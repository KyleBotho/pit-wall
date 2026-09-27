# F1 Fantasy — second-round implementation review

Reviewed 27 September 2026 · Commit `65958eb8d03d8a0d42911e344decda890b82c647` · Previous review: `b527099`

**Overall score: 7.8/10, up from 7.5/10.** The numerical engine is substantially more robust, and the performance improvements are measurable. The seven principal findings from the previous review have been addressed in their demonstrated cases. I would not yet give the complete forecasting and decision system an 8+: historical evaluation now admits some information unavailable at team lock, the new lock-view implementation is not a true snapshot, and several decision/display calculations are inconsistent.

This score is an expert judgment against the requested rubric, not a statistical measurement. There is no persuasive new evidence of improved predictive accuracy from this round of changes. That does not negate the value of correcting mathematical and operational defects.

The application repository was not edited. This review used source inspection, the full automated checks, independent numerical fixtures, chronological backtests, repeated-seed comparisons, lap archive checks and Node CPU profiling. It does not certify the deployed site or authenticated owner-only browser flows. Local cached inputs report a generation time of `2026-09-27T14:24+00:00`; the corrected lap estimates are present in those inputs and agree with the updated race archives. Only R1–R15 have completed outcomes.

## Verification

- `npm run check`: lint, formatting, types and **91 JavaScript tests passed**.
- Python unittest discovery: **47 tests passed**.
- Backtest sections 1, 3, 4, 5, 6, 7 and 8 rerun.
- Eleven three-seed comparisons at 3,000 samples per weekend, over R5–R15: current/previous engines, weather-provenance sensitivity and all six named challengers.
- Numerical fixtures tested weather correlation, settings restoration, market diagnostics, retirement ordering, covariance, random isolation, Poisson moments, pit bonuses and forecast consistency.
- Convergence experiment: 24 independent seeds at each of 1,000, 4,000 and 16,000 samples.
- Runtime comparison: five warmed measurements per mode and engine on the same inputs; separate CPU profile of 30 default projections.

## 1. The previous seven principal findings

| Previous finding | Result of independent recheck |
|---|---|
| Negative weather correlation discarded | **Fixed.** With both wet probabilities 50% and latent correlation −0.4, expected joint wet probability is 18.4505%; observed 18.39% over 40,000 samples. The negative-correlation output is no longer identical to independence. |
| Pole targets omitted from convergence diagnostics | **Fixed.** The extreme pole-only fixture now reports `moving`, with residual 1.756 versus noise 0.085, instead of falsely reporting settled. The final check uses independent production samples. |
| Cached odds timestamped as freshly fetched | **Fixed for the demonstrated fallback path.** Feed metadata preserves original fetch times; books carry individual timestamps and stale flags. Refresh no longer routinely overwrites a valid old timestamp. Remaining unknown/mixed-timestamp limitations are below. |
| Misaligned contextual lap data and ignored standard errors | **Fixed in the reviewed archive.** R1 now matches 957/957 comparable lap times without adding an offset. All 15 rounds have reconciliation metadata; R2–R15 lap-time agreement is about 97.4–98.5%. Changing `paceSe` changes the model. |
| First teammate's retirement rate applied to both | **Fixed in the original fixture.** Targets 1%/80% produce 0.93%/80.27%; reversing driver order produces 1.00%/80.52%, over 30,000 samples. Shared and individual components are separated. |
| Invalid settings leave earlier mutations behind | **Fixed.** Applying a valid change followed by an invalid key leaves `qSd` at 0.20. The suite also covers nested calls and thrown callbacks. |
| Production/archive/Lab use different persistence seeds | **Fixed at the shared job/seed layer.** The archive and production-style run use the same persistence seed. Rounded archived means differ from unrounded simulation means by at most 0.048 points in the fixture, consistent with one-decimal rounding. Exact sample equality is covered by the new regression test. |

Compound agreement is now 100% in the lap audit because reconciliation takes compound data from FastF1. This verifies consistent copying/alignment; it is not independent proof that every source label is correct. Contextual pace remains experimental, appropriately.

