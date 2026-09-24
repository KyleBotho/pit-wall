// Backtests behind the model settings in engine.js (MODEL, SIM, TRACK). Run:  npm run backtest
// Needs cache/data.json (python refresh.py) and, for the practice section, backtest/practice_by_round.json
// (python backtest/practice_rounds.py). Every section walks through the season using only what was known before
// each round (except the season-total overtake points and constructor pit history, a small look-ahead).
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");
const { loadData } = require("../tests/helpers.js");

const D = loadData();
if (!D) throw new Error("no cache/data.json: run python refresh.py first");
const PRACTICE_FILE = path.join(__dirname, "practice_by_round.json");
const PRACTICE = fs.existsSync(PRACTICE_FILE) ? JSON.parse(fs.readFileSync(PRACTICE_FILE, "utf8")) : {};
const nameOf = Object.fromEntries(D.schedule.map((g) => [g.gd, g.name]));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const table = (rows) => console.table(rows);

// the data as it stood before round r
function asOf(r, drop = []) {
  const keep = (g) => g < r && !drop.includes(g);
  const cut = (obj) => Object.fromEntries(Object.entries(obj).filter(([g]) => keep(+g)));
  return {
    ...D,
    done: D.done.filter(keep),
    results: { race: cut(D.results.race), quali: cut(D.results.quali), sprint: cut(D.results.sprint) },
    trackStats: cut(D.trackStats || {}),
    practice: [],
  };
}
const rounds = D.done.slice();
const last = rounds[rounds.length - 1] + 1;

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
    "\n2. Track model, leave-one-round-out (mean absolute error; better = vs a flat average of the other rounds)",
  );
  const withStats = rounds.filter((g) => D.trackStats && D.trackStats[g]);
  const dnfCount = (g) => (D.results.race[g] || []).filter((x) => !x.cls).length;
  const out = [];
  for (const lam of [0.25, 0.5, 1, 2, 4, 8]) {
    const e = { ov: [], ovFlat: [], dnf: [], dnfFlat: [], team: [], teamFlat: [] };
    for (const r of withStats) {
      const Dm = asOf(last, [r]);
      const tm = E.trackModel(Dm, { ovLambda: lam, dnfLambda: lam, teamLambda: lam, teamPace: true });
      if (!tm.fitted) continue;
      const c = tm.forCircuit(nameOf[r]);
      e.ov.push(Math.abs(c.ov * tm.ovMean - D.trackStats[r].ovt));
      e.ovFlat.push(Math.abs(tm.ovMean - D.trackStats[r].ovt));
      e.dnf.push(Math.abs(c.chaos * tm.dnfMean - dnfCount(r)));
      e.dnfFlat.push(Math.abs(tm.dnfMean - dnfCount(r)));
      // team pace: a team's average qualifying slot vs its average over the other rounds, shifted by the track
      for (const [team, shift] of Object.entries(c.teamShift)) {
        const other = Object.entries(Dm.results.quali).flatMap(([, rows]) =>
          rows.filter((x) => x.team === team).map((x) => x.pos),
        );
        const here = (D.results.quali[r] || []).filter((x) => x.team === team).map((x) => x.pos);
        if (!other.length || !here.length) continue;
        e.team.push(Math.abs(mean(other) + shift - mean(here)));
        e.teamFlat.push(Math.abs(mean(other) - mean(here)));
      }
    }
    out.push({
      lambda: lam,
      "overtakes: better": pct(mean(e.ov), mean(e.ovFlat)),
      "retirements: better": pct(mean(e.dnf), mean(e.dnfFlat)),
      "team pace: better": pct(mean(e.team), mean(e.teamFlat)),
    });
  }
  table(out);
  console.log(
    `   in use: overtakes λ=${E.TRACK.ovLambda}, retirements λ=${E.TRACK.dnfLambda}, team pace ${E.TRACK.teamPace ? "λ=" + E.TRACK.teamLambda : "off"}`,
  );
}

/* ---------- 3. retirements: recency and shrinkage ---------- */
function retirements() {
  console.log("\n3. Retirement rate, walk-forward from R4 (log loss per car-race; lower is better)");
  const from = rounds.filter((g) => g >= 4);
  const out = [];
  for (const hl of [2, 4, 6, 10, 1000])
    for (const k of [0, 2, 4, 8, 16]) {
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
  table(out.slice(0, 8));
  console.log(
    `   in use: half-life ${Number.isFinite(E.MODEL.dnfHalfLife) ? E.MODEL.dnfHalfLife : "none"}, shrink ${E.MODEL.dnfShrink}`,
  );
}

/* ---------- 4. practice weights ---------- */
function practiceWeights() {
  const rs = rounds.filter((g) => g >= 4 && PRACTICE[g] && PRACTICE[g].some((s) => s.done));
  if (!rs.length)
    return console.log(
      "\n4. Practice weights: no backtest/practice_by_round.json (python backtest/practice_rounds.py)",
    );
  console.log(
    `\n4. Practice weights, walk-forward on R${rs[0]}-R${rs[rs.length - 1]} (${rs.length} rounds; mean absolute error in places)`,
  );
  const run = (model, pick, actual) => {
    const err = [];
    for (const r of rs) {
      const Dr = asOf(r),
        c = E.trackModel(Dr).forCircuit(nameOf[r]);
      const m = E.buildModel(Dr, { practice: PRACTICE[r], teamShift: c.teamShift, model });
      for (const [tla, pos] of actual(r)) {
        const d = m.drivers.find((x) => x.tla === tla);
        if (d) err.push(Math.abs(pick(d) - pos));
      }
    }
    return mean(err);
  };
  const quali = (r) => (D.results.quali[r] || []).map((x) => [x.tla, x.pos]);
  // classified finishers, rank rescaled to a full field like the model's race pace
  const race = (r) => {
    const rows = (D.results.race[r] || []).filter((x) => x.cls);
    return rows.map((x) => [x.tla, ((x.pos - 0.5) / rows.length) * (D.cfg.field || 22) + 0.5]);
  };
  const q = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7].map((w) => ({
    "short-run weight": w,
    "quali MAE": +run({ practiceQ: w }, (d) => d.qMu, quali).toFixed(3),
  }));
  table(q);
  const rr = [0, 0.05, 0.1, 0.2, 0.3].map((w) => ({
    "long-run weight": w,
    "race MAE": +run({ practiceR: w }, (d) => d.rMu, race).toFixed(3),
  }));
  table(rr);
  const cap = [2, 4, 6, 10, 99].map((c) => ({
    "pull cap": c === 99 ? "none" : c,
    "quali MAE": +run({ practicePull: c }, (d) => d.qMu, quali).toFixed(3),
  }));
  table(cap);
  console.log(`   in use: short-run ${E.MODEL.practiceQ}, long-run ${E.MODEL.practiceR}, cap ${E.MODEL.practicePull}`);
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
  const tm = E.trackModel(D),
    c = { ...tm.forCircuit("neutral"), ov: 1, chaos: 1, grid: E.gridFromOv(1) };
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
  // who gets fastest lap and DotD: share going to the seven fastest cars
  const top7 = m.drivers
    .map((d, i) => [d.rMu, i])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 7)
    .map(([, i]) => i);
  const share = (k) => top7.reduce((s, i) => s + sim.stats[i][k], 0);
  console.log(
    `   fastest lap to the 7 fastest cars: ${(100 * share("fl")).toFixed(0)}%, Driver of the Day: ${(100 * share("dotd")).toFixed(0)}%`,
  );
}

prices();
track();
retirements();
practiceWeights();
calibration();
