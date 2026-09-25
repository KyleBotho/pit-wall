"""This season's extra model inputs, beyond the fantasy feeds and classifications (all public, no login):

  calendar()       Jolpica: each round's circuit id, coordinates and race date (joins the circuit priors, weather)
  race_info()      OpenF1, per finished round: safety cars, VSCs, red flags, rain, stationary pit-stop times per
                   team, and race pace (median clean lap per driver, % off the fastest), archived per round
  weather()        Open-Meteo: rain probability during qualifying and the race, for races within the forecast range
  odds()           Kalshi: market probabilities for the next race (winner, podium, top 10, pole)
  weekend()        OpenF1, for the next race: grid penalties announced by race control and, once qualifying has
                   run, the actual qualifying / sprint order (the Final Fix and Live sims start from it)

Every function takes the caller's paced fetchers (f1feeds.get / get_soft) and cache/archive path helpers, fails soft
(a missing extra never blocks a price refresh) and returns plain JSON for DATA.
"""

import re
import statistics
from datetime import datetime, timedelta, timezone

OPENF1 = "https://api.openf1.org/v1"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
# Kalshi series: probability per driver, and how many drivers each market pays out on (to normalise the book)
KALSHI_SERIES = {
    "win": ("KXF1RACE", 1),
    "podium": ("KXF1RACEPODIUM", 3),
    "top10": ("KXF1TOP10", 10),
    "pole": ("KXF1POLE", 1),
}


def _dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _warn(what, e):
    print(f"  ! {what}: {e}")


# ---------------------------------------------------------------- calendar


def calendar(get, cached, season):
    """Round -> {circuit, lat, lon, date (race, UTC)} from Jolpica."""
    d = get(f"https://api.jolpi.ca/ergast/f1/{season}.json?limit=100", cached(f"j_calendar_{season}.json"), reuse=True)
    out = []
    for r in d["MRData"]["RaceTable"]["Races"]:
        loc = r["Circuit"]["Location"]
        out.append(
            {
                "round": int(r["round"]),
                "circuit": r["Circuit"]["circuitId"],
                "lat": float(loc["lat"]),
                "lon": float(loc["long"]),
                "date": r["date"],
                "name": r["raceName"],
            }
        )
    return out


def match_round(cal, race_start):
    """The calendar row whose race date is within a day of the gameday's race start."""
    if not race_start:
        return None
    day = _dt(race_start).date()
    return next((c for c in cal if abs((datetime.fromisoformat(c["date"]).date() - day).days) <= 1), None)


# ---------------------------------------------------------------- finished rounds


def _sessions(get_soft, cached, season, fresh):
    return get_soft(f"{OPENF1}/sessions?year={season}", cached(f"of_sessions_all_{season}.json"), reuse=not fresh)


def _session_for(sessions, name, race_start):
    """The OpenF1 session with this name in the week of a race."""
    t = _dt(race_start)
    for s in sessions or []:
        near = timedelta(days=-4) <= _dt(s["date_start"]) - t <= timedelta(hours=6)
        if s.get("session_name") == name and not s.get("is_cancelled") and near:
            return s
    return None


def lap_pace(laps):
    """Race pace per driver number: median clean lap, % off the fastest driver's median. Clean = not lap 1, not a pit
    out-lap or in-lap, and within 107% of the driver's own median (safety cars, damage, traffic)."""
    by = {}
    for lap in laps:
        by.setdefault(lap["driver_number"], []).append(lap)
    med = {}
    for num, ls in by.items():
        outs = {lap["lap_number"] for lap in ls if lap.get("is_pit_out_lap")}
        ok = [
            lap["lap_duration"]
            for lap in ls
            if lap.get("lap_duration")
            and lap["lap_number"] > 1
            and lap["lap_number"] not in outs
            and lap["lap_number"] + 1 not in outs
        ]
        if len(ok) < 8:
            continue
        m = statistics.median(ok)
        ok = [t for t in ok if t < m * 1.07]
        if len(ok) >= 8:
            med[num] = statistics.median(ok)
    if not med:
        return {}
    best = min(med.values())
    return {num: round((v / best - 1) * 100, 3) for num, v in med.items()}


