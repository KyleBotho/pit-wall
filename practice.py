"""Practice-session pace from OpenF1 lap data (free, available shortly after each session).

For each practice session:
  short run  = driver's best clean lap, as % gap to the session's fastest   -> qualifying pace
  long run   = median clean lap of stints of 5+ laps, corrected for tyre compound
               and fuel burn, as % gap to the best long run in the session  -> race pace
"""

import statistics
from datetime import datetime, timedelta

COMPOUND_ORDER = ["SOFT", "MEDIUM", "HARD"]
FUEL_S_PER_LAP = 0.055  # lap-time gain per lap of fuel burned (s)
DEG_S_PER_LAP = 0.04  # typical tyre degradation per lap of tyre age (s)


def sessions_for(get, cache_path, lock_iso):
    """Practice sessions of the meeting whose qualifying/sprint lock is lock_iso."""
    lock = datetime.fromisoformat(lock_iso)
    year = lock.year
    allp = get(
        f"https://api.openf1.org/v1/sessions?year={year}&session_type=Practice", cache_path(f"of_sessions_{year}.json")
    )
    out = []
    for s in allp:
        start = datetime.fromisoformat(s["date_start"])
        if lock - timedelta(days=4) < start < lock and not s.get("is_cancelled"):
            out.append(s)
    return sorted(out, key=lambda s: s["date_start"])


def analyse_session(laps, stints, drivers):
    num2tla = {d["driver_number"]: d["name_acronym"] for d in drivers}
    by_drv = {}
    for lap in laps:
        by_drv.setdefault(lap["driver_number"], []).append(lap)
    stint_of = {}
    # a stint still open when the data was pulled has no lap_end: it runs to the driver's last lap. Later stints
    # are applied last so they win any overlap.
    for s in sorted(stints, key=lambda s: (s["driver_number"], s.get("stint_number") or 0)):
        for n in range(s["lap_start"] or 0, (s["lap_end"] or 999) + 1):
            stint_of[(s["driver_number"], n)] = s

    best, runs = {}, {}
    for num, ls in by_drv.items():
        clean = [lap for lap in ls if lap.get("lap_duration") and not lap.get("is_pit_out_lap")]
        if clean:
            best[num] = min(lap["lap_duration"] for lap in clean)
            # ideal lap: sum of the driver's best three sectors (robust to one scrappy sector)
            secs = [
                min((lap.get(f"duration_sector_{i}") or 1e9) for lap in ls if not lap.get("is_pit_out_lap"))
                for i in (1, 2, 3)
            ]
            if max(secs) < 1e8:
                best[num] = min(best[num], sum(secs))
        # long runs: group clean laps by stint
        groups = {}
        for lap in clean:
            st = stint_of.get((num, lap["lap_number"]))
            if st:
                groups.setdefault(st["stint_number"], (st, []))[1].append(lap)
        for st, gl in groups.values():
            if len(gl) < 6:
                continue
            gl = sorted(gl, key=lambda lap: lap["lap_number"])[:-1]  # drop in-lap/cool-down tail
            med = statistics.median(lap["lap_duration"] for lap in gl)
            gl = [lap for lap in gl if lap["lap_duration"] < med * 1.025]  # traffic, push laps, mistakes
            if len(gl) < 5:
                continue
            # normalise each lap to "fresh tyre, start-of-run fuel" conditions
            adj = []
            for lap in gl:
                age = (st.get("tyre_age_at_start") or 0) + lap["lap_number"] - st["lap_start"]
                k = lap["lap_number"] - gl[0]["lap_number"]
                adj.append(lap["lap_duration"] + FUEL_S_PER_LAP * k - DEG_S_PER_LAP * age)
            runs.setdefault(num, []).append(
                {"compound": st.get("compound") or "MEDIUM", "pace": statistics.median(adj), "laps": len(gl)}
            )

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


REF_DRIVERS = 10


def ref_lap(laps):
    """The session's reference lap (s): median of the REF_DRIVERS fastest drivers' best clean laps (actual laps, not
    sector sums). With the circuit length it gives the track's average speed, which sets the round's overtake level
    (engine.js TRACK.speed)."""
    best = {}
    for lap in laps:
        t = lap.get("lap_duration")
        if t and not lap.get("is_pit_out_lap"):
            best[lap["driver_number"]] = min(best.get(lap["driver_number"], t), t)
    top = sorted(best.values())[:REF_DRIVERS]
    return round(statistics.median(top), 3) if len(top) >= 5 else None


