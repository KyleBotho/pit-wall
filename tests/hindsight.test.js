// Hindsight scoring against F1's official round scores. Needs your own line-ups per round, which only exist in the
// private repo (history/backfill.json from a data export): runs on a machine with the ../pit-wall-private clone (or
// PIT_WALL_PRIVATE set), skipped elsewhere (CI).
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");
const H = require("../hindsight.js");
const { loadData, loadBackfill } = require("./helpers.js");

const D = loadData(),
  BF = loadBackfill();
const opt = { skip: !D ? "no cache/data.json" : !BF ? "no private backfill.json" : false };

function teamRounds() {
  const out = [];
  for (const [team, rounds] of Object.entries(BF.lineups))
    for (const [g, r] of Object.entries(rounds)) {
      const gd = +g,
        official = (BF.rounds[g] || {})[team];
      if (D.done.includes(gd) && official != null) out.push({ team, gd, r, official });
    }
  return out;
}

test("score() rebuilds every official round score exactly", opt, () => {
  const h = H.create(D, E),
    rows = teamRounds();
  assert.ok(rows.length >= 40, `team-rounds to check: ${rows.length}`);
  const miss = rows.filter((x) => Math.abs(h.score(x.r, x.gd) - x.official) > 0.5);
  assert.deepEqual(
    miss.map((x) => `${x.team} R${x.gd} (${x.r.chip || "no chip"}): ${h.score(x.r, x.gd)} vs ${x.official}`),
    [],
  );
});

test("the best reachable team never scores below what was played", opt, () => {
  const h = H.create(D, E);
  const below = teamRounds().filter((x) => {
    const b = h.own(x.r, x.gd);
    return !b || b.score < x.official - 0.5;
  });
  assert.deepEqual(
    below.map((x) => `${x.team} R${x.gd}`),
    [],
  );
});
