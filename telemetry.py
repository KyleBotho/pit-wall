"""Session data for the lap-by-lap race model (CLAUDE.md, To do item 9), read with FastF1 from F1's live-timing
archive and saved as small JSON in history/<season>/telemetry/.

  python telemetry.py laps [--rounds 1-14] [--sessions R,S] [--max 20]   lap records per session (small)
  python telemetry.py laps --telemetry [...]                              the same, also caching car/position data
  python telemetry.py measure --round 13 --session Q                      size/time of one session WITH telemetry
  python telemetry.py passes [--rounds 5-14]                              passes counted from the laps vs the
                                                                          official overtake lines

Pacing (the user's rule: go slow, stop on a block): one session at a time, PAUSE seconds between sessions that
actually downloaded, at most --max downloads per run, and never while an F1 session is live (OpenF1 answers 401 for
everything then; checked before every download). Any failure stops the run: rerun later, cached sessions are free.
The FastF1 cache lives outside OneDrive and the repo (%LOCALAPPDATA%/pit-wall/fastf1, ~/.cache/pit-wall/fastf1).
"""

import argparse
import glob
import json
import logging
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PAUSE = 30  # seconds between sessions that downloaded something
SESSIONS = ["FP1", "FP2", "FP3", "SQ", "S", "Q", "R"]  # FastF1 identifiers; sprint weekends have FP1, SQ, S, Q, R
COLS = ["lap", "t0", "t1", "t2", "t3", "lapTime", "pos", "pitIn", "pitOut", "cmp", "life", "i1", "i2", "fl", "st"]
COLS += ["status", "deleted"]
LIVE_URL = "https://api.openf1.org/v1/sessions?year={year}&session_key=latest"


class Stop(RuntimeError):
    """Stop the run (live session, block, rate limit, repeated failure); the message says why."""


def cache_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "pit-wall", "fastf1")


def folder_bytes(path):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def data_json():
    with open(os.path.join(HERE, "cache", "data.json"), encoding="utf-8") as f:
        return json.load(f)


def out_dir(season, kind="laps"):
    d = os.path.join(HERE, "history", str(season), "telemetry", kind)
    os.makedirs(d, exist_ok=True)
    return d


def session_live(year):
    """True while an F1 session is live (OpenF1 locks every request then)."""
    req = urllib.request.Request(LIVE_URL.format(year=year), headers={"User-Agent": "pit-wall telemetry"})
    try:
        with urllib.request.urlopen(req, timeout=30):
            return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return True
        raise Stop(f"OpenF1 answered {e.code} to the live-session check") from e


def fastf1_ready():
    import fastf1

    logging.getLogger("fastf1").setLevel(logging.ERROR)
    os.makedirs(cache_dir(), exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir())
    return fastf1


def event_for(fastf1, year, g):
    """FastF1's event for a fantasy gameday, matched on the race date (round numbers can differ)."""
    sched = fastf1.get_event_schedule(year, include_testing=False)
    day = datetime.fromisoformat(g["raceStart"]).date()
    for _, ev in sched.iterrows():
        if abs((ev["EventDate"].date() - day).days) <= 1:
            return ev
    raise Stop(f"no FastF1 event on {day} for gameday {g['gd']} ({g['name']})")


def secs(v):
    """Timedelta -> seconds (3 dp), NaT/NaN -> None."""
    if v is None or v != v:
        return None
    return round(v.total_seconds(), 3)


def num(v, nd=0):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), nd) if nd else int(v)


def lap_rows(laps):
    """FastF1 Laps -> {TLA: [[COLS...], ...]} (session times in seconds)."""
    out = {}
    for _, r in laps.sort_values(["Driver", "LapNumber"]).iterrows():
        t3 = secs(r["Sector3SessionTime"])
        out.setdefault(r["Driver"], []).append(
            [
                num(r["LapNumber"]),
                secs(r["LapStartTime"]),
                secs(r["Sector1SessionTime"]),
                secs(r["Sector2SessionTime"]),
                t3 if t3 is not None else secs(r["Time"]),
                secs(r["LapTime"]),
                num(r["Position"]),
                int(r["PitInTime"] == r["PitInTime"]),  # not NaT
                int(r["PitOutTime"] == r["PitOutTime"]),
                r["Compound"][0] if isinstance(r["Compound"], str) and r["Compound"] else None,
                num(r["TyreLife"]),
                num(r["SpeedI1"]),
                num(r["SpeedI2"]),
                num(r["SpeedFL"]),
                num(r["SpeedST"]),
                r["TrackStatus"] if isinstance(r["TrackStatus"], str) else None,
                int(bool(r["Deleted"])) if r["Deleted"] == r["Deleted"] else 0,
            ]
        )
    return out


