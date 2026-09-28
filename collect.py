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
        try:
            text = pdf_text(read_bytes(d["url"]))
        except OSError as e:  # the FIA site is slow and times out: keep what's read, the rest next run
            print(f"  ! FIA decision {d['url']}: {e}")
            break
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


CORRECTED = re.compile(r"\b(?:corrected|revised|amended)\b", re.I)


def grid_ledger(schedule, docs_of, num_of, raced=None):
    """Every grid penalty the stewards have handed out this season, each with the race it's for (fifth review: a
    decision was reduced to a number for its own event, so one "for the next race" was lost):
    [{car, tla, places, issued (gd), target (gd), published, doc, title}].
    target: the issuing event's own race when the decision was published before that race started, else the next
    race (a penalty handed out after a race can only be served later: the stewards' "next race in which the driver
    participates"); a driver who didn't race there (raced(gd, tla) false, for rounds already run) carries it on.
    A "Corrected" / "Revised" decision replaces the last one for that car at that event (with no grid penalty, it
    removes it). docs_of(g) = the event's FIA document index (docs with `grid` as read by fia_penalties) or None;
    num_of(gd) = {car number: TLA} from that round's classification (else an earlier round's). Sprint-only penalties
    are 0 in parse_decision and aren't listed."""
    from datetime import datetime

    order = [g["gd"] for g in schedule]
    start = {g["gd"]: datetime.fromisoformat(g["raceStart"]) for g in schedule}

    def tla_for(gd, car):
        for g in reversed(order[: order.index(gd) + 1]):
            t = (num_of(g) or {}).get(car)
            if t:
                return t
        return None

    out = []
    for g in schedule:
        per_car = {}
        for d in sorted(docs_of(g) or [], key=lambda d: (d.get("published") or "", d.get("doc") or 0)):
            m = PEN_TITLE.search(d.get("title") or "")
            if not m or "grid" not in d:
                continue
            rows = per_car.setdefault(int(m.group(1)), [])
            if CORRECTED.search(d.get("title") or "") and rows:
                rows.pop()
            if d["grid"]:
                rows.append(d)
        for car, rows in per_car.items():
            for d in rows:
                try:
                    pub = datetime.fromisoformat(d["published"])
                except (KeyError, TypeError, ValueError):
                    continue
                later = not pub < start[g["gd"]]
                i = order.index(g["gd"]) + (1 if later else 0)
                tla = tla_for(g["gd"], car)
                # "the next race in which the driver participates": past a round he didn't race. Only a penalty
                # handed out after its race carries on; one for this race (a pit-lane start for parc-fermé changes)
                # lapses if he doesn't start
                while later and raced and tla and i < len(order) and raced(order[i], tla) is False:
                    i += 1
                out.append(
                    {
                        "car": car,
                        "tla": tla,
                        "places": d["grid"],
                        "issued": g["gd"],
                        "target": order[i] if i < len(order) else None,
                        "published": d["published"],
                        "doc": d.get("url"),
                        "title": d.get("title"),
                    }
                )
    return out


def ledger_penalties(ledger, gd, before=None):
    """The grid penalties for race gd from the ledger (published before `before`, ISO, if given): ({TLA: places},
    {TLA: latest published}, {TLA: [[places, published], ...]}); 99 (back of the grid) wins, the rest add up."""
    from datetime import datetime

    cut = datetime.fromisoformat(before) if before else None
    pen, at, parts = {}, {}, {}
    for e in ledger:
        if e["target"] != gd or not e.get("tla"):
            continue
        if cut and datetime.fromisoformat(e["published"]) >= cut:
            continue
        t = e["tla"]
        pen[t] = 99 if e["places"] >= 99 or pen.get(t) == 99 else pen.get(t, 0) + e["places"]
        at[t] = max(at.get(t, ""), e["published"])
        parts.setdefault(t, []).append([e["places"], e["published"]])
    return pen, at, parts


def event_slug(name, season):
    """The FIA's event slug for a meeting name: "Azerbaijan Grand Prix" -> "2026_azerbaijan_grand_prix"."""
    return f"{season}_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def fia_names(name, aliases):
    """A meeting's names on the FIA's pages: its own, then the FIA's where they differ (config/season.json
    fiaNames)."""
    return [name, *[a for a in (aliases or {}).get(name, []) if isinstance(a, str)]]


