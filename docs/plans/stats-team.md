# The stats team: a season played by the numbers (2026-10-12)

User, 2026-10-12: test from R1 Australia, with the budget carried, transfers and chips as a real player has them,
choosing when and where to play each chip, and compare with the real top 10 / top 100. "We can call this a stats
team." Code: `backtest/stats_team.js` (`npm run stats-team`), results in `history/<season>/stats-team.json`.

## How it plays

Each round, on the data as it stood before that round's lock (walk.js `asOf`: results and scoring lines, prices,
practice, the Kalshi market at lock, the rain forecast at lock, stewards' penalties published before lock):

1. The next three races simulated with the shipped engine (`Engine.forecastRaces`), every asset's price path over
   them with the game's price rule (`Engine.pricePath`, 493 / 495 real changes).
2. The page's race-by-race planner (`Engine.planHorizon`, plans valued over the simulated futures: a later transfer
   made only where it still fits the budget) from the team held, with its budget and free transfers, once without
   a chip and once with each chip still in hand.
3. The budget policy sets how much an expected price rise is worth (the Calculator's xΔ$Pts: points per $1m per race
   left); the chip policy decides which chip, if any, the round gets, from each chip's projected gain.
4. Final Fix is decided after qualifying (and on a sprint weekend the sprint): the round re-simulated with the real
   orders, the best single swap within the budget by projected race points.
5. Scored with hindsight.js's rebuild of F1's official round score (checked against real scores), on the real
   points; then the real price changes of the team held move the budget.

