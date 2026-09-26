/* ---------- computation ---------- */
import { DATA, NEXT, SEASON_OVER, byId, code, col, esc, f1, isDriver, money, sgn, teamCode, upcoming } from "./core.js";
import { activeTeam, state } from "./state.js";
import { nextIds, teamKey, teamLabel, tracked, usedChips } from "./league.js";
import { rivalRows } from "./sync.js";
export let forecast = null; // the simulated races and projections behind every view (compute())
const recentForm = Engine.recentForm;
export const trackFit = Engine.trackModel(DATA);
// circuit settings: fitted track values (past seasons x this season's trend) with this weekend's rain forecast,
// overridden by anything set in Settings
export const circ = (g) =>
  Object.assign(Engine.withWeather(trackFit.forCircuit(g), (DATA.weather || {})[g.gd]), state.circuits[g.gd] || {});
export function compute() {
  const form = Object.fromEntries(DATA.assets.map((a) => [a.id, recentForm(a)]));
  if (SEASON_OVER) {
    forecast = { model: null, races: [], sims: [], idx: {}, form, proj: [], price: {} };
    return;
  }
  // the next three races; each gets its own model: practice pace, the betting market, grid penalties and any
  // result already known (qualifying) only for the coming weekend (later races use season form alone)
  const races = upcoming.slice(0, 3);
  const setups = races.map((g, k) =>
    Engine.raceSetup(DATA, g, {
      next: k === 0,
      track: trackFit,
      halfLife: state.halfLife,
      adj: state.adj,
      pw: state.pw,
      oddsW: state.oddsW,
      pen: k === 0 ? state.pen : {},
      circuit: state.circuits[g.gd] || {},
    }),
  );
  const models = setups.map((x) => x.model);
  const sims = races.map((g, k) =>
    Engine.simulate(
      models[k],
      setups[k].circuit,
      k === 0 ? sprintNext() : g.sprint,
      state.sims,
      g.gd * 7919 + 13,
      setups[k].simOpt,
    ),
  );
  const idx = Object.fromEntries(sims[0].ids.map((id, i) => [id, i]));
  const proj = sims.map((sim) => {
    const o = {};
    for (const a of DATA.assets) {
      const i = idx[a.id];
      if (i == null) {
        o[a.id] = { mean: -25, nn: 0, shift: 0, out: true };
        continue;
      }
      const st = sim.stats[i];
      const mean = Engine.blendMean(st, form[a.id], state.blend);
      o[a.id] = { mean, nn: st.nnMean + (mean - st.mean), shift: mean - st.mean, st };
    }
    return o;
  });
  // a past-performance preset replaces the simulated means (the simulated spread is kept, shifted to match)
  if (state.simPreset !== "sim") {
    const pp = Engine.pastPoints(DATA, { preset: state.simPreset, weights: simWeights(), off: state.simOff });
    races.forEach((g, k) => {
      const sprint = k === 0 ? sprintNext() : g.sprint;
      for (const [id, v] of Object.entries(pp)) {
        const p = proj[k][id];
        if (!p || p.out) continue;
        p.mean = v.base + (sprint ? v.sprint : 0);
        p.nn = v.nnBase + (sprint ? v.nnSprint : 0);
        p.shift = p.mean - p.st.mean;
      }
    });
  }
  // xPts typed in the Drivers / Constructors tables replace the next race's projection (distribution shifted to match)
  for (const [id, v] of Object.entries(state.xo || {})) {
    const p = proj[0][id];
    if (!p || p.out || v == null || isNaN(v)) continue;
    const dlt = v - p.mean;
    p.model = p.mean;
    p.mean = v;
    p.shift += dlt;
    p.nn += dlt;
  }
  forecast = { model: models[0], setup: setups[0], races, sims, idx, form, proj, price: {} };
  forecast.price = Object.fromEntries(DATA.assets.map((a) => [a.id, priceInfo(a)]));
}
// the next race as a sprint weekend: as the Simulation panel's toggle says for that race, else the calendar
export const sprintNext = () =>
  state.simSprint && NEXT && state.simSprint.gd === NEXT.gd ? !!state.simSprint.v : !!(NEXT && NEXT.sprint);
