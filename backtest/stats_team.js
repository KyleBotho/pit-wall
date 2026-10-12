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
//   ST=points-consensus,naive:budget-ev node ... only these; ST_N = sims per race (default 3000)
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
const TIER_A = 18.5; // the game's A tier ($m and up; the price rule's line between big and small steps)

/* ---------- what was known before each lock ---------- */
const FC = {};
/** Round r's forecast: the next HZ races' simulated weekends and every asset's price path over them. src "model" =
 * the shipped engine; "naive" = every weekend replaced by the naive forecast (season-to-date average + a drawn
 * residual: engine SIM.naivePool 1; an asset with no round yet, as everyone at R1, keeps the model's). */
function forecastAt(r, src = "model") {
  const key = `${r}|${src}`;
  if (FC[key]) return FC[key];
  if (src === "oracle") return (FC[key] = oracleAt(r));
  const Dr = W.asOf(r);
  const g = D.schedule.find((x) => x.gd === r);
  const run = () => E.forecastRaces(Dr, { setup: () => ({}), sprint0: g.sprint, sims: N });
  const f = src === "naive" ? E.withSettings({ "SIM.naivePool": 1 }, run) : run();
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
      tier: a.price >= TIER_A ? 1 : 0,
      mean,
      nn: sims[0].stats[i0].nnMean,
      path: E.pricePath(a, Dr.done, pts),
    };
  }
  FC[key] = { Dr, g, src, sims, idx, assets, races: f.races.slice(0, HZ), N };
  return FC[key];
}
/** Hindsight ("oracle"): the planner told the real points of the next races and the real price changes after them,
 * one "simulated" weekend each (N 1). The best a manager could have done with perfect knowledge of the next three
 * races, under the same rules: an upper benchmark, not a proven optimum (the plan looks three races ahead). */
function oracleAt(r) {
  const g = D.schedule.find((x) => x.gd === r);
  const races = ROUNDS.filter((x) => x >= r).slice(0, HZ);
  const ids = D.assets.filter((a) => hist(a.id, r)).map((a) => a.id);
  const ptsAt = (id, gd, nn) => {
    const h = hist(id, gd);
    return h && h.active ? (nn ? (h.nn ?? Math.max(0, h.pts)) : h.pts) : 0;
  };
  const sims = races.map((gd) => ({
    ids,
    tot: Float32Array.from(ids, (id) => ptsAt(id, gd, false)),
    nn: Float32Array.from(ids, (id) => ptsAt(id, gd, true)),
  }));
  const idx = sims.map(() => Object.fromEntries(ids.map((id, i) => [id, i])));
  const assets = {};
  for (const id of ids) {
    const a = byId[id],
      h = hist(id, r);
    const d = races.map((gd) => r1(priceChange(id, gd)));
    assets[id] = {
      kind: a.kind,
      price: h.price,
      active: a.kind === "C" || h.active,
      tier: h.price >= TIER_A ? 1 : 0,
      mean: races.map((gd) => ptsAt(id, gd, false)),
      nn: ptsAt(id, r, true),
      path: { d, steps: Int8Array.from(d, (v) => Math.round(v * 10)) },
    };
  }
  return { Dr: null, g, src: "oracle", sims, idx, assets, races, N: 1 };
}
/** An asset's real price change after round gd (the next round's price, or today's after the latest). */
function priceChange(id, gd) {
  const h = hist(id, gd),
    nx = byId[id].hist.find((x) => x && x.gd > gd);
  return h ? (nx ? nx.price : byId[id].price) - h.price : 0;
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
      // A-tier counts for a team-structure filter (the "2A drivers + 1A constructor" builds)
      f: { AD: a.kind === "D" ? a.tier : 0, AC: a.kind === "C" ? a.tier : 0 },
    }));
    out.push({ cand, dPrice: Object.fromEntries(Object.entries(fc.assets).map(([id, a]) => [id, a.path.d[k] || 0])) });
  }
  return out;
}

