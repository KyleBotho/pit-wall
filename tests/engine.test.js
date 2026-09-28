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

test("fit log: a singular fit is flagged (not just finite); a Poisson fit says whether it converged", () => {
  const { value, fits } = E.withFitLog(() =>
    E.ridge(
      [
        [1, 1],
        [1, 1],
      ],
      [1, 2],
      0,
      "twins",
    ),
  );
  assert.ok(value.every(Number.isFinite));
  assert.deepEqual([fits[0].name, fits[0].ok, fits[0].dropped], ["twins", false, 1]);
  const X = [0, 1, 2, 3, 4, 5].map((v) => [1, v / 5]),
    y = [1, 2, 2, 4, 5, 7];
  const ok = E.withFitLog(() => E.poissonGlm(X, y, new Array(6).fill(0), 0.5, "fine")).fits[0];
  assert.ok(ok.ok && ok.converged && ok.iters < 30);
  // perfect separation: the slope runs off, IRLS never settles
  const sep = E.withFitLog(() => E.poissonGlm(X, [0, 0, 0, 0, 0, 9], new Array(6).fill(0), 0, "separated")).fits[0];
  assert.equal(sep.ok, false);
  assert.equal(E.withFitLog(() => 0).fits.length, 0);
  // the condition number is the real one (eigenvalues), not a pivot ratio
  assert.equal(fits[0].cond, Infinity);
  assert.ok(Number.isFinite(ok.cond) && ok.cond >= 1);
  // [[2, 1], [1, 2]]: eigenvalues 3 and 1 (pivots 2 and 1.5 would say 1.33)
  const cond = E.withFitLog(() =>
    E.ridge(
      [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      [1, 1, 2],
      0,
      "known",
    ),
  ).fits[0].cond;
  assert.ok(Math.abs(cond - 3) < 1e-9, `cond ${cond}`);
  assert.deepEqual(
    E.symEig([
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ])
      .sort((a, b) => a - b)
      .map((v) => +v.toFixed(9)),
    [3 - Math.sqrt(3), 3, 3 + Math.sqrt(3)].map((v) => +v.toFixed(9)),
  );
});

test("gauss: both Box-Muller halves are standard normals, and a pair is uncorrelated", () => {
  const r = E.mulberry32(3),
    n = 200000,
    xs = Array.from({ length: n }, () => E.gauss(r));
  const m = xs.reduce((a, b) => a + b, 0) / n,
    v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  let c = 0;
  for (let k = 0; k + 1 < n; k += 2) c += xs[k] * xs[k + 1];
  assert.ok(Math.abs(m) < 0.01 && Math.abs(v - 1) < 0.015, `${m} ${v}`);
  assert.ok(Math.abs(c / (n / 2)) < 0.01, `pair corr ${c / (n / 2)}`);
  assert.ok(Math.abs(xs.filter((x) => x > 1.96).length / n - 0.025) < 0.002);
});

test("sameAgeBooks: a book fetched before qualifying ended isn't fitted with the ones fetched after", () => {
  const g = { gd: 16, sessions: [{ type: "Qualifying", end: "2026-10-03T09:00:00Z" }] };
  const odds = {
    gd: 16,
    win: { A: 0.5 },
    pole: { A: 0.4 },
    at: "2026-10-02T12:00+00:00",
    asOf: { win: "2026-10-03T10:00+00:00", pole: "2026-10-02T12:00+00:00" },
  };
  const out = E.sameAgeBooks(odds, g);
  assert.deepEqual(
    [out.win, out.pole, out.at, out.dropped],
    [{ A: 0.5 }, undefined, "2026-10-03T10:00+00:00", ["pole"]],
  );
  // all from the same side: unchanged
  const same = { ...odds, asOf: { win: "2026-10-02T11:00+00:00", pole: "2026-10-02T12:00+00:00" } };
  assert.equal(E.sameAgeBooks(same, g), same);
});

test("atLock: the snapshot frozen at lock wins over later data; without one, later penalties are left out", () => {
  const g = { gd: 16, lock: "2026-10-03T08:00:00Z", sessions: [] };
  const data = {
    schedule: [g],
    done: [],
    generated: "2026-10-03T12:00:00Z", // after lock
    weather: { 16: { q: 1, r: 1 } }, // turned wet after lock
    practice: [{ name: "FP3", done: true, drivers: {} }],
    weekend: { gd: 16, penalties: { NOR: 10, VER: 5 }, penAt: { NOR: "2026-10-03T08:30:00Z" }, grid: { q: ["X"] } },
    odds: { gd: 16, win: {} },
    oddsLock: { gd: 16, win: { A: 1 } },
  };
  const bare = E.atLock(data);
  assert.deepEqual(bare.weekend.penalties, { VER: 5 }); // NOR's came 30 min after lock
  assert.deepEqual(bare.weekend.grid, {});
  assert.equal(bare.odds, data.oddsLock);
  const snap = { gd: 16, weather: { q: 0.1, r: 0.2 }, penalties: { VER: 5 }, practice: [] };
  const frozen = E.atLock({ ...data, lockSnap: snap });
  assert.deepEqual(frozen.weather[16], { q: 0.1, r: 0.2 });
  assert.deepEqual(frozen.practice, []);
  assert.deepEqual(frozen.weekend.penalties, { VER: 5 });
  // before lock: the data itself
  const before = E.atLock({ ...data, generated: "2026-10-03T07:00:00Z", lockSnap: snap });
  assert.deepEqual(before.weekend.penalties, data.weekend.penalties);
  assert.equal(before.weather, data.weather);
});

test("pairedCompare: net of penalties, ties and reversals (the third review's fixtures)", () => {
  const same = (v) => new Float64Array(8).fill(v);
  // raw 110 vs 100 with penalties 10 vs 0: an exact net tie, no noise
  const tie = E.pairedCompare(same(110), same(100), 10, 0);
  assert.deepEqual([tie.gap, tie.near, tie.reversed], [0, true, false]);
  // the original #1 is 10 behind on the independent run, no noise: reversed, not "near"
  const rev = E.pairedCompare(same(100), same(110), 0, 0);
  assert.deepEqual([rev.gap, rev.near, rev.reversed], [-10, false, true]);
  // inside the noise
  const a = Float64Array.from([0, 20, 0, 20]),
    b = Float64Array.from([10, 10, 10, 10]);
  assert.equal(E.pairedCompare(a, b, 0, 0).near, true);
});

test("poisson: exact at high rates (the skew of Poisson(31) is 1/sqrt(31) = 0.18, not 0)", () => {
  const r = E.mulberry32(7),
    n = 200000,
    xs = Array.from({ length: n }, () => E.poisson(31, r));
  const m = xs.reduce((a, b) => a + b, 0) / n,
    v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n,
    sk = xs.reduce((a, b) => a + (b - m) ** 3, 0) / n / v ** 1.5;
  assert.ok(Math.abs(m - 31) < 0.05 && Math.abs(v - 31) < 0.4, `${m} ${v}`);
  assert.ok(Math.abs(sk - 1 / Math.sqrt(31)) < 0.03, `skew ${sk}`);
});

test("numerical edges: a singular system stays finite, zero weights never win, no noise, no samples", () => {
  // the reviewer's fixtures (2026-09-27): [[1,1],[1,1]] x = [1,2] came back as about -1e12 / +1e12
  const x = E.ridge(
    [
      [1, 1],
      [1, 1],
    ],
    [1, 2],
    0,
  );
  assert.ok(
    x.every((v) => Number.isFinite(v) && Math.abs(v) < 10),
    String(x),
  );
  assert.equal(
    E.pick([0, 1], () => 0),
    1,
  ); // u = 0 used to pick the zero weight
  assert.equal(
    E.pick([1, 0, 0], () => 0.9999),
    0,
  );
  assert.equal(
    E.pick([0, NaN, -1, 2], () => 0.5),
    3,
  );
  assert.equal(
    E.pick([0, 0, 0, 0], () => 0.6),
    2,
  ); // none positive: equally likely
  E.withSettings({ "SIM.drvSd": 0, "SIM.teamSd": 0 }, () =>
    assert.deepEqual(E.expectedPositions([0, 0, 1], ["A", "B", "C"], 0), [1.5, 1.5, 3]),
  );
  assert.throws(() => E.simulate(toyModel(), circuit, false, 0, 1), RangeError);
  assert.throws(() => E.simulate(toyModel(), circuit, false, 10.5, 1), RangeError);
});

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

test("simulate: the safety-car rate matches the circuit's, with and without multi-car incidents", () => {
  // the reviewer's fixture (2026-09-27): 22 cars at 10% retirement risk, 15% of retirements bring out a safety car,
  // target 50%. The old (1 - q)^E[N] made 48.7%.
  const m = toyModel();
  m.drivers.forEach((d) => (d.dnf = 0.1));
  const c = { ...circuit, rain: {}, sc: 0.5 };
  for (const inc of [0, 0.15, 0.5]) {
    const sim = E.withSettings({ "SIM.incident": inc }, () => E.simulate(m, c, false, 40000, 7, { unc: 0 }));
    assert.ok(Math.abs(sim.sc - 0.5) < 0.012, `incident share ${inc}: safety car ${sim.sc}`);
    assert.equal(sim.scOver, 0);
  }
  // a target below what retirements alone make can't be met: counted, not hidden
  const low = E.withSettings({ "SIM.incident": 0.15 }, () =>
    E.simulate(m, { ...c, sc: 0.1 }, false, 4000, 7, { unc: 0 }),
  );
  assert.ok(low.scOver > 0.9 && low.sc > 0.25, `${low.scOver} ${low.sc}`); // 1 - E[0.85^N] = 28%
});

test("simulate: a retired car keeps the overtakes it made before stopping; one that didn't start has none", () => {
  const m = toyModel();
  m.drivers.forEach((d) => (d.dnf = 1)); // capped at 90%: nearly every car retires
  const c = { ...circuit, rain: {} };
  const ov = (ovRet) => {
    const sim = E.simulate({ ...m, ovRet }, c, false, 4000, 3, { unc: 0 });
    return sim.stats.slice(0, m.drivers.length).reduce((s, st) => s + st.xov, 0) / m.drivers.length;
  };
  const none = ov({ b: 0, phi: 0.3, share: [-1] }), // every retirement a non-starter: only the finishers pass
    half = ov({ b: 0, phi: 0, share: [0.5] }),
    full = ov({ b: 0, phi: 0, share: [1] }),
    start = ov({ b: 0, phi: 1, share: [0] }); // phi = 1: all of them, however early it stopped
  assert.ok(none < 1, `non-starters ${none}`); // the 10% that finish
  assert.ok(half > none + 0.5 && full > 1.7 * half - none, `${none} ${half} ${full}`);
  assert.ok(Math.abs(start - full) < 0.15, `${start} ${full}`);
  // with the old behaviour (no retirement overtakes) it matches the non-starters
  assert.ok(Math.abs(ov(undefined) - none) < 0.15);
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

test("simulate: a scored sprint and qualifying count as they are, whatever the seed", () => {
  const m = toyModel();
  const ids = m.drivers.map((d) => d.id);
  const s = Object.fromEntries(ids.map((id, i) => [id, [i % 5 === 0 ? -10 : 8 - (i % 9), i % 5 === 0 ? -10 : 0]]));
  const q = Object.fromEntries(ids.map((id, i) => [id, [i < 10 ? 10 - i : i === 21 ? -5 : 0, i === 21 ? -5 : 0]]));
  // constructors: their drivers' points, qualifying with its bonus (+10, +5, +3, +1 or -1)
  for (const c of m.cons) {
    const mine = ids.filter((id, i) => m.drivers[i].team === c.team);
    s[c.id] = [mine.reduce((t, id) => t + s[id][0], 0), mine.reduce((t, id) => t + s[id][1], 0)];
    q[c.id] = [mine.reduce((t, id) => t + q[id][0], 0) + 3, mine.reduce((t, id) => t + q[id][1], 0)];
  }
  const locked = { q, s };
  const known = { q: m.drivers.map((d) => d.tla) };
  const a = E.simulate(m, circuit, true, 500, 1, { locked, known }),
    b = E.simulate(m, circuit, true, 500, 99, { locked, known });
  a.stats.slice(0, ids.length).forEach((st, i) => {
    assert.equal(st.cat.sprint, s[ids[i]][0]);
    assert.equal(st.cat.q, q[ids[i]][0]);
    assert.equal(b.stats[i].cat.sprint, s[ids[i]][0]);
  });
  // a point more in the scored sprint is a point more for the driver and his constructor in every sample
  const s2 = { ...s, [ids[3]]: [s[ids[3]][0] + 1, 0], [m.cons[1].id]: [s[m.cons[1].id][0] + 1, s[m.cons[1].id][1]] };
  const c = E.simulate(m, circuit, true, 500, 1, { locked: { q, s: s2 }, known });
  const k = ids.length + 1;
  for (let n = 0; n < 500; n++) {
    assert.equal(c.tot[3 * 500 + n] - a.tot[3 * 500 + n], 1);
    assert.equal(c.tot[k * 500 + n] - a.tot[k * 500 + n], 1);
  }
  // the constructor's qualifying bonus comes through: its total less its drivers' is the same fixed +3 plus race
  assert.ok(a.stats[ids.length].mean > 0);
});

test("simulate: a run-but-unscored sprint uses its classification: a car in the order can still not classify", () => {
  const m = toyModel();
  const order = m.drivers.map((d) => d.tla);
  const known = { s: order, sq: order };
  const plain = E.simulate(m, circuit, true, 400, 5, { known });
  const dnf = E.simulate(m, circuit, true, 400, 5, { known, status: { s: { D00: "dnf" } } });
  assert.ok(plain.stats[0].cat.sprint > 5); // first in the order: 8 points
  assert.ok(dnf.stats[0].cat.sprint < -9); // not classified: -10 (and its overtakes)
  // the sprint's fastest lap is known once it's run: +5 to that driver in every sample, none drawn for others
  const fl = E.simulate(m, circuit, true, 400, 5, { known, fl: { s: "D51" } });
  const at = (sim, id) => sim.stats[sim.ids.indexOf(id)].cat.sprint;
  assert.ok(at(fl, "D51") - at(plain, "D51") > 4.5, `${at(fl, "D51")} vs ${at(plain, "D51")}`);
});

test("scoredSessions: a session counts once it ended before the feed and every racing asset has its points", () => {
  const g = {
    gd: 16,
    sessions: [
      { type: "Sprint Qualifying", end: "2026-10-10T10:00:00Z" },
      { type: "Qualifying", end: "2026-10-10T14:00:00Z" },
    ],
  };
  const evNames = [
    { c: "Q POS", s: "Q" },
    { c: "S NC", s: "S" },
    { c: "S POS", s: "S" },
  ];
  const live = (feedTime, sess2) => ({
    gd: 16,
    feedTime,
    assets: {
      1: {
        act: true,
        sess: { "Sprint Qualifying": -10, Qualifying: 3 },
        ev: [
          [1, -10],
          [0, 3],
        ],
      },
      2: { act: true, sess: sess2, ev: [[2, 8]] },
      3: { act: false, sess: {} },
    },
  });
  const both = E.scoredSessions(
    { evNames, live: live("2026-10-10T15:00:00Z", { "Sprint Qualifying": 8, Qualifying: 0 }) },
    g,
  );
  assert.deepEqual(both.s, { 1: [-10, -10], 2: [8, 0] });
  assert.deepEqual(both.q, { 1: [3, 0], 2: [0, 0] });
  // before qualifying ended, or while an asset has no qualifying points yet: only the sprint
  const early = E.scoredSessions({ evNames, live: live("2026-10-10T13:00:00Z", { "Sprint Qualifying": 8 }) }, g);
  assert.deepEqual(Object.keys(early), ["s"]);
  const missing = E.scoredSessions({ evNames, live: live("2026-10-10T15:00:00Z", { "Sprint Qualifying": 8 }) }, g);
  assert.deepEqual(Object.keys(missing), ["s"]);
  // another gameday's feed: nothing
  assert.deepEqual(E.scoredSessions({ evNames, live: { ...live("2026-10-10T15:00:00Z", {}), gd: 15 } }, g), {});
});

test("oddsKnown: the qualifying order conditions the market only if the quote came after qualifying", () => {
  const g = { gd: 16, sessions: [{ type: "Qualifying", end: "2026-10-03T09:00:00Z" }] };
  const simOpt = { pen: { VER: 5 }, known: { q: ["NOR"], sq: ["PIA"] } };
  assert.deepEqual(E.oddsKnown(simOpt, { at: "2026-10-03T10:00+00:00" }, g), {
    pen: { VER: 5 },
    known: { q: ["NOR"] },
  });
  assert.deepEqual(E.oddsKnown(simOpt, { at: "2026-10-03T08:00+00:00" }, g), { pen: { VER: 5 }, known: {} });
  assert.deepEqual(E.oddsKnown(simOpt, {}, g), { pen: { VER: 5 }, known: {} });
  // a penalty race control announced after the quote: the market didn't know it (a hand-set one always counts)
  const penAt = { VER: "2026-10-03T09:30+00:00" };
  assert.deepEqual(E.oddsKnown(simOpt, { at: "2026-10-03T08:00+00:00" }, g, { penAt }), { pen: {}, known: {} });
  assert.deepEqual(E.oddsKnown(simOpt, { at: "2026-10-03T10:00+00:00" }, g, { penAt }).pen, { VER: 5 });
  // a quote of unknown time: nothing dated counts as known (third review)
  assert.deepEqual(E.oddsKnown(simOpt, {}, g, { penAt }).pen, {});
  // an accumulated penalty: each part by its own time (10 before the quote, 5 after)
  const acc = { ...simOpt, pen: { VER: 15 } };
  const penParts = {
    VER: [
      [10, "2026-10-02T12:00+00:00"],
      [5, "2026-10-03T09:30+00:00"],
    ],
  };
  assert.deepEqual(E.oddsKnown(acc, { at: "2026-10-03T08:00+00:00" }, g, { penAt, penParts }).pen, { VER: 10 });
  assert.deepEqual(E.oddsKnown(acc, { at: "2026-10-03T10:00+00:00" }, g, { penAt, penParts }).pen, { VER: 15 });
});

test("simulate: the weekend's weather is one regime: marginals as forecast, sessions wet together", () => {
  const m = toyModel();
  const run = (rain) => E.simulate(m, { ...circuit, rain }, false, 40000, 2, { unc: 0 });
  for (const rho of [-0.4, 0, 0.6]) {
    const sim = run({ q: 0.4, r: 0.5, s: 0.5, rho });
    assert.ok(Math.abs(sim.wetQ - 0.4) < 0.01 && Math.abs(sim.wet - 0.5) < 0.01, `${sim.wetQ} ${sim.wet}`);
    const want = E.biNormCdf(E.normInv(0.4), E.normInv(0.5), rho);
    assert.ok(Math.abs(sim.wetQR - want) < 0.01, `rho ${rho}: ${sim.wetQR} vs ${want}`);
  }
  // pulling apart: the review's fixture (both 50%, rho -0.4: 18.45% together, not the independent 25%)
  const apart = run({ q: 0.5, r: 0.5, s: 0.5, rho: -0.4 });
  assert.ok(Math.abs(apart.wetQR - 0.1845) < 0.008, `${apart.wetQR}`);
  // the ensemble's joint wet share back as a correlation
  assert.ok(Math.abs(E.latentCorr(0.4, 0.5, E.biNormCdf(E.normInv(0.4), E.normInv(0.5), 0.6)) - 0.6) < 0.02);
  const c = E.withWeather({ ...circuit, rain: {} }, { q: 0.4, r: 0.5, ens: { q: 0.4, r: 0.5, qr: 0.2 } });
  assert.ok(Math.abs(c.rain.rho) < 0.03); // 0.4 x 0.5: independent
});

test("simulate: team-mates keep their own retirement chances, whichever comes first", () => {
  // the review's fixture (2026-09-27, second round): 1% and 80% used to become both drivers' 1% or 80% by order
  const dry = { ...circuit, rain: { q: 0, s: 0, r: 0 } };
  for (const unc of [0, 1]) {
    const m = toyModel();
    m.drivers[10].dnf = 0.01;
    m.drivers[11].dnf = 0.8;
    const rev = { ...m, drivers: [...m.drivers].reverse() };
    const run = (mm) => {
      const sim = E.withSettings({ "SIM.incident": 0 }, () => E.simulate(mm, dry, false, 20000, 5, { unc }));
      return (id) => sim.stats[sim.ids.indexOf(id)].dnf;
    };
    for (const dnf of [run(m), run(rev)]) {
      const lo = dnf("D50"),
        hi = dnf("D51");
      assert.ok(Math.abs(lo - 0.01) < 0.006 && Math.abs(hi - 0.8) < 0.015, `${unc}: ${lo} ${hi}`);
    }
  }
});

test("simulate: reliability uncertainty fades smoothly to none (no jump just above 0)", () => {
  const m = toyModel();
  const dry = { ...circuit, rain: { q: 0, s: 0, r: 0 } };
  const sd = (unc) => {
    const st = E.simulate(m, dry, false, 3000, 3, { unc }).stats.slice(0, m.drivers.length);
    return st.reduce((a, x) => a + x.sd, 0) / st.length;
  };
  const [s0, s1, sBig] = [sd(0), sd(0.02), sd(1)];
  assert.ok(Math.abs(s1 - s0) < 0.35 * Math.abs(sBig - s0) + 0.2, `${s0} ${s1} ${sBig}`);
});

test("simulate: the race's fastest-stop bonus goes to one team a race, among the best stop bands", () => {
  const m = toyModel();
  m.cons.forEach((c, k) =>
    Object.assign(c, { stops: [7, 7, 7], bands: k === 0 ? [10, 10, 10] : [2, 2, 2], bonusW: 1 }),
  );
  const sim = E.simulate(m, circuit, false, 2000, 1);
  const pit = sim.stats.slice(m.drivers.length).map((st) => st.pit);
  assert.equal(pit[0], 15); // the best band every time: the +5 every time
  assert.ok(pit.slice(1).every((v) => v === 2));
  // all on the same band: exactly one +5 a race, shared by the bonus weights
  m.cons.forEach((c, k) => Object.assign(c, { bands: [5, 5, 5], bonusW: k === 1 ? 9 : 0.1 }));
  const even = E.simulate(m, circuit, false, 4000, 1).stats.slice(m.drivers.length);
  assert.ok(Math.abs(even.reduce((a, st) => a + st.pit, 0) - (5 * m.cons.length + 5)) < 1e-9);
  assert.ok(even[1].pit > 8.5);
  // the review's edges: every band 0 (all stops slow) still has one fastest stop; a team with too few races of
  // bands draws from the field's, and the race still has exactly one bonus
  m.cons.forEach((c) => Object.assign(c, { bands: [0, 0, 0], bonusW: 1 }));
  const slow = E.simulate(m, circuit, false, 1000, 1).stats.slice(m.drivers.length);
  assert.ok(Math.abs(slow.reduce((a, st) => a + st.pit, 0) - 5) < 1e-9);
  m.cons.forEach((c, k) => Object.assign(c, { bands: k === 0 ? [6] : [2, 4, 6] }));
  const thin = E.simulate(m, circuit, false, 1000, 1).stats.slice(m.drivers.length);
  assert.ok(Math.abs(thin.reduce((a, st) => a + st.pit, 0) - (4 * m.cons.length + 5)) < 0.6);
});

test("simulate: with a persist seed, races share each sample's car strength (the horizon keeps its uncertainty)", () => {
  const m = toyModel();
  m.drivers.forEach((d) => (d.qSe = d.rSe = 1)); // big pace uncertainty: it dominates a driver's weekend
  const race = (seed, persist) => E.simulate(m, circuit, false, 3000, seed, { persist });
  const corr = (a, b, i, N) => {
    const x = a.tot.subarray(i * N, (i + 1) * N),
      y = b.tot.subarray(i * N, (i + 1) * N);
    const mx = x.reduce((u, v) => u + v, 0) / N,
      my = y.reduce((u, v) => u + v, 0) / N;
    let sxy = 0,
      sxx = 0,
      syy = 0;
    for (let k = 0; k < N; k++) {
      sxy += (x[k] - mx) * (y[k] - my);
      sxx += (x[k] - mx) ** 2;
      syy += (y[k] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  };
  const shared = corr(race(1, 77), race(2, 77), 5, 3000),
    apart = corr(race(1, 0), race(2, 0), 5, 3000);
  assert.ok(shared > 0.2 && Math.abs(apart) < 0.06, `${shared} vs ${apart}`);
  // the stream of sample s doesn't depend on how many samples run
  const a = race(3, 5),
    b = E.simulate(m, circuit, false, 1000, 3, { persist: 5 });
  for (let k = 0; k < 1000; k++) assert.equal(a.tot[k], b.tot[k]);
});

test("pricePath: the price carried race to race on the races in each one's last three rounds", () => {
  const a = {
    price: 10,
    hist: [
      { gd: 1, pts: 12, active: true },
      { gd: 2, pts: 0, active: false },
    ],
  };
  // after R2: the next race averages R1 (12) with its own points; R2 was sat out (not a zero)
  const one = (x) => E.pricePath(a, [1, 2], [[x], [x], [x]]);
  const p = one(12);
  // 1.2 pts per $m: the big rise; then 12 / 10.6 and 12 / 10.8 are just rises (the price catches up)
  assert.deepEqual(
    p.d.map((v) => Math.round(v * 10) / 10),
    [0.6, 0.2, 0.2],
  );
  assert.equal(Math.round(p.cum * 10) / 10, 1);
  const q = one(0);
  // (12 + 0) / 2 = 0.6 per $m: under 0.605, the big drop; then nothing: big drops
  assert.deepEqual(
    q.d.map((v) => Math.round(v * 10) / 10),
    [-0.6, -0.6, -0.6],
  );
});

test("simulate: the official race grid, once published, is the race's grid (penalties already in it)", () => {
  const m = toyModel();
  const order = m.drivers.map((d) => d.tla);
  const race = order.slice(1).concat(order[0]); // the fastest car starts last (a pit-lane start, say)
  const a = E.simulate(m, circuit, false, 3000, 4, { known: { q: order, race }, pen: { D00: 5 } });
  const b = E.simulate(m, circuit, false, 3000, 4, { known: { q: order }, pen: { D00: 5 } });
  // from the back it gains more places than from 6th on the grid
  assert.ok(a.stats[0].cat.gain > b.stats[0].cat.gain + 3, `${a.stats[0].cat.gain} vs ${b.stats[0].cat.gain}`);
});

test("simulate: team-mates share their weekend form (it widens a constructor's range)", () => {
  const m = toyModel(),
    c = m.drivers.length + 5; // a midfield constructor
  const sd = (teamSd) =>
    E.withSettings({ "SIM.teamSd": teamSd }, () => E.simulate(m, circuit, false, 6000, 4).stats[c].sd);
  const flat = sd(0),
    shared = sd(0.4);
  assert.ok(shared > flat * 1.1, `constructor spread ${flat.toFixed(2)} -> ${shared.toFixed(2)}`);
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
  // with quote quality on, a wide spread on the favourite's lines pulls its pace less
  const wide = { ...odds, spread: { win: { [favourite]: 0.2 }, top10: { [favourite]: 0.5 } } };
  const pull = (set) =>
    Math.abs(E.withSettings(set, () => E.applyOdds(m, circuit, wide, { w: 1, n: 1500 })).drivers[i].oddsR);
  assert.ok(pull({ "SIM.oddsQuality": 1 }) < 0.8 * pull({}), `${pull({ "SIM.oddsQuality": 1 })} vs ${pull({})}`);
});

test("applyOdds after qualifying: the known grid explains the market, not a slower car", () => {
  // the fastest car qualified last; the market prices that in. Matched against a sim that doesn't know the grid,
  // its pace had to drop 0.74%; matched against the known grid it stays put.
  const m = toyModel();
  const q = m.drivers
    .map((d) => d.tla)
    .slice(1)
    .concat("D00");
  const simOpt = { known: { q } };
  const sim = E.simulate(m, circuit, false, 20000, 1, simOpt);
  const odds = { win: {}, podium: {}, top10: {} };
  sim.stats.slice(0, m.drivers.length).forEach((st, i) => {
    const t = m.drivers[i].tla;
    odds.win[t] = st.r[0];
    odds.podium[t] = st.r[0] + st.r[1] + st.r[2];
    odds.top10[t] = st.r.slice(0, 10).reduce((a, b) => a + b, 0);
  });
  const known = E.applyOdds(m, circuit, odds, { w: 1, simOpt });
  const blind = E.applyOdds(m, circuit, odds, { w: 1 });
  assert.ok(Math.max(...known.drivers.map((d) => Math.abs(d.oddsR))) < 0.05);
  assert.ok(
    known.drivers.every((d) => d.oddsQ === 0),
    "qualifying is settled: its pace doesn't move",
  );
  assert.ok(blind.drivers[0].oddsR > 0.4);
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

test("planHorizon: a price change carries through every later race, and only held assets move the budget", () => {
  const mk = (vals) =>
    Object.entries(vals).map(([id, e]) => ({
      id,
      kind: id[0] === "K" ? "C" : "D",
      price: 10,
      e,
      boostE: id[0] === "K" ? 0 : e,
      active: true,
    }));
  // a $70m team (reviewer's example, 2026-09-27): a rises $0.6m after race 1; nothing is simulated after that
  const r = { a: 20, b: 20, c: 20, d: 20, e: 20, KA: 10, KB: 10, f: 1, KC: 1 };
  const team = ["a", "b", "c", "d", "e", "KA", "KB"];
  const o = { cap: 70, free: 0, maxT: 0, chip: "", locks: new Set(), bans: new Set() };
  const stages = [{ cand: mk(r), dPrice: { a: 0.6, f: 3 } }, { cand: mk(r) }, { cand: mk(r) }];
  const [best] = E.planHorizon(stages, team, o);
  const cost = best.steps.map((s) => Math.round(s.cost * 10) / 10);
  const cap = best.steps.map((s) => Math.round(s.cap * 10) / 10);
  assert.deepEqual(cost, [70, 70.6, 70.6]); // the rise stays in the team's value in race 3
  assert.deepEqual(cap, [70, 70.6, 70.6]); // f's rise (not held) adds nothing
});

test("planHorizon: each plan is checked against the sampled price paths (afford)", () => {
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
  const o = { cap: 70, free: 0, maxT: 7, chip: "", locks: new Set(), bans: new Set() };
  // f rises $0.6m after race 1 in half the futures (tenths, race k's sample s at k * N + s): then e -> f is $0.6m
  // over budget; e's price moves with it in none
  const N = 4,
    f = new Int8Array(3 * N);
  f.set([6, 6, 0, 0]);
  const run = (steps) => E.planHorizon([{ cand: mk(r1) }, { cand: mk(r2) }], team, { ...o, ...steps });
  // without the paths: keep for race 1, then e -> f for free (320)
  const [plain] = run({});
  assert.equal(Math.round(plain.total), 320);
  assert.equal(plain.afford, undefined);
  // f never rises: the same plan, affordable in every future
  const [calm] = run({ priceSteps: { f: new Int8Array(3 * N) }, priceN: N });
  assert.equal(Math.round(calm.total), 320);
  assert.equal(calm.afford, 1);
  // f rises in half the futures: that plan fits only half the time and drops below the plans that fit
  const risky = run({ priceSteps: { f }, priceN: N });
  assert.ok(risky[0].afford >= 0.9 && risky[0].total < 320);
  const wait = risky.find((p) => !p.steps[0].team.includes("f") && p.steps[1].team.includes("f"));
  assert.ok(!wait || wait.afford === 0.5);
});

test("simulate: no qualifying time costs -5 in the dry, nothing in the wet", () => {
  const m = toyModel();
  // nobody sets a time
  const run = (q) =>
    E.withSettings({ "SIM.qualiNoTime": 1 }, () =>
      E.simulate(m, { ...circuit, rain: { q, s: 0, r: 0 } }, false, 200, 1),
    );
  assert.equal(run(0).stats[0].cat.q, -5);
  assert.equal(run(1).stats[0].cat.q, 0);
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

test("bandShift: a team that loses time in fast corners is slower where the practice lap has more of them", () => {
  const Q = (a, b) => ({
    share: [0.2, 0.2, 0.2, 0.4],
    teams: { A: { gap: 1, band: [1, 1, 1 + a, 1] }, B: { gap: 1, band: [1, 1, 1 + b, 1] } },
  });
  const bands = {
    1: { Q: Q(1, -1), FP: { share: [0.2, 0.2, 0.2, 0.4] } },
    2: { Q: Q(1, -1), FP: { share: [0.2, 0.2, 0.2, 0.4] } },
    3: { Q: Q(1, -1), FP: { share: [0.2, 0.2, 0.2, 0.4] } },
    4: { FP: { share: [0.1, 0.1, 0.4, 0.4] } }, // next: twice the fast-corner share
  };
  const data = { schedule: [], done: [1, 2, 3], assets: [], results: { race: {}, quali: {}, sprint: {} }, bands };
  const sh = E.bandShift(data, { gd: 4, name: "x", sprint: false, lock: "" });
  // +0.2 share x (3 rounds of +1 / (3 + 3 pseudo-rounds)) = +0.1% for A (slower), -0.1% for B
  assert.ok(Math.abs(sh.A - 0.1) < 1e-9 && Math.abs(sh.B + 0.1) < 1e-9, JSON.stringify(sh));
  // no practice shares for the next track, or too few earlier rounds with them: no shift
  assert.equal(
    E.bandShift({ ...data, bands: { ...bands, 4: {} } }, { gd: 4, name: "x", sprint: false, lock: "" }),
    null,
  );
  assert.equal(E.bandShift({ ...data, done: [1, 2] }, { gd: 3, name: "x", sprint: false, lock: "" }), null);
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
  const passes = new Float64Array(n);
  E.withSettings({ "SIM.yoyo": 0 }, () => {
    assert.deepEqual(E.raceSegs(o, r, passes), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(
      passes.reduce((a, b) => a + b, 0),
      0,
    );
  });
  // every close pair swaps and swaps back each segment
  E.withSettings({ "SIM.yoyo": 1 }, () => {
    assert.deepEqual(E.raceSegs(o, r, passes), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(passes.filter((v) => v > 0).length >= 2); // both cars of a swap are credited
    assert.equal(passes.reduce((a, b) => a + b, 0) % 2, 0); // they come in pairs
  });
});

test("simulate: the lap-by-lap race makes the circuit's overtake level", () => {
  E.withSettings({ "SIM.raceModel": "laps" }, () => {
    const m = toyModel();
    for (const ov of [0.5, 1.5]) {
      const c = { ...circuit, ov, laps: 50, lapT: 90 };
      const sim = E.simulate(m, c, false, 1500, 3);
      const got = sim.stats.slice(0, m.drivers.length).reduce((a, s) => a + s.cat.ovt, 0) / m.drivers.length;
      assert.ok(Math.abs(got / (4 * ov) - 1) < 0.12, `level ${4 * ov}: simulated ${got}`);
    }
  });
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
