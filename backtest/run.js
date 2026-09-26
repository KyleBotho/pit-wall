// Backtests behind the model settings in engine.js (MODEL, SIM, TRACK). Run:  npm run backtest
// Sections 9 (experiments) and 10 (ceilings) run only when asked for by number.
// Needs cache/data.json (python refresh.py) and, for some sections, backtest/practice_by_round.json
// (python backtest/practice_rounds.py) and backtest/odds_by_round.json (python backtest/odds_rounds.py). Every section
// walks through the season using only what was known before each round (backtest/walk.js). Section 6 is the gate:
// a model change should not make the walk-forward CRPS / MAE of projected points worse.
const fs = require("node:fs");
const path = require("node:path");
const W = require("./walk.js");
const { D, E, asOf, mean } = W;

if (!D) throw new Error("no cache/data.json: run python refresh.py first");
const nameOf = Object.fromEntries(D.schedule.map((g) => [g.gd, g]));
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const table = (rows) => console.table(rows);
const rounds = D.done.slice();
const last = rounds[rounds.length - 1] + 1;
const only = process.argv.slice(2).map(Number);
const want = (n) => !only.length || only.includes(n);

/* ---------- 1. price rule ---------- */
function prices() {
  let n = 0,
    ok = 0;
  for (const a of D.assets)
    for (let k = 2; k < a.hist.length; k++) {
      const h = a.hist;
      if (!h[k] || !h[k].active || !h[k - 1] || !h[k - 2]) continue;
      const next = k + 1 < h.length ? h[k + 1] : { price: a.price };
      if (!next) continue;
      const pred =
        Math.round((h[k].price + E.priceStep(h[k].price, (h[k].pts + h[k - 1].pts + h[k - 2].pts) / 3)) * 10) / 10;
      n++;
      if (Math.abs(pred - next.price) < 0.05) ok++;
    }
  console.log(
    `\n1. Price rule (bands ${E.PRICE_BANDS.join(" / ")}): ${ok}/${n} real price changes reproduced (${((100 * ok) / n).toFixed(1)}%)`,
  );
}

/* ---------- 2. track model: leave one round out ---------- */
function track() {
  console.log(
    "\n2. Track model, leave-one-round-out: mean absolute error per race (flat = this season's average of the other rounds)",
  );
  const season = E.seasonRounds(D);
  const withStats = rounds.filter((g) => season[g] && season[g].ov != null);
  // alpha = weight of each circuit's past profile (0 = this season's average everywhere, 1 = the full profile)
  const variants = { "features only (old)": (Dm) => E.trackModel(Dm, { noPriors: true }) };
  for (const al of [0, 0.25, 0.5, 0.75, 1])
    variants[`priors, alpha ${al}`] = (Dm) => E.trackModel(Dm, { alpha: { ov: al, dnf: al, sc: al, corr: al } });
  variants["priors, alpha as set"] = (Dm) => E.trackModel(Dm);
  // the round's overtake level from the track's average speed (practice reference lap, TRACK.speed)
  for (const lam of [0, 2, 5])
    variants[`+ speed, ridge ${lam}`] = (Dm) => E.trackModel(Dm, { speed: true, speedLambda: lam });
  const out = [];
  for (const [label, mk] of Object.entries(variants)) {
    const e = { ov: [], ovF: [], dnf: [], dnfF: [], corr: [], corrF: [], sc: [], scF: [] };
    for (const r of withStats) {
      const Dm = { ...asOf(last, [r]), practice: W.PRACTICE[r] || [] };
      const tm = mk(Dm);
      const c = tm.forCircuit(nameOf[r]);
      const s = season[r];
      e.ov.push(Math.abs(c.ov * tm.ovMean - s.ov));
      e.ovF.push(Math.abs(tm.ovMean - s.ov));
      e.dnf.push(Math.abs(c.chaos * tm.dnfMean - s.dnf));
      e.dnfF.push(Math.abs(tm.dnfMean - s.dnf));
      if (s.corr != null) {
        e.corr.push(Math.abs(c.grid - s.corr));
        e.corrF.push(Math.abs(tm.corrMean - s.corr));
      }
      if (s.sc != null && c.sc != null) {
        const others = withStats.filter((g) => g !== r && season[g].sc != null).map((g) => season[g].sc);
        e.sc.push((c.sc - s.sc) ** 2);
        e.scF.push((mean(others) - s.sc) ** 2);
      }
    }
    out.push({
      model: label,
      "overtakes: better than flat": pct(mean(e.ov), mean(e.ovF)),
      "retirements: better": pct(mean(e.dnf), mean(e.dnfF)),
      "grid-finish corr: better": e.corr.length ? pct(mean(e.corr), mean(e.corrF)) : "-",
      "safety car (Brier): better": e.sc.length ? pct(mean(e.sc), mean(e.scF)) : "-",
    });
  }
  table(out);
  const tm = E.trackModel(D);
  console.log(`   alpha in use: ${JSON.stringify(E.TRACK.alpha)}`);
  if (tm.priors)
    console.log(
      `   this season vs the same circuits' history: position changes x${tm.trend.move.toFixed(2)}, retirements x${tm.trend.dnf.toFixed(2)}, safety cars x${tm.trend.sc.toFixed(2)}, grid-finish correlation ${tm.trend.corr >= 0 ? "+" : ""}${tm.trend.corr.toFixed(3)} (${tm.trendN.move} rounds)`,
    );
  else console.log("   no data/circuit_priors.json (python priors.py): features-only fit in use");
}

