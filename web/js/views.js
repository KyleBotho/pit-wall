/* ---------- header ---------- */
function renderHeader() {
  $("#raceName").textContent = NEXT ? `R${NEXT.gd} · ${NEXT.name}` : `${DATA.season} season complete`;
  const age = Math.round((Date.now() - new Date(DATA.generated)) / 6e4);
  const fresh = `data ${age < 60 ? age + " min" : age < 2880 ? Math.round(age / 60) + " h" : Math.round(age / 1440) + " days"} old`;
  if (!NEXT) {
    $("#lock").textContent = `All ${DATA.done.length} rounds scored · ${fresh}`;
    return;
  }
  const lock = new Date(NEXT.lock),
    ms = lock - Date.now();
  const when = lock.toLocaleString(undefined, { weekday: "short", ...shortDate });
  const sprint = NEXT.sprint ? ' <span class="tag sprint">Sprint</span>' : "";
  if (ms <= 0) {
    $("#lock").innerHTML = `Team locked · ${esc(when)} · ${fresh}${sprint}`;
    return;
  }
  const d = Math.floor(ms / 864e5),
    h = Math.floor((ms % 864e5) / 36e5),
    m = Math.floor((ms % 36e5) / 6e4);
  $("#lock").innerHTML =
    `Lock in <b>${d ? d + "d " : ""}${h}h ${String(m).padStart(2, "0")}m</b> · ${esc(when)} · ${fresh}${sprint}`;
}

