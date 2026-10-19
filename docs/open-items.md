# Fantasy Pit Wall: open items

Moved out of CLAUDE.md on 2026-10-19. The next session starts here.

Everything finished, with the reasoning and evidence behind it, is in `docs/history.md` (dated entries). Search
there before re-deciding something.

- [ ] Second review (`docs/reviews/2026-09-27/F1-post-upgrade-review.md`, 7.5/10): findings A-G fixed
      2026-09-27 (history). Open from it: the market fit is still MOVING after 4 steps (0.3-0.4 log-odds off the
      targets, the Calculator now says so): more steps = a higher effective market weight, decide with a backtest.
      Sections 4-8 done the same day (history); left: adaptive sampling, a Calculator worker, a stochastic chip /
      transfer policy, hierarchical pace + survival models. Don't retune on the same R5-R15: wait for frozen rounds.
- [ ] Third review (`docs/reviews/2026-09-27/F1-second-round-review.md`, 7.8/10): all five findings fixed
      2026-09-27 (history). Its advice: no new features now; leave this version running and judge it on the frozen
      rounds from R16 (champion vs challengers in Model health).
- [ ] Fourth review (`docs/reviews/2026-09-27/F1-third-round-review.md`, 7.9/10, 2026-09-28): all five findings
      fixed the same day (history: frozen sims' circuit model, chip-aware planner, adaptive-sampling margin, accuracy
      config key, FIA PU-ANC / event names / past penalties, DSQ). Its advice, still open: keep the default and the
      challenger set stable; score prospective rounds by WEEKEND (the independent unit), including paired team
      differences and realistic transfer policies; "5 rounds and 2 SE" is not a true 95% test with several
      challengers and repeated looks. Every research result should name its input snapshot, code and config.
      Weather calibration (past-seasons item 1): check each forecast's PUBLIC AVAILABILITY time before lock, not
      just its model run time (Open-Meteo's previous-runs archive mostly starts Jan 2024, ECMWF HRES single runs Mar
      2024), and check coverage for our exact variable / model / location. Normal equations are fine while fits are
      well conditioned (QR / SVD only if not).
      Past stewards' decisions: all 244 read 2026-09-28 (26 grid penalties); walk-forward CRPS 8.674 -> 8.586.
      Fixed by the fifth review round: the penalty ledger (below).
- [ ] Fifth review (`docs/reviews/2026-09-27/F1-fifth-round-review.md`, 7.9/10, 2026-09-28): all seven findings
      fixed the same day (history). Its route to 8: accumulate untouched frozen weekends (8-12 more as a first
      checkpoint, extend if inconclusive) and judge them by a declared protocol: paired weekend-level differences
      against simple AND market-informed baselines; no promotion on retrospective differences; no wet / sprint
      claims until those cases are represented. Decision quality needs its own evidence (removing the market
      worsened CRPS 8.586 -> 8.691 but raised the fresh-team points 2,042 -> 2,126: marginal forecasts don't imply
      better transfer / chip policies). Also open from it: the two R8 price-rule misses and the pit-stop data
      (42/62 team-race bands, 4/6 fastest-stop bonuses) to reconcile; end-to-end profiling of three-race planning
      before micro-optimising; the ≈ check isn't a simultaneous guarantee over all teams.
