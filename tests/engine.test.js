// Unit tests for engine.js on small hand-made inputs (no data files needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");

test("priceStep: bands, sizes and clamps", () => {
  const step = (price, avg) => Math.round(E.priceStep(price, avg) * 10) / 10;
  // under $18.5m: ±0.2 / ±0.6
  assert.equal(step(10, 12.0), 0.6); // 1.2 pts per $m >= 1.195: big rise
  assert.equal(step(10, 10.0), 0.2); // 1.0: rise
  assert.equal(step(10, 7.0), -0.2); // 0.7: drop
  assert.equal(step(10, 5.0), -0.6); // 0.5: big drop
  // $18.5m and up: ±0.1 / ±0.3
  assert.equal(step(20, 24), 0.3);
  assert.equal(step(20, 19), 0.1);
  assert.equal(step(20, 13), -0.1);
  assert.equal(step(20, 5), -0.3);
  // band edges are inclusive after rounding the ratio to 3 dp
  assert.equal(step(10, 6.05), -0.2);
  assert.equal(step(10, 6.0451), -0.2); // 0.60451 rounds up to 0.605
  assert.equal(step(10, 6.044), -0.6); // 0.6044 rounds down to 0.604
  // prices stay within $3m-$34m
  assert.equal(step(3.1, 0), -0.1);
  assert.equal(step(33.9, 100), 0.1);
});

test("ridge solves a well-posed system", () => {
  const b = [1.5, -2, 0.5];
  const X = [];
  const y = [];
  for (let i = 0; i < 40; i++) {
    const x = [Math.sin(i), Math.cos(i * 1.3), ((i % 7) - 3) / 3];
    X.push(x);
    y.push(b[0] * x[0] + b[1] * x[1] + b[2] * x[2]);
  }
  E.ridge(X, y, 1e-9).forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `coef ${i}: ${v}`));
});

test("circuitFor reads circuit types from the season config", () => {
  const cfg = { circuits: { list: [["monaco", [0, 1, 0], "tight"]] } };
  assert.deepEqual(E.circuitFor("Monaco Grand Prix", cfg).feat, [0, 1, 0]);
  assert.equal(E.circuitFor("Somewhere New", cfg).note, "Average circuit");
});

/* ---------- simulate ---------- */
function toyModel(nTeams = 11) {
  const drivers = [],
    cons = [];
  for (let t = 0; t < nTeams; t++) {
    cons.push({ id: "C" + t, team: "T" + t, pitMu: 3, pitSd: 2, stops: [] });
    for (let k = 0; k < 2; k++)
      drivers.push({
        id: `D${t}${k}`,
        tla: `D${t}${k}`,
        team: "T" + t,
        qPace: 0.12 * (2 * t + k),
        rPace: 0.12 * (2 * t + k),
        qSe: 0.05,
        rSe: 0.05,
        qMu: 1 + 2 * t + k,
        rMu: 1 + 2 * t + k,
        dnf: 0.08,
        dnfN: 30,
        ov: 3,
        ovU: 0,
        practiceQ: null,
        practiceR: null,
        formQ: 0,
        formR: 0,
      });
  }
  return {
    drivers,
    cons,
    gRate: 0.08,
    field: nTeams * 2,
    ovB: [0, 0.1, 0.1],
    ovSprint: 0.4,
    slopeQ: 0.12,
    slopeR: 0.12,
  };
}
const circuit = {
  ov: 1,
  ovMean: 4,
  grid: 0.62,
  chaos: 1,
  sc: 0.5,
  scOv: 1.2,
  rain: { q: 0.1, s: 0.1, r: 0.1 },
  note: "",
  feat: [0.5, 0.2, 0.5],
};

test("simulate is repeatable for a seed and its probabilities add up", () => {
  const m = toyModel();
  const a = E.simulate(m, circuit, true, 2000, 42),
    b = E.simulate(m, circuit, true, 2000, 42);
  assert.deepEqual(Array.from(a.tot), Array.from(b.tot));
  for (const st of a.stats.slice(0, m.drivers.length)) {
    assert.ok(Math.abs(st.q.reduce((s, p) => s + p, 0) - 1) < 1e-9, "qualifying positions sum to 1");
    assert.ok(Math.abs(st.r.reduce((s, p) => s + p, 0) - 1) < 1e-9, "race positions + DNF sum to 1");
    assert.equal(st.q.length, m.field);
    assert.equal(st.r.length, m.field + 1);
  }
});

