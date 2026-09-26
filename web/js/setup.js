/* ---------- Team Tracking: link your F1 Fantasy account (docs/team-tracking-plan.md) ----------
   Signed in with no link: join Pit Wall's tracking league on F1 Fantasy (its code comes from app_config, readable
   only when signed in), find your F1 Fantasy username, link it (account_links, your own row only). From then on each
   sign-in loads that account's tracked_accounts row and your teams follow it. Settings: Change or Delete. */
import { $, esc } from "./core.js";
import { dropAccount, renderSync, setAccount, syncState } from "./sync.js";
import { accountTeams, likePattern, setupStep } from "./tracking.js";
import { closeModal, openModal, refreshViews, toast } from "./main.js";

// key: the linked account key (undefined = not loaded yet, null = none); row: its tracked_accounts row
// code/league: the tracking league's join code and name from app_config (code undefined = not loaded yet)
export const link = {
  key: undefined,
  row: null,
  at: null,
  code: undefined,
  league: "",
  mode: "join",
  q: "",
  hits: null,
  err: "",
};
const SEEN = "pitwall.setupSeen"; // sessionStorage: the setup has opened by itself once in this tab
let searchTimer = null,
  searchNo = 0;
export const step = () => setupStep({ user: syncState.user, link: link.key, row: link.row });

export function resetLink() {
  Object.assign(link, { key: undefined, row: null, at: null, code: undefined, mode: "join", q: "", hits: null });
  link.err = "";
}
// after sign-in, and when the tab comes back: the link and its account's latest data
export async function pullLink() {
  const U = syncState.user;
  if (!U || !syncState.sb) return;
  const { data, error } = await syncState.sb
    .from("account_links")
    .select("account_key")
    .eq("user_id", U.id)
    .maybeSingle();
  if (U !== syncState.user) return;
  if (error) {
    link.err = "Couldn't load your F1 Fantasy link: " + error.message;
    return renderSync();
  }
  link.err = "";
  const key = data ? data.account_key : null;
  if (!key) {
    if (link.key) setAccount(null); // deleted on another device
    link.key = null;
    link.row = null;
    renderSync();
    refreshViews(["calc"]); // its banner offers the setup
    return autoOpen();
  }
  if (key !== link.key) link.at = null;
  link.key = key;
  await loadAccount(false);
}
async function loadAccount(force) {
  const U = syncState.user;
  const { data, error } = await syncState.sb
    .from("tracked_accounts")
    .select("account_key, username, teams, body, updated_at")
    .eq("account_key", link.key)
    .maybeSingle();
  if (U !== syncState.user) return;
  if (error) {
    link.err = "Couldn't load your F1 Fantasy teams: " + error.message;
    return renderSync();
  }
  const at = data ? data.updated_at : "none";
  if (!force && at === link.at) return renderSync(); // nothing new
  link.at = at;
  link.row = data || null;
  setAccount(link.row, force);
  renderSync();
}
// the setup opens by itself once per tab while signed in without a link (not over another dialog)
function autoOpen() {
  try {
    if (sessionStorage.getItem(SEEN) || !$("#modal").hidden) return;
    sessionStorage.setItem(SEEN, "1");
  } catch (e) {
    return;
  }
  openSetup("join");
}
async function loadCode() {
  if (link.code !== undefined) return;
  const { data, error } = await syncState.sb
    .from("app_config")
    .select("key, value")
    .in("key", ["tracking_join_code", "tracking_league_name"]);
  if (error) return;
  const get = (k) => (data.find((r) => r.key === k) || {}).value;
  link.code = get("tracking_join_code") || null;
  link.league = get("tracking_league_name") || "";
}

/* ---------- the dialog ---------- */
export async function openSetup(mode) {
  if (!syncState.user) return toast("Sign in first: your teams are linked to your Pit Wall account.");
  link.mode = mode;
  if (mode !== "search") link.hits = null;
  renderSetup();
  openModal("setup");
  if (mode === "join" || mode === "missing") {
    await loadCode();
    if (link.mode === mode) renderSetup();
  }
  if (mode === "search") $("#acctSearch")?.focus();
}
const teamNames = (row) =>
  accountTeams(row)
    .map((t) => esc(t.name))
    .join(" · ") || "no teams yet";
