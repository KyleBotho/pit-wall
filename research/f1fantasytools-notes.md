# f1fantasytools.com: research notes

Researched 23 Sep 2026, between R14 (Spanish GP) and R15 (Azerbaijan GP, "Baku"). Read-only: no sign-in, no forms submitted, no manual teams saved. There was no cookie banner and no CAPTCHA or bot block.

Notes on method:
- The browser pane rendered screenshots too small to read, so most of this comes from the page text, the accessibility tree and opening menus and modals.
- Once, the tab turned up on github.com without me clicking anything (the script had errored before any click). I went straight back to the site and did not interact with GitHub.
- Numbers quoted below are examples from that day.

## 0. Site map and access levels

The site uses Next.js on Vercel. Tables are rendered on the server, so the page loads with the data already in it and there is no public JSON API to inspect in the network log.

| Tool | URL | Access |
|---|---|---|
| Team Calculator | /team-calculator | Free. Personal suggestions based on your own team need the **Starter** plan; rival teams need **Pro Plus** |
| Meet Rhter (methodology) | /rhter | Free |
| Budget Builder (price-change predictor) | /budget-builder | Free. Highlighting your teams needs Pro |
| Live Scoring | /live | Free for all assets and the demo "Elite" team. Live scores for your own and manual teams need Pro |
| Elite Data | /elite-data | Free |
| Statistics | /statistics | Free. Team highlighting needs Pro |
| Hindsight | /hindsight | Free. Personalised optimal transfers need Pro |
| Team Analyzer | /team-analyzer | Pro. The public demo shows the Global #1 team |
| League Analyzer | /league-analyzer | Pro. The public demo shows a "Global League" (top of the overall ranking) |
| Season Summary | /season-summary | Pro. The public demo shows the Global #1 team |
| Pricing | /pricing | Free, Starter, Pro and Pro Plus, from about €2.50/month, paid through Stripe (Patreon is being phased out) |
| FAQ + AI assistant | listed on /pricing, but /faq returns 404 | Not live yet |
| Contact, Legal, Login | /contact, /legal, /login | Login is Google or an emailed one-time code. No passwords are stored |

Features listed as "coming later" (Pro Plus): **Team Planner** and **Simulation Builder**. So even this site doesn't yet offer a multi-race planner or a way to build your own simulation. That's a gap we can fill.

Overall layout: a dark theme with a left icon sidebar for the tools. Each tool is a multi-panel dashboard (on mobile the panels become swipeable pages: Info / Best Teams / Settings / Drivers / Constructors). Assets appear as coloured team "chips" with a three-letter code, and the points and price change sit under each chip. Heatmap colouring can be switched on in most tables.

---

## 1. Team Calculator (/team-calculator)

**Question it answers:** "Given the simulated expected points for the next race, my budget, my chip and my current team, which 5 drivers + 2 constructors + DRS (x2) pick score the most?"

### Layout
There are four panels: **Best Teams** (the ranked list), **Settings**, **Drivers** table and **Constructors** table. An ad slot sits at the bottom for free users.

### Inputs and controls
- **Select a starting team** (dropdown):
  - *My Teams*: T1, T2, T3, imported from your linked F1 Fantasy account. **Starter plan.** Clicking one shows "Starter plan required. Get personal team suggestions based on your own F1 Fantasy teams."
  - *Select a Manual Team*: a modal where you pick your current 5 drivers + 2 constructors from chip buttons, including an "Inactive assets" section for drivers who have been replaced. It also takes the **Remaining budget ($M)** and **Free transfers** (dropdown 0/1/2/3, default 2), with Clear / Cancel / Save. The pricing table lists manual starting teams as Starter and above.
  - *Rival Teams* (R1, R2, plus "Manage Rivals"): **Pro Plus**.
  - A starting team switches the calculator from "best team from scratch" to "best set of transfers from my team", which accounts for free transfers and the penalty for extra ones.
