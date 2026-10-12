// The stats team (user, 2026-10-12: "a team played by the numbers"): a whole season played from R1 the way a real
// manager plays it, every decision made on what was known before that round's lock, scored on the real points.
//   - each round: the data as it stood before the lock (walk.js asOf: results, prices, practice, market, weather at
//     lock), the next three races simulated (Engine.forecastRaces), each asset's price path over them
//     (Engine.pricePath), and the page's race-by-race planner (Engine.planHorizon, plans valued over the simulated
//     futures: Engine.planStoch), from the team held, with its budget and free transfers
//   - the game's rules carry over: $100m at R1, the budget moving with the real price changes of the team held, 2
//     free transfers a race (one unused carries, 3 max; none carried out of a Wildcard or Limitless round), -10 each
//     extra, six chips once each (one a round; Limitless from R2, its team reverting after the race; Final Fix after
//     qualifying, the swap for that race only), the inactive-asset penalty
//   - scored with hindsight.js's rebuild of F1's official round score (checked against real scores)
// A strategy = a budget policy (how much an expected price rise is worth: Calculator's xΔ$Pts, pts per $1m per race
// left) and a chip policy (when to play each chip). Compared with the real global top 10 / 100 / 500 (their season
// totals at the last snapshot: data/elite_history.json; per round R1-R14: data/elite_top100.json, today's top 100).
//
//   node backtest/stats_team.js                  every strategy, R1 to the last certified round
//   ST=points-consensus,budget-afford node ...   only these; ST_N = sims per race (default 3000)
//   --json                                       results as JSON (also written to history/<season>/stats-team.json)
const fs = require("node:fs");
const path = require("node:path");
const W = require("./walk.js");
const { D, E } = W;
const Hind = require("../hindsight.js").create(D, E);

const N = +(process.env.ST_N || 3000);
const HZ = 3; // races the planner looks ahead
const LAST = Math.max(...D.schedule.map((g) => g.gd)); // the season's last round
const certified = D.done.filter((gd) => (D.schedule.find((x) => x.gd === gd) || {}).certified !== false);
const ROUNDS = certified.filter((gd) => D.assets.some((a) => a.hist.some((h) => h && h.gd === gd)));
const byId = Object.fromEntries(D.assets.map((a) => [a.id, a]));
const hist = (id, gd) => byId[id].hist.find((h) => h && h.gd === gd) || null;
const isD = (id) => byId[id] && byId[id].kind === "D";
const CHIPS = ["wildcard", "limitless", "x3", "noneg", "autopilot", "finalfix"];
const r1 = (x) => Math.round(x * 10) / 10;

/* ---------- what was known before each lock ---------- */
const FC = {};
/** Round r's forecast: the next HZ races' simulated weekends and every asset's price path over them. */
function forecastAt(r) {
  if (FC[r]) return FC[r];
  const Dr = W.asOf(r);
  const g = D.schedule.find((x) => x.gd === r);
  const f = E.forecastRaces(Dr, { setup: () => ({}), sprint0: g.sprint, sims: N });
  const sims = f.sims.slice(0, HZ);
  const idx = sims.map((s) => Object.fromEntries(s.ids.map((id, i) => [id, i])));
  const assets = {};
  for (const a of Dr.assets) {
    const i0 = idx[0][a.id];
    if (i0 == null) continue;
    const mean = sims.map((s, k) => (idx[k][a.id] != null ? s.stats[idx[k][a.id]].mean : 0));
    const pts = sims.map((s, k) => {
      const i = idx[k][a.id];
      return i != null ? s.tot.subarray(i * N, (i + 1) * N) : new Float32Array(N);
    });
    assets[a.id] = {
      kind: a.kind,
      price: a.price,
      active: a.kind === "C" || a.active,
      mean,
      nn: sims[0].stats[i0].nnMean,
      path: E.pricePath(a, Dr.done, pts),
    };
  }
  FC[r] = { Dr, g, sims, idx, assets, races: f.races.slice(0, HZ) };
  return FC[r];
}

/** The planner's races for round r, as the Calculator builds them (calc.js planStages): race k's expected points,
 * race 1's plus the price value (xΔ$Pts: the expected price change x valW x the races left), the expected price
 * changes moving the budget for the next race. */
