// Pit Wall live feed: Supabase Edge Function "live" (deploy with "Verify JWT" OFF; it's public and read-only).
// F1 Fantasy's feeds have no CORS, so the page can't read them itself. This fetches one gameday's player feed
// server-side and caches it in public.live_cache: F1 sees at most one player-feed request a minute however many
// pages are open, and playerstats (per-asset scoring lines) only for assets whose points changed, one at a time.
//   GET /functions/v1/live?gd=15  ->  { gd, feedTime, checked, assets: { id: { pts, act, sess, ev, lag } } }
//   ev rows: [session code Q/S/R, event name, category code, points, frequency] (same codes as refresh.py)
import { createClient } from "npm:@supabase/supabase-js@2";

const F1 = "https://fantasy.formula1.com/feeds";
const FRESH_MS = 60_000; // serve the cached copy for this long
const PAUSE_MS = 1500; // between playerstats requests (go slow: F1 is the one being asked)
const BUSY_MS = 180_000; // a playerstats refresh older than this is assumed dead
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "apikey, authorization, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS" };

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// F1's scoring-event names -> category codes (first match wins); the same tables refresh.py uses
// <shared:feeds> generated from config/feeds.json by tools/sync-shared.js; don't edit here
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const EV_SESSION: Record<string, string> = {"Qualifying": "Q", "Sprint Qualifying": "S", "Race": "R"};
const EV_RULES: [string, string][] = [
  ["not classified", "NC"],
  ["dq", "DQ"],
  ["disqualif", "DQ"],
  ["position gained", "PG"],
  ["position lost", "PL"],
  ["overtake", "OV"],
  ["fastest lap", "FL"],
  ["driver of day", "DOTD"],
  ["world record", "WRFP"],
  ["2nd fastest pit", "FP2"],
  ["fastest pit", "FP"],
  ["pit", "PIT"],
  ["q3", "TW"],
  ["q2", "TW"],
  ["position", "POS"],
];
// </shared:feeds>
const evCode = (s: string, n: string) => (EV_SESSION[s] ?? "?") + " " + (EV_RULES.find(([k]) => n.toLowerCase().includes(k))?.[1] ?? "OTH");

type Ev = [string, string, string, number, string | null];
type Asset = { pts: number; act: boolean; sess: Record<string, number>; ev: Ev[]; key?: string; evKey?: string | null; lag?: boolean };
type Body = { gd: number; feedTime: string | null; checked: string; assets: Record<string, Asset>; statsAt?: string | null; statsBusy?: string | null };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return await r.json();
}

// "9/17/2026 1:59:44 PM" (UTC) -> ISO
function feedTime(d: { FeedTime?: { UTCTime?: string } }): string | null {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+) (AM|PM)$/.exec(d?.FeedTime?.UTCTime ?? "");
  if (!m) return null;
  const h = (+m[4] % 12) + (m[7] === "PM" ? 12 : 0);
  return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +m[6])).toISOString();
}

async function save(body: Body) {
  await db.from("live_cache").upsert({ gd: body.gd, body, fetched_at: new Date().toISOString() });
}

// Scoring lines for assets whose points changed since their lines were fetched. Runs after the response is sent.
async function refreshStats(gd: number, todo: Record<string, { key: string; pts: number }>) {
  const got: Record<string, { ev: Ev[]; key: string; lag: boolean }> = {};
  for (const [id, t] of Object.entries(todo)) {
    try {
      const ps = await getJSON(`${F1}/popup/playerstats_${id}.json`);
      const m = (ps?.Value?.MatchWiseStats ?? []).find((x: { GamedayId: number }) => x.GamedayId === gd);
      const ev: Ev[] = [];
      for (const rd of m?.RaceDayWise ?? []) {
        for (const e of rd.StatsWise ?? []) {
          if (e.Event === "Total") continue; // per-session subtotal, not an event
          const n = String(e.Event ?? "").trim();
          ev.push([EV_SESSION[rd.SessionType] ?? "?", n, evCode(rd.SessionType, n), Number(e.Value ?? 0), e.Frequency ?? null]);
        }
      }
      // lines that don't add up to the feed's total: playerstats is behind; try again on a later request
      got[id] = { ev, key: t.key, lag: Math.abs(ev.reduce((s, r) => s + r[3], 0) - t.pts) > 0.5 };
    } catch (_) { /* leave it for the next round of requests */ }
    await sleep(PAUSE_MS);
  }
  // merge into the latest row (the player feed may have been refreshed meanwhile)
  const { data } = await db.from("live_cache").select("body").eq("gd", gd).maybeSingle();
  const body = data?.body as Body | undefined;
  if (!body) return;
  for (const [id, g] of Object.entries(got)) {
    const a = body.assets[id];
    if (a) Object.assign(a, { ev: g.ev, evKey: g.key, lag: g.lag });
  }
  body.statsAt = new Date().toISOString();
  body.statsBusy = null;
  await save(body);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const gd = Number(new URL(req.url).searchParams.get("gd"));
  if (!Number.isInteger(gd) || gd < 1 || gd > 30) return json({ error: "gd must be a gameday number (1-30)" }, 400);

  const { data: row } = await db.from("live_cache").select("body, fetched_at").eq("gd", gd).maybeSingle();
  const cached = row?.body as Body | undefined;
  if (cached && Date.now() - Date.parse(row!.fetched_at) < FRESH_MS) return json(cached);
  // claim this refresh, so requests arriving meanwhile get the cached copy instead of fetching too
  if (cached) await db.from("live_cache").update({ fetched_at: new Date().toISOString() }).eq("gd", gd);

  try {
    const d = (await getJSON(`${F1}/drivers/${gd}_en.json`)).Data;
    // Build on the row as it is now, not as it was before the fetch: a background playerstats refresh may have
    // saved newer scoring lines meanwhile, and copying the older ones over them would undo it.
    const { data: now } = await db.from("live_cache").select("body").eq("gd", gd).maybeSingle();
    const base = (now?.body as Body | undefined) ?? cached;
    const prev = base?.assets ?? {};
    const assets: Record<string, Asset> = {};
    for (const p of d?.Value ?? []) {
      const id = String(p.PlayerId), o = prev[id];
      const sess = Object.fromEntries((p.SessionWisePoints ?? []).filter((s: { points: unknown }) => s.points != null)
        .map((s: { sessiontype: string; points: unknown }) => [s.sessiontype, Number(s.points)]));
      const pts = Number(p.GamedayPoints ?? 0) || 0;
      assets[id] = { pts, act: p.IsActive === "1", sess, key: `${pts}|${JSON.stringify(sess)}`, ev: o?.ev ?? [], evKey: o?.evKey ?? null, lag: o?.lag };
    }
    const body: Body = { gd, feedTime: feedTime(d), checked: new Date().toISOString(), assets,
      statsAt: base?.statsAt ?? null, statsBusy: base?.statsBusy ?? null };
    const todo = Object.fromEntries(Object.entries(assets).filter(([, a]) => a.evKey !== a.key || a.lag).map(([id, a]) => [id, { key: a.key!, pts: a.pts }]));
    const busy = body.statsBusy && Date.now() - Date.parse(body.statsBusy) < BUSY_MS;
    if (Object.keys(todo).length && !busy) {
      body.statsBusy = new Date().toISOString();
      // @ts-ignore EdgeRuntime is provided by Supabase's runtime
      EdgeRuntime.waitUntil(refreshStats(gd, todo));
    }
    await save(body);
    return json(body);
  } catch (e) {
    if (cached) return json({ ...cached, error: String(e) });
    return json({ error: String(e) }, 502);
  }
});
