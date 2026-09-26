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
import practice  # noqa: E402
import refresh  # noqa: E402
import telemetry  # noqa: E402


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
        self.assertIn("connect-src https://", policy)

    def test_season_over_builds(self):
        d = self.data()
        d["schedule"] = [g for g in d["schedule"] if g["gd"] in d["done"]]
        d["next"] = None
        self.assertIn('"next":null', self.build(d))


if __name__ == "__main__":
    unittest.main()
