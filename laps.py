"""Canonical lap/stint records and a contextual race-pace estimate (independent review batch 3, 2026-09-27).

The race pace the model used until now is each driver's median clean lap (extras.lap_pace): it can't tell a car's
speed from its tyres, its fuel load (an early retiree's heavy laps against a full race), traffic or a safety car.
Here every race lap is kept with its context, from OpenF1 (the source CI already reads):

  lap, start (s from the session's first lap), time, s1, s2, s3, cmp (compound letter), age (tyre laps),
  stint, pitIn, pitOut, neutral (SC / VSC / red flag), wet (rain reported during the lap), gap (s since the
  previous car crossed the line: traffic), slow (over 112% of the driver's own median: damage, a spin, a stop)

and a pace model is fitted per race on the clean laps, by robust (Huber) least squares on log lap time:

  log t = driver + compound + compound x tyre age + fuel (share of the race run) + traffic (gap under 2 s)

The driver terms, as % off the fastest, are the new race pace (`paceCtx`), with a standard error (`paceSe`) and
the laps behind it; the fitted tyre, fuel and traffic effects are kept for inspection. Retirements are classified
from race control (`retirements`): an incident or collision involving the car in the laps before it stopped, a
non-starter, else "other" (a mechanical failure or a solo crash race control didn't name).

  python laps.py backfill [--rounds 1-15]   canonical laps -> history/<season>/laps/gdNN.json and the pace and
                                            retirements into history/<season>/races/gdNN.json (cached / paced)
  python laps.py audit [--rounds 1-14]      OpenF1 vs the FastF1 lap archive (history/<season>/telemetry/laps)

Checked against FastF1 (second review, 2026-09-27): once the FastF1 archive of a session is in (telemetry.py),
`reconcile` lines OpenF1's lap numbers up with it (R1 2026: OpenF1's lap n is FastF1's n + 1), takes the compound
and tyre age from it (OpenF1's stints put a driver on the wrong tyre in R5, R6, R10, R11) and refits the pace. A
session whose lap times don't agree with FastF1's under any shift gets no contextual pace (quality.ff.ok false).
"""

import argparse
import json
import math
import os
import re
import statistics
from datetime import datetime, timezone

from f1feeds import VSC_DEPLOYED, VSC_ENDING

COLS = ["lap", "start", "time", "s1", "s2", "s3", "cmp", "age", "stint", "pitIn", "pitOut", "neutral", "wet", "gap"]
COLS += ["slow"]
CMP = {"SOFT": "S", "MEDIUM": "M", "HARD": "H", "INTERMEDIATE": "I", "WET": "W"}
TRAFFIC_GAP = 2.0  # s: closer than this to the car ahead at the line costs time (dirty air)
MIN_LAPS = 5  # clean laps a driver needs for a pace estimate
FF_AGREE = 0.9  # share of laps whose times must match FastF1's (to 0.01 s) for a session to count as aligned
RIDGE = 1.0  # on the non-driver terms (log-seconds scale, laps as units)
INCIDENT_WINDOW = 2  # laps before the retirement lap in which an incident involving the car makes it an incident
SKIP_INCIDENTS = ("STARTING PROCEDURE", "TRACK LIMITS", "PIT LANE", "UNNECESSARILY SLOWLY", "UNSAFE RELEASE")
SKIP_INCIDENTS += ("SPEEDING", "BLUE FLAG", "YELLOW FLAG", "RED FLAG", "PARC FERME")


def _t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


# ---------------------------------------------------------------- canonical records


def neutral_windows(rc, lap_s):
    """[(start, end)] epoch seconds with the race neutralised. Safety car: deployed -> "in this lap" + 1.5 laps, or
    the next "track clear" + 1 lap; virtual safety car ("VSC" or spelled out): deployed -> ending + 0.5 lap, or
    track clear; red flag: -> the next green / track clear + 1 lap. A window that never closes in the messages
    (seen: Monza's lap-3 safety car) is capped (6 laps SC, 4 VSC, 2 red). lap_s = a typical lap time."""
    out, open_ = [], {}
    cap = {"sc": 6, "vsc": 4, "red": 2}

    def close(k, t, extra):
        if k in open_:
            out.append((open_.pop(k), t + extra * lap_s))

    for m in sorted(rc or [], key=lambda m: m.get("date") or ""):
        msg, t = (m.get("message") or "").upper(), _t(m.get("date"))
        if t is None:
            continue
        if msg.startswith("SAFETY CAR DEPLOYED"):
            open_.setdefault("sc", t)
        elif msg.startswith("SAFETY CAR IN THIS LAP"):
            close("sc", t, 1.5)
        elif msg.startswith(VSC_DEPLOYED):
            open_.setdefault("vsc", t)
        elif msg.startswith(VSC_ENDING):
            close("vsc", t, 0.5)
        elif m.get("flag") == "RED":
            open_.setdefault("red", t)
        elif msg.startswith("TRACK CLEAR") or (m.get("flag") == "GREEN" and "red" in open_):
            close("sc", t, 1)
            close("vsc", t, 0)
            close("red", t, 1)
    for k, t in list(open_.items()):
        out.append((t, t + cap[k] * lap_s))
    return out


