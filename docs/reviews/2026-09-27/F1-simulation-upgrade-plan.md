# F1 Fantasy simulation upgrade plan

Prepared 27 September 2026 from the two completed audits of commit `79a45af`.

**Objective:** build a reproducible, numerically reliable forecasting and fantasy-decision system, then improve its predictive accuracy with better data and models. The present overall assessment is 7/10. An 8+ assessment requires demonstrated predictive reliability as well as better engineering; completing this plan does not automatically establish that rating.

**Scope:** a plan for implementation. Application changes have not been made. The default rank-based simulator remains the production starting point. Each phase produces a reviewable release or an independently evaluated candidate.

## Roadmap

| Phase | Purpose | Main output | Dependency |
|---|---|---|---|
| 0 | Preserve evidence and establish evaluation | Reproducible baseline and complete forecast archive | Start immediately |
| 1 | Correct known behaviour | Correct scoring, completed sessions, planner accounting and SC probability | Baseline from 0 |
| 2 | Make numerical answers trustworthy | Validated inputs, isolated randomness and convergence diagnostics | Corrected baseline from 1; foundations may begin earlier |
| 3 | Improve speed and responsiveness | Lean calibration, selective summaries, incremental samples and worker | Configuration/RNG contract from 2 |
| 4 | Improve the information feeding the model | Contextual lap/stint pace and cause-specific reliability candidates | Evaluation from 0 and data contracts from 1–2 |
| 5 | Improve joint forecasts and decisions | Correlated weather/performance, coherent pit scoring and future price paths | 2 and relevant models/data from 4 |
| 6 | Evaluate optional features and promote winners | Documented feature decisions and prospective monitoring | Stable production baseline; repeat continuously |

Phases 1–3 can ship without waiting for the research in 4–6. Data collection and prospective forecast archiving should start early because missed pre-lock observations cannot always be reconstructed later. Do not enable several experimental models together and attribute the result to one change.

## Phase 0 — Baseline, provenance and fair evaluation

**Purpose:** make every later claim of improvement reproducible.

| ID | Work item | Acceptance criterion |
|---|---|---|
| B01 | Preserve the reviewed code/configuration/input snapshot and numerical benchmark | The original audited metrics can be reproduced within documented sampling and environment differences |
| B02 | Introduce a versioned forecast record | Record code/configuration/data hashes, forecast generation and cutoff times, data availability times, RNG version/seeds, calibration settings, known sessions and fallback reasons |
| B03 | Retain sufficient forecast distributions | Store compressed joint samples, or an immutable input/model snapshot that reproduces them exactly; marginal quartiles alone are insufficient |
| B04 | Repair validation/cache identities | A change to any influential input, evaluator or model configuration invalidates the corresponding cached result |
| B05 | Separate historical development, chronological testing and genuine frozen forecasts | R5–R15 is labelled development evidence because it has already informed choices; missing historical metadata is not invented |
| B06 | Establish a benchmark suite | Fixed normal/sprint, known-grid, missing-data and adverse fixtures; include end-to-end runtime, memory, score/probability quality and decision metrics |
| B07 | Start prospective champion/challenger recording | Before each lock, freeze both the current production forecast and any named challenger, including unsuccessful challengers |

Use chronological outer evaluation: for each test weekend, any fitting or feature selection uses preceding weekends only. Historical replays must use information available by that forecast's cutoff, including weather publication lag and grid/penalty state. Where faithful reconstruction is impossible, mark that evaluation unsupported rather than substituting hindsight.

Keep the original audit numbers as a historical reference: CRPS 8.761, MAE 12.125, and approximately 0.34 seconds for default setup plus 10,000 final simulations on the audited machine. Establish a new baseline after correctness fixes; valid repairs need not beat the old, partly incorrect model on this small development sample.

**Main areas:** forecast export/storage, `backtest/walk.js`, `backtest/accuracy.js`, fit/ablation scripts and input manifests.

## Phase 1 — Correct the confirmed defects

**Purpose:** make the tool simulate and account for the events it claims to represent.

