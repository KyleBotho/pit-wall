"""The round's overtake level (2x plan lever L1, docs/plans/2x-predictions.md): does a circuit's traffic penalty in past
races (the time a car loses running close behind another, laps.py fit_pace `traffic`) forecast how much overtaking a
2026 race sees, beyond the track's average speed (the shipped rule, engine TRACK.speed)?

  python backtest/ovlevel.py --fetch    OpenF1 2023-2025 races: laps, stints, race control, weather, drivers (paced,
                                        cached in cache/; ~15 min the first time) -> each race's traffic penalty and
                                        tyre wear -> backtest/ovlevel_past.json (committed: nothing to fetch again)
  python backtest/ovlevel.py            the walk-forward comparison on 2026 (needs cache/data.json)

The forecast for 2026 round r uses only what was known before it: this season's rounds before r and the past seasons.
Overtakes are counted differently then and now (OpenF1 passes per starter in 2023-2025, F1 Fantasy's race overtake
points per driver in 2026) and the cars changed, so every season has its own level (a fixed effect: the era factor);
the slopes on speed and traffic are shared. A circuit's traffic for a race = its mean over the OTHER seasons' races
there (as a forecast would know it); a circuit with none takes the average.
"""

import argparse
import json
import math
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import extras  # noqa: E402
import laps  # noqa: E402
import refresh  # noqa: E402

PAST = os.path.join(HERE, "ovlevel_past.json")
SEASONS = (2023, 2024, 2025)
FROM = 5  # scored rounds (as the walk-forward backtest); earlier rounds still feed the fits


def fetch():
    """Each past race's traffic penalty and tyre wear from its laps (laps.py canonical + fit_pace), by Jolpica circuit
    id: OpenF1's race sessions of a season in date order line up with the priors' rounds (checked by count)."""
    data = refresh.read_json(refresh.cached("data.json"))
    pri = sorted(
        (x for x in data["priors"]["races"] if x["season"] in SEASONS), key=lambda x: (x["season"], x["round"])
    )
    out = refresh.read_json(PAST) if os.path.exists(PAST) else {}
    for season in SEASONS:
        sessions = extras._sessions(refresh.get_soft, refresh.cached, season, fresh=False)
        races = sorted(
            (s for s in sessions if s.get("session_name") == "Race" and not s.get("is_cancelled")),
            key=lambda s: s["date_start"],
        )
        rows = [x for x in pri if x["season"] == season]
        if len(races) != len(rows):
            print(f"{season}: {len(races)} OpenF1 races vs {len(rows)} priors rows: matched by order up to the shorter")
        for s, row in zip(races, rows, strict=False):
            key = f"{season}-{row['round']:02d}"
            if key in out:
                continue

            def of(kind, s=s):
                return extras._of(refresh.get_soft, refresh.cached, kind, s["session_key"])

            num2 = {d["driver_number"]: d.get("name_acronym") for d in of("drivers") if d.get("name_acronym")}
            # older seasons have stints without a start lap: left out (their laps get no compound / tyre age)
            stints = [x for x in of("stints") if x.get("lap_start") is not None]
            try:
                canon = laps.canonical(of("laps"), stints, of("race_control"), of("weather"), num2)
                fit = laps.fit_pace(canon)
            except Exception as e:  # noqa: BLE001 - one odd race shouldn't stop the rest
                print(f"{key} {row['circuit']}: not fitted ({e})")
                fit = None
            coef = (fit or {}).get("coef") or {}
            age = coef.get("agePerLap") or {}
            out[key] = {
                "season": season,
                "round": row["round"],
                "circuit": row["circuit"],
                "openf1": s.get("circuit_short_name"),
                "traffic": coef.get("traffic"),
                "deg": age.get("M", age.get("H")),
                "laps": coef.get("laps"),
            }
            print(f"{key} {row['circuit']:<15} ({s.get('circuit_short_name')}): traffic {coef.get('traffic')}")
            refresh.write_json(PAST, out, indent=1, sort_keys=True)
    return out


