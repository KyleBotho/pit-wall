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

test("contactLink: an email or an http(s) link, nothing else", () => {
  const c = (v) => run(`contactLink(${JSON.stringify(v)})`);
  assert.deepEqual(c(" help@example.com "), { href: "mailto:help@example.com", text: "help@example.com" });
  assert.deepEqual(c("https://example.com/help"), { href: "https://example.com/help", text: "example.com/help" });
  assert.equal(c("javascript:alert(1)"), null);
  assert.equal(c("not an address"), null);
  assert.equal(c(""), null);
});

// Rivals: tracking-league teams the user picked (state.rivals = [{ak, tk}])
const RIVAL_ROW = {
  account_key: "acc1",
  username: "Rival Manager",
  teams: [
    { tk: "r1", no: 1, name: "Rival One" },
    { tk: "r2", no: 2, name: "Rival Two" },
  ],
  body: {
    names: { r1: "Old name", r2: "Rival Two" },
    rounds: [
      { gd: 14, pts: { r1: 50, r2: 40 } },
      { gd: 15, pts: { r2: 30 } },
    ],
    seen: { r1: { 14: ["1"] }, r2: { 14: ["2"], 15: ["3"] } },
  },
};

test("rivalPicks: only well-formed picks, each team once", () => {
  const list = [{ ak: "a", tk: "t" }, { ak: "a", tk: "t" }, { ak: "a" }, null, { ak: "b", tk: "u", x: 1 }, "t"];
  assert.deepEqual(run(`rivalPicks(${JSON.stringify(list)})`), [
    { ak: "a", tk: "t" },
    { ak: "b", tk: "u" },
  ]);
  assert.deepEqual(run("rivalPicks(undefined)"), []);
});

test("toggleRival adds a team or takes it out; rivalAccounts lists each account once", () => {
  const one = run(`toggleRival([], "a", "t1")`);
  assert.deepEqual(one, [{ ak: "a", tk: "t1" }]);
  const two = run(`toggleRival(${JSON.stringify(one)}, "a", "t2")`);
  assert.deepEqual(run(`rivalAccounts(${JSON.stringify(two)})`), ["a"]);
  assert.deepEqual(run(`toggleRival(${JSON.stringify(two)}, "a", "t1")`), [{ ak: "a", tk: "t2" }]);
});

test("rivalBody: only the picked teams of an account, with its latest team names", () => {
  assert.deepEqual(run(`rivalBody(${JSON.stringify(RIVAL_ROW)}, ["r1"])`), {
    names: { r1: "Rival One" },
    rounds: [{ gd: 14, pts: { r1: 50 } }],
    seen: { r1: { 14: ["1"] } },
  });
  assert.equal(run(`rivalBody(${JSON.stringify(RIVAL_ROW)}, ["zz"])`), null);
});

test("mergeRivals: picked rivals added after your own data, which wins; nothing picked changes nothing", () => {
  const base = run(`mergeLeague(${JSON.stringify(LEAGUES)}, ${JSON.stringify(ACCOUNT)})`);
  const picks = [{ ak: "acc1", tk: "r2" }];
  const m = run(`mergeRivals(${JSON.stringify(base)}, [${JSON.stringify(RIVAL_ROW)}], ${JSON.stringify(picks)})`);
  assert.deepEqual(m.leagues, LEAGUES.leagues);
  assert.deepEqual(m.names, { ...base.names, r2: "Rival Two" });
  assert.deepEqual(m.rounds, [
    { gd: 14, pts: { a1: 90, t1: 70, r2: 40 } },
    { gd: 15, pts: { t1: 60, r2: 30 } },
  ]);
  assert.deepEqual(m.seen.r2, RIVAL_ROW.body.seen.r2);
  assert.ok(!("r1" in m.seen) && !("r1" in m.names)); // not picked: not loaded
  assert.deepEqual(run(`mergeRivals(${JSON.stringify(base)}, [${JSON.stringify(RIVAL_ROW)}], [])`), base);
  assert.equal(run(`mergeRivals(null, [], [])`), null);
  assert.deepEqual(run(`mergeRivals(null, [${JSON.stringify(RIVAL_ROW)}], ${JSON.stringify(picks)})`).names, {
    r2: "Rival Two",
  });
});

test("rivalList: names and usernames, teams no longer in the league, your own teams left out", () => {
  const picks = [
    { ak: "acc1", tk: "r1" },
    { ak: "acc1", tk: "gone" },
    { ak: "acc2", tk: "x1" },
    { ak: "me", tk: "mine" },
  ];
  const l = run(`rivalList(${JSON.stringify(picks)}, [${JSON.stringify(RIVAL_ROW)}], ["mine"])`);
  assert.deepEqual(
    l.map((r) => [r.tk, r.name, r.user, r.missing]),
    [
      ["r1", "Rival One", "Rival Manager", false],
      ["gone", "Unknown team", "Rival Manager", true],
      ["x1", "Unknown team", "", true],
    ],
  );
  // rows not loaded yet: nothing is called missing
  assert.ok(run(`rivalList(${JSON.stringify(picks)}, null)`).every((r) => !r.missing));
});