- [ ] Deferred from the reviews (checked 2026-09-27: none built unless noted). Build one only when the frozen
      rounds show the error it addresses, and judge it as a challenger:
  - Market fit: now the challenger `odds8` (SIM.oddsIters 8, SIM.oddsN 5000; 2026-09-27), scored from R16. Found
    while adding it: more steps help little, the residual levels off by ~step 6 (R13 0.42 -> ~0.35, R15 0.31 ->
    ~0.27) because one pace per driver can't meet win, podium and top 10 together (the market sees a wider spread
    of results). If the market matters, the lever is a per-driver spread (variance) fitted to the market too.
  - Models: chip timing across races (the planner plays a chip in the first race only). DONE 2026-09-28: the
    stochastic planner (Engine.planStoch: plans valued over the simulated futures, a later transfer made where it
    fits, else the team held; replaces the 90% afford gate; chips scored per future by Engine.chipScore, fourth
    review). CHALLENGER since 2026-09-28 (user: deferred for want of evidence = let it collect evidence): the pooled
    race pace, `racepool` (MODEL.racePace "pool": laps.py pool_rounds writes `pacePool` into each finished round's
    race record from extras.race_info, round k pooled with rounds <= k, with its own cluster-robust errors
    paceSePool and revoked with its source, fifth review). Walk-forward R5-R15, 3 seeds: vs shipped +0.008 +/- 0.022
    (tie). Later refinements if it earns it: residuals by stint / compound, actual compounds across races.
    CHALLENGER since 2026-09-28: the timed safety car, `sctimed` (SIM.scTimed: onset drawn from past races' last-SC
    onsets, effect scaled by a line measured on 31 dry SC races 2023-2026, early = none, late ~3x; scLaps /
    lapsRun in race records and priors; parser v2 ends an SC at a red flag; fit on 2023-2025 only, noise variance kept
    (fifth review)). Walk-forward R5-R15, 3 seeds: +0.004 +/- 0.013 vs shipped (tie).
    DEFERRED 2026-09-28 for want of evidence (not shown useless; fourth review corrected the records): retirements by distance / confirmed cause (sprints: 7 unclassified of 110 entries incl. 2 DNS,
    5 of 108 starters, too few to tell 0.36 / 0.40 / 0.45 apart; separate DNS / DSQ / incident / mechanical; causes:
    no AUTOMATED source, a small hand-checked labelled subset would be the start). DONE 2026-09-28: settings are values, not shared state (engine.js
    withSettings swaps in a changed copy; Engine.SIM / MODEL / TRACK are read-only views, a write throws; the fit,
    section 9 and the tests go through withSettings). Checked output-identical (8 switch sets x 4 races, hashes).
  - Sampling and speed: the precision of quantile ranges. DONE 2026-09-28: the Calculator's own runs (and its
    near-tie check) in the engine worker (web/js/worker.js); adaptive sampling: the independent check run grows by
    a batch while one of the top six ranked teams is within its margin of #1 (Engine.lookZ over the looks, 2.58)
    and that margin is wider than ±0.5 pt (forecast.js checkSim grow, CHECK_MAX 50,000; calc.js simNoise).
  - Evaluation: DONE 2026-09-28: MODEL.ctxSeInflate data-informed from odd vs even stints (laps.py `inflate`: 1.85,
    per round 0.05-3.07, ~1.47 without R8; not an untouched hold-out; keeps 2);
    outcome groups (wet / SC) scored against the matching simulated races (sim.ev), SC / rain forecast calibration
    in section 6 (rain runs high: 25% vs 9%, one wet race; wait for the weather vintages). Repeated
    held-out folds for the weekly fit (fit.js), the real condition number in the fit log (eigenvalues). DONE
    2026-09-27: calibration by group (walk.js `groups`: drivers / constructors, sprint / normal, wet / dry,
    safety car or not) in section 6 and Model health (walk-forward + frozen). First read, R5-R15: SC races
    under-covered (74% / 43% in the 10-90 / 25-75% ranges), no-SC races projected +2.6 too high. Not retuned:
    watch it on the frozen rounds.
  - Data: tyre-set inventory (not in the FIA documents). DONE 2026-09-27: PU elements, upgrades, parc-fermé parts
    and tyre choices from the FIA documents (collect.py `fia_tech`), R1-R15 backfilled. The `oddsq` challenger
    needs Kalshi spreads (bid/ask are archived in quotes/ from R16).
