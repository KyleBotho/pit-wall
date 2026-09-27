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

import html
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


def parse_fia(page):
    """The document rows of an FIA documents page: [{event slug, doc, title, url, published}]."""
    out = []
    for m in ROW.finditer(page):
        file = m.group("file")
        slug = re.sub(r"_-_.*$", "", file)
        # past events' pages wrap the title in nested field divs
        title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group("title")))).strip()
        doc = re.match(r"Doc (\d+)", title)
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
                "title": title,
                "url": "https://www.fia.com" + m.group("url"),
                "published": pub,
            }
        )
    return out


PEN_TITLE = re.compile(r"(?:Infringement|Decision|Offence) - Car (\d+)\b", re.I)
DROP = re.compile(r"drop of (\d+) grid (?:positions?|places?)|(\d+)[ -](?:grid )?places? grid penalty", re.I)
BACK_OF_GRID = re.compile(r"back of the (?:starting )?grid|from the pit ?lane", re.I)


def parse_decision(text):
    """A stewards' decision (PDF text) -> grid places for the next race: the drop, 99 = back of the grid / pit lane,
    0 = no grid penalty (a reprimand, a fine, a time penalty) or one for a sprint only."""
    t = re.sub(r"\s+", " ", text)
    i = t.find("Decision")
    dec = t[i : i + 400] if i >= 0 else t[:400]
    j = dec.find("Reason")
    dec = dec[:j] if j > 0 else dec
    if re.search(r"\bsprint\b", dec, re.I) and not re.search(r"\bnext race\b", dec, re.I):
        return 0
    if BACK_OF_GRID.search(dec):
        return 99
    m = DROP.search(dec)
    return int(m.group(1) or m.group(2)) if m else 0


def pdf_text(data):
    """The text of a PDF (bytes), or None without pypdf."""
    try:
        import io

        import pypdf
    except ImportError:
        return None
    return "\n".join(p.extract_text() or "" for p in pypdf.PdfReader(io.BytesIO(data)).pages)


def fia_penalties(archived, read_json, write_json, slug, read_bytes, most=8):
    """The event's grid penalties from the stewards' decisions: each car-infringement document's PDF read once (at
    most `most` a run; the result kept in the index as `grid`) -> ({car number: places}, {car number: published, the
    latest}, {car number: [[places, published], ...] each decision}). Several decisions add up (the FIA's
    "accumulation"); 99 (back of the grid) wins."""
    import os

    path = archived("fia", f"{slug}.json")
    if not os.path.exists(path):
        return {}, {}, {}
    rec = read_json(path)
    fetched = 0
    for d in rec["docs"]:
        if "grid" in d or not PEN_TITLE.search(d.get("title") or ""):
            continue
        if fetched >= most:
            break
        text = pdf_text(read_bytes(d["url"]))
        fetched += 1
        if text is None:
            break
        d["grid"] = parse_decision(text)
    if fetched:
        write_json(path, rec, indent=1)
    pen, at, parts = {}, {}, {}
    for d in rec["docs"]:
        m = PEN_TITLE.search(d.get("title") or "")
        if not m or not d.get("grid"):
            continue
        car = int(m.group(1))
        pen[car] = 99 if d["grid"] >= 99 or pen.get(car) == 99 else pen.get(car, 0) + d["grid"]
        at[car] = max(at.get(car, ""), d.get("published") or "")
        parts.setdefault(car, []).append([d["grid"], d.get("published")])
    return pen, at, parts


def event_slug(name, season):
    """The FIA's event slug for a meeting name: "Azerbaijan Grand Prix" -> "2026_azerbaijan_grand_prix"."""
    return f"{season}_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def fia_documents(read_text, archived, read_json, write_json, now):
    """The FIA's current event's documents (its landing page), merged into history/<season>/fia/<event>.json with
    the time each was first seen. Returns how many were new."""
    return merge_fia(parse_fia(read_text(FIA_URL)), archived, read_json, write_json, now)


