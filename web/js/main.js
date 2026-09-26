/* ---------- orchestration: views, rendering, events, start-up ---------- */
import { $, $$, DATA, FORECAST_VIEWS, NEXT, SEASON_OVER, alignTable, byId, esc } from "./core.js";
import { VIEWS, activeTeam, state } from "./state.js";
import {
  askWhich,
  pull,
  pullLeagues,
  renderSync,
  save,
  signIn,
  signOut,
  syncChoose,
  syncInit,
  syncState,
  forgetOldKeys,
} from "./sync.js";
import { compute, editStart, forecast, lockedChips, rivalTeams, startKind, startTeam } from "./forecast.js";
import { renderLeague } from "./league.js";
import { renderElite, renderEliteSeason } from "./elite.js";
import { fprops } from "./filters.js";
import { renderHind } from "./hindsight-view.js";
import { renderStats, stCell, stExcluded } from "./stats.js";
import { lvCell, pullLive, renderLive } from "./live.js";
import {
  GOAL_COLS,
  addDraft,
  bestRows,
  bestSort,
  copyText,
  editTarget,
  editing,
  menuAction,
  menuRow,
  openBudgetValue,
  openChipValues,
  openMenu,
  openPlan,
  openTeamEditor,
  openTransferValue,
  pinTeam,
  renderAssetPanels,
  renderSettings,
  runOptimiser,
  setSplit,
  setSplitFrac,
  resetSplit,
  endTeamEdit,
} from "./calc.js";
import {
  ovFor,
  renderAssets,
  renderCal,
  renderCompare,
  renderGrid,
  renderHeader,
  renderModel,
  renderPractice,
  renderPrices,
} from "./views.js";
import { lab, labCheck, labOwner, labRerun, labSave, labSet, renderLab } from "./lab.js";
import { linkAccount, pullLink, searchInput, setupAction } from "./setup.js";
import { cfgSave, closeNotice, loadNotice } from "./admin.js";

// Each view's renderer. Only the visible view renders; the rest are marked stale and render when opened.
const RENDER = {
  calc: () => {
    renderSettings();
    runOptimiser();
    renderAssetPanels();
    showBmode();
  },
  live: () => renderLive(),
  league: () => renderLeague(),
  elite: () => renderElite(),
  hind: () => renderHind(),
  stats: () => renderStats(),
  assets: () => renderAssets(),
  prices: () => renderPrices(),
  practice: () => renderPractice(),
  grid: () => renderGrid(),
  lab: () => renderLab(),
  settings: () => {
    renderSync();
    renderModel();
    if (!SEASON_OVER) renderCal();
  },
};
const stale = new Set(VIEWS);
function renderView(v) {
  if (SEASON_OVER && FORECAST_VIEWS.includes(v)) return;
  RENDER[v]();
  stale.delete(v);
}
// re-render these views: now if one is showing, the others when next opened
export function refreshViews(vs = VIEWS) {
  for (const v of vs) stale.add(v);
  if (stale.has(state.view)) renderView(state.view);
}
export function renderAll() {
  renderHeader();
  refreshViews();
}
let recomputeTimer = null;
// the header's "Updating…" tag and dimmed tables while the simulations re-run
const busy = (on) => {
  $("#busyTag").hidden = !on;
  document.body.classList.toggle("busy", on);
};
function recompute(delay = 120) {
  clearTimeout(recomputeTimer);
  busy(true);
  // at least 30ms: the tag gets painted before the work (synchronous) holds up the page
  recomputeTimer = setTimeout(
    () => {
      compute();
      renderAll();
      save();
      busy(false);
    },
    Math.max(delay, 30),
  );
}
export function rerender() {
  renderAll();
  save();
}

/* ---------- tool groups: one rail button each, their views as sub-tabs ---------- */
const GROUPS = {
  proj: [
    ["assets", "Points"],
    ["prices", "Budget"],
    ["grid", "Positions"],
    ["practice", "Practice"],
  ],
  leagues: [
    ["league", "My leagues"],
    ["elite", "Global elite"],
  ],
  season: [
    ["hind", "Hindsight"],
    ["stats", "Statistics"],
  ],
};
const groupOf = (v) => Object.keys(GROUPS).find((g) => GROUPS[g].some(([x]) => x === v));
const groupViews = (g) => GROUPS[g].filter(([v]) => !(SEASON_OVER && FORECAST_VIEWS.includes(v)));

