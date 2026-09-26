// Team Tracking's pure helpers (web/js/tracking.js): merging a linked account into the league data, the setup steps,
// the username search pattern and the linked account's teams.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pageModules } = require("./helpers.js");

const run = (() => {
  const r = pageModules(["tracking.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } });
  return (expr) => JSON.parse(r(`JSON.stringify(${expr})`));
})();

const LEAGUES = {
  v: 2,
  leagues: [{ name: "Private", members: [] }],
  names: { a1: "Own team" },
  rounds: [{ gd: 14, pts: { a1: 90 } }],
  lineups: { a1: {} },
  rivals: {},
  seen: { a1: { 14: ["1"] } },
};
const ACCOUNT = {
  names: { a1: "Old name", t1: "Tracked" },
  rounds: [
    { gd: 14, pts: { a1: 80, t1: 70 } },
    { gd: 15, pts: { t1: 60 } },
  ],
  seen: { a1: { 13: ["0"], 14: ["2"] }, t1: { 15: ["3"] } },
};

test("mergeLeague: nothing linked leaves the league data as it is", () => {
  assert.deepEqual(run(`mergeLeague(${JSON.stringify(LEAGUES)}, null)`), LEAGUES);
  assert.equal(run("mergeLeague(null, null)"), null);
});

test("mergeLeague: the linked account adds its teams; the league data wins where both know a value", () => {
  const m = run(`mergeLeague(${JSON.stringify(LEAGUES)}, ${JSON.stringify(ACCOUNT)})`);
  assert.deepEqual(m.leagues, LEAGUES.leagues);
  assert.deepEqual(m.lineups, LEAGUES.lineups);
  assert.deepEqual(m.names, { a1: "Own team", t1: "Tracked" });
  assert.deepEqual(m.rounds, [
    { gd: 14, pts: { a1: 90, t1: 70 } },
    { gd: 15, pts: { t1: 60 } },
  ]);
  assert.deepEqual(m.seen, { a1: { 13: ["0"], 14: ["1"] }, t1: { 15: ["3"] } });
});

test("mergeLeague: a user who isn't a league reader gets only their account's teams", () => {
  const m = run(`mergeLeague(null, ${JSON.stringify(ACCOUNT)})`);
  assert.deepEqual(m.leagues, []);
  assert.deepEqual(m.lineups, {});
  assert.deepEqual(m.names, ACCOUNT.names);
  assert.deepEqual(m.seen, ACCOUNT.seen);
  assert.deepEqual(m.rounds, ACCOUNT.rounds);
});

test("setupStep: signed out, loading, not linked, linked, linked but not in the data", () => {
  assert.equal(run('setupStep({ user: null, link: "k", row: {} })'), "signin");
  assert.equal(run("setupStep({ user: {}, link: undefined, row: null })"), "loading");
  assert.equal(run("setupStep({ user: {}, link: null, row: null })"), "join");
  assert.equal(run('setupStep({ user: {}, link: "k", row: { username: "x" } })'), "linked");
  assert.equal(run('setupStep({ user: {}, link: "k", row: null })'), "missing");
});

test("likePattern: part of a username, the user's own wildcards taken literally", () => {
  const lp = (q) => run(`likePattern(${JSON.stringify(q)})`);
  assert.equal(lp("Pit Wall"), "%Pit Wall%");
  assert.equal(lp("  pit "), "%pit%");
  assert.equal(lp("50%_a\\b"), "%50\\%\\_a\\\\b%");
  assert.equal(lp("p"), null);
  assert.equal(lp(null), null);
});

test("accountTeams: team-number order, at most three, only teams with a key", () => {
  const row = { teams: [{ tk: "c", no: 3 }, { tk: "a", no: 1 }, { no: 2 }, { tk: "d", no: 4 }, { tk: "b", no: 2 }] };
  assert.deepEqual(run(`accountTeams(${JSON.stringify(row)}).map((t) => t.tk)`), ["a", "b", "c"]);
  assert.deepEqual(run("accountTeams(null)"), []);
});
