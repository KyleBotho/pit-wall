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
  const MODEL = {
    prior: 1.5, // backtested (flat 0.5-4): pseudo-races of the team-mate average mixed into each driver's pace
    defaultGap: 2.5, // hand-set: % off the fastest for a team with no history
    gapCap: 4, // hand-set: a round's gap above this (%) counts as this (a problem lap, damage)
    paceShrink: 0.8, // fitted (npm run fit): share of each driver's gap to the field median that's kept
    rankSlope: 0.1, // hand-set: % per place when a round has no lap-time pace (only its finishing order)
    dnfHalfLife: Infinity, // backtested: no recency weighting of retirements (every race counts the same)
    dnfShrink: 16, // backtested: pseudo-races of the grid-wide retirement rate mixed into each team's
    dnfFallback: 0.12, // hand-set: retirement rate before any race has run
    defaultOvertakes: 3, // hand-set: race overtake points for a driver with no races
    sprintOvertakeShare: 0.4, // hand-set prior; this season's sprints move it (shrunk: they're noisy)
    ovShrink: 12, // hand-set: pseudo-overtakes behind each driver's own overtaking skill
    practiceQ: 0.5, // backtested: share of practice short-run pace blended into qualifying pace
    practiceR: 0, // backtested: long runs add nothing to race pace since it comes from race laps (section 4)
    practicePull: 0.8, // backtested: most % practice can move a driver (a spin or red flag shouldn't wreck one)
    practiceMinLaps: 6, // hand-set: fewer laps than this in a session = no signal
    practiceMinDrivers: 6, // hand-set: fewer drivers with a time than this = no comparison
    pitRecent: 8, // hand-set: races of pit-stop points used per constructor
    dotdShrink: 2, // hand-set: pseudo-votes "as expected" behind each driver's Driver of the Day popularity
    pitDotd: 0.9, // measured: Driver of the Day points per race that the pit residual leaves out (fallback model)
    mate: "blend", // backtested (section 9, 2026-09-25: a tie): "blend" = each driver's pace mixed with prior races of
    // the team average; "car" = the car's pace (both cars, recency-weighted) plus the driver's offset to it
    offPrior: 3, // "car" only: pseudo-races of zero offset behind each driver's offset to his car (1.5-6 all tie)
    offHalfLife: Infinity, // "car" only: recency half-life of the offset (8 was slightly worse)
  };
  const SIM = {
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
    rainNoise: 1.6, // measured (priors.py wet vs dry races): noise in a wet session
    rainDnf: 1.4, // measured: retirements in a wet race
    flDecay: 2.2, // fitted: fastest-lap weight by finishing position, exp(-(pos-1)/flDecay)
    dotd: [12, 4, 3, 0.4, 0.03], // hand-set: Driver of the Day weight for P1, P2, P3, P4-6, P7+
    dotdGain: 0.4, // hand-set: extra DotD weight per place gained beyond four, for a top-8 finisher
    pitSd: [2, 10], // hand-set: bounds on a constructor's pit points spread (fallback model)
    oddsW: 0.5, // backtested (R5-R14 Kalshi at lock): market weight; 0.25-0.5 tie on CRPS, 0.5 best on MAE
    ovModel: 1, // backtested: 1 = overtakes from the grid / places-moved regression, 0 = each driver's season rate
    pitStops: 1, // backtested: 1 = resample the team's real pit scoring lines, 0 = its leftover race points
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

  /** @typedef {{ ov: number, ovMean?: number, kmh?: number, laps?: number, lapT?: number, grid: number, chaos: number, sc?: number, scOv?: number, rain?: { q?: number, s?: number, r?: number }, note: string, feat: number[], teamShift?: Record<string, number>, id?: string, prior?: Record<string, number | null> }} Circuit */
  /** @typedef {{ tla: string, team: string, pos: number, grid?: number, cls?: boolean, fl?: boolean, gap?: number | null, num?: number }} ResultRow */
  /** @typedef {{ gd: number, price: number, pts: number, active: boolean, team: string, r?: number | null, nn?: number, ev?: any[][], own?: number }} HistRow */
  /** @typedef {{ id: string, kind: "D" | "C", name?: string, tla: string, team: string, price: number, active: boolean, overtakePts: number, own?: number, hist: (HistRow | null)[] }} Asset */
  /** @typedef {{ name: string, done: boolean, ref?: number | null, drivers: Record<string, { q: number | null, r: number | null, laps: number }> }} PracticeSession */
  /** @typedef {{ gd: number, name: string, sprint: boolean, lock: string, circuit?: string, raceStart?: string }} Gameday */
  /** @typedef {{ circuits?: { list: [string, number[], string][], km?: Record<string, number> }, field?: number }} SeasonCfg */
  /** @typedef {{ season: number, round: number, circuit: string, name: string, starters: number, dnf: number, move: number | null, gain: number | null, gridCorr: number | null, sc?: number, vsc?: number, red?: number, rain?: number, ovt?: number | null }} PriorRow */
  /** @typedef {{ sc: number, vsc: number, red: number, rain: number, pits: Record<string, number[]>, pace: Record<string, number> }} RaceBlock */
  /** @typedef {{ win?: Record<string, number>, podium?: Record<string, number>, top10?: Record<string, number>, pole?: Record<string, number>, fl?: Record<string, number>, gd?: number }} Odds */
  /** @typedef {{ schedule: Gameday[], done: number[], assets: Asset[], results: { race: Record<string, ResultRow[]>, quali: Record<string, ResultRow[]>, sprint: Record<string, ResultRow[]> }, trackStats?: Record<string, { ovt: number, lap?: number }>, practice?: PracticeSession[], cfg?: SeasonCfg, evNames?: { c: string }[], priors?: { races: PriorRow[] } | null, raceInfo?: Record<string, { race?: RaceBlock, sprint?: RaceBlock }>, weather?: Record<string, { q?: number | null, s?: number | null, r?: number | null }>, odds?: Odds | null, weekend?: { gd: number, penalties: Record<string, number>, grid: Record<string, string[]> } | null }} Data */

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
  /** Solve A x = b (Gauss-Jordan with partial pivoting). @param {number[][]} A @param {number[]} b */
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let i = 0; i < n; i++) {
      let pv = i;
      for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[pv][i])) pv = k;
      [M[i], M[pv]] = [M[pv], M[i]];
      if (Math.abs(M[i][i]) < 1e-12) M[i][i] = 1e-12;
      for (let k = 0; k < n; k++)
        if (k !== i) {
          const f = M[k][i] / M[i][i];
          for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
        }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  /** Ridge regression on centred features, solved directly. @param {number[][]} X @param {number[]} y @param {number} lam @returns {number[]} */
  function ridge(X, y, lam) {
    const k = X.length ? X[0].length : 3;
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lam : 0)));
    const b = new Array(k).fill(0);
    X.forEach((x, n) => {
      for (let i = 0; i < k; i++) {
        b[i] += x[i] * y[n];
        for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      }
    });
    return solve(A, b);
  }
  /** Poisson regression with an offset (IRLS), light ridge on all but the intercept (column 0).
   * @param {number[][]} X @param {number[]} y @param {number[]} off @param {number} [lam] */
  function poissonGlm(X, y, off, lam = 0.5) {
    const k = X[0].length;
    let b = new Array(k).fill(0);
    const my = y.reduce((s, v) => s + v, 0) / y.length,
      mo = off.reduce((s, v) => s + Math.exp(v), 0) / off.length;
    b[0] = Math.log(Math.max(1e-6, my) / Math.max(1e-6, mo));
    for (let it = 0; it < 30; it++) {
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
      const step = solve(A, g);
      b = b.map((v, i) => v + step[i]);
      if (step.every((s) => Math.abs(s) < 1e-7)) break;
    }
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
  const logit = (/** @type {number} */ p) => {
    const q = clamp(p, 0.004, 0.996);
    return Math.log(q / (1 - q));
  };

  /** Seeded uniform random numbers in [0, 1). @param {number} a */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** @typedef {() => number} Rng */
  /** @param {Rng} r */
  function gauss(r) {
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  /** Standard (mean 0, sd 1) skew-normal draw with shape a; a = 0 is gauss(r) itself (same random stream).
   * @param {Rng} r @param {number} a */
  function skewNoise(r, a) {
    if (!a) return gauss(r);
    const d = a / Math.sqrt(1 + a * a);
    const x = d * Math.abs(gauss(r)) + Math.sqrt(1 - d * d) * gauss(r);
    return (x - d * Math.sqrt(2 / Math.PI)) / Math.sqrt(1 - (2 * d * d) / Math.PI);
  }
  /** @param {number} l @param {Rng} r */
  function poisson(l, r) {
    if (l <= 0) return 0;
    if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * gauss(r)));
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
  /** Index drawn with probability proportional to its weight. @param {number[]} weights @param {Rng} r */
  function pick(weights, r) {
    let s = 0;
    for (const w of weights) s += w;
    let x = r() * s;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x <= 0) return i;
    }
    return weights.length - 1;
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
        dnf: rows.filter((x) => !x.cls).length / rows.length,
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
  const TRACK = {
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
  };
  /** @param {Data} data @param {Partial<typeof TRACK> & { noPriors?: boolean }} [opt] */
  function trackModel(data, opt) {
    const o = { ...TRACK, ...opt };
    const byGd = Object.fromEntries(data.schedule.map((g) => [g.gd, g]));
    const season = seasonRounds(data);
    const rounds = Object.keys(season)
      .map(Number)
      .filter((gd) => season[gd].ov != null);
    const P = !o.noPriors && data.priors && data.priors.races && data.priors.races.length ? data.priors.races : null;
    // features by circuit id and name (the id wins: 2026's "Bahrain GP" ran at Sepang)
    const featOf = (/** @type {string} */ name) => circuitFor(name, data.cfg).feat;

    // ---- per-circuit priors from past seasons
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
              )
            : [0, 0, 0];
        featFit[m] = { b, mean, y: my };
      }
      const F = featFit[m],
        f = featOf(name);
      const v = F.y + F.b.reduce((s, bj, j) => s + bj * (f[j] - F.mean[j]), 0);
      return m === "corr" ? clamp(v, 0.2, 0.95) : Math.max(0, v);
    }

    // ---- this season vs the priors: trend per metric, residuals on features
    const cid = (/** @type {number} */ gd) => byGd[gd] && byGd[gd].circuit;
    const nm = (/** @type {number} */ gd) =>
      ((byGd[gd] && byGd[gd].circuit) || "") + " " + ((byGd[gd] && byGd[gd].name) || "");
    const seasonMean = (/** @type {"ov" | "move" | "dnf" | "corr" | "sc"} */ m) => {
      const v = Object.values(season)
        .map((x) => x[m])
        .filter((x) => x != null);
      return v.length
        ? /** @type {number} */ (v.reduce((a, b) => /** @type {number} */ (a) + /** @type {number} */ (b), 0)) /
            v.length
        : NaN;
    };
    const ovMean = seasonMean("ov"),
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
      );
    };
    const bOv = fitted && !P ? residFit("ov", o.ovLambda * 8) : [0, 0, 0];
    const bDnf = fitted && !P ? residFit("dnf", o.dnfLambda * 8) : [0, 0, 0];
    // overtakes under a safety car vs without (restarts), from past seasons and this one
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

    // team-specific pace by track features (off by default: no better than none in the backtest)
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
        );
      }
    }
    const dot = (/** @type {number[]} */ b, /** @type {number[]} */ x) => b[0] * x[0] + b[1] * x[1] + b[2] * x[2];

    // average speed (km/h) -> the round's overtake level
    const km = (data.cfg && data.cfg.circuits && data.cfg.circuits.km) || {};
    const kmh = (/** @type {string | undefined} */ id, /** @type {number | null | undefined} */ lap) =>
      id && km[id] && lap ? (km[id] * 3600) / lap : null;
    const nextGd = (data.schedule.find((x) => !(data.done || []).includes(x.gd)) || {}).gd;
    const sp = (() => {
      const pts = [];
      for (const gd of rounds) {
        const v = kmh(cid(gd), data.trackStats && data.trackStats[gd] && data.trackStats[gd].lap);
        const ob = season[gd].ov;
        if (v != null && ob != null && ob > 0) pts.push([v, Math.log(ob)]);
      }
      if (pts.length < o.speedMin) return null;
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length,
        my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const sx = Math.sqrt(pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) / pts.length) || 1;
      let sxy = 0,
        szz = 0;
      for (const [x, y] of pts) {
        sxy += ((x - mx) / sx) * (y - my);
        szz += ((x - mx) / sx) ** 2;
      }
      const b = sxy / (szz + o.speedLambda);
      const res = pts.reduce((a, [x, y]) => a + (y - my - (b * (x - mx)) / sx) ** 2, 0) / Math.max(1, pts.length - 2);
      return { b, mx, sx, my, res, n: pts.length };
    })();

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
        c.rain = { r: pr && pr.rain != null ? clamp(pr.rain, 0.02, 0.8) : 0.1 };
        c.rain.q = c.rain.r;
        c.rain.s = c.rain.r;
        c.scOv = scOv;
        c.teamShift = Object.fromEntries(
          Object.entries(bTeam).map(([t, b]) => [t, clamp(dot(b, x), -o.teamShiftMax, o.teamShiftMax)]),
        );
        return c;
      },
    };
  }
  /** A weekend's practice reference lap (s): the fastest finished session's `ref` (practice.py ref_lap), else null.
   * @param {PracticeSession[] | undefined} sessions */
  function practiceRef(sessions) {
    const refs = (sessions || []).filter((p) => p.done && p.ref).map((p) => /** @type {number} */ (p.ref));
    return refs.length ? Math.min(...refs) : null;
  }
  /** A circuit with this weekend's forecast rain on top of its climatology (the forecast wins where it exists).
   * @param {Circuit} c @param {{ q?: number | null, s?: number | null, r?: number | null } | undefined} wx @returns {Circuit} */
  function withWeather(c, wx) {
    if (!wx) return c;
    const rain = { ...(c.rain || {}) };
    for (const k of /** @type {const} */ (["q", "s", "r"]))
      if (wx[k] != null) rain[k] = clamp(/** @type {number} */ (wx[k]), 0, 1);
    return { ...c, rain };
  }

  /* ---------- model: pace, reliability, overtaking, pit stops from this season's results ---------- */
  /** @typedef {{ id: string, tla: string, team: string, qPace: number, rPace: number, qSe: number, rSe: number, qMu: number, rMu: number, dnf: number, dnfN: number, ov: number, ovU: number, practiceQ: number | null, practiceR: number | null, formQ: number, formR: number, oddsQ?: number, oddsR?: number, dotdPop?: number, flMk?: number }} DriverModel */
  /** @typedef {{ id: string, team: string, pitMu: number, pitSd: number, stops: number[] }} ConsModel stops = recent races' pit points */
  /** @typedef {{ drivers: DriverModel[], cons: ConsModel[], gRate: number, field: number, ovB: number[], ovSprint: number, slopeQ: number, slopeR: number }} Model */
  /**
   * @param {Data} data
   * @param {{ halfLife?: number, adj?: Record<string, number>, practice?: PracticeSession[], practiceWeight?: number, teamShift?: Record<string, number>, model?: Partial<typeof MODEL> }} [opt]
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
    const info = (/** @type {number} */ r) => (data.raceInfo && data.raceInfo[r]) || {};

    // reliability: retirements per car-race, shrunk toward the grid rate
    let gD = 0,
      gN = 0;
    /** @type {Record<string, number>} */
    const tD = {};
    /** @type {Record<string, number>} */
    const tN = {};
    const dDecay = Math.pow(0.5, 1 / M.dnfHalfLife);
    for (const r of rounds)
      for (const row of data.results.race[r]) {
        const w = Math.pow(dDecay, last - r);
        gN += w;
        tN[row.team] = (tN[row.team] || 0) + w;
        if (!row.cls) {
          gD += w;
          tD[row.team] = (tD[row.team] || 0) + w;
        }
      }
    const gRate = gN ? gD / gN : M.dnfFallback;

    // pace: % off the fastest in qualifying (lap times) and race (median clean lap; else finishing order)
    const cap = (/** @type {number} */ v) => Math.min(M.gapCap, Math.max(0, v));
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
        const lap = info(r).race && /** @type {RaceBlock} */ (info(r).race).pace[a.tla];
        let rg = null;
        if (lap != null) rg = cap(lap);
        else if (race && race.cls) {
          const ncls = rows.filter((x) => x.cls).length || F;
          rg = cap((((race.pos - 0.5) / ncls) * F - 0.5) * M.rankSlope);
        }
        if (rg != null) {
          rs += w * rg;
          rw += w;
          rw2 += w * w;
          rObs.push([w, rg]);
        }
      }
      return { a, qs, qw, qw2, rs, rw, rw2, qObs, rObs };
    });
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

    /** @type {DriverModel[]} */
    const dModels = raw.map((d, i) => {
      const nq = d.qw2 ? (d.qw * d.qw) / d.qw2 : 0,
        nr = d.rw2 ? (d.rw * d.rw) / d.rw2 : 0;
      // + adj = faster (grid places); the track shift is + = slower
      const nudge = (adjBy[d.a.id] || 0) - (shiftBy[d.a.team] || 0);
      const n = tN[d.a.team] || 0;
      return {
        id: d.a.id,
        tla: d.a.tla,
        team: d.a.team,
        qPace: paceQ[i] - nudge * slopeQ,
        rPace: paceR[i] - nudge * slopeR,
        qSe: sdQ / Math.sqrt(nq + P),
        rSe: sdR / Math.sqrt(nr + P),
        qMu: 0,
        rMu: 0,
        dnf: ((tD[d.a.team] || 0) + M.dnfShrink * gRate) / (n + M.dnfShrink),
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

    // Practice pace for this weekend: short runs into qualifying pace, long runs into race pace, both as % gaps
    // relative to the field (practice runs spread wider, so they're rescaled to the model's spread first).
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

    // Pit stops: the team's actual pit-stop scoring lines (band points + fastest-stop bonus) over its recent races,
    // resampled. Real stop times (OpenF1, kept in raceInfo) match the bands only ~2/3 of the time: they're rounded
    // and aren't DHL's official timing. Without scoring lines: the points left over from the constructor's race
    // score (bias-corrected for the floor at 0).
    const pitIdx = new Set(
      (data.evNames || []).map((e, i) => (/^R (FP|FP2|WRFP|PIT)$/.test(e.c) ? i : -1)).filter((i) => i >= 0),
    );
    /** @type {ConsModel[]} */
    const cModels = cons.map((c) => {
      /** @type {number[]} */
      const lines = [];
      for (const h of c.hist)
        if (h && h.ev && h.ev.length && data.results.race[h.gd])
          lines.push(h.ev.reduce((s, [i, v]) => s + (pitIdx.has(i) ? v : 0), 0));
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
      };
    });
    return {
      drivers: dModels,
      cons: cModels,
      gRate,
      field: F,
      ovB: ovModel.b,
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
      const lapPace = (data.raceInfo && data.raceInfo[r] && data.raceInfo[r].race && data.raceInfo[r].race.pace) || {};
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
        if (j !== i) e += normCdf((p - q) / (teams[i] === teams[j] ? within : across));
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
    /** @type {number[][]} */
    const X = [];
    /** @type {number[]} */
    const y = [];
    /** @type {number[]} */
    const off = [];
    /** @type {string[]} */
    const who = [];
    for (const gd of data.done || []) {
      const ts = data.trackStats && data.trackStats[gd];
      if (!ts || !(ts.ovt > 0)) continue;
      for (const row of data.results.race[gd] || []) {
        if (!row.cls || !row.grid) continue;
        const ov = byTla[row.tla] && byTla[row.tla][gd];
        if (!ov) continue;
        X.push([1, Math.log1p(Math.abs(row.grid - row.pos)), (row.grid - 1) / (F - 1)]);
        y.push(ov[0]);
        off.push(Math.log(ts.ovt));
        who.push(row.tla);
      }
    }
    if (X.length < 40)
      return { b: [0, 0, 0], sprint, skill: /** @type {Record<string, number>} */ ({}), fallback, fitted: false };
    const b = poissonGlm(X, y, off);
    /** @type {Record<string, [number, number]>} */
    const oe = {};
    X.forEach((x, n) => {
      const mu = Math.exp(off[n] + b[0] * x[0] + b[1] * x[1] + b[2] * x[2]);
      const t = (oe[who[n]] ||= [0, 0]);
      t[0] += y[n];
      t[1] += mu;
    });
    /** @type {Record<string, number>} */
    const skill = {};
    for (const [t, [ob, ex]] of Object.entries(oe)) skill[t] = Math.log((ob + M.ovShrink) / (ex + M.ovShrink));
    return { b, sprint, skill, fallback, fitted: true };
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
   * @param {{ grid: Int32Array, base: Float64Array, out: Uint8Array, ovU: number[], laps: number, T: number, sc: boolean, wet: boolean, sprint: boolean, theta: number, kappa?: number }} o
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
    const scLap = o.sc ? 2 + Math.floor(r() * Math.max(1, laps - 5)) : -1;
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
      if (frozen) frozen--;
    }
    return order;
  }
  /**
   * One race in timing segments (SIM.raceModel "segments", item 9 stage 3b): as raceLaps, with three segments a
   * lap, the segment pass curve SIM.segKernel (a car just passed by the car ahead tries less), held-up gaps drawn
   * from SIM.followMin + exponential(SIM.followMean), and the yo-yo: each segment two cars run < 0.3 s apart, both
   * make a pass-and-repass with chance SIM.yoyo (counted as overtakes, the order unchanged).
   * @param {{ grid: Int32Array, base: Float64Array, out: Uint8Array, ovU: number[], laps: number, T: number, sc: boolean, wet: boolean, sprint: boolean, theta: number, kappa?: number }} o
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
    const scSeg = o.sc ? S * (1 + Math.floor(r() * Math.max(1, o.laps - 5))) + 1 : -1;
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
      if (frozen) frozen--;
    }
    return order;
  }
  /** @typedef {{ ids: string[], N: number, field: number, tot: Float32Array, nn: Float32Array, stats: AssetStats[], sc: number, wet: number }} Sim */
  /** @typedef {{ known?: Record<string, string[]>, pen?: Record<string, number>, unc?: number }} SimOpts */
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
    const D = model.drivers,
      C = model.cons,
      nd = D.length,
      nc = C.length,
      A = nd + nc;
    const F = Math.max(model.field || 22, nd);
    const r = mulberry32(seed);
    const tot = new Float32Array(A * N),
      nn = new Float32Array(A * N);
    const cOf = D.map((d) => C.findIndex((c) => c.team === d.team));
    const teamIdx = /** @type {Record<string, number>} */ ({});
    D.forEach((d) => {
      if (teamIdx[d.team] == null) teamIdx[d.team] = Object.keys(teamIdx).length;
    });
    const tOf = D.map((d) => teamIdx[d.team]),
      nt = Object.keys(teamIdx).length;
    const unc = opt.unc ?? SIM.unc;
    const flOddsW = D.some((d) => d.flMk != null) ? SIM.flOddsW : 0;
    const known = opt.known || {};
    const pen = opt.pen || {};
    const tlaIdx = Object.fromEntries(D.map((d, i) => [d.tla, i]));
    const rain = circuit.rain || {};
    const ovB = model.ovB || [0, 0, 0];
    const ovMean = circuit.ovMean ?? 4;
    const tau = tauFor(circuit.grid ?? DEFAULT_CIRCUIT.grid);
    const pSc = circuit.sc ?? 0.5;
    const scOv = circuit.scOv ?? 1;
    // overtake level with and without a safety car, averaging to the circuit's level
    const ovLvl = ovMean * (circuit.ov ?? 1);
    const ovNoSc = ovLvl / (1 + pSc * (scOv - 1)),
      ovSc = ovNoSc * scOv;

    const pts = new Float64Array(A),
      neg = new Float64Array(A);
    const qpos = new Int32Array(nd),
      sgrid = new Int32Array(nd),
      rgrid = new Int32Array(nd);
    const qp = new Float64Array(nd),
      rp = new Float64Array(nd),
      dnfP = new Float64Array(nd),
      shock = new Float64Array(nd),
      tShock = new Float64Array(nt),
      out = new Uint8Array(nd);
    const qCount = new Uint32Array(nd * F),
      rCount = new Uint32Array(nd * (F + 1)); // last column = DNF
    const flC = new Uint32Array(nd),
      dotdC = new Uint32Array(nd),
      ovSum = new Float64Array(nd),
      pitSum = new Float64Array(nc);
    let scN = 0,
      wetN = 0;
    // per-driver points by scoring category (race weekend main events), for calibration and breakdowns
    const CATS = ["q", "rpos", "gain", "lost", "ovt", "fl", "dotd", "dnf", "sprint"],
      NC = CATS.length;
    const cat = new Float64Array(nd * NC);
    const addCat = (/** @type {number} */ i, /** @type {string} */ c, /** @type {number} */ v) => {
      cat[i * NC + CATS.indexOf(c)] += v;
    };
    const dotdW = (/** @type {number} */ pos, /** @type {number} */ g) =>
      (pos === 1
        ? SIM.dotd[0]
        : pos === 2
          ? SIM.dotd[1]
          : pos === 3
            ? SIM.dotd[2]
            : pos <= 6
              ? SIM.dotd[3]
              : SIM.dotd[4]) + (pos <= 8 ? SIM.dotdGain * Math.max(0, g - 4) : 0);
    // team reliability: Beta around the team's rate with its effective number of races
    const teamRate = D.map((d) => d.dnf),
      teamN = D.map((d) => d.dnfN || 20);

    /** A fixed order (known result) as positions; drivers missing from it go to the back in pace order. */
    const fixedOrder = (/** @type {string[]} */ order, /** @type {Int32Array} */ outArr) => {
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
    };

    const qualiOrder = (
      /** @type {Int32Array} */ outArr,
      /** @type {boolean} */ withPoints,
      /** @type {boolean} */ wet,
      /** @type {string[] | undefined} */ fixed,
    ) => {
      /** @type {{ i: number, s: number, noTime: boolean }[]} */
      const arr = [];
      if (fixed) {
        fixedOrder(fixed, outArr);
        for (let i = 0; i < nd; i++) arr.push({ i, s: outArr[i], noTime: false });
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
        if (x.noTime) {
          // no time: starts last; the -5 is waived in a wet session (the 107% rule doesn't apply)
          if (!wet) {
            pts[x.i] -= 5;
            neg[x.i] -= 5;
            addCat(x.i, "q", -5);
          }
        } else if (k < 10) {
          pts[x.i] += QPTS[k];
          addCat(x.i, "q", QPTS[k]);
        }
      });
    };

    // lap-by-lap race (SIM.raceModel "laps"): the pass level theta is set so that the simulated passes per starter
    // match the circuit's overtake level (race) and its sprint share (sprint), from pilot races at the model's pace
    const lapMode = SIM.raceModel === "laps" || SIM.raceModel === "segments";
    const runRace = SIM.raceModel === "segments" ? raceSegs : raceLaps;
    const lapT = circuit.lapT || 90,
      lapN = circuit.laps || 57,
      lapNs = Math.max(5, Math.round((lapN * 100) / 305));
    const lapPass = new Float64Array(nd),
      lapBase = new Float64Array(nd),
      ovUs = D.map((d) => d.ovU || 0);
    const lapCalib = (/** @type {boolean} */ isSprint, /** @type {number} */ target) => {
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
    };
    const calR = lapMode ? lapCalib(false, ovLvl) : { th: 0, ka: 1 },
      calS = lapMode && sprint ? lapCalib(true, ovLvl * (model.ovSprint || MODEL.sprintOvertakeShare)) : calR;

    const midW = (/** @type {number} */ g) => (g <= 3 ? 0.6 : g <= 16 ? 1.2 : 1);
    const race = (
      /** @type {Int32Array} */ grid,
      /** @type {boolean} */ isSprint,
      /** @type {{ i: number }} */ dotdOut,
      /** @type {boolean} */ wet,
      /** @type {string[] | undefined} */ fixed,
    ) => {
      out.fill(0);
      // retirements: individual, plus multi-car incidents (a share of the same total risk)
      let pSum = 0;
      for (let i = 0; i < nd; i++) {
        const p = Math.min(
          0.9,
          dnfP[i] * (circuit.chaos ?? 1) * (isSprint ? SIM.sprintDnf : 1) * (wet ? SIM.rainDnf : 1),
        );
        pSum += p;
        if (!fixed && r() < (1 - SIM.incident) * p) out[i] = 1;
      }
      if (!fixed) {
        const k = poisson((SIM.incident * pSum) / 1.5, r);
        for (let n = 0; n < k; n++) {
          const cars = r() < 0.5 ? 2 : 1;
          for (let c = 0; c < cars; c++) {
            const w = [];
            for (let i = 0; i < nd; i++) w.push(out[i] ? 0 : dnfP[i] * midW(grid[i]));
            if (w.some((v) => v > 0)) out[pick(w, r)] = 1;
          }
        }
      } else {
        // a known sprint result: whoever isn't in it retired
        const inIt = new Set(fixed.map((t) => tlaIdx[t]));
        for (let i = 0; i < nd; i++) if (!inIt.has(i)) out[i] = 1;
      }
      let nOut = 0;
      for (let i = 0; i < nd; i++) nOut += out[i];
      // safety car: each retirement brings one out with chance scPerDnf; other causes (debris, a stranded car that
      // still classifies) make up the circuit's rate: 1 - (1 - base) * (1 - q)^retirements averages to that rate
      const p = pSc * (isSprint ? SIM.sprintSc : 1),
        q = SIM.scPerDnf,
        viaDnf = Math.exp(Math.log(1 - q) * pSum),
        base = clamp(1 - (1 - p) / Math.max(1e-9, viaDnf), 0, p);
      const sc = r() < 1 - (1 - base) * Math.pow(1 - q, nOut);
      if (!isSprint && sc) scN++;
      const fin = [];
      const sd = SIM.rSd * (isSprint ? SIM.sprintSd : 1) * (wet ? SIM.rainNoise : 1) * (sc ? SIM.scNoise : 1);
      const tauNow = tau * (sc ? SIM.scTau : 1);
      const laps = lapMode && !fixed;
      for (let i = 0; i < nd; i++) {
        if (out[i]) {
          const pen = isSprint ? 10 : 20;
          pts[i] -= pen;
          neg[i] -= pen;
          addCat(i, isSprint ? "sprint" : "dnf", -pen);
          if (!isSprint) rCount[i * (F + 1) + F]++;
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
            wet,
            sprint: isSprint,
            theta: isSprint ? calS.th : calR.th,
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
            addCat(i, isSprint ? "sprint" : "ovt", lapPass[i]);
          }
      } else fin.sort((a, b) => a.s - b.s);
      /** @type {number[]} */
      const flW = [];
      /** @type {number[]} */
      const dW = [];
      const lvl = (sc ? ovSc : ovNoSc) * (isSprint ? model.ovSprint || MODEL.sprintOvertakeShare : 1);
      fin.forEach((x, k) => {
        const pos = k + 1,
          i = x.i;
        const pp = isSprint ? SPTS[k] || 0 : RPTS[k] || 0;
        pts[i] += pp;
        let g = grid[i] - pos;
        if (isSprint && g < -10) g = -10; // sprint losses are capped at -10
        pts[i] += g;
        if (g < 0) neg[i] += g;
        if (isSprint) addCat(i, "sprint", pp + g);
        else {
          addCat(i, "rpos", pp);
          addCat(i, g >= 0 ? "gain" : "lost", g);
        }
        const lam =
          lvl *
          Math.exp(
            ovB[0] + ovB[1] * Math.log1p(Math.abs(grid[i] - pos)) + ovB[2] * ((grid[i] - 1) / (F - 1)) + D[i].ovU,
          );
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
        addCat(i, isSprint ? "sprint" : "ovt", ov);
        if (!isSprint) rCount[i * (F + 1) + Math.min(k, F - 1)]++;
        flW.push(Math.exp(-(pos - 1) / SIM.flDecay));
        dW.push(dotdW(pos, g) * (D[i].dotdPop ?? 1));
      });
      if (fin.length) {
        // a share of races take the fastest lap from the market (among the finishers), the rest from the model
        const mkFl = !isSprint && flOddsW > 0 && r() < flOddsW ? fin.map((x) => D[x.i].flMk ?? 0) : null;
        const f = fin[mkFl && mkFl.some((v) => v > 0) ? pick(mkFl, r) : pick(flW, r)].i;
        pts[f] += isSprint ? 5 : 10;
        addCat(f, isSprint ? "sprint" : "fl", isSprint ? 5 : 10);
        if (!isSprint) {
          flC[f]++;
          const d = fin[pick(dW, r)].i;
          pts[d] += 10;
          dotdOut.i = d;
          dotdC[d]++;
          addCat(d, "dotd", 10);
        }
      }
    };

    const qb = new Float64Array(nc),
      qbNeg = new Float64Array(nc),
      pitPts = new Float64Array(nc);
    for (let s = 0; s < N; s++) {
      pts.fill(0);
      neg.fill(0);
      const dotd = { i: -1 };
      // this weekend's draw: pace and reliability within their uncertainty, then team and driver form
      const rel = new Float64Array(nt).fill(-1);
      for (let i = 0; i < nd; i++) {
        qp[i] = D[i].qPace + (unc ? gauss(r) * D[i].qSe * unc : 0);
        rp[i] = D[i].rPace + (unc ? gauss(r) * D[i].rSe * unc : 0);
        shock[i] = gauss(r) * SIM.drvSd;
        const t = tOf[i];
        if (rel[t] < 0) {
          const k = teamN[i] / Math.max(0.2, unc || 0.2);
          rel[t] = unc ? beta(Math.max(0.05, teamRate[i] * k), Math.max(0.05, (1 - teamRate[i]) * k), r) : teamRate[i];
        }
        dnfP[i] = rel[t];
      }
      for (let t = 0; t < nt; t++) tShock[t] = gauss(r) * SIM.teamSd;
      const wetQ = r() < (rain.q ?? 0),
        wetS = r() < (rain.s ?? rain.r ?? 0),
        wetR = r() < (rain.r ?? 0);
      if (wetR) wetN++;
      qualiOrder(qpos, true, wetQ, known.q);
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
      }
      if (sprint) {
        qualiOrder(sgrid, false, wetS, known.sq);
        race(sgrid, true, { i: -1 }, wetS, known.s);
      }
      // race grid: qualifying order with grid penalties applied
      if (Object.keys(pen).length) {
        const g = D.map((d, i) => ({
          i,
          k: qpos[i] + (pen[d.tla] ? (pen[d.tla] >= 99 ? 100 + qpos[i] / 100 : pen[d.tla] + 0.5) : 0),
        }));
        g.sort((a, b) => a.k - b.k).forEach((x, k) => (rgrid[x.i] = k + 1));
      } else rgrid.set(qpos);
      race(rgrid, false, dotd, wetR, undefined);
      // pit stops: one of the team's recent races' pit points (bonus included), else the leftover model
      for (let c = 0; c < nc; c++) {
        const st = C[c].stops;
        pitPts[c] =
          SIM.pitStops && st && st.length >= 3
            ? st[Math.floor(r() * st.length)]
            : Math.max(0, Math.round(C[c].pitMu + gauss(r) * C[c].pitSd));
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

    const ids = D.map((d) => d.id).concat(C.map((c) => c.id));
    const stats = ids.map((id, a) => {
      const sl = Array.from(tot.subarray(a * N, a * N + N)).sort((x, y) => x - y);
      let m = 0,
        mn = 0,
        m2 = 0;
      for (let s = 0; s < N; s++) {
        const v = tot[a * N + s];
        m += v;
        m2 += v * v;
        mn += nn[a * N + s];
      }
      const q = (/** @type {number} */ p) => sl[Math.floor(N * p)];
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
    return { ids, N, field: F, tot, nn, stats, sc: scN / N, wet: wetN / N };
  }

  /* ---------- the betting market (next race) ---------- */
  /** Move each driver's pace so the simulated chances of winning, a podium, a top 10 and pole move towards the
   * market's, by weight w (0 = model only, 1 = market only), in log-odds. Returns a new model; the shift per driver
   * is kept as oddsQ / oddsR (%). @param {Model} model @param {Circuit} circuit @param {Odds | null | undefined} odds
   * @param {{ w?: number, seed?: number, n?: number, iters?: number }} [o] @returns {Model} */
  function applyOdds(model, circuit, odds, o = {}) {
    const w = o.w ?? SIM.oddsW;
    if (!odds || !w || !(odds.win || odds.podium || odds.top10 || odds.pole)) return model;
    const m = { ...model, drivers: model.drivers.map((d) => ({ ...d, oddsQ: 0, oddsR: 0 })) };
    const n = o.n || 2500,
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
    const base = simulate(m, circuit, false, n, seed);
    const p0 = m.drivers.map((_, i) => probs(base, i));
    /** @type {("win" | "podium" | "top10")[]} */
    const RACE = ["win", "podium", "top10"];
    let sim = base;
    for (let it = 0; it < (o.iters || 4); it++) {
      m.drivers.forEach((d, i) => {
        const p = probs(sim, i);
        let num = 0,
          den = 0;
        for (const k of RACE) {
          const mk = odds[k] && odds[k][d.tla];
          if (mk == null) continue;
          const target = (1 - w) * logit(p0[i][k]) + w * logit(mk);
          const wt = Math.sqrt(clamp(mk, 0.01, 0.99) * (1 - clamp(mk, 0.01, 0.99)));
          num += wt * (target - logit(p[k]));
          den += wt;
        }
        const step = den ? clamp(num / den, -3, 3) * 0.12 : 0;
        d.rPace -= step;
        d.oddsR = (d.oddsR || 0) - step;
        let qStep = step * 0.6;
        const pole = odds.pole && odds.pole[d.tla];
        if (pole != null) {
          const target = (1 - w) * logit(p0[i].pole) + w * logit(pole);
          qStep = 0.5 * qStep + 0.5 * clamp(target - logit(p.pole), -3, 3) * 0.1;
        }
        d.qPace -= qStep;
        d.oddsQ = (d.oddsQ || 0) - qStep;
      });
      sim = simulate(m, circuit, false, n, seed);
    }
    finishPositions(m.drivers);
    return m;
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

  /* ---------- optimiser ---------- */
  /**
   * @typedef {{ id: string, kind: "D" | "C", price: number, e: number, boostE?: number | number[], active: boolean, f?: Record<string, number> }} Candidate
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
   * @typedef {{ team: string[], boost: string, boost2: string | null, transfers: number, penalty: number, pts: number, cost: number, cap: number, free: number }} PlanStep
   * @typedef {{ total: number, steps: PlanStep[] }} Plan
   */
  /** Best sequence of teams race by race: transfers can wait for a later race, free transfers carry over (2 a race,
   * at most one unused carries: 3 max), and the budget grows or shrinks with the price changes of the team held.
   * Beam search: `beam` teams for the first race (best by that race and by keeping them for the whole horizon), the
   * best few moves from each for the next race, and so on. The chip plays in the first race only. `firstMaxT` caps the
   * first race's transfers only (what banking transfers is worth: plan with at most k now, the rest carried over).
   * @param {Stage[]} stages @param {string[]} team @param {OptOpts & { beam?: number, bank?: number, perFree?: number, carryMax?: number, firstMaxT?: number }} o
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
    // a Limitless team reverts after the race: plan the later races from the starting team
    if (o.chip === "limitless")
      plans = plans.map((p) => ({
        ...p,
        steps: [
          {
            ...p.steps[0],
            team: team.slice(),
            cost: team.reduce((s, id) => s + (priceOf[id] ? priceOf[id].price : 0), 0),
            free: Math.min(carryMax, perFree + Math.min(1, o.free)),
          },
        ],
      }));
    for (let h = 1; h < H; h++) {
      /** @type {Plan[]} */
      const next = [];
      for (const p of plans) {
        const prev = p.steps[p.steps.length - 1];
        const dp = stages[h - 1].dPrice || {};
        // budget after the price changes of the team held through the last race
        const gain = prev.team.reduce((s, id) => s + (dp[id] || 0), 0);
        const cap = (o.chip === "limitless" && h === 1 ? o.cap : Math.max(prev.cap, prev.cost)) + gain;
        const cand = stages[h].cand.map((c) => ({ ...c, price: c.price + (dp[c.id] || 0) }));
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
    return plans.sort((a, b) => b.total - a.total).slice(0, 10);
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
    });
    const odds = data.odds && data.odds.gd === g.gd ? data.odds : null;
    if (next && odds) model = applyOdds(model, c, odds, { w: o.oddsW ?? SIM.oddsW, seed: g.gd * 31 + 7 });
    const fl = next && odds && odds.fl;
    if (fl) model = { ...model, drivers: model.drivers.map((d) => ({ ...d, flMk: fl[d.tla] ?? 0 })) };
    const wk = data.weekend && data.weekend.gd === g.gd ? data.weekend : null;
    /** @type {SimOpts} */
    const simOpt = { pen: { ...((wk && wk.penalties) || {}), ...(o.pen || {}) }, known: next && wk ? wk.grid : {} };
    return { circuit: c, model, simOpt, odds: !!odds };
  }
  /** The coming race's projection at default settings: what refresh.py freezes into the season archive at lock.
   * Null once the season is over. @param {Data} data @param {Partial<typeof DEFAULTS>} [opt] */
  function project(data, opt) {
    const o = { ...DEFAULTS, ...opt };
    const g = data.schedule.find((x) => !data.done.includes(x.gd));
    if (!g) return null;
    const { circuit, model, simOpt, odds } = raceSetup(data, g, {
      next: true,
      halfLife: o.halfLife,
      pw: o.pw,
      oddsW: o.oddsW,
    });
    const sim = simulate(model, circuit, g.sprint, o.sims, g.gd * 7919 + 13, simOpt);
    /** @type {Record<string, { x: number, p25: number, p75: number }>} */
    const assets = {};
    sim.ids.forEach((id, i) => {
      const a = /** @type {Asset} */ (data.assets.find((x) => x.id === id)),
        st = sim.stats[i];
      assets[id] = { x: Math.round(blendMean(st, recentForm(a), o.blend) * 10) / 10, p25: st.p25, p75: st.p75 };
    });
    return {
      gd: g.gd,
      sims: o.sims,
      practice: (data.practice || []).filter((p) => p.done).map((p) => p.name),
      odds,
      rain: circuit.rain,
      sc: circuit.sc,
      assets,
    };
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
    MODEL,
    SIM,
    TRACK,
    PIT_BANDS,
    PIT_FASTEST,
    FEAT_NAMES,
    PRICE_BANDS,
    DEFAULTS,
    circuitFor,
    trackModel,
    practiceRef,
    ovScenarios,
    withWeather,
    seasonRounds,
    gridFromOv,
    tauFor,
    ridge,
    poissonGlm,
    normCdf,
    spearman,
    buildModel,
    expectedPositions,
    fitOvertakes,
    practiceRanks,
    simulate,
    raceLaps,
    raceSegs,
    applyOdds,
    priceStep,
    optimise,
    budgetCurve,
    planHorizon,
    mulberry32,
    recentForm,
    blendMean,
    raceSetup,
    project,
    presetWeights,
    pastPoints,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else /** @type {any} */ (root).Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
