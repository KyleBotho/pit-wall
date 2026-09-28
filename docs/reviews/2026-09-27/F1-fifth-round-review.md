# F1 Fantasy simulation — fifth review

28 September 2026 · Overall assessment: **7.9/10**

The previous fixes are substantially implemented and tested. The numerical engine is strong, and completing the FIA penalty history has improved the historical forecasts. The remaining gap to an unqualified professional assessment is mainly trustworthy evaluation and data handling, rather than a need for more elaborate simulation.

The unchanged score does **not** mean that the fixes accomplished nothing. The frozen-input, chip-scoring and sequential-check defects are resolved. However, there is still only **one completed weekend with a genuinely frozen forecast**, and the new challengers introduce data-quality and evaluation problems. Neither demonstrates a reliable predictive improvement yet. This is a judgment of the complete forecasting and decision system, not an arithmetic average of code-quality marks.

## Scope and evidence

Reviewed commit **5dd97ecf2a312651d1e634e27d603b10c4cf11c9**, plus the four uncommitted files present at capture: `engine.js`, `refresh.py`, `web/js/lab.js`, `web/js/worker.js`. These contain the unfinished separate Sim Lab payload work. Findings about it are marked **in progress**, not presented as defects in an already released feature.

All code references below are within `C:\Claude memory\F1 Fantasy`. A separate review snapshot and input hashes were retained. No source/input changes were detected between capture and the later integrity check. Application code and original archives were not edited.

Verification included:

- Lint, formatting and type checks; **104 JavaScript tests and 61 Python tests passed**.
- Three-seed, 3,000-simulation walk-forward evaluations over R5–R15: current/previous engines on matching inputs, all nine registered challengers, and checks with and without the newly archived challenger inputs.
- Independent numerical, frozen-input, Autopilot, adaptive-check, loader-failure and quality-revocation fixtures.
- Historical price, retirement, practice, calibration, frozen-forecast and pit-stop checks.
- A smaller one-seed, 1,000-simulation screen of the optional lap and segment engines; matched runtime measurements.

The copied workspace could not run esbuild because of a Windows directory-access restriction. The full application suites were therefore run successfully at the original repository path, whose files matched the captured snapshot. This was an environment limitation, not a product failure. Browser loading findings below use source inspection and deterministic loader fixtures; a live browser/deployment test was not performed.

## 1. Previous findings: what is now fixed

| Previous issue | Current finding |
|---|---|
| Live practice leaking into the derived track model for an at-lock forecast | **Fixed on the reviewed engine, worker and presimulation paths.** Changing live practice after lock leaves the frozen simulation samples identical. |
| Autopilot scored as a fixed Boost by the stochastic planner | **Fixed.** The public planner now returns **200**, rather than 150, for the alternating-driver fixture. The shared chip scorer also covers the other chips; Limitless uses the team actually played. |
| Check-run size incorrectly shrinking the displayed main-run uncertainty | **Fixed.** The main estimate's standard error stays at 1.0 in the fixture when the independent check grows from 10,000 to 50,000 samples. |
| Pinned teams suppressing adaptive growth | **Fixed.** Six pins no longer prevent growth when the leading candidates remain unresolved. |
| Repeated checks using an unadjusted 2-SE threshold | **Substantially fixed.** The five-look threshold is 2.5758 SE. Across 100,000 Gaussian null paths, false separation falls from **13.037% to 3.351%** for one prespecified pair. This is not a simultaneous guarantee over every candidate team. |
| Weather sensitivity mode sharing the standard accuracy identity/output | **Fixed.** Different cache keys and separate `accuracy.json` / `accuracy-wxlatest.json` outputs verified. |
| FIA PU-ANC table parsing and Barcelona event lookup | **Fixed in the reviewed paths**, including real-document regression tests. |
| Historical stewards' decisions unread | **Backfill completed:** 244 candidate decisions read, with 26 nonzero parsed grid penalties. Reading a document is not itself proof that its penalty was assigned to the correct future event. |
| DSQ included in retirement research | **Fixed in the reviewed retirement parser and tested.** |
| Overstated conclusions about pooled pace and stint uncertainty | The model comments and later decision record now distinguish inconclusive evidence from rejection, and describe the uncertainty inflation factor as provisional rather than genuinely held-out. |

