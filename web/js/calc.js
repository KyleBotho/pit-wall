/* ---------- team calculator ----------
   Layout: Best Teams (left) | Settings + Simulation (middle) | Drivers + Constructors (right). The starting team is
   startTeam() (forecast.js); Best Teams come from Engine.optimise over every legal line-up. */

// Incl / Excl toggles for an asset (attr "mark" = the Calculator's, "hmark" = Hindsight's)
const inclExcl = (id, m, attr = "mark") =>
  `<span class="mini"><button class="tbtn lock sm" data-${attr}="${id}" data-to="lock" aria-pressed="${m === "lock"}" aria-label="Include">✓</button>` +
  `<button class="tbtn ban sm" data-${attr}="${id}" data-to="ban" aria-pressed="${m === "ban"}" aria-label="Exclude">✕</button></span>`;
const PIN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z"/></svg>`;
const PERSON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;
const pill = (v, on, cls = "", title = "") =>
  `<span class="pill ${cls}${on ? " on" : ""}"${title ? ` title="${title}"` : ""}>${v}</span>`;

/* ---------- edit team (dialog) ---------- */
// what the editor changes: null = the starting team, a number = that manual team (from Compare's ✎)
let editTarget = null;
const editing = () => (editTarget != null && state.drafts[editTarget] ? state.drafts[editTarget] : editStart());
function openTeamEditor(target = editTarget) {
  editTarget = target != null && state.drafts[target] ? target : null;
  const draft = editTarget != null,
    T = draft ? state.drafts[editTarget] : startTeam();
  if (!draft && (T.none || T.ro))
    return toast(
      T.none
        ? "Pick one of your teams or a manual team first."
        : "Rival line-ups follow the league standings. Save one as a manual team to edit it.",
    );
  const boost = boostFor(T.team, 0, T);
  const slot = (id, k) => {
    const a = byId[id],
      kind = k < 5 ? "D" : "C",
      isB = id === boost;
    const label = `${kind === "D" ? "Driver" : "Constructor"} ${k < 5 ? k + 1 : k - 4}`;
    const boostBtn =
      kind === "D"
        ? `<button class="tbtn" data-boost="${id}" aria-pressed="${isB}" title="Boost this driver">${isB && T.boost === "auto" ? "2× auto" : "2×"}</button>`
        : "<span></span>";
    return `<div class="slotrow" style="--tc:${col(a)}"><select id="slot-${k}" data-slot="${k}" aria-label="${label}">${optionList(kind, id)}</select>
        <span class="x">${forecast.proj[0][id].out ? '<span class="tag">out</span>' : f1(xpts(id, 1))}</span>${boostBtn}</div>`;
  };
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">Edit ${esc(T.name)}</h3>
    <label class="field">Team name<input id="tname" class="inp" type="text" maxlength="24" value="${esc(T.name)}"></label>
    ${T.example ? '<div class="banner">This is an <b>example team</b>. Pick your drivers and constructors below.</div>' : ""}
    <div class="slots">${T.team.map(slot).join("")}</div>` +
    (draft
      ? `<div class="chipbar" style="align-items:center"><span class="muted" style="margin-right:auto">${money(T.team.reduce((s, id) => s + byId[id].price, 0))}</span>` +
        state.teams
          .map(
            (t, j) =>
              `<button class="btn ghost sm" data-todraft="${editTarget}:${j}" title="Copy this line-up into ${esc(t.name)}">→ ${esc(t.name)}</button>`,
          )
          .join("") +
        `<button class="tbtn ban" aria-pressed="true" data-deldraft="${editTarget}">Delete</button></div>`
      : "");
  openModal("editor");
}

/* ---------- settings ---------- */
const startBadge = (kind, i) =>
  `<span class="tno">${kind === "team" ? "T" + (i + 1) : kind === "draft" ? "M" + (i + 1) : kind === "rival" ? "R" + (i + 1) : "–"}</span>`;
function renderStartPicker(T, kind) {
  const rv = rivalTeams();
  const ri = kind === "rival" ? rv.findIndex((x) => x.key === T.rivalKey) : 0,
    di = kind === "draft" ? state.calcStart.i : state.active;
  $("#startBtn").innerHTML =
    startBadge(kind, kind === "team" ? state.active : kind === "draft" ? di : ri) + `<span>${esc(T.name)}</span>`;
  const opt = (start, on, badge, label) =>
    `<button class="opt" data-start="${start}" aria-pressed="${on}">${badge}${label}</button>`;
  $("#pop-start").innerHTML =
    `<div class="grp">My teams</div>` +
    state.teams
      .map((t, i) =>
        opt(
          `team:${i}`,
          kind === "team" && state.active === i,
          startBadge("team", i),
          esc(t.name) + (t.example ? ' <span class="dim">example</span>' : ""),
        ),
      )
      .join("") +
    `<div class="grp">Manual teams</div>` +
    state.drafts
      .map((d, i) => opt(`draft:${i}`, kind === "draft" && di === i, startBadge("draft", i), esc(d.name)))
      .join("") +
    `<button class="opt" data-start="newdraft">＋ New manual team</button>` +
    `<div class="grp">Rival teams</div>` +
    (rv.length
      ? rv
          .map((r, i) =>
            opt(
              `rival:${i}`,
              kind === "rival" && ri === i,
              startBadge("rival", i),
              `<span>${esc(r.name)} <span class="dim">${esc(r.league)}</span></span>`,
            ),
          )
          .join("")
      : '<p class="note" style="padding:4px 8px">Unlock or import a league to pick rivals.</p>') +
    `<div class="grp">Other</div>` +
    opt("none", kind === "none", startBadge("none"), "No starting team (maximum budget only)");
}
function renderSettings() {
  const T = startTeam(),
    kind = startKind(),
    chipK = activeChip();
  renderStartPicker(T, kind);
  $("#exampleBanner").hidden = !T.example;
  $("#bank").disabled = $("#free").disabled = !!T.none;
  if (document.activeElement !== $("#bank")) $("#bank").value = T.none ? "" : T.bank;
  $("#free").value = String(Math.min(7, +T.free || 0) >= 4 ? 7 : +T.free || 0);
  $("#maxPen").value = state.maxPen == null ? "any" : String(state.maxPen);
  $("#maxPen").disabled = !!T.none || chipK === "wildcard" || chipK === "limitless";
  $("#maxBudget").disabled = !T.none;
  // the sections: open as the user left them, each summarised in its header
  for (const d of $$("#view-calc details.grp")) {
    const open = state.calcGrp[d.dataset.grp] !== false;
    if (d.open !== open) d.open = open;
  }
  const free = +T.free || 0;
  $("#grpTeam").textContent = T.none
    ? `none · max ${money(+state.maxBudget || 100)}`
    : `${T.name} · ${money(+T.bank || 0)} · ${free >= 4 ? "∞" : free} free`;
  $("#grpPlan").textContent =
    `${horizon() === 1 ? "next race" : horizon() + " races"} · ${chipK ? (CHIPS.find(([k]) => k === chipK) || [])[2] : "no chip"}`;
  $("#grpPrice").textContent = state.xdp ? `xΔ$Pts on · ${(+state.valW).toFixed(1)} pts per $1m` : "xΔ$Pts off";
  // a starting team plans from its budget and transfers; no team plans from a maximum budget
  $("#budgetField").hidden = $("#maxPen").closest(".field").hidden = !!T.none;
  $("#maxOr").hidden = $("#maxField").hidden = !T.none;
  needSync();
  if (document.activeElement !== $("#maxBudget"))
    $("#maxBudget").value = T.none ? +state.maxBudget || 100 : cap().toFixed(1);
  $$("[data-editteam],[data-keep]").forEach((b) => (b.disabled = !!T.none || (b.dataset.editteam && T.ro)));
  $$("#horizon button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.horizon === state.horizon)));
  $("#chipBar").innerHTML = CHIPS.filter(([k]) => k !== "finalfix")
    .map(([k, sh, n]) => {
      const used = T.chipsUsed[k];
      return `<button class="tbtn" data-chip="${k}" aria-pressed="${chipK === k}" ${used ? "disabled" : ""} title="${n}${used ? " (used)" : ""}">${sh}</button>`;
    })
    .join("");
  $("#chipsUsed").innerHTML = CHIPS.map(
    ([k, sh, n]) =>
      `<button class="tbtn ban" data-used="${k}" aria-pressed="${!!T.chipsUsed[k]}" title="${n}">${sh}</button>`,
  ).join("");
  const rem = Math.max(0, upcoming.length - 1);
  $("#xdp").checked = !!state.xdp;
  $("#xdpBox").hidden = !state.xdp;
  $("#xdpLabel").innerHTML =
    `How many points should a $1M budget increase earn you per future race? <i class="dim">(over ${rem} remaining race${rem === 1 ? "" : "s"})</i>`;
  if (document.activeElement !== $("#valW")) $("#valW").value = state.valW;
  $("#valWv").textContent = (+state.valW).toFixed(1) + " pts";
  const typing = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.flt != null;
  if (!typing) $("#calcFilters").innerHTML = filterUI("calc");
  const nf = filters("calc").length;
  $("#fltN").textContent = nf ? ` · ${nf}` : "";
  const prac = (DATA.practice || []).filter((x) => x.done).map((x) => x.name);
  const nxo = Object.keys(state.xo || {}).length,
    nadj = Object.keys(state.adj || {}).length;
  const edits = [
    nxo ? `${nxo} xPts edit${nxo > 1 ? "s" : ""}` : "",
    nadj ? `${nadj} pace nudge${nadj > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  const P = state.simPreset,
    upd = `Data updated ${esc(new Date(DATA.generated).toLocaleString(undefined, shortDate))}.`;
  $("#simNote").innerHTML =
    (P === "sim"
      ? `Fantasy Pit Wall's race simulation: <b>${state.sims.toLocaleString()}</b> weekends per race, scored with the ${DATA.season} rules. ` +
        `Practice used: ${prac.length ? esc(prac.join(", ")) : "none yet"}. `
      : SIM_NOTES[P] + " Ranges and odds still come from the simulated weekends. ") +
    upd +
    (edits.length ? ` <span class="warn">${edits.join(", ")} active.</span>` : "");
  $("#xoReset").hidden = !nxo;
  renderSim();
  applySplit();
  if (modalKind === "editor") openTeamEditor();
}

// wide screens: the Settings | Simulation divider's position = Settings' share of the column (0..1), null =
// automatic. Deliberately not saved: a reload goes back to the automatic split (the user's ask).
let setSplit = null;
function applySplit() {
  const col = $("#setSplit").parentElement;
  col.classList.toggle("split", setSplit != null);
  if (setSplit != null) col.style.setProperty("--setsplit", (setSplit * 100).toFixed(1) + "%");
}
function setSplitFrac(f) {
  const h = $("#setSplit").parentElement.clientHeight,
    min = Math.min(0.45, 140 / Math.max(1, h)); // keep both panels at least ~140px
  setSplit = Math.max(min, Math.min(1 - min, f));
  applySplit();
}

/* ---------- simulation presets ---------- */
const SIM_NOTES = {
  classic: "<b>Classic average</b>: each asset's points averaged over every round it raced this season.",
  weighted: "<b>Weighted average</b>: like Classic, but each older round counts less (the recency decay).",
  form: "<b>Form</b>: each asset's average over the last few rounds only.",
  ppm: "<b>Equal PPM</b>: each asset's price times the points per $1m of its kind (driver / constructor) and price tier (under / from $18.5m) this season.",
};
function renderSim() {
  const P = state.simPreset,
    past = P !== "sim";
  $("#simPreset").value = P;
  $("#simSprint").checked = sprintNext();
  $("#simSprintL").textContent =
    `Simulate a sprint weekend` + (NEXT ? ` (R${NEXT.gd} is ${NEXT.sprint ? "one" : "not"})` : "");
  $("#simPast").hidden = !past;
  if (!past) return;
  // scoring categories: whole sessions, then each category (as in Statistics)
  const off = new Set(state.simOff),
    codes = [...new Set((DATA.evNames || []).map((e) => e.c))];
  $("#simCatN").textContent = `${codes.filter((c) => !off.has(c)).length} / ${codes.length}`;
  $("#simCats").innerHTML = ["Q", "S", "R"]
    .map((ss) => {
      const cs = codes.filter((c) => c[0] === ss).sort();
      if (!cs.length) return "";
      return `<div class="catrow"><button class="tbtn" data-simsess="${ss}" aria-pressed="${cs.every((c) => !off.has(c))}">${SESSN[ss]}</button>${cs.map((c) => `<button class="tbtn" data-simcat="${c}" aria-pressed="${!off.has(c)}" title="${esc(evLabel(c))}">${esc(EVLABEL[c.slice(2)] || c.slice(2))}</button>`).join("")}</div>`;
    })
    .join("");
  $("#simDecayBox").hidden = P !== "weighted";
  $("#simWinBox").hidden = P !== "form";
  $("#simWin").max = String(Math.max(1, DATA.done.length));
  if (document.activeElement !== $("#simDecay")) $("#simDecay").value = String(state.simDecay);
  if (document.activeElement !== $("#simWin")) $("#simWin").value = String(state.simWin);
  $("#simDecayV").textContent = Math.round(state.simDecay * 100) + "%";
  $("#simWinV").textContent = state.simWin + (state.simWin === 1 ? " race" : " races");
  // each finished round's relative importance, newest first (skipped while a slider in it is being dragged)
  if ($("#simW").contains(document.activeElement)) return;
  const w = simWeights(),
    byGd = Object.fromEntries(DATA.schedule.map((g) => [g.gd, g]));
  $("#simW").innerHTML =
    `<thead><tr><th>Race</th><th title="Relative importance of each round in the average">Weight</th><th></th></tr></thead><tbody>` +
    DATA.done
      .slice()
      .reverse()
      .map((gd) => {
        const g = byGd[gd] || {},
          v = Math.max(0, Math.min(1, w[gd] ?? 1));
        return (
          `<tr><td title="${esc(g.name || "")}"><b>R${gd}</b>${g.sprint ? ' <span class="tag sprint">S</span>' : ""} <span class="dim">${esc(g.country || "")}</span></td>` +
          `<td><input type="range" min="0" max="1" step="0.01" value="${v}" data-simw="${gd}" aria-label="Weight of round ${gd}"></td>` +
          `<td class="simwv">${Math.round(v * 100)}%</td></tr>`
        );
      })
      .join("") +
    "</tbody>";
}

/* ---------- best teams ---------- */
let bestRows = { cur: null, pin: [], best: [] }; // what Best Teams shows: current, pinned and best line-ups
// optional Best Teams columns: [key, header, tooltip]
const BCOLS = [
  ["xd", "xΔ$", "Expected price change of the team ($m)"],
  ["xdp", "xΔ$Pts", "Expected price change points"],
  ["xsp", "xSPts", "xPts + xΔ$Pts"],
  ["tr", "Transfers", "Transfers from the starting team"],
  ["dnf", "DNF", "Expected retirements in the team"],
  ["fl", "FL", "Fastest-lap odds, summed"],
  ["dotd", "DotD", "Driver of the Day odds, summed"],
  ["ov", "xOV", "Expected overtakes"],
  ["neg", "xNeg", "Expected negative points"],
];
// sortable Best Teams columns: [key, header, tooltip]; the sort is also the optimiser's goal
const BSORT = [
  ["cost", "$", "Total cost"],
  ["x", "xPts", "Expected points"],
  ["xd", "xΔ$", "Expected price change"],
  ["xdp", "xΔ$Pts", "Expected price change points"],
  ["xsp", "xSPts", "Expected points + price change points"],
  ["dnf", "DNF", "Expected retirements"],
  ["fl", "FL", "Fastest-lap odds"],
  ["dotd", "DotD", "Driver of the Day odds"],
  ["ov", "xOV", "Expected overtakes"],
  ["neg", "xNeg", "Expected negative points"],
];
function bestSort() {
  const b = state.bsort,
    def = { k: state.xdp ? "xsp" : "x", d: -1 };
  if (!b || ((b.k === "xsp" || b.k === "xdp") && !state.xdp)) return def;
  if ((b.k === "x" || b.k === "xsp") && b.d > 0) return { k: b.k, d: -1 }; // points rank highest first only
  return b;
}
const visCols = () =>
  BCOLS.filter(
    ([k]) => (state.bcols || {})[k] ?? (k === "xd" ? !state.xdp : k === "xdp" || k === "xsp" ? !!state.xdp : false),
  );

// Everything the Calculator's numbers depend on. Points are summed over the horizon (1-3 races, keeping the team);
// the chip plays only in the next race, and the Boost goes to the team's best driver in each later race.
function calcCtx() {
  const chipK = activeChip(),
    H = horizon(),
    T = startTeam(),
    rem = Math.max(0, upcoming.length - 1);
  const vp = (id) => (!state.xdp || chipK === "limitless" ? 0 : priceEv(id) * state.valW * rem);
  // an asset's expected points in race k of the horizon (No Negative only in the next race)
  const pk = (id, k) => {
    const p = forecast.proj[k][id];
    return k === 0 && chipK === "noneg" ? p.nn : p.mean;
  };
  const e = (id) => {
    let s = 0;
    for (let k = 0; k < H; k++) s += pk(id, k);
    return s;
  };
  const unlimited = T.none || chipK === "wildcard" || chipK === "limitless";
  // the Boost's extra points: next race on `boost` (X3: 3x boost + 2x boost2; Autopilot: whoever scores most in
  // each simulated weekend), each later race on the team's best driver
  const boostPts = (ids, boost, boost2) => {
    let b;
    if (chipK === "autopilot") b = teamDist(ids, null, "autopilot").mean - teamDist(ids, null, "").mean;
    else b = (boost ? pk(boost, 0) * (chipK === "x3" ? 2 : 1) : 0) + (chipK === "x3" && boost2 ? pk(boost2, 0) : 0);
    const ds = ids.filter(isDriver);
    for (let k = 1; k < H; k++) b += Math.max(...ds.map((id) => pk(id, k)));
    return b;
  };
  // one team's numbers: xPts after Boost (and chip) and penalties, price-change points, and the column extras
  const stats = (ids, boost, boost2) => {
    const tr = T.none ? 0 : ids.filter((id) => !T.team.includes(id)).length;
    const pen = unlimited ? 0 : 10 * Math.max(0, tr - (+T.free || 0));
    const x = ids.reduce((a, id) => a + e(id), 0) + boostPts(ids, boost, boost2) - pen;
    const sum = (f) => ids.reduce((a, id) => a + f(id), 0),
      st = (id) => forecast.proj[0][id].st || {};
    const xdp = sum(vp);
    return {
      x,
      xdp,
      xsp: x + xdp,
      xd: sum(priceEv),
      cost: sum((id) => byId[id].price),
      tr,
      pen,
      dnf: sum((id) => st(id).dnf || 0),
      fl: sum((id) => st(id).fl || 0),
      dotd: sum((id) => st(id).dotd || 0),
      ov: sum((id) => st(id).xov || 0),
      neg: sum((id) => forecast.proj[0][id].mean - forecast.proj[0][id].nn),
    };
  };
  // the optimiser's Boost for a fixed line-up: best driver in the next race (and second best for X3)
  const boosts = (ids) => {
    const ds = ids.filter(isDriver).sort((a, b) => pk(b, 0) - pk(a, 0));
    return [ds[0], chipK === "x3" ? ds[1] : null];
  };
  // an asset's tile value: xPts over the horizon plus its Boost in the next race
  const tilePts = (r, id) =>
    e(id) + ((id === r.boost ? (chipK === "x3" ? 3 : 2) : id === r.boost2 ? 2 : 1) - 1) * pk(id, 0);
  return { chipK, H, T, rem, vp, pk, e, stats, boosts, tilePts, unlimited };
}
function runOptimiser() {
  const C = calcCtx(),
    { chipK, H, T, vp, pk, e, stats, boosts } = C;
  const fprop = (id) => {
    const p = forecast.proj[0][id],
      st = p.st || {};
    return {
      d: priceEv(id),
      dnf: st.dnf || 0,
      fl: st.fl || 0,
      dotd: st.dotd || 0,
      ov: st.xov || 0,
      neg: p.mean - p.nn,
    };
  };
  // the ranked list follows the sorted column: the optimiser maximises that column (or minimises it, ascending)
  const bs = bestSort(),
    sg = -bs.d,
    pts = bs.k === "x" || bs.k === "xsp";
  const goal = (id) =>
    bs.k === "x"
      ? e(id)
      : bs.k === "xsp"
        ? e(id) + vp(id)
        : bs.k === "xdp"
          ? vp(id)
          : bs.k === "cost"
            ? byId[id].price
            : bs.k === "xd"
              ? priceEv(id) // fprop calls it `d` (the filters' name)
              : (fprop(id)[bs.k] ?? 0);
  const cand = DATA.assets
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      price: a.price,
      active: a.kind === "C" || a.active,
      e: sg * goal(a.id),
      boostE:
        pts && a.kind === "D" && forecast.idx[a.id] != null ? Array.from({ length: H }, (_, k) => sg * pk(a.id, k)) : 0,
      f: fprop(a.id),
    }))
    .filter((c) => forecast.idx[c.id] != null);
  const locks = new Set(Object.keys(state.marks).filter((k) => state.marks[k] === "lock"));
  const bans = new Set(Object.keys(state.marks).filter((k) => state.marks[k] === "ban"));
  const flt = filters("calc");
  const res = Engine.optimise(cand, T.team, {
    cap: cap(),
    free: T.none ? 7 : +T.free || 0,
    maxT: maxTransfers(T),
    chip: chipK,
    locks,
    bans,
    top: 60,
    filters: flt,
    penW: pts ? 10 : 0,
  });

  const mk = (ids, boost, boost2) => ({ ids, boost, boost2, st: stats(ids, boost, boost2) });
  bestRows.cur = null;
  if (!T.none) {
    const [b1, b2] = boosts(T.team);
    bestRows.cur = mk(T.team.slice(), chipK === "x3" ? b1 : boostFor(T.team, 0, T), chipK === "x3" ? b2 : null);
  }
  bestRows.pin = state.pins.map((p) => {
    const [b1, b2] = boosts(p.ids);
    return mk(p.ids, b1, b2);
  });
  bestRows.best = res.map((r) => {
    const ids = r.drivers.concat(r.cons),
      [b1, b2] = pts ? [r.boost, r.boost2] : boosts(ids);
    return mk(ids, b1, b2);
  });
  bestRows.best.sort((a, b) => (a.st[bs.k] - b.st[bs.k]) * bs.d);

  const bits = [
    H > 1 ? `Summed over the next ${H} races, keeping the team (the chip plays in the first).` : `For ${NEXT.name}.`,
  ];
  if (chipK === "limitless") bits.push("Limitless: no budget cap or transfer limit; the team reverts after the race.");
  else if (chipK === "wildcard") bits.push("Wildcard: unlimited transfers within budget.");
  else if (!T.none)
    bits.push(
      `Transfers beyond ${T.free} free cost −10 each (included${state.maxPen == null ? "" : `; at most −${state.maxPen * 10}`}).`,
    );
  if (state.xdp)
    bits.push(
      `xΔ$Pts: ${(+state.valW).toFixed(1)} pts per $1m per race over ${C.rem} races; ranked by xSPts = xPts + xΔ$Pts.`,
    );
  if (locks.size || bans.size) bits.push(`${locks.size} included, ${bans.size} excluded.`);
  if (flt.length) bits.push(`${flt.length} team filter${flt.length > 1 ? "s" : ""}.`);
  if (!pts || bs.d > 0)
    bits.push(
      `Ranked by ${(BSORT.find(([k]) => k === bs.k) || [])[1]} (${bs.d < 0 ? "highest" : "lowest"} first); click a column header to change.`,
    );
  $("#optNote").textContent = bits.join(" ");
  $("#bestNote").textContent =
    `${T.name} · ${chipK === "limitless" ? "no budget cap" : (T.none ? "max budget " : "budget ") + money(cap())}`;
  $("#colList").innerHTML = BCOLS.map(([k, n, t]) => {
    const on = visCols().some(([c]) => c === k);
    return `<label class="switch" title="${esc(t)}"><input type="checkbox" data-bcol="${k}" ${on ? "checked" : ""}><span>${esc(n)} <span class="dim">${esc(t)}</span></span></label>`;
  }).join("");
  renderBestTable(C);
}
function renderBestTable(C) {
  const { chipK, T, vp, tilePts } = C,
    cols = visCols(),
    bs = bestSort(),
    sortK = bs.k;
  const ncol = 7 + cols.length;
  const tile = (r, id, kind) =>
    chip(id, {
      pts: tilePts(r, id),
      b: state.xdp ? f1(vp(id)) : sgn(priceEv(id), 2).replace("−0.00", "0.00"),
      x: id === r.boost ? (chipK === "x3" ? "3×" : "2×") : id === r.boost2 ? "2×" : "",
      cls: [kind !== "cur" && T.team.includes(id) ? "same" : "", forecast.proj[0][id].out ? "out" : ""].join(" "),
    });
  const cell = (k, st) => {
    const v = st[k];
    if (k === "xd") return `<td class="${v >= 0 ? "good" : "bad"}">${sgn(v, 2)}</td>`;
    if (k === "xdp") return `<td class="${v >= 0 ? "good" : "bad"}">${sgn(v, 1)}</td>`;
    if (k === "xsp") return `<td>${pill(f1(v), sortK === "xsp")}</td>`;
    if (k === "tr") return `<td>${st.tr}</td>`;
    if (k === "dnf" || k === "ov" || k === "neg") return `<td class="muted">${f1(v)}</td>`;
    return `<td class="muted">${pct(v)}</td>`;
  };
  const pinned = (ids) => state.pins.findIndex((p) => sameTeam(p.ids, ids));
  const rankCell = (kind, i, r) => {
    if (kind === "cur") return `<span title="Starting team">${PERSON_ICON}</span>`;
    if (kind === "pin")
      return `<button class="pinb on" data-unpin="${i}" title="Unpin" aria-label="Unpin">${PIN_ICON}</button>`;
    const pj = pinned(r.ids);
    return pj >= 0
      ? `<button class="pinb on" data-unpin="${pj}" title="Unpin" aria-label="Unpin team ${i + 1}">${PIN_ICON}</button><span class="n hide">${i + 1}</span>`
      : `<button class="pinb" data-pin="${i}" title="Pin this team" aria-label="Pin team ${i + 1}">${PIN_ICON}</button><span class="n">${i + 1}</span>`;
  };
  const row = (kind, i, r) => {
    const cons = r.ids.filter((id) => !isDriver(id)),
      boostsIn = [r.boost, r.boost2].filter(Boolean);
    const drs = r.ids.filter((id) => isDriver(id) && !boostsIn.includes(id)).sort((a, b) => C.e(b) - C.e(a));
    const st = r.st,
      over = !C.unlimited && kind === "pin" && st.cost > cap() + 1e-6;
    const pen = st.pen ? `<span class="pen">−${st.pen}</span>` : "";
    const tiles = (ids) => `<div class="chips">${ids.map((id) => tile(r, id, kind)).join("")}</div>`;
    // phones show one stacked cell (td.mv) instead of the desktop-only cells marked data-vc
    const mv = state.xdp
      ? pill(f1(st.xsp), true) + pill(f1(st.x), false)
      : pill(f1(st.x), true) + pill(sgn(st.xd, 2), false, st.xd >= 0 ? "good" : "bad");
    return `<tr><td class="rk">${rankCell(kind, i, r)}<br><button class="tbtn mobonly" data-menu="${kind}:${i}" aria-label="More actions">⋯</button></td>
      <td class="tl cr">${tiles(cons)}</td><td class="tl">${tiles(boostsIn)}</td><td class="tl dr">${tiles(drs)}</td>
      <td>${pill(st.cost.toFixed(1), sortK === "cost", over ? "bad" : "", over ? "Over budget" : "Total cost")}</td>
      <td data-vc="1">${pill(f1(st.x), sortK === "x")}${pen}</td>${cols.map(([k]) => cell(k, st).replace("<td", '<td data-vc="1"')).join("")}
      <td class="mv">${mv}${pen}</td>
      <td class="dots"><button class="tbtn" data-menu="${kind}:${i}" aria-label="More actions">⋯</button></td></tr>`;
  };
  const shown = bestRows.best.slice(0, state.showN || 20);
  const arrow = (k) => (k === sortK ? (bs.d < 0 ? " ↓" : " ↑") : "");
  const sth = (k, n, t, vc) => {
    const attrs =
      (vc ? ' data-vc="1"' : "") + (k === sortK ? ` aria-sort="${bs.d < 0 ? "descending" : "ascending"}"` : "");
    return BSORT.some(([b]) => b === k)
      ? `<th class="bsort" data-bsort="${k}" title="${esc(t)}. Click to rank by it"${attrs}>${n}${arrow(k)}</th>`
      : `<th title="${esc(t)}"${attrs}>${n}</th>`;
  };
  const hd =
    `<thead><tr><th>#</th><th style="text-align:left">CR</th><th style="text-align:left">x2</th><th style="text-align:left">DR</th>` +
    sth("cost", "$", "Total cost") +
    sth("x", "xPts", "Expected points (after Boost, chip and penalties)", true) +
    cols.map(([k, n, t]) => sth(k, n, t, true)).join("") +
    `<th class="mv">${state.xdp ? "xSPts ↓<br>xPts" : "xPts ↓<br>xΔ$"}</th><th class="dots"></th></tr></thead>`;
  const sec = (label, extra = "") => `<tr class="sec"><td colspan="${ncol}">${label}${extra}</td></tr>`;
  const wide = (html, center) =>
    `<tr><td colspan="${ncol}" class="${center ? "" : "muted"}" style="position:static;text-align:${center ? "center" : "left"}">${html}</td></tr>`;
  $("#bestTable").innerHTML =
    hd +
    "<tbody>" +
    (bestRows.cur ? sec("Current Team") + row("cur", 0, bestRows.cur) : "") +
    (bestRows.pin.length
      ? sec(
          "Pinned Teams",
          ` <button class="pinb on" style="display:inline-grid;vertical-align:middle" data-unpinall="1" title="Unpin all" aria-label="Unpin all">↺</button>`,
        ) + bestRows.pin.map((r, j) => row("pin", j, r)).join("")
      : "") +
    sec("Best Teams") +
    (shown.length
      ? shown.map((r, i) => row("best", i, r)).join("")
      : wide(
          "No team fits these limits. Allow a bigger transfer penalty, check the budget, or remove some Incl/Excl marks or filters.",
        )) +
    (bestRows.best.length > shown.length
      ? wide('<button class="btn ghost sm" data-more="1">Load more teams</button>', true)
      : "") +
    "</tbody>";
}

