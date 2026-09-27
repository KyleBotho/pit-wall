"""Data health: what refresh.py checks after each build, for Settings > Admin > Data health and the "Data health"
GitHub issue (the workflow's health job opens it, comments when the list changes, closes it when all is clear).

Two kinds of item:
  problems  conditions that hold until fixed: results missing hours after a race, points not certified, practice
            laps missing, no projection frozen at lock, an unknown scoring event, league history not updated...
  notices   mid-season oddities seen when this build is compared with the previous one: a new driver card, a card
            going inactive, a driver changing team, a round's sessions or circuit changing. Kept for NOTICE_DAYS.

Public data only: the page embeds the result and the issue is public, so no league or personal data goes in here.
"""

from datetime import datetime, timedelta

NOTICE_DAYS = 3
H = timedelta(hours=1)


def _iso(t):
    return datetime.fromisoformat(t)


def _end(g, kind):
    s = next((s for s in g["sessions"] if s["type"] == kind), None)
    return _iso(s.get("end") or s["start"]) if s else None


def problems(data, now):
    """[(id, level, message)] for conditions that are wrong right now. level: "error" (the site shows wrong or
    missing numbers) or "warn" (worth a look)."""
    out = []
    sched = {g["gd"]: g for g in data.get("schedule") or []}
    done, nxt = data.get("done") or [], data.get("next")
    res = data.get("results") or {}
    name = lambda g: f"R{g['gd']} {g.get('name', '')}".strip()  # noqa: E731

    for gd in done[-2:]:  # the last two rounds: older ones were checked when they were recent
        g = sched[gd]
        race, quali = _end(g, "Race"), _end(g, "Qualifying")
        if race and now > race + 3 * H and str(gd) not in res.get("race", {}):
            out.append((f"results:{gd}", "error", f"{name(g)}: no race results from Jolpica 3 h after the race."))
        if quali and now > quali + 6 * H and str(gd) not in res.get("quali", {}):
            out.append((f"quali:{gd}", "warn", f"{name(g)}: no qualifying results from Jolpica."))
        rows = res.get("race", {}).get(str(gd)) or []
        if race and now > race + 12 * H and any(r.get("gridFromQuali") for r in rows):
            out.append(
                (
                    f"grid:{gd}",
                    "warn",
                    f"{name(g)}: Jolpica still has no starting grid; the qualifying order stands in.",
                )
            )
    if done:
        g = sched[done[-1]]
        race = _end(g, "Race")
        if race and now > race + 12 * H and g.get("certified") is False:
            out.append(
                (
                    f"certified:{g['gd']}",
                    "warn",
                    f"{name(g)}: F1 Fantasy hasn't certified the points 12 h after the race.",
                )
            )
        if race and now > race + 24 * H and data.get("pricesPending"):
            out.append(
                (
                    f"prices:{nxt}",
                    "warn",
                    f"The player feed for R{nxt} is still empty a day after the race: prices are last round's.",
                )
            )
        if race and now > race + 6 * H and str(g["gd"]) not in (data.get("raceInfo") or {}):
            out.append(
                (f"raceinfo:{g['gd']}", "warn", f"{name(g)}: no OpenF1 race data (safety cars, rain, race pace).")
            )
        # review batch 3: the lap records' pace model and retirement causes (laps.py, retried for 4 days)
        rb = ((data.get("raceInfo") or {}).get(str(g["gd"])) or {}).get("race") or {}
        if race and now > race + 24 * H and rb and ("paceCtx" not in rb or "retirements" not in rb):
            out.append(
                (
                    f"laps:{g['gd']}",
                    "warn",
                    f"{name(g)}: no lap-model pace or retirement causes a day after the race (OpenF1 stints or "
                    "Jolpica's classification missing).",
                )
            )
        # second review: lap records checked against FastF1 once telemetry.py has the round (laps.reconcile)
        chk = rb.get("lapCheck")
        if chk and not chk.get("ok"):
            out.append(
                (
                    f"lapcheck:{g['gd']}",
                    "warn",
                    f"{name(g)}: OpenF1's lap times match FastF1's for only {chk.get('agree', 0):.0%} of laps under "
                    "any lap numbering: no lap-model pace for this race.",
                )
            )
        hist = [h["gd"] for h in (data.get("elite") or {}).get("history") or [] if not h.get("est")]
        if race and now > race + 24 * H and hist and max(hist) < g["gd"]:
            out.append(
                (
                    f"elite:{g['gd']}",
                    "warn",
                    f"Global and league history stop at R{max(hist)}: the private league workflow may be failing.",
                )
            )
    if nxt and nxt in sched:
        g = sched[nxt]
        for p in data.get("practice") or []:
            if not p.get("done") and now > _iso(p["start"]) + 4 * H:
                out.append(
                    (f"practice:{nxt}:{p['name']}", "warn", f"{name(g)}: no {p['name']} laps 3 h after the session.")
                )
        lock = _iso(g["lock"])
        if now > lock + H and str(nxt) not in (data.get("projHist") or {}):
            out.append((f"projection:{nxt}", "error", f"{name(g)}: no projection was frozen at lock."))
        start = _iso(g["raceStart"]) if g.get("raceStart") else None
        wx = (data.get("weather") or {}).get(str(nxt))
        if start and now > start - timedelta(days=10) and wx is None:
            out.append((f"weather:{nxt}", "warn", f"{name(g)}: no rain forecast from Open-Meteo."))
        elif start and now > start - timedelta(days=10) and not wx.get("ens"):
            out.append(
                (
                    f"ensemble:{nxt}",
                    "warn",
                    f"{name(g)}: no ensemble forecast (weather sessions linked at the default).",
                )
            )
    for e in data.get("evNames") or []:
        if e["c"].endswith("OTH") or e["c"].startswith("?"):
            out.append(
                (
                    f"event:{e['s']}:{e['n']}",
                    "warn",
                    f"Unknown scoring event '{e['n'].strip()}' ({e['s']}): scored, but not in any category. "
                    "Add a rule to config/feeds.json.",
                )
            )
    return out


