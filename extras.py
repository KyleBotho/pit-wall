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

import math
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
    "fl": ("KXF1FASTLAP", 1),  # race fastest lap (KXF1FASTESTLAP stopped after 2025)
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


def _of(get_soft, cached, kind, key):
    """One OpenF1 table of a session (cached for good: a finished session doesn't change)."""
    d = get_soft(f"{OPENF1}/{kind}?session_key={key}", cached(f"of_{kind}_{key}.json"), reuse=True)
    return d if isinstance(d, list) else []


def wx_summary(wx):
    """A session's observed weather (OpenF1, about one reading a minute): mean air / track temperature and humidity,
    and the minutes with rain reported. For track-wetness calibration against the forecasts kept in collect.py."""
    rows = [w for w in wx or [] if w.get("air_temperature") is not None]
    if not rows:
        return None

    def mean(k):
        v = [w[k] for w in rows if w.get(k) is not None]
        return round(sum(v) / len(v), 1) if v else None

    return {
        "air": mean("air_temperature"),
        "track": mean("track_temperature"),
        "humidity": mean("humidity"),
        "rainMin": sum(1 for w in rows if w.get("rainfall")),
        "n": len(rows),
    }


def _race_block(get_soft, cached, s, num2, results=None, archive=None):
    """One race session: SC/VSC/red/rain, pit stops by team, pace by driver TLA (median clean lap, and the
    contextual model: laps.py), and for the race each retirement's cause. archive(canon) keeps the canonical laps."""
    import laps as lapmod

    key = s["session_key"]

    def f(kind):
        return _of(get_soft, cached, kind, key)

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
    block = {
        "sc": sum(1 for m in msgs if m.startswith("SAFETY CAR DEPLOYED")),
        "vsc": sum(1 for m in msgs if m.startswith("VIRTUAL SAFETY CAR DEPLOYED")),
        "red": int(any(m.get("flag") == "RED" for m in rc)),
        "rain": int(sum(1 for w in wx if w.get("rainfall")) >= 3),
        "pits": {t: sorted(v) for t, v in stops.items()},
        "pace": {num2[n][0]: v for n, v in pace.items() if n in num2},
        "wx": wx_summary(wx),
    }
    # batch 3: every lap with its context, the pace model on it, retirement causes (fail-soft: extras)
    try:
        tla = {n: v[0] for n, v in num2.items()}
        canon = lapmod.canonical(laps, f("stints"), rc, wx, tla)
        if archive:
            archive(canon)
        fit = lapmod.fit_pace(canon)
        if fit:
            block.update(paceCtx=fit["pace"], paceSe=fit["se"], paceN=fit["n"], paceCoef=fit["coef"])
        if results:
            block["retirements"] = lapmod.retirements(results, rc, {v: k for k, v in tla.items()}, canon)
    except Exception as e:  # noqa: BLE001
        _warn("lap model", e)
    return block


RETRY_DAYS = 4  # a finished round's race block is recomputed this long while its lap model / causes are missing


def race_info(get_soft, cached, archived, read_json, write_json, season, schedule, done, results_num, race_rows=None):
    """Per finished round (archived once complete): race and sprint blocks. results_num[gd] = {car number: (tla,
    team)} from the Jolpica classification; race_rows[gd] = its race rows (for retirement causes). The canonical
    laps go to history/<season>/laps/gdNN.json."""
    import os

    out, sessions = {}, None
    for g in schedule:
        gd = g["gd"]
        if gd not in done:
            continue
        path = archived("races", f"gd{gd:02d}.json")
        if os.path.exists(path):
            rec = read_json(path)
            race = rec.get("race") or {}
            # first archived before OpenF1's stints or Jolpica's classification were in: try again for a few days
            late = datetime.now(timezone.utc) - _dt(g["raceStart"]) < timedelta(days=RETRY_DAYS)
            out[gd] = rec  # kept if the retry fails
            if not (late and ("paceCtx" not in race or "retirements" not in race)):
                continue
        try:
            if sessions is None:
                sessions = _sessions(get_soft, cached, season, fresh=True)
            num2 = results_num.get(gd) or {}
            rec, lap_rec = {}, {"gd": gd}
            for name, key in (("Race", "race"), ("Sprint", "sprint")):
                s = _session_for(sessions, name, g["raceStart"])
                if s:
                    rows = (race_rows or {}).get(gd) if key == "race" else None
                    rec[key] = _race_block(get_soft, cached, s, num2, rows, lap_rec.setdefault(key, {}).update)
            q = _session_for(sessions, "Qualifying", g["raceStart"])
            if q:
                rec["quali"] = {"wx": wx_summary(_of(get_soft, cached, "weather", q["session_key"]))}
            if "race" in rec:
                write_json(path, rec, indent=1, sort_keys=True)
                if len(lap_rec) > 1:
                    write_json(archived("laps", f"gd{gd:02d}.json"), lap_rec, separators=(",", ":"))
                out[gd] = rec
        except Exception as e:  # noqa: BLE001 - an extra; OpenF1 closes during live sessions
            _warn(f"OpenF1 race data for gameday {gd}", e)
    # once telemetry.py has archived a round from FastF1: its lap records checked against it, the pace refitted
    import laps as lapmod

    for gd in out:
        try:
            rec = lapmod.reconcile(archived, read_json, write_json, gd)
            if rec:
                out[gd] = rec
                print(f"  R{gd}: lap records checked against FastF1 {rec['race'].get('lapCheck')}")
        except Exception as e:  # noqa: BLE001
            _warn(f"lap check for gameday {gd}", e)
    return out