/* ---------- compare ---------- */
function horizonPts(ids, H) {
  let t = 0;
  for (let k = 0; k < H; k++) {
    const pr = forecast.proj[k];
    t +=
      ids.reduce((s, id) => s + pr[id].mean, 0) +
      Math.max(...ids.filter((id) => byId[id].kind === "D").map((id) => pr[id].mean));
  }
  return t;
}
function renderCompare() {
  const list = state.teams
    .map((t) => ({ name: t.name, ids: t.team, own: true, boost: t.boost, example: t.example }))
    .concat(state.drafts.map((d, di) => ({ name: d.name, ids: d.team, own: false, boost: d.boost || "auto", di })));
  const H = forecast.races.length;
  const rows = list.map((t) => {
    const boost = boostFor(t.ids, 0, t);
    const smp = teamSamples(t.ids, boost, "");
    const sorted = Array.from(smp).sort((a, b) => a - b),
      N = smp.length;
    return Object.assign(t, {
      boost,
      smp,
      mean: smp.reduce((a, b) => a + b, 0) / N,
      p25: sorted[Math.floor(N * 0.25)],
      p75: sorted[Math.floor(N * 0.75)],
      cost: t.ids.reduce((s, id) => s + byId[id].price, 0),
      h: horizonPts(t.ids, H),
      dv: t.ids.reduce((s, id) => s + priceEv(id), 0),
      wins: 0,
    });
  });
  const N = rows[0].smp.length;
  for (let s = 0; s < N; s++) {
    let b = 0;
    for (let j = 1; j < rows.length; j++) if (rows[j].smp[s] > rows[b].smp[s]) b = j;
    rows[b].wins++;
  }
  const best = Math.max(...rows.map((r) => r.mean));
  $("#cmpGd").textContent = NEXT.gd;
  $("#cmpTable").innerHTML =
    `<thead><tr><th style="text-align:left">Team</th><th title="Mean, with the middle half of outcomes (25–75) below">xPts R${NEXT.gd}</th><th>Next ${H}</th><th>xΔ$</th><th title="Share of simulated weekends where this team scores the most">Wins</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const cons = r.ids.filter((id) => byId[id].kind === "C"),
          drs = r.ids
            .filter((id) => byId[id].kind === "D")
            .sort((x, y) => (x === r.boost ? -1 : y === r.boost ? 1 : xpts(y, 1) - xpts(x, 1)));
        return `<tr><td style="text-align:left"><div class="cmpname"><b>${esc(r.name)}</b> <span class="dim">${r.own ? (r.example ? "your team · example" : "your team") : "manual"} · ${money(r.cost)}</span>${r.own ? "" : ` <button class="tbtn sm" data-editdraft="${r.di}" title="Edit this manual team" aria-label="Edit ${esc(r.name)}">✎</button>`}</div>
      <div class="chips" style="flex-wrap:nowrap">${cons.map((id) => chip(id, { pts: xpts(id, 1) })).join("")}<span class="sep"></span>${drs.map((id) => chip(id, { pts: xpts(id, 1) * (id === r.boost ? 2 : 1), x: id === r.boost ? "2×" : "" })).join("")}</div></td>
      <td data-l="xPts" class="${r.mean === best ? "good" : ""}"><b>${f1(r.mean)}</b><div class="muted" style="font-size:12px">${f0(r.p25)}–${f0(r.p75)}</div></td>
      <td data-l="Next ${H}">${f1(r.h)}</td><td data-l="xΔ$" class="${r.dv >= 0 ? "good" : "bad"}">${sgn(r.dv, 2)}</td><td data-l="Wins"><b>${pct(r.wins / N)}</b></td></tr>`;
      })
      .join("") +
    "</tbody>";
}

/* ---------- projections ---------- */
function spark(a) {
  const h = a.hist.slice(-6),
    vals = h.map((x) => (x ? x.pts : 0));
  const max = Math.max(10, ...vals.map(Math.abs)),
    W = 7,
    G = 2,
    H = 22,
    mid = H / 2;
  const bars = vals
    .map((v, i) => {
      const hh = Math.max(1, (Math.abs(v) / max) * mid);
      return `<rect x="${i * (W + G)}" y="${v >= 0 ? mid - hh : mid}" width="${W}" height="${hh}" rx="1" fill="${v >= 0 ? "#22C55E" : "#EF4444"}" opacity="${h[i] && !h[i].active ? 0.3 : 0.9}"/>`;
    })
    .join("");
  return `<svg width="${vals.length * (W + G)}" height="${H}" viewBox="0 0 ${vals.length * (W + G)} ${H}" aria-label="Last ${vals.length} races: ${vals.join(", ")}"><line x1="0" x2="${vals.length * (W + G)}" y1="${mid}" y2="${mid}" stroke="#27272A"/>${bars}</svg>`;
}
function renderAssets() {
  $("#assetKey").innerHTML = heatKey("fewer xPts", "more xPts");
  const pre = $("#simPreset").selectedOptions[0];
  $("#assetPreset").hidden = state.simPreset === "sim";
  $("#assetPreset").textContent =
    `xPts come from the ${pre ? pre.textContent : state.simPreset} preset (Calculator → Simulation), not the Pit Wall sim.`;
  $$("#assetKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind)));
  $("#assetRace").innerHTML = forecast.races
    .map(
      (g, i) =>
        `<button data-race="${i}" aria-pressed="${i === state.raceIdx}">R${g.gd} ${esc(g.name.replace(" Grand Prix", ""))}${g.sprint ? " · S" : ""}</button>`,
    )
    .join("");
  const k = Math.min(state.raceIdx, forecast.races.length - 1),
    isD = state.kind === "D";
  const rows = DATA.assets
    .filter((a) => a.kind === state.kind && (a.active || !isD))
    .map((a) => {
      const p = forecast.proj[k][a.id],
        st = p.st || {};
      return {
        a,
        x: p.mean,
        p25: (st.p25 ?? 0) + p.shift,
        p75: (st.p75 ?? 0) + p.shift,
        ppm: p.mean / a.price,
        price: a.price,
        own: a.own,
        dnf: st.dnf,
        fl: st.fl,
        ov: st.xov,
        dotd: st.dotd,
        form: forecast.form[a.id],
        neg: p.nn != null ? p.mean - p.nn : null,
        pit: isD ? null : st.pit,
      };
    });
  const { k: sk, d: sd } = state.sort;
  rows.sort((x, y) => ((x[sk] ?? -1e9) - (y[sk] ?? -1e9)) * sd);
  const mx = Math.max(...rows.map((r) => r.x)),
    mn = Math.min(...rows.map((r) => r.x));
  const th = (key, label, title) =>
    `<th class="sort" data-sort="${key}" ${sk === key ? `aria-sort="${sd < 0 ? "descending" : "ascending"}"` : ""} title="${title || ""}">${label}${sk === key ? (sd < 0 ? " ↓" : " ↑") : ""}</th>`;
  $("#assetTable").innerHTML =
    `<thead><tr><th>${isD ? "DR" : "CR"}</th>${th("price", "$")}${th("own", "Own", "Picked by % of teams")}${th("x", "xPts")}<th>25–75</th>${th("ppm", "xPPM", "xPts per $1m")}${th("form", "Form", "Weighted average of the last 6 races")}<th>Last 6</th>${isD ? th("dnf", "DNF") + th("fl", "FL", "Fastest lap") + th("ov", "xOV", "Expected overtakes") + th("dotd", "DotD", "Driver of the Day") + "<th>Pace</th>" : th("pit", "Pit", "Expected pit-stop points")}${th("neg", "xNeg", "Expected points lost to negative events: what No Negative would save")}<th>Incl / Excl</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const a = r.a,
          m = state.marks[a.id] || "",
          adj = state.adj[a.id] || 0;
        return `<tr><td>${who(a)}</td>
        <td>${f1(a.price)}</td><td class="muted">${f0(a.own)}%</td><td${heat(r.x, mn, mx)}><b>${f1(r.x)}</b></td><td class="muted">${f0(r.p25)}–${f0(r.p75)}</td>
        <td>${r.ppm.toFixed(2)}</td><td>${f1(r.form)}</td><td>${spark(a)}</td>
        ${
          isD
            ? `<td>${pct(r.dnf)}</td><td>${pct(r.fl)}</td><td>${f1(r.ov)}</td><td>${pct(r.dotd)}</td>
        <td><span class="mini"><button data-adj="${a.id}" data-step="-0.5" aria-label="Slower">−</button><output>${adj ? sgn(adj) : "0"}</output><button data-adj="${a.id}" data-step="0.5" aria-label="Faster">+</button></span></td>`
            : `<td>${f1(r.pit)}</td>`
        }
        <td class="${r.neg < -0.05 ? "bad" : "muted"}">${f1(r.neg)}</td>
        <td>${inclExcl(a.id, m)}</td></tr>`;
      })
      .join("") +
    "</tbody>";
}

/* ---------- practice ---------- */
function renderPractice() {
  const ps = DATA.practice || [];
  const fmtT = (iso) =>
    new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  $("#pracSessions").innerHTML = ps.length
    ? ps
        .map(
          (p) =>
            `<div class="stat"><span class="l">${esc(p.name)}</span><span class="v">${p.done ? Object.keys(p.drivers).length + " drivers" : "Pending"}</span><span class="s">${esc(fmtT(p.start))}</span></div>`,
        )
        .join("")
    : `<div class="stat"><span class="l">Practice</span><span class="v">No sessions found</span><span class="s">for R${NEXT.gd}</span></div>`;
  const ms = forecast.model.drivers,
    done = ps.filter((p) => p.done);
  const pr = Engine.practiceRanks(
    ps,
    ms.map((d) => d.tla),
  );
  const rows = ms.slice().sort((a, b) => a.qMu - b.qMu);
  // the market's pull on race pace, in grid places (+ = faster)
  const mkt = (d) => {
    if (!d.oddsR) return '<td class="dim">—</td>';
    const v = -d.oddsR / (forecast.model.slopeR || 0.1);
    return `<td class="${v > 0.5 ? "good" : v < -0.5 ? "bad" : ""}">${sgn(v, 1)}</td>`;
  };
  const g = (v) => (v == null ? "—" : "+" + v.toFixed(2) + "%");
  const perSess = (t) =>
    done
      .map((p) => {
        const v = p.drivers[t];
        return `<td class="muted">${v && v.q != null ? g(v.q) : "—"}</td>`;
      })
      .join("");
  $("#pracTable").innerHTML =
    (done.length
      ? ""
      : `<caption style="caption-side:top;text-align:left;padding:4px 0 10px;color:var(--muted)">No practice laps yet, so the model uses season form. Once practice runs, green in Practice Q means a driver looks faster than their form.</caption>`) +
    `<thead><tr><th>DR</th>${done.map((p) => `<th>${esc(p.name.replace("Practice ", "FP"))}</th>`).join("")}<th>Short run</th><th>Long run</th><th title="Grid position implied by practice alone">Practice Q</th><th title="From season form">Form Q</th><th title="What the simulation uses (practice and the market included)">Model Q</th><th>Form R</th><th title="Places the betting market moves race pace (+ = the market rates the driver higher than the model)">Market</th><th>Model R</th></tr></thead><tbody>` +
    rows
      .map((d) => {
        const a = byId[d.id],
          diff = d.practiceQ == null ? 0 : d.formQ - d.practiceQ;
        return `<tr><td>${who(a)}</td>${perSess(d.tla)}<td>${g(pr.gapQ[d.tla])}</td><td>${g(pr.gapR[d.tla])}</td>
        <td class="${diff > 1.5 ? "good" : diff < -1.5 ? "bad" : ""}">${d.practiceQ == null ? "—" : f1(d.practiceQ)}</td>
        <td class="muted">${f1(d.formQ)}</td><td><b>${f1(d.qMu)}</b></td><td class="muted">${f1(d.formR)}</td>${mkt(d)}<td><b>${f1(d.rMu)}</b></td></tr>`;
      })
      .join("") +
    "</tbody>";
}

/* ---------- positions ---------- */
function renderGrid() {
  $$("#gridKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.gridmode === state.grid)));
  const q = state.grid === "q";
  $("#gridKey").innerHTML = state.heat
    ? `<span class="muted">less likely</span><span class="ramp" style="background:linear-gradient(90deg,rgba(168,85,247,.04),rgba(168,85,247,.85))"></span><span class="muted">more likely</span>${q ? "" : '<span class="sw" style="background:rgba(239,68,68,.6)"></span><span class="muted">not classified</span>'}`
    : "";
  $("#gridNote").textContent =
    `${q ? "Qualifying" : "Race"} position probabilities (%) for ${NEXT.name}, from ${state.sims.toLocaleString()} simulated weekends${q ? "" : "; last column = not classified"}.`;
  const sim = forecast.sims[0];
  const rows = DATA.assets
    .filter((a) => a.kind === "D" && forecast.idx[a.id] != null)
    .map((a) => ({ a, v: sim.stats[forecast.idx[a.id]][q ? "q" : "r"] }));
  const F = sim.field; // positions 1..F, then (race) the not-classified column
  const exp = (v) =>
    v.slice(0, F).reduce((s, p, i) => s + p * (i + 1), 0) /
    Math.max(
      1e-9,
      v.slice(0, F).reduce((s, p) => s + p, 0),
    );
  rows.sort((x, y) => exp(x.v) - exp(y.v));
  const cols = q ? F : F + 1;
  $("#heat").innerHTML =
    `<thead><tr><th>DR</th>${Array.from({ length: cols }, (_, i) => `<th>${i === F ? "DNF" : "P" + (i + 1)}</th>`).join("")}</tr></thead><tbody>` +
    rows
      .map(
        ({ a, v }) =>
          `<tr><td>${codeBox(a)}</td>` +
          v
            .slice(0, cols)
            .map((p, i) => {
              const pc = Math.round(p * 100),
                c = i === F ? "239,68,68" : "168,85,247";
              return `<td style="background-color:rgba(${c},${Math.min(0.85, p * 2.6).toFixed(3)});${p > 0.25 ? "font-weight:600" : "color:" + (pc ? "var(--fg)" : "var(--dim)")}">${pc || ""}</td>`;
            })
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody>";
}

/* ---------- budget builder ---------- */
function renderPrices() {
  const binLbl = ["−0.6", "−0.3", "−0.2", "−0.1", "0", "+0.1", "+0.2", "+0.3", "+0.6"];
  const group = (title, list) =>
    !list.length
      ? ""
      : `<tr class="tier"><td colspan="11">${title}</td></tr>` +
        list
          .map((a) => {
            const pi = forecast.price[a.id],
              p = forecast.proj[0][a.id];
            const needCell = (v) => `<td class="${p.mean >= v ? "good" : "muted"}">${f0(v)}</td>`;
            const dist = pi.dist
              ? `<span class="dist" title="${pi.dist.map((v, i) => binLbl[i] + ": " + Math.round(v * 100) + "%").join(" · ")}">${pi.dist.map((v, i) => `<span class="${i < 4 ? "dn" : i > 4 ? "up" : "z"}" style="height:${Math.max(1, v * 22)}px"></span>`).join("")}</span>`
              : "—";
            return `<tr><td>${who(a)}</td>
      <td>${f1(a.price)}</td><td class="muted">${f0(pi.p2)} · ${f0(pi.p1)}</td><td><b>${f1(p.mean)}</b></td>
      ${needCell(pi.need[0])}${needCell(pi.need[1])}${needCell(pi.need[2])}
      <td class="good">${pct(pi.up)}</td><td class="bad">${pct(pi.down)}</td><td>${dist}</td>
      <td${heat(pi.ev, -0.6, 0.6)} class="${pi.ev >= 0 ? "good" : "bad"}"><b>${sgn(pi.ev, 2)}</b></td></tr>`;
          })
          .join("");
  const act = DATA.assets
    .filter((a) => a.active || a.kind === "C")
    .sort((x, y) => forecast.price[y.id].ev - forecast.price[x.id].ev);
  const hi = (k) => act.filter((a) => a.kind === k && a.price >= 18.5),
    lo = (k) => act.filter((a) => a.kind === k && a.price < 18.5);
  $("#priceKey").innerHTML = heatKey("price falls", "price rises");
  $("#priceTable").innerHTML =
    `<thead><tr><th>Asset</th><th>$</th><th title="Points in the last two races">Last 2</th><th>xPts</th><th title="Points needed to avoid the big drop">≥0.605</th><th title="Points needed for a rise">≥0.9</th><th title="Points needed for the big rise">≥1.195</th><th>P(rise)</th><th>P(drop)</th><th title="Distribution from −0.6 to +0.6">Spread</th><th>xΔ$</th></tr></thead><tbody>` +
    group("Drivers · $18.5m+", hi("D")) +
    group("Drivers · under $18.5m", lo("D")) +
    group("Constructors · $18.5m+", hi("C")) +
    group("Constructors · under $18.5m", lo("C")) +
    "</tbody>";
}

/* ---------- calendar ---------- */
// which measures follow each circuit's own history (Engine.TRACK.alpha, set by the leave-one-round-out backtest)
function histUse() {
  const names = { ov: "overtaking", dnf: "retirements", sc: "safety cars", corr: "grid influence" };
  const al = Engine.TRACK.alpha,
    used = Object.keys(names).filter((k) => al[k] > 0),
    not = Object.keys(names).filter((k) => !(al[k] > 0));
  return (
    (used.length
      ? `Each circuit's own history shapes ${used.map((k) => names[k]).join(", ")}`
      : "No circuit's own history is used") +
    (not.length
      ? `; ${not.map((k) => names[k]).join(", ")} use this season's average everywhere (circuit history didn't predict them this season).`
      : ".")
  );
}
// one-click overtaking scenarios (Engine.ovScenarios): the fitted value, or a low / high weekend on top of it
const OV_SC = Engine.ovScenarios(DATA);
const ovBase = (g) => trackFit.forCircuit(g).ov ?? 1;
// rounded to the Overtaking slider's 0.05 step, so the slider shows exactly the scenario
const ovFor = (g, k) => (k === "base" ? ovBase(g) : Math.round(ovBase(g) * OV_SC[k] * 20) / 20);
function ovScenarioUI(g, now) {
  if (!OV_SC) return "";
  const set = (state.circuits[g.gd] || {}).ov;
  const on = (k) => (k === "base" ? set == null : set != null && Math.abs(set - ovFor(g, k)) < 0.005);
  const tip = {
    low: `A weekend like this season's low-overtaking fifth: ×${OV_SC.low.toFixed(2)} (${OV_SC.n} rounds)`,
    base: "The fitted value for this circuit",
    high: `A weekend like this season's high-overtaking fifth: ×${OV_SC.high.toFixed(2)} (${OV_SC.n} rounds)`,
  };
  return (
    `<div class="seg ovsc" role="group" aria-label="Overtaking scenario" title="Current: ${now.toFixed(2)}">` +
    ["low", "base", "high"]
      .map(
        (k) =>
          `<button data-ovsc="${g.gd}:${k}" aria-pressed="${on(k)}" title="${tip[k]}">${k === "low" ? "Low" : k === "high" ? "High" : "Base"} ${ovFor(g, k).toFixed(2)}</button>`,
      )
      .join("") +
    "</div>"
  );
}
const PEN_OPTS = [
  [0, "none"],
  [3, "+3"],
  [5, "+5"],
  [10, "+10"],
  [99, "back"],
];
// the next race's grid penalties: race control's (DATA.weekend) with yours on top
const penFor = (tla) =>
  (state.pen || {})[tla] ?? ((DATA.weekend && NEXT && DATA.weekend.gd === NEXT.gd && DATA.weekend.penalties[tla]) || 0);
