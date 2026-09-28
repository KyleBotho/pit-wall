# F1 Fantasy — third-round review, updated

Updated 28 September 2026 · Source `0275ec73e9dc74879398695c87bcd09a6b96491c` · Previous assessment: 27 September, `c50540b`

**Overall score: 7.9/10, unchanged.** The new work improves the engineering and the ability to diagnose the model. It does not yet demonstrate better default predictions. Some previously deferred work is now implemented, but new defects in the adaptive confidence display and Autopilot planner need fixing. The previous frozen-input and evaluation-cache issues remain.

This is a qualitative assessment against your rubric. The numerical core is strong; I would still withhold an 8+ professional-grade assessment of the complete forecasting and decision system until its frozen-input, uncertainty-reporting and decision-scoring paths are consistent and it has prospective evidence.

This update incorporates the additional work into the previous review. It also independently reviews the latest proposals rejected without a challenger: pooled race pace, timed safety cars, distance-based retirements and confirmed retirement causes. **Application code and archives were not changed.**

## What was verified

- Lint, formatting, type checking and **97 JavaScript tests passed**; **57 Python tests passed**.
- Reran backtest sections 1, 3, 4, 5, 6, 7 and 8.
- Compared current and previous engines on identical current inputs, with three seeds and 3,000 samples per weekend over R5–R15. Reran all seven named challengers.
- Added independent checks for adaptive stopping, pinned-team interference, Autopilot, worker calculation equivalence, price boundaries, eigenvalues and the revised FIA parsers.
- Reran the pooled-pace and error-inflation diagnostics. Screened pooled versus unpooled pace and sprint-retirement alternatives in memory, without creating production challengers.
- Checked chronological fit scopes and ran the full three-fold fitting workflow at **400 samples** as a smoke test. This is deliberately smaller than its production 4,000-sample setting.
- Rechecked the previous numerical and snapshot fixtures. Generated precomputed samples only into the review's scratch directory.

The local application input remains dated **27 September, 14:24 UTC**. Outcomes still end at R15. New source, research archives and the cached application input are therefore not all from the same build. The paired comparisons below control for this by using the same inputs. They do not certify a newly deployed site. Browser responsiveness was inspected through code and worker/direct calculations, not remeasured in a live browser.

## 1. Credit for the new work

| Work | Assessment |
|---|---|
| Independent check grows in batches | Useful implementation. Separate seeds and correct asset/sample alignment preserve the paired comparisons. The confidence reporting and stopping rule need the corrections below. |
| Plans valued on joint points/price futures | A substantial improvement over a blunt 90% affordability gate. The fallback is feasible and avoids future-outcome clairvoyance: it holds the team and chooses Boost using expected points. Autopilot is missing from first-race valuation. |
| Calculator simulation worker and cache | Appropriate separation of expensive sampling from the page. The same calculation helper gave **zero difference in asset means** against direct forecasts. Stale job results are prevented from replacing newer forecasts. This does not remove computation or cover every optimiser operation. |
| Settings copied within a scope, read-only exports | Direct writes throw; nested overrides and exception restoration passed. This substantially reduces accidental configuration leakage. The callback remains synchronous in its semantics; do not use it as an asynchronous configuration context. |
| Eigenvalue-based condition numbers | Real improvement over the pivot-ratio estimate. Twelve deterministic positive-definite test matrices matched NumPy eigenvalues within **2.7×10⁻¹⁴**. This validates the tested range, not every extreme matrix. |
| Repeated chronological outer folds | Correct direction: each fold fits earlier rounds only, and the proposal can use all rounds afterwards. Three test weekends remain a very small sample; the folded score evaluates the fitting procedure, not an independent test of the final all-round settings. |
| Matching-event calibration and Brier scores | Useful separation of event-frequency errors from conditional outcome errors. Full SC is now matched to full SC rather than SC-or-VSC. These diagnostics do not establish that event timing is unnecessary. |
| VSC wording and DSQ handling | Both are useful data corrections. Cached application data needs rebuilding to carry new DSQ flags; the research retirement classifier still needs a DSQ exclusion. |
| Precomputed summaries exclude sample flags | Correct fix. Independently decoded 4,000- and 10,000-sample means matched their respective summaries exactly. |
| Required-points price tables | **38,496 checks passed** against the existing price rule, covering tier transitions, price floor/cap, history lengths and integer points. This proves consistency with the implemented rule; the historical rule itself still matches 493/495 observed changes. |
| FIA power-unit row spacing | The Spanish report now yields all **22 rows**, versus 16 previously. The separate new-components parser is only partially repaired. |