/* ---------- 3. retirements: recency and shrinkage ---------- */
function retirements() {
  console.log("\n3. Retirement rate, walk-forward from R4 (log loss per car-race; lower is better)");
  const from = rounds.filter((g) => g >= 4);
  const out = [];
  for (const hl of [2, 4, 6, 10, 1000])
    for (const k of [0, 2, 4, 8, 16, 32]) {
      let loss = 0,
        n = 0;
      for (const r of from) {
        const m = E.buildModel(asOf(r), { model: { dnfHalfLife: hl, dnfShrink: k } });
        for (const row of D.results.race[r] || []) {
          const d = m.drivers.find((x) => x.tla === row.tla);
          if (!d) continue;
          const p = Math.min(0.99, Math.max(0.01, d.dnf));
          loss -= row.cls ? Math.log(1 - p) : Math.log(p);
          n++;
        }
      }
      out.push({ "half-life": hl === 1000 ? "none" : hl, shrink: k, "log loss": +(loss / n).toFixed(4) });
    }
  out.sort((a, b) => a["log loss"] - b["log loss"]);
  table(out.slice(0, 6));
  console.log(
    `   in use: half-life ${Number.isFinite(E.MODEL.dnfHalfLife) ? E.MODEL.dnfHalfLife : "none"}, shrink ${E.MODEL.dnfShrink}`,
  );
}

/* ---------- 4. practice weights ---------- */
function practiceWeights() {
  const rs = rounds.filter((g) => g >= 4 && W.PRACTICE[g] && W.PRACTICE[g].some((s) => s.done));
  if (!rs.length)
    return console.log(
      "\n4. Practice weights: no backtest/practice_by_round.json (python backtest/practice_rounds.py)",
    );
  console.log(
    `\n4. Practice weights, walk-forward on R${rs[0]}-R${rs[rs.length - 1]} (${rs.length} rounds; mean absolute error of expected position)`,
  );
  const run = (model, pick, actual) => {
    const err = [];
    for (const r of rs) {
      const Dr = asOf(r),
        c = E.trackModel(Dr).forCircuit(nameOf[r]);
      const m = E.buildModel(Dr, { practice: W.PRACTICE[r], teamShift: c.teamShift, model });
      for (const [tla, pos] of actual(r)) {
        const d = m.drivers.find((x) => x.tla === tla);
        if (d) err.push(Math.abs(pick(d) - pos));
      }
    }
    return mean(err);
  };
  const quali = (r) => (D.results.quali[r] || []).map((x) => [x.tla, x.pos]);
  const race = (r) => {
    const rows = (D.results.race[r] || []).filter((x) => x.cls);
    return rows.map((x) => [x.tla, ((x.pos - 0.5) / rows.length) * (D.cfg.field || 22) + 0.5]);
  };
  table(
    [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8].map((w) => ({
      "short-run weight": w,
      "quali MAE": +run({ practiceQ: w }, (d) => d.qMu, quali).toFixed(3),
    })),
  );
  table(
    [0, 0.05, 0.1, 0.2, 0.3].map((w) => ({
      "long-run weight": w,
      "race MAE": +run({ practiceR: w }, (d) => d.rMu, race).toFixed(3),
    })),
  );
  table(
    [0.2, 0.4, 0.8, 1.2, 99].map((c) => ({
      "pull cap (%)": c === 99 ? "none" : c,
      "quali MAE": +run({ practicePull: c }, (d) => d.qMu, quali).toFixed(3),
    })),
  );
  console.log(`   in use: short-run ${E.MODEL.practiceQ}, long-run ${E.MODEL.practiceR}, cap ${E.MODEL.practicePull}%`);
}