| ID | Change | Implementation direction | Acceptance criterion |
|---|---|---|---|
| C01 | Match Lab and production practice weights | Use one definition of practice weight and one setup path | Same inputs/configuration produce identical fitted model and seeded forecast in both paths |
| C02 | Carry prices cumulatively through the planner | Maintain a price vector for all assets and a separate portfolio/bank state | The audited $0.6m rise persists into stage three; unheld asset price changes do not increase the user's budget |
| C03 | Preserve completed-session facts | Store classification, DNS/DNF/DSQ, laps and actual scoring events; lock completed points | A completed sprint has identical points under every seed; late retirement and classification remain distinct |
| C04 | Condition market fitting on the same known information | Pass grid, penalties and completed-session state into both market fitting and final forecasting; check quote timing | Post-qualifying information is not absorbed incorrectly into underlying pace; stale conditioning is identified |
| C05 | Retain overtakes before retirement | Add retirement exposure/time to the rank model and fit a small regularised conditional overtake model; use explicit uncertainty for missing exposure | Retirees can earn pre-retirement overtakes; zero exposure earns none; no passes occur after retirement; constructor totals reconcile |
| C06 | Correct SC marginal calibration | Use the expectation under the actual retirement distribution; detect incompatible requested rates | Independent-retirement fixture matches its analytical SC rate within predeclared Monte Carlo tolerance; correlated fixtures match their configured targets when feasible |
| C07 | Standardise probability labels and overrides | Separate strict win, tie and tie-adjusted probabilities; distinguish manual score scenarios from event-valid forecasts | Identical lineups show P(win)=0 and P(tie)=1; overrides cannot silently masquerade as physically coherent scoring forecasts |
| C08 | Investigate price-rule exceptions | Reconcile inactive/returning-driver and corrected-price records against authoritative evidence | Each mismatch is corrected or explicitly recorded as unresolved; no single-observation special case is silently fitted |

For C05, do not add the observed 3.06 average overtakes to every retirement. Begin with the smallest exposure-based model supported by the available records; the richer cause-specific retirement process belongs in Phase 4.

For C03, missing actual scoring events must remain visibly incomplete. The tool must not silently re-simulate a completed event and present it as a known result.

**Release gate:** meaningful regression fixtures for the confirmed failures pass; driver/constructor/chip scoring reconciles on representative real weekends; bank and price accounting conserve value under documented game rules; full existing checks pass. Changes in forecast outputs are explained by the repaired behaviour.

**Main areas:** `engine.js`, `extras.py`, `web/js/lab.js`, `web/js/calc.js`, `web/js/forecast.js`, `web/js/league.js` and price evaluation.

## Phase 2 — Numerical integrity, random streams and convergence

**Purpose:** make numerical precision measurable and exceptional cases explicit.

| ID | Work item | Acceptance criterion |
|---|---|---|
| N01 | Validate sample counts, probabilities, rates, dimensions and finite values | Invalid configuration produces a useful error or documented fallback before simulation; no silent NaNs |
| N02 | Correct sampler and deterministic boundaries | Zero-weight choices cannot win; all-zero weights have explicit handling; tied zero-noise pace is well-defined; extreme Poisson rates use a validated sampler |
| N03 | Make fits report numerical health | Solver conditioning/singularity, optimisation convergence and fallback status are returned; failed fitting cannot silently publish extreme coefficients |
| N04 | Clarify uncertainty parameters | Pace uncertainty and reliability precision have separate, continuous controls; exact 0/1 reliability endpoints are handled deliberately |
| N05 | Replace mutable shared configuration with explicit configuration | Interleaved and concurrent jobs cannot alter each other's settings or results |
| N06 | Version and isolate random streams | Streams are keyed by simulation/sample/event/participant using a vetted scheme; results are reproducible across chunk sizes and worker scheduling |
| N07 | Report production sampling error | Mean/probability/quantile precision accompanies sample count; repeated-seed experiments support the reported uncertainty |
| N08 | Track calibration convergence | Report residuals, parameter movement, iteration count and convergence/failure state; evaluate the fitted result with independent simulation draws |
| N09 | Make lineup decisions precision-aware | Use paired score differences, validate finalists on fresh samples and stop at predeclared precision/budget checkpoints |

