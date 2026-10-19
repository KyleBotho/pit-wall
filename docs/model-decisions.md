# Fantasy Pit Wall: model decisions

Moved out of CLAUDE.md on 2026-10-19. Backtested: keep unless new evidence. `npm run backtest` reproduces the evidence.

Model rework 2026-09-24/25 (user asked for a sim review, scored 7/10, then "implement all the improvements, including
the additional data sources", plus his own idea: circuit priors carry a SEASON TREND, restarted every season).
- The gate is backtest section 6: walk-forward R5-R14, exact CRPS of projected points (plus MAE, coverage, team pick).
  Paired against the previous engine (git 8c14f43) at 10,000 sims: ΔCRPS +0.02 ± 0.11, ΔMAE +0.08 ± 0.16 — a TIE on
  points within noise; better on race positions (race MAE 2.91 vs 3.05 places, from lap-time pace); qualifying about
  the same (1.737 vs 1.735). The rework's value is structure (correlated team form, SC, rain, market, uncertainty,
  penalties, known grid) and features, not a measured points gain yet. 10 rounds can't separate ±0.1.
- Section 6 now (2026-09-27, R5-R15, third review: only forecasts issued before lock, stewards' penalties published
  before lock): CRPS 8.674, MAE 11.86 (drivers 10.36, constructors 14.87), bias +1.12 (the overtake level forecast,
  see Overtakes), rank corr 0.73, 81% / 53% inside the 10-90% / 25-75% ranges; baselines: season average 13.44,
  recent form 13.84. Before review batch 1: CRPS 8.76, MAE 12.13, 85% / 56%.
- Recent-form blend: default 0 (was 0.3; +30% form is worse on every metric). State schema 4 resets it.
- Pace: % off the fastest. Qualifying from Jolpica Q1-Q3 times (per-session gap to that session's fastest, averaged);
  race from OpenF1 median clean race lap (fallback: finishing rank x 0.1%). Team-mate prior 1.5 races, gaps capped at
  4%, then shrunk 0.8 towards the field median (fitted). Nudges in places convert with the field's %/place.
- Sim (fitted by `npm run fit`, exact CRPS, one pass): qualifying noise 0.2%, race 0.15%, team weekend form 0.1%,
  driver weekend form 0.08%, grid slot cost 0.07% (scaled by the circuit's grid-finish correlation), pace/reliability
  redraw x1, incidents 15% of retirements, SC noise x1.35. Hand-set: rain noise x1.6 / retirements x1.4, SC per
  retirement 0.15, sprint scalings. Many of these sit on a flat optimum (differences < noise).
- Market (Kalshi win/podium/top-10/pole, next race only): pace moved in log-odds towards the market at weight 0.5
  (0.25-0.5 tie on CRPS; 0.5 best MAE; 0 best CRPS by 0.05 in one run — noise level). R5-R14 odds at lock rebuilt.
- Practice: short-run 50% into qualifying pace (0.6 ties), pull cap 0.8%; long-run 0 (race pace from laps beats it).
- Overtakes: Poisson regression on log(1 + |places moved|) and grid slot with the round's level as offset, plus each
  driver's skill (shrunk, 12 pseudo-overtakes). In 2026 overtakes track places MOVED, not net places gained (swaps).
  Retired cars keep the ones made before stopping (2026-09-27): own intercept, exposure phi + (1 - phi) x share of the
  race run (phi 0.35 fitted: the start counts), share drawn from this season's retirements; non-starters none. The
  sim now hits the circuit's level; the level forecast itself runs high (+0.54 per driver R5-R15, early rounds had
  more overtaking), within noise.
  Sprint share of race overtakes swings 0.17-0.92 between sprints: measured, shrunk to 0.4 with 3 pseudo-sprints.
- Weather (2026-09-27): wet sessions from a Gaussian copula, rho from the ECMWF ensemble (else SIM.rainCorr 0.3,
  hand-set; independent sessions were +0.015 CRPS). Negative rho (sessions pulling apart) is sampled too, since
  the second review (Cholesky, to -0.5). Pit: band points resampled per team, the +5 fastest stop to
  one team a race (SIM.pitBonus). The Calculator's races share each sample's car strength (opt.persist).
- Pit points: resample the team's own pit scoring lines (R FP/FP2) over the last 8 races. OpenF1 stop times match
  the official bands only 42/62 team-races (rounded, not DHL timing), so they're archived but not used.
- Track (section 2, leave-one-round-out): circuit history is barely predictive in 2026 (rank corr −0.2..0.2 with this
  season's per-circuit overtakes, grid influence, SC). Fitted weights of each circuit's own history (TRACK.alpha):
  retirements 1 (+7% vs flat), overtakes/SC/grid influence 0 (history made them worse). History still sets the level
  before a season has rounds (trend shrink 3 pseudo-rounds) and the rain climatology. Trend this season vs the same
  circuits: position changes x0.95, retirements x1.52, SC x1.14, grid-finish corr +0.04. Re-run section 2 each
  season: the new-regs effect may fade.
- Overtake level of the next race (2026-09-25, item 9 stage 2): from its practice average speed (TRACK.speed, see
  the to-do list). A race without practice yet (the next one before FP1, the planner's later races): since
  2026-10-07 the same rule on the circuit's past qualifying lap scaled to this season (TRACK.speedPrior; a circuit
  with no history keeps the flat season level). Walk-forward R5-R15 with practice withheld: CRPS 8.844 -> 8.643
  (-0.20 +/- 0.13; Monza, Silverstone, Zandvoort, Monaco gain, Austria loses a little), MAE 12.27 -> 11.86; at lock
  unchanged (practice wins). Found comparing an outside sim (docs/history.md 2026-10-07).
- Price rule: average over the races in the last three rounds, a round sat out isn't a zero (`Engine.priceBase`):
  493/495 (the two misses: R8, likely points corrected after prices). Unchanged: DNF team rate shrink k=16 no recency
  (log loss 0.4608), official scoring.
- Tried and rejected 2026-09-25 (section 9): skewed session noise, car + driver-offset team-mates, the fastest-lap
  market. All ties or worse; see the to-do list Also the lap-by-lap and timing-segment races
  (item 9 stages 3a/3b, SIM.raceModel): ties on points, worse on race positions.
- Known gaps (section 5, 2026-09-27): places lost too few (−0.23 vs −0.56), fastest lap / DotD slightly too spread
  (87% / 91% to the top seven vs 100% / 93%). Overtakes at a neutral track now match (4.67 vs 4.70).
- Default 10,000 sims per race × next 3 races (~1 s in the browser). Optimiser enumerates all teams; `planHorizon`
  beam-searches race-by-race plans (~0.5 s); goals "beat a rival / the top-100 template" re-rank by P(beat).
- vs rhter's Baku sim (f1fantasytools, old engine): MAE 4.6; we're higher on Alpine/midfield, lower on Ferrari.