## 2. Forecast results and what they establish

### Default model

| Measure | Current result |
|---|---:|
| Standard repository evaluation, CRPS | **8.586** |
| Standard evaluation, MAE | **11.797 points** |
| Three-seed mean CRPS | **8.60485** |
| Three-seed mean MAE | **11.84053 points** |
| Three-seed bias | **+1.13693 points** |
| Coverage of nominal 80% interval | **80.62%** |
| Coverage of nominal 50% interval | **52.89%** |
| Completed genuinely frozen evaluation | **R15 only: MAE 14.82, rank correlation 0.567** |

Compared with the prior review's matched three-seed CRPS of 8.68599, the present result improves by approximately **0.0811, or 0.93%**. The previous engine rerun on the **current inputs** also scores exactly 8.60485. Therefore, this improvement is attributable to the changed evaluation inputs—principally the completed penalty history—not a new default simulation algorithm.

Aggregate coverage is encouraging, but 363 asset observations are not 363 independent race weekends: there are only 11 weekends, with correlated drivers and constructors. One wet weekend and three sprint weekends cannot establish reliable subgroup calibration. Wet-event Brier score remains **0.160 versus 0.099** for the historical-rate reference; SC Brier score is **0.276 versus 0.308**. These are small-sample diagnostics, not grounds for immediately tuning to the observed frequencies.

Decision quality also needs its own evidence. In the standard replay, removing the market worsens CRPS from 8.586 to 8.691 but increases the fresh-team points measure from 2,042 to 2,126. That noisy result does not justify removing the market; it demonstrates why better marginal forecasts cannot be assumed to produce better transfer/chip policies. The fresh-team measure is not a full-season budget-constrained policy evaluation.

### All registered challengers

These runs use the current archived race records and circuit priors, with the remaining inputs held fixed. Positive ΔCRPS is worse. **± means one standard error across paired weekend differences**, after averaging three seeds; it is not a 95% interval. These retrospective comparisons remain exploratory after repeated research on the same weekends.

| Challenger | ΔCRPS ± SE | Assessment |
|---|---:|---|
| Qualifying skew `qskew2` | −0.00176 ± 0.01383 | No demonstrated benefit |
| Recent overtaking level `ovhl6` | +0.00856 ± 0.02974 | No demonstrated benefit |
| Contextual race pace `racectx` | +0.00378 ± 0.02621 | Keep as a challenger |
| Pooled contextual pace `racepool` | +0.00759 ± 0.02424 | Keep as a challenger, repair quality revocation |
| Timed safety car `sctimed` | +0.01598 ± 0.01168 | Repair inputs/evaluation before interpreting further |
| Cause-based retirements `dnfcauses` | −0.01841 ± 0.02835 | Promising direction, insufficient evidence and imperfect cause labels |
| Shared overtaking environment `ovenv` | +0.00643 ± 0.01291 | No established marginal-score benefit; assess joint risk too |
| Quote-quality weighting `oddsq` | 0.00000 | Historical inputs do not activate a meaningful difference; **untested**, not disproven |
| Stronger market weight `odds8` | +0.00643 ± 0.03155 | No demonstrated benefit |

Pooled versus unpooled contextual pace is **+0.00380 ± 0.01258** on these inputs. The earlier negative screen and this small positive screen are both consistent with an unresolved effect. Building a shadow challenger was the right response to the earlier premature “duplicate” conclusion.

The timed-SC result differs from the recorded single-run +0.038 ± 0.018. Different seeds and refreshed inputs matter at this scale; neither estimate supports promotion.

## 3. Actionable findings, in priority order

### 1. Carry grid penalties across events, with an explicit target

**Priority: medium; affects the default forecast when a carry-forward penalty applies.**

`collect.py:204` reduces a decision to a number, discarding whether it applies to this race, a sprint, or the next race in which the driver participates. `backtest/walk.js:111` searches only the current event's FIA index; the live collector also aggregates that event's documents.

The fixture returns `3` for both “this race” and “the next race in which the driver participates.” A penalty issued during the previous weekend can consequently disappear from the next weekend's forecast. Conversely, knowing a penalty before lock does not prove it applies to that event. The project history already acknowledges this gap.