def sc_laps(rc):
    """Each safety car of a session as [deployed lap, in lap] by race control's lap numbers (the leader's); the in
    lap None when no "in this lap" message closes it (a red flag, or the race ending under it). Safety cars only,
    not VSCs or red flags. For the timed safety car challenger (SIM.scTimed): when a race's safety car comes."""
    out = []
    for m in sorted(rc or [], key=lambda m: m.get("date") or ""):
        msg, lap = (m.get("message") or "").upper(), m.get("lap_number")
        if msg.startswith("SAFETY CAR DEPLOYED"):
            if not out or out[-1][1] is not None:
                out.append([lap, None])
        elif msg.startswith("SAFETY CAR IN THIS LAP") and out and out[-1][1] is None:
            out[-1][1] = lap
    return out


def rain_times(wx):
    """Epoch seconds of the weather readings reporting rain."""
    return sorted(t for w in wx or [] if w.get("rainfall") and (t := _t(w.get("date"))) is not None)


def canonical(laps, stints, rc, wx, num2):
    """OpenF1 laps + stints + race control + weather of one session -> {"cols", "laps": {TLA: [[...]]}, "t0"}.
    num2: car number -> TLA."""
    by = {}
    for lap in laps or []:
        t = num2.get(lap.get("driver_number"))
        if t and lap.get("lap_number"):
            by.setdefault(t, {})[lap["lap_number"]] = lap
    starts = [_t(lap.get("date_start")) for d in by.values() for lap in d.values() if lap.get("date_start")]
    if not starts:
        return {"cols": COLS, "laps": {}, "t0": None}
    t0 = min(starts)
    durs = [lap["lap_duration"] for d in by.values() for lap in d.values() if lap.get("lap_duration")]
    lap_s = statistics.median(durs) if durs else 90.0
    windows = neutral_windows(rc, lap_s)
    rain = rain_times(wx)
    # every line crossing (lap starts), for the gap to the car ahead
    crossings = sorted((_t(lap["date_start"]), t) for t, d in by.items() for lap in d.values() if lap.get("date_start"))
    ct = [c[0] for c in crossings]
    st_by = {}
    for s in stints or []:
        t = num2.get(s.get("driver_number"))
        if t:
            st_by.setdefault(t, []).append(s)
    out = {}
    import bisect

    for t, d in by.items():
        rows = []
        med = statistics.median([lap["lap_duration"] for lap in d.values() if lap.get("lap_duration")] or [0]) or None
        stl = sorted(st_by.get(t, []), key=lambda s: s.get("lap_start") or 0)
        for n in sorted(d):
            lap = d[n]
            start = _t(lap.get("date_start"))
            dur = lap.get("lap_duration")
            stint = next((s for s in stl if (s.get("lap_start") or 0) <= n <= (s.get("lap_end") or 10**6)), None)
            age = (stint.get("tyre_age_at_start") or 0) + n - stint["lap_start"] if stint else None
            nxt = d.get(n + 1)
            pit_out = int(bool(lap.get("is_pit_out_lap")))
            pit_in = int(bool(nxt and nxt.get("is_pit_out_lap")))
            if stint and stint.get("lap_end") == n and any(s.get("lap_start") == n + 1 for s in stl):
                pit_in = 1
            neutral = wet = 0
            gap = None
            if start is not None:
                end = start + (dur or lap_s)
                neutral = int(any(a < end and b > start for a, b in windows))
                i = bisect.bisect_left(rain, start)
                wet = int(i < len(rain) and rain[i] <= end)
                k = bisect.bisect_left(ct, start)
                gap = round(start - ct[k - 1], 3) if k > 0 else None
            rows.append(
                [
                    n,
                    round(start - t0, 3) if start is not None else None,
                    dur,
                    lap.get("duration_sector_1"),
                    lap.get("duration_sector_2"),
                    lap.get("duration_sector_3"),
                    CMP.get((stint or {}).get("compound") or ""),
                    age,
                    (stint or {}).get("stint_number"),
                    pit_in,
                    pit_out,
                    neutral,
                    wet,
                    gap,
                    int(bool(dur and med and dur > 1.12 * med)),
                ]
            )
        out[t] = rows
    return {
        "cols": COLS,
        "laps": out,
        "t0": datetime.fromtimestamp(t0, timezone.utc).isoformat(),
        "quality": quality(out),
    }


def quality(laps):
    """How complete a session's records are: laps, shares with a compound / a gap, neutralised and wet laps,
    and drivers whose lap numbers skip (seen: OpenF1's R1 2026 numbering, one lap short of FastF1's)."""
    ix = {c: i for i, c in enumerate(COLS)}
    rows = [r for rs in laps.values() for r in rs]
    n = len(rows) or 1
    skips = sorted(t for t, rs in laps.items() if rs and [r[0] for r in rs] != list(range(rs[0][0], rs[-1][0] + 1)))
    return {
        "laps": len(rows),
        "compound": round(sum(r[ix["cmp"]] is not None for r in rows) / n, 3),
        "gap": round(sum(r[ix["gap"]] is not None for r in rows) / n, 3),
        "neutral": sum(r[ix["neutral"]] for r in rows),
        "wet": sum(r[ix["wet"]] for r in rows),
        "skips": skips,
    }


