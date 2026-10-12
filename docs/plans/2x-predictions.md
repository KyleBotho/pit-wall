# Twice as good: plan for the predictions and how we test it (2026-10-12)

User, 2026-10-12: "research and plan how we can get the pitwall predictions 2x as good as it currently is. Also
research and plan how we will test this performance increase. Boil the ocean and be creative."

Evidence below is from the committed archive (`history/2026/`: playerstats = actual points by scoring event, R1-R17;
`projections/` frozen at lock R15-R17; `rebuilt/` R2-R14, rebuilt after the fact; `samples/` R16-R17 joint samples;
`accuracy.json` walk-forward CRPS). `python backtest/scorecard.py` reproduces every headline number in 2 s, no cache
or network needed. The walk-forward and frozen numbers come from the engine as of commit fb5e3fd.

## 1. Summary

1. **Halving the points error is impossible, for any model.** For a driver, the retirement coin flip alone (even
   with each car's true retirement chance known) is 77% of the round-to-round variance (158 of 204 points²). An
   idealised forecaster that knows every driver's true expected result and retirement chance still scores CRPS
   ≈ 6.5-7.6 for drivers; we are at 7.78. The backtest's own ceilings agree: even being told the real race pace,
   qualifying pace and overtake level only gains 0.75 CRPS (≈ 9%).
2. **What can double is the skill: what the model adds over a naive forecast.** Today the CRPS skill over the naive
   forecast (season-to-date average + its spread) is **10.2%** (8.93 vs 9.94, −1.01 ± 0.28 a round: solid).
   **2x = 20% skill = CRPS ≈ 7.92** on the same rounds. That sits at the physical floor (§2.4), so it's a stretch
   target. The levers in §3 add up to about −0.4 to −0.9 CRPS (14-19% skill) if they work; 1.5x is the realistic
   expectation, 2x needs nearly all of them to land.
3. **The decision side is unmeasured, not good.** Teams picked on our projections scored 2,417 (R5-R17, fresh $100m
   team each round) vs **2,555 for teams picked on the plain season average**: −10.6 ± 14.1 a round. Two rounds
   (R6, R13: Ferrari rated above Mercedes, boost on a Ferrari driver) cost 247 points; the model wins or ties the
   other 11. With a paired standard deviation of 51 points a round, a +15 a round edge needs ~100 rounds to show.
   **Testing is the first bottleneck, not modelling**: §4 is the plan for it.
4. Done today: `backtest/scorecard.py` (the three targets + the floor, from the archive alone; tested). Six ideas
   tried on the archive (§2.6): five rejected, so nobody re-tries them blind, one kept as lever L7.

## 2. Evidence

### 2.1 Where we stand (R5-R17, 13 rounds, 429 asset-rounds)

| | Model | Naive (season-to-date) | Edge |
|---|---|---|---|
| CRPS (walk-forward; naive = mean + pooled spread) | 8.93 | 9.94 | −1.01 ± 0.28 (skill 10.2%) |
| MAE (rebuilt R5-R14 + frozen R15-R17) | 12.84 | 13.62 | −0.77 ± 0.42 |
| Spearman within the top 8 drivers by price | 0.30 | 0.22 | +0.08 ± 0.05 |
| Spearman within the top 4 constructors by price | 0.35 | 0.25 | +0.11 ± 0.06 |
| Fresh $100m team, actual points (hindsight best 3,807) | 2,417 | 2,555 | −10.6 ± 14.1 a round |

Other baselines: last-3 average MAE 14.54; the asset's FULL-season average (an oracle that sees the future) MAE 12.05,
and leaving the round itself out 12.83, the same as the model. **The model already knows each asset's season-long
strength as well as hindsight does; everything left is weekend-specific.**

### 2.2 What the remaining error is made of

Within-asset variance (each asset's own season mean removed), share by scoring category:

| | Drivers (sd 14.4) | Constructors (sd 21.3) |
|---|---|---|
| Race not classified (−20) | 35% | 34% |
| Race position | 21% | 18% |
| Race positions gained/lost | 11% | 10% |
| Race overtakes | 11% | 15% |
| Sprint (all) | 10% | 13% |
| Fastest lap / DotD | 9% | 5% |
| Qualifying (+ Q bonus) | 2% | 2% |
| Pit stops | — | 4% |

* Qualifying is 2% of the variance (the ceilings' "real grid ~0" agrees): qualifying fixes matter for the race
  they feed, not for their own points.
* **Round-wide error**: the field's points swing ±90 a round (drivers' race overtake points alone 104 ± 57). The
  round's mean error is 8% of drivers' MSE and **18% of constructors' MSE**. R16 drivers: actual 327 vs median
  sum 220; R17: 189 vs 299. That's the overtake level, the retirement count and safety cars hitting everyone at once.
* Team retirement rates persist (first vs second half correlation 0.8; Aston Martin 0.62 → 0.44, Mercedes 0.06 →
  0.06) but some teams improve (McLaren 0.31 → 0.11, Red Bull 0.25 → 0.06).

### 2.3 Calibration: the model is honest, so the floor is information

* Overall slope of actual on projected (within round): drivers 0.97, constructors 1.01. Coverage 80% / 51% in the
  10-90 / 25-75% ranges. The means are not too compressed or too stretched.
* R16-R17 joint samples: drivers' realised CRPS 8.7 / 9.1 vs the model's own expected CRPS 8.1 / 7.7 (slightly
  overconfident); constructors 16.3 / 12.0 vs 11.8 / 11.2 (R16 overconfident: the round-wide miss).
* A calibrated forecast can only get a lower CRPS by being sharper, which means knowing more before lock. Tuning
  can't buy it: the five most recent challengers are all within ±0.03 (season report).

### 2.4 The floor

* Retirement coin flip alone: CRPS ≥ 4.7 for drivers (`scorecard.py`, two-point forecast that knows p exactly).
* Idealised driver forecast (true retirement chance + true expected result, race-day spread of the finishers 5-8
  points): CRPS 6.5-7.6 depending on how much of the finishers' spread (9.9 in hindsight) is truly random.
* Backtest section 10 (2026-09-25): told the real race pace −0.44, real overtake level −0.41, both + qualifying pace
  −0.75. These are upper bounds (realised pace includes that day's noise).
* So the season-level floor is roughly **7.6-8.2** vs 8.93 today: 0.7-1.3 CRPS of headroom in total. 2x skill (7.92)
  needs most of it.

### 2.5 Signals found in the archive (leads for §3)

* **Short-run practice under-weighted for points**: the practice short-run gap correlates with the model's residual
  at −0.10 ± 0.05 Spearman (13 rounds; faster in practice → beat the projection). Long runs: −0.03 ± 0.06 (nothing).
* **Overtake level vs circuit traffic**: the race's traffic penalty (laps.py `paceCoef.traffic`, time lost behind
  another car) correlates −0.56 with that round's overtake level over 17 rounds; tyre degradation (`agePerLap`)
  +0.23; field pace spread −0.41. Traffic and degradation are circuit and compound properties, measurable before
  the race (past seasons' laps at the same circuit, practice, Pirelli's compound choice).
* **Persistent team biases**: Red Bull −11 a round under-projected (R5-R17), Ferrari +6, RUS +7, LEC +5. They don't
  carry forward cleanly (see 2.6), but they point at car-pace dynamics (upgrades) the averages miss.

### 2.6 Tried today and rejected (walk-forward on the archive, R5-R17)

| Idea | Result |
|---|---|
| Per-asset residual correction (shrunk past residuals, k 2-16) | MAE worse (12.82 → 12.95-13.48), team +7-9 a round ± 7-10 (noise) |
| Per-team residual correction | MAE worse, team −4 to +1 a round |
| Crowd: ownership % / boost % as extra predictors | uninformative (correlation with residual 0.05 / −0.03; leave-one-round-out MAE worse) |
| Normal-distribution recalibration (EMOS) | worse: points are two-humped (the −20 lump), a normal fit loses ~0.5 CRPS before it starts |
| Scoring the top-K teams instead of the top team, to cut decision noise | no help: sd 50-63 a round at K = 1-200 |
| Blend with the naive average (w_model 0.8) | MAE 12.73 (−0.08), team +8 ± 7: a small lead, made a lever (L7) |

## 3. The levers (ranked by expected gain per effort)

Gains are CRPS on the season mix (rough, not additive; each is tested as a challenger before anything ships). The
headroom column is what's known about the maximum.

| # | Lever | Headroom evidence | Expected | Cost |
|---|---|---|---|---|
| L1 | Round overtake level from circuit traffic + degradation | ceiling −0.41; traffic corr −0.56 | −0.10 to −0.20 | M |
| L2 | Market tilting: reweight simulated weekends to ALL market lines jointly | market worth ~0.1 today and under-used | −0.05 to −0.15 | M |
| L3 | Practice: short-run weight for points, Q3-style gap metric | residual corr −0.10 ± 0.05; qtight | −0.03 to −0.08 | S |
| L4 | Dynamic car pace with upgrade jumps (state-space) | team biases ±6-11 a round | −0.05 to −0.15 | L |
| L5 | Retirements: time-varying team hazard + PU ages | 35% of variance; McLaren / RBR halved | −0.03 to −0.10 | M |
| L6 | Rain chance recalibrated (25% forecast vs 9% seen) | over-wide dry weekends | −0.03 to −0.08 | S |
| L7 | Linear pool with the naive forecast | w 0.8: MAE −0.08 | −0.02 to −0.06 | S |
| L8 | Constructors: team-mate correlation, Q bonus (~1 pt low), round-wide factor | 18% of their MSE round-wide | −0.03 to −0.08 | M |
| L9 | Noise settings refitted on 2022-2025 (flat optima on 11 rounds) | open item, past-seasons 4 | −0.02 to −0.05 | L |
| L10 | DotD / fastest lap features | 9% of driver variance | −0.01 to −0.03 | S |
| | **Total (if most land)** | floor 7.6-8.2 | **−0.4 to −0.9** | |

### L1 Overtake level (the biggest single lever)

The round's overtake level moves every asset at once (±57 race overtake points for the field). Today's forecast is
the speed rule (TRACK.speed / speedPrior). Build a small level regression, fitted walk-forward on 2026 rounds plus
2023-2025 OpenF1 overtakes at the same circuits (with an era factor):

* **Pass difficulty**: the traffic penalty from laps.py, measured per circuit from past races (OpenF1 laps
  2023-2025) and from this weekend's practice (laps run within 1 s of another car vs clean laps).
* **Degradation**: Pirelli's race compounds (`fia tech.tyres`, collected since R1) and the practice long-run
  degradation; more degradation = more stops and more passing.
* **Speed spread**: speed-trap spread between cars in practice (FastF1 car data, telemetry.py already caches it).
* Keep the speed rule as one input. Score on `ovLvl` (abs level error per driver) and section 6.

### L2 Market tilting

The market fit moves one pace per driver and can't meet win, podium and top 10 together (residual 0.3-0.4
log-odds, levels off by step 6). Instead, **reweight the simulated weekends** so the weighted sim matches every
market line at once (minimum relative entropy / exponential tilting: one weight per sample, a few Newton steps,
the correlations inside each weekend kept). It gives each driver the spread the market sees, for free.

* Lines: Kalshi win / podium / top 10 / pole (now) + **Polymarket's per-driver podium contracts for every 2026
  race** (public API, keyless) pooled by spread; the market weight stays a fitted shrink (tilt halfway = weight 0.5).
* Guard: effective sample size after tilting ≥ 25% of the run (else tilt less).
* Start collecting Polymarket quotes now (collect.py, beside Kalshi's quotes/): no free archive of F1 odds exists,
  so every week not collected is lost.

### L3 Practice

* Raise the short-run share into qualifying pace (0.5 now; 0.6 ties on qualifying) and test a separate share into
  race pace: the residual signal is in points, not qualifying.
* Gap metric (open item "Qualifying too mixed"): Q3 / Q2 gaps where the driver reached them, Q1 only for the rest
  (top cars don't push in Q1). Then the `qtight` challenger's noise.
* Guard wet practice (open item: practice.py has none).

### L4 Car pace as a state that moves

The recent-form blend failed because it's a flat average of noisy results. A state-space model does it properly:
each car's pace is a random walk with small drift each round and a **jump allowed when the FIA documents list a
Performance upgrade** (Car Presentation Submissions, collected R1-R17 in `fia tech.upgrades`). Kalman filtering
gives the current level and its uncertainty; the process noise and the jump size are fitted on 2022-2025 (3
seasons of upgrades) and checked on 2026. Team-mate prior and shrink as now. Also a track-similarity kernel:
pool a team's pace residuals over circuits like this one (speed, corners, surface) instead of all circuits.

### L5 Retirements

35% of the variance, and it doesn't average out. Team hazard with exponential forgetting (half-life fitted), per-car
power-unit element counts vs allocation from the FIA PU documents (an engine near the end of its life fails more;
a new one brings a grid penalty: that's known before lock, and it's in `puUsed` already), sprint ratio from 2023-2025
(past-seasons item 2). Score on per-car retirement Brier / log loss, then points.

### L6 Rain

Our rain chance runs at 25% vs 9% seen (R5-R15). Rain multiplies noise x1.6 and retirements x1.4, so a forecast
that is too wet makes dry weekends too wide. Recalibrate (isotonic on the weather vintages kept since R16 +
Open-Meteo previous runs where they were public before lock; past-seasons item 1). Score on rain Brier per session.

### L7 Pooling with the naive forecast

Linear pool (mixture) of the sim's distribution with the naive one, weight fitted walk-forward on CRPS. Cheap, and
the standard way forecasters harvest a second opinion. Later members: an outside sim (rhter's, private repo
only; numbers never here) and F1 Fantasy's own `ProjectedGamedayPoints` if the live feed fills it before lock
(the archived feeds are post-race: check the live one on a Friday).

### L8 Constructors

Constructors are a third of the assets with twice the error. Check team-mate correlation in the sim against
2026 (both cars' points residuals), the Q bonus (~1 point low for the top teams), pit bands (open: 42/62 reconcile),
and the round-wide factor (`ovenv`).

### L9-L10

Noise settings on 2022-2025 results (past-seasons item 4, the winter project). DotD: home race, recovery drives
(grid − finish), popularity; fastest lap: free pit stop late (gap to the car behind > a stop).

### Creative, higher risk (try after L1-L8)

* **Bookmaker specials price exactly the big variance terms**: safety car yes/no, number of classified finishers,
  first retirement. Only if a public, keyless source exists (CLAUDE.md: public data, no login).
* **Car-circuit fit from telemetry**: FastF1 speed traces in practice → each car's straight vs slow-corner vs
  fast-corner profile, matched to the circuit's profile. That's within-season learning of "which car suits which track".
* **A weekend-level latent factor fitted live**: practice tells us the round's grip / degradation regime. Share it
  across all cars (overtakes, stops, retirements) instead of per driver.
* **The decision layer** (not a prediction, but where points come from): decision-weighted training loss (weight
  each asset by its chance of being in a top team), pairwise P(A beats B) for the top cars shown in the
  Calculator, a rank-aware objective in leagues (open item "Calculator goal ranking").

## 4. How we test it

### 4.1 Targets (the scorecard)

| | Metric | Now | 1.5x checkpoint | 2x target |
|---|---|---|---|---|
| T1 | CRPS skill over naive, frozen at lock | 10.2% (walk-forward) | 15% | 20% |
| T2 | Spearman edge over naive within the top 8 drivers / top 4 constructors | +0.08 / +0.11 | +0.12 / +0.16 | +0.16 / +0.22 |
| T3 | Fresh-team points over naive a round (and the season replay, 4.4) | −10.6 ± 14.1 | > 0, CI clear of 0 | +15 |

T1 is the headline. T2 and T3 stop us from "winning" T1 with something that doesn't help picking a team. Diagnostics
stay as walk.js has them: qualifying / race position log scores, overtake level error, retirement Brier, rain and
safety car Brier, fastest lap log score, coverage. `python backtest/scorecard.py` prints T1-T3 and the floor. Add it
to refresh.yml after `accuracy.js` (writes `history/<season>/scorecard.json`, shown in Model health).

### 4.2 Statistical power: the real bottleneck

Per-round paired standard deviations (from the archive and the season report):

| Comparison | sd a round | Rounds to see δ at ~95% (anytime-valid) |
|---|---|---|
| Small setting change (challengers) | 0.04-0.10 CRPS | δ 0.05: 6-36 |
| Structural change (engine rework 2026-09-24) | ~0.35 CRPS | δ 0.10: ~110; δ 0.30: ~12 |
| Model vs naive | 1.0 CRPS | δ 1.0: ~9 |
| Fresh team vs naive | 51 points | δ 15: ~100 |

(rounds ≈ (3 sd / δ)², 3 = an anytime-valid allowance for looking every round.) A season has 24 rounds and the
frozen record starts at R15. So:

1. **Multi-season replay** (winter, biggest testing job): rescore 2023-2025 under the 2026 fantasy rules from public
   data: Jolpica results / qualifying / sprints, OpenF1 overtakes (2023+), fastest lap, DotD (F1.com / Wikipedia),
   retirements, pit points from OpenF1 stops (band match is 42/62: report it with and without pit points). ~70
   weekends → ~6x the evidence. Prices only for T3: simulate them with Engine.priceStep from a start price set by
   the previous season. Different car rules: use the replay to test STRUCTURE (does L1's level regression
   generalise?), not to set 2026 levels. walk.js asOf works per season; a `SEASON=2024 npm run backtest 6` mode.
2. **Model world** (synthetic truth): draw seasons from the engine with known settings, run the whole walk-forward
   on them. CRPS(true settings) = the information floor under our own model; CRPS(fitted) − CRPS(true) = what's
   lost to estimating from few rounds (where shrinkage / hierarchical fits help). It also tests the harness.
3. **Variance reduction**: common random numbers (already); score weekends, not assets; paired differences only;
   T2's pairwise orderings (28 + 6 pairs a round) carry more information per round than one team pick.

### 4.3 Protocol (declared before R18, fifth review's "declared protocol")

* **Prequential track record, not a frozen holdout** (user, 2026-10-12: keep improving through 2027 R1-R8, then the
  final calibration). The model may change between ANY two rounds, by hand or by refit, as long as:
  1. each round is scored only on the projection frozen at its lock (refresh.py already does this), with the commit
     that made it; a past round is never re-scored with a newer model and counted;
  2. a change ships before the lock of the first round it affects, with a line in docs/history.md saying why (so the
     verdict can say which rounds each version forecast);
  3. a **fixed reference** runs beside it: the champion as shipped at the end of 2026, frozen as a challenger
     (`ref2026`) from 2027 R1. The paired difference live vs reference is the measured gain of the whole winter +
     in-season programme; live vs naive is T1.
  Why this is honest: a forecast frozen before round k can't have seen round k, however much rounds 1..k-1 were
  used to tune it. The verdict is then about the PROCESS (model + its updates), which is what the user plays with.
  What it gives up: a change made after R3 is only judged on R4-R8 (fewer rounds), and two changes made together
  can't be told apart. So keep in-season changes few and dated, and test each on the replay first (promotion rule).
  The anytime-valid sequences below stay valid under this: they don't care that the forecaster changed.
* **The final calibration after R8** (noise settings, market weight, pooling weight refitted on 2026 + 2027 R1-R8)
  applies from R9. It is judged like everything else: on the rounds after it, against `ref2026` and naive.
* **Unit**: the weekend. Paired differences vs the shipped model AND vs the naive forecast AND vs a market-only
  forecast (sim tilted fully to the market, no history: L2 makes it cheap).
* **Anytime-valid confidence sequences** on the per-weekend paired score differences (Choe & Ramdas, "Comparing
  sequential forecasters", Operations Research 2024; empirical-Bernstein form). Looking after every round is then
  legitimate, which fixes the fifth review's "repeated looks". Across challengers: Holm on the end-of-season p-values,
  or e-value averaging.
* **Promotion rule**: a lever ships when (a) its replay result (2023-2025) is better beyond 2 SE, (b) its frozen 2026
  confidence sequence excludes "worse than shipped" (it doesn't have to prove "better": the replay did that), and
  (c) T2 and T3 are not worse beyond 1 SE. Every result names its input snapshot, commit and config.
* **Kill rule**: a lever that delivers less than half its expected gain on the replay is dropped and noted in
  docs/history.md.

### 4.4 Decision quality (T3) properly

Fresh-team points are a crude proxy. Build the **season replay**: the real game rules (2 free transfers, −10 per
extra, chips, boost, price changes, bank) driven by `planStoch` on each strategy's projections, scored by
`Hind.score`. Run it on 2026 and on the 2023-2025 replay. Compare: shipped, naive, market-only, each promoted lever.

## 5. Roadmap

| When | What |
|---|---|
| Now (before R18 lock) | `scorecard.py` into refresh.yml + Model health. Declare the frozen challenger set for R18-R24: L3 (practice share), L6 (rain recalibration), L7 (naive pool), `qtight` continues. Start Polymarket quotes. |
| R18-R24 | Collect. L1 prototype on 2026 + OpenF1 2023-2025 (walk-forward). Check the live feed's ProjectedGamedayPoints on a Friday. |
| Winter | Multi-season replay + model world (testing first). Then L2 tilting, L4 state-space pace, L5 hazard, L9 noise refit, L8. Each judged on the replay; fold-over as usual. |
| 2027 R1-R8 | Keep improving between rounds (each change before a lock, dated). `ref2026` frozen beside it. After R8: the 2x verdict on the frozen track record (T1 target 20%, checkpoint 15%, T2, T3), then the final calibration for R9+. |

**Needs from the user:** a local session (or these hosts added to the cloud environment's allowed domains:
fantasy.formula1.com, api.jolpi.ca, api.openf1.org, api.elections.kalshi.com, api.open-meteo.com,
ensemble-api.open-meteo.com, www.fia.com, livetiming.formula1.com, gamma-api.polymarket.com) for everything that
runs the engine; the cloud session that wrote this could read only the committed archive. Decided 2026-10-12: no
frozen holdout; 2027 R1-R8 keeps improving and is judged as a prequential track record (4.3).

## 6. Reproduce

* `python backtest/scorecard.py` (or `--json`): T1-T3 and the retirement floor, from history/ alone.
* Section 10 ceilings: `npm run backtest 10` (needs cache/data.json).
* The analyses in §2.2-2.6 were one-off scripts over the same archive; each is a few lines over
  `scorecard.load()` (actual points by event are in playerstats, prices in `PlayerValue`).