Preserve existing joint sampling. Test weighted covariance against direct team-score variance, constructor/driver score consistency and shared-asset cancellation in lineup differences. Do not introduce an unconstrained large covariance matrix merely to make covariance explicit.

Replace the fixed 0.4% market probability floor with documented, sample-size-aware smoothing. Market targets may be mutually inconsistent or unattainable by the pace model; convergence status should distinguish those situations from insufficient sampling.

**Proposed initial operating policy:** begin interactive calculations at 10,000 samples, then extend only for unresolved comparisons. For the final comparison, target a 95% Monte Carlo half-width no greater than 0.5 expected points and 1 percentage point for the displayed win probability, subject to a measured runtime/sample cap. These are proposed precision targets, not promises of forecast accuracy. Calibrate the cap in Phase 3; when it is reached, display the remaining uncertainty and avoid a confident winner label.

Use preplanned checkpoints with appropriate error control, or valid sequential confidence bounds. Near-zero probabilities need binomial/Wilson or suitable exact bounds; zero observations do not mean zero probability. Parameter uncertainty and future-race variability must remain distinct from Monte Carlo calculation error.

**Release gate:** reproducibility/interleaving/chunking tests pass, boundary cases are defined, fit failures are visible, and independent repeated-seed checks substantiate numerical error reporting. Version changes to RNG sequences explicitly.

**Main areas:** engine samplers, regression helpers, simulation state, market calibration, Lab configuration and forecast summaries.

## Phase 3 — Runtime and responsiveness

**Purpose:** spend computation on decisions that need precision.

Implement in this order:

1. Remove the unused final market-calibration simulation. Require identical returned models for equivalent inputs/configuration.
2. Add a probability-only calibration mode that omits unnecessary scoring summaries and buffers. With isolated event streams, compare relevant probabilities and outcomes against the full mode.
3. Compute only requested summaries. Use selection or suitable histograms for quantiles where beneficial; retain aligned samples for chips, tail risk and opponent calculations.
4. Use both normal draws from Box–Muller, with the spare owned by its generator. Confirm distributional correctness and benchmark the actual benefit.
5. Reuse setup and fitted calibration only under complete cache keys. Include data, known results, penalties, circuit, configuration, fit settings and seed/version.
6. Add chunked continuation and a Web Worker with progress/cancellation. A resumed run must equal an uninterrupted run under the same version and inputs.
7. Report setup, calibration, sampling, summaries and optimisation separately, alongside end-to-end time and memory.

**Release gate:** statistically equivalent forecasts for purely computational changes, exact equality where the algorithm is unchanged, no loss of covariance, and no material regression in representative cold/warm benchmarks. Demonstrate improved measured latency and a responsive browser under the agreed maximum workload. Set a numerical performance target after the Phase 1–2 baseline; the old 0.34-second result is hardware- and configuration-specific.

Advanced quasi-Monte Carlo and importance sampling remain deferred. First remove redundant work and use decision-aware sample counts. Optimising experimental lap calibration is lower priority than the production path.

## Phase 4 — Better data and stronger pace/reliability estimates

**Purpose:** improve predictive information rather than simply increase simulation count.

### 4A. Canonical lap/stint and event data

Create a versioned dataset joining driver/car, session, lap, stint, compound, tyre age, lap/sector time, traffic, pit flags, track status, deleted laps and contemporaneous conditions. Retain provenance, availability time, quality flags and uncertainty for missing records. Count usable competitive laps for practice eligibility.

Start with fields already collected through FastF1/OpenF1. Audit duplicate feeds and identifier changes. Never count the same observation from two providers as independent evidence.

### 4B. Contextual pace model

