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
  `own`, Final Fix `ff`) and `score(lineup, gd)`, which rebuilds F1's official round score (42/42 team-rounds).
- `practice.py` — OpenF1 practice laps -> short-run (best lap / best-sector sum) and long-run (5+ lap stints,
  fuel/tyre/compound-corrected) gaps. A stint still open (no `lap_end`) runs to the driver's last lap. When OpenF1
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
  live, calc, views, main). Dark zinc UI modelled on f1fantasytools (the user's explicit ask); inspiration only,
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
  then frozen (embedded as `DATA.projHist` for projected-vs-actual), `practice/gdNN.json`, `elite/`.
- `tests/` — `node --test` (engine vs brute force, price rule vs real changes, scoring lines, state migrations,
  seal round-trip, shared tables, Hindsight vs official scores when the private clone is next door) and
  `python -m unittest discover tests` (feed helpers, practice, page build incl. season over).
- `backtest/run.js` (`npm run backtest [section numbers]`) — 1 price rule, 2 track model (leave-one-round-out, circuit
  history weight alpha), 3 retirements, 4 practice weights, 5 calibration by scoring category, 6 THE GATE:
  walk-forward projected points vs actual (CRPS, MAE, coverage, team pick; variants without market/practice/...),
  7 frozen projections vs results, 8 pit-stop rule vs scoring lines. `backtest/walk.js` = the shared walk-forward
  harness (`asOf(r)` rebuilds the data as it stood before round r; exact CRPS). `backtest/fit.js` (`npm run fit`) =
  coordinate-descent fit of SIM/MODEL settings on walk-forward CRPS. `backtest/practice_rounds.py` and
  `backtest/odds_rounds.py` rebuild `practice_by_round.json` / `odds_by_round.json` (Kalshi prices at each past lock;
  settled events need the `historical/` API, one request per driver).
- `tools/sync-shared.js` — writes the event tables from `config/feeds.json` into the Supabase function (it's
  deployed by pasting one file); `tests/shared.test.js` fails if they drift.
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `supabase/setup.sql` — the sign-in/sync database (item 12). Re-runnable in Supabase's SQL Editor.
- `seal.js` — AES-256-GCM + PBKDF2-SHA256 (250k) sealing of stdin with `LEAGUE_KEY`; the page's `unseal` mirrors it
  (`tests/seal.test.js`). Used by the private repo's workflow, which checks this repo out.
- `elite_import.py` — top-100 line-ups CSV -> `data/elite_top100.json` (anonymous Boost/chip aggregates).
- `data/league.sealed.json` — encrypted `{leagues, rounds, lineups}`, written ONLY by the private repo's workflow.
  `rounds` = per-round points per team (League chart, Elite season); `lineups` = the user's own teams per round
  (ids, start line-up, boost, x3, budget, free, subs, chip) for Hindsight. Don't hand-edit.
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
  points R1+ and the user's per-round line-ups), and the push triggers a reseal. Own line-ups need login, so they
  only advance with exports; everything else is saved automatically.
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
- Private-league standings come from the private repo (above), sealed. Chips, bank and round history are
  logged-in data and are NOT fetched by code. The user collects an
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
- Section 6 now: CRPS 8.85, MAE 12.17 (drivers 10.7, constructors 15.2), bias +0.03, rank corr 0.74, 85% inside the
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
- Unchanged: price rule (390/392), DNF team rate shrink k=16 no recency (log loss 0.4608), official scoring.
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

### To do (agreed 2026-09-25, in this order)
- [ ] Mechanical "model team" in Hindsight: what a hands-off follower of the frozen projections would have scored each
      round (rhter's public "stats team" ranked 1,166–4,105 globally in 2023–25; a benchmark for ours).
- [ ] Try in the backtest before adopting: lap-time noise in 1/t² space (skewed like real mistakes); a car-level +
      driver-offset team-mate model; fastest-lap / DNF odds if Kalshi (or another free source) runs per-race markets
      in 2026 (only 2025 fastest-lap events seen; KXF1RETIRE is season-long). rhter blends FL odds 50/50 and takes DNF%
      from bookmakers; his users showed that misses chronic cases (Stroll), so test, don't switch.
- [ ] One-click overtake scenarios (low / base / high) on top of the circuit Overtaking slider.
- [ ] Budget value slope per constructor pair (rhter: ~1.2 MCL+FER to ~1.7 with one A-tier constructor; leave
      sprints out of the slope). Low priority: he's moving away from hard budget optimisation himself.
- [ ] Value of an extra transfer (nobody models it).
- [ ] 9. The big one, once the rest is done (user wants time spent to get it right): a lap-by-lap race model built on
      sub-lap segments (rhter's own limitation: one time per lap can't produce DRS trains), car-performance envelopes
      (g-g-V from telemetry, projected onto the next track's geometry for pre-practice pace), minisector ideal laps
      (two disjoint sets, less sensitive to one perfect sector), and an energy-deployment model (2026 overtakes come
      from charge differences on energy-starved tracks: the "yo-yo"). Data: FastF1 / OpenF1 telemetry (car_data,
      location). Judge it with the section 6 gate: it has to beat the current model, not just look more realistic.
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
- [ ] After Baku: compare projections with results and rhter; re-check the practice weights with R15 added. R15 is
      the first round with a frozen projection (`history/2026/projections/gd15.json`); a projected-vs-actual view
      across rounds could go in Hindsight once a few exist.
- [x] Final Fix (2026-09-24): the outgoing driver keeps the sessions before the swap (`ff.cat`, R = before the
      race; order Sprint, Qualifying, Race), the incoming one scores from it on, and the slot keeps its Boost.
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
    playerstats only for assets whose points changed (1.5 s apart). The page calls it on opening Live Scoring and
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
    synced = all of `state` except `NOSYNC` (view, pane, showN) plus `lk` (LEAGUE_KEY, only while `state.syncKey`:
    "Keep my league passphrase in my account", default on); `pitwall.sync` = {uid, at, dirty}.
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
    - Page: supabase-js from jsdelivr; "Sign in with Google" in the ☰ menu and Settings; "Synced n min ago";
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
