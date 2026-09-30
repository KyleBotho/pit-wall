"""Is a driver's wet-weather edge a stable skill? A check before building a `wetskill` challenger (2026-09-30).

    python backtest/wet_skill.py            # Jolpica 2014 .. season-1 (cached in cache/, paced)

Each wet session, each team: how the two team-mates finished against each other, minus how the same pair finished
against each other in that season's dry sessions (the car and the pair's normal gap drop out). A driver's wet edge =
the mean of those residuals. Stable skill shows up as: (1) more spread between drivers than chance gives (sign-flip
null), (2) a driver's edge in one half of his wet sessions predicting the other half (random halves, and first vs
second half of his career). The placebo runs the same sums on dry sessions labelled wet at random.

Wet sessions: hand lists below (intermediates or wets used in the session), 2014-2025, from memory, not a feed;
for 2023 on the OpenF1 rain flag in data/circuit_priors.json is printed next to it as a cross-check.
"""

import json
import os
import random
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from f1feeds import get, load_config  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(HERE, "cache")
CFG = load_config("season")
FIRST = 2014

WET_RACES = {
    2014: ["Hungarian", "Japanese"],
    2015: ["British", "United States"],
    2016: ["Monaco", "British", "Brazilian"],
    2017: ["Chinese", "Singapore"],
    2018: ["German"],
    2019: ["German"],
    2020: ["Hungarian", "Turkish"],
    2021: ["Emilia Romagna", "Hungarian", "Russian", "Turkish"],  # Belgian: no racing laps
    2022: ["Emilia Romagna", "Monaco", "Singapore", "Japanese"],
    2023: ["Monaco", "Dutch"],
    2024: ["Canadian", "British", "São Paulo"],
    2025: ["Australian", "British", "Belgian"],
}
WET_QUALI = {
    2014: ["Australian", "Malaysian", "Chinese", "British", "Belgian"],
    2015: ["Malaysian", "United States"],
    2016: ["Hungarian", "Austrian"],
    2017: ["Italian"],
    2018: ["Hungarian", "Belgian"],
    2020: ["Styrian", "Turkish"],
    2021: ["Belgian", "Russian", "Turkish"],
    2022: ["Emilia Romagna", "Canadian", "British", "Singapore", "São Paulo"],
    2023: ["Canadian", "Belgian", "Dutch"],  # not Spanish: damp at first, run on slicks (wet_detect.py)
    2024: ["British", "Belgian", "São Paulo"],
    2025: ["Las Vegas"],
}
SKIP_RACES = {(2021, "Belgian")}
CLIP = 8  # places: one odd result shouldn't carry a driver's mean
MIN_DRY = 4  # dry sessions a pair needs in the season for its baseline
MIN_HALF = 3  # wet sessions a driver needs in each half


def cached(name):
    return os.path.join(CACHE, name)


def pages(year, kind, key):
    out, off, total = {}, 0, 1
    while off < total:
        d = get(
            f"https://api.jolpi.ca/ergast/f1/{year}/{kind}.json?limit=100&offset={off}",
            cached(f"pj_{kind}_{year}_{off}.json"),
            reuse=True,
        )["MRData"]
        total = int(d["total"])
        for r in d["RaceTable"]["Races"]:
            e = out.setdefault(int(r["round"]), {"name": r["raceName"], "rows": []})
            e["rows"].extend(r[key])
        off += 100
    return out


def is_wet(table, year, name):
    return any(name.startswith(k) for k in table.get(year, []))


def sessions(last):
    """[(kind, season, round, name, wet, {team: [(driver, value)]})]; value: lower is better, None = no result."""
    out = []
    for year in range(FIRST, last + 1):
        for rnd, e in sorted(pages(year, "results", "Results").items()):
            if any(e["name"].startswith(k) for (y, k) in SKIP_RACES if y == year):
                continue
            fin, gain = {}, {}
            for r in e["rows"]:
                team, drv = r["Constructor"]["constructorId"], r["Driver"]["driverId"]
                pos = int(r["position"]) if r["positionText"].isdigit() else None
                grid = int(r["grid"])
                fin.setdefault(team, []).append((drv, pos))
                # places lost from the grid (lower is better), so a wet race after a dry qualifying isn't the grid's
                gain.setdefault(team, []).append((drv, pos - grid if pos and grid > 0 else None))
            wet = is_wet(WET_RACES, year, e["name"])
            out.append(("race", year, rnd, e["name"], wet, fin))
            out.append(("gain", year, rnd, e["name"], wet, gain))
        for rnd, e in sorted(pages(year, "qualifying", "QualifyingResults").items()):
            q = {}
            for r in e["rows"]:
                q.setdefault(r["Constructor"]["constructorId"], []).append(
                    (r["Driver"]["driverId"], int(r["position"]))
                )
            out.append(("quali", year, rnd, e["name"], is_wet(WET_QUALI, year, e["name"]), q))
    return out