function stagesAt(fc, chip, valW) {
  const rem = Math.max(0, LAST - fc.g.gd);
  const pk = (a, k) => (k === 0 && chip === "noneg" ? a.nn : a.mean[k]);
  const out = [];
  for (let k = 0; k < fc.sims.length; k++) {
    const cand = Object.entries(fc.assets).map(([id, a]) => ({
      id,
      kind: a.kind,
      price: a.price,
      active: a.active,
      e: pk(a, k) + (k === 0 && chip !== "limitless" ? a.path.d[0] * valW * rem : 0),
      x: pk(a, k),
      boostE: a.kind === "D" ? pk(a, k) : 0,
    }));
    out.push({ cand, dPrice: Object.fromEntries(Object.entries(fc.assets).map(([id, a]) => [id, a.path.d[k] || 0])) });
  }
  return out;
}

/** The best plan from the team held, with a chip ("" = none). */
function plan(fc, st, chip, valW) {
  const stages = stagesAt(fc, chip, valW);
  const fresh = !st.team.length;
  // the optimiser knows X3, Wildcard and Limitless; Autopilot and No Negative act in the valuation over the futures
  // (planStoch's chipScore; No Negative's points are its samples)
  const mode = chip;
  const plans = E.planHorizon(stages, st.team, {
    cap: st.budget,
    free: fresh ? 7 : st.free,
    maxT: 7,
    chip: mode,
    locks: new Set(),
    bans: new Set(),
    beam: 10,
    priceSteps: Object.fromEntries(Object.entries(fc.assets).map(([id, a]) => [id, a.path.steps])),
    priceN: N,
    samples: fc.sims.map((s, k) => ({
      tot: k === 0 && chip === "noneg" ? s.nn : s.tot,
      idx: fc.idx[k],
    })),
  });
  return plans[0] || null;
}

/* ---------- Final Fix: after qualifying (and on a sprint weekend the sprint), one driver swapped for the race ---------- */
const RACE_CATS = ["rpos", "gain", "lost", "ovt", "fl", "dotd", "dnf"];
const FF = {};
/** Each driver's projected race-session points once qualifying (and the sprint) are known: the round's setup with the
 * real qualifying / sprint orders. */
function afterQuali(fc) {
  const r = fc.g.gd;
  if (FF[r]) return FF[r];
  const setup = E.raceSetup(fc.Dr, fc.g, { next: true });
  const known = { ...(setup.simOpt.known || {}) };
  const q = (D.results.quali[r] || []).map((x) => x.tla);
  if (q.length) known.q = q;
  const s = (D.results.sprint[r] || []).map((x) => x.tla);
  if (fc.g.sprint && s.length) known.s = s;
  const sim = E.simulate(setup.model, setup.circuit, fc.g.sprint, N, 7919 + r, { ...setup.simOpt, known });
  FF[r] = Object.fromEntries(
    sim.ids.map((id, i) => [id, sim.stats[i].cat ? RACE_CATS.reduce((t, c) => t + sim.stats[i].cat[c], 0) : 0]),
  );
  return FF[r];
}
/** The best single swap for the race (within the budget), its projected gain (x2 in the Boost slot). */
function bestFix(fc, ids, boost, budget) {
  const post = afterQuali(fc);
  const cost = ids.reduce((t, id) => t + fc.assets[id].price, 0);
  let best = null;
  for (const out of ids.filter(isD))
    for (const [id, a] of Object.entries(fc.assets)) {
      if (a.kind !== "D" || !a.active || ids.includes(id)) continue;
      if (cost - fc.assets[out].price + a.price > budget + 1e-6) continue;
      const gain = ((post[id] || 0) - (post[out] || 0)) * (out === boost ? 2 : 1);
      if (!best || gain > best.gain) best = { out, in: id, cat: "R", gain };
    }
  return best;
}

