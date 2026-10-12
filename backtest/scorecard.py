"""The "2x" scorecard: how much the projections add over a naive forecast, from the committed archive alone.

Needs no cache/data.json and no network: actual points per asset and round come from history/<season>/playerstats,
the projections from history/<season>/projections (frozen at lock) or, before those, rebuilt/ (rebuilt after the
fact), the walk-forward CRPS per round from history/<season>/accuracy.json. Plan and definitions:
docs/plans/2x-predictions.md. Run from the project folder:

    python backtest/scorecard.py              # the table
    python backtest/scorecard.py --json       # the same numbers as JSON

Headline (T1): CRPS skill = 1 - CRPS(model) / CRPS(naive). Naive = each asset's season-to-date mean points plus the
pooled spread of the earlier rounds' (actual - season-to-date mean), drivers and constructors apart. Rounds are the
independent units: every +/- is the standard error over rounds of the per-round paired difference.
"""

import argparse
import bisect
import glob
import itertools
import json
import math
import os
import statistics as st
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRST = 5  # the walk-forward backtest's first round (backtest/walk.js)
TOP = {"D": 8, "C": 4}  # "top" assets by price: the ones a team's points hinge on
CAP = 100.0  # the fresh team's budget, as walk.js pickTeam


def load(season):
    """{(id, gd): row} with actual points, kind, price, dnf and (where there is one) the projection."""
    hist = os.path.join(ROOT, "history", str(season))
    rows = {}
    # sorted: the fresh teams break ties between equal-valued line-ups by the order assets come in (a Linux and
    # a Windows listing once picked different naive teams, 2555 vs 2580)
    for f in sorted(glob.glob(os.path.join(hist, "playerstats", "*.json"))):
        with open(f, encoding="utf-8") as fh:
            v = json.load(fh)["Value"]
        for g in v["GamedayWiseStats"]:
            if not g.get("IsPlayed"):
                continue
            ev = [s for s in g["StatsWise"] if s["Event"].strip() != "Total"]
            rows[(str(v["PlayerId"]), g["GamedayId"])] = {
                "id": str(v["PlayerId"]),
                "gd": g["GamedayId"],
                "kind": "D" if v["PlayerSkill"] == 1 else "C",
                "price": g["PlayerValue"],
                # some rounds carry no "Total" line: the events add up to it where it is there
                "y": sum(s["Value"] for s in ev),
                "dnf": any(s["Event"].strip() == "Race not classified" for s in ev),
            }
    for sub in ("rebuilt", "projections"):  # frozen at lock wins over rebuilt
        for f in sorted(glob.glob(os.path.join(hist, sub, "gd*.json"))):
            gd = int(os.path.basename(f)[2:4])
            with open(f, encoding="utf-8") as fh:
                p = json.load(fh)
            for a, v in p["assets"].items():
                if (a, gd) in rows:
                    rows[(a, gd)]["x"] = v["x"]
                    rows[(a, gd)]["src"] = sub
    acc = {}
    f = os.path.join(hist, "accuracy.json")
    if os.path.exists(f):
        with open(f, encoding="utf-8") as fh:
            acc = {r["gd"]: r["walk"]["crps"] for r in json.load(fh)["rounds"] if r.get("walk")}
    return rows, acc


def crps_sample(sample, y):
    """Exact CRPS of the empirical distribution of `sample` at y: E|X - y| - E|X - X'| / 2."""
    s = sorted(sample)
    n = len(s)
    e1 = sum(abs(v - y) for v in s) / n
    e2 = sum((2 * i - n - 1) * v for i, v in enumerate(s, 1)) * 2 / (n * n)
    return e1 - e2 / 2


def spearman(a, b):
    def ranks(v):
        o = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for k, i in enumerate(o):
            r[i] = k
        return r

    ra, rb = ranks(a), ranks(b)
    ma, mb = st.mean(ra), st.mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb, strict=True))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return num / den if den else 0.0