test("simulate scores every weekend with the official points", () => {
  const m = toyModel(),
    N = 3000,
    sim = E.simulate(m, circuit, false, N, 7);
  // across all drivers, the race hands out exactly one fastest lap and one DotD per weekend
  const nd = m.drivers.length;
  const fl = sim.stats.slice(0, nd).reduce((s, st) => s + st.fl, 0),
    dotd = sim.stats.slice(0, nd).reduce((s, st) => s + st.dotd, 0);
  assert.ok(Math.abs(fl - 1) < 1e-9 && Math.abs(dotd - 1) < 1e-9);
  // No Negative can only help, and the fastest car scores most on average
  sim.stats.forEach((st) => assert.ok(st.nnMean >= st.mean - 1e-9));
  const means = sim.stats.slice(0, nd).map((st) => st.mean);
  assert.equal(means.indexOf(Math.max(...means)), 0);
  // qualifying points per weekend: 10+9+...+1 = 55, minus 5 per no-time (rare); category totals agree
  const q = sim.stats.slice(0, nd).reduce((s, st) => s + st.cat.q, 0);
  assert.ok(q > 50 && q <= 55, `quali points per weekend ${q}`);
  // a constructor scores its drivers' points (minus DotD) plus bonus and pit stops, so at least their sum - 1
  for (let c = 0; c < m.cons.length; c++) {
    const i0 = 2 * c,
      i1 = 2 * c + 1;
    for (let s = 0; s < 50; s++) {
      const drv = sim.tot[i0 * N + s] + sim.tot[i1 * N + s];
      assert.ok(sim.tot[(nd + c) * N + s] >= drv - 10 - 1, "constructor >= drivers - DotD - Q bonus floor");
    }
  }
});

/* ---------- optimise vs brute force ---------- */
function mulberry(seed) {
  return E.mulberry32(seed);
}
function brute(cand, team, o) {
  const inTeam = new Set(team);
  const Ds = cand.filter((c) => c.kind === "D" && c.active && !o.bans.has(c.id));
  const Cs = cand.filter((c) => c.kind === "C" && !o.bans.has(c.id));
  const unlimited = o.chip === "wildcard" || o.chip === "limitless";
  const out = [];
  const pick = (arr, k, start = 0, acc = [], res = []) => {
    if (acc.length === k) res.push(acc.slice());
    else for (let i = start; i < arr.length; i++) pick(arr, k, i + 1, acc.concat([arr[i]]), res);
    return res;
  };
  for (const d5 of pick(Ds, 5))
    for (const c2 of pick(Cs, 2)) {
      const all = d5.concat(c2);
      if ([...o.locks].some((id) => !all.some((x) => x.id === id))) continue;
      const cost = all.reduce((s, x) => s + x.price, 0);
      if (o.chip !== "limitless" && cost > o.cap + 1e-6) continue;
      const t = 7 - all.filter((x) => inTeam.has(x.id)).length;
      if (!unlimited && t > o.maxT) continue;
      const H = Math.max(...d5.map((d) => (Array.isArray(d.boostE) ? d.boostE.length : 1)));
      let boost = 0;
      for (let h = 0; h < H; h++) {
        const v = d5.map((d) => (Array.isArray(d.boostE) ? d.boostE[h] : d.boostE)).sort((a, b) => b - a);
        boost += h === 0 && o.chip === "x3" ? 2 * v[0] + v[1] : v[0];
      }
      const pen = unlimited ? 0 : (o.penW ?? 10) * Math.max(0, t - o.free);
      const score = all.reduce((s, x) => s + x.e, 0) + boost - pen;
      const ok = (o.filters || []).every((f) => {
        const v = f.k === "cost" ? cost : f.k === "score" ? score : all.reduce((s, x) => s + (x.f[f.k] || 0), 0);
        return (f.min == null || v >= f.min - 1e-9) && (f.max == null || v <= f.max + 1e-9);
      });
      if (ok) out.push(score);
    }
  return out.sort((a, b) => b - a);
}
test("optimise finds exactly the brute-force best teams", () => {
  const r = mulberry(99);
  for (let trial = 0; trial < 12; trial++) {
    const H = 1 + (trial % 3);
    const cand = [];
    for (let i = 0; i < 9; i++) {
      const per = Array.from({ length: H }, () => 5 + 25 * r());
      cand.push({
        id: "d" + i,
        kind: "D",
        price: 5 + 20 * r(),
        e: per.reduce((s, v) => s + v, 0),
        boostE: H === 1 ? per[0] : per,
        active: i !== 8 || trial % 2 === 0,
        f: { a: r() },
      });
    }
    for (let i = 0; i < 5; i++)
      cand.push({ id: "c" + i, kind: "C", price: 8 + 20 * r(), e: 10 + 40 * r(), active: true, f: { a: r() } });
    const team = ["d0", "d1", "d2", "d3", "d4", "c0", "c1"];
    const chip = ["", "x3", "wildcard", "limitless"][trial % 4];
    const o = {
      cap: 100 + 10 * r(),
      free: trial % 3,
      maxT: 2 + (trial % 4),
      chip,
      locks: new Set(trial % 5 === 0 ? ["d2"] : []),
      bans: new Set(trial % 6 === 1 ? ["c3"] : []),
      top: 15,
      filters: trial % 4 === 1 ? [{ k: "a", min: 2.5 }] : trial % 4 === 2 ? [{ k: "cost", max: 95 }] : [],
    };
    const got = E.optimise(cand, team, o).map((x) => x.score);
    const want = brute(cand, team, o).slice(0, 15);
    assert.equal(got.length, want.length, `trial ${trial}: count`);
    got.forEach((s, i) => assert.ok(Math.abs(s - want[i]) < 1e-9, `trial ${trial} #${i}: ${s} vs ${want[i]}`));
  }
});

