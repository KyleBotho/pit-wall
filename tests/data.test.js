// Checks against this season's real data (cache/data.json from the last refresh.py run). Skipped if it's missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");
const { loadData } = require("./helpers.js");

const D = loadData();
const opt = { skip: D ? false : "no cache/data.json (run python refresh.py first)" };

test("the price rule reproduces this season's price changes", opt, () => {
  let n = 0,
    ok = 0;
  for (const a of D.assets) {
    const h = a.hist;
    for (let k = 0; k < h.length; k++) {
      // rounds the asset raced (inactive assets keep their price)
      if (!h[k] || !h[k].active) continue;
      // the current price is the next round's, unless F1 hasn't published that yet (right after a race)
      const next = k + 1 < h.length ? h[k + 1] : D.pricesPending ? null : { price: a.price };
      if (!next) continue;
      // the rule as the page applies it: the races among the last three rounds (Engine.priceBase)
      const { sum2, n: races } = E.priceBase(
        a,
        D.done.filter((g) => g < h[k].gd),
      );
      const avg = (sum2 + h[k].pts) / races;
      const pred = Math.round((h[k].price + E.priceStep(h[k].price, avg)) * 10) / 10;
      n++;
      if (Math.abs(pred - next.price) < 0.05) ok++;
    }
  }
  assert.ok(n > 50, `enough price changes to test (${n})`);
  assert.ok(ok / n >= 0.99, `rule matches ${ok}/${n} real changes`); // 493/495 after R15
});

test("each round's scoring lines add up to the asset's points", opt, () => {
  let n = 0,
    bad = [];
  for (const a of D.assets)
    for (const h of a.hist) {
      if (!h || !h.ev || !h.ev.length) continue;
      n++;
      const s = h.ev.reduce((t, r) => t + r[1], 0);
      if (Math.abs(s - h.pts) > 0.5) bad.push(`${a.tla || a.team} R${h.gd}: lines ${s} vs ${h.pts}`);
    }
  assert.ok(n > 100);
  assert.ok(bad.length / n < 0.01, bad.slice(0, 5).join("; "));
});

test("retired cars' overtakes: fitted from this season's retirements", opt, () => {
  const m = E.buildModel(D, { halfLife: 4, adj: {}, practice: [], practiceWeight: 1 });
  const unclassified = D.done.flatMap((g) => (D.results.race[g] || []).filter((r) => !r.cls && r.laps != null));
  if (unclassified.length < 15) return;
  assert.equal(m.ovRet.share.length, unclassified.length);
  assert.ok(m.ovRet.share.every((f) => f === -1 || (f >= 0 && f <= 1)));
  assert.ok(m.ovRet.phi > 0 && m.ovRet.phi < 0.8, `phi ${m.ovRet.phi}`); // R1-R15: 0.35
});

test("the live weekend: scored qualifying counts as scored, its order from the scoring lines", opt, () => {
  const gd = D.live && D.live.gd;
  if (!gd || !(D.results.quali[gd] || []).length) return;
  // the data as it stood after qualifying: this round not done, OpenF1's order not in yet
  const Dq = { ...D, done: D.done.filter((g) => g !== gd), weekend: null, odds: null };
  const g = D.schedule.find((x) => x.gd === gd);
  const { simOpt } = E.raceSetup(Dq, g, { next: true });
  assert.ok(simOpt.locked.q, "qualifying scored");
  const jolpica = D.results.quali[gd].map((r) => r.tla);
  assert.deepEqual(simOpt.known.q.slice(0, 10), jolpica.slice(0, 10));
});

test("the projection for the next race is sane", opt, () => {
  const p = E.project(D, { sims: 2000 });
  if (!D.schedule.some((g) => !D.done.includes(g.gd))) return assert.equal(p, null);
  const vals = Object.values(p.assets).map((x) => x.x);
  assert.ok(vals.length >= 30, "every driver and constructor projected");
  vals.forEach((v) => assert.ok(Number.isFinite(v) && v > -30 && v < 120, `projection ${v}`));
  // mean driver projection should sit near this season's average driver round score
  const drv = D.assets.filter((a) => a.kind === "D" && a.active).map((a) => p.assets[a.id].x);
  const hist = D.assets
    .filter((a) => a.kind === "D")
    .flatMap((a) => a.hist.filter((h) => h && h.active).map((h) => h.pts));
  const m = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(m(drv) - m(hist)) < 6, `projected ${m(drv).toFixed(1)} vs actual ${m(hist).toFixed(1)}`);
});

test("a frozen forecast's record reruns to the same samples", opt, () => {
  const p = E.project(D, { detail: true, samples: 500, sims: 2000 });
  if (!p) return;
  // as stored: through JSON, Infinity as a string
  const rec = JSON.parse(JSON.stringify(p.record), (_, v) => (v === "Infinity" ? Infinity : v));
  const { model, circuit, simOpt } = rec.setup;
  const sim = E.simulate(model, circuit, rec.sprint, 2000, rec.seed, simOpt);
  sim.ids.forEach((id, i) => {
    for (let k = 0; k < 500; k++) assert.equal(Math.round(sim.tot[i * 2000 + k]), p.joint.tot[i * 500 + k]);
    const mean = sim.tot.subarray(i * 2000, (i + 1) * 2000).reduce((a, b) => a + b, 0) / 2000;
    assert.equal(Math.round(mean * 10) / 10, p.assets[id].x);
  });
  assert.equal(rec.rng, E.RNG_VERSION);
  assert.equal(p.record.settings.MODEL.dnfHalfLife, "Infinity");
});

test("challengers: every one projects under its own settings, and the shipped ones come back", opt, () => {
  const before = JSON.stringify([E.MODEL, E.SIM, E.TRACK]);
  const c = E.projectChallengers(D, { sims: 1000 });
  if (!c) return;
  assert.deepEqual(
    Object.keys(c),
    E.CHALLENGERS.map((x) => x.id),
  );
  for (const v of Object.values(c)) assert.ok(Object.values(v.assets).every((a) => a.q.length === 19));
  assert.equal(JSON.stringify([E.MODEL, E.SIM, E.TRACK]), before);
  assert.throws(() => E.withSettings({ "SIM.noSuchThing": 1 }, () => 0));
});

test("a finished season projects nothing and still models", opt, () => {
  const over = { ...D, schedule: D.schedule.filter((g) => D.done.includes(g.gd)) };
  assert.equal(E.project(over), null);
  assert.ok(E.trackModel(over).forCircuit(over.schedule[0].name));
});
