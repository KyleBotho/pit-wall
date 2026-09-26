/* ---------- Rivals: tracking-league teams you pick to compare with ----------
   Nobody becomes a rival by joining Pit Wall's tracking league: you search a manager by F1 Fantasy username and pick
   their teams. The picks live in state.rivals ([{ak, tk}]), so they sync with your settings; the teams' data comes
   from tracked_accounts (readable when signed in) and is merged into the league data (sync.js setRivals). The
   Calculator can start from a rival's team or aim to beat it (forecast.js rivalTeams). The League views stay limited
   to real leagues. */
import { $, $$, esc } from "./core.js";
import { state } from "./state.js";
import { renderSync, rivalRows, save, setRivals, syncState } from "./sync.js";
import { rivalTeams } from "./forecast.js";
import { teamKey } from "./league.js";
import { accountTeams, likePattern, rivalAccounts, rivalList, toggleRival } from "./tracking.js";
import { closeModal, modalKind, openModal, rerender, toast } from "./main.js";

const rv = { q: "", hits: null, err: "", loaded: false, busy: false };
let searchTimer = null,
  searchNo = 0,
  pullNo = 0;
const ownKeys = () => state.teams.filter((t) => !t.example).map(teamKey);
const picked = (tk) => state.rivals.some((p) => p.tk === tk);

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
  if (!syncState.user) return toast("Sign in first: rivals come from Pit Wall's tracking league.");
  rv.hits = null;
  rv.q = "";
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">Your rivals</h3>` +
    `<p class="note">Pick teams from Pit Wall's tracking league to compare with: the Calculator can start from a rival's team or aim to beat it. Only the teams you pick are listed.</p>` +
    `<div id="rivalList" class="rivlist"></div>` +
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
  $("#rivalHits").innerHTML = hitsHtml();
}
function listHtml() {
  const list = rivalList(state.rivals, rv.loaded ? rivalRows() : null, ownKeys()),
    ready = rivalTeams().map((r) => r.tk);
  const err = rv.err ? `<p class="note bad">${esc(rv.err)}</p>` : "";
  if (!list.length) return err + '<p class="note">No rivals yet.</p>';
  return (
    err +
    list
      .map((r) => {
        const why =
          !r.user && (rv.busy || !rv.loaded)
            ? "loading…"
            : r.missing
              ? "not in this season's tracking league"
              : ready.includes(r.tk)
                ? ""
                : "line-up loads after the next race";
        return `<div class="rivrow"><span><b>${esc(r.name)}</b><small>${esc(r.user)}${why ? ` · ${why}` : ""}</small></span><button class="tbtn sm" data-rival="${esc(r.ak)}:${esc(r.tk)}" title="Remove this rival">Remove</button></div>`;
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
            : `<button class="tbtn sm" data-rival="${esc(r.account_key)}:${esc(t.tk)}" aria-pressed="${picked(t.tk)}" title="${picked(t.tk) ? "Remove this rival" : "Add as a rival"}">${picked(t.tk) ? "✓ " : "＋ "}${esc(t.name)}</button>`,
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
// a team button in the dialog ("<account key>:<team key>"): add it, or take it out (with its Calculator settings)
export function toggleRivalPick(v) {
  const [ak, tk] = v.split(":");
  const was = picked(tk);
  state.rivals = toggleRival(state.rivals, ak, tk);
  if (was) {
    delete state.rivalCfg[tk];
    if (state.calcStart && state.calcStart.type === "rival" && state.calcStart.key === tk) {
      state.calcStart = null;
      state.chip = "";
    }
    if (state.goalRival === tk) state.goalRival = null;
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
    `<small>${n ? `${n} team${n === 1 ? "" : "s"} from the tracking league` : "None yet: pick teams from the tracking league to compare with in the Calculator."}</small>` +
    `<div class="chipbar"><button class="btn ghost sm" data-rivals="open">Manage rivals</button></div></div>`
  );
}
