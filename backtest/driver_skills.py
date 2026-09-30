"""Which per-driver skills are stable enough to give a driver his own weight? (2026-09-30, a check before building
any of them as a challenger.)

    python backtest/skill_fetch.py      # once: lap 1 of every race, 2006-2013 results, sprint weekends (Jolpica)
    python backtest/driver_skills.py    # Jolpica 2014 .. season-1 from cache/

Two kinds of test, all on results only:
- a CONDITION edge (wet, street circuits, sprint weekends): a driver's result in those sessions against what his own
  results in that season's other sessions predict. Stable = one half of his sessions predicts the other half, his
  early career predicts his late career, and his edge at one team predicts his edge at his other teams. The placebo
  labels the same number of ordinary sessions at random: it shows how much of that is ordinary form swings.
- a TRAIT (crash rate, places gained on lap 1): the same three splits on the driver's own rate, against drivers
  shuffled within each race (chance).
And two effects for every driver alike (no per-driver weight): a rookie's gap to his team-mate over his first
season, and a driver's first race at a circuit.
"""

import json
import os
import random
import statistics
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wet_skill as W  # noqa: E402

import skills as live  # noqa: E402
from f1feeds import get  # noqa: E402

CLIP = 8
MIN_BASE = 4
STREET = {"monaco", "baku", "marina_bay", "jeddah", "vegas"}  # walls all the way round
CRASH = {"Collision", "Accident", "Collision damage", "Spun off", "Damage"}
CRASH_LAST = 2022  # Jolpica's statuses say only "Retired" from 2023; from then: data/retire_causes.json
CAUSES = os.path.join(W.HERE, "data", "retire_causes.json")  # backtest/retire_causes.py (Wikipedia's tables)
OUT = os.path.join(W.HERE, "data", "skill_points.json")
RACED_BEFORE_2006 = {"button", "alonso", "raikkonen", "massa"}  # the A1-Ring (2003), today's Red Bull Ring


def load(year, kind, key):
    """{round: {name, circuit, rows}} from the cache W.pages filled (fetched if missing)."""
    out, off, total = {}, 0, 1
    while off < total:
        d = get(
            f"https://api.jolpi.ca/ergast/f1/{year}/{kind}.json?limit=100&offset={off}",
            W.cached(f"pj_{kind}_{year}_{off}.json"),
            reuse=True,
        )["MRData"]
        total = int(d["total"])
        for r in d["RaceTable"]["Races"]:
            e = out.setdefault(
                int(r["round"]), {"name": r["raceName"], "circuit": r["Circuit"]["circuitId"], "rows": []}
            )
            e["rows"].extend(r[key])
        off += 100
    return out


def archived_wet(year, rnd):
    """A qualifying of a season refresh.py archived (2026 on): wet by its wet-tyre share (extras.wet_share), so a
    finished season's wet sessions need no hand list. Earlier seasons: wet_skill.py's lists."""
    path = os.path.join(W.HERE, "history", str(year), "races", f"gd{rnd:02d}.json")
    if not os.path.exists(path):
        return False
    with open(path, encoding="utf-8") as fh:
        share = (json.load(fh).get("quali") or {}).get("wetTyres")
    return share is not None and share >= live.WET_SHARE


def secs(t):
    if not t:
        return None
    m, _, s = t.rpartition(":")
    try:
        return (int(m) * 60 if m else 0) + float(s)
    except ValueError:
        return None


