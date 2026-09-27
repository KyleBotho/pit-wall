# F1 Fantasy simulation review — 27 September 2026

**Overall score: 7/10.** A capable personal forecasting system with several professional practices, but insufficient independent predictive evidence and some material implementation defects prevent an 8+ rating. This is a judgment against the requested standard, not a statistically estimated rating.

Reviewed the local repository at `C:\Claude memory\F1 Fantasy`, commit `79a45af`, using the data generated on 26 September 2026 at 20:59 UTC. No application code or settings were changed. The review covers the main Monte Carlo model, its inputs and parameter defaults, experimental race models, price forecasts, chips, opponent comparisons, optimisation, and the backtest/monitoring system. It does not certify every historical upstream feed record or another service's forecasts.

**Practical recommendation:** keep using the main model as decision support. Correct the confirmed defects and strengthen evaluation before trusting small differences between lineups or precise probability claims. Keep the more elaborate race models experimental.

## Evidence reproduced

All **63 JavaScript tests and 31 Python tests passed**. I reran backtest sections 1–8 and ran additional direct diagnostics. Passing tests demonstrate the covered software behaviour; they do not prove forecasting accuracy or cover the defects below.

The default walk-forward evaluation covers **R5–R15, 11 weekends**, using 3,000 simulations per weekend. Earlier results are removed before each forecast, but model settings were selected using much of this same evaluation period.

| Measure | Result | Interpretation |
|---|---:|---|
| Mean absolute points error, all assets | 12.125 | Typical absolute error in an individual driver/constructor's expected points |
| Drivers / constructors separately | 10.60 / 15.17 | Constructors remain the harder absolute-points forecast |
| Season-average baseline error | 13.44 | Approximately 9.8% lower error for the simulator |
| Recent-form / last-three baseline error | 13.84 / 14.34 | Simulator beats these simple point forecasts too |
| CRPS | 8.761 | Proper distribution score; lower is better, not a percentage accuracy |
| Average ranking correlation | 0.727 | Useful separation of stronger and weaker assets |
| Nominal 80% / 50% interval coverage | 85% / 56% | Aggregate intervals are somewhat broad; conditional calibration is unproven |
| Bias | +0.20 points | Small aggregate bias can hide large opposing errors by race/category |
| Price-rule reconstruction | 422/425 = 99.3% | Excellent reconstruction when actual points are supplied; not 99.3% accurate future price probabilities |
| Fresh $100m team selection | 1,975 points | A simplified decision benchmark, with a fresh team every race |
| Perfect-hindsight fresh team | 3,170 points | An unattainable oracle, not a realistic performance target |

The only completed round with a genuinely frozen site forecast is R15: MAE **14.82**, rank correlation **0.567**, and **36%** of the 33 asset outcomes inside the nominal middle 50% interval. That is a weak first live result, but one chaotic race cannot establish or refute skill. R16 is an upcoming forecast, not a second validation result. Historical rebuilt projections must remain separate from frozen forecasts.

I isolated the three price-rule mismatches: Gasly after R8 (predicted price 12.0, observed 12.8), Lawson's Racing Bulls card after R8 (9.3 versus 8.9), and Hadjar after R15 (13.9 versus 15.1). Hadjar's two preceding rows were inactive zero-point rounds, so returning-driver handling deserves explicit investigation. The present price calculation includes those zeros. These are confirmed discrepancies; the archive alone does not establish the exact official exception or whether an earlier feed correction explains a mismatch. Do not silently fit a special case from one observation.

Reproduced ablations on the same 11 rounds:

| Variant | CRPS | MAE | Fresh-team actual points |
|---|---:|---:|---:|
| Shipped model | 8.761 | 12.125 | 1,975 |
| No betting market | 8.753 | 12.246 | 2,117 |
| No practice inputs | 8.949 | 12.460 | 1,946 |
| Add 30% recent fantasy form | 8.890 | 12.284 | 2,093 |
| No pace/reliability uncertainty redraw | 8.757 | 12.131 | 2,042 |

