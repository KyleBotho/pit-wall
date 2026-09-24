/* ---------- computation ---------- */
let forecast = null; // the simulated races and projections behind every view (compute())
const recentForm = Engine.recentForm;
const trackFit = Engine.trackModel(DATA);
// circuit settings: fitted track-type values, overridden by anything set in Settings
const circ = (g) => Object.assign(trackFit.forCircuit(g.name), state.circuits[g.gd] || {});
function compute() {
  const form = Object.fromEntries(DATA.assets.map((a) => [a.id, recentForm(a)]));
  if (SEASON_OVER) {
    forecast = { model: null, races: [], sims: [], idx: {}, form, proj: [], price: {} };
    return;
  }
  // the next three races; each gets its own model: its track's team-pace shift, and practice pace only for the
  // coming weekend (later races use season form alone)
  const races = upcoming.slice(0, 3);
  const models = races.map((g, k) =>
    Engine.buildModel(DATA, {
      halfLife: state.halfLife,
      adj: state.adj,
      teamShift: circ(g).teamShift || {},
      practice: k === 0 ? DATA.practice || [] : [],
      practiceWeight: state.pw,
    }),
  );
  const sims = races.map((g, k) => Engine.simulate(models[k], circ(g), g.sprint, state.sims, g.gd * 7919 + 13));
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
  forecast = { model: models[0], races, sims, idx, form, proj, price: {} };
  forecast.price = Object.fromEntries(DATA.assets.map((a) => [a.id, priceInfo(a)]));
}
const BINS = [-0.6, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.6];
// price change after the next race, from the simulated weekends (the game's rule: Engine.priceStep)
function priceInfo(a) {
  const h = a.hist.filter(Boolean);
  const p1 = h.length ? h[h.length - 1].pts : 0,
    p2 = h.length > 1 ? h[h.length - 2].pts : 0;
  const sum2 = p1 + p2;
  const need = Engine.PRICE_BANDS.map((t) => t * 3 * a.price - sum2);
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
    const d = Math.round(Engine.priceStep(a.price, (sum2 + sim.tot[i * N + s] + sh) / 3) * 10) / 10;
    ev += d;
    if (d > 0) up++;
    if (d < 0) down++;
    let k = BINS.indexOf(d);
    if (k < 0) k = BINS.reduce((b, v, j) => (Math.abs(v - d) < Math.abs(BINS[b] - d) ? j : b), 0);
    dist[k]++;
  }
  return { sum2, p1, p2, need, dist: dist.map((v) => v / N), ev: ev / N, up: up / N, down: down / N };
}
const priceEv = (id) => (forecast.price[id] && forecast.price[id].ev) || 0;

/* ---------- the calculator's starting team ---------- */
// One of your teams (state.active), a manual team, a rival's current line-up, or none (then only a maximum budget).
// Rivals are identified by league and team name; the same team in two of your leagues is listed once.
const rivalKey = (league, name) => league + " / " + name;
function rivalTeams() {
  const out = [];
  for (const L of leagueList())
    for (const m of L.members || []) {
      if (!m.ids || state.teams.some((t) => t.name === m.name)) continue;
      if (out.some((x) => x.name === m.name && sameTeam(x.ids, m.ids))) continue;
      out.push({
        key: rivalKey(L.name, m.name),
        name: m.name,
        league: L.name,
        ids: m.ids,
        bank: m.bank,
        boost: m.boost,
        chips: m.chips,
      });
    }
  return out;
}
// older saves identify a rival by name only
const findRival = (c) =>
  rivalTeams().find((x) => x.key === c.key) || rivalTeams().find((x) => !c.key && x.name === c.name);
const rivalDefaults = (r) => ({ bank: r.bank ?? 0, free: 2, chipsUsed: r.chips || {}, boost: r.boost || "auto" });
const NO_TEAM = Object.freeze({
  name: "No starting team",
  team: [],
  bank: 0,
  free: 7,
  chipsUsed: {},
  boost: "auto",
  none: true,
});
// Reading the starting team changes nothing; editStart() returns the object to change.
function startTeam() {
  const c = state.calcStart;
  if (c && c.type === "none") return NO_TEAM;
  if (c && c.type === "draft" && state.drafts[c.i]) return state.drafts[c.i];
  if (c && c.type === "rival") {
    const r = findRival(c);
    // settings you enter for a rival are kept per rival; the line-up follows the latest standings
    if (r)
      return {
        ...(state.rivalCfg[r.key] || state.rivalCfg[r.name] || rivalDefaults(r)),
        name: r.name,
        team: r.ids.slice(),
        ro: true,
        rivalKey: r.key,
      };
  }
  return activeTeam();
}
// the starting team's settings to change (bank, free transfers, chips used, Boost); a rival's entry is created on
// the first edit
function editStart() {
  const T = startTeam();
  if (!T.rivalKey) return T;
  if (!state.rivalCfg[T.rivalKey]) {
    const { name, team, ro, rivalKey: k, ...cfg } = T;
    state.rivalCfg[k] = cfg;
  }
  return state.rivalCfg[T.rivalKey];
}
const startKind = () => {
  const c = state.calcStart;
  return c && ["none", "draft", "rival"].includes(c.type) && startTeam() !== activeTeam() ? c.type : "team";
};
// the chip the Calculator plays: the one picked, unless the starting team has already used it
const activeChip = () => (state.chip && !startTeam().chipsUsed[state.chip] ? state.chip : "");
const teamValue = () => startTeam().team.reduce((s, id) => s + byId[id].price, 0);
const cap = () => (startTeam().none ? +state.maxBudget || 100 : teamValue() + (+startTeam().bank || 0));
const maxTransfers = (T) =>
  T.none ? 7 : Math.min(7, Math.min(7, +T.free || 0) + (state.maxPen == null ? 7 : state.maxPen));
// a team's Boost for a race: the one set for the team (next race only), else its best projected driver
function boostFor(ids, raceIdx = 0, T = activeTeam()) {
  const ds = ids.filter(isDriver);
  if (raceIdx === 0 && T.boost !== "auto" && ds.includes(T.boost)) return T.boost;
  const pr = forecast.proj[raceIdx];
  return ds.reduce((b, id) => (pr[id].mean > pr[b].mean ? id : b), ds[0]) || null;
}
function teamDist(ids, boost, chip, boost2) {
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
function teamSamples(ids, boost, chip, boost2) {
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
const horizon = () => (activeChip() === "limitless" ? 1 : Math.min(state.horizon, forecast.races.length));
const xpts = (id, H = horizon()) => {
  let s = 0;
  for (let k = 0; k < Math.min(H, forecast.proj.length); k++) s += forecast.proj[k][id].mean;
  return s;
};

/* ---------- building blocks ---------- */
// asset chip: code tile with team border, xPts strip, price-change strip
function chip(id, o = {}) {
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
const codeBox = (a) => `<span class="code" style="--tc:${col(a)}">${esc(code(a))}</span>`;
const who = (a, label) =>
  `<span class="who">${codeBox(a)}<span>${esc(label ?? (a.kind === "D" ? a.short : a.team))}</span></span>`;
function heat(v, lo, hi) {
  if (!state.heat || v == null || isNaN(v)) return "";
  const t = Math.max(-1, Math.min(1, v >= 0 ? (hi > 0 ? v / hi : 0) : lo < 0 ? -(v / lo) : 0));
  const c = t >= 0 ? "34,197,94" : "239,68,68";
  return ` style="background-color:rgba(${c},${(Math.abs(t) * 0.28).toFixed(3)})"`;
}
function optionList(kind, sel) {
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
