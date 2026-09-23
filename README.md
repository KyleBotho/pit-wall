# Pit Wall Planner

F1 Fantasy 2026 planner: simulated race weekends scored with the official rules, best transfers,
price-change odds, and practice-session pace.

- `refresh.py` pulls public data (F1 Fantasy feeds, Jolpica results, OpenF1 practice laps) and builds `build/pit-wall.html`.
- `engine.js` is the simulation, scoring and optimiser; `practice.py` turns practice laps into pace.
- `.github/workflows/refresh.yml` rebuilds and publishes to GitHub Pages every 30 min Thu–Sun and every 6 h otherwise.
  Use **Actions → Refresh data and publish → Run workflow** for an immediate refresh.

Your team, bank and chips are stored only in your browser.