Earlier repairs to negative weather dependence, seeded randomness, penalty-aware team comparisons, weather vintages and individual retirement rates remain intact in the rechecked cases.

## 2. Predictive results

The standard current backtest remains **CRPS 8.674, MAE 11.864, bias +1.12, rank correlation 0.728**, with approximately **81% / 53%** coverage of nominal 80% / 50% intervals. Driver and constructor MAE remain **10.36 / 14.87**. Fresh-$100m-team points remain **2,042**; that metric does not simulate a realistic season of transfers.

| Three-seed mean, same inputs and evaluation harness | Previous engine | Current engine |
|---|---:|---:|
| CRPS, lower is better | 8.685990 | 8.685990 |
| Mean absolute points error | 11.900352 | 11.900352 |
| Bias | +1.130340 | +1.130340 |
| 80% interval coverage | 80.716% | 80.716% |
| 50% interval coverage | 52.433% | 52.433% |
| Fresh-team points | 2,057.33 | 2,057.33 |

Thus there is **no measured default predictive gain on these matching inputs**. That is compatible with valuable changes to execution, evaluation and planning. There is still only the older completed R15 frozen projection: MAE **14.82**, correlation **0.567**, 33 assets. There are no completed prospective outcomes from the new version.

The new standard-run diagnostics reproduce the documented event results:

| Event | Mean probability | Observed frequency | Model Brier | Prior-round season-rate Brier |
|---|---:|---:|---:|---:|
| Full race SC | 56% | 45% | 0.274 | 0.308 |
| Wet race | 25% | 9% | 0.160 | 0.099 |

SC's point estimate beats this baseline; wet-race probability loses to it. **Eleven weekends, including just one wet race, do not establish reliable event-forecast skill or a stable calibration correction.** Most early weather inputs are climatological fallbacks, so this is not a clean test of the newly archived weather service alone.

| Realised group | Weekends | Unconditional 80% / 50% coverage | Matching-event coverage | Matching-event bias |
|---|---:|---:|---:|---:|
| Full SC | 5 | 74% / 43% | 78% / 45% | −0.71 |
| No full SC | 6 | 86% / 61% | 84% / 56% | +2.71 |
| Wet race | 1 | 82% / 73% | 88% / 70% | +2.77 |
| Dry race | 10 | 81% / 51% | 80% / 50% | +1.29 |

The old review's SC/VSC label should therefore be replaced by **full SC** for current results. Conditioning on what happened changes the forecasting question. Keep these diagnostic scores alongside the unconditional score, not as a replacement headline or a claimed gain in advance forecasting.

## 3. Actionable findings, in priority order

Source references below are relative to `C:\Claude memory\F1 Fantasy` at the reviewed commit.

### 1. Frozen forecasts still receive a circuit model built from live data

**High priority; previous finding remains open and now includes the worker.** `forecast.js:12` builds `trackFit` from live `DATA`; `worker.js:33–36` similarly caches a live track model before selecting frozen data. `tools/presim.js:37` does the same. Substituting frozen practice afterwards cannot change the data retained by the already-built model.

The previous fixture still reproduces exactly: frozen practice reference stays at 100 seconds, live practice changes to 90 seconds, the circuit overtake multiplier moves **0.6254 → 0.9344**, and an asset mean changes by up to **3.6771 points** in 10,000 samples. Constructing the circuit model from the frozen data restores the original multiplier. This is a controlled fixture, not a measured completed-race error.

**Required change:** select the input variant first, then construct every derived model from it. Give live and frozen variants separate worker cache entries, and test browser/helper/precompute paths for sample-identical frozen output after live inputs change. For exact historical replay, record the entire resolved job, engine version and input provenance; visibly identify missing snapshots.

### 2. The stochastic planner does not implement Autopilot's scoring