These show modest predictive value from practice and no decisive distribution-score gain from the current market integration or uncertainty mechanism. They also show why better average forecast scores do not automatically select better fantasy teams. The team totals are volatile and are not evidence to switch settings after seeing the result.

## Confirmed defects and important limitations

### 1. Retired drivers lose all their overtakes in the default simulator

In `engine.js:1864` (`raceSession`), an unclassified driver gets the retirement penalty and leaves the scoring loop before overtake points are awarded. Only the experimental lap models retain passes before retirement.

The local actual data contains **66 unclassified driver-races; 47 earned overtake points, totalling 202 points**. That is 3.06 overtake points per unclassified driver-race, or 0.61 per driver-start averaged across 15 races of 22 cars. This is an observed omitted scoring mechanism, not a hypothetical concern. For example, R15 Norris earned 3 overtakes and Alonso 6 despite not classifying.

This distorts driver downside, constructor scores, price thresholds and chip/team comparisons. It is also of comparable magnitude to the neutral-track overtake shortfall, although that diagnostic is not an exact attribution experiment. Fix it with retirement-time/exposure modelling in the rank model; do not add a universal 3.06-point bonus. Learn passes before retirement conditional on laps completed, traffic and race circumstances, then retest.

### 2. The Sim Lab's default practice weight differs from production

`web/js/lab.js:137` passes `pw: Engine.MODEL.practiceQ`. `engine.js:953` multiplies that by `MODEL.practiceQ` again. With the defaults, the Lab applies **0.5 × 0.5 = 0.25** qualifying practice influence; the main calculator applies **0.5 × 1 = 0.5**.

A direct R15 comparison, with odds disabled to isolate practice, changed several drivers' qualifying pace by **0.20 percentage points of lap time**. This affects Lab comparisons once practice exists. The Lab baseline can differ from the main calculator, and the practice slider acts nonlinearly. Pass the same practice multiplier used by production and add a baseline-equality check. The command-line backtest does not take this faulty Lab path.

### 3. The three-race planner forgets an earlier price change

`web/js/calc.js:928` builds every stage using today's prices and provides price changes only after stage one. `engine.js:2540` adds only the immediately preceding stage's change to that original price.

Direct reproduction with a fixed seven-asset team costing $70m and one $0.6m rise:

| Stage | Planner budget | Planner team cost | Correct team cost if no further change |
|---|---:|---:|---:|
| First | $70.0m | $70.0m | $70.0m |
| Second | $70.6m | $70.6m | $70.6m |
| Third | $70.6m | $70.0m | $70.6m |

The planner invents $0.6m of spending room in this example. Carry prices cumulatively, independently of the team's holdings. Subsequently replace mean-price planning with coherent sampled price paths, because the ability to afford a transfer is a threshold event.

### 4. Completed sessions are represented too sparsely

`extras.py:290` reduces session results to lists of driver names. It discards DNF/DNS/DSQ and lap-count information even though OpenF1 supplies such fields. `raceSession` assumes every driver present in a fixed sprint list finished, and continues randomly generating overtakes and fastest lap for that completed sprint. Fixed qualifying similarly assumes every listed driver set a time.

This is a confirmed information-loss problem in the code. I did not find a cached live session-result payload here to quantify a particular user's affected live forecast. Also, “did not finish” and “not classified” are not interchangeable: late retirees may still classify. Preserve official classification and actual fantasy scoring events, lock completed points exactly, and simulate only remaining events. This matters for live probabilities, chips and Final Fix. [OpenF1 session-result documentation](https://openf1.org/docs/#session-result).

The current market adjustment also calibrates against an unconditional simulated grid (`applyOdds`, `engine.js:2171`), then the final simulation applies known orders/penalties. Post-qualifying odds should be calibrated under the same known grid and penalties, avoiding the model compensating for grid information by incorrectly changing underlying pace.

### 5. Race pace is a rough proxy, not an estimate of comparable underlying speed

`extras.py:86` uses each driver's median race lap after removing lap one, pit in/out laps and laps above 107% of that driver's median. It does **not** explicitly control for tyre compound, tyre age, fuel/race lap, weather phases, track evolution, traffic, safety-car/VSC status or car damage.