def pick_team(cands, vals, cap=CAP):
    """The fresh team walk.js pickTeam picks: 5 drivers + 2 constructors within the cap, maximising the values with
    the boost (x2) on the best driver. cands = [(id, kind, price)]. Returns (driver ids, constructor ids, boost)."""
    drv = [c for c in cands if c[1] == "D"]
    con = [c for c in cands if c[1] == "C"]
    combos = []
    for ds in itertools.combinations(drv, 5):
        v = [vals[d[0]] for d in ds]
        combos.append((round(sum(d[2] for d in ds), 6), sum(v) + max(v), ds))
    combos.sort(key=lambda c: c[0])
    costs = [c[0] for c in combos]
    best_at = []  # best combo among the cheapest k+1
    for c in combos:
        best_at.append(c if not best_at or c[1] > best_at[-1][1] else best_at[-1])
    best = None
    for cs in itertools.combinations(con, 2):
        k = bisect.bisect_right(costs, cap - sum(c[2] for c in cs) + 1e-9) - 1
        if k < 0:
            continue
        tot = best_at[k][1] + sum(vals[c[0]] for c in cs)
        if best is None or tot > best[0]:
            best = (tot, best_at[k][2], cs)
    ds, cs = best[1], best[2]
    boost = max(ds, key=lambda d: vals[d[0]])
    return [d[0] for d in ds], [c[0] for c in cs], boost[0]


def carried_teams(rounds, picks, price_of, cap=CAP):
    """T3b: a team picked each round as the fresh team is, but with the money carried over: the first round has the
    cap, every later one the bank left plus the last team sold at this round's prices (unlimited transfers, no
    chips: the game's budget path, not its transfer rules). picks: {gd: (cands, vals, actual)}; price_of(id, gd) =
    the asset's price that round (its last known one if it has none). Returns (points per round, budget per round)."""
    bank, prev, pts, budgets = cap, None, [], []
    for gd in rounds:
        cands, vals, actual = picks[gd]
        budget = round(bank + (sum(price_of(i, gd) for i in prev[0] + prev[1]) if prev else 0), 4)
        team = pick_team(cands, vals, budget)
        price = {c[0]: c[2] for c in cands}
        bank = round(budget - sum(price[i] for i in team[0] + team[1]), 4)
        pts.append(team_points(team, actual))
        budgets.append(budget)
        prev = team
    return pts, budgets


def team_points(team, actual):
    ds, cs, boost = team
    return sum(actual[i] for i in ds + cs) + actual[boost]


def paired(a, b):
    d = [x - y for x, y in zip(a, b, strict=True)]
    return st.mean(d), (st.stdev(d) / math.sqrt(len(d)) if len(d) > 1 else float("nan"))


