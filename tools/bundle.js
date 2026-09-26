// Bundles the page's ES modules (web/js, entry main.js) and the npm packages they import (supabase-js) into one
// classic script, written to stdout. refresh.py inlines it into the page. Whitespace and syntax are minified, names
// are kept, so stack traces stay readable. Run:  node tools/bundle.js [entry]
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

function bundle(entry = "web/js/main.js", options = {}) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: "none",
    write: false,
    logLevel: "error",
    ...options,
  });
  return out.outputFiles[0].text;
}

if (require.main === module) process.stdout.write(bundle(process.argv[2]));
module.exports = { bundle };