export function showView(v) {
  if (v === "lab" && !labOwner) v = "calc"; // the Sim lab is owner-only
  if (GROUPS[v]) {
    // a group's rail button opens the view last used in it
    const vs = groupViews(v).map(([x]) => x);
    v = vs.includes(state.sub[v]) ? state.sub[v] : vs[0] || "hind";
  }
  if (SEASON_OVER && FORECAST_VIEWS.includes(v)) v = "hind";
  state.view = v;
  const g = groupOf(v);
  if (g) state.sub[g] = v;
  const nb = document.querySelector(`#nav button[data-view="${g || v}"] .lbl`);
  $("#appTitle").textContent = nb ? nb.textContent : "Fantasy Pit Wall";
  for (const b of $$("#menuList button, #nav button")) {
    if (b.dataset.view === v || b.dataset.view === g) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("#subTabs").hidden = !g;
  if (g)
    $("#subTabs").innerHTML = groupViews(g)
      .map(([x, l]) => `<button data-view="${x}"${x === v ? ' aria-current="page"' : ""}>${l}</button>`)
      .join("");
  closeMenu();
  $$("[data-v]").forEach((m) => (m.hidden = m.id !== "view-" + v));
  if (stale.has(v)) renderView(v);
  if (v === "calc" && isPhone())
    requestAnimationFrame(() => showPane(PANES.includes(state.pane) ? state.pane : "best", true));
  if (v === "live") pullLive();
  save();
}

/* ---------- the Calculator's panes (a swipe strip on phones) ---------- */
const PANES = ["best", "settings", "drivers", "cons"];
const isPhone = () => matchMedia("(max-width:900px)").matches;
// the page a pane lives on in the phone's swipe strip: Best Teams and Settings (+ Simulation) are whole columns
const paneEl = (p) => {
  const el = document.querySelector(`#view-calc [data-pane="${p}"]`);
  return el && (p === "best" || p === "settings") ? el.closest(".col") : el;
};
function markPane(p) {
  state.pane = p;
  $$("[data-pane]").forEach((el) => el.classList.toggle("on", el.dataset.pane === p));
  $$("[data-pane-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.paneBtn === p)));
}
function showPane(p, instant) {
  markPane(p);
  if (isPhone() && !$("#view-calc").hidden) {
    const strip = $("#view-calc .calc"),
      el = paneEl(p);
    if (el) strip.scrollTo({ left: el.offsetLeft - strip.offsetLeft, behavior: instant ? "auto" : "smooth" });
  }
  save();
}

// the Best Teams pane shows the ranked teams or the comparison of your teams and manual teams
function showBmode() {
  const cmp = state.bmode === "cmp";
  $$("#bmode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.bmode === state.bmode)));
  $$("#view-calc [data-bm]").forEach((el) => (el.hidden = el.dataset.bm !== (cmp ? "cmp" : "best")));
  if (cmp) renderCompare();
}

/* ---------- modal, menu, toast ---------- */
export let modalKind = null; // "editor" while the team editor is open (it re-renders as the team changes)
export function openModal(kind = null) {
  modalKind = kind;
  $("#modal .mbox").classList.toggle("wide", kind === "budget" || kind === "transfer");
  $("#modal").hidden = false;
}
export function closeModal() {
  const draft = editTarget != null; // a manual team edited from Compare: show its new name there
  $("#modal").hidden = true;
  modalKind = null;
  endTeamEdit();
  if (draft) rerender();
}
function closeMenu() {
  $("#appMenu").hidden = true;
  $("#menuBtn").setAttribute("aria-expanded", "false");
}
let undoTeam = null,
  toastTimer = null;
// the team as it was before a one-click change, for the toast's Undo
export function keepUndo(team) {
  undoTeam = { ref: team, team: team.team.slice(), bank: team.bank, boost: team.boost, example: team.example };
}
export function toast(msg, undo) {
  $("#toastMsg").textContent = msg;
  $("#toastUndo").hidden = !undo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6000);
}

/* ---------- actions ---------- */
function pickStart(start) {
  $$(".pop").forEach((x) => (x.hidden = true));
  const [k, i] = start.split(":");
  if (k === "team") {
    state.active = +i;
    state.calcStart = { type: "team" }; // picked: shown even if it's only an example team
  } else if (k === "draft") state.calcStart = { type: "draft", i: +i };
  else if (k === "rival") {
    const r = rivalTeams()[+i];
    state.calcStart = { type: "rival", key: r.key, name: r.name };
  } else if (k === "none") state.calcStart = { type: "none" };
  else if (k === "newdraft") {
    const from = startTeam().none ? activeTeam().team : startTeam().team;
    if (!addDraft("Manual " + (state.drafts.length + 1), from)) return;
    state.calcStart = { type: "draft", i: state.drafts.length - 1 };
    state.chip = "";
    rerender();
    return openTeamEditor(null);
  }
  state.chip = "";
  state.showN = 20;
  rerender();
}
function toggleMark(marks, id, to) {
  if (marks[id] === to) delete marks[id];
  else marks[id] = to;
}
function draftToTeam(i, j) {
  const tgt = state.teams[j],
    oldCap = tgt.team.reduce((s, id) => s + byId[id].price, 0) + (+tgt.bank || 0);
  keepUndo(tgt);
  const cost = state.drafts[i].team.reduce((s, id) => s + byId[id].price, 0);
  Object.assign(tgt, {
    team: state.drafts[i].team.slice(),
    bank: Math.round(Math.max(0, oldCap - cost) * 10) / 10,
    boost: "auto",
    example: false,
  });
  rerender();
  toast(`${tgt.name} updated.${cost > oldCap ? " This line-up costs more than its budget." : ""}`, true);
}
function toggleStatCats(codes) {
  const off = stExcluded();
  const turnOn = codes.some((c) => off.has(c)); // a session button re-includes everything if anything in it was off
  codes.forEach((c) => (turnOn ? off.delete(c) : off.add(c)));
  state.stOff = [...off];
  save();
  renderStats();
}
const saveAnd = (render) => {
  save();
  render();
};
const renderFilterScope = (sc) => (sc === "hd" ? saveAnd(renderHind) : rerender());

// Clicks on a button carrying one of these data attributes; the first one present wins.
const CLICK = [
  ["view", (d) => showView(d.view)],
  [
    "labtab",
    (d) => {
      lab.tab = d.labtab;
      labSave();
      renderLab();
    },
  ],
  [
    "lablapv",
    (d) => {
      lab.lapv = d.lablapv;
      labSave();
      renderLab();
    },
  ],
  [
    "labpos",
    (d) => {
      lab.pos = d.labpos;
      labSave();
      renderLab();
    },
  ],
  ["paneBtn", (d) => showPane(d.paneBtn)],
  [
    "bmode",
    (d) => {
      state.bmode = d.bmode;
      showBmode();
      save();
    },
  ],
  ["signin", () => signIn()],
  ["signout", () => signOut()],
  ["sync", (d) => (d.sync === "ask" ? askWhich() : syncChoose(d.sync))],
  ["setup", (d) => setupAction(d.setup)],
  ["linkacct", (d) => linkAccount(d.linkacct)],
  ["cfgsave", (d) => cfgSave(d.cfgsave)],
  ["noticeclose", () => closeNotice()],
  [
    "boost",
    (d) => {
      const team = editing();
      team.boost = team.boost === d.boost ? "auto" : d.boost;
      rerender();
    },
  ],
  [
    "pop",
    (d) => {
      const el = $("#pop-" + d.pop),
        was = el.hidden;
      $$(".pop").forEach((x) => (x.hidden = true));
      el.hidden = !was;
    },
  ],
  [
    "menu",
    (d, t) => {
      if (!$("#rowMenu").hidden && menuRow === d.menu) $("#rowMenu").hidden = true;
      else openMenu(t);
    },
  ],
  ["mi", (d) => menuAction(d.mi)],
  ["pin", (d) => bestRows.best[+d.pin] && pinTeam(bestRows.best[+d.pin].ids)],
  [
    "unpin",
    (d) => {
      state.pins.splice(+d.unpin, 1);
      rerender();
    },
  ],
  [
    "unpinall",
    () => {
      state.pins = [];
      rerender();
    },
  ],
  [
    "more",
    () => {
      state.showN = Math.min(60, (state.showN || 20) + 20);
      runOptimiser();
    },
  ],
  ["start", (d) => pickStart(d.start)],
  ["editteam", () => openTeamEditor(null)],
  ["editdraft", (d) => openTeamEditor(+d.editdraft)],
  [
    "clearstart",
    () => {
      state.calcStart = { type: "none" };
      state.chip = "";
      rerender();
    },
  ],
  [
    "keep",
    () => {
      const team = startTeam(),
        all = team.team.every((id) => state.marks[id] === "lock");
      team.team.forEach((id) => (all ? delete state.marks[id] : (state.marks[id] = "lock")));
      toast(all ? "Team released." : "Whole team kept: every asset is included.");
      rerender();
    },
  ],
  [
    "calcreset",
    () => {
      Object.assign(state, {
        chip: "",
        marks: {},
        pins: [],
        xdp: false,
        valW: 1,
        maxPen: null,
        xo: {},
        horizon: 1,
        showN: 20,
        bcols: null,
        bsort: null,
      });
      state.filters = { ...state.filters, calc: [] };
      toast("Calculator settings reset.");
      recompute(0);
    },
  ],
  [
    "xoclear",
    (d) => {
      delete state.xo[d.xoclear];
      recompute(0);
    },
  ],
  [
    "chip",
    (d) => {
      state.chip = state.chip === d.chip ? "" : d.chip;
      rerender();
    },
  ],
  [
    "used",
    (d) => {
      const team = editStart();
      if (team.none || lockedChips(startTeam())[d.used]) return;
      team.chipsUsed[d.used] = !team.chipsUsed[d.used];
      if (team.chipsUsed[d.used] && state.chip === d.used) state.chip = "";
      rerender();
    },
  ],
  [
    "horizon",
    (d) => {
      state.horizon = +d.horizon;
      rerender();
    },
  ],
  [
    "kind",
    (d) => {
      state.kind = d.kind;
      rerender();
    },
  ],
  [
    "race",
    (d) => {
      state.raceIdx = +d.race;
      rerender();
    },
  ],
  [
    "gridmode",
    (d) => {
      state.grid = d.gridmode;
      rerender();
    },
  ],
  [
    "sims",
    (d) => {
      state.sims = +d.sims;
      recompute(0);
    },
  ],
  [
    "heat",
    (d) => {
      state.heat = !!+d.heat;
      rerender();
    },
  ],
  [
    "adj",
    (d) => {
      const v = Math.max(-3, Math.min(3, (state.adj[d.adj] || 0) + +d.step));
      if (v) state.adj[d.adj] = v;
      else delete state.adj[d.adj];
      recompute();
    },
  ],
  [
    "mark",
    (d) => {
      toggleMark(state.marks, d.mark, d.to);
      rerender();
    },
  ],
  [
    "deldraft",
    (d) => {
      endTeamEdit();
      closeModal();
      state.drafts.splice(+d.deldraft, 1);
      if (state.calcStart && state.calcStart.type === "draft") state.calcStart = null;
      rerender();
    },
  ],
  ["todraft", (d) => draftToTeam(...d.todraft.split(":").map(Number))],
  [
    "lg",
    (d) => {
      state.lgIdx = +d.lg;
      saveAnd(renderLeague);
    },
  ],
  [
    "lgm",
    (d) => {
      state.lgMode = d.lgm;
      saveAnd(renderLeague);
    },
  ],
  [
    "elt",
    (d) => {
      state.elT = +d.elt;
      saveAnd(renderElite);
    },
  ],
  [
    "em",
    (d) => {
      state.elMode = d.em;
      saveAnd(() => renderEliteSeason(DATA.elite));
    },
  ],
  [
    "hg",
    (d) => {
      state.hdGd = +d.hg;
      saveAnd(renderHind);
    },
  ],
  [
    "hc",
    (d) => {
      state.hdCap = d.hc;
      saveAnd(renderHind);
    },
  ],
  [
    "hch",
    (d) => {
      state.hdChip = d.hch;
      saveAnd(renderHind);
    },
  ],
  [
    "hmark",
    (d) => {
      state.hdMarks = state.hdMarks || {};
      toggleMark(state.hdMarks, d.hmark, d.to);
      saveAnd(renderHind);
    },
  ],
  ["close", () => closeModal()],
  [
    "simcat",
    (d) => {
      const off = new Set(state.simOff);
      if (off.has(d.simcat)) off.delete(d.simcat);
      else off.add(d.simcat);
      state.simOff = [...off];
      recompute(0);
    },
  ],
  [
    "simsess",
    (d) => {
      const cs = [...new Set(DATA.evNames.map((x) => x.c))].filter((c) => c[0] === d.simsess),
        off = new Set(state.simOff),
        turnOn = cs.some((c) => off.has(c)); // a session button re-includes everything if anything in it was off
      cs.forEach((c) => (turnOn ? off.delete(c) : off.add(c)));
      state.simOff = [...off];
      recompute(0);
    },
  ],
  [
    "simreset",
    () => {
      Object.assign(state, { simPreset: "sim", simDecay: 0.9, simWin: 5, simW: {}, simOff: [], simSprint: null });
      recompute(0);
    },
  ],
  [
    "sk",
    (d) => {
      state.stKind = d.sk;
      state.stSort = null;
      saveAnd(renderStats);
    },
  ],
  [
    "stt",
    (d) => {
      state.stTeam = +d.stt;
      saveAnd(renderStats);
    },
  ],
  ["stcat", (d) => toggleStatCats([d.stcat])],
  ["stsess", (d) => toggleStatCats([...new Set(DATA.evNames.map((x) => x.c))].filter((c) => c[0] === d.stsess))],
  [
    "livekind",
    (d) => {
      state.lvKind = d.livekind;
      saveAnd(renderLive);
    },
  ],
  [
    "lvby",
    (d) => {
      state.lvBy = d.lvby;
      saveAnd(renderLive);
    },
  ],
  [
    "lvlg",
    (d) => {
      state.lvLg = +d.lvlg;
      saveAnd(renderLive);
    },
  ],
  [
    "fadd",
    (d) => {
      state.filters = state.filters || {};
      (state.filters[d.fadd] = state.filters[d.fadd] || []).push({ k: fprops(d.fadd)[0][0], min: null, max: null });
      renderFilterScope(d.fadd);
    },
  ],
  [
    "fdel",
    (d) => {
      const [sc, i] = d.fdel.split(":");
      state.filters[sc].splice(+i, 1);
      renderFilterScope(sc);
    },
  ],
  [
    "fclear",
    (d) => {
      state.filters[d.fclear] = [];
      renderFilterScope(d.fclear);
    },
  ],
  ["copy", (d) => copyText(d.copy)],
  [
    "ovsc",
    (d) => {
      const [gd, k] = d.ovsc.split(":"),
        g = DATA.schedule.find((x) => x.gd === +gd);
      const { ov, ...rest } = state.circuits[gd] || {};
      if (k === "base") {
        if (Object.keys(rest).length) state.circuits[gd] = rest;
        else delete state.circuits[gd];
      } else state.circuits[gd] = { ...rest, ov: ovFor(g, k) };
      recompute(0);
    },
  ],
];
// buttons known by id
const CLICK_ID = {
  labRerun: () => labRerun(),
  labReset: () => {
    lab.set = {};
    labSave();
    renderLab();
  },
  planBtn: () => openPlan(),
  chipValBtn: () => openChipValues(),
  budgetValBtn: () => openBudgetValue(),
  transferValBtn: () => openTransferValue(),
  xoReset: () => {
    state.xo = {};
    recompute(0);
  },
  addDraft: () => {
    if (!addDraft("Manual " + (state.drafts.length + 1), activeTeam().team)) return;
    rerender();
    openTeamEditor(state.drafts.length - 1);
  },
  toastUndo: () => {
    if (!undoTeam) return;
    const { ref, ...rest } = undoTeam;
    Object.assign(ref, rest);
    undoTeam = null;
    $("#toast").hidden = true;
    rerender();
  },
  resetAll: () => {
    state.adj = {};
    state.marks = {};
    state.circuits = {};
    state.pen = {};
    recompute(0);
  },
  menuBtn: () => {
    $("#appMenu").hidden = false;
    $("#menuBtn").setAttribute("aria-expanded", "true");
    $("#menuClose").focus();
  },
  menuClose: () => {
    closeMenu();
    $("#menuBtn").focus();
  },
};
// Clicks on things that aren't buttons (table cells, sortable headers): the first selector the click is inside wins. Buttons dispatch through CLICK_ID (by id) and CLICK (by data attribute).
const CLICK_ON = [
  [
    "[data-stcell]",
    (el) => {
      const [id, g] = el.dataset.stcell.split(":");
      stCell(id, +g);
    },
  ],
  ["[data-lvcell]", (el) => lvCell(el.dataset.lvcell)],
  [
    "th[data-bsort]",
    (el) => {
      const k = el.dataset.bsort,
        cur = bestSort();
      // ascending first for cost and retirements, descending for the rest (negative points are negative numbers);
      // points columns only rank highest first: the optimiser's Boost and penalties assume you want the best team
      const pts = k === "x" || k === "xsp" || GOAL_COLS.includes(k);
      state.bsort = { k, d: pts ? -1 : cur.k === k ? -cur.d : k === "cost" || k === "dnf" ? 1 : -1 };
      state.showN = 20;
      rerender();
    },
  ],
  [
    "th[data-stsort]",
    (el) => {
      const k = el.dataset.stsort,
        cur = state.stSort || { k: "avg", d: -1 };
      state.stSort = { k, d: String(cur.k) === k ? -cur.d : ["qpos", "rpos"].includes(state.stMetric) ? 1 : -1 };
      saveAnd(renderStats);
    },
  ],
  [
    "th.sort",
    (el) => {
      const k = el.dataset.sort;
      state.sort = { k, d: state.sort.k === k ? -state.sort.d : -1 };
      rerender();
    },
  ],
];
// an outside click closes popovers, the row menu and open ⓘ notes
function closePopovers(target) {
  if (!target.closest(".pop, [data-pop]")) $$(".pop").forEach((x) => (x.hidden = true));
  if (!target.closest("#rowMenu, [data-menu]")) $("#rowMenu").hidden = true;
  for (const d of $$("details.info[open]")) if (!d.contains(target)) d.open = false;
}
document.addEventListener("click", (e) => {
  const target = e.target;
  closePopovers(target);
  if (target.id === "modal") return closeModal(); // the backdrop
  for (const [sel, fn] of CLICK_ON) {
    const el = target.closest(sel);
    if (el) return fn(el);
  }
  const t = target.closest("button");
  if (!t || t.disabled) return;
  if (CLICK_ID[t.id]) return CLICK_ID[t.id]();
  const d = t.dataset;
  for (const [k, fn] of CLICK) if (k in d) return fn(d, t);
});

// picking someone already in the team swaps the two slots
function setSlot(team, k, id) {
  const prev = team[k],
    j = team.indexOf(id);
  if (j >= 0 && j !== k) team[j] = prev;
  team[k] = id;
  return prev;
}
const CHANGE_ID = {
  labRace: (t) => {
    lab.race = +t.value;
    labSave();
  },
  labN: (t) => {
    lab.N = +t.value;
    labSave();
  },
  labCompare: (t) => {
    lab.compare = t.checked;
    labSave();
  },
  goal: (t) => {
    state.goal = t.value;
    saveAnd(() => (renderSettings(), runOptimiser()));
  },
  goalRival: (t) => {
    state.goalRival = t.value || null;
    saveAnd(runOptimiser);
  },
  simPreset: (t) => {
    state.simPreset = t.value;
    state.simW = {}; // a new preset starts from its own round weights
    recompute(0);
  },
  simSprint: (t) => {
    state.simSprint = NEXT ? { gd: NEXT.gd, v: t.checked } : null;
    recompute(0);
  },
  free: (t) => {
    editStart().free = +t.value;
    rerender();
  },
  maxPen: (t) => {
    state.maxPen = t.value === "any" ? null : +t.value;
    rerender();
  },
  maxBudget: (t) => {
    const v = parseFloat(t.value);
    if (!isNaN(v) && v > 0) state.maxBudget = v;
    rerender();
  },
  xdp: (t) => {
    state.xdp = t.checked;
    if (state.bcols) for (const k of ["xd", "xdp", "xsp"]) delete state.bcols[k];
    rerender();
  },
  lgRef: (t) => {
    state.lgRef = t.value;
    saveAnd(renderLeague);
  },
  lgChips: (t) => {
    state.lgChips = t.checked;
    saveAnd(renderLeague);
  },
  lgRoundPick: (t) => {
    state.lgRound = +t.value;
    saveAnd(renderLeague);
  },
  stMetric: (t) => {
    state.stMetric = t.value;
    state.stSort = null;
    saveAnd(renderStats);
  },
};
const CHANGE = [
  [
    "slot",
    (d, t) => {
      const team = editing(),
        prev = setSlot(team.team, +d.slot, t.value);
      team.example = false;
      if (team.boost === prev) team.boost = "auto";
      rerender();
    },
  ],
  [
    "bcol",
    (d, t) => {
      state.bcols = { ...state.bcols, [d.bcol]: t.checked };
      saveAnd(runOptimiser);
    },
  ],
  [
    "xo",
    (d, t) => {
      const v = parseFloat(t.value),
        p = forecast.proj[0][d.xo],
        model = p.model ?? p.mean;
      if (t.value === "" || isNaN(v) || Math.abs(v - model) < 0.05) delete state.xo[d.xo];
      else state.xo[d.xo] = v;
      recompute(0);
    },
  ],
  [
    "flt",
    (d, t) => {
      const [sc, i, k] = d.flt.split(":"),
        f = state.filters[sc][+i];
      f[k] = k === "k" ? t.value : t.value === "" || isNaN(+t.value) ? null : +t.value;
      renderFilterScope(sc);
    },
  ],
  [
    "pen",
    (d, t) => {
      // stored even when "none", so it can override a penalty race control announced
      state.pen = { ...state.pen, [d.pen]: +t.value };
      recompute(0);
    },
  ],
];
document.addEventListener("change", (e) => {
  const t = e.target;
  if (CHANGE_ID[t.id]) return CHANGE_ID[t.id](t);
  if (t.dataset.labset) return labSet(t);
  for (const [k, fn] of CHANGE) if (k in t.dataset) return fn(t.dataset, t);
});

const slider = (id, key, label) => (t) => {
  state[key] = +t.value;
  $(id).textContent = label(state[key]);
  recompute(250);
};
const INPUT_ID = {
  acctSearch: searchInput,
  simDecay: (t) => {
    state.simDecay = +t.value;
    state.simW = {};
    $("#simDecayV").textContent = Math.round(state.simDecay * 100) + "%";
    recompute(250);
  },
  simWin: (t) => {
    state.simWin = +t.value;
    state.simW = {};
    $("#simWinV").textContent = state.simWin + (state.simWin === 1 ? " race" : " races");
    recompute(250);
  },
  tname: (t) => {
    const team = editing(),
      draft = editTarget != null || startKind() === "draft";
    team.name = t.value.trim() || (draft ? "Manual" : "Team " + (state.active + 1));
    if (editTarget == null) $("#startBtn").lastChild.textContent = team.name;
    save();
  },
  valW: (t) => {
    state.valW = +t.value;
    $("#valWv").textContent = (+state.valW).toFixed(1) + " pts";
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(rerender, 250);
  },
  drvSearch: () => renderAssetPanels(),
  conSearch: () => renderAssetPanels(),
  bank: (t) => {
    const v = parseFloat(t.value);
    if (isNaN(v) || v < 0) return;
    const team = editStart();
    team.bank = v;
    team.example = false;
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(rerender, 300);
  },
  halfLife: slider("#halfLifeV", "halfLife", (v) => v + " races"),
  pw: slider("#pwV", "pw", (v) => Math.round(v * 100) + "%"),
  blend: slider("#blendV", "blend", (v) => Math.round(v * 100) + "%"),
  oddsW: slider("#oddsWV", "oddsW", (v) => Math.round(v * 100) + "%"),
};
document.addEventListener("input", (e) => {
  const t = e.target;
  if (INPUT_ID[t.id]) return INPUT_ID[t.id](t);
  if (t.dataset.labset && t.type === "range") return labSet(t);
  if (t.dataset.simw) {
    state.simW[t.dataset.simw] = +t.value;
    t.closest("tr").querySelector(".simwv").textContent = Math.round(+t.value * 100) + "%";
    return recompute(300);
  }
  if (t.dataset.circ) {
    const g = t.dataset.circ,
      k = t.dataset.key,
      v = +t.value;
    // rain is one probability for qualifying, sprint and race here
    state.circuits[g] = { ...state.circuits[g], ...(k === "rainR" ? { rain: { q: v, s: v, r: v } } : { [k]: v }) };
    t.nextElementSibling.textContent = k === "sc" || k === "rainR" ? Math.round(v * 100) + "%" : v.toFixed(2);
    recompute(300);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeMenu();
  if (!$("#modal").hidden) closeModal();
  $$(".pop").forEach((x) => (x.hidden = true));
  $("#rowMenu").hidden = true;
  $$("details.info[open]").forEach((d) => (d.open = false));
});
// phone: swiping the Calculator's panes moves the tab bar with you
{
  const strip = $("#view-calc .calc");
  let t = null;
  strip.addEventListener(
    "scroll",
    () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!isPhone()) return;
        const x = strip.scrollLeft;
        const best = PANES.reduce((b, p) => {
          const d = Math.abs(paneEl(p).offsetLeft - strip.offsetLeft - x);
          return !b || d < b.d ? { p, d } : b;
        }, null);
        if (best && best.p !== state.pane) {
          markPane(best.p);
          save();
        }
      }, 60);
    },
    { passive: true },
  );
}