def _race_block(get_soft, cached, s, num2):
    """One race session: SC/VSC/red/rain, pit stops by team, pace by driver TLA."""
    key = s["session_key"]

    def f(kind):
        d = get_soft(f"{OPENF1}/{kind}?session_key={key}", cached(f"of_{kind}_{key}.json"), reuse=True)
        return d if isinstance(d, list) else []

    rc, wx, pits, laps = f("race_control"), f("weather"), f("pit"), f("laps")
    if not laps:
        raise ValueError("no laps yet")
    msgs = [(m.get("message") or "").upper() for m in rc]
    pace = lap_pace(laps)
    stops = {}
    for p in pits:
        who = num2.get(p.get("driver_number"))
        if who and p.get("stop_duration"):
            stops.setdefault(who[1], []).append(p["stop_duration"])
    return {
        "sc": sum(1 for m in msgs if m.startswith("SAFETY CAR DEPLOYED")),
        "vsc": sum(1 for m in msgs if m.startswith("VIRTUAL SAFETY CAR DEPLOYED")),
        "red": int(any(m.get("flag") == "RED" for m in rc)),
        "rain": int(sum(1 for w in wx if w.get("rainfall")) >= 3),
        "pits": {t: sorted(v) for t, v in stops.items()},
        "pace": {num2[n][0]: v for n, v in pace.items() if n in num2},
    }


def race_info(get_soft, cached, archived, read_json, write_json, season, schedule, done, results_num):
    """Per finished round (archived once complete): race and sprint blocks. results_num[gd] = {car number: (tla,
    team)} from the Jolpica classification."""
    import os

    out, sessions = {}, None
    for g in schedule:
        gd = g["gd"]
        if gd not in done:
            continue
        path = archived("races", f"gd{gd:02d}.json")
        if os.path.exists(path):
            out[gd] = read_json(path)
            continue
        try:
            if sessions is None:
                sessions = _sessions(get_soft, cached, season, fresh=True)
            num2 = results_num.get(gd) or {}
            rec = {}
            for name, key in (("Race", "race"), ("Sprint", "sprint")):
                s = _session_for(sessions, name, g["raceStart"])
                if s:
                    rec[key] = _race_block(get_soft, cached, s, num2)
            if "race" in rec:
                write_json(path, rec, indent=1, sort_keys=True)
                out[gd] = rec
        except Exception as e:  # noqa: BLE001 - an extra; OpenF1 closes during live sessions
            _warn(f"OpenF1 race data for gameday {gd}", e)
    return out


# ---------------------------------------------------------------- weather forecast


def weather(get_soft, cached, races, now):
    """Rain probability (max hourly %) over qualifying and the race for each coming race Open-Meteo can forecast
    (16 days). races: [{gd, lat, lon, sessions: [{type, start}]}]."""
    out = {}
    for g in races:
        if g.get("lat") is None:
            continue
        starts = {s["type"]: _dt(s["start"]) for s in g["sessions"]}
        if min(starts.values()) - now > timedelta(days=15):
            continue
        url = (
            "https://api.open-meteo.com/v1/forecast?latitude={:.3f}&longitude={:.3f}"
            "&hourly=precipitation_probability,precipitation&forecast_days=16&timezone=UTC"
        ).format(g["lat"], g["lon"])
        try:
            d = get_soft(url, cached(f"wx_{g['gd']}.json"))
        except Exception as e:  # noqa: BLE001
            _warn(f"weather for gameday {g['gd']}", e)
            continue
        hours = d.get("hourly") or {}
        times = [datetime.fromisoformat(t).replace(tzinfo=timezone.utc) for t in hours.get("time", [])]
        prob = hours.get("precipitation_probability") or []

        hourly = [(t, p) for t, p in zip(times, prob, strict=False) if p is not None]

        def window(t0, h, hourly=hourly):
            v = [p for t, p in hourly if t0 - timedelta(hours=1) <= t <= t0 + timedelta(hours=h)]
            return round(max(v) / 100, 2) if v else None

        rec = {"at": now.isoformat(timespec="minutes")}
        for typ, key, h in (("Qualifying", "q", 1), ("Sprint", "s", 1), ("Race", "r", 2)):
            if typ in starts:
                rec[key] = window(starts[typ], h)
        out[g["gd"]] = rec
    return out


# ---------------------------------------------------------------- market odds


def _kalshi_events(get_soft, cached):
    d = get_soft(f"{KALSHI}/events?limit=100&series_ticker=KXF1RACE", cached("k_events.json"))
    return d.get("events") or []


def kalshi_suffix(events, name, season):
    """The event suffix (e.g. AZEGP26) for a meeting name like "Azerbaijan Grand Prix"."""
    yy = str(season)[-2:]
    key = re.sub(r"[^a-z]", "", name.lower().replace("grand prix", ""))
    for e in events:
        t = e["event_ticker"].split("-", 1)[1]
        sub = re.sub(r"[^a-z]", "", (e.get("sub_title") or "").lower().replace("grand prix", "").replace(yy, ""))
        if t.endswith(yy) and sub and (sub == key or sub.startswith(key) or key.startswith(sub)):
            return t
    return None