Other verified improvements include a single fastest-stop bonus in the tested zero-band case, exact high-rate Poisson sampling, stream-local storage of the second Box–Muller draw, Wilson probability intervals, fit-health logging, a smoother reliability-uncertainty control, lean calibration runs, typed-array quantile sorting and sampled affordability checks for retained plans.

## 2. Accuracy: broadly unchanged, with an evaluation qualification

### Standard published backtest

| Metric | Previous review | Current run |
|---|---:|---:|
| CRPS, lower is better | 8.686 | 8.722 |
| Mean absolute points error | 11.947 | 11.928 |
| Driver / constructor MAE | 10.43 / 14.99 | 10.43 / 14.93 |
| Mean bias | +1.22 | +1.22 |
| Rank correlation | 0.726 | 0.727 |
| Nominal 80% coverage | 81% | 80% |
| Nominal 50% coverage | 52% | 52% |
| Fresh-$100m-team points | 2,042 | 2,042 |

These snapshots are not a clean engine comparison: historical weather handling and the random stream changed. Fresh-team points are a development benchmark, not a season-long transfer policy return.

### Controlled comparisons

Both engine versions were run through the same current harness and inputs, with three seeds averaged within each weekend. For a more conservative weather comparison, I removed rebuilt weather fields marked `lead: 0`, retaining available positive-lead fields and the engine's usual fallback when a field was unavailable. This is a sensitivity analysis, not a complete reconstruction of historical information.

| Configuration | CRPS | MAE | Bias | Fresh-team points, seed average |
|---|---:|---:|---:|---:|
| Previous engine, current published inputs | 8.6999 | 11.8847 | +1.2416 | 1,988.0 |
| Current engine, current published inputs | 8.7195 | 11.9260 | +1.2265 | 2,038.7 |
| Previous engine, conservative weather inputs | 8.6590 | 11.8789 | +1.1105 | 2,049.7 |
| Current engine, conservative weather inputs | 8.6754 | 11.8872 | +1.1222 | 2,054.0 |

On the conservative inputs, current minus previous CRPS is **+0.0165 ± 0.0096 standard error across 11 weekends**. Positive means worse. A rough 95% interval includes zero; this is neither convincing improvement nor decisive deterioration. The random stream change contributes Monte Carlo variation. The current model remains better than simple historical-mean baselines on MAE: their errors are approximately 13.44–14.34 points.

Only the earlier R15 forecast has a completed frozen outcome: MAE 14.82, rank correlation 0.567. There are still **no completed prospective outcomes for the newly upgraded version**. Infrastructure and unit tests cannot substitute for that evidence.

## 3. Remaining findings, ordered by importance

Source references below are relative to `C:\Claude memory\F1 Fantasy`, at the reviewed commit.

### 1. Historical weather is not consistently information available at lock

**High priority: validity of evaluation.** `backtest/weather_rounds.py` falls back to unsuffixed precipitation probability when the older run is unavailable and records `lead: 0`. `walk.js` then uses it without a provenance restriction. Thirteen of 15 reconstructed rounds have zero-lead fields; in the evaluated R5–R15 window, **10 of 11** do.

Open-Meteo describes previous-day variables as fixed lead-time offsets relative to valid time. An unsuffixed/latest-run value is not evidence of a forecast available before team lock. The repository's own weather script acknowledges that these fallback values can be better informed than the site was. [Open-Meteo previous-runs documentation](https://open-meteo.com/en/docs/previous-runs-api).

There is also a concrete schema error: `wxAt()` looks for `D.projHist[r].rain`, but `refresh.load_projections()` embeds only asset-to-expected-points mappings. The actual R15 archive contains rain metadata, yet the embedded object does not, so the intended frozen-weather fallback cannot work. R15's race/qualifying rain happen to match the rebuilt zeros, limiting the demonstrated effect in that round.

Removing zero-lead reconstructed fields **improved**, rather than worsened, current CRPS by 0.0441 in this experiment. Leakage need not flatter every particular result to invalidate its interpretation as an operational backtest.

