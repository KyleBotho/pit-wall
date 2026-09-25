"""Refresh the Fantasy Pit Wall planner with the latest F1 Fantasy prices and this season's results.

Run:  python refresh.py              fetch everything, then build build/index.html (GitHub Pages)
      python refresh.py --offline    rebuild the page from cache/data.json without fetching (page/CSS/JS edits)
      python refresh.py --offline --data other.json --out somewhere/   build from another data file

Sources (public, no login):
  - fantasy.formula1.com/feeds/...   prices, ownership, per-race fantasy points
  - api.jolpi.ca/ergast/f1/...        qualifying / sprint / race classifications
  - api.openf1.org                    practice laps (practice.py)
Requests are paced slowly on purpose (f1feeds.py); cached files are reused for locked (finished) gamedays.

Season archive (committed by the workflow, so history survives F1 changing or dropping old feeds):
  history/<season>/players/gdNN.json      raw player feed per finished gameday (prices, ownership, points)
  history/<season>/playerstats/<id>.json  latest per-asset scoring events (every round so far)
  history/<season>/projections/gdNN.json  this model's projection for that race, frozen at lock
  history/<season>/practice/gdNN.json     analysed OpenF1 practice sessions (OpenF1 closes during live sessions)
  history/<season>/elite/<feedTime>_<hash>.json  top-10/100/500 ownership each time the global line-ups change,
                                          with the time we first saw it (when does the feed update: at lock?)
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import extras
import practice
from f1feeds import EV_SESSION, FeedError, ev_code, feed_time, get, get_optional, get_soft, load_config

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
BUILD = os.path.join(HERE, "build")
CFG = load_config("season")
SEASON = CFG["season"]
ARCHIVE = os.path.join(HERE, "history", str(SEASON))
F1 = "https://fantasy.formula1.com/feeds"
PAGE = os.path.join(HERE, "web", "app.html")
DATA_MARK = re.compile(r"/\*__DATA__\*/\s*null")  # in web/js/core.js

# Jolpica constructorId -> F1 Fantasy team name
JOLPICA_TEAM = {jid: name for name, t in CFG["teams"].items() if not name.startswith("_") for jid in t["jolpica"]}


def cached(name):
    return os.path.join(CACHE, name)


def archived(*parts):
    path = os.path.join(ARCHIVE, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def iso(t):
    return datetime.fromisoformat(t)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj, **kw):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, **kw)


# ---------------------------------------------------------------- schedule


def load_schedule(now):
    """Gamedays with their sessions, lock (first session) and race start; which are done, which is next (None once
    the season is over) and which weekend Live Scoring shows (the last one whose first session has started)."""
    sched = get(f"{F1}/schedule/raceday_en.json", cached("raceday.json"))["Data"]["Value"]
    gds = {}
    for s in sched:
        g = gds.setdefault(
            s["GamedayId"],
            {
                "gd": s["GamedayId"],
                "name": s["MeetingName"],
                "loc": s["CircuitLocation"],
                "country": s["CountryName"],
                "sprint": False,
                "lock": None,
                "raceStart": None,
                "locked": s["GDIsLocked"] == 1,
                "sessions": [],
            },
        )
        g["locked"] = g["locked"] and s["GDIsLocked"] == 1
        start = s["SessionStartDateISO8601"]
        g["sessions"].append({"type": s["SessionType"], "start": start, "end": s.get("SessionEndDateISO8601")})
        if "Sprint" in s["SessionType"]:
            g["sprint"] = True
        if g["lock"] is None or iso(start) < iso(g["lock"]):
            g["lock"] = start
        if s["SessionType"] == "Race":
            g["raceStart"] = start
    schedule = [gds[k] for k in sorted(gds)]
    for g in schedule:
        g["sessions"].sort(key=lambda s: s["start"])
    done = [g["gd"] for g in schedule if g["locked"] and g["raceStart"] and iso(g["raceStart"]) < now]
    nxt = next((g["gd"] for g in schedule if g["gd"] not in done), None)
    live_gd = max([g["gd"] for g in schedule if iso(g["lock"]) <= now], default=None)
    return schedule, done, nxt, live_gd


# ---------------------------------------------------------------- fantasy player feeds


def load_player_feeds(done, nxt):
    """Raw player feed per gameday: finished ones from the archive (the latest is refetched for late corrections),
    the next one fresh."""
    feeds, times = {}, {}
    for g in done + ([nxt] if nxt else []):
        path = archived("players", f"gd{g:02d}.json") if g in done else cached(f"players{g}.json")
        d = get(f"{F1}/drivers/{g}_en.json", path, reuse=(g in done[:-1]))["Data"]
        feeds[g], times[g] = d["Value"], feed_time(d)
    return feeds, times


def build_assets(feeds, done, cur_gd):
    """One record per driver/constructor: today's price and status plus a history row per finished round."""
    assets = []
    for p in feeds[cur_gd]:
        kind = "D" if p["PositionName"] == "DRIVER" else "C"
        hist = []
        for g in done:
            q = next((x for x in feeds[g] if x["PlayerId"] == p["PlayerId"]), None)
            if q is None:
                hist.append(None)
                continue
            sess = {s["sessiontype"]: s["points"] for s in q.get("SessionWisePoints") or []}
            hist.append(
                {
                    "gd": g,
                    "price": q["Value"],
                    "pts": float(q["GamedayPoints"] or 0),
                    "own": float(q.get("SelectedPercentage") or 0),
                    "active": q["IsActive"] == "1",
                    "team": q["TeamName"] if kind == "D" else q["FUllName"],
                    "q": sess.get("Qualifying"),
                    "s": sess.get("Sprint Qualifying"),
                    "r": sess.get("Race"),
                }
            )
        extra = p.get("AdditionalStats") or {}
        assets.append(
            {
                "id": p["PlayerId"],
                "kind": kind,
                "name": p["FUllName"],
                "short": p["DisplayName"],
                "tla": p["DriverTLA"],
                "team": p["TeamName"] if kind == "D" else p["FUllName"],
                "price": p["Value"],
                "own": float(p["SelectedPercentage"] or 0),
                "active": p["IsActive"] == "1",
                "total": float(p["OverallPpints"] or 0),
                "overtakePts": extra.get("overtaking_pts", 0),
                "hist": hist,
            }
        )
    return assets


