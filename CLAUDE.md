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
- `web/app.html` + `web/app.css` + `web/js/*.js` — the page. ES modules with explicit imports (since 2026-09-26),
  entry `main.js`; `tools/bundle.js` (esbuild) bundles them and supabase-js from npm into one script that refresh.py
  inlines (so `python refresh.py` needs `npm ci`). Engine and Hindsight stay classic scripts (also used by Node);
  the data is a `<script type="application/json" id="pw-data">` block. A value another module reassigns needs a
  setter in its own module (`setState`, `keepUndo`, `endTeamEdit`, `resetSplit`). `lab.js` = the owner-only Sim lab (item 9 stage 6). Dark zinc UI modelled on f1fantasytools (the user's explicit ask); inspiration only,
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
Everything finished, with the reasoning and evidence behind it, is in `docs/history.md` (dated entries). Search
there before re-deciding something.

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
- [ ] After each round: `npm run backtest 6 7` (the gate + frozen projection vs result); `npm run fit` again after
      a few more rounds.
- [ ] Item 9, the lap-by-lap race model (history: To do, item 9): stages 2-5 built and backtested (most off by
      default; see Model decisions), the Sim lab tab is live. Still to do there: the later stages in the plan. The
      server-side locks (owner-only results table, rerun via an edge function) aren't needed while the lab runs in the
      browser (design change 2026-09-25, history: item 9 stage 6); revisit if a slow model is adopted (runs move to
      CI) or the lab's results/code should go private.

Private league IDs are never written into this public repo: anyone holding one can read that league's feed,
manager names included. They live in the `LEAGUE_IDS` secret and the private repo.
