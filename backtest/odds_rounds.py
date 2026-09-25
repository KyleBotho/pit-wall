"""Market probabilities at lock for every finished round -> backtest/odds_by_round.json (Kalshi, public, no login).

The live site archives the odds it used (history/<season>/odds/gdNN.json); this rebuilds the same thing for rounds
before that archive existed, from Kalshi's hourly price history, so the backtest can fit how much weight the market
gets. Run from the project folder:  python backtest/odds_rounds.py
"""

import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import extras  # noqa: E402
from f1feeds import FeedError, get, load_config  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(HERE, "odds_by_round.json")


def cached(name):
    return os.path.join(CACHE, name)


FIRST_GD = 5  # the walk-forward backtest starts here; older rounds need one request per driver (historical API)


def close_mid(c):
    """Mid of the hour's closing bid/ask, else the last trade (live API: *_dollars fields; historical: plain)."""

    def f(block, k):
        b = c.get(block) or {}
        return float(b.get(k + "_dollars") or b.get(k) or 0)

    bid, ask = f("yes_bid", "close"), f("yes_ask", "close")
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    v = f("price", "close") or f("price", "previous")
    return v or None


def historical(series, suffix, start, end):
    """Settled events leave the live API: list the event's markets, then each market's candles."""
    ev = f"{series}-{suffix}"
    try:
        url = f"{extras.KALSHI}/historical/markets?event_ticker={ev}&limit=60"
        ms = get(url, cached(f"k_hm_{ev}.json"), reuse=True)
    except FeedError:
        return []
    out = []
    for m in ms.get("markets") or []:
        t = m["ticker"]
        url = f"{extras.KALSHI}/historical/markets/{t}/candlesticks?start_ts={start}&end_ts={end}&period_interval=60"
        try:
            d = get(url, cached(f"k_hc_{t}.json"), reuse=True, attempts=1)
        except FeedError:
            continue
        out.append((t, d.get("candlesticks") or []))
    return out


def main():
    season = load_config("season")["season"]
    with open(os.path.join(CACHE, "data.json"), encoding="utf-8") as f:
        data = json.load(f)
    tlas = {a["tla"] for a in data["assets"] if a["kind"] == "D"}
    events = get(f"{extras.KALSHI}/events?limit=100&series_ticker=KXF1RACE", cached("k_events_hist.json"))["events"]
    out = {}
    for g in data["schedule"]:
        if g["gd"] not in data["done"]:
            continue
        suffix = extras.kalshi_suffix(events, g["name"], season)
        if not suffix:
            print(f"R{g['gd']} {g['name']}: no Kalshi event")
            continue
        lock = datetime.fromisoformat(g["lock"])
        end = int(lock.timestamp())
        start = int((lock - timedelta(hours=36)).timestamp())
        rec = {"event": suffix, "gd": g["gd"]}
        for key, (series, total) in extras.KALSHI_SERIES.items():
            url = (
                f"{extras.KALSHI}/series/{series}/events/{series}-{suffix}/candlesticks"
                f"?start_ts={start}&end_ts={end}&period_interval=60"
            )
            try:
                d = get(url, cached(f"k_hist_{series}_{suffix}.json"), reuse=True, attempts=1)
            except FeedError:
                continue
            pairs = list(zip(d.get("market_tickers") or [], d.get("market_candlesticks") or [], strict=False))
            if not pairs and g["gd"] >= FIRST_GD and key != "pole":
                pairs = historical(series, suffix, start, end)
            raw = {}
            for ticker, candles in pairs:
                tla = ticker.rsplit("-", 1)[-1]
                vals = [v for v in (close_mid(c) for c in candles) if v is not None]
                if tla in tlas and vals:
                    raw[tla] = vals[-1]
            if len(raw) >= 10:
                rec[key] = extras._norm(raw, total)
        print(f"R{g['gd']} {suffix}: {', '.join(k for k in rec if k in extras.KALSHI_SERIES) or 'nothing'}")
        if len(rec) > 2:
            out[str(g["gd"])] = rec
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"{len(out)} rounds -> {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