def residuals(sess, kind, wet_of):
    """[(season, round, driver, residual)], + = better than the pair's dry gap, for the sessions wet_of() marks."""
    dry, wet = {}, []
    for k, year, rnd, _name, _wet, teams in sess:
        if k != kind:
            continue
        for team, ds in teams.items():
            if len(ds) != 2 or ds[0][1] is None or ds[1][1] is None:
                continue
            (a, va), (b, vb) = sorted(ds)
            d = max(-CLIP, min(CLIP, vb - va))  # + = a ahead
            key = (year, team, a, b)
            if wet_of(k, year, rnd):
                wet.append((key, rnd, d))
            else:
                dry.setdefault(key, []).append(d)
    out = []
    for key, rnd, d in wet:
        base = dry.get(key, [])
        if len(base) < MIN_DRY:
            continue
        r = d - statistics.mean(base)
        out.append((key[0], rnd, key[2], r))
        out.append((key[0], rnd, key[3], -r))
    return out


def wcorr(xs, ys, ws):
    sw = sum(ws)
    if len(xs) < 5 or not sw:
        return None
    mx, my = sum(w * x for x, w in zip(xs, ws, strict=True)) / sw, sum(w * y for y, w in zip(ys, ws, strict=True)) / sw
    cov = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws, strict=True))
    vx, vy = (
        sum(w * (x - mx) ** 2 for x, w in zip(xs, ws, strict=True)),
        sum(w * (y - my) ** 2 for y, w in zip(ys, ws, strict=True)),
    )
    return cov / (vx * vy) ** 0.5 if vx and vy else None


def halves_corr(res, side):
    """Correlation across drivers of the mean residual in the two halves side(event, driver index) gives."""
    a, b = {}, {}
    for i, (year, rnd, drv, r) in enumerate(res):
        (a if side((year, rnd), drv, i) else b).setdefault(drv, []).append(r)
    ds = [d for d in a if d in b and len(a[d]) >= MIN_HALF and len(b[d]) >= MIN_HALF]
    xs, ys = [statistics.mean(a[d]) for d in ds], [statistics.mean(b[d]) for d in ds]
    ws = [2 / (1 / len(a[d]) + 1 / len(b[d])) for d in ds]
    return wcorr(xs, ys, ws), len(ds)


def spread(res):
    """Sum over drivers of n x mean^2: large when drivers differ by more than noise."""
    by = {}
    for _y, _r, drv, r in res:
        by.setdefault(drv, []).append(r)
    return sum(len(v) * statistics.mean(v) ** 2 for v in by.values())