test("budgetCurve: the best team at every budget matches a brute force at that cap", () => {
  const r = mulberry(7);
  for (let trial = 0; trial < 6; trial++) {
    const cand = [];
    // prices in $0.1m steps, like the game's
    for (let i = 0; i < 9; i++) {
      const e = 5 + 25 * r();
      cand.push({ id: "d" + i, kind: "D", price: Math.round(50 + 200 * r()) / 10, e, boostE: e, active: true });
    }
    for (let i = 0; i < 5; i++)
      cand.push({ id: "c" + i, kind: "C", price: Math.round(80 + 200 * r()) / 10, e: 10 + 40 * r(), active: true });
    const team = ["d0", "d1", "d2", "d3", "d4", "c0", "c1"];
    const o = {
      free: trial % 3,
      maxT: 2 + (trial % 4),
      chip: ["", "x3", "wildcard"][trial % 3],
      locks: new Set(),
      bans: new Set(),
    };
    const curve = E.budgetCurve(cand, team, { ...o, lo: 60, hi: 140 });
    assert.equal(curve.length, 801);
    for (let k = 0; k < curve.length; k += 7) {
      const want = brute(cand, team, { ...o, cap: curve[k].cap })[0];
      if (want == null) assert.equal(curve[k].score, null, `trial ${trial} $${curve[k].cap}m: none fits`);
      else assert.ok(Math.abs(curve[k].score - want) < 1e-9, `trial ${trial} $${curve[k].cap}m`);
    }
  }
});

test("optimise: the Boost goes to the best driver of each race", () => {
  const cand = [
    { id: "a", kind: "D", price: 10, e: 30, boostE: [20, 10], active: true },
    { id: "b", kind: "D", price: 10, e: 30, boostE: [10, 20], active: true },
    ...["c", "d", "e"].map((id) => ({ id, kind: "D", price: 10, e: 10, boostE: [5, 5], active: true })),
    { id: "x", kind: "C", price: 10, e: 10, active: true },
    { id: "y", kind: "C", price: 10, e: 10, active: true },
  ];
  const [best] = E.optimise(cand, [], {
    cap: 100,
    free: 7,
    maxT: 7,
    chip: "",
    locks: new Set(),
    bans: new Set(),
    top: 1,
  });
  assert.equal(best.score, 30 + 30 + 30 + 20 + 20 + 20); // assets + Boost on a (race 1) and b (race 2)
  assert.equal(best.boost, "a");
});

