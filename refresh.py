"""Refresh the Pit Wall fantasy planner with the latest F1 Fantasy prices and 2026 results.

Run:  python refresh.py
Then republish build/pit-wall.html (ask Claude to "refresh the F1 fantasy page").

Sources (public, no login):
  - fantasy.formula1.com/feeds/...   prices, ownership, per-race fantasy points
  - api.jolpi.ca/ergast/f1/...        qualifying / sprint / race classifications
Requests are paced slowly on purpose; cached files are reused for locked (finished) gamedays.

Season archive (committed by the workflow, so history survives F1 changing or dropping old feeds):
  history/<season>/players/gdNN.json      raw player feed per finished gameday (prices, ownership, points)
  history/<season>/playerstats/<id>.json  latest per-asset scoring events (every round so far)
  history/<season>/projections/gdNN.json  this model's projection for that race, frozen at lock
"""
import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request
import practice
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
BUILD = os.path.join(HERE, "build")
SEASON = 2026
ARCHIVE = os.path.join(HERE, "history", str(SEASON))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
PAUSE = 2.5

JOLPICA_TEAM = {
    "mercedes": "Mercedes", "mclaren": "McLaren", "red_bull": "Red Bull Racing", "ferrari": "Ferrari",
    "alpine": "Alpine", "rb": "Racing Bulls", "williams": "Williams", "haas": "Haas F1 Team",
    "audi": "Audi", "sauber": "Audi", "aston_martin": "Aston Martin", "cadillac": "Cadillac",
}


