// Settings > Admin > Data refresh: the status block built from the refresh function's answer
// (supabase/functions/refresh) in its states: working with a recent problem, not set up, running.
const test = require("node:test");
const assert = require("node:assert/strict");
const { pageModules } = require("./helpers.js");

const run = pageModules(["refresh-view.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } });
const html = (st, refresh = { err: "", busy: false }) =>
  run(`refreshHtml(${JSON.stringify(st)}, ${JSON.stringify(refresh)})`);
const now = Date.now(),
  iso = (min) => new Date(now + min * 60000).toISOString();

test("a finished refresh, its planned reason, a later problem and what's next", () => {
  const h = html({
    token: true,
    state: {
      started_at: iso(-30),
      source: "schedule",
      reason: "after qualifying: points and order",
      error: "GitHub answered 401",
      error_at: iso(-10),
    },
    next: [{ at: iso(60), why: "after Practice 1: practice laps" }],
    runs: [
      {
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        created: iso(-29),
        url: "https://github.com/x",
      },
    ],
  });
  assert.match(h, /Last refresh .*✓ finished/);
  assert.match(h, /planned: after qualifying: points and order/);
  assert.match(h, /Last problem .*GitHub answered 401/);
  assert.match(h, /after Practice 1: practice laps/);
  assert.match(h, /data-refreshnow="1">Refresh now</);
});

test("not set up yet, and a run in progress disables the button", () => {
  const h = html({
    token: false,
    state: {},
    next: [],
    runs: [{ event: "schedule", status: "in_progress", created: iso(-2), url: "u" }],
  });
  assert.match(h, /GITHUB_DISPATCH_TOKEN/);
  assert.match(h, /Running since/);
  assert.match(h, /disabled>Refreshing…/);
  assert.doesNotMatch(h, /Last problem/);
  assert.match(
    html(null, { err: "The refresh service isn't set up yet or isn't answering.", busy: false }),
    /set up yet or isn/,
  );
});

test("the GitHub token's expiry: shown, and a warning three weeks ahead", () => {
  const base = { token: true, state: {}, next: [], runs: [] };
  assert.match(html({ ...base, tokenExpires: iso(60 * 24 * 60) }), /token valid until/);
  assert.match(html({ ...base, tokenExpires: iso(60 * 24 * 10) }), /class="note bad">The GitHub token expires on/);
  assert.match(html({ ...base, tokenExpires: iso(-60) }), /token expired on/);
});

// A value used while the page loads must already be set: sync.js imports admin.js, so a load-time
// `SB_URL + ...` in a module bundled before SB_URL came out as "undefined/functions/v1/refresh" (2026-09-26).
test("the bundled page sets SB_URL before any load-time use of it", () => {
  const esbuild = require("esbuild");
  const path = require("node:path");
  const code = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "web", "js", "main.js")],
    bundle: true,
    format: "iife",
    write: false,
    logLevel: "error",
  }).outputFiles[0].text;
  const def = code.search(/\bSB_URL = "https:/);
  assert.ok(def > 0, "SB_URL definition not found");
  const early = [...code.matchAll(/^\s*(?:var|let|const) (\w+) = SB_URL\b/gm)].filter((m) => m.index < def);
  assert.deepEqual(
    early.map((m) => m[1]),
    [],
  );
});

test("Data health: all clear, or the problems and notices with when they started", () => {
  const h = (x) => run(`healthHtml(${JSON.stringify(x)})`);
  assert.match(h({ generated: iso(-5), items: [] }), /✓ All clear/);
  const got = h({
    generated: iso(-5),
    items: [
      { id: "results:15", level: "error", msg: "R15: no race results.", since: iso(-60) },
      { id: "card:new:9", level: "notice", msg: "New card: B (T), $5m.", since: iso(-30) },
    ],
  });
  assert.match(got, /class="bad">Problem:<\/span> R15: no race results\./);
  assert.match(got, /class="muted">Notice:<\/span> New card: B \(T\)/);
  assert.match(h(null), /No health check in this build yet/);
});