Consequences include comparing an early retiree's heavy-fuel laps against another driver's complete race, treating strategy/traffic as ability, and retaining neutralised laps when they dominate the median. The 4% gap cap and shrinkage damp the damage but cannot identify its cause. Missing laps fall back to finishing position at an assumed 0.1% per place, mixing a differently generated measurement into the same pace estimate.

This is my highest-priority modelling research area after correctness and evaluation. Fit a regularised lap/stint model with race-phase and tyre controls, explicit quality flags, and uncertainty for unobserved fuel and damage. The existing telemetry archives already hold compound, tyre life, pit flags and track status; much can be improved without collecting more high-frequency car telemetry.

### 6. Practice corrections are stronger in description than identification

`practice.py:32` estimates short-run speed from the best lap or sum of best sectors, potentially combining sectors run in different conditions. It counts total recorded laps for eligibility, rather than usable competitive laps. Long runs apply fixed **0.055 seconds/lap fuel correction** and **0.04 seconds/lap tyre degradation**, across circuits and compounds. Compound effects are differences between field medians, confounding compound choice with which teams chose it; choosing the best stint also adds selection bias.

Crucially, correcting fuel burned during a run does not reveal the starting fuel load. Initial fuel and engine/energy deployment are unobserved. Use a latent run effect and uncertainty instead of claiming to have measured these. A more careful long-run estimator could be valuable, but the present `practiceR=0` is justified by its results.

### 7. The distributions omit important common risks

Useful correlations already exist: team/driver weekend form, shared team reliability and a common weather/safety-car draw. However:

- Overtake level is a fixed circuit estimate within a race simulation. The residual variation in the speed model is not sampled as a shared race-level shock; conditional Poisson counts can miss high-overtaking tails and cross-driver dependence.
- Teammates have the same base retirement rate; individual crash risk and mechanical failure are combined. Incident cars are selected from the field, not neighbouring cars, and SC timing/cause is abstracted.
- Pit-point histories are resampled independently by team, including fastest-stop bonuses. This does not enforce race-wide bonus consistency, relate stops to retirements, or share wet-race/strategy conditions.
- Weather is an independent binary draw for qualifying and race; sprint qualifying and sprint share one draw. Real session timing and correlated wet/drying conditions deserve explicit handling.
- Historical VSC/red-flag information is collected, but these are not separate event mechanisms in the main race model.
- Parameter uncertainty in a car's underlying strength should persist across future races. Independently generated next-three-race forecasts do not provide that coherent season path.

Calibrate these at both asset and lineup level. Broad average intervals can coexist with underestimated correlated downside; simply widening or narrowing everything is not the answer.

## Assessment of the validation system

The exact empirical CRPS implementation is sound. Keeping earlier race outcomes out of each forecast, using multiple seeds, comparing paired errors by race, separating frozen from rebuilt predictions, and leaving weekly parameter proposals for manual adoption are all good practices.

The weakness is **selection on the evaluation sample**. `backtest/fit.js:17` tries 17 parameter settings/groups over the same races used to report performance. Practice weights, circuit features, model variants and numerous other choices were also explored on R5–R14. Removing future rows from a forecast does not remove the information used to choose today's settings. There are 11 weekend clusters, not hundreds of independent driver/constructor observations.

Further concerns:

