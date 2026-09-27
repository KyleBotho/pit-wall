# F1 Fantasy: mathematical integrity, runtime and data review

27 September 2026 · Repository commit `79a45af` · Follow-up to the initial simulation review

**Overall rating remains 7/10.** The core joint Monte Carlo implementation is sound enough to be useful. Numerical safeguards, calibration convergence and uncertainty reporting fall short of the professional standard requested. More simulated weekends will reduce sampling noise; they will not resolve incorrect scoring, missing relationships or biased input estimates.

The first review examined model structure and predictive performance. This follow-up adds sampler tests, covariance checks, random-state isolation tests, boundary fixtures, repeated-seed experiments and CPU profiling. No application code or settings were changed. Temporary diagnostic versions were evaluated only in isolated memory in separate processes.

## Findings at a glance

| Area | Assessment |
|---|---|
| Covariance handling | Correct joint aggregation; important real-world dependencies remain absent or simplified |
| Distribution boundaries | Normal operating cases mostly sound; several confirmed failures or silent approximations at boundaries |
| Sampling efficiency | Main model is fast; repeated market-calibration summaries and discarded normal draws waste work |
| Random-state isolation | Tested isolation and reproducibility passed; shared mutable settings and branch-dependent streams need better architecture |
| Convergence tracking | Main weakness: fixed sample/iteration budgets without reported Monte Carlo error or calibration residuals |

## 1. Covariance: what works and what remains missing

The simulator creates one shared weekend per sample, with common team form, driver form across sessions, team reliability uncertainty, incident effects and a common race safety-car outcome. Constructor points are computed from their drivers within that same sample. Finishing-order competition also creates dependence between rivals. Team and head-to-head calculations preserve sample alignment.

That is a valid way of producing a joint distribution. An explicit covariance matrix and Cholesky decomposition are not prerequisites. A covariance matrix estimated consistently from these joint samples is positive semidefinite by construction, apart from floating-point roundoff.

For one legal $100m lineup selected using R15 information available before the race, with Leclerc boosted:

| Check | Result |
|---|---:|
| Team standard deviation, directly from shared samples | 57.5766 points |
| Standard deviation if asset covariance were ignored | 53.8680 points |
| Direct variance | 3315.06639136 |
| Weighted covariance calculation, wᵀΣw | 3315.06639136 |
| One overlapping driver/constructor correlation | 0.6759 |

Ignoring covariance would understate standard deviation by approximately 6.4% in this example. The tool does not make that mistake in its shared-sample aggregation. This checks mathematical consistency, not whether the correlations match real F1 sufficiently well.

The next improvements should be:

1. **Correlate uncertainty in qualifying and race pace estimates.** The existing shared form shocks are helpful, but the additional uncertainty draws around fitted qualifying and race means are independent. A shared uncertainty component for the car, plus separate session effects, would better represent what is unknown about performance.
2. **Carry uncertain car strength across future rounds.** Multi-race planning needs a persistent draw of the unknown car/driver strengths, with evolution over time, rather than treating all uncertainty as fresh weekend noise. Otherwise the horizon can diversify away uncertainty that actually persists.
3. **Model weather jointly across session times.** Qualifying and race wet flags are separate Bernoulli draws. Use coherent forecast trajectories with session-specific exposure, retaining both common weather and local changes.
4. **Add a shared race overtaking environment and competitive pit bonuses.** Independent overtake counts after conditioning on the current variables can miss race-wide dispersion. Independent resampling of constructor pit-scoring histories does not enforce the competition for the fastest-stop bonus.
5. **Validate dependencies explicitly.** Compare held-out residual correlations for teammates, driver/constructor overlaps and shared lineups, and evaluate team-level score intervals and head-to-head probabilities. Use shrinkage: 11 evaluation weekends cannot support a large unconstrained covariance matrix.

Evidence: `engine.js` simState at 1646, raceSession at 1864, simSample at 2011; `web/js/forecast.js` teamSamples at 282. Source locations refer to the reviewed commit under `C:\Claude memory\F1 Fantasy`.

## 2. Distribution boundaries and numerical integrity

### Confirmed safety-car calibration error

The code uses `(1-q)^E[N]` where it needs `E[(1-q)^N]`: q is the probability a retirement triggers a safety car and N is the random number of retirements. These expressions are generally different. Moreover, the code's sum of nominal retirement risks is only an approximation to the expected retirement count after its incident mechanism.

Controlled fixture: 22 drivers, independent retirement probability 0.1 each, incident sharing and parameter uncertainty switched off, retirement-to-SC probability 0.15, target SC probability 0.5.

