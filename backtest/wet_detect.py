"""Does the automatic wet-qualifying rule agree with the hand lists? (2026-09-30)

    python backtest/wet_detect.py      # OpenF1 stints of every qualifying 2023 .. season-1 (cached, paced)

The rule (extras.wet_share, used for the running season's qualifying sessions): the share of drivers who ran a set
of intermediates or wets in the session; wet = at least skills.WET_SHARE of them. Printed next to wet_skill.py's
hand list (intermediates or wets used, from memory) for the sessions where either says wet.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wet_skill as W  # noqa: E402

import extras  # noqa: E402
import skills  # noqa: E402
from f1feeds import FeedError, get  # noqa: E402


def main():
    last = W.CFG["season"] - 1
    agree = total = 0
    for year in range(2023, last + 1):
        sessions = get(f"{extras.OPENF1}/sessions?year={year}", W.cached(f"of_sessions_all_{year}.json"), reuse=True)
        names = {e["circuit"]: e["name"] for e in load_names(year)}
        for s in sessions:
            if s.get("session_name") != "Qualifying":
                continue
            try:
                st = get(
                    f"{extras.OPENF1}/stints?session_key={s['session_key']}",
                    W.cached(f"of_stints_{s['session_key']}.json"),
                    reuse=True,
                )
            except FeedError as e:
                print(f"  ! {year} {s.get('location')}: {e}")
                continue
            share = extras.wet_share(st)
            if share is None:
                continue
            name = names.get((s.get("date_start") or "")[:10], s.get("location") or "?")
            hand = W.is_wet(W.WET_QUALI, year, name)
            auto = share >= skills.WET_SHARE
            total += 1
            agree += hand == auto
            if hand or auto or share > 0:
                print(
                    f"  {year} {name:<28} wet-tyre share {share:4.2f}  rule {'wet' if auto else '-  '}  "
                    f"hand {'wet' if hand else '-'}"
                )
    print(f"agree on {agree} of {total} qualifying sessions")


def load_names(year):
    """The season's races keyed by the qualifying day (the day before the race, or two on a Saturday race)."""
    sched = get(f"https://api.jolpi.ca/ergast/f1/{year}.json?limit=100", W.cached(f"pj_sched_{year}.json"), reuse=True)
    out = []
    for r in sched["MRData"]["RaceTable"]["Races"]:
        q = (r.get("Qualifying") or {}).get("date")
        if q:
            out.append({"circuit": q, "name": r["raceName"]})
    return out


if __name__ == "__main__":
    main()
