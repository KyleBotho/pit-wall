"""Data collected as it happens, for models that can only be tested later (independent review batch 4, 2026-09-27;
the user: "collecting data so long can not hurt"). Every piece is archived with the time we saw it, so a backtest
can replay what was known before a lock instead of what was known after. All fail-soft: refresh.py never stops on
these.

  history/<season>/weather/gdNN.json   every Open-Meteo forecast for the race weekend as fetched (hourly rain
                                       probability and amount around each session) and the ECMWF ensemble's
                                       per-member rain per session (51 members): forecast vintages
  history/<season>/quotes/gdNN.json    every Kalshi quote seen for the next race: bid, ask, last, volume, open
                                       interest per driver and market (the de-vigged odds are in odds/)
  history/<season>/fia/<event>.json    the FIA's decision documents index (title, PDF, published, first seen):
                                       starting grids, penalties, power-unit elements, the Pirelli preview
"""

import json
import re
from datetime import datetime, timedelta, timezone

WET_MM = 0.5  # hand-set: an ensemble member is "wet" in a session with this much rain in its window (mm)
FIA_URL = "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14"


def _dt(s):
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _append(path, read_json, write_json, head, entry, key="vintages", same=None):
    """Append entry to path's list (created with head), unless it equals the last one on `same` (a function)."""
    import os

    rec = read_json(path) if os.path.exists(path) else dict(head)
    lst = rec.setdefault(key, [])
    if lst and same and same(lst[-1]) == same(entry):
        return False
    lst.append(entry)
    write_json(path, rec, separators=(",", ":"))
    return True


# ---------------------------------------------------------------- weather


SESSION_HOURS = {"Sprint Qualifying": 1, "Qualifying": 1, "Sprint": 1, "Race": 2}


def windows(g):
    """{session type: (start - 1 h, end)} for the weekend's scored sessions."""
    out = {}
    for s in g.get("sessions") or []:
        h = SESSION_HOURS.get(s["type"])
        if h:
            t = _dt(s["start"])
            out[s["type"]] = (t - timedelta(hours=1), t + timedelta(hours=h))
    return out


def forecast_slice(d, g):
    """The forecast's hourly rain probability and amount inside the weekend's session windows."""
    h = d.get("hourly") or {}
    ws = windows(g)
    rows = []
    for i, t in enumerate(h.get("time") or []):
        tt = _dt(t)
        if any(a <= tt <= b for a, b in ws.values()):
            rows.append([t, (h.get("precipitation_probability") or [None])[i], (h.get("precipitation") or [None])[i]])
    return rows


def ensemble_sessions(d, g):
    """Per session, each ensemble member's rain (mm) in the window; and the wet shares: per session, and jointly
    for qualifying and the race (the dependence the sim's weather draw needs)."""
    h = d.get("hourly") or {}
    members = sorted(k for k in h if k.startswith("precipitation"))
    if not members:
        return None
    times = [_dt(t) for t in h.get("time") or []]
    per = {}
    for typ, (a, b) in windows(g).items():
        idx = [i for i, t in enumerate(times) if a <= t <= b]
        if idx:
            per[typ] = [round(sum(h[m][i] or 0 for i in idx), 2) for m in members]
    if not per:
        return None
    wet = {typ: [v >= WET_MM for v in mm] for typ, mm in per.items()}
    n = len(members)
    out = {"n": n, "wetMm": WET_MM, "mm": per, "p": {typ: round(sum(w) / n, 3) for typ, w in wet.items()}}
    if "Qualifying" in wet and "Race" in wet:
        out["pQR"] = round(sum(q and r for q, r in zip(wet["Qualifying"], wet["Race"], strict=False)) / n, 3)
    return out


def ensemble(get_soft, cached, g, meta=None):
    """ECMWF IFS ensemble rain for the race weekend (Open-Meteo, no key), or None. meta: as f1feeds.get_soft."""
    url = (
        "https://ensemble-api.open-meteo.com/v1/ensemble?latitude={:.3f}&longitude={:.3f}"
        "&hourly=precipitation&models=ecmwf_ifs025&forecast_days=15&timezone=UTC"
    ).format(g["lat"], g["lon"])
    return get_soft(url, cached(f"wxe_{g['gd']}.json"), meta=meta)


