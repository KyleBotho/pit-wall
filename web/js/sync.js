/* ---------- encrypted private leagues (sealed by the private repo's leagues.py with seal.js and LEAGUE_KEY) ---------- */
import { createClient } from "@supabase/supabase-js";
import { $, $$, DATA, byId, esc, isDriver, money } from "./core.js";
import { KEY, loadState, setState, state } from "./state.js";
import { compute, forecast } from "./forecast.js";
import { teamKey, teamLabel, tracked, usedChips } from "./league.js";
import { labCheck } from "./lab.js";
import { closeModal, openModal, refreshViews, renderAll, rerender, toast } from "./main.js";
export let SEALED = null; // the league payload (from the account, or decrypted with the passphrase): memory only
// The passphrase itself is never stored. This browser keeps a non-extractable PBKDF2 key made from it (IndexedDB):
// it can derive the decryption key for each new seal (fresh salt every time) but can't be read back out.
const LK = "pitwall.lk"; // IndexedDB record name; also where older pages kept the passphrase in plain text
const LEAGUE_VIEWS = ["league", "elite", "hind", "live", "stats", "calc"]; // views that show league or line-up data
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function keyStore(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pitwall", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result,
        tx = db.transaction("keys", mode),
        req = op(tx.objectStore("keys"));
      tx.oncomplete = () => (db.close(), resolve(req.result));
      tx.onerror = tx.onabort = () => (db.close(), reject(tx.error));
    };
  });
}
const keyGet = () => keyStore("readonly", (s) => s.get(LK)).catch(() => null);
const keyPut = (k) => keyStore("readwrite", (s) => s.put(k, LK)).catch(() => {});
const keyDel = () => keyStore("readwrite", (s) => s.delete(LK)).catch(() => {});
async function unseal(base) {
  const z = DATA.leagueSealed;
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(z.salt), iterations: z.iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(z.iv) }, key, b64(z.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
// a passphrase typed in (or left by an older page): kept, as a key, only if it opens the leagues
export async function unlock(pass, quiet) {
  if (!DATA.leagueSealed || !window.crypto || !crypto.subtle) {
    if (!quiet) toast("Encrypted leagues need the https site.");
    return;
  }
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  if (await tryUnseal(base, quiet)) await keyPut(base);
}
// league data goes live: your teams keyed and filled in, tracking applied (then refresh the league views)
function useLeagues(payload) {
  SEALED = payload;
  adoptKeys();
  if (forecast) {
    fillFromLineups();
    applyTracked();
  }
}
const leagueCount = () => `${SEALED.leagues.length} league${SEALED.leagues.length === 1 ? "" : "s"}`;
async function tryUnseal(base, quiet) {
  let ok = false;
  try {
    useLeagues(await unseal(base));
    ok = true;
    if (!quiet) toast(`Unlocked ${leagueCount()}.`);
  } catch (e) {
    SEALED = null;
    if (!quiet) toast("That passphrase didn't work.");
  }
  if (forecast) refreshViews(LEAGUE_VIEWS);
  return ok;
}
// Signed-in accounts on the reader list (public.league_readers) get the leagues from the account, no passphrase:
// public.league_data, written by the private repo's workflow, readable only by them (RLS). Anyone else gets no row
// and keeps the passphrase route.
let leaguesAt = null; // updated_at of the row in use
export async function pullLeagues() {
  const U = syncState.user;
  if (!U || !syncState.sb) return;
  const { data, error } = await syncState.sb
    .from("league_data")
    .select("body, updated_at")
    .eq("id", "current")
    .maybeSingle();
  if (U !== syncState.user || error || !data || data.updated_at === leaguesAt) return;
  const first = leaguesAt == null && !SEALED;
  leaguesAt = data.updated_at;
  useLeagues(data.body);
  if (first) toast(`Loaded ${leagueCount()} from your account.`);
  if (forecast) refreshViews(LEAGUE_VIEWS);
}
// at load: this browser's saved key, or a plain-text passphrase from an older page (moved into a key, then deleted)
export async function unlockSaved() {
  let old = null;
  try {
    old = localStorage.getItem(LK);
    localStorage.removeItem(LK);
  } catch (e) {}
  if (old) return unlock(old, true);
  const base = await keyGet();
  if (base) tryUnseal(base, true);
}
// Teams saved before team keys (see teamKey) are matched to the sealed data by name, once; from then on the key
// follows them through renames. A name two teams share stays unmatched rather than guessed.
function adoptKeys() {
  const names = SEALED && SEALED.names;
  if (!names) return;
  let changed = false;
  for (const t of state.teams) {
    if (t.example || t.tk) continue;
    const hits = Object.keys(names).filter((k) => names[k] === t.name);
    if (hits.length === 1) {
      t.tk = hits[0];
      changed = true;
    }
  }
  if (changed) save();
}
// A browser with only example teams takes your teams from the sealed data: the line-up, bank, free transfers and
// chips going into the round after the last one known (an export, then the line-ups seen after each race).
function fillFromLineups() {
  const saved = SEALED && SEALED.lineups;
  if (!saved || !state.teams.every((t) => t.example)) return;
  let n = 0,
    latest = 0;
  for (const key of Object.keys(saved)) {
    if (n > 2) break;
    const next = (tracked(key) || {}).next;
    if (!next) continue;
    const got = next.ids.map(String).filter((id) => byId[id]);
    const ids = got.filter(isDriver).concat(got.filter((id) => !isDriver(id)));
    if (ids.length !== 7 || ids.slice(0, 5).some((id) => !isDriver(id))) continue;
    Object.assign(state.teams[n], {
      name: teamLabel(key),
      ...(SEALED.names ? { tk: key } : {}), // older sealed files are keyed by name
      team: ids,
      bank: next.bank ?? state.teams[n].bank,
      free: next.free ?? 2,
      boost: "auto",
      chipsUsed: usedChips(tracked(key)),
      asOf: next.asOf + 1,
      example: false,
    });
    latest = Math.max(latest, next.asOf);
    n++;
  }
  if (!n) return;
  rerender();
  toast(`Loaded ${n} team${n === 1 ? "" : "s"} as they stood after R${latest}.`);
}
// Your teams follow F1's data: once a race is over and its line-ups are in, each team's current line-up, bank, free
// transfers and chips played update by themselves. A team already set up for a later race (t.asOf: an import taken
// before the lock, or an earlier update) is left alone; chips played are always added (and locked in the Calculator).
export function applyTracked() {
  const news = [];
  let changed = false;
  for (const t of state.teams) {
    if (t.example) continue;
    const tr = tracked(teamKey(t));
    if (!tr) continue;
    const used = usedChips(tr);
    if (Object.keys(used).some((k) => !t.chipsUsed[k])) {
      Object.assign(t.chipsUsed, used);
      changed = true;
    }
    const next = tr.next;
    if (!next || next.asOf + 1 <= (t.asOf || 0)) continue;
    const got = next.ids.map(String).filter((id) => byId[id]);
    const ids = got.filter(isDriver).concat(got.filter((id) => !isDriver(id)));
    if (ids.length !== 7) continue;
    const moved = ids.filter((id) => !t.team.includes(id)).length;
    Object.assign(t, { team: ids, boost: "auto", asOf: next.asOf + 1 });
    if (next.bank != null) t.bank = next.bank;
    if (next.free != null) t.free = next.free;
    changed = true;
    news.push(
      `${t.name}${moved ? ` (${moved} change${moved === 1 ? "" : "s"})` : ""}: ${next.bank != null ? money(next.bank) + " bank, " : ""}${next.free ?? "?"} free`,
    );
  }
  if (!changed) return;
  save();
  rerender();
  if (news.length) {
    const r = Math.max(...state.teams.map((t) => (t.asOf || 1) - 1));
    toast(`Teams updated after R${r}: ${news.join("; ")}.`);
  }
}
export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, v: DATA.season }));
  } catch (e) {}
  queuePush();
}

