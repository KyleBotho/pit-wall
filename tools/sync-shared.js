// The Supabase function is deployed by pasting one file into the dashboard, so it can't read config/feeds.json.
// This writes the shared tables into it between the <shared:feeds> markers. tests/shared.test.js fails if they
// drift. Run:  node tools/sync-shared.js
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "supabase", "functions", "live", "index.ts");
const START = "// <shared:feeds> generated from config/feeds.json by tools/sync-shared.js; don't edit here";
const END = "// </shared:feeds>";

function block() {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "feeds.json"), "utf8"));
  const rules = f.evRules.list.map(([k, c]) => `  [${JSON.stringify(k)}, ${JSON.stringify(c)}],`).join("\n");
  return [
    START,
    `const UA = ${JSON.stringify(f.userAgent)};`,
    `const EV_SESSION: Record<string, string> = ${JSON.stringify(f.evSession).replace(/,/g, ", ").replace(/:/g, ": ")};`,
    `const EV_RULES: [string, string][] = [\n${rules}\n];`,
    END,
  ].join("\n");
}

// the file with the block replaced (and whether that changed anything)
function render(src = fs.readFileSync(TARGET, "utf8")) {
  const a = src.indexOf(START.split(" generated")[0]),
    b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`markers missing in ${TARGET}`);
  const out = src.slice(0, a) + block() + src.slice(b + END.length);
  return { out, changed: out !== src };
}

if (require.main === module) {
  const { out, changed } = render();
  if (changed) fs.writeFileSync(TARGET, out);
  console.log(changed ? "updated " + path.relative(ROOT, TARGET) : "already in sync");
}
module.exports = { render };