def fia_event_path(name, season, archived, aliases):
    """The archived FIA index of a meeting (history/<season>/fia/<event>.json). The FIA names its files itself
    ("2026_barcelona-catalunya_grand_prix"), so an archived file matches any of the meeting's names with
    punctuation ignored; without one yet, the path under its own name (fourth review: the Barcelona round's index
    was never found under "2026_barcelona_grand_prix")."""
    import glob
    import os

    want = {event_slug(n, season) for n in fia_names(name, aliases)}
    for p in sorted(glob.glob(archived("fia", "*.json"))):
        if re.sub(r"[^a-z0-9]+", "_", os.path.basename(p)[:-5].lower()).strip("_") in want:
            return p
    return archived("fia", f"{event_slug(name, season)}.json")


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
    "parcFerme": re.compile(r"^(?!.*Infringement).*(?:Parts|replaced).*Parc Ferm", re.I),
    "tyres": re.compile(r"Pirelli Preview", re.I),
}
PU_ELEMENTS = ["ICE", "TC", "EXH", "MGU-K", "ES", "PU-CE", "PU-ANC"]  # the "used up to now" table's columns


def tech_kind(title):
    return next((k for k, rx in TECH.items() if rx.search(title or "")), None)


def parse_pu_used(text):
    """ "PU elements used per driver up to now" -> {car number: {element: count}} (the season so far)."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\d{1,2})\s+\D.*?((?:\s+\d+){7})\s*$", line)
        if m:
            out[int(m.group(1))] = dict(zip(PU_ELEMENTS, (int(n) for n in m.group(2).split()), strict=True))
    return out


def parse_pu_new(text):
    """ "New PU elements for this Competition" -> {car number: {element: how many of it the car had used before}}.
    Each heading's table only: its "Previously used <element>" header must name the heading's element, and its rows
    run to the first line that isn't one. A car given two different counts for one element in the same document
    is left out for it (unknown rather than wrong; fourth review: an unrecognised "( PU-ANC)" heading put its table
    under MGU-K)."""
    out, bad = {}, set()
    # "... start the Competition with a new turbocharger (TC):" / "... is using a new internal combustion engine
    # (ICE) for the remainder of the Competition:" / "... a new power unit ancillary component ( PU-ANC)"; the
    # compliance lines say "(4) new", never "a new"
    parts = re.split(r"\ban? new [^()]{3,60}?\(\s*([A-Z][A-Z\-\s]*?)\s*\)", text)
    for raw, body in zip(parts[1::2], parts[2::2], strict=True):
        el = re.sub(r"\s+", "", raw)
        head = re.search(r"Previously used\s+([A-Z][A-Z\-]*)", body)
        if not head or head.group(1) != el:
            continue  # no table, or another element's: skip rather than guess
        for line in body[head.end() :].splitlines():
            if not line.strip():
                continue
            m = re.match(r"\s*(\d{1,2})\s+\D.*\s(\d+)\s*$", line)
            if not m:
                break
            car, n = int(m.group(1)), int(m.group(2))
            if (car, el) in bad:
                continue
            if out.get(car, {}).get(el, n) != n:
                bad.add((car, el))
                del out[car][el]
                continue
            out.setdefault(car, {})[el] = n
    return {c: els for c, els in out.items() if els}


def team_code(name, teams):
    """A team's code from any of its names ("Oracle Red Bull Racing" -> RED): the longest config name inside it."""
    low = (name or "").lower()
    keys = [k for k in teams if not k.startswith("_")]
    # the full name inside it, else its first word alone ("HAAS" for "Haas F1 Team")
    hits = [k for k in keys if k.lower() in low] or [k for k in keys if re.search(rf"\b{k.split()[0].lower()}\b", low)]
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


def fia_tech(archived, read_json, write_json, read_bytes, teams, most=6, reparse=False):
    """Every archived event's technical documents not read yet (at most `most` PDFs a run, oldest event first): the
    text kept, `read` set on the document, and the event's `tech` rebuilt from all its texts (the latest document
    of a kind wins; new PU elements add up over the weekend). `reparse` rebuilds every event's `tech` (after a parser
    change). Returns how many were read."""
    import glob
    import os

    fetched = 0
    for path in sorted(glob.glob(archived("fia", "*.json"))):
        rec = read_json(path)
        slug = rec.get("event") or os.path.basename(path)[:-5]
        changed = reparse
        for d in rec["docs"]:
            kind = tech_kind(d.get("title"))
            if d.get("read") and d["read"] != kind:  # TECH changed: relabel, or drop what it no longer covers
                if kind:
                    d["read"] = kind
                else:
                    del d["read"]
                    txt = archived("fia", "text", slug, os.path.basename(d["url"])[:-4] + ".txt")
                    if os.path.exists(txt):
                        os.remove(txt)
                changed = True
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
