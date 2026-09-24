"""Practice-session pace from OpenF1 lap data (free, available shortly after each session).

For each practice session:
  short run  = driver's best clean lap, as % gap to the session's fastest   -> qualifying pace
  long run   = median clean lap of stints of 5+ laps, corrected for tyre compound
               and fuel burn, as % gap to the best long run in the session  -> race pace
"""
import statistics
from datetime import datetime, timedelta

COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD"]
FUEL_S_PER_LAP = 0.055   # lap-time gain per lap of fuel burned (s)
DEG_S_PER_LAP = 0.04     # typical tyre degradation per lap of tyre age (s)


def sessions_for(get, cache_path, lock_iso):
    """Practice sessions of the meeting whose qualifying/sprint lock is lock_iso."""
    lock = datetime.fromisoformat(lock_iso)
    year = lock.year
    allp = get(f"https://api.openf1.org/v1/sessions?year={year}&session_type=Practice",
               cache_path(f"of_sessions_{year}.json"))
    out = []
    for s in allp:
        start = datetime.fromisoformat(s["date_start"])
        if lock - timedelta(days=4) < start < lock and not s.get("is_cancelled"):
            out.append(s)
    return sorted(out, key=lambda s: s["date_start"])


def analyse_session(laps, stints, drivers):
    num2tla = {d["driver_number"]: d["name_acronym"] for d in drivers}
    by_drv = {}
    for l in laps:
        by_drv.setdefault(l["driver_number"], []).append(l)
    stint_of = {}
    for s in stints:
        for n in range(s["lap_start"] or 0, (s["lap_end"] or 0) + 1):
            stint_of[(s["driver_number"], n)] = s

    best, runs = {}, {}
    for num, ls in by_drv.items():
        clean = [l for l in ls if l.get("lap_duration") and not l.get("is_pit_out_lap")]
        if clean:
            best[num] = min(l["lap_duration"] for l in clean)
            # ideal lap: sum of the driver's best three sectors (robust to one scrappy sector)
            secs = [min((l.get(f"duration_sector_{i}") or 1e9) for l in ls if not l.get("is_pit_out_lap")) for i in (1, 2, 3)]
            if max(secs) < 1e8:
                best[num] = min(best[num], sum(secs))
        # long runs: group clean laps by stint
        groups = {}
        for l in clean:
            st = stint_of.get((num, l["lap_number"]))
            if st:
                groups.setdefault(st["stint_number"], (st, []))[1].append(l)
        for st, gl in groups.values():
            if len(gl) < 6:
                continue
            gl = sorted(gl, key=lambda l: l["lap_number"])[:-1]  # drop in-lap/cool-down tail
            med = statistics.median(l["lap_duration"] for l in gl)
            gl = [l for l in gl if l["lap_duration"] < med * 1.025]  # traffic, push laps, mistakes
            if len(gl) < 5:
                continue
            # normalise each lap to "fresh tyre, start-of-run fuel" conditions
            adj = []
            for l in gl:
                age = (st.get("tyre_age_at_start") or 0) + l["lap_number"] - st["lap_start"]
                k = l["lap_number"] - gl[0]["lap_number"]
                adj.append(l["lap_duration"] + FUEL_S_PER_LAP * k - DEG_S_PER_LAP * age)
            runs.setdefault(num, []).append({"compound": st.get("compound") or "MEDIUM",
                                             "pace": statistics.median(adj), "laps": len(gl)})

    # compound offsets from the field: median run pace per compound vs medium
    comp = {}
    for rs in runs.values():
        for r in rs:
            comp.setdefault(r["compound"], []).append(r["pace"])
    base = statistics.median(comp["MEDIUM"]) if len(comp.get("MEDIUM", [])) >= 3 else None
    off = {}
    for c, v in comp.items():
        off[c] = (statistics.median(v) - base) if base is not None and len(v) >= 3 else 0.0

    res = {}
    fastest = min(best.values()) if best else None
    long_best = {}
    for num, rs in runs.items():
        long_best[num] = min(r["pace"] - off.get(r["compound"], 0.0) for r in rs)
    lr_fast = min(long_best.values()) if long_best else None
    for num in set(best) | set(long_best):
        tla = num2tla.get(num)
        if not tla:
            continue
        res[tla] = {
            "q": round((best[num] / fastest - 1) * 100, 3) if num in best else None,
            "r": round((long_best[num] / lr_fast - 1) * 100, 3) if num in long_best else None,
            "laps": len(by_drv.get(num, [])),
            "rl": sum(r["laps"] for r in runs.get(num, [])),
        }
    return res


def practice_for(get, cache_path, lock_iso, now):
    out = []
    for s in sessions_for(get, cache_path, lock_iso):
        end = datetime.fromisoformat(s["date_end"])
        if end > now:
            out.append({"name": s["session_name"], "start": s["date_start"], "done": False, "drivers": {}})
            continue
        k = s["session_key"]

        def fetch(kind):
            url, path = f"https://api.openf1.org/v1/{kind}?session_key={k}", cache_path(f"of_{kind}_{k}.json")
            d = get(url, path, reuse=True)
            return d if isinstance(d, list) and d else get(url, path)  # don't trust an empty cached answer

        try:
            laps = fetch("laps")
            if not isinstance(laps, list) or not laps:
                raise ValueError("no laps yet")
            stints, drivers = fetch("stints"), fetch("drivers")
        except Exception as e:  # one session unavailable (OpenF1 closed during live sessions): keep the others
            print(f"  ! {s['session_name']}: {e}")
            out.append({"name": s["session_name"], "start": s["date_start"], "done": False, "drivers": {}})
            continue
        out.append({"name": s["session_name"], "start": s["date_start"], "done": True,
                    "drivers": analyse_session(laps, stints if isinstance(stints, list) else [], drivers if isinstance(drivers, list) else [])})
    return out
