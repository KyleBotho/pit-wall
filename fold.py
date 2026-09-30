"""Season fold-over: the last finished season into what the model carries from past seasons.

    python fold.py                 # through = this season if it's over, else the one before
    python fold.py --through 2026

Run by .github/workflows/fold.yml (the admin panel's "Fold over" button), or by hand. Rebuilds
- data/circuit_priors.json (priors.py: one row per past race; the track model and the timed safety car), and
- data/skill_points.json (backtest/driver_skills.py --save: the skill challengers' past observations),
both through the last finished season, and notes what it did in history/<season>/fold.json. Before the season's
last race that's the season before (the files come out as they were); after it, the season itself, so the next
season starts with it in. Doing it twice changes nothing. The same workflow then writes the season report
(backtest/season_report.js). Fetches from Jolpica and OpenF1 (paced, cached in cache/): about 20 minutes from an
empty cache; it stops with an error while an F1 session is live (OpenF1 is closed then) and nothing is changed.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

from f1feeds import load_config

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = load_config("season")
SEASON = CFG["season"]


def season_over(data):
    """The config's season has run its last race (refresh.py's data: nothing next, every round done)."""
    return bool(data) and data.get("season") == SEASON and data.get("next") is None and bool(data.get("done"))


def through(data):
    """The last finished season: this one once it's over, else the one before."""
    return SEASON if season_over(data) else SEASON - 1


def read(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--through", type=int, help="the last season to fold in (default: the last finished one)")
    args = ap.parse_args()
    last = args.through or through(read(os.path.join(HERE, "cache", "data.json")))
    if last > SEASON:
        sys.exit(f"--through {last}: the season in config/season.json is {SEASON}")
    print(f"Folding over through {last} (the season in the config: {SEASON})")
    if last == SEASON:
        # pages of the running season cached while it ran are incomplete: fetch them again
        for pat in (f"pj_*_{last}_*.json", f"pj_sched_{last}.json", f"of_races_{last}.json"):
            for f in glob.glob(os.path.join(HERE, "cache", pat)):
                os.remove(f)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    subprocess.run([sys.executable, "priors.py", "--through", str(last)], cwd=HERE, check=True, env=env)
    subprocess.run(
        [sys.executable, os.path.join("backtest", "driver_skills.py"), "--save", "--through", str(last)],
        cwd=HERE,
        check=True,
        env=env,
    )
    pri = read(os.path.join(HERE, "data", "circuit_priors.json"))
    pts = read(os.path.join(HERE, "data", "skill_points.json"))
    note = {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
        "season": SEASON,
        "through": last,
        "priors": {"seasons": pri["seasons"], "races": len(pri["races"])},
        "skills": {"seasons": pts["seasons"], **{k: len(pts[k]) for k in ("wetQ", "sprGrid", "sprFin")}},
    }
    out = os.path.join(HERE, "history", str(SEASON), "fold.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(note, fh, indent=1)
        fh.write("\n")
    print(f"Folded: {note['priors']['races']} past races, {note['skills']['wetQ']} wet-qualifying results")


if __name__ == "__main__":
    main()
