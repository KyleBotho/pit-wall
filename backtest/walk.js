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
const OVC = D
  ? new Set(D.evNames.map((e, i) => (e.c === "R OV" || e.c === "S OV" ? i : -1)).filter((i) => i >= 0))
  : new Set();
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
 * Walk forward from round `from`. o: { N, blend, oddsW, practice (bool), odds (bool), seed, rounds, decision (bool) }.
 * Returns per-asset errors, rank correlation, interval coverage, CRPS, log scores of qualifying and race positions
 * and (decision) the actual points of the best fresh $100m team each round.
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
    byRound: [],
  };
  for (const r of rounds) {
    const Dr = asOf(r);
    if (o.practice === false) Dr.practice = [];
    if (o.odds === false) Dr.odds = null;
    const g = D.schedule.find((x) => x.gd === r);
    const setup = E.raceSetup(Dr, g, {
      next: true,
      oddsW: o.oddsW,
      halfLife: o.halfLife,
      track: o.track && o.track(Dr),
    });
    const sim = E.simulate(setup.model, setup.circuit, g.sprint, N, (o.seed || 1) * 7919 + r, {
      ...setup.simOpt,
      unc: o.unc,
    });
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
      // position log scores (drivers)
      if (A.kind === "D") {
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
    // per-round means (for paired comparisons: rounds are the independent units, assets within one aren't)
    const k0 = out.byRound.reduce((s, x) => s + x.n, 0);
    const cr = out.crps.slice(k0),
      er = out.err.slice(k0);
    out.byRound.push({ gd: r, n: cr.length, crps: mean(cr), mae: mean(er) });
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

module.exports = { D, E, asOf, evaluate, baselines, crps, PRACTICE, ODDS, mean };
