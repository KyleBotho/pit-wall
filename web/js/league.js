/* ---------- league ---------- */
import {
  $,
  $$,
  CHIPS,
  DATA,
  Hind,
  NEXT,
  SEASON_OVER,
  byId,
  chipName,
  chipShort,
  code,
  esc,
  f0,
  f1,
  isDriver,
  money,
  pct,
  sgn,
} from "./core.js";
import { activeTeam, state } from "./state.js";
import { SEALED } from "./sync.js";
import { boostFor, chip, heat, teamSamples, who, xpts } from "./forecast.js";
import { lineups } from "./hindsight-view.js";
// Each team's season as far as the data goes (Hind.track): per-round records from exports (sealed or imported)
// first, else the line-up seen after each race plus the official round points, from which Boost, chips, budget,
// bank and free transfers are worked out. Cached until the sealed data or an import changes.
let TRACK = { ver: null, by: {} };
// A team is known by its key: F1's account id + team number, hashed (tk: from the private repo, or worked out on
// import). Names only label teams, so a rename or two managers with the same team name never mixes up whose season
// is whose. Data from before team keys (an older sealed file, import or save) has none: its name stands in.
export const teamKey = (t) => (t && (t.tk || t.name)) || "";
export const mkey = (m) => m.key || m.name; // a member of leagueList() or of an imported league
export const teamLabel = (k) => (SEALED && SEALED.names && SEALED.names[k]) || k;
export function tracked(key) {
  const ver = [SEALED, state.league && state.league.collected, DATA.done.length];
  if (!TRACK.ver || TRACK.ver.some((k, i) => k !== ver[i])) TRACK = { ver, by: {} };
  if (!(key in TRACK.by)) {
    const im = state.league && state.league.members.find((m) => mkey(m) === key);
    const known = {
      ...(im && im.rounds),
      ...((SEALED && SEALED.rivals && SEALED.rivals[key]) || {}),
      ...((SEALED && SEALED.lineups && SEALED.lineups[key]) || {}),
    };
    const seen = (SEALED && SEALED.seen && SEALED.seen[key]) || {};
    const official = Object.fromEntries(teamHist(key).map((h) => [h.gd, h.pts]));
    TRACK.by[key] = Object.keys(known).length || Object.keys(seen).length ? Hind.track(known, seen, official) : null;
  }
  return TRACK.by[key];
}
export const usedChips = (tr) => Object.fromEntries(Object.keys((tr && tr.used) || {}).map((k) => [k, true]));
// Leagues: auto-updated (decrypted) standings merged with anything imported (chips, bank, round history)
export function leagueList() {
  const out = [];
  for (const L of (SEALED && SEALED.leagues) || []) {
    const imp = state.league && state.league.name === L.name ? state.league : null;
    const members = L.members
      .map((m) => {
        const key = m.tk || m.team;
        const im = imp && imp.members.find((x) => mkey(x) === key);
        const ds = m.ids.filter((id) => byId[id]?.kind === "D"),
          cs = m.ids.filter((id) => byId[id]?.kind === "C");
        const tr = tracked(key),
          nx = tr && tr.next;
        return {
          key,
          name: m.team,
          pts: +m.pts || 0,
          // after a Limitless round the feed still shows that team; the team held reverts to the one before
          ids:
            nx && nx.asOf === DATA.done[DATA.done.length - 1] && nx.ids.every((id) => byId[id])
              ? nx.ids.filter(isDriver).concat(nx.ids.filter((id) => !isDriver(id)))
              : ds.length === 5 && cs.length === 2
                ? ds.concat(cs)
                : im
                  ? im.ids
                  : null,
          boost: im ? im.boost : "",
          // an import taken before the next race is newer than tracking, which only reaches the last finished round
          bank: im && im.bank != null && state.league.round > (nx ? nx.asOf + 1 : 0) ? im.bank : nx ? nx.bank : null,
          free: nx ? nx.free : null,
          chips: { ...(im ? im.chips : {}), ...usedChips(tr) },
          tracked: !!tr,
          hist: teamHist(key),
          mine: state.teams.some((t) => teamKey(t) === key),
        };
      })
      .sort((a, b) => b.pts - a.pts);
    out.push({ name: L.name, pending: L.pending, collected: L.feedTime || null, members, auto: true });
  }
  if (state.league && !out.some((l) => l.name === state.league.name)) out.push(state.league);
  return out;
}
export function renderLeague() {
  $("#lgUnlock").hidden = !(DATA.leagueSealed && !SEALED);
  const all = leagueList(),
    L = all[Math.min(state.lgIdx | 0, all.length - 1)];
  $("#leagueEmpty").hidden = !!L || !!DATA.leagueSealed;
  $("#leagueDash").hidden = !L;
  if (!L) return;
  $("#lgPick").hidden = all.length < 2;
  $("#lgPick").innerHTML = all
    .map((l, i) => `<button data-lg="${i}" aria-pressed="${l === L}">${esc(l.name)}</button>`)
    .join("");
  const myIds = activeTeam().team,
    myKey = teamKey(activeTeam());
  $("#lgTitle").textContent = L.name;
  if (L.pending || !L.members.length) {
    $("#lgStamp").textContent = "standings not published yet";
    $("#lgTable").innerHTML =
      `<tbody><tr><td class="muted" style="position:static">F1 Fantasy hasn't published this league's standings file yet. New leagues usually appear after the next race's leaderboard update; the site picks it up automatically.</td></tr></tbody>`;
    $("#lgChart").innerHTML = "";
    $("#lgH2h").innerHTML = "";
    $("#lgOwn").innerHTML = "";
    return;
  }
  const when = L.collected ? new Date(L.collected) : null;
  $("#lgStamp").textContent =
    `${L.members.length} teams${L.auto ? " · auto-updated" : ""}${when && !isNaN(when) ? " · data from " + when.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}`;
  const lead = L.members[0].pts;
  const tok = (c) =>
    CHIPS.map(
      ([k, sh, n]) => `<span class="chiptok ${c[k] ? "used" : ""}" title="${n}${c[k] ? " (used)" : ""}">${sh}</span>`,
    ).join("");
  $("#lgTable").innerHTML =
    `<thead><tr><th>#</th><th style="text-align:left">Team</th><th>Pts</th><th>Gap</th><th title="Points in the latest round">Last</th><th style="text-align:left">Chips left</th><th title="Cost cap left for the next race">Bank</th><th title="Free transfers for the next race">Free</th></tr></thead><tbody>` +
    L.members
      .map((m, i) => {
        const last = m.hist.length ? m.hist[m.hist.length - 1].pts : null;
        return `<tr${mkey(m) === myKey ? ' style="background:var(--accent-soft)"' : ""}><td>${i + 1}</td><td style="text-align:left;position:static"><b>${esc(m.name)}</b>${m.mine ? ' <span class="tag sprint">you</span>' : ""}</td>
        <td><b>${m.pts.toLocaleString()}</b></td><td class="${i ? "bad" : "muted"}">${i ? "−" + (lead - m.pts).toLocaleString() : "—"}</td><td>${f0(last)}</td><td style="text-align:left">${m.tracked || Object.keys(m.chips || {}).length ? tok(m.chips) : '<span class="dim">no round data yet</span>'}</td><td class="muted">${m.bank == null ? "—" : money(m.bank)}</td><td class="muted">${m.free == null ? "—" : m.free}</td></tr>`;
      })
      .join("") +
    "</tbody>";
  renderLeagueChart(L);
  renderLeagueRounds(L);
  if (SEASON_OVER) {
    $("#lgH2hNote").textContent = "";
    $("#lgH2h").innerHTML = '<p class="note">The season is over: no race left to compare line-ups for.</p>';
    $("#lgOwn").innerHTML = "";
    return;
  }
  renderLeagueForecast(L, myIds, myKey);
}
// Round by round: every member's team for a finished round, like F1's own league view: line-up and each asset's
// points (Boost 2×, x3 3×), chip, bank, transfers. From an export where there is one, else worked out from the line-up
// seen after the race and the official points.
function renderLeagueRounds(L) {
  const rows = L.members.map((m) => ({ m, tr: tracked(mkey(m)) })).filter((x) => x.tr && x.tr.rounds.length);
  $("#lgRoundsBox").hidden = !rows.length;
  if (!rows.length) return;
  const gds = [...new Set(rows.flatMap((x) => x.tr.rounds.map((r) => r.gd)))].sort((a, b) => a - b);
  const gd = gds.includes(state.lgRound) ? state.lgRound : gds[gds.length - 1];
  $("#lgRoundPick").innerHTML = gds
    .map((g) => `<option value="${g}" ${g === gd ? "selected" : ""}>R${g} ${esc(raceName(g))}</option>`)
    .join("");
  const cards = rows
    .map(({ m, tr }) => ({ m, r: tr.rounds.find((x) => x.gd === gd) }))
    .filter((x) => x.r)
    .sort((a, b) => (b.r.pts ?? -1e9) - (a.r.pts ?? -1e9));
  $("#lgRounds").innerHTML = cards.map(({ m, r }) => roundCard(m, r)).join("");
}
const raceName = (gd) => ((DATA.schedule.find((x) => x.gd === gd) || {}).name || "").replace(" Grand Prix", "");
function roundCard(m, r) {
  const boost = String(r.boost ?? ""),
    ffIn = r.ff ? String(r.ff.in) : null,
    ffOut = r.ff ? String(r.ff.out) : null;
  const mult = (id) =>
    r.chip === "x3" && String(r.x3) === id ? 3 : boost === id || (id === ffOut && boost === ffIn) ? 2 : 1;
  const tile = (id) => {
    if (!byId[id]) return "";
    // a Final Fix slot scores the outgoing driver before the swap and the incoming one after it
    const p =
      id === ffOut
        ? (Hind.sess(id, r.gd, r.ff.cat, "pre") + Hind.sess(ffIn, r.gd, r.ff.cat, "post")) * mult(id)
        : Hind.pts(id, r.gd, r.chip || "") * mult(id);
    const h = Hind.at(id, r.gd);
    return chip(id, {
      a: f0(p),
      b: id === ffOut ? "FF→" + esc(code(byId[ffIn])) : h && !h.active ? "out" : "",
      x: mult(id) > 1 ? mult(id) + "×" : "",
    });
  };
  const ids = r.ids.map(String),
    drs = ids.filter(isDriver).sort((a, b) => mult(b) - mult(a)),
    cons = ids.filter((id) => !isDriver(id));
  const pen =
    r.chip === "wildcard" || r.chip === "limitless" || r.subs == null || r.free == null
      ? 0
      : 10 * Math.max(0, r.subs - r.free);
  const moves =
    r.subs != null && r.gd !== DATA.schedule[0].gd && r.chip !== "limitless"
      ? `${r.subs} transfer${r.subs === 1 ? "" : "s"}${r.free != null ? ` of ${r.free} free` : ""}${pen ? ` (−${pen})` : ""}`
      : null;
  // assets no longer in the game cost −25 each (−35 on a sprint weekend)
  const out = ids.filter((id) => Hind.at(id, r.gd) && !Hind.at(id, r.gd).active).length,
    sprint = (DATA.schedule.find((x) => x.gd === r.gd) || {}).sprint;
  const facts = [
    r.bank != null ? `bank ${money(r.bank)}` : null,
    moves,
    out ? `<span class="bad">${out} inactive (−${out * (sprint ? 35 : 25)})</span>` : null,
  ].filter(Boolean);
  const src =
    r.src === "export"
      ? '<span class="dim" title="From an F1 Fantasy data export">export</span>'
      : r.unexplained
        ? '<span class="bad" title="No Boost and chip rebuild the official score: a Final Fix we could not place, or a line-up changed after the race">not worked out</span>'
        : `<span class="dim" title="Worked out from the line-up after the race and the official points${r.sure ? "" : ". More than one Boost or chip fits; the points are the same either way"}">worked out${r.sure ? "" : "?"}</span>`;
  return `<div class="rcard${m.mine ? " mine" : ""}"><div class="rch"><b>${esc(m.name)}</b>${r.chip ? `<span class="chiptok used" title="${esc(chipName(r.chip))}">${chipShort(r.chip)}</span>` : ""}<span class="rcp">${f0(r.pts)} <small>pts</small></span></div>
    <div class="chips">${cons.map(tile).join("")}<span class="sep"></span>${drs.map(tile).join("")}</div>
    <div class="note">${facts.join(" · ")}${facts.length ? " · " : ""}${src}</div></div>`;
}
// Next race: head-to-head against each rival's current line-up, and league ownership
function renderLeagueForecast(L, myIds, myKey) {
  // head-to-head: same simulated weekends for everyone, so the comparison is paired
  const mySmp = teamSamples(myIds, boostFor(myIds), ""),
    N = mySmp.length;
  const myMean = mySmp.reduce((a, b) => a + b, 0) / N;
  $("#lgH2hNote").textContent = `${activeTeam().name} vs current rival line-ups`;
  const rivals = L.members.filter((m) => mkey(m) !== myKey && m.ids);
  $("#lgH2h").innerHTML =
    rivals
      .map((m) => {
        const ds = m.ids.slice(0, 5),
          boost = ds.includes(m.boost) ? m.boost : boostFor(m.ids, 0, { boost: "auto" });
        const smp = teamSamples(m.ids, boost, "");
        let win = 0,
          gap = 0;
        for (let s = 0; s < N; s++) {
          if (mySmp[s] > smp[s]) win++;
          gap += mySmp[s] - smp[s];
        }
        const drs = ds.slice().sort((x, y) => (x === boost ? -1 : y === boost ? 1 : xpts(y, 1) - xpts(x, 1)));
        const chipsHtml =
          m.ids
            .slice(5)
            .map((id) => chip(id, { pts: xpts(id, 1), cls: myIds.includes(id) ? "" : "in" }))
            .join("") +
          '<span class="sep"></span>' +
          drs
            .map((id) =>
              chip(id, {
                pts: xpts(id, 1) * (id === boost ? 2 : 1),
                x: id === boost ? "2×" : "",
                cls: myIds.includes(id) ? "" : "in",
              }),
            )
            .join("");
        const p = win / N;
        return `<div class="bt"><span class="rk"></span><div style="display:flex;flex-direction:column;gap:8px;min-width:0"><b>${esc(m.name)}</b><div class="chips">${chipsHtml}</div></div>
      <div class="num"><b class="${p >= 0.5 ? "good" : "bad"}">${pct(p)}</b><span class="muted">you win</span><span class="${gap >= 0 ? "good" : "bad"}">${sgn(gap / N)} pts</span></div></div>`;
      })
      .join("") +
    `<p class="note">Green dot = an asset you don't have. Uses rivals' current line-ups; they can still transfer before lock. Your team: ${f1(myMean)} xPts.</p>`;

  // league ownership
  const own = {};
  for (const m of rivals) for (const id of m.ids) own[id] = (own[id] || 0) + 1;
  const ids = Array.from(new Set(Object.keys(own).concat(myIds)));
  const nr = Math.max(1, rivals.length);
  const rows = ids
    .map((id) => ({ id, n: own[id] || 0, mine: myIds.includes(id), x: xpts(id, 1) }))
    .filter((r) => (r.mine && r.n < rivals.length) || (!r.mine && r.n > 0))
    .sort((a, b) => a.mine - b.mine || b.n * b.x - a.n * a.x);
  $("#lgOwn").innerHTML =
    `<thead><tr><th>Asset</th><th style="text-align:left">Type</th><th title="How many rivals own it">Rivals</th><th>xPts R${NEXT.gd}</th><th title="Expected swing against the field: positive helps you">Swing</th></tr></thead><tbody>` +
    (rows.length
      ? rows
          .map((r) => {
            const a = byId[r.id];
            const sw = r.mine ? r.x * (1 - r.n / nr) : -r.x * (r.n / nr);
            return `<tr><td>${who(a)}</td>
        <td style="text-align:left">${r.mine ? '<span class="good">Only you</span>' : '<span class="bad">Threat</span>'}</td><td>${r.n}/${rivals.length}</td><td>${f1(r.x)}</td><td${heat(sw, -30, 30)} class="${sw >= 0 ? "good" : "bad"}">${sgn(sw)}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="muted">Your line-up matches the whole league.</td></tr>`) +
    "</tbody>";
}
// Round points for a team: the private repo's round table (after unlocking) first, else an imported league.
export function teamHist(key) {
  const rs = ((SEALED && SEALED.rounds) || [])
    .filter((r) => r.pts[key] != null)
    .map((r) => ({ gd: r.gd, pts: r.pts[key] }));
  if (rs.length) return rs;
  const im = state.league && state.league.members.find((m) => mkey(m) === key);
  return im ? im.hist : [];
}
export const cumPts = (hist, gds) => {
  let c = 0;
  const by = Object.fromEntries(hist.map((h) => [h.gd, h.pts]));
  return gds.map((gd) => ({ v: (c += by[gd] || 0), r: by[gd] ?? null }));
};
// chip badges for a team's line: your teams from the saved line-ups, rivals from an import
export function chipMarks(key, gds) {
  const L = lineups(key),
    im = state.league && state.league.members.find((m) => mkey(m) === key),
    short = (k) => (CHIPS.find(([c]) => c === k) || [])[1];
  const at = {};
  if (L) for (const [g, r] of Object.entries(L)) if (r.chip) at[+g] = short(r.chip);
  if (im && im.chipGd) for (const [k, g] of Object.entries(im.chipGd)) if (!at[g]) at[g] = short(k);
  return gds.map((g) => at[g] || null);
}
function renderLeagueChart(L) {
  const mode = state.lgMode || "total",
    withH = L.members.filter((m) => m.hist.length);
  const gds = [...new Set(withH.flatMap((m) => m.hist.map((h) => h.gd)))].sort((a, b) => a - b);
  const cum = new Map(withH.map((m) => [mkey(m), cumPts(m.hist, gds)]));
  const myKey = teamKey(activeTeam());
  const ref = cum.has(state.lgRef) ? state.lgRef : cum.has(myKey) ? myKey : withH[0] && mkey(withH[0]);
  const refName = (withH.find((m) => mkey(m) === ref) || {}).name;
  $$("#lgMode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lgm === mode)));
  $("#lgRefBox").hidden = mode !== "rel";
  $("#lgRef").innerHTML = withH
    .map((m) => `<option value="${esc(mkey(m))}" ${mkey(m) === ref ? "selected" : ""}>${esc(m.name)}</option>`)
    .join("");
  $("#lgChips").checked = !!state.lgChips;
  // league rank after each round, from the running totals
  const rankAt = (i, key) =>
    1 + withH.filter((m) => mkey(m) !== key && cum.get(mkey(m))[i].v > cum.get(key)[i].v).length;
  const series = withH.map((m) => {
    const c = cum.get(mkey(m));
    const pts =
      mode === "rel"
        ? c.map((p, i) => ({ v: p.v - cum.get(ref)[i].v, r: p.r }))
        : mode === "race"
          ? c.map((p) => ({ v: p.r, r: null }))
          : mode === "rank"
            ? c.map((p, i) => ({ v: rankAt(i, mkey(m)), r: p.r }))
            : c;
    return {
      name: m.name,
      me: mkey(m) === myKey,
      pts,
      marks: state.lgChips ? chipMarks(mkey(m), gds) : null,
    };
  });
  const opts =
    mode === "rank"
      ? { invert: true, fmt: (v) => "#" + v }
      : mode === "rel"
        ? { fmt: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString() }
        : {};
  lineChart(
    $("#lgChart"),
    gds,
    series,
    {
      total: "Cumulative league points by round",
      rel: `Points relative to ${refName}`,
      race: "Points scored each round",
      rank: "League position after each round",
    }[mode],
    opts,
  );
}
// Cumulative line chart on a gameday axis. series: [{name, me, color, dash, pts: [{v, r}] aligned with gds}]; v null = no data.
export function lineChart(box, gds, series, label, opt = {}) {
  series = series.filter((s) => s.pts.some((p) => p.v != null));
  if (!series.length || !gds.length) {
    box.innerHTML = '<p class="note">No round history yet.</p>';
    return;
  }
  // drawn at the box's real width so text and lines keep their size (a 640-unit drawing stretched to a wide card
  // doubled them); redrawn when the box is resized, e.g. when a hidden view is first shown
  box._chart = [gds, series, label, opt];
  if (!box._ro) {
    let last = box.clientWidth;
    box._ro = new ResizeObserver(() => {
      const wNow = box.clientWidth;
      if (!wNow || Math.abs(wNow - last) < 8) return;
      last = wNow;
      lineChart(box, ...box._chart);
    });
    box._ro.observe(box);
  }
  const W = Math.max(320, Math.round(box.clientWidth || 640)),
    H = Math.round(Math.min(340, Math.max(240, W * 0.4))),
    ml = 52,
    mr = 128,
    mt = 12,
    mb = 28;
  const vs = series.flatMap((s) => s.pts.map((p) => p.v).filter((v) => v != null));
  const inv = !!opt.invert,
    fmt = opt.fmt || ((v) => (v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString());
  const maxV = inv ? Math.max(...vs) : Math.max(0, ...vs),
    minV = inv ? Math.min(1, ...vs) : Math.min(0, ...vs),
    span = Math.max(1, maxV - minV);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find((st) => span / st <= 7) || 5000;
  const top = Math.max(step, Math.ceil(maxV / step) * step),
    lo = inv ? Math.max(1, Math.floor(minV / step) * step) : Math.floor(minV / step) * step;
  const x = (i) => ml + (i / Math.max(1, gds.length - 1)) * (W - ml - mr);
  const y = (v) => {
    const t = (v - lo) / Math.max(1e-9, top - lo);
    return mt + (inv ? t : 1 - t) * (H - mt - mb);
  }; // rank: 1 at the top
  const col = (s) => (s.me ? "#A855F7" : s.color || "#71717A");
  const lastI = (s) => s.pts.reduce((k, p, i) => (p.v != null ? i : k), -1);
  let g = "";
  for (let v = lo; v <= top; v += step)
    g += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 && lo < 0 ? "#52525B" : "#27272A"}" stroke-width="1"/><text x="${ml - 10}" y="${y(v) + 4}" fill="#A1A1AA" font-size="12" text-anchor="end">${esc(fmt(v))}</text>`;
  const every = Math.ceil(gds.length / 12);
  gds.forEach((gd, i) => {
    if (i % every === 0 || i === gds.length - 1)
      g += `<text x="${x(i)}" y="${H - 8}" fill="#A1A1AA" font-size="12" text-anchor="middle">R${gd}</text>`;
  });
  const labels = series.map((s) => ({ s, y: y(s.pts[lastI(s)].v) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13; // keep end labels apart
  for (const s of series.slice().sort((a, b) => a.me - b.me)) {
    // draw the active team last, on top
    let d = "",
      pen = false;
    s.pts.forEach((p, i) => {
      if (p.v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    });
    g += `<path d="${d}" fill="none" stroke="${col(s)}" stroke-width="2"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    const li = lastI(s);
    g += `<circle cx="${x(li)}" cy="${y(s.pts[li].v)}" r="4" fill="${col(s)}" stroke="#0A0A0A" stroke-width="2"/>`;
  }
  // chip badges where a chip was played
  for (const s of series)
    (s.marks || []).forEach((m, i) => {
      if (!m || s.pts[i].v == null) return;
      const cx = x(i),
        cy = y(s.pts[i].v) - 13,
        w = m.length * 6.5 + 8;
      g += `<g><rect x="${cx - w / 2}" y="${cy - 8}" width="${w}" height="15" rx="4" fill="${col(s)}"/><text x="${cx}" y="${cy + 3}" fill="#0A0A0A" font-size="10" font-weight="700" text-anchor="middle">${esc(m)}</text><title>${esc(s.name)}: ${esc(m)} in R${gds[i]}</title></g>`;
    });
  for (const l of labels)
    g += `<text x="${W - mr + 10}" y="${l.y + 4}" fill="${l.s.me ? "#FAFAFA" : "#A1A1AA"}" font-size="12" font-weight="${l.s.me ? 600 : 400}">${esc(l.s.name.length > 16 ? l.s.name.slice(0, 15) + "…" : l.s.name)}</text>`;
  box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">${g}<line class="cx" x1="0" x2="0" y1="${mt}" y2="${H - mb}" stroke="#A1A1AA" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="transparent"/></svg><div class="lgtip" hidden></div>`;
  const svg = box.querySelector("svg"),
    tip = box.querySelector(".lgtip"),
    cross = box.querySelector(".cx");
  const move = (ev) => {
    const r = svg.getBoundingClientRect(),
      px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(gds.length - 1, Math.round(((px - ml) / (W - ml - mr)) * (gds.length - 1))));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    const rows = series
      .filter((s) => s.pts[i].v != null)
      .map((s) => ({ n: s.name, v: s.pts[i].v, r: s.pts[i].r, me: s.me, m: s.marks && s.marks[i] }))
      .sort((a, b) => (inv ? a.v - b.v : b.v - a.v));
    tip.innerHTML =
      `<b>Round ${gds[i]}</b>` +
      rows
        .map(
          (q) =>
            `<div style="${q.me ? "color:#FAFAFA;font-weight:600" : "color:#A1A1AA"}"><span>${esc(q.n)}${q.m ? ` <b style="color:var(--accent)">${esc(q.m)}</b>` : ""}</span><span>${esc(fmt(q.v))}${q.r != null ? ` <span class="dim">(+${q.r})</span>` : ""}</span></div>`,
        )
        .join("");
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth, Math.max(0, (x(i) / W) * r.width + 12)) + "px";
    tip.style.top = "8px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}