def merge_fia(rows, archived, read_json, write_json, now, backfill=False):
    """Document rows merged into each event's index. A backfill (past events' pages, read later) says so instead of
    claiming a first-seen time: only `published` tells when those were known."""
    import os

    new = 0
    for slug in sorted({r["event"] for r in rows}):
        path = archived("fia", f"{slug}.json")
        rec = read_json(path) if os.path.exists(path) else {"event": slug, "docs": []}
        seen = {d["url"] for d in rec["docs"]}
        stamp = (
            {"backfill": now.isoformat(timespec="minutes")}
            if backfill
            else {"firstSeen": now.isoformat(timespec="minutes")}
        )
        for r in rows:
            if r["event"] == slug and r["url"] not in seen:
                rec["docs"].append({k: v for k, v in r.items() if k != "event"} | stamp)
                new += 1
        rec["docs"].sort(key=lambda d: d.get("doc") or 0)
        write_json(path, rec, indent=1)
    return new


# ---------------------------------------------------------------- FIA technical documents

# Read once each, their text kept (history/<season>/fia/text/<event>/<file>.txt, ~25 KB an event; the PDFs
# themselves are 0.1-2.5 MB) and a summary parsed into the event's index as `tech`. For models that can only be
# tried later (power-unit age, upgrades, parc-fermé work, the tyre allocation); nothing uses them yet.
TECH = {
    "puUsed": re.compile(r"PU elements used per driver", re.I),
    "puNew": re.compile(r"New PU elements", re.I),
    "upgrades": re.compile(r"Car Presentation Submissions", re.I),
    "parcFerme": re.compile(r"Parc Ferm", re.I),
    "tyres": re.compile(r"Pirelli Preview", re.I),
}
PU_ELEMENTS = ["ICE", "TC", "EXH", "MGU-K", "ES", "PU-CE", "PU-ANC"]  # the "used up to now" table's columns


def tech_kind(title):
    return next((k for k, rx in TECH.items() if rx.search(title or "")), None)


def parse_pu_used(text):
    """ "PU elements used per driver up to now" -> {car number: {element: count}} (the season so far)."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\d{1,2})\s+\D.*?((?:\s\d+){7})\s*$", line)
        if m:
            out[int(m.group(1))] = dict(zip(PU_ELEMENTS, (int(n) for n in m.group(2).split()), strict=True))
    return out


def parse_pu_new(text):
    """ "New PU elements for this Competition" -> {car number: {element: how many of it the car had used before}}."""
    out = {}
    parts = re.split(r"with an? new [^()]+?\(([A-Z][A-Z\-]*)\)\s*:", text)
    for el, body in zip(parts[1::2], parts[2::2], strict=True):
        for line in body.splitlines():
            m = re.match(r"\s*(\d{1,2})\s+\D.*\s(\d+)\s*$", line)
            if m:
                out.setdefault(int(m.group(1)), {})[el] = int(m.group(2))
    return out


def team_code(name, teams):
    """A team's code from any of its names ("Oracle Red Bull Racing" -> RED): the longest config name inside it."""
    low = (name or "").lower()
    hits = [k for k in teams if not k.startswith("_") and k.lower() in low]
    return teams[max(hits, key=len)]["code"] if hits else None


def parse_upgrades(text, teams):
    """ "Car Presentation Submissions" -> {team code (or the name as printed): {"n": updated components, "reasons":
    {Performance / Circuit specific / Reliability: n}}}; a team with no updates gets n 0."""
    out = {}
    for block in re.split(r"Car Presentation\s*[–-]", text)[1:]:
        lines = [x.strip() for x in block.splitlines() if x.strip()]
        if len(lines) < 2:
            continue
        name = lines[1]
        # the items are numbered 1, 2, ...; a wrapped line can put a number mid-line ("... effectively. 3 Front")
        n, pos = 0, block.find(name) + len(name)
        while m := re.compile(rf"(?:^|\s){n + 1}\s+[A-Z]").search(block, pos):
            n, pos = n + 1, m.end()
        reasons = {}
        for r in re.findall(r"\b(Performance|Circuit specific|Reliability)\b", block):
            reasons[r] = reasons.get(r, 0) + 1
        out[team_code(name, teams) or name] = {"n": n, "reasons": reasons}
    return out