/* ---------- account sync: Google sign-in (Supabase), one row of settings per user, RLS = own row only ----------
   Rules: the account's row wins if it changed since this browser last matched it and this browser has nothing
   unsent; this browser's unsent edits are pushed if the row hasn't changed; if both changed (or a browser with its
   own teams signs in for the first time) nothing syncs until the user picks which set to keep. */
export const SB_URL = "https://tfljgylwpkpammzsapin.supabase.co";
const SB_KEY = "sb_publishable_5XxT7rr5X-XS1HyduNK1qQ_TfoP2PLV"; // public by design (RLS protects the rows)
const SK = "pitwall.sync"; // {uid, at, dirty}: the row version this browser last matched, and whether it has unsent changes
const NOSYNC = ["view", "pane", "bmode", "sub", "showN", "calcGrp"]; // where you are on this device, not settings
export const syncState = {
  sb: null,
  user: null,
  at: null,
  busy: false,
  err: "",
  hold: null, // an account row waiting for the user to choose between it and this browser's settings
  holdWhy: "",
  timer: null,
  last: null,
  ready: false,
  applying: false,
  ok: location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname),
};
const readMark = () => {
  try {
    return JSON.parse(localStorage.getItem(SK) || "null");
  } catch (e) {
    return null;
  }
};
const writeMark = (m) => {
  try {
    if (m) localStorage.setItem(SK, JSON.stringify(m));
    else localStorage.removeItem(SK);
  } catch (e) {}
};
const pristine = () => state.teams.every((t) => t.example) && !state.drafts.length && !state.league;
function syncPayload() {
  const s = {};
  for (const k in state) if (!NOSYNC.includes(k)) s[k] = state[k];
  return { v: DATA.season, s }; // never the league passphrase
}
// rows saved by older pages may still hold the league passphrase ("lk"): used once here, then written over without it
const holdsKey = (row) => !!row && !!row.data && "lk" in row.data;
export async function syncInit() {
  if (!syncState.ok) return;
  try {
    // bundled from npm with the page (package-lock.json pins it): no script is fetched from elsewhere
    syncState.sb = createClient(SB_URL, SB_KEY, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (e) {
    syncState.err = "Sign-in couldn't load.";
    return renderSync();
  }
  const q = new URLSearchParams(location.search);
  if (q.get("error_description")) toast("Sign-in failed: " + q.get("error_description"));
  syncState.sb.auth.onAuthStateChange((ev, session) => {
    if (q.has("code") || q.has("error")) history.replaceState(null, "", location.pathname + location.hash); // after the code exchange
    const u = session ? session.user : null;
    if ((u && u.id) === (syncState.user && syncState.user.id)) return renderSync(); // token refresh
    Object.assign(syncState, { user: u, at: null, err: "", hold: null, last: null, ready: false });
    renderSync();
    labCheck();
    // not inside the callback: supabase-js can deadlock on calls made there
    if (u)
      setTimeout(() => {
        pull();
        pullLeagues();
      }, 0);
  });
}
export async function pull() {
  const U = syncState.user;
  if (!U || syncState.hold || syncState.timer) return;
  const { data, error } = await syncState.sb
    .from("configs")
    .select("data, updated_at")
    .eq("user_id", U.id)
    .maybeSingle();
  if (U !== syncState.user) return;
  if (error) {
    syncState.err = "Couldn't load your settings: " + error.message;
    return renderSync();
  }
  if (!data) return push(); // first sign-in anywhere: this browser's settings start the account
  const m = readMark(),
    mine = m && m.uid === U.id,
    changed = !mine || Date.parse(data.updated_at) > Date.parse(m.at);
  if (!changed) {
    syncState.at = data.updated_at;
    syncState.ready = true;
    if (m.dirty || holdsKey(data)) return push();
    syncState.last = JSON.stringify(syncPayload());
    return renderSync();
  }
  // the account changed elsewhere: take it, unless this browser has its own unsent work
  if (mine && m.dirty) return hold(data, "both");
  if (!mine && !pristine()) return hold(data, "new");
  applyRemote(data, mine ? "Updated from another device." : "Loaded your settings.");
}
function hold(row, why) {
  Object.assign(syncState, { hold: row, holdWhy: why });
  renderSync();
  askWhich();
}
function applyRemote(row, msg) {
  const d = row.data || {};
  if (!d.s) {
    syncState.ready = true;
    return push();
  }
  // an older season's row: this browser's (current season) settings win unless it has none of its own
  if (d.v !== DATA.season && !pristine()) {
    syncState.ready = true;
    return push();
  }
  const next = loadState({ ...d.s, v: d.v });
  for (const k of NOSYNC) if (state[k] !== undefined) next[k] = state[k]; // this device's place and layout stay
  setState(next);
  syncState.applying = true;
  compute();
  renderAll();
  save();
  syncState.applying = false;
  const last = holdsKey(row) ? null : JSON.stringify(syncPayload()); // null: push again, to clear the passphrase
  Object.assign(syncState, { at: row.updated_at, last, ready: true, err: "" });
  writeMark({ uid: syncState.user.id, at: row.updated_at, dirty: false });
  renderSync();
  if (typeof d.lk === "string" && d.lk && !SEALED) unlock(d.lk, true);
  if (d.v !== DATA.season) toast(`Carried your settings over from ${d.v}; teams start fresh for ${DATA.season}.`);
  else if (msg) toast(msg);
  queuePush();
}
function queuePush() {
  if (!syncState.user || !syncState.ready || syncState.hold || syncState.applying) return;
  if (JSON.stringify(syncPayload()) === syncState.last) return;
  const m = readMark();
  // mark unsent edits first, so they survive a tab closed before the push
  if (!(m && m.uid === syncState.user.id && m.dirty))
    writeMark({ uid: syncState.user.id, at: syncState.at, dirty: true });
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(push, 2000);
}
async function push() {
  clearTimeout(syncState.timer);
  syncState.timer = null;
  const U = syncState.user;
  if (!U || syncState.hold) return;
  const p = syncPayload(),
    j = JSON.stringify(p);
  syncState.busy = true;
  renderSync();
  const { data, error } = await syncState.sb
    .from("configs")
    .upsert({ user_id: U.id, data: p })
    .select("updated_at")
    .single();
  syncState.busy = false;
  if (U !== syncState.user) return;
  if (error) {
    // 23514: over the account's size cap (configs_data_size in supabase/setup.sql)
    syncState.err =
      error.code === "23514"
        ? "Not synced: your settings are over the account's 1 MB limit (an imported league is the big part)."
        : "Not synced: " + error.message;
    return renderSync();
  }
  Object.assign(syncState, { at: data.updated_at, last: j, ready: true, err: "" });
  const dirty = JSON.stringify(syncPayload()) !== j; // changed while sending
  writeMark({ uid: U.id, at: data.updated_at, dirty });
  if (dirty) queuePush();
  renderSync();
}
export function askWhich() {
  const r = syncState.hold;
  if (!r) return;
  const when = esc(new Date(r.updated_at).toLocaleString());
  const why =
    syncState.holdWhy === "both"
      ? `This browser has changes that weren't synced yet, and your account was changed on another device since (${when}).`
      : `This browser has its own teams and settings, and your account already has a saved set (from ${when}).`;
  $("#modalBody").innerHTML = `<h3 id="modalTitle">Which settings should this browser use?</h3>
    <p class="note">${why} Choose one; the other is replaced. Until you choose, nothing is synced.</p>
    <div class="chipbar"><button class="btn" data-sync="account">Use my account's</button><button class="btn ghost" data-sync="browser">Keep this browser's</button></div>`;
  openModal();
}
export function syncChoose(k) {
  const r = syncState.hold;
  Object.assign(syncState, { hold: null, holdWhy: "" });
  closeModal();
  if (!r) return;
  if (k === "account") return applyRemote(r, "Loaded your account's settings.");
  syncState.ready = true;
  push();
  toast("Saved this browser's settings to your account.");
}
export async function signIn() {
  if (!syncState.sb) return toast(syncState.err || "Sign-in works on the published site.");
  const { error } = await syncState.sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(error.message);
}
export async function signOut() {
  if (syncState.timer) await push(); // don't drop the last edits
  try {
    await syncState.sb.auth.signOut({ scope: "local" });
  } catch (e) {}
  Object.assign(syncState, { user: null, at: null, err: "", hold: null, last: null, ready: false });
  writeMark(null);
  await keyDel();
  SEALED = null;
  leaguesAt = null;
  renderSync();
  if (forecast) refreshViews(LEAGUE_VIEWS);
  toast("Signed out. Your leagues are locked again in this browser; its settings stay.");
}
const ago = (t) => {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : new Date(t).toLocaleDateString();
};
// [data-needsync] buttons (sign in) only show when sign-in is available and nobody is signed in
export const needSync = () => $$("[data-needsync]").forEach((b) => (b.hidden = !syncState.sb || !!syncState.user));
export function renderSync() {
  needSync();
  const U = syncState.user,
    ss = syncState;
  let h = "";
  if (ss.ok && (ss.sb || ss.err)) {
    if (!U) {
      h =
        `<button class="btn sm" data-signin="1">Sign in with Google</button>` +
        `<p class="note">Your teams and settings follow you to every browser you sign in on.</p>` +
        (ss.err ? `<p class="note bad">${esc(ss.err)}</p>` : "");
    } else {
      const status = ss.err
        ? esc(ss.err)
        : ss.hold
          ? "Not syncing until you choose which settings to keep."
          : ss.busy
            ? "Syncing…"
            : ss.at
              ? "Synced " + ago(ss.at)
              : "Connecting…";
      h =
        `<div class="em">${esc(U.email || "Signed in")}</div><p class="note${ss.err ? " bad" : ""}">${status}</p>` +
        `<div class="chipbar">${ss.hold ? '<button class="btn sm" data-sync="ask">Choose</button>' : ""}<button class="btn ghost sm" data-signout="1">Sign out</button></div>`;
    }
  }
  h += `<button class="btn ghost sm" data-import="1">Import a data export</button><p class="note">After a new F1 Fantasy export: updates your teams, bank, chips and league.</p>`;
  $$(".acct").forEach((el) => {
    el.innerHTML = h;
    el.closest("[data-acct]").hidden = false;
  });
  $("#lgSignin").hidden = !(ss.sb && !U);
  // the rail's account row (bottom of the desktop menu): who is signed in, or a way to sign in
  const ra = $("#railAcct");
  ra.hidden = !(ss.ok && (ss.sb || ss.err));
  if (ra.hidden) return;
  const meta = (U && U.user_metadata) || {},
    name = U ? meta.full_name || meta.name || (U.email || "").split("@")[0] || "Signed in" : "Sign in",
    sub = U ? U.email || "" : "with Google";
  ra.innerHTML = `<button ${U ? 'data-view="settings" title="Account &amp; data"' : 'data-signin="1"'}><span class="av">${U ? esc(name.charAt(0).toUpperCase()) : "G"}</span><span class="rtxt"><b>${esc(name)}</b><small>${esc(sub)}</small></span></button>`;
}