/* ---------- strategies ---------- */
// The real 2026 top 100's most common chip rounds (data/elite_top100.json chipRound, 100 line-ups at R14)
const CONSENSUS = { x3: 2, limitless: 3, wildcard: 5, finalfix: 11, autopilot: 12, noneg: 14 };
// a chip's projected gain over playing none must clear this (points) before the "record" policy plays it
const FLOOR = { wildcard: 15, limitless: 40, x3: 20, noneg: 6, autopilot: 6, finalfix: 12 };
const chipPolicies = {
  none: () => null,
  // the rounds most of the real top 100 played them
  consensus: (r, gains) => {
    const c = Object.keys(CONSENSUS).find((k) => CONSENSUS[k] === r && gains[k] != null);
    return c || null;
  },
  // play a chip when its projected gain is the best it has been (after a first look) and clears the floor; the
  // chip furthest above its own record wins the round; chips left with as many races left are played anyway
  record: (r, gains, st) => {
    let pick = null,
      best = 0;
    const left = CHIPS.filter((c) => !st.used.has(c)).length;
    for (const [c, g] of Object.entries(gains)) {
      if (g == null) continue;
      const seen = st.gains[c] || [];
      const forced = LAST - r + 1 <= left;
      const ok = forced || (seen.length >= 1 && g >= FLOOR[c] && g >= Math.max(...seen));
      const score = g / FLOOR[c];
      if (ok && score > best) ((pick = c), (best = score));
    }
    return pick;
  },
  // play each chip the first round its projected gain clears its floor (the top 100 played early)
  early: (r, gains) => {
    let pick = null,
      best = 0;
    for (const [c, g] of Object.entries(gains))
      if (g != null && g >= FLOOR[c] && g / FLOOR[c] > best) ((pick = c), (best = g / FLOOR[c]));
    return pick;
  },
};
// the budget policy: points one $1m of expected price rise is worth per race left (0 = points only)
const budgetPolicies = {
  points: () => 0,
  budget: () => 1, // the Calculator's default xΔ$Pts weight, all season
  "budget-r8": (r) => (r <= 8 ? 1 : 0),
  // build until the budget buys the best team on projected points (no budget limit: "the 4A line-up"), then points
  "budget-afford": (r, st, fc) => (st.budget >= bestUncapped(fc) - 0.05 ? 0 : 1),
};
function bestUncapped(fc) {
  const t = E.optimise(stagesAt(fc, "", 0)[0].cand, [], {
    cap: 1e9,
    free: 7,
    maxT: 7,
    chip: "limitless",
    locks: new Set(),
    bans: new Set(),
    top: 1,
  })[0];
  return t ? t.cost : 0;
}
const STRATEGIES = [];
for (const b of ["points", "budget", "budget-r8", "budget-afford"])
  for (const c of ["consensus", "record", "early", "none"]) STRATEGIES.push(`${b}-${c}`);

/* ---------- one season ---------- */
function season(name) {
  const [, b, c] = name.match(/^(.*)-([a-z]+)$/);
  const budgetOf = budgetPolicies[b],
    chipOf = chipPolicies[c];
  const st = { team: [], budget: 100, free: 7, used: new Set(), gains: {} };
  const rows = [];
  let total = 0;
  for (const r of ROUNDS) {
    const fc = forecastAt(r);
    const valW = budgetOf(r, st, fc);
    const base = plan(fc, st, "", valW);
    // each chip still in hand: its plan and its projected gain over none (Limitless from R2; Final Fix is decided
    // after qualifying, below, so here it only takes the round)
    const plans = { "": base },
      gains = {};
    for (const ch of CHIPS) {
      if (st.used.has(ch) || !st.team.length) continue;
      if (ch === "finalfix") continue;
      const p = plan(fc, st, ch, valW);
      if (p && base) {
        plans[ch] = p;
        gains[ch] = (p.value ?? p.total) - (base.value ?? base.total);
      }
    }
    // Final Fix's gain is only known after qualifying: the team going in is the base plan's
    let fix = null;
    if (!st.used.has("finalfix") && st.team.length) {
      fix = bestFix(fc, base.steps[0].team, base.steps[0].boost, st.budget);
      gains.finalfix = fix ? fix.gain : 0;
    }
    const chip = chipOf(r, gains, st) || "";
    for (const [ch, g] of Object.entries(gains)) (st.gains[ch] = st.gains[ch] || []).push(g);
    const p = plans[chip] || base;
    const s0 = p.steps[0];
    const played = s0.played || s0.team;
    const ds = played.filter(isD);
    // the line-up as F1 scores it (hindsight.js score: X3 = the 3x driver, Boost the 2x)
    let boost = s0.boost,
      x3 = null;
    if (chip === "x3") ((x3 = s0.boost), (boost = s0.boost2));
    if (chip === "autopilot")
      boost = ds.slice().sort((a, b2) => (hist(b2, r)?.pts ?? -99) - (hist(a, r)?.pts ?? -99))[0];
    const lineup = {
      ids: played,
      start: st.team,
      boost,
      x3,
      chip,
      ff: chip === "finalfix" && fix ? { out: fix.out, in: fix.in, cat: "R" } : null,
      subs: s0.transfers,
      free: st.team.length ? st.free : 7,
    };
    const pts = Hind.score(lineup, r);
    total += pts;
    const cost = r1(played.reduce((t, id) => t + (hist(id, r)?.price || 0), 0));
    rows.push({
      gd: r,
      chip: chip || null,
      team: played.map((id) => byId[id].tla || byId[id].name),
      boost: boost && (byId[boost].tla || byId[boost].name),
      x3: x3 && byId[x3].tla,
      ff: lineup.ff && `${byId[lineup.ff.out].tla} -> ${byId[lineup.ff.in].tla}`,
      transfers: st.team.length ? s0.transfers : 0,
      penalty: chip === "wildcard" || chip === "limitless" || !st.team.length ? 0 : s0.penalty,
      budget: r1(st.budget),
      cost,
      valW,
      xPts: r1(s0.pts),
      pts,
      total,
    });
    // carry over: the team held (a Limitless team reverts), the budget with the real price changes of that team,
    // free transfers, the chip spent
    const held = s0.team;
    const moved = held.reduce((t, id) => {
      const h = hist(id, r),
        nx = byId[id].hist.find((x) => x && x.gd > r);
      return t + (h ? (nx ? nx.price : byId[id].price) - h.price : 0);
    }, 0);
    st.budget = r1(st.budget + moved);
    const reset = !st.team.length || chip === "wildcard" || chip === "limitless";
    st.free = reset ? 2 : Math.min(3, 2 + Math.min(1, Math.max(0, st.free - s0.transfers)));
    st.team = held;
    if (chip) st.used.add(chip);
  }
  return { name, total, rows, chipsLeft: CHIPS.filter((c) => !st.used.has(c)) };
}