| Quantity | Value |
|---|---:|
| Intended safety-car rate | 50.000% |
| Exact rate implied by the implemented formula | 48.732% |
| Observed over 100,000 samples | 48.910% |

For independent Bernoulli retirements, the needed expectation is the product of `(1-p_i*q)` over drivers. With correlated retirements, estimate it under the actual joint retirement process, or fit a joint incident/SC model directly. If retirements alone imply an SC rate above the requested target, report an incompatible target rather than silently clipping the background probability to zero. The present overtake-level normalisation also assumes the requested SC rate is achieved, so this discrepancy propagates.

Evidence: `engine.js` raceSession, especially 1907–1918.

### Samplers: healthy defaults, one tail approximation

Each diagnostic used 200,000 draws, with a fixed seed. These are moment/support checks, not exhaustive tests of the pseudorandom generator.

| Distribution | Expected mean / variance | Observed mean / variance | Finding |
|---|---|---|---|
| Standard normal | 0 / 1 | 0.00054 / 1.00049 | Sound in this check |
| Poisson(4) | 4 / 4 | 4.00114 / 4.00763 | Sound; observed skew 0.502 versus expected 0.5 |
| Beta(2,8) | 0.2 / 0.014545 | 0.19995 / 0.014562 | Sound; samples within (0,1) |
| Poisson(31) | 31 / 31 | 31.00432 / 31.09002 | Rounded-normal approximation loses Poisson skew |

For Poisson rates above 30, the code switches to a rounded Gaussian. At 31, theoretical skewness is about 0.180; the observed approximation was −0.012. That can affect tail probabilities. However, **none of 419,333 Poisson calls in the instrumented default projection entered this branch**; the maximum rate was 6.14. An exact high-rate Poisson sampler is worthwhile hardening, not the first accuracy priority.

### Other confirmed issues and their significance

| Issue | Reproduction / consequence | Recommendation |
|---|---|---|
| Singular linear solve silently altered | Solving the inconsistent system with matrix [[1,1],[1,1]] and RHS [1,2] returns roughly [−10¹²,+10¹²] | Detect singularity/poor conditioning; scale features; use a stable regularised factorisation or QR/SVD as appropriate |
| Zero sample count accepted | N=0 returns NaN means and undefined quantiles | Require finite positive integer N; reject invalid inputs before allocating |
| Zero-variance position calculation | Identical pace and all relevant noise scales zero gives NaN expected positions | Define deterministic outcomes and equal-pace ties explicitly |
| Weighted-choice lower endpoint | Weights [0,1] and a uniform draw of exactly 0 choose the zero-weight first item | Skip nonpositive weights and use a strict boundary comparison; reject negative/nonfinite weights and define all-zero behaviour |
| Beta reliability endpoint distortion | Positive shape floors make a nominal zero failure probability positive; small positive uncertainty settings have a variance floor | Separate mean and precision parameters; handle exact endpoints deliberately; define the uncertainty control continuously |
| Log-odds floor is substantive | Probabilities are clipped to 0.004–0.996 before market updates | Use explicit, sample-size-aware probability smoothing and report sensitivity; recognise that this is regularisation, not merely numerical protection |
| Manual score shifts can violate event support | Shifting every sample to match a typed mean can create impossible or fractional event totals and negative No Negative scores | Label overrides clearly, or adjust underlying event parameters and resimulate |
| Head-to-head tie conventions differ | Calculator counts ties as half a win; league comparison counts only strict wins | Show P(win), P(tie), and tie-adjusted probability as different measures |

The singular-system and zero-noise tests are deliberately adverse fixtures; they do not show that ordinary default forecasts currently suffer huge coefficients or NaNs. The weighted-choice endpoint is extremely rare under the current generator. Fix all these cases, but prioritise by real-world impact.

Gaussian **relative pace** may legitimately be negative: it is a deviation from a reference, not a negative physical lap time. Clipping it at zero would bias the model. Validate positive physical quantities separately and monitor nonfinite outputs and extreme event rates.

The regression fit also has limited convergence protection: Poisson IRLS stops after at most 30 iterations or a small step, with no returned convergence flag, objective improvement check or conditioning diagnostic. Normal equations can amplify conditioning problems. Current models are small and regularised, which mitigates this; it does not replace diagnostics.

Evidence: `engine.js` solve 152, ridge 169, poissonGlm 183, logit 227, gauss 244, poisson 258, gamma 271, beta 286, pick 292, expectedPositions 1206, simSample 2011, simulate 2156; `web/js/forecast.js` override logic near 75; `web/js/calc.js` vsTarget 467; `web/js/league.js` h2h 239.

## 3. Runtime and sampling efficiency

