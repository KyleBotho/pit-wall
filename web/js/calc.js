/* ---------- team calculator ----------
   Layout: Best Teams (left) | Settings + Simulation (middle) | Drivers + Constructors (right). The starting team is
   startTeam() (forecast.js); Best Teams come from Engine.optimise over every legal line-up. */
import {
  $,
  $$,
  CHIPS,
  DATA,
  NEXT,
  byId,
  chipName,
  code,
  col,
  esc,
  f1,
  isDriver,
  money,
  pct,
  sameTeam,
  sgn,
  shortDate,
  upcoming,
  infoTip,
} from "./core.js";
import { state } from "./state.js";
import { needSync, syncState } from "./sync.js";
import {
  activeChip,
  boostFor,
  cap,
  chip,
  codeBox,
  editStart,
  forecast,
  heat,
  horizon,
  lockedChips,
  maxTransfers,
  optionList,
  priceEv,
  rivalTeams,
  simWeights,
  sprintNext,
  startKind,
  startTeam,
  templateTeam,
  teamDist,
  teamSamples,
  teamValue,
  xpts,
} from "./forecast.js";
import { teamKey, tracked } from "./league.js";
import { step } from "./setup.js";
import { EVLABEL, SESSN, evLabel, filterUI, filters, teamText } from "./filters.js";
import { modalKind, openModal, rerender, toast, keepUndo } from "./main.js";

// Incl / Excl toggles for an asset (attr "mark" = the Calculator's, "hmark" = Hindsight's)
export const inclExcl = (id, m, attr = "mark") =>
  `<span class="mini"><button class="tbtn lock sm" data-${attr}="${id}" data-to="lock" aria-pressed="${m === "lock"}" aria-label="Include">✓</button>` +
  `<button class="tbtn ban sm" data-${attr}="${id}" data-to="ban" aria-pressed="${m === "ban"}" aria-label="Exclude">✕</button></span>`;
const PIN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z"/></svg>`;
const PERSON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;
const pill = (v, on, cls = "", title = "") =>
  `<span class="pill ${cls}${on ? " on" : ""}"${title ? ` title="${title}"` : ""}>${v}</span>`;

