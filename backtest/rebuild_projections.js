// Rebuilt projections for the finished rounds before the live archive (history/<season>/projections starts at R15):
// the data as it stood before each round (walk.js asOf: results, prices, practice, the market at lock) through
// today's engine with default settings. Written to history/<season>/rebuilt/gdNN.json, the same shape as a frozen
// projection plus `rebuilt: true`. The Hindsight model team uses them where no frozen projection exists.
// Honest caveat: today's settings were fitted on these rounds, so they flatter the model a little.
//   npm run rebuild            every finished round from R2 (R1 had no data: every asset projects the same)
//   npm run rebuild -- 5 6     only those rounds
const fs = require("node:fs");
const path = require("node:path");
const { D, E, asOf } = require("./walk.js");

if (!D) {
  console.error("No cache/data.json: run python refresh.py first.");
  process.exit(1);
}
const dir = path.join(__dirname, "..", "history", String(D.season), "rebuilt");
fs.mkdirSync(dir, { recursive: true });
const want = process.argv.slice(2).map(Number);
const rounds = D.done.filter((g) => g > D.schedule[0].gd && (!want.length || want.includes(g)));
for (const r of rounds) {
  const p = E.project(asOf(r));
  if (!p || p.gd !== r) {
    console.log(`R${r}: no projection`);
    continue;
  }
  // same rounding and key order as refresh.py's frozen files (json.dump indent=1, sort_keys)
  const sort = (o) =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.fromEntries(
          Object.keys(o)
            .sort()
            .map((k) => [k, sort(o[k])]),
        )
      : o;
  const file = path.join(dir, `gd${String(r).padStart(2, "0")}.json`);
  fs.writeFileSync(file, JSON.stringify(sort({ ...p, rebuilt: true }), null, 1) + "\n");
  console.log(`R${r}: ${Object.keys(p.assets).length} assets -> ${path.relative(process.cwd(), file)}`);
}
