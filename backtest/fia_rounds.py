"""The FIA documents of every finished round -> history/<season>/fia/ (index, marked `backfill`) and their technical
documents' text + summaries (collect.fia_tech: PU elements, upgrades, parc-fermé changes, the Pirelli preview).

The live site archives the current event's documents from R15 2026 on (refresh.py, around race weekends); this
fills in the earlier rounds from the FIA's per-event pages. Paced like refresh.py (one request at a time); ~15
events x (one page, ~30 s, + ~8 PDFs). Re-running only reads what's missing.
Run from the project folder:  python backtest/fia_rounds.py [--reparse]
"""

import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import collect  # noqa: E402
import refresh  # noqa: E402

REPARSE = "--reparse" in sys.argv  # after a parser change: every event's summary rebuilt from its kept texts
EVENT_URL = collect.FIA_URL + "/season/season-{season}-2072/event/{name}"
# the FIA's event names where they differ from the fantasy schedule's (config/season.json fiaNames)
ALIASES = refresh.CFG.get("fiaNames") or {}


def main():
    data = refresh.read_json(os.path.join(refresh.HERE, "cache", "data.json"))
    now = datetime.now(timezone.utc)
    season = data["season"]
    slugs = {collect.event_slug(g["name"], season) for g in data["schedule"]}
    for g in data["schedule"]:
        if datetime.fromisoformat(g["raceStart"]) > now:
            break
        slug = collect.event_slug(g["name"], season)
        names = collect.fia_names(g["name"], ALIASES)
        p = collect.fia_event_path(g["name"], season, refresh.archived, ALIASES)
        if os.path.exists(p) and refresh.read_json(p)["docs"]:
            print(f"R{g['gd']} {g['name']}: index kept")
            continue
        for name in names:
            try:
                rows = collect.parse_fia(refresh.fia_text(EVENT_URL.format(season=season, name=quote(name))))
            except OSError as e:  # an unknown name can answer 500
                print(f"  {name}: {e}")
                continue
            rows = [r for r in rows if r["event"].startswith(f"{season}_")]
            # a wrong name answers with the current event's page: keep only this round's documents (the FIA's own
            # slug where its name differs, as long as it isn't another round's)
            rows = [r for r in rows if r["event"] == slug or r["event"] not in slugs]
            events = {r["event"] for r in rows}
            if rows:
                n = collect.merge_fia(rows, refresh.archived, refresh.read_json, refresh.write_json, now, backfill=True)
                print(f"R{g['gd']} {g['name']}: {n} documents ({', '.join(sorted(events))})")
                break
        else:
            print(f"R{g['gd']} {g['name']}: no page found")
    # the stewards' decisions of each finished round, read for grid penalties (`grid` on each car-infringement
    # document, as refresh.py does for the coming race; fourth review: without them an empty list in walk.js penAt
    # meant "never read", not "no penalties")
    for g in data["schedule"]:
        if datetime.fromisoformat(g["raceStart"]) > now:
            break
        p = collect.fia_event_path(g["name"], season, refresh.archived, ALIASES)
        if not os.path.exists(p):
            continue
        before = None
        while True:
            left = [
                d
                for d in refresh.read_json(p)["docs"]
                if collect.PEN_TITLE.search(d.get("title") or "") and "grid" not in d
            ]
            if not left or len(left) == before:  # all read, or none could be (no pypdf, the site down)
                if left:
                    print(f"R{g['gd']} {g['name']}: {len(left)} decisions not read; re-run later")
                break
            before = len(left)
            pen, _, _ = collect.fia_penalties(
                refresh.archived, refresh.read_json, refresh.write_json, os.path.basename(p)[:-5], refresh.fia_bytes
            )
            print(f"R{g['gd']} {g['name']}: decisions read, {len(left)} were left; grid penalties {pen or 'none'}")
    args = (refresh.archived, refresh.read_json, refresh.write_json, refresh.fia_bytes, refresh.CFG["teams"])
    if REPARSE:
        collect.fia_tech(*args, most=0, reparse=True)
        print("  summaries rebuilt from the kept texts")
    while n := collect.fia_tech(*args, most=20):
        print(f"  read {n} technical documents")


if __name__ == "__main__":
    main()
