# Fantasy Pit Wall: data sources (all public, no login)

Moved out of CLAUDE.md on 2026-10-19. The rules from this page are also in CLAUDE.md "Rules".

- `fantasy.formula1.com/feeds/...`: `schedule/raceday_en.json`, `drivers/{gameday}_en.json` (prices, points, ownership),
  `popup/playerstats_{PlayerId}.json` (per-race scoring events). No CORS — only server-side fetches work.
- Jolpica `api.jolpi.ca/ergast/f1/2026/{results,qualifying,sprint}.json` (qualifying Q1-Q3 times -> `gap` % per
  driver), `/2026.json` (circuit ids, coordinates) and past seasons (priors.py).
- OpenF1 per race: `race_control` (SC/VSC/red, grid penalties, incidents), `weather` (rain), `pit`, `stints`, `starting_grid`, `laps`
  (race pace), `session_result` (qualifying order once run). `overtakes` exists for 2023-2025 only.
- Polymarket `gamma-api.polymarket.com/events?tag_slug=f1` (keyless: every weekend market with bid / ask / last)
  and `clob.polymarket.com/books` (POST, batched token ids: depth). Collected only (2x plan L2).
- Kalshi `api.elections.kalshi.com/trade-api/v2` (public reads, no key): series KXF1RACE (winner), KXF1RACEPODIUM,
  KXF1TOP10, KXF1POLE; events `<series>-<AZEGP26>`. Settled markets move to `/historical/markets` (plain price fields).
- Open-Meteo `api.open-meteo.com/v1/forecast` (no key): hourly precipitation probability; `ensemble-api.open-meteo.com`
  (ECMWF IFS, 51 members) for the joint wet chance of the weekend's sessions.
- FIA documents (`fia.com/documents/championships/fia-formula-one-world-championship-14`, HTML, slow ~30 s): the
  decision documents index, fetched around race weekends (collect.py). The car-infringement PDFs are read once each
  (pypdf) for GRID PENALTIES: race control (OpenF1) announced none in 2026, so this is the only source.
- FastF1 (pip) reads `livetiming.formula1.com/static` — the fallback for practice when OpenF1 is locked.
- Grid penalties: stewards' decisions (collect.fia_penalties reads them; collect.grid_ledger gives each its target
  race: this event's if published before its race, else the next, carried past a race the driver missed; kept in
  history/<season>/penalties.json, read by the live weekend and walk.js penAt) + race control + the manual picker in Settings >
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
