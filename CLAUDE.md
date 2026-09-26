# Fantasy Pit Wall — F1 Fantasy 2026

Personal F1 Fantasy planner that replaces an f1fantasytools.com subscription. Live at
https://kylebotho.github.io/pit-wall/ (repo `KyleBotho/pit-wall`, public). That is THE site. The old private Claude
artifact copy (https://claude.ai/artifact/FBsMrxqHKqWBTC9wqytXTF, last version 14) is retired: the user asked on
2026-09-24 to stop republishing it. Don't publish it again unless asked.

## Files
- `refresh.py` — fetches data in stages (`load_schedule`, `load_player_feeds`, `build_assets`, `load_results`,
  `load_playerstats`, `load_practice`, `build_elite`), then `build_page` inlines `web/` into `build/index.html` (GitHub
  Pages) and `build/pit-wall.html` (retired artifact copy). `--offline` rebuilds from `cache/data.json` without
  fetching. Once the season is over `next` is null and nothing is projected.
- `telemetry.py` — item 9's session data with FastF1: `laps` (lap records per session -> `history/<season>/telemetry/
  laps/gdNN.json`; `--telemetry` also caches car/position data), `measure`, `passes` (passes from timing-line crossings
  vs the official overtake lines). Paced (30 s, `--max` 20 downloads a run), stops while any F1 session is live
  (OpenF1 401) and on any failure. Cache in `%LOCALAPPDATA%\pit-wall\fastf1` (never OneDrive or the repo).
- `f1feeds.py` — shared feed helpers: paced `get` / `get_soft` / `get_optional` raising `FeedError` (never
  `sys.exit` deep inside), `feed_time`, `ev_code`. The private repo's `leagues.py` imports it from its checkout.
- `config/season.json` — everything season-specific: teams (code, colour, Jolpica ids), circuit types, field size,
  example team. Embedded as `DATA.cfg`; update it before a new season. `config/feeds.json` — user agent, pacing,
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
- `web/app.html` + `web/app.css` + `web/js/*.js` — the page. Plain scripts sharing one global scope, loaded in
  the order app.html lists them (core, state, sync, forecast, import, league, elite, filters, hindsight-view, stats,
  live, calc, views, lab, main). `lab.js` = the owner-only Sim lab (item 9 stage 6). Dark zinc UI modelled on f1fantasytools (the user's explicit ask); inspiration only,
  never their name/logo. Key globals: `state` (settings), `forecast` (sims and projections from `compute()`),
  `syncState`, `SEALED`, `Hind`. Calculator: the starting team is `startTeam()` (read-only; `editStart()` returns
  the object to change) = your team `activeTeam()`, a manual team, a rival (key "league / team name") or none, via
  `state.calcStart`; pins `state.pins`; xPts edits `state.xo`; xΔ$Pts = `state.xdp` + `state.valW`; max penalty
  `state.maxPen`; the chip played is `activeChip()`.
- `web/brand/` — logo (renamed "Fantasy Pit Wall" 2026-09-24; repo/URL stay `pit-wall`). Icon SVG = favicon; its
  mark is also the `#pwMark` symbol in app.html (rail/app bar/menu); banner PNG = link preview (og:image);
  apple-touch-icon.png 180px. `build_page` copies the folder to `build/brand/`. Originals from the user (their banner
  SVG drew the mark too big, off the bottom edge; the copy here is re-laid out; their PNGs are right).
- `.github/workflows/refresh.yml` — rebuild + deploy every 30 min Thu–Sun, every 6 h Mon–Wed, on push, and manually.
  Commits `history/`, then runs the tests (they gate the deploy). A separate `check` job (pushes only) runs lint,
  formatting, types and ruff, so style never blocks a price refresh.
- `history/2026/` — the season archive, saved as it happens: `players/gdNN.json` raw player feed per finished round
  (read back instead of refetched; the latest round is refetched for late corrections), `playerstats/<id>.json`
  latest per-asset scoring events, `projections/gdNN.json` our default-settings projection, rewritten until lock and
  then frozen (embedded as `DATA.projHist` for projected-vs-actual), `rebuilt/gdNN.json` projections rebuilt after
  the fact for R2–R14 (`npm run rebuild`, flagged `rebuilt`; `DATA.projRebuilt`, used by the model team only),
  `practice/gdNN.json`, `elite/`.
- `tests/` — `node --test` (engine vs brute force, price rule vs real changes, scoring lines, state migrations,
  seal round-trip, shared tables, Hindsight vs official scores when the private clone is next door) and
  `python -m unittest discover tests` (feed helpers, practice, page build incl. season over).
- `backtest/run.js` (`npm run backtest [section numbers]`) — 1 price rule, 2 track model (leave-one-round-out, circuit
  history weight alpha), 3 retirements, 4 practice weights, 5 calibration by scoring category, 6 THE GATE:
  walk-forward projected points vs actual (CRPS, MAE, coverage, team pick; variants without market/practice/...),
  7 frozen projections vs results, 8 pit-stop rule vs scoring lines, 9 (only on request, minutes) experiments paired
  against the shipped model (`EXP=<group>`, `EXP_GRID=1`), 10 (only on request) ceilings: the sim told the round's
  real answer for one input. `backtest/walk.js` = the shared walk-forward
  harness (`asOf(r)` rebuilds the data as it stood before round r; exact CRPS). `backtest/fit.js` (`npm run fit`) =
  coordinate-descent fit of SIM/MODEL settings on walk-forward CRPS. `backtest/practice_rounds.py` and
  `backtest/odds_rounds.py` rebuild `practice_by_round.json` / `odds_by_round.json` (Kalshi prices at each past lock;
  settled events need the `historical/` API, one request per driver).
- `tools/sync-shared.js` — writes the event tables from `config/feeds.json` into the Supabase function (it's
  deployed by pasting one file); `tests/shared.test.js` fails if they drift.
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `supabase/setup.sql` — the sign-in/sync database (item 12) and the Sim lab's `owners` gate. Re-runnable in
  Supabase's SQL Editor.
- `seal.js` — AES-256-GCM + PBKDF2-SHA256 (250k) sealing of stdin with `LEAGUE_KEY`; the page's `unseal` mirrors it
  (`tests/seal.test.js`). Used by the private repo's workflow, which checks this repo out.
- `elite_import.py` — top-100 line-ups CSV -> `data/elite_top100.json` (anonymous Boost/chip aggregates).
- `data/league.sealed.json` — encrypted `{leagues, rounds, lineups, rivals, seen}`, written ONLY by the private repo's
  workflow. `rounds` = per-round points per team (League chart, Elite season); `lineups` = the user's own teams per
  round (ids, start line-up, boost, x3, budget, bank, free, subs, chip) for Hindsight; `rivals` = the same for league
  rivals (from exports); `seen` = {team: {gd: 7 ids}}, the line-up in each round's last league-feed snapshot (the
  team that scored it), which `Hind.track` works the rest out from. Don't hand-edit.
- `data/elite_history.json` — real global cut-offs/means per gameday, written by the private workflow (plaintext,
  numbers only). `refresh.py` merges it over the estimated R1–R14 paths in `data/elite_top100.json` `history`.
- Private repo `KyleBotho/pit-wall-private` (local clone `../pit-wall-private`): `leagues.py` + `leagues.yml`
  (every 6 h, hourly Sun–Mon) fetch the private-league feeds and the global top 500, keep plaintext
  `history/<leagueId>/<feedTime>.json` and `history/global/` there, map each snapshot to a gameday via the schedule
  (last race started before the feed time), and push the sealed snapshot and `elite_history.json` here with the
  `PUBLIC_REPO_TOKEN` PAT (which triggers a rebuild). Secrets `LEAGUE_KEY`, `LEAGUE_IDS`, `PUBLIC_REPO_TOKEN` live in
  that repo only. Its runs aren't visible without auth; check for its commits here instead:
  `https://api.github.com/repos/KyleBotho/pit-wall/commits?path=data/league.sealed.json`.
  `leagues.py` imports `f1feeds.py` from the public checkout: push this repo before a private change that needs it.

## Code conventions (2026-09-24 review)
- Page scripts share one scope, so ESLint collects every file's top-level names as globals (`eslint.config.mjs`) and
  forbids locals that shadow the shared state (`state`, `forecast`, …): a `renderLive` helper called `state` once
  broke Live Scoring.
- Saved settings go through `loadState()` (`web/js/state.js`): bump `SCHEMA` and add a `MIGRATIONS` step for any
  shape change; `CARRY` lists what survives into a new season. `defaults()` returns fresh objects.
- Only the visible view renders: after a change call `rerender()` (all views stale, visible one redrawn) or
  `refreshViews([...])`. Clicks/changes/inputs dispatch through the `CLICK` / `CHANGE` / `INPUT_ID` tables in
  `main.js`; add an entry rather than a branch.
- Prettier drops the parentheses of a JSDoc cast before a member access (`/** @type {X} */ (a)[k]`); use a typed
  local instead. `web/js/core.js` keeps the `/*__DATA__*/ null` placeholder (refresh.py matches it with a regex).

## Commands
- New season: `python priors.py` (adds the finished season to the circuit priors), update `config/season.json`.
- Local preview: `.claude/launch.json` "pit-wall-build" serves `build/` on :8765.
- Rebuild locally: `python refresh.py` (run from this folder; `PYTHONIOENCODING=utf-8` on Windows bash);
  `python refresh.py --offline` rebuilds the page from the last fetch (page/CSS/JS edits).
- Checks: `npm run check` (ESLint, Prettier, tsc on engine/hindsight, node tests; `npm install` once),
  `python -m unittest discover tests`, `ruff check . && ruff format --check .`. `npm run backtest` for the model.
- After editing `config/feeds.json`: `node tools/sync-shared.js`, then redeploy the Supabase function.
- Deploy: commit and `git push` (Git Credential Manager handles auth; no gh CLI). Pages rebuilds on push.
  `git pull --rebase` first: both workflows push to main (history, sealed files).
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
- OpenF1 per race: `race_control` (SC/VSC/red, grid penalties), `weather` (rain), `pit` (`stop_duration`), `laps`
  (race pace), `session_result` (qualifying order once run). `overtakes` exists for 2023-2025 only.
- Kalshi `api.elections.kalshi.com/trade-api/v2` (public reads, no key): series KXF1RACE (winner), KXF1RACEPODIUM,
  KXF1TOP10, KXF1POLE; events `<series>-<AZEGP26>`. Settled markets move to `/historical/markets` (plain price fields).
- Open-Meteo `api.open-meteo.com/v1/forecast` (no key): hourly precipitation probability.
- FastF1 (pip) reads `livetiming.formula1.com/static` — the fallback for practice when OpenF1 is locked.
- Not automated: FIA stewards' PDFs (grid penalties come from race control messages plus the manual picker in
  Settings > Circuits).
- OpenF1 `api.openf1.org/v1/{sessions,laps,stints,drivers}` (practice; free data lands shortly after sessions).
  While ANY F1 session is live, OpenF1 returns 401 for everything (paid key only). `refresh.py` uses `get_soft`
  for it: one attempt, cached copy on failure, never aborts the build (seen 2026-09-24 during Baku FP1).
- The old `fantasy-api.formula1.com` API (Postman doc, dlthub, skelmis package) is dead since 2023 — don't use.
- Private-league standings come from the private repo (above), sealed. Chips, bank and free transfers are
  logged-in data and are NOT fetched by code (checked 2026-09-25: `services/user/opponentteam/...` and
  `services/user/gameplay/.../getteam` answer 401 without a session). Exports give them exactly; after the last
  export `Hind.track` works them out from the public feeds (Round tracking). The user collects an
  export with Claude for Chrome; the page's Import button reads it in the browser only (localStorage).
  Never put league or personal data into the repo/site, and never handle the user's F1 login or tokens.

## Model decisions (backtested — keep unless new evidence; `npm run backtest` reproduces the evidence)
Model rework 2026-09-24/25 (user asked for a sim review, scored 7/10, then "implement all the improvements, including
the additional data sources", plus his own idea: circuit priors carry a SEASON TREND, restarted every season).
- The gate is backtest section 6: walk-forward R5-R14, exact CRPS of projected points (plus MAE, coverage, team pick).
  Paired against the previous engine (git 8c14f43) at 10,000 sims: ΔCRPS +0.02 ± 0.11, ΔMAE +0.08 ± 0.16 — a TIE on
  points within noise; better on race positions (race MAE 2.91 vs 3.05 places, from lap-time pace); qualifying about
  the same (1.737 vs 1.735). The rework's value is structure (correlated team form, SC, rain, market, uncertainty,
  penalties, known grid) and features, not a measured points gain yet. 10 rounds can't separate ±0.1.
- Section 6 now (2026-09-25, after item 9 stage 2): CRPS 8.62, MAE 11.84 (drivers 10.4, constructors 14.7). Before
  it: CRPS 8.85, MAE 12.17 (drivers 10.7, constructors 15.2), bias +0.03, rank corr 0.74, 85% inside the
  10-90% range (a bit wide), baselines: season average 13.17, recent form 13.65.
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
  Sprint share of race overtakes swings 0.17-0.92 between sprints: measured, shrunk to 0.4 with 3 pseudo-sprints.
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
- Unchanged: price rule (390/392), DNF team rate shrink k=16 no recency (log loss 0.4608), official scoring.
- Tried and rejected 2026-09-25 (section 9): skewed session noise, car + driver-offset team-mates, the fastest-lap
  market. All ties or worse; see the to-do list Also the lap-by-lap and timing-segment races
  (item 9 stages 3a/3b, SIM.raceModel): ties on points, worse on race positions.
- Known gaps (section 5): overtakes run low at a neutral track (4.05 vs 4.78), places lost too few (−0.22 vs −0.56),
  fastest lap / DotD slightly too spread (88% / 94% to the top seven vs 100%).
- Default 10,000 sims per race × next 3 races (~1 s in the browser). Optimiser enumerates all teams; `planHorizon`
  beam-searches race-by-race plans (~0.5 s); goals "beat a rival / the top-100 template" re-rank by P(beat).
- vs rhter's Baku sim (f1fantasytools, old engine): MAE 4.6; we're higher on Alpine/midfield, lower on Ferrari.

## Open items — next session starts here
- [x] 2026-09-25, from the F1 Fantasy Tools Discord findings (user's agent scraped #analyst-simulations and
      #analysis-chat, files in Downloads `F1_Fantasy_Sim_Findings_*.md`; ideas only, never rhter's sims or output):
      1. Scoring vs a team to beat on the same simulated weekends: goals rival / top-100 template / top-500 template;
         Best Teams columns P(beat), P(+25) (`GOAL_K`, the gain that moves rank), xGap (E[D]) and Gap 10–90%;
         sortable, and the ranking follows the sorted goal column (default P(beat)).
      2. Price average over the races so far (2026 rule, no "imaginary zeros"): `priceInfo` divides by 1-3, not 3.
      3. Final Fix: "Value my chips and Final Fix" (Plan & chip) shows, once qualifying is known, the best single driver
         swap on points still to be scored (total − known qualifying/sprint points; Boost stays on the slot), with the
         community's ~+20 threshold. 4. Same pop-up: X3, No Negative, Autopilot (+ how often it moves the Boost),
         Wildcard and Limitless gains for the starting team next race. 5. Chalky vs flat: the optimiser keeps 400 teams
         and the note says how many are within 5% of the best.
      Scoring details: no −5 for no qualifying time in a wet session; Driver of the Day popularity per driver
      (`dotdPopularity`: votes won vs what his finishes would earn, 2 pseudo-votes; 2026: VER ×2.2, RUS ×0.5). The
      "−20 only below 90% distance" rule is already how classification works (a car past 90% is classified).
      Gate after these: CRPS 8.854 / MAE 12.18 (unchanged within noise).

### Round tracking (2026-09-25, user asked: "what do we get from a league member's page, and can't we get the rest?")
- [x] `backfill.py` keeps every league member's per-round record (`rivals`), `leagues.py` seals `seen` line-ups and
      rivals; `Hind.track` fills the rest. Validated (`tests/hindsight.test.js`): all 6 export teams given ONLY their
      R1 record rebuild R2–R14 chips, Boost, budget, bank and transfers exactly, whichever way the feed shows a Final
      Fix round. Budget = last budget + price changes of the team held (after Limitless: the team before it; after
      Final Fix: the qualifying team). Free = 2 + one carried, none out of Wildcard/Limitless.
- Findings: (1) inactive assets (a driver's old asset after a team move, e.g. LAW 114, HAD 11032 from R12) cost −25
      each per round, −35 on a sprint weekend (`inactive_driver_penality_points`); now in `score()`. (2) F1's own
      `subsallowed` goes stale for a team that doesn't save (an idle rival shows 2 free for 11 rounds); the rule gives 3,
      which matches whenever the team is active. (3) Not detectable from scores: Autopilot (= a Boost on the top
      scorer) and a No Negative that floored nothing; they can be marked by hand. (4) Several Final Fix swaps can fit
      one score; the one that also explains the next round wins.
- Page: League "Round by round" (a card per member per round, like F1's league view), Chips left / Bank / Free
      columns without an import; `applyTracked()` updates your teams after each race (line-up, bank, free, chips) unless
      `t.asOf` (the race a team is set up for; schema 5 sets it to the next race for older saves) is later; chips F1's
      data shows are locked in the Calculator (`lockedChips`), others stay markable. Rivals as starting team get the
      same bank/free/chips.
- [ ] Check on real data after Baku: the R15 snapshot's line-ups explain R15 (the user's leagues; his team-tracking league was
      still 403 on 2026-09-25). Rounds that come out "not worked out" mean the feed's line-up isn't the scoring team.
- [ ] Decide (user): a dedicated "Pit Wall" F1 account whose session reads every opted-in team's rounds exactly
      (discussed 2026-09-25; not built). He made the account on 2026-09-25; the private repo's daily
      `session_check.py` (workflow "Pit Wall session check") logs whether its session still works to
      `history/session-check.csv`. First run 2026-09-25: HTTP 200, team returned.
- [ ] TO DO (set 2026-09-25): around 2026-10-09 (or as soon as a check run fails) read that log in
      `../pit-wall-private` (`git pull` first). The first failing day = the session's lifetime; then decide with the
      user whether account-based tracking can run unattended or needs a manual cookie refresh every N days.

### To do (agreed 2026-09-25, in this order)
- [x] 2026-09-25 Mechanical "model team" in Hindsight (rhter's public "stats team" ranked 1,166–4,105 globally in
      2023–25; a benchmark for ours). `Hind.modelTeam(proj)`: fresh $100m pick in the first projected round, then each
      round the best team for that race alone on projected points from last round's team (2 free, one carries, 3 max,
      −10 extra; budget moves with the held team's price changes; Boost = top projected driver; no chips); scored with
      `score()`. Projections: frozen (`DATA.projHist`, R15 on) else rebuilt (`DATA.projRebuilt`,
      `history/2026/rebuilt/`, `npm run rebuild`: `asOf(r)` through today's engine, so a little flattered). Starts at R2:
      R1 had no data (every asset projects ~28). First result: 2,705 pts over R2–R14 vs a top-100 average of 3,739.
      Panel "Model team" under Season: per round line-up, transfers, free, budget, xPts, pts, your teams' official
      points, top-100 average; the gaps count only rounds both have. Test: on perfect projections it scores exactly
      what it projected, and follows the transfer rules.
- [x] 2026-09-25 Tried in the backtest (section 9, `npm run backtest 9`: paired vs the shipped model, 5 seeds x 10,000
      sims, ± = SE over the 10 rounds). None adopted; the switches stay in engine.js, off:
      - Skewed noise (`SIM.qSkew` / `rSkew`, skew-normal shape): 2-5 all tie on CRPS (±0.01) and positions. Taken
        literally, 1/t² space skews the noise by only ~0.02 at our 0.15-0.3% sd, so it's a no-op.
      - Car + driver offset (`MODEL.mate "car"`, `offPrior`, `offHalfLife`): a tie (best MAE −0.03 ± 0.02 at prior 6).
      - Fastest-lap market (`SIM.flOddsW`): the 2026 series is KXF1FASTLAP (KXF1FASTESTLAP stopped after 2025), one
        event every round; now fetched live, archived at lock, and in `odds_by_round.json` (R5-R14). Worse at every
        weight (log FL −0.04 at 25%, −0.20 at 100%; CRPS +0.03 at 100%): thin books (Gasly 25% at Spain). Re-test
        with ~20 rounds. No per-race DNF market exists (KXF1RETIRE = Verstappen retiring from F1).
- [x] 2026-09-25 One-click overtake scenarios: Low / Base / High buttons under each circuit's Overtaking slider
      (Settings > Circuits). `Engine.ovScenarios(DATA)` = the 20th / 80th percentile of each finished round's overtakes
      per starter over the season mean (2026 after R14: ×0.70 / ×1.24; the sim has no round-level overtaking shock,
      so this is the swing one weekend can land in), times the circuit's fitted value, rounded to the slider's 0.05.
      Base clears the override (`state.circuits[gd].ov`). Hidden before 4 rounds. At Baku: VER xOV 3.2 / 4.5 / 5.7.
- [x] 2026-09-25 What more budget is worth (replaces rhter's per-constructor-pair slope, ~1.2 MCL+FER to ~1.7 with
      one A-tier constructor, after the user agreed: the payoff is a step function and he's backing off budget
      building since Monza). `Engine.budgetCurve(cand, team, o)`: the best team at every budget in $0.1m steps in one
      pass (~30 ms; `teamSpace` now shared with `optimise`; tested against a brute force at each cap). Calculator >
      Price changes > "What is more budget worth?": gain per race vs your budget from −$2m to +$5m, from your team
      (free transfers, −10 extras) and with a free rebuild, against the flat xΔ$Pts rate; step chart + table with
      what the extra money buys. Baku, fresh pick: $99.8m → $101.4m = +13.3 (ANT), nothing in between.
- [x] 2026-09-25 What a transfer is worth (nobody models it): Calculator > Plan & chip > "What is a transfer worth?".
      `planHorizon` over every simulated race (3), once per number of transfers made now (`firstMaxT` caps the first
      race only; unused free ones carry, extras −10) and once with one more free transfer: spend now vs bank, whether
      a hit pays, and what an extra free transfer is worth. Beam 6, ~2 s (shows "Working it out…" first). The plans
      end at the last simulated race, so a transfer still banked then counts for nothing: banking is undervalued a
      little. Planner stages shared with the race-by-race plan (`planStages`). Example (Team 1, Baku): 3 now with a
      −10 hit beats 2 by 9.6 over R15-R17, so an extra free transfer is worth exactly the 10 it saves.
- [ ] 9. The big one, once the rest is done (user wants time spent to get it right): a lap-by-lap race model built on
      sub-lap segments (rhter's own limitation: one time per lap can't produce DRS trains), car-performance envelopes
      (g-g-V from telemetry, projected onto the next track's geometry for pre-practice pace), minisector ideal laps
      (two disjoint sets, less sensitive to one perfect sector), and an energy-deployment model (2026 overtakes come
      from charge differences on energy-starved tracks: the "yo-yo"). Data: FastF1 / OpenF1 telemetry (car_data,
      location). Judge it with the section 6 gate: it has to beat the current model, not just look more realistic.
      PLAN AGREED 2026-09-25 (design discussion with the user):
      - Ceilings (`npm run backtest 10`, the sim told the round's real answer; 3 seeds x 3,000): real race pace
        −0.44 ± 0.11 CRPS, real race overtake level −0.41 ± 0.16 (race overtakes per driver ran 1.1 Monaco … 11.7
        Monza), both + qualifying pace −0.75 ± 0.26; real qualifying pace −0.01 ± 0.13 and the real grid +0.10 ± 0.12
        (nothing). So the targets are race pace and the round's overtake level; minisectors (qualifying pace) come last.
      - 2026 has no DRS: the car within 1 s gets Overtake Mode (extra electrical deployment), which costs it charge ->
        the yo-yo (pass, clip, repassed). "Trains" in the lap model = Overtake Mode trains. Battery charge isn't in the
        public telemetry (speed/throttle/brake/gear/RPM only): energy use is inferred from clipping in the speed trace.
      - Split: `telemetry.py` (FastF1 + numpy; cache in `%LOCALAPPDATA%\pit-wall\fastf1`, never in OneDrive/the repo)
        writes small JSON (`history/2026/telemetry/`: track segments, laps/positions/speed traps, envelopes,
        minisectors). engine.js stays pure JS: `simulate()` keeps weekend draws, qualifying, DNF/rain draws and
        scoring; only its inner `race(grid, …)` gets an alternative `raceLaps()` behind `SIM.raceModel`, returning
        the finishing order + each driver's overtakes. Small parameters (pass chance vs gap and pace difference, dirty
        air, energy) are fitted on lap-pair events, walk-forward (`kernel_by_round.json`, like practice_by_round);
        section 6 only judges, never tunes.
      - Where it runs (user, 2026-09-25): at build time, NOT in the Calculator (future users must never wait). CI runs
        it when a new session lands (after each practice session before lock, and after the race for the next race)
        and ships the results; the Calculator reads them. Plus an owner-only "Sim lab" tab (shown only when signed in
        as the user; a UI gate, the data is public anyway) with panels like rhter's (built from OUR sim): asset table
        (Qpace, Rpace, DNF, FL, xOV, DotD, p25/xPts/p75, xPPM), price-step probabilities, qualifying/race position
        matrices, average position and gap to the field by lap, points-per-$m scatter, violins, team score
        distributions; a rerun button and toggles for every switch, including those kept but off by default. First
        version after stage 2; lap panels with stage 3.
        Securing it (agreed 2026-09-25): not a separate site (free Pages can't be private; a second site = second
        sign-in, UI and split backtests). Same page, three locks: (1) the tab shows only for accounts in a Supabase
        `owners` table (RLS); (2) CI writes the full Sim lab results to a Supabase table only owners can read (RLS);
        the public build keeps only what the Calculator needs; (3) Rerun = a Supabase edge function that checks the
        JWT + owners, then starts the GitHub workflow (workflow_dispatch with the toggles as inputs) with a
        fine-grained token (Actions write, this repo only) held in Supabase secrets, never in the browser.
        The code stays in this PUBLIC repo while item 9 is developed (user: no Actions limits); once everything runs
        properly, consider moving the whole thing private. Only the pipeline would move; the tab and Calculator
        keep reading Supabase.
      - Data pacing: FastF1 first (OpenF1 car_data only as a fallback), one session at a time, ~30 s apart, ≤ ~20
        sessions per sitting, stop and ask on any 403/429 or run of errors, never while a session is live. Measure one
        telemetry session's size before the bulk (estimate 50–100 MB each, 3–6 GB for the season). CI may fetch each
        weekend's practice telemetry once and archive the result (user OK'd).
      - Adoption rule (set before any results): a stage is ON only if section 9 paired (5 seeds x 10,000, R5+) gives
        ΔCRPS at least 1 SE below 0 and ΔMAE ≤ 0, log R not worse. A TIE (within noise) -> the option needing the
        least manual adjustment if things change later (user's rule, 2026-09-25: fewer hand-set values, manual steps
        and breakable feeds; refits itself from data). Log every tie decision here with where and why. Worse -> kept
        behind a switch, off. Confirm on rounds after the freeze (Baku on) that were never used for fitting.
      Stages (checkpoint at each):
      - [x] 0. Harness (2026-09-25): `walk.js` `withOracle` + per-category errors (overtakes, race places, the round's
        overtake level, sim ms); section 9 = named groups (`EXP=skew,car,fl|none`, `EXP_GRID=1` adds "CRPS, real
        grid" = the race model alone), section 10 = ceilings. Baseline 5 x 10,000: CRPS 8.831, MAE 12.179, real grid
        8.934, err OV 3.385, err places 2.364, err OV level 1.977, log Q −2.168, log R −2.387, 21 ms per 1,000 sims.
      - [x] 1. (2026-09-25) Data: laps/positions/speed traps for every 2026 session (small), then telemetry; track segments per
        circuit; 2025 qualifying geometry for the remaining circuits. Check: passes counted from laps match the
        official overtake lines per driver-race (else the pass model can't be fitted). In progress 2026-09-25:
        `telemetry.py` (laps / measure / passes; stops if a session is live). Race + sprint laps R1–R14 archived
        (`history/2026/telemetry/laps/gdNN.json`, 1.5 MB; 19 sessions, ~7 MB download each, no blocks).
        `telemetry.py passes`: passes = race-order changes between timing-line crossings (3 per lap), pit-lane
        intervals excluded, lapping not counted (tested). vs the official overtake lines: races r 0.85 per
        driver-race, 1227 counted vs 1472 official; sprints r 0.91, 280 vs 317. Lap-end positions only: r 0.82,
        1010 (so sub-lap sampling matters). Too few where the yo-yo swaps happen between lines (Monza 163 vs 258,
        65 of them with the cars < 0.3 s apart); too many where F1 evidently skips passes under SC/VSC or on slow /
        retiring cars (Monaco 51 vs 24, Madrid 47 vs 33, Canada, Miami). Conclusion: good enough per driver, but
        timing lines miss ~20% of passes, so passes must be counted along the lap from race telemetry (position
        data), and race telemetry is needed in stage 1, not only in 3b.
        TIE DECISION 1 (2026-09-25, pass counting): filtering out passes under SC/VSC and on cars >15% slower or
        retiring within 2 laps took r 0.863 -> 0.883 but made the total worse (1507 -> 1289 vs 1789 official,
        mean |round total error| 23 -> 27): a tie. Kept NO filters (the rule: two hand-set thresholds to maintain
        vs none). Revisit once passes come from telemetry.
        Telemetry sizes (measured): qualifying ~50 MB, race ~80-180 MB, sprint ~50 MB; ~6-10 s each. Race + sprint
        telemetry R1-R14 cached (19 sessions, 1.9 GB in %LOCALAPPDATA%\pit-wall\fastf1; `laps --telemetry`).
        Passes from position telemetry TRIED AND DROPPED (2026-09-25, not a tie: worse on most tracks). The public
        feed repeats its last sample ~40-44% of the time (car and position data), releases backlogs late (GAS
        frozen ~3 s at Roggia every lap, then catches up), and traced lap shapes are unreliable per track
        (Hungary lap 3.65 km vs ~4.38 real; speed-integrated lap length 3.95-4.40 km on similar laps). With stalls
        masked (+4 s) and a 40 m hysteresis Monza gave 242 vs 258 official (r 0.90), but across all 19 sessions
        it over-counted badly (Suzuka crossover, Hungary geometry, ...); fixing it needs per-track patches. Decision:
        passes from the timing lines (exact timing loops, r 0.85) with the LEVEL anchored to the official overtake
        lines (what fantasy scores); telemetry only for one stall-free lap per session (shape, energy, envelopes).
        Early read for stage 2 (race telemetry, in-sample, n=14): a track's full-throttle share (>= 98% throttle)
        ranks with its race overtakes per driver at Spearman +0.60, the share of full-throttle time > 200 km/h
        spent decelerating ("super-clipping") at +0.53 (circuit history: −0.2..0.2). Monza 48.7% full throttle ->
        11.7 overtakes; Monaco 19.9% -> 1.1; Hungary (22%, 4.6) the outlier.
        Done: lap records for all 70 sessions R1-R14 (FP/SQ/S/Q/R, 3.4 MB); race, sprint and qualifying telemetry
        cached (33 sessions, 2.6 GB). Still to fetch: practice telemetry (for stage 2's index at lock; after Baku)
        and Baku itself. Track segments moved to stage 2, where the energy index first uses them.
      - [x] 2. (2026-09-25) Track index -> the round's overtake level (`circuit.ov`), walk-forward. ADOPTED, but the
        winning index is the track's AVERAGE SPEED, not a telemetry energy measure. Per-session features from the
        cached telemetry (scratch script, not kept; stall-free laps only): full-throttle share, "super-clipping",
        braking zones, longest full-throttle run, top speed, lap length, average speed. Correlation with log race
        overtakes per starter (R1-R14, qualifying laps): average speed r 0.75, full throttle 0.62, full throttle /
        braking zones 0.61, clipping 0.40. Single-feature fits, |error| of the round level per driver: flat 1.81 LOO /
        2.10 walk-forward; average speed 1.50 / 1.83; full throttle 1.77 / 2.16; braking zones 1.74 / 2.17; the
        hand-set power/street/fast tags 1.77-1.98 / 2.02-3.16. So no telemetry is needed: speed = circuit length
        (`config/season.json` circuits.km, official figures; telemetry laps measure ~1% shorter, checked on all 14)
        / the practice reference lap (`practice.py ref_lap`: median of the 10 fastest drivers' best clean laps; a
        weekend takes its fastest session's). `engine.js` TRACK.speed: log overtakes per starter regressed on the
        standardised speed over this season's rounds (ridge 2, needs 5 rounds), applied only to the NEXT race once
        its practice has run (sprint weekends: FP1 only, as at lock); later races keep the flat level.
        Past rounds' laps: `trackStats[gd].lap` from `history/2026/practice/gdNN.json` (R1-R14 backfilled from
        `practice_by_round.json`, which now carries `ref`). Settings > Circuits shows the speed and the multiplier.
        Evidence: section 2 LOO overtakes better than flat 11% (ridge 0) / 14% (2) / 17% (5). Section 9 paired
        (5 x 10,000, R5-R14) ridge 2: CRPS −0.214 ± 0.122, MAE −0.342 ± 0.195, real grid −0.227 ± 0.119, err OV
        −0.349 ± 0.172, err OV level −0.311 ± 0.304, log Q −0.002, log R −0.003 (noise: Q doesn't depend on it).
        Mean level (speedVar 1) −0.195 / −0.410; ridge 5 −0.187 ± 0.099 / −0.250. Passes the adoption rule; ridge 2
        (best CRPS). Section 6 after: CRPS 8.62, MAE 11.84 (was 8.85 / 12.17); "without practice" is now 8.84, i.e.
        practice's value is mostly this input. About half the ceiling (−0.41) captured.
        TO CHECK (first round never used for fitting): Baku R15 forecast 206.6 km/h -> ×0.70 = 3.3 race overtakes
        per starter (season 4.78). Baku is slow on average but has a 2 km flat-out run, a likely miss; compare after
        the race, and each round's forecast vs actual as they come. Telemetry energy features may still help as a
        second feature once ~20 rounds exist (full throttle / braking zones were next best).
      - [x] 3a + 3b (2026-09-25): BUILT, NOT ADOPTED (switch `SIM.raceModel`, default "rank"; "laps" = 3a,
        "segments" = 3b). Both tie on points and are worse on positions and per-driver detail, so both stay off.
        3a `raceLaps()`: grid start (SIM.lapStart 0.25 s/slot), lap time + race-long offset + 0.40 s noise
        (measured), one stop in the middle half (pit loss 23 s, measured median; stops reorder without passes),
        retirement on a random lap (its passes still count), SC bunches the field and freezes passing 3 laps. Order
        changes on track only by passes: logit theta + kappa x 1.67 x pace advantage (s/lap) − 2.63 x gap − 4.23 x
        min(gap, 0.5) + driver skill (+1 on lap 1), measured on 5,657 lap-end pairs (R1-R14, round level free;
        through R6 1.37 / −2.42, stable). A failed pass = held behind. Calibrated per simulate call from pilot races
        with the main loop's weekend draws: theta so passes per starter = the circuit's level (stage 2), kappa so
        the grid-finish rank correlation = circuit.grid (SIM.lapGrid). Data found: lap 1 = 35% of lap-end passes;
        P(pass by the next lap) within 0.5 s: 9% slower car ... 78% > 1 s/lap faster.
        3b `raceSegs()`: three timing segments a lap; segment pass curve [1.15, −5.21 gap, −0.41 below 0.3 s,
        −0.30 if just passed by that car] from 14,486 segment pairs (stable R8-R14). NO yo-yo at timing-line
        resolution (a just-passed car re-passes LESS at equal gap and pace); the yo-yo is BETWEEN the lines:
        official − line-counted overtakes per driver-race = 0.04 + 0.144 x segments within 0.3 s of another car
        (r(official, lines) 0.846 -> 0.864 with it). So each segment a pair runs < 0.3 s apart, both get a
        pass-and-repass with chance 0.144 (SIM.yoyo); held-up gaps = 0.25 + exponential(0.45) s (measured quantiles
        0.36 / 0.71 / 1.26 s).
        Section 5 (neutral track, actual): overtakes rank 4.05 / laps 4.75 / segments 4.89 (4.78); places lost
        −0.22 / −0.55 / −0.53 (−0.56); places gained 1.55 / 1.86 / 1.85 (1.61). The known gaps close, but gains run
        high. Section 9 paired (5 x 10,000, R5-R14, vs shipped): laps (one-way calibration) CRPS −0.011 ± 0.091,
        MAE +0.044, real grid +0.092, err OV +0.190 ± 0.149, err places +0.061 ± 0.030, log R −0.019; laps
        (two-way) −0.009 ± 0.100, +0.023, +0.118, +0.181, +0.064 ± 0.031, −0.017; laps order + regression
        overtakes (`SIM.lapOv` "regression") +0.095 ± 0.045 (worse), MAE +0.114, err OV +0.079, places +0.065;
        segments −0.008 ± 0.103, MAE −0.006, real grid +0.099, err OV +0.168 ± 0.160, places +0.056 ± 0.032, OV
        level +0.223, log R −0.015. Runtime 1.0 / 2.3 s per 10,000 races (rank 0.2 s).
        Reading: the lap races' finishing ORDER is the problem (worse places and log R even with regression
        overtakes); movement from the grid is too spread out (gains 1.85 vs 1.61 at a matched rank correlation).
        Ideas not tried: fit lapStart / lap1 / followMin to places gained & lost (section 5 targets, not the gate);
        tyre strategy offsets; fit the kernel on model pace rather than realised laps; stage 4 (race pace) is the
        bigger ceiling (−0.44) and may matter more than the race mechanics.
      - [x] 4. (2026-09-25) STOPPED AT THE FEASIBILITY CHECK: no signal, so no engine work. Simplified envelope =
        time lost per speed band (<140 / 140-200 / 200-260 / >260 km/h, by the fastest lap's speed at each point of
        the distance-normalised lap) on each team's best stall-free qualifying lap vs the session's fastest (scratch
        script, not kept; 12 rounds usable, China/Japan too stalled). Band time shares look right (Monaco 42% < 140,
        Monza 53% > 260). Walk-forward R4+ (95 team-rounds): predicted team swing at the track (track band mix x the
        team's band profile relative to its overall gap over earlier rounds) vs actual: qualifying r 0.03, race pace
        r 0.10. Split-half stability of team band profiles across teams: fast corners 200-260 km/h 0.77, slow 0.09,
        140-200 −0.16, straights −0.28 (2026 straight-line speed follows each track's energy budget, not the car).
        Fast-corner band alone: qualifying r 0.17, race r 0.01. Race pace (the −0.44 ceiling) shows nothing; like
        the hand-set track tags before (~0%), track-type fit doesn't predict team pace in 2026. The ceiling looks
        like weekend-specific variation. Re-test with ~20 rounds (fast-corner band for qualifying only).
        2026-09-26, user asked for 4 and 5 built anyway and all of 2-5 run together: stage 4 now exists as a switch,
        off (MODEL.bandQ / bandR = weight on the shift (%) = (next track's practice fast-corner share − the average
        of earlier rounds' practice shares) x the team's fast-corner loss relative to its gap (qualifying, earlier
        rounds, shrunk bandShrink 3), from bandMin 3 rounds with practice shares; `bandShift`). Data:
        `telemetry.py bands` -> `history/2026/telemetry/bands/gdNN.json` (Q: shares + per-team loss per band; FP:
        the fastest practice lap's shares), embedded as DATA.bands; walk.js gives round r only earlier rounds + its
        own FP. Shifts are small (0-0.15% of a lap, midfield/back only).
      - [x] 5. (2026-09-26) Built for the backtest only (not in the live pipeline): `telemetry.py minisectors` ->
        `history/2026/telemetry/minisectors/gdNN.json`: per practice session and driver, push laps (104%, no
        in/out laps, stall-free) split into two disjoint sets (odd/even), each set's ideal lap over 24 equal-
        distance minisectors, averaged; % off the session's best. walk.js `practiceMini` swaps it in for the
        short-run gap (evaluate option `practiceMini`). vs the lap-based gap: r 0.80 over 298 driver-sessions.
        Practice telemetry fetched 2026-09-26 for this: FP2/FP3 of the normal weekends R6-R14 and FP1 of the
        sprints R5/R9/R12 (17 sessions, 51-105 MB each, no blocks); R1-R4 and normal-weekend FP1 not fetched.
        ALL OF 2-5 TOGETHER (section 9 group `combo`, 5 x 10,000, R5-R14, vs shipped, which includes 2):
        without 2 +0.214 ± 0.122 CRPS (so stage 2 = −0.214); +3 −0.008 ± 0.103 (places +0.056); +4 −0.007 ±
        0.010; +5 −0.029 ± 0.032 (log Q −0.057, places +0.094); 2+3+4+5 −0.010 ± 0.117, MAE +0.092, places
        +0.191 ± 0.052, log Q −0.059. Parts 3+4+5 sum to −0.044; together −0.010: NO synergy, the combination is
        worse on places and qualifying positions. Stage 2 carries all the gain. 4 and 5 stay off (5 isn't wired
        into refresh.py / practice.py at all; it would need practice telemetry in CI).
      - [x] 6. (2026-09-25) Sim lab tab built (`web/js/lab.js`, view "lab", rail button `#labNav`). DESIGN CHANGE vs
        the plan above: runs happen IN THE BROWSER on demand, not in CI. The plan assumed the lap model would take
        minutes; it takes 1-3 s per 10,000 races (segments 2.9 s at Baku), so there is no GitHub token, edge function
        or results table: fewer secrets and moving parts (the least-upkeep rule). Lock (1) stays: the tab shows only
        for accounts in the Supabase `owners` table (RLS: each user reads only their own row; `supabase/setup.sql`,
        plus an `insert ... where email = ...` the user runs once), or on localhost with `?lab=1`. Everything shown
        comes from the public build anyway. Since every shipped switch keeps the fast rank model, the Calculator
        needs no build-time runs; add a CI run only if a slow model is ever adopted.
        Controls: race (next 3), weekends (2k-20k), "compare with the shipped model" (same seed), Rerun, Reset;
        20 switches from SIM / TRACK / MODEL incl. ones kept off (race model rank/laps/segments, lapOv, lapGrid,
        yoyo, ovModel, pitStops, incident, TRACK.speed + ridge, teamPace, oddsW, flOddsW, practiceQ/R, mate, qSd,
        rSd, qSkew, rSkew, unc); shipped value on hover, changed ones highlighted. Switches are applied to Engine.* for
        the run only (`withLab`) and restored, so no other view changes; settings in localStorage `pitwall.lab` (not
        synced). Panels: asset table (Q/R pace, DNF, FL, DotD, xOV, p25/xPts/p75, xPPM, P(rise)/P(drop), Δ vs
        shipped), qualifying/race position matrices with average position, points-vs-price scatter, the starting
        team's points distribution (shipped model dashed), per-asset points histograms, and (2026-09-26) average
        position / gap to the leader by lap (lap races only: `simulate(..., { trace: true })` returns
        `sim.laps` {n, pos, gap, run} from raceLaps/raceSegs; your starting team bold). Not yet: price-step matrices
        beyond P(rise/drop), violins.
- [ ] After each round: `npm run backtest 6 7` (the gate + frozen projection vs result). After a few more rounds,
      `npm run fit` again; with ~20 rounds the ±0.1 differences may become readable. `python backtest/odds_rounds.py`
      is only needed for rounds before the live odds archive (history/2026/odds, from R15).
Private league IDs are never written into this public repo: anyone holding one can read that league's feed,
manager names included. They live in the `LEAGUE_IDS` secret (and, after 0b, the private repo).

R. Code review (2026-09-24, user asked for a critique then "implement all"): split app.html into `web/`, extracted
   `hindsight.js`, `f1feeds.py`, `config/`, tests + CI gate, backtests, lint/format/types. Bugs fixed: page crashed
   once no race was left (now a season-over mode: forecast views hidden, Hindsight/Stats/League/Elite/Live work);
   sync silently dropped unsent edits when the account had also changed (now asks); defaults shared by reference;
   rivals identified by name only (now league + name); Live function could overwrite fresh scoring lines; X3 and
   Autopilot were applied to every race of a 2-3 race horizon (X3 3-race total was ~108 pts too high); a new season
   wiped saved settings (now carried over, teams fresh); Projections' pace-nudge buttons were hidden after any view
   switch (`data-v` clash); an open practice stint was dropped.
   - [x] Supabase `smooth-action` redeployed by the user 2026-09-24 (lost-update fix, generated event tables);
         checked: answers for gd 15 with all 35 assets. Scoring lines appear from Baku FP/quali on.
   - [x] 2026-09-24, user approved: practice short-run weight 0.3 -> 0.5, track team-pace shift off, DNF no
         recency with shrink k=16 (was half-life 6 / k=4). See Model decisions. Worth re-running `npm run backtest`
         after a few more rounds (practice needs `python backtest/practice_rounds.py` first).
0. [x] 2026-09-24: tested and pushed the Elite view, sealed private leagues and the Actions bump (checkout@v7,
   setup-python@v7, cache@v6, upload-pages-artifact@v5, deploy-pages@v5). Checked: tags resolve; global feed
   aggregates; a 403 league comes through as `pending`; seal.js -> page `unseal` round-trip under WebCrypto (wrong key
   rejected, no user_name/guid/social_id in the payload); first render with no `DATA.elite`, no `leagueSealed`, no
   `top100`; unlock form, league picker, pending league and auto-unlock on reload in a browser; Import `ovPts`/`ovRank`
   feeding Elite. F1's `FeedTime` is US text (`9/17/2026 1:59:44 PM`); `feed_time()` now converts it to ISO because
   Firefox/Safari can't parse the original.
0b. [x] 2026-09-24: private/public split built. The private repo fetches and seals; this repo's `refresh.py` only
     embeds `data/league.sealed.json`, and the `LEAGUE_*` env is gone from `refresh.yml`. Tested locally end to end
     (seal, skip when unchanged, FORCE reseal, snapshot, embed, page decrypt). If `LEAGUE_KEY`/`LEAGUE_IDS` were ever
     added as secrets on the PUBLIC repo, delete them there. After changing `LEAGUE_KEY`: run the private workflow
     with **force**.
0c. [x] 2026-09-24: League points race from the sealed round table (backfill R1–R14 + snapshots); Elite "Season vs
     the elite" (gap-to-#100 or total chart, round scores vs top-10/100 averages). R1–R14 cut-offs are an estimate
     from today's top 100 (`est: true`); real ones from R15 via `elite_history.json`. R14 estimate = real, exactly.
0d. [x] 2026-09-24: season archive (`history/2026/`, see Files) committed by the public workflow.
0e. [x] 2026-09-24: Hindsight view: best team per past round (budget $100m / your budget / no cap) and, per own team,
     the best move from its actual starting line-up with its budget, free transfers (−10 extra) and chip. Scoring
     rebuilds F1's official round score exactly for 39/42 team-rounds (R1–R14); the misses are No Negative and Final
     Fix rounds, which aren't modelled and are flagged. Gotchas found: R1's `gd_initial_team` is a draft (treat R1 as
     a fresh pick); Limitless rounds have an empty start line-up; the latest round's budget is only in
     `team_info.maxTeambal`. Invariant worth re-checking after changes: best reachable >= official, except those chips.
1. [x] `data/elite_top100.json` built from the R14 top-100 CSV (100 teams, all names matched). Re-run
   `python elite_import.py "<Downloads>/f1_global_top100_lineups.csv"` after a fresh export and commit the JSON.
2. Leaderboard feeds (public, no login): global top 500 `feeds/leaderboard/public/global/list_1_0_1.json`;
   private league `feeds/leaderboard/privateleague/list_1_{leagueId}_0_1.json` (403 until first published). Rows:
   `cur_rank, cur_points, team_name (URL-encoded), team_no, user_team` (7 PlayerIds) plus `user_name, user_guid,
   social_id` (personal: never publish). Boost and chips are NOT in these feeds; that's what the top-100 CSV adds.
- [ ] TO DO after the Baku race (set 2026-09-26, user's ask): score rhter's post-FP3 sims AND ours against the actual
      result. His numbers + ours (same state: post-FP3, qualifying held back, 20,000 sims, commit 0ac57e8) are in the
      PRIVATE clone `../pit-wall-private/research/rhter-r15-baku-post-fp3.md` (his output stays out of this public
      repo; calibration only). Fill in the actual table there, then compare: xPts MAE / rank corr, race overtakes per
      driver (his ~5.2 vs our ~2.8: the stage 2 speed level x0.70 on its first unseen round), Hadjar / Red Bull (his
      FP3 ideal lap has RED 2nd; ours HAD ~P9), retirement rates, win / pole shares. Keep doing it for rounds he posts.
- [ ] After Baku: compare projections with results and rhter; re-check the practice weights with R15 added. R15 is
      the first round with a frozen projection (`history/2026/projections/gd15.json`); a projected-vs-actual view
      across rounds could go in Hindsight once a few exist.
- [x] Final Fix (2026-09-24): the outgoing driver keeps the sessions before the swap (`ff.cat`, R = before the
      race; order Sprint, Qualifying, Race), the incoming one scores from it on, and the slot keeps its Boost.
      The swap lasts ONE race (found 2026-09-25): MaxPeet's R7 start line-up and R7 budget follow the R6
      qualifying team, not the swapped one (`fillFromLineups` assumed it stayed; fixed).
      Reproduces MaxPeet R6 (203) exactly; with it all 42 team-rounds R1–R14 match official scores. `backfill.py`
      stores the qualifying line-up as `ids` plus `ff: {out, in, cat}` (the export lists 8 ids). Hindsight finds the
      best single swap on top of a team (`hdFF`, within budget) and has an FF chip option. Only one example seen:
      sprint-weekend Final Fix (cat S?) is an assumption. Not offered in the Calculator (a forward FF is a
      post-qualifying decision).

### Feature plan from the f1fantasytools spec review (2026-09-24)
Spec: `Downloads/f1-fantasy-tools-feature-spec.md` (an agent's walk-through of their site). Its R14 Hindsight fixture
(254 pts at $126m) matches our optimiser exactly. Its No Negative rule is WRONG: NN floors every negative scoring
EVENT at 0 (drivers and constructors; the transfer penalty still applies). That reproduces official scores exactly.
User-approved order: 1–5, then the rest.
1. [x] No Negative in Hindsight: all assets' scoring events archived; `hist[].nn` = event-floored points, `hist[].ev` =
   [event index, points, frequency] rows (names/codes in `DATA.evNames`), `hist[].own` = ownership that round.
2. [x] Projections columns: DNF/FL/xOV/DotD were already there; added xNeg (all) and Pit xPts (constructors).
3. [x] Fuller Hindsight: top 10 teams, chip picker for the best team (x3/NN/LL), Incl/Excl, Δ$ column, copy as text.
   Plus the **team-level filter builder** (user asked for it): rules of property + min/max, applied inside the
   optimiser (additive per-asset attributes), for Hindsight and the Calculator's Best Teams.
4. [x] Decision impact per round (their Team Analyzer): transfer impact (IN − OUT − penalty, and Δ$), x2 change
   impact, chip impact (x3 = base(x3) + base(x2); NN = floored − raw; WC = penalties avoided; LL = vs the start
   team), and a season transfer summary (good/bad transfers). F1 records 0 transfers on Wildcard rounds: count
   line-up changes there. With NN modelled, best reachable >= official holds for every team-round except Final Fix.
5. [x] Statistics view: asset × round table (points, price, Δ$, pts/$m, ownership), scoring-category filter,
   AVG column/row, heatmap, own-team highlight, cell click -> that round's scoring lines.
6. [x] Elite ownership ± per round: every build saves `history/2026/elite/<feedTime>_<hash>.json` when the top-500
   line-ups change (`firstSeen` = when we first saw it); the page shows ± vs the previous round's snapshot (from R15).
   [ ] After Baku: read the `firstSeen` times to learn whether the feed's line-ups change at lock or only after the
   race (their site snapshots after the qualifying lock). If only after, the ± compares post-race line-ups.
   The user says (2026-09-24) the feed's line-ups update only AFTER the race; confirm with the Baku `firstSeen` times.
   If so, rivals' picks for a round can't be seen before the race; mid-weekend League live uses last round's
   line-ups (the page already warns when line-ups are older than the lock).
7. [x] League chart (Total / Relative to a chosen team / Race points / Rank, chip badges; rivals' chips need an
   import, which now keeps each chip's round as `chipGd`): "relative to you" and race-points modes, chip markers.
8. [x] Direct xPts override per asset (alongside pace nudges).
9. [x] Calculator rework to match f1fantasytools' Team Calculator (user's screenshots, 2026-09-24; he likes its
   layout and settings pane). Layout: Best Teams (wide, left) | Settings (middle) | Drivers + Constructors (right).
   - Best Teams is one table: sections **Current Team** (always on top, for quick comparison), **Pinned Teams** (↺
     clears them) and **Best Teams**. Columns: # | CR ×2 | x2 | DR ×4 | $ | xPts | xΔ$ (or xΔ$Pts) | xSPts | ⋯.
     Hovering a rank number turns it into a pin icon; clicking pins the team (persisted, re-scored live; a pinned
     team shows the pin icon in the ranked list too). Assets unchanged from the current team are dimmed, new ones
     bright. Header buttons: **Filters** (popover with the filter builder: Total Cost, Expected Price Change,
     Expected Points, DNF/FL/DOTD odds, xOV, negative points, pit points), **Columns** (picker), gear (view options).
     Row ⋯ menu: Pin, Show transfers (OUT → IN, choose x2), Set as current team, Save as manual team, Copy as text.
   - Settings pane: "Select a starting team" dropdown with groups My Teams T1–T3, Select a Manual Team, Rival Teams
     (league members' line-ups) + Manage Rivals; Remaining budget ($, M) & Free transfers (0/1/2/3/∞) with pin /
     edit (team picker modal) / clear buttons; **Max transfer penalty** (0 … −60, −∞) replacing Max transfers;
     "OR Maximum budget" when no starting team; chips X3 LL WC NN AP (used ones greyed); **toggle "Convert expected
     price changes (xΔ$) into expected price change points (xΔ$Pts)"** with a slider "How many points should a 1M
     budget increase earn you per future race? (over N remaining races)". Full Reset + gear.
   - xΔ$Pts on: tiles' second line shows xΔ$Pts per asset (xΔ$ × rate × remaining races) instead of xΔ$; table
     gets xΔ$Pts and xSPts (= xPts + xΔ$Pts) columns and ranks by xSPts; Drivers/Constructors tables get xΔ$Pts and
     xSPts columns. Our existing "Value of $1m" setting is this rate; make it this toggle + slider.
   - Drivers/Constructors tables: search box, Columns picker, editable xPts (ties in with item 8).
   - Later asks, done: Best Teams column headers sort AND set the optimiser's goal (`state.bsort`; $ / xPts / xΔ$ /
     xΔ$Pts / xSPts / odds; value goals use `penW: 0`). On screens ≥1281px the Calculator fits the window and each
     pane scrolls on its own (the page doesn't).
10. [x] Phone layout like f1fantasytools' mobile site (user's screenshots, 2026-09-24): top app bar with the tool
    name and a ☰ full-screen tools menu (built from the rail); the rail is hidden ≤900px; the Calculator's panes are a
    floating bottom tab bar (icon, label on the active one); Best Teams rows fit a 375px phone (constructors stacked,
    drivers 2×2, xPts + xΔ$ (or xSPts + xPts) stacked in `td.mv`, ⋯ under the rank; desktop-only cells carry
    `data-vc`). Elite "Chip usage by round" grid (top-100 export) with T1/T2/T3 outlines of your chip rounds.
    Calculator on a phone is a full-screen app: the panes form a horizontal scroll-snap strip (swipe between Best
    Teams / Settings+Simulation / Drivers / Constructors; tabs follow via a debounced scroll listener, tapping a tab
    scrolls there), each pane scrolls vertically, and the tab bar is docked in normal flow at the bottom (nothing
    under it). The header's team switch is hidden there (Settings has the picker).
11. [x] 2026-09-24: Live Scoring view (`view-live`, `renderLive`). `DATA.live` = the weekend whose lock has passed
    most recently (`live_gd`: the next round from qualifying on, else the last finished one): per asset `pts`,
    session points `sess` (player feed `SessionWisePoints`), scoring lines `ev` (playerstats), `act` (active that
    round: Lawson has two assets, Racing Bulls 114 / Red Bull 116). Your teams' totals use the export line-up for
    that round if there is one, else the current team (Boost ×2, x3, No Negative floors lines; penalties and other
    chips not counted); xPts = the frozen projection, "To go" mid-weekend, Δ once it's over. Tested on R14 (real) and
    a simulated Baku Friday. [ ] Check it against real Baku qualifying (Fri 25 Sep, 12:00 UTC).
    Playerstats caching changed with it: `ps_<id>_<live_gd>_<fingerprint of the live weekend's points>`, so they're
    refetched whenever anything is scored (before, a round's lines froze at race start, missing the race until the
    next round). If lines don't add up to the feed total (playerstats lagging), the file is dropped and refetched.
    Live feed (2026-09-24): Supabase Edge Function "live" (`supabase/functions/live/index.ts`, deployed from the
    dashboard editor with Verify JWT OFF; public, read-only). Its URL slug is `smooth-action` (the editor's random
    first name; renaming in the dashboard doesn't change the slug): `GET /functions/v1/smooth-action?gd=N` fetches F1's player feed
    at most once a minute (cache table `live_cache`, service role only; SQL in setup.sql) and, in the background,
    playerstats only for assets whose points changed (1.5 s apart). Since 2026-09-26: the feed (`body`) and scoring
    lines (`stats`, merged by `live_stats_merge`) are separate columns so the two writers can't undo each other;
    both refreshes are claimed with conditional updates; lagging lines back off 1, 2, 4... up to 30 min; a
    non-404 failure stops the run and keeps `stats_busy` for 3 min. The page calls it on opening Live Scoring and
    every minute while that view is open (`pullLive`, gameday = latest lock passed), and falls back to the build's
    `DATA.live` if it fails. Tested under Node with a mocked table against real R14 feeds (33 assets' lines in
    ~63 s, cache hit within a minute, no refetch when nothing changed). GitHub's cron still skips runs (one
    scheduled run in 4 h on 2026-09-24), but Live Scoring no longer depends on it.
    Deployed and checked 2026-09-24: 35 assets, all 33 scoring-line sets within ~1 min, none lagging, cache hits.
    To redeploy: paste index.ts into the smooth-action function in the dashboard editor (or `supabase functions
    deploy smooth-action` with the CLI) and keep Verify JWT off.
    League live standings (2026-09-24, `renderLiveLeague`): per league (unlocked or imported; picker `state.lvLg`),
    season points before the round + the round so far = live total and rank change. Your teams score as in the
    cards; rivals from their league-feed line-up, Boost from an import only if it covers the round (`state.league.round
    >= gd`), else guessed = their highest-projected driver (shown "2×?"). Official round points from the round
    table (`m.hist`) replace the estimate once they exist (before = feed total − that round). Warns when the line-ups
    are older than the round's lock. Tested with a fake league (R14 final + simulated Baku Friday); not yet on the
    real leagues (needs the passphrase).
- [x] Header cleanup (2026-09-24, user's ask): the header's team buttons and Import are gone (sign-in sync made
    them redundant). Import = any `[data-import]` button (Account & data in the Settings view, bottom of the rail; League empty state)
    opening the hidden `#importFile`. The Calculator picks the team in Settings; Hindsight's budget has one button
    per team (`state.hdCap` = "100" | "team:i" | "none"); Elite has its own team
    picker at the top (`state.elT`, `elTeam()`) for the template, ownership and chip grid. League follows `state.active`.
- [x] Practice archive (2026-09-24): OpenF1 refuses everything, past sessions included, while any F1 session is live,
    and the CI runs during Baku FP1/FP2 had no cached copy, so the site had NO practice for Baku. Now each analysed
    session is saved in `history/2026/practice/gdNN.json` and reused when OpenF1 is closed; one failing session no
    longer drops the others (`practice.py`). FP2 moved Baku projections by at most ±1.3 (mostly undoing FP1's
    shifts: ANT back up, VRB/LAW down).
12. [x] 2026-09-24 built, and the user signed in on the live site. "Unable to exchange external code" = the Client secret
    in Supabase's Google provider doesn't match the Client ID: add a new secret in Google Cloud and paste both again
    (Google shows a secret only once). Confirmed the same day: his phone picked up teams + leagues. Supabase project
    `tfljgylwpkpammzsapin` (URL + publishable key are public, in web/js/sync.js and refresh.yml); SQL in
    `supabase/setup.sql` (table, RLS, grants, server-set `updated_at`, `ping()`). Google provider on, Email off,
    sign-ups on (the Google test-user list is the gate). Page: `syncState` + `syncInit/pull/push/applyRemote` after `save()`;
    synced = all of `state` except `NOSYNC` (view, pane, showN); `pitwall.sync` = {uid, at, dirty}. Since 2026-09-26
    (security review) the account never holds the league passphrase: each browser keeps a non-extractable PBKDF2
    key made from it in IndexedDB (`keyGet/keyPut/keyDel`, `unlock`, `unlockSaved`), so a new browser asks once.
    Old plain-text copies (localStorage `pitwall.lk`, an account row's `lk`) are used once, then deleted/overwritten.
    Rules: a row changed since this browser's mark wins if this browser has nothing unsent; unsent local edits are
    pushed if the row didn't change; if both changed, or a browser with its own teams has no mark, it asks which to
    keep (nothing syncs until it chooses). Before 2026-09-24 the both-changed case silently dropped the local edits. Re-pulls on tab focus. `fillFromLineups`
    fills an all-example browser from the sealed export line-ups after unlock. Tested against a mocked table
    (first sign-in, debounced push, other-device pull, ask-on-conflict, sign-out flush, Final Fix line-up fill).
    Keep-alive: refresh.yml calls `rpc/ping`; still to confirm Supabase counts that as activity.
    Original plan (agreed 2026-09-24): sign in with Google so a new browser shows your teams and leagues.
    Goal: open the site anywhere, sign in once, see teams, settings and leagues with no Import.
    - Supabase only (free tier): Supabase Auth with the Google provider + one table `configs(user_id uuid pk ->
      auth.users, data jsonb, updated_at timestamptz)` with RLS `auth.uid() = user_id` for select/insert/update.
      `data` = teams, drafts, pins, filters, xo, adj, marks, calculator settings, and the user's `LEAGUE_KEY`.
      No Cloudflare, no passkeys, no client-side vault: RLS is enough for this data (decided with the user).
      E2E encryption can be layered on later without changing the UX.
    - Site stays on GitHub Pages; league data stays sealed in the build. After sign-in the page reads the row,
      restores settings and calls tryUnseal(LEAGUE_KEY). Saves are debounced (~2 s) upserts; latest write wins.
      First sign-in on a browser offers to upload its current local settings. Missing teams fall back to the
      sealed export line-ups (`lineups`).
    - Keep-alive: free projects pause after ~1 week idle; have refresh.yml make a tiny anon request each run
      (verify that counts as activity).
    - Page: supabase-js bundled into `web/vendor/supabase.js` (`npm run vendor`; was jsdelivr until 2026-09-26);
      the page ships a hash-based CSP (`refresh.content_policy`); "Sign in with Google" in the ☰ menu and Settings; "Synced n min ago";
      sign out (clears the local session and the stored key).
    - User setup (once): Supabase project (send URL + anon key; both public); Google Cloud consent screen in
      TESTING mode with his email as test user + web OAuth client; paste client id/secret into Supabase's Google
      provider; Site URL / redirect = https://kylebotho.github.io/pit-wall/; run the SQL Claude provides.
    - Multi-user later (designed for it now): rows are per user already. Add users as Google test users (≤100)
      or publish the consent screen (basic scopes need no verification); optional `allowed_emails` table checked
      in RLS. Their teams/settings work at once (they Import their own export once). Their LEAGUES need new work:
      store league IDs per user and have the private workflow fetch + seal per user with each user's key
      (F1 feeds have no CORS, so fetching stays server-side).
- [x] 2026-09-24 UI/UX review (user asked for a score + tab merges): the Calendar and Model views moved into
    Settings (Account & data | Model settings | How it works, then a "Circuits" section; hidden once the season is
    over). Saved `view` "cal"/"model" maps to "settings" in `normalise`. Same day, all approved: the rail is 6 items.
    `GROUPS` (main.js) = one rail button per group with sub-tabs (`#subTabs`): Projections (assets, prices, grid,
    practice), Leagues (league, elite), Season (hind, stats); a group button reopens `state.sub[group]`. Compare is a
    Best Teams | Compare switch in the Calculator's left pane (`state.bmode`; saved view "compare" -> calc + cmp);
    manual teams are edited in the team-editor pop-up (`openTeamEditor(i)`, `editTarget`/`editing()` in calc.js;
    `openTeamEditor(null)` = the starting team). Best Teams and Compare each sit in a `div[data-bm]`; on screens
    >=1281px Best Teams passes the height to its table (own scroll bar) and Compare scrolls whole.
    Desktop rail (>=901px) opens on hover into a labelled menu over the page, like f1fantasytools' (user's screenshot):
    logo + name on top, account row `#railAcct` (filled by `renderSync`) at the bottom. Keyboard focus keeps it open via
    `.rail:has(:focus-visible)`, not `:focus-within` (a clicked item would hold it open).
- [x] 2026-09-24 Simulation presets (user's f1fantasytools screenshots): the Calculator's Simulation panel picks
    `state.simPreset` = "sim" (our Monte Carlo) | "classic" | "weighted" (`simDecay`) | "form" (`simWin`) | "ppm".
    `Engine.presetWeights` + `Engine.pastPoints` (tested): per-round weighted average of each asset's scoring lines
    (rounds it didn't race don't count), sprint ("S …") lines averaged over sprint rounds and added on sprint weekends,
    categories in `simOff` left out; PPM = price x points per $1m of its kind and tier (under / from $18.5m).
    `compute()` sets `proj[k].mean` from it and shifts the simulated distribution to match (like xPts edits, which
    still apply on top). Per-round weights by hand in `simW` (cleared when the preset/decay/window changes);
    `simSprint` {gd, v} runs the next race as a sprint weekend or not (the sim too). rhter's sims are NOT offered
    (calibration only, never in the product).
- [x] 2026-09-24 Best Teams sort bug: ranking by xΔ$ looked up `fprop(id).xd`, but fprop calls it `d`, so every
    asset scored 0 and the list was 60 arbitrary teams sorted afterwards. Fixed; every sortable column now matches a
    brute force over all legal teams in both directions (checked in the browser). xPts / xSPts rank highest first
    only: minimising gave the Boost to the worst driver and counted penalties the wrong way.
- [x] 2026-09-24 Settings | Simulation divider (wide screens, `#setSplit`): drag, arrow keys, double-click resets.
    The position lives in `setSplit` (calc.js) only, NOT in `state`: the user wants a reload to reset it. Also fixed:
    `applyRemote` now keeps every `NOSYNC` key (before, only view and pane survived a sync from another device).
- [x] 2026-09-24 UI polish from the second review (7.5/10): how-to paragraphs moved into ⓘ popovers
    (`details.info` next to a title; outside click / Escape closes; fixed-position inside the Calculator, a sheet on
    phones); status lines stay visible. Plain wording (league passphrase, no GitHub/Claude for Chrome), sign-in +
    import prompts where only example teams exist (`[data-needsync]` = hidden unless sign-in works). Calculator
    settings show either budget+transfers (a team) or Maximum budget (no team); labelled Keep all / Edit / Clear.
    Statistics categories in a dropdown like Simulation's. Header labelled "Next race". Live panels sit side by side
    at content width (`.lvgrid`), roomier heat tables, Settings stacks Account + Model left. Type: tables/notes 14px
    (13px in the Calculator), `--dim` #8b8b94. Drivers with two assets show the team (`DUP_TLA`, all name cells use
    `who()`).
- [x] 2026-09-24 Calculator Settings in collapsible sections (`details.grp`: Starting team / Plan & chip / Price changes),
    each summarised in its header while closed; open state in `state.calcGrp` (per device, not synced). Table
    alignment: `alignTable` (core.js) classes every column from its cells (text left, numbers right, controls and mini
    charts centred, number boxes right; the header follows), re-run by a MutationObserver in main.js whenever a table
    changes, so new tables need no alignment CSS. Found with it: tables with class "stat" also matched the tile rule
    `.stat` (display:flex), so Live/Statistics/league headers didn't line up with their columns; that rule is now
    `.stat:not(table)`. Checked in the browser: 16 tables, every header over its column, one alignment per column.
- [x] 2026-09-24 Last polish (review 8.5/10): `lineChart` (league.js) draws at the box's real width (text 12px;
    before, a 640-unit SVG stretched to ~1300px doubled every label), redrawn by a ResizeObserver; Elite cut-off tiers
    get neutral steps (#1 lightest .. #500 darkest). Global cut-offs: one sign-in/import row until a team has points.
    Heat keys (`heatKey()` in forecast.js; `#…Key` under Points, Budget, Positions (purple ramp), Live, Statistics),
    hidden when heatmap colours are off. `recompute()` shows the header's "Updating…" tag and dims visible tables
    (`busy()`, at least 30 ms so it paints before the synchronous work).
Not doing (agreed): paywall/subscriber data, suggestions box, curve styles, view toggles, "+" search, analyst
presets/scenario versions, light theme, log rank scale, treemaps/gauges.