// each finished round's weight for a past-performance preset: the preset's, with any set by hand on top
export const simWeights = () => ({
  ...Engine.presetWeights(state.simPreset, DATA.done, { decay: state.simDecay, win: state.simWin }),
  ...state.simW,
});
export const BINS = [-0.6, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.6];
// price change after the next race, from the simulated weekends (the game's rule: Engine.priceStep). The average
// is over the last three races, or only the races run so far early on (2026: no "imaginary zero" races; confirmed
// by the community against the game), so after round 1 the next race counts half.
function priceInfo(a) {
  const h = a.hist.filter(Boolean);
  const p1 = h.length ? h[h.length - 1].pts : 0,
    p2 = h.length > 1 ? h[h.length - 2].pts : 0;
  const sum2 = p1 + p2,
    n = Math.min(3, h.length + 1); // races in the average, the next one included
  const need = Engine.PRICE_BANDS.map((t) => t * n * a.price - sum2);
  const i = forecast.idx[a.id];
  if (i == null || !a.active) return { sum2, p1, p2, need, dist: null, ev: 0, up: 0, down: 0 };
  const sim = forecast.sims[0],
    N = sim.N,
    sh = forecast.proj[0][a.id].shift,
    dist = BINS.map(() => 0);
  let ev = 0,
    up = 0,
    down = 0;
  for (let s = 0; s < N; s++) {
    const d = Math.round(Engine.priceStep(a.price, (sum2 + sim.tot[i * N + s] + sh) / n) * 10) / 10;
    ev += d;
    if (d > 0) up++;
    if (d < 0) down++;
    let k = BINS.indexOf(d);
    if (k < 0) k = BINS.reduce((b, v, j) => (Math.abs(v - d) < Math.abs(BINS[b] - d) ? j : b), 0);
    dist[k]++;
  }
  return { sum2, p1, p2, need, dist: dist.map((v) => v / N), ev: ev / N, up: up / N, down: down / N };
}
export const priceEv = (id) => (forecast.price[id] && forecast.price[id].ev) || 0;

