/* ---------- Settings > Admin: the settings that change from season to season (public.app_config) ----------
   Shown only to admins = accounts in the Supabase `owners` table. Every signed-in user can read app_config; only
   admins can change it (RLS, supabase/setup.sql). */
import { $, esc } from "./core.js";
import { syncState } from "./sync.js";
import { link } from "./setup.js";
import { toast } from "./main.js";

// The settings the page reads, with what each is for. Any other key in app_config is listed below them.
export const CONFIG_KEYS = [
  [
    "tracking_join_code",
    "Tracking league code",
    "The code users enter on F1 Fantasy (Leagues → Join a league) to join this season's tracking league. Shown in the setup, to signed-in users only.",
  ],
  [
    "tracking_league_name",
    "Tracking league name",
    "The tracking league's name on F1 Fantasy, shown in the setup so users can check they joined the right one.",
  ],
];
export const admin = { on: false, rows: null, err: "" };

// after sign-in: is this account an admin, and if so the current settings
export async function pullAdmin() {
  const U = syncState.user;
  if (!U || !syncState.sb) return resetAdmin();
  const { data } = await syncState.sb.from("owners").select("user_id").eq("user_id", U.id).maybeSingle();
  if (U !== syncState.user) return;
  admin.on = !!data;
  if (admin.on) await loadConfig();
  renderAdmin();
}
export function resetAdmin() {
  Object.assign(admin, { on: false, rows: null, err: "" });
  renderAdmin();
}
async function loadConfig() {
  const { data, error } = await syncState.sb.from("app_config").select("key, value, updated_at").order("key");
  admin.rows = error ? [] : data;
  admin.err = error ? "Couldn't load the settings: " + error.message : "";
}
const when = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric" });
function field({ key, label, help, row, known }) {
  return (
    `<div class="adminfield"><label for="cfg-${key}">${esc(label)}</label>` +
    `<div class="adminrow"><input id="cfg-${key}" class="inp" type="text" maxlength="2000" spellcheck="false" autocomplete="off" value="${esc(row ? row.value : "")}">` +
    `<button class="btn sm" data-cfgsave="${key}">Save</button>` +
    (known ? "" : `<button class="btn ghost sm" data-cfgdel="${key}">Delete</button>`) +
    `</div><small>${esc(help)}${help ? " " : ""}${row ? `Changed ${when(row.updated_at)}.` : "Not set."}</small></div>`
  );
}
export function renderAdmin() {
  const box = $("#adminPanel");
  if (!box) return;
  box.hidden = !admin.on;
  if (!admin.on) return;
  const rows = admin.rows || [];
  const known = CONFIG_KEYS.map(([key, label, help]) => ({ key, label, help, known: true }));
  const other = rows
    .filter((r) => !CONFIG_KEYS.some(([k]) => k === r.key))
    .map((r) => ({ key: r.key, label: r.key, help: "", known: false }));
  $("#adminBody").innerHTML =
    `<p class="note">Settings that change from season to season. Only admins see this panel and can change them; the page reads them for signed-in users.</p>` +
    (admin.err ? `<p class="note bad">${esc(admin.err)}</p>` : "") +
    [...known, ...other].map((x) => field({ ...x, row: rows.find((r) => r.key === x.key) })).join("") +
    `<details class="adminadd"><summary>Add a setting</summary><div class="adminrow">` +
    `<input id="cfgNewKey" class="inp" type="text" placeholder="key_name" spellcheck="false" autocomplete="off">` +
    `<input id="cfgNewVal" class="inp" type="text" placeholder="value" spellcheck="false" autocomplete="off">` +
    `<button class="btn sm" data-cfgadd="1">Add</button></div>` +
    `<small>Lower-case letters, digits and _. The page only uses settings its code reads, so a new one also needs a code change.</small></details>`;
}
async function write(key, value) {
  const U = syncState.user;
  const { error } = value
    ? await syncState.sb.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() })
    : await syncState.sb.from("app_config").delete().eq("key", key);
  if (U !== syncState.user) return false;
  if (error) {
    toast(
      error.code === "42501"
        ? "Not saved: this account isn't an admin."
        : error.code === "23514"
          ? "Not saved: that key or value isn't allowed."
          : "Not saved: " + error.message,
    );
    return false;
  }
  // the setup dialog reads these; it picks up the new values next time it opens
  if (key === "tracking_join_code" || key === "tracking_league_name") link.code = undefined;
  await loadConfig();
  renderAdmin();
  return true;
}
export async function cfgSave(key) {
  const value = ($(`#cfg-${key}`).value || "").trim();
  if (await write(key, value)) toast(value ? "Saved." : "Cleared.");
}
export async function cfgDelete(key) {
  if (await write(key, "")) toast(`Deleted ${key}.`);
}
export async function cfgAdd() {
  const key = ($("#cfgNewKey").value || "").trim().toLowerCase(),
    value = ($("#cfgNewVal").value || "").trim();
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(key))
    return toast("A key is lower-case letters, digits and _ (starting with a letter).");
  if (!value) return toast("Give it a value.");
  if (await write(key, value)) toast(`Added ${key}.`);
}