def notices(data, prev):
    """[(id, message)]: what changed since the previous build that a person should know about."""
    if not prev:
        return []
    out = []
    was = {a["id"]: a for a in prev.get("assets") or []}
    for a in data.get("assets") or []:
        p = was.get(a["id"])
        who = f"{a['name']} ({a['team']})" if a["kind"] == "D" else a["name"]
        if p is None:
            out.append((f"card:new:{a['id']}", f"New card: {who}, ${a['price']}m."))
            continue
        if p.get("active") != a.get("active"):
            state = "active again" if a.get("active") else "inactive (a stand-in or a driver out?)"
            out.append((f"card:active:{a['id']}:{a.get('active')}", f"{who} is now {state}."))
        if a["kind"] == "D" and p.get("team") != a.get("team"):
            out.append((f"card:team:{a['id']}:{a['team']}", f"{a['name']} moved from {p.get('team')} to {a['team']}."))
    old = {g["gd"]: g for g in prev.get("schedule") or []}
    for g in data.get("schedule") or []:
        o = old.get(g["gd"])
        if o is None:
            out.append((f"round:new:{g['gd']}", f"New round in the schedule: R{g['gd']} {g.get('name', '')}."))
            continue
        if g.get("done") or g["gd"] in (data.get("done") or []):
            continue
        a = {s["type"]: s["start"] for s in g["sessions"]}
        b = {s["type"]: s["start"] for s in o["sessions"]}
        for kind in sorted(set(a) | set(b)):
            if (kind in a) != (kind in b) or (kind in a and _iso(a[kind]) != _iso(b[kind])):
                what = (
                    f"{kind} moved from {b[kind]} to {a[kind]}"
                    if kind in a and kind in b
                    else (f"{kind} added ({a[kind]})" if kind in a else f"{kind} removed")
                )
                out.append((f"round:{g['gd']}:{kind}:{a.get(kind)}", f"R{g['gd']} {g.get('name', '')}: {what}."))
        if o.get("circuit") and g.get("circuit") and o["circuit"] != g["circuit"]:
            out.append(
                (
                    f"round:{g['gd']}:circuit:{g['circuit']}",
                    f"R{g['gd']} {g.get('name', '')} moved from circuit {o['circuit']} to {g['circuit']}.",
                )
            )
    gone = set(old) - {g["gd"] for g in data.get("schedule") or []}
    out += [
        (f"round:gone:{gd}", f"R{gd} {old[gd].get('name', '')} is no longer in the schedule.") for gd in sorted(gone)
    ]
    return out


def check(data, prev, log, now):
    """-> (health for the page and the workflow, the updated log). log = {"since": {id: first seen},
    "notices": {id: {"msg", "first"}}}, kept in history/<season>/health.json so first-seen times survive builds."""
    log = {"since": dict((log or {}).get("since") or {}), "notices": dict((log or {}).get("notices") or {})}
    stamp = now.isoformat(timespec="minutes")
    items = []
    probs = problems(data, now)
    log["since"] = {i: log["since"].get(i, stamp) for i, _, _ in probs}
    items += [{"id": i, "level": lv, "msg": m, "since": log["since"][i]} for i, lv, m in probs]
    for i, m in notices(data, prev):
        log["notices"].setdefault(i, {"msg": m, "first": stamp})
    cutoff = now - timedelta(days=NOTICE_DAYS)
    log["notices"] = {i: n for i, n in log["notices"].items() if _iso(n["first"]) >= cutoff}
    items += [
        {"id": i, "level": "notice", "msg": n["msg"], "since": n["first"]}
        for i, n in sorted(log["notices"].items(), key=lambda kv: kv[1]["first"])
    ]
    return {"generated": stamp, "items": items}, log