- The experimental lap/segment kernels are fixed constants measured using R1–R14, then evaluated on several of those same races. Their reported historical performance is optimistic as an unseen-race estimate. The original kernel-fitting scratch scripts are not retained according to the development history, limiting reproducibility.
- The development adoption criterion of a gain exceeding one standard error is weak after many experiments. The displayed “±” is a **standard error**, not a 95% confidence interval. A documented gain of −0.214 ± 0.122 CRPS is promising, not conclusive; a rough two-standard-error interval crosses zero.
- `backtest/walk.js:93` sets weather to empty and weekend information to null. Therefore the main backtest does not validate operational forecast weather or known-grid/penalty handling as shipped.
- Frozen files save means and two quartiles, but not the full score distributions, comprehensive input snapshot, model commit, parameter configuration or generation time. They cannot support full retrospective CRPS or joint lineup calibration.
- `backtest/accuracy.js:31` hashes engine/evaluator code and certified point totals, but not all influential data/configuration such as practice, odds, race pace, priors or frozen files. Those inputs can change while model health stays cached.
- Section 2 is leave-one-round-out, which includes later rounds when evaluating earlier ones; it is a diagnostic, not prospective evidence. Its non-speed-labelled variants also inherit `TRACK.speed=true`, so their overtake columns do not isolate a feature-only or history-only model.
- The fresh-$100m team benchmark omits portfolio history, bank, paid transfers and chip inventory. It cannot validate the season planner by itself.

**Required improvement:** use nested chronological validation. For each outer test race, choose parameters/features only on preceding races, freeze the model, and forecast the outer race. Keep a prospective champion/challenger archive thereafter, including forecasts that lose. Report race-cluster uncertainty, wet/dry and sprint splits, driver/constructor splits, probability calibration and realistic transfer/chip-policy returns. Add a simple probabilistic historical-points baseline and a regularised direct fantasy-points model; existing baselines assess only point forecasts.

## Disabled and alternative features

| Feature | Current state | Verdict |
|---|---|---|
| Rank-based weekend Monte Carlo | Default | Keep as production baseline. Economical and the best-supported option, subject to fixes above. |
| Practice-speed overtake level, stage 2 | On | Keep provisionally. Small-sample improvement is credible enough to monitor, not to regard as settled. Average speed misses long-straight geometry and wet-session effects. |
| Lap-by-lap race, stage 3a | Off | Keep off. More moving parts without established predictive gain. |
| Timing segments plus pass/repass, stage 3b | Off | Keep off. Better aggregate movement counts do not establish better individual outcomes or fantasy distributions. |
| Lap order with regression overtakes | Off alternative | Historical evidence is worse; low priority. |
| Fast-corner band shifts, stage 4 | `bandQ=bandR=0` | Keep off, especially race pace. Earlier race-pace correlation was approximately zero. Retest qualifying alone with more independent weekends. |
| Minisector practice gaps, stage 5 | Backtest only, not connected to live refresh | Keep experimental. Small historical CRPS gain was uncertain and qualifying/places metrics worsened. Missing telemetry coverage also complicates comparisons. |
| Stages 2+3+4+5 together | Off | No evidence that enabling all yields a better model. Components overlap rather than add independent information. |
| Practice long runs | `practiceR=0` | Keep off until the estimator is improved. Reproduced race-position MAE rises from 2.983 at weight 0 to 3.088 at weight 0.3. |
| Skewed qualifying/race noise | Zero | Keep off unless conditional residuals and unseen forecasts support it. A distribution's shape alone does not fix biased input pace. |
| Car pace plus driver offset | Off; teammate blend used | Current implementation has not established a gain. The hierarchical idea is worth revisiting for upgrades, driver swaps and rookies, with a time-varying car effect. |
| Fastest-lap betting market | Weight 0 | Keep off without better liquidity/quality filters and conditional validation. Thin prices can be misleading. |
| Team pace by hand-set track type | Off | Keep off. Avoid forcing track suitability where evidence is weak. |
| Individual circuit history for overtakes, SC and grid influence | Weights 0 | Defensible given the regulation change and tests. Partial pooling is preferable to blindly restoring historical effects. |
| Individual circuit history for retirements | Weight 1 | Keep provisionally; leave-one-out retirement error improves about 8.2% versus its flat comparator. Validate chronologically too. |
| Recent fantasy form added to mean | Weight 0 | Keep off. Duplicates noisy information already represented in pace/results and worsens CRPS/MAE. |
| Parameter uncertainty redraws | On | Keep concept, review calibration. Removing them currently produces nearly identical overall accuracy; their form and correlations need testing. |
| Pit residual fallback / per-driver overtake-rate fallback | Available alternatives | Useful for missing data, not demonstrated upgrades over the default scoring-line/regression approaches. |
| Classical/weighted/recent/points-per-million presets | User alternatives | Historical scoring heuristics, not independently validated generative models. Recentring a simulated distribution on a different mean does not validate its probabilities. |
| Sim Lab | Available | A useful experiment interface. Correct its practice-weight defect before comparing it with the main calculator. It is not an independent simulator. |

