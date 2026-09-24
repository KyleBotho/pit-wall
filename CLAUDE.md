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
- Logged-in data (own teams, private/global leagues, rivals' teams) is NOT fetched by code. The user collects an
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

## Open items
- [ ] Elite tab (top-100/500 ownership, x2 %, chip timing, differentials) — waiting on a global-leaderboard export
      from Claude for Chrome (also capture the exact leaderboard feed URL; if public, automate standings).
- [ ] Automatic private-league standings — needs the exact `leaderboard/privateleague/list_…` file name from a real
      logged-in request. Don't guess feed parameters (blocked as probing).
- [ ] Bump `actions/deploy-pages` / `upload-pages-artifact` off Node 20 before GitHub removes it (warning in runs).
- [ ] After Baku: compare projections with results and rhter; re-check the practice weights with R15 added.
- [ ] Final Fix chip isn't modelled in the optimiser.
