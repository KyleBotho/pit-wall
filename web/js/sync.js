/* ---------- encrypted private leagues (sealed by the private repo's leagues.py with seal.js and LEAGUE_KEY) ---------- */
let SEALED = null; // decrypted payload, memory only
const LK = "pitwall.lk";
const LEAGUE_VIEWS = ["league", "elite", "hind", "live", "stats", "calc"]; // views that show league or line-up data
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function unseal(pass) {
  const z = DATA.leagueSealed;
  if (!z || !window.crypto || !crypto.subtle) throw new Error("Encrypted leagues need the https site.");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
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
async function tryUnseal(pass, quiet) {
  try {
    SEALED = await unseal(pass);
    try {
      localStorage.setItem(LK, pass);
    } catch (e) {}
    if (!quiet) toast(`Unlocked ${SEALED.leagues.length} league${SEALED.leagues.length === 1 ? "" : "s"}.`);
    queuePush(); // the key travels with the account (unless that's switched off)
    if (forecast) fillFromLineups();
  } catch (e) {
    SEALED = null;
    if (!quiet) toast(e.message && e.message.includes("https") ? e.message : "That passphrase didn't work.");
  }
  if (forecast) refreshViews(LEAGUE_VIEWS);
}
// A browser with only example teams takes the line-ups from the last data export (sealed with the leagues).
function fillFromLineups() {
  const L = SEALED && SEALED.lineups;
  if (!L || !state.teams.every((t) => t.example)) return;
  let n = 0;
  for (const [name, rounds] of Object.entries(L)) {
    if (n > 2) break;
    const gds = Object.keys(rounds)
        .map(Number)
        .sort((a, b) => a - b),
      gd = gds[gds.length - 1],
      r = rounds[gd];
    // a Final Fix swap stays in the team after that race
    const got = (r.ids || []).map((id) => (r.ff && id === r.ff.out ? r.ff.in : String(id))).filter((id) => byId[id]);
    const ids = got.filter(isDriver).concat(got.filter((id) => !isDriver(id)));
    if (ids.length !== 7 || ids.slice(0, 5).some((id) => !isDriver(id))) continue;
    const paid = ids.reduce((s, id) => s + (Hind.at(id, gd)?.price ?? byId[id].price), 0);
    const chipsUsed = {};
    for (const g of gds) if (rounds[g].chip) chipsUsed[rounds[g].chip] = true;
    Object.assign(state.teams[n], {
      name,
      team: ids,
      bank: r.budget ? Math.max(0, Math.round((r.budget - paid) * 10) / 10) : state.teams[n].bank,
      boost: "auto",
      chipsUsed,
      example: false,
    });
    n++;
  }
  if (!n) return;
  rerender();
  const latest = Math.max(...Object.values(L).flatMap((r) => Object.keys(r).map(Number)));
  toast(
    `Loaded ${n} team${n === 1 ? "" : "s"} from your last data export (R${latest}). Check free transfers and bank.`,
  );
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, v: DATA.season }));
  } catch (e) {}
  queuePush();
}

/* ---------- account sync: Google sign-in (Supabase), one row of settings per user, RLS = own row only ----------
   Rules: the account's row wins if it changed since this browser last matched it and this browser has nothing
   unsent; this browser's unsent edits are pushed if the row hasn't changed; if both changed (or a browser with its
   own teams signs in for the first time) nothing syncs until the user picks which set to keep. */
const SB_URL = "https://tfljgylwpkpammzsapin.supabase.co";
const SB_KEY = "sb_publishable_5XxT7rr5X-XS1HyduNK1qQ_TfoP2PLV"; // public by design (RLS protects the rows)
const SB_LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
const SK = "pitwall.sync"; // {uid, at, dirty}: the row version this browser last matched, and whether it has unsent changes
const NOSYNC = ["view", "pane", "sub", "showN"]; // where you are on this device, not settings
const syncState = {
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
  let lk = null;
  if (state.syncKey)
    try {
      lk = localStorage.getItem(LK);
    } catch (e) {}
  return { v: DATA.season, s, lk };
}
async function syncInit() {
  if (!syncState.ok) return;
  try {
    const { createClient } = await import(SB_LIB);
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
    if (u) setTimeout(pull, 0); // not inside the callback: supabase-js can deadlock on calls made there
  });
}
async function pull() {
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
    if (m.dirty) return push();
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
  state = Object.assign(next, { view: state.view, pane: state.pane });
  if (d.lk) {
    try {
      localStorage.setItem(LK, d.lk);
    } catch (e) {}
  }
  syncState.applying = true;
  compute();
  renderAll();
  save();
  syncState.applying = false;
  Object.assign(syncState, { at: row.updated_at, last: JSON.stringify(syncPayload()), ready: true, err: "" });
  writeMark({ uid: syncState.user.id, at: row.updated_at, dirty: false });
  renderSync();
  if (d.lk && !SEALED && DATA.leagueSealed) tryUnseal(d.lk, true);
  if (d.v !== DATA.season) {
    toast(`Carried your settings over from ${d.v}; teams start fresh for ${DATA.season}.`);
    queuePush();
  } else if (msg) toast(msg);
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
    syncState.err = "Not synced: " + error.message;
    return renderSync();
  }
  Object.assign(syncState, { at: data.updated_at, last: j, ready: true, err: "" });
  const dirty = JSON.stringify(syncPayload()) !== j; // changed while sending
  writeMark({ uid: U.id, at: data.updated_at, dirty });
  if (dirty) queuePush();
  renderSync();
}
function askWhich() {
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
function syncChoose(k) {
  const r = syncState.hold;
  Object.assign(syncState, { hold: null, holdWhy: "" });
  closeModal();
  if (!r) return;
  if (k === "account") return applyRemote(r, "Loaded your account's settings.");
  syncState.ready = true;
  push();
  toast("Saved this browser's settings to your account.");
}
async function signIn() {
  if (!syncState.sb) return toast(syncState.err || "Sign-in works on the published site.");
  const { error } = await syncState.sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(error.message);
}
async function signOut() {
  if (syncState.timer) await push(); // don't drop the last edits
  try {
    await syncState.sb.auth.signOut({ scope: "local" });
  } catch (e) {}
  Object.assign(syncState, { user: null, at: null, err: "", hold: null, last: null, ready: false });
  writeMark(null);
  try {
    localStorage.removeItem(LK);
  } catch (e) {}
  SEALED = null;
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
function renderSync() {
  const U = syncState.user,
    ss = syncState;
  let h = "";
  if (ss.ok && (ss.sb || ss.err)) {
    if (!U) {
      h =
        `<button class="btn sm" data-signin="1">Sign in with Google</button>` +
        `<p class="note">Your teams, settings and leagues follow you to every browser you sign in on.</p>` +
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
        `<div class="chipbar">${ss.hold ? '<button class="btn sm" data-sync="ask">Choose</button>' : ""}<button class="btn ghost sm" data-signout="1">Sign out</button></div>` +
        `<label class="switch" title="Off: each browser asks for the passphrase once; the account never holds it"><input type="checkbox" data-synckey="1" ${state.syncKey ? "checked" : ""}><span>Keep my league passphrase in my account</span></label>`;
    }
  }
  h += `<button class="btn ghost sm" data-import="1">Import a data export</button><p class="note">After a new F1 Fantasy export: updates your teams, bank, chips and league.</p>`;
  $$(".acct").forEach((el) => {
    el.innerHTML = h;
    el.closest("[data-acct]").hidden = false;
  });
  $("#lgSignin").hidden = !(ss.sb && !U);
}