/* ---------- the calculator's starting team ---------- */
// One of your teams (state.active), a manual team, a rival's current line-up, or none (then only a maximum budget).
// Rivals are the tracking-league teams you picked (state.rivals, rivals.js), known by team key; one whose line-up
// isn't known yet (no race since it joined) or that left the league isn't listed.
export function rivalTeams() {
  const out = [];
  for (const p of state.rivals) {
    if (state.teams.some((t) => teamKey(t) === p.tk)) continue; // your own team
    const row = rivalRows().find((r) => r.account_key === p.ak);
    if (!row || !(row.teams || []).some((t) => t && t.tk === p.tk)) continue;
    const tr = tracked(p.tk),
      ids = nextIds(tr);
    if (!ids) continue;
    out.push({
      key: p.tk,
      tk: p.tk,
      name: teamLabel(p.tk),
      user: row.username,
      ids,
      bank: tr.next.bank,
      free: tr.next.free,
      boost: "",
      chips: usedChips(tr),
    });
  }
  return out;
}
const findRival = (c) => rivalTeams().find((x) => x.key === c.key);
const rivalDefaults = (r) => ({
  bank: r.bank ?? 0,
  free: r.free ?? 2,
  chipsUsed: r.chips || {},
  boost: r.boost || "auto",
});
const NO_TEAM = Object.freeze({
  name: "No starting team",
  team: [],
  bank: 0,
  free: 7,
  chipsUsed: {},
  boost: "auto",
  none: true,
});
// Reading the starting team changes nothing; editStart() returns the object to change. With nothing picked, it's
// your active team, unless that is only an example (no F1 Fantasy account linked, nothing entered): then none.
export function startTeam() {
  const c = state.calcStart;
  if (c && c.type === "none") return NO_TEAM;
  if (c && c.type === "draft" && state.drafts[c.i]) return state.drafts[c.i];
  if (c && c.type === "rival") {
    const r = findRival(c);
    // settings you enter for a rival are kept per rival; the line-up follows the latest standings
    if (r) {
      const cfg = state.rivalCfg[r.key] || rivalDefaults(r);
      return {
        ...cfg,
        chipsUsed: { ...cfg.chipsUsed, ...r.chips }, // chips F1's data shows as played always count
        name: r.name,
        tk: r.tk,
        team: r.ids.slice(),
        ro: true,
        rivalKey: r.key,
      };
    }
  }
  if (!(c && c.type === "team") && activeTeam().example) return NO_TEAM;
  return activeTeam();
}
// the starting team's settings to change (bank, free transfers, chips used, Boost); a rival's entry is created on
// the first edit
export function editStart() {
  const start = startTeam();
  if (!start.rivalKey) return start;
  if (!state.rivalCfg[start.rivalKey]) {
    const { name, tk, team, ro, rivalKey: k, ...cfg } = start;
    state.rivalCfg[k] = cfg;
  }
  return state.rivalCfg[start.rivalKey];
}
export const startKind = () => {
  const c = state.calcStart,
    t = startTeam();
  if (t.none) return "none";
  return c && ["draft", "rival"].includes(c.type) && t !== activeTeam() ? c.type : "team";
};
// chips F1's data shows the starting team has played ({chip: gameday}); the Calculator won't un-mark them
export const lockedChips = (team) =>
  team.none || !(team.rivalKey || state.teams.includes(team)) ? {} : (tracked(teamKey(team)) || { used: {} }).used;
// the chip the Calculator plays: the one picked, unless the starting team has already used it
export const activeChip = () => (state.chip && !startTeam().chipsUsed[state.chip] ? state.chip : "");
export const teamValue = () => startTeam().team.reduce((s, id) => s + byId[id].price, 0);
export const cap = () => (startTeam().none ? +state.maxBudget || 100 : teamValue() + (+startTeam().bank || 0));
export const maxTransfers = (team) =>
  team.none ? 7 : Math.min(7, Math.min(7, +team.free || 0) + (state.maxPen == null ? 7 : state.maxPen));
// a team's Boost for a race: the one set for the team (next race only), else its best projected driver
export function boostFor(ids, raceIdx = 0, team = activeTeam()) {
  const ds = ids.filter(isDriver);
  if (raceIdx === 0 && team.boost !== "auto" && ds.includes(team.boost)) return team.boost;
  const pr = forecast.proj[raceIdx];
  return ds.reduce((b, id) => (pr[id].mean > pr[b].mean ? id : b), ds[0]) || null;
}
export function teamDist(ids, boost, chip, boost2) {
  const arr = teamSamples(ids, boost, chip, boost2),
    N = arr.length;
  const sorted = Array.from(arr).sort((a, b) => a - b);
  return {
    mean: arr.reduce((a, b) => a + b, 0) / N,
    p25: sorted[Math.floor(N * 0.25)],
    p75: sorted[Math.floor(N * 0.75)],
  };
}
// joint next-race score of a team across the simulated weekends
export function teamSamples(ids, boost, chip, boost2) {
  const sim = forecast.sims[0],
    N = sim.N,
    arr = new Float64Array(N);
  const ds = ids.filter(isDriver);
  for (const id of ids) {
    const i = forecast.idx[id],
      p = forecast.proj[0][id];
    if (i == null) {
      for (let s = 0; s < N; s++) arr[s] += -25;
      continue;
    }
    const src = chip === "noneg" ? sim.nn : sim.tot;
    const mult = chip === "autopilot" ? 1 : id === boost ? (chip === "x3" ? 3 : 2) : id === boost2 ? 2 : 1;
    for (let s = 0; s < N; s++) arr[s] += (src[i * N + s] + p.shift) * mult;
  }
  // Autopilot: the Boost goes to whoever scores most, weekend by weekend
  if (chip === "autopilot")
    for (let s = 0; s < N; s++) {
      let m = -1e9;
      for (const id of ds) {
        const i = forecast.idx[id];
        const v = i == null ? -25 : sim.tot[i * N + s] + forecast.proj[0][id].shift;
        if (v > m) m = v;
      }
      arr[s] += m;
    }
  return arr;
}
export const horizon = () => (activeChip() === "limitless" ? 1 : Math.min(state.horizon, forecast.races.length));
export const xpts = (id, H = horizon()) => {
  let s = 0;
  for (let k = 0; k < Math.min(H, forecast.proj.length); k++) s += forecast.proj[k][id].mean;
  return s;
};