def parse_rounds(s, done):
    if not s:
        return list(done)
    a, _, b = s.partition("-")
    return [g for g in done if int(a) <= g <= int(b or a)]


def has_telemetry(ev, code):
    """True if FastF1's cache already holds this session's car data."""
    name = ev.get_session_name(code).replace(" ", "_")
    ev_dir = ev["EventName"].replace(" ", "_")
    return bool(glob.glob(os.path.join(cache_dir(), "*", f"*{ev_dir}", f"*_{name}", "car_data.ff1pkl")))


def cmd_laps(args):
    D = data_json()
    year = D["season"]
    rounds = parse_rounds(args.rounds, D["done"])
    want = args.sessions.split(",") if args.sessions else SESSIONS
    fastf1 = fastf1_ready()
    downloads = 0
    for gd in rounds:
        g = next(x for x in D["schedule"] if x["gd"] == gd)
        path = os.path.join(out_dir(year), f"gd{gd:02d}.json")
        rec = read_json(path) if os.path.exists(path) else {"gd": gd, "sessions": {}}
        weekend = ["FP1", "SQ", "S", "Q", "R"] if g["sprint"] else ["FP1", "FP2", "FP3", "Q", "R"]
        codes = [c for c in want if c in weekend]
        if not args.telemetry and all(c in rec["sessions"] for c in codes):
            continue
        ev = event_for(fastf1, year, g)
        rec["event"] = ev["EventName"]
        codes = [c for c in codes if c not in rec["sessions"] or (args.telemetry and not has_telemetry(ev, c))]
        for code in codes:
            if downloads >= args.max:
                print(f"reached --max {args.max} downloads; rerun to continue")
                return
            if session_live(year):
                raise Stop("an F1 session is live: not fetching now; rerun once it has finished")
            before = folder_bytes(cache_dir())
            t = time.time()
            try:
                ses = fastf1.get_session(year, int(ev["RoundNumber"]), code)
                ses.load(laps=True, telemetry=args.telemetry, weather=False, messages=False)
                laps = ses.laps
            except Exception as e:  # FastF1 wraps HTTP errors, rate limits and missing data in many types
                raise Stop(f"gd{gd} {code}: {type(e).__name__}: {e}") from e
            if laps is None or not len(laps):
                raise Stop(f"gd{gd} {code}: no laps in the archive")
            got = folder_bytes(cache_dir()) - before
            rec["sessions"][code] = {"name": ses.name, "start": str(ses.date), "cols": COLS, "laps": lap_rows(laps)}
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump(rec, f, separators=(",", ":"))
            print(
                f"gd{gd:02d} {code:3s} {len(laps):5d} laps, downloaded {got / 1e6:6.1f} MB in {time.time() - t:5.1f} s"
            )
            if got > 0:
                downloads += 1
                time.sleep(PAUSE)


def cmd_measure(args):
    D = data_json()
    year = D["season"]
    g = next(x for x in D["schedule"] if x["gd"] == args.round)
    fastf1 = fastf1_ready()
    if session_live(year):
        raise Stop("an F1 session is live: not fetching now")
    ev = event_for(fastf1, year, g)
    before = folder_bytes(cache_dir())
    t = time.time()
    ses = fastf1.get_session(year, int(ev["RoundNumber"]), args.session)
    ses.load(laps=True, telemetry=True, weather=False, messages=False)
    got = folder_bytes(cache_dir()) - before
    cd = ses.car_data
    n = sum(len(v) for v in cd.values()) if isinstance(cd, dict) else 0
    print(f"gd{args.round} {args.session}: downloaded {got / 1e6:.1f} MB in {time.time() - t:.0f} s; {n} car samples")


# ---------- passes counted from the laps ----------


def crossings(rows, cols=COLS, lines=(1, 2, 3)):
    """{k: session time} for every timing line a driver crossed; k = 3 * (lap - 1) + line (line 3 = the lap's end)."""
    ix = {c: i for i, c in enumerate(cols)}
    out = {}
    for r in rows:
        for s in lines:
            t = r[ix[f"t{s}"]]
            if t is not None:
                out[3 * (r[ix["lap"]] - 1) + s] = t
    return out


def pit_marks(rows, cols=COLS):
    """Crossing indices whose interval (from the previous crossing) includes pit-lane running: entry late in the lap's
    last sector, the stop and exit in the next lap's first two sectors."""
    ix = {c: i for i, c in enumerate(cols)}
    out = set()
    for r in rows:
        k = 3 * (r[ix["lap"]] - 1)
        if r[ix["pitIn"]]:
            out.update((k + 3, k + 4, k + 5))
        if r[ix["pitOut"]]:
            out.update((k + 1, k + 2))
    return out