The experimental lap engines are stylised traffic simulators, not professional vehicle/strategy simulations. Each car normally makes one randomly timed stop with a common 23-second loss; there is no explicit tyre-compound strategy, degradation evolution, realistic multi-stop policy, pit double-stack or detailed energy state. Lap count is approximated by rounding 305 km divided by circuit length, which is inappropriate for Monaco and can be wrong elsewhere. Sector simulation splits lap time into three equal pieces rather than circuit-specific sector physics. SC timing is random conditional on an SC, rather than linked to the sampled retirement event. Fixing these would be a substantial project, with no guaranteed fantasy accuracy gain.

Recorded earlier five-seed/10,000-run comparisons found approximately −0.01 CRPS for lap models with uncertainty around 0.09–0.10, and worse race-position detail. Fast-corner shifts were about −0.007 ± 0.010; minisectors −0.029 ± 0.032; all stages combined −0.010 ± 0.117. These figures come from the repository's development record, not a new independent holdout.

**New experiment completed for this review:** 18 variants, each evaluated across R5–R15 using three seeds and 3,000 simulations per weekend. Shipped baseline CRPS 8.761, MAE 12.131. Differences below are variant minus shipped; lower is better. “±” denotes standard error across weekends after averaging seeds. This extends reproduction to current data; it is still not an independent holdout.

| Variant | Change in CRPS ± SE | Change in MAE ± SE |
|---|---:|---:|
| Disable practice-speed overtake model | +0.180 ± 0.120 | +0.285 ± 0.184 |
| Enable timing segments/pass-repass | −0.010 ± 0.091 | −0.009 ± 0.239 |
| Enable fast-corner band shift | −0.008 ± 0.009 | −0.001 ± 0.014 |
| Enable minisector practice | −0.019 ± 0.027 | +0.022 ± 0.044 |
| All stages 2+3+4+5 | −0.002 ± 0.102 | +0.090 ± 0.248 |
| Enable lap-by-lap race | −0.012 ± 0.087 | +0.014 ± 0.227 |
| Car/driver offset, prior 1.5 | +0.013 ± 0.015 | −0.011 ± 0.032 |
| Car/driver offset, prior 3 | −0.017 ± 0.022 | −0.046 ± 0.035 |
| Car/driver offset, prior 6 | +0.006 ± 0.024 | −0.022 ± 0.038 |
| Car/driver offset, prior 3 and half-life 8 | +0.009 ± 0.023 | +0.003 ± 0.032 |
| Qualifying skew, shape 2 | −0.023 ± 0.013 | −0.028 ± 0.013 |
| Qualifying skew, shape 5 | −0.014 ± 0.019 | −0.016 ± 0.032 |
| Race skew, shape 2 | −0.008 ± 0.013 | −0.007 ± 0.019 |
| Race skew, shape 5 | −0.006 ± 0.015 | −0.002 ± 0.022 |
| Both skews, shape 3 | −0.009 ± 0.013 | −0.008 ± 0.019 |
| Fastest-lap market, 25% | −0.011 ± 0.012 | −0.019 ± 0.016 |
| Fastest-lap market, 50% | −0.008 ± 0.014 | −0.014 ± 0.018 |
| Fastest-lap market, 100% | Approximately 0 ± 0.021 | −0.004 ± 0.028 |

The current rerun supports leaving these additions off. Lap/segment models worsen individual overtake and position-movement errors; all stages combined worsen movement MAE by **0.175 ± 0.049**. The fastest-lap market reduces the actual winner's log probability by 0.016, 0.040 and 0.116 as weight increases, despite nearly unchanged total-score CRPS. Qualifying skew 2 has a small favourable signal worth a prospective challenger, but approximately 0.02 points of CRPS after 18 comparisons is insufficient evidence to adopt it. The practice-speed model remains the strongest candidate contribution, though its confidence interval is still broad.

