/* ---------- Sim lab (owner only): every engine switch, a rerun, and panels built from our own simulations ----------
   Shown only to accounts in the Supabase `owners` table (RLS: each user can read only their own row), or on
   localhost with ?lab=1. It's a UI gate: everything here comes from the public build. Runs are in this browser, on
   demand: the switches are applied to Engine.SIM / TRACK / MODEL for the run only and put back afterwards, so the
   Calculator and every other view keep the shipped model. Settings live in this browser only (LAB_KEY). */
import { $, $$, DATA, SEASON_OVER, byId, code, col, esc, f1, pct, sgn, upcoming } from "./core.js";
import { state } from "./state.js";
import { syncState } from "./sync.js";
import { BINS, codeBox, forecast, heat, sprintNext, startTeam, who } from "./forecast.js";
import { showView } from "./main.js";
export let labOwner = false;
let labRun = null; // the last run: { g, N, ms, sim, setup, base (the shipped model's run, when compared), changed }
const LAB_KEY = "pitwall.lab";
// the switches, with the shipped value read from the engine at start-up (backtest notes in CLAUDE.md, item 9)
const LAB_SWITCHES = [
  {
    g: "Race",
    o: "SIM",
    k: "raceModel",
    l: "Race model",
    opts: [
      ["rank", "One score per driver"],
      ["laps", "Lap by lap (stage 3a)"],
      ["segments", "Timing segments + yo-yo (3b)"],
    ],
  },
  {
    g: "Race",
    o: "SIM",
    k: "lapOv",
    l: "Lap race: overtakes",
    opts: [
      ["passes", "Passes it makes"],
      ["regression", "Places-moved regression"],
    ],
  },
  { g: "Race", o: "SIM", k: "lapGrid", l: "Lap race: match the circuit's grid influence", bool: true },
  { g: "Race", o: "SIM", k: "yoyo", l: "Yo-yo chance per close segment (3b)", range: [0, 0.4, 0.02] },
  { g: "Race", o: "SIM", k: "ovModel", l: "Overtakes from the places-moved regression", bit: true },
  { g: "Race", o: "SIM", k: "pitStops", l: "Pit points from the team's real scoring lines", bit: true },
  { g: "Race", o: "SIM", k: "incident", l: "Share of retirements from multi-car incidents", range: [0, 0.5, 0.05] },
  { g: "Track", o: "TRACK", k: "speed", l: "Overtake level from practice average speed", bool: true },
  { g: "Track", o: "TRACK", k: "speedLambda", l: "Average speed: ridge", range: [0, 10, 0.5] },
  { g: "Track", o: "TRACK", k: "teamPace", l: "Team pace by track type", bool: true },
  { g: "Market", o: "SIM", k: "oddsW", l: "Betting-market weight", range: [0, 1, 0.05] },
  { g: "Market", o: "SIM", k: "flOddsW", l: "Fastest lap from the market", range: [0, 1, 0.05] },
  { g: "Pace", o: "MODEL", k: "bandQ", l: "Fast-corner band shift into qualifying (4)", range: [0, 2, 0.1] },
  { g: "Pace", o: "MODEL", k: "bandR", l: "Fast-corner band shift into race pace (4)", range: [0, 2, 0.1] },
  { g: "Pace", o: "MODEL", k: "practiceQ", l: "Practice short runs into qualifying pace", range: [0, 1, 0.05] },
  { g: "Pace", o: "MODEL", k: "practiceR", l: "Practice long runs into race pace", range: [0, 1, 0.05] },
  {
    g: "Pace",
    o: "MODEL",
    k: "mate",
    l: "Team-mates",
    opts: [
      ["blend", "Blend with the team-mate"],
      ["car", "Car + driver offset"],
    ],
  },
  { g: "Noise", o: "SIM", k: "qSd", l: "Qualifying noise, %", range: [0, 0.6, 0.02] },
  { g: "Noise", o: "SIM", k: "rSd", l: "Race noise, %", range: [0, 0.6, 0.02] },
  { g: "Noise", o: "SIM", k: "qSkew", l: "Qualifying noise skew", range: [0, 5, 0.5] },
  { g: "Noise", o: "SIM", k: "rSkew", l: "Race noise skew", range: [0, 5, 0.5] },
  { g: "Noise", o: "SIM", k: "unc", l: "Pace / reliability uncertainty", range: [0, 2, 0.1] },
].filter((s) => Engine[s.o] && s.k in Engine[s.o]);
const LAB_SHIPPED = Object.fromEntries(LAB_SWITCHES.map((s) => [s.o + "." + s.k, Engine[s.o][s.k]]));
const labRead = () => {
  try {
    return JSON.parse(localStorage.getItem(LAB_KEY) || "null") || {};
  } catch (e) {
    return {};
  }
};
export const lab = { set: {}, race: 0, N: 10000, compare: true, pos: "r", lapv: "pos", tab: "assets", ...labRead() };
export const labSave = () => {
  try {
    localStorage.setItem(LAB_KEY, JSON.stringify(lab));
  } catch (e) {}
};
const labVal = (s) => {
  const k = s.o + "." + s.k;
  return k in lab.set ? lab.set[k] : LAB_SHIPPED[k];
};
const labChanged = () => LAB_SWITCHES.filter((s) => labVal(s) !== LAB_SHIPPED[s.o + "." + s.k]);

// the gate: an `owners` row for the signed-in account (or ?lab=1 on this machine)
export async function labCheck() {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("lab");
  let ok = local;
  const U = syncState.user;
  if (!ok && U && syncState.sb) {
    const { data } = await syncState.sb.from("owners").select("user_id").eq("user_id", U.id).maybeSingle();
    ok = !!data && U === syncState.user;
  }
  labSetOwner(ok);
}
function labSetOwner(ok) {
  labOwner = ok && !SEASON_OVER;
  $("#labNav").hidden = !labOwner;
  const m = $("#menuList [data-view=lab]");
  if (labOwner && !m)
    $("#menuList").insertAdjacentHTML(
      "beforeend",
      `<button data-view="lab">${$("#labNav svg").outerHTML}<span>Sim lab</span></button>`,
    );
  if (!labOwner && m) m.remove();
  // before start-up has computed anything, showView() itself keeps a non-owner out of the lab
  if (!labOwner && state.view === "lab" && forecast) showView("calc");
}