# ---------------------------------------------------------------- checked against FastF1


def align(canon, ff, shifts=(0, 1, -1, 2, -2)):
    """The lap-number shift that makes OpenF1's lap times match FastF1's archive of the same session:
    {shift, agree (share of laps in both with equal times), n (laps compared)}; the unshifted numbering wins ties."""
    ia = {c: i for i, c in enumerate(ff["cols"])}
    ib = {c: i for i, c in enumerate(canon["cols"])}
    best = {"shift": 0, "agree": 0.0, "n": 0}
    for sh in shifts:
        n = same = 0
        for t, rows in canon["laps"].items():
            fa = {r[ia["lap"]]: r for r in ff["laps"].get(t, [])}
            for r in rows:
                x = fa.get(r[ib["lap"]] + sh)
                if not x or r[ib["time"]] is None or x[ia["lapTime"]] is None:
                    continue
                n += 1
                same += abs(r[ib["time"]] - x[ia["lapTime"]]) < 0.01
        agree = same / n if n else 0.0
        if agree > best["agree"] + 1e-9:
            best = {"shift": sh, "agree": round(agree, 4), "n": n}
    return best


def with_ff(canon, ff):
    """canon checked against FastF1: renumbered by the best shift, compound and tyre age from FastF1 (its TyreLife
    counts the lap itself: age = life - 1), quality.ff = {shift, agree, n, ok, cmpFixed}. The input isn't changed."""
    a = align(canon, ff)
    ok = a["agree"] >= FF_AGREE
    ia = {c: i for i, c in enumerate(ff["cols"])}
    ib = {c: i for i, c in enumerate(canon["cols"])}
    laps, fixed = {}, 0
    for t, rows in canon["laps"].items():
        fa = {r[ia["lap"]]: r for r in ff["laps"].get(t, [])}
        out = []
        for r in rows:
            r = list(r)
            r[ib["lap"]] += a["shift"] if ok else 0
            x = fa.get(r[ib["lap"]]) if ok else None
            if x:
                c = CMP.get(str(x[ia["cmp"]] or "").upper(), (x[ia["cmp"]] or "")[:1] or None)
                if c and c != r[ib["cmp"]]:
                    fixed += 1
                    r[ib["cmp"]] = c
                if x[ia["life"]] is not None:
                    r[ib["age"]] = max(0, int(x[ia["life"]]) - 1)
            out.append(r)
        laps[t] = out
    q = dict(canon.get("quality") or {})
    q["ff"] = {**a, "ok": ok, "cmpFixed": fixed}
    return {**canon, "laps": laps, "quality": q}


FF_KEY = {"race": "R", "sprint": "S"}


def reconcile(archived, read_json, write_json, gd):
    """Once the FastF1 archive of a round is in: its OpenF1 lap records checked against it (with_ff) and the pace
    refitted, both archives rewritten. Returns the round's updated race record, or None when there was nothing to do
    (no FastF1 archive yet, or already checked)."""
    lp, rp, fp = archived("laps", f"gd{gd:02d}.json"), archived("races", f"gd{gd:02d}.json"), None
    fp = archived("telemetry", "laps", f"gd{gd:02d}.json")
    if not (os.path.exists(lp) and os.path.exists(rp) and os.path.exists(fp)):
        return None
    lap_rec, rec, ff = read_json(lp), read_json(rp), read_json(fp).get("sessions") or {}
    changed = False
    for key, code in FF_KEY.items():
        canon = lap_rec.get(key)
        if not canon or not canon.get("laps") or "ff" in (canon.get("quality") or {}) or not ff.get(code):
            continue
        canon = with_ff(canon, ff[code])
        lap_rec[key] = canon
        block = rec.setdefault(key, {})
        for k in ("paceCtx", "paceSe", "paceN", "paceCoef"):
            block.pop(k, None)
        fit = fit_pace(canon)
        if fit:
            block.update(paceCtx=fit["pace"], paceSe=fit["se"], paceN=fit["n"], paceCoef=fit["coef"])
        block["lapCheck"] = canon["quality"]["ff"]
        changed = True
    if not changed:
        return None
    write_json(lp, lap_rec, separators=(",", ":"))
    write_json(rp, rec, indent=1, sort_keys=True)
    return rec


# ---------------------------------------------------------------- the pace model


def clean_laps(canon, stint=False):
    """(tla, time, cmp, age, fuel share, traffic[, stint]) for laps fit for pace: not lap 1, not in / out laps, not
    neutralised, not wet, not slow, with a compound and a time."""
    ix = {c: i for i, c in enumerate(canon["cols"])}
    laps = canon["laps"]
    total = max((r[ix["lap"]] for rows in laps.values() for r in rows), default=0)
    out = []
    for t, rows in laps.items():
        for r in rows:
            if r[ix["lap"]] <= 1 or r[ix["pitIn"]] or r[ix["pitOut"]] or r[ix["neutral"]] or r[ix["wet"]]:
                continue
            if r[ix["slow"]] or not r[ix["time"]] or not r[ix["cmp"]] or r[ix["age"]] is None:
                continue
            gap = r[ix["gap"]]
            traffic = max(0.0, TRAFFIC_GAP - gap) / TRAFFIC_GAP if gap is not None else 0.0
            row = (t, r[ix["time"]], r[ix["cmp"]], r[ix["age"]], r[ix["lap"]] / max(1, total), traffic)
            out.append(row + (r[ix["stint"]],) if stint else row)
    return out


