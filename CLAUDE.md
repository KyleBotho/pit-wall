# Pit Wall Planner — F1 Fantasy 2026

Personal F1 Fantasy planner that replaces an f1fantasytools.com subscription. Live at
https://kylebotho.github.io/pit-wall/ (repo `KyleBotho/pit-wall`, public). A private Claude artifact copy also
exists (https://claude.ai/artifact/FBsMrxqHKqWBTC9wqytXTF) but only updates when republished.

## Files
- `refresh.py` — fetches data, builds `build/index.html` (GitHub Pages, own doctype/viewport) and
  `build/pit-wall.html` (Claude artifact; the publisher wraps it). Paced 2.5 s/request; caches finished rounds in `cache/`.
- `engine.js` — pure JS, no DOM: `buildModel` (pace, DNF, overtakes, pit stops, practice blend, track-type shift),
  `simulate` (Monte Carlo weekend scored with official 2026 rules), `trackModel`, `priceStep`, `optimise`,
  `recentForm`/`blendMean`/`DEFAULTS` (shared with the page) and `project` (next race at default settings, used by
  refresh.py to freeze projections). Loadable from node (`require("./engine.js")`) for checks.
- `practice.py` — OpenF1 practice laps -> short-run (best lap / best-sector sum) and long-run (5+ lap stints,
  fuel/tyre/compound-corrected) gaps.
- `app.html` — the page (inlines engine.js and data at build). Dark zinc UI modelled on f1fantasytools
  (the user's explicit ask): icon rail, Team Calculator dashboard (Best Teams table | Settings + Simulation |
  Drivers + Constructors), 44px asset chips. Inspiration only — never their name/logo. Calculator state: the
  starting team is `ST()` (your team `A()`, a manual team, a rival's line-up or none, via `S.calcStart`); pins in
  `S.pins`; xPts edits in `S.xo` (applied to the next race's projection in `compute()`, distribution shifted);
  xΔ$Pts = `S.xdp` + `S.valW` pts per $1m per remaining race; max penalty `S.maxPen` (null = any).
- `.github/workflows/refresh.yml` — rebuild + deploy every 30 min Thu–Sun, every 6 h Mon–Wed, on push, and manually.
  Commits `history/` after each build (GITHUB_TOKEN pushes don't retrigger it), so it has `contents: write`.
- `history/2026/` — the season archive, saved as it happens: `players/gdNN.json` raw player feed per finished round
  (read back instead of refetched; the latest round is refetched for late corrections), `playerstats/<id>.json`
  latest per-asset scoring events, `projections/gdNN.json` our default-settings projection, rewritten until lock and
  then frozen (embedded as `DATA.projHist` for projected-vs-actual).
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `seal.js` — AES-256-GCM + PBKDF2-SHA256 (250k) sealing of stdin with `LEAGUE_KEY`; the page's `unseal` mirrors it.
  Used by the private repo's workflow, which checks this repo out.
- `elite_import.py` — top-100 line-ups CSV -> `data/elite_top100.json` (anonymous Boost/chip aggregates).
- `data/league.sealed.json` — encrypted `{leagues, rounds, lineups}`, written ONLY by the private repo's workflow.
  `rounds` = per-round points per team (League chart, Elite season); `lineups` = the user's own teams per round
  (ids, start line-up, boost, x3, budget, free, subs, chip) for Hindsight. Don't hand-edit.
- `data/elite_history.json` — real global cut-offs/means per gameday, written by the private workflow (plaintext,
  numbers only). `refresh.py` merges it over the estimated R1–R14 paths in `data/elite_top100.json` `history`.
- Private repo `KyleBotho/pit-wall-private` (local clone `../pit-wall-private`): `leagues.py` + `leagues.yml`
  (every 6 h, hourly Sun–Mon) fetch the private-league feeds and the global top 500, keep plaintext
  `history/<leagueId>/<feedTime>.json` and `history/global/` there, map each snapshot to a gameday via the schedule
  (last race started before the feed time), and push the sealed snapshot and `elite_history.json` here with the `PUBLIC_REPO_TOKEN` PAT (which triggers a rebuild). Secrets
  `LEAGUE_KEY`, `LEAGUE_IDS`, `PUBLIC_REPO_TOKEN` live in that repo only. Its runs aren't visible without auth;
  check for its commits here instead: `https://api.github.com/repos/KyleBotho/pit-wall/commits?path=data/league.sealed.json`.

## Commands
- Rebuild locally: `python refresh.py` (run from this folder; `PYTHONIOENCODING=utf-8` on Windows bash).
- Deploy: commit and `git push` (Git Credential Manager handles auth; no gh CLI). Pages rebuilds on push.
  `git pull --rebase` first: both workflows push to main (history, sealed files).
- After a fresh F1 Fantasy export (Claude for Chrome -> `Downloads/f1fantasy_official_data_<date>.json`): in
  `../pit-wall-private` run `python backfill.py "<that file>"` and push. It rewrites `history/backfill.json` (round
  points R1+ and the user's per-round line-ups), and the push triggers a reseal. Own line-ups need login, so they
  only advance with exports; everything else is saved automatically.
- Update the Claude artifact: Artifact publish `build/pit-wall.html` with url above.
- Check a CI run without auth: `https://api.github.com/repos/KyleBotho/pit-wall/actions/runs?per_page=3`.

## Data sources (all public, no login)
- `fantasy.formula1.com/feeds/...`: `schedule/raceday_en.json`, `drivers/{gameday}_en.json` (prices, points, ownership),
  `popup/playerstats_{PlayerId}.json` (per-race scoring events). No CORS — only server-side fetches work.
- Jolpica `api.jolpi.ca/ergast/f1/2026/{results,qualifying,sprint}.json`.
- OpenF1 `api.openf1.org/v1/{sessions,laps,stints,drivers}` (practice; free data lands shortly after sessions).
  While ANY F1 session is live, OpenF1 returns 401 for everything (paid key only). `refresh.py` uses `get_soft`
  for it: one attempt, cached copy on failure, never aborts the build (seen 2026-09-24 during Baku FP1).
- The old `fantasy-api.formula1.com` API (Postman doc, dlthub, skelmis package) is dead since 2023 — don't use.
- Private-league standings come from the private repo (above), sealed. Chips, bank and round history are
  logged-in data and are NOT fetched by code. The user collects an
  export with Claude for Chrome; the page's Import button reads it in the browser only (localStorage).
  Never put league or personal data into the repo/site, and never handle the user's F1 login or tokens.

## Model decisions (backtested — keep unless new evidence)
- Scoring = official 2026 rules (sprint DNF −10, sprint losses capped −10, constructor Q2/Q3 bonus, pit bands).
- Price change: 3-race avg pts / price, rounded to 3 dp; bands 0.605 / 0.9 / 1.195; ≥$18.5m ±0.1/0.3, else ±0.2/0.6;
  clamp $3–34m. Fitted on 2026 history and matches f1fantasytools.
- Practice: short-run rank blended 30% into quali pace, long-run 10% into race pace, pull capped ±6 places
  (R6–R14 backtest). Only applied to the next race.
- Race pace from finish rank rescaled to a full field; DNF = team rate, recent-weighted (half-life 6), shrunk k=4.
- Track type: circuits tagged [power, street, fast corners] in `engine.js` CIRCUITS. Leave-one-out on R1–R14:
  overtaking fit ~13% better (used), DNF ~4% (mild), team-specific pace ~0% (kept tiny, ridge λ=8).
- Neutral-track sim matches actual 2026 per-category points; FL/DOTD go to the top seven ~90% of the time.
- Default 10,000 sims per race × next 3 races. Optimiser enumerates all 5-driver × 2-constructor teams.
- vs rhter's Baku sim (f1fantasytools): MAE 4.6; we're higher on Alpine/midfield, lower on Ferrari.

## Open items — next session starts here
Private league IDs are never written into this public repo: anyone holding one can read that league's feed,
manager names included. They live in the `LEAGUE_IDS` secret (and, after 0b, the private repo).

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
   - Later asks, done: Best Teams column headers sort AND set the optimiser's goal (`S.bsort`; $ / xPts / xΔ$ /
     xΔ$Pts / xSPts / odds; value goals use `penW: 0`). On screens ≥1281px the Calculator fits the window and each
     pane scrolls on its own (the page doesn't).
10. [x] Phone layout like f1fantasytools' mobile site (user's screenshots, 2026-09-24): top app bar with the tool
    name and a ☰ full-screen tools menu (built from the rail); the rail is hidden ≤900px; the Calculator's panes are a
    floating bottom tab bar (icon, label on the active one); Best Teams rows fit a 375px phone (constructors stacked,
    drivers 2×2, xPts + xΔ$ (or xSPts + xPts) stacked in `td.mv`, ⋯ under the rank; desktop-only cells carry
    `data-vc`). Elite "Chip usage by round" grid (top-100 export) with T1/T2/T3 outlines of your chip rounds.
11. [ ] Option (not started): a Live Scoring view like theirs (per-asset category breakdown for the current weekend,
    your teams' running totals). Only as fresh as the last build (every 30 min Thu–Sun): F1's feeds have no CORS.
Not doing (agreed): paywall/subscriber data, suggestions box, curve styles, view toggles, "+" search, analyst
presets/scenario versions, light theme, log rank scale, treemaps/gauges.
