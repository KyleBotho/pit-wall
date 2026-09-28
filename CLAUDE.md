# Fantasy Pit Wall — F1 Fantasy 2026

Personal F1 Fantasy planner that replaces an f1fantasytools.com subscription. Live at
https://kylebotho.github.io/pit-wall/ (repo `KyleBotho/pit-wall`, public). That is THE site. The old private Claude
artifact copy (https://claude.ai/artifact/FBsMrxqHKqWBTC9wqytXTF, last version 14) is retired: the user asked on
2026-09-24 to stop republishing it. Don't publish it again unless asked.

## Files
- `refresh.py` — fetches data in stages (`load_schedule`, `load_player_feeds`, `build_assets`, `load_results`,
  `load_playerstats`, `load_practice`, `build_elite`), then `build_page` inlines `web/` into `build/index.html` (GitHub
  Pages). `--offline` rebuilds from `cache/data.json` without
  fetching. Once the season is over `next` is null and nothing is projected.
- `telemetry.py` — item 9's session data with FastF1: `laps` (lap records per session -> `history/<season>/telemetry/
  laps/gdNN.json`; `--telemetry` also caches car/position data), `measure`, `passes` (passes from timing-line crossings
  vs the official overtake lines). Paced (30 s, `--max` 20 downloads a run), stops while any F1 session is live
  (OpenF1 401) and on any failure. Cache in `%LOCALAPPDATA%\pit-wall\fastf1` (never OneDrive or the repo).
- `health.py` — data health checks after each build (`data.health`, `build/health.json`, log with first-seen times in
  `history/<season>/health.json`): problems (results/practice/race data missing, points not certified, no projection
  at lock, unknown scoring events, league history stale) and 3-day notices for mid-season oddities (new or inactive
  cards, team moves, session/venue changes vs the previous build). Shown in Settings > Admin > Data health;
  `tools/health_issue.py` (refresh.yml's `health` job) keeps one "Data health" GitHub issue (label `data-health`) in
  step: opened, a comment (= email) when something new is listed, closed when clear. Public data only.
- `f1feeds.py` — shared feed helpers: paced `get` / `get_soft` / `get_optional` raising `FeedError` (never
  `sys.exit` deep inside), `feed_time`, `ev_code`. `get_soft(meta={})` reports fresh/cached and the real fetch
  time (a `.at` stamp next to the cached copy): odds `at` / `asOf` / `stale`, weather `at` use it, never the
  refresh time. The private repo's `leagues.py` imports it from its checkout.
- `config/season.json` — everything season-specific: teams (code, colour, Jolpica ids), circuit types, field size,
  example team, `fiaNames` (the FIA's event names where they differ; collect.fia_event_path / walk.js fiaFile find
  an event's archive file by any of them, punctuation ignored). Embedded as `DATA.cfg`; update it before a new season. `config/feeds.json` — user agent, pacing,
  scoring-event codes (shared by Python, the page data and the Supabase function).
- `engine.js` — pure JS, no DOM, `// @ts-check` (model rework 2026-09-24, see Model decisions): `buildModel` (pace
  as % off the fastest from qualifying lap times and median clean race laps, DNF, overtake regression, pit points,
  practice blend, parameter uncertainty; `opt.model` overrides `MODEL`), `trackModel` (circuit priors from past
  seasons x this season's level), `withWeather`, `applyOdds` (Kalshi market), `raceSetup` (everything one race's sim
  needs: circuit + forecast rain, model + practice + market, grid penalties, orders already known), `simulate`
  (Monte Carlo weekend: team/driver weekend form, pace/reliability redraws, rain, multi-car incidents, safety car,
  official scoring; `opt.known` / `opt.pen`), `priceStep`, `optimise`, `planHorizon` (race-by-race transfers with
  carry-over and price-driven budget), `project`. Settings in `MODEL`, `SIM`, `TRACK`, each marked fitted /
  backtested / measured / hand-set.
- `hindsight.js` — pure, `// @ts-check`: `Hindsight.create(DATA, Engine)` -> best teams on actual points (`run`,
  `own`, Final Fix `ff`), `score(lineup, gd)`, which rebuilds F1's official round score (42/42 own team-rounds
  + every rival round in the export), `modelTeam(proj)` (a hands-off follower of the projections, see Open items)
  and `track(known, seen, official)`: a team's season from export records where they exist, else the line-up seen
  after each race + the official points (Boost/x3/chip = the plainest combination that rebuilds the score; budget,
  bank, free transfers carried on; see "Round tracking" under Open items).
- `collect.py` — data kept as it happens (refresh.py, fail-soft): forecast vintages + ECMWF ensemble per session
  (`history/<season>/weather/`), Kalshi quotes (`quotes/`), the FIA documents index (`fia/`). Also gives the
  ensemble wet shares behind the weather copula (`weather[gd].ens`). `fia_tech` (2026-09-27): the FIA's technical
  documents read once each (PU elements used / new, Car Presentation Submissions = upgrades, the parc-fermé parts
  list, the Pirelli preview: compounds, Q3 tyre, mandatory race tyres), text kept in `fia/text/<event>/`, summary
  as the event index's `tech`; nothing uses them yet. `backtest/fia_rounds.py` backfilled R1-R15 (`--reparse`
  rebuilds every summary after a parser change) and reads past rounds' stewards' decisions for grid penalties
  (`grid` per document; an unread one is unknown, not "no penalty"). Health warns when a finished round has < 3 kinds read.
