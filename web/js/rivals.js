/* ---------- Rivals: teams you pick to compare with ----------
   Nobody becomes a rival by joining a league: you pick them. Three kinds (tracking.js rivalPicks): tracking-league
   teams (search a manager by F1 Fantasy username; their data comes from tracked_accounts, merged into the league data
   by sync.js setRivals), members of your private leagues (only for league readers, who have that data already) and
   the global top-100/500 templates. The picks live in state.rivals, so they sync with your settings. The Calculator
   can start from a rival's team or aim to beat it (forecast.js rivalTeams); the League views stay limited to real
   leagues. */
import { $, $$, esc } from "./core.js";
import { state } from "./state.js";
import { LEAGUE_DATA, renderSync, rivalRows, save, setRivals, syncState } from "./sync.js";
import { rivalTeams } from "./forecast.js";
import { leagueList, mkey, teamKey } from "./league.js";
import { TEMPLATES, accountTeams, likePattern, pickKey, rivalAccounts, rivalList, toggleRival } from "./tracking.js";
import { closeModal, modalKind, openModal, rerender, toast } from "./main.js";

const rv = { q: "", hits: null, err: "", loaded: false, busy: false };
let searchTimer = null,
  searchNo = 0,
  pullNo = 0;
const ownKeys = () => state.teams.filter((t) => !t.example).map(teamKey);
const picked = (key) => state.rivals.some((p) => pickKey(p) === key);
// your private leagues' members (league readers only; imported leagues don't count), as [{name, members: [{key, name}]}]
const privateLeagues = () =>
  leagueList()
    .filter((l) => l.auto)
    .map((l) => ({ name: l.name, members: l.members.map((m) => ({ key: mkey(m), name: m.name })) }));
// a pick button's value: "p:<template>", "l:<team key>" (a private-league member) or "t:<account key>:<team key>"
const pickVal = (p) => (p.tpl ? "p:" + p.tpl : p.lg ? "l:" + p.tk : `t:${p.ak}:${p.tk}`);
const pickBtn = (val, key, label) =>
  `<button class="tbtn sm" data-rival="${esc(val)}" aria-pressed="${picked(key)}" title="${picked(key) ? "Remove this rival" : "Add as a rival"}">${picked(key) ? "✓ " : "＋ "}${esc(label)}</button>`;

// after sign-in, when the picks change, and when the tab comes back: the picked rivals' latest data
export async function pullRivals() {
  const U = syncState.user;
  if (!U || !syncState.sb) return;
  const aks = rivalAccounts(state.rivals),
    no = ++pullNo;
  if (!aks.length) {
    Object.assign(rv, { loaded: true, busy: false, err: "" });
    setRivals([]);
    return renderOpen();
  }
  rv.busy = true;
  const { data, error } = await syncState.sb
    .from("tracked_accounts")
    .select("account_key, username, teams, body, updated_at")
    .in("account_key", aks);
  if (U !== syncState.user || no !== pullNo) return; // signed out, or a newer pull
  rv.busy = false;
  rv.err = error ? "Couldn't load your rivals: " + error.message : "";
  if (!error) {
    rv.loaded = true;
    setRivals(data || []);
  }
  renderOpen();
}