**Required change:** preserve issue/availability times and distinguish verified pre-lock forecasts, conservative substitutes and retrospective sensitivity inputs. Read complete frozen records from their archive. Reject later or unknown vintages from the headline chronological evaluation. Where possible, choose a specific forecast run with availability no later than lock; assess every hour in the session window, not only session start.

Evidence: `backtest/weather_rounds.py:49–81`, `backtest/walk.js:52–61`, `refresh.py:763–772`.

### 2. The “at lock” view is a live-data transformation, not a frozen snapshot

**High priority: user-facing forecast integrity.** `Engine.atLock()` removes live scoring and known session orders and substitutes locked odds. It retains the current weather, practice and penalty inputs. A later refresh can therefore change what is described as the forecast at lock.

In a controlled future post-lock fixture, a penalty explicitly timestamped 30 minutes after lock remained in the lock view. Changing weather from dry to wet and adding that penalty changed an asset's displayed projection by up to **7.6 points**. This is a deliberately adverse fixture, not a claim that the reviewed next race has already experienced that change.

**Required change:** store an immutable full job/input snapshot at lock and use it for this view and its precomputed samples. Keep a separately identified live forecast. Filtering only qualifying and odds cannot reproduce all the information that was available at lock.

Evidence: `engine.js:3492–3499`, `web/js/forecast.js:29–36`, `tools/presim.js:44–45`.

### 3. Independent finalist checks omit transfer penalties and mislabel reversals

**Medium priority: decision diagnostics.** The independent simulation is a good addition. However, `simNoise()` compares `teamSamples()`, which contain raw team scores but do not subtract each candidate's transfer penalty. The ranking uses net points. The independent check can therefore test a different objective from the one that selected the teams.

A controlled example with independent raw scores 110 versus 100 and penalties 10 versus 0 is an exact net tie. The current function does not mark it as near. Separately, its one-sided test `gap < 2 × SE` labels a candidate beating the original leader by 10 points with zero sampling error as a near tie.

**Required change:** compare independently simulated net scores, including all deterministic penalties/adjustments used in the objective. Use the absolute gap for an equivalence/noise marker, with inclusive handling of exact zero-variance ties. Show a separate “independent check reverses the ranking” result when the sign changes convincingly. If independently estimated means are displayed, label their sample basis.

Evidence: `web/js/calc.js:720–756`, `web/js/forecast.js:419–445`.

### 4. The partial download mixes 4,000-sample distributions with 10,000-sample summaries

**Medium priority: output consistency.** The initial precomputed download correctly contains a 4,000-sample prefix. Its metadata contains full 10,000-sample means, quantiles and event probabilities. `runRaces()` changes `N` and the sample arrays but retains those full summaries.

On current inputs, the largest asset mean differences between the prefix samples and reported summaries are **0.504, 0.689 and 0.361 points** across the three forecast races. With both download parts present, the discrepancy is exactly zero. If the second download fails, the mixed state persists silently.

It is legitimate to offer full-run means alongside provisional distributions, but the sample bases must be explicit and calculations must use them consistently. Currently team distributions, asset tables, price probabilities and sampling-error calculations can refer to different samples while appearing to be one forecast.

**Required change:** ship summaries for the prefix as well as the full run, or recompute them for the loaded samples. Alternatively preserve separate explicitly named sample bases throughout. Test interrupted/failed second downloads and cross-view consistency, not just binary decoding.

Evidence: `tools/presim.js:50–70`, `web/js/forecast.js:104–141`; the existing presim test verifies correct bytes and full summaries separately but does not detect this combination.

### 5. The accuracy-cache key omits the newly added weather and FIA inputs

**Medium priority: stale evaluation.** The earlier omissions of joint sample files and `ACC_N` are fixed. However, the new evaluator reads `backtest/weather_by_round.json` and FIA document archives, neither of which is hashed by the cache key. A correction to either can change evaluation without invalidating the saved health result.

**Required change:** build a single explicit input manifest shared by evaluation and cache identity. Include weather vintages, parsed penalty files, schema and code versions. A source file changing today happens to invalidate the cache, but subsequent data-only corrections must do so too.

