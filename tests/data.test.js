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
    for (let k = 2; k < h.length; k++) {
      // rounds where the asset raced and has three rounds of points (inactive assets keep their price)
      if (!h[k] || !h[k].active || !h[k - 1] || !h[k - 2]) continue;
      // the current price is the next round's, unless F1 hasn't published that yet (right after a race)
      const next = k + 1 < h.length ? h[k + 1] : D.pricesPending ? null : { price: a.price };
      if (!next) continue;
      const avg = (h[k].pts + h[k - 1].pts + h[k - 2].pts) / 3;
      const pred = Math.round((h[k].price + E.priceStep(h[k].price, avg)) * 10) / 10;
      n++;
      if (Math.abs(pred - next.price) < 0.05) ok++;
    }
  }
  assert.ok(n > 50, `enough price changes to test (${n})`);
  assert.ok(ok / n >= 0.97, `rule matches ${ok}/${n} real changes`);
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

test("a finished season projects nothing and still models", opt, () => {
  const over = { ...D, schedule: D.schedule.filter((g) => D.done.includes(g.gd)) };
  assert.equal(E.project(over), null);
  assert.ok(E.trackModel(over).forCircuit(over.schedule[0].name));
});
