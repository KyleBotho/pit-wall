"""Rain forecasts as they stood at lock for every finished round -> backtest/weather_by_round.json (Open-Meteo, public).

The live site keeps every forecast it used (history/<season>/weather, since R16 2026); this rebuilds the same numbers
for earlier rounds from Open-Meteo's previous-runs archive: for each session, the forecast issued the whole number of
days before it that the lock left (at least one: the run before lock, never a later one). Same windows as
extras.weather: the max hourly precipitation probability from 1 h before a session to 1 h (qualifying, sprint) or 2 h
(race) after its start. No ensemble, so no correlation: the walk-forward uses SIM.rainCorr.

Open-Meteo keeps the older runs' precipitation PROBABILITY only for some dates (2026: R4-R5); elsewhere the value is
the latest run's (`lead` 0: issued up to about a day after lock, so a little better informed than the site was).
Run from the project folder:  python backtest/weather_rounds.py
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
URL = (
    "https://previous-runs-api.open-meteo.com/v1/forecast?latitude={lat:.3f}&longitude={lon:.3f}"
    "&hourly={vars}&start_date={d0}&end_date={d1}&timezone=UTC"
)
WINDOWS = (("Qualifying", "q", 1), ("Sprint", "s", 1), ("Race", "r", 2))


def _dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def lead_days(start, lock):
    """Days before the session of the last run the lock could have seen (1-7)."""
    return min(7, max(1, math.ceil((start - lock) / timedelta(days=1))))


def at_lock(g, fetch):
    """{q, s, r} rain chances for gameday g (schedule entry with lat/lon, lock, sessions) as at its lock."""
    lock = _dt(g["lock"])
    starts = {s["type"]: _dt(s["start"]) for s in g["sessions"]}
    want = {key: (starts[typ], h) for typ, key, h in WINDOWS if typ in starts}
    if not want:
        return None
    leads = {key: lead_days(t, lock) for key, (t, _) in want.items()}
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
    out = {"lead": leads}
    for key, (t0, h) in want.items():
        for col_name in (f"precipitation_probability_previous_day{leads[key]}", "precipitation_probability"):
            col = hours.get(col_name) or []
            v = [
                p
                for t, p in zip(times, col, strict=False)
                if p is not None and t0 - timedelta(hours=1) <= t <= t0 + timedelta(hours=h)
            ]
            if v:
                out[key] = round(max(v) / 100, 2)
                if col_name == "precipitation_probability":
                    out["lead"][key] = 0
                break
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
        if g["gd"] not in data["done"] or str(g["gd"]) in out or g.get("lat") is None:
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