def rows_2026(data):
    """2026 rounds: the race overtake level (overtake points per driver who raced), the speed (km/h from practice's
    reference lap) and the circuit."""
    ev = data["evNames"]
    rov = {i for i, e in enumerate(ev) if e["c"] == "R OV"}
    km = data["cfg"]["circuits"]["km"]
    out = []
    for gd in data["done"]:
        g = next(x for x in data["schedule"] if x["gd"] == gd)
        vals = [
            sum(e[1] for e in (h.get("ev") or []) if e[0] in rov)
            for a in data["assets"]
            if a["kind"] == "D"
            for h in [next((x for x in a["hist"] if x and x["gd"] == gd), None)]
            if h and h.get("active")
        ]
        lap = ((data.get("trackStats") or {}).get(str(gd)) or {}).get("lap")
        c = g.get("circuit")
        if vals and lap and km.get(c):
            out.append(
                {
                    "season": 2026,
                    "gd": gd,
                    "circuit": c,
                    "y": st.mean(vals),
                    "kmh": km[c] * 3600 / lap,
                    "S": straights(gd),
                }
            )
    return out


def straights(gd):
    """The share of the lap above 260 km/h on the weekend's fastest practice lap before the lock (telemetry.py bands,
    FastF1 car data); qualifying's where practice wasn't kept (R1, R4)."""
    p = os.path.join(ROOT, "history", "2026", "telemetry", "bands", f"gd{gd:02d}.json")
    if not os.path.exists(p):
        return None
    b = refresh.read_json(p)
    sh = (b.get("FP") or b.get("Q") or {}).get("share")
    return sh[3] if sh else None


def rows_past(data, past):
    km = data["cfg"]["circuits"]["km"]
    out = []
    for x in data["priors"]["races"]:
        if x["season"] not in SEASONS or x.get("ovt") is None or not x.get("qref") or not km.get(x["circuit"]):
            continue
        p = past.get(f"{x['season']}-{x['round']:02d}") or {}
        out.append(
            {
                "season": x["season"],
                "circuit": x["circuit"],
                "y": x["ovt"],
                "kmh": km[x["circuit"]] * 3600 / x["qref"],
                "traffic": p.get("traffic"),
            }
        )
    return out


def fit(train, feats, lam=1.0):
    """Ridge least squares of log y on season fixed effects + the standardised features (no penalty on the season
    levels). train rows carry `x` (feature values) and `season`. Returns (season levels, slopes)."""
    import numpy as np

    seasons = sorted({r["season"] for r in train})
    X = np.array([[1.0 if r["season"] == s else 0.0 for s in seasons] + [r["x"][f] for f in feats] for r in train])
    y = np.array([math.log(max(0.05, r["y"])) for r in train])
    P = np.diag([0.0] * len(seasons) + [lam] * len(feats))
    beta = np.linalg.solve(X.T @ X + P, X.T @ y)
    return dict(zip(seasons, beta[: len(seasons)], strict=True)), list(beta[len(seasons) :])


def zscore(rows, key, ref):
    """Standardise rows' `key` within their season (2026: by the rounds in ref, those known at the time)."""
    by = {}
    for r in ref:
        by.setdefault(r["season"], []).append(r[key])
    for r in rows:
        v = by.get(r["season"]) or [r[key]]
        m, s = st.mean(v), (st.pstdev(v) or 1.0)
        r.setdefault("x", {})[key] = (r[key] - m) / s


