import js from "@eslint/js";
import globals from "globals";
import fs from "node:fs";

// The page's scripts (web/js) are plain scripts that share one global scope: web/app.html loads them in order and
// refresh.py inlines them. So a name declared at the top level of any of them is a global for all of them. Collect
// those names here so no-undef still catches typos and leftovers from renames.
const PAGE = "web/js";
const pageGlobals = {};
for (const f of fs.readdirSync(PAGE)) {
  const src = fs.readFileSync(`${PAGE}/${f}`, "utf8");
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) pageGlobals[m[1]] = "writable";
  for (const m of src.matchAll(/^(?:const|let|var)\s+([^;\n]*)/gm))
    for (const n of m[1].matchAll(/(?:^|,\s*)([A-Za-z_$][\w$]*)\s*=/g)) pageGlobals[n[1]] = "writable";
}

const SHARED = "/^(state|forecast|syncState|liveFeed|trackFit|bestRows|stale|DATA|CFG|NEXT|Engine|Hind|SEALED)$/";

const common = {
  "no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-redeclare": ["error", { builtinGlobals: false }],
  eqeqeq: ["error", "smart"],
};

export default [
  {
    ignores: [
      "build/**",
      "build-seasonover/**",
      "cache/**",
      "node_modules/**",
      "history/**",
      "data/**",
      "supabase/**",
      "web/vendor/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["web/js/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...pageGlobals, Engine: "readonly", Hindsight: "readonly", supabase: "readonly" },
    },
    rules: {
      ...common,
      // a local named like the page's shared state silently hides it (a renderLive helper called `state` once did)
      "no-restricted-syntax": [
        "error",
        {
          selector: `:function VariableDeclarator[id.name=${SHARED}]`,
          message: "Shadows a page-wide global; pick another name.",
        },
        {
          selector: `:function > Identifier.params[name=${SHARED}]`,
          message: "Shadows a page-wide global; pick another name.",
        },
        {
          selector: `:function > FunctionDeclaration[id.name=${SHARED}]`,
          message: "Shadows a page-wide global; pick another name.",
        },
      ],
    },
  },
  {
    files: ["engine.js", "hindsight.js", "seal.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.node } },
    rules: common,
  },
  {
    files: ["tests/**/*.js", "backtest/**/*.js", "tools/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: common,
  },
];