function renderCal() {
  const tr = trackFit.trend || {},
    pct0 = (v) => (v == null || isNaN(v) ? "—" : Math.round(v * 100) + "%");
  const trendTxt = trackFit.priors
    ? `This season vs the same circuits in past seasons (${trackFit.trendN.move} rounds): position changes ×${tr.move.toFixed(2)}, retirements ×${tr.dnf.toFixed(2)}, safety cars ×${tr.sc.toFixed(2)}, grid-finish correlation ${tr.corr >= 0 ? "+" : ""}${tr.corr.toFixed(2)}. Overtake points: ${trackFit.ovMean.toFixed(1)} per car per race this season. ${histUse()}`
    : "No past-season circuit history loaded: circuits are fitted from this season's track types only.";
  $("#calTrend").textContent = trendTxt;
  $("#cal").innerHTML = upcoming
    .map((g, k) => {
      const c = circ(g);
      const when = new Date(g.raceStart).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const sl = (key, label, min, max, step, val, fmt) =>
        `<label class="slider"><span>${label}</span><input type="range" id="c-${g.gd}-${key}" data-circ="${g.gd}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(+val)}</output></label>`;
      const f2 = (v) => v.toFixed(2);
      const wx = (DATA.weather || {})[g.gd];
      const rainSrc = wx && wx.r != null && !(state.circuits[g.gd] || {}).rain ? "forecast" : "past seasons here";
      const pr = c.prior;
      // the overtake level from practice average speed (Engine.TRACK.speed), once this weekend's practice has run
      const sp = Engine.TRACK.speed && trackFit.speed && c.kmh != null ? trackFit.speed : null;
      const speedTxt = sp
        ? `<div class="note" style="font-size:12px">Average speed in practice ${c.kmh.toFixed(0)} km/h (season ${sp.mx.toFixed(0)}): overtaking ${ovBase(g).toFixed(2)}× this season's average. Faster tracks see more passing (fitted on ${sp.n} rounds).</div>`
        : "";
      const hist = pr
        ? `<div class="note" style="font-size:12px">Past seasons here${pr.n ? ` (${pr.n} races)` : " (new circuit: similar tracks)"}: ${pr.ov != null && !sp ? `overtaking ${ovBase(g).toFixed(2)}× this season's average · ` : ""}safety car ${pct0(c.sc)} · rain ${pct0(pr.rain)}</div>`
        : "";
      const fit = trackFit.fitted && !state.circuits[g.gd];
      let extra = "";
      if (k === 0) {
        const o = DATA.odds && DATA.odds.gd === g.gd ? DATA.odds : null;
        const wk = DATA.weekend && DATA.weekend.gd === g.gd ? DATA.weekend : null;
        const known = wk ? Object.keys(wk.grid || {}) : [];
        const names = { q: "qualifying", sq: "sprint qualifying", s: "sprint" };
        extra =
          `<div class="note" style="font-size:12px">Market: ${o ? `${["win", "podium", "top10", "pole"].filter((m) => o[m]).join(", ")} odds from Kalshi (${new Date(o.at).toLocaleString(undefined, shortDate)}), weight ${Math.round(state.oddsW * 100)}%` : "no odds yet"}.` +
          (known.length
            ? ` <b>Known: ${known.map((x) => names[x] || x).join(", ")}</b> (simulated from the actual order).`
            : "") +
          `</div><div><details class="grp"><summary>Grid penalties${Object.values(state.pen || {}).some(Boolean) || (wk && Object.keys(wk.penalties).length) ? " · set" : ""}</summary>` +
          `<p class="note" style="font-size:12px">Places added to the qualifying position for the race. Race control's announcements load automatically; set any others here.</p><div class="pengrid">` +
          DATA.assets
            .filter((a) => a.kind === "D" && a.active)
            .sort((a, b) => a.tla.localeCompare(b.tla))
            .map(
              (a) =>
                `<label>${esc(a.tla)} <select data-pen="${a.tla}">${PEN_OPTS.map(([v, n]) => `<option value="${v}" ${penFor(a.tla) === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>`,
            )
            .join("") +
          `</div></details></div>`;
      }
      return `<section class="panel"><h3>${esc(g.name.replace(" Grand Prix", " GP"))} <small>R${g.gd}</small></h3>
      <div class="muted" style="font-size:13px">${esc(g.loc)} · race ${esc(when)} ${g.sprint ? '<span class="tag sprint">Sprint</span>' : ""}</div>
      <p class="note">${esc(c.note || "")}</p>
      <div class="chipbar">${(c.feat || []).map((v, i) => `<span class="chiptok" title="0 = none, 1 = maximum">${Engine.FEAT_NAMES[i]} ${v.toFixed(2)}</span>`).join("")}</div>
      ${hist}${speedTxt}
      <div class="note" style="font-size:12px">${fit ? `Fitted from this season's ${trackFit.rounds} rounds and this circuit's history (see above). Rain from the ${rainSrc}.` : "Custom values set here."}</div>
      ${sl("ov", "Overtaking", 0.2, 2.5, 0.05, c.ov, f2)}${ovScenarioUI(g, c.ov ?? 1)}${sl("grid", "Grid decides", 0.25, 0.95, 0.01, c.grid, f2)}${sl("chaos", "Retirements", 0.5, 1.8, 0.05, c.chaos, f2)}
      ${sl("sc", "Safety car", 0.05, 0.95, 0.05, c.sc ?? 0.5, pct0)}${sl("rainR", "Rain (race)", 0, 1, 0.05, (c.rain || {}).r ?? 0, pct0)}
      ${extra}</section>`;
    })
    .join("");
}

/* ---------- model ---------- */
function renderModel() {
  $("#halfLife").value = state.halfLife;
  $("#halfLifeV").textContent = state.halfLife + " races";
  $("#pw").value = state.pw;
  $("#pwV").textContent = Math.round(state.pw * 100) + "%";
  $("#blend").value = state.blend;
  $("#blendV").textContent = Math.round(state.blend * 100) + "%";
  $("#oddsW").value = state.oddsW;
  $("#oddsWV").textContent = Math.round(state.oddsW * 100) + "%";
  $$("#sims button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.sims === state.sims)));
  $$("#heatOpt button").forEach((b) => b.setAttribute("aria-pressed", String(!!+b.dataset.heat === state.heat)));
  const gen = new Date(DATA.generated);
  $("#dataStamp").textContent =
    `Data: F1 Fantasy prices and points after round ${DATA.done[DATA.done.length - 1]}; ${DATA.season} results and past seasons from Jolpica; practice, race pace, pit stops and safety cars from OpenF1; odds from Kalshi; rain forecasts from Open-Meteo. Pulled ${gen.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`;
}