/* ---------- the ⋯ menu on a Best Teams row ---------- */
let menuRow = null;
const rowOf = (key) => {
  const [k, i] = key.split(":");
  return k === "cur" ? bestRows.cur : k === "pin" ? bestRows.pin[+i] : bestRows.best[+i];
};
function openMenu(btn) {
  const key = btn.dataset.menu,
    [k] = key.split(":"),
    r = rowOf(key),
    T = startTeam(),
    m = $("#rowMenu");
  if (!r) return;
  menuRow = key;
  const items = [state.pins.some((p) => sameTeam(p.ids, r.ids)) ? ["unpin", "Unpin team"] : ["pin", "Pin team"]];
  if (k !== "cur") items.push(["tr", "Show transfers"]);
  if (k !== "cur" && !T.none && !T.ro && activeChip() !== "limitless") items.push(["use", "Set as current team"]);
  if (k !== "cur") items.push(["save", "Save as manual team"]);
  items.push(["copy", "Copy team as text"]);
  m.innerHTML = items.map(([a, n]) => `<button data-mi="${a}">${n}</button>`).join("");
  const host = $("#view-calc").getBoundingClientRect(),
    b = btn.getBoundingClientRect();
  m.hidden = false;
  m.style.top = b.bottom - host.top + 4 + "px";
  m.style.left = Math.max(0, Math.min(host.width - m.offsetWidth, b.right - host.left - m.offsetWidth)) + "px";
}
const copyText = (txt) =>
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
    () => toast("Copied."),
    () => toast(txt),
  );