function codeHtml() {
  if (link.code === undefined) return '<span class="dim">loading…</span>';
  if (!link.code) return '<span class="dim">not set yet: ask the site owner</span>';
  return `<code class="joincode">${esc(link.code)}</code> <button class="tbtn sm" data-setup="copy" title="Copy the league code">Copy</button>`;
}
function renderSetup() {
  const m = link.mode;
  let h;
  if (m === "search") {
    h =
      `<h3 id="modalTitle">Find your F1 Fantasy account</h3>` +
      `<label class="field">Your F1 Fantasy username<input id="acctSearch" class="inp" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. Fantasy Pit Wall" value="${esc(link.q)}"></label>` +
      `<div id="acctHits" class="accthits">${hitsHtml()}</div>` +
      `<div class="chipbar"><button class="btn ghost sm" data-setup="join">Back</button></div>`;
  } else if (m === "delete") {
    h =
      `<h3 id="modalTitle">Delete the link?</h3>` +
      `<p class="note">Pit Wall stops loading the teams of <b>${esc(link.row ? link.row.username : "this account")}</b>. They're cleared from the Calculator, which then starts from no team. You can link again any time.</p>` +
      `<div class="chipbar"><button class="btn" data-setup="unlink">Delete the link</button><button class="btn ghost" data-setup="close">Cancel</button></div>`;
  } else {
    h =
      `<h3 id="modalTitle">Load your F1 Fantasy teams</h3>` +
      (m === "missing"
        ? `<p class="note">Your linked F1 Fantasy account isn't in this season's tracking league yet.</p>`
        : "") +
      `<ol class="setupsteps"><li>On F1 Fantasy, join Pit Wall's tracking league${link.league ? ` (“${esc(link.league)}”)` : ""} with <b>all</b> your teams (Leagues → Join a league). League code: ${codeHtml()}</li>` +
      `<li>Find your F1 Fantasy username here and link it. Your teams then load by themselves and update after every race.</li></ol>` +
      `<p class="note">Pit Wall only reads F1 Fantasy's public league standings. It can't change anything in your F1 Fantasy account.</p>` +
      `<div class="chipbar"><button class="btn" data-setup="search">I've joined</button><button class="btn ghost" data-setup="close">Not now</button></div>`;
  }
  $("#modalBody").innerHTML = h;
}
function hitsHtml() {
  if (link.hits == null)
    return likePattern(link.q) ? '<p class="note">Searching…</p>' : '<p class="note">Type at least 2 letters.</p>';
  if (link.hits.error) return `<p class="note bad">${esc(link.hits.error)}</p>`;
  if (!link.hits.length)
    return `<p class="note">No F1 Fantasy account matches “${esc(link.q.trim())}” yet. New members appear after the next race's standings update.</p>`;
  return (
    link.hits
      .map(
        (r) =>
          `<button class="acctpick" data-linkacct="${esc(r.account_key)}"${r.account_key === link.key ? ' aria-pressed="true"' : ""}><b>${esc(r.username)}</b><small>${teamNames(r)}</small></button>`,
      )
      .join("") + `<p class="note">Not listed? New members appear after the next race's standings update.</p>`
  );
}
// typing in the search box: search once the typing pauses
export function searchInput(t) {
  link.q = t.value;
  link.hits = null;
  $("#acctHits").innerHTML = hitsHtml();
  clearTimeout(searchTimer);
  if (likePattern(link.q)) searchTimer = setTimeout(search, 300);
}
async function search() {
  const pat = likePattern(link.q),
    no = ++searchNo;
  if (!pat || !syncState.user) return;
  const { data, error } = await syncState.sb
    .from("tracked_accounts")
    .select("account_key, username, teams")
    .ilike("username", pat)
    .order("username")
    .limit(20);
  if (no !== searchNo || link.mode !== "search" || !$("#acctHits")) return; // a newer search, or the dialog closed
  link.hits = error ? { error: "Search failed: " + error.message } : data;
  $("#acctHits").innerHTML = hitsHtml();
}
export async function linkAccount(key) {
  const U = syncState.user;
  if (!U) return;
  const hit = (link.hits || []).find((r) => r.account_key === key);
  const { error } = await syncState.sb.from("account_links").upsert({ user_id: U.id, account_key: key });
  if (U !== syncState.user) return;
  if (error) return toast("Couldn't link it: " + error.message);
  link.key = key;
  link.at = null;
  closeModal();
  toast(`Linked ${hit ? hit.username : "your F1 Fantasy account"}.`);
  await loadAccount(true);
}
async function unlink() {
  const U = syncState.user;
  if (!U) return;
  const { error } = await syncState.sb.from("account_links").delete().eq("user_id", U.id);
  if (U !== syncState.user) return;
  if (error) return toast("Couldn't delete the link: " + error.message);
  closeModal();
  dropAccount();
  Object.assign(link, { key: null, row: null, at: null });
  try {
    sessionStorage.removeItem(SEEN); // the setup shows again next time
  } catch (e) {}
  renderSync();
  toast("Link deleted. Your F1 Fantasy teams are no longer loaded here.");
}
export function setupAction(a) {
  if (a === "close") return closeModal();
  if (a === "unlink") return unlink();
  if (a === "copy") {
    navigator.clipboard?.writeText(link.code || "").then(
      () => toast("League code copied."),
      () => toast("Couldn't copy: select the code instead."),
    );
    return;
  }
  openSetup(a);
}

/* ---------- Settings: the linked account ---------- */
export function linkHtml() {
  const s = step();
  const err = link.err ? `<p class="note bad">${esc(link.err)}</p>` : "";
  if (s === "loading") return err;
  let h = `<div class="linkbox"><div class="lbl">Your F1 Fantasy account</div>`;
  if (s === "linked")
    h +=
      `<b>${esc(link.row.username)}</b><small>${teamNames(link.row)}</small>` +
      `<div class="chipbar"><button class="btn ghost sm" data-setup="search">Change</button><button class="btn ghost sm" data-setup="delete">Delete</button></div>`;
  else if (s === "missing")
    h +=
      `<p class="note">Linked, but not in this season's tracking league yet: join it with all your teams. New members appear after the next race's standings update.</p>` +
      `<div class="chipbar"><button class="btn sm" data-setup="missing">Show the league code</button><button class="btn ghost sm" data-setup="search">Change</button><button class="btn ghost sm" data-setup="delete">Delete</button></div>`;
  else
    h +=
      `<p class="note">Not linked. Link it once and your teams load by themselves, updated after every race.</p>` +
      `<div class="chipbar"><button class="btn sm" data-setup="join">Set up</button></div>`;
  return h + `</div>` + err;
}