def practice_for(get, cache_path, lock_iso, now):
    out = []
    for s in sessions_for(get, cache_path, lock_iso):
        end = datetime.fromisoformat(s["date_end"])
        if end > now:
            out.append({"name": s["session_name"], "start": s["date_start"], "done": False, "drivers": {}})
            continue
        key = s["session_key"]

        def fetch(kind, key=key):
            url, path = f"https://api.openf1.org/v1/{kind}?session_key={key}", cache_path(f"of_{kind}_{key}.json")
            d = get(url, path, reuse=True)
            return d if isinstance(d, list) and d else get(url, path)  # don't trust an empty cached answer

        try:
            laps = fetch("laps")
            if not isinstance(laps, list) or not laps:
                raise ValueError("no laps yet")
            stints, drivers = fetch("stints"), fetch("drivers")
        except Exception as e:  # one session unavailable (OpenF1 closed during live sessions): try F1's own timing
            print(f"  ! {s['session_name']}: {e}")
            try:
                laps, stints, drivers = fastf1_session(s, cache_path)
                print(f"    {s['session_name']}: loaded from F1 live timing (FastF1) instead")
            except Exception as e2:  # noqa: BLE001 - FastF1 missing or the session not published yet
                print(f"    FastF1 fallback: {e2}")
                out.append({"name": s["session_name"], "start": s["date_start"], "done": False, "drivers": {}})
                continue
        out.append(
            {
                "name": s["session_name"],
                "start": s["date_start"],
                "done": True,
                "ref": ref_lap(laps),
                "drivers": analyse_session(
                    laps, stints if isinstance(stints, list) else [], drivers if isinstance(drivers, list) else []
                ),
            }
        )
    return out


FASTF1_NAMES = {"Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3"}


def fastf1_session(s, cache_path):
    """The same laps / stints / drivers records as OpenF1, read with FastF1 from F1's live-timing archive (public,
    published shortly after each session). Used when OpenF1 refuses us (it locks while any session is live)."""
    import os

    import fastf1  # optional dependency: pip install fastf1

    folder = os.path.dirname(cache_path("fastf1/x"))
    os.makedirs(folder, exist_ok=True)
    fastf1.Cache.enable_cache(folder)
    year = int(s["date_start"][:4])
    ses = fastf1.get_session(year, s.get("location") or s.get("country_name"), FASTF1_NAMES[s["session_name"]])
    ses.load(laps=True, telemetry=False, weather=False, messages=False)
    secs = lambda v: None if v is None or v != v else v.total_seconds()  # noqa: E731 - NaT != NaT
    laps, stints, drivers = [], {}, {}
    for _, r in ses.laps.iterrows():
        num = int(r["DriverNumber"])
        drivers[num] = r["Driver"]
        n = int(r["LapNumber"])
        laps.append(
            {
                "driver_number": num,
                "lap_number": n,
                "lap_duration": secs(r["LapTime"]),
                "is_pit_out_lap": r["PitOutTime"] == r["PitOutTime"],  # not NaT
                "duration_sector_1": secs(r["Sector1Time"]),
                "duration_sector_2": secs(r["Sector2Time"]),
                "duration_sector_3": secs(r["Sector3Time"]),
            }
        )
        if r["Stint"] != r["Stint"]:
            continue
        st = stints.setdefault(
            (num, int(r["Stint"])),
            {
                "driver_number": num,
                "stint_number": int(r["Stint"]),
                "lap_start": n,
                "lap_end": n,
                "compound": r["Compound"] if isinstance(r["Compound"], str) else None,
                "tyre_age_at_start": max(0, int(r["TyreLife"]) - 1) if r["TyreLife"] == r["TyreLife"] else 0,
            },
        )
        st["lap_end"] = max(st["lap_end"], n)
    if not laps:
        raise ValueError("no laps in the live-timing archive yet")
    return laps, list(stints.values()), [{"driver_number": k, "name_acronym": v} for k, v in drivers.items()]