/* ---------- the real players ---------- */
function topTeams() {
  const read = (f) => {
    const p = path.join(__dirname, "..", "data", f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  };
  const snaps = read("elite_history.json") || [];
  const last = snaps.filter((x) => ROUNDS.includes(x.gd)).pop();
  const t100 = read("elite_top100.json");
  return {
    // season totals after the last round both have (exact: the global leaderboard)
    at: last ? last.gd : null,
    total: last ? { 1: last.cut["1"], 10: last.mean["10"], 100: last.mean["100"], 500: last.mean["500"] } : null,
    // per round: the R14 top 100's average points (their own CSV; survivors, so a little high early)
    perRound: t100 ? Object.fromEntries(t100.history.map((h) => [h.gd, { 10: h.avg["10"], 100: h.avg["100"] }])) : {},
    snaps: snaps.map((x) => ({ gd: x.gd, 10: x.mean["10"], 100: x.mean["100"] })),
  };
}

function main() {
  const want = (process.env.ST || STRATEGIES.join(",")).split(",");
  const t0 = Date.now();
  const res = want.map(season);
  const top = topTeams();
  const out = {
    generated: new Date().toISOString().slice(0, 16) + "Z",
    rounds: ROUNDS,
    sims: N,
    top,
    strategies: res,
  };
  const file = path.join(__dirname, "..", "history", String(D.season), "stats-team.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  if (process.argv.includes("--json")) return console.log(JSON.stringify(out, null, 1));
  console.log(
    `Stats team, R${ROUNDS[0]}-R${ROUNDS[ROUNDS.length - 1]} (${N} sims a race, ${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
  if (top.total)
    console.log(
      `Real players after R${top.at}: #1 ${top.total[1]}, top-10 average ${top.total[10]}, top-100 ${top.total[100]}, top-500 ${top.total[500]}`,
    );
  const rows = res
    .map((s) => {
      const L = s.rows[s.rows.length - 1];
      const at = s.rows.find((x) => x.gd === top.at);
      return {
        strategy: s.name,
        total: s.total,
        ...(at && top.total
          ? { "vs top-100": r1(at.total - top.total[100]), "vs top-10": r1(at.total - top.total[10]) }
          : {}),
        chips: s.rows
          .filter((x) => x.chip)
          .map((x) => `${x.chip} R${x.gd}`)
          .join(", "),
        "chips left": s.chipsLeft.join(","),
        budget: L.budget,
        transfers: s.rows.reduce((t, x) => t + x.transfers, 0),
        "-10s": s.rows.reduce((t, x) => t + x.penalty, 0) / 10,
      };
    })
    .sort((a, b) => b.total - a.total);
  console.table(rows);
  console.log(`   written to ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) main();
module.exports = { season, forecastAt, STRATEGIES, CONSENSUS, topTeams };
