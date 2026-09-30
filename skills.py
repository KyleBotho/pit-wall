"""Per-driver skill edges for the engine's skill challengers (wetskill, sprintskill): DATA.skills.

Past seasons' observations are in data/skill_points.json (backtest/driver_skills.py --save, once a season); every
build adds the running season's finished rounds from the results refresh.py already has, so a driver's edges follow
his own results without anyone rebuilding anything. No fetching here.

An observation = a driver's result in a session of the kind (a wet qualifying; a sprint's grid; a sprint's finish)
next to x = his own level that season in the ordinary sessions of the same kind (mean position, same team, at least
MIN_BASE of them). His edge in that session = what his level predicts (a line fitted over all observations) minus
the result, in places (+ = better), clipped. Per driver the mean, shrunk towards 0 by k pseudo-sessions (k = the
noise in one session over the spread between drivers, one-way analysis of variance).
- wetQ: wet qualifying against dry qualifying.
- sprR: the sprint's finish against his Grand Prix finishes (classified ones, both), less what his sprint grid slot
  (against his Grand Prix qualifying) explains.
`drivers` = with the running season; `base` = past seasons only (the walk-forward backtest uses it: a round must not
see later rounds).
"""

import statistics

CLIP = 8  # places: one odd result shouldn't carry a driver's mean
MIN_BASE = 4  # ordinary sessions a driver needs that season for his own level
WET_SHARE = 0.5  # a qualifying is wet when at least this share of the drivers ran intermediates or wets
KINDS = ("wetQ", "sprGrid", "sprFin")


def residuals(pts):
    """pts: [[year, rnd, driver, x, v]] -> {(year, rnd, driver): edge}."""
    if len(pts) < 3:
        return {}
    mx, my = statistics.fmean(p[3] for p in pts), statistics.fmean(p[4] for p in pts)
    den = sum((p[3] - mx) ** 2 for p in pts)
    b = sum((p[3] - mx) * (p[4] - my) for p in pts) / den if den else 0.0
    a = my - b * mx
    return {(p[0], p[1], p[2]): max(-CLIP, min(CLIP, a + b * p[3] - p[4])) for p in pts}


def shrunk(res):
    """{(year, rnd, driver): edge} -> ({driver: (shrunk mean, n)}, k); no spread between drivers = all 0, k None."""
    by = {}
    for (_y, _r, drv), x in res.items():
        by.setdefault(drv, []).append(x)
    n_all, d = sum(len(v) for v in by.values()), len(by)
    if d < 2 or n_all <= d:
        return {drv: (0.0, len(v)) for drv, v in by.items()}, None
    grand = sum(sum(v) for v in by.values()) / n_all
    within = sum(sum((x - statistics.fmean(v)) ** 2 for x in v) for v in by.values()) / (n_all - d)
    msb = sum(len(v) * (statistics.fmean(v) - grand) ** 2 for v in by.values()) / (d - 1)
    n0 = (n_all - sum(len(v) ** 2 for v in by.values()) / n_all) / (d - 1)
    tau2 = max(0.0, (msb - within) / n0) if n0 > 0 else 0.0
    if tau2 <= 0:
        return {drv: (0.0, len(v)) for drv, v in by.items()}, None
    k = within / tau2
    return {drv: (statistics.fmean(v) * len(v) / (len(v) + k), len(v)) for drv, v in by.items()}, k


def compute(points):
    """points: {"wetQ" / "sprGrid" / "sprFin": [[year, rnd, driver, x, v]]} -> ({driver: {wetQ, nWetQ, sprR,
    nSprR}}, {"wetQ": k, "sprR": k}, the sprint grid edge's share in the sprint finish edge)."""
    wet = residuals(points.get("wetQ") or [])
    grid = residuals(points.get("sprGrid") or [])
    fin = {key: x for key, x in residuals(points.get("sprFin") or []).items() if key in grid}
    b = 0.0
    if len(fin) > 2:
        mg, mf = statistics.fmean(grid[key] for key in fin), statistics.fmean(fin.values())
        den = sum((grid[key] - mg) ** 2 for key in fin)
        b = sum((grid[key] - mg) * (x - mf) for key, x in fin.items()) / den if den else 0.0
    net = {key: x - b * grid[key] for key, x in fin.items()}
    out, ks = {}, {}
    for name, res in (("wetQ", wet), ("sprR", net)):
        vals, k = shrunk(res) if res else ({}, None)
        ks[name] = None if k is None else round(k, 1)
        for drv, (v, n) in vals.items():
            out.setdefault(drv, {})[name] = round(v, 3)
            out[drv]["n" + name[0].upper() + name[1:]] = n
    return out, ks, round(b, 3)