def fit_pace(canon):
    """Robust least squares on log lap time over the clean laps. Returns {pace: {tla: % off the fastest}, se: {tla: %},
    n: {tla: laps}, coef: {...}} or None without enough data (or without numpy)."""
    try:
        import numpy as np
    except ImportError:
        return None
    if not ((canon.get("quality") or {}).get("ff") or {"ok": True})["ok"]:
        return None  # lap numbers that don't line up with FastF1's: compound, tyre age and fuel would be off
    rows = clean_laps(canon)
    counts = {}
    for r in rows:
        counts[r[0]] = counts.get(r[0], 0) + 1
    drivers = sorted(t for t, n in counts.items() if n >= MIN_LAPS)
    rows = [r for r in rows if r[0] in counts and counts[r[0]] >= MIN_LAPS]
    if len(drivers) < 6:
        return None
    cmps = sorted({r[2] for r in rows}, key=lambda c: -sum(1 for r in rows if r[2] == c))
    base, others = cmps[0], cmps[1:]
    di = {t: k for k, t in enumerate(drivers)}
    # columns: drivers | other compounds' offsets | tyre age per compound | fuel | traffic
    nd, no, nc = len(drivers), len(others), len(cmps)
    p = nd + no + nc + 2
    X = np.zeros((len(rows), p))
    y = np.log(np.array([r[1] for r in rows]))
    for i, (t, _, c, age, fuel, traffic) in enumerate(rows):
        X[i, di[t]] = 1
        if c != base:
            X[i, nd + others.index(c)] = 1
        X[i, nd + no + cmps.index(c)] = age
        X[i, nd + no + nc] = fuel
        X[i, nd + no + nc + 1] = traffic
    pen = np.zeros(p)
    pen[nd:] = RIDGE * 1e-4  # a light ridge on the context terms (their scale: log-seconds per unit)
    w = np.ones(len(rows))
    beta = None
    for _ in range(6):
        XtW = X.T * w
        A = XtW @ X + np.diag(pen)
        beta = np.linalg.solve(A, XtW @ y)
        res = y - X @ beta
        s = 1.4826 * np.median(np.abs(res - np.median(res))) or 1e-3
        k = 1.5 * s
        w = np.where(np.abs(res) <= k, 1.0, k / np.maximum(np.abs(res), 1e-12))
    res = y - X @ beta
    sigma2 = float(np.sum(w * res**2) / max(1, len(rows) - p))
    cov = sigma2 * np.linalg.inv((X.T * w) @ X + np.diag(pen))
    d = beta[:nd]
    best = float(np.min(d))
    pace = {t: round((math.exp(d[k] - best) - 1) * 100, 3) for t, k in di.items()}
    se = {t: round(math.sqrt(max(0.0, cov[k, k])) * 100, 3) for t, k in di.items()}
    coef = {
        "compound": {c: round(float(beta[nd + j]) * 100, 3) for j, c in enumerate(others)},
        "agePerLap": {c: round(float(beta[nd + no + j]) * 100, 4) for j, c in enumerate(cmps)},
        "fuelFullRace": round(float(beta[nd + no + nc]) * 100, 3),
        "traffic": round(float(beta[nd + no + nc + 1]) * 100, 3),
        "base": base,
        "sigma": round(math.sqrt(sigma2) * 100, 3),
        "laps": len(rows),
    }
    return {"pace": pace, "se": se, "n": {t: counts[t] for t in drivers}, "coef": coef}


# ---------------------------------------------------------------- the pooled (hierarchical) pace model

# fit_pace fits each race alone. Within one race fuel and tyre age move together, so its tyre, fuel and traffic
# effects are loosely pinned (fuel over a full race: -0.6% to -4.9% across R1-R15) and that noise leaks into the
# driver terms. Here the context terms of every race are drawn towards the season's typical values, as much as the
# races agree (empirical Bayes: each term's between-race spread tau against its within-race standard error,
# DerSimonian-Laird); the driver terms stay free per race. Round k is pooled with rounds up to k only, so a backtest
# of round r never sees a later race. Compounds by letter (dry: S / M / H), offsets against M.
HIER_CMPS = ("S", "M", "H")
HIER_TERMS = ["cmp:S", "cmp:H", "age:S", "age:M", "age:H", "fuel", "traffic"]
HIER_MIN_ROUNDS = 3  # races with a term before it's pooled
HIER_MIN_LAPS = 30  # clean laps a race needs on a term for its estimate to count in the pooling


