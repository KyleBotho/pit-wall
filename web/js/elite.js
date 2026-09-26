/* ---------- elite (global top 500, aggregates only) ---------- */
import { $, $$, CHIPS, DATA, byId, code, esc, f0, pct, sgn } from "./core.js";
import { state } from "./state.js";
import { LEAGUE_DATA, needSync } from "./sync.js";
import { chip, heat, who, xpts } from "./forecast.js";
import { chipMarks, cumPts, lineChart, teamHist, teamKey } from "./league.js";
import { lineups } from "./hindsight-view.js";
// the team the Elite page compares (its own picker at the top; defaults to the team last picked in the Calculator)
const elTeam = () => state.teams[Math.min(state.teams.length - 1, state.elT ?? state.active)];
export function renderElite() {
  const El = DATA.elite;
  $("#eliteEmpty").hidden = !!El;
  $("#eliteDash").hidden = !El;
  if (!El) return;
  const own = El.own || {},
    top = El.top100,
    o = (id, t) => (own[id] ? own[id][t] : 0);
  $("#elTeamPick").innerHTML = state.teams
    .map((t, i) => `<button data-elt="${i}" aria-pressed="${t === elTeam()}">${esc(t.name)}</button>`)
    .join("");
  const ft = El.feedTime ? new Date(El.feedTime) : null;
  $("#elStamp").textContent =
    `global top ${El.n}` +
    (ft && !isNaN(ft)
      ? " · standings as of " +
        ft.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "");
  $("#elCut").innerHTML = ["1", "10", "100", "500"]
    .filter((k) => El.cut[k] != null)
    .map(
      (k) =>
        `<div class="stat"><span class="l">#${k}</span><span class="v">${Math.round(El.cut[k]).toLocaleString()}</span><span class="s">points</span></div>`,
    )
    .join("");
  // your totals: auto-updated league standings when signed in, otherwise the last import
  const auto = ((LEAGUE_DATA && LEAGUE_DATA.leagues) || []).flatMap((l) => l.members);
  const gap = (p, c) =>
    p == null || c == null
      ? "—"
      : p >= c
        ? '<span class="good">in</span>'
        : `<span class="bad">−${Math.round(c - p).toLocaleString()}</span>`;
  const ptsOf = (tm) => {
    const a = auto.find((m) => (m.tk || m.team) === teamKey(tm));
    return a ? +a.pts : (tm.ovPts ?? null);
  };
  const anyPts = state.teams.some((tm) => ptsOf(tm) != null);
  $("#elMine").innerHTML =
    `<thead><tr><th>Your team</th><th>Points</th><th title="From your last import">Global rank</th><th>To top 500</th><th>To top 100</th><th>To #1</th></tr></thead><tbody>` +
    (!anyPts
      ? `<tr><td colspan="6" style="text-align:left"><span class="muted">Sign in or import a data export to see where your teams stand.</span> <button class="btn sm" data-signin="1" data-needsync="1">Sign in with Google</button> <button class="btn ghost sm" data-import="1">Import a data export</button></td></tr>`
      : "") +
    state.teams
      .filter(() => anyPts)
      .map((tm) => {
        const a = auto.find((m) => (m.tk || m.team) === teamKey(tm)),
          p = a ? +a.pts : (tm.ovPts ?? null);
        return `<tr><td><b>${esc(tm.name)}</b></td><td>${p == null ? '<span class="dim">—</span>' : Math.round(p).toLocaleString()}</td><td class="muted">${tm.ovRank ? tm.ovRank.toLocaleString() : "—"}</td>
        <td>${gap(p, El.cut["500"])}</td><td>${gap(p, El.cut["100"])}</td><td>${gap(p, El.cut["1"])}</td></tr>`;
      })
      .join("") +
    "</tbody>";
  needSync();

  renderEliteSeason(El);

  // template: the 5 drivers and 2 constructors most owned by the top 100
  const by = (kind) =>
    DATA.assets.filter((a) => a.kind === kind && (a.active || kind === "C")).sort((x, y) => o(y.id, 1) - o(x.id, 1));
  const tDr = by("D")
      .slice(0, 5)
      .map((a) => a.id),
    tCr = by("C")
      .slice(0, 2)
      .map((a) => a.id);
  const topBoost = top && top.boost ? Object.entries(top.boost).sort((a, b) => b[1] - a[1])[0] : null;
  $("#elTemplate").innerHTML =
    tCr.map((id) => chip(id, { pts: xpts(id, 1) })).join("") +
    '<span class="sep"></span>' +
    tDr.map((id) => chip(id, { pts: xpts(id, 1), x: topBoost && topBoost[0] === id ? "2×" : "" })).join("");
  const shared = elTeam().team.filter((id) => tDr.includes(id) || tCr.includes(id)).length;
  $("#elTemplateNote").innerHTML =
    `${esc(elTeam().name)} shares <b>${shared} of 7</b> with the template.` +
    (topBoost ? ` ${pct(topBoost[1])} of the top 100 boosted ${esc(code(byId[topBoost[0]]))} in R${top.round}.` : "");

  // chips: share of the top 100 playing each chip in each round (from the top-100 export); your team's chip rounds outlined
  if (top) {
    const order = ["x3", "limitless", "wildcard", "noneg", "autopilot", "finalfix"],
      chipDef = (k) => CHIPS.find(([c]) => c === k);
    const ti = Math.min(state.teams.length - 1, state.elT ?? state.active),
      tm = state.teams[ti],
      Lu = tm ? lineups(teamKey(tm)) : null;
    const max = Math.max(0.05, ...order.flatMap((k) => Object.values(top.chipRound[k] || {}).map((v) => v / top.n)));
    $("#elChipNote").innerHTML = "";
    $("#elChipSub").textContent =
      `Share of the top 100 (line-ups export after R${top.round}) playing each chip, by round.` +
      (Lu ? ` Outlined: when ${tm.name} played it.` : " Sign in to outline your own chip rounds.");
    const rounds = Array.from({ length: top.round }, (_, i) => top.round - i);
    $("#elChips").innerHTML =
      `<thead><tr><th>Round</th>${order.map((k) => `<th title="${esc(chipDef(k)[2])}">${chipDef(k)[1]}</th>`).join("")}</tr></thead><tbody>` +
      `<tr><td><b>Total</b></td>${order.map((k) => `<td><b>${pct((top.chipUsed || {})[k])}</b></td>`).join("")}</tr>` +
      rounds
        .map(
          (g) =>
            `<tr><td>R${g}</td>${order
              .map((k) => {
                const v = ((top.chipRound[k] || {})[g] || 0) / top.n,
                  mine = Lu && Lu[g] && Lu[g].chip === k;
                return `<td${heat(v, 0, max)}${mine ? ' class="chl"' : ""}>${v ? pct(v) : '<span class="dim">0</span>'}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("") +
      "</tbody>";
  } else {
    $("#elChipNote").textContent = "";
    $("#elChips").innerHTML =
      `<tbody><tr><td class="muted" style="position:static">Chip timing and Boost share come from a top-100 line-ups export. Run <code>elite_import.py</code> on one to add them.</td></tr></tbody>`;
  }

  const sn = El.snaps || [],
    lastSn = sn[sn.length - 1],
    fmtT = (x) =>
      new Date(x).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
  $("#elOwnNote").textContent =
    (El.ownPrev
      ? `± = change in ownership since R${El.prevGd}, in percentage points. `
      : "The ± columns appear once a second round's line-ups are recorded. ") +
    (lastSn
      ? `Line-ups recorded ${sn.length} time${sn.length > 1 ? "s" : ""}; last change first seen ${fmtT(lastSn.firstSeen)}.`
      : "");

  // ownership vs your teams
  const act = elTeam().team;
  // change since the previous round's snapshot (the ± columns); needs two rounds of snapshots
  const pv = El.ownPrev,
    dOwn = (id, t) => (pv ? o(id, t) - (pv[id] ? pv[id][t] : 0) : null);
  const dCell = (v) =>
    v == null
      ? ""
      : `<td class="${v > 0.005 ? "good" : v < -0.005 ? "bad" : "muted"}" style="font-size:12px">${Math.abs(v) < 0.005 ? "0" : (v > 0 ? "+" : "−") + Math.round(Math.abs(v) * 100)}</td>`;
  const rows = DATA.assets
    .filter((a) => (a.active || a.kind === "C") && (own[a.id] || state.teams.some((t) => t.team.includes(a.id))))
    .sort((x, y) => o(y.id, 1) - o(x.id, 1) || o(y.id, 2) - o(x.id, 2));
  $("#elOwn").innerHTML =
    `<thead><tr><th>Asset</th><th>Top 10</th><th>Top 100</th>${pv ? `<th title="Change in top-100 ownership since R${El.prevGd}, percentage points">±</th>` : ""}<th>Top 500</th>${pv ? `<th title="Change in top-500 ownership since R${El.prevGd}, percentage points">±</th>` : ""}<th title="All players">All</th>${top ? `<th title="Share of the top 100 boosting this driver in R${top.round}">Boost</th>` : ""}<th style="text-align:left">Your teams</th><th style="text-align:left">For ${esc(elTeam().name)}</th></tr></thead><tbody>` +
    rows
      .map((a) => {
        const p100 = o(a.id, 1),
          has = act.includes(a.id);
        const tag =
          has && p100 < 0.3
            ? '<span class="good">Differential</span>'
            : !has && p100 >= 0.7
              ? '<span class="bad">Missing staple</span>'
              : has
                ? '<span class="muted">Owned</span>'
                : "";
        return `<tr><td>${who(a)}</td>
        <td>${pct(o(a.id, 0))}</td><td${heat(p100, 0, 1)}><b>${pct(p100)}</b></td>${pv ? dCell(dOwn(a.id, 1)) : ""}<td>${pct(o(a.id, 2))}</td>${pv ? dCell(dOwn(a.id, 2)) : ""}<td class="muted">${f0(a.own)}%</td>
        ${top ? `<td>${top.boost && top.boost[a.id] ? pct(top.boost[a.id]) : "—"}</td>` : ""}
        <td style="text-align:left">${state.teams.map((t, i) => (t.team.includes(a.id) ? `<span class="chiptok" title="${esc(t.name)}">T${i + 1}</span>` : "")).join("")}</td><td style="text-align:left">${tag}</td></tr>`;
      })
      .join("") +
    "</tbody>";
}

export function renderEliteSeason(El) {
  const Hs = El.history || [],
    byGd = Object.fromEntries(Hs.map((h) => [h.gd, h]));
  const mine = state.teams.map((t) => ({ t, h: teamHist(teamKey(t)) })).filter((x) => x.h.length);
  const gds = [...new Set(Hs.map((h) => h.gd).concat(mine.flatMap((x) => x.h.map((h) => h.gd))))].sort((a, b) => a - b);
  // gap mode: every line minus the #100 cut-off that round, so the distances are readable
  const gap = state.elMode !== "total",
    base = (i) => (gap ? (byGd[gds[i]]?.cut?.["100"] ?? null) : 0);
  const rel = (pts) => pts.map((p, i) => ({ v: p.v == null || base(i) == null ? null : p.v - base(i), r: p.r }));
  $$("#elMode button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.em === "gap") === gap)));
  const cuts = ["1", "10", "100", "500"]
    .filter((k) => Hs.some((h) => h.cut && h.cut[k] != null))
    .map((k) => ({
      name: "#" + k,
      dash: true,
      color: { 1: "#D4D4D8", 10: "#A1A1AA", 100: "#71717A", 500: "#52525B" }[k],
      pts: rel(gds.map((gd) => ({ v: byGd[gd]?.cut?.[k] ?? null, r: null }))),
    }));
  lineChart(
    $("#elSeasonChart"),
    gds,
    cuts.concat(
      mine.map(({ t, h }) => ({
        name: t.name,
        me: t === elTeam(),
        color: "#E4E4E7",
        pts: rel(cumPts(h, gds)),
        marks: chipMarks(t.name, gds),
      })),
    ),
    gap
      ? "Points above or below the global top-100 cut-off, by round"
      : "Cumulative points: your teams against global cut-offs",
  );
  $("#elSeasonNote").textContent =
    (gap
      ? "Points above or below the global top-100 cut-off after each round. "
      : "Cumulative points after each round. ") + (mine.length ? "" : "Sign in to add your teams.");
  const cell = (p, avg) =>
    p == null
      ? '<td class="dim">—</td>'
      : `<td><b>${p}</b>${avg == null ? "" : ` <span class="${p >= avg ? "good" : "bad"}">${sgn(p - avg, 0)}</span>`}</td>`;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rows = gds
    .slice()
    .reverse()
    .map((gd) => {
      const e = byGd[gd] || {},
        a100 = e.avg?.["100"];
      return `<tr><td>R${gd}</td><td>${f0(e.avg?.["10"])}</td><td>${f0(a100)}</td>${mine.map(({ h }) => cell(h.find((x) => x.gd === gd)?.pts, a100)).join("")}</tr>`;
    });
  const avgRow = `<tr><td><b>Average</b></td><td>${f0(mean(Hs.map((h) => h.avg?.["10"]).filter((v) => v != null)))}</td><td>${f0(mean(Hs.map((h) => h.avg?.["100"]).filter((v) => v != null)))}</td>${mine.map(({ h }) => `<td><b>${f0(mean(h.map((x) => x.pts)))}</b></td>`).join("")}</tr>`;
  $("#elRounds").innerHTML =
    `<thead><tr><th>Round</th><th title="Average round score of the current global top 10">Top 10</th><th title="Average round score of the current global top 100">Top 100</th>${mine.map(({ t }) => `<th>${esc(t.name)}</th>`).join("")}</tr></thead><tbody>${avgRow}${rows.join("")}</tbody>`;
  const est = Hs.filter((h) => h.est).map((h) => h.gd);
  $("#elSeasonFoot").innerHTML =
    "Your round score against the top-100 average (green: beat it). " +
    (est.length
      ? `Cut-offs for R${est[0]}–R${est[est.length - 1]} trace today's top 100 through the season, so they are an estimate and run slightly low; later rounds are the real cut-offs recorded after each race.`
      : "Cut-offs are recorded after each race.");
}
