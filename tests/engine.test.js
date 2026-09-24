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
    cons.push({ id: "C" + t, team: "T" + t, pitMu: 3, pitSd: 2 });
    for (let k = 0; k < 2; k++)
      drivers.push({
        id: `D${t}${k}`,
        tla: `D${t}${k}`,
        team: "T" + t,
        qMu: 1 + 2 * t + k,
        rMu: 1 + 2 * t + k,
        dnf: 0.08,
        ov: 3,
        practiceQ: null,
        practiceR: null,
        formQ: 0,
        formR: 0,
      });
  }
  return { drivers, cons, gRate: 0.08, field: nTeams * 2 };
}
const circuit = { ov: 1, grid: 0.5, chaos: 1, note: "", feat: [0.5, 0.2, 0.5] };

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
