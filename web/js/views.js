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
    .concat(state.drafts.map((d) => ({ name: d.name, ids: d.team, own: false, boost: "auto" })));
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
  $("#cmpTable").innerHTML =
    `<thead><tr><th>Team</th><th style="text-align:left">Line-up</th><th>$</th><th>xPts R${NEXT.gd}</th><th>25–75</th><th>Next ${H} races</th><th>xΔ$</th><th title="Share of simulated weekends where this team scores the most">Wins</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const cons = r.ids.filter((id) => byId[id].kind === "C"),
          drs = r.ids
            .filter((id) => byId[id].kind === "D")
            .sort((x, y) => (x === r.boost ? -1 : y === r.boost ? 1 : xpts(y, 1) - xpts(x, 1)));
        return `<tr><td><b>${esc(r.name)}</b><br><span class="dim" style="font-size:12px">${r.own ? (r.example ? "your team · example" : "your team") : "manual"}</span></td>
      <td style="text-align:left"><div class="chips" style="flex-wrap:nowrap">${cons.map((id) => chip(id, { pts: xpts(id, 1) })).join("")}<span class="sep"></span>${drs.map((id) => chip(id, { pts: xpts(id, 1) * (id === r.boost ? 2 : 1), x: id === r.boost ? "2×" : "" })).join("")}</div></td>
      <td>${f1(r.cost)}</td><td class="${r.mean === best ? "good" : ""}"><b>${f1(r.mean)}</b></td><td class="muted">${f0(r.p25)}–${f0(r.p75)}</td>
      <td>${f1(r.h)}</td><td class="${r.dv >= 0 ? "good" : "bad"}">${sgn(r.dv, 2)}</td><td><b>${pct(r.wins / N)}</b></td></tr>`;
      })
      .join("") +
    "</tbody>";
  $("#drafts").innerHTML = state.drafts
    .map(
      (d, i) => `<section class="panel">
      <h3 style="gap:8px"><input class="inp" id="dname-${i}" data-dname="${i}" value="${esc(d.name)}" maxlength="24" aria-label="Manual team name" style="font-family:var(--display);font-weight:600;font-size:16px;flex:1"><button class="tbtn ban" aria-pressed="true" data-deldraft="${i}">Delete</button></h3>
      <div class="slots" style="margin:0">${d.team.map((id, k) => `<div class="slotrow" style="--tc:${col(byId[id])};grid-template-columns:1fr auto"><select id="d-${i}-${k}" data-dslot="${i}:${k}" aria-label="Slot ${k + 1}">${optionList(k < 5 ? "D" : "C", id)}</select><span class="x">${f1(xpts(id, 1))}</span></div>`).join("")}</div>
      <div class="chipbar"><span class="muted" style="align-self:center;margin-right:auto">${money(d.team.reduce((s, id) => s + byId[id].price, 0))}</span>${state.teams.map((t, j) => `<button class="btn ghost sm" data-todraft="${i}:${j}">→ ${esc(t.name)}</button>`).join("")}</div>
    </section>`,
    )
    .join("");
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
        pit: isD ? null : (forecast.model.cons.find((c) => c.id === a.id) || {}).pitMu,
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
        return `<tr><td><span class="who">${codeBox(a)}<span>${esc(isD ? a.short : a.team)}</span></span></td>
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
    `<thead><tr><th>DR</th>${done.map((p) => `<th>${esc(p.name.replace("Practice ", "FP"))}</th>`).join("")}<th>Short run</th><th>Long run</th><th title="Grid position implied by practice alone">Practice Q</th><th title="From season form">Form Q</th><th title="What the simulation uses">Model Q</th><th>Form R</th><th>Model R</th></tr></thead><tbody>` +
    rows
      .map((d) => {
        const a = byId[d.id],
          diff = d.practiceQ == null ? 0 : d.formQ - d.practiceQ;
        return `<tr><td><span class="who">${codeBox(a)}<span>${esc(a.short)}</span></span></td>${perSess(d.tla)}<td>${g(pr.gapQ[d.tla])}</td><td>${g(pr.gapR[d.tla])}</td>
        <td class="${diff > 1.5 ? "good" : diff < -1.5 ? "bad" : ""}">${d.practiceQ == null ? "—" : f1(d.practiceQ)}</td>
        <td class="muted">${f1(d.formQ)}</td><td><b>${f1(d.qMu)}</b></td><td class="muted">${f1(d.formR)}</td><td><b>${f1(d.rMu)}</b></td></tr>`;
      })
      .join("") +
    "</tbody>";
}