/* ---------- 5. calibration: simulated points by category vs this season ---------- */
function calibration() {
  console.log("\n5. Calibration: points per driver per race weekend by category, neutral track (simulated vs actual)");
  const actual = {},
    n = { races: 0 };
  const map = {
    "Q POS": "qualifying",
    "Q NC": "qualifying",
    "R POS": "race position",
    "R PG": "places gained",
    "R PL": "places lost",
    "R OV": "overtakes",
    "R FL": "fastest lap",
    "R DOTD": "Driver of the Day",
    "R NC": "not classified",
  };
  const ovDone = [];
  for (const a of D.assets) {
    if (a.kind !== "D") continue;
    for (const h of a.hist) {
      if (!h || !h.active || !h.ev) continue;
      n.races++;
      for (const [ni, v] of h.ev) {
        const k = map[D.evNames[ni].c];
        if (k) actual[k] = (actual[k] || 0) + v;
      }
    }
  }
  for (const g of rounds) if (D.trackStats[g]) ovDone.push(D.trackStats[g].ovt);
  const tm = E.trackModel(D),
    c = { ...tm.forCircuit("neutral"), ov: 1, chaos: 1, grid: tm.corrMean || 0.62, rain: { q: 0.1, s: 0.1, r: 0.1 } };
  const m = E.buildModel(D, {});
  const sim = E.simulate(m, c, false, 20000, 1);
  const nd = m.drivers.length,
    cat = {};
  for (const st of sim.stats.slice(0, nd)) for (const [k, v] of Object.entries(st.cat)) cat[k] = (cat[k] || 0) + v / nd;
  const simOf = {
    qualifying: cat.q,
    "race position": cat.rpos,
    "places gained": cat.gain,
    "places lost": cat.lost,
    overtakes: cat.ovt,
    "fastest lap": cat.fl,
    "Driver of the Day": cat.dotd,
    "not classified": cat.dnf,
  };
  table(
    Object.keys(simOf).map((k) => ({
      category: k,
      simulated: +simOf[k].toFixed(2),
      actual: +((actual[k] || 0) / n.races).toFixed(2),
    })),
  );
  // who gets fastest lap and DotD: share going to the seven fastest cars, simulated vs actual
  const top7 = m.drivers
    .map((d, i) => [d.rPace, i])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 7)
    .map(([, i]) => i);
  const share = (k) => top7.reduce((s, i) => s + sim.stats[i][k], 0);
  const top7Tla = new Set(top7.map((i) => m.drivers[i].tla));
  let fl = 0,
    fl7 = 0,
    dd = 0,
    dd7 = 0;
  const flI = new Set(D.evNames.map((e, i) => (e.c === "R FL" ? i : -1)));
  const ddI = new Set(D.evNames.map((e, i) => (e.c === "R DOTD" ? i : -1)));
  for (const a of D.assets)
    if (a.kind === "D")
      for (const h of a.hist)
        if (h && h.ev)
          for (const [i] of h.ev) {
            if (flI.has(i)) (fl++, top7Tla.has(a.tla) && fl7++);
            if (ddI.has(i)) (dd++, top7Tla.has(a.tla) && dd7++);
          }
  console.log(
    `   to the 7 fastest cars: fastest lap ${(100 * share("fl")).toFixed(0)}% simulated vs ${((100 * fl7) / (fl || 1)).toFixed(0)}% actual, Driver of the Day ${(100 * share("dotd")).toFixed(0)}% vs ${((100 * dd7) / (dd || 1)).toFixed(0)}%`,
  );
  console.log(
    `   safety car in ${(100 * sim.sc).toFixed(0)}% of simulated races, rain in ${(100 * sim.wet).toFixed(0)}%`,
  );
}