Unprofiled measurements on this computer in Node, using R15 pre-race information and archived inputs. Median of three runs after a warm-up. Browser rendering, network fetches, and the full multi-round planner are excluded. The final-stage simulation includes normal summaries; lap modes also include their internal pilot calibration. Results are indicative, not universal hardware benchmarks.

| Model | Setup including market fit | Final 10,000 samples | Approximate combined time |
|---|---:|---:|---:|
| Default rank model | 193 ms | 147 ms | 340 ms |
| Disabled lap model | 1,462 ms | 898 ms | 2,360 ms |
| Disabled segment model | 3,653 ms | 2,220 ms | 5,873 ms |

A separate fresh-team optimisation returning the top 60 took about 20 ms in the instrumented run. This does not benchmark every chip, league comparison, transfer constraint or planner search.

Profiling 30 complete default projections attributed approximately 24.8% of sampled CPU time to per-asset summary work and its sorting comparator, 19.2% to normal generation, and 1.1% to garbage collection. Function attribution depends on V8 inlining and this workload. The priority is avoiding unnecessary work, then optimising measured hot functions.

**Ordered runtime improvements:**

1. **Stop summarising full fantasy scores for every market-calibration iteration.** A normal projection currently performs six simulations: five calibration runs of 2,500 weekends, then the production run. Calibration primarily needs finishing-position probabilities, but each call produces sample score buffers, categories and sorted score quantiles. Add a lean probability mode. If random draws are removed as part of this change, seeded outputs can change; verify distributional equivalence and isolate streams first.
2. **Remove the unused last market-calibration simulation.** Its result is assigned after the final parameter update and never consumed. A temporary in-memory change produced an identical returned model in the tested case. It removes 2,500 of the 22,500 sampled weekends in an ordinary 10,000-sample forecast, approximately 11% of that sample workload, not a guaranteed 11% wall-clock speedup.
3. **Make summaries optional; select quantiles without sorting every full array.** Keep full sorting when required, but use selection, bounded integer histograms where appropriate, or streaming summaries for other consumers. Preserve raw aligned samples where chips or opponent comparisons need them. Welford-style moments are a useful safeguard for more general score scales.
4. **Use both Box–Muller normal draws.** The current implementation discards the sine partner. Store any spare normal in the individual RNG/simulation object, never globally. Benchmark against another vetted normal generator if needed. This changes seeded sequences, so version the RNG implementation.
5. **Cache deterministic setup and lap pilot fits using complete keys.** Include model, circuit, configuration, inputs, conditioning and seed. Each experimental race model repeatedly recalibrates its pilot races inside market iterations. Reuse only when all relevant inputs match.
6. **Move heavier work to a Web Worker and process samples in chunks.** The browser's short delayed callback still executes the work synchronously. Workers improve responsiveness; they do not automatically reduce total CPU time. Key random streams independently of worker scheduling.

The main model's sample storage is modest: the two Float32 score buffers for 33 assets × 10,000 samples occupy approximately 2.64 MB combined, before temporary copies and other state. Ordinary integer fantasy scores are exactly representable at this scale. Float32 is not the main accuracy bottleneck.

The backtest and Lab timing counters start after race setup, so their displayed simulation runtime omits market fitting. Report end-to-end time with a breakdown. The current disabled lap/segment modes cost approximately 7×/17× the combined default time in this benchmark, without a convincing held-out accuracy gain in the earlier experiments. Keep them experimental.

Evidence: `engine.js` lapCalib 1807, simSummary 2090, applyOdds 2171, raceSetup 2628; `backtest/walk.js` timer 203; `web/js/lab.js` timer 142.

## 4. Random state: tests passed, architecture can improve

The simulator creates a local seeded generator and local scratch state. These checks passed for the default engine:

- Same seed and inputs produced identical raw-score hashes even after an intervening simulation with another seed and sprint setting.
- Increasing N from 1,000 to 2,000 preserved the first 1,000 samples for every asset.
- Model, circuit and options were unchanged after simulation.
- Replacing ambient Math.random with a throwing function did not interrupt the tested simulations.

I found **no random-state leak in those paths**. These checks are not exhaustive coverage of every experimental/UI branch or a formal assessment of the generator's period and statistical quality.

The remaining concerns are different:

- Mutable global MODEL/SIM settings make re-entrant use fragile. Lab uses try/finally restoration, which is good; experiment scripts are less defensive. Pass immutable configuration into each simulation.
- A single sequential stream is sensitive to branches. Turning a feature on changes how many numbers it consumes, so subsequent draws can describe different shocks. Identical seeds across two model variants do not guarantee strong common-random-number coupling.
- Use reproducible streams keyed by master seed, sample index, session, event and participant, or a vetted splittable/counter-based generator. Keep market fitting and production sampling separate but record both seeds. Deterministic per-sample streams also permit incremental extension and parallel workers without scheduling-dependent results.
- Store the generator/version, input hash, model/configuration and all calibration settings with frozen forecasts. Reproducibility should survive a future implementation change, not just a repeated call today.