/* ---------- a run ---------- */
// apply the lab's switches to the engine for fn(), then put the shipped values back
function withLab(set, fn) {
  const keep = LAB_SWITCHES.map((s) => Engine[s.o][s.k]);
  LAB_SWITCHES.forEach((s) => {
    const k = s.o + "." + s.k;
    if (k in set) Engine[s.o][s.k] = set[k];
  });
  try {
    return fn();
  } finally {
    LAB_SWITCHES.forEach((s, i) => (Engine[s.o][s.k] = keep[i]));
  }
}
// one race's simulation under a set of switches, with this page's settings (penalties and circuit edits for the
// next race, sims from the lab)
function labSim(set, g, k, N) {
  return withLab(set, () => {
    const tm = Engine.trackModel(DATA);
    const setup = Engine.raceSetup(DATA, g, {
      next: k === 0,
      track: tm,
      halfLife: state.halfLife,
      adj: state.adj,
      pw: Engine.MODEL.practiceQ,
      oddsW: Engine.SIM.oddsW,
      pen: k === 0 ? state.pen : {},
      circuit: state.circuits[g.gd] || {},
    });
    const t0 = performance.now();
    const sim = Engine.simulate(setup.model, setup.circuit, k === 0 ? sprintNext() : g.sprint, N, g.gd * 7919 + 13, {
      ...setup.simOpt,
      trace: true,
    });
    return { setup, sim, ms: performance.now() - t0 };
  });
}
export function labRerun() {
  const races = upcoming.slice(0, 3);
  const k = Math.min(lab.race, races.length - 1),
    g = races[k];
  if (!g) return;
  $("#labStatus").textContent = "Running…";
  document.body.classList.add("busy");
  setTimeout(() => {
    const changed = labChanged();
    const run = labSim(lab.set, g, k, lab.N);
    const base = changed.length && lab.compare ? labSim({}, g, k, lab.N) : null;
    labRun = { g, k, N: lab.N, ...run, base, changed };
    document.body.classList.remove("busy");
    renderLab();
  }, 30);
}

