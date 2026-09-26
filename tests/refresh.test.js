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