## 5. Convergence: quantify three different uncertainties

The implementation primarily uses fixed budgets: production sample count, four market-update iterations, and eight pilot-calibration iterations in the lap models. It does not expose convincing stopping diagnostics for these processes. Regression has a small-step stopping rule, but returns no convergence status.

The following experiment held the fitted market model fixed, then used 12 production seeds for the same lineup at each N. The team scored roughly 163 points on average and its outcome standard deviation was about 58 points.

| Samples N | Estimated standard error of team mean | Observed SD of means across seeds | Observed SD of P(score ≥200), percentage points | Range of estimated 10th percentile |
|---|---:|---:|---:|---:|
| 1,000 | 1.84 points | 1.89 | 1.28 | 73–85 points |
| 3,000 | 1.06 | 0.92 | 0.93 | 76–84 |
| 10,000 | 0.58 | 0.41 | 0.41 | 77–81 |
| 30,000 | 0.34 | 0.34 | 0.21 | 78–80 |

Variation broadly behaves as expected under independent Monte Carlo sampling; 12 seeds are too few to expect exact scaling of empirical estimates. At 10,000 samples, the approximate 95% Monte Carlo interval around that team's estimated mean is ±1.1 points. This is uncertainty in the computed expectation, **not** a prediction interval for the race result.

An additional eight-seed market-fitting experiment, keeping the production seed fixed and using 30,000 final samples each time, moved that team's estimated mean between **162.09 and 163.55** points; its across-fit SD was 0.45 points. The same production seed only partly couples paths when parameters change, so the spread is not a pure variance decomposition. It nevertheless demonstrates that changing market-fitting randomness changes the final forecast. Increasing only production N does not remove uncertainty introduced by finite calibration simulations.

Implement these diagnostics:

1. **Production sampling:** display N, seed, mean standard error `sd/sqrt(N)`, probability uncertainty, and uncertainty around key quantiles. For ordinary event probabilities, `sqrt(p*(1-p)/N)` gives a first approximation; use Wilson/binomial bounds for rare events or probabilities near 0/1. Zero hits is not proof of zero probability.
2. **Decisions:** monitor the sample-wise difference between competing lineups on their common weekends. Its standard error, rather than two unrelated team intervals, tells you whether a small expected-points advantage is resolved. Screen candidates, then validate finalists with an independent sample to reduce selection optimism.
3. **Calibration:** show weighted probability residuals, parameter changes, iteration count, sampling error and a convergence/failure status. Stop when residuals are below a meaningful tolerance relative to simulation noise. Independently validate the resulting probabilities. More iterations alone can chase sampling noise or incompatible market targets.
4. **Model uncertainty:** track how forecasts change across plausible fitted parameters and independently held-out weekends. This remains even when numerical standard errors are tiny.
5. **Adaptive budgets:** extend samples at preplanned checkpoints, or use valid sequential bounds, until the relevant decision is stable or a maximum budget is reached. Do not repeatedly inspect an ordinary 95% interval and assume its nominal coverage survives arbitrary stopping.

This engine uses independent forward Monte Carlo, not MCMC. Burn-in and R-hat are not the relevant default diagnostics. Stratifying wet/dry and SC/no-SC scenarios may improve sampling efficiency if their true joint weights and conditional draws are preserved. Randomised quasi-Monte Carlo is a later experiment: variable-length rejection sampling and discontinuous race rankings make a naive replacement of uniforms unreliable. Importance sampling is useful only if rare outcomes become a specific objective and weights are implemented and validated correctly.

## 6. Additional data most likely to improve accuracy

The following ranking is my assessment of likely value, not a measured uplift. Much of the highest-value material is already partly collected: the missing work is joining it correctly and retaining context in the estimator.