/* ---------- 6. walk-forward: projected points vs what happened (the gate) ---------- */
function walkForward() {
  console.log("\n6. Walk-forward, projected points vs actual (rounds 5+; lower CRPS / MAE is better)");
  const row = (label, o) => {
    const r = W.evaluate({ N: 3000, decision: true, ...o });
    return {
      variant: label,
      CRPS: +r.crps.toFixed(3),
      MAE: +r.mae.toFixed(3),
      "MAE drv": +r.maeD.toFixed(2),
      "MAE con": +r.maeC.toFixed(2),
      bias: +r.bias.toFixed(2),
      rho: +r.rho.toFixed(3),
      "in 10-90%": (100 * r.cover80).toFixed(0) + "%",
      "in 25-75%": (100 * r.cover50).toFixed(0) + "%",
      "team pts": r.team,
    };
  };
  const rows = [
    row("model (as shipped)", {}),
    row("without the market", { odds: false }),
    row("without practice", { practice: false }),
    row("+30% recent form (old default)", { blend: 0.3 }),
    row("no pace/reliability uncertainty", { unc: 0 }),
  ];
  table(rows);
  const b = W.baselines();
  const best = W.evaluate({ N: 1000, decision: true }).best;
  console.log(
    `   baselines, MAE: season average ${b.seasonAvg.toFixed(2)}, recent form ${b.form.toFixed(2)}, last three ${b.last3.toFixed(2)}; best possible fresh team ${best} pts`,
  );
}

/* ---------- 7. the frozen projections (what the site said at lock) vs results ---------- */
function frozen() {
  const dir = path.join(__dirname, "..", "history", String(D.season), "projections");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const rows = [];
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!D.done.includes(p.gd)) continue;
    const xs = [],
      ys = [];
    for (const [id, v] of Object.entries(p.assets)) {
      const a = D.assets.find((x) => x.id === id);
      const h = a && a.hist.find((x) => x && x.gd === p.gd);
      if (!h || !h.active) continue;
      xs.push(v.x);
      ys.push(h.pts);
    }
    rows.push({
      round: p.gd,
      MAE: +mean(xs.map((x, i) => Math.abs(x - ys[i]))).toFixed(2),
      rho: +(E.spearman(xs, ys) ?? NaN).toFixed(3),
      assets: xs.length,
    });
  }
  console.log("\n7. Frozen projections (saved at lock) vs results");
  if (rows.length) table(rows);
  else console.log("   none finished yet (the first is R15)");
}

