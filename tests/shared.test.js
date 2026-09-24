// Tables that live in more than one place stay identical.
const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../tools/sync-shared.js");
const { config } = require("./helpers.js");

test("the live function's event tables match config/feeds.json (node tools/sync-shared.js)", () => {
  assert.equal(render().changed, false);
});

test("every team in the season config has a code, colour and Jolpica ids", () => {
  for (const [name, t] of Object.entries(config("season").teams)) {
    if (name.startsWith("_")) continue;
    assert.match(t.code, /^[A-Z]{3}$/, name);
    assert.match(t.color, /^#[0-9A-F]{6}$/i, name);
    assert.ok(t.jolpica.length, name);
  }
});