**Change:** retain driver identity, issue time, target event/session or participation condition, served status and source document. Resolve pending decisions across events and deduplicate documents. Test a next-event penalty, a missed event, a sprint-only penalty and a superseding decision. Do not simply sum every previous-event penalty. This review establishes the structural defect; it does not claim a measured current-season points loss from it.

### 2. Fix the timed-SC parser's red-flag state

**Priority: medium; new challenger only.** `laps.py:94–107`.

An SC deployment is accepted only if the preceding SC has an “in this lap” message. A red flag leaves that SC open, so later deployments are ignored or merged into it.

This occurs in real cached data:

- **Australia 2023:** deployments on laps 1, 7 and 54 become only `[1,3]` and `[7,null]`. The model uses lap **7/58**, rather than **54/58**, for the last-SC onset.
- **São Paulo 2024:** deployments at laps 30 and 39 become one interval `[30,42]`, rather than two separate events interrupted by a red flag.

**Change:** model SC/VSC/red/restart state explicitly. Preserve an unknown or red-terminated end separately from whether another deployment can start. Reparse existing race and prior records, then refit the onset relationship. Merely fixing the parser will not update fields already populated by the one-time backfill.

I checked this season's archived race/sprint `lapsRun` against the available classification lap counts and found no discrepancies. Deriving historic race length from the last race-control message still deserves a fallback/validation rule; it is a potential weakness, not a demonstrated current-season error.

### 3. Invalidate pooled pace when its source fails validation

**Priority: medium; new `racepool` challenger only.** `laps.py:270–290`, `laps.py:512–536`, `engine.js:1197–1217`.

When FastF1 reconciliation fails, the code removes `paceCtx` and `paceSe`, but leaves `pacePool`. The pooling pass skips the rejected lap record and never removes the old pooled estimate. The engine then consumes that stale estimate, with **weight 1** because its standard error is missing.

Independent fixture: a previously pooled pace of **0.9%** survives a failed cross-source check; the valid median fallback is **0.1%**, but the engine still returns 0.9% at full weight. The fixture uses the real reconciliation and pooling functions, with a stub supplying the failed validation result. This is a reproducible failure path, not a claim that today's archive already contains such a rejected row.

**Change:** revoke all derived pace fields when source quality is revoked or a refit becomes ineligible. Also make the engine reject explicitly failed-quality contextual records. Persist input/fit versions and an appropriate uncertainty estimate for pooled pace. Test “previously valid → invalid,” not only “adding a later valid race leaves earlier estimates unchanged.”

### 4. Separate a timing experiment from a variance change and a retrospectively fitted effect

**Priority: medium; research validity.** `engine.js:90–98`, `1045–1055`, `2414–2420`, `2487–2505`; `docs/history.md:8–18`.

Two issues need explicit treatment:

**Evaluation leakage:** the fixed coefficients −0.146 and 1.258 were fitted to 31 dry SC races spanning **2023–2026**, including races used by the 2026 walk-forward evaluation. Restricting the onset distribution to earlier races does not make those fixed fitted coefficients out-of-sample. Refit inside each training fold, use a pre-2026 fit, or label the entire retrospective comparison exploratory and judge the fixed version prospectively. Correct the parser before refitting.

**Moment preservation:** normalising timing weights to have mean one preserves the average *noise multiplier*, not its variance effect. With the 41 available SC onsets:

- Mean noise multiplier: **1.35**, equal to the untimed setting.
- Mean squared multiplier: **1.96096**, versus **1.82250** untimed.
- The conditional noise-variance factor therefore increases by **7.60%**.

This is not automatically an undesirable model, but it is not a clean test of timing alone. For a variance-preserving experiment, normalise the squared multiplier, or fit the overall scale separately within training data. That 7.60% refers to this noise component conditional on SC, not total fantasy-score variance.

The onset pool also mixes tracks and wet/dry races, and full-race onsets can be used for sprint simulations. Last-SC onset and mean absolute grid-to-finish movement do not identify duration, pit opportunity or a causal SC effect. Start with a modest, clearly labelled model rather than interpreting these coefficients as physically established.

### 5. Complete the separate Lab payload's lifecycle

**Priority: medium; explicitly in progress.** `web/js/lab.js:111–165`, `844–874`.

