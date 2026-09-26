import js from "@eslint/js";
import globals from "globals";

// The page's scripts (web/js) are ES modules with explicit imports, so no-undef catches typos and leftovers from
// renames on its own. Engine and Hindsight are the two classic scripts loaded before the bundle.
const SHARED = "/^(state|forecast|syncState|liveFeed|trackFit|bestRows|stale|DATA|CFG|NEXT|Engine|Hind|LEAGUE_DATA)$/";

const common = {
  "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-redeclare": ["error", { builtinGlobals: false }],
  eqeqeq: ["error", "smart"],
};

export default [
  {
    ignores: ["build/**", "build-seasonover/**", "cache/**", "node_modules/**", "history/**", "data/**", "supabase/**"],
  },
  js.configs.recommended,
  {
    files: ["web/js/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser, Engine: "readonly", Hindsight: "readonly" },
    },
    rules: {
      ...common,
      // a local named like one of the page's shared modules' values silently hides it (a renderLive helper called `state` once did)
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
    files: ["engine.js", "hindsight.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...globals.node } },
    rules: common,
  },
  {
    files: ["tests/**/*.js", "backtest/**/*.js", "tools/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: common,
  },
];
