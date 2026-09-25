/* ---------- Sim lab (owner only): every engine switch, a rerun, and panels built from our own simulations ----------
   Shown only to accounts in the Supabase `owners` table (RLS: each user can read only their own row), or on
   localhost with ?lab=1. It's a UI gate: everything here comes from the public build. Runs are in this browser, on
   demand: the switches are applied to Engine.SIM / TRACK / MODEL for the run only and put back afterwards, so the
   Calculator and every other view keep the shipped model. Settings live in this browser only (LAB_KEY). */
let labOwner = false;
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
const lab = { set: {}, race: 0, N: 10000, compare: true, pos: "r", ...labRead() };
const labSave = () => {
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
async function labCheck() {
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
  if (!labOwner && state.view === "lab") showView("calc");
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
    const sim = Engine.simulate(
      setup.model,
      setup.circuit,
      k === 0 ? sprintNext() : g.sprint,
      N,
      g.gd * 7919 + 13,
      setup.simOpt,
    );
    return { setup, sim, ms: performance.now() - t0 };
  });
}
function labRerun() {
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
function renderLab() {
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
  const rows = labRows(r);
  $("#labAssets").innerHTML = labAssetTable(rows, r.base);
  $$("#labPos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.labpos === lab.pos)));
  $("#labMatrix").innerHTML = labMatrix(rows, r.sim);
  $("#labScatter").innerHTML = labScatter(rows);
  $("#labStrips").innerHTML = labStrips(rows, r.sim);
  $("#labTeam").innerHTML = labTeam(r);
}
// a switch changed: keep it (the shipped value clears the entry)
function labSet(t) {
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
