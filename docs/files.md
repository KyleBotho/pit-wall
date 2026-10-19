# Fantasy Pit Wall: file map

Moved out of CLAUDE.md on 2026-10-19. What each file and folder does.

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
  (`history/<season>/weather/`), Kalshi quotes (`quotes/`), Polymarket quotes for every listed race weekend
  (`quotes/gdNN-polymarket.json`, since 2026-10-12, unused yet), the FIA documents index (`fia/`). Also gives the
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
  2014+: position changes, grid-finish correlation, retirements, `qref` = the qualifying reference lap (median of the
  ten fastest best laps; TRACK.speedPrior); OpenF1 2023+: SC, VSC, red, rain, overtakes).
- `web/app.html` + `web/app.css` + `web/js/*.js` — the page. ES modules with explicit imports (since 2026-09-26),
  entry `main.js`; `tools/bundle.js` (esbuild) bundles them and supabase-js from npm into one script that refresh.py
  inlines (so `python refresh.py` needs `npm ci`). Engine and Hindsight stay classic scripts (also used by Node);
  the data is a `<script type="application/json" id="pw-data">` block. A value another module reassigns needs a
  setter in its own module (`setState`, `keepUndo`, `endTeamEdit`, `resetSplit`). `lab.js` = the owner-only Sim lab (item 9 stage 6).
  Challengers never run in a visitor's browser (they're frozen and scored on GitHub), and what only the lab uses
  stays out of the page everyone downloads (user, 2026-09-28): refresh.py `lab_split` moves Model health and the
  challengers' inputs (raceInfo pacePool / scLaps / lapsRun, the priors' scLaps / lapsRun; LAB_KEYS,
  LAB_RACE_FIELDS, LAB_PRIOR_FIELDS) into `lab-<hash>.json` next to index.html (`DATA.labFile`); lab.js `labData`
  fetches and merges it for owners / admins (the worker gets the data again).
  The loader is `lab-data.js` (idle / loading / ready / error with retry; challenger runs wait for it). A new challenger-only input goes into
  those lists. `worker.js` = the engine worker shared by the lab
  and the Calculator (2026-09-28): `compute()` runs non-default sims there (returns false; `setSimDone` redraws),
  and caches runs by their inputs (`simKey`) so blend / xPts / preset changes don't re-simulate. Every derived
  model comes from the variant's own data (the track model per variant, `ctx.tm[v]`: as at lock = the practice
  frozen at lock). Team scores with a chip: `Engine.chipScore` everywhere (Calculator and planner). Each frozen
  challenger records its input coverage, sameAsShipped and evaluable (engine.projectChallengers); Model health scores
  evaluable rounds only. Dark UI, since 2026-09-29 retextured with the user's own Pit Lane 0.2 design system
  (`docs/design/`, docs/ui-system.md "Retexture"); originally modelled on f1fantasytools, inspiration only, never
  their name/logo. Key shared values: `state` (settings), `forecast` (sims and projections from `compute()`),
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
  `history/<season>/accuracy.json`, then `backtest/scorecard.py --json` -> `scorecard.json` (the 2x plan's T1-T3, T3b = T3 with the budget carried from R2,
  Model health's first table) (a sensitivity run, e.g. WX_LATEST=1, keys and writes its own file:
  walk.js CONFIG); `.github/workflows/fit.yml` (Tuesdays 03:30 UTC, ~20 min) runs `fit.js --save`
  into `history/<season>/fit.json`. Both are embedded as `DATA.modelHealth` and shown in the Sim lab's Model health
  panel (`web/js/model-health.js`). The fit only proposes; adopting a setting is a manual engine.js change.
- `backtest/scorecard.py` — the "2x" plan's scorecard (`docs/plans/2x-predictions.md`), from the committed archive
  alone (no cache, no network): T1 CRPS skill over the naive forecast (season-to-date mean + pooled spread; 10.2%
  R5-R17), T2 rank edge within the top-priced assets, T3 fresh-team points vs naive picks, and the retirement floor.
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
  From R17 each projected asset also carries `parts` (engine `projectionParts`: points per category, retirement /
  fastest lap / DotD chances, overtakes, average positions, negatives, constructors' Q bonus and pit points, price
  change chances), for scoring by category against outside sims (private repo `research/competitors/score.py builder`).
- `tools/sync-shared.js` — writes the event tables from `config/feeds.json` into the Supabase function (it's
  deployed by pasting one file); `tests/shared.test.js` fails if they drift. The `refresh` function is pasted the
  same way: after a change to `supabase/functions/refresh/index.ts` the user must deploy it again.
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `docs/reviews/2026-09-27/` — an independent review of the simulator (7/10), its numerical/runtime follow-up and the
  upgrade plan (phases 0-6), then three more rounds (post-upgrade 7.5, second-round 7.8, third-round 7.9; each
  with its evidence JSON). Batch 1 (correctness) done 2026-09-27; batches 2-4 in Open items.
- `supabase/setup.sql` — the sign-in/sync database (item 12), the Sim lab's `owners` gate, and the private leagues:
  `league_data` (one row, the league payload) readable only by accounts in `league_readers` (RLS). Re-runnable in
  Supabase's SQL Editor. Add a reader there (see the comment in the file).
- `backtest/driver_skills.py` (+ `wet_skill.py` = the wet-session hand lists and first check, `skill_fetch.py` =
  lap 1 of every race / 2006-2013 results / sprints from Jolpica, `retire_causes.py` = why each car retired 2023 on,
  from Wikipedia's race tables -> `data/retire_causes.json`): which per-driver skills are stable (2014-2025; history
  2026-09-30). `--save` writes `data/skill_points.json` (past seasons' observations). `wet_detect.py` checks the
  automatic wet-qualifying rule against the hand lists.
- `skills.py` — pure, no fetching: DATA.skills (lab-only, LAB_KEYS) at every build = per-driver edges in places,
  shrunk (`wetQ` wet qualifying, `sprR` sprint finish beyond the grid), from `data/skill_points.json` plus this
  season's finished rounds (refresh.py `load_skills`; a wet qualifying = `quali.wetTyres` >= 0.5 in the round's
  race archive, extras.wet_share). `drivers` = with this season, `base` = past seasons only (walk.js asOf). For
  the `wetskill` / `sprintskill` challengers (SIM.wetSkill / SIM.sprintSkill, engine `skillSteps`).
- `fold.py` + `.github/workflows/fold.yml` + `backtest/season_report.js` — the season fold-over and report
  (Settings > Admin > "Season fold-over and report", `foldNow` in admin.js -> the `refresh` function's
  `{action: "fold"}` -> fold.yml). fold.py rebuilds `data/circuit_priors.json` and `data/skill_points.json`
  through the last finished season (this one only once it's over) and notes it in `history/<season>/fold.json`;
  season_report.js (`npm run report`) compares every challenger with the live model over the season's rounds
  (looking back: walk-forward under its settings, paired per round; at lock: accuracy.json's frozen rounds) into
  `history/<season>/season-report.json`. Shown by `model-health.js seasonReportHtml` in Admin and the Sim lab
  (`DATA.modelHealth.report` / `.fold`, lab-only data).
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