# ---------------------------------------------------------------- results


def load_results(done):
    """Jolpica classifications per round. Results only change when a round completes, so pages are cached per
    number of completed rounds."""
    results = {"race": {}, "quali": {}, "sprint": {}}
    for kind, key, path in (
        ("race", "Results", "results"),
        ("quali", "QualifyingResults", "qualifying"),
        ("sprint", "SprintResults", "sprint"),
    ):
        off, total = 0, 1
        while off < total:
            d = get(
                f"https://api.jolpi.ca/ergast/f1/{SEASON}/{path}.json?limit=100&offset={off}",
                cached(f"j_{path}_{len(done)}_{off}.json"),
                reuse=True,
            )["MRData"]
            total = int(d["total"])
            for race in d["RaceTable"]["Races"]:
                rows = results[kind].setdefault(int(race["round"]), [])
                for r in race[key]:
                    cid = r["Constructor"]["constructorId"]
                    row = {
                        "tla": r["Driver"]["code"],
                        "team": JOLPICA_TEAM.get(cid, r["Constructor"]["name"]),
                        "pos": int(r["position"]),
                    }
                    if kind != "quali":
                        row["grid"] = int(r["grid"])
                        row["cls"] = r["positionText"].isdigit()
                        row["fl"] = (r.get("FastestLap") or {}).get("rank") == "1"
                        row["num"] = int(r["number"])
                    else:
                        row["qt"] = [lap_secs(r.get(k)) for k in ("Q1", "Q2", "Q3")]
                    rows.append(row)
            off += 100
    for rows in results["quali"].values():
        quali_gaps(rows)
    return results


def lap_secs(t):
    """ "1:23.456" -> 83.456 (None for no time)."""
    try:
        m, s = (t or "").split(":") if ":" in (t or "") else ("0", t)
        return round(int(m) * 60 + float(s), 3)
    except (TypeError, ValueError):
        return None


