# Pit Wall Planner — F1 Fantasy 2026

Personal F1 Fantasy planner that replaces an f1fantasytools.com subscription. Live at
https://kylebotho.github.io/pit-wall/ (repo `KyleBotho/pit-wall`, public). A private Claude artifact copy also
exists (https://claude.ai/artifact/FBsMrxqHKqWBTC9wqytXTF) but only updates when republished.

## Files
- `refresh.py` — fetches data, builds `build/index.html` (GitHub Pages, own doctype/viewport) and
  `build/pit-wall.html` (Claude artifact; the publisher wraps it). Paced 2.5 s/request; caches finished rounds in `cache/`.
- `engine.js` — pure JS, no DOM: `buildModel` (pace, DNF, overtakes, pit stops, practice blend, track-type shift),
  `simulate` (Monte Carlo weekend scored with official 2026 rules), `trackModel`, `priceStep`, `optimise`.
  Loadable from node (`require("./engine.js")`) for checks.
- `practice.py` — OpenF1 practice laps -> short-run (best lap / best-sector sum) and long-run (5+ lap stints,
  fuel/tyre/compound-corrected) gaps.
- `app.html` — the page (inlines engine.js and data at build). Dark zinc UI modelled on f1fantasytools
  (the user's explicit ask): icon rail, Team Calculator dashboard (Best Teams | My Team + Settings |
  Drivers + Constructors), 44px asset chips. Inspiration only — never their name/logo.
- `.github/workflows/refresh.yml` — rebuild + deploy every 30 min Thu–Sun, every 6 h Mon–Wed, on push, and manually.
- `research/f1fantasytools-notes.md` — catalogue of f1fantasytools features.
- `seal.js` — AES-256-GCM + PBKDF2-SHA256 (250k) sealing of stdin with `LEAGUE_KEY`; the page's `unseal` mirrors it.
  Used by the private repo's workflow, which checks this repo out.
- `elite_import.py` — top-100 line-ups CSV -> `data/elite_top100.json` (anonymous Boost/chip aggregates).
- `data/league.sealed.json` — encrypted league standings, written ONLY by the private repo's workflow. Don't hand-edit.
- Private repo `KyleBotho/pit-wall-private` (local clone `../pit-wall-private`): `leagues.py` + `leagues.yml`
  (every 6 h, hourly Sun–Mon) fetch the private-league feeds, keep plaintext `history/<leagueId>/<feedTime>.json`
  there, and push the sealed snapshot here with the `PUBLIC_REPO_TOKEN` PAT (which triggers a rebuild). Secrets
  `LEAGUE_KEY`, `LEAGUE_IDS`, `PUBLIC_REPO_TOKEN` live in that repo only. Its runs aren't visible without auth;
  check for its commits here instead: `https://api.github.com/repos/KyleBotho/pit-wall/commits?path=data/league.sealed.json`.

## Commands
- Rebuild locally: `python refresh.py` (run from this folder; `PYTHONIOENCODING=utf-8` on Windows bash).
- Deploy: commit and `git push` (Git Credential Manager handles auth; no gh CLI). Pages rebuilds on push.
- Update the Claude artifact: Artifact publish `build/pit-wall.html` with url above.
- Check a CI run without auth: `https://api.github.com/repos/KyleBotho/pit-wall/actions/runs?per_page=3`.

## Data sources (all public, no login)
- `fantasy.formula1.com/feeds/...`: `schedule/raceday_en.json`, `drivers/{gameday}_en.json` (prices, points, ownership),
  `popup/playerstats_{PlayerId}.json` (per-race scoring events). No CORS — only server-side fetches work.
- Jolpica `api.jolpi.ca/ergast/f1/2026/{results,qualifying,sprint}.json`.
- OpenF1 `api.openf1.org/v1/{sessions,laps,stints,drivers}` (practice; free data lands shortly after sessions).
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
0c. [ ] Season history: the private repo now keeps one snapshot per leaderboard update. Add the per-round points to
     the sealed payload so the League "Points race" chart works without an Import.
1. [x] `data/elite_top100.json` built from the R14 top-100 CSV (100 teams, all names matched). Re-run
   `python elite_import.py "<Downloads>/f1_global_top100_lineups.csv"` after a fresh export and commit the JSON.
2. Leaderboard feeds (public, no login): global top 500 `feeds/leaderboard/public/global/list_1_0_1.json`;
   private league `feeds/leaderboard/privateleague/list_1_{leagueId}_0_1.json` (403 until first published). Rows:
   `cur_rank, cur_points, team_name (URL-encoded), team_no, user_team` (7 PlayerIds) plus `user_name, user_guid,
   social_id` (personal: never publish). Boost and chips are NOT in these feeds; that's what the top-100 CSV adds.
- [ ] After Baku: compare projections with results and rhter; re-check the practice weights with R15 added.
- [ ] Final Fix chip isn't modelled in the optimiser.