Fit a regularised hierarchical model that separates car/driver strength from compound/age, race phase, track evolution, weather and traffic. Include latent stint/programme effects for unknown practice fuel and deployment. Apply quality-aware weighting or robust errors; do not infer exact fuel from lap times alone. Avoid selecting only the fastest stint or assembling an ideal lap without uncertainty for changed conditions.

Produce a joint estimate of qualifying and race pace with uncertainty. Begin with a small model whose factors can be identified, and add complexity through isolated ablations. Keep a documented fallback for insufficient data, new drivers and unfamiliar circuits.

### 4C. Cause-specific reliability

Separate mechanical retirements, driver incidents, shared collisions, DNS and classification outcomes. Use distance/laps at risk, treating finished races as censored exposure. Add team pooling, individual effects only where supported, and regulation/component changes with strong shrinkage. Pass retirement time into points earned before retirement.

### 4D. Additional collection, in priority order

| Data | Initial use | Guardrail |
|---|---|---|
| Issued weather forecasts and observed session weather | Track-wetness calibration and coherent session scenarios | Archive actual availability time; forecast rain is not observed track wetness |
| Pirelli compound nominations and published tyre-set availability | Consistent compound identity and strategy context | Soft/Medium/Hard labels are relative to the weekend |
| FIA upgrades, components, grids and penalties | Timestamped car changes and eligibility | An announced upgrade is not a measured gain; component count is not mileage |
| Market quote history, spread and liquidity | Freshness/quality weighting and conditional calibration | Avoid double-counting practice/grid information |
| Track geometry and multiple seasons | Partial pooling for track mechanisms and rare events | Account explicitly for regulation and tyre changes |

**Research gate:** train/tune on earlier weekends, evaluate on later weekends, compare with the corrected production model and simple probabilistic baselines. Report CRPS, mean error, calibration, paired differences by weekend and decision outcomes. Thousands of laps remain clustered within a small number of weekends. If evidence is inconclusive, retain the model as a challenger.

**Main areas:** `telemetry.py`, `practice.py`, `extras.py`, `priors.py`, model fitting and input schemas.

## Phase 5 — Joint uncertainty, coherent events and multi-race decisions

**Purpose:** make team risk, chips and future transfer decisions reflect a coherent shared future.

| Work item | Design | Acceptance criterion |
|---|---|---|
| Joint car/driver uncertainty | Draw persistent car strength and driver offset, with session residuals and gradual evolution | Qualifying/race and teammate residual dependence improves on held-out checks; persistent uncertainty does not disappear across future rounds |
| Coherent weather | Sample a trajectory, then derive session track conditions | Marginal wet rates and dependence match validated inputs; completed weather remains fixed |
| Shared overtaking environment | Add a regularised race-level factor conditional on track/conditions | Overtake means, tails and cross-driver dependence are evaluated together |
| Competitive pit scoring | Simulate eligible stops/teams jointly and award bonuses according to rules | Race-level bonuses obey scoring constraints; retirements and race conditions affect opportunities coherently |
| SC/VSC/red-flag effects | Add event mechanisms only when data supports identifiable timing/duration effects | Marginals, ordering and conditional consequences are coherent; complexity earns predictive value |
| Sampled future prices | Derive asset price changes from simulated points and evolving scoring/price history | All asset prices evolve cumulatively, respect verified bounds/rules and reconcile with portfolio accounting |
| Stateful transfer/chip planner | Carry bank, holdings, transfer allowance and remaining chips along scenarios | Every proposed action is affordable/eligible and uses only information observable at that decision time |

Evaluate the planner with a realistic sequential replay that starts from an actual or fixed portfolio. Include paid transfers, bank and chip inventory. Compare against simple hold/current-mean policies. Use hindsight selection only as an explicitly unattainable reference.

Fix or label candidate screening for nonlinear objectives such as head-to-head probability and Autopilot. Verify small cases exhaustively; for larger searches, report candidate coverage and the remaining optimisation limitation. A precise probability calculation does not prove the globally best team was searched.

