// Shared test helpers: the latest built data (cache/data.json, written by refresh.py) and the private repo's
// plaintext round history (only on a machine with the private clone).
const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { ROOT, readJson, config, loadData, loadBackfill };
