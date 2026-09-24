// @ts-check
/* Pit Wall engine: race-weekend Monte Carlo + official F1 Fantasy scoring + team optimiser.
   Pure functions, no DOM. Inlined into the page by refresh.py; also loadable from node (tests, backtests, the
   projection refresh.py freezes at lock). Season-specific inputs (circuit types, field size) come from
   data.cfg (config/season.json). */
(function (root) {
  const QPTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const RPTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const SPTS = [8, 7, 6, 5, 4, 3, 2, 1];

  /* Model settings. "backtested" values were chosen by walk-forward backtests; `npm run backtest` re-runs them on
     the current season (latest results in CLAUDE.md). "hand-set" values were picked by eye and are only checked by
     the calibration section there (simulated points per category at a neutral track vs this season's). */
  const MODEL = {
    prior: 1.5, // hand-set: pseudo-races of the team-mate average mixed into each driver's pace
    defaultQuali: 16, // hand-set: grid slot for a team with no qualifying history
    defaultRace: 15, // hand-set: race rank for a team with no finishes
    dnfHalfLife: 6, // backtested: recency weighting of retirements (races)
    dnfShrink: 4, // backtested: pseudo-races of the grid-wide retirement rate mixed into each team's
    dnfFallback: 0.12, // hand-set: retirement rate before any race has run
    defaultOvertakes: 3, // hand-set: race overtake points for a driver with no races
    sprintOvertakeShare: 0.4, // hand-set: a sprint's overtakes relative to a race (a third of the distance)
    practiceQ: 0.3, // backtested: share of practice short-run rank blended into qualifying pace
    practiceR: 0.1, // backtested: share of practice long-run rank blended into race pace
    practicePull: 6, // backtested: most places practice can move a driver (a spin or red flag shouldn't wreck one)
    practiceMinLaps: 6, // hand-set: fewer laps than this in a session = no signal
    practiceMinDrivers: 6, // hand-set: fewer drivers with a time than this = no comparison
    pitRecent: 8, // hand-set: races of pit-stop points averaged per constructor
    pitDotd: 0.9, // measured: Driver of the Day points per race that the pit residual leaves out
  };
  const SIM = {
    qualiNoTime: 0.012, // hand-set: chance a driver sets no qualifying time (-5, starts last)
    qualiSd: [1.1, 0.11], // hand-set: qualifying noise, sd = a + b * expected grid slot
    raceSd: [1.6, 0.12], // hand-set: race noise, sd = a + b * expected race rank
    sprintSd: 0.85, // hand-set: sprint noise relative to the race
    sprintDnf: 0.4, // hand-set: sprint retirement rate relative to the race
    flDecay: 1.6, // hand-set: fastest-lap weight by finishing position, exp(-(pos-1)/flDecay)
    dotd: [12, 4, 3, 0.4, 0.03], // hand-set: Driver of the Day weight for P1, P2, P3, P4-6, P7+
    dotdGain: 0.4, // hand-set: extra DotD weight per place gained beyond four, for a top-8 finisher
    pitSd: [2, 10], // hand-set: bounds on a constructor's pit-stop points spread
  };

  /** @typedef {{ ov: number, grid: number, chaos: number, note: string, feat: number[], teamShift?: Record<string, number> }} Circuit */
  /** @typedef {{ tla: string, team: string, pos: number, grid?: number, cls?: boolean, fl?: boolean }} ResultRow */
  /** @typedef {{ gd: number, price: number, pts: number, active: boolean, team: string, r?: number | null, nn?: number, ev?: number[][], own?: number }} HistRow */
  /** @typedef {{ id: string, kind: "D" | "C", name?: string, tla: string, team: string, price: number, active: boolean, overtakePts: number, hist: (HistRow | null)[] }} Asset */
  /** @typedef {{ name: string, done: boolean, drivers: Record<string, { q: number | null, r: number | null, laps: number }> }} PracticeSession */
  /** @typedef {{ gd: number, name: string, sprint: boolean, lock: string }} Gameday */
  /** @typedef {{ circuits?: { list: [string, number[], string][] }, field?: number }} SeasonCfg */
  /** @typedef {{ schedule: Gameday[], done: number[], assets: Asset[], results: { race: Record<string, ResultRow[]>, quali: Record<string, ResultRow[]>, sprint: Record<string, ResultRow[]> }, trackStats?: Record<string, { ovt: number }>, practice?: PracticeSession[], cfg?: SeasonCfg }} Data */

  const FEAT_NAMES = ["Power", "Street", "Fast corners"];
  /** @type {Circuit} */
  const DEFAULT_CIRCUIT = { ov: 1, grid: 0.5, chaos: 1, note: "Average circuit", feat: [0.5, 0.2, 0.5] };
  const fieldOf = (/** @type {Data} */ data) => (data.cfg && data.cfg.field) || 22;

  /** Track-type features of a meeting, from config/season.json circuits (first name fragment that matches).
   * @param {string} name @param {SeasonCfg} [cfg] @returns {Circuit} */
  function circuitFor(name, cfg) {
    const n = (name || "").toLowerCase();
    const hit = ((cfg && cfg.circuits && cfg.circuits.list) || []).find(([k]) => n.includes(k));
    return hit
      ? { ov: 1, grid: 0.5, chaos: 1, feat: hit[1].slice(), note: hit[2] }
      : { ...DEFAULT_CIRCUIT, feat: DEFAULT_CIRCUIT.feat.slice() };
  }
  // how much the grid (vs race pace) decides the finishing order: more overtaking, less grid
  const gridFromOv = (/** @type {number} */ ov) => Math.max(0.3, Math.min(0.85, 0.5 - 0.3 * (ov - 1)));

  /** Small ridge regression on centred features (3 predictors), solved directly.
   * @param {number[][]} X @param {number[]} y @param {number} lam @returns {number[]} */
  function ridge(X, y, lam) {
    const A = [
      [lam, 0, 0],
      [0, lam, 0],
      [0, 0, lam],
    ];
    const b = [0, 0, 0];
    X.forEach((x, k) => {
      for (let i = 0; i < 3; i++) {
        b[i] += x[i] * y[k];
        for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j];
      }
    });
    const M = A.map((row, i) => [...row, b[i]]);
    for (let i = 0; i < 3; i++) {
      let pv = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[pv][i])) pv = k;
      [M[i], M[pv]] = [M[pv], M[i]];
      for (let k = 0; k < 3; k++)
        if (k !== i) {
          const f = M[k][i] / M[i][i];
          for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
        }
    }
    return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
  }

  /* Track-type model, fitted on completed rounds. Lambdas from leave-one-round-out backtests (backtest/run.js,
     section 2; R1-R14 2026 against a flat average of the other rounds):
     overtaking  ~6% better at lambda 0.5 -> used fully
     retirements ~1% better at lambda 2   -> mild
     team pace   no better at any lambda  -> kept tiny (lambda 8); practice pace does this job better */
  const TRACK = { ovLambda: 0.5, dnfLambda: 2, teamLambda: 8, minRounds: 6, teamShiftMax: 1.5 };
  /** @param {Data} data @param {Partial<typeof TRACK>} [opt] */
  function trackModel(data, opt) {
    const o = { ...TRACK, ...opt };
    const byName = Object.fromEntries(data.schedule.map((g) => [g.gd, g.name]));
    const rounds = (data.done || []).filter((gd) => data.trackStats && data.trackStats[gd] != null);
    const forFallback = (/** @type {string} */ name) => {
      const c = circuitFor(name, data.cfg);
      c.grid = gridFromOv(c.ov);
      c.teamShift = {};
      return c;
    };
    if (rounds.length < o.minRounds) return { forCircuit: forFallback, fitted: false, rounds: rounds.length };
    const feat = (/** @type {number} */ gd) => circuitFor(byName[gd], data.cfg).feat;
    const mean = [0, 1, 2].map((j) => rounds.reduce((a, r) => a + feat(r)[j], 0) / rounds.length);
    const xc = (/** @type {number[]} */ f) => f.map((v, j) => v - mean[j]);
    const X = rounds.map((r) => xc(feat(r)));
    const ts = /** @type {Record<string, { ovt: number }>} */ (data.trackStats);
    const ovt = rounds.map((r) => ts[r].ovt);
    const ovMean = ovt.reduce((a, b) => a + b, 0) / ovt.length;
    const dnf = rounds.map((r) => (data.results.race[r] || []).filter((x) => !x.cls).length);
    const dnfMean = dnf.reduce((a, b) => a + b, 0) / dnf.length;
    const bOv = ridge(
      X,
      ovt.map((v) => v - ovMean),
      o.ovLambda,
    );
    const bDnf = ridge(
      X,
      dnf.map((v) => v - dnfMean),
      o.dnfLambda,
    );
    const teams = [
      ...new Set(
        Object.values(data.results.quali)
          .flat()
          .map((x) => x.team),
      ),
    ];
    /** @type {Record<string, number[]>} */
    const bTeam = {};
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
        rs.map((r) => xc(feat(r))),
        ys.map((v) => v - m),
        o.teamLambda,
      );
    }
    const dot = (/** @type {number[]} */ b, /** @type {number[]} */ x) => b[0] * x[0] + b[1] * x[1] + b[2] * x[2];
    return {
      fitted: true,
      rounds: rounds.length,
      ovMean,
      dnfMean,
      /** @param {string} name @returns {Circuit} */
      forCircuit(name) {
        const c = circuitFor(name, data.cfg),
          x = xc(c.feat);
        c.ov = Math.max(0.3, Math.min(2, (ovMean + dot(bOv, x)) / ovMean));
        c.chaos = Math.max(0.6, Math.min(1.6, (dnfMean + dot(bDnf, x)) / dnfMean));
        c.grid = gridFromOv(c.ov);
        c.teamShift = Object.fromEntries(
          Object.entries(bTeam).map(([t, b]) => [t, Math.max(-o.teamShiftMax, Math.min(o.teamShiftMax, dot(b, x)))]),
        );
        return c;
      },
    };
  }

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
  /** @param {number} l @param {Rng} r */
  function poisson(l, r) {
    if (l <= 0) return 0;
    const L = Math.exp(-l);
    let k = 0,
      p = 1;
    do {
      k++;
      p *= r();
    } while (p > L);
    return k - 1;
  }
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

  /* ---------- model: pace, reliability, overtaking, pit stops from this season's results ---------- */
  /** @typedef {{ id: string, tla: string, team: string, qMu: number, rMu: number, dnf: number, ov: number, practiceQ: number | null, practiceR: number | null, formQ: number, formR: number }} DriverModel */
  /** @typedef {{ id: string, team: string, pitMu: number, pitSd: number }} ConsModel */
  /** @typedef {{ drivers: DriverModel[], cons: ConsModel[], gRate: number, field: number }} Model */
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
    const adjOf = (/** @type {string} */ id) => adjBy[id] || 0;
    const F = fieldOf(data);
    const decay = Math.pow(0.5, 1 / o.halfLife);
    const drivers = data.assets.filter((a) => a.kind === "D" && a.active);
    const cons = data.assets.filter((a) => a.kind === "C");
    const rounds = Object.keys(data.results.race)
      .map(Number)
      .sort((a, b) => a - b);
    const last = rounds.length ? rounds[rounds.length - 1] : 0;

    // reliability: retirements per car-race, recent races weighted, shrunk toward the grid rate
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

    const raw = drivers.map((a) => {
      let qs = 0,
        qw = 0,
        rs = 0,
        rw = 0,
        wk = 0,
        sp = 0;
      for (const r of rounds) {
        const w = Math.pow(decay, last - r);
        const rows = data.results.race[r] || [];
        const race = rows.find((x) => x.tla === a.tla);
        const ncls = rows.filter((x) => x.cls).length || F;
        const q = (data.results.quali[r] || []).find((x) => x.tla === a.tla);
        if (race) {
          wk++;
          if (data.results.sprint[r]) sp++;
        }
        const same = (race && race.team === a.team) || (q && q.team === a.team);
        if (!same) continue;
        if (q) {
          qs += w * q.pos;
          qw += w;
        } else if (race) {
          qs += w * F;
          qw += w;
        }
        // finishing rank rescaled to a full field, so other cars' retirements don't flatter it
        if (race && race.cls) {
          rs += w * (((race.pos - 0.5) / ncls) * F + 0.5);
          rw += w;
        }
      }
      return { a, qs, qw, rs, rw, wk, sp };
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
    /** @type {DriverModel[]} */
    const dModels = raw.map((d) => {
      const t = team[d.a.team];
      const tq = t.qw ? t.qs / t.qw : M.defaultQuali,
        tr = t.rw ? t.rs / t.rw : M.defaultRace;
      // + = faster, in grid positions; the track shift is + = slower
      const adj = adjOf(d.a.id) - (shiftBy[d.a.team] || 0);
      const qMu = (d.qs + P * tq) / (d.qw + P) - adj,
        rMu = (d.rs + P * tr) / (d.rw + P) - adj;
      return {
        id: d.a.id,
        tla: d.a.tla,
        team: d.a.team,
        qMu,
        rMu,
        dnf: ((tD[d.a.team] || 0) + M.dnfShrink * gRate) / ((tN[d.a.team] || 0) + M.dnfShrink),
        ov: d.wk ? d.a.overtakePts / (d.wk + M.sprintOvertakeShare * d.sp) : M.defaultOvertakes,
        practiceQ: null,
        practiceR: null,
        formQ: qMu,
        formR: rMu,
      };
    });

    // Practice pace for this weekend: short-run rank blended into qualifying pace, long runs into race pace.
    const pr = practiceRanks(
      o.practice || [],
      dModels.map((d) => d.tla),
      F,
      M,
    );
    const wq = Math.min(1, M.practiceQ * o.practiceWeight),
      wr = Math.min(1, M.practiceR * o.practiceWeight);
    for (const d of dModels) {
      d.practiceQ = pr.q[d.tla] ?? null;
      d.practiceR = pr.r[d.tla] ?? null;
      const cap = M.practicePull;
      const pull = (/** @type {number} */ v, /** @type {number} */ form) =>
        Math.max(-cap, Math.min(cap, v - adjOf(d.id) - form));
      if (d.practiceQ != null) d.qMu += wq * pull(d.practiceQ, d.qMu);
      if (d.practiceR != null) d.rMu += wr * pull(d.practiceR, d.rMu);
    }

    // Pit-stop points: constructor race score minus its drivers' race scores (DOTD adds back ~0.9/race)
    /** @type {ConsModel[]} */
    const cModels = cons.map((c) => {
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
      return {
        id: c.id,
        team: c.team,
        pitMu: Math.max(0, m + M.pitDotd),
        pitSd: Math.max(SIM.pitSd[0], Math.min(sd, SIM.pitSd[1])),
      };
    });
    return { drivers: dModels, cons: cModels, gRate, field: F };
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
  /** @typedef {{ id: string, mean: number, nnMean: number, p10: number, p25: number, p50: number, p75: number, p90: number, dnf?: number, fl?: number, dotd?: number, xov?: number, q?: number[], r?: number[], cat?: Record<string, number> }} AssetStats */
  /** @typedef {{ ids: string[], N: number, field: number, tot: Float32Array, nn: Float32Array, stats: AssetStats[] }} Sim */
  /**
   * Simulate one weekend N times, scored with the official rules. tot/nn hold every sample per asset
   * (asset a, sample s at a * N + s); nn is the No Negative score (negative events floored at 0).
   * @param {Model} model @param {Circuit} circuit @param {boolean} sprint @param {number} N @param {number} seed
   * @returns {Sim}
   */
  function simulate(model, circuit, sprint, N, seed) {
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
    const pts = new Float64Array(A),
      neg = new Float64Array(A);
    const qpos = new Int32Array(nd),
      sgrid = new Int32Array(nd);
    const w = circuit.grid;
    const qCount = new Uint32Array(nd * F),
      rCount = new Uint32Array(nd * (F + 1)); // last column = DNF
    const flC = new Uint32Array(nd),
      dotdC = new Uint32Array(nd),
      ovSum = new Float64Array(nd);
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

    const qualiOrder = (/** @type {Int32Array} */ out, /** @type {boolean} */ withPoints) => {
      const arr = [];
      for (let i = 0; i < nd; i++) {
        const noTime = r() < SIM.qualiNoTime;
        arr.push({
          i,
          s: noTime ? 99 + r() : D[i].qMu + gauss(r) * (SIM.qualiSd[0] + SIM.qualiSd[1] * D[i].qMu),
          noTime,
        });
      }
      arr.sort((a, b) => a.s - b.s);
      arr.forEach((x, k) => {
        out[x.i] = k + 1;
        if (!withPoints) return;
        qCount[x.i * F + Math.min(k, F - 1)]++;
        if (x.noTime) {
          pts[x.i] -= 5;
          neg[x.i] -= 5;
          addCat(x.i, "q", -5);
        } else if (k < 10) {
          pts[x.i] += QPTS[k];
          addCat(x.i, "q", QPTS[k]);
        }
      });
    };

    const race = (
      /** @type {Int32Array} */ grid,
      /** @type {boolean} */ isSprint,
      /** @type {{ i: number }} */ dotdOut,
    ) => {
      const fin = [];
      for (let i = 0; i < nd; i++) {
        const pDnf = D[i].dnf * circuit.chaos * (isSprint ? SIM.sprintDnf : 1);
        if (r() < pDnf) {
          const pen = isSprint ? 10 : 20;
          pts[i] -= pen;
          neg[i] -= pen;
          addCat(i, isSprint ? "sprint" : "dnf", -pen);
          if (!isSprint) rCount[i * (F + 1) + F]++;
          continue;
        }
        const sd = (SIM.raceSd[0] + SIM.raceSd[1] * D[i].rMu) * (isSprint ? SIM.sprintSd : 1);
        fin.push({ i, s: w * grid[i] + (1 - w) * D[i].rMu + gauss(r) * sd });
      }
      fin.sort((a, b) => a.s - b.s);
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
        if (isSprint) addCat(i, "sprint", pp + g);
        else {
          addCat(i, "rpos", pp);
          addCat(i, g >= 0 ? "gain" : "lost", g);
        }
        const ov = poisson(D[i].ov * circuit.ov * (isSprint ? MODEL.sprintOvertakeShare : 1), r);
        pts[i] += ov;
        ovSum[i] += ov;
        addCat(i, isSprint ? "sprint" : "ovt", ov);
        if (!isSprint) rCount[i * (F + 1) + Math.min(k, F - 1)]++;
        flW.push(Math.exp(-(pos - 1) / SIM.flDecay));
        dW.push(dotdW(pos, g));
      });
      if (fin.length) {
        const f = fin[pick(flW, r)].i;
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
      qbNeg = new Float64Array(nc);
    for (let s = 0; s < N; s++) {
      pts.fill(0);
      neg.fill(0);
      const dotd = { i: -1 };
      qualiOrder(qpos, true);
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
        qualiOrder(sgrid, false);
        race(sgrid, true, { i: -1 });
      }
      race(qpos, false, dotd);
      // constructors: their drivers' points (Driver of the Day excluded), the qualifying bonus and pit stops
      for (let c = 0; c < nc; c++) {
        let t = qb[c],
          n = qbNeg[c];
        for (let i = 0; i < nd; i++)
          if (cOf[i] === c) {
            t += pts[i] - (dotd.i === i ? 10 : 0);
            n += neg[i];
          }
        t += Math.max(0, Math.round(C[c].pitMu + gauss(r) * C[c].pitSd));
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
        mn = 0;
      for (let s = 0; s < N; s++) {
        m += tot[a * N + s];
        mn += nn[a * N + s];
      }
      const q = (/** @type {number} */ p) => sl[Math.floor(N * p)];
      /** @type {AssetStats} */
      const st = { id, mean: m / N, nnMean: mn / N, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
      if (a < nd) {
        st.dnf = rCount[a * (F + 1) + F] / N;
        st.fl = flC[a] / N;
        st.dotd = dotdC[a] / N;
        st.xov = ovSum[a] / N;
        st.q = Array.from(qCount.subarray(a * F, a * F + F), (v) => v / N);
        st.r = Array.from(rCount.subarray(a * (F + 1), a * (F + 1) + F + 1), (v) => v / N);
        st.cat = Object.fromEntries(CATS.map((c, j) => [c, cat[a * NC + j] / N]));
      }
      return st;
    });
    return { ids, N, field: F, tot, nn, stats };
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
  /** Every 5-driver x 2-constructor team, best `top` by score. @param {Candidate[]} cand @param {string[]} team
   * @param {OptOpts} o @returns {TeamResult[]} */
  function optimise(cand, team, o) {
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
    return top.slice(0, K).map((x) => ({
      score: x.score,
      transfers: x.t,
      penalty: x.pen,
      cost: x.c.cost + x.p.cost,
      drivers: x.c.idx.map((k) => Ds[k].id),
      cons: [Cs[x.p.a].id, Cs[x.p.b].id],
      boost: Ds[x.c.i1].id,
      boost2: o.chip === "x3" ? Ds[x.c.i2].id : null,
    }));
  }

  /* ---------- projections ---------- */
  const DEFAULTS = { halfLife: 4, blend: 0.3, sims: 10000, pw: 1 };
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
  /** The coming race's projection at default settings: what refresh.py freezes into the season archive at lock.
   * Null once the season is over. @param {Data} data @param {Partial<typeof DEFAULTS>} [opt] */
  function project(data, opt) {
    const o = { ...DEFAULTS, ...opt };
    const g = data.schedule.find((x) => !data.done.includes(x.gd));
    if (!g) return null;
    const c = trackModel(data).forCircuit(g.name);
    const model = buildModel(data, {
      halfLife: o.halfLife,
      teamShift: c.teamShift || {},
      practice: data.practice || [],
      practiceWeight: o.pw,
    });
    const sim = simulate(model, c, g.sprint, o.sims, g.gd * 7919 + 13);
    /** @type {Record<string, { x: number, p25: number, p75: number }>} */
    const assets = {};
    sim.ids.forEach((id, i) => {
      const a = /** @type {Asset} */ (data.assets.find((x) => x.id === id)),
        st = sim.stats[i];
      assets[id] = { x: Math.round(blendMean(st, recentForm(a), o.blend) * 10) / 10, p25: st.p25, p75: st.p75 };
    });
    return { gd: g.gd, sims: o.sims, practice: (data.practice || []).filter((p) => p.done).map((p) => p.name), assets };
  }

  const api = {
    QPTS,
    RPTS,
    SPTS,
    MODEL,
    SIM,
    TRACK,
    FEAT_NAMES,
    PRICE_BANDS,
    DEFAULTS,
    circuitFor,
    trackModel,
    gridFromOv,
    ridge,
    buildModel,
    practiceRanks,
    simulate,
    priceStep,
    optimise,
    mulberry32,
    recentForm,
    blendMean,
    project,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else /** @type {any} */ (root).Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