test("presetWeights: classic, weighted decay and a form window", () => {
  const done = [1, 2, 3, 4];
  assert.deepEqual(E.presetWeights("classic", done), { 1: 1, 2: 1, 3: 1, 4: 1 });
  const w = E.presetWeights("weighted", done, { decay: 0.5 });
  assert.deepEqual([w[4], w[3], w[2], w[1]], [1, 0.5, 0.25, 0.125]);
  assert.deepEqual(E.presetWeights("form", done, { win: 2 }), { 1: 0, 2: 0, 3: 1, 4: 1 });
});

test("pastPoints: weighted averages, sprint lines, left-out categories and PPM tiers", () => {
  const evNames = [{ c: "R POS" }, { c: "S POS" }, { c: "R OV" }];
  const row = (gd, price, ev, active = true) => ({
    gd,
    price,
    active,
    team: "T",
    pts: ev.reduce((s, [, v]) => s + v, 0),
    ev,
  });
  const data = {
    evNames,
    done: [1, 2, 3],
    schedule: [
      { gd: 1, name: "a", sprint: false, lock: "" },
      { gd: 2, name: "b", sprint: true, lock: "" },
      { gd: 3, name: "c", sprint: false, lock: "" },
      { gd: 4, name: "d", sprint: false, lock: "" },
    ],
    assets: [
      {
        id: "A",
        kind: "D",
        price: 10,
        active: true,
        hist: [
          row(1, 10, [[0, 10]]),
          row(2, 10, [
            [0, 20],
            [1, 6],
            [2, -4],
          ]),
          row(3, 10, [[0, 30]]),
        ],
      },
      { id: "B", kind: "D", price: 12, active: true, hist: [row(1, 12, [[0, 5]]), null, row(3, 12, [[0, 7]], false)] },
    ],
  };
  const classic = E.pastPoints(data, { preset: "classic", weights: E.presetWeights("classic", data.done) });
  assert.equal(classic.A.base, (10 + 16 + 30) / 3); // round 2's race lines: 20 - 4
  assert.equal(classic.A.sprint, 6); // sprint lines only, averaged over the sprint round
  assert.equal(classic.A.nnBase, (10 + 20 + 30) / 3); // the -4 floored
  assert.equal(classic.B.base, 5); // rounds it didn't race don't count as zero
  const form = E.pastPoints(data, { preset: "form", weights: E.presetWeights("form", data.done, { win: 1 }) });
  assert.equal(form.A.base, 30);
  assert.equal(form.A.sprint, 6); // no sprint round in the window: every sprint round it raced
  const noOv = E.pastPoints(data, { preset: "classic", weights: { 1: 1, 2: 1, 3: 1 }, off: ["R OV"] });
  assert.equal(noOv.A.base, 20);
  // PPM: both drivers are in the under-$18.5m tier; (10+16+30+5) pts over (10+10+10+12) $m, times each price
  const ppm = E.pastPoints(data, { preset: "ppm", weights: { 1: 1, 2: 1, 3: 1 } });
  assert.ok(Math.abs(ppm.A.base - (10 * 61) / 42) < 1e-9);
  assert.ok(Math.abs(ppm.B.base - (12 * 61) / 42) < 1e-9);
});

/* ---------- new model pieces ---------- */
test("poissonGlm recovers known coefficients with an offset", () => {
  const r = E.mulberry32(5);
  const X = [],
    y = [],
    off = [];
  for (let n = 0; n < 4000; n++) {
    const x1 = r() * 2,
      x2 = r();
    const o = Math.log(2 + 3 * r());
    X.push([1, x1, x2]);
    off.push(o);
    const mu = Math.exp(o + 0.2 + 0.5 * x1 - 0.7 * x2);
    // Poisson draw
    let k = 0,
      p = 1;
    const L = Math.exp(-mu);
    do {
      k++;
      p *= r();
    } while (p > L);
    y.push(k - 1);
  }
  const b = E.poissonGlm(X, y, off, 1e-6);
  [0.2, 0.5, -0.7].forEach((v, i) => assert.ok(Math.abs(b[i] - v) < 0.06, `coef ${i}: ${b[i]}`));
});