def hier_design(canon):
    """Clean dry laps -> (drivers, X, y, support per context term) with HIER_TERMS' fixed columns, or None."""
    import numpy as np

    rows = [r for r in clean_laps(canon, stint=True) if r[2] in HIER_CMPS]
    counts = {}
    for r in rows:
        counts[r[0]] = counts.get(r[0], 0) + 1
    drivers = sorted(t for t, n in counts.items() if n >= MIN_LAPS)
    rows = [r for r in rows if counts.get(r[0], 0) >= MIN_LAPS]
    if len(drivers) < 6:
        return None
    di, nd, nt = {t: k for k, t in enumerate(drivers)}, len(drivers), len(HIER_TERMS)
    X = np.zeros((len(rows), nd + nt))
    y = np.log(np.array([r[1] for r in rows]))
    clusters = []
    for i, (t, _, c, age, fuel, traffic, st) in enumerate(rows):
        clusters.append(f"{t}:{st}")
        X[i, di[t]] = 1
        if c != "M":
            X[i, nd + HIER_TERMS.index("cmp:" + c)] = 1
        X[i, nd + HIER_TERMS.index("age:" + c)] = age
        X[i, nd + HIER_TERMS.index("fuel")] = fuel
        X[i, nd + HIER_TERMS.index("traffic")] = traffic
    support = [int(np.count_nonzero(X[:, nd + j])) for j in range(nt)]
    return drivers, X, y, support, clusters


def hier_fit(design, mu=None, tau2=None):
    """Huber IRLS on one race's design. Without a prior: a light ridge on the context terms (as fit_pace). With one
    (mu, tau2 per term; None = not pooled): each term is drawn towards mu with weight sigma^2 / tau2. Standard errors
    are cluster-robust by driver-stint (a stint's laps share tyres, traffic and set-up: their errors aren't
    independent, and the plain ones come out too small). Returns {pace, se, n, ctx (log units), ctxVar, sigma2,
    inflate (robust / plain standard error of the driver terms, median)}."""
    import numpy as np

    drivers, X, y, support, clusters = design
    nd, nt = len(drivers), len(HIER_TERMS)
    lam, m = np.zeros(nd + nt), np.zeros(nd + nt)
    w = np.ones(len(y))
    beta, sigma2 = None, 1e-4
    for _ in range(8):
        for j in range(nt):
            if mu is not None and mu[j] is not None:
                lam[nd + j], m[nd + j] = sigma2 / max(tau2[j], 1e-12), mu[j]
            else:
                lam[nd + j], m[nd + j] = RIDGE * 1e-4, 0.0
        XtW = X.T * w
        beta = np.linalg.solve(XtW @ X + np.diag(lam), XtW @ y + lam * m)
        res = y - X @ beta
        s = 1.4826 * np.median(np.abs(res - np.median(res))) or 1e-3
        k = 1.5 * s
        w = np.where(np.abs(res) <= k, 1.0, k / np.maximum(np.abs(res), 1e-12))
        sigma2 = float(np.sum(w * res**2) / max(1, len(y) - nd - nt))
    Ainv = np.linalg.inv((X.T * w) @ X + np.diag(lam))
    plain = sigma2 * Ainv
    # sandwich: A^-1 (sum over clusters of g g') A^-1, g = the cluster's weighted score; small-sample factor G/(G-1)
    score = X * (w * res)[:, None]
    ids = {}
    for i, c in enumerate(clusters):
        ids.setdefault(c, []).append(i)
    G = len(ids)
    meat = np.zeros((X.shape[1], X.shape[1]))
    for rows_c in ids.values():
        g = score[rows_c].sum(axis=0)
        meat += np.outer(g, g)
    cov = Ainv @ meat @ Ainv * (G / max(1, G - 1))
    ratio = [math.sqrt(cov[k, k] / plain[k, k]) for k in range(nd) if plain[k, k] > 0]
    d = beta[:nd]
    best = float(np.min(d))
    return {
        "pace": {t: round((math.exp(d[k] - best) - 1) * 100, 3) for k, t in enumerate(drivers)},
        "se": {t: round(math.sqrt(max(0.0, cov[k, k])) * 100, 3) for k, t in enumerate(drivers)},
        "n": {t: int(np.count_nonzero(X[:, k])) for k, t in enumerate(drivers)},
        "ctx": [float(beta[nd + j]) for j in range(nt)],
        "ctxVar": [float(cov[nd + j, nd + j]) for j in range(nt)],
        "support": support,
        "sigma2": sigma2,
        "inflate": statistics.median(ratio) if ratio else None,
    }


def pool_terms(fits):
    """Each context term's season mean and between-race variance from unpooled race fits (DerSimonian-Laird, random
    effects): -> (mu, tau2), None for a term fewer than HIER_MIN_ROUNDS races pin down."""
    mu, tau2 = [], []
    for j in range(len(HIER_TERMS)):
        est = [(f["ctx"][j], f["ctxVar"][j]) for f in fits if f["support"][j] >= HIER_MIN_LAPS and f["ctxVar"][j] > 0]
        if len(est) < HIER_MIN_ROUNDS:
            mu.append(None)
            tau2.append(None)
            continue
        w = [1 / v for _, v in est]
        sw = sum(w)
        m0 = sum(wi * b for wi, (b, _) in zip(w, est, strict=True)) / sw
        q = sum(wi * (b - m0) ** 2 for wi, (b, _) in zip(w, est, strict=True))
        t2 = max(0.0, (q - (len(est) - 1)) / (sw - sum(wi * wi for wi in w) / sw))
        ws = [1 / (v + t2) for _, v in est]
        mu.append(sum(wi * b for wi, (b, _) in zip(ws, est, strict=True)) / sum(ws))
        tau2.append(t2)
    return mu, tau2


