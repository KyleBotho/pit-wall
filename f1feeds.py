"""Shared helpers for reading F1 Fantasy's public feeds (and other public JSON sources).

Used by refresh.py and practice.py here, and by the private repo's leagues.py (which checks this repo out and
imports this file). Requests are paced (config/feeds.json "pauseSeconds") and never hammer a server: a failure is
retried slowly a couple of times and then raised as FeedError for the caller to decide what to do.
"""

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(name):
    with open(os.path.join(HERE, "config", f"{name}.json"), encoding="utf-8") as f:
        return json.load(f)


FEEDS = load_config("feeds")
UA = FEEDS["userAgent"]
PAUSE = FEEDS["pauseSeconds"]
EV_SESSION = FEEDS["evSession"]
EV_RULES = [tuple(r) for r in FEEDS["evRules"]["list"]]


class FeedError(RuntimeError):
    """A source kept failing (outage, block or CAPTCHA). Callers stop rather than retry into a ban."""


def _read(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def _load(path):
    """The saved copy, or None when there is none or it isn't JSON (a block page an older version saved)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_text(path, text):
    """Write via a temp file and a rename, so a crash mid-write never leaves a half-written file behind."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _parse(url, body):
    try:
        return json.loads(body)
    except ValueError as e:
        # a 200 that isn't JSON is usually a block or CAPTCHA page: stop (no retries into a ban) and don't save it
        raise FeedError(f"{url}: not JSON, maybe a block page: {body[:80]!r}") from e


def get(url, path, reuse=False, attempts=3, backoff=10):
    """Fetch JSON and keep a copy at path. reuse=True returns the saved copy without asking the server.
    Raises FeedError after `attempts` failures, waiting backoff, 2*backoff, ... seconds in between, or at once when
    the answer isn't JSON."""
    if reuse and (saved := _load(path)) is not None:
        return saved
    for attempt in range(attempts):
        try:
            body = _read(url)
            break
        except Exception as e:  # noqa: BLE001 - any failure: slow down, then give up
            print(f"  ! {url} -> {e}")
            if attempt == attempts - 1:
                raise FeedError(f"{url}: {e}") from e
            time.sleep(backoff * (attempt + 1))
    data = _parse(url, body)
    write_text(path, body)
    time.sleep(PAUSE)
    return data


def get_soft(url, path, reuse=False):
    """For sources that may refuse us for a while (OpenF1 locks everything to paying users while a session is live):
    one attempt; on failure fall back to the last saved copy, else raise FeedError so the caller can skip it."""
    if reuse and (saved := _load(path)) is not None:
        return saved
    try:
        body = _read(url)
        data = _parse(url, body)
    except Exception as e:  # noqa: BLE001
        if (saved := _load(path)) is not None:
            print(f"  ! {url} -> {e}; using the cached copy")
            return saved
        if isinstance(e, FeedError):
            raise
        raise FeedError(f"{url}: {e}") from e
    finally:
        time.sleep(PAUSE)
    write_text(path, body)
    return data


def get_optional(url, attempts=1, backoff=15):
    """A feed that may not exist yet: None on 403/404 (a new league's standings file 403s until it's published).
    Other failures are retried slowly, then raised as FeedError; an answer that isn't JSON raises at once."""
    for attempt in range(attempts):
        try:
            body = _read(url)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            err = e
        except Exception as e:  # noqa: BLE001
            err = e
        else:
            return _parse(url, body)
        finally:
            time.sleep(PAUSE)
        print(f"  ! {url} -> {err}")
        if attempt < attempts - 1:
            time.sleep(backoff)
    raise FeedError(f"{url}: {err}")


def feed_time(d):
    """F1's FeedTime.UTCTime is US-style text ("9/17/2026 1:59:44 PM"); return ISO UTC so every browser can parse it."""
    t = ((d or {}).get("FeedTime") or {}).get("UTCTime")
    try:
        return datetime.strptime(t, "%m/%d/%Y %I:%M:%S %p").strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return None


def team_key(guid, team_no):
    """A team's lasting identity: F1's account guid + team number (1-3), hashed so no account id is kept. Names are
    only labels (they change, and two managers can share one). The page computes the same (web/js/core.js teamTk).
    None without a guid."""
    if not guid or team_no is None:
        return None
    return hashlib.sha256(f"{guid}:{int(team_no)}".encode()).hexdigest()[:16]


def account_key(guid):
    """An F1 account's lasting identity for Team Tracking: its account guid, hashed like team_key, so no account id
    is kept. The page computes the same (web/js/core.js accountKey). None without a guid."""
    if not guid:
        return None
    return hashlib.sha256(str(guid).encode()).hexdigest()[:16]


def ev_code(session, name):
    """Scoring-event category code, e.g. ("Race", "Race Position Gained") -> "R PG"."""
    n = name.strip().lower()
    return EV_SESSION.get(session, "?") + " " + next((c for k, c in EV_RULES if k in n), "OTH")