# ---------------------------------------------------------------- weather forecast


def weather(get_soft, cached, races, now, keep=None):
    """Rain probability (max hourly %) over qualifying and the race for each coming race Open-Meteo can forecast
    (16 days), and from the ECMWF ensemble the share of members wet in each session and in qualifying and the race
    together (`ens`, collect.py). keep(g, forecast, ensemble) archives the vintage. races: [{gd, lat, lon,
    sessions: [{type, start}]}]."""
    import collect

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
        got = {}
        try:
            d = get_soft(url, cached(f"wx_{g['gd']}.json"), meta=got)
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

        # at = when this forecast was fetched (a cached copy keeps its own time), checked = this attempt
        rec = {"at": got.get("at") or now.isoformat(timespec="minutes"), "checked": now.isoformat(timespec="minutes")}
        for typ, key, h in (("Qualifying", "q", 1), ("Sprint", "s", 1), ("Race", "r", 2)):
            if typ in starts:
                rec[key] = window(starts[typ], h)
        ens = None
        got_e = {}
        try:
            ens = collect.ensemble_sessions(collect.ensemble(get_soft, cached, g, meta=got_e), g)
        except Exception as e:  # noqa: BLE001
            _warn(f"weather ensemble for gameday {g['gd']}", e)
        if ens:
            p = ens["p"]
            rec["ens"] = {
                "q": p.get("Qualifying"),
                "s": p.get("Sprint Qualifying", p.get("Sprint")),
                "r": p.get("Race"),
                "qr": ens.get("pQR"),
                "n": ens["n"],
                "at": got_e.get("at"),
            }
        if keep:
            try:
                keep(g, d, ens, rec["at"])
            except Exception as e:  # noqa: BLE001
                _warn(f"weather archive for gameday {g['gd']}", e)
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


def _norm(raw, total, field=22):
    """Mid prices -> probabilities that add up to the number of drivers the market pays (removes the overround).
    A book without every driver (a podium market listing 12-18 of 22 was seen) can't hand all the places to the
    listed ones: each missing driver is counted at half the longest listed price, and its share is left out."""
    s = sum(raw.values())
    if s <= 0:
        return {}
    missing = max(0, field - len(raw)) * min(raw.values()) / 2
    return {k: round(min(0.995, v * total / (s + missing)), 4) for k, v in raw.items()}


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


def _spread(m):
    try:
        b, a = float(m.get("yes_bid_dollars") or 0), float(m.get("yes_ask_dollars") or 0)
    except ValueError:
        return None
    return round(a - b, 4) if a > 0 and b > 0 and a >= b else None


def odds(get_soft, cached, name, season, tlas, field=22, keep=None):
    """Market probabilities for the next race: {win, podium, top10, pole: {TLA: p}} (only drivers we know)."""
    try:
        suffix = kalshi_suffix(_kalshi_events(get_soft, cached), name, season)
    except Exception as e:  # noqa: BLE001
        _warn("Kalshi events", e)
        return None
    if not suffix:
        return None
    import collect

    out = {"event": suffix}
    books = {}
    got = {}
    for key, (series, total) in KALSHI_SERIES.items():
        got[key] = {}
        try:
            d = get_soft(
                f"{KALSHI}/markets?event_ticker={series}-{suffix}&limit=60",
                cached(f"k_{series}_{suffix}.json"),
                meta=got[key],
            )
        except Exception as e:  # noqa: BLE001
            _warn(f"Kalshi {series}", e)
            continue
        raw, spread = {}, {}
        for m in d.get("markets") or []:
            tla = m["ticker"].rsplit("-", 1)[-1]
            p = _mid(m)
            if tla in tlas and p is not None:
                raw[tla] = p
                sp = _spread(m)
                if sp is not None:
                    spread[tla] = sp
            if tla in tlas:
                books.setdefault(key, {})[tla] = collect.quote_row(m)
        if len(raw) >= 10:
            out[key] = _norm(raw, total, field)
            # bid-ask spread per line (dollars, before de-vigging): how sure the market is of it (SIM.oddsQuality)
            if spread:
                out.setdefault("spread", {})[key] = spread
    # when each book was fetched (a cached copy after a failed request keeps its own time); at = the oldest, which
    # decides what the market can have known (engine.js oddsKnown: the qualifying order only if at is after it)
    used = [k for k in KALSHI_SERIES if k in out and k != "spread"]
    out["asOf"] = {k: got[k].get("at") for k in used}
    stale = [k for k in used if not got[k].get("fresh")]
    if stale:
        out["stale"] = stale
    times = [t for t in out["asOf"].values() if t]
    if times:
        out["at"] = min(times, key=_dt)
    fresh = {k: v for k, v in books.items() if got.get(k, {}).get("fresh")}
    if keep and fresh:
        try:
            keep(suffix, fresh)
        except Exception as e:  # noqa: BLE001
            _warn("Kalshi quotes archive", e)
    return out if used else None