def _race_canons(archived, read_json, done):
    """{gd: the race's lap records} for finished rounds whose laps line up with FastF1's (as fit_pace)."""
    out = {}
    for gd in sorted(done):
        lp = archived("laps", f"gd{gd:02d}.json")
        canon = read_json(lp).get("race") if os.path.exists(lp) else None
        if canon and canon.get("laps") and ((canon.get("quality") or {}).get("ff") or {"ok": True})["ok"]:
            out[gd] = canon
    return out


def pool_rounds(archived, read_json, write_json, done):
    """The challenger `racepool`'s input (MODEL.racePace "pool", user 2026-09-28: deferred for want of evidence, so
    let it collect evidence): each finished round's pooled race pace (`pacePool`, % off the fastest), round k pooled
    with rounds <= k only, written into its race record (history/<season>/races) where it changed. The engine weights
    it with the race-alone fit's standard errors (paceSe), as the fourth review screened it. Returns {gd: record}
    for the rounds rewritten."""
    designs, raw = {}, {}
    for gd, canon in _race_canons(archived, read_json, done).items():
        d = hier_design(canon)
        if d:
            designs[gd], raw[gd] = d, hier_fit(d)
    out = {}
    for gd in sorted(designs):
        mu, tau2 = pool_terms([raw[g] for g in raw if g <= gd])
        pace = hier_fit(designs[gd], mu, tau2)["pace"]
        path = archived("races", f"gd{gd:02d}.json")
        if not os.path.exists(path):
            continue
        rec = read_json(path)
        race = rec.get("race")
        if race is None or race.get("pacePool") == pace:
            continue
        race["pacePool"] = pace
        write_json(path, rec, indent=1, sort_keys=True)
        out[gd] = rec
    return out


def hier_report(archived, read_json, done):
    """The pooled race pace for every finished round with lap records, round k pooled with rounds <= k, next to the
    race-alone fit: [{gd, fuel {alone, fit, season, tau}, maxShift, meanShift (% of a lap, driver terms)}].
    A check, not a model input: on R1-R15 2026 pooling moved a driver's race pace by at most 0.161% (R6; 0.113% R4,
    <= 0.021% elsewhere; mean <= 0.044%; race-to-race spread ~0.4%). Deferred for want of evidence, not shown useless:
    the fourth review's screen (pooled vs unpooled contextual pace, uncertainty weights held) gave CRPS -0.006 +/-
    0.010, inconclusive (docs/history.md). Re-run with a full season: python laps.py hier"""
    designs, raw = {}, {}
    for gd, canon in _race_canons(archived, read_json, done).items():
        d = hier_design(canon)
        if d:
            designs[gd], raw[gd] = d, hier_fit(d)
    rows = []
    for gd in sorted(designs):
        mu, tau2 = pool_terms([raw[g] for g in raw if g <= gd])
        f, a = hier_fit(designs[gd], mu, tau2), raw[gd]
        j = HIER_TERMS.index("fuel")
        shifts = [abs(f["pace"][t] - a["pace"][t]) for t in f["pace"]]
        rows.append(
            {
                "gd": gd,
                "fuel": {
                    "alone": round(a["ctx"][j] * 100, 3),
                    "fit": round(f["ctx"][j] * 100, 3),
                    "season": None if mu[j] is None else round(mu[j] * 100, 3),
                    "tau": None if tau2[j] is None else round(math.sqrt(tau2[j]) * 100, 3),
                },
                "maxShift": round(max(shifts), 3),
                "meanShift": round(statistics.mean(shifts), 3),
            }
        )
    return rows