- `laps.py` — canonical lap records (OpenF1 laps + stints + race control + weather, with context and quality
  flags) -> `history/<season>/laps/gdNN.json`, the contextual race-pace model (`paceCtx`, MODEL.racePace "ctx") and
  retirement causes (MODEL.dnfModel "causes"). Run by extras.race_info for each finished round; `backfill` / `audit`;
  checks `hier` (the context terms pooled across races) and `inflate` (standard errors on held-out stints).
  `reconcile` (each refresh, once telemetry.py has the round): lap numbers lined up with FastF1's lap times,
  compound + tyre age from FastF1, pace refitted, `lapCheck` in the race block; < 90% agreement = no `paceCtx`.
- `practice.py` — OpenF1 practice laps -> short-run (best lap / best-sector sum) and long-run (5+ lap stints,
  fuel/tyre/compound-corrected) gaps, plus each session's reference lap `ref` (s; the track's average speed). A stint still open (no `lap_end`) runs to the driver's last lap. When OpenF1
  refuses a session, `fastf1_session` reads the same laps from F1's live-timing archive with FastF1 (optional
  dependency, `requirements.txt`; checked 2026-09-24: Baku FP2 short-run gaps identical to OpenF1's).
- `extras.py` — this season's extra inputs, all fail-soft: `calendar` (Jolpica circuit id, coordinates; 2026's
  "Bahrain GP" is at Sepang, so circuit features match on the id first), `race_info` (OpenF1 per finished round:
  SC/VSC/red flag, rain, stop times, median clean-lap race pace; archived in `history/2026/races/`), `weather`
  (Open-Meteo rain probability for qualifying/sprint/race, 16-day range), `odds` (Kalshi winner/podium/top-10/pole
  for the next race, de-vigged; archived at lock in `history/2026/odds/`), `weekend` (race-control grid penalties
  and, once run, the actual qualifying/sprint order from OpenF1).
- `priors.py` — run once per season (before round 1): `data/circuit_priors.json`, one row per past race (Jolpica
  2014+: position changes, grid-finish correlation, retirements; OpenF1 2023+: SC, VSC, red, rain, overtakes).
