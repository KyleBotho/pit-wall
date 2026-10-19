# Fantasy Pit Wall — F1 Fantasy 2026

Personal F1 Fantasy planner that replaces an f1fantasytools.com subscription. Live at
https://kylebotho.github.io/pit-wall/ (repo `KyleBotho/pit-wall`, public). That is THE site. The old private Claude
artifact copy (https://claude.ai/artifact/FBsMrxqHKqWBTC9wqytXTF, last version 14) is retired: the user asked on
2026-09-24 to stop republishing it. Don't publish it again unless asked.

## Rules
- Never put league or personal data into the repo or the site, and never handle the user's F1 login or tokens.
- Private league IDs are never written into this public repo: anyone holding one can read that league's feed,
  manager names included. They live in the `LEAGUE_IDS` secret and the private repo. rhter's sims and numbers stay
  in the private repo too.
- Public data only, no login. Fetch through `f1feeds.py` (paced `get` / `get_soft`, `FeedError`, never
  `sys.exit` deep inside). While any F1 session is live OpenF1 answers 401, so its fetches use `get_soft` and
  never abort the build. The old `fantasy-api.formula1.com` API is dead: don't use it.
- FastF1's cache lives in `%LOCALAPPDATA%\pit-wall\fastf1`, never OneDrive or the repo.
- Model defaults are backtested: change one only with new evidence from `npm run backtest`, and don't retune on
  the same R5-R15 rounds. Try a new idea as a challenger, not a new default.

## Where to look
- Starting or continuing the to-do list: `docs/open-items.md`.
- Before re-deciding anything: search `docs/history.md` (finished work, with reasons and evidence).
- Before editing or adding a file: `docs/files.md` (what each file and folder does).
- Before changing a fetcher or adding a source: `docs/data-sources.md`.
- Before changing engine settings, the sim or the challengers: `docs/model-decisions.md`.
- UI work: `docs/ui-system.md` and `docs/design/`.

## Code conventions (2026-09-24 review)
- Page modules import what they use, so ESLint's no-undef catches typos; `eslint.config.mjs` also forbids locals that
  shadow the shared values (`state`, `forecast`, …): a `renderLive` helper called `state` once broke Live Scoring.
  Tests load modules through `tests/helpers.js` `pageModules()` (bundled into a vm sandbox).
- Saved settings go through `loadState()` (`web/js/state.js`): bump `SCHEMA` and add a `MIGRATIONS` step for any
  shape change; `CARRY` lists what survives into a new season. `defaults()` returns fresh objects.
- Only the visible view renders: after a change call `rerender()` (all views stale, visible one redrawn) or
  `refreshViews([...])`. Clicks/changes/inputs dispatch through the `CLICK` / `CLICK_ID` / `CLICK_ON` (non-button
  targets by selector) / `CHANGE` / `INPUT_ID` tables in `main.js`; add an entry rather than a branch.
- engine.js's big functions are split into named stages (2026-09-26): `simulate` = `simState` + `lapCalib` +
  `simSample` (`qualiOrder`, `raceSession`) + `simSummary`; `trackModel` = `circuitPriors`, `seasonTrend`,
  `featureResiduals`, `scOvertakes`, `teamTrackPace`, `speedFit`; `buildModel` = `reliability`, `paceObservations`,
  `paceEstimates`, `applyPractice`, `constructorModels`. The split was checked output-identical (seeded sims, 8
  switch combinations x 4 races); check any engine refactor the same way.
- How-it-works text goes in an ⓘ popover, not a paragraph on the page (user, 2026-09-26): static ones as
  `<details class="info">` in the title row, dynamic ones via a `<span class="tipslot">` filled with core.js
  `infoTip(html)`. What the user must see stays visible: status (data as of…), warnings, instructions to act.
- UI system (2026-09-28): `docs/ui-system.md`. The Calculator and Live Scoring are the reference look; other pages
  are brought in line with them. Colours only from the `app.css :root` tokens (Pit Lane 0.2 values: one green,
  one red, one purple; charts in JS read core.js `TOKENS`, tests/tokens.test.js); a retexture keeps layouts,
  control sizes and fonts. Page templates: Workspace (`main.ws`: Calculator, Hindsight;
  main.js `PANE_KEY`), Board, Table. Panel names and heat colours stay as they are (user); rename alternatives noted.
- Prettier drops the parentheses of a JSDoc cast before a member access (`/** @type {X} */ (a)[k]`); use a typed
  local instead. `web/app.html` keeps the `__PITWALL_DATA__` placeholder (refresh.py matches it with a regex).

## Commands
- New season: after the last race press Settings > Admin > "Fold over and make the report" (or `python fold.py`:
  the finished season into the circuit priors and the skill challengers' past observations, plus the season
  report), then update `config/season.json` for the new season.
- Local preview: `.claude/launch.json` "pit-wall-build" serves `build/` on :8765. With league data (sign-in doesn't
  work locally): `python tools/dev_league.py` (reads ../pit-wall-private; writes the gitignored
  build/dev-league.json), then open `http://localhost:8765/?league`.
- Rebuild locally: `python refresh.py` (run from this folder; `PYTHONIOENCODING=utf-8` on Windows bash);
  `python refresh.py --offline` rebuilds the page from the last fetch (page/CSS/JS edits).
- Checks: `npm run check` (ESLint, Prettier, tsc on engine/hindsight, node tests; `npm install` once),
  `python -m unittest discover tests`, `ruff check . && ruff format --check .`. `npm run backtest` for the model.
- After editing `config/feeds.json`: `node tools/sync-shared.js`, then redeploy the Supabase function.
- Deploy: commit and `git push` (Git Credential Manager handles auth; no gh CLI). Pages rebuilds on push.
  `git pull --rebase` first: both workflows push to main (history, elite history).
- After a fresh F1 Fantasy export (Claude for Chrome -> `Downloads/f1fantasy_official_data_<date>.json`): in
  `../pit-wall-private` run `python backfill.py "<that file>"` and push. It rewrites `history/backfill.json` (round
  points R1+ and every team's per-round records: yours and league rivals'), and the push triggers a reseal. Between
  exports the page works rounds out from the league feeds (Round tracking).
- Check a CI run without auth: `https://api.github.com/repos/KyleBotho/pit-wall/actions/runs?per_page=3`.