test("simulate: a known qualifying order is used as is; grid penalties drop a driver down the race grid", () => {
  const m = toyModel(),
    N = 400;
  const order = m.drivers.map((d) => d.tla).reverse(); // slowest on pole
  const sim = E.simulate(m, circuit, false, N, 3, { known: { q: order } });
  const last = m.drivers.length - 1;
  assert.equal(sim.stats[last].q[0], 1, "the known pole-sitter qualifies first every time");
  // back of the grid: the car finishes lower (it still gains places, which fantasy pays for)
  const base = E.simulate(m, circuit, false, 3000, 9);
  const pen = E.simulate(m, circuit, false, 3000, 9, { pen: { D00: 99 } });
  const top3 = (st) => st.r[0] + st.r[1] + st.r[2];
  assert.ok(
    top3(pen.stats[0]) < top3(base.stats[0]) - 0.1,
    `podium odds ${top3(base.stats[0])} -> ${top3(pen.stats[0])}`,
  );
});

test("simulate: team-mates share their weekend form (it widens a constructor's range)", () => {
  const m = toyModel(),
    keep = E.SIM.teamSd,
    c = m.drivers.length + 5; // a midfield constructor
  try {
    E.SIM.teamSd = 0;
    const flat = E.simulate(m, circuit, false, 6000, 4).stats[c].sd;
    E.SIM.teamSd = 0.4;
    const shared = E.simulate(m, circuit, false, 6000, 4).stats[c].sd;
    assert.ok(shared > flat * 1.1, `constructor spread ${flat.toFixed(2)} -> ${shared.toFixed(2)}`);
  } finally {
    E.SIM.teamSd = keep;
  }
});

test("simulate: pit points are resampled from the team's recent races", () => {
  const m = toyModel(2);
  m.cons[0].stops = [25, 25, 20, 20]; // a fast crew: band points plus the fastest-stop bonus
  m.cons[1].stops = [2, 0, 2, 0];
  const sim = E.simulate(m, circuit, false, 4000, 1);
  const pit = sim.stats.slice(m.drivers.length).map((st) => st.pit);
  assert.ok(Math.abs(pit[0] - 22.5) < 0.5, `fast crew ${pit[0]}`);
  assert.ok(Math.abs(pit[1] - 1) < 0.2, `slow crew ${pit[1]}`);
});

test("applyOdds moves the simulated win chances towards the market", () => {
  const m = toyModel();
  const favourite = "D30"; // a midfielder the market loves
  const odds = { win: { [favourite]: 0.3, D00: 0.3 }, top10: { [favourite]: 0.9 } };
  const before = E.simulate(m, circuit, false, 3000, 2);
  const m2 = E.applyOdds(m, circuit, odds, { w: 1, n: 1500 });
  const after = E.simulate(m2, circuit, false, 3000, 2);
  const i = m.drivers.findIndex((d) => d.tla === favourite);
  assert.ok(after.stats[i].r[0] > before.stats[i].r[0] + 0.05, `win ${before.stats[i].r[0]} -> ${after.stats[i].r[0]}`);
  const m0 = E.applyOdds(m, circuit, odds, { w: 0 });
  assert.equal(m0, m, "weight 0 leaves the model alone");
});