**Release gate:** event and accounting invariants pass, joint team distributions are assessed, and decision-policy results are evaluated prospectively or in faithful chronological replays. Marginal accuracy alone is insufficient to justify a change intended to improve portfolio risk.

## Phase 6 — Disabled features, promotion and monitoring

Treat each feature as a separate challenger with a written hypothesis and retirement criterion.

| Feature | Plan | Condition for production use |
|---|---|---|
| Practice long-run race pace | Rebuild after contextual pace work | Incremental held-out value beyond race pace and short-run practice |
| Car pace plus driver offset | Revisit within the hierarchical model | Better handling of swaps, upgrades and sparse history without excessive variance |
| Track bands/minisector adjustments | Retest one component at a time with quality/coverage flags | Improvement beyond existing practice/track information across independent weekends |
| Lap/segment race engines | Keep experimental; retain reproducible fitting code | Material improvement in distributions or decisions sufficient to justify runtime; kernels fitted only on training data |
| Skewed noise | Defer until residual diagnostics justify it | Consistent conditional calibration improvement |
| Fastest-lap market input | Revisit after quote-quality and conditioning work | Incremental probability/decision value with adequate coverage |
| Recent fantasy form | Low priority | Demonstrable information beyond pace, scoring and market inputs |
| Circuit history and hand-set track effects | Test partial pooling rather than blanket restoration | Stable transfer across tracks/regulation changes |
| Existing speed-based overtaking input | Retain provisionally and monitor | Continued benefit after correcting retirement exposure and upgrading track context |
| Fallback models and presets | Keep clearly identified | Documented use under missing data; do not present recentered distributions as independently validated models |

Promotion requires a predeclared comparison with the current production version, weekend-cluster uncertainty, meaningful improvement for the stated objective and no material degradation in essential secondary measures. With limited independent weekends, use a provisional label; do not manufacture certainty with more seeds or count every asset/lap as an independent test case.

After each race, monitor frozen forecast accuracy, calibration, input coverage, source corrections, numerical warnings, latency and realised decision outcomes. Retain the previous production version for rollback. Keep model-health alerts separate from automatic parameter retuning.

## First implementation batch

These are the first six reviewable work packages, in order:

1. **Baseline and archive foundation:** B01–B04, initial B06–B07, benchmark fixtures and complete input/configuration identity.
2. **Lab consistency:** C01 and shared setup comparison fixtures.
3. **Planner accounting:** C02, cumulative prices and bank/portfolio invariants; investigate C08 alongside this work.
4. **Completed sessions and conditioning:** C03–C04, canonical result state and matching market/final simulation inputs.
5. **Retirement scoring and safety cars:** C05–C06 with exposure data and analytical/Monte Carlo fixtures.
6. **Probability and numerical foundations:** C07, N01–N03, followed by explicit configuration, stream versioning and convergence diagnostics.

Start contextual data collection while these packages are implemented. Ship the corrected model before promoting the richer pace model. Keep mathematically equivalent speed improvements separate from predictive-model changes so their effects remain attributable.

## What completion means

| Milestone | Evidence required |
|---|---|
| Corrected production model | Confirmed behavioural defects fixed; scoring, completed events and accounting reconcile |
| Numerically dependable model | Invalid inputs handled; fits/calibration report health; randomness reproducible; decision precision visible |
| Efficient interactive tool | Measured end-to-end improvement and responsive execution without forecast distortion |
| More accurate model | Independent chronological/prospective evidence supporting better distributions and useful decisions |
| Candidate for 8+ review | All of the above, plus documented limitations, coherent joint risk, reliable data provenance and stable operational performance |

A more complex model or more samples alone is not a completion criterion. Engineering fixes can be verified immediately; claims of superior predictive accuracy need independent race outcomes.

## Supporting reviews

- [Initial simulation review](F1-simulation-review.md)
- [Numerical and runtime review](F1-numerical-runtime-review.md)
- [Numerical measurements](F1-numerical-results.json)

External data capabilities and their limitations are documented with source links in those reviews. Recheck source coverage and applicable scoring rules during implementation before relying on a new feed or rule exception.