## Improvements in recommended order

1. **Fix the proven correctness defects.** Retain overtakes before retirement, align Sim Lab with production, carry prices cumulatively and preserve actual completed-session scoring/classification. Add targeted regression checks for these behaviours. Also align market calibration with known grids and penalties.
2. **Make future accuracy claims trustworthy.** Archive full timestamped inputs, model/version/settings and joint samples at each decision deadline. Use nested chronological validation and prospective champion/challenger comparisons. Include all model-affecting inputs in health cache keys. This primarily improves the reliability of model selection, rather than instantly lowering a forecast error.
3. **Replace raw median race pace with comparable lap/stint pace.** Control tyre/phase/track status/traffic, account for censoring of early retirees, and attach quality-dependent uncertainty. This is the most promising substantive accuracy project.
4. **Model overtakes with exposure and shared race uncertainty.** Use a negative-binomial or Poisson-mixture candidate, a race-level latent overtake rate, and retirement exposure. Compare expected scoring, extremes, correlations and price-threshold probabilities. Avoid setting the noise level by eye.
5. **Improve reliability, neutralisation and pit dependencies.** Separate mechanical and incident hazards with shrinkage; connect incident participants locally and connect SC timing to causes. Model pit opportunities conditional on running distance and strategy, with race-wide bonus consistency.
6. **Repair and qualify market inputs.** Record spread, freshness, traded activity and field coverage; reduce weight for weak books. Some archived podium books contain only 12, 16 or 18 of 22 drivers but are normalised to sum to three, allocating all podium probability to the observed subset. Complete missing drivers with an explicit prior or model-based remainder. Fit market constraints coherently and condition on known grid/penalties. A universal weight of 0.5 is not proven optimal.
7. **Use weather trajectories and evaluate them as known at lock.** Current maximum hourly precipitation probability over a window is a heuristic, not the probability of a materially wet session. Sample plausible dry/wet/drying phases, link related sessions, and model data quality when practice was wet but the race forecast is dry. Use actual forecast vintages, not realised weather, in validation.
8. **Validate fantasy decisions directly.** Run rolling season policies with real starting lineups, bank, transfers, chips and price changes. Backtest price-up/down probabilities and rival-win probabilities. Evaluate realistic baselines under identical constraints. Rival optimisation and Autopilot selection use candidate screening; they are not guaranteed globally optimal for those nonlinear objectives.
9. **Use coherent multi-race scenarios.** Preserve uncertain car strength across races, update it after simulated information, propagate score-driven prices and budgets, and optimise feasible policies. A beam search over expected values remains an approximation and should be labelled accordingly.
10. **Then revisit optional complexity and computational precision.** Refit experimental kernels using past races only, retain the fitting scripts, and change one independently measurable hypothesis at a time. Evaluate shortlisted lineups with fresh seeds and report a near-tie zone. At 10,000 simulations, a 50% probability alone has Monte Carlo standard error about 0.5 percentage points (roughly ±1 percentage point at 95%); model uncertainty is additional. More simulations do not correct biased inputs or missing events.

No percentage accuracy gain is promised for these proposals. Correctness fixes can initially worsen an aggregate fitted metric because other settings may have compensated for the bug. Refit only inside training data and judge the complete model on held-out races.

## Additional sources and better use of existing ones

The existing source selection is broadly sensible. The largest opportunity is extracting cleaner information and preserving provenance, rather than accumulating more feeds.

