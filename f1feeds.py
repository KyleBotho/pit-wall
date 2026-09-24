"""Shared helpers for reading F1 Fantasy's public feeds (and other public JSON sources).

Used by refresh.py and practice.py here, and by the private repo's leagues.py (which checks this repo out and
imports this file). Requests are paced (config/feeds.json "pauseSeconds") and never hammer a server: a failure is
retried slowly a couple of times and then raised as FeedError for the caller to decide what to do.
"""

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
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save(path, body):
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def get(url, path, reuse=False, attempts=3, backoff=10):
    """Fetch JSON and keep a copy at path. reuse=True returns the saved copy without asking the server.
    Raises FeedError after `attempts` failures, waiting backoff, 2*backoff, ... seconds in between."""
    if reuse and os.path.exists(path):
        return _load(path)
    for attempt in range(attempts):
        try:
            body = _read(url)
            break
        except Exception as e:  # noqa: BLE001 - any failure: slow down, then give up
            print(f"  ! {url} -> {e}")
            if attempt == attempts - 1:
                raise FeedError(f"{url}: {e}") from e
            time.sleep(backoff * (attempt + 1))
    _save(path, body)
    time.sleep(PAUSE)
    return json.loads(body)


def get_soft(url, path, reuse=False):
    """For sources that may refuse us for a while (OpenF1 locks everything to paying users while a session is live):
    one attempt; on failure fall back to the last saved copy, else raise FeedError so the caller can skip it."""
    if reuse and os.path.exists(path):
        return _load(path)
    try:
        body = _read(url)
    except Exception as e:  # noqa: BLE001
        if os.path.exists(path):
            print(f"  ! {url} -> {e}; using the cached copy")
            return _load(path)
        raise FeedError(f"{url}: {e}") from e
    finally:
        time.sleep(PAUSE)
    _save(path, body)
    return json.loads(body)


def get_optional(url, attempts=1, backoff=15):
    """A feed that may not exist yet: None on 403/404 (a new league's standings file 403s until it's published).
    Other failures are retried slowly, then raised as FeedError."""
    for attempt in range(attempts):
        try:
            return json.loads(_read(url))
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            err = e
        except Exception as e:  # noqa: BLE001
            err = e
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


def ev_code(session, name):
    """Scoring-event category code, e.g. ("Race", "Race Position Gained") -> "R PG"."""
    n = name.strip().lower()
    return EV_SESSION.get(session, "?") + " " + next((c for k, c in EV_RULES if k in n), "OTH")
