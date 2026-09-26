// Pit Wall live feed: Supabase Edge Function "live" (deploy with "Verify JWT" OFF; it's public and read-only).
// F1 Fantasy's feeds have no CORS, so the page can't read them itself. This fetches one gameday's player feed
// server-side and caches it in public.live_cache: F1 sees at most one player-feed request a minute however many
// pages are open, and playerstats (per-asset scoring lines) only for assets whose points changed, one at a time.
//   GET /functions/v1/live?gd=15  ->  { gd, feedTime, checked, assets: { id: { pts, act, sess, key, ev, evKey, lag } } }
//   ev rows: [session code Q/S/R, event name, category code, points, frequency] (same codes as refresh.py)
// Two writers, two columns, so neither can undo the other: requests write the player feed (body, fetched_at); the
// background playerstats run writes the scoring lines (stats, merged in by live_stats_merge). Both refreshes are
// claimed with a conditional update, so of several requests arriving together only one asks F1.
// Needs supabase/setup.sql run first (the stats and stats_busy columns, live_stats_merge).
import { createClient } from "npm:@supabase/supabase-js@2";

const F1 = "https://fantasy.formula1.com/feeds";
const FRESH_MS = 60_000; // serve the cached copy for this long
const PAUSE_MS = 1500; // between playerstats requests (go slow: F1 is the one being asked)
const BUSY_MS = 180_000; // a playerstats refresh older than this is assumed dead
const LAG_MS = 60_000; // lines that don't add up yet are retried after 1, 2, 4... min
const LAG_MAX_MS = 30 * 60_000; // ...but no less often than this, so they still catch up in the end
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
type Asset = { pts: number; act: boolean; sess: Record<string, number>; key: string };
type Body = { gd: number; feedTime: string | null; checked: string; assets: Record<string, Asset> };
// one asset's scoring lines, fetched when its points were `key`; `tries` = fetches so far for that key
type Stat = { ev: Ev[]; key: string; lag: boolean; tries: number; at: string };
type Stats = Record<string, Stat>;
type Row = { body: Body; stats: Stats | null; fetched_at: string };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`${status} from ${url}`);
    this.status = status;
  }
}
async function getJSON(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new HttpError(r.status, url);
  return await r.json();
}

// "9/17/2026 1:59:44 PM" (UTC) -> ISO
function feedTime(d: { FeedTime?: { UTCTime?: string } }): string | null {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+) (AM|PM)$/.exec(d?.FeedTime?.UTCTime ?? "");
  if (!m) return null;
  const h = (+m[4] % 12) + (m[7] === "PM" ? 12 : 0);
  return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +m[6])).toISOString();
}

// what the page gets: each asset's feed numbers with its latest scoring lines (evKey !== key: lines not caught up)
function view(body: Body, stats: Stats | null) {
  const assets = Object.fromEntries(Object.entries(body.assets).map(([id, a]) => {
    const s = stats?.[id];
    return [id, { pts: a.pts, act: a.act, sess: a.sess, key: a.key, ev: s?.ev ?? [], evKey: s?.key ?? null, lag: s?.lag ?? false }];
  }));
  return { gd: body.gd, feedTime: body.feedTime, checked: body.checked, assets };
}

// assets whose lines need fetching: points changed since the last fetch, or lines that didn't add up (backing off)
function stale(body: Body, stats: Stats | null): Record<string, string> {
  const now = Date.now();
  return Object.fromEntries(Object.entries(body.assets).filter(([id, a]) => {
    const s = stats?.[id];
    if (!s || s.key !== a.key) return true;
    return s.lag && now - Date.parse(s.at) >= Math.min(LAG_MAX_MS, LAG_MS * 2 ** (s.tries - 1));
  }).map(([id, a]) => [id, a.key]));
}

