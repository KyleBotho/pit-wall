# F1 Fantasy — post-upgrade review

27 September 2026 · Reviewed commit `b527099` · Data generated `2026-09-27T14:24+00:00`

**Revised score: 7.5/10, up from 7/10.** The upgrade materially improves correctness, reproducibility and the foundations for future modelling. The default model's historical results improve modestly, and its uncertainty intervals are better calibrated in aggregate. It still falls short of the requested professional standard because several numerical/data defects remain, substantial parts of the plan are incomplete, and the upgraded forecasts have not yet accumulated independent race outcomes.

This is a judgment against the original rating rubric, not a measured statistical quantity. I would continue using the default model for decision support. I would keep the new contextual pace and cause-specific retirement models experimental until the defects below are corrected and their incremental value is established.

The application repository was not modified. Diagnostics were run from a separate workspace. This review covers source code, tests, archived inputs, controlled numerical experiments, repeated-seed backtests and Node runtime profiling. It does not certify the deployed website, authenticated owner-only UI, every upstream record or future operation of the scheduled data collection.

## 1. Verification and measured change

The complete JavaScript check pipeline passed: lint, formatting, types and **82 tests**. All **41 Python tests** passed. The earlier review had 63 JavaScript and 31 Python tests.

I reran backtest sections 1, 3, 4, 5, 6, 7 and 8, the canonical-lap source audit, additional boundary/stream/covariance fixtures, and seven three-seed model comparisons over R5–R15 at 3,000 simulations per race.

### Standard backtest: earlier report versus current version

| Metric | Earlier reviewed result | Current standard run | Assessment |
|---|---:|---:|---|
| CRPS, lower is better | 8.761 | 8.686 | Modest improvement, about 0.9% |
| Mean absolute points error | 12.125 | 11.947 | Modest improvement, about 1.5% |
| Driver / constructor MAE | 10.60 / 15.17 | 10.43 / 14.99 | Both improve |
| Nominal 80% interval coverage | 85% | 81% | Closer to target |
| Nominal 50% interval coverage | 56% | 52% | Closer to target |
| Mean bias | +0.20 points | +1.22 points | More optimistic overall |
| Rank correlation | 0.727 | 0.726 | Essentially unchanged |
| Fresh-$100m-team points | 1,975 | 2,042 | A volatile development benchmark, not a realistic season return |
| Reconstructed historical price changes | 422/425 | 493/495 | Broader coverage and better fit |

The before/after snapshots include data and evaluation changes as well as code changes. To isolate the engine more fairly, I also ran **both engine versions on the same current data and current chronological harness**, averaging three seeds within each weekend:

| Same-input comparison | Old engine | New engine |
|---|---:|---:|
| CRPS | 8.7513 | 8.6765 |
| MAE | 12.1098 | 11.9348 |
| Average fresh-team points over the three runs | 2,048.0 | 2,049.7 |

The paired new-minus-old CRPS difference is **−0.0748 ± 0.0502 standard error across 11 weekends**. A rough 95% interval includes zero. This supports a modest improvement, not a statistically decisive claim of superior future predictions or fantasy decisions. The selected-team totals are almost unchanged in this controlled comparison.

The increased positive bias deserves monitoring, but is not a reason to undo the retirement-overtake correction: an old missing scoring mechanism can accidentally cancel another modelling bias. Correct the remaining bias at its source.

Only R15 has a completed genuinely frozen forecast, and that is the earlier version's forecast: MAE 14.82, rank correlation 0.567. The upgraded champion/challenger records begin at R16, which has no outcome in this snapshot. There is **no new completed prospective evidence** yet.

## 2. Improvements that are implemented and working