def inflate_check(archived, read_json, done):
    """How far the lap model's standard errors understate (MODEL.ctxSeInflate, hand-set 2), from a split of the
    stints: each driver's odd and even stints (>= 5 clean laps each) get a pace term each, fitted together with the
    shared context terms; their difference against its standard error should be N(0, 1) if the errors were honest,
    so sqrt(mean z^2) is the inflation. Only drivers whose odd and even stints share a compound (else the compound
    offset soaks the difference up). Not an untouched held-out prediction (both halves are in the fit), and the rows
    aren't independent weekends: per round it ranges 0.05-3.07, leaving R8 out takes 1.85 to ~1.47 (fourth review).
    Data-informed, not a validated constant. -> {rounds, drivers, inflation, perRound}. python laps.py inflate"""
    import numpy as np

    z2, per = [], {}
    for gd, canon in _race_canons(archived, read_json, done).items():
        rows = [r for r in clean_laps(canon, stint=True) if r[2] in HIER_CMPS]
        laps_in, cmp_of = {}, {}
        for r in rows:
            laps_in[(r[0], r[6])] = laps_in.get((r[0], r[6]), 0) + 1
            cmp_of.setdefault((r[0], r[6]), set()).add(r[2])
        par = {}
        for t in {k[0] for k in laps_in}:
            good = sorted(s for (d, s), n in laps_in.items() if d == t and n >= 5)
            odd = set().union(*(cmp_of[(t, s)] for s in good[0::2])) if good else set()
            even = set().union(*(cmp_of[(t, s)] for s in good[1::2])) if len(good) > 1 else set()
            if odd & even:
                for k, s in enumerate(good):
                    par[(t, s)] = k % 2
        rows = [r for r in rows if (r[0], r[6]) in par]
        keys = sorted({(r[0], par[(r[0], r[6])]) for r in rows})
        if len(keys) < 6:
            continue
        ki, nk, nt = {k: i for i, k in enumerate(keys)}, len(keys), len(HIER_TERMS)
        X = np.zeros((len(rows), nk + nt))
        y = np.log(np.array([r[1] for r in rows]))
        for i, (t, _, c, age, fuel, traffic, st) in enumerate(rows):
            X[i, ki[(t, par[(t, st)])]] = 1
            if c != "M":
                X[i, nk + HIER_TERMS.index("cmp:" + c)] = 1
            X[i, nk + HIER_TERMS.index("age:" + c)] = age
            X[i, nk + HIER_TERMS.index("fuel")] = fuel
            X[i, nk + HIER_TERMS.index("traffic")] = traffic
        lam = np.r_[np.zeros(nk), np.full(nt, RIDGE * 1e-4)]
        w = np.ones(len(y))
        for _ in range(8):
            XtW = X.T * w
            beta = np.linalg.solve(XtW @ X + np.diag(lam), XtW @ y)
            res = y - X @ beta
            s = 1.4826 * np.median(np.abs(res - np.median(res))) or 1e-3
            w = np.where(np.abs(res) <= 1.5 * s, 1.0, 1.5 * s / np.maximum(np.abs(res), 1e-12))
        sigma2 = float(np.sum(w * res**2) / max(1, len(y) - nk - nt))
        cov = sigma2 * np.linalg.inv((X.T * w) @ X + np.diag(lam))
        zs = []
        for t in sorted({k[0] for k in keys}):
            if (t, 0) in ki and (t, 1) in ki:
                a, b = ki[(t, 0)], ki[(t, 1)]
                var = cov[a, a] + cov[b, b] - 2 * cov[a, b]
                if var > 0:
                    zs.append(float((beta[a] - beta[b]) ** 2 / var))
        if zs:
            z2 += zs
            per[gd] = [len(zs), round(math.sqrt(statistics.mean(zs)), 2)]
    return {
        "rounds": len(per),
        "drivers": len(z2),
        "inflation": round(math.sqrt(statistics.mean(z2)), 2) if z2 else None,
        "perRound": per,
    }


def _hier_cmd(args):
    import refresh

    data = refresh.read_json(refresh.cached("data.json"))
    done = _rounds(args.rounds, data["done"])
    if args.cmd == "inflate":
        print(json.dumps(inflate_check(refresh.archived, refresh.read_json, done)))
        return
    for r in hier_report(refresh.archived, refresh.read_json, done):
        f = r["fuel"]
        print(
            f"R{r['gd']}: fuel (full race) alone {f['alone']}%, pooled {f['fit']}% (season {f['season']}, tau "
            f"{f['tau']}); driver pace moved max {r['maxShift']}%, mean {r['meanShift']}%"
        )


# ---------------------------------------------------------------- retirements


CAR = re.compile(r"\b(\d{1,2}) \([A-Z]{3}\)")  # "CARS 1 (NOR), 10 (GAS) AND 43 (COL)"
INCIDENT_BEFORE, INCIDENT_AFTER = 180, 600  # s: an incident message this long before / after a car stops


def _cars(msg):
    """Car numbers named in an incident message."""
    return {int(n) for n in CAR.findall(msg)}


def retirements(results, rc, num_of, canon=None):
    """Each unclassified car's cause: "dns" (didn't start), "incident" (race control names it in an incident or
    collision from INCIDENT_BEFORE s before it stopped to INCIDENT_AFTER s after: messages lag, an "update" comes
    minutes later), else "other" (no incident recorded: a mechanical failure, or a solo crash race control didn't
    name); with the lap it stopped on and the share of the race run. When the stop time isn't known (no canonical
    laps), race control's lap number is the leader's: INCIDENT_WINDOW laps before to 5 after.
    results: Jolpica rows (tla, cls, laps, dns); num_of: tla -> car number."""
    full = max((r.get("laps") or 0 for r in results), default=0)
    incidents = []
    for m in rc or []:
        msg = (m.get("message") or "").upper()
        if "INCIDENT" not in msg and "COLLISION" not in msg:
            continue
        if any(k in msg for k in SKIP_INCIDENTS):
            continue
        incidents.append((_t(m.get("date")), m.get("lap_number") or 0, _cars(msg)))
    stops = {}
    if canon and canon.get("t0"):
        ix = {c: i for i, c in enumerate(canon["cols"])}
        t0 = datetime.fromisoformat(canon["t0"]).timestamp()
        for t, rows in canon["laps"].items():
            last = max((r for r in rows if r[ix["start"]] is not None), key=lambda r: r[ix["lap"]], default=None)
            if last:
                stops[t] = t0 + last[ix["start"]] + (last[ix["time"]] or 0)
    out = {}
    for r in results:
        # a disqualified car ran the race: not a retirement (fourth review: one came out as "other")
        if r.get("cls") or r.get("dsq"):
            continue
        t, laps = r["tla"], r.get("laps") or 0
        if r.get("dns"):
            out[t] = {"cause": "dns", "lap": 0, "share": 0.0}
            continue
        stop, num = laps + 1, num_of.get(t)
        at = stops.get(t)
        if at is not None:
            hit = any(
                num in cars and when is not None and at - INCIDENT_BEFORE <= when <= at + INCIDENT_AFTER
                for when, _, cars in incidents
            )
        else:
            hit = any(num in cars and stop - INCIDENT_WINDOW <= lap <= stop + 5 for _, lap, cars in incidents)
        out[t] = {
            "cause": "incident" if hit else "other",
            "lap": stop,
            "share": round(laps / full, 3) if full else None,
        }
    return out