def quali_gaps(rows):
    """Each driver's qualifying pace as % off the fastest: per session (Q1, Q2, Q3) against that session's fastest
    time, averaged over the sessions they ran. Times over 107% (a scrappy lap, a problem) don't count."""
    for k in range(3):
        best = min((r["qt"][k] for r in rows if r["qt"][k]), default=None)
        for r in rows:
            t = r["qt"][k]
            r.setdefault("_g", [])
            if best and t and t / best < 1.07:
                r["_g"].append((t / best - 1) * 100)
    for r in rows:
        g = r.pop("_g")
        r["gap"] = round(sum(g) / len(g), 3) if g else None
        del r["qt"]


# ---------------------------------------------------------------- per-asset scoring events


def load_playerstats(assets, done, feeds, feed_times, live_gd, results):
    """Scoring lines per asset and round (hist[].ev, hist[].nn), the live weekend's lines, and race overtake points
    per car per round (for the track model). Returns (ev_names, track_stats, live)."""
    ev_names = []  # event name table; ev rows are [name index, points, frequency]

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
    fp = hashlib.sha1(
        json.dumps(
            sorted(
                [
                    str(p["PlayerId"]),
                    str(p.get("GamedayPoints")),
                    [str(s.get("points")) for s in p.get("SessionWisePoints") or []],
                ]
                for p in live_feed
            )
        ).encode()
    ).hexdigest()[:8]
    live = None
    if live_feed:
        live = {
            "gd": live_gd,
            "feedTime": feed_times.get(live_gd),
            "assets": {
                p["PlayerId"]: {
                    "pts": float(p.get("GamedayPoints") or 0),
                    "ev": [],
                    "act": p.get("IsActive") == "1",
                    "sess": {
                        s["sessiontype"]: s["points"]
                        for s in p.get("SessionWisePoints") or []
                        if s.get("points") is not None
                    },
                }
                for p in live_feed
            },
        }

    ovt = {}
    for a in assets:
        ps_path = cached(f"ps_{a['id']}_{live_gd}_{fp}.json")
        for old in glob.glob(cached(f"ps_{a['id']}_*.json")):
            if old != ps_path:
                os.remove(old)
        ps = get(f"{F1}/popup/playerstats_{a['id']}.json", ps_path, reuse=True)
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
    # race overtake points per car that started the race
    track_stats = {
        g: {"ovt": round(v / (len(results["race"].get(g) or []) or CFG["field"]), 2)} for g, v in ovt.items()
    }
    return ev_names, track_stats, live


# ---------------------------------------------------------------- practice


def load_practice(g):
    """This weekend's analysed practice sessions. They're archived: OpenF1 refuses everything (past sessions too)
    while any F1 session is live, and a CI runner that only ran during those windows would otherwise have none."""
    path = archived("practice", f"gd{g['gd']:02d}.json")
    saved = read_json(path) if os.path.exists(path) else []
    try:
        prac = practice.practice_for(get_soft, cached, g["lock"], datetime.now(timezone.utc))
    except Exception as e:  # noqa: BLE001 - practice is a bonus; never block a price refresh on it
        print(f"  ! practice from OpenF1 skipped: {e}")
        prac = []
    old = {p["name"]: p for p in saved if p["done"]}
    prac = [old.get(p["name"], p) if not p["done"] else p for p in prac] or saved
    if any(p["done"] for p in prac) and prac != saved:
        write_json(path, prac, indent=1, sort_keys=True)
    return prac


# ---------------------------------------------------------------- extras (extras.py)


def load_priors():
    path = os.path.join(HERE, "data", "circuit_priors.json")
    return read_json(path) if os.path.exists(path) else None