function pinTeam(ids) {
  state.pins = state.pins.concat([{ ids: ids.slice() }]).slice(-6);
  rerender();
}
function addDraft(name, team) {
  if (state.drafts.length >= 8) {
    toast("Up to 8 manual teams. Delete one in Calculator → Compare first.");
    return false;
  }
  state.drafts.push({ name, team: team.slice(), bank: 0, free: 2, chipsUsed: {}, boost: "auto" });
  return true;
}
function showTransfers(r) {
  const T = startTeam(),
    C = calcCtx();
  const outs = T.team.filter((id) => !r.ids.includes(id)),
    ins = r.ids.filter((id) => !T.team.includes(id));
  const line = (id, sign) => {
    const a = byId[id];
    return `<div class="mline"><span>${sign} ${esc(code(a))} <span class="muted">${esc(a.kind === "D" ? a.short : a.team)} · ${money(a.price)}</span></span><span>${f1(C.e(id))} <span class="muted">xΔ$ ${sgn(priceEv(id), 2)}</span></span></div>`;
  };
  const gain = ins.reduce((s, id) => s + C.e(id), 0) - outs.reduce((s, id) => s + C.e(id), 0);
  const body = T.none
    ? '<p class="note">No starting team: this is a fresh pick.</p>'
    : !ins.length
      ? '<p class="note">No changes from the starting team.</p>'
      : `<b style="font-size:13px">Out</b>${outs.map((id) => line(id, "−")).join("")}<b style="font-size:13px;margin-top:8px;display:block">In</b>${ins.map((id) => line(id, "+")).join("")}
      <div class="mline" style="margin-top:8px"><b>xPts change</b><b>${sgn(gain, 1)}${r.st.pen ? ` <span class="bad">(−${r.st.pen} penalty)</span>` : ""}</b></div>`;
  const boost = `<div class="mline"><span>Boost</span><span>${esc(code(byId[r.boost]))}${r.boost2 ? ` (3×) + ${esc(code(byId[r.boost2]))} (2×)` : ""}</span></div>`;
  $("#modalBody").innerHTML = `<h3 id="modalTitle">Transfers</h3>` + body + boost;
  openModal();
}
function menuAction(a) {
  const r = rowOf(menuRow),
    T = editStart();
  $("#rowMenu").hidden = true;
  if (!r) return;
  if (a === "pin") return pinTeam(r.ids);
  if (a === "unpin") {
    state.pins = state.pins.filter((p) => !sameTeam(p.ids, r.ids));
    return rerender();
  }
  if (a === "copy") {
    const x3 = activeChip() === "x3",
      cons = r.ids.filter((id) => !isDriver(id)),
      drs = r.ids.filter(isDriver);
    return copyText(
      teamText(
        menuRow.startsWith("cur") ? T.name : `R${NEXT.gd} option`,
        cons,
        drs,
        x3 ? r.boost2 : r.boost,
        x3 ? r.boost : null,
        r.st.cost,
        r.st.xsp,
      ),
    );
  }
  if (a === "save") {
    if (!addDraft("Option " + (state.drafts.length + 1), r.ids)) return;
    rerender();
    return toast("Saved as a manual team (see Compare, next to Best Teams).");
  }
  if (a === "use") {
    undoTeam = { ref: T, team: T.team.slice(), bank: T.bank, boost: T.boost, example: T.example };
    const oldCap = cap();
    Object.assign(T, {
      team: r.ids.filter(isDriver).concat(r.ids.filter((id) => !isDriver(id))),
      bank: Math.round(Math.max(0, oldCap - r.st.cost) * 10) / 10,
      boost: "auto",
      example: false,
    });
    rerender();
    return toast(`${T.name} updated. Make the same changes in the official game.`, true);
  }
  if (a === "tr") showTransfers(r);
}

