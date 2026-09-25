// Walk-forward evaluation shared by backtest/run.js and backtest/fit.js: for each finished round, rebuild the data
// as it stood before that round (results, scoring lines, prices, overtake totals, OpenF1 race data, practice, the
// market at lock), project every asset with the real engine and score the projection against what happened.
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");
const { loadData } = require("../tests/helpers.js");

const D = loadData();
const read = (f) =>
  fs.existsSync(path.join(__dirname, f)) ? JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")) : {};
const PRACTICE = read("practice_by_round.json");
const ODDS = read("odds_by_round.json");
// frozen live-site odds (history/<season>/odds) take precedence over the rebuilt ones
if (D) {
  const dir = path.join(__dirname, "..", "history", String(D.season || ""), "odds");
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      ODDS[o.gd] = o;
    }
}
const codes = (...cs) =>
  D ? new Set(D.evNames.map((e, i) => (cs.includes(e.c) ? i : -1)).filter((i) => i >= 0)) : new Set();
const OVC = codes("R OV", "S OV");
const ROV = codes("R OV");
const RPLACES = codes("R PG", "R PL");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** The data as it stood before round r (drop: rounds left out entirely, for leave-one-out). */
function asOf(r, drop = []) {
  const keep = (g) => g < r && !drop.includes(+g);
  const cut = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([g]) => keep(+g)));
  const assets = D.assets.map((a) => {
    const hist = a.hist.map((h) => (h && keep(h.gd) ? h : null));
    const now = a.hist.find((h) => h && h.gd === r);
    const ovp = hist.reduce(
      (s, h) => s + (h && h.ev ? h.ev.filter(([i]) => OVC.has(i)).reduce((t, x) => t + x[1], 0) : 0),
      0,
    );
    return {
      ...a,
      hist,
      overtakePts: ovp,
      price: now ? now.price : a.price,
      active: now ? now.active : false,
      team: now ? now.team : a.team,
    };
  });
  return {
    ...D,
    assets,
    done: D.done.filter(keep),
    results: { race: cut(D.results.race), quali: cut(D.results.quali), sprint: cut(D.results.sprint) },
    trackStats: cut(D.trackStats),
    raceInfo: cut(D.raceInfo),
    practice: PRACTICE[r] || [],
    weather: {},
    weekend: null,
    odds: ODDS[r] ? { ...ODDS[r], gd: r } : null,
  };
}
const actualPts = (a, r) => {
  const h = a.hist.find((h) => h && h.gd === r);
  return h && h.active ? h.pts : null;
};
/** An asset's actual points in round r from the scoring lines in `set` (null if it didn't race). */
const actualEv = (a, r, set) => {
  const h = a.hist.find((h) => h && h.gd === r);
  return h && h.active ? (h.ev || []).filter(([i]) => set.has(i)).reduce((s, x) => s + x[1], 0) : null;
};
/** Mean race overtake points per driver who raced round r. */
const roundOvertakes = (r) =>
  mean(
    D.assets
      .filter((a) => a.kind === "D")
      .map((a) => actualEv(a, r, ROV))
      .filter((v) => v != null),
  );

/**
 * Ceiling runs (backtest section 10): give the sim the round's real answer for one input, keeping everything else.
 * or: { q: realised qualifying pace, r: realised race pace, ov: realised race overtake level, grid: actual
 * qualifying order }. Realised pace is noisier than the underlying pace, so these are upper bounds.
 */
