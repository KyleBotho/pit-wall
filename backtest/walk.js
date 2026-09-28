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
// rounds not in practice_by_round.json yet: the site's own practice archive (same format, history/<season>/practice)
if (D) {
  const dir = path.join(__dirname, "..", "history", String(D.season || ""), "practice");
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) {
      const r = +f.slice(2, 4);
      if (!PRACTICE[r]) PRACTICE[r] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    }
}
// item 9 stage 5: practice short-run pace from minisector ideal laps (telemetry.py minisectors), per round
const MINI = {};
if (D) {
  const dir = path.join(__dirname, "..", "history", String(D.season || ""), "telemetry", "minisectors");
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) MINI[+f.slice(2, 4)] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
}
/** Round r's practice sessions with each driver's short-run gap taken from the minisector ideal laps where there is
 * one (sessions and drivers without keep the lap-based gap). */
function practiceMini(r) {
  const m = MINI[r] || {};
  return (PRACTICE[r] || []).map((s) => {
    const g = m[s.name];
    if (!g) return s;
    const drivers = Object.fromEntries(
      Object.entries(s.drivers).map(([t, d]) => [t, g[t] != null ? { ...d, q: g[t] } : d]),
    );
    return { ...s, drivers };
  });
}
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
// rain forecasts at lock (third review: only what was known before lock): the site's own frozen projection (read from
// its archive file: the page's projHist carries only points), else the rebuilt forecasts from runs issued before lock
// (backtest/weather_rounds.py q / s / r). Its `latest` values were issued AFTER lock: only with WX_LATEST=1, as a
// sensitivity run. A session without a known forecast gets the circuit's climatology, as the engine does.
const WX = read("weather_by_round.json");
const WX_LATEST = process.env.WX_LATEST === "1";
// the evaluation's own settings (fourth review: accuracy.js keys and labels its results with them, so a
// sensitivity run never passes for, or overwrites, the standard one); {} = the standard evaluation
const CONFIG = WX_LATEST ? { wxLatest: true } : {};
const PROJ_DIR = D ? path.join(__dirname, "..", "history", String(D.season), "projections") : "";
/** Round r's rain as at lock ({q, s, r}; a session missing = unknown), or null. */
function wxAt(r) {
  const f = path.join(PROJ_DIR, `gd${String(r).padStart(2, "0")}.json`);
  if (PROJ_DIR && fs.existsSync(f)) {
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    if (p.rain && !p.rebuilt) return p.rain;
  }
  const w = WX[r];
  if (!w) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of ["q", "s", "r"]) {
    const v = w[k] != null ? w[k] : WX_LATEST && w.latest ? w.latest[k] : null;
    if (v != null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
// a round's FIA index, as collect.fia_event_path finds it: any of the meeting's names (config/season.json fiaNames:
// the FIA's own where they differ), punctuation ignored (the FIA names its files: "2026_barcelona-catalunya_...")
const FIA_NAMES = read(path.join("..", "config", "season.json")).fiaNames || {};
const fiaKey = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
function fiaFile(name) {
  const dir = path.join(__dirname, "..", "history", String(D.season), "fia");
  if (!fs.existsSync(dir)) return null;
  const want = new Set(
    [name, ...(Array.isArray(FIA_NAMES[name]) ? FIA_NAMES[name] : [])].map((n) => fiaKey(`${D.season} ${n}`)),
  );
  const f = fs
    .readdirSync(dir)
    .sort()
    .find((x) => x.endsWith(".json") && want.has(fiaKey(x.slice(0, -5))));
  return f ? path.join(dir, f) : null;
}
/** Grid penalties the stewards had published by round r's lock (history/<season>/fia, parsed decisions), as TLAs. */
function penAt(r) {
  const g = D.schedule.find((x) => x.gd === r);
  if (!g) return {};
  const f = fiaFile(g.name);
  if (!f) return {};
  const num = Object.fromEntries((D.results.race[r] || []).filter((x) => x.num).map((x) => [x.num, x.tla]));
  /** @type {Record<string, number>} */
  const pen = {};
  for (const d of JSON.parse(fs.readFileSync(f, "utf8")).docs) {
    const m = /(?:Infringement|Decision|Offence) - Car (\d+)\b/i.exec(d.title || "");
    const t = m && num[+m[1]];
    if (!t || !d.grid || !(Date.parse(d.published) < Date.parse(g.lock))) continue;
    pen[t] = d.grid >= 99 || pen[t] === 99 ? 99 : (pen[t] || 0) + d.grid;
  }
  return pen;
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
    // speed bands: earlier rounds whole, this round's practice shares only (known at lock)
    bands: Object.fromEntries(
      Object.entries(D.bands || {})
        .filter(([g]) => keep(+g) || +g === r)
        .map(([g, v]) => [g, +g === r ? { FP: v.FP } : v]),
    ),
    raceInfo: cut(D.raceInfo),
    practice: PRACTICE[r] || [],
    // this round's rain forecast and grid penalties as at lock (second review: they used to be left out)
    weather: wxAt(r) ? { [r]: wxAt(r) } : {},
    weekend: { gd: r, penalties: penAt(r), grid: {} },
    live: null, // the live weekend's scored sessions: not known at lock
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
    recs: [],
    events: [],
  };
  for (const r of rounds) {
    const Dr = asOf(r);
    if (o.practice === false) Dr.practice = [];
    else if (o.practiceMini) Dr.practice = practiceMini(r);
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
    const tags = roundTags(r);
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
      out.recs.push({
        gd: r,
        kind: A.kind,
        ...tags,
        crps: out.crps[out.crps.length - 1],
        err: Math.abs(p - y),
        bias: p - y,
        in80: y >= st.p10 + sh && y <= st.p90 + sh,
        in50: y >= st.p25 + sh && y <= st.p75 + sh,
        // the same scores against only the samples that match what happened (a group formed after the fact:
        // a race with a safety car against the sim's safety-car races, a wet one against its wet ones)
        cSc: condScore(sim, i, 1, tags.sc, y - sh),
        cWet: condScore(sim, i, 2, tags.wet, y - sh),
      });
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
    // the event forecasts themselves: the sim's chance of a race safety car / a wet race vs what happened
    const before = D.done.filter((g) => g < r).map(roundTags),
      rate = (k) => (before.length ? mean(before.map((t) => (t[k] ? 1 : 0))) : 0.5);
    out.events.push({ gd: r, sc: [sim.sc, tags.sc, rate("sc")], wet: [sim.wet, tags.wet, rate("wet")] });
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
      bias: mean(out.bias.slice(k0)),
      rho: out.rho[out.rho.length - 1],
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
    groups: groups(out.recs),
    events: eventCalib(out.events),
  };
}

// calibration by group (reviews' deferred evaluation item): the same scores for drivers / constructors, sprint /
// normal weekends, wet / dry races and races with / without a safety car (race control: SC or VSC)
const GROUPS = {
  drivers: [(x) => x.kind === "D"],
  constructors: [(x) => x.kind === "C"],
  sprint: [(x) => x.sprint],
  normal: [(x) => !x.sprint],
  wet: [(x) => x.wet, "cWet"],
  dry: [(x) => !x.wet, "cWet"],
  "safety car": [(x) => x.sc, "cSc"],
  "no safety car": [(x) => !x.sc, "cSc"],
};
// Grouping by what happened (a safety car, rain) splits even a perfect forecast: its range mixes both kinds of race,
// so it looks too narrow where the event happened and too wide, and off-centre, where it didn't. Those groups are
// also scored against the matching samples (cond): that is the fair test of how the sim plays such a race.

/** Scores of asset i against only the samples whose event bit matches `want` (null if fewer than 50). */
function condScore(sim, i, bit, want, y) {
  if (!sim.ev) return null;
  const N = sim.N,
    xs = [];
  for (let s = 0; s < N; s++) if ((sim.ev[s] & bit) > 0 === !!want) xs.push(sim.tot[i * N + s]);
  if (xs.length < 50) return null;
  const x = Float64Array.from(xs).sort(),
    q = (p) => x[Math.min(x.length - 1, Math.floor(p * x.length))];
  return { crps: crps(x, y), in80: y >= q(0.1) && y <= q(0.9), in50: y >= q(0.25) && y <= q(0.75), bias: mean(xs) - y };
}

/** The sim's chance of a race safety car / a wet race vs what happened: mean forecast, actual rate, Brier score. */
function eventCalib(evs) {
  const one = (k) => {
    const xs = evs.map((e) => e[k]);
    return {
      n: xs.length,
      forecast: mean(xs.map(([p]) => p)),
      actual: mean(xs.map(([, y]) => (y ? 1 : 0))),
      brier: mean(xs.map(([p, y]) => (p - (y ? 1 : 0)) ** 2)),
      // the Brier score of forecasting this season's rate so far (known before the round; lower is better)
      brierFlat: mean(xs.map(([, y, f]) => (f - (y ? 1 : 0)) ** 2)),
    };
  };
  return evs.length ? { sc: one("sc"), wet: one("wet") } : null;
}

/** What happened in round r, for grouping scores (after the fact; never a model input). */
function roundTags(r) {
  const g = D.schedule.find((x) => x.gd === r) || {};
  const race = (D.raceInfo?.[r] || {}).race || {};
  // sc: a full safety car (the sim has no VSC; its safety-car samples are what a race with one is scored against)
  return { sprint: !!g.sprint, wet: !!race.rain, sc: (race.sc || 0) > 0 };
}

/** Per-asset records {gd, kind, sprint, wet, sc, err, bias, crps?, in80?, in50?} -> {group: {rounds, n, crps, mae,
 * bias, cover80, cover50}}; groups with no records are left out, a score no record has is null. */
function groups(recs) {
  const avg = (xs) => (xs.length ? mean(xs) : null);
  const share = (xs, k) => {
    const v = xs.filter((x) => x[k] != null);
    return v.length ? v.filter((x) => x[k]).length / v.length : null;
  };
  const out = {};
  for (const [k, [f, ck]] of Object.entries(GROUPS)) {
    const xs = recs.filter(f);
    if (!xs.length) continue;
    const cs = ck ? xs.map((x) => x[ck]).filter(Boolean) : [];
    out[k] = {
      rounds: new Set(xs.map((x) => x.gd)).size,
      n: xs.length,
      crps: avg(xs.filter((x) => Number.isFinite(x.crps)).map((x) => x.crps)),
      mae: avg(xs.map((x) => x.err)),
      bias: avg(xs.map((x) => x.bias)),
      cover80: share(xs, "in80"),
      cover50: share(xs, "in50"),
      // against the matching samples (see GROUPS)
      ...(cs.length
        ? {
            cond: {
              n: cs.length,
              crps: avg(cs.map((c) => c.crps)),
              bias: avg(cs.map((c) => c.bias)),
              cover80: share(cs, "in80"),
              cover50: share(cs, "in50"),
            },
          }
        : {}),
    };
  }
  return out;
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

// Every file and folder the evaluation reads besides cache/data.json and the code (third review): the accuracy cache
// key hashes exactly these, so a data-only correction to any of them reruns the evaluation. Add to it when asOf reads
// something new.
const SEASON_DIR = D ? path.join(__dirname, "..", "history", String(D.season)) : "";
const INPUTS = [
  path.join(__dirname, "practice_by_round.json"),
  path.join(__dirname, "odds_by_round.json"),
  path.join(__dirname, "weather_by_round.json"),
  path.join(__dirname, "..", "config", "season.json"), // fiaNames: which FIA index is a round's
  ...["practice", "odds", "projections", "fia", path.join("telemetry", "minisectors")].map((d) =>
    path.join(SEASON_DIR, d),
  ),
];
module.exports = {
  D,
  E,
  asOf,
  evaluate,
  baselines,
  crps,
  groups,
  roundTags,
  roundOvertakes,
  PRACTICE,
  ODDS,
  MINI,
  mean,
  INPUTS,
  CONFIG,
};
