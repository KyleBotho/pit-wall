"""Practice analysis for every finished round, for the practice-weight backtest (backtest/run.js).

Analyses each round's practice sessions with practice.py (the same code the site uses) from the OpenF1 files in
cache/, fetching any that are missing (slowly; OpenF1 refuses everything while an F1 session is live, so run it
between sessions). Writes backtest/practice_by_round.json: {gameday: [sessions as in DATA.practice]}.

Run:  python backtest/practice_rounds.py            (after python refresh.py, which writes cache/data.json)
"""

import json
import os
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import practice  # noqa: E402
from f1feeds import FeedError, get_soft  # noqa: E402

CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(ROOT, "backtest", "practice_by_round.json")


def main():
    with open(os.path.join(CACHE, "data.json"), encoding="utf-8") as f:
        data = json.load(f)
    cached = lambda n: os.path.join(CACHE, n)  # noqa: E731
    out = {}
    for g in data["schedule"]:
        if g["gd"] not in data["done"]:
            continue
        # every session of the meeting has ended, so "now" is just after the lock
        after = datetime.fromisoformat(g["lock"]) + timedelta(hours=1)
        try:
            sessions = practice.practice_for(get_soft, cached, g["lock"], after)
        except FeedError as e:
            print(f"  R{g['gd']}: skipped ({e})")
            continue
        done = [s for s in sessions if s["done"]]
        if done:
            out[str(g["gd"])] = sessions
        print(f"  R{g['gd']} {g['name']}: {len(done)} practice session(s)")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"Wrote {os.path.relpath(OUT, ROOT)} ({len(out)} rounds)")


if __name__ == "__main__":
    main()