function withOracle(setup, r, or) {
  let drivers = setup.model.drivers;
  if (or.q) {
    const q = Object.fromEntries((D.results.quali[r] || []).filter((x) => x.gap != null).map((x) => [x.tla, x.gap]));
    drivers = drivers.map((d) => (q[d.tla] != null ? { ...d, qPace: q[d.tla], qSe: 0 } : d));
  }
  if (or.r) {
    const p = ((D.raceInfo[r] || {}).race || {}).pace || {};
    drivers = drivers.map((d) => (p[d.tla] != null ? { ...d, rPace: Math.min(p[d.tla], 4), rSe: 0 } : d));
  }
  const model = { ...setup.model, drivers };
  let circuit = setup.circuit;
  if (or.ov) {
    // scale the circuit's overtake level so the simulated race overtakes per driver match what happened
    const pilot = E.simulate(model, circuit, false, 2000, 99, setup.simOpt);
    const simOv = mean(pilot.stats.slice(0, drivers.length).map((st) => st.cat.ovt));
    circuit = { ...circuit, ov: (circuit.ov ?? 1) * (roundOvertakes(r) / simOv) };
  }
  const simOpt = or.grid
    ? { ...setup.simOpt, known: { ...setup.simOpt.known, q: (D.results.quali[r] || []).map((x) => x.tla) } }
    : setup.simOpt;
  return { ...setup, model, circuit, simOpt };
}
/** CRPS of samples vs an outcome, O(N log N): mean |x - y| minus half the mean pairwise gap (from sorted order). */
function crps(samples, y) {
  const x = Float64Array.from(samples).sort(),
    n = x.length;
  let a = 0,
    b = 0;
  for (let k = 0; k < n; k++) {
    a += Math.abs(x[k] - y);
    b += (2 * k - n + 1) * x[k];
  }
  return a / n - b / (n * n);
}
function spearman(x, y) {
  return E.spearman(x, y) ?? NaN;
}

/**
 * Walk forward from round `from`. o: { N, blend, oddsW, practice (bool), odds (bool), seed, rounds, decision (bool),
 * oracle (see withOracle) }. Returns per-asset errors, rank correlation, interval coverage, CRPS, log scores of
 * qualifying and race positions, per-driver errors of overtake points and race places gained/lost, the error of each
 * round's overtake level, sim time and (decision) the actual points of the best fresh $100m team each round.
 */