/* ---------- positions ---------- */
function renderGrid() {
  $$("#gridKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.gridmode === state.grid)));
  const q = state.grid === "q";
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
            return `<tr><td><span class="who">${codeBox(a)}<span>${esc(a.kind === "D" ? a.short : a.team)}</span></span></td>
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
  $("#priceTable").innerHTML =
    `<thead><tr><th>Asset</th><th>$</th><th title="Points in the last two races">Last 2</th><th>xPts</th><th title="Points needed to avoid the big drop">≥0.605</th><th title="Points needed for a rise">≥0.9</th><th title="Points needed for the big rise">≥1.195</th><th>P(rise)</th><th>P(drop)</th><th title="Distribution from −0.6 to +0.6">Spread</th><th>xΔ$</th></tr></thead><tbody>` +
    group("Drivers · $18.5m+", hi("D")) +
    group("Drivers · under $18.5m", lo("D")) +
    group("Constructors · $18.5m+", hi("C")) +
    group("Constructors · under $18.5m", lo("C")) +
    "</tbody>";
}

/* ---------- calendar ---------- */
function renderCal() {
  $("#cal").innerHTML = upcoming
    .map((g) => {
      const c = circ(g);
      const when = new Date(g.raceStart).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const sl = (key, label, min, max, step) =>
        `<label class="slider"><span>${label}</span><input type="range" id="c-${g.gd}-${key}" data-circ="${g.gd}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${c[key]}"><output>${(+c[key]).toFixed(2)}</output></label>`;
      const shifts = Object.entries(c.teamShift || {})
        .filter(([, v]) => Math.abs(v) >= 0.15)
        .sort((a, b) => a[1] - b[1]);
      const shiftTxt = shifts.length
        ? shifts
            .map(
              ([t, v]) =>
                `<span class="${v < 0 ? "good" : "bad"}">${esc(teamCode(t))} ${v < 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}</span>`,
            )
            .join(" ")
        : '<span class="dim">none worth noting</span>';
      const fit = trackFit.fitted && !state.circuits[g.gd];
      return `<section class="panel"><h3>${esc(g.name.replace(" Grand Prix", " GP"))} <small>R${g.gd}</small></h3>
      <div class="muted" style="font-size:13px">${esc(g.loc)} · race ${esc(when)} ${g.sprint ? '<span class="tag sprint">Sprint</span>' : ""}</div>
      <p class="note">${esc(c.note || "")}</p>
      <div class="chipbar">${(c.feat || []).map((v, i) => `<span class="chiptok" title="0 = none, 1 = maximum">${Engine.FEAT_NAMES[i]} ${v.toFixed(2)}</span>`).join("")}</div>
      <div class="note" style="font-size:12px">Track-type pace (grid places): ${shiftTxt}</div>
      <div class="note" style="font-size:12px">${fit ? `Overtaking, grid weight and chaos are fitted from ${trackFit.rounds} completed rounds of this season's track types.` : "Custom values set here."}</div>
      ${sl("ov", "Overtaking", 0.2, 1.6, 0.05)}${sl("grid", "Grid weight", 0.2, 0.9, 0.05)}${sl("chaos", "Chaos", 0.6, 1.6, 0.05)}</section>`;
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
  $$("#sims button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.sims === state.sims)));
  $$("#heatOpt button").forEach((b) => b.setAttribute("aria-pressed", String(!!+b.dataset.heat === state.heat)));
  const gen = new Date(DATA.generated);
  $("#dataStamp").textContent =
    `Data: F1 Fantasy prices and points after round ${DATA.done[DATA.done.length - 1]}; ${DATA.season} results from Jolpica; practice from OpenF1. Pulled ${gen.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`;
}
