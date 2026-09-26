// Shared test helpers: the latest built data (cache/data.json, written by refresh.py) and the private repo's
// plaintext round history (only on a machine with the private clone).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = (name) => readJson(path.join(ROOT, "config", `${name}.json`));

// the data the site was last built from, with the current config; null if refresh.py hasn't run here
function loadData() {
  const p = path.join(ROOT, "cache", "data.json");
  if (!fs.existsSync(p)) return null;
  const data = readJson(p);
  data.cfg = config("season");
  return data;
}

// history/backfill.json from the private repo: official round points and your own line-ups per round
function loadBackfill() {
  const p = process.env.PIT_WALL_PRIVATE
    ? path.join(process.env.PIT_WALL_PRIVATE, "history", "backfill.json")
    : path.join(ROOT, "..", "pit-wall-private", "history", "backfill.json");
  return fs.existsSync(p) ? readJson(p) : null;
}

// Some of the page's ES modules (web/js), bundled and run in a sandbox with `data` in the page's JSON block. Returns
// run(expr): evaluates expr with the modules' exports in scope. Each call is a fresh page (nothing shared).
function pageModules(files, data, globals = {}) {
  const esbuild = require("esbuild");
  const contents = files.map((f) => `export * from "./web/js/${f}";`).join("\n");
  const code = esbuild.buildSync({
    stdin: { contents, resolveDir: ROOT },
    bundle: true,
    format: "iife",
    globalName: "P",
    platform: "browser",
    write: false,
    logLevel: "error",
  }).outputFiles[0].text;
  const ctx = vm.createContext({
    Engine: require("../engine.js"),
    Hindsight: require("../hindsight.js"),
    document: {
      getElementById: (id) => (id === "pw-data" ? { textContent: JSON.stringify(data) } : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    structuredClone,
    crypto: globalThis.crypto,
    TextEncoder,
    ...globals,
  });
  vm.runInContext(code, ctx);
  return (expr) => vm.runInContext(`with (P) { ${expr} }`, ctx);
}

module.exports = { ROOT, readJson, config, loadData, loadBackfill, pageModules };