function evaluate(o = {}) {
  const N = o.N || 3000;
  const rounds = o.rounds || D.done.filter((g) => g >= (o.from || 5));
  const out = {
    err: [],
    errD: [],
    errC: [],
    bias: [],
    rho: [],
    c80: 0,
    c50: 0,
    n: 0,
    crps: [],
    lsQ: [],
    lsR: [],
    team: [],
    best: [],
    lsFL: [],
    ov: [],
    places: [],
    ovLvl: [],
    ms: 0,
    byRound: [],
  };
  for (const r of rounds) {
    const Dr = asOf(r);
    if (o.practice === false) Dr.practice = [];
    if (o.odds === false) Dr.odds = null;
    const g = D.schedule.find((x) => x.gd === r);
    let setup = E.raceSetup(Dr, g, {
      next: true,
      oddsW: o.oddsW,
      halfLife: o.halfLife,
      track: o.track && o.track(Dr),
    });
    if (o.oracle) setup = withOracle(setup, r, o.oracle);
    const t0 = performance.now();
    const sim = E.simulate(setup.model, setup.circuit, g.sprint, N, (o.seed || 1) * 7919 + r, {
      ...setup.simOpt,
      unc: o.unc,
    });
    out.ms += performance.now() - t0;
    const k0 = out.crps.length,
      ko = out.ov.length;
    let simOvR = 0,
      nOvR = 0;
    const xs = [],
      ys = [],
      pred = {};
    sim.ids.forEach((id, i) => {
      const A = D.assets.find((x) => x.id === id);
      const y = actualPts(A, r);
      if (y == null) return;
      const a = Dr.assets.find((x) => x.id === id);
      const st = sim.stats[i];
      const p = E.blendMean(st, E.recentForm(a), o.blend ?? 0);
      pred[id] = p;
      out.err.push(Math.abs(p - y));
      (A.kind === "D" ? out.errD : out.errC).push(Math.abs(p - y));
      out.bias.push(p - y);
      xs.push(p);
      ys.push(y);
      const sh = p - st.mean;
      out.n++;
      if (y >= st.p10 + sh && y <= st.p90 + sh) out.c80++;
      if (y >= st.p25 + sh && y <= st.p75 + sh) out.c50++;
      // CRPS over every sample (exact for the empirical distribution): E|X - y| - E|X - X'| / 2
      out.crps.push(crps(sim.tot.subarray(i * N, i * N + N), y - sh));
      // position log scores and per-category errors (drivers)
      if (A.kind === "D") {
        out.ov.push(Math.abs(st.xov - actualEv(A, r, OVC)));
        out.places.push(Math.abs(st.cat.gain + st.cat.lost - actualEv(A, r, RPLACES)));
        simOvR += st.cat.ovt;
        nOvR++;
        const q = (D.results.quali[r] || []).find((x) => x.tla === A.tla);
        if (q && st.q) out.lsQ.push(Math.log((st.q[Math.min(q.pos, st.q.length) - 1] || 0) + 1e-3));
        const rr = (D.results.race[r] || []).find((x) => x.tla === A.tla);
        if (rr && st.r) {
          const k = rr.cls ? Math.min(rr.pos, sim.field) - 1 : sim.field;
          out.lsR.push(Math.log((st.r[k] || 0) + 1e-3));
        }
      }
    });
    out.rho.push(spearman(xs, ys));
    // log score of the fastest lap: the simulated chance of whoever set it
    const flRow = (D.results.race[r] || []).find((x) => x.fl);
    const flI = flRow ? sim.ids.findIndex((id) => D.assets.find((a) => a.id === id).tla === flRow.tla) : -1;
    if (flI >= 0) out.lsFL.push(Math.log((sim.stats[flI].fl || 0) + 1e-3));
    // the round's overtake level: simulated minus actual race overtake points per driver
    const lvl = simOvR / nOvR - roundOvertakes(r);
    out.ovLvl.push(lvl);
    // per-round means (for paired comparisons: rounds are the independent units, assets within one aren't)
    const cr = out.crps.slice(k0),
      er = out.err.slice(k0);
    out.byRound.push({
      gd: r,
      n: cr.length,
      crps: mean(cr),
      mae: mean(er),
      ov: mean(out.ov.slice(ko)),
      places: mean(out.places.slice(ko)),
      ovLvl: Math.abs(lvl),
    });
    if (o.decision) {
      const actual = Object.fromEntries(D.assets.map((a) => [a.id, actualPts(a, r) ?? -20]));
      const pickTeam = (vals) => {
        const cand = Dr.assets
          .filter((a) => vals[a.id] != null)
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            price: a.price,
            active: true,
            e: vals[a.id],
            boostE: a.kind === "D" ? vals[a.id] : 0,
          }));
        const t = E.optimise(cand, [], { cap: 100, free: 7, maxT: 7, locks: new Set(), bans: new Set(), top: 1 })[0];
        return [...t.drivers, ...t.cons].reduce((s, id) => s + actual[id], 0) + actual[t.boost];
      };
      out.team.push(pickTeam(pred));
      out.best.push(pickTeam(Object.fromEntries(Object.keys(pred).map((id) => [id, actual[id]]))));
    }
  }
  return {
    mae: mean(out.err),
    maeD: mean(out.errD),
    maeC: mean(out.errC),
    bias: mean(out.bias),
    rho: mean(out.rho),
    cover80: out.c80 / out.n,
    cover50: out.c50 / out.n,
    crps: mean(out.crps),
    lsQ: mean(out.lsQ),
    lsR: mean(out.lsR),
    team: out.team.reduce((a, b) => a + b, 0),
    best: out.best.reduce((a, b) => a + b, 0),
    perRound: out.team,
    rounds: rounds.length,
    lsFL: mean(out.lsFL),
    ovMae: mean(out.ov),
    placesMae: mean(out.places),
    ovLvl: mean(out.ovLvl.map(Math.abs)),
    ovLvlBias: mean(out.ovLvl),
    msPerRound: out.ms / rounds.length,
    byRound: out.byRound,
  };
}

/** Naive baselines on the same rounds: season average, recent form, last three. */
function baselines(from = 5) {
  const rounds = D.done.filter((g) => g >= from);
  const e = { seasonAvg: [], form: [], last3: [] };
  for (const r of rounds) {
    const Dr = asOf(r);
    for (const a of Dr.assets) {
      const y = actualPts(
        D.assets.find((x) => x.id === a.id),
        r,
      );
      if (y == null) continue;
      const h = a.hist.filter((x) => x && x.active);
      if (!h.length) continue;
      e.seasonAvg.push(Math.abs(mean(h.map((x) => x.pts)) - y));
      e.last3.push(Math.abs(mean(h.slice(-3).map((x) => x.pts)) - y));
      e.form.push(Math.abs((E.recentForm(a) ?? 0) - y));
    }
  }
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, mean(v)]));
}

module.exports = { D, E, asOf, evaluate, baselines, crps, roundOvertakes, PRACTICE, ODDS, mean };