- **Maximum budget ($M)**: a free-text number, prefilled with 109.4 on the day.
- **Select a chip**: toggle buttons **X3** (Extra DRS Boost), **LL** (Limitless), **WC** (Wildcard), **NN** (No Negative), **AP** (Autopilot). Final Fix isn't offered here because it is played mid-weekend. With X3 selected, the table gains an "x3" column: the x3 driver's points are tripled and the second-best driver still gets x2.
- **Convert expected price changes (xΔ$) into expected price change points (xΔ$Pts)**: a switch. Turning it on opens a modal:
  - "How many points should a 1M budget increase earn you per future race?" A **slider from 0 to 3 pts per $1M per race**.
  - The number of **remaining races** (8 by default), which you can adjust if you think a race will be cancelled or added.
  - Formula: **xΔ$Pts = xΔ$ × (pts per M per race) × remaining races**, and **xSPts (Expected Season Points) = xPts + xΔ$Pts**. The modal shows a worked example with two assets.
  - This is their "budget uplift" answer: a single number that trades points now against team value later.
- **Select a simulation preset** (dropdown):
  - *Rhter Sims*: this week's analyst simulation, labelled e.g. "Baku. Very Early.", with a last-updated time and notes such as "Dry/average conditions."
  - *Past Performance Sims*: **Classic Average**, **Weighted Average**, and **Form** (average of the last 5 races).
  - *PPM Sims*: **Equal PPM** (every asset's expected points proportional to its price, a neutral baseline).
- **Simulation version** (dropdown), which only affects the price-change assumptions:
  - Scenario A: mean(0, 0, sim)
  - Scenario B: nanmean(NaN, NaN, sim)
  - Scenario C: mean(rw10, rw11, sim)
  - Each comes with "Version notes". That week, two drivers had swapped teams, so nobody knew what earlier-race scores F1 Fantasy would use for them in the 3-race price average. Each scenario handles that differently.
- **Full Reset** button.
- **Drivers and Constructors tables:**
  - A search box that accepts several names at once ("VER+NOR").
  - An **editable xPts cell per asset** (a text box, e.g. ANT 28.6), so you can override the sim with your own view. Two small buttons next to it (probably nudge or reset).
  - **Incl / Excl checkboxes** to force an asset in or out (locks and bans).
  - Clicking an asset chip opens a **"Points breakdown" modal**: current price, xΔ$, xPts and "Extra simulation info" (DNF %, FL %, DOTD %, xOV = expected overtakes, xNP = expected negative points). Example: ANT had DNF 8.8 %, FL 22.8 %, DOTD 17.9 %, xOV 4.31, xNP −3.56.
  - Column picker for **Drivers**: DR, Current Price ($), Expected Price Change (xΔ$), Expected Points for next race (xPts), **Expected Points per Million (xPts/$)**, Force Include/Exclude, DNF %, FL %, DOTD %, xOV, xNP.
  - Column picker for **Constructors**: CR, $, xΔ$, xPts, xPts/$, Incl/Excl, **Fastest Pitstop Exp. Points (FP xPts)**, xNP.
- **Best Teams panel:**
  - **Filters**: "Apply Filters", with a note that filters can slow things down. You add rules on these properties: Total Cost ($), xPts, xΔ$, DNF %, FL %, DOTD %, xOV, xNP, FP xPts. For example, "team DNF exposure < X" or "xΔ$ > 0.5".
  - **Columns**: Rank (#), Constructors (CR), x2 Driver, Drivers (DR), Total Cost ($), xPts/xΔ$, DNF %, FL %, DOTD %, xOV, xNP, FP xPts.
  - Each row has a **team actions** menu with **Pin team** (keeps it at the top for comparison) and **Copy team as text**.
  - **Load more teams** shows 20 at a time.

### Outputs
- A ranked list of teams. Default columns are **# | CR | x2 | DR | $ | xPts / xΔ$**.
- Each asset appears with its points for this team; the x2 driver's figure is already doubled (ANT 57.2 = 28.6 × 2) and its xΔ$ is shown underneath.
- Sorted by **total xPts**, or by xSPts when conversion is on. Headers can be clicked to re-sort.
- Example top team: MER + FER; ANT x2; LIN, HUL, BEA, STR. Cost $109.4M, xPts 198.7, xΔ$ +0.87.

### Methodology: Rhter's model (from /rhter)
- Each driver has **qualifying pace (Qpace)**, **race pace (Rpace)**, a **DNF probability**, a **fastest-lap probability** and a **grid penalty**. There are also subjective inputs: **team-order probability** and DNQ estimates when grid penalties are known.
- **Qpace** is a weighted mix of previous qualifying results **and FP1/FP2/FP3 results**.
- **Rpace** is derived from Qpace plus a typical overtake count. Confirmed grid penalties lower Rpace according to how hard it is to overtake at the track.
- Each driver gets a mean and standard deviation. These are sampled Monte-Carlo style, **typically N = 10,000 runs**. DNFs and team orders are sampled inside each run. Fastest lap combines Rpace with in-season fastest-lap history.
- Every run is scored with the official F1 Fantasy rules, and the calculator uses the averages.
- On Discord they post **violin plots** (distributions per driver) and summary tables. The dashboards show predictions per driver and constructor and the optimal teams at three budget levels.
- Planned improvements: weighting results by **track similarity** and estimating **car characteristics per track layout**.
- Sims are re-run through the weekend ("Very Early", then after FP sessions and so on), and each one is labelled with a timestamp.

---

## 2. Budget Builder (/budget-builder): the price-change predictor

**Question it answers:** "Which assets will rise or fall in price after the next race, how likely is each outcome, and how many points does an asset need to score to reach each step?"

### Inputs and controls
- **Data-view dropdown:**
  - *Basic Data*
  - *Required Points*
  - *Required Points per Million (PPM)*
  - *Rhter Simulation Odds*, with one entry per sim version (Scenario A/B/C)
- **T1 / T2 / T3** buttons to highlight your own teams (subscriber feature).
- Driver and constructor search boxes.
- **Display options:** show points from the previous 2 races; show the sim's expected points; show required points next to the odds.
- A warning banner about the data problem from the driver swap. The previous-race scores in the table **can be edited by clicking them**.

### Outputs
- Separate tables for drivers and constructors, each split into **Tier A (≥ $18.5M)** and **Tier B (< $18.5M)**.
- Columns: `DR/CR | $ | R13 Pts | R14 Pts | R15 xPts | odds for each price step | R15 x∆$`.
  - Tier A steps: −0.3, −0.1, +0.1, +0.3.
  - Tier B steps: −0.6, −0.2, 0.0, +0.2, +0.6. The 0.0 column shows up for assets at the $3M floor; for them the −0.6 cell is blank because it can't happen.
- Example rows:
  - VER: 0 % / 9 % / 38 % / 53 %, so x∆$ = +0.19.
  - ANT: 99 % chance of +0.3.
- x∆$ is the expected price change weighted by probability. The same number feeds the Team Calculator.

### Methodology (their "About Budget Builder" modal, in my words)
1. AvgPPM = (average fantasy points over the **last 3 races**) ÷ current price, **rounded to 3 decimal places**. Fewer races are used early in the season.
2. Bands:
   - below 0.605 = terrible
   - 0.605 to 0.9 = poor
   - 0.9 to 1.195 = good
   - 1.195 and above = great
3. Price change by tier:
   - Tier A (≥ 18.5M): −0.3 / −0.1 / +0.1 / +0.3
   - Tier B (< 18.5M): −0.6 / −0.2 / +0.2 / +0.6
4. Prices are **clamped between $3M and $34M**, and the Required Points calculation takes those limits into account.
5. **Required Points** = the score needed in the next race to land in each band. For example, "NOR needs more than −23 to rise 0.3M". Required PPM is the same figure relative to price.
6. With an analyst sim selected, the tool turns the simulated distribution of points into **probabilities** for each band.

> Check our `priceStep()` in engine.js: it uses thresholds of 1.2 / 0.9 / 0.6 with no 3-dp rounding. The site's thresholds are **0.605 / 0.9 / 1.195**, with rounding to 3 dp. They look like the real rules. Worth aligning.

---

## 3. Live Scoring (/live)

**Question it answers:** "What is everyone, and my team, scoring right now in this session?"

### Inputs and controls
- **Session selector** across the top, e.g. "R14: Q, R" and "R15: Qualifying in 2d 0h". It includes a countdown to the next session.
- Each session has a **status**: Upcoming, Live, Provisional or Finalized. You can turn on coloured header borders that show the status.
- **Data options:** show inactive drivers, heatmap colouring, header status colouring.
- **View options for teams:** wide or compact table; **extra asset info** can show points or price change.
- **Add a Manual Team** modal (Pro): pick 5 drivers, 2 constructors, the x2 driver, an optional chip (X3/LL/AP/NN/FF/WC) with details of how it was played, **Extra transfers** (for the −10 penalty each) and a team name.

### Outputs
- **Drivers table:** DR | TOT | Δ$ | Q POS | Race POS | PG (positions gained) | OV (overtakes) | FL | DD (Driver of the Day).
- **Constructors table:** CR | TOT | Δ$ | Q POS | **TW** (qualifying teamwork bonus) | Race POS | PG | OV | FL | **FP** (fastest pit stop).
- **Teams table** with sections for Elite Teams (the Global #1 team, free), My Teams + My Rivals (subscribe) and Manual Teams.
  - Default columns: # | CR | x2 | DR | Δ$ | PTS.
  - The column picker breaks the score into every official scoring category: Q TOT, Q POS, Q NC, Q DQ, Q TW, R TOT, R POS, R NC, R DQ, R PG, R OV, R FL, R DOTD, R FP, R OFP (overall fastest pit stop), R WRFP (world-record pit stop).
- Δ$ is the actual price change, shown once the race is finalised.

---

## 4. Elite Data (/elite-data)

**Question it answers:** "What are the best players picking, and when are they playing chips?"

### Inputs and controls
- Season: 2024, 2025 or 2026.
- **Round:** R1 to R14, with sprint weekends listed separately.
- **Dataset:**
  - *Global 500*: the top 500 teams overall.
  - *Subscriber 500*: the top 500 among F1FT subscribers.
- Highlight your team (T1–T3, subscriber).
- Visual settings: heatmap, hide % signs, align numbers, round numbers.

### Outputs
- **Constructor Picks:** CR | P% (percentage of the top 500 owning it) | change since the previous round. Example: MER 100 %, FER 95 % (−3 %).
- **Driver Picks:** DR | P% | Δ | **x2%** (share using that driver as DRS boost) | Δ. Example: ANT 99.8 % owned and 97.6 % boosted; PER +58.1 % week on week.
- **Chip Usage:** one row per race, with a column for each chip (LL, X3, NN, AP, FF, WC) showing the % of the top 500 who played it that round. A **Total** row shows how many have used each chip so far. For example, 99.5 % had used Limitless by R14, but only 42 % had used Final Fix. You can see where the elite clustered: LL at R3 (58.5 %), X3 at R2 (54 %) and R13 (30 %), NN at R14 (40 %), FF at R11 (24 %).

---

## 5. Statistics (/statistics)

**Question it answers:** "How has every asset scored, race by race, and in which categories?"

### Inputs and controls
- Season: 2023–2026.
- **Metric dropdown:**
  - Fantasy: Fantasy Points, Price, Price Change, Points Per Million, Percent Owned, x2 Percent Owned.
  - Sprint: Position, Fastest Lap, Positions Gained, Overtakes, DNF.
  - Qualifying: Position.
  - Race: Position, FL, PG, Overtakes, DNF, DOTD, Overall Fastest Pit Stop, World Record Pit Stop.
- **Fantasy Points Types** filter ("20 / 20"): tick which scoring categories count toward the total. For example, show only race overtakes and fastest-lap points.
- **Races** multi-select, with full GP names and sprint flags.
- Display options: remove points for inactive-driver results, heatmap colouring, mute other rows when highlighting your team, show only races with results.
- Highlighting your team T1–T3 (subscriber) marks the regular, x2 and x3 picks for every race.

### Outputs
- A **grid of assets × races (R1 to R23)** plus an **AVG** column, and an **AVG row per race**. Every column can be sorted.
- **Clicking a cell** opens "Asset Details": price at team lock, Δ$, the qualifying breakdown (Q POS points) and the race breakdown (overtakes, position, positions gained, FL, DOTD), with a total. Example: ANT R13 = 93 (4 from qualifying + 89 from the race, including 26 overtakes).
- **Right-click or long-press a race header** to see details for that race.

---

## 6. Hindsight (/hindsight)

**Question it answers:** "What would the optimal team have been for a past race?"

### Inputs and controls
Same as the calculator, but using actual results:
- Season and Round.
- "Select a team to analyze" (your teams; personalised optimal transfers need Pro, Rivals need Pro Plus), or a maximum budget.
- Chip: X3, LL, NN, WC.
- Convert Δ$ into points.
- Incl/Excl per asset.

### Outputs
- **Optimal Teams**, ranked by actual points: # | CR | x2 | DR | $ | Pts / Δ$. For R14 the top team scored **254**, which gives a ceiling to compare against.
- Drivers and constructors tables showing actual $, Δ$ and Pts.

---

## 7. Team Analyzer (/team-analyzer): Pro, demo on the Global #1 team

**Question it answers:** "Which of my decisions (transfers, x2 choice, chips) gained or lost points?"

### Per-race card, newest first
- Race points, **Δ$ budget change**, cumulative total, total budget.
- The team with each asset's points and Δ$.
- **Team value**, **Bank**, **Transfers (N free)**.
- **Transfer diff:** assets out (their points and Δ$) against assets in, giving the **Transfer impact** in points and $. Example: at R12, bringing in GAS and BOR for two dropped drivers (who scored −35 each) was worth +83 points.
- **Change of x2 driver:** what the old x2 choice would have scored against the new one, giving the **x2 change impact**.
- **Chip impact:**
  - NN: sums the negatives that were avoided.
  - X3: extra points compared with plain x2.
  - FF: the swapped-in driver's points against the swapped-out driver's.
  - WC: counts the transfer penalties avoided ("made 3 subs with 3 free, 0 × −10 avoided").
  - LL: transfer impact plus x2 impact. It notes that price changes are based on the previous race's team.
- **Global Race Rank** with a top-% figure, and **Global Rank**.

---

## 8. League Analyzer (/league-analyzer): Pro. This is the "league" feature

**Question it answers:** "How is my league looking: standings, rivals' teams, their chips and transfers, and progress over time?"

### How you connect
- You create an F1FT account (Google or an email code), buy **Starter or higher**, and then **"Link your F1 Fantasy account"**. According to the privacy policy, F1FT then retrieves "your team, scores, and related game data" and keeps it while your account is active.
- The public pages don't explain the linking step itself, for example whether you sign in to F1 or hand over a session token. Once linked, they show your teams T1–T3, and the leagues you belong to become selectable. The "League Selection" dropdown requires **Pro**.
- There is **no free "enter a league code" option**. League data comes from the linked, logged-in F1 account.
- **Rivals** (Pro Plus) are other teams you "find and link", which are then tracked in every tool.
- **Refresh and timing:**
  - Real-time points and standings during live sessions (Pro).
  - Saves your rank every week once you subscribe, because "F1 Fantasy does not store this data". Historic global rank for teams outside the top 500 exists only from the week you subscribed.
  - They also save your data after the season ends, because F1 Fantasy deletes most of it.
  - A **budget-over-time graph is "not possible due to F1 Fantasy limitations"**, which suggests the league API doesn't expose past team values.

### Controls
- **League selector.** The free demo uses "Global League".
- **Teams in list:** choose up to **20 teams per league** to analyse, with a searchable ranked list.
- **Round** selector.
- **Sort by:** Total Points, Race Points, Total Budget, Budget Change, or Chip order.
- Chip-order display: Default (easier to compare), Used vs Unused, or In order of play.
- **Extra info on closed cards:** asset points, asset price changes, or chips played.
- **Graph settings:**
  - Data type: Total Points, Race Points or Rank (Budget is disabled).
  - "Compare with" a chosen team, which plots gaps relative to it.
  - Line style: Default or Monotone.
  - Show used chips, and always show all races.

### Outputs (team card)
- League position, team name and slot (T1/T2/T3), manager.
- Race pts, Δ$, total pts, total budget.
- Current team with the x2 pick.
- **Chips shown as used or unused** (LL X3 NN AP FF WC), with the **round each chip was played** (e.g. R4, R2, R5, R11, R13).
- Team value and bank.
- **Transfers (N free)**, with an out/in diff and the transfer impact.
- Chip impact.
- League rank, race rank and global rank, each with a top-%.
- A graph tab shows a line chart of cumulative points (or rank) per round with chip markers.

---

## 9. Season Summary (/season-summary): Pro, demo on the Global #1 team

Each section below is a chart or tile.

- **Rank Progression:**
  - Global rank per round, as a line chart with an optional log scale, a round range and chip markers.
- **Transfer Balance:**
  - Free against extra transfers (e.g. 28 free, 0 extra).
- **Transfer Impact Overview:**
  - Good transfers: +516 points across 16 transfers.
  - Bad transfers: −93 points.
  - Net: +423 points.
  - Can be switched between points and budget.
- **Transfer Impact per Race:**
  - A bar chart sorted from high to low, labelled "(used/free)", e.g. LL R4 = +256 (5/∞).
  - Penalties are already subtracted.
- **Positive Events:**
  - FL, DOTD and fastest-pit-stop events caught against those possible (32 of 65, 360 of 770 pts).
  - Broken down by DR, CR and the x2 bonus.
  - A bar per race showing actual points against the theoretical maximum from a valid team.
- **Negative Events:**
  - DNFs and DQs hit against those possible (12 of 138, −210 of −2,590).
  - A bar per race, including how much "NN avoided".
- **Points by Asset:**
  - A **treemap** of positive and negative points by driver and constructor.
- **Points by Session & Type:**
  - A treemap by session (Race / Qualifying / Sprint) and category (POS, OV, FL, PG, FP, DOTD, TW, NC).

---

## 10. Particularly clever or useful ideas

1. **Editable xPts per asset plus force include/exclude**: the optimiser takes the user's own view instantly.
2. **Converting price changes into points (xSPts)** with a slider and a count of remaining races: a clear, principled "budget uplift" knob.
3. **Probability of each price step** from simulated score distributions, not just a single expected change. The **Required Points** table works without any simulation.
4. **Simulation versioning with written assumptions** (Scenario A/B/C) plus timestamps and notes such as "Very Early" or "dry conditions".
5. **Alternative baselines** (Classic/Weighted average, Form over 5 races, Equal PPM) to sanity-check the model.
6. **Filters on team-level risk metrics**: DNF %, xNP, FL %, DOTD %, FP xPts.
7. **Pin team and copy as text**: easy to compare and share.
8. **Hindsight optimum** as a benchmark for how good a week's team could have been.
9. **Decision attribution** (transfer, x2, chip impact) in Team Analyzer and Season Summary.
10. **Elite ownership and chip timing**: the "template" and when to break from it.
11. **Session status on the live board** (Upcoming, Live, Provisional, Finalized).
12. **Scoring-category filter in Statistics**: pick which scoring types to count.

---

## 11. Features our planner lacks, ranked by usefulness

Our planner today (engine.js, app.html, refresh.py, practice.py) has:
- A Monte Carlo weekend simulation with circuit factors and sprint scoring.
- An optimiser with locks, bans, chips, maximum transfers and a horizon.
- An assets table with xPts, the 25–75 range, PPM, form, DNF/FL/xOvt/DotD and ownership.
- A heat grid, a price table and a calendar.
- Model settings for half-life, blend and number of sims.
- Practice pace from OpenF1.

Features we don't have yet, ranked:

| # | Feature | Why it's useful | Data needed |
|---|---|---|---|
| 1 | **Price-change odds and Required Points table.** Probability of each step, and the points needed per step and asset. Use 3-race AvgPPM rounded to 3 dp, with thresholds 0.605 / 0.9 / 1.195, tier split at 18.5M and the 3–34M clamp. | Budget growth decides the season, and we already have the simulated distributions (`tot`). Also fix `priceStep` thresholds. | **Public**: F1 Fantasy feeds (prices, per-race points) plus our own sim |
| 2 | **Price-to-points conversion (xSPts)**: a pts-per-$M-per-race slider times remaining races, as an objective option in the optimiser. | Makes the points-now against value-later trade-off explicit and tunable. Our horizon partly does this implicitly. | **Public** (calendar feed for remaining races) |
| 3 | **Editable xPts per asset** in the assets table, feeding straight into the optimiser. | Lets the user add their own knowledge (weather, upgrades, penalties). | None (UI only) |
| 4 | **Team-level risk columns and filters**: total DNF exposure, xNP, FL/DOTD odds, and variance or p10 of the team total. Plus **Pin** and **Copy team as text**. | Choose between near-equal teams by risk. We already compute these per asset. | **Public** / own sim |
| 5 | **Hindsight optimum** for past races, with the actual score of our pick compared to the optimum. | Calibrates the model and shows the ceiling. | **Public**: F1 Fantasy per-race points (feeds) plus Jolpica results |
| 6 | **Alternative baseline sims** (season average, weighted average, last-5 form, equal PPM) that can be switched in the optimiser. | Checks the model; fallback when practice data is thin. | **Public** |
| 7 | **Statistics grid with category drill-down**: asset × race grid, clicking a cell opens a points breakdown (Q POS, R POS, PG, OV, FL, DOTD, pit stop), with a filter by scoring category. | Explains *why* an asset scores; useful for setting circuit factors. | **Public**: F1 Fantasy driver/constructor feeds (per-race stat breakdowns) plus Jolpica. Check the feed carries category breakdowns; otherwise rebuild from Jolpica with OpenF1 overtakes/pit stops (approximate) |
| 8 | **Live scoring board** with session status and a per-category breakdown, for our own team. | Useful on race weekends. | **Public** if the F1 Fantasy live/driver feeds update during sessions (needs checking); OpenF1 live positions as a fallback |
| 9 | **Simulation versioning, timestamps and notes** ("after FP2", "wet risk"), with a comparison between versions. | Shows how estimates move through the weekend; builds trust. | None (own data) |
| 10 | **Decision attribution** for our own team: transfer impact, x2 impact and chip impact per race, plus a season summary (treemaps, events caught against possible). | Learning loop. | **Public** if we record our own team each week in the planner. Importing it automatically needs a **logged-in F1 account** |
| 11 | **Elite ownership and chip-timing data** (top 500 pick %, x2 %, chip usage by round). | Shows the template, and when differentials matter. | Global ownership % is **public** in the feeds (we already show "Own"). **Top-500-specific** data needs **logged-in F1 access** to the leaderboard and team endpoints, or scraping, so skip it or approximate with global ownership |
| 12 | **League / rival tracking**: league standings, rivals' teams, chips used and remaining, transfers, rank graph. | Head-to-head strategy (covering or differentiating). | **Logged-in F1 account needed.** League and team endpoints require the user's F1 session, which is how F1FT does it with "Link your F1 Fantasy account". A manual fallback is to type in rivals' teams and chips, which is public-only |
| 13 | **Import my current team, bank, free transfers and chips remaining** instead of entering them by hand. | Convenience. | **Logged-in F1 account needed.** Manual entry already works |
| 14 | **Violin plots or distributions per asset** (the site only shows these on Discord). | We already have p10–p90, so this is cheap to add and exceeds the site. | Own sim |
| 15 | **Multi-race Team Planner / chip planner** across the horizon. It's "coming later" on F1FT, and our horizon optimiser is already a step towards it. | Chip timing (LL, WC, X3, NN) over the rest of the season. A differentiator. | **Public**: calendar plus our sims |

Suggested order: 1, 2, 3 and 4 are quick and high-value wins that use data we already fetch. Then 5 and 7 to calibrate the model. Items 12 and 13 are the only ones that really depend on a logged-in F1 account.