def scorecard(rows, acc, first=FIRST):
    by = defaultdict(list)
    for r in rows.values():
        by[r["id"]].append(r)
    for v in by.values():
        v.sort(key=lambda r: r["gd"])

    def before(i, gd):
        return [r["y"] for r in by[i] if r["gd"] < gd]

    rounds = sorted({gd for (_, gd), r in rows.items() if gd >= first and "x" in r})
    prices = defaultdict(dict)
    for r in rows.values():
        prices[r["id"]][r["gd"]] = r["price"]

    def price_of(i, gd):
        p = prices[i]
        return p[gd] if gd in p else p[max(g for g in p if g < gd)]

    def round_picks(gd):
        """(candidates, model values, naive values, actual points) of the assets with a projection and a past."""
        here = [r for r in rows.values() if r["gd"] == gd and "x" in r and before(r["id"], gd)]
        cands = [(r["id"], r["kind"], r["price"]) for r in here]
        actual = {r["id"]: r["y"] for r in here}
        vm = {r["id"]: r["x"] for r in here}
        vn = {r["id"]: st.mean(before(r["id"], gd)) for r in here}
        return cands, vm, vn, actual

    out = {"rounds": rounds, "perRound": []}
    naive_crps, model_crps, mae_m, mae_n = [], [], [], []
    top_m, top_n, team_m, team_n, team_b = [], [], [], [], []
    for gd in rounds:
        here = [r for r in rows.values() if r["gd"] == gd and "x" in r and before(r["id"], gd)]
        cr, em, en = [], [], []
        for kind in "DC":
            # the naive forecast's spread: earlier rounds' (actual - season-to-date mean), pooled
            resid = [
                q["y"] - st.mean(before(i, q["gd"]))
                for i, rs in by.items()
                for q in rs
                if q["kind"] == kind and q["gd"] < gd and len(before(i, q["gd"])) >= 2
            ]
            for r in (r for r in here if r["kind"] == kind):
                m = st.mean(before(r["id"], gd))
                if resid:  # none before R4: no spread yet (and no walk-forward CRPS either)
                    cr.append(crps_sample([m + e for e in resid], r["y"]))
                em.append(abs(r["y"] - r["x"]))
                en.append(abs(r["y"] - m))
            # ranking among the top-priced assets (the ones teams are built around)
            top = sorted((r for r in here if r["kind"] == kind), key=lambda r: -r["price"])[: TOP[kind]]
            ys = [r["y"] for r in top]
            top_m.append((kind, spearman([r["x"] for r in top], ys)))
            top_n.append((kind, spearman([st.mean(before(r["id"], gd)) for r in top], ys)))
        naive_crps.append(st.mean(cr) if cr else None)
        model_crps.append(acc.get(gd))
        mae_m.append(st.mean(em))
        mae_n.append(st.mean(en))
        cands, vm, vn, actual = round_picks(gd)
        team_m.append(team_points(pick_team(cands, vm), actual))
        team_n.append(team_points(pick_team(cands, vn), actual))
        team_b.append(team_points(pick_team(cands, actual), actual))
        out["perRound"].append(
            {
                "gd": gd,
                "crps": model_crps[-1],
                "crpsNaive": round(naive_crps[-1], 3) if naive_crps[-1] is not None else None,
                "mae": round(mae_m[-1], 2),
                "maeNaive": round(mae_n[-1], 2),
                "team": team_m[-1],
                "teamNaive": team_n[-1],
                "teamBest": team_b[-1],
            }
        )
    both = [(m, n) for m, n in zip(model_crps, naive_crps, strict=True) if m is not None and n is not None]
    if both:
        m, n = zip(*both, strict=True)
        d, se = paired(m, n)
        out["T1"] = {
            "rounds": len(both),
            "crps": round(st.mean(m), 3),
            "crpsNaive": round(st.mean(n), 3),
            "skill": round(1 - st.mean(m) / st.mean(n), 3),
            "dCrps": round(d, 3),
            "se": round(se, 3),
            "target2x": round(st.mean(n) * (1 - 2 * (1 - st.mean(m) / st.mean(n))), 2),
        }
    d, se = paired(mae_m, mae_n)
    out["mae"] = {
        "model": round(st.mean(mae_m), 2),
        "naive": round(st.mean(mae_n), 2),
        "d": round(d, 2),
        "se": round(se, 2),
    }
    out["T2"] = {}
    for kind in "DC":
        a = [v for k, v in top_m if k == kind]
        b = [v for k, v in top_n if k == kind]
        d, se = paired(a, b)
        out["T2"][kind] = {
            "top": TOP[kind],
            "model": round(st.mean(a), 3),
            "naive": round(st.mean(b), 3),
            "edge": round(d, 3),
            "se": round(se, 3),
        }
    d, se = paired(team_m, team_n)
    out["T3"] = {
        "team": sum(team_m),
        "teamNaive": sum(team_n),
        "teamBest": sum(team_b),
        "perRound": round(d, 1),
        "se": round(se, 1),
        "sdPerRound": round(st.stdev([x - y for x, y in zip(team_m, team_n, strict=True)]), 1)
        if len(rounds) > 1
        else None,
    }
    # T3b: the same picks with the budget carried from round to round (price rises and falls kept), over the whole
    # season the archive can play: from the first round with a projection (R2: rebuilt; R1 has none), whatever `first`
    path = sorted({gd for (_, gd), r in rows.items() if "x" in r})
    pk = {gd: round_picks(gd) for gd in path}
    path = [gd for gd in path if pk[gd][0]]
    cm, bm = carried_teams(path, {gd: (pk[gd][0], pk[gd][1], pk[gd][3]) for gd in path}, price_of)
    cn, bn = carried_teams(path, {gd: (pk[gd][0], pk[gd][2], pk[gd][3]) for gd in path}, price_of)
    cb, bb = carried_teams(path, {gd: (pk[gd][0], pk[gd][3], pk[gd][3]) for gd in path}, price_of)
    d, se = paired(cm, cn)
    out["T3b"] = {
        "rounds": path,
        "team": sum(cm),
        "teamNaive": sum(cn),
        "teamBest": sum(cb),
        "perRound": round(d, 1),
        "se": round(se, 1),
        "budget": bm[-1],
        "budgetNaive": bn[-1],
        "budgetBest": bb[-1],
        "byRound": [
            {"gd": g, "team": a, "teamNaive": b, "teamBest": c, "budget": x, "budgetNaive": y}
            for g, a, b, c, x, y in zip(path, cm, cn, cb, bm, bn, strict=True)
        ],
    }
    out["floor"] = dnf_floor(by)
    return out