def build(last):
    """Flat observations. race / quali: (year, rnd, drv, team, value) with lower = better; info per (year, rnd)."""
    race, quali, lap1, crash, qtime, info = [], [], [], [], {}, {}
    sprint_r, sprint_q = [], []  # the sprint itself: finish, and its grid (= the sprint qualifying result)
    visits = {d: {"red_bull_ring"} for d in RACED_BEFORE_2006}
    first = set()  # (year, rnd, drv): his first race at this circuit
    debut, code = {}, {}
    causes = {}
    if os.path.exists(CAUSES):
        with open(CAUSES, encoding="utf-8") as fh:
            causes = json.load(fh)["races"]
    for year in range(2006, last + 1):
        res = load(year, "results", "Results")
        spr = load(year, "sprint", "SprintResults") if year >= 2021 else {}
        sprints = set(spr)
        for rnd, e in spr.items():
            n = sum(1 for r in e["rows"] if r["positionText"].isdigit())
            info[(year, 500 + rnd)] = {"ncls": n}
            for r in e["rows"]:
                drv, team = r["Driver"]["driverId"], r["Constructor"]["constructorId"]
                if r.get("status") == "Did not start":
                    continue
                sprint_r.append(
                    (year, 500 + rnd, drv, team, int(r["position"]) if r["positionText"].isdigit() else n + 1)
                )
                if int(r["grid"]) > 0:
                    sprint_q.append((year, 500 + rnd, drv, team, int(r["grid"])))
        ql = load(year, "qualifying", "QualifyingResults") if year >= W.FIRST else {}
        for rnd, e in sorted(res.items()):
            for r in e["rows"]:
                drv = r["Driver"]["driverId"]
                debut.setdefault(drv, year)
                if r["Driver"].get("code"):
                    code[drv] = (year, r["Driver"]["code"])
                seen = visits.setdefault(drv, set())
                if e["circuit"] not in seen:
                    first.add((year, rnd, drv))
                    seen.add(e["circuit"])
            if year < W.FIRST or any(e["name"].startswith(k) for (y, k) in W.SKIP_RACES if y == year):
                continue
            info[(year, rnd)] = {
                "name": e["name"],
                "circuit": e["circuit"],
                "wetR": W.is_wet(W.WET_RACES, year, e["name"]),
                "wetQ": W.is_wet(W.WET_QUALI, year, e["name"]) or archived_wet(year, rnd),
                "street": e["circuit"] in STREET,
                "sprint": rnd in sprints,
            }
            pos1 = {}
            if os.path.exists(W.cached(f"pj_lap1_{year}_{rnd}.json")):  # else: not fetched, no lap-1 test for this race
                with open(W.cached(f"pj_lap1_{year}_{rnd}.json"), encoding="utf-8") as fh:
                    lp = json.load(fh)["MRData"]["RaceTable"]["Races"]
                if lp and lp[0]["Laps"]:
                    pos1 = {t["driverId"]: int(t["position"]) for t in lp[0]["Laps"][0]["Timings"]}
            n_cls = info[(year, rnd)]["ncls"] = sum(1 for r in e["rows"] if r["positionText"].isdigit())
            for r in e["rows"]:
                drv, team = r["Driver"]["driverId"], r["Constructor"]["constructorId"]
                if r["positionText"] in ("W", "F") or r.get("status") == "Did not start":
                    continue
                cls = r["positionText"].isdigit()
                race.append((year, rnd, drv, team, int(r["position"]) if cls else n_cls + 1))
                why = None  # "crash" / "other", None = not known (left out of the crash check)
                if cls:
                    why = ""
                elif year <= CRASH_LAST:
                    why = "crash" if r["status"] in CRASH else "other"
                else:
                    k = causes.get(str(year), {}).get(str(rnd), {}).get("out", {}).get(drv, {}).get("kind")
                    why = k if k in ("crash", "other") else None
                if why is not None:
                    crash.append((year, rnd, drv, team, 1.0 if why == "crash" else 0.0))
                    # a control: retirements that aren't the driver's
                    info[(year, rnd)].setdefault("mech", []).append(
                        (year, rnd, drv, team, 1.0 if why == "other" else 0.0)
                    )
                g = int(r["grid"])
                if g > 0 and drv in pos1:
                    lap1.append((year, rnd, drv, team, g, g - pos1[drv]))
            for r in ql.get(rnd, {"rows": []})["rows"]:
                drv, team = r["Driver"]["driverId"], r["Constructor"]["constructorId"]
                quali.append((year, rnd, drv, team, int(r["position"])))
                qtime[(year, rnd, drv)] = [secs(r.get(k)) for k in ("Q1", "Q2", "Q3")]
    return {
        "sprint_r": sprint_r,
        "sprint_q": sprint_q,
        "race": race,
        "quali": quali,
        "lap1": lap1,
        "crash": crash,
        "qtime": qtime,
        "info": info,
        "first": first,
        "debut": debut,
        "code": code,
    }