/* ---------- the dialog ---------- */
export function rivalsAction(a) {
  $$(".pop").forEach((x) => (x.hidden = true));
  if (a === "close") return closeModal();
  if (!syncState.user) return toast("Sign in first: your rivals are kept with your account.");
  rv.hits = null;
  rv.q = "";
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">Your rivals</h3>` +
    `<p class="note">Pick teams to compare with: the Calculator can start from a rival's team or aim to beat it. Only what you pick is listed.</p>` +
    `<div id="rivalList" class="rivlist"></div>` +
    `<div id="rivalMore"></div>` +
    `<label class="field">Add a rival: their F1 Fantasy username<input id="rivalSearch" class="inp" type="search" autocomplete="off" spellcheck="false" placeholder="Type at least 2 letters"></label>` +
    `<div id="rivalHits" class="accthits"></div>` +
    `<div class="chipbar"><button class="btn ghost sm" data-rivals="close">Done</button></div>`;
  openModal("rivals");
  renderOpen();
  $("#rivalSearch").focus();
}
function renderOpen() {
  if (modalKind !== "rivals" || !$("#rivalList")) return;
  $("#rivalList").innerHTML = listHtml();
  $("#rivalMore").innerHTML = moreHtml();
  $("#rivalHits").innerHTML = hitsHtml();
}
// the templates, and your private leagues' members (league readers only)
function moreHtml() {
  const own = ownKeys();
  let h =
    `<div class="rivhit"><b>Templates</b><small>The 5 drivers and 2 constructors the global top 100 or top 500 own most, with their most common Boost.</small><div class="chipbar">` +
    Object.entries(TEMPLATES)
      .map(([k, n]) => pickBtn("p:" + k, "tpl:" + k, n))
      .join("") +
    `</div></div>`;
  for (const lg of privateLeagues()) {
    const ms = lg.members.filter((m) => !own.includes(m.key));
    if (ms.length)
      h += `<div class="rivhit"><b>${esc(lg.name)}</b><small>Your private league</small><div class="chipbar">${ms.map((m) => pickBtn("l:" + m.key, m.key, m.name)).join("")}</div></div>`;
  }
  return h;
}
function listHtml() {
  const list = rivalList(
      state.rivals,
      rv.loaded ? rivalRows() : null,
      ownKeys(),
      LEAGUE_DATA ? privateLeagues() : null,
    ),
    ready = rivalTeams().map((r) => r.key);
  const err = rv.err ? `<p class="note bad">${esc(rv.err)}</p>` : "";
  if (!list.length) return err + '<p class="note">No rivals yet.</p>';
  return (
    err +
    list
      .map((r) => {
        const why = ready.includes(r.key)
          ? ""
          : r.tpl
            ? "no elite data yet"
            : r.ak && !r.user && (rv.busy || !rv.loaded)
              ? "loading…"
              : r.missing
                ? r.lg
                  ? `no longer in ${r.lg}`
                  : "not in this season's tracking league"
                : r.lg && !LEAGUE_DATA
                  ? "loading…"
                  : "line-up loads after the next race";
        return `<div class="rivrow"><span><b>${esc(r.name)}</b><small>${esc(r.user)}${why ? ` · ${why}` : ""}</small></span><button class="tbtn sm" data-rival="${esc(pickVal(r))}" title="Remove this rival">Remove</button></div>`;
      })
      .join("")
  );
}
function hitsHtml() {
  if (rv.hits == null) return likePattern(rv.q) ? '<p class="note">Searching…</p>' : "";
  if (rv.hits.error) return `<p class="note bad">${esc(rv.hits.error)}</p>`;
  if (!rv.hits.length)
    return `<p class="note">No manager in the tracking league matches “${esc(rv.q.trim())}”. New members appear after the next race's standings update.</p>`;
  const own = ownKeys();
  return rv.hits
    .map((r) => {
      const teams = accountTeams(r)
        .map((t) =>
          own.includes(t.tk)
            ? `<button class="tbtn sm" disabled title="Your own team">${esc(t.name)} · yours</button>`
            : pickBtn(`t:${r.account_key}:${t.tk}`, t.tk, t.name),
        )
        .join("");
      return `<div class="rivhit"><b>${esc(r.username)}</b><div class="chipbar">${teams || '<span class="dim">no teams yet</span>'}</div></div>`;
    })
    .join("");
}
// typing in the search box: search once the typing pauses
export function rivalSearchInput(t) {
  rv.q = t.value;
  rv.hits = null;
  $("#rivalHits").innerHTML = hitsHtml();
  clearTimeout(searchTimer);
  if (likePattern(rv.q)) searchTimer = setTimeout(search, 300);
}
async function search() {
  const pat = likePattern(rv.q),
    no = ++searchNo;
  if (!pat || !syncState.user) return;
  const { data, error } = await syncState.sb
    .from("tracked_accounts")
    .select("account_key, username, teams")
    .ilike("username", pat)
    .order("username")
    .limit(20);
  if (no !== searchNo || modalKind !== "rivals" || !$("#rivalHits")) return; // a newer search, or the dialog closed
  rv.hits = error ? { error: "Search failed: " + error.message } : data;
  $("#rivalHits").innerHTML = hitsHtml();
}
// a pick button in the dialog (pickVal): add it, or take it out (with its Calculator settings)
export function toggleRivalPick(v) {
  const i = v.indexOf(":"),
    kind = v.slice(0, i),
    rest = v.slice(i + 1);
  let pick;
  if (kind === "p") pick = { tpl: rest };
  else if (kind === "l") {
    const lg = privateLeagues().find((l) => l.members.some((m) => m.key === rest));
    pick = { lg: lg ? lg.name : "", tk: rest };
  } else {
    const j = rest.indexOf(":");
    pick = { ak: rest.slice(0, j), tk: rest.slice(j + 1) };
  }
  const key = pickKey(pick),
    was = picked(key);
  if (!was && kind === "l" && !pick.lg) return; // that league isn't loaded
  state.rivals = toggleRival(state.rivals, pick);
  if (was) {
    delete state.rivalCfg[key];
    if (state.calcStart && state.calcStart.type === "rival" && state.calcStart.key === key) {
      state.calcStart = null;
      state.chip = "";
    }
    if (state.goalRival === key) state.goalRival = null;
  }
  save();
  rerender();
  renderSync(); // Settings' rival count
  renderOpen();
  pullRivals();
}

/* ---------- Settings: how many rivals, and a way to change them ---------- */
export function rivalsHtml() {
  const n = state.rivals.length;
  return (
    `<div class="linkbox"><div class="lbl">Your rivals</div>` +
    `<small>${n ? `${n} picked` : "None yet: pick teams to compare with in the Calculator."}</small>` +
    `<div class="chipbar"><button class="btn ghost sm" data-rivals="open">Manage rivals</button></div></div>`
  );
}