def parse_parc_ferme(text):
    """ "Parts and parameters replaced ... during Parc Fermé" -> {car number: [part, ...]}. Items are the car line's
    rest and the indented lines after it; a page break's header lines aren't indented."""
    out, car = {}, None
    for line in text.splitlines():
        m = re.match(r"\s*Car (\d{1,2})\s*:\s*(.*)$", line)
        if m:
            car = int(m.group(1))
            out[car] = [m.group(2).strip()] if m.group(2).strip() else []
        elif car is not None and line.strip() and line[:1].isspace() and not line.strip().endswith(":"):
            out[car].append(line.strip())
        elif line.strip():
            car = None
    return {c: v for c, v in out.items() if v}


def parse_tyres(text):
    """The Pirelli preview -> {"compounds": [C.., ...], "q3": C.., "race": [C.., C..]} as far as it says."""
    t = re.sub(r"\s+", " ", text)
    out = {}
    m = re.search(r"Compound((?: C\d){3})", t)
    if m:
        out["compounds"] = sorted(m.group(1).split())
    m = re.search(r"Q3 tyre (C\d)", t)
    if m:
        out["q3"] = m.group(1)
    m = re.search(r"Mandatory race tyres((?: C\d){1,3})", t)
    if m:
        out["race"] = sorted(m.group(1).split())
    return out


def tech_summary(kind, text, teams):
    text = text.replace("\xa0", " ")  # some PDFs space with no-break spaces
    if kind == "puUsed":
        return parse_pu_used(text)
    if kind == "puNew":
        return parse_pu_new(text)
    if kind == "upgrades":
        return parse_upgrades(text, teams)
    if kind == "parcFerme":
        return parse_parc_ferme(text)
    return parse_tyres(text)


def fia_tech(archived, read_json, write_json, read_bytes, teams, most=6):
    """Every archived event's technical documents not read yet (at most `most` PDFs a run, oldest event first): the
    text kept, `read` set on the document, and the event's `tech` rebuilt from all its texts (the latest document
    of a kind wins; new PU elements add up over the weekend). Returns how many were read."""
    import glob
    import os

    fetched = 0
    for path in sorted(glob.glob(archived("fia", "*.json"))):
        rec = read_json(path)
        slug = rec.get("event") or os.path.basename(path)[:-5]
        changed = False
        for d in rec["docs"]:
            kind = tech_kind(d.get("title"))
            if not kind or d.get("read"):
                continue
            if fetched >= most:
                break
            text = pdf_text(read_bytes(d["url"]))
            fetched += 1
            if text is None:
                return fetched
            out = archived("fia", "text", slug, os.path.basename(d["url"])[:-4] + ".txt")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                f.write(text)
            d["read"] = kind
            changed = True
        if changed or ("tech" not in rec and any(d.get("read") for d in rec["docs"])):
            rec["tech"] = event_tech(rec, slug, archived, teams)
            write_json(path, rec, indent=1)
    return fetched


def event_tech(rec, slug, archived, teams):
    """An event's `tech` from its kept texts, in document order."""
    import os

    tech = {}
    for d in sorted(rec["docs"], key=lambda d: (d.get("published") or "", d.get("doc") or 0)):
        kind = d.get("read")
        path = archived("fia", "text", slug, os.path.basename(d["url"])[:-4] + ".txt") if kind else None
        if not path or not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            s = tech_summary(kind, f.read(), teams)
        if kind == "puNew":
            acc = tech.setdefault("puNew", {})
            for car, els in s.items():
                acc.setdefault(str(car), {}).update(els)
        elif kind == "parcFerme":
            acc = tech.setdefault("parcFerme", {})
            for car, parts in s.items():
                acc.setdefault(str(car), []).extend(parts)
        elif s:
            tech[kind] = {str(k): v for k, v in s.items()} if kind != "tyres" else s
    return tech