def load_extras(now, schedule, done, nxt_g, results, assets):
    """Circuit ids/coordinates on the schedule, and DATA's priors, raceInfo, weather, odds and weekend. Each piece
    fails soft: the model falls back to what it had before."""
    out = {"priors": load_priors(), "raceInfo": {}, "weather": {}, "odds": None, "weekend": None}
    try:
        cal = extras.calendar(get, cached, SEASON)
        for g in schedule:
            c = extras.match_round(cal, g["raceStart"])
            if c:
                g.update(circuit=c["circuit"], lat=c["lat"], lon=c["lon"])
    except FeedError as e:
        print(f"  ! Jolpica calendar: {e}")
    num = {gd: {r["num"]: (r["tla"], r["team"]) for r in rows if "num" in r} for gd, rows in results["race"].items()}
    out["raceInfo"] = {
        str(k): v
        for k, v in extras.race_info(
            get_soft, cached, archived, read_json, write_json, SEASON, schedule, done, num
        ).items()
    }
    print(f"  OpenF1 race data: {len(out['raceInfo'])}/{len(done)} rounds")
    coming = [g for g in schedule if g["gd"] not in done][:3]
    out["weather"] = {str(k): v for k, v in extras.weather(get_soft, cached, coming, now).items()}
    print(f"  rain forecasts: {', '.join(f'R{k}' for k in out['weather']) or 'none in range'}")
    if nxt_g:
        tlas = {a["tla"] for a in assets if a["kind"] == "D"}
        out["odds"] = extras.odds(get_soft, cached, nxt_g["name"], SEASON, tlas)
        if out["odds"]:
            out["odds"]["gd"] = nxt_g["gd"]
            out["odds"]["at"] = now.isoformat(timespec="minutes")
            # frozen at lock like the projections: what the market said going in
            if now < iso(nxt_g["lock"]):
                write_json(archived("odds", f"gd{nxt_g['gd']:02d}.json"), out["odds"], indent=1, sort_keys=True)
        print(
            "  market odds: "
            + (", ".join(k for k in out["odds"] if k in extras.KALSHI_SERIES) if out["odds"] else "none")
        )
        out["weekend"] = extras.weekend(get_soft, cached, SEASON, nxt_g, now)
        out["weekend"]["gd"] = nxt_g["gd"]
        w = out["weekend"]
        print(f"  weekend: {len(w['penalties'])} grid penalties, known orders: {', '.join(w['grid']) or 'none'}")
    return out


# ---------------------------------------------------------------- global leaderboard (anonymous aggregates)


def build_elite(assets, schedule):
    """Top-10/100/500 ownership and points cut-offs from the public global leaderboard. Numbers only, no names."""
    try:
        d = get_optional(f"{F1}/leaderboard/public/global/list_1_0_1.json")
    except FeedError as e:
        print(f"  ! global leaderboard skipped: {e}")
        return None
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
        "feedTime": feed_time(d),
        "n": len(rows),
        "tiers": tiers,
        "own": {k: [round(v, 3) for v in vs] for k, vs in own.items()},
        "cut": {str(k): rows[min(k, len(rows)) - 1].get("cur_points") for k in (1, 10, 100, 500)},
    }
    elite.update(elite_snapshots(elite, rows, schedule))
    extra = os.path.join(HERE, "data", "elite_top100.json")  # Boost % and chip timing from a top-100 export
    if os.path.exists(extra):
        elite["top100"] = read_json(extra)
    elite["history"] = elite_history((elite.get("top100") or {}).pop("history", []))
    return elite