| Priority | Additional information or fuller use of existing information | Model improvement |
|---|---|---|
| 1 | Lap-level tyre compound, tyre age, stint, track status, deleted laps, traffic gap, time within session and weather | Separate underlying pace from tyre, traffic and track effects; include uncertainty for missing context |
| 2 | Retirement cause, retirement lap, completed exposure, DNS/DSQ/classification and incident participants | Separate mechanical failure, driver incidents and shared crashes; model survival by distance and retain points earned before retirement |
| 3 | Weather trajectories available before lock, with actual issue/availability times | Joint wet/dry scenarios, track evolution and temperature effects; honest historical replay |
| 4 | Actual compound nomination, available tyre sets where published, track-specific pit losses and green/SC/VSC state | Estimate degradation and strategy-sensitive pace; model competitive pit-stop bonuses coherently |
| 5 | Timestamped upgrade packages, which car received them, component changes and official penalties | Permit changes in car strength and reliability without assuming every upgrade is beneficial |
| 6 | Market snapshots with timestamps, liquidity/volume, bid–ask spread and matching conditioning | Downweight stale/noisy markets, avoid mixing pre-grid and post-grid information, and assess market/model overlap |
| 7 | Track geometry and mechanisms: corner-speed mix, straights, braking, surface, overtaking opportunities and pit-lane layout | Better transfer of performance to upcoming circuits, especially where practice is unavailable |
| 8 | More seasons with explicit regulation, tyre and team/driver changes | Better priors for rare events and track effects; avoid pooling obsolete car pace as if conditions were unchanged |

**Sources and practical limitations:**

- The existing [OpenF1 API](https://openf1.org/docs/) provides laps, stints, intervals, pit data, race control, results, starting grids and weather. Its car telemetry is approximately 3.7 Hz and its location data lacks lateral track placement. Those limitations matter when interpreting close racing. Its documented fields do not supply exact initial fuel load or battery state of charge. Treat these as latent variables with uncertainty, not quantities you can read directly from the feed.
- [FastF1](https://github.com/theOehrly/Fast-F1) provides another route to timing, telemetry, tyre and session context. The repository's telemetry extraction already retains compound, tyre life, track status and deleted-lap flags; the main race pace extraction is much cruder. Audit agreement and provenance between sources rather than treating duplicate feeds as independent evidence.
- [Open-Meteo ensembles](https://open-meteo.com/en/docs/ensemble-api) can supply weather scenarios. The [Single Runs archive](https://open-meteo.com/en/docs/single-runs-api) supports individual historical forecast runs. Respect both model initialisation and later public availability: a run initialised before lock may not have been available before lock. Coverage varies by model and date. Convert atmospheric forecasts into track-wetness probabilities using observed sessions; rainfall probability alone is not the same target.
- [FIA event documents](https://www.fia.com/documents/sporting-regulations) include car presentation submissions, power-unit element information, penalties, grids and circuit notes. These support timestamped change and eligibility records. Component usage counts are not exact component mileage; upgrade descriptions are not measured lap-time gains.
- [Pirelli compound announcements](https://press.pirelli.com/?h=1&t=2026+tyre+compound+choices) identify the actual nominated compounds. Relative labels such as Soft and Medium should not be assumed equivalent across weekends. Supplement with tyre-set availability only where it is actually published or reliably observed.

### The first data/model project I would build

Create a canonical, timestamped lap-and-stint dataset, and fit a hierarchical pace estimator with car/driver strength, compound and age effects, session evolution, track conditions and traffic. Model practice fuel/programme uncertainty explicitly; do not claim to infer exact fuel from lap times alone. Carry the resulting joint uncertainty into qualifying/race predictions.

That would provide a principled way to revisit the disabled practice long-run and car/driver decomposition features. Their present failure to improve the backtest does not prove the underlying information is useless; it shows that the current transformation and weighting have not established incremental value.

Use regularisation and grouped forward validation. Thousands of laps are not thousands of independent race weekends. Select features on earlier rounds, test on later untouched rounds, and assess CRPS, probability calibration, team decision quality and runtime together. Require repeatable improvement over the current model before enabling a feature by default.

## Recommended order of work

1. Correct the material scoring/conditioning/planner defects in the first review, plus the confirmed SC calculation and inconsistent probability labels here.
2. Add input validation, boundary fixtures, solver/fit diagnostics and full provenance for every frozen forecast.
3. Expose Monte Carlo and calibration error; use paired lineup comparisons and independent finalist validation.
4. Remove redundant calibration work and full summaries; make heavy calculations responsive in a worker.
5. Build the contextual lap/stint pace model and cause-specific retirement dataset.
6. Add coherent weather, persistent car uncertainty and competitive pit scoring; validate the resulting joint distributions.
7. Reassess disabled long-run, car-offset and track-specific features on untouched future races. Keep lap/segment simulation experimental until it earns its considerable runtime cost.

## Evidence files

The accompanying `F1-numerical-results.json` contains sampler, covariance, convergence, runtime, profile and controlled-fixture outputs. All measured forecast examples are from the specified snapshot and machine. Diagnostics cover selected representative and adverse cases, not every possible configuration, source-data error or browser platform.
