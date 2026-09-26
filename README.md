# Fantasy Pit Wall

F1 Fantasy planner: simulated race weekends scored with the official rules, best transfers, price-change odds,
practice-session pace, hindsight on past rounds, live scoring and private leagues. Live at
https://kylebotho.github.io/pit-wall/.

## Layout

| Path | What |
| --- | --- |
| `refresh.py` | Fetches the public data (F1 Fantasy feeds, Jolpica, OpenF1) and builds `build/index.html` |
| `f1feeds.py` | Shared, paced feed helpers (also used by the private repo's `leagues.py`) |
| `practice.py` | Practice laps -> short-run and long-run pace |
| `engine.js` | Simulation, scoring, price rule, optimiser (pure; runs in the page and in Node) |
| `hindsight.js` | Best teams on actual points; rebuilds official round scores (pure) |
| `web/` | The page: `app.html` shell, `app.css`, `js/*.js` (ES modules, entry `main.js`; bundled by `tools/bundle.js` and inlined at build) |
| `config/` | `season.json` (teams, circuits, field size, example team) and `feeds.json` (event codes, pacing) |
| `tests/` | `npm test` (Node) and `python -m unittest discover tests` |
| `backtest/` | `npm run backtest`: the evidence behind the model settings |
| `supabase/` | Sign-in database SQL and the Live Scoring function |

## Commands

```bash
python refresh.py
```

Fetches everything and rebuilds. `python refresh.py --offline` rebuilds the page from the last fetch (for page edits).

```bash
npm run check
```

Lint, formatting, types and tests (run `npm ci` once first; `python refresh.py` needs it too, to bundle the page). Python: `ruff check . && ruff format --check .`.

**Actions → Refresh data and publish → Run workflow** refreshes the live site immediately; it also runs every 30 min
Thu–Sun and every 6 h otherwise. Your teams and settings stay in your browser (and your account, if you sign in).
