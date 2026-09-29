// The colour tokens: app.css :root is the source; core.js TOKENS (charts drawn as SVG strings) must match it, and each
// "-rgb" triple must be its colour.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pageModules } = require("./helpers.js");

const css = fs.readFileSync(path.join(__dirname, "..", "web", "app.css"), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

test("core.js TOKENS match app.css :root", async () => {
  const run = pageModules(["core.js"], { assets: [], schedule: [], done: [], cfg: { teams: {} } });
  const tokens = JSON.parse(await run("JSON.stringify(TOKENS)"));
  for (const [k, v] of Object.entries(tokens)) assert.equal(v.toLowerCase(), (vars[kebab(k)] || "").toLowerCase(), k);
});

test("each -rgb token is its colour", () => {
  for (const k of ["bg", "ctl", "accent", "good", "bad"]) {
    const hex = vars[k].slice(1);
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
    assert.equal(vars[k + "-rgb"], rgb, k);
  }
});

test("no stray purple, green or red outside the tokens", () => {
  const dir = path.join(__dirname, "..", "web", "js");
  const old = /168,\s*85,\s*247|#a855f7|34,\s*197,\s*94|239,\s*68,\s*68|#22c55e|#ef4444/i;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "core.js"))
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), old, f);
  assert.doesNotMatch(css.slice(css.indexOf("}", css.indexOf(":root {"))), old, "app.css outside :root");
});