// Scoring lines for the assets in todo, one at a time. Runs after the response is sent; the stats_busy claim means
// only one runs per gameday. The database merges the results into the row rather than writing over it. If F1 refuses
// or fails (anything but a missing file), the run stops and the claim is kept, so nobody asks again for BUSY_MS.
async function refreshStats(gd: number, todo: Record<string, string>, pts: Record<string, number>, prev: Stats | null) {
  const patch: Stats = {};
  let rest = false;
  for (const [id, key] of Object.entries(todo)) {
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
      const p = prev?.[id];
      patch[id] = {
        ev,
        key,
        // lines that don't add up to the feed's total: playerstats is behind; stale() retries them later
        lag: Math.abs(ev.reduce((s, r) => s + r[3], 0) - pts[id]) > 0.5,
        tries: (p && p.key === key ? p.tries : 0) + 1,
        at: new Date().toISOString(),
      };
    } catch (e) {
      console.error(`playerstats ${id}: ${e}`); // left for a later request
      if (!(e instanceof HttpError && e.status === 404)) {
        rest = true;
        break;
      }
    }
    await sleep(PAUSE_MS);
  }
  const { error } = await db.rpc("live_stats_merge", { p_gd: gd, p_patch: patch, p_rest: rest });
  if (error) console.error(`live_stats_merge: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const gd = Number(new URL(req.url).searchParams.get("gd"));
  if (!Number.isInteger(gd) || gd < 1 || gd > 30) return json({ error: "gd must be a gameday number (1-30)" }, 400);

  const { data: row } = await db.from("live_cache").select("body, stats, fetched_at").eq("gd", gd).maybeSingle<Row>();
  if (row && Date.now() - Date.parse(row.fetched_at) < FRESH_MS) return json(view(row.body, row.stats));
  if (row) {
    // claim this refresh: only the request whose update still finds the row stale asks F1; the rest get the copy
    const { data: won } = await db.from("live_cache").update({ fetched_at: new Date().toISOString() })
      .eq("gd", gd).lt("fetched_at", ago(FRESH_MS)).select("gd");
    if (!won?.length) return json(view(row.body, row.stats));
  }

  try {
    const d = (await getJSON(`${F1}/drivers/${gd}_en.json`)).Data;
    const assets: Record<string, Asset> = {};
    for (const p of d?.Value ?? []) {
      const sess = Object.fromEntries((p.SessionWisePoints ?? []).filter((s: { points: unknown }) => s.points != null)
        .map((s: { sessiontype: string; points: unknown }) => [s.sessiontype, Number(s.points)]));
      const pts = Number(p.GamedayPoints ?? 0) || 0;
      assets[String(p.PlayerId)] = { pts, act: p.IsActive === "1", sess, key: `${pts}|${JSON.stringify(sess)}` };
    }
    const body: Body = { gd, feedTime: feedTime(d), checked: new Date().toISOString(), assets };
    await db.from("live_cache").upsert({ gd, body, fetched_at: new Date().toISOString() }); // feed columns only

    const { data: cur } = await db.from("live_cache").select("stats").eq("gd", gd).maybeSingle<{ stats: Stats | null }>();
    const stats = cur?.stats ?? null;
    const todo = stale(body, stats);
    if (Object.keys(todo).length) {
      const { data: claimed } = await db.from("live_cache").update({ stats_busy: new Date().toISOString() })
        .eq("gd", gd).or(`stats_busy.is.null,stats_busy.lt."${ago(BUSY_MS)}"`).select("gd");
      if (claimed?.length) {
        const pts = Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.pts]));
        // @ts-ignore EdgeRuntime is provided by Supabase's runtime
        EdgeRuntime.waitUntil(refreshStats(gd, todo, pts, stats));
      }
    }
    return json(view(body, stats));
  } catch (e) {
    console.error(`gd ${gd}: ${e}`); // the details stay in the function's log
    if (row) return json({ ...view(row.body, row.stats), error: "F1's feed isn't answering; showing the last copy." });
    return json({ error: "F1's feed isn't answering." }, 502);
  }
});
