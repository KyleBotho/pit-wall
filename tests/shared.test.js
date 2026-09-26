// Tables that live in more than one place stay identical.
const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../tools/sync-shared.js");
const { config, pageModules } = require("./helpers.js");

test("the live function's event tables match config/feeds.json (node tools/sync-shared.js)", () => {
  assert.equal(render().changed, false);
});

test("the page's team key matches f1feeds.team_key (same vector as tests/test_python.py)", async () => {
  const run = pageModules(["core.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } });
  assert.equal(await run('teamTk("guid-example", 2)'), "b533aeb1cc9b3744");
  assert.equal(await run("teamTk(null, 2)"), null);
});

test("the page's account key matches f1feeds.account_key (same vector as tests/test_python.py)", async () => {
  const run = pageModules(["core.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } });
  assert.equal(await run('accountKey("guid-example")'), "e13e0b890006eb4b");
  assert.equal(await run("accountKey(null)"), null);
});

test("every team in the season config has a code, colour and Jolpica ids", () => {
  for (const [name, t] of Object.entries(config("season").teams)) {
    if (name.startsWith("_")) continue;
    assert.match(t.code, /^[A-Z]{3}$/, name);
    assert.match(t.color, /^#[0-9A-F]{6}$/i, name);
    assert.ok(t.jolpica.length, name);
  }
});