The payload split is sensible, but:

- A failed fetch resolves to null and remains cached forever. Two attempts in the failure fixture produce only **one fetch**, with no health data or retry.
- The usual owner path starts loading before `renderLab`; that render attaches a completion redraw only when loading has **not** started. Health can stay at “Loading…” until another action redraws it.
- `labRerun` does not await readiness. A run requested with challenger-only settings before the payload arrives can use missing-input fallbacks; merging the payload does not automatically invalidate that completed run.

The current visible switch list does not yet expose `racePace` or `scTimed`. Thus the misleading challenger-run path is relevant to persisted/programmatic settings and future controls; the failed health-load path is already directly reachable.

**Change:** use explicit idle/loading/ready/error state, always redraw on completion, offer retry, and require the relevant inputs before running a challenger. Include a payload version in run identity and discard stale responses. Test slow success, failure/retry, a run requested during loading and a deployment changing the payload filename.

### 6. Make challenger readiness and provenance observable

**Priority: medium; evaluation workflow.** `tests/helpers.js:14`, `backtest/walk.js:10`, `engine.js:4151–4165`.

The cached dataset is dated **2026-09-27 14:24 UTC**. It contains zero pooled-pace records, zero timing records and zero prior timing rows. The newer archives contain **15 pooled race records, 15 timed race records and 70 timed prior rows**. With the cache unchanged, both `racepool` and `sctimed` produce exactly the default result. My challenger table explicitly overlays the newer archives; this is a controlled reconstructed input set, not a claim that the old cache was already current.

Normal refresh does load the newer archives; the problem is that a standalone evaluation or freeze can still silently label a fallback run as a challenger. Record input availability, effective observations, fallback counts, input hashes, fit version and settings for every run. Fail or mark the result **not evaluable** when the challenger was never activated.

At capture, the provisional R16 challenger file contains `racepool` but **does not contain `sctimed`**. The registry and freeze path support it, and a subsequent pre-lock refresh can add it. “Collects from R16” is presently an intention, not a verified archived result. Preserve this distinction, and retain enough per-challenger metadata to reproduce its actual setup.

### 7. Correct the remaining confidence-summary wording

**Priority: medium; uncertainty presentation.** `web/js/calc.js:683`, `727–775`.

The headline uses the median standard error across displayed, starting and pinned teams, then describes the uncertainty of “a team's xPts.” That is not a bound for each team. In the six-constant-pins fixture, the headline margin is **zero**, although the leading team's standard error is **1.0** and its ordinary 95% margin is about **1.96 points**.

Show the selected team's own Monte Carlo error, or explicitly label a median as “typical displayed-team sampling error.” Distinguish this from predictive outcome ranges and model uncertainty. The Bonferroni improvement controls repeated looks for a prespecified pair; it does not control all comparisons or remove the optimism of a winner selected on the main sample. Use independent-check means for confirmation and a multiple-candidate procedure only if claiming a simultaneous ranking guarantee.

## 4. Mathematical integrity and runtime

**Covariance:** in an independent weighted-asset fixture, direct sample variance was **1102.857431**, matching the full covariance quadratic form within **1.4×10⁻¹²**. Summing marginal variances would give **1048.524913**. Joint samples correctly retain dependence; there is no evidence here of the earlier naive independence error. This algebraic check does not establish that every real-world dependence has been calibrated correctly.

**Distributions and randomness:** negative weather dependence produced joint wet frequency **0.1839**, against the Gaussian-copula target **0.184505**. Same seeds reproduce samples even after an intervening simulation, larger runs preserve prefixes, and an engine with ambient `Math.random` replaced by a throwing function completed the checked paths. The Poisson sampler at λ=31, over 200,000 draws, gave mean **31.0068**, variance **31.0501**, skew **0.1860**; the theoretical skew is about 0.1796. No new distribution/RNG regression was demonstrated. This is sampled verification, not a proof over every possible input.

**Boundaries/scoring:** existing floor/cap and required-points tests pass. The historical price rule still reproduces **493/495 changes**; the two R8 discrepancies remain data/rule cases to reconcile. The pit-stop diagnostic matches only **42/62** observed team-race band totals and finds **4/6** fastest-stop bonuses. Investigate coverage and scoring correspondence before treating raw stop timing as a complete scoring truth source.