Evidence: `backtest/accuracy.js:47–57`, `backtest/walk.js:52–82`.

## 4. Numerical integrity and convergence

**Covariance:** direct variance of a seven-asset boosted lineup and the weighted covariance calculation agree: **3148.18771399**. The correct team SD is **56.11 points**, versus **53.02** if assets were treated as independent. Joint aggregation is sound in this fixture.

**Randomness:** repeatability, sample-prefix stability, interleaved-run isolation and independence from ambient `Math.random()` passed. The spare normal is stored on each RNG stream, avoiding a global cached-normal leak. RNG version 5 correctly records the changed stream.

**Distribution boundaries:** Poisson(31), over 200,000 draws, has mean **31.0068**, variance **31.0501**, skew **0.1860**, close to its theoretical skew **0.1796**. The previous near-zero-skew approximation is gone. The all-zero pit-band fixture awards exactly five bonus points in total. The safety-car fixture yields **49.82%** versus a 50% target over 100,000 samples.

**Sampling convergence:** for a fixed lineup, 24 independent runs at each sample size produced:

| Samples per run | SD of run means | Average calculated standard error |
|---|---:|---:|
| 1,000 | 1.574 | 1.741 |
| 4,000 | 0.710 | 0.863 |
| 16,000 | 0.438 | 0.431 |

These results are consistent with the expected approximate inverse-square-root reduction in error. This supports the sampler and standard-error calculation; it does not establish forecast calibration or validate every tail statistic. Adaptive sample extension, sequential stopping and quantile precision remain unimplemented.

**Fit health:** seven logged fits in the R15 projection are healthy. Singular directions and non-convergence now have a reporting route. The condition diagnostic is a pivot-ratio heuristic, not a full matrix condition number. The contextual Python regression still uses six fixed robust-reweighting iterations and approximate uncertainty, rather than a fully validated hierarchical fit.

**Market convergence:** the current R15 fit reports `moving`, with residual **0.313** against noise **0.050**. The diagnostic is now honest; the four-step fitter still does not closely meet its intended blended targets in this case. Additional steps should be evaluated as a model change, since they alter the effective market influence. A fixed global logit floor and a step-size threshold remain approximations; a small last step alone does not prove targets mathematically unreachable.

Small configuration issue: `withSettings({'MODEL.dnfHalfLife': Infinity})` is now rejected even though Infinity is the shipped “no decay” value. Permit documented sentinel values by setting schema, while rejecting invalid values and unsupported ranges.

## 5. Disabled features and additional modelling

The six named challengers were rerun on the conservative weather inputs, three seeds per weekend. Deltas are challenger minus default CRPS; ± denotes the standard error across 11 weekends, not a 95% interval.

| Challenger | Δ CRPS ± SE | Recommendation |
|---|---:|---|
| Qualifying skew 2 | +0.0086 ± 0.0126 | Keep experimental |
| Overtake half-life 6 | +0.0085 ± 0.0267 | Keep experimental; bias falls, overall benefit unresolved |
| Contextual pace | +0.0107 ± 0.0224 | Data repair is valuable; promotion not supported yet |
| Cause-based retirements, field incidents | −0.0143 ± 0.0267 | Slightly favourable point estimate; insufficient evidence |
| Shared overtaking environment | +0.0230 ± 0.0159 | Keep experimental; assess joint/team risk too |
| Quote-spread weighting | 0.0000 | Historical inputs lack spread coverage; this is not a meaningful performance test |

The qualifying practice signal remains useful; the long-run practice sweep still favours weight zero. At weight 0.3, race-position MAE is 3.088 versus 2.983 at zero.

The lap and segment engines were benchmarked, but I did not repeat the entire older 18-variant predictive sweep: their mechanics were not comprehensively rebuilt this round. More detailed simulation is not automatically more accurate.

The sampled affordability check is a useful improvement: it tests retained plans against coherent asset price paths. It remains a check after beam-search pruning on expected prices. A robust plan discarded earlier cannot be recovered by final reranking, and infeasible scenarios have no adaptive replacement policy. The 90% threshold is a chosen risk tolerance, not an empirically established optimum. Keep the limitation visible; do not present this as a fully stochastic transfer/chip optimiser.