/* ---------- 8. pit-stop scoring rule vs the constructors' scoring lines ---------- */
function pits() {
  const ri = D.raceInfo || {};
  const fpI = new Set(D.evNames.map((e, i) => (e.c === "R FP" ? i : -1)));
  const fp2I = new Set(D.evNames.map((e, i) => (e.c === "R FP2" ? i : -1)));
  let n = 0,
    band = 0,
    fast = 0,
    nf = 0;
  for (const g of rounds) {
    const info = ri[g] && ri[g].race;
    if (!info || !Object.keys(info.pits || {}).length) continue;
    const bestOf = Object.fromEntries(Object.entries(info.pits).map(([t, s]) => [t, s[0]]));
    const fastest = Object.entries(bestOf).sort((a, b) => a[1] - b[1])[0][0];
    for (const c of D.assets.filter((a) => a.kind === "C")) {
      const h = c.hist.find((x) => x && x.gd === g);
      if (!h || !h.ev || bestOf[c.team] == null) continue;
      const got = h.ev.filter(([i]) => fpI.has(i)).reduce((s, x) => s + x[1], 0);
      const bonus = h.ev.filter(([i]) => fp2I.has(i)).reduce((s, x) => s + x[1], 0);
      let want = 0;
      for (const [lim, v] of E.PIT_BANDS)
        if (bestOf[c.team] < lim) {
          want = v;
          break;
        }
      n++;
      if (got === want) band++;
      if (c.team === fastest) {
        nf++;
        if (bonus === E.PIT_FASTEST || got === want + E.PIT_FASTEST) fast++;
      }
    }
  }
  console.log(
    `\n8. Pit-stop rule vs scoring lines: band points match ${band}/${n} team-races; fastest-stop bonus found ${fast}/${nf}`,
  );
}

/* ---------- 9. experiments: candidate model changes, paired against the model as shipped ---------- */
// Each variant runs on the same rounds and seeds as the shipped model (common random numbers). Rounds are the
// independent units (assets within a round share its weekend), so ± is the standard error over rounds of the
// per-round difference, averaged over the seeds. Adopt a variant only if it beats the shipped model clearly.
/* Paired experiments against the shipped model: same seeds, same rounds; ± = SE over the rounds (the independent
   units). Each variant is [label, settings to change] or [label, settings, evaluate options] (oracle runs). */