test("trackModel: circuit priors scaled by this season's trend", () => {
  const cfg = { circuits: { list: [] }, field: 20 };
  const priors = { races: [] };
  // two circuits with history: A calm (2 overtakes per starter), B busy (6)
  for (const season of [2023, 2024, 2025])
    for (const [c, ovt] of [
      ["a", 2],
      ["b", 6],
    ])
      priors.races.push({
        season,
        round: 1,
        circuit: c,
        name: c.toUpperCase() + " GP",
        starters: 20,
        dnf: 2,
        move: 2,
        gain: 1,
        gridCorr: 0.7,
        sc: 1,
        rain: 0,
        ovt,
      });
  // this season: both circuits raced with twice the overtakes
  const results = { race: {}, quali: {}, sprint: {} };
  const schedule = [];
  const trackStats = {};
  for (let gd = 1; gd <= 8; gd++) {
    const c = gd % 2 ? "a" : "b";
    schedule.push({ gd, name: c.toUpperCase() + " GP", sprint: false, lock: "", circuit: c });
    results.race[gd] = Array.from({ length: 20 }, (_, i) => ({
      tla: "T" + i,
      team: "X" + (i >> 1),
      pos: i + 1,
      grid: i + 1,
      cls: i < 18,
    }));
    trackStats[gd] = { ovt: c === "a" ? 4 : 12 };
  }
  schedule.push({ gd: 9, name: "B GP", sprint: false, lock: "", circuit: "b" });
  const full = { alpha: { ov: 1, dnf: 1, sc: 1, corr: 1 } }; // the circuits' own profiles at full weight
  const tm = E.trackModel(
    { schedule, done: [1, 2, 3, 4, 5, 6, 7, 8], assets: [], results, trackStats, cfg, priors },
    full,
  );
  // alpha 0: every circuit gets this season's average
  const flat = E.trackModel(
    { schedule, done: [1, 2, 3, 4, 5, 6, 7, 8], assets: [], results, trackStats, cfg, priors },
    { alpha: { ov: 0, dnf: 0, sc: 0, corr: 0 } },
  );
  assert.equal(flat.forCircuit(schedule[8]).ov, 1);
  const b = tm.forCircuit(schedule[8]);
  const a = tm.forCircuit(schedule[0]);
  // the busy circuit well above its past (6, shrunk towards the average) and still twice the calm one
  assert.ok(b.ov * tm.ovMean > 9 && b.ov * tm.ovMean < 13, `busy circuit forecast ${b.ov * tm.ovMean}`);
  assert.ok(b.ov > 1.6 * a.ov, `busy ${b.ov} vs calm ${a.ov}`);
  const fresh = E.trackModel({
    schedule,
    done: [],
    assets: [],
    results: { race: {}, quali: {}, sprint: {} },
    trackStats: {},
    cfg,
    priors,
  });
  assert.equal(fresh.trend.move, 1, "a new season starts with no trend");
});

test("trackModel: the next race's overtake level follows its practice average speed", () => {
  // six rounds: overtakes per starter rise with average speed (length / reference lap)
  const km = { slow: 3.3, mid: 5, fast: 5.8 };
  const laps = { slow: 74, mid: 90, fast: 82 }; // 160, 200 and 255 km/h
  const ovt = { slow: 1.5, mid: 4, fast: 10 };
  const order = ["slow", "mid", "fast", "slow", "mid", "fast"];
  const schedule = order.map((c, i) => ({ gd: i + 1, name: c + " GP", sprint: false, lock: "", circuit: c }));
  schedule.push({ gd: 7, name: "next GP", sprint: false, lock: "", circuit: "fast" });
  schedule.push({ gd: 8, name: "later GP", sprint: false, lock: "", circuit: "fast" });
  const results = { race: {}, quali: {}, sprint: {} };
  const trackStats = {};
  order.forEach((c, i) => {
    results.race[i + 1] = Array.from({ length: 20 }, (_, k) => ({
      tla: "T" + k,
      team: "X",
      pos: k + 1,
      grid: k + 1,
      cls: true,
    }));
    trackStats[i + 1] = { ovt: ovt[c], lap: laps[c] };
  });
  const data = {
    schedule,
    done: [1, 2, 3, 4, 5, 6],
    assets: [],
    results,
    trackStats,
    cfg: { circuits: { list: [], km } },
    practice: [{ name: "Practice 1", done: true, ref: 82, drivers: {} }],
  };
  const tm = E.trackModel(data, { speed: true, speedLambda: 0 });
  assert.equal(tm.speed.n, 6);
  const next = tm.forCircuit(schedule[6]);
  assert.ok(Math.abs(next.kmh - 254.6) < 0.1, `speed ${next.kmh}`);
  assert.ok(next.ov * tm.ovMean > 8 && next.ov * tm.ovMean < 12, `fast track level ${next.ov * tm.ovMean}`);
  // a slow practice at the same track: fewer overtakes
  const slow = E.trackModel(
    { ...data, practice: [{ name: "Practice 1", done: true, ref: 120, drivers: {} }] },
    { speed: true },
  );
  assert.ok(slow.forCircuit(schedule[6]).ov < next.ov);
  // no practice yet, a race after the next, a circuit without a length, or the switch off: the flat level
  assert.equal(E.trackModel({ ...data, practice: [] }, { speed: true }).forCircuit(schedule[6]).ov, 1);
  assert.equal(tm.forCircuit(schedule[7]).ov, 1);
  assert.equal(
    E.trackModel({ ...data, cfg: { circuits: { list: [], km: {} } } }, { speed: true }).forCircuit(schedule[6]).ov,
    1,
  );
  assert.equal(E.trackModel(data, { speed: false }).forCircuit(schedule[6]).ov, 1);
  assert.equal(
    E.practiceRef([
      { name: "a", done: true, ref: 90, drivers: {} },
      { name: "b", done: true, ref: 89, drivers: {} },
      { name: "c", done: false, drivers: {} },
    ]),
    89,
  );
});

