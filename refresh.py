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
  history/<season>/practice/gdNN.json    analysed OpenF1 practice sessions (OpenF1 closes during live sessions)
  history/<season>/elite/<feedTime>_<hash>.json  top-10/100/500 ownership each time the global line-ups change,
                                         with the time we first saw it (when does the feed update: at lock?)
"""
import glob, hashlib, json, os, shutil, subprocess, sys, time, urllib.error, urllib.request
import practice
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
BUILD = os.path.join(HERE, "build")
SEASON = 2026
ARCHIVE = os.path.join(HERE, "history", str(SEASON))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
PAUSE = 2.5

# F1's scoring-event names -> short category codes (first match wins, so specific phrases come first)
EV_SESSION = {"Qualifying": "Q", "Sprint Qualifying": "S", "Race": "R"}
EV_RULES = [("not classified", "NC"), ("dq", "DQ"), ("disqualif", "DQ"), ("position gained", "PG"),
            ("position lost", "PL"), ("overtake", "OV"), ("fastest lap", "FL"), ("driver of day", "DOTD"),
            ("world record", "WRFP"), ("2nd fastest pit", "FP2"), ("fastest pit", "FP"), ("pit", "PIT"),
            ("q3", "TW"), ("q2", "TW"), ("position", "POS")]


def ev_code(session, name):
    n = name.strip().lower()
    return EV_SESSION.get(session, "?") + " " + next((c for k, c in EV_RULES if k in n), "OTH")


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


def get_soft(url, path, reuse=False):
    """For sources that may refuse us for a while (OpenF1 locks everything to paying users while a session is live):
    one attempt, no retries; on failure fall back to the last cached copy, else raise so the caller can skip it."""
    if reuse and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8")
    except Exception as e:
        if os.path.exists(path):
            print(f"  ! {url} -> {e}; using the cached copy")
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        raise RuntimeError(f"{url} -> {e}")
    finally:
        time.sleep(PAUSE)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
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


def build_elite(assets, schedule):
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
    elite.update(elite_snapshots(elite, rows, schedule))
    extra = os.path.join(HERE, "data", "elite_top100.json")  # Boost % and chip timing from a top-100 export
    if os.path.exists(extra):
        with open(extra, encoding="utf-8") as f:
            elite["top100"] = json.load(f)
    elite["history"] = elite_history((elite.get("top100") or {}).pop("history", []))
    return elite


def elite_snapshots(elite, rows, schedule):
    """Save ownership whenever the top-500 line-ups change (anonymous numbers only), then return the previous
    round's ownership for the Elite ± column and the snapshot log."""
    fp = hashlib.sha1(json.dumps([sorted(str(x) for x in r.get("user_team") or []) for r in rows]).encode()).hexdigest()[:10]
    ft = elite["feedTime"] or "unknown"
    starts = {g["gd"]: datetime.fromisoformat(g["raceStart"]) for g in schedule if g.get("raceStart")}
    def gd_at(iso):
        try:
            t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            return None
        return max([g for g, st in starts.items() if st <= t], default=None)
    path = archived("elite", f"{ft.replace(':', '')}_{fp}.json")
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"feedTime": ft, "firstSeen": datetime.now(timezone.utc).isoformat(timespec="minutes"), "hash": fp,
                       "gd": gd_at(ft), "n": elite["n"], "own": elite["own"], "cut": elite["cut"]}, f, indent=1, sort_keys=True)
        print(f"  elite line-ups changed: snapshot {ft} {fp}")
    snaps = []
    for fn in glob.glob(os.path.join(ARCHIVE, "elite", "*.json")):
        with open(fn, encoding="utf-8") as f:
            snaps.append(json.load(f))
    snaps.sort(key=lambda x: x["firstSeen"])
    cur = next((x for x in snaps if x["hash"] == fp and x["feedTime"] == ft), snaps[-1])
    prev = [x for x in snaps if x["gd"] is not None and cur["gd"] is not None and x["gd"] < cur["gd"]]
    return {"gd": cur["gd"], "prevGd": prev[-1]["gd"] if prev else None, "ownPrev": prev[-1]["own"] if prev else None,
            "snaps": [{"feedTime": x["feedTime"], "firstSeen": x["firstSeen"], "gd": x["gd"]} for x in snaps]}


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
            "locked": s["GDIsLocked"] == 1, "sessions": [],
        })
        g["locked"] = g["locked"] and s["GDIsLocked"] == 1
        g["sessions"].append({"type": s["SessionType"], "start": s["SessionStartDateISO8601"], "end": s.get("SessionEndDateISO8601")})
        if "Sprint" in s["SessionType"]:
            g["sprint"] = True
        start = s["SessionStartDateISO8601"]
        if g["lock"] is None or datetime.fromisoformat(start) < datetime.fromisoformat(g["lock"]):
            g["lock"] = start
        if s["SessionType"] == "Race":
            g["raceStart"] = start
    schedule = [gds[k] for k in sorted(gds)]
    for g in schedule:
        g["sessions"].sort(key=lambda s: s["start"])
    now = datetime.now(timezone.utc)
    done = [g["gd"] for g in schedule if g["locked"] and datetime.fromisoformat(g["raceStart"]) < now]
    nxt = next((g["gd"] for g in schedule if g["gd"] not in done), schedule[-1]["gd"])
    # the weekend Live Scoring shows: the last one whose first scored session has started (nxt or done[-1])
    live_gd = max([g["gd"] for g in schedule if datetime.fromisoformat(g["lock"]) <= now], default=None)
    print(f"  completed gamedays: {done[-1] if done else 0}, next: {nxt}, live: {live_gd}")

    print("Fantasy player feeds…")
    feeds, feed_times = {}, {}
    for g in done + [nxt]:
        path = archived("players", f"gd{g:02d}.json") if g in done else os.path.join(CACHE, f"players{g}.json")
        d = get(f"https://fantasy.formula1.com/feeds/drivers/{g}_en.json", path, reuse=(g in done[:-1]))["Data"]
        feeds[g], feed_times[g] = d["Value"], feed_time(d)

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
                "own": float(q.get("SelectedPercentage") or 0),
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
    ev_names = []  # event name table; hist[].ev rows are [name index, points, frequency]

    def ev_rows(m):
        rows = []
        for rd in m.get("RaceDayWise") or []:
            for e in rd.get("StatsWise") or []:
                if e.get("Event") == "Total":  # per-session subtotal, not an event
                    continue
                key = (rd.get("SessionType"), e.get("Event", "").strip())
                if key not in ev_names:
                    ev_names.append(key)
                rows.append([ev_names.index(key), e.get("Value") or 0, e.get("Frequency")])
        return rows

    # Live weekend: session points straight from the player feed, scoring lines from playerstats. The playerstats
    # cache is keyed by a fingerprint of the live weekend's points, so it's refetched whenever anything is scored
    # (and the latest round's race lines are complete, not frozen at race start).
    live_feed = feeds.get(live_gd) or []
    fp = hashlib.sha1(json.dumps(sorted([str(p["PlayerId"]), str(p.get("GamedayPoints")), [str(s.get("points")) for s in p.get("SessionWisePoints") or []]]
                                        for p in live_feed)).encode()).hexdigest()[:8]
    live = None
    if live_feed:
        live = {"gd": live_gd, "feedTime": feed_times.get(live_gd), "assets": {
            p["PlayerId"]: {"pts": float(p.get("GamedayPoints") or 0), "ev": [], "act": p.get("IsActive") == "1",
                            "sess": {s["sessiontype"]: s["points"] for s in p.get("SessionWisePoints") or [] if s.get("points") is not None}}
            for p in live_feed}}
    for a in assets:
        ps_path = os.path.join(CACHE, f"ps_{a['id']}_{live_gd}_{fp}.json")
        for old in glob.glob(os.path.join(CACHE, f"ps_{a['id']}_*.json")):
            if old != ps_path:
                os.remove(old)
        ps = get(f"https://fantasy.formula1.com/feeds/popup/playerstats_{a['id']}.json", ps_path, reuse=True)
        shutil.copyfile(ps_path, archived("playerstats", f"{a['id']}.json"))
        for m in (ps.get("Value") or {}).get("MatchWiseStats") or []:
            g = m.get("GamedayId")
            if live and g == live_gd and a["id"] in live["assets"]:
                la = live["assets"][a["id"]]
                la["ev"] = ev_rows(m)
                if abs(sum(r[1] for r in la["ev"]) - la["pts"]) > 0.5:
                    os.remove(ps_path)  # playerstats lagging the player feed: fetch again next build
                    la["lag"] = True
            if g not in done:
                continue
            h = a["hist"][done.index(g)]
            if h is not None:
                rows = ev_rows(m)
                h["ev"] = rows
                # No Negative floors every negative event at 0 (checked against official scores)
                h["nn"] = sum(max(0, r[1]) for r in rows) if rows else max(0, h["pts"])
            if a["kind"] != "D":
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
    # Analysed sessions are archived: OpenF1 refuses everything (past sessions too) while any F1 session is live,
    # and a CI runner that only ran during those windows would otherwise have no practice at all.
    prac_path = archived("practice", f"gd{nxt:02d}.json")
    saved = []
    if os.path.exists(prac_path):
        with open(prac_path, encoding="utf-8") as f:
            saved = json.load(f)
    try:
        prac = practice.practice_for(get_soft, lambda n: os.path.join(CACHE, n), nxt_g["lock"], datetime.now(timezone.utc))
    except Exception as e:  # practice data is a bonus; never block a price refresh on it (OpenF1 is closed during live sessions)
        print(f"  ! practice from OpenF1 skipped: {e}")
        prac = []
    old = {p["name"]: p for p in saved if p["done"]}
    prac = [old.get(p["name"], p) if not p["done"] else p for p in prac] or saved
    if any(p["done"] for p in prac) and prac != saved:
        with open(prac_path, "w", encoding="utf-8") as f:
            json.dump(prac, f, indent=1, sort_keys=True)
    print("  " + ", ".join(f'{p["name"]}: {len(p["drivers"])} drivers' if p["done"] else f'{p["name"]}: pending' for p in prac))

    print("Leaderboards…")
    elite = build_elite(assets, schedule)
    print("  global top 500: " + (f"{elite['n']} teams" if elite else "unavailable"))
    sealed = sealed_leagues()
    print("  private leagues: " + ("sealed snapshot embedded" if sealed else "none"))

    data = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "season": SEASON, "next": nxt, "done": done, "schedule": schedule,
        "assets": assets, "evNames": [{"s": EV_SESSION.get(st, "?"), "n": n, "c": ev_code(st, n)} for st, n in ev_names],
        "practice": prac, "trackStats": track_stats, "elite": elite, "leagueSealed": sealed, "live": live,
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
