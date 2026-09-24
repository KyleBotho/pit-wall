"""Turn a top-100 line-ups CSV (collected with Claude for Chrome) into anonymous aggregates for the Elite tab.

Run:  python elite_import.py "C:/Users/<you>/Downloads/f1_global_top100_lineups.csv"
Writes data/elite_top100.json: Boost share per driver and chip usage by round. No team or manager names are kept,
so the file is safe to commit to the public repo.
"""
import csv, json, os, sys, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
CHIP_COLS = {"wildcard": "Wildcard round", "limitless": "Limitless round", "finalfix": "Final Fix round",
             "x3": "Extra DRS round", "noneg": "No Negative round", "autopilot": "Autopilot round"}


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower().strip()


def main(path):
    with open(os.path.join(HERE, "cache", "data.json"), encoding="utf-8") as f:
        assets = json.load(f)["assets"]
    by_name = {}
    for a in sorted(assets, key=lambda a: not a["active"]):  # prefer the active entry (e.g. a driver who changed team)
        by_name.setdefault(norm(a["name"]), a["id"])
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    n = len(rows)
    rnd = next((int(k.split("(R")[1].rstrip(")")) for k in rows[0] if k.startswith("Drivers (R")), None)
    boost, x3, unknown = {}, {}, set()
    chip_used = {k: 0 for k in CHIP_COLS}
    chip_round = {k: {} for k in CHIP_COLS}
    played_last = {}
    for r in rows:
        for col, tgt in ((f"Boost 2x (R{rnd})", boost), (f"Extra DRS 3x (R{rnd})", x3)):
            nm = norm(r.get(col))
            if nm:
                if nm in by_name:
                    tgt[by_name[nm]] = tgt.get(by_name[nm], 0) + 1
                else:
                    unknown.add(r.get(col))
        for k, col in CHIP_COLS.items():
            v = (r.get(col) or "").strip()
            if v.isdigit():
                chip_used[k] += 1
                chip_round[k][v] = chip_round[k].get(v, 0) + 1
        c = (r.get(f"Chip played R{rnd}") or "").strip()
        if c:
            played_last[c] = played_last.get(c, 0) + 1
    out = {"source": "top 100 global line-ups", "round": rnd, "n": n,
           "boost": {k: round(v / n, 3) for k, v in boost.items()},
           "x3": {k: round(v / n, 3) for k, v in x3.items()},
           "chipUsed": {k: round(v / n, 3) for k, v in chip_used.items()},
           "chipRound": chip_round, "playedLast": played_last}
    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    with open(os.path.join(HERE, "data", "elite_top100.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"Wrote data/elite_top100.json from {n} teams (round {rnd}).", "Unmatched names: " + ", ".join(unknown) if unknown else "")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/f1_global_top100_lineups.csv"))
