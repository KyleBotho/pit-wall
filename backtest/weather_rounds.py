"""Rain forecasts as they stood at lock for every finished round -> backtest/weather_by_round.json (Open-Meteo, public).

The live site keeps every forecast it used (history/<season>/weather, since R16 2026); this rebuilds the same numbers
for earlier rounds from Open-Meteo's previous-runs archive. Same windows as extras.weather: the max hourly
precipitation probability from 1 h before a session to 1 h (qualifying, sprint) or 2 h (race) after its start.

Time of knowledge (third review): Open-Meteo's `_previous_dayN` value for an hour comes from the run issued N days
before that hour, so N is chosen so that even the window's LAST hour comes from a run issued before lock (`lead`;
`issuedBy` = the latest possible issue time). Only those values go into q / s / r. Open-Meteo keeps older-run
probabilities for few dates (2026: R4-R5); elsewhere only the latest run exists, issued after lock: it's kept apart
under `latest` for sensitivity runs (walk.js uses it only with WX_LATEST=1), never in the headline evaluation. No
ensemble, so no correlation: the walk-forward uses SIM.rainCorr.
Run from the project folder:  python backtest/weather_rounds.py [--all]   (--all: rebuild every round)
"""

import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from f1feeds import FeedError, get  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "weather_by_round.json")
REDO = "--all" in sys.argv
URL = (
    "https://previous-runs-api.open-meteo.com/v1/forecast?latitude={lat:.3f}&longitude={lon:.3f}"
    "&hourly={vars}&start_date={d0}&end_date={d1}&timezone=UTC"
)
WINDOWS = (("Qualifying", "q", 1), ("Sprint", "s", 1), ("Race", "r", 2))


def _dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def lead_days(last_hour, lock):
    """Days before an hour of the run the lock could have seen for it (1-7): issued no later than lock."""
    return min(7, max(1, math.ceil((last_hour - lock) / timedelta(days=1))))


def at_lock(g, fetch):
    """{q, s, r, lead, issuedBy, latest} rain chances for gameday g (schedule entry with lat/lon, lock, sessions)."""
    lock = _dt(g["lock"])
    starts = {s["type"]: _dt(s["start"]) for s in g["sessions"]}
    want = {key: (starts[typ], h) for typ, key, h in WINDOWS if typ in starts}
    if not want:
        return None
    leads = {key: lead_days(t + timedelta(hours=h), lock) for key, (t, h) in want.items()}
    names = sorted({f"precipitation_probability_previous_day{n}" for n in leads.values()})
    names.append("precipitation_probability")
    days = [t for t, _ in want.values()]
    d = fetch(
        URL.format(
            lat=g["lat"],
            lon=g["lon"],
            vars=",".join(names),
            d0=(min(days) - timedelta(days=1)).date().isoformat(),
            d1=(max(days) + timedelta(days=1)).date().isoformat(),
        )
    )
    hours = d.get("hourly") or {}
    times = [datetime.fromisoformat(t).replace(tzinfo=timezone.utc) for t in hours.get("time", [])]
    out = {"lead": leads, "issuedBy": {}, "latest": {}}

    def window(col, t0, h):
        v = [
            p
            for t, p in zip(times, hours.get(col) or [], strict=False)
            if p is not None and t0 - timedelta(hours=1) <= t <= t0 + timedelta(hours=h)
        ]
        return round(max(v) / 100, 2) if v else None

    for key, (t0, h) in want.items():
        v = window(f"precipitation_probability_previous_day{leads[key]}", t0, h)
        out[key] = v
        if v is not None:
            issued = t0 + timedelta(hours=h) - timedelta(days=leads[key])
            assert issued <= lock, (g["gd"], key)
            out["issuedBy"][key] = issued.isoformat(timespec="minutes")
        latest = window("precipitation_probability", t0, h)
        if latest is not None:
            out["latest"][key] = latest
    return out


def main():
    with open(os.path.join(ROOT, "cache", "data.json"), encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            out = json.load(f)
    tmp = os.path.join(ROOT, "cache", "wx_prev.json")
    for g in data["schedule"]:
        if g["gd"] not in data["done"] or (str(g["gd"]) in out and not REDO) or g.get("lat") is None:
            continue
        try:
            rec = at_lock(g, lambda url: get(url, tmp))
        except FeedError as e:
            print(f"  R{g['gd']}: {e}")
            continue
        if rec:
            out[str(g["gd"])] = rec
            print(f"  R{g['gd']}: {rec}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"{len(out)} rounds -> {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
