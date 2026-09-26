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
  for (const [team, rounds] of Object.entries({ ...BF.lineups, ...(BF.rivals || {}) }))
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

test(
  "model team: follows the transfer rules, and on perfect projections scores exactly what it projected",
  {
    skip: D ? false : "no cache/data.json",
  },
  () => {
    const h = H.create(D, E);
    // projections = the points each asset actually scored (from R2, like the rebuilt ones)
    const proj = Object.fromEntries(
      D.done
        .filter((g) => g > D.schedule[0].gd)
        .map((g) => [
          g,
          Object.fromEntries(
            D.assets
              .map((a) => [a.id, h.at(a.id, g)])
              .filter(([, x]) => x && x.active)
              .map(([id, x]) => [id, x.pts]),
          ),
        ]),
    );
    const rs = h.modelTeam(proj);
    assert.equal(rs.length, Object.keys(proj).length);
    assert.equal(rs[0].start.length, 0);
    assert.ok(rs[0].cost <= 100 + 1e-6);
    let free = null,
      total = 0;
    for (const r of rs) {
      assert.equal(r.ids.length, 7);
      assert.ok(r.cost <= r.budget + 1e-6, `R${r.gd} over budget`);
      if (free != null) {
        assert.equal(r.free, free);
        assert.equal(r.penalty, 10 * Math.max(0, r.transfers - r.free));
      }
      assert.equal(r.pts, r.x, `R${r.gd}: scored ${r.pts}, projected ${r.x}`);
      total += r.pts;
      assert.equal(r.total, total);
      free = r.start.length ? Math.min(3, 2 + Math.min(1, Math.max(0, r.free - r.transfers))) : 2;
    }
  },
);

// Every team in the export (yours and league rivals), given only its round-1 record: the rest of its season must come
// back from the line-up that scored each round plus the official points, as it does for teams we only see in the
// league feed. Known limits: Autopilot can't be told from a Boost on the top scorer, and an inactive team's own
// "free transfers" stays stale in F1's record (it's only recomputed when the team is saved), so free transfers are
// compared on rounds with transfers.
test("track() rebuilds chips, Boost, budget, bank and transfers from line-ups and points", opt, () => {
  const h = H.create(D, E);
  const all = { ...BF.lineups, ...(BF.rivals || {}) };
  const miss = [];
  let n = 0;
  for (const [team, recs] of Object.entries(all))
    // the feed may show a Final Fix round's team either way: with the incoming driver, or back to the qualifying team
    for (const ffSeen of ["in", "qual"]) {
      const seen = {},
        official = {};
      for (const [g, r] of Object.entries(recs))
        seen[g] = ffSeen === "in" && r.ff ? r.ids.map((id) => (id === r.ff.out ? r.ff.in : id)) : r.ids;
      for (const [g, row] of Object.entries(BF.rounds)) if (row[team] != null) official[g] = row[team];
      const t = h.track({ 1: recs[1] }, seen, official);
      for (const r of t.rounds.filter((x) => x.gd > 1)) {
        const x = recs[r.gd],
          bad = [];
        n++;
        if ((r.chip || null) !== (x.chip === "autopilot" ? null : x.chip || null)) bad.push(`chip ${r.chip}/${x.chip}`);
        if (r.sure && String(r.boost) !== String(x.boost)) bad.push(`boost ${r.boost}/${x.boost}`);
        if (Math.abs(r.budget - x.budget) > 0.05) bad.push(`budget ${r.budget}/${x.budget}`);
        if (x.bank != null && Math.abs(r.bank - x.bank) > 0.05) bad.push(`bank ${r.bank}/${x.bank}`);
        if (!["wildcard", "limitless"].includes(x.chip) && r.subs !== x.subs) bad.push(`subs ${r.subs}/${x.subs}`);
        if (x.subs > 0 && r.free !== x.free) bad.push(`free ${r.free}/${x.free}`);
        if (bad.length) miss.push(`${team} R${r.gd} (${ffSeen}): ${bad.join(", ")}`);
      }
    }
  assert.ok(n >= 150, `team-rounds checked: ${n}`);
  assert.deepEqual(miss, []);
});

// Team Tracking: a member who joined the tracking league mid-season is first seen with a season total, not a round's
// points. That line-up still counts as the team held, so the next round's team is known (bank and free transfers not).
test("track() keeps a line-up seen without that round's points", { skip: D ? false : "no cache/data.json" }, () => {
  const h = H.create(D, E);
  const last = D.done[D.done.length - 1];
  const ids = D.assets
    .filter((a) => a.kind === "D" && h.at(a.id, last)?.active)
    .slice(0, 5)
    .concat(D.assets.filter((a) => a.kind === "C").slice(0, 2))
    .map((a) => a.id);
  const t = h.track({}, { [last]: ids }, {});
  assert.equal(t.rounds.length, 1);
  assert.equal(t.rounds[0].pts, null);
  assert.ok(t.rounds[0].unexplained);
  assert.deepEqual(t.next.ids, ids);
  assert.equal(t.next.asOf, last);
  assert.equal(t.next.bank, null);
  assert.equal(t.next.free, null);
});