/* ---------- edit team (dialog) ---------- */
// what the editor changes: null = the starting team, a number = that manual team (from Compare's ✎)
export let editTarget = null;
export const endTeamEdit = () => (editTarget = null);
export const editing = () => (editTarget != null && state.drafts[editTarget] ? state.drafts[editTarget] : editStart());
export function openTeamEditor(target = editTarget) {
  editTarget = target != null && state.drafts[target] ? target : null;
  const draft = editTarget != null,
    team = draft ? state.drafts[editTarget] : startTeam();
  if (!draft && (team.none || team.ro))
    return toast(
      team.none
        ? "Pick one of your teams or a manual team first."
        : "A rival's line-up follows the tracking league. Save it as a manual team to edit it.",
    );
  const boost = boostFor(team.team, 0, team);
  const slot = (id, k) => {
    const a = byId[id],
      kind = k < 5 ? "D" : "C",
      isB = id === boost;
    const label = `${kind === "D" ? "Driver" : "Constructor"} ${k < 5 ? k + 1 : k - 4}`;
    const boostBtn =
      kind === "D"
        ? `<button class="tbtn" data-boost="${id}" aria-pressed="${isB}" title="Boost this driver">${isB && team.boost === "auto" ? "2× auto" : "2×"}</button>`
        : "<span></span>";
    return `<div class="slotrow" style="--tc:${col(a)}"><select id="slot-${k}" data-slot="${k}" aria-label="${label}">${optionList(kind, id)}</select>
        <span class="x">${forecast.proj[0][id].out ? '<span class="tag">out</span>' : f1(xpts(id, 1))}</span>${boostBtn}</div>`;
  };
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">Edit ${esc(team.name)}</h3>
    <label class="field">Team name<input id="tname" class="inp" type="text" maxlength="24" value="${esc(team.name)}"></label>
    ${team.example ? '<div class="banner">This is an <b>example team</b>. Pick your drivers and constructors below.</div>' : ""}
    <div class="slots">${team.team.map(slot).join("")}</div>` +
    (draft
      ? `<div class="chipbar" style="align-items:center"><span class="muted" style="margin-right:auto">${money(team.team.reduce((s, id) => s + byId[id].price, 0))}</span>` +
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
function renderStartPicker(team, kind) {
  const rv = rivalTeams();
  const ri = kind === "rival" ? rv.findIndex((x) => x.key === team.rivalKey) : 0,
    di = kind === "draft" ? state.calcStart.i : state.active;
  $("#startBtn").innerHTML =
    startBadge(kind, kind === "team" ? state.active : kind === "draft" ? di : ri) + `<span>${esc(team.name)}</span>`;
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
              `<span>${esc(r.name)} <span class="dim">${esc(r.user)}</span></span>`,
            ),
          )
          .join("")
      : "") +
    (syncState.user
      ? `<button class="opt" data-rivals="open">＋ Manage rivals</button>`
      : '<p class="note" style="padding:4px 8px">Sign in to pick rivals from the tracking league.</p>') +
    `<div class="grp">Other</div>` +
    opt("none", kind === "none", startBadge("none"), "No starting team (maximum budget only)");
}
export function renderSettings() {
  const team = startTeam(),
    kind = startKind(),
    chipK = activeChip();
  renderStartPicker(team, kind);
  // an example team, or no team because nothing is linked yet (not "none" picked on purpose): say how to get yours
  const st = step(),
    auto = team.none && !(state.calcStart && state.calcStart.type === "none");
  $("#exampleBanner").hidden = !(team.example || auto);
  $("#exampleText").innerHTML = team.example
    ? "This is an <b>example team</b>. Load your own teams, or press Edit to enter one by hand."
    : "<b>No starting team</b>: the Calculator picks teams from a maximum budget. " +
      (st === "linked"
        ? "Your linked teams load once F1's standings show their line-ups (after the next race)."
        : st === "signin"
          ? "Sign in and link your F1 Fantasy account to start from your own teams."
          : "Link your F1 Fantasy account to start from your own teams.");
  $("#bank").disabled = $("#free").disabled = !!team.none;
  if (document.activeElement !== $("#bank")) $("#bank").value = team.none ? "" : team.bank;
  $("#free").value = String(Math.min(7, +team.free || 0) >= 4 ? 7 : +team.free || 0);
  $("#maxPen").value = state.maxPen == null ? "any" : String(state.maxPen);
  $("#maxPen").disabled = !!team.none || chipK === "wildcard" || chipK === "limitless";
  $("#maxBudget").disabled = !team.none;
  // the sections: open as the user left them, each summarised in its header
  for (const d of $$("#view-calc details.grp")) {
    const open = state.calcGrp[d.dataset.grp] !== false;
    if (d.open !== open) d.open = open;
  }
  const free = +team.free || 0;
  $("#grpTeam").textContent = team.none
    ? `none · max ${money(+state.maxBudget || 100)}`
    : `${team.name} · ${money(+team.bank || 0)} · ${free >= 4 ? "∞" : free} free`;
  $("#grpPlan").textContent =
    `${horizon() === 1 ? "next race" : horizon() + " races"} · ${chipK ? (CHIPS.find(([k]) => k === chipK) || [])[2] : "no chip"}`;
  $("#grpPrice").textContent = state.xdp ? `xΔ$Pts on · ${(+state.valW).toFixed(1)} pts per $1m` : "xΔ$Pts off";
  // a starting team plans from its budget and transfers; no team plans from a maximum budget
  $("#budgetField").hidden = $("#maxPen").closest(".field").hidden = !!team.none;
  $("#maxOr").hidden = $("#maxField").hidden = !team.none;
  needSync();
  if (document.activeElement !== $("#maxBudget"))
    $("#maxBudget").value = team.none ? +state.maxBudget || 100 : cap().toFixed(1);
  $$("[data-editteam],[data-keep]").forEach((b) => (b.disabled = !!team.none || (b.dataset.editteam && team.ro)));
  $$("#horizon button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.horizon === state.horizon)));
  $("#planField").hidden = horizon() < 2;
  $("#goal").value = state.goal || "pts";
  const rivals = rivalTeams();
  $("#goalRival").hidden = $("#goalRivalMng").hidden = state.goal !== "rival";
  $("#goalRival").innerHTML = rivals.length
    ? `<option value="">Pick a rival…</option>` +
      rivals
        .map(
          (r) =>
            `<option value="${esc(r.key)}" ${r.key === state.goalRival ? "selected" : ""}>${esc(r.name)} · ${esc(r.user)}</option>`,
        )
        .join("")
    : `<option value="">No rivals yet: pick some with Manage rivals</option>`;
  // chips F1's data shows as played are locked; the rest can still be marked by hand (Autopilot, or a No Negative that
  // changed nothing, can't be seen in the data)
  const locked = lockedChips(team),
    playedIn = (k) => (locked[k] ? ` (played in R${locked[k]}, from F1's data)` : " (used)");
  $("#chipBar").innerHTML = CHIPS.filter(([k]) => k !== "finalfix")
    .map(([k, sh, n]) => {
      const used = team.chipsUsed[k] || locked[k];
      return `<button class="tbtn" data-chip="${k}" aria-pressed="${chipK === k}" ${used ? "disabled" : ""} title="${n}${used ? playedIn(k) : ""}">${sh}</button>`;
    })
    .join("");
  $("#chipsUsed").innerHTML = CHIPS.map(
    ([k, sh, n]) =>
      `<button class="tbtn ban" data-used="${k}" aria-pressed="${!!(team.chipsUsed[k] || locked[k])}" ${locked[k] ? "disabled" : ""} title="${n}${locked[k] ? playedIn(k) : ""}">${sh}</button>`,
  ).join("");
  const upTo = Object.keys(locked).length && tracked(teamKey(team))?.next?.asOf;
  $("#chipsNote").innerHTML = infoTip(
    upTo ? `Locked chips come from F1's data up to R${upTo}. Mark any others by hand.` : "",
  );
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
  $("#simNote").innerHTML = infoTip(
    (P === "sim"
      ? `Fantasy Pit Wall's race simulation: <b>${state.sims.toLocaleString()}</b> weekends per race, scored with the ${DATA.season} rules. ` +
        `Practice used: ${prac.length ? esc(prac.join(", ")) : "none yet"}. ` +
        raceInputs()
      : SIM_NOTES[P] + " Ranges and odds still come from the simulated weekends. ") + upd,
  );
  $("#simWarn").hidden = !edits.length; // a setting that changes the numbers stays in sight
  $("#simWarn").textContent = edits.length ? `${edits.join(", ")} active.` : "";
  $("#xoReset").hidden = !nxo;
  renderSim();
  applySplit();
  if (modalKind === "editor") openTeamEditor();
}

// what else shapes the next race's simulation: the market, rain, safety car, grid penalties, results already in
function raceInputs() {
  const su = forecast.setup;
  if (!su) return "";
  const c = su.circuit,
    known = Object.keys((su.simOpt && su.simOpt.known) || {}),
    pens = Object.entries((su.simOpt && su.simOpt.pen) || {}).filter(([, v]) => v);
  const names = { q: "qualifying", sq: "sprint qualifying", s: "sprint" };
  const bits = [
    su.odds ? `Betting market at ${Math.round(state.oddsW * 100)}%.` : "No market odds.",
    `Rain ${Math.round(((c.rain || {}).r || 0) * 100)}%, safety car ${Math.round((c.sc ?? 0) * 100)}%.`,
  ];
  if (pens.length)
    bits.push(`Grid penalties: ${pens.map(([t, v]) => `${esc(t)} ${v >= 99 ? "back" : "+" + v}`).join(", ")}.`);
  if (known.length)
    bits.push(`<b>Known ${known.map((k) => names[k] || k).join(", ")}: simulated from the actual order.</b>`);
  return bits.join(" ") + " ";
}

// wide screens: the Settings | Simulation divider's position = Settings' share of the column (0..1), null =
// automatic. Deliberately not saved: a reload goes back to the automatic split (the user's ask).
export let setSplit = null;
function applySplit() {
  const col = $("#setSplit").parentElement;
  col.classList.toggle("split", setSplit != null);
  if (setSplit != null) col.style.setProperty("--setsplit", (setSplit * 100).toFixed(1) + "%");
}
export function setSplitFrac(f) {
  const h = $("#setSplit").parentElement.clientHeight,
    min = Math.min(0.45, 140 / Math.max(1, h)); // keep both panels at least ~140px
  setSplit = Math.max(min, Math.min(1 - min, f));
  applySplit();
}
export function resetSplit() {
  setSplit = null;
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
export let bestRows = { cur: null, pin: [], best: [] }; // what Best Teams shows: current, pinned and best line-ups
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
  ["pb", "P(beat)", "Chance of outscoring the team to beat (Goal) in the next race"],
  ["pk", "P(+25)", "Chance of beating the team to beat by 25+ points in the next race (what moves your rank)"],
  ["dx", "xGap", "Expected points gained (+) or given up (-) on the team to beat"],
  ["dr", "Gap 10–90%", "Range of the points gap to the team to beat: bad weekend (10%) to good weekend (90%)"],
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
  ["pb", "P(beat)", "Chance of outscoring the team to beat"],
  ["pk", "P(+25)", "Chance of beating the team to beat by 25+"],
  ["dx", "xGap", "Expected points gained on the team to beat"],
];
// goal columns: need a team to beat, and like xPts they rank highest first
export const GOAL_COLS = ["pb", "pk", "dx", "dr"];
const GOAL_K = 25;
export function bestSort() {
  const b = state.bsort,
    def = { k: state.xdp ? "xsp" : "x", d: -1 };
  if (!b || ((b.k === "xsp" || b.k === "xdp") && !state.xdp)) return def;
  if (GOAL_COLS.includes(b.k) && !goalTarget()) return def;
  if ((b.k === "x" || b.k === "xsp" || GOAL_COLS.includes(b.k)) && b.d > 0) return { k: b.k, d: -1 }; // highest first
  return b;
}
const visCols = () =>
  BCOLS.filter(
    ([k]) =>
      (!GOAL_COLS.includes(k) || !!goalTarget()) &&
      ((state.bcols || {})[k] ??
        (k === "xd" ? !state.xdp : k === "xdp" || k === "xsp" ? !!state.xdp : GOAL_COLS.includes(k))),
  );

/* ---------- goals: beat a rival or the top-100 template ---------- */
// The team to beat for goal "rival" (one you picked in Manage rivals) or "template" / "template500" (forecast.js
// templateTeam); null for goal "pts".
function goalTarget() {
  if (state.goal === "rival") {
    const r = rivalTeams().find((x) => x.key === state.goalRival);
    return r ? { name: r.name, ids: r.ids, boost: r.boost } : null;
  }
  if (state.goal === "template" || state.goal === "template500")
    return templateTeam(state.goal === "template500" ? "top500" : "top100");
  return null;
}
// the target's simulated next-race scores (Boost as set, else its best projected driver), for P(beat)
function targetSamples(target) {
  const boost =
    target.boost && target.ids.includes(target.boost) ? target.boost : boostFor(target.ids, 0, { boost: "auto" });
  return teamSamples(target.ids, boost, "");
}

// Everything the Calculator's numbers depend on. Points are summed over the horizon (1-3 races, keeping the team);
// the chip plays only in the next race, and the Boost goes to the team's best driver in each later race.
function calcCtx() {
  const chipK = activeChip(),
    H = horizon(),
    team = startTeam(),
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
  const unlimited = team.none || chipK === "wildcard" || chipK === "limitless";
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
  // goal rival / template: the target's simulated scores, to give every team its chance of outscoring it
  const target = goalTarget(),
    tgS = target ? targetSamples(target) : null;
  // D = my team - the target, weekend by weekend (shared assets cancel): P(D > 0), P(D >= K), E[D], its 10-90%
  const vsTarget = (ids, boost, boost2, pen) => {
    if (!tgS) return {};
    const mine = teamSamples(ids, boost, chipK, boost2),
      n = mine.length,
      d = new Float64Array(n);
    let w = 0,
      k = 0,
      sum = 0;
    for (let s = 0; s < n; s++) {
      d[s] = mine[s] - pen - tgS[s];
      w += d[s] > 0 ? 1 : d[s] === 0 ? 0.5 : 0;
      if (d[s] >= GOAL_K) k++;
      sum += d[s];
    }
    d.sort();
    return { pb: w / n, pk: k / n, dx: sum / n, dlo: d[Math.floor(n * 0.1)], dhi: d[Math.floor(n * 0.9)] };
  };
  // one team's numbers: xPts after Boost (and chip) and penalties, price-change points, and the column extras
  const stats = (ids, boost, boost2) => {
    const tr = team.none ? 0 : ids.filter((id) => !team.team.includes(id)).length;
    const pen = unlimited ? 0 : 10 * Math.max(0, tr - (+team.free || 0));
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
      ...vsTarget(ids, boost, boost2, pen),
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
  return { chipK, H, T: team, rem, vp, pk, e, stats, boosts, tilePts, unlimited, tg: target };
}
export function runOptimiser() {
  const ctx = calcCtx(),
    { chipK, H, T: team, vp, pk, e, stats, boosts } = ctx;
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
  const sort = bestSort(),
    sg = -sort.d,
    pts = sort.k === "x" || sort.k === "xsp" || GOAL_COLS.includes(sort.k);
  const goal = (id) =>
    sort.k === "x" || GOAL_COLS.includes(sort.k)
      ? e(id)
      : sort.k === "xsp"
        ? e(id) + vp(id)
        : sort.k === "xdp"
          ? vp(id)
          : sort.k === "cost"
            ? byId[id].price
            : sort.k === "xd"
              ? priceEv(id) // fprop calls it `d` (the filters' name)
              : (fprop(id)[sort.k] ?? 0);
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
  const optO = {
    cap: cap(),
    free: team.none ? 7 : +team.free || 0,
    maxT: maxTransfers(team),
    chip: chipK,
    locks,
    bans,
    top: 60,
    filters: flt,
    penW: pts ? 10 : 0,
  };
  let res = Engine.optimise(cand, team.team, pts ? { ...optO, top: 400 } : optO);
  // how many teams sit within 5% of the best: one obvious team (chalky) or many near-equal ones (flat)
  const near =
    pts && res.length ? res.filter((r) => r.score >= res[0].score - 0.05 * Math.abs(res[0].score)).length : 0;
  res = res.slice(0, 60);
  // goal rival / template: expected points can't tell teams apart on beating someone (shared assets score for
  // both), so add the best teams with the shared assets counted at half (more differentials) and rank all of them
  // by the chance of outscoring the target
  if (ctx.tg && pts) {
    const shared = new Set(ctx.tg.ids);
    const half = (v, id) => (shared.has(id) ? v / 2 : v);
    const diff = cand.map((c) => ({
      ...c,
      e: half(c.e, c.id),
      boostE: Array.isArray(c.boostE) ? c.boostE.map((v) => half(v, c.id)) : c.boostE,
    }));
    const seen = new Set(res.map((r) => r.drivers.concat(r.cons).sort().join()));
    for (const r of Engine.optimise(diff, team.team, optO))
      if (!seen.has(r.drivers.concat(r.cons).sort().join())) res.push(r);
  }

  const mk = (ids, boost, boost2) => ({ ids, boost, boost2, st: stats(ids, boost, boost2) });
  bestRows.cur = null;
  if (!team.none) {
    const [b1, b2] = boosts(team.team);
    bestRows.cur = mk(
      team.team.slice(),
      chipK === "x3" ? b1 : boostFor(team.team, 0, team),
      chipK === "x3" ? b2 : null,
    );
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
  bestRows.best.sort((a, b) => (a.st[sort.k] - b.st[sort.k]) * sort.d);
  if (ctx.tg && pts) {
    const k = GOAL_COLS.includes(sort.k) && sort.k !== "dr" ? sort.k : "pb";
    bestRows.best.sort((a, b) => b.st[k] - a.st[k]);
    bestRows.best.length = Math.min(bestRows.best.length, 60);
  }

  const bits = [
    H > 1 ? `Summed over the next ${H} races, keeping the team (the chip plays in the first).` : `For ${NEXT.name}.`,
  ];
  if (chipK === "limitless") bits.push("Limitless: no budget cap or transfer limit; the team reverts after the race.");
  else if (chipK === "wildcard") bits.push("Wildcard: unlimited transfers within budget.");
  else if (!team.none)
    bits.push(
      `Transfers beyond ${team.free} free cost −10 each (included${state.maxPen == null ? "" : `; at most −${state.maxPen * 10}`}).`,
    );
  if (state.xdp)
    bits.push(
      `xΔ$Pts: ${(+state.valW).toFixed(1)} pts per $1m per race over ${ctx.rem} races; ranked by xSPts = xPts + xΔ$Pts.`,
    );
  if (near)
    bits.push(
      `${near >= 400 ? "400+" : near} team${near === 1 ? "" : "s"} within 5% of the best: ${near <= 5 ? "a chalky weekend (few obvious teams)" : near >= 60 ? "a flat weekend (many near-equal teams: pick on price changes, differentials or chips)" : "a normal spread"}.`,
    );
  if (ctx.tg && pts)
    bits.push(
      `Goal: beat ${ctx.tg.name}. Ranked by ${GOAL_COLS.includes(sort.k) && sort.k !== "dr" ? (BSORT.find(([k]) => k === sort.k) || [])[1] : "P(beat)"}: both teams scored on the same simulated weekends, so shared assets cancel. P(+${GOAL_K}) is the chance of a gain that moves your rank; xGap the average gain; Gap 10–90% the bad-to-good weekend range.`,
    );
  // a goal with nothing to beat stays in sight (the rest of the note is in the ⓘ)
  const warn =
    state.goal !== "pts" && !ctx.tg
      ? state.goal === "rival"
        ? "Goal: pick a rival in Plan & chip."
        : "Goal: no top-100 data yet."
      : "";
  if (locks.size || bans.size) bits.push(`${locks.size} included, ${bans.size} excluded.`);
  if (flt.length) bits.push(`${flt.length} team filter${flt.length > 1 ? "s" : ""}.`);
  if (!pts || sort.d > 0)
    bits.push(
      `Ranked by ${(BSORT.find(([k]) => k === sort.k) || [])[1]} (${sort.d < 0 ? "highest" : "lowest"} first); click a column header to change.`,
    );
  $("#optNote").innerHTML = infoTip(esc(bits.join(" ")));
  $("#bestNote").innerHTML =
    esc(
      `${team.name} · ${chipK === "limitless" ? "no budget cap" : (team.none ? "max budget " : "budget ") + money(cap())}`,
    ) + (warn ? ` · <span class="warn">${warn}</span>` : "");
  $("#colList").innerHTML = BCOLS.map(([k, n, t]) => {
    const on = visCols().some(([c]) => c === k);
    return `<label class="switch" title="${esc(t)}"><input type="checkbox" data-bcol="${k}" ${on ? "checked" : ""}><span>${esc(n)} <span class="dim">${esc(t)}</span></span></label>`;
  }).join("");
  renderBestTable(ctx);
}
function renderBestTable(ctx) {
  const { chipK, T: team, vp, tilePts } = ctx,
    cols = visCols(),
    sort = bestSort(),
    sortK = sort.k;
  const ncol = 7 + cols.length;
  const tile = (r, id, kind) =>
    chip(id, {
      pts: tilePts(r, id),
      b: state.xdp ? f1(vp(id)) : sgn(priceEv(id), 2).replace("−0.00", "0.00"),
      x: id === r.boost ? (chipK === "x3" ? "3×" : "2×") : id === r.boost2 ? "2×" : "",
      cls: [kind !== "cur" && team.team.includes(id) ? "same" : "", forecast.proj[0][id].out ? "out" : ""].join(" "),
    });
  const cell = (k, st) => {
    const v = st[k];
    if (k === "xd") return `<td class="${v >= 0 ? "good" : "bad"}">${sgn(v, 2)}</td>`;
    if (k === "xdp") return `<td class="${v >= 0 ? "good" : "bad"}">${sgn(v, 1)}</td>`;
    if (k === "xsp") return `<td>${pill(f1(v), sortK === "xsp")}</td>`;
    if (k === "tr") return `<td>${st.tr}</td>`;
    if (k === "dx") return `<td class="${v >= 0 ? "good" : "bad"}">${sgn(v, 1)}</td>`;
    if (k === "dr") return `<td class="muted">${sgn(st.dlo, 0)} … ${sgn(st.dhi, 0)}</td>`;
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
    const drs = r.ids.filter((id) => isDriver(id) && !boostsIn.includes(id)).sort((a, b) => ctx.e(b) - ctx.e(a));
    const st = r.st,
      over = !ctx.unlimited && kind === "pin" && st.cost > cap() + 1e-6;
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
  const arrow = (k) => (k === sortK ? (sort.d < 0 ? " ↓" : " ↑") : "");
  const sth = (k, n, t, vc) => {
    const attrs =
      (vc ? ' data-vc="1"' : "") + (k === sortK ? ` aria-sort="${sort.d < 0 ? "descending" : "ascending"}"` : "");
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
export let menuRow = null;
const rowOf = (key) => {
  const [k, i] = key.split(":");
  return k === "cur" ? bestRows.cur : k === "pin" ? bestRows.pin[+i] : bestRows.best[+i];
};
export function openMenu(btn) {
  const key = btn.dataset.menu,
    [k] = key.split(":"),
    r = rowOf(key),
    team = startTeam(),
    m = $("#rowMenu");
  if (!r) return;
  menuRow = key;
  const items = [state.pins.some((p) => sameTeam(p.ids, r.ids)) ? ["unpin", "Unpin team"] : ["pin", "Pin team"]];
  if (k !== "cur") items.push(["tr", "Show transfers"]);
  if (k !== "cur" && !team.none && !team.ro && activeChip() !== "limitless") items.push(["use", "Set as current team"]);
  if (k !== "cur") items.push(["save", "Save as manual team"]);
  items.push(["copy", "Copy team as text"]);
  m.innerHTML = items.map(([a, n]) => `<button data-mi="${a}">${n}</button>`).join("");
  const host = $("#view-calc").getBoundingClientRect(),
    b = btn.getBoundingClientRect();
  m.hidden = false;
  m.style.top = b.bottom - host.top + 4 + "px";
  m.style.left = Math.max(0, Math.min(host.width - m.offsetWidth, b.right - host.left - m.offsetWidth)) + "px";
}
export const copyText = (txt) =>
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
    () => toast("Copied."),
    () => toast(txt),
  );
export function pinTeam(ids) {
  state.pins = state.pins.concat([{ ids: ids.slice() }]).slice(-6);
  rerender();
}
export function addDraft(name, team) {
  if (state.drafts.length >= 8) {
    toast("Up to 8 manual teams. Delete one in Calculator → Compare first.");
    return false;
  }
  state.drafts.push({ name, team: team.slice(), bank: 0, free: 2, chipsUsed: {}, boost: "auto" });
  return true;
}
function showTransfers(r) {
  const team = startTeam(),
    ctx = calcCtx();
  const outs = team.team.filter((id) => !r.ids.includes(id)),
    ins = r.ids.filter((id) => !team.team.includes(id));
  const line = (id, sign) => {
    const a = byId[id];
    return `<div class="mline"><span>${sign} ${esc(code(a))} <span class="muted">${esc(a.kind === "D" ? a.short : a.team)} · ${money(a.price)}</span></span><span>${f1(ctx.e(id))} <span class="muted">xΔ$ ${sgn(priceEv(id), 2)}</span></span></div>`;
  };
  const gain = ins.reduce((s, id) => s + ctx.e(id), 0) - outs.reduce((s, id) => s + ctx.e(id), 0);
  const body = team.none
    ? '<p class="note">No starting team: this is a fresh pick.</p>'
    : !ins.length
      ? '<p class="note">No changes from the starting team.</p>'
      : `<b style="font-size:13px">Out</b>${outs.map((id) => line(id, "−")).join("")}<b style="font-size:13px;margin-top:8px;display:block">In</b>${ins.map((id) => line(id, "+")).join("")}
      <div class="mline" style="margin-top:8px"><b>xPts change</b><b>${sgn(gain, 1)}${r.st.pen ? ` <span class="bad">(−${r.st.pen} penalty)</span>` : ""}</b></div>`;
  const boost = `<div class="mline"><span>Boost</span><span>${esc(code(byId[r.boost]))}${r.boost2 ? ` (3×) + ${esc(code(byId[r.boost2]))} (2×)` : ""}</span></div>`;
  $("#modalBody").innerHTML = `<h3 id="modalTitle">Transfers</h3>` + body + boost;
  openModal();
}
export function menuAction(a) {
  const r = rowOf(menuRow),
    team = editStart();
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
        menuRow.startsWith("cur") ? team.name : `R${NEXT.gd} option`,
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
    keepUndo(team);
    const oldCap = cap();
    Object.assign(team, {
      team: r.ids.filter(isDriver).concat(r.ids.filter((id) => !isDriver(id))),
      bank: Math.round(Math.max(0, oldCap - r.st.cost) * 10) / 10,
      boost: "auto",
      example: false,
    });
    rerender();
    return toast(`${team.name} updated. Make the same changes in the official game.`, true);
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
export function renderAssetPanels() {
  const H = horizon(),
    ctx = calcCtx(),
    team = ctx.T;
  $("#drvNote").textContent = H > 1 ? `xPts: next race (editable) and over ${H} races` : "";
  const table = (kind, q) => {
    const list = DATA.assets.filter((a) => a.kind === kind && (a.active || kind === "C") && matchSearch(a, q));
    const val = (a) => xpts(a.id) + (state.xdp ? ctx.vp(a.id) : 0);
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
        mine = team.team.includes(a.id),
        ov = state.xo[a.id] != null;
      const input =
        `<input class="xin${ov ? " ov" : ""}" type="number" step="0.1" data-xo="${a.id}" value="${f1(p.mean)}" aria-label="xPts for ${esc(code(a))}" ` +
        `title="${ov ? `Your value. Model: ${f1(p.model)}. Clear it to go back.` : "Model value. Type your own to override."}">` +
        (ov
          ? `<button class="pinb" style="display:inline-grid" data-xoclear="${a.id}" title="Back to the model's ${f1(p.model)}" aria-label="Reset">↺</button>`
          : "");
      const value = state.xdp
        ? `<td class="${ctx.vp(a.id) >= 0 ? "good" : "bad"}">${sgn(ctx.vp(a.id), 1)}</td><td${heat(val(a), min, max)}><b>${f1(val(a))}</b></td>`
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

/* ---------- race-by-race plan (horizon 2-3) ---------- */
// The planner's races (Engine.planHorizon): each race's candidates (xΔ$Pts on the next race's price changes, as in
// Best Teams) and its simulated price changes, which move the budget for the one after.
function planStages(ctx, H) {
  const { pk, vp } = ctx;
  const stages = [];
  for (let k = 0; k < H; k++) {
    const cand = DATA.assets
      .filter((a) => forecast.idx[a.id] != null)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        price: a.price,
        active: a.kind === "C" || a.active,
        e: pk(a.id, k) + (k === 0 ? vp(a.id) : 0),
        boostE: a.kind === "D" ? pk(a.id, k) : 0,
      }));
    // price changes: the simulated next race's; later races' aren't simulated per sample, so they count as none
    stages.push({ cand, dPrice: k === 0 ? Object.fromEntries(cand.map((c) => [c.id, priceEv(c.id)])) : {} });
  }
  return stages;
}
export function openPlan() {
  const ctx = calcCtx(),
    { chipK, H, T: team, pk } = ctx;
  const stages = planStages(ctx, H);
  const locks = new Set(Object.keys(state.marks).filter((k) => state.marks[k] === "lock"));
  const bans = new Set(Object.keys(state.marks).filter((k) => state.marks[k] === "ban"));
  const plans = Engine.planHorizon(stages, team.team, {
    cap: cap(),
    free: team.none ? 7 : +team.free || 0,
    maxT: maxTransfers(team),
    chip: chipK,
    locks,
    bans,
    beam: 10,
  });
  const keep = bestRows.best[0];
  const p = plans[0];
  const races = forecast.races.slice(0, H);
  const body = p
    ? `<p class="note">Expected <b>${f1(p.total)}</b> pts over ${H} races${keep ? ` (the best team kept for all ${H}: ${f1(keep.st.x + (keep.st.xdp || 0))})` : ""}. Transfers beyond the free ones cost −10 each.</p>` +
      p.steps
        .map((st, k) => {
          const g = races[k],
            prev = k ? p.steps[k - 1].team : team.team,
            ins = st.team.filter((id) => !prev.includes(id)),
            outs = prev.filter((id) => !st.team.includes(id));
          const ds = st.team.filter(isDriver),
            cs = st.team.filter((id) => !isDriver(id));
          return `<div class="panel" style="margin:8px 0"><b>R${g.gd} ${esc(g.name.replace(" Grand Prix", " GP"))}</b> <span class="muted">${f1(st.pts)} pts · budget ${money(st.cap)} · ${st.transfers} transfer${st.transfers === 1 ? "" : "s"}${st.penalty ? ` (−${st.penalty})` : ""}</span>
          <div class="chipbar" style="margin-top:6px">${cs.map((id) => chip(id, { pts: pk(id, k) })).join("")}<span class="sep"></span>${ds.map((id) => chip(id, { pts: pk(id, k), x: id === st.boost ? (k === 0 && chipK === "x3" ? "3×" : "2×") : id === st.boost2 ? "2×" : "" })).join("")}</div>
          ${ins.length ? `<div class="note">Out: ${outs.map((id) => esc(code(byId[id]))).join(", ")} → In: ${ins.map((id) => esc(code(byId[id]))).join(", ")}</div>` : `<div class="note">No changes.</div>`}</div>`;
        })
        .join("")
    : `<p class="note">No legal plan within the budget and transfer limits.</p>`;
  $("#modalBody").innerHTML =
    `<h3>Race-by-race plan</h3>${body}<p class="note dim">Beam search over the best teams for the first race and for keeping all ${H} races, then the best few moves each race. Price changes after the next race are simulated; later ones aren't counted.</p>`;
  openModal("plan");
}

/* ---------- chip values and Final Fix (the starting team, next race) ---------- */
// Each chip's expected gain for the starting team next race, from the same simulated weekends: X3, No Negative,
// Autopilot (with the chance it moves the Boost), Wildcard and Limitless (best team with the chip vs without).
// Once qualifying is in, Final Fix: the best single driver swap on the points still to be scored.
export function openChipValues() {
  const team = startTeam();
  if (team.none) {
    $("#modalBody").innerHTML = `<h3>Chip values</h3><p class="note">Pick a starting team first.</p>`;
    return openModal("chips");
  }
  const pr = forecast.proj[0],
    mean = (id) => pr[id].mean,
    ids = team.team,
    ds = ids.filter(isDriver).sort((a, b) => mean(b) - mean(a));
  const boost = boostFor(ids, 0, team),
    base = teamDist(ids, boost, "").mean;
  // autopilot: how often the best scorer isn't the Boost you picked
  const sim = forecast.sims[0],
    N = sim.N;
  let moved = 0;
  for (let s = 0; s < N; s++) {
    let best = null,
      bv = -1e9;
    for (const id of ds) {
      const i = forecast.idx[id],
        v = i == null ? -25 : sim.tot[i * N + s] + pr[id].shift;
      if (v > bv) {
        bv = v;
        best = id;
      }
    }
    if (best !== boost) moved++;
  }
  // wildcard / limitless: best team with the chip vs the best normal move (next race only)
  const cand = DATA.assets
    .filter((a) => forecast.idx[a.id] != null)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      price: a.price,
      active: a.kind === "C" || a.active,
      e: mean(a.id),
      boostE: a.kind === "D" ? mean(a.id) : 0,
    }));
  const o = { cap: cap(), free: +team.free || 0, maxT: maxTransfers(team), locks: new Set(), bans: new Set(), top: 1 };
  const bestOf = (chip) => (Engine.optimise(cand, team.team, { ...o, chip })[0] || { score: NaN }).score;
  const normal = bestOf("");
  const rows = [
    ["x3", teamDist(ids, ds[0], "x3", ds[1]).mean - base, `3× ${code(byId[ds[0]])}, 2× ${code(byId[ds[1]])}`],
    ["noneg", teamDist(ids, boost, "noneg").mean - base, "every negative scoring line counts as 0"],
    [
      "autopilot",
      teamDist(ids, null, "autopilot").mean - base,
      `moves the Boost off ${code(byId[boost])} in ${Math.round((100 * moved) / N)}% of weekends`,
    ],
    ["wildcard", bestOf("wildcard") - normal, "best team with unlimited transfers vs your best normal move"],
    ["limitless", bestOf("limitless") - normal, "best team with no budget cap vs your best normal move"],
  ];
  const used = team.chipsUsed || {};
  let html =
    `<h3>Chip values <small>${esc(team.name)} · ${esc(NEXT.name.replace(" Grand Prix", " GP"))}</small></h3>` +
    `<p class="note">Expected extra points in the next race, from the same simulated weekends. Rules of thumb from the community: No Negative is usually worth 25–30 (more in the wet); Limitless is worth most early in a season and on sprint weekends.</p>` +
    `<div class="tw"><table class="stat"><thead><tr><th>Chip</th><th>Gain</th><th style="text-align:left">How</th></tr></thead><tbody>` +
    rows
      .map(
        ([k, g, how]) =>
          `<tr class="${used[k] ? "dim" : ""}"><td>${esc(chipName(k))}${used[k] ? " (used)" : ""}</td><td class="${g > 0 ? "good" : "muted"}"><b>${sgn(g, 1)}</b></td><td style="text-align:left" class="muted">${how}</td></tr>`,
      )
      .join("") +
    "</tbody></table></div>";
  html += finalFixHtml(team, boost);
  $("#modalBody").innerHTML = html;
  openModal("chips");
}
// Final Fix: once qualifying (and the sprint) are known, points still to be scored = the simulated total minus what
// qualifying (and the sprint) already paid. The swapped-in driver keeps the slot's Boost. Constructors can't be fixed.
function finalFixHtml(team, boost) {
  const known = (forecast.setup && forecast.setup.simOpt && forecast.setup.simOpt.known) || {};
  if (!known.q)
    return `<h3 style="margin-top:14px">Final Fix</h3><p class="note">Available once qualifying is in: the next race is then simulated from the actual grid and this shows the best swap on the points still to be scored.</p>`;
  const pr = forecast.proj[0];
  const rem = (id) => {
    const c = (pr[id].st && pr[id].st.cat) || {};
    return pr[id].mean - (c.q || 0) - (known.s ? c.sprint || 0 : 0);
  };
  const room = cap() - teamValue();
  let best = null;
  for (const out of team.team.filter(isDriver))
    for (const a of DATA.assets) {
      if (a.kind !== "D" || !a.active || team.team.includes(a.id) || forecast.idx[a.id] == null) continue;
      if (a.price > room + byId[out].price + 1e-9) continue;
      const g = (rem(a.id) - rem(out)) * (out === boost ? 2 : 1);
      if (!best || g > best.g) best = { out, inn: a.id, g };
    }
  if (!best) return `<h3 style="margin-top:14px">Final Fix</h3><p class="note">No swap fits the budget.</p>`;
  const worth = best.g >= 20;
  return (
    `<h3 style="margin-top:14px">Final Fix <small>qualifying known</small></h3>` +
    `<p class="note">Best swap: <b>${esc(code(byId[best.out]))} → ${esc(code(byId[best.inn]))}</b>, <b class="${worth ? "good" : "muted"}">${sgn(best.g, 1)}</b> points still to be scored${best.out === boost ? " (the Boost stays on the slot)" : ""}. ` +
    (team.chipsUsed && team.chipsUsed.finalfix
      ? "Final Fix is already used."
      : worth
        ? "Worth it: the usual threshold is about +20."
        : "Probably not worth the chip: the usual threshold is about +20.") +
    `</p>`
  );
}

/* ---------- what more budget is worth (the starting team, the horizon's races) ---------- */
// Engine.budgetCurve: the best team at every budget in $0.1m steps, once from your line-up (your free transfers,
// −10 for each extra) and once with a free rebuild (what the money buys once every seat can change). The payoff
// comes in steps: +$0.3m can be worth nothing and +$0.4m a whole upgrade. Compared with the flat rate the xΔ$Pts
// setting uses.
const BV_COL = { own: "#a855f7", wild: "#0891b2" }; // accent + cyan: checked for colour-blind separation on --card
const bvMoney = (d) => (d ? sgn(d, 1).replace(/^([+−])/, "$1$") + "m" : "Your budget");
export function openBudgetValue() {
  const { H, T: team, pk, rem } = calcCtx();
  const B = Math.round(cap() * 10) / 10,
    lo = Math.round((B - 2) * 10) / 10,
    hi = Math.round((B + 5) * 10) / 10;
  const cand = DATA.assets
    .filter((a) => forecast.idx[a.id] != null)
    .map((a) => {
      const per = Array.from({ length: H }, (_, k) => pk(a.id, k));
      return {
        id: a.id,
        kind: a.kind,
        price: a.price,
        active: a.kind === "C" || a.active,
        e: per.reduce((s, v) => s + v, 0),
        boostE: a.kind === "D" ? per : 0,
      };
    });
  const marks = (to) => new Set(Object.keys(state.marks).filter((k) => state.marks[k] === to));
  const o = { maxT: maxTransfers(team), chip: "", locks: marks("lock"), bans: marks("ban"), lo, hi };
  const curves = {
    own: team.none ? null : Engine.budgetCurve(cand, team.team, { ...o, free: +team.free || 0 }),
    wild: Engine.budgetCurve(cand, [], { ...o, chip: "wildcard", free: 7, maxT: 7 }),
  };
  const at = (c, b) => c && c[Math.round((b - lo) * 10)];
  // gain per race over the horizon against the best team at your budget
  const gain = (c, d) => {
    const x = at(c, B + d),
      b0 = at(c, B);
    return x && b0 && x.score != null && b0.score != null ? (x.score - b0.score) / H : null;
  };
  const ds = [];
  for (let d = -2; d <= 5 + 1e-9; d += 0.1) ds.push(Math.round(d * 10) / 10);
  const label = { own: `From ${team.none ? "your team" : team.name}`, wild: "Free rebuild" };
  const series = ["own", "wild"]
    .filter((k) => curves[k])
    .map((k) => ({ k, name: label[k], col: BV_COL[k], pts: ds.map((d) => gain(curves[k], d)) }));
  const flat = (d) => (+state.valW || 0) * d;
  const buys = (c, d) => {
    const a = at(c, B),
      b = at(c, B + d);
    if (!a || !b || a.score == null || b.score == null) return "";
    const ia = a.drivers.concat(a.cons),
      ib = b.drivers.concat(b.cons);
    const ins = ib.filter((id) => !ia.includes(id)),
      outs = ia.filter((id) => !ib.includes(id));
    return ins.length
      ? `${outs.map((id) => code(byId[id])).join(", ")} → ${ins.map((id) => code(byId[id])).join(", ")}`
      : "no change";
  };
  const g1 = (k) => gain(curves[k], 1);
  const races = forecast.races
    .slice(0, H)
    .map((g) => `R${g.gd}`)
    .join("–");
  let html =
    `<h3>What more budget is worth <small>${esc(team.none ? "no starting team" : team.name)} · ${money(B)} · ${races}</small></h3>` +
    `<p class="note">The best team you could field at each budget, on the expected points of ${races}, per race, against the best at your budget. ` +
    `Right now +$1m is worth <b>${g1("own") == null ? "—" : sgn(g1("own"), 1)}</b> pts a race from your team and <b>${sgn(g1("wild") ?? 0, 1)}</b> with a free rebuild. ` +
    `The xΔ$Pts setting counts it as a flat <b>${(+state.valW).toFixed(1)}</b>${state.xdp ? "" : " (off)"} for each of the ${rem} race${rem === 1 ? "" : "s"} after this one. ` +
    `Money only helps once it reaches the next step.</p>` +
    `<div id="bvChart" style="position:relative"></div>`;
  const rows = [-1, -0.5, 0.5, 1, 2, 3, 5];
  html +=
    `<div class="tw"><table class="stat"><thead><tr><th>Budget</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join("")}<th title="The xΔ$Pts setting's flat rate">Setting</th><th style="text-align:left">Free rebuild buys</th></tr></thead><tbody>` +
    rows
      .map((d) => {
        const cell = (s) => {
          const v = gain(curves[s.k], d);
          return `<td class="${v > 0.05 ? "good" : v < -0.05 ? "bad" : "muted"}">${v == null ? "—" : sgn(v, 1)}</td>`;
        };
        return `<tr><td>${bvMoney(d)} <span class="dim">(${money(B + d)})</span></td>${series.map(cell).join("")}<td class="muted">${sgn(flat(d), 1)}</td><td style="text-align:left" class="muted">${esc(buys(curves.wild, d))}</td></tr>`;
      })
      .join("") +
    "</tbody></table></div>" +
    `<p class="note dim">Points per race over ${races}. "From your team" counts −10 for each transfer beyond your free ones, spread over those races. Incl / Excl marks apply. Races after ${races} aren't simulated, so take the long-run value as a guide.</p>`;
  $("#modalBody").innerHTML = html;
  openModal("budget");
  bvChart($("#bvChart"), ds, series, flat);
}
// Step chart of gain per race against budget change, the flat setting dashed for reference; hover shows the values.
function bvChart(box, ds, series, flat) {
  const W = Math.max(300, Math.round(box.clientWidth || 600)),
    Hh = 220,
    ml = 44,
    mr = 16,
    mt = 12,
    mb = 30;
  const vs = series.flatMap((s) => s.pts.filter((v) => v != null)).concat(ds.map(flat));
  const step = [1, 2, 5, 10, 20].find((st) => (Math.max(...vs) - Math.min(...vs)) / st <= 6) || 50;
  const top = Math.ceil(Math.max(0, ...vs) / step) * step,
    bot = Math.floor(Math.min(0, ...vs) / step) * step;
  const x = (d) => ml + ((d - ds[0]) / (ds[ds.length - 1] - ds[0])) * (W - ml - mr);
  const y = (v) => mt + (1 - (v - bot) / Math.max(1e-9, top - bot)) * (Hh - mt - mb);
  let g = "";
  for (let v = bot; v <= top + 1e-9; v += step)
    g += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? "#52525B" : "#27272A"}"/><text x="${ml - 8}" y="${y(v) + 4}" fill="#A1A1AA" font-size="12" text-anchor="end">${v === 0 ? "0" : sgn(v, 0)}</text>`;
  for (let d = -2; d <= 5; d++)
    g += `<text x="${x(d)}" y="${Hh - 10}" fill="#A1A1AA" font-size="12" text-anchor="middle">${d === 0 ? "yours" : sgn(d, 0)}</text>`;
  g += `<line x1="${x(0)}" x2="${x(0)}" y1="${mt}" y2="${Hh - mb}" stroke="#52525B" stroke-dasharray="2 3"/>`;
  g += `<path d="M${x(ds[0])},${y(flat(ds[0]))}L${x(ds[ds.length - 1])},${y(flat(ds[ds.length - 1]))}" stroke="#8b8b94" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>`;
  for (const s of series) {
    // a step line: flat until the budget reaches the next team
    let d = "",
      prev = null;
    s.pts.forEach((v, i) => {
      if (v == null) {
        prev = null;
        return;
      }
      d += prev == null ? `M${x(ds[i])},${y(v)}` : `H${x(ds[i])}V${y(v)}`;
      prev = v;
    });
    g += `<path d="${d}" stroke="${s.col}" stroke-width="2" fill="none" stroke-linejoin="round"/>`;
  }
  const key = (s) =>
    `<span><svg width="14" height="4" aria-hidden="true"><rect width="14" height="3" rx="1.5" fill="${s.col}"/></svg> ${esc(s.name)}</span>`;
  box.innerHTML =
    `<div class="chipbar" style="font-size:12px;margin:6px 0">${series.map(key).join("")}<span class="muted"><svg width="14" height="4" aria-hidden="true"><line x1="0" x2="14" y1="2" y2="2" stroke="#8b8b94" stroke-width="1.5" stroke-dasharray="4 3"/></svg> Your xΔ$Pts setting</span><span class="dim">x: $m more or less than yours · y: pts per race</span></div>` +
    `<svg class="chart" viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Points per race gained or lost at each budget">${g}<line class="cx" y1="${mt}" y2="${Hh - mb}" stroke="#A1A1AA" stroke-dasharray="3 3" visibility="hidden"/><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${Hh - mt - mb}" fill="transparent"/></svg><div class="lgtip" hidden></div>`;
  const svg = box.querySelector("svg"),
    tip = box.querySelector(".lgtip"),
    cross = box.querySelector(".cx");
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect(),
      px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(ds.length - 1, Math.round(((px - ml) / (W - ml - mr)) * (ds.length - 1))));
    cross.setAttribute("x1", x(ds[i]));
    cross.setAttribute("x2", x(ds[i]));
    cross.setAttribute("visibility", "visible");
    tip.innerHTML =
      `<b>${bvMoney(ds[i])}</b>` +
      series
        .map((s) => `<div><span>${esc(s.name)}</span><span>${s.pts[i] == null ? "—" : sgn(s.pts[i], 1)}</span></div>`)
        .join("") +
      `<div class="muted"><span>Setting</span><span>${sgn(flat(ds[i]), 1)}</span></div>`;
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth, Math.max(0, (x(ds[i]) / W) * r.width + 12)) + "px";
    tip.style.top = "36px";
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