function paired(title, variants, o = {}) {
  const N = +(process.env.EXP_N || o.N || 10000),
    seeds = [1, 2, 3, 4, 5].slice(0, +(process.env.EXP_SEEDS || o.seeds || 5)),
    grid = process.env.EXP_GRID === "1";
  console.log(`
${title} (${seeds.length} seeds x ${N} sims; Δ < 0 is better for CRPS, MAE and the category errors,`);
  console.log("   > 0 better for the log scores of qualifying / race positions and of the fastest lap)");
  const runAll = (extra = {}) => seeds.map((seed) => W.evaluate({ N, seed, ...extra }));
  const base = runAll(),
    baseG = grid ? runAll({ oracle: { grid: 1 } }) : null;
  const avg = (rs, f) => mean(rs.map(f));
  const f3 = (x) => +x.toFixed(3);
  const rows = [
    {
      variant: "model as shipped",
      CRPS: f3(avg(base, (r) => r.crps)),
      MAE: f3(avg(base, (r) => r.mae)),
      ...(grid ? { "CRPS, real grid": f3(avg(baseG, (r) => r.crps)) } : {}),
      "err OV": f3(avg(base, (r) => r.ovMae)),
      "err places": f3(avg(base, (r) => r.placesMae)),
      "err OV level": f3(avg(base, (r) => r.ovLvl)),
      "log Q": f3(avg(base, (r) => r.lsQ)),
      "log R": f3(avg(base, (r) => r.lsR)),
      "log FL": f3(avg(base, (r) => r.lsFL)),
      "ms/race": Math.round((avg(base, (r) => r.msPerRound) / N) * 1000),
    },
  ];
  const pm = (d) => {
    const m = mean(d),
      se = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1) / d.length);
    return `${m >= 0 ? "+" : ""}${m.toFixed(3)} ± ${se.toFixed(3)}`;
  };
  for (const [label, set, extra] of variants) {
    const keep = set.map(([obj, k]) => obj[k]);
    set.forEach(([obj, k, v]) => (obj[k] = v));
    const v = runAll(extra),
      vG = grid && !(extra && extra.oracle) ? runAll({ ...extra, oracle: { grid: 1 } }) : null;
    set.forEach(([obj, k], i) => (obj[k] = keep[i]));
    const per = (vs, bs, f) =>
      bs[0].byRound.map((_, k) => mean(seeds.map((_, j) => f(vs[j].byRound[k]) - f(bs[j].byRound[k]))));
    const d = (f) => {
      const x = avg(v, f) - avg(base, f);
      return `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
    };
    rows.push({
      variant: label,
      CRPS: pm(per(v, base, (x) => x.crps)),
      MAE: pm(per(v, base, (x) => x.mae)),
      ...(grid ? { "CRPS, real grid": vG ? pm(per(vG, baseG, (x) => x.crps)) : "" } : {}),
      "err OV": pm(per(v, base, (x) => x.ov)),
      "err places": pm(per(v, base, (x) => x.places)),
      "err OV level": pm(per(v, base, (x) => x.ovLvl)),
      "log Q": d((r) => r.lsQ),
      "log R": d((r) => r.lsR),
      "log FL": d((r) => r.lsFL),
      "ms/race": Math.round((avg(v, (r) => r.msPerRound) / N) * 1000),
    });
  }
  table(rows);
  console.log(
    "   err OV / err places: mean |simulated - actual| per driver-race of overtake points and of race places gained +",
  );
  console.log(
    "   lost points; err OV level: |simulated - actual| race overtakes per driver, per round; ms/race: per 1,000 sims.",
  );
  if (grid)
    console.log("   CRPS, real grid: the same projection given the actual qualifying order (the race model alone)");
}

/* ---------- 9. experiments (only on request: minutes) ---------- */
// Groups run by name: EXP=<group>[,<group>] npm run backtest 9 (default: all groups; EXP=none = the base row).
// EXP_N / EXP_SEEDS change the sims and seeds; EXP_GRID=1 adds the race-alone score given the real grid (2x time).
const EXPERIMENTS = {
  // item 9 stage 3a: the race run lap by lap (SIM.raceModel)
  laps: [["lap-by-lap race", [[E.SIM, "raceModel", "laps"]]]],
  // item 9 stages 2-5 together vs each alone ("is the sum more than its parts"; stage 2 is in the shipped model,
  // so its own part is minus the "without stage 2" row)
  combo: [
    ["without stage 2 (flat overtake level)", [[E.TRACK, "speed", false]]],
    ["+ stage 3 (timing segments + yo-yo)", [[E.SIM, "raceModel", "segments"]]],
    [
      "+ stage 4 (fast-corner band shift)",
      [
        [E.MODEL, "bandQ", 1],
        [E.MODEL, "bandR", 1],
      ],
    ],
    ["+ stage 5 (minisector practice pace)", [], { practiceMini: true }],
    [
      "stages 2+3+4+5 together",
      [
        [E.SIM, "raceModel", "segments"],
        [E.MODEL, "bandQ", 1],
        [E.MODEL, "bandR", 1],
      ],
      { practiceMini: true },
    ],
  ],
  // item 9 stage 3b: timing segments, the segment pass curve and the between-line yo-yo (SIM.raceModel "segments")
  segs: [["race in timing segments with the yo-yo", [[E.SIM, "raceModel", "segments"]]]],
  lapsreg: [
    [
      "lap race, overtakes from the regression",
      [
        [E.SIM, "raceModel", "laps"],
        [E.SIM, "lapOv", "regression"],
      ],
    ],
  ],
  // item 9 stage 2: the round's overtake level from the track's average speed (TRACK.speed)
  speed: [
    ["overtake level from average speed", [[E.TRACK, "speed", true]]],
    [
      "average speed, mean level",
      [
        [E.TRACK, "speed", true],
        [E.TRACK, "speedVar", 1],
      ],
    ],
    [
      "average speed, ridge 5",
      [
        [E.TRACK, "speed", true],
        [E.TRACK, "speedLambda", 5],
      ],
    ],
  ],
  // 2026-09-25, none adopted (see docs/history.md)
  skew: [
    ["qualifying noise skewed, shape 2", [[E.SIM, "qSkew", 2]]],
    ["qualifying noise skewed, shape 5", [[E.SIM, "qSkew", 5]]],
    ["race noise skewed, shape 2", [[E.SIM, "rSkew", 2]]],
    ["race noise skewed, shape 5", [[E.SIM, "rSkew", 5]]],
    [
      "both skewed, shape 3",
      [
        [E.SIM, "qSkew", 3],
        [E.SIM, "rSkew", 3],
      ],
    ],
  ],
  car: [
    [
      "car + driver offset, offset prior 1.5",
      [
        [E.MODEL, "mate", "car"],
        [E.MODEL, "offPrior", 1.5],
      ],
    ],
    [
      "car + driver offset, offset prior 3",
      [
        [E.MODEL, "mate", "car"],
        [E.MODEL, "offPrior", 3],
      ],
    ],
    [
      "car + driver offset, offset prior 6",
      [
        [E.MODEL, "mate", "car"],
        [E.MODEL, "offPrior", 6],
      ],
    ],
    [
      "car + offset, prior 3, offset half-life 8",
      [
        [E.MODEL, "mate", "car"],
        [E.MODEL, "offPrior", 3],
        [E.MODEL, "offHalfLife", 8],
      ],
    ],
  ],
  fl: [
    ["fastest lap from the market, 25%", [[E.SIM, "flOddsW", 0.25]]],
    ["fastest lap from the market, 50%", [[E.SIM, "flOddsW", 0.5]]],
    ["fastest lap from the market, 100%", [[E.SIM, "flOddsW", 1]]],
  ],
};
function experiments() {
  const want9 = (process.env.EXP || Object.keys(EXPERIMENTS).join(",")).split(",");
  const unknown = want9.filter((g) => g !== "none" && !EXPERIMENTS[g]);
  if (unknown.length) throw new Error(`unknown EXP group ${unknown} (have: ${Object.keys(EXPERIMENTS)}, none)`);
  paired(
    `9. Experiments vs the model as shipped [${want9}]`,
    want9.flatMap((g) => EXPERIMENTS[g] || []),
  );
  const nFl = Object.values(W.ODDS).filter((o) => o.fl && D.done.includes(+o.gd) && +o.gd >= 5).length;
  console.log(
    `   fastest-lap odds at lock for ${nFl} of the rounds (history/<season>/odds, backtest/odds_by_round.json)`,
  );
}

/* ---------- 10. ceilings (only on request): the most a better input could gain ---------- */
// The sim is told the round's real answer for one input (walk.js withOracle). Realised pace carries that session's
// noise too, so these are upper bounds. 2026-09-25 (3 seeds x 3,000): real race pace -0.44 ± 0.11 CRPS, real race
// overtake level -0.41 ± 0.16, both + qualifying pace -0.75 ± 0.26; qualifying pace or the real grid ~0. Item 9's plan
// follows these.
function ceilings() {
  paired(
    "10. Ceilings: the round's real answer for one input",
    [
      ["real qualifying pace", [], { oracle: { q: 1 } }],
      ["real qualifying order (grid)", [], { oracle: { grid: 1 } }],
      ["real race pace", [], { oracle: { r: 1 } }],
      ["real race overtake level", [], { oracle: { ov: 1 } }],
      ["real qualifying + race pace", [], { oracle: { q: 1, r: 1 } }],
      ["real qualifying + race pace + overtake level", [], { oracle: { q: 1, r: 1, ov: 1 } }],
    ],
    { N: 3000, seeds: 3 },
  );
  const lv = rounds
    .filter((g) => g >= 5)
    .map((g) => `${nameOf[g].name.replace(" Grand Prix", "")} ${W.roundOvertakes(g).toFixed(1)}`);
  console.log(`   actual race overtake points per driver: ${lv.join(", ")}`);
}

if (want(1)) prices();
if (want(2)) track();
if (want(3)) retirements();
if (want(4)) practiceWeights();
if (want(5)) calibration();
if (want(6)) walkForward();
if (want(7)) frozen();
if (want(8)) pits();
if (only.includes(9)) experiments(); // slow (minutes): only on request, npm run backtest 9
if (only.includes(10)) ceilings(); // slow (a minute): only on request, npm run backtest 10
