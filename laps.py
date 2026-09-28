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


def clean_laps(canon):
    """(tla, time, cmp, age, fuel share, traffic) for laps fit for pace: not lap 1, not in / out laps, not
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
            out.append((t, r[ix["time"]], r[ix["cmp"]], r[ix["age"]], r[ix["lap"]] / max(1, total), traffic))
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
        if r.get("cls"):
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
    ap.add_argument("cmd", choices=["backfill", "audit"])
    ap.add_argument("--rounds")
    args = ap.parse_args()
    {"backfill": backfill, "audit": audit}[args.cmd](args)


if __name__ == "__main__":
    main()