def _norm(raw, total):
    """Mid prices -> probabilities that add up to the number of drivers the market pays (removes the overround)."""
    s = sum(raw.values())
    if s <= 0:
        return {}
    return {k: round(min(0.995, v * total / s), 4) for k, v in raw.items()}


def _mid(m):
    bid, ask = m.get("yes_bid_dollars"), m.get("yes_ask_dollars")
    try:
        b, a = float(bid or 0), float(ask or 0)
    except ValueError:
        return None
    if a > 0 and b > 0:
        return (a + b) / 2
    last = m.get("last_price_dollars")
    return float(last) if last else (a or None)


def odds(get_soft, cached, name, season, tlas):
    """Market probabilities for the next race: {win, podium, top10, pole: {TLA: p}} (only drivers we know)."""
    try:
        suffix = kalshi_suffix(_kalshi_events(get_soft, cached), name, season)
    except Exception as e:  # noqa: BLE001
        _warn("Kalshi events", e)
        return None
    if not suffix:
        return None
    out = {"event": suffix}
    for key, (series, total) in KALSHI_SERIES.items():
        try:
            d = get_soft(
                f"{KALSHI}/markets?event_ticker={series}-{suffix}&limit=60", cached(f"k_{series}_{suffix}.json")
            )
        except Exception as e:  # noqa: BLE001
            _warn(f"Kalshi {series}", e)
            continue
        raw = {}
        for m in d.get("markets") or []:
            tla = m["ticker"].rsplit("-", 1)[-1]
            p = _mid(m)
            if tla in tlas and p is not None:
                raw[tla] = p
        if len(raw) >= 10:
            out[key] = _norm(raw, total)
    return out if len(out) > 1 else None


# ---------------------------------------------------------------- the coming weekend


PEN = re.compile(r"CAR (\d+) \([A-Z]{3}\).*?(\d+) PLACE GRID PENALTY")
BACK = re.compile(r"CAR (\d+) \([A-Z]{3}\).*?(BACK OF THE GRID|PIT ?LANE)")


def weekend(get_soft, cached, season, g, now):
    """Race-control grid penalties this weekend and, once run, the qualifying / sprint qualifying / sprint order."""
    out = {"penalties": {}, "grid": {}}
    try:
        sessions = _sessions(get_soft, cached, season, fresh=True)
    except Exception as e:  # noqa: BLE001
        _warn("OpenF1 sessions", e)
        return out
    race = _session_for(sessions, "Race", g["raceStart"])
    meeting = race and race["meeting_key"]
    if not meeting:
        return out
    try:
        drv = get_soft(f"{OPENF1}/drivers?meeting_key={meeting}", cached(f"of_drivers_m{meeting}.json"))
        num2 = {d["driver_number"]: d["name_acronym"] for d in drv or []}
        rc = get_soft(f"{OPENF1}/race_control?meeting_key={meeting}", cached(f"of_rc_m{meeting}.json"))
        for m in rc or []:
            msg = (m.get("message") or "").upper()
            if "GRID" not in msg and "PIT LANE" not in msg and "PITLANE" not in msg:
                continue
            p, b = PEN.search(msg), BACK.search(msg)
            if p and num2.get(int(p.group(1))):
                t = num2[int(p.group(1))]
                out["penalties"][t] = out["penalties"].get(t, 0) + int(p.group(2))
            elif b and num2.get(int(b.group(1))):
                out["penalties"][num2[int(b.group(1))]] = 99  # back of the grid / pit lane
        for name, key in (("Qualifying", "q"), ("Sprint Qualifying", "sq"), ("Sprint Shootout", "sq"), ("Sprint", "s")):
            s = _session_for(sessions, name, g["raceStart"])
            if not s or _dt(s["date_end"]) > now:
                continue
            res = get_soft(
                f"{OPENF1}/session_result?session_key={s['session_key']}", cached(f"of_result_{s['session_key']}.json")
            )
            rows = sorted((r for r in res or [] if r.get("position")), key=lambda r: r["position"])
            order = [num2.get(r["driver_number"]) for r in rows]
            if len(order) >= 10 and all(order):
                out["grid"][key] = order
    except Exception as e:  # noqa: BLE001
        _warn("OpenF1 weekend", e)
    return out
