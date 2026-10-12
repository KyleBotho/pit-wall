// backtest/stats_team.js: the hindsight chip calendar (exact: at most one chip a round, each chip once)
const test = require("node:test");
const assert = require("node:assert/strict");
const { solveCalendar } = require("../backtest/stats_team.js");

test("solveCalendar picks the best calendar, not each chip's best round", () => {
  const gains = {
    // each chip's best round alone would be: Wildcard R3, Limitless R3, X3 R2 (a clash at R3)
    wildcard: [
      { gd: 2, g: 5 },
      { gd: 3, g: 20 },
    ],
    limitless: [
      { gd: 3, g: 50 },
      { gd: 4, g: 10 },
    ],
    x3: [
      { gd: 2, g: 30 },
      { gd: 4, g: -5 },
    ],
  };
  // X3 R2 30 + Limitless R3 50 = 80 beats Wildcard R3 20 + Limitless R4 10 + X3 R2 30 = 60
  assert.deepEqual(solveCalendar(gains), { 2: "x3", 3: "limitless" });
  // a gain never above 0 is never played
  assert.deepEqual(solveCalendar({ noneg: [{ gd: 5, g: -1 }] }), {});
});