**Runtime:** five measured runs per mode, after warm-up, same R15 inputs and machine; 10,000 final simulations. Setup includes the market fit and is measured separately.

| Mode | Previous engine final simulation | Current final simulation | Current setup |
|---|---:|---:|---:|
| Rank | 136 ms | **131 ms** | 133 ms |
| Lap | 846 ms | **824 ms** | 1,079 ms |
| Segment | 2,097 ms | **2,110 ms** | 2,761 ms |

There is no material new runtime regression demonstrated. Lap and segment simulation remain roughly **6× and 16×** the default final-run cost; market fitting compounds that cost. Recomputing pooled pace over 15 rounds took a median **0.098 s**, with no changed records: currently a minor cost, not the bottleneck.

Prioritise end-to-end profiling of three-race planning, candidate search, price-path evaluation and worker transport before micro-optimising the sampler. The worker moves simulations off the main thread; it does not by itself prove that beam search and transfer-value calculations are responsive. The planner still searches a restricted candidate set and does not implement fully adaptive optimal recourse after every future price outcome.

## 5. Disabled and previously rejected work

- **Pooled race pace:** now appropriately promoted from “rejected without evidence” to a shadow challenger. Keep off by default; fix stale derived values and improve its uncertainty estimate. The paired result remains inconclusive.
- **Timed safety car:** appropriate to investigate, but its current implementation needs the parser and validation repairs above. Keep it off by default. Event-conditioned coverage was never evidence that timing could not matter.
- **Distance-based retirement hazards:** continued deferral is reasonable. The corrected sample is 5 nonclassified sprint starters out of 108, versus 59/323 race starters; DNS and DSQ require separate treatment. Do not infer a zero late-race hazard from an archive restricted to unclassified finishers. Existing retirement-distance effects reduce the likely incremental gain, but do not prove it is zero.
- **Confirmed retirement causes:** automated labels remain imperfect; unknown causes should remain unknown. A manually verified subset is a useful next step. Do not equate “no named incident” with confirmed mechanical failure. The existing `dnfcauses` challenger is a proxy experiment, not validation of true cause-specific hazards.
- **Long-run practice:** keeping it disabled is supported by the rerun: race-position MAE **2.983** at zero weight versus **3.088** at weight 0.3. Short-run practice still helps; the small difference between weights 0.5 and 0.6 is not persuasive retuning evidence.
- **Lap and segment engines:** the fresh low-budget screen gives ΔCRPS **−0.035 ± 0.144** and **−0.133 ± 0.140**, respectively; MAE changes are **+0.170** and **+0.038**. These wide, one-seed results do not establish superiority or inferiority. Given their runtime cost, continued default-off status is reasonable. A larger prespecified test is needed before promotion.
- **Other previously screened switches**—car/driver separation, corner-band shifts, minisector practice and fastest-lap market weights—were inspected through their existing paths/records but their full grids were not rerun. No new evidence justifies enabling them. Keep “not selected” distinct from “proven useless.”

## 6. What would constitute 8, 9 and 10?

These are explicit review criteria, not an industry certification. A 10 does not mean predicting every crash or producing a narrow interval for an inherently uncertain race. More simulation draws or more switches do not earn a higher score on their own.