| Source | Proposed use | Priority / qualification |
|---|---|---|
| [Official FIA decision documents](https://www.fia.com/documents/championship) | Final grids, steward decisions, power-unit declarations, circuit notes | High: reduce missed/duplicated penalties and distinguish pit-lane starts from simple grid drops. Archive versions. |
| [OpenF1 API](https://openf1.org/docs/) | Use `starting_grid`, richer session results, stints, gaps, weather and race-control flags | High: extend the current integration. Its documentation exposes starting-grid data, so an official-grid path is preferable to relying only on penalty-message regular expressions. |
| [FastF1](https://github.com/theOehrly/Fast-F1) and existing local lap archives | Common lap/stint dataset, deleted-lap and track-status filtering, retirement distance | High: already partly collected; prioritise data cleaning over extra telemetry volume. |
| [Pirelli event preview via FIA](https://www.fia.com/system/files/decision-document/2026_australian_grand_prix_-_event_notes_-_pirelli_preview.pdf) and [Pirelli F1 information](https://www.pirelli.com/tires/en-us/motorsport/car/formula-1) | Nominated compounds, event tyre constraints and available strategy information | Medium: treat as priors/features, not direct knowledge of individual fuel loads. |
| [Open-Meteo ensemble forecasts](https://open-meteo.com/en/docs/ensemble-api) | Coherent uncertainty in session weather | High for wet weekends. Archive individual members at lock; retention varies. |
| [Open-Meteo forecast archive](https://open-meteo.com/en/docs/historical-forecast-api) | Reconstruct weather available before the deadline | Use individual model runs for the correct forecast horizon. The stitched historical product is not automatically the forecast that was available at an earlier lock. |
| [Kalshi candles](https://docs.kalshi.com/api-reference/market/get-market-candlesticks) | Timestamped odds and activity diagnostics | Improve existing quality filters first. Check candle end time and preserve vintage. A second independent market can be researched later if lawful practical access and useful liquidity exist. |
| Official team/FIA announcements | Upgrades, replacements, confirmed damage and component changes | Medium: structured, timestamped flags with uncertainty; do not turn rumours into precise pace offsets. |

I checked the unusual upcoming venue mapping: the local R16 “Bahrain” event points to Sepang. This is supported by [Formula 1's announcement](https://www.formula1.com/en/latest/article/formula-1-and-fia-confirm-formula-1-and-fia-confirm-malaysia-will-join-2026-calendar-as-host-venue-for-the-bahrain-grand-prix.6lL7vjFEM2VVynRHvg1TCf), so it should not be “corrected” to Sakhir based on the event name.

## What I would build differently

I would retain the fast joint weekend simulator and the scoring/optimisation separation, but put a small hierarchical state model in front of it. Each team would have a changing underlying car pace, each driver a shrunk offset, and each lap/session observation a measurement error reflecting tyres, traffic, weather and data quality. Practice and market observations would update that state without being treated as independent perfect measurements. Shared weekend conditions would generate positions, retirement exposure, overtakes and pit events coherently.

I would benchmark that against a simpler regularised model predicting fantasy score distributions directly. The more physically detailed model earns production use only if it improves unseen forecasts or decisions. Source quality, correct accounting and honest validation offer better returns here than immediately expanding the lap simulator.

An 8+ rating would require the confirmed defects resolved, reproducible fits, meaningful prospective evidence against competitive baselines, and calibrated probabilities for the outputs users actually act on. It would not require an elaborate vehicle physics engine or perfect race predictions.

## Parameter inventory

The accompanying `F1-simulation-parameters.json` records every exported MODEL, SIM, TRACK and DEFAULTS setting reviewed, including disabled branches. Parameters are not all independently identifiable from 11 evaluation weekends.

Key choices: 10,000 simulations; pace half-life 4 races; teammate prior 1.5 pseudo-races; 80% retention of pace differences; qualifying/race noise 0.20%/0.15%; team/driver weekend shocks 0.10%/0.08%; grid-slot cost 0.07%; practice short-run weight 0.5 and long-run weight 0; team retirement shrinkage 16 with no recency decay; incident share 15%; market weight 0.5; pit resampling over 8 races; overtake skill shrinkage 12; circuit history weights 0/1/0/0 for overtakes/retirements/SC/grid influence; speed regression ridge 2 from at least 5 races. These mix fitted, measured and hand-set values; “fitted” does not mean independently validated.

Important constants outside that inventory include practice fuel/degradation corrections, the market calibration's 2,500 simulations and four iterations, a three-race forecast horizon, a default planner beam of 12, and the official scoring/price tables. These were reviewed at their call sites too.