def count_passes(laps, grid, cols=COLS, lines=(1, 2, 3)):
    """On-track passes per driver: every change of race order between two cars from one shared timing-line
    crossing to the next, credited to the car now ahead, unless either car was in the pit lane in between. Race
    order at a line = who crossed it first on the same lap, so lapping a backmarker isn't a pass. The start is the
    grid (grid: {TLA: slot}, pit-lane starters missing or 0 -> the back)."""
    cr = {d: crossings(rows, cols, lines) for d, rows in laps.items()}
    pit = {d: pit_marks(rows, cols) for d, rows in laps.items()}
    slot = {d: (grid.get(d) or 99) for d in laps}
    passes = dict.fromkeys(laps, 0)
    ds = sorted(laps)
    for a_i, a in enumerate(ds):
        for b in ds[a_i + 1 :]:
            common = sorted(set(cr[a]) & set(cr[b]))
            prev_k, prev = 0, (slot[a] < slot[b]) - (slot[a] > slot[b])  # +1: a ahead
            for k in common:
                now = 1 if cr[a][k] < cr[b][k] else -1
                if prev and now != prev and not any(prev_k < e <= k for e in pit[a] | pit[b]):
                    passes[a if now > 0 else b] += 1
                prev_k, prev = k, now
    return passes


def official_overtakes(D, gd, code):
    """{TLA: overtakes} from the fantasy scoring lines (R OV / S OV), active drivers only."""
    idx = {i for i, e in enumerate(D["evNames"]) if e["c"] == f"{code} OV"}
    out = {}
    for a in D["assets"]:
        if a["kind"] != "D":
            continue
        h = next((h for h in a["hist"] if h and h["gd"] == gd and h["active"]), None)
        if h:
            out[a["tla"]] = sum(x[1] for x in h.get("ev") or [] if x[0] in idx)
    return out


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return float("nan")
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sxy / (sx * sy) if sx and sy else float("nan")


def cmd_passes(args):
    D = data_json()
    year = D["season"]
    rounds = parse_rounds(args.rounds, D["done"])
    res_key = {"R": "race", "S": "sprint"}
    tot = {}
    print("round        sess  official  3 lines  lap end   r(3 lines)  r(lap end)")
    for gd in rounds:
        path = os.path.join(out_dir(year), f"gd{gd:02d}.json")
        if not os.path.exists(path):
            continue
        rec = read_json(path)
        for code in ("R", "S"):
            s = rec["sessions"].get(code)
            if not s:
                continue
            grid = {x["tla"]: x.get("grid") for x in D["results"][res_key[code]].get(str(gd), [])}
            off = official_overtakes(D, gd, code)
            p3 = count_passes(s["laps"], grid, s["cols"])
            p1 = count_passes(s["laps"], grid, s["cols"], lines=(3,))
            ds = [d for d in off if d in p3]
            x, y3, y1 = [off[d] for d in ds], [p3[d] for d in ds], [p1[d] for d in ds]
            for key, v in (("off", x), ("p3", y3), ("p1", y1)):
                tot.setdefault((code, key), []).extend(v)
            name = next(g["name"] for g in D["schedule"] if g["gd"] == gd).replace(" Grand Prix", "")[:12]
            r3, r1 = pearson(x, y3), pearson(x, y1)
            print(f"{name:12s} {code:4s} {sum(x):8d} {sum(y3):8d} {sum(y1):8d} {r3:11.2f} {r1:11.2f}")
    for code in ("R", "S"):
        x, y3, y1 = tot.get((code, "off"), []), tot.get((code, "p3"), []), tot.get((code, "p1"), [])
        if not x:
            continue
        mae = sum(abs(a - b) for a, b in zip(x, y3, strict=True)) / len(x)
        print(
            f"ALL {code}: {len(x)} driver-races, official {sum(x)}, counted {sum(y3)} (3 lines) / {sum(y1)} (lap end); "
            f"r {pearson(x, y3):.2f} / {pearson(x, y1):.2f}; MAE per driver {mae:.2f}"
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("laps")
    p.add_argument("--rounds", help="e.g. 1-14 (default: every finished round)")
    p.add_argument("--sessions", help=f"comma list of {','.join(SESSIONS)} (default: all)")
    p.add_argument("--max", type=int, default=20, help="most sessions to download in this run")
    p.add_argument("--telemetry", action="store_true", help="also cache car and position data (~50-120 MB each)")
    p = sub.add_parser("measure")
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--session", default="Q")
    p = sub.add_parser("passes")
    p.add_argument("--rounds")
    args = ap.parse_args()
    try:
        {"laps": cmd_laps, "measure": cmd_measure, "passes": cmd_passes}[args.cmd](args)
    except Stop as e:
        print(f"STOPPED: {e}")
        raise SystemExit(2) from e


if __name__ == "__main__":
    main()
