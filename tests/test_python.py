"""Tests for the Python side: shared feed helpers and the page build. Run:  python -m unittest discover tests"""

import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import f1feeds  # noqa: E402
import practice  # noqa: E402
import refresh  # noqa: E402


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


class Config(unittest.TestCase):
    def test_jolpica_map_covers_old_and_new_names(self):
        self.assertEqual(refresh.JOLPICA_TEAM["sauber"], "Audi")
        self.assertEqual(refresh.JOLPICA_TEAM["rb"], "Racing Bulls")


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
        self.assertIn("const DATA = {", html)

    def test_season_over_builds(self):
        d = self.data()
        d["schedule"] = [g for g in d["schedule"] if g["gd"] in d["done"]]
        d["next"] = None
        self.assertIn('"next":null', self.build(d))


if __name__ == "__main__":
    unittest.main()