def walk(data, past):
    """For each 2026 round r: the level forecast by the shipped speed rule (2026 rounds before r, ridge 2 on speed, at
    least 5 rounds, else the season mean) and by the pooled models (past seasons + 2026 before r)."""
    r26 = rows_2026(data)
    rp = rows_past(data, past)
    # each circuit's traffic by season, for "the other seasons' mean"
    traf = {}
    for x in past.values():
        if x.get("traffic") is not None:
            traf.setdefault(x["circuit"], {}).setdefault(x["season"], []).append(x["traffic"])
    allT = [v for c in traf.values() for vs in c.values() for v in vs]
    meanT = st.mean(allT) if allT else 0.0

    def t_of(circuit, season):
        vs = [v for s, xs in traf.get(circuit, {}).items() if s != season for v in xs]
        return st.mean(vs) if vs else meanT

    for r in rp + r26:
        r["T"] = t_of(r["circuit"], r["season"])
    res = []
    for k, cur in enumerate(r26):
        before = r26[:k]
        if len(before) < 2:
            continue
        rows = [dict(r) for r in rp + before + [cur]]
        zscore(rows, "kmh", [r for r in rows if r is not rows[-1]])
        for r in rows:
            r["x"]["T"] = r["T"]
        tr, now = rows[:-1], rows[-1]
        # shipped: 2026 only, speed, ridge 2, 5+ rounds
        b26 = [r for r in tr if r["season"] == 2026]
        lv26 = st.mean(math.log(r["y"]) for r in b26)
        if len(b26) >= 5:
            _, (b,) = fit(b26, ["kmh"], 2.0)
            speed = lv26 + b * (now["x"]["kmh"] - st.mean(r["x"]["kmh"] for r in b26))
        else:
            speed = lv26
        out = {"gd": cur["gd"], "y": cur["y"], "flat": lv26, "speed": speed}
        # 2026 alone, as the speed rule (ridge 2, 5+ rounds): the circuit's past traffic, speed + past traffic, the
        # straights' share of the practice lap (2026-10-12: Monza's miss), and speed + straights
        for r in rows:
            r["x"]["S"] = r.get("S") if r.get("S") is not None else 0.0
        if any(r.get("S") is not None for r in b26):
            mS = st.mean(r["S"] for r in b26 if r.get("S") is not None)
            sS = st.pstdev([r["S"] for r in b26 if r.get("S") is not None]) or 1.0
            for r in rows:
                r["x"]["S"] = ((r["S"] if r.get("S") is not None else mS) - mS) / sS
        for name, feats in (
            ("traffic26", ["T"]),
            ("speedTraffic26", ["kmh", "T"]),
            ("straight26", ["S"]),
            ("speedStraight26", ["kmh", "S"]),
        ):
            if len(b26) >= 5:
                _, b = fit(b26, feats, 2.0)
                out[name] = lv26 + sum(
                    bj * (now["x"][f] - st.mean(r["x"][f] for r in b26)) for bj, f in zip(b, feats, strict=True)
                )
                out[name + "B"] = [round(v, 3) for v in b]
            else:
                out[name], out[name + "B"] = lv26, []
        for name, feats in (("pooledSpeed", ["kmh"]), ("pooledSpeedTraffic", ["kmh", "T"]), ("pooledTraffic", ["T"])):
            lv, b = fit(tr, feats)
            out[name] = lv[2026] + sum(bj * now["x"][f] for bj, f in zip(b, feats, strict=True))
            out[name + "B"] = [round(v, 3) for v in b]
        res.append(out)
    return res


def report(res):
    rounds = [r for r in res if r["gd"] >= FROM]
    keys = [
        "flat",
        "speed",
        "pooledSpeed",
        "pooledSpeedTraffic",
        "pooledTraffic",
        "traffic26",
        "speedTraffic26",
        "straight26",
        "speedStraight26",
    ]
    err = {k: [abs(math.exp(r[k]) - r["y"]) for r in rounds] for k in keys}
    lerr = {k: [abs(r[k] - math.log(r["y"])) for r in rounds] for k in keys}
    span = f"R{rounds[0]['gd']}-R{rounds[-1]['gd']} ({len(rounds)} rounds)"
    print(f"2026 {span}: |forecast - actual| race overtakes a driver")
    for k in keys:
        d = [a - b for a, b in zip(err[k], err["speed"], strict=True)]
        se = st.stdev(d) / math.sqrt(len(d)) if len(d) > 1 else float("nan")
        print(
            f"  {k:<20} {st.mean(err[k]):.3f}  log {st.mean(lerr[k]):.3f}  vs speed rule {st.mean(d):+.3f} +/- {se:.3f}"
        )
    last = res[-1]
    print(f"  slopes at R{last['gd']} (per sd of speed, per s of traffic):", {k: last[k + "B"] for k in keys[2:]})
    print("  per round (actual, speed rule, speed + traffic, straights, speed + straights):")
    for r in rounds:
        print(
            f"    R{r['gd']:<3} {r['y']:5.2f} {math.exp(r['speed']):5.2f} {math.exp(r['speedTraffic26']):5.2f}"
            f" {math.exp(r['straight26']):5.2f} {math.exp(r['speedStraight26']):5.2f}"
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fetch", action="store_true", help="fetch and fit the 2023-2025 races first")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    past = fetch() if a.fetch else (refresh.read_json(PAST) if os.path.exists(PAST) else {})
    res = walk(refresh.read_json(refresh.cached("data.json")), past)
    if a.json:
        print(json.dumps(res, indent=1))
    else:
        report(res)


if __name__ == "__main__":
    main()