def elite_snapshots(elite, rows, schedule):
    """Save ownership whenever the top-500 line-ups change (anonymous numbers only), then return the previous
    round's ownership for the Elite ± column and the snapshot log."""
    fp = hashlib.sha1(
        json.dumps([sorted(str(x) for x in r.get("user_team") or []) for r in rows]).encode()
    ).hexdigest()[:10]
    ft = elite["feedTime"] or "unknown"
    starts = {g["gd"]: iso(g["raceStart"]) for g in schedule if g.get("raceStart")}

    def gd_at(t):
        try:
            when = iso(t.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            return None
        return max([g for g, st in starts.items() if st <= when], default=None)

    path = archived("elite", f"{ft.replace(':', '')}_{fp}.json")
    if not os.path.exists(path):
        snap = {
            "feedTime": ft,
            "firstSeen": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "hash": fp,
            "gd": gd_at(ft),
            "n": elite["n"],
            "own": elite["own"],
            "cut": elite["cut"],
        }
        write_json(path, snap, indent=1, sort_keys=True)
        print(f"  elite line-ups changed: snapshot {ft} {fp}")
    snaps = sorted(
        (read_json(fn) for fn in glob.glob(os.path.join(ARCHIVE, "elite", "*.json"))), key=lambda x: x["firstSeen"]
    )
    cur = next((x for x in snaps if x["hash"] == fp and x["feedTime"] == ft), snaps[-1])
    prev = [x for x in snaps if x["gd"] is not None and cur["gd"] is not None and x["gd"] < cur["gd"]]
    return {
        "gd": cur["gd"],
        "prevGd": prev[-1]["gd"] if prev else None,
        "ownPrev": prev[-1]["own"] if prev else None,
        "snaps": [{"feedTime": x["feedTime"], "firstSeen": x["firstSeen"], "gd": x["gd"]} for x in snaps],
    }


def elite_history(est):
    """Season cut-offs per gameday: the export's estimate (today's top 100, R1 onward), replaced by the real
    cut-offs the private workflow records after each leaderboard update (data/elite_history.json)."""
    by = {h["gd"]: h for h in est}
    path = os.path.join(HERE, "data", "elite_history.json")
    real = read_json(path) if os.path.exists(path) else []
    prev = None
    for g in sorted(real, key=lambda g: g["gd"]):
        row = {"gd": g["gd"], "est": False, "cut": g["cut"], "avg": {}}
        if prev and prev["gd"] == g["gd"] - 1:  # round average from consecutive real snapshots only
            row["avg"] = {
                k: round(g["mean"][k] - prev["mean"][k], 1)
                for k in ("10", "100")
                if k in g["mean"] and k in prev["mean"]
            }
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
        z = read_json(path)
    except ValueError:
        print("  ! data/league.sealed.json is not valid JSON; leagues skipped")
        return None
    if not all(k in z for k in ("v", "iter", "salt", "iv", "ct")):
        print("  ! data/league.sealed.json is missing fields; leagues skipped")
        return None
    return z


# ---------------------------------------------------------------- projections archive


def freeze_projection(data, g):
    """Before lock, save this build's default-settings projection for the coming race. After lock the last one
    stands: that is what the model said going in, for checking against the result later."""
    if datetime.now(timezone.utc) >= iso(g["lock"]):
        return
    script = (
        "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>"
        "process.stdout.write(JSON.stringify(require('./engine.js').project(JSON.parse(s)))))"
    )
    try:
        res = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(data),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
            cwd=HERE,
        )
        proj = json.loads(res.stdout)
    except Exception as e:  # noqa: BLE001 - a bonus; never block a price refresh on it
        print(f"  ! projection not frozen: {e}")
        return
    write_json(archived("projections", f"gd{g['gd']:02d}.json"), proj, indent=1, sort_keys=True)
    print(f"  projection for gameday {g['gd']} saved (practice: {', '.join(proj['practice']) or 'none'})")


def load_projections():
    folder = os.path.join(ARCHIVE, "projections")
    out = {}
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        p = read_json(os.path.join(folder, name))
        out[str(p["gd"])] = {k: v["x"] for k, v in p["assets"].items()}
    return out


# ---------------------------------------------------------------- page


def inline_page(data):
    """web/app.html with its local stylesheet and scripts inlined and DATA embedded: one self-contained file."""
    with open(PAGE, encoding="utf-8") as f:
        html = f.read()

    def local(path):
        with open(os.path.join(HERE, path), encoding="utf-8") as f:
            return f.read()

    # local files only (no ":" in the path, so fonts and CDN links stay); tags may be self-closing
    html = re.sub(
        r'<link rel="stylesheet" href="([^":]+)"\s*/?>',
        lambda m: "<style>\n" + local(m.group(1)) + "</style>",
        html,
    )
    html = re.sub(
        r'<script src="([^":]+)"\s*></script>',
        lambda m: "<script>\n" + local(m.group(1)).replace("</script", "<\\/script") + "</script>",
        html,
    )
    left = re.findall(r'<(?:script|link)\b[^>]*\b(?:src|href)="([^":]+)"', html)
    if left:
        raise RuntimeError(f"local files not inlined (check the tag format in web/app.html): {left}")
    if len(DATA_MARK.findall(html)) != 1:
        raise RuntimeError("expected exactly one /*__DATA__*/ null placeholder in the page")
    js = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    return DATA_MARK.sub(lambda _: js, html)