| Upgrade | Verification and qualification |
|---|---|
| Retired drivers retain overtakes | The rank simulator now models passes before retirement using sampled exposure and a fitted retirement term. It distinguishes non-starters. This fixes the main omitted-points mechanism. |
| Planner price carry | Cumulative changes persist through later stages; the regression test covers the original third-stage defect and held-versus-unheld assets. |
| Lab practice weight | Shared setup options remove the original squared practice-weight defect. A separate random-stream consistency issue remains below. |
| Completed scored sessions | Actual scored qualifying/sprint points can be locked, including constructor reconciliation. Before scoring is complete, provisional handling still has limitations. |
| Market conditioning | Known qualifying/grid information is now passed into fitting when the quote is judged post-qualifying; settled qualifying pace is held fixed. Quote freshness needs correction below. |
| Safety-car calibration | The independent-retirement fixture now gives **50.181% over 100,000 samples** for a 50% target, consistent with Monte Carlo error. Incompatible targets are counted. The incident generating-function treatment assumes uncapped additive incident losses and should retain stress tests for near-total retirement. |
| Price-rule coverage | Inactive rounds are no longer automatically treated as zero scores in the rolling price average. Two R8 discrepancies remain explicitly unresolved. |
| Probability labels | Calculator and league strict-win conventions now agree; league ties are shown. |
| Forecast records | Settings, RNG version, exact final simulation setup, input hashes and build/lock metadata are recorded; replay is tested. |
| Challenger infrastructure | Five named alternatives are archived with the champion; future comparisons use weekend-level differences and identify standard errors correctly. |
| Monte Carlo error display | Next-race team-mean errors and paired near-tie markers are useful additions. They are fixed-sample diagnostics, not adaptive convergence control. |
| Data collection | Fifteen rounds of canonical laps, weather vintages and an FIA document index now exist. Collection hooks are integrated into refresh. |
| Joint modelling | Positive weather dependence, competitive pit bonuses in supported cases, and persistent horizon uncertainty have been added. Each needs the qualifications below. |
| Responsiveness | The Sim Lab has a worker path with fallback; this was inspected in code, not exercised through owner authentication in this review. |

Joint covariance remains correctly preserved in team aggregation. In a repeated lineup diagnostic, direct score variance and the weighted covariance calculation agreed to numerical precision: **3267.40139959**. Team SD was **57.16 points**, versus **53.81** if covariance were incorrectly ignored.

Default simulation repeatability, sample-prefix consistency and isolation from ambient `Math.random()` passed again. That should be distinguished from the configuration-restoration failure below.

## 3. Highest-priority remaining findings

Source locations refer to commit `b527099` under `C:\Claude memory\F1 Fantasy`.

### A. Negative weather correlation is calculated, then silently discarded

**Confirmed; affects an active input.** `withWeather`/`latentCorr` can produce a negative latent correlation. The current next-race input is **−0.21**. But `simSample` uses `Math.max(0, rho)` in both coefficients, so every negative value is sampled as zero correlation.

Controlled fixture: qualifying and race wet probabilities both 50%, requested latent correlation −0.4, 40,000 samples.

| Quantity | Result |
|---|---:|
| Correct joint wet probability under the specified Gaussian copula | 18.45% |
| Simulated joint wet probability | 24.67% |
| Comparison with rho=0 | Raw score arrays identical |

Marginal weather probabilities remain approximately correct; the joint scenarios do not. This directly concerns the covariance improvement the upgrade intended to deliver.

**Fix:** sample the specified valid correlation structure, using a proper bivariate/positive-semidefinite multivariate construction or calibrated ensemble scenarios. Test positive, zero and negative dependence. Do not merely accept negative values in the input while implementing only positive dependence.

Evidence: `engine.js:888`, `engine.js:954`, `engine.js:2374`.

### B. Market calibration can report “settled” without checking the relevant target

**Confirmed.** The new residual and maximum-step diagnostics accumulate race-market terms only. Pole adjustments are excluded. A pole-only book therefore has zero reported residual, zero reported noise and zero reported step, even while qualifying pace is moving substantially.

With a 95% pole target, one update and an independent 30,000-sample validation, the returned model achieved **2.03% pole probability**, yet reported `settled: true`, `resid: [0]`, `lastStep: 0`. The point of this adverse fixture is the false convergence report, not that one update should reach an extreme target. The omission exists with the default iteration count too.

For mixed books, the residual describes the model before the final update, rather than an independently evaluated final model. Four iterations remain fixed; the code does not use the diagnostic to stop or extend fitting. Its noise estimate is an unweighted average while its residual uses weights, so the threshold also needs a consistent definition.

**Fix:** cover all active markets, measure final-model residuals on independent draws, include qualifying and race parameter movement, and report separate states for convergence, sampling-limited fitting and unattainable/inconsistent targets. Keep the redundant final simulation removed; use the production run or a purpose-built validation run for meaningful final diagnostics.

Evidence: `engine.js:2574–2660`.

### C. Cached odds can acquire a false fresh timestamp and the wrong conditioning

**Confirmed code path; impact on a particular historical outage was not measured.** `get_soft` returns the old cached payload when a request fails. `refresh.py` then sets `odds.at` to the current refresh time regardless of whether the data was fresh. `oddsKnown` uses that timestamp to decide whether qualifying was already known to the market.

A pre-qualifying cached book reused after qualifying can therefore be treated as a post-qualifying book. That compromises the new conditioning fix and the archive's provenance. Weather observations also need a distinction between retrieval attempt, successful retrieval and source/model issue time.

