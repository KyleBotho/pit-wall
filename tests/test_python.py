"""Tests for the Python side: shared feed helpers and the page build. Run:  python -m unittest discover tests"""

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import f1feeds  # noqa: E402
import health  # noqa: E402
import practice  # noqa: E402
import refresh  # noqa: E402
import telemetry  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tools"))
import health_issue  # noqa: E402


class FeedHelpers(unittest.TestCase):
    def test_feed_time(self):
        self.assertEqual(f1feeds.feed_time({"FeedTime": {"UTCTime": "9/17/2026 1:59:44 PM"}}), "2026-09-17T13:59:44Z")
        self.assertEqual(f1feeds.feed_time({"FeedTime": {"UTCTime": "12/1/2026 12:05:00 AM"}}), "2026-12-01T00:05:00Z")
        self.assertIsNone(f1feeds.feed_time({}))
        self.assertIsNone(f1feeds.feed_time(None))

    def test_ev_code(self):
        self.assertEqual(f1feeds.ev_code("Race", "Race Position Gained"), "R PG")
        self.assertEqual(f1feeds.ev_code("Race", "2nd Fastest Pitstop"), "R FP2")
        self.assertEqual(f1feeds.ev_code("Qualifying", "Qualifying Not Classified"), "Q NC")
        self.assertEqual(f1feeds.ev_code("Sprint Qualifying", "Something new"), "S OTH")

    def test_team_key(self):
        # the page's teamTk (web/js/core.js) must give the same: tests/shared.test.js checks this vector
        self.assertEqual(f1feeds.team_key("guid-example", 2), "b533aeb1cc9b3744")
        self.assertEqual(f1feeds.team_key("guid-example", "2"), "b533aeb1cc9b3744")
        self.assertIsNone(f1feeds.team_key(None, 2))
        self.assertIsNone(f1feeds.team_key("guid-example", None))

    def test_account_key(self):
        # the page's accountKey (web/js/core.js) must give the same: tests/shared.test.js checks this vector
        self.assertEqual(f1feeds.account_key("guid-example"), "e13e0b890006eb4b")
        self.assertIsNone(f1feeds.account_key(None))
        self.assertIsNone(f1feeds.account_key(""))

    def test_optional_feed_missing_is_none(self):
        err = urllib.error.HTTPError("u", 403, "Forbidden", {}, None)
        with mock.patch.object(f1feeds, "_read", side_effect=err), mock.patch.object(f1feeds.time, "sleep"):
            self.assertIsNone(f1feeds.get_optional("https://example.invalid/x"))

    def test_failures_raise_feed_error_after_retries(self):
        calls = []

        def boom(url):
            calls.append(url)
            raise OSError("down")

        with (
            tempfile.TemporaryDirectory() as d,
            mock.patch.object(f1feeds, "_read", boom),
            mock.patch.object(f1feeds.time, "sleep"),
        ):
            with self.assertRaises(f1feeds.FeedError):
                f1feeds.get("https://example.invalid/x", os.path.join(d, "x.json"), attempts=3)
        self.assertEqual(len(calls), 3)

    def test_soft_fetch_falls_back_to_the_cached_copy(self):
        with (
            tempfile.TemporaryDirectory() as d,
            mock.patch.object(f1feeds, "_read", side_effect=OSError("401")),
            mock.patch.object(f1feeds.time, "sleep"),
        ):
            p = os.path.join(d, "x.json")
            with self.assertRaises(f1feeds.FeedError):
                f1feeds.get_soft("https://example.invalid/x", p)
            with open(p, "w") as f:
                json.dump([1, 2], f)
            self.assertEqual(f1feeds.get_soft("https://example.invalid/x", p), [1, 2])

    def test_soft_fetch_says_when_its_answer_was_fetched(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(f1feeds.time, "sleep"):
            p = os.path.join(d, "x.json")
            meta = {}
            with mock.patch.object(f1feeds, "_read", return_value="[1]"):
                f1feeds.get_soft("https://example.invalid/x", p, meta=meta)
            self.assertTrue(meta["fresh"])
            with open(p + ".at", "w") as f:
                f.write("2026-09-01T10:00+00:00")
            meta = {}
            with mock.patch.object(f1feeds, "_read", side_effect=OSError("401")):
                self.assertEqual(f1feeds.get_soft("https://example.invalid/x", p, meta=meta), [1])
            # the cached copy keeps its own time, not the time of the failed attempt
            self.assertEqual(meta, {"fresh": False, "at": "2026-09-01T10:00+00:00"})

    def test_a_block_page_is_not_cached_or_retried(self):
        calls = []

        def captcha(url):
            calls.append(url)
            return "<html>Are you a robot?</html>"

        with (
            tempfile.TemporaryDirectory() as d,
            mock.patch.object(f1feeds, "_read", captcha),
            mock.patch.object(f1feeds.time, "sleep"),
        ):
            p = os.path.join(d, "x.json")
            with self.assertRaises(f1feeds.FeedError):
                f1feeds.get("https://example.invalid/x", p, attempts=3)
            self.assertEqual(len(calls), 1)
            self.assertFalse(os.path.exists(p))
            with open(p, "w") as f:
                json.dump([1, 2], f)
            self.assertEqual(f1feeds.get_soft("https://example.invalid/x", p), [1, 2])
            with open(p) as f:
                self.assertEqual(json.load(f), [1, 2])
            with self.assertRaises(f1feeds.FeedError):
                f1feeds.get_optional("https://example.invalid/x")

    def test_a_bad_saved_copy_is_fetched_again(self):
        with (
            tempfile.TemporaryDirectory() as d,
            mock.patch.object(f1feeds, "_read", return_value='{"ok": 1}'),
            mock.patch.object(f1feeds.time, "sleep"),
        ):
            p = os.path.join(d, "x.json")
            with open(p, "w") as f:
                f.write("<html>blocked</html>")
            self.assertEqual(f1feeds.get("https://example.invalid/x", p, reuse=True), {"ok": 1})
            self.assertEqual(f1feeds.get("https://example.invalid/x", p, reuse=True), {"ok": 1})
            self.assertEqual(os.listdir(d), ["x.json"])


class MarketOdds(unittest.TestCase):
    def test_a_cached_book_keeps_its_own_time(self):
        import extras

        tlas = [f"D{i:02d}" for i in range(12)]

        def fake(url, path, reuse=False, meta=None):
            if "events?" in url:
                return {"events": [{"event_ticker": "KXF1RACE-AZEGP26", "sub_title": "Azerbaijan Grand Prix 26"}]}
            series = url.split("event_ticker=")[1].split("-")[0]
            if meta is not None:
                # the winner book fresh; the others failed and came from the cache, fetched before qualifying
                fresh = series == "KXF1RACE"
                meta.update(fresh=fresh, at="2026-09-19T15:00+00:00" if fresh else "2026-09-18T09:00+00:00")
            ms = [
                {"ticker": f"{series}-AZEGP26-{t}", "yes_bid_dollars": "0.05", "yes_ask_dollars": "0.07"} for t in tlas
            ]
            return {"markets": ms}

        kept = []
        o = extras.odds(fake, lambda n: n, "Azerbaijan Grand Prix", 2026, set(tlas), 22, lambda e, b: kept.append(b))
        self.assertEqual(o["at"], "2026-09-18T09:00+00:00")  # the oldest book decides what the market knew
        self.assertEqual(o["asOf"]["win"], "2026-09-19T15:00+00:00")
        self.assertEqual(sorted(o["stale"]), ["fl", "podium", "pole", "top10"])
        self.assertEqual(list(kept[0]), ["win"])  # only fresh quotes go into the archive


class SessionClassification(unittest.TestCase):
    def test_flags_follow_the_classification_not_openf1s_dnf(self):
        import extras

        num2 = {1: "AAA", 2: "BBB", 3: "CCC", 4: "DDD", 5: "EEE"}
        sprint = [
            {"driver_number": 1, "position": 1, "number_of_laps": 24},
            {"driver_number": 2, "position": 2, "number_of_laps": 22, "dnf": True},  # retired, still classified
            {"driver_number": 3, "position": 3, "number_of_laps": 21},  # under 90% of 24 (21.6 -> 21 laps: in)
            {"driver_number": 4, "position": 4, "number_of_laps": 20},  # not classified, though not flagged
            {"driver_number": 5, "position": None, "number_of_laps": 7, "dsq": True},
        ]
        self.assertEqual(extras.session_flags(sprint, num2, "s"), {"DDD": "dnf", "EEE": "dsq"})
        quali = [
            {"driver_number": 1, "duration": [90.1, 89.9, 89.5]},
            {"driver_number": 2, "duration": [91.0, None, None], "dnf": True},  # crashed after setting a time
            {"driver_number": 3, "duration": [None, None, None]},
            {"driver_number": 4, "duration": [90.5, None, None], "dsq": True},
        ]
        self.assertEqual(extras.session_flags(quali, num2, "q"), {"CCC": "notime", "DDD": "dsq"})
        laps = [{"driver_number": 1, "lap_duration": 92.1}, {"driver_number": 3, "lap_duration": 91.7}, {}]
        self.assertEqual(extras.fastest_lap(laps, num2), "CCC")


class FiaPenalties(unittest.TestCase):
    def test_decisions_to_grid_places(self):
        import collect

        head = "Stewards Decision Document 20 From The Stewards To The Team Manager "
        self.assertEqual(
            collect.parse_decision(
                head + "Decision Drop of 25 grid positions for the next Race in which the driver participates "
                "Reason The penalty is imposed in accordance with Article B8.2.8 ... a 10 grid place penalty ..."
            ),
            25,
        )
        self.assertEqual(collect.parse_decision(head + "Decision Required to start the race from the pit lane."), 99)
        self.assertEqual(collect.parse_decision(head + "Decision Reprimand (driving) Reason ... 5 grid places"), 0)
        self.assertEqual(collect.parse_decision(head + "Decision 3 place grid penalty for the next Sprint."), 0)
        self.assertEqual(collect.event_slug("Azerbaijan Grand Prix", 2026), "2026_azerbaijan_grand_prix")

    def test_decisions_add_up_and_each_pdf_is_read_once(self):
        import collect

        rec = {
            "event": "e",
            "docs": [
                {"title": "Doc 20 - Infringement - Car 14 - PU elements", "url": "a", "published": "T1"},
                {"title": "Doc 34 - Infringement - Car 14 - PU element", "url": "b", "published": "T2"},
                {"title": "Doc 48 - Infringement - Car 11 - Impeding Car 81", "url": "c", "published": "T3"},
                {"title": "Doc 52 - Provisional Starting Grid", "url": "d", "published": "T4"},
            ],
        }
        store, reads = {"x": rec}, []
        texts = {
            "a": "Decision Drop of 25 grid positions",
            "b": "Decision Drop of 5 grid positions",
            "c": "Decision Reprimand",
        }

        def read_bytes(url):
            reads.append(url)
            return texts[url]

        with mock.patch.object(collect, "pdf_text", lambda b: b), mock.patch("os.path.exists", return_value=True):
            args = (lambda *p: "x", lambda p: store[p], lambda p, v, **k: store.__setitem__(p, v), "e", read_bytes)
            pen, at = collect.fia_penalties(*args)
            self.assertEqual(pen, {14: 30})
            self.assertEqual(at, {14: "T2"})
            collect.fia_penalties(*args)
        self.assertEqual(reads, ["a", "b", "c"])


class ForecastRecord(unittest.TestCase):
    def test_input_hashes_show_which_input_changed(self):
        data = {"assets": [{"id": "1"}], "odds": {"win": {"NOR": 0.3}}, "generated": "x"}
        a = refresh.input_hashes(data)
        b = refresh.input_hashes({**data, "odds": {"win": {"NOR": 0.31}}, "generated": "y"})
        self.assertEqual(set(a), set(refresh.RECORD_INPUTS))
        self.assertEqual([k for k in a if a[k] != b[k]], ["odds"])

    def test_partial_kalshi_book_keeps_room_for_missing_drivers(self):
        import extras

        full = extras._norm({t: 0.2 for t in "ABCDEFGHIJ"}, 3, field=10)
        self.assertAlmostEqual(sum(full.values()), 3, places=3)
        part = extras._norm({t: 0.2 for t in "ABCDEF"}, 3, field=10)
        self.assertLess(sum(part.values()), 3)  # the 4 missing drivers keep a share
        self.assertAlmostEqual(part["A"], 3 * 0.2 / (1.2 + 4 * 0.1), places=3)


class Config(unittest.TestCase):
    def test_jolpica_map_covers_old_and_new_names(self):
        self.assertEqual(refresh.JOLPICA_TEAM["sauber"], "Audi")
        self.assertEqual(refresh.JOLPICA_TEAM["rb"], "Racing Bulls")


class RefreshPlan(unittest.TestCase):
    # a weekend like Baku's: qualifying Fri 12:00-13:00 UTC (the lock), race Sat 11:00-13:00, practice before
    DATA = {
        "next": 15,
        "schedule": [
            {
                "gd": 15,
                "lock": "2026-09-25T12:00:00+00:00",
                "certified": False,
                "sessions": [
                    {"type": "Qualifying", "start": "2026-09-25T12:00:00+00:00", "end": "2026-09-25T13:00:00+00:00"},
                    {"type": "Race", "start": "2026-09-26T11:00:00+00:00", "end": "2026-09-26T13:00:00+00:00"},
                ],
            }
        ],
        "practice": [{"name": "Practice 3", "start": "2026-09-25T08:30:00+00:00", "done": False}],
    }

    def plan(self, now, data=None):
        return {p["at"]: p["why"] for p in refresh.refresh_plan(data or self.DATA, now)["plan"]}

    def test_session_driven_times(self):
        from datetime import datetime, timezone

        p = self.plan(datetime(2026, 9, 24, 12, tzinfo=timezone.utc))
        self.assertIn("after Practice 3", p["2026-09-25T09:55+00:00"])
        self.assertIn("before lock", p["2026-09-25T11:00+00:00"])
        self.assertIn("before lock", p["2026-09-25T11:40+00:00"])
        self.assertIn("after qualifying", p["2026-09-25T13:20+00:00"])
        self.assertIn("line-ups", p["2026-09-25T15:30+00:00"])
        self.assertIn("after the race", p["2026-09-26T13:20+00:00"])
        self.assertIn("certified", p["2026-09-26T16:30+00:00"])
        self.assertIn("daily", p["2026-09-24T06:17+00:00"])
        self.assertEqual(list(p), sorted(p))

    def test_certified_race_stops_polling_and_old_entries_drop(self):
        from copy import deepcopy
        from datetime import datetime, timezone

        d = deepcopy(self.DATA)
        d["schedule"][0]["certified"] = True
        p = self.plan(datetime(2026, 9, 26, 18, tzinfo=timezone.utc), d)
        self.assertFalse([w for w in p.values() if "certified" in w])
        self.assertNotIn("2026-09-25T13:20+00:00", p)  # more than 12 h ago


class Health(unittest.TestCase):
    # one finished round (race Sat 11:00-13:00 UTC) and the next one
    def data(self, **kw):
        d = {
            "done": [15],
            "next": 16,
            "schedule": [
                {
                    "gd": 15,
                    "name": "Azerbaijan Grand Prix",
                    "lock": "2026-09-25T12:00:00+00:00",
                    "raceStart": "2026-09-26T11:00:00+00:00",
                    "certified": True,
                    "sessions": [
                        {
                            "type": "Qualifying",
                            "start": "2026-09-25T12:00:00+00:00",
                            "end": "2026-09-25T13:00:00+00:00",
                        },
                        {"type": "Race", "start": "2026-09-26T11:00:00+00:00", "end": "2026-09-26T13:00:00+00:00"},
                    ],
                },
                {
                    "gd": 16,
                    "name": "Bahrain Grand Prix",
                    "lock": "2026-10-03T08:00:00+00:00",
                    "raceStart": "2026-10-04T07:00:00+00:00",
                    "sessions": [
                        {
                            "type": "Qualifying",
                            "start": "2026-10-03T16:00:00+08:00",
                            "end": "2026-10-03T17:00:00+08:00",
                        },
                        {"type": "Race", "start": "2026-10-04T07:00:00+00:00", "end": "2026-10-04T09:00:00+00:00"},
                    ],
                },
            ],
            "results": {"race": {"15": [{"tla": "RUS", "grid": 1}]}, "quali": {"15": []}},
            "raceInfo": {"15": {}},
            "weather": {"16": {"ens": {"q": 0.1, "r": 0.1, "qr": 0.02, "n": 51}}},
            "projHist": {"15": {}},
            "elite": {"history": [{"gd": 15, "est": False}]},
            "evNames": [{"s": "R", "n": "Race Position", "c": "R POS"}],
            "assets": [{"id": "1", "kind": "D", "name": "A", "team": "T", "price": 10, "active": True}],
        }
        d.update(kw)
        return d

    def at(self, s):
        from datetime import datetime

        return datetime.fromisoformat(s)

    def ids(self, data, now):
        return {i: lv for i, lv, _ in health.problems(data, self.at(now))}

    def test_a_clean_weekend_has_no_problems(self):
        self.assertEqual(self.ids(self.data(), "2026-09-28T12:00:00+00:00"), {})

    def test_the_automatic_data_of_batches_3_and_4_is_watched(self):
        # a race block without the lap model a day after the race; a forecast without the ensemble
        d = self.data(raceInfo={"15": {"race": {"pace": {}}}}, weather={"16": {"q": 0.2}})
        self.assertEqual(self.ids(d, "2026-09-28T12:00:00+00:00"), {"laps:15": "warn", "ensemble:16": "warn"})
        ok = {"race": {"pace": {}, "paceCtx": {}, "retirements": {}}}
        self.assertEqual(self.ids(self.data(raceInfo={"15": ok}), "2026-09-28T12:00:00+00:00"), {})

    def test_missing_results_uncertified_points_and_unknown_events(self):
        d = self.data(
            results={"race": {}, "quali": {"15": []}}, evNames=[{"s": "R", "n": "Pit lane bonus", "c": "R OTH"}]
        )
        d["schedule"][0]["certified"] = False
        # 1 h after the race: too early for any of them
        self.assertEqual(self.ids(d, "2026-09-26T14:00:00+00:00"), {"event:R:Pit lane bonus": "warn"})
        got = self.ids(d, "2026-09-27T02:00:00+00:00")
        self.assertEqual(got["results:15"], "error")
        self.assertEqual(got["certified:15"], "warn")

    def test_no_projection_frozen_at_lock_and_the_stand_in_grid(self):
        d = self.data(projHist={"15": {}})
        d["results"]["race"]["15"] = [{"tla": "RUS", "grid": 1, "gridFromQuali": True}]
        got = self.ids(d, "2026-10-03T10:00:00+00:00")
        self.assertEqual(got["projection:16"], "error")
        self.assertEqual(got["grid:15"], "warn")

    def test_notices_for_cards_and_schedule_changes(self):
        prev = self.data()
        now = self.data(
            assets=[
                {"id": "1", "kind": "D", "name": "A", "team": "U", "price": 10, "active": False},
                {"id": "2", "kind": "D", "name": "B", "team": "T", "price": 5, "active": True},
            ]
        )
        # the same moment written with another offset is not a change; a real move is
        now["schedule"][1]["sessions"][0]["start"] = "2026-10-03T08:00:00+00:00"
        now["schedule"][1]["sessions"][1]["start"] = "2026-10-04T08:00:00+00:00"
        msgs = " | ".join(m for _, m in health.notices(now, prev))
        self.assertIn("New card: B (T)", msgs)
        self.assertIn("A (U) is now inactive", msgs)
        self.assertIn("A moved from T to U", msgs)
        self.assertIn("Race moved from", msgs)
        self.assertNotIn("Qualifying moved", msgs)
        self.assertEqual(health.notices(now, None), [])

    def test_first_seen_is_kept_and_notices_expire(self):
        prev = self.data()
        now = self.data(
            assets=prev["assets"] + [{"id": "2", "kind": "D", "name": "B", "team": "T", "price": 5, "active": True}]
        )
        now["schedule"][0]["certified"] = False
        h, log = health.check(now, prev, {}, self.at("2026-09-27T02:00:00+00:00"))
        self.assertEqual([i["level"] for i in h["items"]], ["warn", "notice"])
        h, log = health.check(now, now, log, self.at("2026-09-28T02:00:00+00:00"))
        self.assertEqual(h["items"][0]["since"], "2026-09-27T02:00+00:00")  # still the first time it was seen
        self.assertEqual(h["items"][1]["level"], "notice")
        h, log = health.check(now, now, log, self.at("2026-10-01T02:00:00+00:00"))
        self.assertEqual([i["level"] for i in h["items"]], ["warn"])  # the notice is 4 days old: gone


class HealthIssue(unittest.TestCase):
    ITEMS = [
        {"id": "results:15", "level": "error", "msg": "R15: no race results.", "since": "2026-09-26T16:00+00:00"},
        {"id": "card:new:9", "level": "notice", "msg": "New card: B (T), $5m.", "since": "2026-09-26T17:00+00:00"},
    ]

    def test_render_lists_both_kinds_and_marks_the_ids(self):
        title, body = health_issue.render(self.ITEMS)
        self.assertEqual(title, "Data health: 1 problem, 1 notice")
        self.assertIn("**Problems**", body)
        self.assertIn("**Notices**", body)
        self.assertIn("(since 2026-09-26 16:00 UTC)", body)
        self.assertEqual(health_issue.listed(body), ["card:new:9", "results:15"])
        self.assertEqual(health_issue.listed("no marker"), [])

    def test_change_note_names_what_is_new(self):
        note = health_issue.change_note(self.ITEMS, ["results:15", "old:1"])
        self.assertIn("New card: B", note)
        self.assertNotIn("no race results", note)
        self.assertIn("Cleared: 1 item.", note)


class Practice(unittest.TestCase):
    def test_open_stint_counts_as_a_long_run(self):
        laps = [
            {"driver_number": 1, "lap_number": n, "lap_duration": 90 + 0.01 * n, "is_pit_out_lap": n == 1}
            for n in range(1, 12)
        ]
        stints = [
            {
                "driver_number": 1,
                "stint_number": 1,
                "lap_start": 1,
                "lap_end": None,
                "compound": "MEDIUM",
                "tyre_age_at_start": 0,
            }
        ]
        res = practice.analyse_session(laps, stints, [{"driver_number": 1, "name_acronym": "AAA"}])
        self.assertIsNotNone(res["AAA"]["r"], "the stint without a lap_end still gives a long-run pace")
        self.assertGreater(res["AAA"]["rl"], 0)

    def test_reference_lap_is_the_median_of_the_ten_fastest_best_laps(self):
        laps = [{"driver_number": d, "lap_duration": 80 + d, "is_pit_out_lap": False} for d in range(1, 16)]
        laps += [{"driver_number": 1, "lap_duration": 70, "is_pit_out_lap": True}]  # out-lap: not a lap time
        laps += [{"driver_number": 2, "lap_duration": None, "is_pit_out_lap": False}]
        self.assertEqual(practice.ref_lap(laps), 85.5)  # drivers 1-10: 81..90
        self.assertIsNone(practice.ref_lap(laps[:4]))  # too few drivers to say


class Minisectors(unittest.TestCase):
    def test_ideal_lap_takes_each_minisectors_best(self):
        import numpy as np

        # two 60 s laps: one 2 s faster in the first half, the other 2 s faster in the second half
        x = np.linspace(0, 1, 1001)
        a = np.where(x < 0.5, x * 56, 28 + (x - 0.5) * 64)
        b = np.where(x < 0.5, x * 64, 32 + (x - 0.5) * 56)
        self.assertAlmostEqual(telemetry.ideal_lap([(a, 60.0), (b, 60.0)], mini=2), 56.0, places=6)
        self.assertAlmostEqual(telemetry.ideal_lap([(a, 60.0)], mini=2), 60.0, places=6)

    def test_a_stalled_trace_is_rejected(self):
        import numpy as np

        t = np.arange(0, 60, 0.25)
        v = np.full(len(t), 200.0)  # the same speed for a minute: a frozen feed
        self.assertTrue(telemetry.stalled(t, v))
        self.assertFalse(telemetry.stalled(t, 200 + 50 * np.sin(t)))


class LapRefs(unittest.TestCase):
    def test_a_round_gets_its_fastest_practice_session(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(refresh, "ARCHIVE", d):
            os.makedirs(os.path.join(d, "practice"))
            sessions = [{"done": True, "ref": 90.5}, {"done": True, "ref": 89.9}, {"done": False, "ref": 80}]
            with open(os.path.join(d, "practice", "gd03.json"), "w", encoding="utf-8") as f:
                json.dump(sessions, f)
            ts = refresh.add_lap_refs({"3": {"ovt": 4}, "4": {"ovt": 5}})
        self.assertEqual(ts, {"3": {"ovt": 4, "lap": 89.9}, "4": {"ovt": 5}})


class Passes(unittest.TestCase):
    """telemetry.count_passes: race-order changes between timing lines, pit stops and lapping excluded."""

    @staticmethod
    def lap(n, t_end, lap_time=90.0, pit_in=0, pit_out=0):
        # sectors at 1/3 and 2/3 of the lap
        row = dict.fromkeys(telemetry.COLS)
        row.update(lap=n, t1=t_end - 2 * lap_time / 3, t2=t_end - lap_time / 3, t3=t_end, pitIn=pit_in, pitOut=pit_out)
        return [row[c] for c in telemetry.COLS]

    def test_a_pass_mid_lap_counts_once(self):
        # B starts behind A, is ahead from lap 2's second line on
        laps = {
            "AAA": [self.lap(1, 100), self.lap(2, 190)],
            "BBB": [self.lap(1, 101), self.lap(2, 189, lap_time=88)],
        }
        # lap 2 lines: A 130/160/190, B 130.33/159.67/189 -> B ahead at line 2
        self.assertEqual(telemetry.count_passes(laps, {"AAA": 1, "BBB": 2}), {"AAA": 0, "BBB": 1})

    def test_swap_inside_a_lap_is_missed_by_lap_end_sampling_only(self):
        # B passes A in sector 2 of lap 2 and A passes back in sector 3: two passes, same order at the line
        a = [self.lap(1, 100), [2, None, 130, 160, 190] + [None] * 12]
        b = [self.lap(1, 101), [2, None, 131, 159, 191] + [None] * 12]
        full = telemetry.count_passes({"AAA": a, "BBB": b}, {"AAA": 1, "BBB": 2})
        end = telemetry.count_passes({"AAA": a, "BBB": b}, {"AAA": 1, "BBB": 2}, lines=(3,))
        self.assertEqual(full, {"AAA": 1, "BBB": 1})
        self.assertEqual(end, {"AAA": 0, "BBB": 0})

    def test_places_lost_in_the_pits_are_not_passes(self):
        laps = {
            "AAA": [self.lap(1, 100), self.lap(2, 190, pit_in=1), self.lap(3, 305, lap_time=115, pit_out=1)],
            "BBB": [self.lap(1, 101), self.lap(2, 191), self.lap(3, 281)],
        }
        self.assertEqual(telemetry.count_passes(laps, {"AAA": 1, "BBB": 2}), {"AAA": 0, "BBB": 0})

    def test_lapping_a_backmarker_is_not_a_pass(self):
        # A laps B during lap 2 (B is a lap down: B's lap n ends 60 s after A's)
        laps = {
            "AAA": [self.lap(n, 90 * n) for n in range(1, 4)],
            "BBB": [self.lap(n, 90 * n + 60 * n) for n in range(1, 3)],
        }
        self.assertEqual(telemetry.count_passes(laps, {"AAA": 1, "BBB": 2}), {"AAA": 0, "BBB": 0})


@unittest.skipUnless(os.path.exists(os.path.join(ROOT, "cache", "data.json")), "no cache/data.json")
class PageBuild(unittest.TestCase):
    def build(self, data):
        with tempfile.TemporaryDirectory() as out:
            refresh.build_page(data, out)
            with open(os.path.join(out, "index.html"), encoding="utf-8") as f:
                return f.read()

    def data(self):
        with open(os.path.join(ROOT, "cache", "data.json"), encoding="utf-8") as f:
            d = json.load(f)
        d["cfg"] = refresh.CFG
        return d

    def test_page_is_self_contained(self):
        html = self.build(self.data())
        self.assertNotIn('<script src="', html)
        self.assertNotIn('<link rel="stylesheet" href="web/', html)
        self.assertIsNone(refresh.DATA_MARK.search(html))
        block = re.search(r'<script type="application/json" id="pw-data">\s*(.*?)\s*</script>', html, re.S).group(1)
        self.assertTrue(block.startswith("{"))
        self.assertNotIn("<", block)  # every "<" escaped, so the data can't end its block

    def test_content_policy_allows_exactly_the_page_scripts(self):
        html = self.build(self.data())
        policy = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', html).group(1)
        allowed = re.search(r"script-src ([^;]+)", policy).group(1).split()
        scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
        digest = lambda s: "'sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode() + "'"
        self.assertEqual(sorted(allowed), sorted(digest(s) for s in scripts))
        self.assertNotIn("unsafe-inline", re.search(r"script-src[^;]+", policy).group(0))
        # Supabase and this site itself (the build's sims, presim-*.bin), nothing else
        self.assertRegex(policy, r"connect-src 'self' https://[^ ;]+;")

    def test_season_over_builds(self):
        d = self.data()
        d["schedule"] = [g for g in d["schedule"] if g["gd"] in d["done"]]
        d["next"] = None
        self.assertIn('"next":null', self.build(d))


if __name__ == "__main__":
    unittest.main()


class LapModel(unittest.TestCase):
    """laps.py: canonical lap records, the contextual race pace, retirement causes (review batch 3)."""

    T0 = 1_790_000_000  # epoch seconds, a race start

    def iso(self, s):
        from datetime import datetime, timezone

        return datetime.fromtimestamp(self.T0 + s, timezone.utc).isoformat()

    def test_neutral_windows_close_on_any_end_signal_or_are_capped(self):
        import laps

        rc = [
            {"date": self.iso(100), "message": "SAFETY CAR DEPLOYED"},
            {"date": self.iso(400), "message": "SAFETY CAR IN THIS LAP"},
            {"date": self.iso(1000), "message": "VSC DEPLOYED"},
            {"date": self.iso(1100), "message": "VSC ENDING"},
            {"date": self.iso(2000), "message": "SAFETY CAR DEPLOYED"},  # never ends in the messages (Monza R13)
        ]
        w = [(a - self.T0, b - self.T0) for a, b in laps.neutral_windows(rc, 90)]
        self.assertEqual(w, [(100, 400 + 135), (1000, 1100 + 45), (2000, 2000 + 6 * 90)])

    def test_lap_records_line_up_with_fastf1_or_give_no_pace(self):
        import laps

        cols = laps.COLS
        ix = {c: i for i, c in enumerate(cols)}

        def row(n, t, cmp="I", age=5):
            r = [None] * len(cols)
            r[ix["lap"]], r[ix["time"]], r[ix["cmp"]], r[ix["age"]] = n, t, cmp, age
            return r

        times = [90 + (k * 0.37) % 2 for k in range(12)]
        ff = {
            "cols": ["lap", "lapTime", "cmp", "life"],
            "laps": {"AAA": [[n, times[n - 1], "MEDIUM", n + 2] for n in range(1, 13)]},
        }
        # OpenF1 numbers every lap one short (R1 2026) and puts the car on the wrong tyre (R5 2026)
        canon = {"cols": cols, "laps": {"AAA": [row(n - 1, times[n - 1]) for n in range(2, 13)]}, "quality": {}}
        out = laps.with_ff(canon, ff)
        self.assertEqual(out["quality"]["ff"]["shift"], 1)
        self.assertTrue(out["quality"]["ff"]["ok"])
        r = out["laps"]["AAA"][0]
        self.assertEqual((r[ix["lap"]], r[ix["cmp"]], r[ix["age"]]), (2, "M", 3))
        self.assertEqual(canon["laps"]["AAA"][0][ix["lap"]], 1)  # the input isn't changed
        # times that match under no numbering: no contextual pace
        bad = {"cols": cols, "laps": {"AAA": [row(n, 80.0 + n) for n in range(1, 13)]}, "quality": {}}
        out = laps.with_ff(bad, ff)
        self.assertFalse(out["quality"]["ff"]["ok"])
        self.assertIsNone(laps.fit_pace(out))

    def session(self, pace, n_laps=30, vary=False):
        """Synthetic race: lap time = 90 x (1 + pace %) + tyre wear - fuel burn, one stop. vary: each car stops
        on its own lap and half start on hards (what makes fuel and tyres separable in a real race)."""
        num2 = {k + 1: t for k, t in enumerate(pace)}
        laps_, stints = [], []
        for num, t in num2.items():
            stop = n_laps // 2 + (num % 7 - 3 if vary else 0)
            first, second = ("HARD", "MEDIUM") if vary and num % 2 else ("MEDIUM", "HARD")
            wear = {"MEDIUM": 0.08, "HARD": 0.04}
            clock = self.T0 + num * 0.7  # cars cross the line in order
            for n in range(1, n_laps + 1):
                cmp_, start = (first, 1) if n <= stop else (second, stop + 1)
                dur = 90 * (1 + pace[t] / 100) + wear[cmp_] * (n - start) - 2.0 * n / n_laps + (5 if n == 1 else 0)
                laps_.append(
                    {
                        "driver_number": num,
                        "lap_number": n,
                        "date_start": self.iso(clock - self.T0),
                        "lap_duration": round(dur, 3),
                        "is_pit_out_lap": n == stop + 1,
                    }
                )
                clock += dur
            stints += [
                {"driver_number": num, "stint_number": 1, "lap_start": 1, "lap_end": stop, "compound": first,
                 "tyre_age_at_start": 0},
                {"driver_number": num, "stint_number": 2, "lap_start": stop + 1, "lap_end": n_laps,
                 "compound": second, "tyre_age_at_start": 0},
            ]  # fmt: skip
        return laps_, stints, num2

    def test_canonical_records_carry_the_context(self):
        import laps

        l_, st, num2 = self.session({"AAA": 0.0, "BBB": 0.5})
        c = laps.canonical(l_, st, [], [{"date": self.iso(500), "rainfall": 1}], num2)
        ix = {k: i for i, k in enumerate(c["cols"])}
        a = c["laps"]["AAA"]
        self.assertEqual([r[ix["cmp"]] for r in a[14:17]], ["M", "H", "H"])
        self.assertEqual([r[ix["pitIn"]] for r in a[14:16]], [1, 0])
        self.assertEqual(a[15][ix["pitOut"]], 1)
        self.assertEqual(a[16][ix["age"]], 1)
        self.assertEqual(sum(r[ix["wet"]] for r in a), 1)  # the lap running at 500 s
        self.assertAlmostEqual(c["laps"]["BBB"][0][ix["gap"]], 0.7, places=2)  # BBB crosses 0.7 s after AAA
        self.assertEqual(c["quality"]["compound"], 1.0)

    def test_pace_model_recovers_the_cars_through_tyres_and_fuel(self):
        import laps

        pace = {"A%02d" % k: 0.15 * k for k in range(8)}
        l_, st, num2 = self.session(pace, vary=True)
        fit = laps.fit_pace(laps.canonical(l_, st, [], [], num2))
        for t, p in pace.items():
            self.assertAlmostEqual(fit["pace"][t], p, delta=0.02)
        self.assertLess(fit["coef"]["fuelFullRace"], -1.5)  # lighter car, faster laps

    def test_retirement_causes_by_time_of_the_incident_message(self):
        import laps

        rows = [
            {"tla": "WIN", "cls": True, "laps": 50},
            {"tla": "CRA", "cls": False, "laps": 20},
            {"tla": "ENG", "cls": False, "laps": 30},
            {"tla": "DNS", "cls": False, "laps": 0, "dns": True},
        ]
        canon = {
            "cols": laps.COLS,
            "t0": self.iso(0),
            "laps": {"CRA": [[20, 1800.0, 90.0] + [None] * 12], "ENG": [[30, 2700.0, 90.0] + [None] * 12]},
        }
        rc = [
            # noted two minutes after CRA stopped, with the leader already laps further on
            {"date": self.iso(2010), "lap_number": 24, "message": "INCIDENT INVOLVING CARS 7 (CRA) AND 9 (XXX) NOTED"},
            {"date": self.iso(2790), "lap_number": 31, "message": "INCIDENT INVOLVING CAR 8 (ENG) - TRACK LIMITS"},
        ]
        got = laps.retirements(rows, rc, {"CRA": 7, "ENG": 8, "DNS": 5}, canon)
        self.assertEqual({t: v["cause"] for t, v in got.items()}, {"CRA": "incident", "ENG": "other", "DNS": "dns"})
        self.assertEqual(got["CRA"]["share"], 0.4)


class Collect(unittest.TestCase):
    """collect.py: data kept as it happens (review batch 4)."""

    G = {
        "gd": 16,
        "lat": 1.0,
        "lon": 2.0,
        "sessions": [
            {"type": "Qualifying", "start": "2026-10-03T08:00:00+00:00"},
            {"type": "Race", "start": "2026-10-04T07:00:00+00:00"},
        ],
    }

    def test_ensemble_wet_shares_per_session_and_together(self):
        import collect

        times = [f"2026-10-03T{h:02d}:00" for h in range(24)] + [f"2026-10-04T{h:02d}:00" for h in range(24)]
        hourly = {"time": times}
        # 4 members: wet in qualifying (07-09 h on the 3rd) / the race (06-09 h on the 4th): [Q, R] = TT, TF, FT, FF
        for m, (q, r) in enumerate([(1, 1), (1, 0), (0, 1), (0, 0)]):
            hourly[f"precipitation_member{m:02d}"] = [
                (0.6 if (d == 3 and 7 <= h <= 9 and q) or (d == 4 and 6 <= h <= 9 and r) else 0)
                for d in (3, 4)
                for h in range(24)
            ]
        e = collect.ensemble_sessions({"hourly": hourly}, self.G)
        self.assertEqual(e["p"], {"Qualifying": 0.5, "Race": 0.5})
        self.assertEqual(e["pQR"], 0.25)
        self.assertEqual(e["n"], 4)

    def test_vintages_are_kept_only_when_they_change(self):
        import collect

        store = {}
        read = lambda p: json.loads(json.dumps(store[p]))  # noqa: E731
        write = lambda p, obj, **kw: store.__setitem__(p, obj)  # noqa: E731
        with tempfile.TemporaryDirectory() as d:
            arch = lambda *parts: os.path.join(d, *parts)  # noqa: E731
            real_exists = os.path.exists
            with mock.patch("os.path.exists", lambda p: p in store or real_exists(p)):
                f = {
                    "hourly": {"time": ["2026-10-03T08:00"], "precipitation_probability": [40], "precipitation": [0.1]}
                }
                from datetime import datetime, timezone

                now = datetime(2026, 9, 28, tzinfo=timezone.utc)
                self.assertTrue(collect.weather_vintage(arch, read, write, self.G, f, None, now))
                self.assertFalse(collect.weather_vintage(arch, read, write, self.G, f, None, now))
                f["hourly"]["precipitation_probability"] = [55]
                self.assertTrue(collect.weather_vintage(arch, read, write, self.G, f, None, now))
                self.assertEqual(len(store[arch("weather", "gd16.json")]["vintages"]), 2)

    def test_fia_rows_parse_with_utc_times(self):
        import collect

        html = (
            '<li class="document-row key-58"><a href="/system/files/decision-document/'
            '2026_azerbaijan_grand_prix_-_final_starting_grid.pdf" download><div class="file-type"></div>'
            '<div class="title"> Doc 58 - Final Starting Grid </div><div class="published"> Published on '
            '<span class="date-display-single">26.09.26 12:00</span> CET </div></a></li>'
        )
        [r] = collect.parse_fia(html)
        self.assertEqual(r["event"], "2026_azerbaijan_grand_prix")
        self.assertEqual(r["doc"], 58)
        self.assertEqual(r["published"], "2026-09-26T10:00+00:00")  # Paris summer time