- `web/app.html` + `web/app.css` + `web/js/*.js` — the page. ES modules with explicit imports (since 2026-09-26),
  entry `main.js`; `tools/bundle.js` (esbuild) bundles them and supabase-js from npm into one script that refresh.py
  inlines (so `python refresh.py` needs `npm ci`). Engine and Hindsight stay classic scripts (also used by Node);
  the data is a `<script type="application/json" id="pw-data">` block. A value another module reassigns needs a
  setter in its own module (`setState`, `keepUndo`, `endTeamEdit`, `resetSplit`). `lab.js` = the owner-only Sim lab (item 9 stage 6). `worker.js` = the engine worker shared by the lab
  and the Calculator (2026-09-28): `compute()` runs non-default sims there (returns false; `setSimDone` redraws),
  and caches runs by their inputs (`simKey`) so blend / xPts / preset changes don't re-simulate. Every derived
  model comes from the variant's own data (the track model per variant, `ctx.tm[v]`: as at lock = the practice
  frozen at lock). Team scores with a chip: `Engine.chipScore` everywhere (Calculator and planner). Dark zinc UI modelled on f1fantasytools (the user's explicit ask); inspiration only,
  never their name/logo. Key shared values: `state` (settings), `forecast` (sims and projections from `compute()`),
  `syncState`, `LEAGUE_DATA` (league_data merged with the linked F1 account's tracked_accounts body,
  `tracking.js mergeLeague`), `Hind`. Team Tracking (phase A, 2026-09-26): `setup.js` = the setup dialog (join code
  from `app_config`, username search, link), Settings' Change/Delete, `pullLink()` after sign-in; `tracking.js` = its
  pure helpers (tested); `rivals.js` = "Manage rivals" (`state.rivals`: tracking-league teams `{ak, tk}`, merged
  into `LEAGUE_DATA` by `setRivals`; private-league members `{lg, tk}`, league readers only; the top-100/500
  templates `{tpl}`, forecast.js `templateTeam`; nobody is a rival by joining; League views ignore them);
  `rivals-view.js` = the "My rivals" tab (Leagues group): next-race head-to-head + differentials (league.js `h2h`,
  `ownTable`, shared with League) and the points race (league.js `pointsRace`, prefix "rv"); `sync.js setAccount/dropAccount/fillTeams`. Calculator: the starting team is `startTeam()` (read-only; `editStart()` returns
  the object to change) = your team `activeTeam()`, a manual team, a rival (key "league / team name") or none, via
  `state.calcStart` (null = auto: your active team, or "No starting team" while it's only an example; `{type:
  "team"}` = picked); pins `state.pins`; xPts edits `state.xo`; xΔ$Pts = `state.xdp` + `state.valW`; max penalty
  `state.maxPen`; the chip played is `activeChip()`.
- The "at lock" view (Engine.atLock) reads DATA.lockSnap: the coming race's weather, practice, bands and penalties
  as frozen at lock by refresh.py `lock_snapshot` (`history/<season>/lock/gdNN.json`, rewritten until lock).
- Sim after lock (user, 2026-09-27): `compute()` runs the live sim (known qualifying/sprint orders, live market) only
  for owners/admins (`labOwner`); everyone else gets it as at lock (`atLock`: practice only, `DATA.oddsLock`), except
  My rivals and Live Scoring, which always use the live one (`withLive`; Live Scoring's xPts = the live sim while its
  round is the next race, else the projection frozen at lock). The Pit Wall preset's label names the race and stage
  ("Pit Wall sim · Monaco post FP2").
- `web/brand/` — logo (renamed "Fantasy Pit Wall" 2026-09-24; repo/URL stay `pit-wall`). Icon SVG = favicon; its
  mark is also the `#pwMark` symbol in app.html (rail/app bar/menu); banner PNG = link preview (og:image);
  apple-touch-icon.png 180px. `build_page` copies the folder to `build/brand/`. Originals from the user (their banner
  SVG drew the mark too big, off the bottom edge; the copy here is re-laid out; their PNGs are right).
- `.github/workflows/refresh.yml` — rebuild + deploy when the refresh function starts it (below), on push, and every 6 h
  as a fallback.
  Commits `history/`, then runs the tests (they gate the deploy). A separate `check` job (pushes only) runs lint,
  formatting, types and ruff, so style never blocks a price refresh.
- Data refresh (live 2026-09-26): `refresh.py refresh_plan` writes `build/refresh-plan.json` (due times after
  each session, before lock, until the race's points are certified, daily). Supabase function `refresh`
  (`supabase/functions/refresh/index.ts`, Verify JWT off, secret `GITHUB_DISPATCH_TOKEN` = fine-grained token,
  pit-wall only, Actions read/write; made 2026-09-26 with 90 days: EXPIRES Fri 2026-12-25, after the season's last
  race; the admin panel shows its expiry and warns 3 weeks ahead) starts refresh.yml when an entry falls due; pg_cron calls it every 5 min
  (setup.sql). Settings > Admin > Data refresh (`web/js/refresh-view.js`) shows status and has Refresh now (admins,
  10 min apart). refresh.yml's own timer is only a 6-hourly fallback.
- `history/2026/` — the season archive, saved as it happens: `players/gdNN.json` raw player feed per finished round
  (read back instead of refetched; the latest round is refetched for late corrections), `playerstats/<id>.json`
  latest per-asset scoring events, `projections/gdNN.json` our default-settings projection, rewritten until lock and
  then frozen (embedded as `DATA.projHist` for projected-vs-actual), `rebuilt/gdNN.json` projections rebuilt after
  the fact for R2–R14 (`npm run rebuild`, flagged `rebuilt`; `DATA.projRebuilt`, used by the model team only),
  `practice/gdNN.json`, `elite/`.
- `tests/` — `node --test` (engine vs brute force, price rule vs real changes, scoring lines, state migrations,
  seal round-trip, shared tables, Hindsight vs official scores when the private clone is next door) and
  `python -m unittest discover tests` (feed helpers, practice, page build incl. season over).
- Model health: `backtest/accuracy.js` (`npm run accuracy`; refresh.py runs it after each fetch, ~3 s, skipped when
  unchanged) scores every certified round (frozen projection vs result, walk-forward CRPS/MAE) into
  `history/<season>/accuracy.json` (a sensitivity run, e.g. WX_LATEST=1, keys and writes its own file:
  walk.js CONFIG); `.github/workflows/fit.yml` (Tuesdays 03:30 UTC, ~20 min) runs `fit.js --save`
  into `history/<season>/fit.json`. Both are embedded as `DATA.modelHealth` and shown in the Sim lab's Model health
  panel (`web/js/model-health.js`). The fit only proposes; adopting a setting is a manual engine.js change.
- `backtest/run.js` (`npm run backtest [section numbers]`) — 1 price rule, 2 track model (leave-one-round-out, circuit
  history weight alpha), 3 retirements, 4 practice weights, 5 calibration by scoring category, 6 THE GATE:
  walk-forward projected points vs actual (CRPS, MAE, coverage, team pick; variants without market/practice/...),
  7 frozen projections vs results, 8 pit-stop rule vs scoring lines, 9 (only on request, minutes) experiments paired
  against the shipped model (`EXP=<group>`, `EXP_GRID=1`), 10 (only on request) ceilings: the sim told the round's
  real answer for one input. `backtest/walk.js` = the shared walk-forward
  harness (`asOf(r)` rebuilds the data as it stood before round r; exact CRPS). `backtest/fit.js` (`npm run fit`) =
  coordinate-descent fit of SIM/MODEL settings on walk-forward CRPS; held out in folds (each of the last 3 rounds
  scored by a fit on the rounds before it), the proposal fitted on every round, each change with how many folds
  agree (Model health). `backtest/practice_rounds.py` and
  `backtest/odds_rounds.py` rebuild `practice_by_round.json` / `odds_by_round.json` (Kalshi prices at each past lock;
  settled events need the `historical/` API, one request per driver). `backtest/weather_rounds.py` ->
  `weather_by_round.json` (rain at each past lock, Open-Meteo previous runs), used by walk.js `asOf` with the
  stewards' penalties published before lock. fit.js holds the last 3 rounds out and scores its proposal on them.
- `tools/presim.js` — the page's default-settings sims, run by `build_page` (Engine.forecastRaces; variants "lock" =
  Engine.atLock and, after lock, "live", whose later races are shared with "lock"): summaries into `DATA.presim`, the
  simulated weekends next to index.html as `presim-<hash>-a.bin` (first 4,000) and `-b.bin` (the other 6,000), one
  byte each + offset, gzipped (~0.6 + 0.85 MB; ~1.9 MB after lock). The page (forecast.js, decoder `web/js/presim.js`)
  waits for part a (max 15 s), then redraws itself once part b is in; any non-default sim setting (`simDefault`) runs
  the sim in the browser as before. `tests/presim.test.js` checks it decodes to exactly the page's own run.
- `tools/freeze.js` — what refresh.py freezes before lock: the projection with its record (commit, settings, seeds,
  input hashes, exact simulate() inputs), the challengers (`Engine.CHALLENGERS`) and, in the last 6 h, 2,000 joint
  samples -> `history/<season>/{projections,challengers,samples}/gdNN.json`. Scored by backtest/accuracy.js.
- `tools/sync-shared.js` — writes the event tables from `config/feeds.json` into the Supabase function (it's
  deployed by pasting one file); `tests/shared.test.js` fails if they drift.
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `docs/reviews/2026-09-27/` — an independent review of the simulator (7/10), its numerical/runtime follow-up and the
  upgrade plan (phases 0-6), then three more rounds (post-upgrade 7.5, second-round 7.8, third-round 7.9; each
  with its evidence JSON). Batch 1 (correctness) done 2026-09-27; batches 2-4 in Open items.
- `supabase/setup.sql` — the sign-in/sync database (item 12), the Sim lab's `owners` gate, and the private leagues:
  `league_data` (one row, the league payload) readable only by accounts in `league_readers` (RLS). Re-runnable in
  Supabase's SQL Editor. Add a reader there (see the comment in the file).
- `elite_import.py` — top-100 line-ups CSV -> `data/elite_top100.json` (anonymous Boost/chip aggregates).
- League payload (Supabase `league_data`, written ONLY by the private repo's workflow): `{v: 2, leagues, names,
  rounds, lineups, rivals, seen}`, keyed by team key. `rounds` = per-round points per team (League chart, Elite season); `lineups` = the user's own teams per
  round (ids, start line-up, boost, x3, budget, bank, free, subs, chip) for Hindsight; `rivals` = the same for league
  rivals (from exports); `seen` = {team: {gd: 7 ids}}, the line-up in each round's last league-feed snapshot (the
  team that scored it), which `Hind.track` works the rest out from. The page loads it after sign-in
  (`pullLeagues`). Until 2026-09-26 it was an encrypted `data/league.sealed.json` unlocked with a passphrase.
- `data/elite_history.json` — real global cut-offs/means per gameday, written by the private workflow (plaintext,
  numbers only). `refresh.py` merges it over the estimated R1–R14 paths in `data/elite_top100.json` `history`.
- Private repo `KyleBotho/pit-wall-private` (local clone `../pit-wall-private`): `leagues.py` + `leagues.yml`
  (every 6 h, hourly Sun–Mon) fetch the private-league feeds and the global top 500, keep plaintext
  `history/<leagueId>/<feedTime>.json` and `history/global/` there, map each snapshot to a gameday via the schedule
  (last round locked before the feed time: feeds update once qualifying is scored, with the new line-ups), upload the league payload to Supabase (`SUPABASE_SECRET_KEY`, only
  when it changed; `state/published.sha256`), and push `elite_history.json` here with the `PUBLIC_REPO_TOKEN` PAT
  (which triggers a rebuild). Secrets `LEAGUE_IDS`, `SUPABASE_SECRET_KEY`, `PUBLIC_REPO_TOKEN` live in that repo
  only. Its runs aren't visible without auth; check for its commits here instead:
  `https://api.github.com/repos/KyleBotho/pit-wall/commits?path=data/elite_history.json`.
  `leagues.py` imports `f1feeds.py` from the public checkout: push this repo before a private change that needs it.

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
- Prettier drops the parentheses of a JSDoc cast before a member access (`/** @type {X} */ (a)[k]`); use a typed
  local instead. `web/app.html` keeps the `__PITWALL_DATA__` placeholder (refresh.py matches it with a regex).

## Commands
- New season: `python priors.py` (adds the finished season to the circuit priors), update `config/season.json`.
- Local preview: `.claude/launch.json` "pit-wall-build" serves `build/` on :8765.
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

## Data sources (all public, no login)
- `fantasy.formula1.com/feeds/...`: `schedule/raceday_en.json`, `drivers/{gameday}_en.json` (prices, points, ownership),
  `popup/playerstats_{PlayerId}.json` (per-race scoring events). No CORS — only server-side fetches work.
- Jolpica `api.jolpi.ca/ergast/f1/2026/{results,qualifying,sprint}.json` (qualifying Q1-Q3 times -> `gap` % per
  driver), `/2026.json` (circuit ids, coordinates) and past seasons (priors.py).
- OpenF1 per race: `race_control` (SC/VSC/red, grid penalties, incidents), `weather` (rain), `pit`, `stints`, `starting_grid`, `laps`
  (race pace), `session_result` (qualifying order once run). `overtakes` exists for 2023-2025 only.
- Kalshi `api.elections.kalshi.com/trade-api/v2` (public reads, no key): series KXF1RACE (winner), KXF1RACEPODIUM,
  KXF1TOP10, KXF1POLE; events `<series>-<AZEGP26>`. Settled markets move to `/historical/markets` (plain price fields).
- Open-Meteo `api.open-meteo.com/v1/forecast` (no key): hourly precipitation probability; `ensemble-api.open-meteo.com`
  (ECMWF IFS, 51 members) for the joint wet chance of the weekend's sessions.
- FIA documents (`fia.com/documents/championships/fia-formula-one-world-championship-14`, HTML, slow ~30 s): the
  decision documents index, fetched around race weekends (collect.py). The car-infringement PDFs are read once each
  (pypdf) for GRID PENALTIES: race control (OpenF1) announced none in 2026, so this is the only source.
- FastF1 (pip) reads `livetiming.formula1.com/static` — the fallback for practice when OpenF1 is locked.
- Grid penalties: stewards' decisions (collect.fia_penalties) + race control + the manual picker in Settings >
  Circuits. Not automated: PU mileage / tyre sets from the FIA documents.
- OpenF1 `api.openf1.org/v1/{sessions,laps,stints,drivers}` (practice; free data lands shortly after sessions).
  While ANY F1 session is live, OpenF1 returns 401 for everything (paid key only). `refresh.py` uses `get_soft`
  for it: one attempt, cached copy on failure, never aborts the build (seen 2026-09-24 during Baku FP1).
- The old `fantasy-api.formula1.com` API (Postman doc, dlthub, skelmis package) is dead since 2023 — don't use.
- Private-league standings come from the private repo (above), via Supabase. Chips, bank and free transfers are
  logged-in data and are NOT fetched by code (checked 2026-09-25: `services/user/opponentteam/...` and
  `services/user/gameplay/.../getteam` answer 401 without a session). Exports give them exactly; after the last
  export `Hind.track` works them out from the public feeds (Round tracking). The user collects an
  export with Claude for Chrome for `backfill.py` (private repo); the page's Import button was removed on 2026-09-26
  (Team Tracking replaces it; an older import saved in `state.league` is still read).
  Never put league or personal data into the repo/site, and never handle the user's F1 login or tokens.

## Model decisions (backtested — keep unless new evidence; `npm run backtest` reproduces the evidence)
Model rework 2026-09-24/25 (user asked for a sim review, scored 7/10, then "implement all the improvements, including
the additional data sources", plus his own idea: circuit priors carry a SEASON TREND, restarted every season).
- The gate is backtest section 6: walk-forward R5-R14, exact CRPS of projected points (plus MAE, coverage, team pick).
  Paired against the previous engine (git 8c14f43) at 10,000 sims: ΔCRPS +0.02 ± 0.11, ΔMAE +0.08 ± 0.16 — a TIE on
  points within noise; better on race positions (race MAE 2.91 vs 3.05 places, from lap-time pace); qualifying about
  the same (1.737 vs 1.735). The rework's value is structure (correlated team form, SC, rain, market, uncertainty,
  penalties, known grid) and features, not a measured points gain yet. 10 rounds can't separate ±0.1.
- Section 6 now (2026-09-27, R5-R15, third review: only forecasts issued before lock, stewards' penalties published
  before lock): CRPS 8.674, MAE 11.86 (drivers 10.36, constructors 14.87), bias +1.12 (the overtake level forecast,
  see Overtakes), rank corr 0.73, 81% / 53% inside the 10-90% / 25-75% ranges; baselines: season average 13.44,
  recent form 13.84. Before review batch 1: CRPS 8.76, MAE 12.13, 85% / 56%.
- Recent-form blend: default 0 (was 0.3; +30% form is worse on every metric). State schema 4 resets it.
- Pace: % off the fastest. Qualifying from Jolpica Q1-Q3 times (per-session gap to that session's fastest, averaged);
  race from OpenF1 median clean race lap (fallback: finishing rank x 0.1%). Team-mate prior 1.5 races, gaps capped at
  4%, then shrunk 0.8 towards the field median (fitted). Nudges in places convert with the field's %/place.
- Sim (fitted by `npm run fit`, exact CRPS, one pass): qualifying noise 0.2%, race 0.15%, team weekend form 0.1%,
  driver weekend form 0.08%, grid slot cost 0.07% (scaled by the circuit's grid-finish correlation), pace/reliability
  redraw x1, incidents 15% of retirements, SC noise x1.35. Hand-set: rain noise x1.6 / retirements x1.4, SC per
  retirement 0.15, sprint scalings. Many of these sit on a flat optimum (differences < noise).
- Market (Kalshi win/podium/top-10/pole, next race only): pace moved in log-odds towards the market at weight 0.5
  (0.25-0.5 tie on CRPS; 0.5 best MAE; 0 best CRPS by 0.05 in one run — noise level). R5-R14 odds at lock rebuilt.
- Practice: short-run 50% into qualifying pace (0.6 ties), pull cap 0.8%; long-run 0 (race pace from laps beats it).
- Overtakes: Poisson regression on log(1 + |places moved|) and grid slot with the round's level as offset, plus each
  driver's skill (shrunk, 12 pseudo-overtakes). In 2026 overtakes track places MOVED, not net places gained (swaps).
  Retired cars keep the ones made before stopping (2026-09-27): own intercept, exposure phi + (1 - phi) x share of the
  race run (phi 0.35 fitted: the start counts), share drawn from this season's retirements; non-starters none. The
  sim now hits the circuit's level; the level forecast itself runs high (+0.54 per driver R5-R15, early rounds had
  more overtaking), within noise.
  Sprint share of race overtakes swings 0.17-0.92 between sprints: measured, shrunk to 0.4 with 3 pseudo-sprints.
- Weather (2026-09-27): wet sessions from a Gaussian copula, rho from the ECMWF ensemble (else SIM.rainCorr 0.3,
  hand-set; independent sessions were +0.015 CRPS). Negative rho (sessions pulling apart) is sampled too, since
  the second review (Cholesky, to -0.5). Pit: band points resampled per team, the +5 fastest stop to
  one team a race (SIM.pitBonus). The Calculator's races share each sample's car strength (opt.persist).
- Pit points: resample the team's own pit scoring lines (R FP/FP2) over the last 8 races. OpenF1 stop times match
  the official bands only 42/62 team-races (rounded, not DHL timing), so they're archived but not used.
- Track (section 2, leave-one-round-out): circuit history is barely predictive in 2026 (rank corr −0.2..0.2 with this
  season's per-circuit overtakes, grid influence, SC). Fitted weights of each circuit's own history (TRACK.alpha):
  retirements 1 (+7% vs flat), overtakes/SC/grid influence 0 (history made them worse). History still sets the level
  before a season has rounds (trend shrink 3 pseudo-rounds) and the rain climatology. Trend this season vs the same
  circuits: position changes x0.95, retirements x1.52, SC x1.14, grid-finish corr +0.04. Re-run section 2 each
  season: the new-regs effect may fade.
- Overtake level of the next race (2026-09-25, item 9 stage 2): from its practice average speed (TRACK.speed, see
  the to-do list); a flat season level for races without practice yet.
- Price rule: average over the races in the last three rounds, a round sat out isn't a zero (`Engine.priceBase`):
  493/495 (the two misses: R8, likely points corrected after prices). Unchanged: DNF team rate shrink k=16 no recency
  (log loss 0.4608), official scoring.
- Tried and rejected 2026-09-25 (section 9): skewed session noise, car + driver-offset team-mates, the fastest-lap
  market. All ties or worse; see the to-do list Also the lap-by-lap and timing-segment races
  (item 9 stages 3a/3b, SIM.raceModel): ties on points, worse on race positions.
- Known gaps (section 5, 2026-09-27): places lost too few (−0.23 vs −0.56), fastest lap / DotD slightly too spread
  (87% / 91% to the top seven vs 100% / 93%). Overtakes at a neutral track now match (4.67 vs 4.70).
- Default 10,000 sims per race × next 3 races (~1 s in the browser). Optimiser enumerates all teams; `planHorizon`
  beam-searches race-by-race plans (~0.5 s); goals "beat a rival / the top-100 template" re-rank by P(beat).
- vs rhter's Baku sim (f1fantasytools, old engine): MAE 4.6; we're higher on Alpine/midfield, lower on Ferrari.

## Open items — next session starts here
Everything finished, with the reasoning and evidence behind it, is in `docs/history.md` (dated entries). Search
there before re-deciding something.

- [ ] Second review (`docs/reviews/2026-09-27/F1-post-upgrade-review.md`, 7.5/10): findings A-G fixed
      2026-09-27 (history). Open from it: the market fit is still MOVING after 4 steps (0.3-0.4 log-odds off the
      targets, the Calculator now says so): more steps = a higher effective market weight, decide with a backtest.
      Sections 4-8 done the same day (history); left: adaptive sampling, a Calculator worker, a stochastic chip /
      transfer policy, hierarchical pace + survival models. Don't retune on the same R5-R15: wait for frozen rounds.
- [ ] Third review (`docs/reviews/2026-09-27/F1-second-round-review.md`, 7.8/10): all five findings fixed
      2026-09-27 (history). Its advice: no new features now; leave this version running and judge it on the frozen
      rounds from R16 (champion vs challengers in Model health).
- [ ] Fourth review (`docs/reviews/2026-09-27/F1-third-round-review.md`, 7.9/10, 2026-09-28): all five findings
      fixed the same day (history: frozen sims' circuit model, chip-aware planner, adaptive-sampling margin, accuracy
      config key, FIA PU-ANC / event names / past penalties, DSQ). Its advice, still open: keep the default and the
      challenger set stable; score prospective rounds by WEEKEND (the independent unit), including paired team
      differences and realistic transfer policies; "5 rounds and 2 SE" is not a true 95% test with several
      challengers and repeated looks. Every research result should name its input snapshot, code and config.
      Weather calibration (past-seasons item 1): check each forecast's PUBLIC AVAILABILITY time before lock, not
      just its model run time (Open-Meteo's previous-runs archive mostly starts Jan 2024, ECMWF HRES single runs Mar
      2024), and check coverage for our exact variable / model / location. Normal equations are fine while fits are
      well conditioned (QR / SVD only if not).
      UNFINISHED: the past rounds' stewards' decisions (grid penalties for walk.js) are mostly unread: on
      2026-09-28 the FIA site answered 504 / 502 to nearly every PDF. Re-run `python backtest/fia_rounds.py`
      (reads only what's missing) until it prints no "not read" lines, then commit history/2026/fia.
- [ ] Deferred from the reviews (checked 2026-09-27: none built unless noted). Build one only when the frozen
      rounds show the error it addresses, and judge it as a challenger:
  - Market fit: now the challenger `odds8` (SIM.oddsIters 8, SIM.oddsN 5000; 2026-09-27), scored from R16. Found
    while adding it: more steps help little, the residual levels off by ~step 6 (R13 0.42 -> ~0.35, R15 0.31 ->
    ~0.27) because one pace per driver can't meet win, podium and top 10 together (the market sees a wider spread
    of results). If the market matters, the lever is a per-driver spread (variance) fitted to the market too.
  - Models: chip timing across races (the planner plays a chip in the first race only). DONE 2026-09-28: the
    stochastic planner (Engine.planStoch: plans valued over the simulated futures, a later transfer made where it
    fits, else the team held; replaces the 90% afford gate; chips scored per future by Engine.chipScore, fourth
    review). DEFERRED 2026-09-28 for want of evidence (not shown useless; fourth review corrected the records): a
    hierarchical race-pace model (laps.py `hier`: pooling moved a driver by max 0.161% (R6), mean <= 0.044%; the
    review's screen, pooled vs unpooled: CRPS -0.006 +/- 0.010, inconclusive; before a challenger: residuals by
    stint / compound, race-stint resampling, actual compounds across races), timed SC events (the matching-event
    check explained the coverage gap, but onset / duration / pit timing are untested; look at race control's SC
    windows first), retirements by distance / confirmed cause (sprints: 7 unclassified of 110 entries incl. 2 DNS,
    5 of 108 starters, too few to tell 0.36 / 0.40 / 0.45 apart; separate DNS / DSQ / incident / mechanical; causes:
    no AUTOMATED source, a small hand-checked labelled subset would be the start). DONE 2026-09-28: settings are values, not shared state (engine.js
    withSettings swaps in a changed copy; Engine.SIM / MODEL / TRACK are read-only views, a write throws; the fit,
    section 9 and the tests go through withSettings). Checked output-identical (8 switch sets x 4 races, hashes).
  - Sampling and speed: the precision of quantile ranges. DONE 2026-09-28: the Calculator's own runs (and its
    near-tie check) in the engine worker (web/js/worker.js); adaptive sampling: the independent check run grows by
    a batch while one of the top six ranked teams is within its margin of #1 (Engine.lookZ over the looks, 2.58)
    and that margin is wider than ±0.5 pt (forecast.js checkSim grow, CHECK_MAX 50,000; calc.js simNoise).
  - Evaluation: DONE 2026-09-28: MODEL.ctxSeInflate data-informed from odd vs even stints (laps.py `inflate`: 1.85,
    per round 0.05-3.07, ~1.47 without R8; not an untouched hold-out; keeps 2);
    outcome groups (wet / SC) scored against the matching simulated races (sim.ev), SC / rain forecast calibration
    in section 6 (rain runs high: 25% vs 9%, one wet race; wait for the weather vintages). Repeated
    held-out folds for the weekly fit (fit.js), the real condition number in the fit log (eigenvalues). DONE
    2026-09-27: calibration by group (walk.js `groups`: drivers / constructors, sprint / normal, wet / dry,
    safety car or not) in section 6 and Model health (walk-forward + frozen). First read, R5-R15: SC races
    under-covered (74% / 43% in the 10-90 / 25-75% ranges), no-SC races projected +2.6 too high. Not retuned:
    watch it on the frozen rounds.
  - Data: tyre-set inventory (not in the FIA documents). DONE 2026-09-27: PU elements, upgrades, parc-fermé parts
    and tyre choices from the FIA documents (collect.py `fia_tech`), R1-R15 backfilled. The `oddsq` challenger
    needs Kalshi spreads (bid/ask are archived in quotes/ from R16).
- [ ] Past seasons' data where the 2026 rules didn't change it (user, 2026-09-28; the sim already takes circuit priors
      from 2014+, which helped only retirement levels and rain climatology). Each as a prior, judged walk-forward on
      2026 like everything else; not pace / team order, tyre and fuel effects, overtaking (no DRS) or the
      reliability level (new PUs). In this order:
  1. Rain forecast calibration: our rain chance runs high (25% forecast vs 9% seen R5-R15, one wet race). 2023-2025
     races give ~70 with OpenF1's observed rain. FIRST check that forecasts as they stood before lock exist for
     them (Open-Meteo's previous-runs archive was thin for 2026's early rounds, backtest/weather_rounds.py); if
     only after-the-fact forecasts exist, it can't be done honestly. The most valuable: rain drives spread,
     retirements and qualifying.
  2. Sprint vs race retirement ratio and when retirements happen: 2023-2025's ~18 sprints to pin SIM.sprintDnf
     (hand-set 0.4; 2026's 5 sprint retirements among 108 starters can't tell 0.36 / 0.40 / 0.45 apart) and the
     start-spike + per-lap shape; the level stays 2026's (the new PUs fail about twice as often). Count entries,
     starts, laps at risk, DNS, DSQ separately; a late stop that's still classified is censored, not a zero hazard.
  3. Retirement causes: Jolpica has detailed statuses up to ~2022 ("Collision damage", "Power Unit", "Undertray";
     a few in 2023; 2024-2026 mostly "Retired"): a weak prior for the mechanical / incident split with an era
     effect (now: race control's incidents only); unknowns stay unknown, "no incident message" is not "mechanical".
  4. The sim's noise settings (qSd, rSd, teamSd, drvSd, tau, SC noise): how results scatter around pace, fitted on
     2022-2025 (the previous car rules, ~90 races vs 2026's 11; the fitted values sit on flat optima). The biggest
     job (the backtest harness is built on 2026 fantasy data): a winter project, the results priors to confirm on
     2026.
- [ ] Independent review (`docs/reviews/2026-09-27/`): batches 1-4 DONE 2026-09-27 (history). Watch from R16 on,
      all automatic: the frozen record + samples at lock; challengers (qskew2, ovhl6, racectx, dnfcauses, ovenv)
      scored in Model health after certification (adopt one only after 5+ rounds and a gain beyond 2 SE); lap
      records, FastF1 archive, weather vintages + ensemble, Kalshi quotes, FIA index arriving on their own (health
      warns on the lap model and ensemble). Later, with the data: calibrate forecast rain vs observed session
      weather (weather/ + races/ wx), market-quote quality weights (quotes/), grid penalties from FIA documents.

- [x] Autonomy steps 1-3 done 2026-09-26 (docs/history.md): session-aware refresh + Refresh now, data health +
      the Data health issue, model health (accuracy per round + weekly fit proposals in the Sim lab). Still to see
      live: the first Data health issue, the first weekly fit (Tue 2026-09-29), R16 scored automatically.
- [ ] Team Tracking (`docs/team-tracking-plan.md`): phase A built 2026-09-26 (public data; see docs/history.md).
      Phase B (the FPW account's session, members visible before their first race) waits for the session-check
      results around 2026-10-09. The tracking league is the `LEAGUE_IDS` entry marked `<id>:<Name>:track`.
- [x] Rivals (`docs/team-tracking-plan.md`, "Rivals"), 2026-09-26: Manage rivals (tracking-league teams, your private
      leagues' members, the top-100/500 templates), Calculator start team and goal, and the "My rivals" tab; all
      checked working by the user, including a tracking-league rival.
- [x] 2026-09-26 "option 1": signing in unlocks the leagues (Supabase `league_data` behind `league_readers` RLS);
      the passphrase, `seal.js` and `data/league.sealed.json` are gone. Old sealed files stay in git history
      (encrypted; left in place rather than rewriting history). The security review's items 1-9 are done too
      (docs/history.md, "Recently finished"). Next is the Team Tracking TO DO above: per-user teams and access.
- Workflow (item 9 of that review): actions are pinned to release commit SHAs (tag in a comment; bump them by hand
  when a runtime is retired). `refresh` runs our code with a read-only token and hands `history/` to the `history`
  job, the only one that can push; `deploy` needs `refresh` (the tests).
- [ ] Pit Wall F1 account (history: Round tracking): around 2026-10-09, or as soon as a check run fails, read
      `history/session-check.csv` in `../pit-wall-private` (`git pull` first). The first failing day = the session's
      lifetime; then decide with the user whether account-based tracking can run unattended.
- [x] After Baku (R15), all checks done 2026-09-26 (docs/history.md: Round tracking, To do, Feature plan 6 and 11):
      line-ups explain R15 for all 9 league teams once feeds map to the last LOCKED round (they update after
      qualifying, with the new line-ups; fixed in leagues.py and refresh.py); live league standings fixed (they
      counted qualifying twice); practice weights unchanged; backtest 6/7 run. rhter's sims vs ours: private repo only
      (`research/rhter-comparisons.md`, `research/score_rhter.py`); never copy the numbers here.
- [ ] After each round: automatic since 2026-09-26 (Model health: accuracy per certified round, the weekly fit's
      proposal). What stays manual: deciding on a fit proposal, and the rhter comparison when he posts (private repo).
- [ ] Item 9, the lap-by-lap race model (history: To do, item 9): stages 2-5 built and backtested (most off by
      default; see Model decisions), the Sim lab tab is live. Still to do there: the later stages in the plan. The
      server-side locks (owner-only results table, rerun via an edge function) aren't needed while the lab runs in the
      browser (design change 2026-09-25, history: item 9 stage 6); revisit if a slow model is adopted (runs move to
      CI) or the lab's results/code should go private.

Private league IDs are never written into this public repo: anyone holding one can read that league's feed,
manager names included. They live in the `LEAGUE_IDS` secret and the private repo.
