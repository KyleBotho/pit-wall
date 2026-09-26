// Pit Wall data refresh: Supabase Edge Function "refresh" (deploy with "Verify JWT" OFF; it checks admins itself).
// Starts the site's GitHub workflow (refresh.yml: fetch, rebuild, publish) when new data is due, instead of GitHub
// running it on a blind timer. refresh.py publishes the plan with every build (refresh-plan.json next to the page:
// after each session, before lock, until the race's points are certified, daily); Supabase's scheduler (pg_cron,
// supabase/setup.sql) calls "tick" every 5 minutes and this starts the workflow once per plan entry that fell due.
//   POST ?tick           the scheduler: start the workflow if a plan entry fell due since the last start
//   POST {action:"run"}  an admin's "Refresh now" (Settings > Admin): Authorization: Bearer <their session token>
//   GET                  status for the admin panel: last start, the next planned refreshes, the latest runs
// Needs: supabase/setup.sql (table refresh_state) and the secret GITHUB_DISPATCH_TOKEN (a fine-grained GitHub token
// for KyleBotho/pit-wall only, permission "Actions: Read and write"). Ticks can't start more runs than the plan
// has entries, so they need no key; "run" is admins only and at most once per MIN_GAP_MS.
import { createClient } from "npm:@supabase/supabase-js@2";

const REPO = "KyleBotho/pit-wall";
const WORKFLOW = "refresh.yml";
const PLAN_URL = "https://kylebotho.github.io/pit-wall/refresh-plan.json";
const MIN_GAP_MS = 10 * 60_000; // between an admin's refresh and any other start
const CATCH_UP_MS = 3 * 3600_000; // a due entry older than this (the scheduler was down) is skipped, not chased
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "apikey, authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN") ?? "";

type Entry = { at: string; why: string };
type State = { last_due: string | null; started_at: string | null; source: string | null; reason: string | null; error: string | null; error_at: string | null };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const gh = (path: string, init: RequestInit = {}) =>
  fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${TOKEN}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pit-wall-refresh" },
  });

async function plan(): Promise<Entry[]> {
  const r = await fetch(`${PLAN_URL}?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`plan: HTTP ${r.status}`);
  return ((await r.json()).plan ?? []) as Entry[];
}

async function state(): Promise<State> {
  const { data, error } = await db.from("refresh_state").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(`refresh_state: ${error.message}`);
  if (data) return data as State;
  await db.from("refresh_state").insert({ id: 1 });
  return { last_due: null, started_at: null, source: null, reason: null, error: null, error_at: null };
}

// when the token expires: GitHub says so on every answer to a fine-grained token ("2026-12-25 12:00:00 UTC")
let tokenExpires: string | null = null;
// the latest runs of the workflow (any trigger): public data for a public repo
async function runs(n = 3) {
  const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=${n}`);
  const exp = r.headers.get("github-authentication-token-expiration");
  if (exp) tokenExpires = new Date(exp.replace(" UTC", "Z").replace(" ", "T")).toISOString();
  if (!r.ok) return [];
  return ((await r.json()).workflow_runs ?? []).map((x: Record<string, string>) => ({
    event: x.event, status: x.status, conclusion: x.conclusion, created: x.created_at, updated: x.updated_at, url: x.html_url,
  }));
}

async function start(): Promise<string | null> {
  if (!TOKEN) return "GITHUB_DISPATCH_TOKEN isn't set";
  const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
  return r.status === 204 ? null : `GitHub answered ${r.status}: ${(await r.text()).slice(0, 200)}`;
}

async function note(fields: Partial<State>) {
  await db.from("refresh_state").update(fields).eq("id", 1);
}

async function tick() {
  const now = Date.now();
  const due = (await plan()).filter((e) => Date.parse(e.at) <= now).pop();
  if (!due || now - Date.parse(due.at) > CATCH_UP_MS) return { started: false, why: "nothing due" };
  const st = await state();
  if (st.last_due && Date.parse(st.last_due) >= Date.parse(due.at)) return { started: false, why: "already started for " + due.at };
  // claim the entry (two ticks at once: only one gets the row back)
  const at = new Date(due.at).toISOString(); // "Z" form: a "+" inside a filter would read as a space
  const { data } = await db.from("refresh_state").update({ last_due: at }).eq("id", 1)
    .or(`last_due.is.null,last_due.lt.${at}`).select("id");
  if (!data?.length) return { started: false, why: "claimed by another tick" };
  // a start after the entry fell due (an admin's refresh) already covers it
  if (st.started_at && Date.parse(st.started_at) >= Date.parse(due.at)) return { started: false, why: "covered by the start at " + st.started_at };
  const err = await start();
  if (err) {
    await note({ last_due: st.last_due, error: err, error_at: new Date().toISOString() }); // retried on the next tick
    return { started: false, why: err };
  }
  await note({ started_at: new Date().toISOString(), source: "schedule", reason: due.why, error: null, error_at: null });
  return { started: true, why: due.why };
}

async function isAdmin(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return false;
  const { data } = await db.from("owners").select("user_id").eq("user_id", u.user.id).maybeSingle();
  return !!data;
}

async function run(req: Request) {
  if (!(await isAdmin(req))) return json({ error: "Only admins can start a refresh." }, 403);
  const st = await state();
  const last = st.started_at ? Date.parse(st.started_at) : 0;
  if (Date.now() - last < MIN_GAP_MS)
    return json({ error: "A refresh started less than 10 minutes ago.", retryAt: new Date(last + MIN_GAP_MS).toISOString() }, 429);
  const busy = (await runs(1)).find((r: { status: string }) => r.status !== "completed");
  if (busy) return json({ error: "A refresh is already running.", run: busy }, 409);
  const err = await start();
  if (err) {
    await note({ error: err, error_at: new Date().toISOString() });
    return json({ error: "GitHub didn't start the refresh: " + err }, 502);
  }
  await note({ started_at: new Date().toISOString(), source: "admin", reason: "Refresh now", error: null, error_at: null });
  return json({ started: true });
}

async function status() {
  const now = Date.now();
  let next: Entry[] = [], planError: string | null = null;
  try {
    next = (await plan()).filter((e) => Date.parse(e.at) > now).slice(0, 5);
  } catch (e) {
    planError = String(e);
  }
  const latest = await runs();
  return json({ state: await state(), next, planError, runs: latest, token: !!TOKEN, tokenExpires });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    if (req.method === "GET") return await status();
    if (new URL(req.url).searchParams.has("tick")) return json(await tick());
    const body = await req.json().catch(() => ({}));
    if (body?.action === "run") return await run(req);
    return json({ error: "unknown request" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