# ---------------------------------------------------------------- CLI


def _rounds(spec, done):
    if not spec:
        return done
    a, _, b = spec.partition("-")
    return [g for g in done if int(a) <= g <= int(b or a)]


def backfill(args):
    import extras
    import refresh

    data = refresh.read_json(refresh.cached("data.json"))
    sessions = extras._sessions(refresh.get_soft, refresh.cached, refresh.SEASON, fresh=False)
    for gd in _rounds(args.rounds, data["done"]):
        g = next(x for x in data["schedule"] if x["gd"] == gd)
        path = refresh.archived("races", f"gd{gd:02d}.json")
        rec = refresh.read_json(path) if os.path.exists(path) else {}
        rows = data["results"]["race"].get(str(gd)) or data["results"]["race"].get(gd) or []
        num2 = {r["num"]: r["tla"] for r in rows if r.get("num")}
        lap_rec = {"gd": gd}
        for name, key in (("Race", "race"), ("Sprint", "sprint")):
            s = extras._session_for(sessions, name, g["raceStart"])
            if not s or key not in rec:
                continue
            f = lambda kind, s=s: extras._of(refresh.get_soft, refresh.cached, kind, s["session_key"])  # noqa: E731
            canon = canonical(f("laps"), f("stints"), f("race_control"), f("weather"), num2)
            lap_rec[key] = canon
            fit = fit_pace(canon)
            if fit:
                rec[key]["paceCtx"], rec[key]["paceSe"] = fit["pace"], fit["se"]
                rec[key]["paceN"], rec[key]["paceCoef"] = fit["n"], fit["coef"]
            rec[key]["wx"] = extras.wx_summary(f("weather"))
            if key == "race":
                rec[key]["retirements"] = retirements(rows, f("race_control"), {v: k for k, v in num2.items()}, canon)
        q = extras._session_for(sessions, "Qualifying", g["raceStart"])
        if q:
            rec["quali"] = {
                "wx": extras.wx_summary(extras._of(refresh.get_soft, refresh.cached, "weather", q["session_key"]))
            }
        refresh.write_json(refresh.archived("laps", f"gd{gd:02d}.json"), lap_rec, separators=(",", ":"))
        refresh.write_json(path, rec, indent=1, sort_keys=True)
        r = rec.get("race", {})
        causes = [v["cause"] for v in (r.get("retirements") or {}).values()]
        print(
            f"R{gd}: {sum(len(v) for v in lap_rec.get('race', {}).get('laps', {}).values())} race laps, "
            f"pace for {len(r.get('paceCtx') or {})} drivers, sigma {(r.get('paceCoef') or {}).get('sigma')}%, "
            f"retirements {', '.join(f'{c} {causes.count(c)}' for c in sorted(set(causes))) or 'none'}"
        )


def audit(args):
    """OpenF1 lap times and compounds against the FastF1 archive (history/<season>/telemetry/laps)."""
    import refresh

    for gd in _rounds(args.rounds, refresh.read_json(refresh.cached("data.json"))["done"]):
        ff = refresh.archived("telemetry", "laps", f"gd{gd:02d}.json")
        of = refresh.archived("laps", f"gd{gd:02d}.json")
        if not (os.path.exists(ff) and os.path.exists(of)):
            continue
        a = refresh.read_json(ff)["sessions"].get("R")
        b = refresh.read_json(of).get("race")
        if not a or not b:
            continue
        ia = {c: i for i, c in enumerate(a["cols"])}
        ib = {c: i for i, c in enumerate(b["cols"])}
        n = same_t = same_c = 0
        for t, rows in b["laps"].items():
            fa = {r[ia["lap"]]: r for r in a["laps"].get(t, [])}
            for r in rows:
                x = fa.get(r[ib["lap"]])
                if not x or r[ib["time"]] is None or x[ia["lapTime"]] is None:
                    continue
                n += 1
                same_t += abs(r[ib["time"]] - x[ia["lapTime"]]) < 0.01
                same_c += (r[ib["cmp"]] or "") == (x[ia["cmp"]] or "")[:1]
        print(
            f"R{gd}: {n} laps in both, lap time equal {same_t / max(1, n):.1%}, compound equal {same_c / max(1, n):.1%}"
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["backfill", "audit", "hier", "inflate"])
    ap.add_argument("--rounds")
    args = ap.parse_args()
    {"backfill": backfill, "audit": audit, "hier": _hier_cmd, "inflate": _hier_cmd}[args.cmd](args)


if __name__ == "__main__":
    main()