test("planHorizon: waiting to transfer can beat transferring now, and matches a brute force", () => {
  // race 1: keep the team; race 2: driver f (not owned) is great. Free transfers: 0 now, 2 next race.
  const mk = (vals) =>
    Object.entries(vals).map(([id, e]) => ({
      id,
      kind: id[0] === "K" ? "C" : "D",
      price: 10,
      e,
      boostE: id[0] === "K" ? 0 : e,
      active: true,
    }));
  const r1 = { a: 20, b: 20, c: 20, d: 20, e: 20, f: 5, KA: 10, KB: 10, KC: 5 };
  const r2 = { a: 20, b: 20, c: 20, d: 20, e: 5, f: 40, KA: 10, KB: 10, KC: 5 };
  const team = ["a", "b", "c", "d", "e", "KA", "KB"];
  const o = { cap: 100, free: 0, maxT: 7, chip: "", locks: new Set(), bans: new Set() };
  const [best] = E.planHorizon([{ cand: mk(r1) }, { cand: mk(r2) }], team, o);
  // keep for race 1 (20*5 + 20 boost + 20 = 140), then e -> f for free (20*4 + 40 + 40 boost + 20 = 180)
  assert.equal(Math.round(best.total), 320);
  assert.equal(best.steps[0].transfers, 0);
  assert.equal(best.steps[1].transfers, 1);
  assert.equal(best.steps[1].penalty, 0);
});

test("planHorizon: firstMaxT caps the first race's transfers only", () => {
  const mk = (vals) =>
    Object.entries(vals).map(([id, e]) => ({
      id,
      kind: id[0] === "K" ? "C" : "D",
      price: 10,
      e,
      boostE: id[0] === "K" ? 0 : e,
      active: true,
    }));
  // f is great in both races: with 1 free transfer the best plan takes it now
  const r = { a: 20, b: 20, c: 20, d: 20, e: 5, f: 40, KA: 10, KB: 10, KC: 5 };
  const team = ["a", "b", "c", "d", "e", "KA", "KB"];
  const o = { cap: 100, free: 1, maxT: 7, chip: "", locks: new Set(), bans: new Set() };
  const stages = [{ cand: mk(r) }, { cand: mk(r) }];
  const [now] = E.planHorizon(stages, team, o);
  const [wait] = E.planHorizon(stages, team, { ...o, firstMaxT: 0 });
  assert.equal(now.steps[0].transfers, 1);
  assert.equal(wait.steps[0].transfers, 0);
  assert.equal(wait.steps[1].transfers, 1); // it still makes the move, one race later
  assert.equal(Math.round(now.total - wait.total), 55); // race 1 with f in (+35) and as the Boost (+20)
});

test("simulate: no qualifying time costs -5 in the dry, nothing in the wet", () => {
  const m = toyModel(),
    keep = E.SIM.qualiNoTime;
  try {
    E.SIM.qualiNoTime = 1; // nobody sets a time
    const dry = E.simulate(m, { ...circuit, rain: { q: 0, s: 0, r: 0 } }, false, 200, 1);
    const wet = E.simulate(m, { ...circuit, rain: { q: 1, s: 0, r: 0 } }, false, 200, 1);
    assert.equal(dry.stats[0].cat.q, -5);
    assert.equal(wet.stats[0].cat.q, 0);
  } finally {
    E.SIM.qualiNoTime = keep;
  }
});