// the Settings | Simulation divider (wide screens): drag it, or focus it and use the arrow keys; double-click or a
// reload resets
{
  const sp = $("#setSplit");
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      sp.setPointerCapture(e.pointerId); // keeps the drag when the pointer leaves the thin bar
    } catch (err) {}
    sp.classList.add("drag");
    const r = sp.parentElement.getBoundingClientRect();
    const move = (ev) => setSplitFrac((ev.clientY - r.top - sp.offsetHeight / 2) / r.height);
    const end = () => {
      sp.classList.remove("drag");
      sp.removeEventListener("pointermove", move);
      sp.removeEventListener("pointerup", end);
      sp.removeEventListener("pointercancel", end);
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", end);
    sp.addEventListener("pointercancel", end);
  });
  sp.addEventListener("dblclick", resetSplit);
  sp.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = setSplit ?? $("#view-calc [data-pane=settings]").offsetHeight / sp.parentElement.clientHeight;
    setSplitFrac(cur + (e.key === "ArrowDown" ? 0.05 : -0.05));
  });
}

// Settings sections remember whether they're open (the toggle event doesn't bubble: listen in the capture phase)
document.addEventListener(
  "toggle",
  (e) => {
    const d = /** @type {HTMLElement} */ (e.target);
    if (!d.matches || !d.matches("details.grp")) return;
    state.calcGrp[d.dataset.grp] = /** @type {HTMLDetailsElement} */ (d).open;
    save();
  },
  true,
);
// every table's alignment follows its content (core.js alignTable), re-applied whenever a table is rebuilt
{
  const due = new Set();
  let queued = false;
  new MutationObserver((ms) => {
    for (const m of ms) {
      const el = /** @type {Element} */ (m.target);
      const t = el.closest && el.closest("table");
      if (t) due.add(t);
      else if (el.querySelectorAll) el.querySelectorAll("table").forEach((x) => due.add(x));
    }
    if (queued || !due.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      due.forEach(alignTable);
      due.clear();
    });
  }).observe(document.body, { childList: true, subtree: true });
}