/* ---------- panels ---------- */
const labQ = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
// price change after the race from the simulated weekends (the game's rule), like the Budget view
function labPrice(a, sim, i) {
  const h = a.hist.filter(Boolean);
  const sum2 = (h.length ? h[h.length - 1].pts : 0) + (h.length > 1 ? h[h.length - 2].pts : 0),
    n = Math.min(3, h.length + 1),
    N = sim.N;
  let up = 0,
    down = 0,
    ev = 0;
  for (let s = 0; s < N; s++) {
    const d = Math.round(Engine.priceStep(a.price, (sum2 + sim.tot[i * N + s]) / n) * 10) / 10;
    ev += d;
    if (d > 0) up++;
    if (d < 0) down++;
  }
  return { up: up / N, down: down / N, ev: ev / N };
}
function labRows(run) {
  const { sim, setup } = run;
  const drv = Object.fromEntries(setup.model.drivers.map((d) => [d.id, d]));
  return sim.ids
    .map((id, i) => {
      const a = byId[id];
      if (!a) return null;
      const st = sim.stats[i],
        d = drv[id];
      return { a, i, st, d, pr: labPrice(a, sim, i) };
    })
    .filter(Boolean)
    .sort((x, y) => y.st.mean - x.st.mean);
}
const labF2 = (v) => (v == null || isNaN(v) ? "" : v.toFixed(2));
function labAssetTable(rows, base) {
  const bIdx = base ? Object.fromEntries(base.sim.ids.map((id, i) => [id, base.sim.stats[i].mean])) : null;
  const head =
    `<th>Asset</th><th>$</th><th title="Qualifying pace, % off the fastest">Q pace</th><th title="Race pace, % off the fastest">R pace</th>` +
    `<th>DNF</th><th>FL</th><th>DotD</th><th title="Expected overtake points">xOV</th><th>p25</th><th>xPts</th><th>p75</th>` +
    `<th title="xPts per $1m">xPPM</th><th>P(rise)</th><th>P(drop)</th>${bIdx ? '<th title="xPts vs the shipped model, same seed">Δ shipped</th>' : ""}`;
  const body = rows
    .map(({ a, st, d, pr }) => {
      const dx = bIdx ? st.mean - bIdx[a.id] : 0;
      return (
        `<tr><td>${who(a)}</td><td>${a.price.toFixed(1)}</td><td>${d ? labF2(d.qPace) : ""}</td><td>${d ? labF2(d.rPace) : ""}</td>` +
        `<td>${a.kind === "D" ? pct(st.dnf) : ""}</td><td>${a.kind === "D" ? pct(st.fl) : ""}</td><td>${a.kind === "D" ? pct(st.dotd) : ""}</td>` +
        `<td>${a.kind === "D" ? f1(st.xov) : ""}</td><td>${f1(st.p25)}</td><td><b>${f1(st.mean)}</b></td><td>${f1(st.p75)}</td>` +
        `<td>${labF2(st.mean / a.price)}</td><td${heat(pr.up, -1, 1)}>${pct(pr.up)}</td><td${heat(-pr.down, -1, 1)}>${pct(pr.down)}</td>` +
        (bIdx ? `<td${heat(dx, -5, 5)}>${sgn(dx)}</td>` : "") +
        "</tr>"
      );
    })
    .join("");
  return `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}
function labMatrix(rows, sim) {
  const q = lab.pos === "q",
    F = sim.field,
    cols = q ? F : F + 1;
  const dr = rows.filter((r) => r.a.kind === "D" && r.st[q ? "q" : "r"]);
  const exp = (v) =>
    v.slice(0, F).reduce((s, p, i) => s + p * (i + 1), 0) /
    Math.max(
      1e-9,
      v.slice(0, F).reduce((s, p) => s + p, 0),
    );
  dr.sort((x, y) => exp(x.st[q ? "q" : "r"]) - exp(y.st[q ? "q" : "r"]));
  return (
    `<thead><tr><th>DR</th><th title="Average position">Avg</th>${Array.from({ length: cols }, (_, i) => `<th>${i === F ? "DNF" : "P" + (i + 1)}</th>`).join("")}</tr></thead><tbody>` +
    dr
      .map(({ a, st }) => {
        const v = st[q ? "q" : "r"];
        return (
          `<tr><td>${codeBox(a)}</td><td>${exp(v).toFixed(1)}</td>` +
          v
            .slice(0, cols)
            .map((p, i) => {
              const c = i === F ? "239,68,68" : "168,85,247";
              return `<td style="background-color:rgba(${c},${Math.min(0.85, p * 2.6).toFixed(3)})">${Math.round(p * 100) || ""}</td>`;
            })
            .join("") +
          "</tr>"
        );
      })
      .join("") +
    "</tbody>"
  );
}
// xPts against price: value on the diagonal
function labScatter(rows) {
  const W = 640,
    H = 300,
    P = 36;
  const xs = rows.map((r) => r.a.price),
    ys = rows.map((r) => r.st.mean);
  const x0 = Math.floor(Math.min(...xs)),
    x1 = Math.ceil(Math.max(...xs)),
    y0 = Math.floor(Math.min(0, ...ys) / 10) * 10,
    y1 = Math.ceil(Math.max(...ys) / 10) * 10;
  const X = (v) => P + ((v - x0) / (x1 - x0 || 1)) * (W - P - 10),
    Y = (v) => H - P + 10 - ((v - y0) / (y1 - y0 || 1)) * (H - P);
  let s = `<svg viewBox="0 0 ${W} ${H + 10}" class="labsvg" role="img" aria-label="Expected points against price">`;
  for (let v = y0; v <= y1; v += 10)
    s += `<line x1="${P}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${P - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let v = x0; v <= x1; v += Math.max(1, Math.round((x1 - x0) / 8)))
    s += `<text x="${X(v)}" y="${H + 6}" text-anchor="middle">$${v}m</text>`;
  for (const { a, st } of rows) {
    const cx = X(a.price),
      cy = Y(st.mean);
    s +=
      a.kind === "D"
        ? `<circle cx="${cx}" cy="${cy}" r="5" fill="${col(a)}"><title>${esc(code(a))}: ${f1(st.mean)} xPts, $${a.price}m</title></circle>`
        : `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" fill="${col(a)}"><title>${esc(a.team)}: ${f1(st.mean)} xPts, $${a.price}m</title></rect>`;
    s += `<text x="${cx + 7}" y="${cy + 4}">${esc(code(a))}</text>`;
  }
  return s + "</svg>";
}
// each asset's simulated points as a histogram strip (shaded p25-p75, mean tick), on one shared scale
function labStrips(rows, sim) {
  const N = sim.N,
    lo = -30,
    hi = 90,
    B = 40,
    w = 260,
    h = 22;
  const bx = (v) => ((v - lo) / (hi - lo)) * w;
  return rows
    .map(({ a, i, st }) => {
      const c = new Array(B).fill(0);
      for (let s = 0; s < N; s++) {
        const v = sim.tot[i * N + s];
        c[Math.max(0, Math.min(B - 1, Math.floor(((v - lo) / (hi - lo)) * B)))]++;
      }
      const m = Math.max(...c) || 1;
      let bars = "";
      c.forEach((n, k) => {
        const bh = (n / m) * (h - 2);
        if (bh > 0.2)
          bars += `<rect x="${(k * w) / B}" y="${h - bh}" width="${w / B - 0.5}" height="${bh}" fill="${col(a)}" opacity=".75"/>`;
      });
      return (
        `<div class="labstrip">${codeBox(a)}<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
        `<rect x="${bx(st.p25)}" y="0" width="${Math.max(1, bx(st.p75) - bx(st.p25))}" height="${h}" class="band"/>${bars}` +
        `<line x1="${bx(st.mean)}" x2="${bx(st.mean)}" y1="0" y2="${h}" class="mk"/></svg><span class="dim">${f1(st.p10)} · <b>${f1(st.mean)}</b> · ${f1(st.p90)}</span></div>`
      );
    })
    .join("");
}
// the starting team's total per simulated weekend (Boost doubled; "auto" = the top projected driver)
function labTeam(run) {
  const T = startTeam();
  if (!T || !T.team || T.team.length < 7) return `<p class="note">No starting team set in the Calculator.</p>`;
  const tot = (r) => {
    const { sim } = r,
      N = sim.N,
      idx = Object.fromEntries(sim.ids.map((id, i) => [id, i]));
    const ids = T.team.filter((id) => idx[id] != null);
    const drivers = ids.filter((id) => byId[id].kind === "D");
    const boost =
      T.boost && T.boost !== "auto" && idx[T.boost] != null
        ? T.boost
        : drivers.sort((x, y) => sim.stats[idx[y]].mean - sim.stats[idx[x]].mean)[0];
    const out = new Float64Array(N);
    for (let s = 0; s < N; s++) {
      let t = 0;
      for (const id of ids) t += sim.tot[idx[id] * N + s];
      if (boost) t += sim.tot[idx[boost] * N + s];
      out[s] = t;
    }
    return Array.from(out).sort((a, b) => a - b);
  };
  const a = tot(run),
    b = run.base ? tot(run.base) : null;
  const all = b ? a.concat(b) : a,
    lo = Math.floor(labQ(all, 0.005) / 10) * 10,
    hi = Math.ceil(labQ(all, 0.995) / 10) * 10;
  const W = 640,
    H = 160,
    B = 48;
  const hist = (arr) => {
    const c = new Array(B).fill(0);
    for (const v of arr) c[Math.max(0, Math.min(B - 1, Math.floor(((v - lo) / (hi - lo || 1)) * B)))]++;
    return c;
  };
  const ca = hist(a),
    cb = b ? hist(b) : null,
    m = Math.max(...ca, ...(cb || [0]));
  const X = (v) => ((v - lo) / (hi - lo || 1)) * W;
  let s = `<svg viewBox="0 0 ${W} ${H + 18}" class="labsvg" role="img" aria-label="Team points distribution">`;
  ca.forEach(
    (n, k) =>
      (s += `<rect x="${(k * W) / B}" y="${H - (n / m) * H}" width="${W / B - 1}" height="${(n / m) * H}" fill="var(--accent)" opacity=".7"/>`),
  );
  if (cb) {
    let d = "";
    cb.forEach((n, k) => (d += `${k ? "L" : "M"}${(k * W) / B + W / B / 2},${H - (n / m) * H}`));
    s += `<path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  }
  for (let v = lo; v <= hi; v += Math.max(10, Math.round((hi - lo) / 80) * 10))
    s += `<text x="${X(v)}" y="${H + 14}" text-anchor="middle">${v}</text>`;
  s += "</svg>";
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  const line = (arr) =>
    `p10 ${f1(labQ(arr, 0.1))} · p50 ${f1(labQ(arr, 0.5))} · mean <b>${f1(mean(arr))}</b> · p90 ${f1(labQ(arr, 0.9))}`;
  return (
    `<p class="note">${esc(T.name || "Starting team")}: ${line(a)}${b ? `<br><span class="dim">Shipped model (dashed): ${line(b)}</span>` : ""}</p>` +
    s
  );
}

// average position (or gap to the leader) at each lap end, per driver, from the lap races' traces
function labLaps(run) {
  const L = run.sim.laps;
  if (!L)
    return `<p class="note">Only the lap races record laps: set Race model to "Lap by lap" or "Timing segments" and Rerun.</p>`;
  const fieldMode = lab.lapv === "field",
    gapMode = lab.lapv === "gap" || fieldMode,
    D = run.setup.model.drivers;
  const T = startTeam(),
    mine = new Set((T && T.team) || []);
  const W = 720,
    H = 340,
    PL = 34,
    PR = 44,
    PT = 8,
    PB = 22;
  let vals = gapMode ? L.gap : L.pos;
  if (fieldMode) {
    const mean = Array.from({ length: L.n }, (_, l) => {
      let s = 0,
        n = 0;
      for (const v of L.gap)
        if (isFinite(v[l])) {
          s += v[l];
          n++;
        }
      return n ? s / n : 0;
    });
    vals = L.gap.map((v) => v.map((x, l) => x - mean[l]));
  }
  let ymin = fieldMode ? 0 : gapMode ? 0 : 1,
    ymax = gapMode ? 0 : D.length;
  if (gapMode)
    for (const v of vals)
      for (const x of v)
        if (isFinite(x)) {
          ymax = Math.max(ymax, x);
          ymin = Math.min(ymin, x);
        }
  if (gapMode) {
    ymax = Math.ceil(ymax / 10) * 10;
    ymin = Math.floor(ymin / 10) * 10;
  }
  const X = (l) => PL + (l / Math.max(1, L.n - 1)) * (W - PL - PR),
    Y = (v) => PT + ((v - ymin) / Math.max(1, ymax - ymin)) * (H - PT - PB);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="labsvg" role="img" aria-label="${gapMode ? "Gap to the leader" : "Average position"} by lap">`;
  const step = gapMode ? Math.max(10, Math.round((ymax - ymin) / 60) * 10) : 5;
  for (let v = ymin; v <= ymax; v += step)
    s += `<line x1="${PL}" x2="${W - PR}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${PL - 6}" y="${Y(v) + 4}" text-anchor="end">${gapMode ? (v > 0 ? "+" : "") + v + "s" : "P" + v}</text>`;
  for (let l = 0; l < L.n; l += Math.max(5, Math.round(L.n / 60) * 10))
    s += `<text x="${X(l)}" y="${H - 6}" text-anchor="middle">L${l + 1}</text>`;
  // your team drawn last (on top), bolder
  const order = D.map((d, i) => i).sort((a, b) => (mine.has(D[a].id) ? 1 : 0) - (mine.has(D[b].id) ? 1 : 0));
  for (const i of order) {
    const a = byId[D[i].id];
    if (!a) continue;
    let dPath = "",
      last = null;
    vals[i].forEach((v, l) => {
      if (!isFinite(v)) return;
      dPath += `${dPath ? "L" : "M"}${X(l).toFixed(1)},${Y(v).toFixed(1)}`;
      last = [l, v];
    });
    if (!last) continue;
    const bold = mine.has(a.id);
    s += `<path d="${dPath}" fill="none" stroke="${col(a)}" stroke-width="${bold ? 2.5 : 1.2}" opacity="${bold ? 1 : 0.55}"><title>${esc(code(a))}</title></path>`;
    s += `<text x="${X(last[0]) + 4}" y="${Y(last[1]) + 4}"${bold ? ' style="fill:var(--fg);font-weight:600"' : ""}>${esc(code(a))}</text>`;
  }
  s += "</svg>";
  return (
    `<p class="note">${fieldMode ? "Average time against the running field's average at each lap end (s; up = faster)" : gapMode ? "Average gap to the leader at each lap end (cars still running)" : "Average position at each lap end among cars still running"} over ${run.N.toLocaleString()} races; your starting team in bold. Pit stops show as the dip in the middle of the race.</p>` +
    s
  );
}

/* ---------- more panels, in the spirit of the community's sim posts but all from our own simulations ---------- */
// a violin: the samples' density (histogram, lightly smoothed) mirrored around x, with the 5 / 25 / 50 / 75 / 95%
// ticks labelled on the left; Y maps points to pixels
function labViolin(sorted, x, halfW, Y, lo, hi, color) {
  const B = 48,
    c = new Array(B).fill(0);
  for (const v of sorted) c[Math.max(0, Math.min(B - 1, Math.floor(((v - lo) / (hi - lo || 1)) * B)))]++;
  const sm = c.map((v, k) => (c[k - 1] || 0) * 0.25 + v * 0.5 + (c[k + 1] || 0) * 0.25);
  const m = Math.max(...sm) || 1;
  let right = "",
    left = "";
  sm.forEach((v, k) => {
    const y = Y(lo + ((k + 0.5) / B) * (hi - lo)).toFixed(1),
      w = ((v / m) * halfW).toFixed(1);
    right += `${k ? "L" : "M"}${(x + +w).toFixed(1)},${y}`;
    left = `L${(x - +w).toFixed(1)},${y}` + left;
  });
  let s = `<path d="${right}${left}Z" fill="${color}" opacity=".8"/>`;
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const v = labQ(sorted, p),
      y = Y(v).toFixed(1),
      w = p === 0.5 ? halfW : halfW * 0.6;
    s += `<line x1="${x - w}" x2="${x + w}" y1="${y}" y2="${y}" class="vt"/>`;
    if (p !== 0.05 && p !== 0.95)
      s += `<text x="${x - halfW - 2}" y="${+y + 3}" text-anchor="end" class="vl">${Math.round(v)}</text>`;
  }
  return s;
}
// per-simulation totals of a line-up (Boost counted twice)
function labTeamTot(sim, ids, boost) {
  const N = sim.N,
    idx = Object.fromEntries(sim.ids.map((id, i) => [id, i])),
    out = new Float64Array(N);
  for (let s = 0; s < N; s++) {
    let t = 0;
    for (const id of ids) if (idx[id] != null) t += sim.tot[idx[id] * N + s];
    if (boost && idx[boost] != null) t += sim.tot[idx[boost] * N + s];
    out[s] = t;
  }
  return Array.from(out).sort((a, b) => a - b);
}
// the best teams within your budget (Calculator's starting team: its value + bank; else $100m), each a violin
function labTeams(run, rows) {
  const T = startTeam(),
    hasTeam = T && T.team && T.team.length === 7;
  const cap = hasTeam ? T.team.reduce((s, id) => s + (byId[id] ? byId[id].price : 0), 0) + (T.bank || 0) : 100;
  const pr = Object.fromEntries(rows.map((r) => [r.a.id, r]));
  const cand = rows
    .filter((r) => r.a.active || r.a.kind === "C")
    .map((r) => ({
      id: r.a.id,
      kind: r.a.kind,
      price: r.a.price,
      e: r.st.mean,
      boostE: r.a.kind === "D" ? r.st.mean : 0,
      active: true,
    }));
  const teams = Engine.optimise(cand, [], { cap, free: 7, maxT: 7, locks: new Set(), bans: new Set(), top: 24 });
  const list = teams.map((t) => ({ ids: [...t.cons, ...t.drivers], boost: t.boost, label: "" }));
  if (hasTeam) {
    const drivers = T.team.filter((id) => byId[id] && byId[id].kind === "D");
    const boost =
      T.boost && T.boost !== "auto"
        ? T.boost
        : drivers.slice().sort((a, b) => (pr[b] ? pr[b].st.mean : 0) - (pr[a] ? pr[a].st.mean : 0))[0];
    list.push({
      ids: T.team.slice().sort((a, b) => (byId[a].kind === "C" ? -1 : 1) - (byId[b].kind === "C" ? -1 : 1)),
      boost,
      label: "Yours",
    });
  }
  const dist = list.map((t) => labTeamTot(run.sim, t.ids, t.boost));
  const lo = Math.floor(Math.min(...dist.map((d) => labQ(d, 0.01))) / 50) * 50,
    hi = Math.ceil(Math.max(...dist.map((d) => labQ(d, 0.99))) / 50) * 50;
  const colW = 64,
    W = 40 + colW * list.length,
    top = 58,
    H = 300,
    bot = 90;
  const Y = (v) => top + (1 - (v - lo) / (hi - lo || 1)) * H;
  let s = `<svg viewBox="0 0 ${W} ${top + H + bot}" width="${W}" class="labsvg labteams" role="img" aria-label="Team points distributions">`;
  for (let v = lo; v <= hi; v += 50)
    s += `<line x1="30" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="26" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  list.forEach((t, k) => {
    const x = 40 + colW * k + colW / 2,
      d = dist[k],
      mean = d.reduce((a, b) => a + b, 0) / d.length;
    const price = t.ids.reduce((a, id) => a + byId[id].price, 0),
      dp = t.ids.reduce((a, id) => a + (pr[id] ? pr[id].pr.ev : 0), 0);
    if (t.label)
      s += `<rect x="${x - colW / 2 + 2}" y="2" width="${colW - 4}" height="${top + H + bot - 4}" rx="6" class="mine"/>`;
    s += `<text x="${x}" y="14" text-anchor="middle">$${price.toFixed(1)}m</text><text x="${x}" y="28" text-anchor="middle" class="hi">${mean.toFixed(1)}</text><text x="${x}" y="42" text-anchor="middle">${dp >= 0 ? "+" : ""}${dp.toFixed(2)}m</text>`;
    s += labViolin(d, x, colW * 0.36, Y, lo, hi, t.label ? "var(--accent)" : "#14b8a6");
    const names = t.ids.map((id) => (id === t.boost ? code(byId[id]) + "×2" : code(byId[id])));
    names.forEach(
      (n, j) =>
        (s += `<text x="${x}" y="${top + H + 16 + j * 11}" text-anchor="middle"${j < 2 ? ' class="hi"' : ""}>${esc(n)}</text>`),
    );
    if (t.label) s += `<text x="${x}" y="${top + H + 16 + 7 * 11}" text-anchor="middle" class="hi">${t.label}</text>`;
  });
  s += "</svg>";
  return (
    `<p class="note">The ${teams.length} best teams within $${cap.toFixed(1)}m${hasTeam ? " (your starting team's value + bank)" : ""} by expected points, each simulated weekend's total (Boost ×2; no transfers or chips). Above: price, xPts, expected budget change after the race. Ticks: 5 / 25 / 50 / 75 / 95%.</p>` +
    `<div class="tw">${s}</div>`
  );
}
// points and points per $1m of every asset, as violins sorted by xPts per $1m (drivers and constructors apart)
function labAssetViolins(run, rows) {
  const part = (kind, perM) => {
    const rs = rows.filter((r) => r.a.kind === kind).sort((x, y) => y.st.mean / y.a.price - x.st.mean / x.a.price);
    const N = run.sim.N;
    const dist = rs.map((r) => {
      const v = Array.from(run.sim.tot.subarray(r.i * N, r.i * N + N), (x) => (perM ? x / r.a.price : x));
      return v.sort((a, b) => a - b);
    });
    let lo = Math.min(...dist.map((d) => labQ(d, 0.01))),
      hi = Math.max(...dist.map((d) => labQ(d, 0.99)));
    const step = perM ? 1 : 20;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const colW = 44,
      W = 40 + colW * rs.length,
      H = 230;
    const Y = (v) => 8 + (1 - (v - lo) / (hi - lo || 1)) * H;
    let s = `<svg viewBox="0 0 ${W} ${H + 30}" width="${W}" class="labsvg" role="img" aria-label="${kind === "D" ? "Driver" : "Constructor"} ${perM ? "points per $1m" : "points"}">`;
    for (let v = lo; v <= hi; v += step)
      s += `<line x1="30" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="26" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    rs.forEach((r, k) => {
      const x = 40 + colW * k + colW / 2;
      s += labViolin(dist[k], x, colW * 0.4, Y, lo, hi, col(r.a));
      s += `<text x="${x}" y="${H + 24}" text-anchor="middle">${esc(code(r.a))}</text>`;
    });
    return `<div class="tw">${s}</div>`;
  };
  return (
    `<h4 class="labh">Constructors · points per $1m</h4>${part("C", true)}<h4 class="labh">Drivers · points per $1m</h4>${part("D", true)}` +
    `<h4 class="labh">Constructors · points</h4>${part("C", false)}<h4 class="labh">Drivers · points</h4>${part("D", false)}`
  );
}
// every constructor pair and every 5-driver combination: summed xPts against summed price, with a fitted line
function labCombos(rows) {
  const C = rows.filter((r) => r.a.kind === "C"),
    D = rows.filter((r) => r.a.kind === "D" && r.a.active);
  const fit = (pts) => {
    const n = pts.length,
      mx = pts.reduce((a, p) => a + p[0], 0) / n,
      my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0,
      sxx = 0;
    for (const [x, y] of pts) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    }
    const b = sxx ? sxy / sxx : 0;
    return { b, a: my - b * mx };
  };
  const pairs = [];
  for (let i = 0; i < C.length; i++)
    for (let j = i + 1; j < C.length; j++) {
      const p = C[i].a.price + C[j].a.price,
        x = C[i].st.mean + C[j].st.mean;
      pairs.push({ i: C[i], j: C[j], p, x });
    }
  const fc = fit(pairs.map((q) => [q.p, q.x]));
  // constructor pairs: SVG scatter
  const W = 420,
    H = 280,
    P = 34;
  const xs = pairs.map((q) => q.p),
    ys = pairs.map((q) => q.x);
  const x0 = 0,
    x1 = Math.ceil(Math.max(...xs) / 10) * 10,
    y0 = Math.floor(Math.min(0, ...ys, fc.a) / 25) * 25,
    y1 = Math.ceil(Math.max(...ys) / 25) * 25;
  const X = (v) => P + ((v - x0) / (x1 - x0)) * (W - P - 8),
    Yc = (v) => 8 + (1 - (v - y0) / (y1 - y0)) * (H - P);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="labsvg" role="img" aria-label="Constructor pairs: xPts against price">`;
  for (let v = y0; v <= y1; v += 25)
    s += `<line x1="${P}" x2="${W - 8}" y1="${Yc(v)}" y2="${Yc(v)}" class="gl"/><text x="${P - 4}" y="${Yc(v) + 4}" text-anchor="end">${v}</text>`;
  for (let v = x0; v <= x1; v += 10) s += `<text x="${X(v)}" y="${H - 8}" text-anchor="middle">${v}</text>`;
  s += `<line x1="${X(x0)}" x2="${X(x1)}" y1="${Yc(fc.a + fc.b * x0)}" y2="${Yc(fc.a + fc.b * x1)}" stroke="var(--fg)" stroke-width="1"/>`;
  for (const q of pairs)
    s += `<circle cx="${X(q.p)}" cy="${Yc(q.x)}" r="4" fill="${col(q.i.a)}" stroke="${col(q.j.a)}" stroke-width="2"><title>${esc(code(q.i.a))} + ${esc(code(q.j.a))}: ${q.x.toFixed(1)} xPts, $${q.p.toFixed(1)}m</title></circle>`;
  s += "</svg>";
  const table =
    `<table class="stat labmini"><thead><tr><th>CR1</th><th>CR2</th><th>$</th><th>xPts</th><th>xPts/$m</th></tr></thead><tbody>` +
    pairs
      .sort((a, b) => b.x / b.p - a.x / a.p)
      .map(
        (q) =>
          `<tr><td>${codeBox(q.i.a)}</td><td>${codeBox(q.j.a)}</td><td>${q.p.toFixed(1)}</td><td>${q.x.toFixed(1)}</td><td>${(q.x / q.p).toFixed(3)}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  // 5-driver combinations: counted and fitted here, drawn on a canvas after the HTML is in place
  let n = 0;
  const combos = [];
  const k5 = D.length;
  for (let a = 0; a < k5; a++)
    for (let b = a + 1; b < k5; b++)
      for (let c = b + 1; c < k5; c++)
        for (let d = c + 1; d < k5; d++)
          for (let e = d + 1; e < k5; e++) {
            const m = [D[a], D[b], D[c], D[d], D[e]];
            let p = 0,
              x = 0,
              top = m[0];
            for (const r of m) {
              p += r.a.price;
              x += r.st.mean;
              if (r.a.price > top.a.price) top = r;
            }
            combos.push([p, x, top.a]);
            n++;
          }
  const fd = fit(combos);
  labRun.combos = { combos, fd };
  return (
    `<div class="labgrid"><div><h4 class="labh">${pairs.length} constructor pairs: xPts = ${fc.b.toFixed(3)} × $m ${fc.a >= 0 ? "+" : "−"} ${Math.abs(fc.a).toFixed(2)}</h4>${s}` +
    `<div class="tw labscroll">${table}</div></div>` +
    `<div><h4 class="labh">${n.toLocaleString()} driver combinations (5 drivers, no Boost): xPts = ${fd.b.toFixed(3)} × $m ${fd.a >= 0 ? "+" : "−"} ${Math.abs(fd.a).toFixed(2)}</h4>` +
    `<canvas id="labCombos" width="840" height="620" class="labcanvas" aria-label="Driver combinations: xPts against price"></canvas>` +
    `<p class="note">Each dot is a 5-driver line-up, coloured by its most expensive driver's team. Above the line = more points than its price buys on average.</p></div></div>`
  );
}
function labDrawCombos() {
  const cv = $("#labCombos");
  if (!cv || !labRun || !labRun.combos) return;
  const { combos, fd } = labRun.combos;
  const ctx = cv.getContext("2d"),
    W = cv.width,
    H = cv.height,
    P = 56;
  const css = getComputedStyle(document.body);
  const dim = css.getPropertyValue("--dim").trim() || "#8b8b94",
    line = css.getPropertyValue("--line").trim() || "#27272a",
    fg = css.getPropertyValue("--fg").trim() || "#fafafa";
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [p, x] of combos) {
    x0 = Math.min(x0, p);
    x1 = Math.max(x1, p);
    y0 = Math.min(y0, x);
    y1 = Math.max(y1, x);
  }
  x0 = Math.floor(x0 / 10) * 10;
  x1 = Math.ceil(x1 / 10) * 10;
  y0 = Math.floor(Math.min(y0, 0) / 25) * 25;
  y1 = Math.ceil(y1 / 25) * 25;
  const X = (v) => P + ((v - x0) / (x1 - x0)) * (W - P - 16),
    Y = (v) => 16 + (1 - (v - y0) / (y1 - y0)) * (H - P - 16);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "22px Inter, system-ui, sans-serif";
  ctx.fillStyle = dim;
  ctx.strokeStyle = line;
  ctx.textAlign = "right";
  for (let v = y0; v <= y1; v += 25) {
    ctx.beginPath();
    ctx.moveTo(P, Y(v));
    ctx.lineTo(W - 16, Y(v));
    ctx.stroke();
    ctx.fillText(String(v), P - 8, Y(v) + 7);
  }
  ctx.textAlign = "center";
  for (let v = x0; v <= x1; v += 20) ctx.fillText("$" + v + "m", X(v), H - 16);
  ctx.globalAlpha = 0.55;
  for (const [p, x, top] of combos) {
    ctx.fillStyle = col(top);
    ctx.fillRect(X(p) - 1.5, Y(x) - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = fg;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(x0), Y(fd.a + fd.b * x0));
  ctx.lineTo(X(x1), Y(fd.a + fd.b * x1));
  ctx.stroke();
}
// price change after the race: the full distribution per asset (the game's steps), and the average
function labPriceMatrix(run, rows) {
  const N = run.sim.N;
  const body = (kind) =>
    rows
      .filter((r) => r.a.kind === kind)
      .map((r) => {
        const h = r.a.hist.filter(Boolean);
        const sum2 = (h.length ? h[h.length - 1].pts : 0) + (h.length > 1 ? h[h.length - 2].pts : 0),
          n = Math.min(3, h.length + 1),
          dist = BINS.map(() => 0);
        let ev = 0;
        for (let s = 0; s < N; s++) {
          const d = Math.round(Engine.priceStep(r.a.price, (sum2 + run.sim.tot[r.i * N + s]) / n) * 10) / 10;
          ev += d;
          let k = BINS.indexOf(d);
          if (k < 0) k = BINS.reduce((b, v, j) => (Math.abs(v - d) < Math.abs(BINS[b] - d) ? j : b), 0);
          dist[k]++;
        }
        return { r, dist: dist.map((v) => v / N), ev: ev / N };
      })
      .sort((a, b) => b.ev - a.ev)
      .map(
        ({ r, dist, ev }) =>
          `<tr><td>${codeBox(r.a)}</td>${dist
            .map((p, k) => {
              const c = BINS[k] > 0 ? "34,197,94" : BINS[k] < 0 ? "239,68,68" : "139,139,148";
              return `<td style="background-color:rgba(${c},${Math.min(0.7, p * 1.2).toFixed(3)})">${Math.round(p * 100) || ""}</td>`;
            })
            .join("")}<td${heat(ev, -0.6, 0.6)}><b>${ev >= 0 ? "+" : "−"}${Math.abs(ev).toFixed(3)}</b></td></tr>`,
      )
      .join("");
  const head = `<thead><tr><th></th>${BINS.map((b) => `<th>${b > 0 ? "+" : b < 0 ? "−" : ""}${Math.abs(b).toFixed(1)}</th>`).join("")}<th>avg</th></tr></thead>`;
  return `<div class="labgrid"><div class="tw"><table class="heat">${head}<tbody>${body("D")}</tbody></table></div><div class="tw"><table class="heat">${head}<tbody>${body("C")}</tbody></table></div></div>`;
}
// constructors: their two cars' average qualifying -> race positions, pit points, range and value
function labConsTable(run, rows) {
  const avg = (v, F) => {
    if (!v) return NaN;
    const w = v.slice(0, F).reduce((s, p) => s + p, 0);
    return v.slice(0, F).reduce((s, p, i) => s + p * (i + 1), 0) / Math.max(1e-9, w);
  };
  const F = run.sim.field;
  const body = rows
    .filter((r) => r.a.kind === "C")
    .map((r) => {
      const ds = rows.filter((x) => x.a.kind === "D" && x.a.team === r.a.team && x.a.active);
      const cells = ds
        .map((x) => `${codeBox(x.a)} ${avg(x.st.q, F).toFixed(1)} → ${avg(x.st.r, F).toFixed(1)}`)
        .join('<span class="dim"> · </span>');
      return `<tr><td>${who(r.a)}</td><td>${cells}</td><td>${f1(r.st.pit)}</td><td>${f1(r.st.p25)}</td><td><b>${f1(r.st.mean)}</b></td><td>${f1(r.st.p75)}</td><td>${labF2(r.st.mean / r.a.price)}</td></tr>`;
    })
    .join("");
  return `<table class="stat"><thead><tr><th>Constructor</th><th title="Each car's average qualifying → race position">Avg qualifying → race</th><th title="Expected pit-stop points">xPit</th><th>p25</th><th>xPts</th><th>p75</th><th>xPPM</th></tr></thead><tbody>${body}</tbody></table>`;
}
// this weekend's practice: each team's short-run pace per session (best lap or best-sector sum), as % of the fastest
function labPractice(run) {
  if (run.k !== 0) return `<p class="note">Practice exists for the next race only.</p>`;
  const S = (DATA.practice || []).filter((p) => p.done);
  if (!S.length) return `<p class="note">No practice yet for ${esc(run.g.name)}.</p>`;
  const teamOf = Object.fromEntries(DATA.assets.filter((a) => a.kind === "D" && a.active).map((a) => [a.tla, a.team]));
  const teams = {};
  for (const s of S)
    for (const [t, d] of Object.entries(s.drivers)) {
      const tm = teamOf[t];
      if (!tm || d.q == null) continue;
      const e = (teams[tm] = teams[tm] || { best: Infinity, by: {} });
      e.by[s.name] = Math.min(e.by[s.name] ?? Infinity, d.q);
    }
  // the bar: the latest session (closest to qualifying); the other sessions as marks
  const last = S[S.length - 1].name;
  for (const e of Object.values(teams)) e.best = e.by[last] ?? Infinity;
  const list = Object.entries(teams)
    .filter(([, e]) => isFinite(e.best))
    .sort((a, b) => a[1].best - b[1].best);
  const lead = list.length ? list[0][1].best : 0,
    hi = Math.max(...list.map(([, e]) => Math.max(...Object.values(e.by)))) - lead || 1;
  const W = 520,
    rowH = 26,
    L = 70,
    R = 70;
  const X = (v) => L + ((v - lead) / hi) * (W - L - R);
  let s = `<svg viewBox="0 0 ${W} ${list.length * rowH + 24}" class="labsvg" role="img" aria-label="Practice pace by team">`;
  const marks = ["▮", "◆", "●"];
  list.forEach(([tm, e], k) => {
    const y = 16 + k * rowH,
      a = DATA.assets.find((x) => x.kind === "C" && x.team === tm);
    s += `<text x="${L - 8}" y="${y + 5}" text-anchor="end" class="hi">${esc(a ? code(a) : tm)}</text>`;
    s += `<line x1="${X(lead)}" x2="${X(e.best)}" y1="${y}" y2="${y}" stroke="${a ? col(a) : "var(--dim)"}" stroke-width="8" stroke-linecap="round" opacity=".85"/>`;
    Object.entries(e.by).forEach(([name], j) => {
      const v = e.by[name];
      s += `<text x="${X(v)}" y="${y + 4}" text-anchor="middle" style="fill:var(--fg);font-size:10px">${marks[S.findIndex((x) => x.name === name)] || "·"}</text>`;
    });
    s += `<text x="${W - R + 8}" y="${y + 5}">${(100 + e.best).toFixed(2)}%</text>`;
  });
  s += "</svg>";
  return (
    `<p class="note">Each team's best short run in ${esc(last)} (best lap or best-sector sum, from practice.py) as % of the fastest (bars); marks per session: ${S.map((x, j) => `${marks[j] || "·"} ${esc(x.name)}`).join(", ")}. Practice feeds qualifying pace at ${Math.round(Engine.MODEL.practiceQ * 100)}%.</p>` +
    s
  );
}

function labControls() {
  const groups = [...new Set(LAB_SWITCHES.map((s) => s.g))];
  const ctl = (s) => {
    const k = s.o + "." + s.k,
      v = labVal(s),
      ship = LAB_SHIPPED[k],
      ch = v !== ship ? " changed" : "";
    const tip = `Shipped: ${String(ship)}`;
    if (s.bool || s.bit)
      return `<label class="switch${ch}" title="${tip}"><input type="checkbox" data-labset="${k}" ${v ? "checked" : ""}><span>${esc(s.l)}</span></label>`;
    if (s.opts)
      return `<label class="labsel${ch}" title="${tip}"><span>${esc(s.l)}</span><select data-labset="${k}">${s.opts.map(([x, l]) => `<option value="${x}" ${x === v ? "selected" : ""}>${esc(l)}${x === ship ? " (shipped)" : ""}</option>`).join("")}</select></label>`;
    const [lo, hi, st] = s.range;
    return `<label class="slider${ch}" title="${tip}"><span>${esc(s.l)}</span><input type="range" data-labset="${k}" min="${lo}" max="${hi}" step="${st}" value="${v}"><output>${v}</output></label>`;
  };
  return groups
    .map(
      (g) =>
        `<fieldset class="labgrp"><legend>${esc(g)}</legend>${LAB_SWITCHES.filter((s) => s.g === g)
          .map(ctl)
          .join("")}</fieldset>`,
    )
    .join("");
}
export function renderLab() {
  if (!labOwner) return;
  const races = upcoming.slice(0, 3);
  $("#labRace").innerHTML = races
    .map(
      (g, k) =>
        `<option value="${k}" ${k === lab.race ? "selected" : ""}>R${g.gd} ${esc(g.name.replace(" Grand Prix", " GP"))}${k === 0 ? " (next)" : ""}</option>`,
    )
    .join("");
  $("#labN").value = String(lab.N);
  $("#labCompare").checked = lab.compare;
  $("#labCtl").innerHTML = labControls();
  const ch = labChanged();
  $("#labChanged").textContent = ch.length
    ? `${ch.length} switch${ch.length > 1 ? "es" : ""} changed from the shipped model`
    : "The shipped model";
  if (!labRun) {
    $("#labStatus").textContent = "Press Rerun to simulate.";
    $("#labOut").hidden = true;
    return;
  }
  const r = labRun,
    c = r.setup.circuit;
  $("#labOut").hidden = false;
  $("#labStatus").textContent =
    `R${r.g.gd} ${r.g.name}: ${r.N.toLocaleString()} weekends in ${(r.ms / 1000).toFixed(1)} s` +
    ` · overtakes ${(c.ov * (c.ovMean ?? 4)).toFixed(1)} per starter${c.kmh ? ` (practice ${c.kmh.toFixed(0)} km/h)` : ""}` +
    ` · safety car ${pct(r.sim.sc)} · rain ${pct(r.sim.wet)}` +
    (r.changed.length ? ` · run with: ${r.changed.map((s) => `${s.l} = ${labVal(s)}`).join(", ")}` : "");
  // only the open tab renders (the combinations and violins take a moment)
  const rows = r.rows || (r.rows = labRows(r));
  $$("#labTabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.labtab === lab.tab)));
  $$("[data-labpanel]").forEach((el) => (el.hidden = el.dataset.labpanel !== lab.tab));
  const t = lab.tab;
  if (t === "assets") {
    $("#labAssets").innerHTML = labAssetTable(rows, r.base);
    $("#labCons").innerHTML = labConsTable(r, rows);
    $("#labViolins").innerHTML = labAssetViolins(r, rows);
    $("#labStrips").innerHTML = labStrips(rows, r.sim);
  } else if (t === "teams") {
    $("#labTeam").innerHTML = labTeam(r);
    $("#labTeams").innerHTML = labTeams(r, rows);
  } else if (t === "value") {
    $("#labScatter").innerHTML = labScatter(rows);
    $("#labCombosBox").innerHTML = labCombos(rows);
    labDrawCombos();
  } else if (t === "prices") $("#labPrices").innerHTML = labPriceMatrix(r, rows);
  else if (t === "pos") {
    $$("#labPos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.labpos === lab.pos)));
    $("#labMatrix").innerHTML = labMatrix(rows, r.sim);
  } else if (t === "laps") {
    $$("#labLapv button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lablapv === lab.lapv)));
    $("#labLaps").innerHTML = labLaps(r);
  } else if (t === "practice") $("#labPractice").innerHTML = labPractice(r);
}
// a switch changed: keep it (the shipped value clears the entry)
export function labSet(t) {
  const k = t.dataset.labset,
    s = LAB_SWITCHES.find((x) => x.o + "." + x.k === k);
  let v = t.type === "checkbox" ? t.checked : t.type === "range" ? +t.value : t.value;
  if (s.bit) v = v ? 1 : 0;
  if (v === LAB_SHIPPED[k]) delete lab.set[k];
  else lab.set[k] = v;
  labSave();
  if (t.type === "range") t.nextElementSibling.textContent = String(v);
  const ch = labChanged();
  $("#labChanged").textContent = ch.length
    ? `${ch.length} switch${ch.length > 1 ? "es" : ""} changed from the shipped model`
    : "The shipped model";
  t.closest("label").classList.toggle("changed", v !== LAB_SHIPPED[k]);
}