def build_page(data, out_dir=BUILD):
    out = inline_page(data)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "pit-wall.html"), "w", encoding="utf-8") as f:
        f.write(out)  # retired Claude artifact copy: the publisher adds doctype/head/viewport
    # logo files sit next to index.html; link previews need an absolute image URL
    shutil.copytree(os.path.join(HERE, "web", "brand"), os.path.join(out_dir, "brand"), dirs_exist_ok=True)
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(
            '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<meta name="theme-color" content="#050505">\n'
            '<link rel="icon" type="image/svg+xml" href="brand/fantasy-pit-wall-icon.svg">\n'
            '<link rel="apple-touch-icon" href="brand/apple-touch-icon.png">\n'
            '<meta property="og:title" content="Fantasy Pit Wall">\n'
            '<meta property="og:image" content="https://kylebotho.github.io/pit-wall/brand/fantasy-pit-wall-banner.png">\n'
            '<meta name="twitter:card" content="summary_large_image">\n' + out + "\n</html>\n"
        )
    return len(out)


# ---------------------------------------------------------------- main


def collect():
    now = datetime.now(timezone.utc)
    print("Schedule…")
    schedule, done, nxt, live_gd = load_schedule(now)
    print(f"  completed gamedays: {done[-1] if done else 0}, next: {nxt or 'none (season over)'}, live: {live_gd}")

    print("Fantasy player feeds…")
    feeds, feed_times = load_player_feeds(done, nxt)
    assets = build_assets(feeds, done, nxt or done[-1])

    print("Jolpica results…")
    results = load_results(done)

    print("Player stats (per-round scoring events)…")
    ev_names, track_stats, live = load_playerstats(assets, done, feeds, feed_times, live_gd, results)

    nxt_g = next((g for g in schedule if g["gd"] == nxt), None)
    prac = []
    if nxt_g:
        print("OpenF1 practice…")
        prac = load_practice(nxt_g)
        print(
            "  "
            + ", ".join(
                f"{p['name']}: {len(p['drivers'])} drivers" if p["done"] else f"{p['name']}: pending" for p in prac
            )
        )

    print("Race extras (calendar, OpenF1 race data, weather, market odds)…")
    ext = load_extras(now, schedule, done, nxt_g, results, assets)

    print("Leaderboards…")
    elite = build_elite(assets, schedule)
    print("  global top 500: " + (f"{elite['n']} teams" if elite else "unavailable"))
    sealed = sealed_leagues()
    print("  private leagues: " + ("sealed snapshot embedded" if sealed else "none"))

    data = {
        "generated": now.isoformat(timespec="minutes"),
        "season": SEASON,
        "cfg": CFG,
        "next": nxt,
        "done": done,
        "schedule": schedule,
        "assets": assets,
        "evNames": [{"s": EV_SESSION.get(st, "?"), "n": n, "c": ev_code(st, n)} for st, n in ev_names],
        "practice": prac,
        "trackStats": track_stats,
        "elite": elite,
        "leagueSealed": sealed,
        "live": live,
        "results": {k: {str(r): v for r, v in sorted(rs.items())} for k, rs in results.items()},
        **ext,
    }
    if nxt_g:
        freeze_projection(data, nxt_g)
    data["projHist"] = load_projections()
    return data


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="rebuild the page from saved data without fetching")
    ap.add_argument("--data", default=os.path.join(CACHE, "data.json"), help="with --offline: the data file")
    ap.add_argument("--out", default=BUILD, help="output folder")
    args = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    if args.offline:
        data = read_json(args.data)
        data["cfg"] = CFG  # the page and engine always use the current config
    else:
        try:
            data = collect()
        except FeedError as e:
            sys.exit(f"Giving up: {e}\nIf this is a block/CAPTCHA, wait before retrying.")
        with open(cached("data.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    size = build_page(data, args.out)
    nxt = data.get("next")
    out = os.path.relpath(args.out, HERE)
    print(f"Built {out}/index.html ({size // 1024} KB), next race: {nxt or 'none (season over)'}")


if __name__ == "__main__":
    main()