# ---------------------------------------------------------------- the coming weekend


PEN = re.compile(r"CAR (\d+) \([A-Z]{3}\).*?(\d+) PLACE GRID PENALTY")
BACK = re.compile(r"CAR (\d+) \([A-Z]{3}\).*?(BACK OF THE GRID|PIT ?LANE)")


def grid_penalties(rc, num2, before=None):
    """Race control's grid penalties: ({TLA: places, 99 = back of the grid / pit lane}, {TLA: when announced (the
    latest message)}). before (datetime): only messages before then (what was known at lock, for the backtest)."""
    pen, at = {}, {}
    for m in rc or []:
        msg = (m.get("message") or "").upper()
        if "GRID" not in msg and "PIT LANE" not in msg and "PITLANE" not in msg:
            continue
        if before and m.get("date") and _dt(m["date"]) >= before:
            continue
        p, b = PEN.search(msg), BACK.search(msg)
        t = num2.get(int((p or b).group(1))) if p or b else None
        if not t:
            continue
        pen[t] = pen.get(t, 0) + int(p.group(2)) if p else 99
        # a market quoted before the announcement didn't know it
        if m.get("date"):
            at[t] = max(at.get(t, ""), m["date"])
    return pen, at


def session_flags(res, num2, key):
    """Who a finished session's classification leaves without points, until F1 Fantasy has scored it: in qualifying
    ("q", "sq") no time in any segment ("notime") or disqualified; in a sprint or race, disqualified, didn't start,
    or not classified: under 90% of the winner's laps (FIA rule; OpenF1's `dnf` means only "didn't finish", and a
    car can retire and still classify). A car without a position isn't in the order at all (the sim retires it)."""
    flags = {}
    if key in ("q", "sq"):
        for r in res:
            t = num2.get(r.get("driver_number"))
            d = r.get("duration")
            times = [x for x in (d if isinstance(d, list) else [d]) if x]
            f = "dsq" if r.get("dsq") else "notime" if r.get("dns") or not times else None
            if t and f:
                flags[t] = f
        return flags
    lead = max((r.get("number_of_laps") or 0 for r in res), default=0)
    need = math.floor(0.9 * lead)
    for r in res:
        t = num2.get(r.get("driver_number"))
        if not t:
            continue
        if r.get("dsq"):
            flags[t] = "dsq"
        elif r.get("dns"):
            flags[t] = "dns"
        elif r.get("position") and (r.get("number_of_laps") or 0) < need:
            flags[t] = "dnf"
    return flags


def fastest_lap(laps, num2):
    """The TLA with the session's fastest lap (OpenF1 laps), or None."""
    best = min((x for x in laps or [] if x.get("lap_duration")), key=lambda x: x["lap_duration"], default=None)
    return best and num2.get(best.get("driver_number"))


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
        out["penalties"], pen_at = grid_penalties(rc, num2)
        if pen_at:
            out["penAt"] = pen_at
        # the official race grid once published (penalties and pit-lane starts applied): what the race starts from
        rs = race if race and _dt(race["date_start"]) - timedelta(hours=2) <= now else None
        if rs:
            sg = get_soft(
                f"{OPENF1}/starting_grid?session_key={rs['session_key']}", cached(f"of_grid_{rs['session_key']}.json")
            )
            rows = sorted((r for r in sg or [] if r.get("position")), key=lambda r: r["position"])
            order = [num2.get(r["driver_number"]) for r in rows]
            if len(order) >= 10 and all(order):
                out["grid"]["race"] = order
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
                flags = session_flags(res or [], num2, key)
                if flags:
                    out.setdefault("status", {})[key] = flags
                if key == "s":
                    # refetched each time (not _of's cache-for-good): the first laps may land before the rest
                    laps = get_soft(
                        f"{OPENF1}/laps?session_key={s['session_key']}", cached(f"of_laps_live_{s['session_key']}.json")
                    )
                    fl = fastest_lap(laps if isinstance(laps, list) else [], num2)
                    if fl:
                        out.setdefault("fl", {})["s"] = fl
    except Exception as e:  # noqa: BLE001
        _warn("OpenF1 weekend", e)
    return out