# ---- stability of a per-driver number ----


def wcorr(xs, ys, ws):
    return W.wcorr(xs, ys, ws)


def halves(res, side, min_half):
    a, b = {}, {}
    for i, x in enumerate(res):
        (a if side(x, i) else b).setdefault(x[2], []).append(x[3])
    ds = [d for d in a if d in b and len(a[d]) >= min_half and len(b[d]) >= min_half]
    ws = [2 / (1 / len(a[d]) + 1 / len(b[d])) for d in ds]
    return wcorr([statistics.fmean(a[d]) for d in ds], [statistics.fmean(b[d]) for d in ds], ws), len(ds)


def random_halves(res, rng, min_half, n_iter):
    events = sorted({(x[0], x[1]) for x in res})
    rs = []
    for _ in range(n_iter):
        pick = set(rng.sample(events, len(events) // 2))
        c, _n = halves(res, lambda x, _i, pick=pick: (x[0], x[1]) in pick, min_half)
        if c is not None:
            rs.append(c)
    return statistics.fmean(rs) if rs else float("nan")


def stability(label, res, rng, min_half=3, n_iter=300, shuffle=0):
    """res: (year, rnd, drv, x, team), + = better. Prints the three splits; shuffle > 0 adds the chance level."""
    r_half = random_halves(res, rng, min_half, n_iter)
    order, seen = {}, {}
    for i, x in sorted(enumerate(res), key=lambda t: (t[1][0], t[1][1])):
        order[i] = seen[x[2]] = seen.get(x[2], -1) + 1
    c_time, n_time = halves(res, lambda x, i: order[i] < (seen[x[2]] + 1) / 2, min_half)
    cnt = {}
    for x in res:
        cnt.setdefault(x[2], {})
        cnt[x[2]][x[4]] = cnt[x[2]].get(x[4], 0) + 1
    main = {d: max(c, key=c.get) for d, c in cnt.items()}
    c_team, n_team = halves(res, lambda x, _i: x[4] == main[x[2]], min_half)
    by = {}
    for x in res:
        by.setdefault((x[0], x[1], x[4]), []).append(x[3])
    pr = [v for v in by.values() if len(v) == 2]
    c_mate = wcorr([p[0] for p in pr] + [p[1] for p in pr], [p[1] for p in pr] + [p[0] for p in pr], [1] * 2 * len(pr))
    chance = ""
    if shuffle:
        ev = {}
        for i, x in enumerate(res):
            ev.setdefault((x[0], x[1]), []).append(i)
        null = []
        for _ in range(shuffle):
            fake = list(res)
            for idx in ev.values():
                ds = [res[i][2] for i in idx]
                rng.shuffle(ds)
                for i, d in zip(idx, ds, strict=True):
                    fake[i] = (res[i][0], res[i][1], d, res[i][3], res[i][4])
            null.append(random_halves(fake, rng, min_half, 20))
        null = [v for v in null if v == v]
        p = sum(1 for v in null if v >= r_half) / len(null)
        chance = f"  chance {statistics.fmean(null):+.2f} (max {max(null):+.2f}), p {p:.2f}"
    f = lambda c: "  n/a" if c is None else f"{c:+.2f}"  # noqa: E731
    print(
        f"  {label:<36} n {len(res):>5}  halves {r_half:+.2f}  early/late {f(c_time)} ({n_time})  "
        f"main team/other teams {f(c_team)} ({n_team})  team-mates same race {f(c_mate)}{chance}"
    )
    return r_half


def condition(obs, flag):
    """A driver's result in the flagged sessions against his own level in that season's other sessions (same team):
    (year, rnd, drv, residual in places, team), + = better than his own level predicts."""
    base, hit = {}, []
    for y, r, d, t, v in obs:
        if flag(y, r, d):
            hit.append((y, r, d, t, v))
        else:
            base.setdefault((y, d, t), []).append(v)
    pts = [
        (statistics.fmean(base[(y, d, t)]), v, y, r, d, t)
        for y, r, d, t, v in hit
        if len(base.get((y, d, t), [])) >= MIN_BASE
    ]
    mx, my = statistics.fmean(p[0] for p in pts), statistics.fmean(p[1] for p in pts)
    b = sum((p[0] - mx) * (p[1] - my) for p in pts) / sum((p[0] - mx) ** 2 for p in pts)
    a = my - b * mx
    return [(y, r, d, max(-CLIP, min(CLIP, a + b * x - v)), t) for x, v, y, r, d, t in pts]


def condition_test(label, parts, rng, draws=20):
    """parts: [(obs, flag by (year, rnd))]. The real labels, then the placebo: as many unflagged sessions at random."""
    real = []
    for k, (obs, fl) in enumerate(parts):
        real += [(y, 1000 * k + r, d, x, t) for y, r, d, x, t in condition(obs, lambda y, r, _d, fl=fl: fl(y, r))]
    stability(label, real, rng)
    rs = []
    for _ in range(draws):
        fake = []
        for k, (obs, fl) in enumerate(parts):
            ev = sorted({(y, r) for y, r, *_ in obs})
            n = sum(1 for e in ev if fl(*e))
            plain = [o for o in obs if not fl(o[0], o[1])]
            pick = set(rng.sample(sorted({(o[0], o[1]) for o in plain}), n))
            fake += [
                (y, 1000 * k + r, d, x, t)
                for y, r, d, x, t in condition(plain, lambda y, r, _d, pick=pick: (y, r) in pick)
            ]
        rs.append(random_halves(fake, rng, 3, 40))
    print(f"  {'  placebo':<36} halves {statistics.fmean(rs):+.2f} (range {min(rs):+.2f} .. {max(rs):+.2f})")
    return real


def table(title, res, names, min_n, unit="", scale=1.0, k=None):
    """Drivers on this season's grid; k = pseudo-observations for the shrunk value."""
    by = {}
    for x in res:
        by.setdefault(x[2], []).append(x[3])
    rows = sorted(((statistics.fmean(v), d, v) for d, v in by.items() if d in names and len(v) >= min_n), reverse=True)
    print(f"\n{title}")
    for m, d, v in rows:
        se = statistics.stdev(v) / len(v) ** 0.5
        sh = f"  shrunk {scale * m * len(v) / (len(v) + k):+.2f}" if k else ""
        print(f"  {d:<16} n {len(v):>4}  {scale * m:+.2f}{unit} +/- {scale * se:.2f}{sh}")


# ---- effects for every driver alike ----


def pair_gap(D, year, rnd, a, b):
    """Qualifying gap a - b in % of the lap, in the last segment both set a time."""
    ta, tb = D["qtime"].get((year, rnd, a)), D["qtime"].get((year, rnd, b))
    if not ta or not tb:
        return None
    for i in (2, 1, 0):
        if ta[i] and tb[i]:
            return max(-2.0, min(2.0, (ta[i] - tb[i]) / tb[i] * 100))
    return None


def pairs(D, kind):
    """{(year, team, a, b): [(rnd, a's value - b's)]} for teams with two cars in the session; quali = % of the lap,
    race = places (classified only: a retirement is no comparison)."""
    by = {}
    for y, r, d, t, v in D["quali" if kind == "quali" else "race"]:
        by.setdefault((y, r, t), []).append((d, v))
    out = {}
    for (y, r, t), ds in by.items():
        if len(ds) != 2:
            continue
        (a, va), (b, vb) = sorted(ds)
        if kind == "quali":
            g = pair_gap(D, y, r, a, b)
        else:
            n = D["info"][(y, r)]["ncls"]  # a retired car sits at classified + 1
            g = None if va > n or vb > n else float(max(-CLIP, min(CLIP, va - vb)))
        if g is not None:
            out.setdefault((y, t, a, b), []).append((r, g))
    return out


def mean_se(xs):
    return (statistics.fmean(xs), statistics.stdev(xs) / len(xs) ** 0.5) if len(xs) > 1 else (float("nan"),) * 2


def rookie_curve(D, kind, unit):
    """First half vs second half of the sessions a driver shared with his team-mate that season, by experience."""
    seasons = {}
    for y, _r, d, _t, _v in D["race"]:
        seasons.setdefault(d, set()).add(y)
    out = {"rookie": [], "2nd year": [], "3rd year on": []}
    for (y, _t, a, b), gs in pairs(D, kind).items():
        if len(gs) < 10:
            continue
        gs.sort()
        h = len(gs) // 2
        d = statistics.fmean(g for _r, g in gs[:h]) - statistics.fmean(g for _r, g in gs[h:])  # + = a improved
        exp = {x: sum(1 for s in seasons[x] if s < y) + max(0, W.FIRST - D["debut"][x]) for x in (a, b)}
        for me, other, sign in ((a, b, 1), (b, a, -1)):
            if exp[other] < 2:
                continue  # against an experienced team-mate only
            grp = "rookie" if exp[me] == 0 else "2nd year" if exp[me] == 1 else "3rd year on"
            if grp == "3rd year on" and sign < 0:
                continue  # two experienced drivers: count the pair once
            out[grp].append(sign * d)
    for grp, xs in out.items():
        m, se = mean_se(xs)
        print(
            f"  {kind:<6} {grp:<12} driver-seasons {len(xs):>3}  gain on the team-mate, 2nd half vs 1st "
            f"{m:+.3f}{unit} +/- {se:.3f}"
        )


def new_track(D, kind, unit):
    """Sessions where one team-mate races the circuit for the first time and the other has raced it before, against
    the pair's gap in that season's other sessions (both new or both not)."""
    res = []
    for (y, _t, a, b), gs in pairs(D, kind).items():
        base = [g for r, g in gs if ((y, r, a) in D["first"]) == ((y, r, b) in D["first"])]
        if len(base) < MIN_BASE:
            continue
        m = statistics.fmean(base)
        for r, g in gs:
            fa, fb = (y, r, a) in D["first"], (y, r, b) in D["first"]
            if fa != fb:
                res.append(((a if fa else b), (g - m) if fa else -(g - m)))  # + = the newcomer was slower / behind
    by = {}
    for d, x in res:
        by.setdefault(d, []).append(x)
    m, se = mean_se([statistics.fmean(v) for v in by.values()])
    print(
        f"  {kind:<6} sessions {len(res):>3}, drivers {len(by):>2}  newcomer's loss to the team-mate "
        f"{m:+.3f}{unit} +/- {se:.3f} (per driver)"
    )


def points(obs, flag):
    """The flagged sessions as skills.py's observations: [year, rnd, driver, x, v], x = his own level that season in
    the other sessions (mean position, same team, MIN_BASE of them at least), v = the result."""
    base, hit = {}, []
    for y, r, d, t, v in obs:
        if flag(y, r, d):
            hit.append((y, r, d, t, v))
        else:
            base.setdefault((y, d, t), []).append(v)
    return [
        [y, r, d, round(statistics.fmean(base[(y, d, t)]), 3), v]
        for y, r, d, t, v in hit
        if len(base.get((y, d, t), [])) >= MIN_BASE
    ]


def skill_points(D):
    """Past seasons' observations for the engine's skill challengers (skills.py turns them into edges):
    wetQ = wet qualifying vs dry; sprGrid = the sprint's grid vs his Grand Prix qualifying; sprFin = the sprint's
    finish vs his Grand Prix finishes, classified ones only on both sides (a car that often retires from Grands
    Prix, retired = last, would otherwise look good in the sprints, where fewer cars stop)."""
    info = D["info"]
    is_s = lambda _y, r, _d: 500 <= r < 1000  # noqa: E731
    gp_q = [o for o in D["quali"] if o[0] >= 2021]
    done = [o for o in D["race"] + D["sprint_r"] if o[0] >= 2021 and o[4] <= info[(o[0], o[1])]["ncls"]]
    return {
        "wetQ": points(D["quali"], lambda y, r, _d: info.get((y, r), {}).get("wetQ")),
        "sprGrid": points(gp_q + D["sprint_q"], is_s),
        "sprFin": points(done, is_s),
    }


def skill_report(D, rng):
    """The edges as the engine gets them (skills.compute), and how stable the two kept ones are."""
    info = D["info"]
    pts = skill_points(D)
    team = {(y, r, d): t for k in ("quali", "sprint_q", "sprint_r") for y, r, d, t, _v in D[k]}
    rows = lambda res: [(y, r, d, x, team.get((y, r, d))) for (y, r, d), x in res.items()]  # noqa: E731
    drivers, ks, b = live.compute(pts)
    grid, fin = live.residuals(pts["sprGrid"]), live.residuals(pts["sprFin"])
    print(f"\nSKILLS FOR THE ENGINE (sprint finish edge = {b:.2f} x sprint grid edge + the driver's own)")
    stability("wet qualifying", rows(live.residuals(pts["wetQ"])), rng)
    sq = {k: x for k, x in grid.items() if k[0] >= 2023}  # before 2023 Friday qualifying set the sprint grid
    stability("sprint qualifying 2023 on", rows(sq), rng)
    print(f"    its shrink k = {live.shrunk(sq)[1] or float('inf'):.0f} pseudo-sessions (no edge of its own: not used)")
    stability("sprint finish beyond the grid", rows({k: x - b * grid[k] for k, x in fin.items() if k in grid}), rng)
    for key in ("wetQ", "sprR"):
        n = sum(1 for d in drivers.values() if key in d)
        print(f"  {key}: {n} drivers, shrink k = {ks[key]} pseudo-sessions")
    del info
    return pts, drivers


def main():
    last = W.CFG["season"] - 1
    D = build(last)
    info = D["info"]
    if "--save" in sys.argv:
        pts, drivers = skill_report(D, random.Random(20260930))
        # driver id -> TLA; two drivers with one TLA (VER: Vergne, Verstappen): the one who raced last keeps it
        holder = {}
        for drv, (year, c) in D["code"].items():
            if c not in holder or year > holder[c][0]:
                holder[c] = (year, drv)
        codes = {drv: c for c, (_y, drv) in sorted(holder.items())}
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "_comment": "Built by backtest/driver_skills.py --save (once a season, after priors.py): past "
                    "seasons' observations for the engine's wetskill / sprintskill challengers, [year, round "
                    "(500+ = a sprint), driver id, x = his own level that season, v = the result]. skills.py adds "
                    "the running season and turns them into per-driver edges (DATA.skills) at every build.",
                    "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
                    "seasons": [W.FIRST, last],
                    "codes": codes,
                    **pts,
                },
                fh,
                separators=(",", ":"),
            )
            fh.write("\n")
        print(f"wrote {OUT}: {', '.join(f'{k} {len(v)}' for k, v in pts.items())} observations")
        for c in ("VER", "NOR", "HAM", "LEC", "ALO", "PIA", "RUS"):
            drv = holder[c][1]
            print(f"  {c} {drivers.get(drv)}")
        return
    rng = random.Random(20260930)
    names = {
        d for (y, _r, d, _t, _v) in D["race"] if y == last
    }  # last season's drivers (the 2026 grid is most of them)
    print(
        f"Seasons {W.FIRST}-{last}: {len(info)} races, {len(D['lap1'])} lap-1 results, "
        f"{len(D['crash'])} starts with a status"
    )

    print("\nCONDITION EDGES (places vs the driver's own level that season; halves etc. = correlation across drivers)")
    wetq = condition_test("wet qualifying", [(D["quali"], lambda y, r: info.get((y, r), {}).get("wetQ"))], rng)
    condition_test("wet race", [(D["race"], lambda y, r: info.get((y, r), {}).get("wetR"))], rng)
    st = [(D[k], lambda y, r: info.get((y, r), {}).get("street")) for k in ("quali", "race")]
    condition_test("street circuit, qualifying", st[:1], rng)
    condition_test("street circuit, race", st[1:], rng)
    street = condition_test("street circuit, both", st, rng)
    sp = [(D[k], lambda y, r: info.get((y, r), {}).get("sprint")) for k in ("quali", "race")]
    sp = [([o for o in obs if o[0] >= 2021], fl) for obs, fl in sp]
    condition_test("sprint weekend, qualifying", sp[:1], rng)
    condition_test("sprint weekend, both", sp, rng)
    is_s = lambda _y, r: 500 <= r < 1000  # noqa: E731
    sq = ([o for o in D["quali"] if o[0] >= 2021] + D["sprint_q"], is_s)
    sr = ([o for o in D["race"] if o[0] >= 2021] + D["sprint_r"], is_s)
    condition_test("sprint qualifying vs GP qualifying", [sq], rng)
    condition_test("sprint finish vs GP finish", [sr], rng)
    sprint = condition_test("the sprint itself, both", [sq, sr], rng)

    print("\nTRAITS (the driver's own rate; chance = drivers shuffled within each race)")
    mean_c = statistics.fmean(x[4] for x in D["crash"])
    crash = [(y, r, d, mean_c - v, t) for y, r, d, t, v in D["crash"]]
    c_last = max(x[0] for x in crash)
    stability(f"crash retirements {W.FIRST}-{c_last}", crash, rng, min_half=25, n_iter=100, shuffle=40)
    if c_last > CRASH_LAST:
        old = [x for x in crash if x[0] <= CRASH_LAST]
        stability(f"  {W.FIRST}-{CRASH_LAST} only (Jolpica)", old, rng, min_half=25, n_iter=100, shuffle=40)
    mech_obs = [o for e in info.values() for o in e.get("mech", [])]
    mean_m = statistics.fmean(x[4] for x in mech_obs)
    stability(
        "  control: other retirements", [(y, r, d, mean_m - v, t) for y, r, d, t, v in mech_obs], rng, 25, 100, 40
    )
    slot = {}
    for _y, _r, _d, _t, g, x in D["lap1"]:
        slot.setdefault(g, []).append(x)
    slot = {g: statistics.fmean(v) for g, v in slot.items()}
    l1 = [(y, r, d, max(-6, min(6, x - slot[g])), t) for y, r, d, t, g, x in D["lap1"]]
    stability("lap 1 places gained vs the grid slot", l1, rng, min_half=25, n_iter=100, shuffle=40)
    ts = {}
    for y, _r, _d, x, t in l1:
        ts.setdefault((y, t), []).append(x)
    ts = {k: statistics.fmean(v) for k, v in ts.items()}
    l1t = [(y, r, d, x - ts[(y, t)], t) for y, r, d, x, t in l1]
    stability("  the same, less the car's season average", l1t, rng, min_half=25, n_iter=100, shuffle=40)

    print("\nFOR EVERY DRIVER ALIKE (vs the team-mate; qualifying in % of the lap, race in places; - = faster / ahead)")
    rookie_curve(D, "quali", "%")
    rookie_curve(D, "race", " pl")
    new_track(D, "quali", "%")
    new_track(D, "race", " pl")

    n_c = {}
    for x in crash:
        n_c.setdefault(x[2], []).append(x[3])
    print(
        f"\nField crash-retirement rate {W.FIRST}-{c_last}: {100 * mean_c:.1f}% of starts; "
        f"other retirements {100 * mean_m:.1f}%"
    )
    table("Crash retirements per 100 starts vs the field (+ = fewer), 60+ starts; shrunk with 60 pseudo-starts:",
          crash, names, 60, "", 100.0, 60)  # fmt: skip
    table(
        "Lap 1 places gained vs the grid slot, 60+ starts; shrunk with 40 pseudo-starts:", l1, names, 60, " pl", 1.0, 40
    )
    skill_report(D, rng)
    table("Wet qualifying edge in places, 5+ sessions; shrunk with 12 pseudo-sessions:", wetq, names, 5, " pl", 1.0, 12)
    table(
        "The sprint itself (sprint qualifying + sprint) edge in places, 10+ sessions; shrunk with 25:",
        sprint,
        names,
        10,
        " pl",
        1.0,
        25,
    )
    table(
        "Street circuits (qualifying + race) edge in places, 10+ sessions; shrunk with 25:",
        street,
        names,
        10,
        " pl",
        1.0,
        25,
    )


if __name__ == "__main__":
    main()