def archived(*parts):
    path = os.path.join(ARCHIVE, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def get(url, path, reuse=False):
    if reuse and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8")
            break
        except Exception as e:  # a block or outage: stop rather than hammer the server
            print(f"  ! {url} -> {e}")
            if attempt == 2:
                sys.exit("Giving up. If this is a block/CAPTCHA, wait before retrying.")
            time.sleep(10 * (attempt + 1))
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    time.sleep(PAUSE)
    return json.loads(body)


def get_optional(url):
    """Fetch a feed that may not exist yet: a new league's standings file returns 403 until the next rebuild."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    finally:
        time.sleep(PAUSE)


def feed_time(d):
    """F1's FeedTime.UTCTime is US-style text ("9/17/2026 1:59:44 PM"); return ISO UTC so every browser can parse it."""
    t = ((d or {}).get("FeedTime") or {}).get("UTCTime")
    try:
        return datetime.strptime(t, "%m/%d/%Y %I:%M:%S %p").strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return None


def build_elite(assets):
    """Top-10/100/500 ownership and points cut-offs from the public global leaderboard. Numbers only, no names."""
    d = get_optional("https://fantasy.formula1.com/feeds/leaderboard/public/global/list_1_0_1.json")
    rows = sorted(((d or {}).get("Value") or {}).get("leaderboard") or [], key=lambda r: r.get("cur_rank") or 1e9)
    if not rows:
        return None
    known = {a["id"] for a in assets}
    tiers = [10, 100, 500]
    own = {}
    for ti, t in enumerate(tiers):
        sub = rows[:t]
        for r in sub:
            for pid in {str(x) for x in r.get("user_team") or []} & known:
                own.setdefault(pid, [0.0] * len(tiers))[ti] += 1 / len(sub)
    elite = {
        "feedTime": feed_time(d), "n": len(rows), "tiers": tiers,
        "own": {k: [round(v, 3) for v in vs] for k, vs in own.items()},
        "cut": {str(k): rows[min(k, len(rows)) - 1].get("cur_points") for k in (1, 10, 100, 500)},
    }
    extra = os.path.join(HERE, "data", "elite_top100.json")  # Boost % and chip timing from a top-100 export
    if os.path.exists(extra):
        with open(extra, encoding="utf-8") as f:
            elite["top100"] = json.load(f)
    elite["history"] = elite_history((elite.get("top100") or {}).pop("history", []))
    return elite


def elite_history(est):
    """Season cut-offs per gameday: the export's estimate (today's top 100, R1 onward), replaced by the real
    cut-offs the private workflow records after each leaderboard update (data/elite_history.json)."""
    by = {h["gd"]: h for h in est}
    path = os.path.join(HERE, "data", "elite_history.json")
    real = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            real = json.load(f)
    prev = None
    for g in sorted(real, key=lambda g: g["gd"]):
        row = {"gd": g["gd"], "est": False, "cut": g["cut"], "avg": {}}
        if prev and prev["gd"] == g["gd"] - 1:  # round average from consecutive real snapshots only
            row["avg"] = {k: round(g["mean"][k] - prev["mean"][k], 1) for k in ("10", "100") if k in g["mean"] and k in prev["mean"]}
        elif g["gd"] in by:
            row["avg"] = by[g["gd"]].get("avg", {})
        by[g["gd"]] = row
        prev = g
    return [by[k] for k in sorted(by)]


def sealed_leagues():
    """Encrypted private-league standings. The private pit-wall-private workflow fetches and seals them and pushes
    data/league.sealed.json here; this repo never sees the league IDs or the key. None until that file exists."""
    path = os.path.join(HERE, "data", "league.sealed.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            z = json.load(f)
    except ValueError:
        print("  ! data/league.sealed.json is not valid JSON; leagues skipped")
        return None
    if not all(k in z for k in ("v", "iter", "salt", "iv", "ct")):
        print("  ! data/league.sealed.json is missing fields; leagues skipped")
        return None
    return z


def freeze_projection(data, g):
    """Before lock, save this build's default-settings projection for the coming race. After lock the last one
    stands: that is what the model said going in, for checking against the result later."""
    if datetime.now(timezone.utc) >= datetime.fromisoformat(g["lock"]):
        return
    try:
        res = subprocess.run(["node", "-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>"
                              "process.stdout.write(JSON.stringify(require('./engine.js').project(JSON.parse(s)))))"],
                             input=json.dumps(data), capture_output=True, text=True, encoding="utf-8", check=True, cwd=HERE)
        proj = json.loads(res.stdout)
    except Exception as e:  # a bonus; never block a price refresh on it
        print(f"  ! projection not frozen: {e}")
        return
    with open(archived("projections", f"gd{g['gd']:02d}.json"), "w", encoding="utf-8") as f:
        json.dump(proj, f, indent=1, sort_keys=True)
    print(f"  projection for gameday {g['gd']} saved (practice: {', '.join(proj['practice']) or 'none'})")


def load_projections():
    out = {}
    folder = os.path.join(ARCHIVE, "projections")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        with open(os.path.join(folder, name), encoding="utf-8") as f:
            p = json.load(f)
        out[str(p["gd"])] = {k: v["x"] for k, v in p["assets"].items()}
    return out


def main():
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)

    print("Schedule…")
    sched = get("https://fantasy.formula1.com/feeds/schedule/raceday_en.json",
                os.path.join(CACHE, "raceday.json"))["Data"]["Value"]
    gds = {}
    for s in sched:
        g = gds.setdefault(s["GamedayId"], {
            "gd": s["GamedayId"], "name": s["MeetingName"], "loc": s["CircuitLocation"],
            "country": s["CountryName"], "sprint": False, "lock": None, "raceStart": None,
            "locked": s["GDIsLocked"] == 1,
        })
        g["locked"] = g["locked"] and s["GDIsLocked"] == 1
        if "Sprint" in s["SessionType"]:
            g["sprint"] = True
        start = s["SessionStartDateISO8601"]
        if g["lock"] is None or datetime.fromisoformat(start) < datetime.fromisoformat(g["lock"]):
            g["lock"] = start
        if s["SessionType"] == "Race":
            g["raceStart"] = start
    schedule = [gds[k] for k in sorted(gds)]
    done = [g["gd"] for g in schedule if g["locked"] and datetime.fromisoformat(g["raceStart"]) < datetime.now(timezone.utc)]
    nxt = next((g["gd"] for g in schedule if g["gd"] not in done), schedule[-1]["gd"])
    print(f"  completed gamedays: {done[-1] if done else 0}, next: {nxt}")

    print("Fantasy player feeds…")
    feeds = {}
    for g in done + [nxt]:
        path = archived("players", f"gd{g:02d}.json") if g in done else os.path.join(CACHE, f"players{g}.json")
        feeds[g] = get(f"https://fantasy.formula1.com/feeds/drivers/{g}_en.json", path, reuse=(g in done[:-1]))["Data"]["Value"]

    cur = feeds[nxt]
    assets = []
    for p in cur:
        kind = "D" if p["PositionName"] == "DRIVER" else "C"
        hist = []
        for g in done:
            q = next((x for x in feeds[g] if x["PlayerId"] == p["PlayerId"]), None)
            if q is None:
                hist.append(None)
                continue
            sess = {s["sessiontype"]: s["points"] for s in q.get("SessionWisePoints") or []}
            hist.append({
                "gd": g, "price": q["Value"], "pts": float(q["GamedayPoints"] or 0),
                "active": q["IsActive"] == "1",
                "team": q["TeamName"] if kind == "D" else q["FUllName"],
                "q": sess.get("Qualifying"), "s": sess.get("Sprint Qualifying"), "r": sess.get("Race"),
            })
        a = p.get("AdditionalStats") or {}
        assets.append({
            "id": p["PlayerId"], "kind": kind, "name": p["FUllName"], "short": p["DisplayName"],
            "tla": p["DriverTLA"], "team": p["TeamName"] if kind == "D" else p["FUllName"],
            "price": p["Value"], "own": float(p["SelectedPercentage"] or 0),
            "active": p["IsActive"] == "1", "total": float(p["OverallPpints"] or 0),
            "overtakePts": a.get("overtaking_pts", 0), "hist": hist,
        })

    print("Player stats (per-round scoring events)…")
    track_stats = {}
    ovt = {}
    for a in assets:
        if a["kind"] != "D":
            continue
        ps_path = os.path.join(CACHE, f"ps_{a['id']}_{len(done)}.json")
        ps = get(f"https://fantasy.formula1.com/feeds/popup/playerstats_{a['id']}.json", ps_path, reuse=True)
        shutil.copyfile(ps_path, archived("playerstats", f"{a['id']}.json"))
        for m in (ps.get("Value") or {}).get("MatchWiseStats") or []:
            g = m.get("GamedayId")
            if g not in done:
                continue
            for rd in m.get("RaceDayWise") or []:
                if rd.get("SessionType") == "Race":
                    for e in rd.get("StatsWise") or []:
                        if e.get("Event", "").strip().lower() == "race overtake bonus":
                            ovt[g] = ovt.get(g, 0) + (e.get("Value") or 0)
    for g, v in ovt.items():
        track_stats[g] = {"ovt": round(v / 22, 2)}  # race overtake points per car

    print("Jolpica results…")
    results = {"race": {}, "quali": {}, "sprint": {}}
    for kind, key, path in (("race", "Results", "results"), ("quali", "QualifyingResults", "qualifying"),
                            ("sprint", "SprintResults", "sprint")):
        off, total = 0, 1
        while off < total:
            # results only change when a round completes, so cache per number of completed rounds
            d = get(f"https://api.jolpi.ca/ergast/f1/{SEASON}/{path}.json?limit=100&offset={off}",
                    os.path.join(CACHE, f"j_{path}_{len(done)}_{off}.json"), reuse=True)["MRData"]
            total = int(d["total"])
            for R in d["RaceTable"]["Races"]:
                rows = results[kind].setdefault(int(R["round"]), [])
                for r in R[key]:
                    row = {"tla": r["Driver"]["code"], "team": JOLPICA_TEAM.get(r["Constructor"]["constructorId"], r["Constructor"]["name"]),
                           "pos": int(r["position"])}
                    if kind != "quali":
                        row["grid"] = int(r["grid"])
                        row["cls"] = r["positionText"].isdigit()
                        row["fl"] = (r.get("FastestLap") or {}).get("rank") == "1"
                    rows.append(row)
            off += 100

    print("OpenF1 practice…")
    nxt_g = next(g for g in schedule if g["gd"] == nxt)
    try:
        prac = practice.practice_for(get, lambda n: os.path.join(CACHE, n), nxt_g["lock"], datetime.now(timezone.utc))
    except SystemExit:
        raise
    except Exception as e:  # practice data is a bonus; never block a price refresh on it
        print(f"  ! practice skipped: {e}")
        prac = []
    print("  " + ", ".join(f'{p["name"]}: {len(p["drivers"])} drivers' if p["done"] else f'{p["name"]}: pending' for p in prac))

    print("Leaderboards…")
    elite = build_elite(assets)
    print("  global top 500: " + (f"{elite['n']} teams" if elite else "unavailable"))
    sealed = sealed_leagues()
    print("  private leagues: " + ("sealed snapshot embedded" if sealed else "none"))

    data = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "season": SEASON, "next": nxt, "done": done, "schedule": schedule,
        "assets": assets, "practice": prac, "trackStats": track_stats, "elite": elite, "leagueSealed": sealed,
        "results": {k: {str(r): v for r, v in sorted(rs.items())} for k, rs in results.items()},
    }
    freeze_projection(data, next(g for g in schedule if g["gd"] == nxt))
    data["projHist"] = load_projections()
    js = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(HERE, "app.html"), encoding="utf-8") as f:
        html = f.read()
    with open(os.path.join(HERE, "engine.js"), encoding="utf-8") as f:
        engine = f.read()
    out = html.replace('<script src="engine.js"></script>', "<script>\n" + engine + "\n</script>")
    out = out.replace("/*__DATA__*/null", js.replace("</", "<\\/"))
    with open(os.path.join(BUILD, "pit-wall.html"), "w", encoding="utf-8") as f:
        f.write(out)  # Claude artifact: the publisher adds doctype/head/viewport
    with open(os.path.join(BUILD, "index.html"), "w", encoding="utf-8") as f:
        f.write('<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                '<meta name="theme-color" content="#050505">\n' + out + "\n</html>\n")  # GitHub Pages
    with open(os.path.join(CACHE, "data.json"), "w", encoding="utf-8") as f:
        f.write(js)
    print(f"Built build/pit-wall.html ({len(out)//1024} KB) — next race: gameday {nxt}")


if __name__ == "__main__":
    main()
