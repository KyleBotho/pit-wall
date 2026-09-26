/* ---------- live scoring: the weekend in progress (or the last one), as fresh as the last build ---------- */
import { $, $$, CHIPS, DATA, NEXT, byId, code, esc, infoTip, f0, f1, sgn } from "./core.js";
import { state } from "./state.js";
import { SB_URL, needSync } from "./sync.js";
import { chip, heat, heatKey, who } from "./forecast.js";
import { leagueList, mkey, teamKey } from "./league.js";
import { SESSN } from "./filters.js";
import { lineups } from "./hindsight-view.js";
import { refreshViews } from "./main.js";
const LV_SESS = {
  "Sprint Shootout": "SQ",
  "Sprint Qualifying": "Sprint",
  Sprint: "Sprint",
  Qualifying: "Quali",
  Race: "Race",
};
const LV_CATS = [
  ["POS", "Position"],
  ["TW", "Q2/Q3"],
  ["PG", "Gained"],
  ["PL", "Lost"],
  ["OV", "Overtakes"],
  ["FL", "Fastest lap"],
  ["DOTD", "DotD"],
  ["PIT", "Pit stops"],
  ["NEG", "DNF/DQ"],
  ["OTH", "Other"],
];
const lvCat = (c) => {
  const k = c.slice(2);
  return ["FP", "FP2", "WRFP", "PIT"].includes(k)
    ? "PIT"
    : ["NC", "DQ"].includes(k)
      ? "NEG"
      : LV_CATS.some(([x]) => x === k)
        ? k
        : "OTH";
};
const lvPts = (id) => (DATA.live.assets[id] || {}).pts || 0;
const lvProj = (id) => ((DATA.projHist || {})[DATA.live.gd] || {})[id];
// the line-up that scores this weekend: the export's (after the round) or, for the round in progress, your current team
function lvTeam(team) {
  const gd = DATA.live.gd,
    r = (lineups(teamKey(team)) || {})[gd];
  if (r)
    return {
      ids: r.ids.map(String),
      boost: String(r.boost || ""),
      x3: String(r.x3 || ""),
      chip: r.chip,
      src: "from your data export",
    };
  if (team.example) return null;
  const ids = team.team.slice(),
    ds = ids.filter((id) => byId[id].kind === "D");
  const boost =
    team.boost !== "auto" && ds.includes(team.boost)
      ? team.boost
      : ds.reduce((b, id) => ((lvProj(id) ?? 0) > (lvProj(b) ?? 0) ? id : b), ds[0]);
  return {
    ids,
    boost,
    x3: "",
    chip: null,
    src: NEXT && gd === NEXT.gd ? "your current team" : "your current team (this round's line-up needs an export)",
    autoB: team.boost === "auto",
  };
}
function lvScore(t, f) {
  // f: points of one asset; Boost doubles, x3 triples, No Negative floors each scoring line
  const one = (id) =>
    t.chip === "noneg" && f === lvPts
      ? (DATA.live.assets[id]?.ev || []).reduce((s, r) => s + Math.max(0, r[1]), 0)
      : f(id);
  return t.ids.reduce((s, id) => s + one(id) * (id === t.x3 ? 3 : id === t.boost ? 2 : 1), 0);
}
export function renderLive() {
  const live = DATA.live;
  $("#lvTeams").hidden = !live;
  $("#lvTable").closest("section").hidden = !live;
  if (!live) {
    $("#lvTitle").textContent = "Live Scoring";
    $("#lvNote").textContent = "No race weekend has started yet.";
    return;
  }
  const g = DATA.schedule.find((x) => x.gd === live.gd) || {},
    now = Date.now(),
    sess = g.sessions || [];
  const scored = (s) => DATA.assets.some((a) => (live.assets[a.id]?.sess || {})[s.type] != null);
  const sessState = (s) =>
    scored(s) && Date.parse(s.end || s.start) < now
      ? "done"
      : Date.parse(s.start) <= now && now <= Date.parse(s.end || s.start) + 3 * 36e5
        ? "live"
        : "up";
  const over = sess.length && sess.every((s) => sessState(s) === "done");
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  $("#lvTitle").textContent = `R${live.gd} · ${g.name || ""}`;
  $("#lvStamp").textContent = over ? "final" : "live";
  $("#lvSess").innerHTML = sess
    .map((s) => {
      const st = sessState(s);
      return `<span class="tag ${st}">${esc(LV_SESS[s.type] || s.type)} ${st === "done" ? "✓" : st === "live" ? "· scoring" : "· " + esc(when(s.start))}</span>`;
    })
    .join("");
  const tm = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const asOf = live.feedTime ? tm(live.feedTime) : "—";
  $("#lvNote").innerHTML =
    (live.src === "fn"
      ? `Live feed · F1's scores as of <b>${esc(asOf)}</b>, checked ${esc(new Date(liveFeed.at).toLocaleTimeString())} (every minute while this view is open). `
      : `Scores as of <b>${esc(asOf)}</b> (F1's feed at the last site build). ${esc(liveFeed.err)} `) +
    (over
      ? "The weekend is over; these are its final points until the next one starts."
      : "Points appear after each session is scored.") +
    (Object.values(live.assets).some((a) => a.lag) ? " Some scoring lines are still catching up with the totals." : "");

  // your teams (with only example teams: one card that says how to load yours)
  if (state.teams.every((team) => !lvTeam(team))) {
    $("#lvTeams").innerHTML =
      `<section class="panel" style="grid-column:1/-1"><h3>Your teams</h3><p class="note">Sign in and link your F1 Fantasy account to follow your teams live here.</p>` +
      `<div class="chipbar"><button class="btn sm" data-signin="1" data-needsync="1">Sign in with Google</button><button class="btn sm" data-setup="join" data-needlink="1" hidden>Link your F1 Fantasy account</button></div></section>`;
    needSync();
  } else
    $("#lvTeams").innerHTML = state.teams
      .map((team, i) => {
        const t = lvTeam(team);
        if (!t)
          return `<section class="panel"><h3>${esc(team.name)}</h3><p class="note">Example team. Link your F1 Fantasy account to follow your teams live.</p></section>`;
        const live = lvScore(t, lvPts),
          proj = lvScore(t, (id) => lvProj(id) ?? 0),
          hasProj = t.ids.some((id) => lvProj(id) != null);
        const chipName = t.chip ? (CHIPS.find(([k]) => k === t.chip) || [])[2] : "";
        return `<section class="panel"><h3>${esc(team.name)} <small>T${i + 1} · ${esc(t.src)}</small></h3>
      <div class="lvbig"><b>${f0(live)}</b><span class="muted">pts${hasProj ? ` · projected ${f0(proj)} at lock` : ""}${chipName ? ` · ${esc(chipName)}` : ""}</span></div>
      <div class="chips">${t.ids.map((id) => chip(id, { a: f0(lvPts(id)), b: lvProj(id) != null ? `<span class="dim">x${f0(lvProj(id))}</span>` : "", x: id === t.x3 ? "3×" : id === t.boost ? (t.autoB ? "2×?" : "2×") : "" })).join("")}</div>
      ${t.autoB ? '<p class="note">Boost is set to auto, so 2×? marks the driver we projected highest. Set your real Boost in the Calculator.</p>' : ""}</section>`;
      })
      .join("");

  renderLiveLeague(g, over);

  // assets table
  const kind = state.lvKind || "D",
    by = state.lvBy || "sess";
  $$("#lvKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.livekind === kind)));
  $$("#lvBy button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lvby === by)));
  const cats = (id) => {
    const o = {};
    for (const [ni, v] of live.assets[id]?.ev || []) {
      const c = lvCat(DATA.evNames[ni].c);
      o[c] = (o[c] || 0) + v;
    }
    return o;
  };
  // racing that weekend (a driver who changed team mid-season has two assets; only one is active per round)
  const assets = DATA.assets.filter(
    (a) => a.kind === kind && live.assets[a.id] && ((live.assets[a.id].act ?? a.active) || lvPts(a.id)),
  );
  const cols =
    by === "sess"
      ? sess.map((s) => [s.type, LV_SESS[s.type] || s.type, (id) => (live.assets[id]?.sess || {})[s.type] ?? null])
      : LV_CATS.filter(([c]) => assets.some((a) => cats(a.id)[c])).map(([c, n]) => [c, n, (id) => cats(id)[c] ?? null]);
  const teamsOf = (id) =>
    state.teams
      .map((team, i) => {
        const t = lvTeam(team);
        return t && t.ids.includes(id) ? `T${i + 1}` : "";
      })
      .filter(Boolean);
  const rows = assets
    .map((a) => ({ a, pts: lvPts(a.id), px: lvProj(a.id) }))
    .sort((x, y) => y.pts - x.pts || (y.px ?? -99) - (x.px ?? -99));
  const lo = Math.min(0, ...rows.map((r) => r.pts)),
    hi = Math.max(0, ...rows.map((r) => r.pts));
  $("#lvTable").innerHTML =
    `<thead><tr><th>${kind === "D" ? "DR" : "CR"}</th><th>Yours</th>${cols.map(([, n]) => `<th>${esc(n)}</th>`).join("")}<th>Total</th><th title="Our projection at lock">xPts</th>${over ? '<th title="Total minus projection">Δ</th>' : '<th title="Points still needed to reach the projection">To go</th>'}</tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td>${who(r.a)}</td><td class="muted">${teamsOf(r.a.id).join(" ")}</td>` +
          cols
            .map(([, , f]) => {
              const v = f(r.a.id);
              return `<td class="${v < 0 ? "bad" : ""}">${v == null ? '<span class="dim">—</span>' : f0(v)}</td>`;
            })
            .join("") +
          `<td${heat(r.pts, lo, hi)} data-lvcell="${r.a.id}"><b>${f0(r.pts)}</b></td><td class="muted">${r.px == null ? "—" : f1(r.px)}</td>` +
          (r.px == null
            ? "<td>—</td>"
            : over
              ? `<td class="${r.pts - r.px >= 0 ? "good" : "bad"}">${sgn(r.pts - r.px, 0)}</td>`
              : `<td class="${r.pts >= r.px ? "good" : "muted"}">${r.pts >= r.px ? "✓" : f0(r.px - r.pts)}</td>`) +
          "</tr>",
      )
      .join("") +
    "</tbody>";
  $("#lvKey").innerHTML = heatKey("fewer points", "more points");
  $("#lvTNote").textContent =
    "Click a total for its scoring lines. xPts is our projection for the whole weekend, frozen at lock; " +
    (over ? "Δ is the final total minus it." : "To go is what's still needed to reach it (✓ = already there).");
}
// Live feed: the Supabase function "live" reads F1's feeds for the page (they have no CORS), cached for a minute
// there, so F1 sees one request a minute however many pages are open. Falls back to the build's DATA.live.
const LIVE_FN = SB_URL + "/functions/v1/smooth-action"; // the "live" function; its URL slug is the name it was first deployed under
const liveFeed = { at: null, err: "", busy: false };
const liveGd = () =>
  Math.max(0, ...DATA.schedule.filter((g) => Date.parse(g.lock) <= Date.now()).map((g) => g.gd)) || null;
function evIdx(s, n, c) {
  let i = DATA.evNames.findIndex((e) => e.s === s && e.n.trim() === n);
  if (i < 0) {
    DATA.evNames.push({ s, n, c });
    i = DATA.evNames.length - 1;
  }
  return i;
}
export async function pullLive() {
  const gd = liveGd();
  if (!gd || liveFeed.busy) return;
  liveFeed.busy = true;
  try {
    const r = await fetch(`${LIVE_FN}?gd=${gd}`),
      b = await r.json();
    if (!r.ok || !b.assets) throw new Error(b.error || "HTTP " + r.status);
    const old = DATA.live && DATA.live.gd === gd ? DATA.live.assets : {};
    DATA.live = {
      gd,
      feedTime: b.feedTime,
      src: "fn",
      assets: Object.fromEntries(
        Object.entries(b.assets).map(([id, a]) => {
          let ev = (a.ev || []).map(([s, n, c, v, f]) => [evIdx(s, n, c), v, f]),
            pending = a.evKey !== a.key;
          const o = old[id];
          if (pending && o && o.pts === a.pts && o.ev && o.ev.length) {
            ev = o.ev;
            pending = false;
          } // lines still loading there: keep ours
          return [id, { pts: a.pts, act: a.act, sess: a.sess || {}, ev, lag: !!a.lag || pending }];
        }),
      ),
    };
    liveFeed.err = "";
    liveFeed.at = Date.now();
  } catch (e) {
    liveFeed.err = "The live feed isn't answering right now.";
  }
  liveFeed.busy = false;
  refreshViews(["live"]);
}
// A league's standings with this weekend added: season points before the round + the round's points so far.
// Your teams score as in the cards above; rivals from their line-up in the league feed. A rival's Boost is known
// only from an import that covers this round; otherwise it's assumed on their highest-projected driver (2×?).
// The league feed carries a round from its first scored session on (seen at Baku: qualifying points on Friday), so
// "before" is always the feed's season total minus the round so far. The feed's round points replace the live score
// only once the weekend is over and the league data is from after the race; mid-weekend they lag the live feed.
function renderLiveLeague(g, over) {
  const live = DATA.live,
    gd = live.gd,
    all = leagueList().filter((l) => (l.members || []).length),
    box = $("#lvLeague");
  box.hidden = !all.length;
  if (!all.length) return;
  const lg = all[Math.min(state.lvLg | 0, all.length - 1)];
  $("#lvLgTitle").textContent = lg.name;
  $("#lvLgPick").hidden = all.length < 2;
  $("#lvLgPick").innerHTML = all
    .map((l, i) => `<button data-lvlg="${i}" aria-pressed="${l === lg}">${esc(l.name)}</button>`)
    .join("");
  const boostKnown = state.league && state.league.round >= gd; // an import taken after this round's lock
  const race = g.sessions.find((s) => s.type === "Race"),
    final = over && Date.parse(lg.collected || "") >= Date.parse((race && (race.end || race.start)) || g.raceStart);
  const rows = lg.members.map((m) => {
    const ti = state.teams.findIndex((t) => teamKey(t) === mkey(m)),
      sofar = (m.hist || []).find((h) => h.gd === gd),
      off = final ? sofar : null;
    let t = ti >= 0 ? lvTeam(state.teams[ti]) : null,
      guess = false;
    if (!t && m.ids) {
      const ids = m.ids.map(String),
        ds = ids.filter((id) => byId[id] && byId[id].kind === "D");
      const b = boostKnown && ds.includes(String(m.boost)) ? String(m.boost) : null;
      guess = !b;
      t = {
        ids,
        boost: b || ds.reduce((x, id) => ((lvProj(id) ?? 0) > (lvProj(x) ?? 0) ? id : x), ds[0]),
        x3: "",
        chip: null,
      };
    }
    const live = off ? off.pts : t ? lvScore(t, lvPts) : sofar ? sofar.pts : null;
    const before = (+m.pts || 0) - (sofar ? sofar.pts : 0); // the feed's season total includes the round so far
    return { m, ti, t, guess, live, before, total: before + (live || 0), official: !!off };
  });
  const rankBy = (k) => {
    const s = rows.slice().sort((a, b) => b[k] - a[k]);
    return (r) => s.indexOf(r) + 1;
  };
  const rBefore = rankBy("before"),
    rNow = rankBy("total");
  rows.sort((a, b) => b.total - a.total);
  const boostOf = (r) => (r.t && byId[r.t.boost] ? code(byId[r.t.boost]) + (r.guess ? "?" : "") : "");
  $("#lvLgTable").innerHTML =
    `<thead><tr><th>#</th><th>Team</th><th title="This round so far">R${gd}</th><th>Boost</th><th title="Season total before this round">Before</th><th>Total</th><th title="Places gained or lost this round">±</th></tr></thead><tbody>` +
    rows
      .map((r) => {
        const d = rBefore(r) - rNow(r);
        return (
          `<tr${r.ti >= 0 ? ' style="background:var(--accent-soft)"' : ""}><td>${rNow(r)}</td><td style="text-align:left;position:static"><b>${esc(r.m.name)}</b>${r.ti >= 0 ? ` <span class="tag sprint">T${r.ti + 1}</span>` : ""}</td>` +
          `<td>${r.live == null ? '<span class="dim">no line-up</span>' : `<b>${f0(r.live)}</b>${r.official ? ' <span class="dim" title="Official round score">✓</span>' : ""}`}</td>` +
          `<td class="muted">${r.official ? "" : esc(boostOf(r))}</td><td class="muted">${f0(r.before)}</td><td><b>${f0(r.total)}</b></td>` +
          `<td class="${d > 0 ? "good" : d < 0 ? "bad" : "muted"}">${d > 0 ? "▲" + d : d < 0 ? "▼" + -d : "–"}</td></tr>`
        );
      })
      .join("") +
    "</tbody>";
  const when = lg.collected ? new Date(lg.collected) : null,
    beforeLock = when && !isNaN(when) && when < new Date(g.lock);
  $("#lvLgNote").innerHTML =
    `Rivals' line-ups from the league feed${when && !isNaN(when) ? ` as of ${esc(when.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }))}` : ""}.` +
    (beforeLock && !over
      ? " <b>That's before this round's lock</b>, so rivals' transfers for this round aren't in yet."
      : "") +
    " " +
    infoTip(
      (rows.some((r) => r.guess && !r.official)
        ? "A Boost with ? is a guess (their highest-projected driver): the league feed doesn't say, only an import after the lock does. "
        : "") + "Transfer penalties and chips are only counted once the round's official points arrive (✓).",
    );
}
export function lvCell(id) {
  const a = byId[id],
    x = DATA.live.assets[id];
  if (!x) return;
  const groups = {};
  for (const [ni, v, f] of x.ev || []) {
    const e = DATA.evNames[ni];
    (groups[e.s] = groups[e.s] || []).push({ n: e.n, f, v });
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">${esc(code(a))} · R${DATA.live.gd} scoring</h3>` +
    (Object.keys(groups).length
      ? ["Q", "S", "R"]
          .filter((ss) => groups[ss])
          .map(
            (ss) =>
              `<div class="mline" style="margin-top:8px"><b>${SESSN[ss]}</b><b>${groups[ss].reduce((p, q) => p + q.v, 0)}</b></div>` +
              groups[ss]
                .map(
                  (q) =>
                    `<div class="mline"><span class="muted">${esc(cap(q.n.trim()))}${q.f && q.f !== "-" ? ` (${esc(q.f)})` : ""}</span><span class="${q.v < 0 ? "bad" : ""}">${q.v}</span></div>`,
                )
                .join(""),
          )
          .join("")
      : '<p class="note">No scoring lines yet.</p>') +
    `<div class="mline" style="margin-top:8px"><b>Total</b><b>${f0(x.pts)}</b></div>`;
  $("#modal").hidden = false;
}