test("simulate: Driver of the Day follows each driver's popularity", () => {
  const m = toyModel();
  const base = E.simulate(m, circuit, false, 4000, 5).stats[0].dotd;
  m.drivers[0].dotdPop = 0.3; // a winner the fans don't vote for
  const low = E.simulate(m, circuit, false, 4000, 5).stats[0].dotd;
  assert.ok(low < base * 0.6, `DotD ${base} -> ${low}`);
});

test("raceLaps: order changes on track only by passes; a fast car from the back works through", () => {
  const n = 10,
    r = (() => {
      let x = 7;
      return () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
    })();
  const grid = Int32Array.from({ length: n }, (_, i) => i + 1);
  const base = new Float64Array(n),
    out = new Uint8Array(n),
    passes = new Float64Array(n);
  const o = { grid, base, out, ovU: [], laps: 30, T: 90, sc: false, wet: false, sprint: true, theta: -50 };
  // no passing, no stops (a sprint): the grid order holds whatever the pace
  base[9] = -3;
  assert.deepEqual(E.raceLaps(o, r, passes), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(
    passes.reduce((a, b) => a + b, 0),
    0,
  );
  // passing on: the car 3 s a lap faster from the back gains places, all of them by passes
  const ord = E.raceLaps({ ...o, theta: 1 }, r, passes);
  assert.ok(ord.indexOf(9) <= 2, `fast car finished P${ord.indexOf(9) + 1}`);
  assert.ok(passes[9] >= 7, `passes ${passes[9]}`);
  // a retired car drops out; stops (a race) reorder without passes
  out[3] = 1;
  const race = E.raceLaps({ ...o, sprint: false }, r, passes);
  assert.equal(race.length, 9);
  assert.ok(!race.includes(3));
  assert.equal(
    passes.reduce((a, b) => a + b, 0),
    0,
  );
});

test("raceSegs: the yo-yo credits both cars and never changes the order", () => {
  const n = 8;
  let x = 11;
  const r = () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
  const grid = Int32Array.from({ length: n }, (_, i) => i + 1);
  const o = {
    grid,
    base: new Float64Array(n),
    out: new Uint8Array(n),
    ovU: [],
    laps: 20,
    T: 90,
    sc: false,
    wet: false,
    sprint: true,
    theta: -50,
  };
  const passes = new Float64Array(n),
    keep = E.SIM.yoyo;
  try {
    E.SIM.yoyo = 0;
    assert.deepEqual(E.raceSegs(o, r, passes), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(
      passes.reduce((a, b) => a + b, 0),
      0,
    );
    E.SIM.yoyo = 1; // every close pair swaps and swaps back each segment
    assert.deepEqual(E.raceSegs(o, r, passes), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(passes[0] > 0 && passes[7] > 0);
    assert.equal(passes.reduce((a, b) => a + b, 0) % 2, 0); // they come in pairs
  } finally {
    E.SIM.yoyo = keep;
  }
});

test("simulate: the lap-by-lap race makes the circuit's overtake level", () => {
  const keep = E.SIM.raceModel;
  try {
    E.SIM.raceModel = "laps";
    const m = toyModel();
    for (const ov of [0.5, 1.5]) {
      const c = { ...circuit, ov, laps: 50, lapT: 90 };
      const sim = E.simulate(m, c, false, 1500, 3);
      const got = sim.stats.slice(0, m.drivers.length).reduce((a, s) => a + s.cat.ovt, 0) / m.drivers.length;
      assert.ok(Math.abs(got / (4 * ov) - 1) < 0.12, `level ${4 * ov}: simulated ${got}`);
    }
  } finally {
    E.SIM.raceModel = keep;
  }
});

test("ovScenarios: low / high weekends from the spread of this season's rounds", () => {
  const data = {
    done: [1, 2, 3, 4, 5],
    trackStats: { 1: { ovt: 2 }, 2: { ovt: 4 }, 3: { ovt: 4 }, 4: { ovt: 4 }, 5: { ovt: 6 } },
  };
  const s = E.ovScenarios(data);
  assert.deepEqual(s, { low: 0.9, high: 1.1, n: 5 }); // ratios 0.5, 1, 1, 1, 1.5: 20th / 80th percentiles
  assert.equal(E.ovScenarios({ ...data, done: [1, 2, 3] }), null); // too few rounds
});
