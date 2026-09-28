// @ts-check
/* Pit Wall engine: race-weekend Monte Carlo + official F1 Fantasy scoring + team optimiser.
   Pure functions, no DOM. Inlined into the page by refresh.py; also loadable from node (tests, backtests, the
   projection refresh.py freezes at lock). Season-specific inputs (circuit types, field size) come from
   data.cfg (config/season.json); past seasons' circuit numbers from data.priors (priors.py).

   The weekend model, in short:
   - pace is % off the fastest car: qualifying from each session's lap times, race from the median clean race lap
     (OpenF1), recency-weighted, mixed with the team-mate, nudged by practice and (next race) the betting market
   - each simulated weekend draws a form shock per team and per driver that carries through qualifying, sprint and
     race, a fresh draw of every driver's pace and team's reliability within their uncertainty, rain per session,
     multi-car incidents and a safety car (more likely after a crash), which shuffles the order
   - finishing order = race pace + a cost per grid slot (how hard passing is at that circuit) + noise
   - overtakes depend on grid slot and places moved; pit-stop points come from each team's real stop times
   - circuit numbers (overtaking, retirements, grid influence, safety cars, rain) start from past seasons at that
     circuit and are scaled by this season's trend (e.g. a new rule set with more overtaking) */
(function (root) {
  const QPTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const RPTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const SPTS = [8, 7, 6, 5, 4, 3, 2, 1];

  /* Model settings. "backtested"/"fitted" values were chosen by walk-forward tests (`npm run backtest`, `npm run
     fit`; latest results in CLAUDE.md). "hand-set" values were picked by eye and are only checked by the calibration
     section there. "measured" values are counted from data. */
  let MODEL = {
    prior: 1.5, // backtested (flat 0.5-4): pseudo-races of the team-mate average mixed into each driver's pace
    defaultGap: 2.5, // hand-set: % off the fastest for a team with no history
    gapCap: 4, // hand-set: a round's gap above this (%) counts as this (a problem lap, damage)
    paceShrink: 0.8, // fitted (npm run fit): share of each driver's gap to the field median that's kept
    rankSlope: 0.1, // hand-set: % per place when a round has no lap-time pace (only its finishing order)
    // race pace per round: "median" = median clean lap (extras.lap_pace); "ctx" = the contextual lap model
    // (laps.py: tyres, fuel, traffic, neutralised and wet laps taken out), median where it has no estimate; "pool"
    // = the same with those context terms pooled across the rounds up to it (laps.py pool_rounds, challenger
    // racepool). Review batch 3 (2026-09-27): see docs/history.md for the backtest.
    racePace: "median",
    // with "ctx": each round's estimate counts ctxTau^2 / (ctxTau^2 + (ctxSeInflate x its standard error)^2), so a
    // driver the lap model barely pinned down (few clean laps) counts little. Hand-set: ctxTau ~ how much a
    // driver's race pace moves between races (%); ctxSeInflate for lap errors that are correlated within a stint
    // (laps.py's standard errors treat them as independent)
    ctxTau: 0.4,
    ctxSeInflate: 2, // data-informed 2026-09-28: 1.85 from odd vs even stints (laps.py inflate, 64 driver-races R1-R15; per round 0.05-3.07, ~1.47 without R8): a conservative provisional value, not a held-out test
    dnfHalfLife: Infinity, // backtested: no recency weighting of retirements (every race counts the same)
    dnfShrink: 16, // backtested: pseudo-races of the grid-wide retirement rate mixed into each team's
    dnfFallback: 0.12, // hand-set: retirement rate before any race has run
    // retirements by cause (review batch 3): "pooled" = one team rate for every cause; "causes" = the team's
    // mechanical rate (no incident recorded, or didn't start; shrunk with dnfShrink) plus the driver's incident rate
    // (race control named the car; shrunk with incShrink pseudo-races of the field's). raceInfo retirements
    // (laps.py) decide the cause; rounds without them count as mechanical.
    dnfModel: "pooled",
    incShrink: 40,
    defaultOvertakes: 3, // hand-set: race overtake points for a driver with no races
    sprintOvertakeShare: 0.4, // hand-set prior; this season's sprints move it (shrunk: they're noisy)
    ovShrink: 12, // hand-set: pseudo-overtakes behind each driver's own overtaking skill
    practiceQ: 0.5, // backtested: share of practice short-run pace blended into qualifying pace
    practiceR: 0, // backtested: long runs add nothing to race pace since it comes from race laps (section 4)
    practicePull: 0.8, // backtested: most % practice can move a driver (a spin or red flag shouldn't wreck one)
    practiceMinLaps: 6, // hand-set: fewer laps than this in a session = no signal
    practiceMinDrivers: 6, // hand-set: fewer drivers with a time than this = no comparison
    pitRecent: 8, // hand-set: races of pit-stop points used per constructor
    pitBonusPrior: 0.5, // hand-set: pseudo-bonuses per team when weighing who wins the race's fastest stop
    dotdShrink: 2, // hand-set: pseudo-votes "as expected" behind each driver's Driver of the Day popularity
    pitDotd: 0.9, // measured: Driver of the Day points per race that the pit residual leaves out (fallback model)
    // item 9 stage 4 (off: telemetry.py bands): a team's fast-corner loss (200-260 km/h, the only speed band stable
    // across rounds) x how much more of the next track's practice lap is fast corners than the season's average, as a
    // pace shift (%), weighted into qualifying (bandQ) and race pace (bandR); bandShrink pseudo-rounds of no loss
    bandQ: 0,
    bandR: 0,
    bandShrink: 3,
    bandMin: 3, // rounds with a practice band share before the shift applies
    mate: "blend", // backtested (section 9, 2026-09-25: a tie): "blend" = each driver's pace mixed with prior races of
    // the team average; "car" = the car's pace (both cars, recency-weighted) plus the driver's offset to it
    offPrior: 3, // "car" only: pseudo-races of zero offset behind each driver's offset to his car (1.5-6 all tie)
    offHalfLife: Infinity, // "car" only: recency half-life of the offset (8 was slightly worse)
  };
  let SIM = {
    qualiNoTime: 0.012, // hand-set: chance a driver sets no qualifying time (-5, starts last)
    qSd: 0.2, // fitted: qualifying noise, % of a lap
    rSd: 0.15, // fitted: race noise, %
    teamSd: 0.1, // fitted: a team's weekend form (shared by both cars, all sessions), %
    drvSd: 0.08, // fitted: a driver's weekend form (all sessions), %
    tau: 0.07, // fitted: cost of one grid slot at an average circuit, % of race pace
    unc: 1, // fitted: scale on the pace / reliability uncertainty drawn per weekend (0 = off)
    sprintSd: 0.85, // hand-set: sprint noise relative to the race
    sprintDnf: 0.4, // hand-set: sprint retirement rate relative to the race
    sprintSc: 0.5, // hand-set: sprint safety-car chance relative to the race
    incident: 0.15, // fitted: share of retirements that come from multi-car incidents
    scPerDnf: 0.15, // hand-set: chance a retirement brings out the safety car (2026: ~3 retirements, 43% safety cars)
    scNoise: 1.35, // fitted: race noise under a safety car
    scTau: 0.75, // hand-set: grid slot cost under a safety car (the field bunches up)
    // the timed safety car (challenger sctimed; 0 = off): each simulated race safety car gets an onset (the share of
    // the race run when the last one came, drawn from the circuit's scAt: dry, unflagged races of past seasons and
    // this season's finished rounds) and its effect scaled by the weight max(0, scTimeA + scTimeB x onset): the
    // grid slot cost and overtake uplift by the weight over its mean (the average safety car keeps its level
    // effect), the race noise so that its mean SQUARE matches the untimed one (the noise variance under a safety
    // car is kept: a timing test, not a variance change; fifth review). Sprints untimed. Fitted 2026-09-28 on 24
    // dry safety-car races 2023-2025 only (priors.py; out of sample for the 2026 walk-forward, fifth review): places
    // moved per car above no-SC races = -0.137 + 1.10 x onset (slope se 0.64); 2023-2026 gives -0.146 + 1.26.
    // Exploratory: last-SC onset vs places moved doesn't identify duration, pit windows or a causal effect
    scTimed: 0,
    scTimeA: -0.137,
    scTimeB: 1.1,
    rainNoise: 1.6, // measured (priors.py wet vs dry races): noise in a wet session
    rainDnf: 1.4, // measured: retirements in a wet race
    // hand-set (review batch 4): latent correlation of the weekend's wet sessions (one weather regime), used when
    // no ensemble forecast gives it (circuit.rain.rho). The marginal chances don't change.
    rainCorr: 0.3,
    flDecay: 2.2, // fitted: fastest-lap weight by finishing position, exp(-(pos-1)/flDecay)
    dotd: [12, 4, 3, 0.4, 0.03], // hand-set: Driver of the Day weight for P1, P2, P3, P4-6, P7+
    dotdGain: 0.4, // hand-set: extra DotD weight per place gained beyond four, for a top-8 finisher
    pitSd: [2, 10], // hand-set: bounds on a constructor's pit points spread (fallback model)
    oddsW: 0.5, // backtested (R5-R14 Kalshi at lock): market weight; 0.25-0.5 tie on CRPS, 0.5 best on MAE
    ovModel: 1, // backtested: 1 = overtakes from the grid / places-moved regression, 0 = each driver's season rate
    pitStops: 1, // backtested: 1 = resample the team's real pit scoring lines, 0 = its leftover race points
    // review batch 4: the race's fastest-stop bonus ("R FP2", +5) goes to exactly one team per simulated race, among
    // those with the best stop band that weekend (weighted by bonuses won + pitBonusPrior), instead of riding along
    // in each team's resampled line (which gave none or several). Same expected total. 0 = the old way.
    pitBonus: 1,
    // market quote quality (second review, off: challenger "oddsq"): a line's pull towards the market is divided by
    // 1 + oddsQuality x its bid-ask spread / its price, so a wide, thin quote moves pace less than a tight one
    oddsQuality: 0,
    // the market fit's steps and the sims each step is judged on (hand-set; the weight oddsW was backtested with
    // these). After 4 steps the fit is still "moving" (0.3-0.4 log-odds off its targets on R13-R15), so the market's
    // real pull is below oddsW. More steps help little: the residual levels off by about step 6 (R13 0.42 -> ~0.35,
    // R15 0.31 -> ~0.27, 24 steps tried), because one pace per driver can't meet win, podium and top 10 together (the
    // market sees a wider spread of results than the model). Challenger "odds8" (8 steps on 5,000 sims) tests the gain.
    oddsIters: 4,
    oddsN: 2500,
    // review batch 4: a race-wide overtaking factor drawn once a weekend, lognormal with mean 1 and the circuit's
    // ovSd (trackModel), so a race can run high or low for everyone (and the tails of overtake points widen).
    // 0 = the fixed forecast level. See docs/history.md for the backtest.
    ovEnv: 0,
    qSkew: 0, // backtested (section 9, 2026-09-25): skew-normal shape of the qualifying noise; 2-5 tie with 0
    rSkew: 0, // backtested: the same for the race; 5 slightly worse. (Noise in 1/t² space skews by only ~0.02: a no-op)
    flOddsW: 0, // backtested: share of races whose fastest lap is drawn from Kalshi's market; worse at every weight
    // Lap-by-lap race (item 9 stage 3a, raceLaps): "rank" = the finishing order from one score per driver and
    // overtakes from the regression; "laps" = the race run lap by lap, overtakes = the passes it makes.
    raceModel: "rank",
    // measured (R1-R14 race lap records, lap-end pairs < 3 s apart, green laps, no pit stops; round level left free):
    // pass logit per s/lap pace advantage of the car behind, per s of gap, and extra per s of gap below 0.5 s
    lapKernel: [1.67, -2.63, -4.23],
    lapSd: 0.4, // measured: lap-to-lap noise of clean laps, s
    lapStart: 0.25, // hand-set: gap per grid slot at the start, s
    lap1: 1, // hand-set: pass logit bonus on lap 1 (lap 1 = ~35% of lap-end passes in 2026)
    pitLoss: 23, // measured: median time lost to a stop (in-lap + out-lap), s
    lapFollow: 0.3, // hand-set: gap to the car ahead when held up, s
    // calibrate the pace term of the pass curve (kappa) so the grid-finish rank correlation matches the circuit's
    // (circuit.grid, fitted on this season's rounds), as the rank model's grid slot cost does
    lapGrid: true,
    // each driver's overtakes in the lap race: "passes" = the passes it made; "regression" = the rank model's
    // regression on places moved and grid slot, applied to the lap race's result (the order still comes from laps)
    lapOv: "passes",
    // Stage 3b (raceModel "segments", raceSegs): three timing segments a lap. Measured on R1-R14 race timing-line
    // pairs < 2 s apart (14,486 segment events, round level left free): pass logit per s/lap pace advantage, per s of
    // gap, extra per s of gap below 0.3 s, and when the car behind was passed by this car in the last 3 segments
    segKernel: [1.15, -5.21, -0.41, -0.3],
    // measured: official overtakes minus timing-line passes per driver-race = 0.04 + 0.144 x segments spent < 0.3 s
    // from another car (r 0.33): passes and re-passes between two timing lines (the Overtake Mode yo-yo). Each
    // segment a pair runs < 0.3 s apart, both cars get one with this chance; the order doesn't change.
    yoyo: 0.144,
    followMin: 0.25, // measured: a held-up car's gap = followMin + exponential(followMean); quantiles 0.36 / 0.71 /
    followMean: 0.45, // 1.26 s (10 / 50 / 90%) in the data
  };
  // Constructor pit-stop points (2026 rules), from the team's fastest stop of the race: under 2.0 s 20, 2.0-2.19 10,
  // 2.2-2.49 5, 2.5-2.99 2, slower 0; the fastest stop of the race +5. Only used to check OpenF1's stop times
  // against the scoring lines (backtest section 8); the sim resamples the real lines.
  const PIT_BANDS = [
    [2.0, 20],
    [2.2, 10],
    [2.5, 5],
    [3.0, 2],
  ];
  const PIT_FASTEST = 5;

  /** @typedef {{ ov: number, ovMean?: number, kmh?: number, laps?: number, lapT?: number, grid: number, chaos: number, sc?: number, scOv?: number, scAt?: number[], rain?: { q?: number, s?: number, r?: number, rho?: number }, ovSd?: number, note: string, feat: number[], teamShift?: Record<string, number>, id?: string, prior?: Record<string, number | null> }} Circuit */
  /** @typedef {{ tla: string, team: string, pos: number, grid?: number, cls?: boolean, fl?: boolean, gap?: number | null, num?: number, laps?: number, dns?: boolean, dsq?: boolean }} ResultRow */
  /** @typedef {{ gd: number, price: number, pts: number, active: boolean, team: string, r?: number | null, nn?: number, ev?: any[][], own?: number }} HistRow */
  /** @typedef {{ id: string, kind: "D" | "C", name?: string, tla: string, team: string, price: number, active: boolean, overtakePts: number, own?: number, hist: (HistRow | null)[] }} Asset */
  /** @typedef {{ name: string, done: boolean, ref?: number | null, drivers: Record<string, { q: number | null, r: number | null, laps: number }> }} PracticeSession */
  /** @typedef {{ gd: number, name: string, sprint: boolean, lock: string, circuit?: string, raceStart?: string, sessions?: { type: string, start?: string, end?: string }[] }} Gameday */
  /** @typedef {{ Q?: { share: number[], teams: Record<string, { gap: number, band: number[] }> }, FP?: { share: number[], lap?: number } }} BandRound */
  /** @typedef {{ circuits?: { list: [string, number[], string][], km?: Record<string, number> }, field?: number }} SeasonCfg */
  /** @typedef {{ season: number, round: number, circuit: string, name: string, starters: number, dnf: number, move: number | null, gain: number | null, gridCorr: number | null, sc?: number, vsc?: number, red?: number, rain?: number, ovt?: number | null, scLaps?: (number | string | null)[][], lapsRun?: number }} PriorRow */
  /** @typedef {{ sc: number, vsc: number, red: number, rain: number, pits: Record<string, number[]>, pace: Record<string, number>, paceCtx?: Record<string, number>, pacePool?: Record<string, number>, paceSePool?: Record<string, number>, paceSe?: Record<string, number>, lapCheck?: { ok?: boolean }, scLaps?: (number | string | null)[][], lapsRun?: number, retirements?: Record<string, { cause: string, lap: number, share: number | null }> }} RaceBlock */
  /** @typedef {{ win?: Record<string, number>, podium?: Record<string, number>, top10?: Record<string, number>, pole?: Record<string, number>, fl?: Record<string, number>, gd?: number, at?: string, checked?: string, asOf?: Record<string, string | null>, stale?: string[], dropped?: string[], spread?: Record<string, Record<string, number>> }} Odds */
  /** @typedef {{ schedule: Gameday[], done: number[], assets: Asset[], results: { race: Record<string, ResultRow[]>, quali: Record<string, ResultRow[]>, sprint: Record<string, ResultRow[]> }, trackStats?: Record<string, { ovt: number, lap?: number }>, bands?: Record<string, BandRound>, practice?: PracticeSession[], cfg?: SeasonCfg, evNames?: { c: string, s?: string }[], priors?: { races: PriorRow[] } | null, raceInfo?: Record<string, { race?: RaceBlock, sprint?: RaceBlock }>, weather?: Record<string, { q?: number | null, s?: number | null, r?: number | null, ens?: { q?: number | null, s?: number | null, r?: number | null, qr?: number | null, n?: number } }>, odds?: Odds | null, weekend?: { gd: number, penalties: Record<string, number>, penAt?: Record<string, string>, penParts?: Record<string, [number, string | null][]>, grid: Record<string, string[]>, status?: Record<string, Record<string, string>>, fl?: Record<string, string> } | null, lockSnap?: { gd: number, weather?: any, penalties: Record<string, number>, penAt?: Record<string, string>, penParts?: Record<string, [number, string | null][]>, practice?: PracticeSession[], bands?: Record<string, BandRound> } | null, live?: { gd: number, feedTime?: string, assets: Record<string, { act?: boolean, sess?: Record<string, number>, ev?: [number, number, string?][] }> } | null, generated?: string, oddsLock?: Odds | null }} Data */

  const FEAT_NAMES = ["Power", "Street", "Fast corners"];
  /** @type {Circuit} */
  const DEFAULT_CIRCUIT = {
    ov: 1,
    grid: 0.62,
    chaos: 1,
    sc: 0.5,
    scOv: 1,
    rain: {},
    note: "Average circuit",
    feat: [0.5, 0.2, 0.5],
  };
  const fieldOf = (/** @type {Data} */ data) => (data.cfg && data.cfg.field) || 22;

  /* ---------- small maths ---------- */
  /* numerical health of the fits behind a model (second review): each least-squares / Poisson fit notes itself
     while a log is open (withFitLog): a direction the data can't pin down (dropped), a rough condition number and,
     for the Poisson fits, whether IRLS converged. Finite output alone doesn't say a fit is identified. */
  /** @type {{ name: string, ok: boolean, [k: string]: unknown }[] | null} */
  let fitLog = null;
  /** @param {string} name @param {{ ok: boolean, [k: string]: unknown }} info */
  const fitNote = (name, info) => {
    if (fitLog) fitLog.push({ name, ...info });
  };
  /** Run fn with a fresh fit log: {value, fits}. @template T @param {() => T} fn */
  function withFitLog(fn) {
    const prev = fitLog;
    fitLog = [];
    try {
      const value = fn();
      return { value, fits: fitLog };
    } finally {
      fitLog = prev;
    }
  }
  /** Eigenvalues of a symmetric matrix (cyclic Jacobi rotations; the fits' matrices are small, k <= ~12).
   * @param {number[][]} A @returns {number[]} */
  function symEig(A) {
    const n = A.length;
    const M = A.map((r) => r.slice());
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += M[p][q] * M[p][q];
      if (!(off > 1e-30 * (1 + M.reduce((s, r, i) => s + r[i] * r[i], 0)))) break;
      for (let p = 0; p < n; p++)
        for (let q = p + 1; q < n; q++) {
          if (M[p][q] === 0) continue;
          const th = (M[q][q] - M[p][p]) / (2 * M[p][q]);
          const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
          const c = 1 / Math.sqrt(t * t + 1),
            s = t * c;
          for (let k = 0; k < n; k++) {
            const kp = M[k][p],
              kq = M[k][q];
            M[k][p] = c * kp - s * kq;
            M[k][q] = s * kp + c * kq;
          }
          for (let k = 0; k < n; k++) {
            const pk = M[p][k],
              qk = M[q][k];
            M[p][k] = c * pk - s * qk;
            M[q][k] = s * pk + c * qk;
          }
        }
    }
    return M.map((r, i) => r[i]);
  }
  /** 2-norm condition number of a symmetric matrix: largest / smallest |eigenvalue| (Infinity when singular).
   * @param {number[][]} A */
  function symCond(A) {
    const ev = symEig(A).map(Math.abs);
    const lo = Math.min(...ev),
      hi = Math.max(...ev);
    return lo > 0 ? hi / lo : Infinity;
  }
  /** Solve A x = b (Gauss-Jordan with partial pivoting). A variable the system can't pin down (no pivot left, e.g.
   * two identical columns) is set to 0 rather than blown up, so a singular fit stays finite; info gets how many were
   * (dropped) and, A being symmetric (every caller solves normal equations), its condition number (cond, exact:
   * eigenvalues). @param {number[][]} A @param {number[]} b @param {{ dropped?: number, cond?: number }} [info] */
  function solve(A, b, info) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    const tol = 1e-12 * Math.max(1e-300, ...A.flat().map(Math.abs));
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      let pv = i;
      for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[pv][i])) pv = k;
      [M[i], M[pv]] = [M[pv], M[i]];
      if (!(Math.abs(M[i][i]) > tol)) {
        M[i] = M[i].map((_, j) => (j === i ? 1 : 0));
        dropped++;
      }
      for (let k = 0; k < n; k++)
        if (k !== i) {
          const f = M[k][i] / M[i][i];
          for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
        }
    }
    if (info) {
      info.dropped = dropped;
      info.cond = symCond(A);
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  /** Ridge regression on centred features, solved directly (noted in the fit log as name).
   * @param {number[][]} X @param {number[]} y @param {number} lam @param {string} [name] @returns {number[]} */
  function ridge(X, y, lam, name = "ridge") {
    const k = X.length ? X[0].length : 3;
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lam : 0)));
    const b = new Array(k).fill(0);
    X.forEach((x, n) => {
      for (let i = 0; i < k; i++) {
        b[i] += x[i] * y[n];
        for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      }
    });
    /** @type {{ dropped?: number, cond?: number }} */
    const info = {};
    const x = solve(A, b, info);
    fitNote(name, { ok: !info.dropped && (info.cond ?? 0) < 1e12, n: X.length, ...info });
    return x;
  }
  /** Poisson regression with an offset (IRLS), light ridge on all but the intercept (column 0). A step that makes
   * the penalised likelihood worse is halved (up to 20 times); noted in the fit log as name, with whether it
   * converged. @param {number[][]} X @param {number[]} y @param {number[]} off @param {number} [lam]
   * @param {string} [name] */
  function poissonGlm(X, y, off, lam = 0.5, name = "poisson") {
    const k = X[0].length;
    let b = new Array(k).fill(0);
    const my = y.reduce((s, v) => s + v, 0) / y.length,
      mo = off.reduce((s, v) => s + Math.exp(v), 0) / off.length;
    b[0] = Math.log(Math.max(1e-6, my) / Math.max(1e-6, mo));
    const obj = (/** @type {number[]} */ bb) => {
      let ll = 0;
      for (let n = 0; n < y.length; n++) {
        const eta = off[n] + X[n].reduce((s, v, j) => s + v * bb[j], 0);
        ll += (y[n] ? y[n] * eta : 0) - Math.exp(Math.min(20, eta));
      }
      for (let i = 1; i < k; i++) ll -= (lam * bb[i] * bb[i]) / 2;
      return ll;
    };
    let cur = obj(b),
      converged = false,
      iters = 0,
      halvings = 0,
      dropped = 0,
      cond = NaN; // of the last IRLS system (the Fisher information at the solution)
    for (let it = 0; it < 30; it++) {
      iters = it + 1;
      const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j && i > 0 ? lam : 0)));
      const g = new Array(k).fill(0);
      for (let n = 0; n < y.length; n++) {
        const eta = off[n] + X[n].reduce((s, v, j) => s + v * b[j], 0);
        const mu = Math.exp(Math.min(20, eta));
        for (let i = 0; i < k; i++) {
          g[i] += X[n][i] * (y[n] - mu);
          for (let j = 0; j < k; j++) A[i][j] += X[n][i] * X[n][j] * mu;
        }
      }
      for (let i = 1; i < k; i++) g[i] -= lam * b[i];
      /** @type {{ dropped?: number, cond?: number }} */
      const info = {};
      const step = solve(A, g, info);
      dropped = Math.max(dropped, info.dropped || 0);
      cond = info.cond ?? cond;
      let t = 1,
        nb = b.map((v, i) => v + step[i]),
        nv = obj(nb);
      // (a likelihood that isn't finite, e.g. an observation the offset makes impossible, can't be compared: the
      // full step, as plain IRLS)
      while (Number.isFinite(cur) && Number.isFinite(nv) && nv < cur - 1e-9 * Math.abs(cur) && t > 1e-6) {
        t /= 2;
        halvings++;
        nb = b.map((v, i) => v + t * step[i]);
        nv = obj(nb);
      }
      b = nb;
      cur = nv;
      if (step.every((s) => Math.abs(s) < 1e-7)) {
        converged = true;
        break;
      }
    }
    fitNote(name, { ok: converged && !dropped && cond < 1e12, converged, iters, halvings, dropped, cond, n: y.length });
    return b;
  }
  /** Standard normal CDF (Abramowitz-Stegun 7.1.26). @param {number} x */
  function normCdf(x) {
    const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp((-x * x) / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  /** @param {number[]} xs @param {number} p */
  function quantile(xs, p) {
    if (!xs.length) return NaN;
    const s = xs.slice().sort((a, b) => a - b),
      i = (s.length - 1) * p,
      lo = Math.floor(i);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
  }
  const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
    Math.max(lo, Math.min(hi, v));
  // log-odds with a floor at 0.4% / 99.6%: about the smallest price Kalshi's 1-cent tick gives after the overround
  // comes out, and 10 of the market fit's 2,500 sims (below that neither side is measured, so neither is matched)
  const logit = (/** @type {number} */ p) => {
    const q = clamp(p, 0.004, 0.996);
    return Math.log(q / (1 - q));
  };

  /** Sample s's own random stream under a master seed (a splitmix-style hash of the two), independent of how many
   * samples run or in what order. @param {number} seed @param {number} s @returns {Rng} */
  function streamFor(seed, s) {
    let h = (seed ^ Math.imul(s + 1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return mulberry32((h ^ (h >>> 16)) >>> 0);
  }
  /** Seeded uniform random numbers in [0, 1). @param {number} a */
  function mulberry32(a) {
    const f = function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // gauss's spare normal, on every stream from the start (one object shape for all of them)
    /** @type {{ g2?: number }} */ (/** @type {unknown} */ (f)).g2 = undefined;
    return f;
  }
  /** @typedef {() => number} Rng */
  /** A standard normal draw: Box-Muller, both halves (the sine half is kept on the stream for its next draw: one
   * log, sqrt and pair of uniforms per two normals; the review's profile had normals at ~18% of a run).
   * @param {Rng} r */
  function gauss(r) {
    const st = /** @type {{ g2?: number }} */ (/** @type {unknown} */ (r));
    const spare = st.g2;
    if (spare !== undefined) {
      st.g2 = undefined;
      return spare;
    }
    let u = 0;
    while (u === 0) u = r();
    const rad = Math.sqrt(-2 * Math.log(u)),
      th = 2 * Math.PI * r();
    st.g2 = rad * Math.sin(th);
    return rad * Math.cos(th);
  }
  /** Standard (mean 0, sd 1) skew-normal draw with shape a; a = 0 is gauss(r) itself (same random stream).
   * @param {Rng} r @param {number} a */
  function skewNoise(r, a) {
    if (!a) return gauss(r);
    const d = a / Math.sqrt(1 + a * a);
    const x = d * Math.abs(gauss(r)) + Math.sqrt(1 - d * d) * gauss(r);
    return (x - d * Math.sqrt(2 / Math.PI)) / Math.sqrt(1 - (2 * d * d) / Math.PI);
  }
  /** @param {number} l @param {Rng} r @returns {number} */
  function poisson(l, r) {
    if (l <= 0) return 0;
    // a large rate in chunks of 30 (a sum of Poissons is Poisson): exact, skew included (the normal approximation
    // had none: Poisson(31)'s skew is 0.18); cost grows with the rate, and no sim rate comes near it
    if (l > 30) return poisson(30, r) + poisson(l - 30, r);
    const L = Math.exp(-l);
    let k = 0,
      p = 1;
    do {
      k++;
      p *= r();
    } while (p > L);
    return k - 1;
  }
  /** Gamma(shape, 1) (Marsaglia-Tsang). @param {number} a @param {Rng} r @returns {number} */
  function gamma(a, r) {
    if (a < 1) return gamma(a + 1, r) * Math.pow(r() || 1e-12, 1 / a);
    const d = a - 1 / 3,
      c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        x = gauss(r);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = r();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  /** @param {number} a @param {number} b @param {Rng} r */
  const beta = (a, b, r) => {
    const x = gamma(a, r);
    return x / (x + gamma(b, r));
  };
  /** Index drawn with probability proportional to its weight. Zero, negative and non-finite weights are never
   * drawn; if none is positive, every index is equally likely. @param {number[]} weights @param {Rng} r */
  function pick(weights, r) {
    let s = 0,
      last = -1;
    for (let i = 0; i < weights.length; i++)
      if (weights[i] > 0 && weights[i] < Infinity) {
        s += weights[i];
        last = i;
      }
    const u = r();
    if (last < 0) return Math.min(weights.length - 1, Math.floor(u * weights.length));
    let x = u * s;
    for (let i = 0; i < last; i++) {
      if (!(weights[i] > 0 && weights[i] < Infinity)) continue;
      x -= weights[i];
      if (x < 0) return i;
    }
    return last;
  }

  /* ---------- circuits ---------- */
  /** Track-type features of a meeting, from config/season.json circuits (first name fragment that matches).
   * @param {string} name @param {SeasonCfg} [cfg] @returns {Circuit} */
  function circuitFor(name, cfg) {
    const n = (name || "").toLowerCase();
    const hit = ((cfg && cfg.circuits && cfg.circuits.list) || []).find(([k]) => n.includes(k));
    const base = { ...DEFAULT_CIRCUIT, rain: {}, feat: DEFAULT_CIRCUIT.feat.slice() };
    return hit ? { ...base, feat: hit[1].slice(), note: hit[2] } : base;
  }
  // kept for older callers: how much the grid (vs race pace) decides the finish, from an overtaking multiplier
  const gridFromOv = (/** @type {number} */ ov) => clamp(0.62 - 0.25 * (ov - 1), 0.25, 0.92);
  // cost of a grid slot (% of race pace) from the grid-finish rank correlation expected at a circuit
  const tauFor = (/** @type {number} */ grid) => {
    const odds = (/** @type {number} */ g) => clamp(g, 0.2, 0.95) / (1 - clamp(g, 0.2, 0.95));
    return SIM.tau * Math.pow(odds(grid) / odds(DEFAULT_CIRCUIT.grid), 0.8);
  };

  /** This season's per-round numbers the track model is fitted on (keyed by gameday).
   * @param {Data} data */
  function seasonRounds(data) {
    /** @type {Record<number, { ov: number | null, move: number | null, dnf: number, corr: number | null, sc: number | null, rain: number | null }>} */
    const out = {};
    for (const gd of data.done || []) {
      const rows = (data.results.race[gd] || []).slice();
      if (!rows.length) continue;
      const cls = rows.filter((x) => x.cls && x.grid);
      const ts = data.trackStats && data.trackStats[gd];
      const info = data.raceInfo && data.raceInfo[gd] && data.raceInfo[gd].race;
      const moves = cls.map((x) => Math.abs(/** @type {number} */ (x.grid) - x.pos));
      out[gd] = {
        ov: ts ? ts.ovt : null,
        move: moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null,
        dnf: rows.filter((x) => !x.cls && !x.dsq).length / rows.length,
        corr: spearman(
          cls.map((x) => /** @type {number} */ (x.grid)),
          cls.map((x) => x.pos),
        ),
        sc: info ? (info.sc > 0 ? 1 : 0) : null,
        rain: info ? info.rain : null,
      };
    }
    return out;
  }
  /** @param {number[]} xs @param {number[]} ys */
  function spearman(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const rk = (/** @type {number[]} */ v) => {
      const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(n);
      o.forEach(([, i], k) => (r[i] = k));
      return r;
    };
    const a = rk(xs),
      b = rk(ys),
      m = (n - 1) / 2;
    let num = 0,
      da = 0,
      db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - m) * (b[i] - m);
      da += (a[i] - m) ** 2;
      db += (b[i] - m) ** 2;
    }
    return num / Math.sqrt(da * db);
  }

  /* Track model. Past seasons at each circuit (data.priors, from priors.py: overtakes, position changes,
     retirements, grid-finish correlation, safety cars, rain) give a prior per circuit, recency-weighted and shrunk to
     the all-circuit average; a circuit with no history gets the average of circuits with similar features. This
     season's finished rounds then set a TREND: how this season compares with those same circuits' priors (e.g. 1.3x
     the position changes or retirements under new rules), shrunk towards no change while few rounds have run, and
     applied to the circuits still to come. Fantasy overtake points have no past-season equivalent (OpenF1 counts
     every pass, pit cycles included), so their level is this season's own and the priors only say which circuits see
     more or fewer. What the trend leaves unexplained is regressed on track features (power / street / fast corners).
     The trend restarts with each season (it only uses this season's rounds; priors.py adds the finished season to
     the history). Without priors, the old feature-only fit on this season is used. */
  let TRACK = {
    ovLambda: 0.5, // backtested (LOO): ridge on features for overtakes
    dnfLambda: 2, // backtested (LOO): retirements
    teamPace: false, // backtested: team-specific track pace is off (no better than none)
    teamLambda: 8,
    minRounds: 6,
    teamShiftMax: 1.5,
    priorDecay: 0.8, // hand-set: weight of a past season per year back
    priorShrink: 2, // hand-set: pseudo-races of the all-circuit average in a circuit's prior
    trendShrink: 3, // hand-set: pseudo-rounds of "no change" in this season's trend
    // backtested (leave-one-round-out, backtest section 2): weight of each circuit's own past profile against this
    // season's average (0 = every circuit the same, 1 = the full past profile)
    alpha: { ov: 0, dnf: 1, sc: 0, corr: 0 },
    // the round's overtake level from the track's average speed (circuit length / practice reference lap): log
    // overtakes per starter regressed on it over this season's rounds (ridge on the standardised speed), applied to
    // the next race once its practice has run. Needs speedMin rounds with a reference lap.
    // Backtested 2026-09-25 (section 9 paired, R5-R14): CRPS -0.21 +/- 0.12, MAE -0.34, round overtake level error
    // -0.31 (item 9 stage 2). A track with no practice yet (races after the next) keeps the flat season level.
    speed: true,
    speedLambda: 2, // backtested: 2 best CRPS; 5 ties (-0.19); 0 worse in leave-one-out
    speedMin: 5,
    speedVar: 0, // 0: the fitted median level; 1: the mean (adds half the residual variance on the log scale)
    // the season's overtake level weighted towards recent rounds (half-life in rounds; Infinity = every round the same).
    // Challenger from review batch 2 (2026-09-27): R1-R4 had far more overtaking than later rounds.
    ovHalfLife: Infinity,
  };
  /** Recency weights for this season's rounds (half-life hl rounds before the last), scaled to average 1.
   * @param {number[]} gds @param {number} hl @returns {number[]} */
  function recencyWeights(gds, hl) {
    if (!gds.length || !Number.isFinite(hl)) return gds.map(() => 1);
    const last = Math.max(...gds);
    const w = gds.map((g) => Math.pow(0.5, (last - g) / hl));
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    return w.map((v) => v / m);
  }
  /** Per-circuit priors from past seasons (data.priors, from priors.py): each measure recency-weighted and shrunk to
   * the all-circuit average; a circuit with no history gets the average of circuits with similar features.
   * @param {PriorRow[] | null} P @param {(name: string) => number[]} featOf @param {typeof TRACK} o */
  function circuitPriors(P, featOf, o) {
    /** @type {Record<string, (x: PriorRow) => number | null>} */
    const METRIC = {
      ov: (x) => x.ovt ?? null, // OpenF1 overtakes per starter (2023 on); `move` stands in before that (scaled below)
      move: (x) => x.move,
      dnf: (x) => (x.starters ? x.dnf / x.starters : null),
      corr: (x) => x.gridCorr,
      sc: (x) => (x.sc == null ? null : x.sc > 0 ? 1 : 0),
      rain: (x) => x.rain ?? null,
    };
    let lastSeason = 0;
    for (const x of P || []) lastSeason = Math.max(lastSeason, x.season);
    // overtakes: past races without an OpenF1 count use mean |grid-finish| x (overtakes per unit of it)
    let ovPerMove = 1;
    if (P) {
      let a = 0,
        b = 0;
      for (const x of P)
        if (x.ovt != null && x.move != null) {
          a += x.ovt;
          b += x.move;
        }
      if (b > 0) ovPerMove = a / b;
    }
    const val = (/** @type {string} */ m, /** @type {PriorRow} */ x) =>
      m === "ov" ? (x.ovt != null ? x.ovt : x.move != null ? x.move * ovPerMove : null) : METRIC[m](x);
    /** @type {Record<string, number>} */
    const globalMean = {};
    for (const m of ["ov", "move", "dnf", "corr", "sc", "rain"]) {
      let s = 0,
        w = 0;
      for (const x of P || []) {
        const v = val(m, x);
        if (v == null) continue;
        const k = Math.pow(o.priorDecay, lastSeason - x.season);
        s += k * v;
        w += k;
      }
      globalMean[m] = w ? s / w : NaN;
    }
    const nameOf = /** @type {Record<string, string>} */ ({});
    for (const x of P || []) nameOf[x.circuit] = x.circuit + " " + x.name;
    // circuits that have history, for the feature fallback
    const known = [...new Set((P || []).map((x) => x.circuit))];
    /** @type {Record<string, Record<string, number | null>>} */
    const priorCache = {};
    /** @param {string | undefined} cid @param {string} name */
    const priorOf = (cid, name) => {
      const key = cid || "?" + name;
      if (priorCache[key]) return priorCache[key];
      /** @type {Record<string, number | null>} */
      const out = {};
      for (const m of ["ov", "move", "dnf", "corr", "sc", "rain"]) {
        let s = 0,
          w = 0;
        for (const x of P || []) {
          if (x.circuit !== cid) continue;
          const v = val(m, x);
          if (v == null) continue;
          const k = Math.pow(o.priorDecay, lastSeason - x.season);
          s += k * v;
          w += k;
        }
        const g = globalMean[m];
        if (!Number.isFinite(g)) out[m] = null;
        else if (w > 0) out[m] = (s + o.priorShrink * g) / (w + o.priorShrink);
        else out[m] = featurePrior(m, name);
      }
      out.n = (P || []).filter((x) => x.circuit === cid).length;
      return (priorCache[key] = out);
    };
    // a new circuit: the average of known circuits' priors, adjusted by track features (ridge)
    /** @type {Record<string, { b: number[], mean: number[], y: number }>} */
    const featFit = {};
    /** @param {string} m @param {string} name */
    function featurePrior(m, name) {
      const g = globalMean[m];
      if (!known.length) return g;
      if (!featFit[m]) {
        const rows = known
          .map((c) => {
            let s = 0,
              w = 0;
            for (const x of P || []) {
              if (x.circuit !== c) continue;
              const v = val(m, x);
              if (v == null) continue;
              s += v;
              w++;
            }
            return w ? { f: featOf(nameOf[c]), y: s / w } : null;
          })
          .filter((x) => x != null);
        const mean = [0, 1, 2].map((j) => rows.reduce((a, r) => a + r.f[j], 0) / (rows.length || 1));
        const my = rows.reduce((a, r) => a + r.y, 0) / (rows.length || 1);
        const b =
          rows.length >= 6
            ? ridge(
                rows.map((r) => r.f.map((v, j) => v - mean[j])),
                rows.map((r) => r.y - my),
                2,
                `circuit features: ${m}`,
              )
            : [0, 0, 0];
        featFit[m] = { b, mean, y: my };
      }
      const F = featFit[m],
        f = featOf(name);
      const v = F.y + F.b.reduce((s, bj, j) => s + bj * (f[j] - F.mean[j]), 0);
      return m === "corr" ? clamp(v, 0.2, 0.95) : Math.max(0, v);
    }
    return { globalMean, priorOf };
  }
  /** This season against the priors of the circuits raced so far: each measure's level and trend, and a circuit's own
   * profile relative to them. @param {ReturnType<typeof seasonRounds>} season @param {PriorRow[] | null} P
   * @param {(cid: string | undefined, name: string) => Record<string, number | null>} priorOf
   * @param {Record<string, number>} globalMean @param {(gd: number) => string | undefined} cid
   * @param {(gd: number) => string} nm @param {typeof TRACK} o */
  function seasonTrend(season, P, priorOf, globalMean, cid, nm, o) {
    const seasonMean = (/** @type {"ov" | "move" | "dnf" | "corr" | "sc"} */ m) => {
      const v = Object.values(season)
        .map((x) => x[m])
        .filter((x) => x != null);
      return v.length
        ? /** @type {number} */ (v.reduce((a, b) => /** @type {number} */ (a) + /** @type {number} */ (b), 0)) /
            v.length
        : NaN;
    };
    const ovGds = Object.keys(season)
      .map(Number)
      .filter((g) => season[g].ov != null);
    const ovW = recencyWeights(ovGds, o.ovHalfLife);
    const ovMean = Number.isFinite(o.ovHalfLife)
        ? ovGds.reduce((a, g, k) => a + ovW[k] * /** @type {number} */ (season[g].ov), 0) / (ovGds.length || NaN)
        : seasonMean("ov"),
      dnfMean = seasonMean("dnf"),
      corrMean = seasonMean("corr");
    // this season's level per measure, against the priors of the circuits raced so far. Ratio measures are shrunk
    // towards those priors (no change) with trendShrink pseudo-rounds; fantasy overtakes have no past equivalent,
    // so their level is this season's own.
    /** @type {Record<string, { L: number, pm: number, n: number }>} */
    const lvl = {};
    for (const m of /** @type {const} */ (["ov", "move", "dnf", "sc", "corr"])) {
      let so = 0,
        n = 0,
        sp = 0,
        np = 0;
      for (const gd of Object.keys(season).map(Number)) {
        const ob = season[gd][m];
        if (ob == null) continue;
        so += ob;
        n++;
        const pr = P ? priorOf(cid(gd), nm(gd))[m] : null;
        if (pr != null) {
          sp += pr;
          np++;
        }
      }
      const pm = np ? sp / np : globalMean[m];
      const L =
        m === "ov"
          ? n
            ? so / n
            : NaN
          : Number.isFinite(pm)
            ? (so + o.trendShrink * pm) / (n + o.trendShrink)
            : n
              ? so / n
              : NaN;
      lvl[m] = { L, pm, n };
    }
    const ratio = (/** @type {string} */ m) => (lvl[m].pm > 0 && Number.isFinite(lvl[m].L) ? lvl[m].L / lvl[m].pm : 1);
    /** @type {Record<string, number>} */
    const trend = {
      move: ratio("move"),
      dnf: ratio("dnf"),
      sc: ratio("sc"),
      corr: Number.isFinite(lvl.corr.L) && Number.isFinite(lvl.corr.pm) ? lvl.corr.L - lvl.corr.pm : 0,
    };
    /** @type {Record<string, number>} */
    const trendN = Object.fromEntries(Object.entries(lvl).map(([k, v]) => [k, v.n]));
    // a circuit's own profile relative to the circuits raced so far, weighted by alpha (0 = none, 1 = all of it)
    const prof = (/** @type {"ov" | "dnf" | "sc"} */ m, /** @type {number | null | undefined} */ pr) =>
      pr == null || !(lvl[m].pm > 0) ? 1 : Math.pow(Math.max(0.05, pr) / lvl[m].pm, o.alpha[m]);
    return { ovMean, dnfMean, corrMean, lvl, trend, trendN, prof };
  }
  /** Without priors: this season's rounds regressed on track features (overtakes and retirements).
   * @param {ReturnType<typeof seasonRounds>} season @param {number[]} rounds @param {PriorRow[] | null} P
   * @param {(name: string) => number[]} featOf @param {(gd: number) => string} nm @param {number} ovMean
   * @param {number} dnfMean @param {typeof TRACK} o */
  function featureResiduals(season, rounds, P, featOf, nm, ovMean, dnfMean, o) {
    // without priors: the old fit of this season's rounds on track features
    const fitted = rounds.length >= o.minRounds;
    const xcMean = [0, 1, 2].map((j) =>
      rounds.length ? rounds.reduce((a, r) => a + featOf(nm(r))[j], 0) / rounds.length : 0,
    );
    const xc = (/** @type {number[]} */ f) => f.map((v, j) => v - xcMean[j]);
    /** @param {"ov" | "dnf"} m @param {number} lam */
    const residFit = (m, lam) => {
      const X = [],
        y = [];
      for (const gd of rounds) {
        const ob = season[gd][m];
        if (ob == null) continue;
        const base = m === "ov" ? ovMean : dnfMean;
        if (!(base > 0)) continue;
        X.push(xc(featOf(nm(gd))));
        y.push(Math.log((ob + 0.02) / (base + 0.02)));
      }
      if (X.length < o.minRounds) return [0, 0, 0];
      const my = y.reduce((a, b) => a + b, 0) / y.length;
      return ridge(
        X,
        y.map((v) => v - my),
        lam,
        `season vs history: ${m}`,
      );
    };
    const bOv = fitted && !P ? residFit("ov", o.ovLambda * 8) : [0, 0, 0];
    const bDnf = fitted && !P ? residFit("dnf", o.dnfLambda * 8) : [0, 0, 0];
    return { fitted, xc, bOv, bDnf };
  }
  /** Overtakes under a safety car vs without (restarts), from past seasons. @param {PriorRow[] | null} P */
  function scOvertakes(P) {
    let scOv = 1.25;
    {
      let a = 0,
        na = 0,
        b = 0,
        nb = 0;
      for (const x of P || [])
        if (x.ovt != null && x.sc != null) {
          if (x.sc > 0) {
            a += x.ovt;
            na++;
          } else {
            b += x.ovt;
            nb++;
          }
        }
      if (na >= 5 && nb >= 5) scOv = clamp(a / na / (b / nb), 1, 2);
    }
    return scOv;
  }
  /** Team-specific pace by track features (off by default: no better than none in the backtest).
   * @param {Data} data @param {number[]} rounds @param {boolean} fitted @param {(f: number[]) => number[]} xc
   * @param {(name: string) => number[]} featOf @param {(gd: number) => string} nm @param {typeof TRACK} o */
  function teamTrackPace(data, rounds, fitted, xc, featOf, nm, o) {
    /** @type {Record<string, number[]>} */
    const bTeam = {};
    if (o.teamPace && fitted) {
      const teams = [
        ...new Set(
          Object.values(data.results.quali)
            .flat()
            .map((x) => x.team),
        ),
      ];
      for (const t of teams) {
        const rs = [],
          ys = [];
        for (const r of rounds) {
          const rows = (data.results.quali[r] || []).filter((x) => x.team === t);
          if (rows.length) {
            rs.push(r);
            ys.push(rows.reduce((a, b) => a + b.pos, 0) / rows.length);
          }
        }
        if (rs.length < o.minRounds) continue;
        const m = ys.reduce((a, b) => a + b, 0) / ys.length;
        bTeam[t] = ridge(
          rs.map((r) => xc(featOf(nm(r)))),
          ys.map((v) => v - m),
          o.teamLambda,
          `team by track type: ${t}`,
        );
      }
    }
    return bTeam;
  }
  /** The round's overtake level against the track's average speed (km/h): log overtakes per starter, ridge on the
   * standardised speed. Null with fewer than speedMin rounds. @param {ReturnType<typeof seasonRounds>} season
   * @param {number[]} rounds @param {Data} data @param {(gd: number) => string | undefined} cid
   * @param {(id: string | undefined, lap: number | null | undefined) => number | null} kmh @param {typeof TRACK} o */
  function speedFit(season, rounds, data, cid, kmh, o) {
    const pts = [];
    for (const gd of rounds) {
      const v = kmh(cid(gd), data.trackStats && data.trackStats[gd] && data.trackStats[gd].lap);
      const ob = season[gd].ov;
      if (v != null && ob != null && ob > 0) pts.push([v, Math.log(ob), gd]);
    }
    if (pts.length < o.speedMin) return null;
    // weighted least squares (weights 1 unless ovHalfLife is set), ridge on the standardised speed
    const w = recencyWeights(
      pts.map((p) => p[2]),
      o.ovHalfLife,
    );
    const W = w.reduce((a, b) => a + b, 0);
    const mx = pts.reduce((a, p, k) => a + w[k] * p[0], 0) / W,
      my = pts.reduce((a, p, k) => a + w[k] * p[1], 0) / W;
    const sx = Math.sqrt(pts.reduce((a, p, k) => a + w[k] * (p[0] - mx) ** 2, 0) / W) || 1;
    let sxy = 0,
      szz = 0;
    pts.forEach(([x, y], k) => {
      sxy += w[k] * ((x - mx) / sx) * (y - my);
      szz += w[k] * ((x - mx) / sx) ** 2;
    });
    const b = sxy / (szz + o.speedLambda);
    const res =
      pts.reduce((a, [x, y], k) => a + w[k] * (y - my - (b * (x - mx)) / sx) ** 2, 0) / Math.max(1, pts.length - 2);
    return { b, mx, sx, my, res, n: pts.length };
  }
  /** @param {Data} data @param {Partial<typeof TRACK> & { noPriors?: boolean }} [opt] */
  function trackModel(data, opt) {
    const o = { ...TRACK, ...opt };
    const byGd = Object.fromEntries(data.schedule.map((g) => [g.gd, g]));
    const season = seasonRounds(data);
    const rounds = Object.keys(season)
      .map(Number)
      .filter((gd) => season[gd].ov != null);
    // the season's spread of log overtakes between rounds (the level's uncertainty for a race without practice)
    const logOv = rounds
      .map((gd) => /** @type {number} */ (season[gd].ov))
      .filter((v) => v > 0)
      .map(Math.log);
    const ovLogSd =
      logOv.length >= 4
        ? Math.sqrt(
            logOv.reduce((a, v) => a + (v - logOv.reduce((x, y) => x + y, 0) / logOv.length) ** 2, 0) /
              (logOv.length - 1),
          )
        : NaN;
    const P = !o.noPriors && data.priors && data.priors.races && data.priors.races.length ? data.priors.races : null;
    // features by circuit id and name (the id wins: 2026's "Bahrain GP" ran at Sepang)
    const featOf = (/** @type {string} */ name) => circuitFor(name, data.cfg).feat;

    // ---- per-circuit priors from past seasons
    const { globalMean, priorOf } = circuitPriors(P, featOf, o);

    // ---- this season vs the priors: trend per metric, residuals on features
    const cid = (/** @type {number} */ gd) => byGd[gd] && byGd[gd].circuit;
    const nm = (/** @type {number} */ gd) =>
      ((byGd[gd] && byGd[gd].circuit) || "") + " " + ((byGd[gd] && byGd[gd].name) || "");
    const { ovMean, dnfMean, corrMean, lvl, trend, trendN, prof } = seasonTrend(
      season,
      P,
      priorOf,
      globalMean,
      cid,
      nm,
      o,
    );
    const { fitted, xc, bOv, bDnf } = featureResiduals(season, rounds, P, featOf, nm, ovMean, dnfMean, o);
    const scOv = scOvertakes(P);
    const bTeam = teamTrackPace(data, rounds, fitted, xc, featOf, nm, o);
    const dot = (/** @type {number[]} */ b, /** @type {number[]} */ x) => b[0] * x[0] + b[1] * x[1] + b[2] * x[2];

    // average speed (km/h) -> the round's overtake level
    const km = (data.cfg && data.cfg.circuits && data.cfg.circuits.km) || {};
    const kmh = (/** @type {string | undefined} */ id, /** @type {number | null | undefined} */ lap) =>
      id && km[id] && lap ? (km[id] * 3600) / lap : null;
    const nextGd = (data.schedule.find((x) => !(data.done || []).includes(x.gd)) || {}).gd;
    const sp = speedFit(season, rounds, data, cid, kmh, o);
    const scAt = scOnsets(P, data);

    return {
      fitted: fitted || !!P,
      priors: !!P,
      rounds: rounds.length,
      ovMean,
      dnfMean,
      corrMean,
      trend,
      trendN,
      speed: sp,
      /** @param {Gameday | string} g the gameday (with its circuit id) or just a meeting name @returns {Circuit} */
      forCircuit(g) {
        const name = typeof g === "string" ? g : g.name,
          id = typeof g === "string" ? undefined : g.circuit;
        const c = circuitFor((id || "") + " " + name, data.cfg);
        c.id = id;
        const x = xc(c.feat);
        const pr = P ? priorOf(id, (id || "") + " " + name) : null;
        c.prior = pr || undefined;
        const ovBase = Number.isFinite(ovMean) ? ovMean : 4;
        c.ovMean = ovBase;
        if (pr) {
          // this season's level x the circuit's past profile (weighted by alpha)
          c.ov = clamp(prof("ov", pr.ov), 0.25, 2.5);
          if (Number.isFinite(lvl.dnf.L) && dnfMean > 0)
            c.chaos = clamp((lvl.dnf.L * prof("dnf", pr.dnf)) / dnfMean, 0.5, 1.8);
          if (Number.isFinite(lvl.corr.L))
            c.grid = clamp(lvl.corr.L + o.alpha.corr * ((pr.corr ?? lvl.corr.pm) - lvl.corr.pm), 0.25, 0.95);
          if (Number.isFinite(lvl.sc.L)) c.sc = clamp(lvl.sc.L * prof("sc", pr.sc), 0.05, 0.95);
        } else {
          if (fitted) c.ov = clamp(Math.exp(dot(bOv, x)), 0.3, 2);
          if (fitted) c.chaos = clamp(Math.exp(dot(bDnf, x)), 0.6, 1.6);
          c.grid = Number.isFinite(corrMean) ? clamp(corrMean, 0.25, 0.95) : gridFromOv(c.ov);
        }
        // the next race, once practice has run: overtake level from the track's average speed
        const lap = typeof g !== "string" && g.gd === nextGd ? practiceRef(data.practice) : null;
        const v = kmh(id, lap);
        if (v != null) c.kmh = Math.round(v * 10) / 10;
        // for the lap-by-lap race: laps (305 km) and a lap time (practice, else the season's average speed)
        const kmC = id ? km[id] : undefined;
        if (kmC) c.laps = Math.max(10, Math.round(305 / kmC));
        c.lapT = lap || (kmC && sp ? (kmC * 3600) / sp.mx : 90);
        if (o.speed && sp && v != null && Number.isFinite(ovMean) && ovMean > 0)
          c.ov = clamp(Math.exp(sp.my + (sp.b * (v - sp.mx)) / sp.sx + (o.speedVar * sp.res) / 2) / ovMean, 0.25, 2.5);
        // how far a race's overtaking strays from its forecast level (log sd): the speed fit's residual where it
        // applies, else the season's spread between rounds (SIM.ovEnv draws it once a weekend)
        c.ovSd =
          o.speed && sp && v != null ? Math.sqrt(Math.max(0, sp.res)) : Number.isFinite(ovLogSd) ? ovLogSd : 0.35;
        c.rain = { r: pr && pr.rain != null ? clamp(pr.rain, 0.02, 0.8) : 0.1 };
        c.rain.q = c.rain.r;
        c.rain.s = c.rain.r;
        c.scOv = scOv;
        if (SIM.scTimed && scAt.length) c.scAt = scAt; // only for the timed safety car: the shipped circuit unchanged
        c.teamShift = Object.fromEntries(
          Object.entries(bTeam).map(([t, b]) => [t, clamp(dot(b, x), -o.teamShiftMax, o.teamShiftMax)]),
        );
        return c;
      },
    };
  }
  /** When races' last safety car came, as the share of the race run (rounded to 0.01): every dry, unflagged past
   * race with one (priors, OpenF1 2023 on) and this season's finished rounds (raceInfo; a walk-forward's data holds
   * only the rounds before). The timed safety car (SIM.scTimed) draws from them. Empty without timings.
   * @param {PriorRow[] | null} P @param {Data} data @returns {number[]} */
  function scOnsets(P, data) {
    /** @type {number[]} */
    const out = [];
    // dry races without a red flag only: the population the timing effect was fitted on (SIM.scTimeA / B)
    const add = (
      /** @type {{ scLaps?: (number | string | null)[][], lapsRun?: number, rain?: number, red?: number } | undefined} */ x,
    ) => {
      if (!x || x.rain || x.red || !x.scLaps || !x.scLaps.length || !x.lapsRun) return;
      const last = x.scLaps[x.scLaps.length - 1][0];
      if (typeof last === "number") out.push(Math.round(clamp(last / x.lapsRun, 0, 1) * 100) / 100);
    };
    for (const x of P || []) add(x);
    for (const ri of Object.values(data.raceInfo || {})) add(ri && ri.race);
    return out;
  }
  /** A weekend's practice reference lap (s): the fastest finished session's `ref` (practice.py ref_lap), else null.
   * @param {PracticeSession[] | undefined} sessions */
  function practiceRef(sessions) {
    const refs = (sessions || []).filter((p) => p.done && p.ref).map((p) => /** @type {number} */ (p.ref));
    return refs.length ? Math.min(...refs) : null;
  }
  /** A circuit with this weekend's forecast rain on top of its climatology (the forecast wins where it exists).
   * @param {Circuit} c @param {{ q?: number | null, s?: number | null, r?: number | null, ens?: { q?: number | null, r?: number | null, qr?: number | null } } | undefined} wx @returns {Circuit} */
  function withWeather(c, wx) {
    if (!wx) return c;
    const rain = { ...(c.rain || {}) };
    for (const k of /** @type {const} */ (["q", "s", "r"]))
      if (wx[k] != null) rain[k] = clamp(/** @type {number} */ (wx[k]), 0, 1);
    // how strongly the weekend's sessions share their weather: from the ECMWF ensemble's joint wet share for
    // qualifying and the race (collect.py), as a latent correlation (SIM.rainCorr when there's none)
    const e = wx.ens;
    if (e && e.q != null && e.r != null && e.qr != null) rain.rho = latentCorr(e.q, e.r, e.qr);
    return { ...c, rain };
  }
  /** Bivariate normal P(X <= a, Y <= b) with correlation rho (Owen's integral over the correlation, 16-point
   * Gauss-Legendre). @param {number} a @param {number} b @param {number} rho */
  function biNormCdf(a, b, rho) {
    const X = [
      0.0950125098, 0.2816035508, 0.4580167777, 0.6178762444, 0.7554044084, 0.8656312024, 0.9445750231, 0.989400935,
    ];
    const W = [
      0.1894506105, 0.182603415, 0.1691565194, 0.1495959888, 0.1246289713, 0.0951585117, 0.0622535239, 0.0271524594,
    ];
    let s = 0;
    for (let k = 0; k < 8; k++)
      for (const sg of [-1, 1]) {
        const r = (rho * (1 + sg * X[k])) / 2,
          q = 1 - r * r;
        s += (W[k] * Math.exp(-(a * a - 2 * r * a * b + b * b) / (2 * q))) / Math.sqrt(q);
      }
    return normCdf(a) * normCdf(b) + ((rho / 2) * s) / (2 * Math.PI);
  }
  /** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9 after one Newton step).
   * @param {number} p */
  function normInv(p) {
    const q = clamp(p, 1e-9, 1 - 1e-9);
    const a = [
      -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
      2.506628277459239,
    ];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [
      -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
      2.938163982698783,
    ];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    let x;
    if (q < lo) {
      const t = Math.sqrt(-2 * Math.log(q));
      x =
        (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) /
        ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
    } else if (q > 1 - lo) {
      const t = Math.sqrt(-2 * Math.log(1 - q));
      x =
        -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) /
        ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
    } else {
      const t = q - 0.5,
        u = t * t;
      x =
        ((((((a[0] * u + a[1]) * u + a[2]) * u + a[3]) * u + a[4]) * u + a[5]) * t) /
        (((((b[0] * u + b[1]) * u + b[2]) * u + b[3]) * u + b[4]) * u + 1);
    }
    return x;
  }
  /** The latent correlation that makes two events of chances p1, p2 happen together with chance p12 (a Gaussian
   * copula), clamped to [-0.5, 0.95]. @param {number} p1 @param {number} p2 @param {number} p12 */
  function latentCorr(p1, p2, p12) {
    const a = normInv(p1),
      b = normInv(p2);
    let lo = -0.5,
      hi = 0.95;
    if (p1 <= 0 || p2 <= 0 || p1 >= 1 || p2 >= 1) return SIM.rainCorr;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (biNormCdf(a, b, m) < p12) lo = m;
      else hi = m;
    }
    return Math.round(((lo + hi) / 2) * 100) / 100;
  }

  /* ---------- model: pace, reliability, overtaking, pit stops from this season's results ---------- */
  /** @typedef {{ id: string, tla: string, team: string, qPace: number, rPace: number, qSe: number, rSe: number, qMu: number, rMu: number, dnf: number, dnfInc?: number, dnfN: number, ov: number, ovU: number, practiceQ: number | null, practiceR: number | null, formQ: number, formR: number, oddsQ?: number, oddsR?: number, dotdPop?: number, flMk?: number }} DriverModel */
  /** Reliability: retirements per car-race (recency-weighted by dnfHalfLife), per team and grid-wide.
   * @param {Data} data @param {number[]} rounds @param {number} last @param {typeof MODEL} M */
  function reliability(data, rounds, last, M) {
    let gD = 0,
      gN = 0;
    /** @type {Record<string, number>} */
    const tD = {};
    /** @type {Record<string, number>} */
    const tN = {};
    // by cause: mechanical per team, incidents per driver
    let gM = 0,
      gI = 0;
    /** @type {Record<string, number>} */
    const tM = {};
    /** @type {Record<string, number>} */
    const dI = {};
    /** @type {Record<string, number>} */
    const dN = {};
    const dDecay = Math.pow(0.5, 1 / M.dnfHalfLife);
    for (const r of rounds) {
      const causes =
        (data.raceInfo && data.raceInfo[r] && data.raceInfo[r].race && data.raceInfo[r].race.retirements) || {};
      for (const row of data.results.race[r]) {
        const w = Math.pow(dDecay, last - r);
        gN += w;
        tN[row.team] = (tN[row.team] || 0) + w;
        dN[row.tla] = (dN[row.tla] || 0) + w;
        // a disqualified car ran the race: not a retirement (Jolpica "Disqualified"; 2026: BOR R4)
        if (!row.cls && !row.dsq) {
          gD += w;
          tD[row.team] = (tD[row.team] || 0) + w;
          if ((causes[row.tla] || {}).cause === "incident") {
            gI += w;
            dI[row.tla] = (dI[row.tla] || 0) + w;
          } else {
            gM += w;
            tM[row.team] = (tM[row.team] || 0) + w;
          }
        }
      }
    }
    const gRate = gN ? gD / gN : M.dnfFallback;
    // the field's split of the fallback before any race: an eighth incidents (2026: 10 of 66)
    const gMech = gN ? gM / gN : M.dnfFallback * 0.85,
      gInc = gN ? gI / gN : M.dnfFallback * 0.15;
    return { tD, tN, gRate, tM, dI, dN, gMech, gInc };
  }
  /** The race block's contextual pace MODEL.racePace picks: "ctx" = the race-alone lap model (paceCtx), "pool" = the
   * same with its tyre / fuel / traffic terms pooled across the rounds up to it (pacePool, laps.py pool_rounds);
   * "median" (none) = the median clean lap. @param {typeof MODEL} M */
  const ctxKey = (M) => (M.racePace === "ctx" ? "paceCtx" : M.racePace === "pool" ? "pacePool" : null);
  /** A round's contextual race pace as MODEL.racePace picks it, with the standard errors that go with it: the
   * race-alone fit's paceSe for "ctx"; the pooled fit's own cluster-robust paceSePool for "pool" (fifth review: not
   * a borrowed one). None when the round's lap records failed the FastF1 check (lapCheck.ok false: whatever was
   * derived from them no longer counts, stale or not). A driver without a standard error isn't used (the median
   * clean lap stands). @param {RaceBlock | undefined} b @param {typeof MODEL} M */
  function ctxPace(b, M) {
    const k = ctxKey(M);
    if (!b || !k || (b.lapCheck && b.lapCheck.ok === false)) return null;
    const pace = b[k],
      se = k === "paceCtx" ? b.paceSe : b.paceSePool;
    return pace && se ? { pace, se, inflate: k === "paceCtx" ? M.ctxSeInflate : 1 } : null;
  }
  /** A round's race pace per driver (% off the fastest) as MODEL.racePace picks it. @param {Data} data
   * @param {number} r @param {typeof MODEL} M @returns {Record<string, number>} */
  function racePaceOf(data, r, M) {
    const b = data.raceInfo && data.raceInfo[r] && data.raceInfo[r].race;
    if (!b) return {};
    const c = ctxPace(b, M);
    if (!c) return b.pace || {};
    /** @type {Record<string, number>} */
    const out = { ...b.pace };
    for (const [t, v] of Object.entries(c.pace)) if (c.se[t] != null) out[t] = v;
    return out;
  }
  /** How much a round's race pace for a driver counts (1, or less for a contextual estimate with a wide standard
   * error, MODEL.ctxTau; the race-alone fit's errors are inflated by ctxSeInflate for laps correlated within a
   * stint, the pooled fit's are cluster-robust already). @param {Data} data @param {number} r @param {string} tla
   * @param {typeof MODEL} M */
  function racePaceWeight(data, r, tla, M) {
    const b = data.raceInfo && data.raceInfo[r] && data.raceInfo[r].race;
    const c = ctxPace(b, M);
    const se = c && c.pace[tla] != null && c.se[tla] != null ? c.se[tla] : null;
    if (se == null || !c) return 1;
    const t2 = M.ctxTau * M.ctxTau,
      e = c.inflate * se;
    return t2 / (t2 + e * e);
  }
  /** Each driver's pace observations: % off the fastest in qualifying (lap times) and race (median clean lap; else
   * finishing order), recency-weighted, for rounds driven for his current team.
   * @param {Data} data @param {Asset[]} drivers @param {number[]} rounds @param {number} last @param {number} decay
   * @param {typeof MODEL} M @param {(v: number) => number} cap @param {number} F */
  function paceObservations(data, drivers, rounds, last, decay, M, cap, F) {
    const raw = drivers.map((a) => {
      let qs = 0,
        qw = 0,
        qw2 = 0,
        rs = 0,
        rw = 0,
        rw2 = 0;
      /** @type {[number, number][]} */
      const qObs = [],
        rObs = [];
      for (const r of rounds) {
        const w = Math.pow(decay, last - r);
        const rows = data.results.race[r] || [];
        const race = rows.find((x) => x.tla === a.tla);
        const q = (data.results.quali[r] || []).find((x) => x.tla === a.tla);
        const same = (race && race.team === a.team) || (q && q.team === a.team);
        if (!same) continue;
        if (q && q.gap != null) {
          const g = cap(q.gap);
          qs += w * g;
          qw += w;
          qw2 += w * w;
          qObs.push([w, g]);
        } else if (q && q.gap === undefined) {
          // older data without lap times: qualifying rank on the rank scale
          const g = cap((q.pos - 1) * M.rankSlope);
          qs += w * g;
          qw += w;
          qw2 += w * w;
          qObs.push([w, g]);
        }
        const lap = racePaceOf(data, r, M)[a.tla];
        let rg = null,
          wr = w;
        if (lap != null) {
          rg = cap(lap);
          wr = w * racePaceWeight(data, r, a.tla, M);
        } else if (race && race.cls) {
          const ncls = rows.filter((x) => x.cls).length || F;
          rg = cap((((race.pos - 0.5) / ncls) * F - 0.5) * M.rankSlope);
        }
        if (rg != null) {
          rs += wr * rg;
          rw += wr;
          rw2 += wr * wr;
          rObs.push([wr, rg]);
        }
      }
      return { a, qs, qw, qw2, rs, rw, rw2, qObs, rObs };
    });
    return raw;
  }
  /** Pace means (mixed with the team-mate, or car + driver offset), shrunk to the field median; the % per grid place
   * and the uncertainty of each mean. @param {ReturnType<typeof paceObservations>} raw @param {Data} data
   * @param {Asset[]} drivers @param {number[]} rounds @param {number} last @param {number} decay
   * @param {typeof MODEL} M @param {(v: number) => number} cap @param {number} F */
  function paceEstimates(raw, data, drivers, rounds, last, decay, M, cap, F) {
    /** @type {Record<string, { qs: number, qw: number, rs: number, rw: number }>} */
    const team = {};
    for (const d of raw) {
      const t = team[d.a.team] || (team[d.a.team] = { qs: 0, qw: 0, rs: 0, rw: 0 });
      t.qs += d.qs;
      t.qw += d.qw;
      t.rs += d.rs;
      t.rw += d.rw;
    }
    const P = M.prior;
    const paceQ = raw.map((d) => {
      const t = team[d.a.team];
      return (d.qs + P * (t.qw ? t.qs / t.qw : M.defaultGap)) / (d.qw + P);
    });
    const paceR = raw.map((d) => {
      const t = team[d.a.team];
      return (d.rs + P * (t.rw ? t.rs / t.rw : M.defaultGap)) / (d.rw + P);
    });
    if (M.mate === "car") {
      const car = carPlusOffset(data, drivers, rounds, last, decay, M, cap, F);
      drivers.forEach((a, i) => {
        paceQ[i] = car.q[i];
        paceR[i] = car.r[i];
      });
    }
    // regression to the mean: past gaps overstate how far apart cars will be (luck in the average), so each is
    // pulled towards the field's median by paceShrink
    for (const arr of [paceQ, paceR]) {
      const med = quantile(arr, 0.5);
      for (let i = 0; i < arr.length; i++) arr[i] = med + M.paceShrink * (arr[i] - med);
    }
    // % per grid place across the field (turns nudges in places into %)
    const spread = (/** @type {number[]} */ v) => (quantile(v, 0.85) - quantile(v, 0.15)) / (0.7 * (F - 1));
    const slopeQ = spread(paceQ) > 0 ? spread(paceQ) : M.rankSlope,
      slopeR = spread(paceR) > 0 ? spread(paceR) : M.rankSlope;
    // uncertainty of each mean: pooled round-to-round spread / sqrt(effective races + prior)
    const pooled = (/** @type {"qObs" | "rObs"} */ k, /** @type {number[]} */ mu) => {
      let s = 0,
        w = 0;
      raw.forEach((d, i) =>
        d[k].forEach(([wk, g]) => {
          s += wk * (g - mu[i]) ** 2;
          w += wk;
        }),
      );
      return w ? Math.sqrt(s / w) : 0.4;
    };
    const sdQ = pooled("qObs", paceQ),
      sdR = pooled("rObs", paceR);
    return { paceQ, paceR, slopeQ, slopeR, sdQ, sdR };
  }
  /** Practice pace for this weekend: short runs into qualifying pace, long runs into race pace, both as % gaps
   * relative to the field (practice runs spread wider, so they're rescaled to the model's spread first); then each
   * driver's expected finishing positions. @param {DriverModel[]} dModels
   * @param {{ practice?: PracticeSession[], practiceWeight: number }} o @param {number} F @param {typeof MODEL} M */
  function applyPractice(dModels, o, F, M) {
    const pr = practiceRanks(
      o.practice || [],
      dModels.map((d) => d.tla),
      F,
      M,
    );
    const wq = Math.min(1, M.practiceQ * o.practiceWeight),
      wr = Math.min(1, M.practiceR * o.practiceWeight);
    /** @param {Record<string, number>} gaps @param {"qPace" | "rPace"} k @param {number} w */
    const blendPractice = (gaps, k, w) => {
      const ds = dModels.filter((d) => gaps[d.tla] != null);
      if (ds.length < M.practiceMinDrivers || !w) return;
      const pg = ds.map((d) => gaps[d.tla]),
        mg = ds.map((d) => d[k]);
      const iqr = (/** @type {number[]} */ v) => quantile(v, 0.75) - quantile(v, 0.25);
      const scale = iqr(pg) > 0 ? iqr(mg) / iqr(pg) : 1;
      const pm = quantile(pg, 0.5),
        mm = quantile(mg, 0.5);
      for (const d of ds) {
        const target = (gaps[d.tla] - pm) * scale,
          now = d[k] - mm;
        d[k] += w * clamp(target - now, -M.practicePull, M.practicePull);
      }
    };
    blendPractice(pr.gapQ, "qPace", wq);
    blendPractice(pr.gapR, "rPace", wr);
    for (const d of dModels) {
      d.practiceQ = pr.q[d.tla] ?? null;
      d.practiceR = pr.r[d.tla] ?? null;
    }
    finishPositions(dModels);
  }
  /** Pit stops: the team's actual pit-stop scoring lines (band points + fastest-stop bonus) over its recent races,
   * resampled. Real stop times (OpenF1, kept in raceInfo) match the bands only ~2/3 of the time: they're rounded
   * and aren't DHL's official timing. Without scoring lines: the points left over from the constructor's race
   * score (bias-corrected for the floor at 0). @param {Data} data @param {Asset[]} cons @param {typeof MODEL} M */
  function constructorModels(data, cons, M) {
    const pitIdx = new Set(
      (data.evNames || []).map((e, i) => (/^R (FP|FP2|WRFP|PIT)$/.test(e.c) ? i : -1)).filter((i) => i >= 0),
    );
    // the fastest stop of the race: exactly one team a race (2026 lines, checked R1-R15)
    const bonusIdx = new Set((data.evNames || []).map((e, i) => (e.c === "R FP2" ? i : -1)).filter((i) => i >= 0));
    /** @type {ConsModel[]} */
    const cModels = cons.map((c) => {
      /** @type {number[]} */
      const lines = [];
      /** @type {number[]} the same without the fastest-stop bonus */
      const bands = [];
      let bonuses = 0;
      for (const h of c.hist)
        if (h && h.ev && h.ev.length && data.results.race[h.gd]) {
          lines.push(h.ev.reduce((s, [i, v]) => s + (pitIdx.has(i) ? v : 0), 0));
          bands.push(h.ev.reduce((s, [i, v]) => s + (pitIdx.has(i) && !bonusIdx.has(i) ? v : 0), 0));
          bonuses += h.ev.some(([i]) => bonusIdx.has(i)) ? 1 : 0;
        }
      /** @type {number[]} */
      const res = [];
      c.hist.forEach((h, i) => {
        if (!h || h.r == null) return;
        let s = 0;
        for (const d of data.assets) {
          if (d.kind !== "D") continue;
          const dh = d.hist[i];
          if (dh && dh.team === c.team && dh.r != null) s += dh.r;
        }
        res.push(h.r - s);
      });
      const recent = res.slice(-M.pitRecent);
      const m = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 3;
      const sd = recent.length > 1 ? Math.sqrt(recent.reduce((a, b) => a + (b - m) ** 2, 0) / (recent.length - 1)) : 4;
      const sdC = clamp(sd, SIM.pitSd[0], SIM.pitSd[1]);
      return {
        id: c.id,
        team: c.team,
        pitMu: floorMean(Math.max(0, m + M.pitDotd), sdC),
        pitSd: sdC,
        stops: pitIdx.size ? lines.slice(-M.pitRecent) : [],
        bands: bonusIdx.size ? bands.slice(-M.pitRecent) : [],
        bonusW: bonuses + M.pitBonusPrior,
      };
    });
    return cModels;
  }
  /** @typedef {{ id: string, team: string, pitMu: number, pitSd: number, stops: number[], bands?: number[], bonusW?: number }} ConsModel stops = recent races' pit points (bands: without the fastest-stop bonus) */
  /** @typedef {{ drivers: DriverModel[], cons: ConsModel[], gRate: number, field: number, ovB: number[], ovRet?: { b: number, phi: number, share: number[] }, oddsFit?: { iters: number, n: number, resid: number[], noise: number, lastStep: number, targets: Record<string, Record<string, [number, number]>> }, ovSprint: number, slopeQ: number, slopeR: number }} Model */
  /**
   * @param {Data} data
   * @param {{ halfLife?: number, adj?: Record<string, number>, practice?: PracticeSession[], practiceWeight?: number, teamShift?: Record<string, number>, paceShift?: Record<string, number>, model?: Partial<typeof MODEL> }} [opt]
   *   opt.model overrides MODEL settings (the backtests use it to try other values)
   * @returns {Model}
   */
  function buildModel(data, opt) {
    const o = { halfLife: 4, adj: {}, practice: [], practiceWeight: 1, teamShift: {}, ...opt };
    const M = { ...MODEL, ...(opt && opt.model) };
    /** @type {Record<string, number>} */
    const adjBy = o.adj;
    /** @type {Record<string, number>} */
    const shiftBy = o.teamShift;
    const F = fieldOf(data);
    const decay = Math.pow(0.5, 1 / o.halfLife);
    const drivers = data.assets.filter((a) => a.kind === "D" && a.active);
    const cons = data.assets.filter((a) => a.kind === "C");
    const rounds = Object.keys(data.results.race)
      .map(Number)
      .sort((a, b) => a - b);
    const last = rounds.length ? rounds[rounds.length - 1] : 0;

    const { tD, tN, gRate, tM, dI, dN, gMech, gInc } = reliability(data, rounds, last, M);
    const cap = (/** @type {number} */ v) => Math.min(M.gapCap, Math.max(0, v));
    const raw = paceObservations(data, drivers, rounds, last, decay, M, cap, F);
    const { paceQ, paceR, slopeQ, slopeR, sdQ, sdR } = paceEstimates(
      raw,
      data,
      drivers,
      rounds,
      last,
      decay,
      M,
      cap,
      F,
    );
    const P = M.prior;

    /** @type {DriverModel[]} */
    const dModels = raw.map((d, i) => {
      const nq = d.qw2 ? (d.qw * d.qw) / d.qw2 : 0,
        nr = d.rw2 ? (d.rw * d.rw) / d.rw2 : 0;
      // + adj = faster (grid places); the track shift is + = slower
      const nudge = (adjBy[d.a.id] || 0) - (shiftBy[d.a.team] || 0);
      const n = tN[d.a.team] || 0;
      const inc = ((dI[d.a.tla] || 0) + M.incShrink * gInc) / ((dN[d.a.tla] || 0) + M.incShrink);
      return {
        id: d.a.id,
        tla: d.a.tla,
        team: d.a.team,
        qPace: paceQ[i] - nudge * slopeQ + M.bandQ * ((o.paceShift || {})[d.a.team] || 0),
        rPace: paceR[i] - nudge * slopeR + M.bandR * ((o.paceShift || {})[d.a.team] || 0),
        qSe: sdQ / Math.sqrt(nq + P),
        rSe: sdR / Math.sqrt(nr + P),
        qMu: 0,
        rMu: 0,
        dnf:
          M.dnfModel === "causes"
            ? ((tM[d.a.team] || 0) + M.dnfShrink * gMech) / (n + M.dnfShrink) + inc
            : ((tD[d.a.team] || 0) + M.dnfShrink * gRate) / (n + M.dnfShrink),
        dnfInc: M.dnfModel === "causes" ? inc : 0,
        dnfN: n + M.dnfShrink,
        ov: M.defaultOvertakes,
        ovU: 0,
        dotdPop: 1,
        practiceQ: null,
        practiceR: null,
        formQ: 0,
        formR: 0,
      };
    });
    const posQ = expectedPositions(
      dModels.map((d) => d.qPace),
      dModels.map((d) => d.team),
      SIM.qSd,
    );
    const posR = expectedPositions(
      dModels.map((d) => d.rPace),
      dModels.map((d) => d.team),
      SIM.rSd,
    );
    dModels.forEach((d, i) => {
      d.formQ = posQ[i];
      d.formR = posR[i];
    });
    applyPractice(dModels, o, F, M);

    // Overtakes: Poisson regression per driver-race on grid slot and places moved (gained or lost: in 2026 most
    // overtakes are swaps back and forth, so net places gained alone predicts little), with the round's overtaking
    // level as offset; plus each driver's own overtaking skill (shrunk). Sprint overtakes relative to the race's.
    const ovModel = fitOvertakes(data, F, M);
    for (const d of dModels) {
      const u = ovModel.skill[d.tla];
      d.ovU = u == null ? 0 : u;
      d.ov = ovModel.fallback[d.tla] ?? M.defaultOvertakes;
    }
    // Driver of the Day is a fan vote, not just results: each driver's votes won vs what his finishes would earn
    const pop = dotdPopularity(data, M);
    for (const d of dModels) d.dotdPop = pop[d.tla] ?? 1;
    const cModels = constructorModels(data, cons, M);
    return {
      drivers: dModels,
      cons: cModels,
      gRate,
      field: F,
      ovB: ovModel.b,
      ovRet: ovModel.ret,
      ovSprint: ovModel.sprint,
      slopeQ,
      slopeR,
    };
  }
  /** Pace as the car's plus the driver's offset to it (MODEL.mate "car"). The car: the mean gap of the team's cars
   * each round, recency-weighted like the blend. The offset: the driver's gap minus that mean in rounds where the
   * team had two cars with a time, with its own half-life and offPrior pseudo-rounds of zero (a rookie drives at
   * the car's pace). Uses every driver who raced for the team, so a replaced team-mate still informs the car.
   * @param {Data} data @param {Asset[]} drivers @param {number[]} rounds @param {number} last @param {number} decay
   * @param {typeof MODEL} M @param {(v: number) => number} cap @param {number} F */
  function carPlusOffset(data, drivers, rounds, last, decay, M, cap, F) {
    const offDecay = Math.pow(0.5, 1 / M.offHalfLife);
    /** @type {Record<string, { s: number, w: number }>[]} */
    const carAcc = [{}, {}];
    /** @type {Record<string, { s: number, w: number }>[]} */
    const offAcc = [{}, {}];
    for (const r of rounds) {
      const w = Math.pow(decay, last - r),
        wo = Math.pow(offDecay, last - r);
      const rows = data.results.race[r] || [],
        ncls = rows.filter((x) => x.cls).length || F;
      const lapPace = racePaceOf(data, r, M);
      /** @type {Record<string, [string, number][]>[]} team -> [tla, gap] for qualifying [0] and race [1] */
      const by = [{}, {}];
      for (const q of data.results.quali[r] || []) {
        const g = q.gap != null ? cap(q.gap) : q.gap === undefined ? cap((q.pos - 1) * M.rankSlope) : null;
        if (g != null) (by[0][q.team] = by[0][q.team] || []).push([q.tla, g]);
      }
      for (const row of rows) {
        const lap = lapPace[row.tla];
        const g = lap != null ? cap(lap) : row.cls ? cap((((row.pos - 0.5) / ncls) * F - 0.5) * M.rankSlope) : null;
        if (g != null) (by[1][row.team] = by[1][row.team] || []).push([row.tla, g]);
      }
      for (let k = 0; k < 2; k++)
        for (const [team, xs] of Object.entries(by[k])) {
          const mean = xs.reduce((s, x) => s + x[1], 0) / xs.length;
          const c = carAcc[k][team] || (carAcc[k][team] = { s: 0, w: 0 });
          c.s += w * mean;
          c.w += w;
          if (xs.length < 2) continue;
          for (const [tla, g] of xs) {
            const key = tla + "|" + team,
              o = offAcc[k][key] || (offAcc[k][key] = { s: 0, w: 0 });
            o.s += wo * (g - mean);
            o.w += wo;
          }
        }
    }
    const pace = (/** @type {number} */ k) =>
      drivers.map((a) => {
        const c = carAcc[k][a.team],
          o = offAcc[k][a.tla + "|" + a.team];
        return (c && c.w ? c.s / c.w : M.defaultGap) + (o ? o.s / (o.w + M.offPrior) : 0);
      });
    return { q: pace(0), r: pace(1) };
  }

  /** The mean of a normal whose rounded, floored-at-0 draws average `target` (the old pit model's floor pushed the
   * average up by ~0.6 pts). @param {number} target @param {number} sd */
  function floorMean(target, sd) {
    const e = (/** @type {number} */ mu) => {
      const z = mu / sd;
      return mu * normCdf(z) + (sd * Math.exp((-z * z) / 2)) / Math.sqrt(2 * Math.PI);
    };
    let lo = target - 4 * sd,
      hi = target;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (e(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  /** Expected finishing positions from pace (% gaps) with normal noise: 1 + sum of P(the other is ahead).
   * @param {number[]} pace @param {string[]} teams @param {number} sd */
  function expectedPositions(pace, teams, sd) {
    const within = Math.sqrt(2 * (sd * sd + SIM.drvSd * SIM.drvSd)),
      across = Math.sqrt(2 * (sd * sd + SIM.drvSd * SIM.drvSd + SIM.teamSd * SIM.teamSd));
    return pace.map((p, i) => {
      let e = 1;
      pace.forEach((q, j) => {
        if (j === i) return;
        const s = teams[i] === teams[j] ? within : across;
        // no noise at all: the faster car is ahead, a tie is a coin toss
        e += s > 0 ? normCdf((p - q) / s) : p > q ? 1 : p === q ? 0.5 : 0;
      });
      return e;
    });
  }
  /** Expected qualifying / race positions (qMu / rMu, what the Projections and Practice views show).
   * @param {DriverModel[]} ds */
  function finishPositions(ds) {
    const q = expectedPositions(
      ds.map((d) => d.qPace),
      ds.map((d) => d.team),
      SIM.qSd,
    );
    const r = expectedPositions(
      ds.map((d) => d.rPace),
      ds.map((d) => d.team),
      SIM.rSd,
    );
    ds.forEach((d, i) => {
      d.qMu = q[i];
      d.rMu = r[i];
    });
  }

  // Retired cars' overtakes before a season has 15 retirements to fit them: phi (hand-set, the reviewer's R1-R15
  // data points to about a third) and an even spread of how far into the race a retirement comes, one in ten a
  // car that doesn't start (-1)
  const RET_PHI = 0.3;
  const RET_SHARES = [-1, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  /** Overtake model from this season's scoring lines. @param {Data} data @param {number} F @param {typeof MODEL} M */
  function fitOvertakes(data, F, M) {
    /** @type {Record<string, number>} */
    const fallback = {};
    const names = data.evNames || [];
    const ovIdx = new Set(names.map((e, i) => (e.c === "R OV" ? i : -1)).filter((i) => i >= 0));
    const sOvIdx = new Set(names.map((e, i) => (e.c === "S OV" ? i : -1)).filter((i) => i >= 0));
    // points per driver per round: [race overtakes, sprint overtakes]
    /** @type {Record<string, Record<number, [number, number]>>} */
    const byTla = {};
    for (const a of data.assets) {
      if (a.kind !== "D") continue;
      for (const h of a.hist) {
        if (!h || !h.active || !h.ev || !(data.done || []).includes(h.gd)) continue;
        let ro = 0,
          so = 0;
        for (const [i, v] of h.ev) {
          if (ovIdx.has(i)) ro += v;
          else if (sOvIdx.has(i)) so += v;
        }
        (byTla[a.tla] ||= {})[h.gd] = [ro, so];
      }
    }
    // sprint overtakes per car relative to the race's, over sprint weekends
    let rs = 0,
      ss = 0;
    for (const t of Object.keys(byTla))
      for (const [gd, [ro, so]] of Object.entries(byTla[t]))
        if (data.results.sprint[gd]) {
          rs += ro;
          ss += so;
        }
    // it swings wildly between sprints (0.17-0.92 in 2026), so it's shrunk towards the hand-set share with three
    // pseudo-sprints of an average race's overtakes
    const nSpr = Object.keys(data.results.sprint || {}).filter((g) => (data.done || []).includes(+g)).length;
    const perSpr = nSpr ? rs / nSpr : 0;
    const sprint =
      rs > 0 ? clamp((ss + 3 * perSpr * M.sprintOvertakeShare) / (rs + 3 * perSpr), 0.15, 0.8) : M.sprintOvertakeShare;
    // fallback per-driver rate (season points per weekend) for drivers the regression can't cover
    for (const a of data.assets)
      if (a.kind === "D") {
        const wk = a.hist.filter((h) => h && h.active).length;
        if (wk)
          fallback[a.tla] =
            a.overtakePts / (wk + sprint * a.hist.filter((h) => h && h.active && data.results.sprint[h.gd]).length);
      }
    // Finishers: places moved and grid slot. Retired cars keep the overtakes they made before stopping (66
    // unclassified cars in R1-R15 scored 202 overtake points): their own intercept (column 4, places moved unknown)
    // and an exposure of phi + (1 - phi) x the share of the race they ran, phi being the part that doesn't wait for
    // laps (the start: cars out within 5 laps often had 3-6). A car that didn't start has none.
    /** @type {number[][]} */
    const X = [];
    /** @type {number[]} */
    const y = [];
    /** @type {number[]} */
    const off = [];
    /** @type {number[]} share of the race run (retired cars; -1 = finished) */
    const run = [];
    /** @type {string[]} */
    const who = [];
    /** @type {number[]} every retirement's share of the race run (-1 = didn't start), for the sim to draw from */
    const shares = [];
    for (const gd of data.done || []) {
      const rows = data.results.race[gd] || [];
      const lapsRun = rows.map((r) => r.laps ?? -1),
        full = Math.max(...lapsRun);
      for (const row of rows)
        if (!row.cls && !row.dsq && full > 0 && row.laps != null) shares.push(row.dns ? -1 : row.laps / full);
      const ts = data.trackStats && data.trackStats[gd];
      if (!ts || !(ts.ovt > 0)) continue;
      for (const row of rows) {
        if (!row.grid) continue;
        const ov = byTla[row.tla] && byTla[row.tla][gd];
        if (!ov) continue;
        if (row.cls) {
          X.push([1, Math.log1p(Math.abs(row.grid - row.pos)), (row.grid - 1) / (F - 1), 0]);
          run.push(-1);
        } else if (!row.dns && row.laps != null && full > 0) {
          X.push([1, 0, (row.grid - 1) / (F - 1), 1]);
          run.push(row.laps / full);
        } else continue;
        y.push(ov[0]);
        off.push(Math.log(ts.ovt));
        who.push(row.tla);
      }
    }
    const nRet = run.filter((v) => v >= 0).length;
    const ret = {
      b: 0,
      phi: RET_PHI,
      share: shares.length >= 10 ? shares : RET_SHARES,
    };
    if (X.length < 40)
      return {
        b: [0, 0, 0],
        ret,
        sprint,
        skill: /** @type {Record<string, number>} */ ({}),
        fallback,
        fitted: false,
      };
    const expo = (/** @type {number} */ phi) => run.map((f, n) => off[n] + (f < 0 ? 0 : Math.log(phi + (1 - phi) * f)));
    /** @param {number[]} o @param {number[][]} Xs @param {number[]} b */
    const logLik = (o, Xs, b) =>
      Xs.reduce((s, x, n) => {
        const eta = o[n] + x.reduce((t, v, j) => t + v * b[j], 0);
        return s + y[n] * eta - Math.exp(eta);
      }, 0);
    let b = [0, 0, 0, 0],
      oFit = off;
    if (nRet >= 15) {
      // phi by profile likelihood on a grid
      let best = -Infinity,
        note = null;
      for (let phi = 0; phi <= 0.801; phi += 0.05) {
        const o = expo(phi),
          { value: bb, fits } = withFitLog(() => poissonGlm(X, y, o, 0.5, `overtakes (phi ${phi.toFixed(2)})`)),
          ll = logLik(o, X, bb);
        if (ll > best) {
          best = ll;
          b = bb;
          ret.phi = Math.round(phi * 100) / 100;
          oFit = o;
          note = fits[0];
        }
      }
      // only the chosen phi's fit counts (the grid's edges may be impossible: phi 0 gives a retired car none)
      if (note) fitNote(note.name, note);
      ret.b = b[3];
    } else {
      // too few retirements to fit: finishers only; retired cars use the hand-set phi and the finishers' level
      const keep = run.map((f) => f < 0);
      const Xf = X.filter((_, n) => keep[n]).map((x) => x.slice(0, 3));
      const bf = poissonGlm(
        Xf,
        y.filter((_, n) => keep[n]),
        off.filter((_, n) => keep[n]),
        0.5,
        "overtakes (finishers)",
      );
      b = [...bf, 0];
      oFit = expo(ret.phi);
    }
    /** @type {Record<string, [number, number]>} */
    const oe = {};
    X.forEach((x, n) => {
      const mu = Math.exp(oFit[n] + x.reduce((t, v, j) => t + v * b[j], 0));
      const t = (oe[who[n]] ||= [0, 0]);
      t[0] += y[n];
      t[1] += mu;
    });
    /** @type {Record<string, number>} */
    const skill = {};
    for (const [t, [ob, ex]] of Object.entries(oe)) skill[t] = Math.log((ob + M.ovShrink) / (ex + M.ovShrink));
    return { b: b.slice(0, 3), ret, sprint, skill, fallback, fitted: true };
  }

  /** Driver of the Day popularity per driver: (votes won + k) / (votes expected + k), where "expected" is what the
   * sim's position-based weights give for his actual finishes this season and k = dotdShrink pseudo-votes. A fan
   * favourite scores above 1; a winner the fans don't vote for (Russell) below. @param {Data} data
   * @param {typeof MODEL} M @returns {Record<string, number>} */
  function dotdPopularity(data, M) {
    const names = data.evNames || [];
    const dIdx = new Set(names.map((e, i) => (e.c === "R DOTD" ? i : -1)).filter((i) => i >= 0));
    if (!dIdx.size) return {};
    const w = (/** @type {number} */ pos, /** @type {number} */ g) =>
      (pos === 1
        ? SIM.dotd[0]
        : pos === 2
          ? SIM.dotd[1]
          : pos === 3
            ? SIM.dotd[2]
            : pos <= 6
              ? SIM.dotd[3]
              : SIM.dotd[4]) + (pos <= 8 ? SIM.dotdGain * Math.max(0, g - 4) : 0);
    /** @type {Record<string, [number, number]>} */
    const acc = {};
    for (const gd of data.done || []) {
      const rows = (data.results.race[gd] || []).filter((x) => x.cls);
      if (!rows.length) continue;
      // who won the vote: the driver asset with a DotD line that round
      const winner = data.assets.find(
        (a) => a.kind === "D" && a.hist.some((h) => h && h.gd === gd && h.ev && h.ev.some(([i]) => dIdx.has(i))),
      );
      if (!winner) continue;
      const ws = rows.map((x) => w(x.pos, (x.grid || x.pos) - x.pos)),
        tot = ws.reduce((a, b) => a + b, 0);
      rows.forEach((x, k) => {
        const t = (acc[x.tla] ||= [0, 0]);
        t[1] += ws[k] / tot;
        if (x.tla === winner.tla) t[0] += 1;
      });
    }
    /** @type {Record<string, number>} */
    const out = {};
    for (const [t, [won, exp]] of Object.entries(acc))
      out[t] = clamp((won + M.dotdShrink) / (exp + M.dotdShrink), 0.3, 3);
    return out;
  }

  /** Combine practice sessions (later ones count more) into gap %, then into an implied grid position.
   * @param {PracticeSession[]} sessions @param {string[]} tlas @param {number} [field] @param {typeof MODEL} [M] */
  function practiceRanks(sessions, tlas, field = 22, M = MODEL) {
    /** @type {Record<string, number>} */
    const q = {};
    /** @type {Record<string, number>} */
    const qw = {};
    /** @type {Record<string, number>} */
    const r = {};
    /** @type {Record<string, number>} */
    const rn = {};
    sessions
      .filter((s) => s.done)
      .forEach((s, i) => {
        const w = [1, 1, 2][Math.min(i, 2)];
        for (const [t, v] of Object.entries(s.drivers || {})) {
          if (v.laps < M.practiceMinLaps) continue; // barely ran: no signal
          if (v.q != null) {
            q[t] = (q[t] || 0) + w * v.q;
            qw[t] = (qw[t] || 0) + w;
          }
          if (v.r != null) {
            r[t] = (r[t] || 0) + v.r;
            rn[t] = (rn[t] || 0) + 1;
          }
        }
      });
    /** @type {Record<string, number>} */
    const gapQ = {};
    /** @type {Record<string, number>} */
    const gapR = {};
    for (const t of tlas) {
      if (qw[t]) gapQ[t] = q[t] / qw[t];
      if (rn[t]) gapR[t] = r[t] / rn[t];
    }
    const toPos = (/** @type {Record<string, number>} */ gaps) => {
      const ks = Object.keys(gaps).sort((a, b) => gaps[a] - gaps[b]),
        n = ks.length;
      /** @type {Record<string, number>} */
      const out = {};
      if (n < M.practiceMinDrivers) return out; // too few drivers ran to compare
      ks.forEach((k, i) => (out[k] = ((i + 0.5) / n) * field + 0.5));
      return out;
    };
    return { q: toPos(gapQ), r: toPos(gapR), gapQ, gapR };
  }

  /* ---------- one race weekend, N times ---------- */
  /** @typedef {{ id: string, mean: number, nnMean: number, sd: number, p10: number, p25: number, p50: number, p75: number, p90: number, dnf?: number, fl?: number, dotd?: number, xov?: number, q?: number[], r?: number[], cat?: Record<string, number>, pit?: number }} AssetStats */
  /**
   * One race lap by lap (SIM.raceModel "laps"). Cars start on the grid SIM.lapStart s apart; each lap takes the
   * lap time + the car's offset (base, s) + noise, plus SIM.pitLoss on its stop lap (one stop, in the middle half;
   * none in a sprint). Order changes on track only through passes: each car tries the car directly ahead once a lap
   * with logit theta + lapKernel . (pace advantage, gap, gap below 0.5 s) + its overtaking skill (+ lap1 on lap 1);
   * a car that fails is held SIM.lapFollow s behind. Stops reorder without passes. A retiring car drops out on a
   * random lap (its passes before that count); a safety car bunches the field at a random lap and freezes passing
   * for 3 laps. Returns the running cars in finishing order; passes[i] = passes made.
   * @param {{ grid: Int32Array, base: Float64Array, out: Uint8Array, ovU: number[], laps: number, T: number, sc: boolean, scAt?: number, wet: boolean, sprint: boolean, theta: number, kappa?: number, trace?: LapTrace }} o
   * @param {Rng} r @param {Float64Array} passes @returns {number[]}
   */
  function raceLaps(o, r, passes) {
    const n = o.grid.length,
      K = SIM.lapKernel,
      laps = o.laps;
    passes.fill(0);
    const cum = new Float64Array(n),
      nxt = new Float64Array(n),
      stopLap = new Int32Array(n),
      outLap = new Int32Array(n);
    /** @type {number[]} */
    let order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => o.grid[a] - o.grid[b]);
    order.forEach((i, k) => (cum[i] = k * SIM.lapStart));
    for (let i = 0; i < n; i++) {
      stopLap[i] = o.sprint ? -1 : 1 + Math.floor(laps * (0.25 + 0.5 * r()));
      outLap[i] = o.out[i] ? 1 + Math.floor(r() * laps) : laps + 1;
    }
    // the safety car's lap: at its drawn onset (SIM.scTimed, o.scAt = share of the race), else anywhere
    const scLap = !o.sc
      ? -1
      : o.scAt != null && o.scAt >= 0
        ? clamp(Math.round(o.scAt * laps), 1, laps)
        : 2 + Math.floor(r() * Math.max(1, laps - 5));
    const sd = SIM.lapSd * (o.wet ? SIM.rainNoise : 1);
    let frozen = 0;
    for (let l = 1; l <= laps; l++) {
      order = order.filter((i) => outLap[i] > l);
      if (!order.length) break;
      if (l === scLap) {
        order.forEach((i, k) => (cum[i] = cum[order[0]] + k * 0.4));
        frozen = 3;
      }
      for (const i of order)
        nxt[i] = frozen
          ? cum[i] + o.T * 1.4
          : cum[i] + o.T + o.base[i] + gauss(r) * sd + (l === stopLap[i] ? SIM.pitLoss : 0);
      /** @type {number[]} */
      const res = [];
      /** @type {number[]} */
      const pit = [];
      for (const b of order) {
        if (!frozen && l === stopLap[b]) {
          pit.push(b);
          continue;
        }
        const a = res.length ? res[res.length - 1] : -1;
        if (a >= 0 && !frozen) {
          const g = Math.max(0, cum[b] - cum[a]);
          if (g < 3) {
            const d = clamp(o.base[a] - o.base[b], -2, 2);
            const z =
              o.theta +
              (o.kappa ?? 1) * K[0] * d +
              K[1] * g +
              K[2] * Math.min(g, 0.5) +
              (o.ovU[b] || 0) +
              (l === 1 ? SIM.lap1 : 0);
            if (r() < 1 / (1 + Math.exp(-z))) {
              res.splice(res.length - 1, 0, b);
              passes[b]++;
              continue;
            }
          }
        }
        res.push(b);
      }
      // times along the new order: nobody ahead of the car in front, held cars follow SIM.lapFollow behind
      let prev = -Infinity;
      for (const i of res) {
        if (nxt[i] < prev + SIM.lapFollow) nxt[i] = prev + SIM.lapFollow;
        prev = nxt[i];
      }
      // cars that stopped rejoin wherever their time puts them (no passes either way)
      for (const i of pit) {
        let k = 0;
        while (k < res.length && nxt[res[k]] <= nxt[i]) k++;
        res.splice(k, 0, i);
      }
      order = res;
      for (const i of order) cum[i] = nxt[i];
      if (o.trace) traceLap(o.trace, order, cum, l, laps);
      if (frozen) frozen--;
    }
    return order;
  }
  /** @typedef {{ pos: Float64Array, gap: Float64Array, cnt: Float64Array }} LapTrace */
  /** Add one lap's running order (positions and gaps to the leader, s) to a trace (per driver x lap sums).
   * @param {LapTrace} t @param {number[]} order @param {Float64Array} cum @param {number} l @param {number} laps */
  function traceLap(t, order, cum, l, laps) {
    const lead = cum[order[0]];
    order.forEach((i, k) => {
      const j = i * laps + l - 1;
      t.pos[j] += k + 1;
      t.gap[j] += cum[i] - lead;
      t.cnt[j]++;
    });
  }
  /**
   * One race in timing segments (SIM.raceModel "segments", item 9 stage 3b): as raceLaps, with three segments a
   * lap, the segment pass curve SIM.segKernel (a car just passed by the car ahead tries less), held-up gaps drawn
   * from SIM.followMin + exponential(SIM.followMean), and the yo-yo: each segment two cars run < 0.3 s apart, both
   * make a pass-and-repass with chance SIM.yoyo (counted as overtakes, the order unchanged).
   * @param {{ grid: Int32Array, base: Float64Array, out: Uint8Array, ovU: number[], laps: number, T: number, sc: boolean, scAt?: number, wet: boolean, sprint: boolean, theta: number, kappa?: number, trace?: LapTrace }} o
   * @param {Rng} r @param {Float64Array} passes @returns {number[]}
   */
  function raceSegs(o, r, passes) {
    const n = o.grid.length,
      K = SIM.segKernel,
      S = 3,
      segs = o.laps * S,
      ka = o.kappa ?? 1;
    passes.fill(0);
    const cum = new Float64Array(n),
      nxt = new Float64Array(n),
      stopSeg = new Int32Array(n),
      outSeg = new Int32Array(n),
      passedAt = new Int32Array(n).fill(-99),
      passedBy = new Int32Array(n).fill(-1);
    /** @type {number[]} */
    let order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => o.grid[a] - o.grid[b]);
    order.forEach((i, k) => (cum[i] = k * SIM.lapStart));
    for (let i = 0; i < n; i++) {
      // the stop is taken in the lap's last segment (pit entry), rejoining in the next
      stopSeg[i] = o.sprint ? -1 : S * Math.floor(o.laps * (0.25 + 0.5 * r())) + S;
      outSeg[i] = o.out[i] ? 1 + Math.floor(r() * segs) : segs + 1;
    }
    const scSeg = !o.sc
      ? -1
      : o.scAt != null && o.scAt >= 0
        ? S * clamp(Math.round(o.scAt * o.laps) - 1, 0, o.laps - 1) + 1
        : S * (1 + Math.floor(r() * Math.max(1, o.laps - 5))) + 1;
    const sd = (SIM.lapSd * (o.wet ? SIM.rainNoise : 1)) / Math.sqrt(S),
      Ts = o.T / S;
    let frozen = 0;
    for (let k = 1; k <= segs; k++) {
      order = order.filter((i) => outSeg[i] > k);
      if (!order.length) break;
      if (k === scSeg) {
        order.forEach((i, j) => (cum[i] = cum[order[0]] + j * 0.4));
        frozen = 3 * S;
      }
      for (const i of order)
        nxt[i] = frozen
          ? cum[i] + Ts * 1.4
          : cum[i] + Ts + o.base[i] / S + gauss(r) * sd + (k === stopSeg[i] ? SIM.pitLoss : 0);
      /** @type {number[]} */
      const res = [];
      /** @type {number[]} */
      const pit = [];
      for (const b of order) {
        if (!frozen && k === stopSeg[b]) {
          pit.push(b);
          continue;
        }
        const a = res.length ? res[res.length - 1] : -1;
        if (a >= 0 && !frozen) {
          const g = Math.max(0, cum[b] - cum[a]);
          if (g < 2) {
            const d = clamp(o.base[a] - o.base[b], -2, 2);
            const just = passedBy[b] === a && k - passedAt[b] <= 3 ? 1 : 0;
            const z =
              o.theta +
              ka * K[0] * d +
              K[1] * g +
              K[2] * Math.min(g, 0.3) +
              K[3] * just +
              (o.ovU[b] || 0) +
              (k === 1 ? SIM.lap1 : 0);
            if (r() < 1 / (1 + Math.exp(-z))) {
              res.splice(res.length - 1, 0, b);
              passes[b]++;
              passedAt[a] = k;
              passedBy[a] = b;
              continue;
            }
          }
        }
        res.push(b);
      }
      // times along the new order: a car held up sits a drawn gap behind the car in front
      let prev = -Infinity;
      for (const i of res) {
        if (nxt[i] < prev + SIM.followMin) {
          let u = r();
          while (u === 0) u = r();
          nxt[i] = prev + SIM.followMin - SIM.followMean * Math.log(u);
        }
        prev = nxt[i];
      }
      // the yo-yo: close pairs pass and re-pass between the timing lines
      if (!frozen)
        for (let j = 1; j < res.length; j++)
          if (nxt[res[j]] - nxt[res[j - 1]] < 0.3 && r() < SIM.yoyo) {
            passes[res[j]]++;
            passes[res[j - 1]]++;
          }
      for (const i of pit) {
        let j = 0;
        while (j < res.length && nxt[res[j]] <= nxt[i]) j++;
        res.splice(j, 0, i);
      }
      order = res;
      for (const i of order) cum[i] = nxt[i];
      if (o.trace && k % S === 0) traceLap(o.trace, order, cum, k / S, o.laps);
      if (frozen) frozen--;
    }
    return order;
  }
  /** @typedef {{ ids: string[], N: number, field: number, tot: Float32Array, nn: Float32Array, stats: AssetStats[], sc: number, ev?: Uint8Array, scOver?: number, wet: number, wetQ?: number, wetQR?: number, laps?: { n: number, pos: number[][], gap: number[][], run: number[][] } | null }} Sim */
  /** @typedef {{ persist?: number, known?: Record<string, string[]>, status?: Record<string, Record<string, string>>, fl?: Record<string, string>, locked?: { q?: Record<string, number[]>, s?: Record<string, number[]> }, pen?: Record<string, number>, unc?: number, trace?: boolean, lean?: boolean }} SimOpts */
  const SIM_CATS = ["q", "rpos", "gain", "lost", "ovt", "fl", "dotd", "dnf", "sprint"]; // scoring categories per driver
  /** Driver of the Day vote weight for a finishing position and places gained. @param {number} pos @param {number} g */
  const dotdWeight = (pos, g) =>
    (pos === 1
      ? SIM.dotd[0]
      : pos === 2
        ? SIM.dotd[1]
        : pos === 3
          ? SIM.dotd[2]
          : pos <= 6
            ? SIM.dotd[3]
            : SIM.dotd[4]) + (pos <= 8 ? SIM.dotdGain * Math.max(0, g - 4) : 0);
  /** How likely a car at this grid slot is caught in a multi-car incident (the midfield most). @param {number} g */
  const incidentWeight = (g) => (g <= 3 ? 0.6 : g <= 16 ? 1.2 : 1);

  /** Per team: the retirement rate its drivers share (the lower of their mechanical rates, so the order they come
   * in doesn't matter) and its effective number of races; per driver: what his own rate adds on top (his incident
   * rate under MODEL.dnfModel "causes", 0 for pooled team-mates), so each driver keeps his own chance.
   * @param {DriverModel[]} D @param {Record<string, number>} teamIdx @param {number} nt */
  function teamReliability(D, teamIdx, nt) {
    const teamRate = new Float64Array(nt).fill(Infinity),
      teamN = new Float64Array(nt),
      cnt = new Float64Array(nt);
    D.forEach((d) => {
      const t = teamIdx[d.team];
      teamRate[t] = Math.min(teamRate[t], d.dnf - (d.dnfInc || 0));
      teamN[t] += d.dnfN || 20;
      cnt[t]++;
    });
    for (let t = 0; t < nt; t++) teamN[t] /= cnt[t] || 1;
    return { teamRate, teamN, incRate: Float64Array.from(D, (d) => d.dnf - teamRate[teamIdx[d.team]]) };
  }
  /** Everything one simulate() call shares between its stages: the model as arrays, the circuit's numbers, the random
   * stream, each sample's scratch arrays and the tallies over all samples.
   * @param {Model} model @param {Circuit} circuit @param {boolean} sprint @param {number} N @param {number} seed
   * @param {SimOpts} opt */
  function simState(model, circuit, sprint, N, seed, opt) {
    const D = model.drivers,
      C = model.cons,
      nd = D.length,
      nc = C.length,
      A = nd + nc;
    const F = Math.max(model.field || 22, nd);
    const teamIdx = /** @type {Record<string, number>} */ ({});
    D.forEach((d) => {
      if (teamIdx[d.team] == null) teamIdx[d.team] = Object.keys(teamIdx).length;
    });
    const nt = Object.keys(teamIdx).length;
    const ovMean = circuit.ovMean ?? 4;
    const pSc = circuit.sc ?? 0.5;
    const scOv = circuit.scOv ?? 1;
    // overtake level with and without a safety car, averaging to the circuit's level
    const ovLvl = ovMean * (circuit.ov ?? 1);
    const ovNoSc = ovLvl / (1 + pSc * (scOv - 1));
    // the lap-by-lap race (SIM.raceModel "laps" or "segments")
    const lapMode = SIM.raceModel === "laps" || SIM.raceModel === "segments";
    const lapN = circuit.laps || 57;
    return {
      model,
      circuit,
      sprint,
      N,
      seed,
      D,
      C,
      nd,
      nc,
      A,
      F,
      nt,
      r: mulberry32(seed),
      cOf: D.map((d) => C.findIndex((c) => c.team === d.team)),
      tOf: D.map((d) => teamIdx[d.team]),
      unc: opt.unc ?? SIM.unc,
      flOddsW: D.some((d) => d.flMk != null) ? SIM.flOddsW : 0,
      known: opt.known || {},
      pen: opt.pen || {},
      persist: opt.persist || 0,
      lean: !!opt.lean,
      order: D.map((_, i) => i),
      byTla: D.map((_, i) => i).sort((a, b) => (D[a].tla < D[b].tla ? -1 : D[a].tla > D[b].tla ? 1 : 0)),
      // a finished sprint's classification (TLA -> "dnf" | "dns" | "dsq") while its points aren't scored yet
      status: opt.status || {},
      // every team's recent band points together: the stand-in for a team with too few of its own
      pitPool: model.cons.flatMap((c) => c.bands || []),
      // a finished session's fastest lap (TLA; s = the sprint) while its points aren't scored yet
      fl: opt.fl || {},
      // points already scored: asset id -> [points, negative part] per finished session (q, s = the sprint)
      lockQ: lockedArrays(opt.locked && opt.locked.q, D, C),
      lockS: lockedArrays(opt.locked && opt.locked.s, D, C),
      tlaIdx: Object.fromEntries(D.map((d, i) => [d.tla, i])),
      rain: circuit.rain || {},
      ovB: model.ovB || [0, 0, 0],
      tau: tauFor(circuit.grid ?? DEFAULT_CIRCUIT.grid),
      pSc,
      ovLvl,
      ovNoSc,
      ovSc: ovNoSc * scOv,
      scOv,
      // the timed safety car (SIM.scTimed): the onsets to draw from and the mean of their weights
      ...scTiming(circuit),
      // team reliability: Beta around the team's mechanical rate with its effective number of races, one draw per
      // team a weekend; each driver adds his own incident rate (MODEL.dnfModel "causes"), so team-mates keep
      // their own chances whichever comes first
      ...teamReliability(D, teamIdx, nt),
      // one sample's scratch
      pts: new Float64Array(A),
      neg: new Float64Array(A),
      qpos: new Int32Array(nd),
      sgrid: new Int32Array(nd),
      rgrid: new Int32Array(nd),
      qp: new Float64Array(nd),
      rp: new Float64Array(nd),
      dnfP: new Float64Array(nd),
      scDnfP: new Float64Array(nd), // this session's retirement chances (after chaos, sprint and rain scaling)
      shock: new Float64Array(nd),
      tShock: new Float64Array(nt),
      out: new Uint8Array(nd),
      qb: new Float64Array(nc),
      qbNeg: new Float64Array(nc),
      pitPts: new Float64Array(nc),
      // tallies over the samples
      tot: new Float32Array(A * N),
      nn: new Float32Array(A * N),
      qCount: new Uint32Array(nd * F),
      rCount: new Uint32Array(nd * (F + 1)), // last column = DNF
      flC: new Uint32Array(nd),
      dotdC: new Uint32Array(nd),
      ovSum: new Float64Array(nd),
      pitSum: new Float64Array(nc),
      cat: new Float64Array(nd * SIM_CATS.length), // points by scoring category, for calibration and breakdowns
      scN: 0,
      // per sample: bit 1 = a safety car in the race, bit 2 = a wet race (after-the-fact grouping in the backtests:
      // a race that had one is scored against the samples that had one)
      ev: new Uint8Array(N),
      cur: 0,
      scOver: 0, // races whose retirements alone make more safety cars than the circuit's rate
      ovMult: 1, // this weekend's overtaking factor (SIM.ovEnv)
      wetN: 0,
      wetQN: 0, // wet qualifying
      wetQRN: 0, // wet qualifying and race
      // the lap-by-lap race
      lapMode,
      runRace: SIM.raceModel === "segments" ? raceSegs : raceLaps,
      lapT: circuit.lapT || 90,
      lapN,
      lapNs: Math.max(5, Math.round((lapN * 100) / 305)),
      // each driver's position and gap to the leader at every lap end, summed over the races (opt.trace)
      trace:
        opt.trace && lapMode
          ? { pos: new Float64Array(nd * lapN), gap: new Float64Array(nd * lapN), cnt: new Float64Array(nd * lapN) }
          : null,
      lapPass: new Float64Array(nd),
      lapBase: new Float64Array(nd),
      ovUs: D.map((d) => d.ovU || 0),
      calR: { th: 0, ka: 1 },
      calS: { th: 0, ka: 1 },
    };
  }
  /** A finished session's points per asset as arrays in model order (drivers, then constructors), or null.
   * @param {Record<string, number[]> | undefined} m @param {DriverModel[]} D @param {ConsModel[]} C */
  function lockedArrays(m, D, C) {
    if (!m) return null;
    const ids = D.map((d) => String(d.id)).concat(C.map((c) => String(c.id)));
    return {
      pts: Float64Array.from(ids, (id) => (m[id] ? m[id][0] : 0)),
      neg: Float64Array.from(ids, (id) => (m[id] ? m[id][1] : 0)),
    };
  }
  /** @typedef {ReturnType<typeof simState>} SimState */
  /** @param {SimState} S @param {number} i @param {string} c @param {number} v */
  function addCat(S, i, c, v) {
    S.cat[i * SIM_CATS.length + SIM_CATS.indexOf(c)] += v;
  }
  /** A fixed order (known result) as positions; drivers missing from it go to the back in pace order.
   * @param {SimState} S @param {string[]} order @param {Int32Array} outArr */
  function fixedOrder(S, order, outArr) {
    const { D, tlaIdx, qp } = S;
    const seen = new Set();
    let k = 0;
    for (const t of order) {
      const i = tlaIdx[t];
      if (i == null || seen.has(i)) continue;
      seen.add(i);
      outArr[i] = ++k;
    }
    const rest = D.map((d, i) => i)
      .filter((i) => !seen.has(i))
      .sort((a, b) => qp[a] - qp[b]);
    for (const i of rest) outArr[i] = ++k;
  }
  /** A qualifying session: its order into outArr, and (withPoints) its points and position counts.
   * @param {SimState} S @param {Int32Array} outArr @param {boolean} withPoints @param {boolean} wet
   * @param {string[] | undefined} fixed */
  function qualiOrder(S, outArr, withPoints, wet, fixed) {
    const { nd, r, qp, tShock, tOf, shock, qCount, F, pts, neg, lockQ } = S;
    /** @type {{ i: number, s: number, noTime: boolean }[]} */
    const arr = [];
    if (fixed) {
      fixedOrder(S, fixed, outArr);
      // qualifying run but not scored yet: its classification says who set no time
      const st = (withPoints && S.status.q) || {};
      for (let i = 0; i < nd; i++) arr.push({ i, s: outArr[i], noTime: !!st[S.D[i].tla] });
    } else {
      const sd = SIM.qSd * (wet ? SIM.rainNoise : 1);
      for (let i = 0; i < nd; i++) {
        const noTime = r() < SIM.qualiNoTime * (wet ? 1.5 : 1);
        arr.push({
          i,
          s: noTime ? 99 + r() : qp[i] + tShock[tOf[i]] + shock[i] + skewNoise(r, SIM.qSkew) * sd,
          noTime,
        });
      }
    }
    arr.sort((a, b) => a.s - b.s);
    arr.forEach((x, k) => {
      outArr[x.i] = k + 1;
      if (!withPoints) return;
      qCount[x.i * F + Math.min(k, F - 1)]++;
      if (lockQ) {
        // qualifying is scored: its points as they are
        pts[x.i] += lockQ.pts[x.i];
        neg[x.i] += lockQ.neg[x.i];
        addCat(S, x.i, "q", lockQ.pts[x.i]);
        return;
      }
      if (x.noTime) {
        // no time: starts last; the -5 is waived in a wet session (the 107% rule doesn't apply)
        if (!wet) {
          pts[x.i] -= 5;
          neg[x.i] -= 5;
          addCat(S, x.i, "q", -5);
        }
      } else if (k < 10) {
        pts[x.i] += QPTS[k];
        addCat(S, x.i, "q", QPTS[k]);
      }
    });
  }
  /** The lap race's pass level theta (and grid weight kappa), set so that pilot races at the model's pace make the
   * circuit's overtakes per starter (race) or its sprint share (sprint).
   * @param {SimState} S @param {boolean} isSprint @param {number} target */
  function lapCalib(S, isSprint, target) {
    const { seed, nd, nt, circuit, D, tOf, lapBase, lapT, unc, pSc, runRace, ovUs, lapNs, lapN, lapPass } = S;
    const rc = mulberry32(seed ^ 0x5bd1e995),
      g = new Int32Array(nd),
      none = new Uint8Array(nd), // retirements in the pilot races
      ts = new Float64Array(nt),
      M = 150,
      rhoT = circuit.grid ?? DEFAULT_CIRCUIT.grid;
    let th = 1,
      ka = 1;
    for (let it = 0; it < 8; it++) {
      let tot = 0,
        rho = 0;
      for (let m = 0; m < M; m++) {
        // a weekend like the main loop's: pace uncertainty, team and driver form, session noise
        for (let t = 0; t < nt; t++) ts[t] = gauss(rc) * SIM.teamSd;
        const qs = D.map((d, i) => {
          const sh = ts[tOf[i]] + gauss(rc) * SIM.drvSd;
          lapBase[i] = (lapT * (d.rPace + gauss(rc) * d.rSe * unc + sh + gauss(rc) * SIM.rSd)) / 100;
          return { i, s: d.qPace + gauss(rc) * d.qSe * unc + sh + gauss(rc) * SIM.qSd };
        });
        qs.sort((a, b) => a.s - b.s).forEach((x, k) => (g[x.i] = k + 1));
        const scDraw = rc() < pSc * (isSprint ? SIM.sprintSc : 1);
        for (let i = 0; i < nd; i++)
          none[i] = rc() < D[i].dnf * (circuit.chaos ?? 1) * (isSprint ? SIM.sprintDnf : 1) ? 1 : 0;
        const ord = runRace(
          {
            grid: g,
            base: lapBase,
            out: none,
            ovU: ovUs,
            laps: isSprint ? lapNs : lapN,
            T: lapT,
            sc: scDraw,
            wet: false,
            sprint: isSprint,
            theta: th,
            kappa: ka,
          },
          rc,
          lapPass,
        );
        for (let i = 0; i < nd; i++) tot += lapPass[i];
        rho +=
          spearman(
            ord.map((i) => g[i]),
            ord.map((_, k) => k),
          ) ?? rhoT;
      }
      th += 1.2 * Math.log(Math.max(0.05, target) / Math.max(0.05, tot / (M * nd)));
      if (SIM.lapGrid && !isSprint) ka = clamp(ka * Math.exp(4 * (rho / M - rhoT)), 0.05, 5);
    }
    return { th, ka };
  }
  /** The timed safety car's inputs (SIM.scTimed): the onsets a safety car is drawn from (circuit.scAt) and the mean
   * of their weights, so the weights average 1. Off, or without onsets: none. @param {Circuit} circuit */
  function scTiming(circuit) {
    const at = SIM.scTimed && circuit.scAt && circuit.scAt.length ? circuit.scAt : null;
    if (!at) return { scAt: null, scWBar: 0, scNoiseC: 0 };
    const raw = at.map(scRawWeight);
    const m1 = raw.reduce((s, x) => s + x, 0) / raw.length,
      m2 = raw.reduce((s, x) => s + x * x, 0) / raw.length;
    if (!(m1 > 0)) return { scAt: null, scWBar: 0, scNoiseC: 0 };
    // the race noise multiplier 1 + c x weight with E[(1 + c w)^2] = scNoise^2: c^2 m2 + 2 c m1 + 1 - scNoise^2 = 0
    const f0 = SIM.scNoise;
    const c = (-m1 + Math.sqrt(Math.max(0, m1 * m1 - m2 * (1 - f0 * f0)))) / m2;
    return { scAt: at, scWBar: m1, scNoiseC: c };
  }
  /** A safety car's weight by its onset u (share of the race run), before normalising. @param {number} u */
  const scRawWeight = (u) => Math.max(0, SIM.scTimeA + SIM.scTimeB * u);
  /** The timed safety car's weight for onset u among the onsets `at` (1 = the average safety car's effect).
   * @param {number} u @param {number[]} at */
  function scWeight(u, at) {
    const bar = at.reduce((s, x) => s + scRawWeight(x), 0) / at.length;
    return bar > 0 ? scRawWeight(u) / bar : 1;
  }
  /** A race or sprint from the grid: retirements, safety car, finishing order and every driver's points.
   * @param {SimState} S @param {Int32Array} grid @param {boolean} isSprint @param {{ i: number }} dotdOut
   * @param {boolean} wet @param {string[] | undefined} fixed */
  function raceSession(S, grid, isSprint, dotdOut, wet, fixed) {
    const { out, nd, dnfP, circuit, r, tlaIdx, pSc, tau, lapMode, pts, neg, rCount, F, rp, tShock, tOf, shock, D } = S;
    const { lapBase, lapT, runRace, ovUs, lapNs, lapN, calS, calR, trace, lapPass, ovSum, ovSc, ovNoSc, model, ovB } =
      S;
    const { flOddsW, flC, dotdC } = S;
    out.fill(0);
    // retirements: individual, plus multi-car incidents (a share of the same total risk)
    let pSum = 0;
    const { scDnfP } = S;
    for (let i = 0; i < nd; i++) {
      const p = Math.min(
        0.9,
        dnfP[i] * (circuit.chaos ?? 1) * (isSprint ? SIM.sprintDnf : 1) * (wet ? SIM.rainDnf : 1),
      );
      pSum += p;
      scDnfP[i] = p;
      if (!fixed && r() < (1 - SIM.incident) * p) out[i] = 1;
    }
    if (!fixed) {
      const k = poisson((SIM.incident * pSum) / 1.5, r);
      for (let n = 0; n < k; n++) {
        const cars = r() < 0.5 ? 2 : 1;
        for (let c = 0; c < cars; c++) {
          const w = [];
          for (let i = 0; i < nd; i++) w.push(out[i] ? 0 : dnfP[i] * incidentWeight(grid[i]));
          if (w.some((v) => v > 0)) out[pick(w, r)] = 1;
        }
      }
    } else {
      // a known sprint result: whoever isn't in it, or is in it as not classified, retired
      const inIt = new Set(fixed.map((t) => tlaIdx[t])),
        st = (isSprint ? S.status.s : S.status.r) || {};
      for (let i = 0; i < nd; i++) if (!inIt.has(i) || st[D[i].tla]) out[i] = 1;
    }
    let nOut = 0;
    for (let i = 0; i < nd; i++) nOut += out[i];
    // safety car: each retirement brings one out with chance scPerDnf; other causes (debris, a stranded car that
    // still classifies) make up the circuit's rate: 1 - (1 - base) * (1 - q)^retirements averages to that rate.
    // P(no SC from retirements) = E[(1 - q)^N] under the retirement process above: each car's own retirement
    // independently, times the incidents' (a Poisson number of 1- or 2-car incidents: its generating function)
    const p = pSc * (isSprint ? SIM.sprintSc : 1),
      q = SIM.scPerDnf;
    let viaDnf = 1;
    if (!fixed) {
      for (let i = 0; i < nd; i++) viaDnf *= 1 - (1 - SIM.incident) * scDnfP[i] * q;
      const gen = (1 - q + (1 - q) ** 2) / 2;
      viaDnf *= Math.exp(((SIM.incident * pSum) / 1.5) * (gen - 1));
    } else viaDnf = Math.pow(1 - q, nOut);
    const base = 1 - (1 - p) / Math.max(1e-9, viaDnf);
    // retirements alone bring out more safety cars than the circuit's rate: counted, and the rate can't be met
    if (base < 0 && !isSprint) S.scOver++;
    const sc = r() < 1 - (1 - clamp(base, 0, p)) * Math.pow(1 - q, nOut);
    if (!isSprint && sc) {
      S.scN++;
      S.ev[S.cur] |= 1;
    }
    const fin = [];
    // the timed safety car (SIM.scTimed): when it comes (the share of the race run) and so how much of the average
    // safety car's effect this one has (an early one reshuffles nothing); untimed, the average effect as before
    let scAtU = -1,
      scNoise = SIM.scNoise,
      scTau = SIM.scTau,
      ovScNow = ovSc;
    if (sc && S.scAt && !isSprint) {
      scAtU = S.scAt[Math.floor(r() * S.scAt.length)];
      const raw = scRawWeight(scAtU),
        w = raw / S.scWBar;
      scNoise = 1 + S.scNoiseC * raw;
      scTau = Math.max(0, 1 + (SIM.scTau - 1) * w);
      ovScNow = ovNoSc * (1 + (S.scOv - 1) * w);
    }
    const sd = SIM.rSd * (isSprint ? SIM.sprintSd : 1) * (wet ? SIM.rainNoise : 1) * (sc ? scNoise : 1);
    const tauNow = tau * (sc ? scTau : 1);
    const laps = lapMode && !fixed;
    const lvl = (sc ? ovScNow : ovNoSc) * (isSprint ? model.ovSprint || MODEL.sprintOvertakeShare : 1) * S.ovMult;
    const ret = model.ovRet;
    for (let i = 0; i < nd; i++) {
      if (out[i]) {
        const pen = isSprint ? 10 : 20;
        pts[i] -= pen;
        neg[i] -= pen;
        addCat(S, i, isSprint ? "sprint" : "dnf", -pen);
        if (!isSprint) rCount[i * (F + 1) + F]++;
        // the overtakes made before it stopped: how far it got is drawn from this season's retirements
        if (!laps && !fixed && ret && ret.share.length) {
          const f = ret.share[Math.floor(r() * ret.share.length)];
          if (f >= 0) {
            const expo = ret.phi + (1 - ret.phi) * f;
            const lam =
              model.ovB && SIM.ovModel
                ? lvl * Math.exp(ovB[0] + ret.b + ovB[2] * ((grid[i] - 1) / (F - 1)) + D[i].ovU)
                : D[i].ov * (circuit.ov ?? 1) * (isSprint ? model.ovSprint || MODEL.sprintOvertakeShare : 1);
            const ov = poisson(lam * expo, r);
            pts[i] += ov;
            ovSum[i] += ov;
            addCat(S, i, isSprint ? "sprint" : "ovt", ov);
          }
        }
        continue;
      }
      if (laps) continue;
      const s = fixed
        ? fixed.indexOf(D[i].tla)
        : rp[i] + tShock[tOf[i]] + shock[i] + tauNow * (grid[i] - 1) + skewNoise(r, SIM.rSkew) * sd;
      fin.push({ i, s });
    }
    if (laps) {
      // the race lap by lap: race-long form and noise as a lap-time offset; the grid costs time on track
      for (let i = 0; i < nd; i++)
        lapBase[i] = (lapT * (rp[i] + tShock[tOf[i]] + shock[i] + skewNoise(r, SIM.rSkew) * sd)) / 100;
      const ord = runRace(
        {
          grid,
          base: lapBase,
          out,
          ovU: ovUs,
          laps: isSprint ? lapNs : lapN,
          T: lapT,
          sc,
          scAt: scAtU,
          wet,
          sprint: isSprint,
          theta: isSprint ? calS.th : calR.th,
          trace: isSprint ? undefined : trace || undefined,
          kappa: calR.ka,
        },
        r,
        lapPass,
      );
      ord.forEach((i, k) => fin.push({ i, s: k }));
      // a retired car keeps the passes it made before it stopped
      for (let i = 0; i < nd; i++)
        if (out[i] && lapPass[i] && SIM.lapOv === "passes") {
          pts[i] += lapPass[i];
          ovSum[i] += lapPass[i];
          addCat(S, i, isSprint ? "sprint" : "ovt", lapPass[i]);
        }
    } else fin.sort((a, b) => a.s - b.s);
    /** @type {number[]} */
    const flW = [];
    /** @type {number[]} */
    const dW = [];
    fin.forEach((x, k) => {
      const pos = k + 1,
        i = x.i;
      const pp = isSprint ? SPTS[k] || 0 : RPTS[k] || 0;
      pts[i] += pp;
      let g = grid[i] - pos;
      if (isSprint && g < -10) g = -10; // sprint losses are capped at -10
      pts[i] += g;
      if (g < 0) neg[i] += g;
      if (isSprint) addCat(S, i, "sprint", pp + g);
      else {
        addCat(S, i, "rpos", pp);
        addCat(S, i, g >= 0 ? "gain" : "lost", g);
      }
      const lam =
        lvl *
        Math.exp(ovB[0] + ovB[1] * Math.log1p(Math.abs(grid[i] - pos)) + ovB[2] * ((grid[i] - 1) / (F - 1)) + D[i].ovU);
      const ov =
        laps && SIM.lapOv === "passes"
          ? lapPass[i]
          : poisson(
              model.ovB && SIM.ovModel
                ? lam
                : D[i].ov * (circuit.ov ?? 1) * (isSprint ? model.ovSprint || MODEL.sprintOvertakeShare : 1),
              r,
            );
      pts[i] += ov;
      ovSum[i] += ov;
      addCat(S, i, isSprint ? "sprint" : "ovt", ov);
      if (!isSprint) rCount[i * (F + 1) + Math.min(k, F - 1)]++;
      flW.push(Math.exp(-(pos - 1) / SIM.flDecay));
      dW.push(dotdWeight(pos, g) * (D[i].dotdPop ?? 1));
    });
    if (fin.length) {
      // a share of races take the fastest lap from the market (among the finishers), the rest from the model
      const mkFl = !isSprint && flOddsW > 0 && r() < flOddsW ? fin.map((x) => D[x.i].flMk ?? 0) : null;
      // a run session's fastest lap is known (weekend.fl): its driver, if classified; else drawn
      const flKnown = fixed ? tlaIdx[S.fl[isSprint ? "s" : "r"]] : undefined;
      const f =
        flKnown != null && fin.some((x) => x.i === flKnown)
          ? flKnown
          : fin[mkFl && mkFl.some((v) => v > 0) ? pick(mkFl, r) : pick(flW, r)].i;
      pts[f] += isSprint ? 5 : 10;
      addCat(S, f, isSprint ? "sprint" : "fl", isSprint ? 5 : 10);
      if (!isSprint) {
        flC[f]++;
        const d = fin[pick(dW, r)].i;
        pts[d] += 10;
        dotdOut.i = d;
        dotdC[d]++;
        addCat(S, d, "dotd", 10);
      }
    }
  }
  /** One simulated weekend (sample s): this weekend's draw, the sessions and every asset's score.
   * @param {SimState} S @param {number} s */
  function simSample(S, s) {
    S.cur = s;
    const {
      pts,
      neg,
      nt,
      nd,
      qp,
      D,
      unc,
      r,
      rp,
      shock,
      tOf,
      teamN,
      teamRate,
      incRate,
      dnfP,
      tShock,
      rain,
      qpos,
      nc,
      cOf,
    } = S;
    const { qb, qbNeg, sprint, sgrid, known, pen, rgrid, C, pitPts, pitSum, A, tot, nn, N, lockQ, lockS } = S;
    pts.fill(0);
    neg.fill(0);
    const dotd = { i: -1 };
    // this weekend's draw: pace and reliability within their uncertainty, then team and driver form. With
    // opt.persist the uncertainty draws come from sample s's own stream (drivers in TLA order), so simulations of
    // several races with the same persist seed share each sample's car and driver strength: what isn't known about
    // a car stays unknown across the horizon instead of averaging out
    const rel = new Float64Array(nt).fill(-1);
    const ru = S.persist ? streamFor(S.persist, s) : r;
    for (const i of S.persist ? S.byTla : S.order) {
      qp[i] = D[i].qPace + (unc ? gauss(ru) * D[i].qSe * unc : 0);
      rp[i] = D[i].rPace + (unc ? gauss(ru) * D[i].rSe * unc : 0);
      const t = tOf[i];
      if (rel[t] < 0) {
        // the Beta's spread scales with unc like the pace draws' (sd ~ unc): k = races / unc^2, so it shrinks
        // smoothly to the plain rate as unc goes to 0 (was races / max(0.2, unc): a jump at 0; the same at 1)
        const k = teamN[t] / Math.max(1e-9, unc * unc);
        rel[t] = unc ? beta(Math.max(0.05, teamRate[t] * k), Math.max(0.05, (1 - teamRate[t]) * k), ru) : teamRate[t];
      }
      dnfP[i] = rel[t] + incRate[i];
    }
    for (let i = 0; i < nd; i++) shock[i] = gauss(r) * SIM.drvSd;
    for (let t = 0; t < nt; t++) tShock[t] = gauss(r) * SIM.teamSd;
    if (SIM.ovEnv) {
      const sd = S.circuit.ovSd ?? 0.35;
      S.ovMult = Math.exp(sd * gauss(r) - (sd * sd) / 2);
    }
    // wet sessions: a Gaussian copula, one weekend draw shared by the sessions with correlation rho, so a wet
    // qualifying makes a wet race likelier while each session's own chance stays as forecast
    // (rho >= 0: a shared factor; rho < 0, sessions pulling apart: the Cholesky factor of the three sessions'
    // equicorrelation matrix, valid down to -0.5)
    const rho = clamp(rain.rho ?? SIM.rainCorr, -0.5, 0.95);
    let wetQ, wetS, wetR;
    if (rho >= 0) {
      const zc = gauss(r) * Math.sqrt(rho),
        e = Math.sqrt(1 - rho);
      const wet = (/** @type {number} */ p) => p > 0 && normCdf(zc + e * gauss(r)) < p;
      wetQ = wet(rain.q ?? 0);
      wetS = wet(rain.s ?? rain.r ?? 0);
      wetR = wet(rain.r ?? 0);
    } else {
      const g1 = gauss(r),
        g2 = gauss(r),
        g3 = gauss(r),
        l22 = Math.sqrt(1 - rho * rho),
        l32 = rho * Math.sqrt((1 - rho) / (1 + rho)),
        l33 = Math.sqrt(Math.max(0, 1 - rho * rho - l32 * l32));
      const wet = (/** @type {number} */ p, /** @type {number} */ x) => p > 0 && normCdf(x) < p;
      wetQ = wet(rain.q ?? 0, g1);
      wetR = wet(rain.r ?? 0, rho * g1 + l22 * g2);
      wetS = wet(rain.s ?? rain.r ?? 0, rho * g1 + l32 * g2 + l33 * g3);
    }
    if (wetR) {
      S.wetN++;
      S.ev[s] |= 2;
    }
    if (wetQ) S.wetQN++;
    if (wetQ && wetR) S.wetQRN++;
    qualiOrder(S, qpos, true, wetQ, known.q);
    // constructor qualifying bonus: both in Q3 +10, one +5; both in Q2 +3, one +1; neither -1
    for (let c = 0; c < nc; c++) {
      let q2 = 0,
        q3 = 0;
      for (let i = 0; i < nd; i++)
        if (cOf[i] === c) {
          if (qpos[i] <= 16) q2++;
          if (qpos[i] <= 10) q3++;
        }
      const b = q3 === 2 ? 10 : q3 === 1 ? 5 : q2 === 2 ? 3 : q2 === 1 ? 1 : -1;
      qb[c] = b;
      qbNeg[c] = b < 0 ? b : 0;
      // scored: whatever the constructor's qualifying points hold beyond its drivers' (the bonus)
      if (lockQ) {
        qb[c] = lockQ.pts[nd + c];
        qbNeg[c] = lockQ.neg[nd + c];
        for (let i = 0; i < nd; i++)
          if (cOf[i] === c) {
            qb[c] -= lockQ.pts[i];
            qbNeg[c] -= lockQ.neg[i];
          }
      }
    }
    if (sprint && lockS) {
      // the sprint is scored: its points as they are (a constructor's are its drivers', plus any difference)
      for (let i = 0; i < nd; i++) {
        pts[i] += lockS.pts[i];
        neg[i] += lockS.neg[i];
        addCat(S, i, "sprint", lockS.pts[i]);
      }
      for (let c = 0; c < nc; c++) {
        qb[c] += lockS.pts[nd + c];
        qbNeg[c] += lockS.neg[nd + c];
        for (let i = 0; i < nd; i++)
          if (cOf[i] === c) {
            qb[c] -= lockS.pts[i];
            qbNeg[c] -= lockS.neg[i];
          }
      }
    } else if (sprint) {
      qualiOrder(S, sgrid, false, wetS, known.sq);
      raceSession(S, sgrid, true, { i: -1 }, wetS, known.s);
    }
    // race grid: the official one once published (OpenF1 starting_grid: penalties and pit-lane starts in), else the
    // qualifying order with grid penalties applied
    if (known.race) fixedOrder(S, known.race, rgrid);
    else if (Object.keys(pen).length) {
      const g = D.map((d, i) => ({
        i,
        k: qpos[i] + (pen[d.tla] ? (pen[d.tla] >= 99 ? 100 + qpos[i] / 100 : pen[d.tla] + 0.5) : 0),
      }));
      g.sort((a, b) => a.k - b.k).forEach((x, k) => (rgrid[x.i] = k + 1));
    } else rgrid.set(qpos);
    raceSession(S, rgrid, false, dotd, wetR, undefined);
    // pit stops: one of the team's recent races' pit points, else the leftover model. With pitBonus, the band
    // points only (a team with under 3 races of them: the field's, S.pitPool), and the race's fastest-stop bonus to
    // exactly one team among the best bands, also when every band is 0 (someone still has the fastest stop)
    const race1 = SIM.pitBonus && S.pitPool.length >= 3;
    let best = -1;
    for (let c = 0; c < nc; c++) {
      const own = race1 ? C[c].bands : C[c].stops;
      const st = race1 && !(own && own.length >= 3) ? S.pitPool : own;
      pitPts[c] =
        SIM.pitStops && st && st.length >= 3
          ? /** @type {number[]} */ (st)[Math.floor(r() * st.length)]
          : Math.max(0, Math.round(C[c].pitMu + gauss(r) * C[c].pitSd));
      if (pitPts[c] > best) best = pitPts[c];
    }
    if (race1 && best >= 0) {
      const w = C.map((c, k) => (pitPts[k] === best ? c.bonusW || 1 : 0));
      pitPts[pick(w, r)] += PIT_FASTEST;
    }
    // constructors: their drivers' points (Driver of the Day excluded), the qualifying bonus and pit stops
    for (let c = 0; c < nc; c++) {
      let t = qb[c],
        n = qbNeg[c];
      for (let i = 0; i < nd; i++)
        if (cOf[i] === c) {
          t += pts[i] - (dotd.i === i ? 10 : 0);
          n += neg[i];
        }
      t += pitPts[c];
      pitSum[c] += pitPts[c];
      pts[nd + c] = t;
      neg[nd + c] = n;
    }
    for (let a = 0; a < A; a++) {
      tot[a * N + s] = pts[a];
      nn[a * N + s] = pts[a] - neg[a];
    }
  }
  /** Per-asset statistics over all samples, and the lap traces. @param {SimState} S @returns {Sim} */
  function simSummary(S) {
    const { D, C, N, tot, nn, nd, rCount, F, flC, dotdC, ovSum, qCount, cat, pitSum, trace, lapN, scN, wetN, scOver } =
      S;
    const CATS = SIM_CATS,
      NC = CATS.length;
    const ids = D.map((d) => d.id).concat(C.map((c) => c.id));
    const stats = ids.map((id, a) => {
      // quantiles: a typed-array sort (numeric, no boxing; the review's profile had summaries at ~23% of a run),
      // skipped for a lean run (applyOdds only reads chances)
      const sl = S.lean ? null : tot.slice(a * N, a * N + N).sort();
      let m = 0,
        mn = 0,
        m2 = 0;
      for (let s = 0; s < N; s++) {
        const v = tot[a * N + s];
        m += v;
        m2 += v * v;
        mn += nn[a * N + s];
      }
      const q = (/** @type {number} */ p) => (sl ? sl[Math.floor(N * p)] : NaN);
      /** @type {AssetStats} */
      const st = {
        id,
        mean: m / N,
        nnMean: mn / N,
        sd: Math.sqrt(Math.max(0, m2 / N - (m / N) ** 2)),
        p10: q(0.1),
        p25: q(0.25),
        p50: q(0.5),
        p75: q(0.75),
        p90: q(0.9),
      };
      if (a < nd) {
        st.dnf = rCount[a * (F + 1) + F] / N;
        st.fl = flC[a] / N;
        st.dotd = dotdC[a] / N;
        st.xov = ovSum[a] / N;
        st.q = Array.from(qCount.subarray(a * F, a * F + F), (v) => v / N);
        st.r = Array.from(rCount.subarray(a * (F + 1), a * (F + 1) + F + 1), (v) => v / N);
        st.cat = Object.fromEntries(CATS.map((c, j) => [c, cat[a * NC + j] / N]));
      } else st.pit = pitSum[a - nd] / N;
      return st;
    });
    /** @param {Float64Array} v @param {number} i */
    const perLap = (v, i) =>
      Array.from({ length: lapN }, (_, l) => {
        const c = /** @type {LapTrace} */ (trace).cnt[i * lapN + l];
        return c ? v[i * lapN + l] / c : NaN;
      });
    const laps = trace
      ? {
          n: lapN,
          pos: D.map((_, i) => perLap(trace.pos, i)),
          gap: D.map((_, i) => perLap(trace.gap, i)),
          run: D.map((_, i) => Array.from({ length: lapN }, (_, l) => trace.cnt[i * lapN + l] / N)),
        }
      : null;
    return {
      ids,
      N,
      field: F,
      tot,
      nn,
      stats,
      sc: scN / N,
      ev: S.ev,
      scOver: scOver / N,
      wet: wetN / N,
      wetQ: S.wetQN / N,
      wetQR: S.wetQRN / N,
      laps,
    };
  }
  /**
   * Simulate one weekend N times, scored with the official rules. tot/nn hold every sample per asset
   * (asset a, sample s at a * N + s); nn is the No Negative score (negative events floored at 0).
   * opt.known: orders already decided this weekend (q = qualifying, sq = sprint qualifying, s = sprint; TLAs in
   * order); opt.pen: grid penalties in places (99 = back of the grid) for the race; opt.unc scales the per-weekend
   * redraw of pace and reliability within their uncertainty (default SIM.unc).
   * @param {Model} model @param {Circuit} circuit @param {boolean} sprint @param {number} N @param {number} seed
   * @param {SimOpts} [opt]
   * @returns {Sim}
   */
  function simulate(model, circuit, sprint, N, seed, opt = {}) {
    if (!Number.isInteger(N) || N < 1) throw new RangeError(`simulate: N must be a positive whole number (got ${N})`);
    const S = simState(model, circuit, sprint, N, seed, opt);
    if (S.lapMode) {
      S.calR = lapCalib(S, false, S.ovLvl);
      S.calS = sprint ? lapCalib(S, true, S.ovLvl * (model.ovSprint || MODEL.sprintOvertakeShare)) : S.calR;
    }
    for (let s = 0; s < N; s++) simSample(S, s);
    return simSummary(S);
  }

  /** Two teams' net scores compared weekend by weekend (the same simulated weekends: shared assets cancel): a's lead
   * over b after their transfer penalties, and whether it's inside z standard errors ("near", exact ties with no
   * noise included) or convincingly the other way ("reversed": b ahead). z 2 for one look; more where the same
   * comparison is looked at repeatedly as samples are added (lookZ).
   * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number} penA @param {number} penB
   * @param {number} [z] @returns {{ gap: number, se: number, near: boolean, reversed: boolean }} */
  function pairedCompare(a, b, penA, penB, z = 2) {
    const n = a.length;
    let m = 0,
      m2 = 0;
    for (let k = 0; k < n; k++) {
      const d = a[k] - penA - (b[k] - penB);
      m += d;
      m2 += d * d;
    }
    m /= n;
    const se = Math.sqrt(Math.max(0, m2 / n - m * m) / n);
    return { gap: m, se, near: Math.abs(m) <= z * se, reversed: m < -z * se };
  }
  /** The z for a two-sided 5% test that may be looked at up to `looks` times as samples are added (Bonferroni over
   * the looks: conservative, but valid however the looks fall; fourth review: 2 SE at any of five looks separated
   * equal means 13% of the time, not 5%). lookZ(1) = 1.96. @param {number} looks */
  const lookZ = (looks) => normInv(1 - 0.025 / Math.max(1, looks));

  /* ---------- the betting market (next race) ---------- */
  /** Move each driver's pace so the simulated chances of winning, a podium, a top 10 and pole move towards the
   * market's, by weight w (0 = model only, 1 = market only), in log-odds. Returns a new model; the shift per driver
   * is kept as oddsQ / oddsR (%). o.simOpt: what's already known this weekend (grid penalties, the qualifying order),
   * so a market quoted after qualifying isn't matched by moving pace to make up for a grid the sim doesn't know.
   * With the qualifying order known, pole is settled and qualifying pace no longer moves.
   * @param {Model} model @param {Circuit} circuit @param {Odds | null | undefined} odds
   * @param {{ w?: number, seed?: number, n?: number, iters?: number, simOpt?: SimOpts }} [o] @returns {Model} */
  function applyOdds(model, circuit, odds, o = {}) {
    const w = o.w ?? SIM.oddsW;
    if (!odds || !w || !(odds.win || odds.podium || odds.top10 || odds.pole)) return model;
    const m = { ...model, drivers: model.drivers.map((d) => ({ ...d, oddsQ: 0, oddsR: 0 })) };
    const n = o.n || SIM.oddsN,
      seed = o.seed || 4242;
    const probs = (/** @type {Sim} */ sim, /** @type {number} */ i) => {
      const st = sim.stats[i],
        rr = /** @type {number[]} */ (st.r),
        qq = /** @type {number[]} */ (st.q);
      let pod = 0,
        top = 0;
      for (let k = 0; k < 10; k++) {
        if (k < 3) pod += rr[k];
        top += rr[k];
      }
      return { win: rr[0], podium: pod, top10: top, pole: qq[0] };
    };
    const simOpt = o.simOpt || {},
      qKnown = !!(simOpt.known && simOpt.known.q);
    const lean = { ...simOpt, lean: true };
    const base = simulate(m, circuit, false, n, seed, lean);
    const p0 = m.drivers.map((_, i) => probs(base, i));
    /** @type {("win" | "podium" | "top10")[]} */
    const RACE = ["win", "podium", "top10"];
    let sim = base;
    const iters = o.iters || SIM.oddsIters;
    // the targets, per driver and market: [log-odds, weight], the market's chance moved w of the way from the
    // model's, weighted by sqrt(p (1 - p)) of the market's so long shots don't dominate. Pole only while the
    // qualifying order isn't known (then it's settled). Kept for oddsCheck, which scores the final model on a run
    // of its own (the production sims), not on the samples it was fitted to.
    /** @type {Record<string, Record<string, [number, number]>>} */
    const targets = {};
    m.drivers.forEach((d, i) => {
      /** @type {Record<string, [number, number]>} */
      const t = {};
      for (const k of /** @type {const} */ (["win", "podium", "top10", "pole"])) {
        const mk = odds[k] && odds[k][d.tla];
        if (mk == null || (k === "pole" && qKnown)) continue;
        const c = clamp(mk, 0.01, 0.99);
        const sp = SIM.oddsQuality && odds.spread && odds.spread[k] ? odds.spread[k][d.tla] : null;
        const wk = sp != null ? w / (1 + (SIM.oddsQuality * sp) / Math.max(0.02, mk)) : w;
        t[k] = [(1 - wk) * logit(p0[i][k]) + wk * logit(mk), Math.sqrt(c * (1 - c))];
      }
      targets[d.tla] = t;
    });
    // diagnostics: each step's residual (oddsCheck's measure on the samples the step was fitted to) and the
    // largest pace step, race or qualifying (%)
    /** @type {number[]} */
    const resid = [];
    let maxStep = 0;
    for (let it = 0; it < iters; it++) {
      maxStep = 0;
      resid.push(oddsResid(targets, m.drivers, sim).resid);
      m.drivers.forEach((d, i) => {
        const p = probs(sim, i),
          t = targets[d.tla];
        let num = 0,
          den = 0;
        for (const k of RACE) {
          if (t[k] == null) continue;
          const [target, wt] = t[k];
          num += wt * (target - logit(p[k]));
          den += wt;
        }
        const step = den ? clamp(num / den, -3, 3) * 0.12 : 0;
        d.rPace -= step;
        d.oddsR = (d.oddsR || 0) - step;
        let qStep = qKnown ? 0 : step * 0.6;
        if (t.pole != null) qStep = 0.5 * qStep + 0.5 * clamp(t.pole[0] - logit(p.pole), -3, 3) * 0.1;
        d.qPace -= qStep;
        d.oddsQ = (d.oddsQ || 0) - qStep;
        maxStep = Math.max(maxStep, Math.abs(step), Math.abs(qStep));
      });
      // the last step's result isn't read here: no simulation after it (oddsCheck reads it off the production run)
      if (it < iters - 1) sim = simulate(m, circuit, false, n, seed, lean);
    }
    finishPositions(m.drivers);
    m.oddsFit = {
      iters,
      n,
      resid,
      noise: oddsResid(targets, m.drivers, base).noise,
      lastStep: Math.round(maxStep * 1000) / 1000,
      targets,
    };
    return m;
  }

  /** Weighted mean |target - simulated| in log-odds over every market line applyOdds fitted (pole included), and
   * the sampling noise of a simulated log-odds at the sim's size (1 / sqrt(N p (1 - p)) at the target, the same
   * weights). @param {Record<string, Record<string, [number, number]>>} targets @param {{ tla: string }[]} drivers @param {Sim} sim */
  function oddsResid(targets, drivers, sim) {
    let rs = 0,
      nz = 0,
      rw = 0;
    drivers.forEach((d) => {
      const t = targets[d.tla],
        i = sim.ids.indexOf(/** @type {any} */ (d).id);
      const st = i >= 0 ? sim.stats[i] : null;
      if (!t || !st || !st.r || !st.q) return;
      const rr = /** @type {number[]} */ (st.r);
      let pod = 0,
        top = 0;
      for (let k = 0; k < 10; k++) {
        if (k < 3) pod += rr[k];
        top += rr[k];
      }
      /** @type {Record<string, number>} */
      const p = { win: rr[0], podium: pod, top10: top, pole: /** @type {number[]} */ (st.q)[0] };
      for (const [k, [target, wt]] of Object.entries(t)) {
        const pt = clamp(1 / (1 + Math.exp(-target)), 0.004, 0.996);
        rs += wt * Math.abs(target - logit(p[k]));
        nz += wt / Math.sqrt(sim.N * pt * (1 - pt));
        rw += wt;
      }
    });
    const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
    return { resid: rw ? r3(rs / rw) : 0, noise: rw ? r3(nz / rw) : 0 };
  }
  /** @typedef {{ resid: number, noise: number, state: "matched" | "moving" | "unreachable" }} OddsCheck */
  /** How closely a model fitted by applyOdds meets its market targets, scored on a run of its own (the production
   * sims, other samples than the fit's): "matched" = within twice the sampling noise; "moving" = off, and the
   * fit's last step still moved pace (more steps would help); "unreachable" = off with the fit at rest (targets the
   * model can't meet together). Null without a fit. @param {Model} model @param {Sim} sim
   * @returns {OddsCheck | null} */
  function oddsCheck(model, sim) {
    const f = model.oddsFit;
    if (!f || !f.targets) return null;
    const { resid, noise } = oddsResid(f.targets, model.drivers, sim);
    /** @type {OddsCheck["state"]} */
    const state = resid <= 2 * noise ? "matched" : f.lastStep >= 0.01 ? "moving" : "unreachable";
    return { resid, noise, state };
  }

  /* ---------- price change rule (fitted to this season's price history; backtest/prices.js) ---------- */
  // 3-race average points / price, rounded to 3 dp: <0.605 big drop, <0.9 drop, <1.195 rise, else big rise.
  // $18.5m and up move ±0.1/0.3, cheaper assets ±0.2/0.6; prices stay within $3-34m.
  const PRICE_BANDS = [0.605, 0.9, 1.195];
  /** @param {number} price @param {number} avg 3-race average points @returns {number} price change ($m) */
  function priceStep(price, avg) {
    const big = price >= 18.5,
      ppm = Math.round((avg / price) * 1000) / 1000;
    const step = ppm >= PRICE_BANDS[2] ? 3 : ppm >= PRICE_BANDS[1] ? 1 : ppm >= PRICE_BANDS[0] ? -1 : -3;
    const d = big ? step * 0.1 : step * 0.2;
    return Math.max(3, Math.min(34, Math.round((price + d) * 10) / 10)) - price;
  }
  /** The points the coming race needs for each price step (the Budget view): [{d, lo, hi}] in step order, d the
   * change ($m, rounded to 0.1; the $3m floor / $34m cap applied, steps they make equal merged into one), lo / hi
   * whole points (null = open). sum2 / n as from priceBase. @param {number} price @param {number} sum2
   * @param {number} n @returns {{ d: number, lo: number | null, hi: number | null }[]} */
  function priceSteps(price, sum2, n) {
    const step = (/** @type {number} */ p) => Math.round(priceStep(price, (sum2 + p) / n) * 10) / 10;
    // the fewest whole points that clear each band (priceStep's own rounding of points per $1m)
    const ppm = (/** @type {number} */ p) => Math.round(((sum2 + p) / n / price) * 1000) / 1000;
    const first = (/** @type {number} */ t) => {
      let lo = -1000,
        hi = 2000;
      while (lo < hi) {
        const m = Math.floor((lo + hi) / 2);
        if (ppm(m) >= t) hi = m;
        else lo = m + 1;
      }
      return lo;
    };
    const T = PRICE_BANDS.map(first);
    /** @type {{ d: number, lo: number | null, hi: number | null }[]} */
    const out = [];
    for (let j = 0; j <= T.length; j++) {
      const lo = j === 0 ? null : T[j - 1],
        hi = j === T.length ? null : T[j] - 1;
      if (lo != null && hi != null && hi < lo) continue; // an empty band
      const d = step(lo ?? /** @type {number} */ (hi));
      const last = out[out.length - 1];
      if (last && last.d === d) last.hi = hi;
      else out.push({ d, lo, hi });
    }
    return out;
  }

  /** The points already in an asset's next price change: its last two rounds (p1 = the last), counting only rounds
   * it raced. The game averages over the races in the last three rounds, the coming one included: an inactive round
   * isn't a zero (2026: 493/495 real changes, vs 422/425 counting zeros; the two left are R8, likely points corrected
   * after the prices were set). n = races in the average. @param {Asset} a @param {number[]} done
   * @returns {{ p1: number | null, p2: number | null, sum2: number, n: number }} */
  function priceBase(a, done) {
    const pts = done.slice(-2).map((gd) => {
      const h = a.hist.find((x) => x && x.gd === gd);
      return h && h.active ? h.pts : null;
    });
    while (pts.length < 2) pts.unshift(null);
    const [p2, p1] = pts;
    return { p1, p2, sum2: (p1 ?? 0) + (p2 ?? 0), n: 1 + (p1 != null ? 1 : 0) + (p2 != null ? 1 : 0) };
  }

  /** An asset's price path over the next races, sample by sample (the races simulated with the same persist seed,
   * so sample s is one coherent future): each race's change from the game's rule on the races in its last three
   * rounds, the price carried from race to race. pts[k] = its points in race k per sample. Returns the expected
   * change per race, and over all of them the mean, the 10-90% range and the chance it ends up; steps = every
   * sample's change per race in $0.1m (race k's sample s at k * N + s: planHorizon's affordability check).
   * @param {Asset} a @param {number[]} done @param {ArrayLike<number>[]} pts
   * @returns {{ d: number[], cum: number, p10: number, p90: number, up: number, down: number, steps: Int8Array }} */
  function pricePath(a, done, pts) {
    const H = pts.length,
      N = H ? pts[0].length : 0;
    const base = priceBase(a, done);
    const d = new Array(H).fill(0),
      cum = new Float64Array(N),
      steps = new Int8Array(H * N);
    for (let s = 0; s < N; s++) {
      let price = a.price;
      // the two rounds before the next race (null = sat out), then the simulated races
      const hist = [base.p2, base.p1];
      for (let k = 0; k < H; k++) {
        const x = pts[k][s];
        const last = [hist[hist.length - 2], hist[hist.length - 1]].filter((v) => v != null);
        const avg = (last.reduce((u, v) => u + /** @type {number} */ (v), 0) + x) / (last.length + 1);
        const step = Math.round(priceStep(price, avg) * 10) / 10;
        price = Math.round((price + step) * 10) / 10;
        d[k] += step;
        steps[k * N + s] = Math.round(step * 10);
        hist.push(x);
      }
      cum[s] = Math.round((price - a.price) * 10) / 10;
    }
    const sorted = Array.from(cum).sort((u, v) => u - v);
    let up = 0,
      down = 0,
      m = 0;
    for (const v of cum) {
      m += v;
      if (v > 0) up++;
      if (v < 0) down++;
    }
    return {
      d: d.map((v) => v / Math.max(1, N)),
      cum: m / Math.max(1, N),
      p10: sorted[Math.floor(0.1 * N)] ?? 0,
      p90: sorted[Math.floor(0.9 * N)] ?? 0,
      up: up / Math.max(1, N),
      down: down / Math.max(1, N),
      steps,
    };
  }

  /* ---------- optimiser ---------- */
  /**
   * @typedef {{ id: string, kind: "D" | "C", price: number, e: number, x?: number, boostE?: number | number[], active: boolean, f?: Record<string, number> }} Candidate
   * e is the asset's value (summed over the horizon); boostE the value the Boost adds: one number, or one per race
   * of the horizon (the Boost goes to the team's best driver in each race; chips only apply to the first race).
   * @typedef {{ k: string, min?: number | null, max?: number | null }} Filter
   * Filters apply to the whole team. k is "cost", "score" (after Boost and penalties) or a key of each candidate's
   * f (additive per asset, e.g. price change or points in a scoring category; not multiplied by Boost).
   * @typedef {{ cap: number, free: number, maxT: number, chip?: string, locks: Set<string>, bans: Set<string>, top?: number, filters?: Filter[], penW?: number }} OptOpts
   * @typedef {{ score: number, transfers: number, penalty: number, cost: number, drivers: string[], cons: string[], boost: string, boost2: string | null }} TeamResult
   */
  /** Every 5-driver line-up and every constructor pair, scored (value + Boost), for optimise and budgetCurve.
   * @param {Candidate[]} cand @param {string[]} team @param {Omit<OptOpts, "cap">} o */
  function teamSpace(cand, team, o) {
    const Fl = (o.filters || []).filter((f) => f.k && (f.min != null || f.max != null));
    const fk = [...new Set(Fl.map((f) => f.k).filter((k) => k !== "cost" && k !== "score"))];
    const fsum = (/** @type {Candidate[]} */ list) =>
      fk.map((k) => list.reduce((s, c) => s + ((c.f && c.f[k]) || 0), 0));
    const fj = Fl.map((f) => fk.indexOf(f.k));
    /** @param {{ cost: number, fs: number[] | null }} c @param {{ cost: number, fs: number[] | null }} p @param {number} score */
    const passes = (c, p, score) =>
      Fl.every((f, i) => {
        const v =
          f.k === "cost"
            ? c.cost + p.cost
            : f.k === "score"
              ? score
              : /** @type {number[]} */ (c.fs)[fj[i]] + /** @type {number[]} */ (p.fs)[fj[i]];
        return (f.min == null || v >= f.min - 1e-9) && (f.max == null || v <= f.max + 1e-9);
      });
    const inTeam = new Set(team);
    const Ds = cand.filter((c) => c.kind === "D" && c.active && !o.bans.has(c.id));
    const Cs = cand.filter((c) => c.kind === "C" && !o.bans.has(c.id));
    const n = Ds.length,
      m = Cs.length;
    if (n > 31) throw new Error("optimise: more than 31 drivers doesn't fit the bitmasks");
    let curD = 0,
      lockD = 0,
      curC = 0,
      lockC = 0;
    Ds.forEach((d, i) => {
      if (inTeam.has(d.id)) curD |= 1 << i;
      if (o.locks.has(d.id)) lockD |= 1 << i;
    });
    Cs.forEach((c, i) => {
      if (inTeam.has(c.id)) curC |= 1 << i;
      if (o.locks.has(c.id)) lockC |= 1 << i;
    });
    const unlimited = o.chip === "wildcard" || o.chip === "limitless";
    const noCap = o.chip === "limitless";
    const pop = (/** @type {number} */ x) => {
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      return (((x + (x >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24;
    };
    const BE = Ds.map((d) => (Array.isArray(d.boostE) ? d.boostE : [d.boostE || 0]));
    const HR = Math.max(1, ...BE.map((b) => b.length));

    const combos = [];
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) {
              const mask = (1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e);
              if ((mask & lockD) !== lockD) continue;
              const idx = [a, b, c, d, e];
              let cost = 0,
                sum = 0,
                boost = 0,
                i1 = -1,
                i2 = -1;
              for (const k of idx) {
                cost += Ds[k].price;
                sum += Ds[k].e;
              }
              for (let h = 0; h < HR; h++) {
                let m1 = -1e9,
                  m2 = -1e9,
                  j1 = -1,
                  j2 = -1;
                for (const k of idx) {
                  const v = BE[k][h] ?? 0;
                  if (v > m1) {
                    m2 = m1;
                    j2 = j1;
                    m1 = v;
                    j1 = k;
                  } else if (v > m2) {
                    m2 = v;
                    j2 = k;
                  }
                }
                if (h === 0) {
                  i1 = j1;
                  i2 = j2;
                  boost += o.chip === "x3" ? 2 * m1 + m2 : m1; // X3: top driver 3x, second 2x
                } else boost += m1;
              }
              combos.push({
                mask,
                idx,
                cost,
                val: sum + boost,
                i1,
                i2,
                keep: pop(mask & curD),
                fs: fk.length ? fsum(idx.map((k) => Ds[k])) : null,
              });
            }
    const pairs = [];
    for (let a = 0; a < m; a++)
      for (let b = a + 1; b < m; b++) {
        const mask = (1 << a) | (1 << b);
        if ((mask & lockC) !== lockC) continue;
        pairs.push({
          mask,
          a,
          b,
          cost: Cs[a].price + Cs[b].price,
          val: Cs[a].e + Cs[b].e,
          keep: pop(mask & curC),
          fs: fk.length ? fsum([Cs[a], Cs[b]]) : null,
        });
      }
    /** @param {{ score: number, c: any, p: any, t: number, pen: number }} x @returns {TeamResult} */
    const result = (x) => ({
      score: x.score,
      transfers: x.t,
      penalty: x.pen,
      cost: x.c.cost + x.p.cost,
      drivers: x.c.idx.map((/** @type {number} */ k) => Ds[k].id),
      cons: [Cs[x.p.a].id, Cs[x.p.b].id],
      boost: Ds[x.c.i1].id,
      boost2: o.chip === "x3" ? Ds[x.c.i2].id : null,
    });
    return { combos, pairs, Fl, passes, unlimited, noCap, result };
  }

  /** Every 5-driver x 2-constructor team, best `top` by score. @param {Candidate[]} cand @param {string[]} team
   * @param {OptOpts} o @returns {TeamResult[]} */
  function optimise(cand, team, o) {
    const { combos, pairs, Fl, passes, unlimited, noCap, result } = teamSpace(cand, team, o);
    const top = [],
      K = o.top || 60;
    let floor = -1e9;
    for (const p of pairs)
      for (const c of combos) {
        if (!noCap && c.cost + p.cost > o.cap + 1e-6) continue;
        const t = 7 - c.keep - p.keep;
        if (!unlimited && t > o.maxT) continue;
        const pen = unlimited ? 0 : (o.penW ?? 10) * Math.max(0, t - o.free); // penW 0: rank by a non-points goal
        const score = c.val + p.val - pen;
        if (score <= floor && top.length >= K) continue;
        if (Fl.length && !passes(c, p, score)) continue;
        top.push({ score, c, p, t, pen });
        if (top.length > K * 2) {
          top.sort((x, y) => y.score - x.score);
          top.length = K;
          floor = top[K - 1].score;
        }
      }
    top.sort((x, y) => y.score - x.score);
    return top.slice(0, K).map(result);
  }

  /** The best team at every budget from `lo` to `hi` ($m, in $0.1m steps) in one pass: what more (or less) money is
   * worth, steps and dead zones included. Same rules as optimise (transfers, penalties, chip, locks, bans,
   * filters); entry k is the best team costing at most lo + k/10, or null if none fits.
   * @param {Candidate[]} cand @param {string[]} team @param {Omit<OptOpts, "cap"> & { lo: number, hi: number }} o
   * @returns {({ cap: number } & TeamResult | { cap: number, score: null })[]} */
  function budgetCurve(cand, team, o) {
    const { combos, pairs, Fl, passes, unlimited, result } = teamSpace(cand, team, o);
    const lo = Math.round(o.lo * 10),
      n = Math.round(o.hi * 10) - lo + 1;
    /** @type {({ score: number, c: any, p: any, t: number, pen: number } | null)[]} */
    const best = new Array(n).fill(null);
    for (const p of pairs)
      for (const c of combos) {
        const k = Math.max(0, Math.round((c.cost + p.cost) * 10) - lo);
        if (k >= n) continue;
        const t = 7 - c.keep - p.keep;
        if (!unlimited && t > o.maxT) continue;
        const pen = unlimited ? 0 : (o.penW ?? 10) * Math.max(0, t - o.free);
        const score = c.val + p.val - pen;
        const b = best[k];
        if (b && score <= b.score) continue;
        if (Fl.length && !passes(c, p, score)) continue;
        best[k] = { score, c, p, t, pen };
      }
    // at most that budget: carry the best cheaper team up
    for (let k = 1; k < n; k++) {
      const a = best[k - 1],
        b = best[k];
      if (a && (!b || a.score > b.score)) best[k] = a;
    }
    return best.map((x, k) => (x ? { cap: (lo + k) / 10, ...result(x) } : { cap: (lo + k) / 10, score: null }));
  }

  /* ---------- race-by-race plan over the horizon ---------- */
  /**
   * @typedef {{ cand: Candidate[], dPrice?: Record<string, number> }} Stage
   *   one race of the horizon: that race's candidates (e = that race's expected points, boostE that race's Boost
   *   value) and the expected price change of each asset after it (its budget effect for the next race)
   * @typedef {{ team: string[], boost: string, boost2: string | null, transfers: number, penalty: number, pts: number, cost: number, cap: number, free: number, played?: string[] }} PlanStep
   * @typedef {{ total: number, steps: PlanStep[], afford?: number, value?: number, valueFit?: number, held?: number }} Plan
   * @typedef {{ tot: Float32Array, idx: Record<string, number>, shift?: Record<string, number> }} PlanSamples
   *   one race's simulated weekends for the stochastic planner: asset idx[id]'s points in sample s at tot[idx * N + s]
   *   (plus shift[id], the projection's shift), the races' samples one future each (the same persist seed)
   */
  /** Best sequence of teams race by race: transfers can wait for a later race, free transfers carry over (2 a race,
   * at most one unused carries: 3 max), and the budget grows or shrinks with the price changes of the team held.
   * Beam search: `beam` teams for the first race (best by that race and by keeping them for the whole horizon), the
   * best few moves from each for the next race, and so on. The chip plays in the first race only. `firstMaxT` caps the
   * first race's transfers only (what banking transfers is worth: plan with at most k now, the rest carried over).
   * The search plans on expected price changes; with o.priceSteps (each asset's sampled change per race, pricePath
   * steps) every plan gets `afford`: the share of simulated futures in which each of its transfers still fits the
   * budget as those prices turn out, and plans that fit in at least 90% of them rank first. With o.samples too (each
   * race's simulated weekends, the same futures as the price steps) the plans kept are ranked by `value` instead:
   * their points over those futures, a later race's transfers made only where they fit and the team held otherwise
   * (planStoch; the stochastic planner, 2026-09-28).
   * @param {Stage[]} stages @param {string[]} team @param {OptOpts & { beam?: number, bank?: number, perFree?: number, carryMax?: number, firstMaxT?: number, priceSteps?: Record<string, Int8Array>, priceN?: number, samples?: PlanSamples[] }} o
   * @returns {Plan[]} best plans first */
  function planHorizon(stages, team, o) {
    const beam = o.beam || 12,
      perFree = o.perFree ?? 2,
      carryMax = o.carryMax ?? 3;
    const byId = (/** @type {Candidate[]} */ cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
    const priceOf = byId(stages[0].cand);
    const H = stages.length;
    // first-race candidates: best for race 1, and best to keep for all H races
    const whole = stages[0].cand.map((c) => {
      let e = 0;
      /** @type {number[]} */
      const b = [];
      for (const st of stages) {
        const x = st.cand.find((y) => y.id === c.id);
        e += x ? x.e : 0;
        b.push(x ? (Array.isArray(x.boostE) ? x.boostE[0] : x.boostE || 0) : 0);
      }
      return { ...c, e, boostE: c.kind === "D" ? b : 0 };
    });
    const o1 = { ...o, maxT: Math.min(o.maxT, o.firstMaxT ?? 7), top: beam };
    const firsts = [...optimise(stages[0].cand, team, o1), ...optimise(whole, team, o1)];
    const seen = new Set();
    /** @type {Plan[]} */
    let plans = [];
    // a team's race-1 points: its assets, the Boost (X3: 3x the best, 2x the second) and the penalty
    const r1 = (/** @type {string[]} */ ds, /** @type {string[]} */ cs, /** @type {number} */ pen) => {
      const v = (/** @type {string} */ id) => priceOf[id].e;
      const b = ds
        .map((id) => {
          const be = priceOf[id].boostE;
          return { id, v: Array.isArray(be) ? be[0] : be || 0 };
        })
        .sort((a, c) => c.v - a.v);
      const boost = o.chip === "x3" ? 2 * b[0].v + b[1].v : b[0].v;
      return {
        pts: ds.concat(cs).reduce((s, id) => s + v(id), 0) + boost - pen,
        boost: b[0].id,
        boost2: o.chip === "x3" ? b[1].id : null,
      };
    };
    for (const r of firsts) {
      const ids = r.drivers.concat(r.cons);
      const key = ids.slice().sort().join();
      if (seen.has(key)) continue;
      seen.add(key);
      const one = r1(r.drivers, r.cons, r.penalty);
      const pts = one.pts;
      const cost = ids.reduce((s, id) => s + priceOf[id].price, 0);
      const used = o.chip === "wildcard" || o.chip === "limitless" ? 0 : r.transfers;
      plans.push({
        total: pts,
        steps: [
          {
            team: ids,
            boost: one.boost,
            boost2: one.boost2,
            transfers: r.transfers,
            penalty: r.penalty,
            pts,
            cost,
            cap: o.cap,
            free: Math.min(carryMax, perFree + Math.min(1, Math.max(0, o.free - used))),
          },
        ],
      });
    }
    // a Limitless team reverts after the race: plan the later races from the starting team (the team played in race
    // 1 kept as `played`)
    if (o.chip === "limitless")
      plans = plans.map((p) => ({
        ...p,
        steps: [
          {
            ...p.steps[0],
            played: p.steps[0].team,
            team: team.slice(),
            cost: team.reduce((s, id) => s + (priceOf[id] ? priceOf[id].price : 0), 0),
            free: Math.min(carryMax, perFree + Math.min(1, o.free)),
          },
        ],
      }));
    // every asset's price change so far (all stages up to the last one), whoever holds it: a stage's prices are
    // today's plus these
    /** @type {Record<string, number>} */
    const moved = {};
    for (let h = 1; h < H; h++) {
      /** @type {Plan[]} */
      const next = [];
      const dp = stages[h - 1].dPrice || {};
      for (const [id, d] of Object.entries(dp)) moved[id] = (moved[id] || 0) + d;
      const cand = stages[h].cand.map((c) => ({ ...c, price: c.price + (moved[c.id] || 0) }));
      for (const p of plans) {
        const prev = p.steps[p.steps.length - 1];
        // budget after the price changes of the team held through the last race
        const gain = prev.team.reduce((s, id) => s + (dp[id] || 0), 0);
        const cap = (o.chip === "limitless" && h === 1 ? o.cap : Math.max(prev.cap, prev.cost)) + gain;
        const opts = {
          ...o,
          cap,
          free: prev.free,
          maxT: Math.min(7, prev.free + (o.maxT - Math.min(o.maxT, o.free))),
          chip: "",
          top: 3,
        };
        const res = optimise(cand, prev.team, opts);
        for (const r of res) {
          const ids = r.drivers.concat(r.cons);
          const cost = ids.reduce((s, id) => s + (cand.find((c) => c.id === id)?.price || 0), 0);
          next.push({
            total: p.total + r.score,
            steps: [
              ...p.steps,
              {
                team: ids,
                boost: r.boost,
                boost2: null,
                transfers: r.transfers,
                penalty: r.penalty,
                pts: r.score,
                cost,
                cap,
                free: Math.min(carryMax, perFree + Math.min(1, Math.max(0, prev.free - r.transfers))),
              },
            ],
          });
        }
      }
      next.sort((a, b) => b.total - a.total);
      plans = next.slice(0, beam * 2);
    }
    plans.sort((a, b) => b.total - a.total);
    if (o.priceSteps && o.samples && o.priceN && H > 1 && o.samples.length >= H) {
      for (const p of plans) Object.assign(p, planStoch(p, stages, priceOf, o.priceSteps, o.priceN, o.samples, o));
      plans.sort((a, b) => /** @type {number} */ (b.value) - /** @type {number} */ (a.value));
    } else if (o.priceSteps && H > 1) {
      for (const p of plans) p.afford = planAfford(p, priceOf, o.priceSteps, o.priceN || 0);
      plans.sort((a, b) => +((b.afford ?? 1) >= 0.9) - +((a.afford ?? 1) >= 0.9) || b.total - a.total);
    }
    return plans.slice(0, 10);
  }
  /** A team's points in one simulated weekend with the race's chip (chipScore; the Calculator's teamSamples and the
   * planner both score with it, fourth review): every asset once, plus the Boost once more (X3: the Boost twice more
   * and boost2 once more; Autopilot: once more on whichever driver scores most that weekend). pts(id) = the asset's
   * points that weekend (No Negative: its points with the chip). @param {string[]} ids @param {string[]} ds the
   * team's drivers @param {string | null} boost @param {string | null} boost2 @param {string} chip
   * @param {(id: string) => number} pts */
  function chipScore(ids, ds, boost, boost2, chip, pts) {
    let v = 0;
    for (const id of ids) v += pts(id);
    if (chip === "autopilot") {
      let m = -Infinity;
      for (const id of ds) m = Math.max(m, pts(id));
      if (ds.length) v += m;
      return v;
    }
    if (boost) v += pts(boost) * (chip === "x3" ? 2 : 1);
    if (boost2) v += pts(boost2);
    return v;
  }
  /** A plan over the simulated futures (the stochastic planner). In each future s: race 1 as planned, scored with
   * the chip (chipScore; a Limitless race on the team played, `played`); from race 2 on, the planned team if its
   * transfers fit the budget at that future's prices, else the team held from then on (no transfers, no penalty,
   * its best expected Boost), which is what a manager does when a move no longer fits. Points from that future's
   * weekends. value = the mean over the futures plus the plan's price-value terms (a candidate's e above its
   * expected points x, race 1: xΔ$Pts); valueFit = the same with every planned move made whether it fits or not
   * (value - valueFit = what holding costs); afford = the share of futures in which every planned transfer fit;
   * held = the share that had to hold.
   * @param {Plan} p @param {Stage[]} stages @param {Record<string, Candidate>} priceOf today's prices
   * @param {Record<string, Int8Array>} steps sampled price changes (tenths, race k's sample s at k * N + s)
   * @param {number} N @param {PlanSamples[]} samples @param {{ chip?: string }} o */
  function planStoch(p, stages, priceOf, steps, N, samples, o) {
    const H = p.steps.length;
    const pts = (/** @type {string} */ id, /** @type {number} */ h, /** @type {number} */ s) => {
      const sm = samples[h],
        i = sm.idx[id];
      return i == null ? 0 : sm.tot[i * N + s] + ((sm.shift && sm.shift[id]) || 0);
    };
    const price = (/** @type {string} */ id, /** @type {number} */ h, /** @type {number} */ s) => {
      let v = priceOf[id] ? priceOf[id].price : 0;
      const st = steps[id];
      if (st) for (let k = 0; k < h; k++) v += st[k * N + s] / 10;
      return v;
    };
    // the expected Boost of a held team in race h: its driver with the best boostE there
    const boostOf = (/** @type {string[]} */ ids, /** @type {number} */ h) => {
      let best = null,
        bv = -Infinity;
      for (const c of stages[h].cand)
        if (ids.includes(c.id) && c.kind === "D") {
          const v = Array.isArray(c.boostE) ? c.boostE[0] : c.boostE || 0;
          if (v > bv) ((bv = v), (best = c.id));
        }
      return best;
    };
    const s0 = p.steps[0],
      c0 = Object.fromEntries(stages[0].cand.map((c) => [c.id, c]));
    const t0 = s0.played || s0.team,
      ds0 = t0.filter((id) => c0[id] && c0[id].kind === "D");
    // race 1's price-value terms: e above the expected points x (none without x; none with Limitless, whose team
    // reverts)
    const extra =
      o.chip === "limitless"
        ? 0
        : t0.reduce((t, id) => t + (c0[id] && c0[id].x != null ? c0[id].e - /** @type {number} */ (c0[id].x) : 0), 0);
    let sum = 0,
      sumFit = 0,
      fitAll = 0,
      held = 0,
      s = 0;
    const pts0 = (/** @type {string} */ id) => pts(id, 0, s);
    for (; s < N; s++) {
      let v = chipScore(t0, ds0, s0.boost, s0.boost2, o.chip || "", pts0) - s0.penalty;
      // the same future with every planned move made, fitting or not (valueFit: what holding costs, like for like)
      let vFit = v;
      for (let h = 1; h < H; h++) {
        const st = p.steps[h];
        for (const id of st.team) vFit += pts(id, h, s);
        vFit += pts(st.boost, h, s) - st.penalty;
      }
      sumFit += vFit;
      let bank = s0.cap - s0.team.reduce((t, id) => t + price(id, 0, s), 0),
        team = s0.team,
        hold = false,
        fit = true;
      for (let h = 1; h < H; h++) {
        const st = p.steps[h];
        const budget = bank + team.reduce((t, id) => t + price(id, h, s), 0);
        if (!hold && st.transfers > 0) {
          const cost = st.team.reduce((t, id) => t + price(id, h, s), 0);
          if (cost > budget + 1e-6) {
            hold = true;
            fit = false;
          }
        }
        if (hold) {
          const b = boostOf(team, h);
          for (const id of team) v += pts(id, h, s);
          if (b) v += pts(b, h, s);
          bank = budget - team.reduce((t, id) => t + price(id, h, s), 0);
        } else {
          for (const id of st.team) v += pts(id, h, s);
          v += pts(st.boost, h, s) - st.penalty;
          bank = Math.max(0, budget - st.team.reduce((t, id) => t + price(id, h, s), 0));
          team = st.team;
        }
      }
      sum += v;
      if (fit) fitAll++;
      if (hold) held++;
    }
    return { value: sum / N + extra, valueFit: sumFit / N + extra, afford: fitAll / N, held: held / N };
  }
  /** The share of sampled price futures in which every later race's transfers fit the budget: a sample's budget is
   * what was left in the bank plus the value of the team held, at that sample's prices (a race without transfers
   * always passes: a team can be kept whatever its value). @param {Plan} p
   * @param {Record<string, Candidate>} priceOf today's prices @param {Record<string, Int8Array>} steps
   * @param {number} N samples per race in steps */
  function planAfford(p, priceOf, steps, N) {
    const H = p.steps.length;
    if (!N || H < 2) return 1;
    let ok = 0;
    for (let s = 0; s < N; s++) {
      // price of id before race h in sample s
      const price = (/** @type {string} */ id, /** @type {number} */ h) => {
        let v = priceOf[id] ? priceOf[id].price : 0;
        const st = steps[id];
        if (st) for (let k = 0; k < h; k++) v += st[k * N + s] / 10;
        return v;
      };
      let bank = p.steps[0].cap - p.steps[0].team.reduce((t, id) => t + price(id, 0), 0),
        fits = true;
      for (let h = 1; h < H && fits; h++) {
        const prev = p.steps[h - 1].team,
          cur = p.steps[h];
        const budget = bank + prev.reduce((t, id) => t + price(id, h), 0),
          cost = cur.team.reduce((t, id) => t + price(id, h), 0);
        if (cur.transfers > 0 && cost > budget + 1e-6) fits = false;
        bank = Math.max(0, budget - cost);
      }
      if (fits) ok++;
    }
    return ok / N;
  }

  /* ---------- projections ---------- */
  const DEFAULTS = { halfLife: 4, blend: 0, sims: 10000, pw: 1, oddsW: SIM.oddsW };
  /** Recency-weighted fantasy points over the last six active rounds, same team where possible.
   * @param {Asset} a @returns {number | null} */
  function recentForm(a) {
    let h = /** @type {HistRow[]} */ (a.hist.filter((x) => x && x.active && x.team === a.team));
    if (h.length < 2) h = /** @type {HistRow[]} */ (a.hist.filter((x) => x && x.active));
    h = h.slice(-6);
    if (!h.length) return null;
    let s = 0,
      w = 0;
    h.forEach((x, i) => {
      const k = Math.pow(0.8, h.length - 1 - i);
      s += k * x.pts;
      w += k;
    });
    return s / w;
  }
  /** @param {{ mean: number }} st @param {number | null} form @param {number} blend */
  const blendMean = (st, form, blend) => (form == null ? st.mean : (1 - blend) * st.mean + blend * form);
  /** Stage 4: each team's pace shift (%, + = slower) at the next track from its fast-corner band (see MODEL.bandQ).
   * Needs the track's practice band shares (data.bands[gd].FP) and MODEL.bandMin earlier rounds with them.
   * @param {Data} data @param {Gameday} g @returns {Record<string, number> | null} */
  function bandShift(data, g) {
    const B = data.bands || {},
      fp = B[g.gd] && B[g.gd].FP;
    if (!fp) return null;
    const prior = Object.keys(B)
      .map(Number)
      .filter((x) => x < g.gd && (data.done || []).includes(x));
    const shares = prior.map((x) => B[x].FP && B[x].FP.share[2]).filter((v) => v != null);
    if (shares.length < MODEL.bandMin) return null;
    const ds = fp.share[2] - shares.reduce((a, b) => a + /** @type {number} */ (b), 0) / shares.length;
    /** @type {Record<string, { s: number, n: number }>} */
    const rel = {};
    for (const x of prior) {
      const q = B[x].Q;
      if (!q) continue;
      for (const [tm, v] of Object.entries(q.teams)) {
        const e = (rel[tm] = rel[tm] || { s: 0, n: 0 });
        e.s += v.band[2] - v.gap;
        e.n++;
      }
    }
    return Object.fromEntries(Object.entries(rel).map(([tm, e]) => [tm, (ds * e.s) / (e.n + MODEL.bandShrink)]));
  }
  /** Everything one race's simulation needs, at default settings unless overridden: the circuit (with this
   * weekend's rain forecast), the model (with practice and the market for the next race) and the sim options
   * (grid penalties, orders already known). @param {Data} data @param {Gameday} g
   * @param {{ next?: boolean, halfLife?: number, pw?: number, adj?: Record<string, number>, oddsW?: number, pen?: Record<string, number>, track?: ReturnType<typeof trackModel>, circuit?: Partial<Circuit> }} [o] */
  function raceSetup(data, g, o = {}) {
    const tm = o.track || trackModel(data);
    const c0 = withWeather(tm.forCircuit(g), data.weather && data.weather[g.gd]);
    const c = { ...c0, ...(o.circuit || {}) };
    const next = o.next ?? g.gd === (data.schedule.find((x) => !data.done.includes(x.gd)) || {}).gd;
    let model = buildModel(data, {
      halfLife: o.halfLife ?? DEFAULTS.halfLife,
      adj: o.adj || {},
      teamShift: c.teamShift || {},
      practice: next ? data.practice || [] : [],
      practiceWeight: o.pw ?? DEFAULTS.pw,
      paceShift: next && (MODEL.bandQ || MODEL.bandR) ? bandShift(data, g) || {} : {},
    });
    const odds = data.odds && data.odds.gd === g.gd ? sameAgeBooks(data.odds, g) : null;
    const wk = data.weekend && data.weekend.gd === g.gd ? data.weekend : null;
    /** @type {SimOpts} */
    const simOpt = {
      pen: { ...((wk && wk.penalties) || {}), ...(o.pen || {}) },
      known: next && wk ? { ...wk.grid } : {},
      status: next && wk ? wk.status || {} : {},
      fl: next && wk ? wk.fl || {} : {},
      locked: next ? scoredSessions(data, g) : {},
    };
    // qualifying scored before OpenF1 has its order (it's closed while any session runs): the order from the
    // scoring lines' positions; without one, qualifying stays simulated (its points and grid go together)
    const lk = /** @type {{ q?: Record<string, number[]> }} */ (simOpt.locked);
    const known = /** @type {Record<string, string[]>} */ (simOpt.known);
    if (lk.q && !known.q) {
      const order = qualiOrderFromLive(data);
      if (order) known.q = order;
      else delete lk.q;
    }
    if (next && odds)
      model = applyOdds(model, c, odds, {
        w: o.oddsW ?? SIM.oddsW,
        seed: g.gd * 31 + 7,
        simOpt: oddsKnown(simOpt, odds, g, wk || {}),
      });
    const fl = next && odds && odds.fl;
    if (fl) model = { ...model, drivers: model.drivers.map((d) => ({ ...d, flMk: fl[d.tla] ?? 0 })) };
    // oddsCheck: set by forecastRaces once the race is simulated
    return { circuit: c, model, simOpt, odds: !!odds, oddsCheck: /** @type {OddsCheck | null} */ (null) };
  }
  /** The page's forecast: the next three races, each set up by raceSetup with setup(g, k) and simulated with one persist
   * seed (sample s is one coherent future: the same car strength each race). The page runs it (web/js/forecast.js)
   * and so does tools/presim.js at build time, with the default settings, for the page to use instead.
   * @param {Data} data @param {{ setup: (g: Gameday, k: number) => Parameters<typeof raceSetup>[2], sprint0: boolean, sims: number }} o */
  function forecastRaces(data, o) {
    const races = data.schedule.filter((g) => !data.done.includes(g.gd)).slice(0, 3);
    // the circuit model from this same data unless the caller gives one built from it (fourth review: a model built
    // from the live data kept the live practice in a run as at lock)
    let tm = /** @type {ReturnType<typeof trackModel> | null} */ (null);
    const setups = races.map((g, k) => {
      const so = o.setup(g, k) || {};
      return raceSetup(data, g, so.track ? so : { ...so, track: (tm = tm || trackModel(data)) });
    });
    const sims = races.map((g, k) => {
      const { seed, persist } = raceSeeds(g, races[0]);
      return simulate(setups[k].model, setups[k].circuit, k === 0 ? o.sprint0 : g.sprint, o.sims, seed, {
        ...setups[k].simOpt,
        persist,
      });
    });
    // how closely the next race's market fit holds on these sims (other samples than the fit's own)
    if (setups[0]) setups[0].oddsCheck = oddsCheck(setups[0].model, sims[0]);
    return { races, setups, sims };
  }
  /** A race's seeds in the forecast: its own, and the persist seed shared by the forecast's races (from the first
   * of them). The page, the frozen record (project) and the Sim lab all take them from here, so the same job draws
   * the same samples everywhere. @param {Gameday} g @param {Gameday} first */
  function raceSeeds(g, first) {
    return { seed: g.gd * 7919 + 13, persist: first.gd * 104729 + 1 };
  }
  /** Whether the next race's team lock has passed at the data's time. @param {Data} data */
  function pastLock(data) {
    const next = data.schedule.find((g) => !data.done.includes(g.gd));
    return !!next && !!data.generated && Date.parse(next.lock) <= Date.parse(data.generated);
  }
  /** The data as it stood at lock (the everyday sim after lock, the user's call 2026-09-27): no session run or scored
   * since (qualifying, sprint), the market going in (oddsLock) and, from the snapshot refresh.py froze at lock
   * (data.lockSnap, third review), that race's weather, practice and grid penalties as they were then, not as later
   * refreshes have them. Without a snapshot: penalties announced after lock (penAt) are left out; the rest is the
   * data's own. Before lock it simulates the same as the data itself. @param {Data} data @returns {Data} */
  function atLock(data) {
    const next = data.schedule.find((g) => !data.done.includes(g.gd));
    const past = pastLock(data);
    const snap = past && next && data.lockSnap && data.lockSnap.gd === next.gd ? data.lockSnap : null;
    const wk = data.weekend && { ...data.weekend, grid: {}, status: {}, fl: {} };
    if (wk && past && next) {
      if (snap) {
        wk.penalties = { ...snap.penalties };
        wk.penAt = { ...(snap.penAt || {}) };
        wk.penParts = { ...(snap.penParts || {}) };
      } else {
        // what had been announced by lock: each component of a penalty by its own time (penParts), else its latest
        wk.penalties = oddsKnown({ pen: wk.penalties || {} }, { at: next.lock }, next, wk).pen || {};
      }
    }
    /** @type {Data} */
    const out = {
      ...data,
      live: null,
      weekend: wk,
      odds: past ? data.oddsLock || null : data.odds,
    };
    if (snap && next) {
      out.weather = { ...(data.weather || {}) };
      if (snap.weather) out.weather[next.gd] = snap.weather;
      else delete out.weather[next.gd];
      if (snap.practice) out.practice = snap.practice;
      if (snap.bands) out.bands = snap.bands;
    }
    return out;
  }
  /** This weekend's sessions the fantasy feed has already scored (data.live, the player feed's per-session points):
   * q = qualifying, s = the sprint (F1 Fantasy's "Sprint Qualifying" session). A session counts once it has ended
   * before the feed's time and every racing asset has points for it. Returns asset id -> [points, negative part]
   * per session; the negative part comes from the scoring lines when they add up to the session's points.
   * @param {Data} data @param {Gameday} g @returns {{ q?: Record<string, number[]>, s?: Record<string, number[]> }} */
  function scoredSessions(data, g) {
    const live = data.live;
    /** @type {{ q?: Record<string, number[]>, s?: Record<string, number[]> }} */
    const out = {};
    if (!live || live.gd !== g.gd || !live.feedTime) return out;
    const names = data.evNames || [];
    const fed = Date.parse(live.feedTime);
    for (const [key, type, code] of /** @type {const} */ ([
      ["q", "Qualifying", "Q"],
      ["s", "Sprint Qualifying", "S"],
    ])) {
      const sess = (g.sessions || []).find((x) => x.type === type);
      if (!sess || !sess.end || !(Date.parse(sess.end) < fed)) continue;
      const racing = Object.entries(live.assets || {}).filter(([, a]) => a.act);
      if (!racing.length || !racing.every(([, a]) => a.sess && typeof a.sess[type] === "number")) continue;
      /** @type {Record<string, number[]>} */
      const m = {};
      for (const [id, a] of racing) {
        const p = (a.sess && a.sess[type]) || 0;
        const lines = (a.ev || []).filter(([i]) => names[i] && names[i].s === code);
        const sum = lines.reduce((t, [, v]) => t + v, 0);
        const neg = sum === p ? lines.reduce((t, [, v]) => t + Math.min(0, v), 0) : Math.min(0, p);
        m[id] = [p, neg];
      }
      out[key] = m;
    }
    return out;
  }
  /** The qualifying order from the live weekend's "Qualifying Position" lines ("7th"), or null unless every racing
   * driver has one. @param {Data} data @returns {string[] | null} */
  function qualiOrderFromLive(data) {
    const live = data.live,
      names = data.evNames || [];
    if (!live) return null;
    /** @type {{ tla: string, pos: number }[]} */
    const rows = [];
    for (const a of data.assets) {
      const la = a.kind === "D" && live.assets[a.id];
      if (!la || !la.act) continue;
      const line = (la.ev || []).find(([i]) => names[i] && names[i].c === "Q POS");
      const pos = line ? parseInt(String(line[2]), 10) : NaN;
      if (!(pos > 0)) return null;
      rows.push({ tla: a.tla, pos });
    }
    return rows.length >= 10 ? rows.sort((x, y) => x.pos - y.pos).map((x) => x.tla) : null;
  }
  /** A market whose books were fetched on both sides of the end of qualifying (a stale book from the cache next to
   * fresh ones, asOf per book): only the books from after it, with at = the oldest of those, so the fit conditions
   * each book on what it knew (third review) instead of one time for all. Otherwise the odds as they are.
   * @param {Odds} odds @param {Gameday} g @returns {Odds} */
  function sameAgeBooks(odds, g) {
    const q = (g.sessions || []).find((x) => x.type === "Qualifying");
    const asOf = odds.asOf || {};
    if (!q || !q.end) return odds;
    const end = Date.parse(q.end);
    const books = /** @type {("win" | "podium" | "top10" | "pole" | "fl")[]} */ (Object.keys(asOf)).filter(
      (k) => odds[k] && asOf[k],
    );
    const late = books.filter((k) => Date.parse(/** @type {string} */ (asOf[k])) >= end);
    if (!late.length || late.length === books.length) return odds;
    /** @type {Odds} */
    const out = { ...odds, dropped: books.filter((k) => !late.includes(k)) };
    for (const k of /** @type {string[]} */ (out.dropped)) delete out[/** @type {"win"} */ (k)];
    out.at = late.map((k) => /** @type {string} */ (asOf[k])).sort()[0];
    return out;
  }
  /** What the market saw when it was quoted (odds.at: when its books were fetched, the oldest of them; missing =
   * unknown, and then nothing dated counts as known): the qualifying order only if the quote is from after
   * qualifying ended; grid penalties only as far as race control or the stewards had announced them before the quote.
   * wk.penParts (TLA -> [places, announced][], 99 = back of the grid) counts each component of an accumulated penalty
   * by its own time; wk.penAt (TLA -> the latest announcement) is the fallback; a penalty with no time (set by hand)
   * counts as known. @param {SimOpts} simOpt @param {Odds} odds @param {Gameday} g
   * @param {{ penAt?: Record<string, string>, penParts?: Record<string, [number, string | null][]> }} [wk]
   * @returns {SimOpts} */
  function oddsKnown(simOpt, odds, g, wk = {}) {
    const known = simOpt.known || {};
    const at = odds.at ? Date.parse(odds.at) : NaN;
    const before = (/** @type {string | null | undefined} */ t) => !t || at >= Date.parse(t);
    const q = (g.sessions || []).find((x) => x.type === "Qualifying");
    const after = !!(q && q.end && at >= Date.parse(q.end));
    /** @type {Record<string, string[]>} */
    const k = {};
    if (after && known.q) k.q = known.q;
    if (after && known.race) k.race = known.race;
    /** @type {Record<string, number>} */
    const pen = {};
    const parts = wk.penParts || {},
      penAt = wk.penAt || {};
    for (const [t, v] of Object.entries(simOpt.pen || {})) {
      if (parts[t]) {
        const seen = parts[t].filter(([, a]) => before(a));
        const n = seen.some(([p]) => p >= 99) ? 99 : seen.reduce((s, [p]) => s + p, 0);
        // a hand-set penalty on top of the announced ones (simOpt.pen differs from their sum) stays in full
        const all = parts[t].some(([p]) => p >= 99) ? 99 : parts[t].reduce((s, [p]) => s + p, 0);
        const val = v !== all ? v : n;
        if (val) pen[t] = val;
      } else if (before(penAt[t])) pen[t] = v;
    }
    return { pen, known: k };
  }
  // the random stream behind every simulation: bump when mulberry32, gauss or the order of draws changes, so a
  // stored forecast says which sequence produced it
  // 2: the weekend's weather drawn as a copula; 3: pace / reliability redraws before the driver form draws, and
  // opt.persist per-sample streams (review batch 4); 4: a negative weather correlation draws three session normals
  // (second review, 2026-09-27; rho >= 0 draws as in 3)
  // 5: gauss uses both Box-Muller halves (second review, performance)
  const RNG_VERSION = "mulberry32+box-muller-pair/5";
  /* Settings are values, not shared state (the reviews' deferred item, 2026-09-28): MODEL / SIM / TRACK hold the
     settings in force, the shipped objects unless a withSettings call has swapped in a changed copy for its fn().
     Nothing edits a settings object in place, and what leaves the engine (Engine.SIM, ...) is a read-only view, so
     a caller can't change the shipped settings by accident or leave them changed. */
  /** Run fn() with some engine settings changed ({"SIM.qSkew": 2, ...}): fn sees copies with the changes; the
   * settings in force before are back afterwards (calls nest). Every key and value is checked before anything
   * changes. @template T @param {Record<string, unknown>} set @param {() => T} fn @returns {T} */
  function withSettings(set, fn) {
    const cur = /** @type {Record<string, Record<string, unknown>>} */ ({ MODEL, SIM, TRACK });
    const next = { ...cur };
    for (const k of Object.keys(set)) {
      const [o, f] = k.split(".");
      if (!cur[o] || !(f in cur[o])) throw new Error(`withSettings: unknown setting ${k}`);
      const old = cur[o][f],
        v = set[k];
      if (old != null && typeof old !== "object" && typeof v !== typeof old)
        throw new Error(`withSettings: ${k} must be a ${typeof old}`);
      // Infinity is a documented value for a half-life ("no decay", MODEL.dnfHalfLife ships as it); NaN never is
      const inf = v === Infinity && (old === Infinity || /HalfLife$/.test(f));
      if (typeof v === "number" && !Number.isFinite(v) && !inf)
        throw new Error(`withSettings: ${k} must be finite${/HalfLife$/.test(f) ? " or Infinity" : ""}`);
      if (next[o] === cur[o]) next[o] = { ...cur[o] };
      next[o][f] = v;
    }
    const keep = { MODEL, SIM, TRACK };
    MODEL = /** @type {typeof MODEL} */ (next.MODEL);
    SIM = /** @type {typeof SIM} */ (next.SIM);
    TRACK = /** @type {typeof TRACK} */ (next.TRACK);
    try {
      return fn();
    } finally {
      ({ MODEL, SIM, TRACK } = keep);
    }
  }
  const views = new WeakMap();
  /** A read-only view of a settings object (nested objects too): reads as usual, a write throws, in sloppy-mode
   * callers as well (a frozen object would ignore it silently there). @template T @param {T} o @returns {T} */
  function readOnly(o) {
    if (!o || typeof o !== "object") return o;
    let v = views.get(o);
    if (!v) {
      const no = (/** @type {object} */ _t, /** @type {string | symbol} */ k) => {
        throw new TypeError(`Engine settings are read-only (${String(k)}): use Engine.withSettings({...}, fn)`);
      };
      v = new Proxy(o, {
        get: (t, k) => readOnly(Reflect.get(t, k)),
        set: no,
        defineProperty: no,
        deleteProperty: no,
      });
      views.set(o, v);
    }
    return v;
  }
  /** How much of a challenger's own input a data set has (fifth review: a challenger whose input is missing runs as
   * the shipped model and must not be scored as a test of itself). n = items it can use, of = items there could be.
   * @param {Data} data @param {(b: RaceBlock) => boolean} ok @param {string} what
   * @returns {{ n: number, of: number, what: string }} */
  const raceCoverage = (data, ok, what) => {
    const bs = (data.done || []).map((gd) => data.raceInfo && data.raceInfo[gd] && data.raceInfo[gd].race);
    return { n: bs.filter((b) => b && ok(b)).length, of: bs.length, what };
  };
  const passed = (/** @type {RaceBlock} */ b) => !(b.lapCheck && b.lapCheck.ok === false);
  /** The next race's market lines (and with spreads: bid / ask) a market challenger works from. @param {Data} data */
  const nextOdds = (data) => {
    const g = data.schedule.find((x) => !data.done.includes(x.gd));
    return g && data.odds && data.odds.gd === g.gd ? data.odds : null;
  };
  /** Challengers: named variants frozen next to the shipped model at every lock (tools/freeze.js) and scored against
   * it once the round is certified (backtest/accuracy.js, Model health). Adopt one only on evidence from rounds it
   * hadn't seen, and only on rounds where it was evaluable (had its own input, came out different from the
   * shipped model: projectChallengers). Keep an id once used: the archive refers to it. */
  const CHALLENGERS = [
    {
      id: "qskew2",
      label: "Qualifying noise skewed (shape 2)",
      set: { "SIM.qSkew": 2 },
      why: "the review's best R5-R15 variant: CRPS -0.023 +/- 0.013 (18 variants tried)",
    },
    {
      id: "ovhl6",
      label: "Overtake level weighted to recent rounds (half-life 6)",
      set: { "TRACK.ovHalfLife": 6 },
      why: "R1-R4 had far more overtaking than later rounds; R5-R15 CRPS -0.015 +/- 0.017",
    },
    {
      id: "racectx",
      label: "Race pace from the lap model (tyres, fuel, traffic)",
      set: { "MODEL.racePace": "ctx" },
      needs: (/** @type {Data} */ d) =>
        raceCoverage(d, (b) => !!b.paceCtx && !!b.paceSe && passed(b), "rounds with lap-model pace"),
      why: "review batch 3: steadier round to round (rank corr 0.85 vs 0.83); R5-R15 CRPS +0.020 +/- 0.034 (tie)",
    },
    {
      id: "racepool",
      label: "Race pace from the lap model, its tyre / fuel / traffic terms pooled across races",
      set: { "MODEL.racePace": "pool" },
      needs: (/** @type {Data} */ d) =>
        raceCoverage(d, (b) => !!b.pacePool && !!b.paceSePool && passed(b), "rounds with pooled pace"),
      why: "deferred for want of evidence (fourth review): pooled vs race-alone CRPS -0.006 +/- 0.010 (inconclusive); pooling moves a driver's pace by at most 0.16% (R6). Collects its evidence from R16",
    },
    {
      id: "sctimed",
      label: "Safety car timed: a late one reshuffles the order, an early one hardly",
      set: { "SIM.scTimed": 1 },
      needs: (/** @type {Data} */ d) => {
        const n = scOnsets(d.priors && d.priors.races && d.priors.races.length ? d.priors.races : null, d).length;
        return { n, of: n, what: "safety car onsets" };
      },
      why: "measured on 31 dry safety-car races 2023-2026: places moved per car above no-SC races -0.15 + 1.26 x onset share (slope 2.5 se); the average safety car keeps its fitted effect. Deferred by the fourth review for want of a target; collects its evidence from R16",
    },
    {
      id: "dnfcauses",
      label: "Retirements by cause (team mechanical + field incidents)",
      set: { "MODEL.dnfModel": "causes", "MODEL.incShrink": 1e6 },
      needs: (/** @type {Data} */ d) => raceCoverage(d, (b) => !!b.retirements, "rounds with retirement causes"),
      why: "review batch 3: retirement log loss 0.4690 vs 0.4711 walk-forward R4-R15 (small)",
    },
    {
      id: "ovenv",
      label: "Race-wide overtaking factor (a race runs high or low for everyone)",
      set: { "SIM.ovEnv": 1 },
      why: "review batch 4: joint risk; asset CRPS R5-R15 +0.002 +/- 0.014 (tie: it can't show in per-asset scores)",
    },
    {
      id: "oddsq",
      label: "Market lines weighted by their bid-ask spread",
      set: { "SIM.oddsQuality": 1 },
      needs: (/** @type {Data} */ d) => {
        const o = nextOdds(d);
        const n = o && o.spread ? Object.values(o.spread).filter((x) => x && Object.keys(x).length).length : 0;
        return { n, of: 4, what: "market lines with bid-ask spreads" };
      },
      why: "second review: a wide, thin quote says less than a tight one; spreads kept from R17 on (no past data)",
    },
    {
      id: "odds8",
      label: "Market fit run to (near) convergence: 8 steps on 5,000 sims",
      set: { "SIM.oddsIters": 8, "SIM.oddsN": 5000 },
      needs: (/** @type {Data} */ d) => ({ n: nextOdds(d) ? 1 : 0, of: 1, what: "the next race's market" }),
      why: "4 steps stop 0.3-0.4 log-odds short of the targets (R13-R15); 8 get most of what's reachable (the residual levels off by ~6: one pace per driver can't meet every line); more sims so extra steps don't chase noise",
    },
  ];
  /** The engine's settings as plain JSON (Infinity kept as a string). */
  const settingsSnapshot = () =>
    JSON.parse(JSON.stringify({ MODEL, SIM, TRACK }, (_, v) => (v === Infinity ? "Infinity" : v)));
  const PROJ_Q = [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
  ];
  /** The coming race's projection at default settings: what refresh.py freezes into the season archive at lock.
   * Null once the season is over. opt.detail adds what reproduces and scores it later: 19 quantiles and the sd per
   * asset, and a record (seed, random-stream version, every setting, and the exact simulate() inputs, which rerun
   * with the same engine give the same samples). opt.samples keeps the first n joint samples (sample prefixes don't
   * depend on N) as `joint`. @param {Data} data
   * @param {Partial<typeof DEFAULTS> & { detail?: boolean, samples?: number }} [opt] */
  function project(data, opt) {
    const o = { ...DEFAULTS, ...opt };
    const g = data.schedule.find((x) => !data.done.includes(x.gd));
    if (!g) return null;
    // the fits behind this model noted as they run (their health goes into the record)
    const { value: setup, fits } = withFitLog(() =>
      raceSetup(data, g, {
        next: true,
        halfLife: o.halfLife,
        pw: o.pw,
        oddsW: o.oddsW,
      }),
    );
    const { circuit, model, odds } = setup;
    // the page's own run of this race (forecastRaces): the same seeds, persist included
    const { seed, persist } = raceSeeds(g, g);
    const simOpt = { ...setup.simOpt, persist };
    const sim = simulate(model, circuit, g.sprint, o.sims, seed, simOpt);
    /** @type {Record<string, { x: number, p25: number, p75: number, sd?: number, q?: number[] }>} */
    const assets = {};
    sim.ids.forEach((id, i) => {
      const a = /** @type {Asset} */ (data.assets.find((x) => x.id === id)),
        st = sim.stats[i];
      const x = Math.round(blendMean(st, recentForm(a), o.blend) * 10) / 10;
      assets[id] = { x, p25: st.p25, p75: st.p75 };
      if (o.detail) {
        const sl = Array.from(sim.tot.subarray(i * sim.N, (i + 1) * sim.N)).sort((u, v) => u - v);
        const sh = x - st.mean; // the blend moves the whole distribution
        assets[id].sd = Math.round(st.sd * 100) / 100;
        assets[id].q = PROJ_Q.map((p) => Math.round((sl[Math.floor(p * sim.N)] + sh) * 10) / 10);
      }
    });
    /** @type {Record<string, unknown>} */
    const out = {
      gd: g.gd,
      sims: o.sims,
      practice: (data.practice || []).filter((p) => p.done).map((p) => p.name),
      odds,
      rain: circuit.rain,
      sc: circuit.sc,
      assets,
    };
    if (o.detail)
      out.record = {
        v: 2,
        rng: RNG_VERSION,
        seed,
        sprint: g.sprint,
        defaults: o,
        settings: settingsSnapshot(),
        oddsFit: model.oddsFit ? { ...model.oddsFit, check: oddsCheck(model, sim) } : null,
        fits: { n: fits.length, bad: fits.filter((f) => !f.ok) },
        scOver: sim.scOver,
        quantiles: PROJ_Q,
        setup: JSON.parse(JSON.stringify({ model, circuit, simOpt }, (_, v) => (v === Infinity ? "Infinity" : v))),
      };
    if (o.samples) {
      const n = Math.min(o.samples, sim.N);
      const joint = new Int16Array(sim.ids.length * n);
      sim.ids.forEach((_, i) => {
        for (let k = 0; k < n; k++) joint[i * n + k] = Math.round(sim.tot[i * sim.N + k]);
      });
      out.joint = { ids: sim.ids, n, tot: joint };
    }
    return out;
  }
  /** The challengers' projections for the coming race, each under its own settings: {id: {label, set, coverage,
   * sameAsShipped, evaluable, assets: {id: {x, q}}}}. champ = the shipped model's projection of the same data (to
   * tell a challenger that came out as the shipped model). @param {Data} data
   * @param {Partial<typeof DEFAULTS>} [opt] @param {{ assets: Record<string, unknown> } | null} [champ] */
  function projectChallengers(data, opt, champ) {
    /** @type {Record<string, unknown>} */
    const out = {};
    const shipped = champ ? /** @type {Record<string, { x: number }>} */ (champ.assets) : null;
    for (const c of CHALLENGERS) {
      const p = withSettings(c.set, () => project(data, { ...opt, detail: true }));
      if (!p) return null;
      const assets = /** @type {Record<string, { x: number, q?: number[] }>} */ (p.assets);
      // provenance (fifth review): how much of its own input it had, and whether it came out as the shipped model
      // (a silent fallback); a round with neither is not evaluable and the scoring leaves it out
      const coverage = c.needs ? c.needs(data) : null;
      const same = shipped
        ? Object.keys(assets).every((id) => shipped[id] && shipped[id].x === assets[id].x) &&
          Object.keys(shipped).every((id) => assets[id])
        : null;
      out[c.id] = {
        label: c.label,
        set: c.set,
        coverage,
        sameAsShipped: same,
        evaluable: !(coverage && coverage.n === 0) && same !== true,
        assets: Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, { x: a.x, q: a.q }])),
      };
    }
    return out;
  }

  /* ---------- past-performance presets (the Calculator's Simulation panel) ---------- */
  /** Default weight of each finished round: "weighted" = decay^(rounds back), "form" = 1 for the last `win`
   * rounds and 0 before, anything else ("classic", "ppm") = 1 for every round.
   * @param {string} preset @param {number[]} done @param {{ decay?: number, win?: number }} [o]
   * @returns {Record<number, number>} */
  function presetWeights(preset, done, o = {}) {
    const decay = o.decay ?? 0.9,
      win = o.win ?? 5;
    return Object.fromEntries(
      done.map((gd, i) => {
        const back = done.length - 1 - i;
        return [gd, preset === "weighted" ? Math.pow(decay, back) : preset === "form" ? (back < win ? 1 : 0) : 1];
      }),
    );
  }
  /** Expected points per asset from past rounds, split into sprint scoring lines ("S …" codes) and the rest, so a
   * sprint weekend can add the sprint part. Each part is a weighted average over the rounds the asset raced (sprint
   * lines over sprint rounds only; if none carries weight, over all of them). `off` drops scoring categories.
   * "ppm": the asset's price times the points per $1m of its kind and price tier (under / from $18.5m), from the same
   * weighted rounds. `nnBase` / `nnSprint` are the same with every negative line floored at 0 (No Negative).
   * Assets without a weighted round are left out.
   * @param {Data & { evNames?: { c: string }[] }} data
   * @param {{ preset: string, weights: Record<number, number>, off?: string[] }} o
   * @returns {Record<string, { base: number, sprint: number, nnBase: number, nnSprint: number }>} */
  function pastPoints(data, o) {
    const off = new Set(o.off || []),
      names = data.evNames || [],
      sprintGd = new Set(data.schedule.filter((g) => g.sprint).map((g) => g.gd));
    const w = (/** @type {number} */ gd) => (data.done.includes(gd) ? Math.max(0, o.weights[gd] ?? 1) : 0);
    // one round's points: [base, sprint, nn base, nn sprint]
    const split = (/** @type {HistRow} */ h) => {
      const r = [0, 0, 0, 0];
      if (!h.ev || !h.ev.length) {
        r[0] = h.pts;
        r[2] = h.nn ?? Math.max(0, h.pts);
        return r;
      }
      for (const [ni, v] of h.ev) {
        const c = (names[ni] && names[ni].c) || "";
        if (off.has(c)) continue;
        const s = c[0] === "S" ? 1 : 0;
        r[s] += v;
        r[s + 2] += Math.max(0, v);
      }
      return r;
    };
    const rows = (/** @type {Asset} */ a) =>
      /** @type {HistRow[]} */ (a.hist.filter((h) => h && h.active && data.done.includes(h.gd))).map((h) => ({
        h,
        p: split(h),
      }));
    // weighted sums of [base, sprint, nnBase, nnSprint] and their weights, with a price-weighted denominator for PPM
    const acc = (/** @type {{ h: HistRow, p: number[] }[]} */ rs) => {
      const s = [0, 0, 0, 0],
        ws = [0, 0],
        wp = [0, 0],
        all = [0, 0, 0]; // unweighted sprint rounds: count, sprint sum, nn sprint sum
      for (const { h, p } of rs) {
        const k = w(h.gd);
        s[0] += k * p[0];
        s[2] += k * p[2];
        ws[0] += k;
        wp[0] += k * h.price;
        if (sprintGd.has(h.gd)) {
          s[1] += k * p[1];
          s[3] += k * p[3];
          ws[1] += k;
          wp[1] += k * h.price;
          all[0]++;
          all[1] += p[1];
          all[2] += p[3];
        }
      }
      return { s, ws, wp, all };
    };
    /** @type {Record<string, { base: number, sprint: number, nnBase: number, nnSprint: number }>} */
    const out = {};
    if (o.preset === "ppm") {
      /** @type {Record<string, { s: number[], wp: number[] }>} */
      const tiers = {};
      const tierOf = (/** @type {Asset} */ a, /** @type {number} */ price) => a.kind + (price >= 18.5 ? "hi" : "lo");
      for (const a of data.assets)
        for (const { h, p } of rows(a)) {
          const t = (tiers[tierOf(a, h.price)] ||= { s: [0, 0, 0, 0], wp: [0, 0] }),
            k = w(h.gd);
          t.s[0] += k * p[0];
          t.s[2] += k * p[2];
          t.wp[0] += k * h.price;
          if (sprintGd.has(h.gd)) {
            t.s[1] += k * p[1];
            t.s[3] += k * p[3];
            t.wp[1] += k * h.price;
          }
        }
      for (const a of data.assets) {
        const t = tiers[tierOf(a, a.price)];
        if (!t || !t.wp[0]) continue;
        const per = (/** @type {number} */ i, /** @type {number} */ d) => (t.wp[d] ? (a.price * t.s[i]) / t.wp[d] : 0);
        out[a.id] = { base: per(0, 0), sprint: per(1, 1), nnBase: per(2, 0), nnSprint: per(3, 1) };
      }
      return out;
    }
    for (const a of data.assets) {
      const { s, ws, all } = acc(rows(a));
      if (!ws[0]) continue;
      // sprint lines: weighted sprint rounds, else every sprint round the asset raced, else none
      const spr = (/** @type {number} */ i) => (ws[1] ? s[i] / ws[1] : all[0] ? all[i === 1 ? 1 : 2] / all[0] : 0);
      out[a.id] = { base: s[0] / ws[0], sprint: spr(1), nnBase: s[2] / ws[0], nnSprint: spr(3) };
    }
    return out;
  }

  /** One-click overtaking scenarios for a circuit: how much a weekend's overtaking level swings around the season
   * average. Low / high = the q / 1-q quantile of each finished round's overtakes per starter over the season mean
   * (the sim draws no round-level overtaking shock, so this is the spread a single weekend can land in). Multipliers
   * on the circuit's fitted Overtaking; null with fewer than `minRounds` rounds.
   * @param {Data} data @param {{ q?: number, minRounds?: number }} [o]
   * @returns {{ low: number, high: number, n: number } | null} */
  function ovScenarios(data, o = {}) {
    const q = o.q ?? 0.2;
    /** @type {number[]} */
    const xs = [];
    for (const gd of data.done) {
      const v = data.trackStats && data.trackStats[gd] ? data.trackStats[gd].ovt : null;
      if (v != null && v > 0) xs.push(v);
    }
    if (xs.length < (o.minRounds ?? 4)) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const r = xs.map((v) => v / m);
    const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
    return { low: round2(quantile(r, q)), high: round2(quantile(r, 1 - q)), n: xs.length };
  }

  const api = {
    QPTS,
    RPTS,
    SPTS,
    // the current settings (the shipped ones, or a withSettings call's), read-only: a write throws
    get MODEL() {
      return readOnly(MODEL);
    },
    get SIM() {
      return readOnly(SIM);
    },
    get TRACK() {
      return readOnly(TRACK);
    },
    PIT_BANDS,
    PIT_FASTEST,
    FEAT_NAMES,
    PRICE_BANDS,
    DEFAULTS,
    circuitFor,
    trackModel,
    practiceRef,
    bandShift,
    ovScenarios,
    withWeather,
    seasonRounds,
    gridFromOv,
    tauFor,
    ridge,
    poissonGlm,
    symEig,
    normCdf,
    normInv,
    biNormCdf,
    latentCorr,
    spearman,
    buildModel,
    expectedPositions,
    fitOvertakes,
    practiceRanks,
    simulate,
    raceLaps,
    raceSegs,
    applyOdds,
    sameAgeBooks,
    oddsCheck,
    pairedCompare,
    lookZ,
    chipScore,
    scWeight,
    scTiming,
    withFitLog,
    priceStep,
    priceSteps,
    priceBase,
    pricePath,
    streamFor,
    optimise,
    budgetCurve,
    planHorizon,
    mulberry32,
    poisson,
    gauss,
    pick,
    recentForm,
    blendMean,
    raceSetup,
    forecastRaces,
    raceSeeds,
    pastLock,
    atLock,
    withSettings,
    CHALLENGERS,
    RNG_VERSION,
    projectChallengers,
    scoredSessions,
    oddsKnown,
    project,
    presetWeights,
    pastPoints,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else /** @type {any} */ (root).Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