The new three-round holdout for weekly fitting is a better development safeguard. It is a single trailing holdout, not repeated outer walk-forward validation. Repeatedly inspecting and tuning against those three rounds compromises independence, and a two-standard-error rule with only three weekends is weak evidence. New frozen outcomes remain the stronger promotion gate.

## 6. Runtime

Same current R15 inputs, same machine, five warmed measurements per stage. Combined figures sum median setup time and median 10,000-sample time; they exclude network, browser rendering and the full planner.

| Mode | Previous engine | Current engine | Reduction |
|---|---:|---:|---:|
| Rank/default | 0.348 s | 0.260 s | About 25% |
| Laps | 2.140 s | 1.925 s | About 10% |
| Segments | 5.286 s | 4.801 s | About 9% |

The lean market runs, typed-array sorting and both Box–Muller outputs have achieved real savings. In the new CPU profile, summary-related self time is around 4%, versus roughly 23% in the preceding profile. Normal generation remains around 17%; most remaining work is in weekend/session simulation. Profiling attribution is approximate and changes as other work gets faster.

Precomputing the default forecast during the build is a sensible response to phone performance. Sample decoding matches the full run exactly in the test. The partial-summary issue needs correction. Custom simulations and the independent finalist check still run on the browser's main thread; scheduling work with a timeout defers it but does not make it non-blocking. Move those to a worker only if measured interaction latency warrants it.

## 7. Data priorities and next actions

1. **Make time-of-knowledge reliable.** Freeze the complete job at lock; enforce forecast issue/availability cutoffs in backtests; read full archived forecast records. This matters more to accuracy claims than adding another feature now.
2. **Correct decision and display consistency.** Include transfer penalties in independent comparisons, distinguish reversals from near ties, and keep partial-download summaries aligned with their samples.
3. **Finish evaluation dependency tracking.** Hash every data source the evaluator reads; preserve immutable manifests for repeatable results.
4. **Accumulate prospective champion/challenger outcomes.** Continue storing joint samples near lock, outcome revisions and source vintages. Current coverage is 15 lap rounds, two weather archive files, one FIA event archive, two projections and one challenger round; no joint sample or quote archive files yet. Those collection windows may not have occurred, so absence alone is not a malfunction.
5. **Use existing richer data more carefully.** Retain event-specific penalty histories, original book timestamps, publication/retrieval times, individual pit-stop eligibility/times and reliable retirement causes. A single latest penalty timestamp can hide an earlier component of an accumulated penalty; mixed-age market books should not all be conditioned under one global timestamp.
6. **Validate model extensions before enabling them.** Estimate contextual error inflation from held-out stints/races rather than treating the current factor of two as established; distinguish unknown retirement causes from confirmed mechanical failures; evaluate calibration by wet/dry, sprint/standard and driver/constructor groups. Preserve the stronger default until an extension demonstrates benefit.
7. **Treat larger models as research, not required complexity.** Distance-based survival, tyre/fuel hierarchy, safety-car timing and adaptive transfer policies should earn their implementation cost through measurable errors or decision gains. FIA mileage, tyre inventory and upgrade extraction remain possible inputs, not completed predictive features.

The remaining timestamp corner case is worth covering explicitly: an odds object without `at` still treats a dated penalty as known because comparison with NaN is false; refresh also substitutes the current time if no book time exists. Normal stamped caches now work, but “unknown” should remain unknown. Legacy file modification times are an approximation to fetch time, not guaranteed source provenance.

No additional feature needs to be switched on immediately. The next release should concentrate on the five confirmed findings above and then leave a stable version running long enough to measure prospective performance.

## Evidence

`F1-second-round-evidence.json` contains the controlled numerical cases, repeated-seed comparisons, lap alignment results, partial-download diagnostics, convergence measurements, timings and profile summary. Deliberately adverse fixtures are identified as such; their effect sizes are not presented as measured errors in an actual completed race.