test("Model health: season summary, rounds newest first, misses, and the fit proposal with its caution", () => {
  const mh = (x) =>
    pageModules(["model-health.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } })(
      `modelHealthHtml(${JSON.stringify(x)}, [{ gd: 15, name: "Azerbaijan Grand Prix" }])`,
    );
  assert.match(mh(null), /No model health yet/);
  const acc = {
    generated: "2026-09-26T21:00Z",
    season: {
      from: 5,
      crps: 8.76,
      mae: 12.12,
      maeD: 10.6,
      maeC: 15.2,
      rho: 0.73,
      cover80: 0.85,
      cover50: 0.56,
      team: 1975,
      best: 3170,
      baselines: { seasonAvg: 13.44, form: 13.84 },
    },
    rounds: [
      { gd: 14, frozen: null, walk: { crps: 7.9, mae: 11.2, bias: -0.4, rho: 0.8, team: 180 } },
      {
        gd: 15,
        frozen: { n: 33, mae: 14.82, bias: 2.47, rho: 0.57, in50: 0.36, miss: [{ name: "McLaren", x: 44.1, y: 1 }] },
        walk: { crps: 10.14, mae: 14.99, bias: 0.68, rho: 0.57, team: 194 },
      },
    ],
  };
  const fit = {
    generated: "2026-09-29T03:50Z",
    N: 4000,
    rounds: [5, 15],
    shipped: { crps: 8.76, mae: 12.1 },
    fitted: { crps: 8.71, mae: 12.0 },
    changes: [{ setting: "SIM.qSd", shipped: 0.2, fitted: 0.25 }],
  };
  const h = mh({ accuracy: acc, fit });
  assert.match(h, /<b>CRPS 8\.76<\/b>/);
  assert.ok(h.indexOf("R15 Azerbaijan") < h.indexOf("R14"), "newest round first");
  assert.match(h, /McLaren 44\.1 → 1/);
  assert.match(h, /SIM\.qSd<\/td><td>0\.2<\/td><td>0\.25/);
  assert.match(h, /Within noise/);
  // repeated held-out folds: each change says how many folds' fits agree
  const folded = mh({
    accuracy: acc,
    fit: {
      ...fit,
      holdout: { rounds: [14, 15], shipped: 9, fitted: 8.9, dCrps: -0.1, se: 0.2, folds: [{}, {}] },
      changes: [{ ...fit.changes[0], folds: 0 }],
    },
  });
  assert.match(folded, /each by a fit on the rounds before it/);
  assert.match(folded, /Folds agree.*<td class="bad">0 of 2<\/td>/s);
  assert.match(mh({ accuracy: acc, fit: { ...fit, changes: [] } }), /still the best fit/);
  assert.match(h, /frozen next to the shipped model from R16/);
  // challengers: a clear gain after enough rounds, noise otherwise
  const ch = (dqs, dqsSe, n) => ({
    ...acc,
    challengers: { rounds: [], summary: [{ id: "x", label: "Skewed", n, dqs, dqsSe, dmae: -0.1 }] },
  });
  assert.match(mh({ accuracy: ch(-0.3, 0.1, 6) }), /Skewed<\/td><td>6<\/td><td>-0\.30 ± 0\.10.*better/);
  assert.match(mh({ accuracy: ch(-0.1, 0.1, 6) }), /within noise/);
  assert.match(mh({ accuracy: ch(-0.3, 0.1, 2) }), /too few rounds/);
  // calibration by group: walk-forward and frozen side by side, a group only one of them has still listed
  assert.doesNotMatch(h, /By group/);
  const grp = mh({
    accuracy: {
      ...acc,
      season: {
        ...acc.season,
        groups: { wet: { rounds: 1, crps: 7.93, mae: 9.66, bias: 3.62, cover80: 0.82, cover50: 0.73 } },
      },
      frozenGroups: { "safety car": { rounds: 1, mae: 14.82, bias: 2.47, cover80: null, cover50: 0.36 } },
    },
  });
  assert.match(grp, /By group/);
  assert.match(grp, /wet<\/td><td>1<\/td><td>7\.93<\/td><td>9\.7<\/td><td>\+3\.6<\/td><td>82%<\/td><td>73%<\/td><td>–/);
  assert.match(grp, /safety car<\/td><td>–<\/td>.*<td>1<\/td><td>14\.8<\/td><td>\+2\.5<\/td><td>36%/);
});