/* ---------- what a transfer is worth (the starting team, every simulated race) ---------- */
// Engine.planHorizon over every simulated race, once per number of transfers made now (0, 1, 2 ...; unused free
// ones carry over, extras cost −10), and once with one more free transfer. Spend now or bank, and whether a hit pays.
// The plans stop at the last simulated race, so a transfer still banked then counts for nothing: that edge
// undervalues banking a little.
export function openTransferValue() {
  const team = startTeam(),
    chipK = activeChip();
  const title = `<h3>What is a transfer worth? <small>${esc(team.none ? "no starting team" : team.name)}</small></h3>`;
  if (team.none) {
    $("#modalBody").innerHTML = title + `<p class="note">Pick a starting team first.</p>`;
    return openModal("transfer");
  }
  if (chipK === "wildcard" || chipK === "limitless") {
    $("#modalBody").innerHTML =
      title +
      `<p class="note">With ${esc(chipName(chipK))} every transfer this race is free. Clear the chip to see what a transfer is worth.</p>`;
    return openModal("transfer");
  }
  $("#modalBody").innerHTML = title + `<p class="note">Working it out…</p>`;
  openModal("transfer");
  setTimeout(() => {
    if (modalKind !== "transfer") return;
    const ctx = calcCtx(),
      n = forecast.races.length,
      stages = planStages(ctx, n),
      free = Math.max(0, +team.free || 0);
    const marks = (to) => new Set(Object.keys(state.marks).filter((k) => state.marks[k] === to));
    const o = { cap: cap(), free, maxT: 7, chip: chipK, locks: marks("lock"), bans: marks("ban"), beam: 6 };
    const plan = (x) => Engine.planHorizon(stages, team.team, { ...o, ...x })[0] || null;
    const rows = [];
    // one row per number actually used: a cap of k that still uses fewer repeats the row above
    for (let k = 0; k <= Math.min(7, free + 2); k++) {
      const p = plan({ firstMaxT: k });
      if (!p || p.steps[0].transfers === k) rows.push({ k, p });
    }
    const ok = rows.filter((r) => r.p);
    const best = ok.reduce((a, r) => (!a || r.p.total > a.p.total + 1e-9 ? r : a), null);
    const extra = plan({ free: free + 1 });
    const races = forecast.races.map((g) => `R${g.gd}`).join("–");
    const moves = (p) => {
      const st = p.steps[0],
        outs = team.team.filter((id) => !st.team.includes(id)),
        ins = st.team.filter((id) => !team.team.includes(id));
      return ins.length
        ? `${outs.map((id) => code(byId[id])).join(", ")} → ${ins.map((id) => code(byId[id])).join(", ")}`
        : "keep";
    };
    const used = (p) => p.steps[0].transfers;
    const gainExtra = extra && best ? extra.total - best.p.total : null;
    const bank = best && used(best.p) < free;
    let html =
      title +
      `<p class="note">${free} free transfer${free === 1 ? "" : "s"} now; each race adds 2 and one unused carries (3 at most); extras cost −10. Plans run over the ${n} simulated races (${races}), with the xΔ$Pts setting on the next race's price changes as in the planner.</p>` +
      (best
        ? `<p>Best: <b>${used(best.p)} transfer${used(best.p) === 1 ? "" : "s"} now</b>${bank ? `, banking ${free - used(best.p)}` : used(best.p) > free ? `, taking a −${10 * (used(best.p) - free)} hit` : ""}. ` +
          `One more free transfer now would be worth <b class="${gainExtra > 0.05 ? "good" : "muted"}">${sgn(gainExtra ?? 0, 1)}</b> over ${races}.</p>`
        : `<p class="note">No legal plan within the budget.</p>`);
    html +=
      `<div class="tw"><table class="stat"><thead><tr><th title="Transfers made in the first race">Transfers now</th><th>Penalty now</th><th title="Expected points over the simulated races, penalties included">Plan total</th><th>vs best</th><th style="text-align:left">Now</th><th title="Transfers in the later races of the plan">Later</th></tr></thead><tbody>` +
      rows
        .map(({ k, p }) => {
          if (!p) return `<tr><td>${k}</td><td colspan="5" class="dim">no legal plan</td></tr>`;
          const d = p.total - best.p.total,
            me = p === best.p;
          return `<tr${me ? ' style="background:var(--accent-soft)"' : ""}><td>${k}</td><td class="${p.steps[0].penalty ? "bad" : "muted"}">${p.steps[0].penalty ? "−" + p.steps[0].penalty : "0"}</td><td><b>${f1(p.total)}</b></td><td class="${me ? "muted" : "bad"}">${me ? "best" : sgn(d, 1)}</td><td style="text-align:left" class="muted">${esc(moves(p))}</td><td class="muted">${p.steps
            .slice(1)
            .map((s) => s.transfers)
            .join(", ")}</td></tr>`;
        })
        .join("") +
      "</tbody></table></div>" +
      `<p class="note dim">Beam search, like the race-by-race plan. A transfer still banked after ${forecast.races[n - 1] ? "R" + forecast.races[n - 1].gd : "the last race"} counts for nothing here, so banking looks slightly worse than it is. Incl / Excl marks apply; the maximum penalty setting doesn't (every hit is shown).</p>`;
    $("#modalBody").innerHTML = html;
  }, 30);
}
