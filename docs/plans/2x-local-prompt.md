# Prompt for the local session (2x plan, phase "Now" and R18-R24)

Paste everything below the line into a local Claude Code session started in the pit-wall folder.

---

Read `docs/plans/2x-predictions.md` (the plan) and CLAUDE.md's open item "Twice as good". It was written on
2026-10-12 in a cloud session that couldn't reach the data feeds. It only read the committed `history/2026/` archive
and never ran the engine. The plan and `backtest/scorecard.py` are on branch `claude/beautiful-faraday-pr6zr7`. Your
job is the plan's first two roadmap rows ("Now" and "R18-R24"), in the order below. Work on main: `git pull --rebase`,
then merge that branch in (merge, don't rebase).

Before anything else, find the R18 lock time (`build/refresh-plan.json` after `python refresh.py`, or the schedule
feed). Steps 1-4 must be pushed and deployed before that lock: frozen challengers only count from the first lock
after they ship. If there isn't time for all of them, do 1, 2 and 3 first and tell me what slipped.

0. **Confirm the cloud session's numbers with the real engine.** `npm ci`, `python refresh.py`, then:
   - `python backtest/scorecard.py`. Expect T1 skill ~10.2% (8.93 vs 9.94), T3 2417 vs 2555 vs 3807, more rounds
     if R17 has been certified since.
   - `npm run backtest 6`. Its team pick and best should match scorecard T3, and its CRPS should match
     accuracy.json.
   - `npm run backtest 10` (ceilings). Note the numbers in the plan §2.4 if they moved from −0.44 / −0.41 / −0.75.

   If anything disagrees by more than noise, stop and tell me before building on it.
1. **Scorecard in CI and Model health.** Run `backtest/scorecard.py --json` in refresh.yml after accuracy.js and
   write `history/<season>/scorecard.json` (committed by the history job like the others). Embed it in
   `DATA.modelHealth` (lab-only data: refresh.py `lab_split` / LAB_KEYS) and show T1-T3 + the floor in the Sim lab's
   Model health panel (`web/js/model-health.js`, an ⓘ popover for the definitions, CLAUDE.md conventions).
2. **Three cheap challengers, frozen from R18** (plan §3 L3, L6, L7; `Engine.CHALLENGERS`, scored by accuracy.js like
   the others):
   - `prac60` (L3): practice short-run share into pace 0.5 → 0.6 for qualifying, plus a share into race pace. The
     archive showed the short-run gap correlating −0.10 ± 0.05 with points residuals. Pick the race share with one
     walk-forward run (`EXP` in backtest section 9), not a grid search on R5-R17.
   - `raincal` (L6): the forecast rain chance recalibrated towards what was seen (25% forecast vs 9% seen R5-R15).
     Use a shrink towards the circuit climatology fitted walk-forward on the 2026 rounds, using only forecasts
     issued before lock (weather_by_round.json / the projections' `rain`). Check each forecast's public
     availability time, as the fourth review asked.
   - `pool8` (L7): the sim's distribution pooled with the naive forecast (season-to-date mean + pooled spread, as
     scorecard.py builds it), weight 0.8 on the sim. It's a mixture of samples, not a mean shift. The archive gave
     MAE 12.82 → 12.73 and team picks +8 ± 7 a round.

   For each one: the section 9 walk-forward (3 seeds, paired, R5-R17), a line in docs/history.md with the numbers,
   and the challenger list in CLAUDE.md updated. Don't change the shipped default.
3. **Start collecting Polymarket podium prices** (plan L2): per-driver podium contracts for every race, from the
   public keyless API (gamma-api.polymarket.com, then the CLOB prices). collect.py should save them beside Kalshi's
   `quotes/` (`history/<season>/quotes/`, with bid/ask where there is one), fail-soft, paced like the other feeds.
   Nothing uses them yet. No free archive of past F1 odds exists, so every race not collected is lost.
4. **Declare the protocol.** Add a short "Declared YYYY-MM-DD, before R18 lock" note to the plan §4.3 listing the
   challenger set for R18-R24 (the existing ones + prac60, raincal, pool8). Commit it before the lock.
5. **After the lock, through R24:**
   - **L1 prototype**, the overtake level regression (plan §3 L1). Inputs: the per-circuit traffic penalty from
     laps.py (`paceCoef.traffic` correlated −0.56 with the round's overtake level over 17 rounds), degradation
     (Pirelli compounds in `fia tech.tyres`, practice long-run degradation) and the speed rule. Fit it walk-forward
     on 2026 + OpenF1 2023-2025 at the same circuits, with an era factor. Score it on section 6 and the overtake
     level error. If it beats the speed rule beyond 2 SE, make it a challenger for the next lock.
   - **The live feed's `ProjectedGamedayPoints`.** On a Friday before lock, fetch `drivers/<next gd>_en.json` and
     see whether it differs from `GamedayPoints`. If it's a real pre-race projection, archive it each round (a
     possible pool member, plan L7).
6. **Stop and report** after step 4 is deployed, and again when L1 has a result. Each report should cover: what
   shipped, the numbers with their ± and the rounds they're over, and what's next from the plan's roadmap. The
   winter items (multi-season replay, model world, L2 tilting, L4, L5, L9) are NOT for this session. Don't start
   them.

Rules (from CLAUDE.md, the ones that matter here):
- Never tune on a round after it's been seen and count it.
- Every result names its commit, config and rounds.
- Challenger-only inputs go into LAB_KEYS / LAB_RACE_FIELDS so visitors don't download them.
- Check engine changes output-identical for the shipped default (seeded sims).
- Run `npm run check`, `python -m unittest discover tests` and `ruff check . && ruff format --check .` before
  each push.
- No league or personal data in the repo.