**Medium priority; new decision-scoring finding.** `engine.js:3506–3511` gives the first race's extra points to `s0.boost`; only X3 gets special handling. `openPlan()` passes `chip: "autopilot"`, but no sample-wise maximum over the team's drivers is taken. The ordinary Calculator does implement that maximum in `forecast.js:529`.

Independent fixture through the public planner: two drivers alternate scores of 100 and 0 across two equally likely outcomes, with everyone else scoring zero. Autopilot should yield **200 expected points**: 100 base plus 100 from the best scorer each time. The planner returns **150**, exactly the ordinary fixed-Boost value. This is a synthetic demonstration, not an estimate of the real-world loss.

**Required change:** use one tested chip-aware team-sample scorer for both Calculator and planner. Cover Autopilot, X3, No Negative, Limitless reversion and transfer penalties with tiny enumerated futures. The “What is a transfer worth?” panel (`calc.js:1407–1423`) still uses deterministic plans without sample/price-path inputs; either align it with stochastic valuation or clearly distinguish its approximation.

The affordability policy itself is a useful, deliberately limited approximation. It only reranks plans surviving an expected-value beam search, and a failed transfer permanently switches to holding. It can miss plans pruned earlier or profitable later recovery moves. The page documents this limitation; retain that disclosure and evaluate policy quality before expanding it.

### 3. Adaptive sampling can overstate displayed precision and stop on the wrong teams

**Medium priority; new uncertainty-reporting findings.**

**Wrong sample count for the displayed estimate.** In `calc.js:733–752`, once an independent check exists, the standard error attached to a row is divided by the check's sample count. The row's displayed xPts remains the estimate from the original main run. Increasing the check from 10,000 to 50,000 therefore narrows the interval attached to an unchanged 10,000-sample estimate. In a controlled SD=10 fixture the 95% half-width falls from **0.196 to 0.0877**, a factor of √5, without improving that displayed estimator. Selection of the top team creates an additional reason not to promise literal 95% coverage for its main-run mean.

**Wrong finalists.** `all` starts with the current and pinned teams. `all.slice(0, 6)` at `calc.js:766` therefore does not necessarily inspect the top six ranked candidates. A fixture with six clearly inferior pinned teams and a genuine tie between the best two requests **no growth**; the same tie with no pins requests growth.

**Repeated looks are not a fixed-sample confidence test.** The implementation comments acknowledge this, but the effect is more than a cosmetic caveat. In 100,000 independent Gaussian null paths, the same two-standard-error rule falsely separated equal means **4.55%** of the time at one fixed final look, versus **13.04%** at any of five cumulative looks. This is a benchmark of the stopping logic, not the measured false-positive rate of F1 lineups; multiple candidate comparisons add another issue.