def dnf_floor(by):
    """How much of a driver's round-to-round variance is the retirement coin flip alone: p(1 - p) x (points when
    finishing - points when not)^2, with p the season's driver retirement rate, against the within-driver variance."""
    drv = [r for rs in by.values() for r in rs if r["kind"] == "D"]
    p = st.mean(1.0 if r["dnf"] else 0.0 for r in drv)
    deltas, within = [], []
    for rs in by.values():
        if rs[0]["kind"] != "D":
            continue
        fin = [r["y"] for r in rs if not r["dnf"]]
        out = [r["y"] for r in rs if r["dnf"]]
        if len(fin) < 3:
            continue
        deltas.append(abs(st.mean(fin) - (st.mean(out) if out else -20.0)))
        m = st.mean(r["y"] for r in rs)
        within += [(r["y"] - m) ** 2 for r in rs]
    var = st.mean(p * (1 - p) * d**2 for d in deltas)
    return {
        "pDnf": round(p, 3),
        "dnfVar": round(var, 1),
        "withinVar": round(st.mean(within), 1),
        "share": round(var / st.mean(within), 2),
        # a two-point forecast that knows p and both outcomes exactly still scores p (1 - p) |delta|
        "dnfCrps": round(st.mean(p * (1 - p) * d for d in deltas), 2),
    }


def show(s):
    t1, t2, t3, fl = s.get("T1"), s["T2"], s["T3"], s["floor"]
    print(f"Rounds {s['rounds'][0]}-{s['rounds'][-1]} ({len(s['rounds'])})")
    if t1:
        print(
            f"T1 CRPS skill over naive: {t1['skill']:.1%}  (model {t1['crps']} vs naive {t1['crpsNaive']}, "
            f"{t1['dCrps']:+.3f} +/- {t1['se']} a round; 2x = {2 * t1['skill']:.1%} = CRPS {t1['target2x']})"
        )
    m = s["mae"]
    print(f"   MAE model {m['model']} vs naive {m['naive']}  ({m['d']:+.2f} +/- {m['se']})")
    for k, v in t2.items():
        print(
            f"T2 rank within the top {v['top']} {'drivers' if k == 'D' else 'constructors'} (Spearman): "
            f"model {v['model']} vs naive {v['naive']}, edge {v['edge']:+.3f} +/- {v['se']}"
        )
    print(
        f"T3 fresh $100m team: model {t3['team']:.0f} vs naive {t3['teamNaive']:.0f} (hindsight best "
        f"{t3['teamBest']:.0f}); {t3['perRound']:+.1f} +/- {t3['se']} a round (sd {t3['sdPerRound']})"
    )
    b = s["T3b"]
    print(
        f"T3b the same with the budget carried R{b['rounds'][0]}-R{b['rounds'][-1]}, $100m at the start: "
        f"model {b['team']:.0f} vs naive {b['teamNaive']:.0f} (hindsight best {b['teamBest']:.0f}); "
        f"{b['perRound']:+.1f} +/- {b['se']} a round; budget now ${b['budget']:.1f}m vs ${b['budgetNaive']:.1f}m "
        f"(best ${b['budgetBest']:.1f}m)"
    )
    print(
        f"Floor: driver retirement rate {fl['pDnf']}; the retirement coin flip alone is {fl['dnfVar']} of the "
        f"{fl['withinVar']} within-driver variance ({fl['share']:.0%}), CRPS >= {fl['dnfCrps']} from it alone"
    )


def main():
    with open(os.path.join(ROOT, "config", "season.json"), encoding="utf-8") as fh:
        season = json.load(fh)["season"]
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=season)
    ap.add_argument("--first", type=int, default=FIRST, help="first round scored")
    ap.add_argument("--json", action="store_true", help="print JSON instead of the table")
    args = ap.parse_args()
    s = scorecard(*load(args.season), first=args.first)
    if args.json:
        print(json.dumps(s, indent=1))
    else:
        show(s)


if __name__ == "__main__":
    main()
