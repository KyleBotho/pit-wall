"""Circuit priors from past seasons -> data/circuit_priors.json (committed; the engine reads it as DATA.priors).

Run once before each new season (and whenever you want the latest finished season added):
    python priors.py                 # seasons 2014 .. season-1 from Jolpica, 2023 .. season-1 from OpenF1
    python priors.py --from 2018     # a shorter history

One row per past race: how much the order changed (mean |grid - finish| and places gained per classified car, grid vs
finish rank correlation), how many cars retired, and from OpenF1 (2023 on) safety cars, virtual safety cars, red flags,
rain and on-track overtakes per starter. The engine turns these into per-circuit priors and scales them by this
season's trend (engine.js trackModel), so a new rule set that brings more overtakes shows up after a few rounds.
Everything is cached in cache/ (finished races never change), requests are paced (f1feeds.py).
"""

import argparse
import json
import os
from datetime import datetime

from f1feeds import FeedError, get, load_config

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(HERE, "data", "circuit_priors.json")
CFG = load_config("season")
FIRST_OPENF1 = 2023


def cached(name):
    return os.path.join(CACHE, name)


def spearman(xs, ys):
    n = len(xs)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        for k, i in enumerate(order):
            r[i] = k
        return r

    a, b = ranks(xs), ranks(ys)
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return round(num / den, 3) if den else None


def race_metrics(rows):
    """Order-change and retirement numbers for one race from Jolpica result rows (shared with refresh.py)."""
    started = [r for r in rows if r["positionText"] not in ("W", "F") and r.get("status") not in ("Did not start",)]
    cls = [r for r in started if r["positionText"].isdigit()]
    dnf = [r for r in started if r["positionText"] in ("R", "N")]
    gridded = [r for r in cls if int(r["grid"]) > 0]
    moves = [abs(int(r["grid"]) - int(r["position"])) for r in gridded]
    gains = [max(0, int(r["grid"]) - int(r["position"])) for r in gridded]
    return {
        "starters": len(started),
        "dnf": len(dnf),
        "move": round(sum(moves) / len(moves), 3) if moves else None,
        "gain": round(sum(gains) / len(gains), 3) if gains else None,
        "gridCorr": spearman([int(r["grid"]) for r in gridded], [int(r["position"]) for r in gridded]),
    }


def jolpica_season(year):
    """Every race of a season: schedule (circuit, date) + results."""
    sched = get(f"https://api.jolpi.ca/ergast/f1/{year}.json?limit=100", cached(f"pj_sched_{year}.json"), reuse=True)
    races = {int(r["round"]): r for r in sched["MRData"]["RaceTable"]["Races"]}
    res = {}
    off, total = 0, 1
    while off < total:
        d = get(
            f"https://api.jolpi.ca/ergast/f1/{year}/results.json?limit=100&offset={off}",
            cached(f"pj_results_{year}_{off}.json"),
            reuse=True,
        )["MRData"]
        total = int(d["total"])
        for r in d["RaceTable"]["Races"]:
            res.setdefault(int(r["round"]), []).extend(r["Results"])
        off += 100
    out = []
    for rnd, r in sorted(races.items()):
        if rnd not in res:
            continue
        out.append(
            {
                "season": year,
                "round": rnd,
                "circuit": r["Circuit"]["circuitId"],
                "name": r["raceName"],
                "date": r["date"],
                **race_metrics(res[rnd]),
            }
        )
    return out


def openf1_race(session_key, reuse=True):
    """Safety cars, VSCs, red flags, rain and overtakes in one race session (OpenF1)."""
    base = "https://api.openf1.org/v1"
    rc = get(f"{base}/race_control?session_key={session_key}", cached(f"of_rc_{session_key}.json"), reuse=reuse)
    wx = get(f"{base}/weather?session_key={session_key}", cached(f"of_weather_{session_key}.json"), reuse=reuse)
    rc = rc if isinstance(rc, list) else []
    wx = wx if isinstance(wx, list) else []
    msgs = [(m.get("message") or "").upper() for m in rc]
    info = {
        "sc": sum(1 for m in msgs if m.startswith("SAFETY CAR DEPLOYED")),
        "vsc": sum(1 for m in msgs if m.startswith("VIRTUAL SAFETY CAR DEPLOYED")),
        "red": int(any(m.get("flag") == "RED" for m in rc)),
        "rain": int(sum(1 for w in wx if w.get("rainfall")) >= 3),  # a few wet readings, not one stray drop
    }
    try:
        ov = get(
            f"{base}/overtakes?session_key={session_key}", cached(f"of_ovt_{session_key}.json"), reuse=reuse, attempts=1
        )
        info["ovt"] = len(ov) if isinstance(ov, list) else None
    except FeedError:
        info["ovt"] = None  # "No results found" for races OpenF1 hasn't processed
    return info


def openf1_season(year):
    s = get(
        f"https://api.openf1.org/v1/sessions?year={year}&session_type=Race",
        cached(f"of_races_{year}.json"),
        reuse=year < datetime.now().year,
    )
    return {
        x["date_start"][:10]: x["session_key"] for x in s if x["session_name"] == "Race" and not x.get("is_cancelled")
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="first", type=int, default=2014)
    args = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    last = CFG["season"] - 1
    rows = []
    for year in range(args.first, last + 1):
        print(f"{year}: Jolpica…")
        season = jolpica_season(year)
        if year >= FIRST_OPENF1:
            print(f"{year}: OpenF1…")
            keys = openf1_season(year)
            for r in season:
                # OpenF1 dates are UTC; a night race can start the day before its local date
                k = keys.get(r["date"]) or next((v for d, v in keys.items() if abs(_days(d, r["date"])) <= 1), None)
                if k:
                    r.update(openf1_race(k))
                    if r.get("ovt") is not None and r["starters"]:
                        r["ovt"] = round(r["ovt"] / r["starters"], 3)
        rows.extend(season)
    out = {
        "_comment": "Built by priors.py. One row per past race; engine.js trackModel turns them into circuit priors.",
        "built": datetime.now().strftime("%Y-%m-%d"),
        "seasons": [args.first, last],
        "races": rows,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"{len(rows)} races -> {os.path.relpath(OUT, HERE)}")


def _days(a, b):
    return (datetime.fromisoformat(a) - datetime.fromisoformat(b)).days


if __name__ == "__main__":
    main()