/** The best plan from the team held, with a chip ("" = none). */
function plan(fc, st, chip, valW, filters) {
  const stages = stagesAt(fc, chip, valW);
  const n = fc.N || N;
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
    filters,
    priceSteps: Object.fromEntries(Object.entries(fc.assets).map(([id, a]) => [id, a.path.steps])),
    priceN: n,
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
/** Each driver's real points from the race session (hindsight's Final Fix). */
function racePoints(gd) {
  const out = {};
  for (const a of D.assets) {
    const h = hist(a.id, gd);
    if (a.kind === "D" && h && h.active)
      out[a.id] = (h.ev || []).reduce((t, e) => t + (D.evNames[e[0]].s === "R" ? e[1] : 0), 0);
  }
  return out;
}
/** The best single swap for the race (within the budget), its projected gain (x2 in the Boost slot). */
function bestFix(fc, ids, boost, budget) {
  // the naive player learns nothing from qualifying: its race projection is still the season average
  const post =
    fc.src === "naive"
      ? Object.fromEntries(Object.entries(fc.assets).map(([id, a]) => [id, a.mean[0]]))
      : fc.src === "oracle"
        ? racePoints(fc.g.gd)
        : afterQuali(fc);
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
  // the best calendar in hindsight (solveCalendar: each chip's real gain per round, the best one chip a round)
  hindsight: (r, gains, st) => {
    const c = st.calendar && st.calendar[r];
    return c && gains[c] != null ? c : null;
  },
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
      const seen = (st.gains[c] || []).map((x) => x.g);
      const forced = LAST - r + 1 <= left;
      const ok = forced || (seen.length >= 1 && g >= FLOOR[c] && g >= Math.max(...seen));
      const score = g / FLOOR[c];
      if (ok && score > best) ((pick = c), (best = score));
    }
    return pick;
  },
  // play a chip when its gain this round beats what holding it is expected to bring: the expected best gain over the
  // races left (optimal stopping, worked back race by race over the real calendar from the gains seen so far, sprint
  // weekends apart); from the third round with chips (two gains seen); the chip furthest above its threshold wins
  ev: (r, gains, st) => {
    let pick = null,
      best = -Infinity;
    const left = CHIPS.filter((c) => !st.used.has(c)).length;
    for (const [c, g] of Object.entries(gains)) {
      if (g == null) continue;
      const seen = st.gains[c] || [];
      const forced = LAST - r + 1 <= left;
      if (!forced && seen.length < 2) continue;
      const v = holdValue(seen.concat([{ gd: r, g, sprint: isSprint(r) }]), r);
      const margin = g - v + (forced ? 1e6 : 0);
      if ((forced || g >= v) && margin > best) ((pick = c), (best = margin));
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
const isSprint = (gd) => !!(D.schedule.find((x) => x.gd === gd) || {}).sprint;
/** What keeping a chip after round r is worth: V = E[max(G_k, V_{k+1})] worked back from the season's last round
 * (V = 0 after it) over the rounds after r, G_k drawn from the chip's gains seen so far on the same kind of weekend
 * (sprint or not; all of them while a kind has fewer than 2). @param {{ gd: number, g: number, sprint: boolean }[]} seen */
function holdValue(seen, r) {
  const all = seen.map((x) => x.g);
  const pool = (sp) => {
    const xs = seen.filter((x) => x.sprint === sp).map((x) => x.g);
    return xs.length >= 2 ? xs : all;
  };
  let v = 0;
  for (let k = LAST; k > r; k--) {
    const xs = pool(isSprint(k));
    v = xs.reduce((t, x) => t + Math.max(x, v), 0) / xs.length;
  }
  return v;
}
// the budget policy: points one $1m of expected price rise is worth per race left (0 = points only)
const budgetPolicies = {
  points: () => 0,
  budget: () => 1, // the Calculator's default xΔ$Pts weight, all season
  "budget-r8": (r) => (r <= 8 ? 1 : 0),
  "budget-half": () => 0.5,
  "budget-2": () => 2,
  // build until the budget buys the best team on projected points with exactly 4 (or 3) A-tier assets (the user's
  // "4A / 3.5A line-up": the optimiser fills the rest with what scores best for its price, e.g. a B-priced driver
  // performing at A level), then points for good (2026-10-12: "until the best team at any price" never came)
  "budget-4A": (r, st, fc) => tierPolicy(st, fc, 4),
  "budget-3A": (r, st, fc) => tierPolicy(st, fc, 3),
};
function tierPolicy(st, fc, k) {
  if (st.reached) return 0;
  const target = tierTarget(fc, k);
  if (target != null && st.budget >= target - 0.05) {
    st.reached = fc.g.gd;
    return 0;
  }
  return 1;
}
/** The cost of the best team on projected points with exactly k A-tier assets (no budget limit), or null. */
function tierTarget(fc, k) {
  const cand = stagesAt(fc, "", 0)[0].cand.map((c) => ({ ...c, f: { A: fc.assets[c.id].tier } }));
  const t = E.optimise(cand, [], {
    cap: 1e9,
    free: 7,
    maxT: 7,
    chip: "limitless",
    locks: new Set(),
    bans: new Set(),
    top: 1,
    filters: [{ k: "A", min: k, max: k }],
  })[0];
  return t ? t.cost : null;
}
const STRATEGIES = [];
for (const b of ["points", "budget", "budget-r8", "budget-4A", "budget-3A"])
  for (const c of ["consensus", "early", "ev", "none"]) STRATEGIES.push(`${b}-${c}`);
// the naive player (season averages) on the same planner and rules: what the model itself is worth
for (const b of ["points", "budget"]) for (const c of ["early", "ev"]) STRATEGIES.push(`naive:${b}-${c}`);
// the meta builds on the model
for (const sx of ["meta", "meta-alt"]) STRATEGIES.push(`${sx}/budget-early`);
// hindsight: perfect knowledge of the next three races, the best chip calendar; free and by structure
const HINDSIGHT = ["points", "budget-half", "budget", "budget-2"].map((b) => `oracle:${b}-hindsight`);
for (const sx of ["2D1C", "1D2C", "2D2C", "meta", "meta-alt"]) HINDSIGHT.push(`oracle:${sx}/budget-hindsight`);
HINDSIGHT.push("oracle:budget-none");
STRATEGIES.push(...HINDSIGHT);

/* ---------- one season ---------- */
// team structures by A-tier counts (drivers D, constructors C at $18.5m and up): a fixed one, or the season's meta
// builds in order (user, 2026-10-12: 2A drivers + 1A constructor -> 1A driver + 2A constructors (+ a B driver scoring
// like an A: "3.5A") -> 2A + 2A; or starting 1D2C), each moved on to once a team of it fits the budget and plans no
// more than 10 points worse
const STRUCTS = { meta: ["2D1C", "1D2C", "2D2C"], "meta-alt": ["1D2C", "2D2C"] };
const filtersOf = (sx) =>
  sx
    ? [
        { k: "AD", min: +sx[0], max: +sx[0] },
        { k: "AC", min: +sx[2], max: +sx[2] },
      ]
    : undefined;
const STRAT = /^(?:(naive|oracle):)?(?:([\w-]+)\/)?(.*)-([a-z]+)$/;
function season(name, opt = {}) {
  const [, pre, sx, b, c] = name.match(STRAT);
  const src = pre || "model";
  const budgetOf = budgetPolicies[b],
    chipOf = chipPolicies[c];
  const phases = sx ? STRUCTS[sx] || [sx] : null;
  if (!budgetOf || !chipOf || (phases && !phases.every((x) => /^\dD\dC$/.test(x))))
    throw new Error(`unknown strategy ${name}`);
  const st = { team: [], budget: 100, free: 7, used: new Set(), gains: {}, reached: null, calendar: opt.calendar };
  let phase = 0;
  // the plan within the structure in force (Limitless ignores it: no budget); none fits: the plain plan
  const planS = (fc, chip, valW) => {
    if (!phases || chip === "limitless") return plan(fc, st, chip, valW);
    const cur = plan(fc, st, chip, valW, filtersOf(phases[phase]));
    if (!chip && phase + 1 < phases.length) {
      const nx = plan(fc, st, chip, valW, filtersOf(phases[phase + 1]));
      const v = (p) => (p ? (p.value ?? p.total) : -Infinity);
      if (nx && v(nx) >= v(cur) - 10) {
        phase++;
        return nx;
      }
    }
    return cur || plan(fc, st, chip, valW);
  };
  const rows = [];
  let total = 0;
  for (const r of ROUNDS) {
    const fc = forecastAt(r, src);
    const valW = budgetOf(r, st, fc);
    const base = planS(fc, "", valW);
    // each chip still in hand: its plan and its projected gain over none (Limitless from R2; Final Fix is decided
    // after qualifying, below, so here it only takes the round)
    const plans = { "": base },
      gains = {};
    for (const ch of CHIPS) {
      if (st.used.has(ch) || !st.team.length) continue;
      if (ch === "finalfix") continue;
      const p = planS(fc, ch, valW);
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
    for (const [ch, g] of Object.entries(gains))
      (st.gains[ch] = st.gains[ch] || []).push({ gd: r, g, sprint: isSprint(r) });
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
    const tierOf = (k) => played.filter((id) => byId[id].kind === k && (hist(id, r)?.price || 0) >= TIER_A).length;
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
      struct: `${tierOf("D")}D${tierOf("C")}C`,
      valW,
      xPts: r1(s0.pts),
      pts,
      total,
    });
    // carry over: the team held (a Limitless team reverts), the budget with the real price changes of that team,
    // free transfers, the chip spent
    const held = s0.team;
    const moved = held.reduce((t, id) => t + priceChange(id, r), 0);
    st.budget = r1(st.budget + moved);
    const reset = !st.team.length || chip === "wildcard" || chip === "limitless";
    st.free = reset ? 2 : Math.min(3, 2 + Math.min(1, Math.max(0, st.free - s0.transfers)));
    st.team = held;
    if (chip) st.used.add(chip);
  }
  // chips still in hand after the last round played: what holding them is expected to bring over the races left
  // (holdValue on the gains seen), so a policy that saves chips for later isn't scored as if they were worth nothing
  const last = ROUNDS[ROUNDS.length - 1];
  const inHand = Object.fromEntries(
    CHIPS.filter((ch) => !st.used.has(ch)).map((ch) => [
      ch,
      st.gains[ch] && st.gains[ch].length ? r1(holdValue(st.gains[ch], last)) : null,
    ]),
  );
  return { name, src, total, rows, chipsLeft: Object.keys(inHand), inHand, reached: st.reached, gains: st.gains };
}

/** The best chip calendar for a season played without chips: each chip's gain per round (as that season measured
 * it), at most one chip a round and each chip once, the total gain maximised exactly (over the chips used so far).
 * The gains are those of the chip-less season; a chip played changes the team after it a little (re-run with it). */
function solveCalendar(gains) {
  const rounds = [...new Set(Object.values(gains).flatMap((xs) => xs.map((x) => x.gd)))].sort((a, b) => a - b);
  const g = (c, r) => ((gains[c] || []).find((x) => x.gd === r) || {}).g;
  const M = 1 << CHIPS.length;
  let dp = new Array(M).fill(-Infinity);
  dp[0] = 0;
  const choice = [];
  for (const r of rounds) {
    const nx = dp.slice(),
      ch = new Array(M).fill(null);
    for (let m = 0; m < M; m++) {
      if (dp[m] === -Infinity) continue;
      CHIPS.forEach((c, j) => {
        const v = g(c, r);
        if (m & (1 << j) || v == null || v <= 0) return;
        const m2 = m | (1 << j);
        if (dp[m] + v > nx[m2]) ((nx[m2] = dp[m] + v), (ch[m2] = { from: m, c }));
      });
    }
    choice.push(ch);
    dp = nx;
  }
  let m = dp.indexOf(Math.max(...dp));
  const cal = {};
  for (let k = rounds.length - 1; k >= 0; k--) {
    const x = choice[k][m];
    if (x) {
      // only if this round's choice led to m (else m was reached earlier: carried over)
      cal[rounds[k]] = x.c;
      m = x.from;
    }
  }
  return cal;
}
/** A strategy with chips "hindsight": the season without chips first, then again with the best calendar for it. */
function seasonWith(name) {
  if (!name.endsWith("-hindsight")) return season(name);
  const first = season(name.replace(/-hindsight$/, "-none"));
  return season(name, { calendar: solveCalendar(first.gains) });
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
  const res = want.map(seasonWith);
  const top = topTeams();
  const out = {
    generated: new Date().toISOString().slice(0, 16) + "Z",
    rounds: ROUNDS,
    sims: N,
    top,
    // the chip-gain log only serves the hindsight calendar: left out of the file
    strategies: res.map(({ gains, ...x }) => x),
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
        "chips left (pts held)": s.chipsLeft
          .map((ch) => `${ch}${s.inHand[ch] != null ? " " + s.inHand[ch] : ""}`)
          .join(", "),
        budget: L.budget,
        "points from": s.reached ? `R${s.reached}` : "",
        transfers: s.rows.reduce((t, x) => t + x.transfers, 0),
        "-10s": s.rows.reduce((t, x) => t + x.penalty, 0) / 10,
      };
    })
    .sort((a, b) => b.total - a.total);
  console.table(rows);
  console.log(`   written to ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) main();
module.exports = { season, seasonWith, solveCalendar, forecastAt, STRATEGIES, HINDSIGHT, CONSENSUS, topTeams };