def season_points(season, results, wet_q):
    """The running season's observations from refresh.py's results ({"quali" / "race" / "sprint": {round: rows}};
    a row: tla, team, pos, and for races grid and cls). wet_q: {round: True / False / None = not known (left out)}.
    Drivers are their TLAs here; build() gives them their past seasons' ids."""

    def levels(rounds, keep, value):
        by = {}
        for gd, rows in rounds.items():
            if not keep(int(gd)):
                continue
            for r in rows:
                v = value(r)
                if v is not None:
                    by.setdefault((r["tla"], r.get("team")), []).append(v)
        return {k: statistics.fmean(v) for k, v in by.items() if len(v) >= MIN_BASE}

    quali, race, sprint = (results.get(k) or {} for k in ("quali", "race", "sprint"))
    wet = {int(g): w for g, w in (wet_q or {}).items()}
    pos = lambda r: r.get("pos")  # noqa: E731
    cls = lambda r: r.get("pos") if r.get("cls") else None  # noqa: E731
    dry = levels(quali, lambda g: wet.get(g) is False, pos)
    q_all = levels(quali, lambda _g: True, pos)
    fin = levels(race, lambda _g: True, cls)
    out = {k: [] for k in KINDS}
    for gd, rows in quali.items():
        if wet.get(int(gd)) is not True:
            continue
        for r in rows:
            x = dry.get((r["tla"], r.get("team")))
            if x is not None and r.get("pos") is not None:
                out["wetQ"].append([season, int(gd), r["tla"], round(x, 3), r["pos"]])
    for gd, rows in sprint.items():
        for r in rows:
            key = (r["tla"], r.get("team"))
            if key in q_all and (r.get("grid") or 0) > 0:
                out["sprGrid"].append([season, 500 + int(gd), r["tla"], round(q_all[key], 3), r["grid"]])
            if key in fin and r.get("cls") and r.get("pos") is not None:
                out["sprFin"].append([season, 500 + int(gd), r["tla"], round(fin[key], 3), r["pos"]])
    return out


def build(base, season=None, year=None):
    """DATA.skills from the past seasons' file (data/skill_points.json) and, if given, season_points() of the running
    season `year`: {"drivers": {TLA: {...}}, "base": the same from the seasons before `year` only, "k",
    "gridToFinish", "seasons", "n"}. Once the file holds `year` itself (folded over after its last race, fold.py),
    its rounds aren't added a second time, and "base" still leaves them out."""
    codes = base.get("codes") or {}  # past seasons' driver id -> TLA (one holder per TLA: the latest to race)
    ids = {c: i for i, c in codes.items()}

    def named(points):
        drivers, ks, b = compute(points)
        by_tla = {}
        for drv, rec in drivers.items():
            tla = codes.get(drv) or (drv[4:] if drv.startswith("tla:") else None)
            if tla:
                by_tla[tla] = rec
        return dict(sorted(by_tla.items())), ks, b

    every = {k: base.get(k) or [] for k in KINDS}
    past = {k: [r for r in every[k] if year is None or r[0] < year] for k in KINDS}
    folded = any(len(past[k]) != len(every[k]) for k in KINDS)
    base_drivers, ks, b = named(past)
    out = {"base": base_drivers, "seasons": list(base.get("seasons") or [])}
    n_new = 0
    if folded:
        out["drivers"], ks, b = named(every)
    elif season:
        both = {}
        for k in KINDS:
            rows = [[y, r, ids.get(t, "tla:" + t), x, v] for y, r, t, x, v in season.get(k) or []]
            n_new += len(rows)
            both[k] = past[k] + rows
        if n_new:
            drivers, ks, b = named(both)
            out["drivers"] = drivers
            out["seasons"] = [out["seasons"][0] if out["seasons"] else None, max(r[0] for k in KINDS for r in both[k])]
    if "drivers" not in out:
        out["drivers"] = base_drivers
    out.update(k=ks, gridToFinish=b, n={k: len(past[k]) for k in KINDS}, added=n_new)
    return out