| Dimension | **8 — professional for its stated use** | **9 — independently demonstrated excellence** | **10 — exceptional, sustained standard** |
|---|---|---|---|
| Mathematical correctness | Sampling, dependence, boundaries, chip scoring and uncertainty claims are correct on supported paths; important edge cases have regression coverage. | Broad stress/property testing; independent scoring and numerical implementations cross-check key results; parameter and simulation uncertainty are distinguished. | Independent replication/audit, explicit approximation-error budgets and sustained correctness across model and rule changes. |
| Inputs and reproducibility | At-lock provenance, correct event/driver joins, quality revocation and visible fallbacks; forecasts reproducible from immutable records. | Independently cross-checked critical inputs, versioned transformations and automated drift/coverage monitoring. | End-to-end auditable lineage, quantified sensitivity to missing/misclassified inputs, and tested recovery from realistic source failures. |
| Predictive evidence | Useful performance against simple baselines on an untouched, time-ordered evaluation; calibration uncertainty stated honestly. Prospective records corroborate that historical reconstruction is representative. | Material, repeatable improvement over strong baselines, including market-informed ones, across an entire season or comparably broad independent evidence; wet/sprint/SC claims only where supported. | Sustained independent evidence across seasons and regime changes, well-calibrated central and tail forecasts, and no material unexplained weakness within the claimed scope. |
| Decisions | Legal teams, budgets, transfers and chips score consistently; recommendations remain stable within Monte Carlo tolerance. | Prospective or sealed-replay tests establish decision value, including transaction costs, chips and affordability; small problems benchmark search regret against exhaustive solutions. | Adaptive policies outperform strong alternatives with bounded/measured approximation regret and robustness to misspecification and risk preferences. |
| Research governance | Disabled features are clearly experimental, results show activation/coverage, and promotions follow a predeclared rule. | Nested/rolling validation, protected confirmation data and explicit control of repeated model selection. | A mature champion/challenger process whose claimed gains survive independent reproduction and repeated deployment cycles. |
| Operations | Ready/error/retry states work; deterministic records, checks and acceptable measured user-facing performance. | Tested failure recovery, runtime/memory budgets, rollback and alerts tied to forecast quality. | Sustained operational evidence under realistic load and degraded data, with no silent substitution of an unevaluated model. |

**Concrete route to 8:** resolve the default penalty-target and confidence-summary issues; finish the Lab lifecycle before shipping it; repair or quarantine the affected challenger results; verify challenger inputs and pre-lock archives. Then accumulate and assess untouched forecasts using a declared protocol. An initial **8–12 additional frozen weekends** is a useful checkpoint, not a magical sufficient sample. Report paired, weekend-level uncertainty against simple and market-informed baselines; extend the window if the result remains inconclusive. Limit the scope of any wet/sprint claims until those cases are adequately represented.

**Route to 9:** demonstrate that calibrated forecasts produce better realistic decisions, beyond the easy historical baselines, across a broad independent period. Validate joint team tails, price paths, chip policies and search quality. The burden shifts from “the mechanics are sound” to “the benefit repeats under difficult conditions.”

**Route to 10:** sustain and independently reproduce that standard across seasons, changing regulations, roster changes and source failures. Measure remaining uncertainty and approximation error rather than hiding it. A simpler model can earn this score if its evidence and operation are exceptional; a detailed lap simulation cannot earn it through realism alone.

## 7. Highest-value data and experiment additions

1. **Preserve untouched forecast evidence first.** Archive forecast issue time, lock time, exact inputs, active feature coverage, fit version and joint samples. Keep corrected reconstructions separate from what users actually saw. This improves the trustworthiness of every subsequent accuracy claim.
2. **Complete penalty semantics and technical-event labels.** Use the FIA documents already collected to label target sessions, pending penalties, component changes and confirmed upgrades. Validate those labels manually on a small sample before estimating their effects. Document counts are not performance estimates.
3. **Use the existing race-control history more fully.** Reconstruct SC/VSC/red/restart windows and link them to pit entry, race position and stint context. OpenF1 provides race-control messages, positions, pits and weather; the opportunity is to join and validate these records, rather than simply collect more rows. [OpenF1 documentation and endpoint overview](https://openf1.org/).
4. **Accumulate genuinely pre-lock weather ensembles and quotes.** The ensemble data can support joint session rain scenarios, but member count is not the number of independent forecast cases. Evaluate weather by issue time and lead time; keep bid/ask and liquidity histories for the quote-quality challenger. [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api).
5. **Create an exposure-based retirement dataset.** Distinguish entries, starts, laps at risk, DNS, DSQ, classified late stops and cause confidence. Use verified team/FIA evidence for a labelled subset. Older seasons can inform weak hazard-shape priors, with separate current-era reliability levels.
6. **Improve pace validation before increasing model complexity.** Retain actual compound specification, stint identity, traffic and weather; evaluate on withheld stints and future weekends. Thousands of correlated laps do not replace independent weekends. A pooled pace model should propagate its own fit uncertainty and missingness, rather than inherit a convenient standard error without validation.

No challenger should be promoted on this review's small retrospective differences. The best next investment is dependable data interpretation and prospective evaluation, followed by decision-policy validation.