def weather_vintage(archived, read_json, write_json, g, forecast, ens, now, at=None):
    """Keep this forecast (and ensemble) for the weekend unless it's the same as the last one kept. at: when the
    forecast was fetched (a cached copy's own time), else now."""
    entry = {"at": at or now.isoformat(timespec="minutes"), "hourly": forecast_slice(forecast or {}, g)}
    if ens:
        entry["ensemble"] = ens
    return _append(
        archived("weather", f"gd{g['gd']:02d}.json"),
        read_json,
        write_json,
        {"gd": g["gd"], "lat": g.get("lat"), "lon": g.get("lon"), "sessions": g.get("sessions")},
        entry,
        same=lambda e: json.dumps([e.get("hourly"), (e.get("ensemble") or {}).get("mm")]),
    )


# ---------------------------------------------------------------- market quotes


def quote_row(m):
    """One Kalshi market's quote: [bid, ask, last, volume, open interest] (dollars / contracts)."""

    def f(k):
        try:
            v = m.get(k)
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    return [f("yes_bid_dollars"), f("yes_ask_dollars"), f("last_price_dollars"), f("volume"), f("open_interest")]


def quotes_vintage(archived, read_json, write_json, gd, event, books, now):
    """books: {market key: {TLA: quote_row}}. Kept unless unchanged since the last one."""
    if not books:
        return False
    return _append(
        archived("quotes", f"gd{gd:02d}.json"),
        read_json,
        write_json,
        {"gd": gd, "event": event, "cols": ["bid", "ask", "last", "volume", "openInterest"]},
        {"at": now.isoformat(timespec="minutes"), "books": books},
        same=lambda e: json.dumps(e["books"], sort_keys=True),
    )


# ---------------------------------------------------------------- FIA documents


ROW = re.compile(
    r'href="(?P<url>/system/files/decision-document/(?P<file>[^"]+\.pdf))".*?<div class="title">\s*(?P<title>.*?)\s*'
    r'</div>.*?date-display-single">(?P<pub>[^<]+)</span>\s*(?P<tz>[A-Z]+)',
    re.S,
)


def _paris_summer(t):
    """EU summer time: from the last Sunday of March to the last Sunday of October (local date)."""

    def last_sunday(month):
        d = datetime(t.year, month, 31)
        return d - timedelta(days=(d.weekday() + 1) % 7)

    return last_sunday(3) <= t < last_sunday(10)


def parse_fia(html):
    """The document rows of an FIA documents page: [{event slug, doc, title, url, published}]."""
    out = []
    for m in ROW.finditer(html):
        file = m.group("file")
        slug = re.sub(r"_-_.*$", "", file)
        doc = re.match(r"Doc (\d+)", m.group("title"))
        pub = m.group("pub").strip()
        try:
            # "26.09.26 15:17 CET": Paris local time whatever the label says (Baku's provisional classification,
            # "15:10 CET", came 30 minutes after the 12:41 UTC chequered flag: CEST)
            t = datetime.strptime(pub, "%d.%m.%y %H:%M")
            pub = (t - timedelta(hours=2 if _paris_summer(t) else 1)).replace(tzinfo=timezone.utc)
            pub = pub.isoformat(timespec="minutes")
        except ValueError:
            pass
        out.append(
            {
                "event": slug,
                "doc": int(doc.group(1)) if doc else None,
                "title": re.sub(r"\s+", " ", m.group("title")),
                "url": "https://www.fia.com" + m.group("url"),
                "published": pub,
            }
        )
    return out


def fia_documents(read_text, archived, read_json, write_json, now):
    """The FIA's current event's documents (its landing page), merged into history/<season>/fia/<event>.json with
    the time each was first seen. Returns how many were new."""
    import os

    rows = parse_fia(read_text(FIA_URL))
    new = 0
    for slug in sorted({r["event"] for r in rows}):
        path = archived("fia", f"{slug}.json")
        rec = read_json(path) if os.path.exists(path) else {"event": slug, "docs": []}
        seen = {d["url"] for d in rec["docs"]}
        for r in rows:
            if r["event"] == slug and r["url"] not in seen:
                rec["docs"].append(
                    {k: v for k, v in r.items() if k != "event"} | {"firstSeen": now.isoformat(timespec="minutes")}
                )
                new += 1
        rec["docs"].sort(key=lambda d: d.get("doc") or 0)
        write_json(path, rec, indent=1)
    return new