/* ---------- start-up ---------- */
if (SEASON_OVER) {
  $$("#nav button").forEach(
    (b) =>
      (b.hidden =
        FORECAST_VIEWS.includes(b.dataset.view) || (GROUPS[b.dataset.view] && !groupViews(b.dataset.view).length)),
  );
  $("#calHead").hidden = $("#cal").hidden = true; // no races left to tune
}
// phone menu: the same tools as the rail, as a full-screen list
$("#menuList").innerHTML = $$("#nav button")
  .filter((b) => !b.hidden)
  .map(
    (b) =>
      `<button data-view="${b.dataset.view}">${b.querySelector("svg").outerHTML}<span>${esc(b.querySelector(".lbl").textContent)}</span></button>`,
  )
  .join("");
labCheck(); // ?lab=1 on this machine; signed-in owners are checked again once the account loads
compute();
renderHeader();
showView(state.view);
$$("table").forEach(alignTable);
if (!SEASON_OVER) showPane(PANES.includes(state.pane) ? state.pane : "best");
forgetOldKeys();
syncInit();
setInterval(() => {
  renderHeader();
  renderSync();
}, 30000);
// back on this tab (say after using the site on the phone): pick up changes made elsewhere
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (syncState.ready) pull();
  pullLeagues();
  pullLink();
  loadNotice();
  if (state.view === "live") pullLive();
});
setInterval(() => {
  if (state.view === "live" && !document.hidden) pullLive();
}, 60000);
