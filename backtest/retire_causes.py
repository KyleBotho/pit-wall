"""Why each car retired, 2023 on: Jolpica's statuses say only "Retired" from 2023, Wikipedia's race classification
tables still give the reason ("Collision", "Power unit", ...). -> data/retire_causes.json

    python backtest/retire_causes.py            # 2023 .. this season's finished rounds (cached in cache/, paced)

One request per race to Wikipedia's API (the article Jolpica links for the race). Cars are matched by car number.
A reason is kept as written; `kind` sorts it into "crash" (the driver's or another driver's: accident, collision,
spun off, damage from one), "other" (the car, a disqualification, a withdrawal) or "unknown" (no reason given).
backtest/driver_skills.py reads it for the crash-rate check.
"""

import json
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wet_skill as W  # noqa: E402

from f1feeds import FeedError, get  # noqa: E402

OUT = os.path.join(W.HERE, "data", "retire_causes.json")
FIRST = 2023
CRASH_WORDS = ("accident", "collision", "crash", "spun", "spin", "damage", "debris", "puncture")
NOT_CRASH = ("floor damage", "undertray")  # wear / kerbs, not a crash, unless it says collision or accident


def kind(text):
    t = text.lower()
    if not t or t in ("retired", "ret", "dnf"):
        return "unknown"
    if any(w in t for w in ("collision", "accident", "crash", "spun", "spin")):
        return "crash"
    if any(w in t for w in NOT_CRASH):
        return "other"
    return "crash" if any(w in t for w in CRASH_WORDS) else "other"


def clean(cell):
    """A table cell's text: references, templates and link markup off."""
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", cell, flags=re.S)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)

    def template(m):
        name, _, rest = m.group(1).partition("|")
        name = name.strip().lower()
        if name == "nowrap":
            return rest
        return rest.split("|")[0] if name in ("abbr", "tooltip") else ""  # notes, flags: dropped

    while True:  # innermost first: a note may hold other templates
        t = re.sub(r"\{\{([^{}]*)\}\}", template, s)
        if t == s:
            break
        s = t
    s = re.sub(r"<[^>]+>", "", s)
    # cell attributes before the last single pipe (align=center| 52)
    s = s.split("|")[-1] if "|" in s else s
    return s.replace("'''", "").replace("''", "").strip()


def table(wikitext):
    """{car number: (mark, reason)} for the cars not classified (Ret / DNS / DSQ / NC ...) in the race table."""
    m = re.search(r"=+\s*Race classification\s*=+", wikitext)
    if not m:
        return None
    start = wikitext.find("{|", m.end())
    end = wikitext.find("\n|}", start)
    if start < 0 or end < 0:
        return None
    out = {}
    for row in wikitext[start:end].split("\n|-"):
        lines = [ln for ln in row.strip().split("\n") if ln.startswith(("!", "|"))]
        if len(lines) < 6 or not lines[0].startswith("!"):
            continue
        mark = clean(lines[0][1:])
        if mark.isdigit():
            continue
        cells = [clean(ln[1:]) for ln in lines[1:]]
        if not cells[0].isdigit():
            continue
        # number, driver, constructor, laps, time / retired, grid, points
        out[cells[0]] = (mark, cells[4] if len(cells) > 4 else "")
    return out


def build(last):
    races = {}
    for year in range(FIRST, last + 1):
        sched = get(
            f"https://api.jolpi.ca/ergast/f1/{year}.json?limit=100", W.cached(f"pj_sched_{year}.json"), reuse=True
        )["MRData"]["RaceTable"]["Races"]
        urls = {int(r["round"]): r["url"] for r in sched}
        res = W.pages(year, "results", "Results")
        for rnd, e in sorted(res.items()):
            title = urllib.parse.unquote(urls[rnd].rsplit("/", 1)[-1])
            tab = None
            # the article Jolpica links, else the one named after the race
            for k, page in enumerate((title, f"{year}_{e['name'].replace(' ', '_')}")):
                try:
                    d = get(
                        "https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2"
                        f"&redirects=1&page={urllib.parse.quote(page)}",
                        W.cached(f"wk_race_{year}_{rnd}{'_b' if k else ''}.json"),
                        reuse=True,
                    )
                    tab = table(d["parse"]["wikitext"])
                except (FeedError, KeyError) as err:
                    print(f"  ! {year} R{rnd} {page}: {err}")
                if tab is not None:
                    title = page
                    break
            rec = {"name": e["name"], "page": title, "out": {}}
            if tab is None:
                rec["missing"] = True
            for r in e["rows"]:
                if r["positionText"].isdigit():
                    continue
                mark, why = (tab or {}).get(r["number"], ("", ""))
                rec["out"][r["Driver"]["driverId"]] = {
                    "status": r["status"],
                    "mark": mark,
                    "why": why,
                    "kind": kind(why)
                    if r["positionText"] not in ("W", "F") and r["status"] != "Did not start"
                    else "dns",
                }
            races.setdefault(str(year), {})[str(rnd)] = rec
    return races


def main():
    last = W.CFG["season"]
    races = build(last)
    n = {"crash": 0, "other": 0, "unknown": 0, "dns": 0}
    words = {}
    for ys in races.values():
        for rec in ys.values():
            for o in rec["out"].values():
                n[o["kind"]] += 1
                words.setdefault((o["kind"], o["why"]), 0)
                words[(o["kind"], o["why"])] += 1
    miss = [f"{y} R{r}" for y, ys in races.items() for r, rec in ys.items() if rec.get("missing")]
    print(f"races {sum(len(v) for v in races.values())}, not classified: {n}; no table: {miss or 'none'}")
    for (k, w), c in sorted(words.items(), key=lambda t: (t[0][0], -t[1])):
        print(f"  {k:<8} {c:>3}  {w}")
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "_comment": "Built by backtest/retire_causes.py from Wikipedia's race classification tables "
                "(the reason a car wasn't classified; Jolpica only says Retired from 2023).",
                "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
                "races": races,
            },
            fh,
            ensure_ascii=False,
            indent=1,
        )
        fh.write("\n")


if __name__ == "__main__":
    main()