**Fix:** propagate cached/fresh status and original successful fetch/quote time per source or book. Record retry time separately. Do not infer the information behind a quote from the latest attempted refresh; account for penalties published after the quote as well.

Evidence: `f1feeds.py:91`, `refresh.py:483–486`, `engine.js:3225`, `extras.py:268`.

### D. The contextual pace candidate still consumes known misaligned data and ignores its own uncertainty

**Confirmed; currently experimental.** The source audit's R1 lap-time agreement is only **1.04%** when matching the stored lap numbers. Adding one to OpenF1's lap number produces **100% agreement across 957 comparable laps**. The canonical cleaner nevertheless accepts **738 R1 laps** for fitting. A generic missing-lap flag is not a correction or exclusion policy.

Because compound, tyre age and pit boundaries are joined using lap numbers, alignment matters for the contextual variables even when the time value itself is valid. Other compound agreement results also warrant reconciliation: R5 92.5%, R6 91.5%, R10 96.8% and R11 97.1% in the current cross-source audit.

The lap estimator writes `paceSe`, but the engine never uses it in pace weighting or uncertainty. Replacing all available `paceSe` values with **100 percentage points** left the contextual engine model **exactly unchanged**.

This is a useful robust per-race regression, but not the full planned hierarchical pace model. Driver intercepts, compound, age, race progress and traffic are fitted with a very light context penalty. Practice modelling remains the old estimator; latent practice fuel/programme uncertainty and full joint car/driver inference have not been implemented. Lap errors within a stint are correlated, and the simple weighted regression covariance is not a validated uncertainty model for that dependence.

**Fix:** reconcile identifiers and lap alignment before joins, enforce data-quality gates, handle missing/neutralised/damp periods explicitly, and propagate estimated measurement uncertainty into the season model. Then test whether the added detail beats the corrected median-pace baseline.

Evidence: `laps.py:90–254`, `engine.js:1018–1080`, `engine.js:1270–1280`.

### E. Driver-specific retirement rates are overwritten by the first teammate's rate

**Confirmed; important before enabling individual incident effects.** The cause model can estimate different retirement probabilities for teammates. Simulation creates one `rel[t]` from the first driver of each team and assigns it to both, including when uncertainty is switched off.

In a controlled no-shared-incident fixture with teammate risks 1% and 80%:

| Driver order | First driver's observed risk | Second driver's observed risk |
|---|---:|---:|
| Normal | 1.01% | 1.07% |
| Reversed input order, reported for the same two drivers | 80.10% | 79.66% |

This is not merely Monte Carlo variation. The input order chooses which risk both drivers inherit. The actual R15-input cause model with ordinary incident shrinkage estimates Mercedes at 11.64% for Russell and 7.94% for Antonelli, demonstrating that distinct rates occur in realistic inputs too.

The shipped default still uses pooled team rates, so this is primarily an experimental-feature issue. The named `dnfcauses` challenger uses near-field-only incident rates (`incShrink=1e6`), which largely suppresses this difference and limits the practical effect on that particular challenger.

The “other” retirement category also includes unidentified solo incidents, not just mechanical failures. The model uses rates per race, not the planned distance-based survival model.

**Fix:** keep shared mechanical uncertainty separate from individual incident risk; preserve each driver's marginal risk. Validate invariance to input ordering and label unknown causes honestly.

Evidence: `engine.js:972`, `engine.js:1280–1291`, `engine.js:2357–2365`; `laps.py:276`.

### F. Configuration restoration leaks when a settings key is invalid

**Confirmed error-path defect.** `withSettings` mutates settings while preparing its undo list, before entering `try/finally`. If a later key is invalid, it throws before restoration becomes active.

Applying a valid `SIM.qSd=0.91` followed by an invalid key left `SIM.qSd` at **0.91 instead of 0.20** after the error. Ordinary valid synchronous calls restore correctly, and the tested random generator itself remains isolated.

**Fix:** validate all keys and values first, then mutate within an active restoration scope; prefer explicit immutable configuration in the longer term. Add invalid-key, invalid-value and nested-call tests.

Evidence: `engine.js:3242–3257`.

### G. The archived forecast and Lab do not exactly replay the production calculation

**Confirmed consistency gap.** The browser's `compute()` passes a persistent uncertainty seed, even for the next race. `Engine.project()` and the Lab's `runJob()` omit it. This changes random-number streams and realised samples despite otherwise matching settings.

