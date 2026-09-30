"""Extra past-season data for backtest/driver_skills.py (Jolpica, cached in cache/, paced): every race's lap 1
(positions at the end of the first lap), 2006-2013 results (which circuits a veteran had raced on) and the sprint
weekends. Run once: python backtest/skill_fetch.py"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wet_skill as W  # noqa: E402

from f1feeds import get  # noqa: E402


def main():
    last = W.CFG["season"] - 1
    for year in range(2006, W.FIRST):
        W.pages(year, "results", "Results")
    for year in range(2021, last + 1):
        W.pages(year, "sprint", "SprintResults")
    n = 0
    for year in range(W.FIRST, last + 1):
        for rnd in sorted(W.pages(year, "results", "Results")):
            get(
                f"https://api.jolpi.ca/ergast/f1/{year}/{rnd}/laps/1.json?limit=100",
                W.cached(f"pj_lap1_{year}_{rnd}.json"),
                reuse=True,
            )
            n += 1
    print("lap-1 files", n)


if __name__ == "__main__":
    main()
