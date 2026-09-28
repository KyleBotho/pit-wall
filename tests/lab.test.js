// The Sim lab's own data file (refresh.py lab_split -> lab-<hash>.json, web/js/lab-data.js): loaded once for the
// owner, a failure retried (fifth review: a failed load was cached for good), concurrent requests share one fetch,
// and what arrives is merged into DATA.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pageModules } = require("./helpers.js");

const data = {
  assets: [],
  schedule: [],
  done: [],
  cfg: { teams: {}, defaultTeam: { drivers: [], constructors: [] } },
  labFile: "lab-abc.json",
  raceInfo: { 1: { race: { pace: { AAA: 0.1 } } } },
  priors: { races: [{ season: 2025 }] },
};
const payload = {
  modelHealth: { accuracy: { rounds: [1] } },
  raceInfo: { 1: { race: { pacePool: { AAA: 0.9 }, paceSePool: { AAA: 0.2 } } } },
  priorRows: { 0: { scLaps: [[3, 5, "in"]], lapsRun: 50 } },
};

test("lab data: a failed load is retried, concurrent loads share a fetch, the payload merges into DATA", async () => {
  const calls = [];
  let fail = true;
  const fetch = (url) => {
    calls.push(url);
    if (fail) return Promise.resolve({ ok: false, status: 503 });
    // a slow success: both callers wait for the same answer
    return new Promise((r) => setTimeout(() => r({ ok: true, json: () => Promise.resolve(payload) }), 20));
  };
  const run = pageModules(["lab-data.js", "core.js"], data, { fetch, setTimeout });
  assert.equal(await run("labData()"), false);
  assert.equal(await run("labData()"), false); // failed again: it did try again
  assert.equal(calls.length, 2);
  fail = false;
  const [a, b] = await Promise.all([run("labData()"), run("labData()")]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(calls.length, 3); // one fetch for both
  assert.equal(await run("labData()"), true); // loaded: no more fetches
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, ["lab-abc.json", "lab-abc.json", "lab-abc.json"]);
  const D = JSON.parse(run("JSON.stringify(DATA)"));
  assert.deepEqual(D.modelHealth, payload.modelHealth);
  assert.deepEqual(D.raceInfo[1].race, { pace: { AAA: 0.1 }, pacePool: { AAA: 0.9 }, paceSePool: { AAA: 0.2 } });
  assert.deepEqual(D.priors.races[0], { season: 2025, scLaps: [[3, 5, "in"]], lapsRun: 50 });
});
