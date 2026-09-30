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

test("the frozen record draws the page's own samples (the same seeds, persist included)", opt, () => {
  const p = E.project(D, { samples: 300, sims: 1000 });
  if (!p) return;
  const track = E.trackModel(D),
    Df = E.DEFAULTS;
  const next = D.schedule.find((g) => !D.done.includes(g.gd));
  const f = E.forecastRaces(D, {
    setup: (g, k) => ({ next: k === 0, track, halfLife: Df.halfLife, adj: {}, pw: Df.pw, oddsW: Df.oddsW, pen: {} }),
    sprint0: !!next.sprint,
    sims: 1000,
  });
  const sim = f.sims[0];
  sim.ids.forEach((id, i) => {
    for (let k = 0; k < 300; k++) assert.equal(Math.round(sim.tot[i * 1000 + k]), p.joint.tot[i * 300 + k]);
  });
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

test("withSettings: a bad key or value changes nothing; nested calls and throws put everything back", () => {
  const q = E.SIM.qSd,
    m = E.MODEL.racePace;
  assert.throws(() => E.withSettings({ "SIM.qSd": 0.91, "SIM.noSuchThing": 1 }, () => 0));
  assert.throws(() => E.withSettings({ "SIM.qSd": 0.91, "SIM.rSd": "0.3" }, () => 0));
  assert.throws(() => E.withSettings({ "SIM.qSd": NaN }, () => 0));
  assert.throws(() => E.withSettings({ "SIM.qSd": Infinity }, () => 0));
  // a half-life's "no decay" is Infinity (the third review found it rejected)
  assert.equal(
    E.withSettings({ "MODEL.dnfHalfLife": Infinity }, () => E.MODEL.dnfHalfLife),
    Infinity,
  );
  assert.throws(() => E.withSettings({ "MODEL.dnfHalfLife": NaN }, () => 0));
  assert.equal(E.SIM.qSd, q);
  const seen = E.withSettings({ "SIM.qSd": 0.5 }, () =>
    E.withSettings({ "SIM.qSd": 0.7, "MODEL.racePace": "ctx" }, () => [E.SIM.qSd, E.MODEL.racePace]),
  );
  assert.deepEqual(seen, [0.7, "ctx"]);
  assert.throws(() =>
    E.withSettings({ "SIM.qSd": 0.5 }, () => {
      throw new Error("boom");
    }),
  );
  assert.equal(E.SIM.qSd, q);
  assert.equal(E.MODEL.racePace, m);
});

test("batch 3 switches: race pace from the lap model, retirements by cause", opt, () => {
  if (!Object.values(D.raceInfo || {}).some((x) => x.race && x.race.paceCtx)) return;
  const b = (model) => E.buildModel(D, { halfLife: 4, adj: {}, practice: [], practiceWeight: 1, model });
  const med = b({}),
    ctx = b({ racePace: "ctx" });
  assert.ok(
    med.drivers.some((d, i) => Math.abs(d.rPace - ctx.drivers[i].rPace) > 0.01),
    "a different race pace",
  );
  assert.deepEqual(
    med.drivers.map((d) => d.qPace),
    ctx.drivers.map((d) => d.qPace),
  );
  // by cause with the field's incident rate: team-mates still share one rate, about the pooled level
  const cz = b({ dnfModel: "causes", incShrink: 1e6 });
  const mean = (m) => m.drivers.reduce((a, d) => a + d.dnf, 0) / m.drivers.length;
  assert.ok(Math.abs(mean(cz) - mean(med)) < 0.02, `${mean(cz)} vs ${mean(med)}`);
  for (const d of cz.drivers) assert.ok(d.dnf > 0 && d.dnf < 0.5);
});

test("a finished season projects nothing and still models", opt, () => {
  const over = { ...D, schedule: D.schedule.filter((g) => D.done.includes(g.gd)) };
  assert.equal(E.project(over), null);
  assert.ok(E.trackModel(over).forCircuit(over.schedule[0].name));
});

test("the evaluation's input manifest names every data file asOf reads (the accuracy cache key hashes it)", opt, () => {
  const W = require("../backtest/walk.js");
  const names = W.INPUTS.map((p) => p.replace(/\\/g, "/"));
  for (const want of ["weather_by_round.json", "odds_by_round.json", "practice_by_round.json", "/fia", "/projections"])
    assert.ok(
      names.some((n) => n.endsWith(want)),
      want,
    );
});

// Fifth review: a challenger frozen without its own input runs as the shipped model; the freeze says so (coverage,
// sameAsShipped) and marks it not evaluable, so Model health doesn't score it as a test of itself.
test("frozen challengers carry their input coverage; one without its input isn't evaluable", opt, () => {
  const d = structuredClone(D);
  for (const ri of Object.values(d.raceInfo || {}))
    if (ri.race) for (const k of ["pacePool", "paceSePool"]) delete ri.race[k];
  const o = { sims: 400 };
  const champ = E.project(d, { ...o, detail: true });
  if (!champ) return; // season over
  const ch = E.projectChallengers(d, o, champ);
  assert.equal(ch.racepool.coverage.n, 0);
  assert.equal(ch.racepool.sameAsShipped, true);
  assert.equal(ch.racepool.evaluable, false);
  // a challenger that changes a setting everyone has (qualifying skew) is active
  assert.equal(ch.qskew2.coverage, null);
  assert.equal(ch.qskew2.sameAsShipped, false);
  assert.equal(ch.qskew2.evaluable, true);
});

test("skill challengers: only a wet qualifying / a sprint changes anything, and then by about the edge", opt, () => {
  const next = D.schedule.find((g) => !D.done.includes(g.gd));
  if (!next) return;
  const Df = E.DEFAULTS;
  // one mid-field driver with an edge of +1.5 places in both skills
  const ds = D.assets.filter((a) => a.kind === "D" && a.active).sort((a, b) => b.price - a.price);
  const who = ds[Math.floor(ds.length / 2)];
  const data = { ...D, skills: { drivers: { [who.tla]: { wetQ: 1.5, nWetQ: 20, sprR: 1.5, nSprR: 20 } } } };
  const run = (set, rainQ, sprint) =>
    E.withSettings(set, () => {
      const s = E.raceSetup(data, next, {
        next: true,
        halfLife: Df.halfLife,
        pw: Df.pw,
        oddsW: 0,
        circuit: { rain: { q: rainQ, r: 0, s: 0 } },
      });
      return E.simulate(s.model, s.circuit, sprint, 4000, 7, s.simOpt);
    });
  const same = (a, b) => a.tot.every((v, i) => v === b.tot[i]);
  const st = (sim) => sim.stats.find((x) => x.id === who.id);
  const eq = (sim) => st(sim).q.reduce((t, p, i) => t + p * (i + 1), 0);
  assert.ok(same(run({}, 0, false), run({ "SIM.wetSkill": 1, "SIM.sprintSkill": 1 }, 0, false)));
  assert.ok(same(run({}, 1, false), run({ "SIM.sprintSkill": 1 }, 1, false)));
  const moved = eq(run({}, 1, false)) - eq(run({ "SIM.wetSkill": 1 }, 1, false));
  assert.ok(moved > 0.8 && moved < 2.4, `wet qualifying moved ${moved.toFixed(2)} places for an edge of 1.5`);
  const s0 = st(run({}, 0, true)).cat.sprint,
    s1 = st(run({ "SIM.sprintSkill": 1 }, 0, true)).cat.sprint;
  assert.ok(s1 > s0, `sprint points ${s0.toFixed(2)} -> ${s1.toFixed(2)}`);
  // coverage counts the drivers with past sessions
  const c = E.CHALLENGERS.find((x) => x.id === "wetskill").needs(data);
  assert.equal(c.n, 1);
  assert.equal(E.CHALLENGERS.find((x) => x.id === "wetskill").needs(D.skills ? { ...D, skills: null } : D).n, 0);
});