**Required change:** report main-estimate precision separately from independent paired-gap precision; use `rows.best.slice(0, 6)` for growth decisions; and use a prespecified validation size, a valid sequential interval, or a final fresh confirmation batch after adaptive exploration. A practical points-tolerance stopping rule would prevent spending 50,000 samples distinguishing irrelevant fractions of a point. Confidence sequences provide a principled option for repeated looks. [Howard et al., primary research](https://arxiv.org/abs/1810.08240)

`mergeRuns()` concatenates `tot` and `nn` correctly, but leaves first-batch statistics and event flags in an object advertising the combined N. Current near-tie consumers use the concatenated arrays, so I found no additional active result error from this. Return a deliberately narrow sample-only object or update all fields before this helper gains other callers.

### 4. Weather sensitivity mode is still absent from accuracy identity

**Medium priority; previous finding remains open.** Changing a weather input file invalidates the cache; changing `WX_LATEST` still does not. `accuracy.js:57–69` includes file dependencies and N but omits that mode. A sensitivity run can reuse or overwrite the standard result under the same identity. The previous quantified sensitivity effect was CRPS **8.6860 → 8.7208**; that sensitivity sweep was not repeated in this update.

**Required change:** include an explicit evaluation configuration in the key, saved metadata and displayed provenance, preferably with separate sensitivity output. Test both execution orderings. Default-only runs do not trigger the collision.

### 5. FIA extraction is partially fixed, but now corrupts a component assignment

**Medium priority before model use; previous finding revised.** The archive currently contains **15 events, 1,098 indexed documents and 104 technical documents marked read**. The lower technical count reflects revised document classification; it should not be confused with independently validated coverage.

The Spanish “PU elements used” spacing defect is fixed: **22/22 rows**. The new-components parser now recognises “is using a new”, but misses the heading **`( PU-ANC)`**, which contains a space inside the parentheses. It continues treating the next table as MGU-K and overwrites car 18's correct count of 4 with 6. Both the parser and the stored summary contain **MGU-K=6, PU-ANC missing**; the source tables say **MGU-K=4, PU-ANC=6**, alongside ICE=4, TC=4 and ES=5. These are counts previously used, not counts of new units fitted.

**Required change:** normalise abbreviation whitespace and bound each table to its own recognised heading; reject ambiguous overwrites. Use the real archived document as a regression fixture. Separate text-extracted, parsed and validated status, retain parser/document versions, and expose missing roster/component coverage.

The **Barcelona event join remains broken**: the consumer requests `2026_barcelona_grand_prix.json`, while the archive is `2026_barcelona-catalunya_grand_prix.json`. The backfill's new alias check prevents some redundant fetching but does not fix the consumer. Only Azerbaijan has parsed `grid` fields in the archived decision inventory; the other empty penalty dictionaries still do not demonstrate zero pre-lock penalties. Use shared event identities and complete timestamped penalty extraction before relying on these inputs in historical evaluation.

These technical summaries remain outside the default model. Component count is not mileage, upgrade count is not measured performance, and allocated compounds are not remaining tyre-set inventory.

## 4. Review of the rejected improvements without challengers

**My recommendation is to keep all four out of the production default for now. However, “deferred for insufficient evidence” is a more accurate verdict than “shown not to help” for several of them.**

### A. Hierarchical / pooled race pace — defer; revise the evidence

The chronological construction is sensible: round k uses fits from rounds ≤k, and forecasts of a later round only see earlier data. The pooling calculation uses between-race variance and within-race uncertainty rather than arbitrarily imposing one context coefficient.

However, I could not reproduce the stated maximum pace change of **0.044%**. Running the current diagnostic gives **0.161 percentage points at R6** and **0.113 at R4**; R6's mean absolute change is **0.044**. This is not proof of useful forecasting power, but it invalidates the current numerical reason for dismissing it as a duplicate. The report should identify the input snapshot behind each research result.

I performed an additional controlled offline screen: replace only each prior round's contextual pace with the newly fitted unpooled or pooled pace, while holding the existing uncertainty weights fixed. Three seeds, 3,000 samples, R5–R15:

| Variant | CRPS |
|---|---:|
| Shipped default | 8.68599 |
| Existing contextual-pace challenger | 8.69468 |
| New unpooled contextual pace | 8.70260 |
| New pooled contextual pace | 8.69663 |

Pooling versus its matching unpooled model changes CRPS by **−0.00597 ± 0.01026 SE across weekends**. This is inconclusive, and its point estimate still does not beat the default. It supports **deferral**, now for a relevant predictive reason. It does not validate the entire hierarchical model: I deliberately held uncertainty weights fixed to isolate the pooling effect.

Before a new challenger, assess residuals by stint and compound, use race/stint resampling, and validate uncertainty for relative pace contrasts rather than just individual intercepts. S/M/H are weekend-relative tyre labels, so cross-race pooling should eventually account for actual compounds and conditions. Large between-race fitted coefficient differences can reflect confounding or model misspecification as well as real physical differences.

### B. Timed safety cars — reasonable to defer; not disproved

The matching-event diagnostic is a useful reason **not to build an elaborate event simulator merely to repair one subgroup coverage table**. It demonstrates that some of the apparent coverage gap comes from mixing SC and non-SC outcomes.

It does not test SC onset, duration, repeated deployments, pit timing, overtakes, or correlated constructor outcomes. Full-SC occurrence probability and conditional spread can be reasonable while those details remain wrong. Also, the existing optional lap engine already draws a simplified `scLap`; that is different from a calibrated event process and does not validate one.

**Decision:** keep a richer timed-event challenger deferred until category residuals or joint tail errors identify a target. Use the already collected race-control windows to examine early versus late SC, duration and SC/VSC distinctions. Require an improvement in unconditional predictive scores and relevant team decisions before promotion. Avoid recording “SC groups were an artifact” as evidence that the entire mechanism is unnecessary.

### C. Distance-based retirements / sprint scaling — defer, but correct the counts

Keeping a 0.4 sprint multiplier is defensible given scarce evidence. My three-seed sensitivity screen found:

| Sprint multiplier | CRPS change versus 0.4, ± SE across all 11 weekends |
|---|---:|
| 0.36 | +0.00090 ± 0.00302 |
| 0.45 | +0.01169 ± 0.00850 |

Only three evaluated weekends are sprints, so these full-season deltas are diluted and are not a strong test of the sprint mechanism. Neither establishes an improvement.

The recorded **“8 sprint retirements in 110 starts” needs correction**. Rebuilding results in memory from the cached source pages with the current loader identifies Bortoleto's R4 **sprint** disqualification. Excluding it leaves **7 nonclassifications among 110 entries**, including two DNS. Among cars that actually started, there are **5 nonclassifications in 108 starts**. For races, the comparable quantities are **66/330 entries**, including seven DNS, or **59/323 actual starts**. These are different targets and should not be mixed when estimating a survival hazard.

The illustrative independent-binomial 95% interval for 5/108 is approximately **2.0%–10.4%**; shared race conditions make that only a rough benchmark. It still leaves plenty of uncertainty. Do not retune to a newly calculated point ratio from so few events.

A flat −20 fantasy penalty does not make retirement timing irrelevant: timing affects overtakes retained, interactions with SC and constructor scores. The current model already uses retirement-distance shares, which reduces the incremental benefit of a new hazard model. If revisited, separate DNS, DSQ, incident and mechanical events, and include late-running cars that remain officially classified. Their absence from an unclassified-car sample is censoring/selection, not proof that the late-race hazard is zero.

`laps.py:retirements()` still emits an `other` retirement for an explicitly `dsq=True` row in an independent fixture. Fix that research/data path before using it to fit hazards, even though the engine's new DSQ checks exclude those rows in its relevant numerical paths.

### D. Confirmed retirement causes — defer; preserve unknowns

I agree that a supervised mechanical-versus-incident model should not be promoted using “no incident message” as a confirmed mechanical label. The local archive supports the coverage concern: 2022 contains detailed failure statuses; 2024–2025 mostly have generic retirement statuses. A few detailed labels also exist in 2023, so availability is mixed rather than a perfectly clean year cutoff.

However, **“no public source” is too absolute**. The reviewed automated feeds do not supply complete reliable current cause labels; that does not exclude targeted labels from official team reports, FIA documents or timestamped radio. A small, provenance-linked, manually checked subset could support validation, provided unknown cases remain unknown and missing labels are not assumed random.

**Decision:** defer a new confirmed-cause challenger; first build a labelled evaluation subset and establish coverage. Treat older detailed statuses as weak priors with explicit era/source effects. Do not transfer pre-2026 mechanical frequencies directly to the new equipment regime.

### Related decision: retaining context-error inflation at 2

The **1.85** diagnostic reproduces across 64 driver-races in eight rounds. Keeping 2 as a provisional conservative setting is reasonable. It should be labelled **data-informed**, rather than a precisely validated constant.

The implementation fits odd/even stint intercepts together with shared context terms using all selected observations. Its contrast variance includes covariance, which is good, but this is **not an untouched held-out prediction test**. Per-round inflation ranges from **0.05 to 3.07**. Using the reported rounded per-round values, leaving R8 out reduces the pooled figure to roughly **1.47**. The 64 rows are not 64 independent weekends.

Before replacing the constant, perform actual held-out-stint or next-round prediction, bootstrap at the race/stint level, and report uncertainty and selection coverage. The cluster sandwich estimate near 1.03 is also not strong enough evidence to remove inflation with only a few stints per driver.

## 5. Mathematical integrity, convergence and remaining runtime work

The underlying simulation continues to pass the rechecked numerical fixtures:

| Check | Result |
|---|---|
| Weighted team covariance | Direct variance **3144.7790027900** agrees with the covariance calculation to numerical precision; SD **56.08**, versus **53.15** if correlations were incorrectly ignored. |
| Negative weather dependence | Joint wet probability **18.39%**, analytical **18.4505%**, 40,000 samples. |
| Random isolation | Same-seed reproducibility, prefix stability, interleaved calls and no ambient-random dependency passed. |
| Poisson(31) | Mean **31.0068**, variance **31.0501**, skew **0.1860**; expected skew **0.1796**. |
| SC probability fixture | **49.82%** against a 50% target, 100,000 samples. |
| Settings safety | Nested values **0.3 → 0.7 → 0.3**, then restoration; invalid-key and throwing callbacks leave the original configuration intact. |
| Price boundaries | **38,496** comparisons passed against `priceStep`. |

The condition-number improvement is a diagnostic improvement, not a replacement for stable linear algebra. Normal equations still worsen conditioning relative to working directly with the design matrix; consider QR/SVD if actual fits become ill-conditioned. Avoid changing solvers solely because they sound more sophisticated when current fits are healthy.

Sampling convergence and predictive accuracy remain different questions. The old fixed-N convergence evidence is retained, and the new independent checks are useful, but adaptive stopping needs the corrections above. Quantile/tail precision and the probability that two competing decisions are genuinely distinguishable remain more useful next diagnostics than simply increasing N everywhere.

Five warmed measurements per stage on the same R15 inputs, with no fitting run competing for CPU, gave the following medians. Totals add setup and sampling medians; they are microbenchmarks, not browser end-to-end timings. Setup uses the normal market option; the standalone 10,000-sample kernel uses a model prepared with market weight zero, consistently for both versions.

| Setup plus 10,000 samples | Previous source | Current source |
|---|---:|---:|
| Default rank engine | 0.274 s | 0.262 s |
| Lap engine | 1.940 s | 1.916 s |
| Segment engine | 4.809 s | 4.817 s |

These single-machine differences do not establish a material speedup. The principal new benefit is moving simulation work off the page's main thread, rather than reducing the underlying runtime.

The complete 400-sample fitting smoke run produced a held-out CRPS change of **−0.057 ± 0.060 SE** over R13–R15. Its full-data proposal changed qSd to 0.25, rSd to 0.2 and incident share to zero; each change appeared in only **one of three** folds. Do not adopt those settings on this evidence. The run demonstrates that the workflow executes and exposes instability; it is not a substitute for its 4,000-sample production run. With only three folds, a two-SE rule is also much weaker evidence than its wording may suggest.

The remaining runtime opportunities are concrete: conditional-event scoring repeatedly scans and sorts matching samples; precompute sample memberships once per event. The stochastic planner repeatedly recomputes prices and held-team Boost choices inside sample loops; precompute these where profiling shows a cost. Beam search and transfer-value calculations still run outside the simulation worker. Benchmark the full three-race planning interaction before calling the entire Calculator non-blocking. Use transferable buffers or avoid needless copies only if measured transport/memory costs justify the change.

## 6. Existing challengers and disabled features

All seven named challengers were rerun. Positive Δ CRPS is worse; ± is weekend-level SE, not a 95% interval.

| Challenger | Δ CRPS ± SE | Current decision |
|---|---:|---|
| Qualifying skew 2 | −0.0035 ± 0.0139 | Keep off; inconclusive |
| Overtake half-life 6 | +0.0062 ± 0.0273 | Keep off |
| Contextual race pace | +0.0087 ± 0.0219 | Keep off |
| Cause-based retirements | −0.0182 ± 0.0275 | Keep off; not established |
| Shared overtaking environment | +0.0189 ± 0.0171 | Keep off; assess joint risk as well as marginal scores |
| Quote-spread weighting | 0.0000 | Historical spread data absent; equality does not test efficacy |
| Eight-step market fit | +0.0438 ± 0.0321 | Do not promote |

Long-run practice also remains correctly disabled: race-position MAE **2.983** at weight zero versus **3.088** at 0.3. Lap/segment predictive experiment grids were not rerun: their mechanics were not rebuilt in this batch. Keeping them off remains consistent with the earlier evidence. Stronger market fitting still needs independent outcome validation; a residual plateau does not uniquely identify driver-specific variance as the missing mechanism.

## 7. Ordered upgrade and evidence plan

1. **Repair forecast and scoring consistency:** freeze derived circuit models correctly; unify chip scoring across Calculator and planner; give deterministic and stochastic transfer recommendations clear, consistent meanings.
2. **Repair confidence reporting:** distinguish the displayed main-run estimate from check-run gaps, inspect the actual finalists, and choose a valid stopping/confirmation procedure. Add the pinned-team and unchanged-main-estimate fixtures.
3. **Protect evaluation provenance:** put evaluation modes in cache identities, rebuild derived input data after schema changes, and attach source/configuration/input hashes to every research result. Do not overwrite prospective forecasts with reconstructions.
4. **Finish FIA and retirement data validation:** fix the real PU-ANC table case, canonical event joins, timestamped historical penalties, DSQ exclusions and DNS denominators. Report unknown/unparsed separately from zero.
5. **Correct rejection records:** replace irreproducible numbers and categorical claims with the results above; preserve each rejected proposal's code, inputs, scope and criterion for reopening it. Keep the default and challenger set stable until the evidence warrants changing them.
6. **Accumulate prospective decision evidence:** score the saved champion/challenger distributions and realistic transfer policies, including paired team differences and relevant tails. Treat weekends as the main independent unit. A repeated “five rounds and two SE” gate alone is not a guaranteed 95% test, particularly with multiple challengers and repeated reviews.
7. **Then expand data and model complexity selectively.** Target a measured error and require a reproducible predictive screen before adding another permanent parameter.

## 8. Additional data: where the next useful gains may come from

The new past-season plan is sensible as a list of weak-prior research projects, not a promise that older data will improve 2026 forecasts. I would prioritise:

- **Weather forecast vintages and their actual availability times.** Check 2024–2025 coverage before assuming all of 2023–2025 can be reconstructed. Open-Meteo documents most previous-run archives from January 2024, and its single-run archive lists ECMWF IFS HRES from March 2024. A model's initialisation time precedes public availability, often by hours; enforce availability before lock rather than only an early initialisation timestamp. Verify coverage for the exact precipitation variable/model/location used. [Previous Runs documentation](https://open-meteo.com/en/docs/previous-runs-api), [Single Runs documentation](https://open-meteo.com/en/docs/single-runs-api)
- **Matched observed session weather and event timing.** OpenF1 supplies weather, race-control and stint information. Align observations to session windows, separate SC from VSC/red flags and define “wet” consistently. These records support weather calibration and tests of event timing, with no need to begin with a larger simulator. [OpenF1 documentation](https://openf1.org/docs/)
- **Clean exposure and cause labels for retirements.** Record entries, starts, laps at risk, DNS, DSQ, late classified stops and label confidence separately. Use older seasons mainly to inform plausible hazard shapes, with partial pooling and a separate 2026 reliability level. The available local older-status archive is immediately useful for an audit of label coverage.
- **Quote quality and timestamps.** Keep accumulating bid/ask, liquidity and time-to-lock so the existing quote-quality challenger can actually be tested. More market-fitting iterations cannot substitute for better quote provenance.
- **Contextual pace uncertainty and actual tyre compounds.** Preserve stint identifiers, weather, traffic and compound specifications; evaluate prediction on withheld stints and future rounds. More laps from the same stint should not count as independent new evidence.
- **Curated technical-event validation.** Once the FIA parser is trustworthy, link a few confirmed component changes/upgrades to their subsequent measured effects and provenance. Do not regress directly on raw document counts or assume missing failures were mechanical.

Historical noise parameters should be weak, era-aware priors fitted to raw race outcomes or harmonised scoring. Neither old pace/team rankings nor old fantasy totals should be pooled blindly into the current model. The existing code/data foundation is now sufficient to improve the quality of these experiments; the main constraint is trustworthy labels and independent evaluation rather than a shortage of simulation features.

The accompanying evidence file retains the original third-round evidence and adds this update's fixtures, comparisons, fit logs, parser results and source-integrity checks.