Rules carried (hindsight.js, the game's 2026 rules): $100m at R1; 2 free transfers a race, one unused carries (3 max),
none carried out of a Wildcard or Limitless round; −10 for each extra; Boost 2x on one driver; six chips once each,
one a round: Wildcard (unlimited transfers within the budget), Limitless (from R2: no budget, unlimited transfers,
the team reverts after the race), Extra DRS / X3 (one driver 3x), No Negative (negative events floored at 0),
Autopilot (the Boost goes to the team's top scorer), Final Fix (one driver swapped after qualifying, for the race);
−25 (−35 on a sprint weekend) for an asset no longer in the game.

## What real players do (research, 2026-10-12)

* **The real 2026 top 100** (their own line-up CSV at R14, `data/elite_top100.json`): Limitless 100% of them, at R3
  (70), R4 (18), R2 (10); X3 99%, at R2 (67, a sprint) and R13 (26); No Negative 94%, R14 (47), R5 (23), R4 (14);
  Final Fix 53%, mostly R11 (34); Autopilot 57%, R12 (21), R10 (17), R1 (14); Wildcard 47%, R4-R5. **They spend
  their chips early**: by R14 all but Wildcard, Final Fix and Autopilot are gone for nearly all of them.
* The 2024 global champion (FanAmp interview): built the game's biggest budget (+$40m) and expected it to pay late;
  four budget drivers who still gain value, a second premium driver only later; Limitless early on a low-overtake
  track; X3 on a strong team's weekend or a non-favourite's likely win; plans differentials a week ahead and uses
  three transfers at once, with an exit plan; avoids unreliable (DNF-prone) cars.
* Another top player (FanAmp): Limitless early on a low-overtake, dry track, else a sprint weekend; Final Fix for a
  top driver who qualifies badly through no fault of his own or takes a late penalty; chips held for late
  information rather than forced; the highest-EV team, not a contrarian one.
* General guides (Motorsport Magazine, FanAmp): X3 on sprint weekends (more scoring events) or a top driver starting
  at the back; Wildcard when the order changes a lot; roll a transfer to have three for a big move.

Sources: [FanAmp, the 2024 champion](https://www.fanamp.com/f1-news/catching-up-with-2024-global-league-champion-leapsfrog),
[FanAmp, porschef1](https://fanamp.com/f1-news/tips-from-the-top-an-exclusive-interview-with-porschef1),
[Motorsport Magazine, chips](https://www.motorsportmagazine.com/articles/single-seaters/f1/f1-fantasy-chips-what-they-are-and-when-to-use-them/),
[FanAmp, X3](https://fanamp.com/f1-news/3x-extra-drs-boost-chip-explained),
[FanAmp, Wildcard](https://fanamp.com/f1-news/wildcard-chip-explained),
[FanAmp, budgets](https://www.fanamp.com/f1-news/f1-fantasy-budgets-explained-2024).

## Strategies

Budget policies (points per $1m of expected price rise, per race left):

* `points`: 0 all season (max points from the start).
* `budget`: 1 all season (the Calculator's default xΔ$Pts weight).
* `budget-r8`: 1 until R8, then 0.
* `budget-afford`: 1 until the budget buys the best team on projected points with no budget limit (the user's "4A /
  3.5A line-up": e.g. a B-priced driver performing at A level), then 0.

Chip policies:

* `consensus`: the rounds most of the real top 100 played each chip (X3 R2, Limitless R3, Wildcard R5, Final Fix
  R11, Autopilot R12, No Negative R14). The team still decides its own line-up.
* `record`: a chip when its projected gain is the best it has been so far and clears a floor (hand-set: Limitless
  40, X3 20, Wildcard 15, Final Fix 12, No Negative 6, Autopilot 6 points); chips left with as many races left are
  played anyway.
* `early`: each chip the first round its projected gain clears its floor (as the top 100 did).
* `none`: no chips (the floor for what chips add).

## Results, second run (2026-10-12: tier targets, expected-value chips, the naive player, hindsight)

Added (user, 2026-10-12): budget targets by A-tier counts (`budget-4A` / `budget-3A`: build until the budget buys the
best projected team with exactly 4 / 3 assets at $18.5m and up; counted over drivers AND constructors, since 3-4 A
drivers cost $152-187m, out of any 2026 budget), chips by expected value (`ev`: when a chip's gain beats the
expected best over the races left, worked back over the real calendar), the naive player (`naive:`: the same planner
on season averages), the meta builds as structures (`meta/`: 2A drivers + 1A constructor -> 1A + 2A ("3.5A" with a
B driver scoring like an A) -> 2A + 2A; `meta-alt/`: from 1A + 2A), and **hindsight** (`oracle:`: told the real
points and price changes of the next three races, the best chip calendar found exactly from each chip's real gain
per round: the most the season gave, an upper benchmark rather than a strategy, and not a proven optimum since it
looks three races ahead).

Played on the model (prospective), best first:

| Strategy | Total R17 | vs top 100 | Notes |
|---|---|---|---|
| budget to 3.5A / chips early | **4640** | −219 | switched to points at R16 |
| budget / chips early | 4597 | −262 | (budget to 4A: the same, 4A never affordable) |
| meta build / chips early | 4560 | −299 | the meta's structures cost ~40 on the model |
| budget / chips expected value | 4521 | −338 | Limitless only at R17; Wildcard held (worth ~1) |
| budget / top 100's chip rounds | 4500 | −359 | |
| **season average** budget / chips early | 4485 | −374 | the model is worth +112 over it with budget building |
| points / chips early | 4274 | −585 | (season average with points only: 4358, ahead of the model) |

**What the season allowed, in hindsight** (the real top 100: 4859, #1 4994):

| Strategy | Total R17 | Chips |
|---|---|---|
| free structure, budget weight 1 | **5985** | Wildcard R2, Limitless R4, No Negative R5, Final Fix R6, X3 R13 Monza |
| free, budget weight ½ / 0 / 2 | 5975 / 5966 / 5949 | the same rounds: the weight hardly matters in hindsight |
| meta build 2D1C → 1D2C → 2D2C | 5878 | |
| 1D2C all season | 5733 | |
| meta from 1D2C | 5712 | |
| 2D1C all season | 5593 | |
| free, no chips | 5576 | the chips are worth ~410 timed perfectly |
| 2D2C as soon as possible | 5339 | |

The hindsight-best team's structure: 1D1C at R1 (Verstappen + Haas, Mercedes and five cheap drivers), 1D2C R2-R3
(Antonelli, Ferrari + Mercedes, Wildcard at R2), Limitless R4 (Miami sprint, 499 pts), 2D1C R5-R6, **1D2C with
Hadjar as the B-priced "semi-A" R7-R10**, **2D2C from R11** (budget $129m) to the end ($145m at R17). That is the
meta's path, with the 2D1C step after Limitless instead of at the start: the meta build in hindsight scores 5878,
107 below the free optimum, most of it at R1 and R5-R6. Autopilot is worth nothing with perfect knowledge (the Boost
already sits on the right driver): in real play it is insurance. Four −10 hits were worth taking.

## Results, first run (2026-10-12, R1-R17, 3,000 sims a race, commit after 1927ab0)

Real players after R17 (global leaderboard): #1 4994, top-10 average 4945, top-100 4859, top-500 4780 (cut-off 4722).

| Strategy (budget / chips) | Total | vs top 100 | vs top 10 | Chips | Budget R17 |
|---|---|---|---|---|---|
| budget / early | **4597** | −262 | −348 | No Negative R2, X3 R3, Limitless R4, Wildcard R5, Autopilot R9, Final Fix R15 | $136.1m |
| budget-r8 / early | 4510 | −349 | −435 | the same, Autopilot R10, Final Fix unused | $131.1m |
| budget / consensus | 4500 | −359 | −445 | the top 100's rounds | $131.7m |
| budget / record | 4361 | −498 | −584 | Limitless, X3, Wildcard never played | $131.8m |
| budget / none | 4348 | −511 | −597 | none | $132.5m |
| points / early | 4274 | −585 | −671 | No Negative R2, X3 R3, Limitless R4, ... | $123.0m |
| points / consensus | 4185 | −674 | −760 | the top 100's rounds | $123.2m |
| points / none | 3987 | −872 | −958 | none | $123.0m |

(`budget-afford` played exactly as `budget`: the best team on projected points with no budget limit always cost
more than the budget reached, so it never switched. A softer target, the "3.5A" line-up, is the next variant.)

* **Budget building wins**: +323 over max points from the start (4597 vs 4274, same chip policy), +$13m of team
  value at R17. The planner's xΔ$Pts weight 1 decays by itself as the races left run out.
* **Chips early**: playing each chip the first round its projected gain clears its floor beats the top 100's own
  calendar by ~100 and waiting for a "record" gain by ~240 (that policy never played Limitless, X3 or Wildcard).
  Chips add ~250 in total (4597 vs 4348).
* **Where the gap to the top 100 is** (budget / early, round points vs the R14 top 100's average): R1 +13, R2-R3
  −88 (their X3 on the R2 sprint, Limitless R3), R4 +115 (our Limitless), R13 Monza **−179** (the top 100 scored
  413: 11.7 race overtakes a driver, our projection ran far too low: plan lever L1), R12 −38; the other rounds
  within ±12. R15-R17 (snapshot differences): 256 / 298 / 316 for the top 100 vs 236 / 290 / 304.

Caveats: one season; 16 strategies compared on it (the best one is flattered by being picked); R1-R14 projections
are today's engine on the data as it stood (walk.js), not what a site showed then; the top 100's R1-R14 path is the
R14 top 100's (survivors), their R14 and R17 totals are exact; Final Fix is modelled as a one-race swap; the chip
floors are hand-set.