def report(label, res, rng, n_iter=1000):
    events = sorted({(y, r) for y, r, _d, _x in res})
    if len(events) < 6:
        print(f"{label}: too few sessions ({len(events)})")
        return None
    # random halves of the sessions
    rs = []
    for _ in range(n_iter):
        pick = set(rng.sample(events, len(events) // 2))
        c, _n = halves_corr(res, lambda ev, _d, _i, pick=pick: ev in pick)
        if c is not None:
            rs.append(c)
    # each driver's first vs second half, in time
    order, seen = {}, {}
    for i, (_y, _r, drv, _x) in sorted(enumerate(res), key=lambda t: (t[1][0], t[1][1])):
        order[i] = seen[drv] = seen.get(drv, -1) + 1
    c_time, n_time = halves_corr(res, lambda _ev, drv, i: order[i] < (seen[drv] + 1) / 2)
    # sign-flip null: under "no driver wet skill" each pair's residual is as likely + as -
    obs, null = spread(res), []
    pairs = [(res[i], res[i + 1]) for i in range(0, len(res), 2)]
    for _ in range(n_iter):
        flipped = []
        for p, q in pairs:
            s = rng.choice((1, -1))
            flipped += [(p[0], p[1], p[2], s * p[3]), (q[0], q[1], q[2], s * q[3])]
        null.append(spread(flipped))
    p = sum(1 for v in null if v >= obs) / n_iter
    r_half = statistics.mean(rs) if rs else float("nan")
    rel = 2 * r_half / (1 + r_half) if rs and r_half > -1 else float("nan")
    sd = statistics.pstdev([x for *_k, x in res])
    print(
        f"{label:<22} sessions {len(events):>3}  pair-results {len(pairs):>4}  sd {sd:4.2f}  "
        f"random halves r {r_half:+.2f} ({len(rs)} splits)  first/second half r "
        f"{'  n/a' if c_time is None else f'{c_time:+.2f}'} ({n_time} drivers)  spread vs chance p {p:.3f}  "
        f"reliability {rel:+.2f}"
    )
    return r_half


def main():
    last = CFG["season"] - 1
    sess = sessions(last)
    rng = random.Random(20260930)
    with open(os.path.join(HERE, "data", "circuit_priors.json"), encoding="utf-8") as fh:
        priors = json.load(fh)["races"]
    of_rain = {(r["season"], r["round"]) for r in priors if r.get("rain")}
    print("Wet races, hand list vs OpenF1 rain flag (2023 on):")
    for k, y, rnd, name, wet, _t in sess:
        if k == "race" and y >= 2023 and (wet or (y, rnd) in of_rain):
            print(f"  {y} {name:<28} hand {'wet' if wet else '-  '}  openf1 {'rain' if (y, rnd) in of_rain else '-'}")
    wet_flag = {(k, y, rnd): wet for k, y, rnd, _n, wet, _t in sess}
    real = lambda k, y, rnd: wet_flag[(k, y, rnd)]  # noqa: E731
    print("\nStability of the wet edge (places vs the team-mate, relative to the pair's dry gap):")
    out = {}
    for kind, label in (("race", "race finish"), ("gain", "race places from grid"), ("quali", "qualifying")):
        out[kind] = residuals(sess, kind, real)
        report(label, out[kind], rng)
    both = out["race"] + [(y, 100 + r, d, x) for y, r, d, x in out["quali"]]
    report("race + qualifying", both, rng)

    print("\nPlacebo: the same number of dry sessions labelled wet at random (20 draws, mean of each column):")
    for kind, label in (("race", "race finish"), ("quali", "qualifying")):
        n_wet = sum(1 for k, *_r, wet, _t in sess if k == kind and wet)
        dry_keys = [(k, y, rnd) for k, y, rnd, _n, wet, _t in sess if k == kind and not wet]
        rh = []
        for _ in range(20):
            fake = set(rng.sample(dry_keys, n_wet))
            res = residuals(
                [s for s in sess if s[0] == kind and not s[4]], kind, lambda k, y, rnd, fake=fake: (k, y, rnd) in fake
            )
            events = sorted({(y, r) for y, r, _d, _x in res})
            rs = []
            for _ in range(100):
                pick = set(rng.sample(events, len(events) // 2))
                c, _n = halves_corr(res, lambda ev, _d, _i, pick=pick: ev in pick)
                if c is not None:
                    rs.append(c)
            if rs:
                rh.append(statistics.mean(rs))
        print(f"  {label:<22} random halves r {statistics.mean(rh):+.2f} (range {min(rh):+.2f} .. {max(rh):+.2f})")

    print("\nDrivers with 8+ wet results (race + qualifying), mean edge in places per session, and its standard error:")
    by = {}
    for _y, _r, drv, x in both:
        by.setdefault(drv, []).append(x)
    rows = sorted(((statistics.mean(v), drv, v) for drv, v in by.items() if len(v) >= 8), reverse=True)
    for m, drv, v in rows:
        print(f"  {drv:<18} n {len(v):>3}  edge {m:+.2f}  se {statistics.stdev(v) / len(v) ** 0.5:.2f}")


if __name__ == "__main__":
    main()