/* ---------- drivers / constructors ---------- */
// search terms separated by "+" match any of code, name, team
const matchSearch = (a, q) =>
  !q ||
  q
    .split("+")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((t) =>
      [code(a), a.name, a.team, a.short].some((v) =>
        String(v || "")
          .toLowerCase()
          .includes(t),
      ),
    );
function renderAssetPanels() {
  const H = horizon(),
    C = calcCtx(),
    T = C.T;
  $("#drvNote").textContent = H > 1 ? `xPts: next race (editable) and over ${H} races` : "";
  const table = (kind, q) => {
    const list = DATA.assets.filter((a) => a.kind === kind && (a.active || kind === "C") && matchSearch(a, q));
    const val = (a) => xpts(a.id) + (state.xdp ? C.vp(a.id) : 0);
    list.sort((x, y) => val(y) - val(x));
    const xs = list.map(val),
      max = Math.max(...xs, 1),
      min = Math.min(...xs, 0);
    const head =
      `<thead><tr><th>${kind === "D" ? "DR" : "CR"}</th><th>$</th><th title="Expected points next race: type to override">xPts</th>` +
      (H > 1 ? `<th>${H} races</th>` : "") +
      (state.xdp
        ? '<th title="Expected price change points">xΔ$Pts</th><th title="xPts + xΔ$Pts">xSPts ↓</th>'
        : '<th title="Expected price change after the next race">xΔ$</th>') +
      `<th title="Include / exclude in Best Teams">Incl / Excl</th></tr></thead>`;
    const line = (a) => {
      const dv = priceEv(a.id),
        p = forecast.proj[0][a.id],
        mine = T.team.includes(a.id),
        ov = state.xo[a.id] != null;
      const input =
        `<input class="xin${ov ? " ov" : ""}" type="number" step="0.1" data-xo="${a.id}" value="${f1(p.mean)}" aria-label="xPts for ${esc(code(a))}" ` +
        `title="${ov ? `Your value. Model: ${f1(p.model)}. Clear it to go back.` : "Model value. Type your own to override."}">` +
        (ov
          ? `<button class="pinb" style="display:inline-grid" data-xoclear="${a.id}" title="Back to the model's ${f1(p.model)}" aria-label="Reset">↺</button>`
          : "");
      const value = state.xdp
        ? `<td class="${C.vp(a.id) >= 0 ? "good" : "bad"}">${sgn(C.vp(a.id), 1)}</td><td${heat(val(a), min, max)}><b>${f1(val(a))}</b></td>`
        : `<td class="${dv > 0.04 ? "good" : dv < -0.04 ? "bad" : "muted"}">${sgn(dv, 2)}</td>`;
      return `<tr><td><span class="who">${codeBox(a)}${mine ? '<span title="In the starting team" style="color:var(--accent)">●</span>' : ""}</span></td>
          <td>${f1(a.price)}</td><td>${input}</td>${H > 1 ? `<td>${f1(xpts(a.id))}</td>` : ""}${value}
          <td>${inclExcl(a.id, state.marks[a.id] || "")}</td></tr>`;
    };
    return head + "<tbody>" + list.map(line).join("") + "</tbody>";
  };
  $("#drvTable").innerHTML = table("D", $("#drvSearch").value);
  $("#conTable").innerHTML = table("C", $("#conSearch").value);
}