- [ ] Past seasons' data where the 2026 rules didn't change it (user, 2026-09-28; the sim already takes circuit priors
      from 2014+, which helped only retirement levels and rain climatology). Each as a prior, judged walk-forward on
      2026 like everything else; not pace / team order, tyre and fuel effects, overtaking (no DRS) or the
      reliability level (new PUs). In this order:
  1. Rain forecast calibration: our rain chance runs high (25% forecast vs 9% seen R5-R15, one wet race). 2023-2025
     races give ~70 with OpenF1's observed rain. FIRST check that forecasts as they stood before lock exist for
     them (Open-Meteo's previous-runs archive was thin for 2026's early rounds, backtest/weather_rounds.py); if
     only after-the-fact forecasts exist, it can't be done honestly. The most valuable: rain drives spread,
     retirements and qualifying.
  2. Sprint vs race retirement ratio and when retirements happen: 2023-2025's ~18 sprints to pin SIM.sprintDnf
     (hand-set 0.4; 2026's 5 sprint retirements among 108 starters can't tell 0.36 / 0.40 / 0.45 apart) and the
     start-spike + per-lap shape; the level stays 2026's (the new PUs fail about twice as often). Count entries,
     starts, laps at risk, DNS, DSQ separately; a late stop that's still classified is censored, not a zero hazard.
  3. Retirement causes: Jolpica has detailed statuses up to ~2022 ("Collision damage", "Power Unit", "Undertray";
     a few in 2023; 2024-2026 mostly "Retired"): a weak prior for the mechanical / incident split with an era
     effect (now: race control's incidents only); unknowns stay unknown, "no incident message" is not "mechanical".
  4. The sim's noise settings (qSd, rSd, teamSd, drvSd, tau, SC noise): how results scatter around pace, fitted on
     2022-2025 (the previous car rules, ~90 races vs 2026's 11; the fitted values sit on flat optima). The biggest
     job (the backtest harness is built on 2026 fantasy data): a winter project, the results priors to confirm on
     2026.
- [ ] Independent review (`docs/reviews/2026-09-27/`): batches 1-4 DONE 2026-09-27 (history). Watch from R16 on,
      all automatic: the frozen record + samples at lock; challengers (qskew2, ovhl6, racectx, racepool, sctimed, dnfcauses, ovenv, oddsq, odds8, wetskill, sprintskill, qtight from R17; prac60, raincal, pool8 from R18)
      scored in Model health after certification (adopt one only after 5+ rounds and a gain beyond 2 SE); lap
      records, FastF1 archive, weather vintages + ensemble, Kalshi quotes, FIA index arriving on their own (health
      warns on the lap model and ensemble). Later, with the data: calibrate forecast rain vs observed session
      weather (weather/ + races/ wx), market-quote quality weights (quotes/), grid penalties from FIA documents.

- [ ] Twice as good (user, 2026-10-12): `docs/plans/2x-predictions.md`. Points error can't halve (the retirement
      coin flip alone is 77% of a driver's round-to-round variance); 2x = CRPS skill over naive 10% -> 20% (CRPS
      ~7.92), at the floor, so 1.5x is the realistic aim. Levers L1-L10 (overtake level from circuit traffic first),
      testing first: multi-season replay 2023-2025, model world, anytime-valid confidence sequences. 2027 R1-R8 keeps
      improving (user): judged as a prequential track record (each round on its frozen-at-lock projection, changes
      dated before a lock, the end-2026 champion frozen beside it as `ref2026`), final calibration after R8.
      Model-picked teams trail naive picks -10.6 +/- 14.1 a round (unresolved, not proven).
      "Now" done 2026-10-12 (history): the scorecard in the build + Model health, challengers prac60 / raincal / pool8
      frozen from R18 (all ties walk-forward), Polymarket quotes collected, the protocol declared (plan 4.3). Next
      (R18-R24): L1 overtake-level regression prototype; on a Friday before lock, check whether the live feed's
      `ProjectedGamedayPoints` differs from `GamedayPoints`. User, 2026-10-12: judge decisions by a season replay
      FROM R1 with carried budget and real transfer rules, against the real top-100 average and the league (plan 4.4).
      Built 2026-10-12 as the stats team (`backtest/stats_team.js`, `npm run stats-team`, docs/plans/stats-team.md):
      best playable strategy (budget to 3.5A, chips early) 4640 at R17 vs the real top-100 average 4859; hindsight
      (`oracle:`) 5985, along the meta's structures. Weekly in fit.yml's `stats` job -> history/<season>/
      stats-team.json -> Model health (lab-only `modelHealth.statsTeam`). L1 (overtake level from circuit traffic,
      backtest/ovlevel.py): a tie with the speed rule, not a challenger (history 2026-10-12).
- [ ] Qualifying too mixed (history 2026-10-07, found comparing an outside sim): walk-forward R5-R15 puts 6.51 top-four-team
      cars in the qualifying top 8 vs 7.55 actual (too few in 9 of 11 rounds; race top 8 calibrated, 6.22 vs 6.18),
      and our model's qualifying gaps sit well inside the actual per-session gaps. Challenger `qtight` (SIM.qSd 0.1) from R17: points a tie,
      qualifying log score better. If it earns adoption, look next at the gap metric (per-session gaps averaged over
      Q1-Q3 squeeze the field: top cars don't push in Q1) before more noise tuning.
- [ ] Per-driver skills (history 2026-09-30): `wetskill` and `sprintskill` are challengers from R16; each is only
      evaluable on a weekend with rain forecast for a qualifying / a sprint, so expect few scored rounds this season.
      Automatic in season (skills.py adds each finished round; wet qualifying from tyre data). The evidence is
      thin: one wrongly listed session moved the wet check's across-teams figure from +0.40 to +0.25, and the
      sprint edge flips for some drivers with how retirements are counted. Crash rate
      per driver failed once 2023-2025 was added (not built; `data/retire_causes.json` is there if it's retried);
      lap-1 gains are a team trait (a possible team-level start weight); the rookie / second-year learning curve
      is suggestive (0.07-0.12% a half season), not built. Also seen: practice.py has no handling for a wet
      practice session (its short-run gaps would go 50% into qualifying pace): guard before a wet FP.
- [x] Autonomy steps 1-3 done 2026-09-26 (docs/history.md): session-aware refresh + Refresh now, data health +
      the Data health issue, model health (accuracy per round + weekly fit proposals in the Sim lab). Still to see
      live: the first Data health issue, the first weekly fit (Tue 2026-09-29), R16 scored automatically.
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
- [ ] Calculator goal ranking (user, 2026-10-02; explore later): with a goal (rival / template) Best Teams rank by
      P(beat) unless a column is clicked (a header click is obeyed since 2026-10-02). P(beat) is the next race's
      head-to-head only: it favours copying the target (seen: 213.3 xPts / 60% / xGap +4.1 ranked above 216.9 / 58% /
      +7.8). Consider xGap as the goal's default (the season-long view), P(beat) kept for the endgame (ahead of a
      rival with a race or two left); check the P(beat) differences against their simulation error first.
- [ ] Pit Wall F1 account (history: Round tracking): around 2026-10-09, or as soon as a check run fails, read
      `history/session-check.csv` in `../pit-wall-private` (`git pull` first). The first failing day = the session's
      lifetime; then decide with the user whether account-based tracking can run unattended.
- [x] After Baku (R15), all checks done 2026-09-26 (docs/history.md: Round tracking, To do, Feature plan 6 and 11):
      line-ups explain R15 for all 9 league teams once feeds map to the last LOCKED round (they update after
      qualifying, with the new line-ups; fixed in leagues.py and refresh.py); live league standings fixed (they
      counted qualifying twice); practice weights unchanged; backtest 6/7 run. rhter's sims vs ours: private repo only
      (`research/rhter-comparisons.md`, `research/score_rhter.py`); never copy the numbers here.
- [ ] After each round: automatic since 2026-09-26 (Model health: accuracy per certified round, the weekly fit's
      proposal). What stays manual: deciding on a fit proposal, and the rhter comparison when he posts (private repo).
- [ ] Item 9, the lap-by-lap race model (history: To do, item 9): stages 2-5 built and backtested (most off by
      default; see Model decisions), the Sim lab tab is live. Still to do there: the later stages in the plan. The
      server-side locks (owner-only results table, rerun via an edge function) aren't needed while the lab runs in the
      browser (design change 2026-09-25, history: item 9 stage 6); revisit if a slow model is adopted (runs move to
      CI) or the lab's results/code should go private.