For identical R15 inputs and 10,000 samples, the largest asset mean difference between the archived-project path and the production-style path was **0.47 points**, including the archive's rounding. This is not evidence of a large systematic bias: the marginal models are intended to agree. It does mean that the frozen record is not an exact record of the displayed production calculation, and default Lab comparisons are not identical seeded baselines.

**Fix:** share a forecast-job specification, including persistent seed and conditioning, across production, Lab, export and replay. Require exact sample equality for matching jobs, while retaining intentional overrides as separate scenarios.

Evidence: `web/js/forecast.js:36–46`, `web/js/lab.js:124–139`, `engine.js:3304–3319`.

## 4. Other limitations that remain relevant

- **Provisional sessions:** scored-session locking is a real improvement. Before actual scoring arrives, the code still maps raw DNF/DNS/DSQ flags directly to retirement/no-time treatment and can randomly generate sprint overtakes/fastest lap. Preserve classification and completed laps, and distinguish actual events from estimates. OpenF1 describes DNF as “did not finish” and separately supplies lap counts; it does not document DNF as synonymous with fantasy non-classification. [OpenF1 session results](https://openf1.org/docs/#session-result).
- **Pit bonus boundary:** the new single-winner branch requires all teams to have at least three band observations. Otherwise it falls back to independent histories, which can still produce multiple bonuses. Even in the new branch, all-zero bands yield no fastest-stop bonus. A controlled all-zero-band fixture returned zero total pit points. To distinguish no stops from eligible stops slower than the scoring bands, retain stop eligibility/times rather than only band points. This is a boundary limitation, not a demonstrated error in an actual reviewed weekend.
- **Solver health:** the singular example now returns [1,0] instead of huge numbers. That is better bounded behaviour, but it silently discards an inconsistent equation and returns no failure/conditioning flag. Poisson fitting still lacks a returned convergence status or robust objective-based stopping. Finite output does not establish an identified fit.
- **Distribution controls:** the high-rate Poisson normal approximation, fixed 0.4% market logit floor, beta shape floors and discontinuity near zero uncertainty remain. They were not comprehensively replaced by the numerical upgrades. The Poisson(31) diagnostic still has near-zero skew rather than the correct approximately 0.18.
- **Sampling error:** Wald probability errors can report zero uncertainty for zero/one observed probabilities. Use suitable binomial bounds. There is no adaptive sample extension, independent finalist validation, quantile precision display or robust sequential stopping policy yet. Close-team markers are useful but use the same samples that selected the top team.
- **Evaluation:** historical weather and known-weekend information remain omitted by `asOf`; fitting still uses the evaluation period for development rather than nested outer validation. The new frozen archive is the right prospective remedy, but has not yet yielded outcomes.
- **Cache completeness:** the accuracy key now covers far more inputs, but omits the `samples` directory it reads for frozen CRPS, and the `ACC_N` override. Changes to those can leave a stale health result.
- **Planner:** cumulative and sampled asset prices are implemented, but the beam search uses expected price changes. It does not yet enforce affordability across sampled future scenarios or search a complete adaptive transfer/chip policy. Candidate screening for nonlinear objectives remains approximate.
- **Data collection versus model use:** FIA document links and timestamps are archived; upgrade performance, component mileage and tyre-set inventories are not extracted into the model. Quote-quality fields are collected when available, but are not yet used for liquidity/freshness weighting. More collection is valuable without implying that all new information currently improves predictions.

## 5. Disabled/new feature reassessment

Three-seed comparisons below use the current engine, current inputs, R5–R15 and 3,000 simulations. Seeds are averaged within weekend; ± is the standard error of paired CRPS differences over 11 weekends, not a 95% interval. Positive differences are worse.

| Challenger | Δ CRPS versus current default | Verdict |
|---|---:|---|
| Qualifying skew 2 | +0.0263 ± 0.0107 | Do not promote; its earlier advantage did not persist against the upgraded baseline |
| Overtake recency half-life 6 | +0.0198 ± 0.0292 | Inconclusive; may help bias, but no established distribution improvement |
| Contextual race pace | +0.0220 ± 0.0333 | Keep experimental; resolve alignment and uncertainty integration first |
| Cause-based retirement, field incidents | −0.0074 ± 0.0322 | Inconclusive; slight point estimate improvement, not compelling evidence |
| Shared overtaking environment | +0.0213 ± 0.0171 | Keep experimental; evaluate team/joint risk as well as marginal scores |

Multiple experiments on these same weekends further weaken any isolated significance claim. A shared overtaking factor can affect marginal distributions too; the claim that asset CRPS cannot show any effect from it would be too strong. Team-level validation is additionally necessary for its intended covariance benefit.

The lap/segment engines, track bands, minisectors, old long-run estimator and car-offset variants have not been rebuilt into the full planned models. Their earlier caveats still apply; I did not rerun the entire earlier 18-variant grid because the newly changed challengers and their defects were the relevant new evidence. The current practice-weight sweep still favours zero long-run weight: race-position MAE 2.983 at zero versus 3.088 at weight 0.3.

## 6. Runtime reassessment

Both versions were benchmarked sequentially on the same current R15 inputs, in Node on this computer, with three warmed measurements per stage. These exclude network, browser rendering and the full planner. Figures are medians and their sums, not guaranteed user-interface latency.

| Mode | Old combined setup + 10k samples | New combined | Change |
|---|---:|---:|---:|
| Rank | 0.338 s | 0.323 s | About 4% faster |
| Laps | 2.397 s | 2.127 s | About 11% faster |
| Segments | 5.920 s | 5.184 s | About 12% faster |

The main improvement comes from removing the unused calibration simulation. New rank setup is about 165 ms versus 192 ms; final sampling is about 158 ms versus 145 ms because the new model does more work. Experimental models remain considerably more expensive without proven predictive benefit.

A new profile of 30 complete default projections attributed approximately **23% of sampled CPU time to summary/sorting work**, **18% to normal generation**, and **1% to garbage collection**. V8 attribution and workload affect these estimates.

The main unimplemented opportunities remain lean probability-only market fitting, optional summaries, using both Box–Muller draws, incremental sampling and complete caching. The worker currently covers the Lab; the main calculator's `compute()` still performs its simulations synchronously. A worker improves responsiveness, not the underlying statistical accuracy.

## 7. Completion against the agreed plan

| Plan phase | Current assessment |
|---|---|
| 0 — Evidence and validation | Substantially improved archives; prospective collection started; full nested/operational replay and complete cache identity remain incomplete |
| 1 — Correctness | Most headline defects repaired; provisional classification, quote freshness and some boundaries remain |
| 2 — Numerical integrity/convergence | Partial: sample-count validation and error displays added; calibration status is flawed, configuration can leak, adaptive/independent validation remains absent |
| 3 — Performance | Partial: redundant run removed and Lab worker added; most measured hot-path optimisations remain |
| 4 — Data and core models | Useful collection and experimental regression/cause models built; full hierarchical pace, measurement-uncertainty integration and survival modelling remain incomplete |
| 5 — Joint uncertainty/planning | Partial: persistent uncertainty and asset price paths work; negative weather dependence fails; fully stochastic planning and event mechanisms remain deferred |
| 6 — Feature promotion | Champion/challenger infrastructure exists; independent outcomes are not yet available and promotion remains unproven |

The repository's own development history explicitly says fully stochastic planning, SC/VSC/red-flag event mechanisms and explicit configuration objects were not built. Deferring a feature can be sensible; it should not be recorded as satisfying the whole plan.

## 8. Ordered next actions

1. **Fix weather dependence and market freshness/conditioning.** They affect active forecast inputs and can misrepresent the information available before a race.
2. **Replace the misleading market “settled” diagnostic.** Include pole targets and independently validate the final fitted state; distinguish uncertainty from convergence.
3. **Repair configuration restoration and unify production/Lab/archive job specifications.** Matching jobs should reproduce matching samples, including persistence settings.
4. **Gate and repair contextual data before feature promotion.** Correct the R1 alignment, investigate compound mismatches and use measurement uncertainty in the estimator.
5. **Separate shared mechanical and individual incident risk.** Remove the teammate-order dependency before enabling driver-specific cause effects.
6. **Finish meaningful numerical diagnostics and boundary handling.** Include solver health, probability bounds, remaining pit/session boundaries, independent finalist checks and cache completeness.
7. **Implement the remaining measured performance improvements.** Prioritise calibration summaries and normal generation; extend worker coverage only where responsiveness requires it.
8. **Accumulate prospective evidence and evaluate realistic team policies.** Keep challengers off by default when their benefit is unresolved; do not retune repeatedly to the same 11 weekends.

The upgrade has made the system more credible and easier to evaluate. The next route toward an 8+ score is to close these specific gaps and demonstrate performance on forecasts frozen before new race outcomes, rather than add another layer of simulation detail.

## Evidence accompanying this report

`F1-post-upgrade-evidence.json` combines the controlled numerical fixtures, same-input version comparison, challenger comparisons, lap alignment audit, covariance check and runtime profile. Numerical fixtures deliberately include adverse inputs; their stated scope separates default-path defects from experimental or exceptional cases.