/* ---------- building blocks ---------- */
// asset chip: code tile with team border, xPts strip, price-change strip
export function chip(id, o = {}) {
  const a = byId[id],
    p = o.pts ?? xpts(id),
    dv = priceEv(id);
  const b =
    o.b != null
      ? `<span class="b">${o.b}</span>`
      : `<span class="b ${dv > 0.04 ? "good" : dv < -0.04 ? "bad" : ""}">${sgn(dv, 2).replace("−0.00", "0.00")}</span>`;
  return `<span class="ac ${o.cls || ""}" style="--tc:${col(a)}" title="${esc(a.kind === "D" ? a.name : a.team)} · ${money(a.price)}">
    <span class="c">${esc(code(a))}</span><span class="a">${o.a ?? f1(p)}</span>${b}${o.x ? `<span class="x">${o.x}</span>` : ""}</span>`;
}
export const codeBox = (a) => `<span class="code" style="--tc:${col(a)}">${esc(code(a))}</span>`;
// drivers with more than one asset this season (a mid-season team change): their rows also name the team
const DUP_TLA = new Set(
  DATA.assets
    .filter((a, i, all) => a.kind === "D" && all.some((b, j) => j !== i && b.kind === "D" && b.tla === a.tla))
    .map((a) => a.tla),
);
export const who = (a, label) =>
  `<span class="who">${codeBox(a)}<span>${esc(label ?? (a.kind === "D" ? a.short : a.team))}${label == null && a.kind === "D" && DUP_TLA.has(a.tla) ? ` <span class="dim">${esc(teamCode(a.team))}</span>` : ""}</span></span>`;
// the key under a heat-shaded table: red = lower, green = higher, deeper = further from the middle; none when the
// heatmap colours are off (Settings)
export function heatKey(lo = "lower", hi = "higher") {
  if (!state.heat) return "";
  return `<span class="muted">${esc(lo)}</span><span class="ramp" style="background:linear-gradient(90deg,rgba(239,68,68,.34),rgba(239,68,68,0) 45%,rgba(34,197,94,0) 55%,rgba(34,197,94,.34))"></span><span class="muted">${esc(hi)}</span>`;
}
export function heat(v, lo, hi) {
  if (!state.heat || v == null || isNaN(v)) return "";
  const t = Math.max(-1, Math.min(1, v >= 0 ? (hi > 0 ? v / hi : 0) : lo < 0 ? -(v / lo) : 0));
  const c = t >= 0 ? "34,197,94" : "239,68,68";
  return ` style="background-color:rgba(${c},${(Math.abs(t) * 0.28).toFixed(3)})"`;
}
export function optionList(kind, sel) {
  const list = DATA.assets
    .filter((a) => a.kind === kind && (a.active || a.id === sel))
    .sort((a, b) => b.price - a.price);
  return list
    .map((a) => {
      const label = `${esc(code(a))} · ${esc(kind === "D" ? a.name : a.team)} — ${money(a.price)}${a.active ? "" : " (not racing)"}`;
      return `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${label}</option>`;
    })
    .join("");
}
