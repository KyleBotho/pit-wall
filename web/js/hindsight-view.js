/* ---------- hindsight: best teams on actual points (scoring in hindsight.js, as Hind) ---------- */
import { $, $$, CHIPS, DATA, Hind, byId, code, esc, infoTip, f0, f1, money, sgn } from "./core.js";
import { activeTeam, state } from "./state.js";
import { LEAGUE_DATA, save } from "./sync.js";
import { chip, codeBox, heat } from "./forecast.js";
import { teamHist, teamKey } from "./league.js";
import { filterUI, filters, teamText } from "./filters.js";
import { addDraft, copyText, inclExcl, matchSearch } from "./calc.js";
import { toast } from "./main.js";
export const lineups = (key) => (LEAGUE_DATA && LEAGUE_DATA.lineups && LEAGUE_DATA.lineups[key]) || null; // by teamKey
// budget for the best teams: $100m, no cap, or one of your teams' budget that round ("team:i"; the default, the
// fair comparison)
const hdCapMode = () => state.hdCap || `team:${state.active}`;
function hdCap(gd) {
  const mode = hdCapMode();
  if (mode === "none") return null;
  if (mode.startsWith("team:")) {
    const team = state.teams[+mode.slice(5)] || activeTeam(),
      r = (lineups(teamKey(team)) || {})[gd];
    return r ? Hind.budget(r, gd) : 100;
  }
  return 100;
}
const hdMarks = (to) => Object.keys(state.hdMarks || {}).filter((k) => state.hdMarks[k] === to);
const hdBestList = (gd, top) => {
  const ff = state.hdChip === "finalfix",
    list = Hind.run(gd, {
      cap: hdCap(gd),
      chip: ff ? "" : state.hdChip || "",
      filters: filters("hd"),
      locks: hdMarks("lock"),
      bans: hdMarks("ban"),
      top,
    });
  return ff ? list.map((t) => Hind.withFF(t, gd, hdCap(gd))).sort((a, b) => b.score - a.score) : list;
};
function hdChips(ids, boost, x3, start, gd, chipK, ff) {
  if (ff) ids = ids.concat([ff.in]);
  const cons = ids.filter((id) => byId[id]?.kind === "C"),
    drs = ids.filter((id) => byId[id]?.kind === "D");
  const slotB = ff && (boost === ff.in || boost === ff.out),
    isFF = (id) => ff && (id === ff.in || id === ff.out);
  const m = (id) => (isFF(id) ? (slotB ? 2 : 1) : id === x3 ? 3 : id === boost ? 2 : 1);
  const pts = (id) => (!isFF(id) ? Hind.pts(id, gd, chipK) : Hind.sess(id, gd, ff.cat, id === ff.in ? "post" : "pre"));
  const one = (id) => {
    const h = Hind.at(id, gd);
    return chip(id, {
      a: h ? f0(pts(id) * m(id)) : "—",
      b: h ? h.price.toFixed(1) : "",
      x: ff && id === ff.in ? "FF" : ff && id === ff.out ? "" : id === x3 ? "3×" : id === boost ? "2×" : "",
      cls: [start && !start.includes(id) && !isFF(id) ? "in" : "", ff && id === ff.out ? "out" : ""].join(" "),
    });
  };
  return (
    cons.map(one).join("") +
    '<span class="sep"></span>' +
    drs
      .sort((a, b) => m(b) - m(a) || pts(b) - pts(a))
      .map(one)
      .join("")
  );
}
// What each decision was worth that round. Formulas as in the Decisions panel note.
function hdDecisions(name, gd) {
  const rounds = lineups(name) || {},
    r = rounds[gd];
  if (!r) return null;
  const prevGd = Object.keys(rounds)
      .map(Number)
      .filter((g) => g < gd)
      .sort((a, b) => b - a)[0],
    prev = prevGd ? rounds[prevGd] : null;
  const base = (id) => Hind.pts(id, gd, ""),
    mult = (id) => (id === r.x3 ? 3 : id === r.boost ? 2 : 1);
  const score = (ids, boost, x3) => ids.reduce((s, id) => s + base(id) * (id === x3 ? 3 : id === boost ? 2 : 1), 0);
  const out = { chip: r.chip, list: [] };
  if (gd === DATA.schedule[0].gd) {
    out.list.push({ k: "start", label: "Initial pick", pts: null });
    return out;
  }
  if (r.chip === "limitless") {
    if (prev) {
      const was = score(prev.ids, prev.ids.includes(prev.boost) ? prev.boost : null, null);
      out.list.push({
        k: "chip",
        label: `Limitless over keeping R${prevGd}'s team`,
        pts: score(r.ids, r.boost, r.x3) - was,
      });
    }
    return out;
  }
  const outs = r.start.filter((id) => !r.ids.includes(id)),
    ins = r.ids.filter((id) => !r.start.includes(id));
  const pen = r.chip === "wildcard" ? 0 : 10 * Math.max(0, (r.subs || 0) - (r.free || 0));
  if (ins.length)
    out.list.push({
      k: "tr",
      label: `${ins.length} transfer${ins.length > 1 ? "s" : ""} (${r.free ?? "?"} free): ${outs.map((id) => code(byId[id])).join(", ")} → ${ins.map((id) => code(byId[id])).join(", ")}${pen ? ` (−${pen})` : ""}`,
      pts: ins.reduce((s, id) => s + base(id), 0) - outs.reduce((s, id) => s + base(id), 0) - pen,
      d: ins.reduce((s, id) => s + Hind.delta(id, gd), 0) - outs.reduce((s, id) => s + Hind.delta(id, gd), 0),
      pen,
      n: ins.length,
    });
  if (prev && prev.boost && prev.boost !== r.boost && r.ids.includes(prev.boost) && r.boost)
    out.list.push({
      k: "x2",
      label: `Boost ${code(byId[prev.boost])} → ${code(byId[r.boost])}`,
      pts: base(r.boost) - base(prev.boost),
    });
  if (r.chip === "x3" && r.x3)
    out.list.push({ k: "chip", label: "X3 chip", pts: base(r.x3) + (r.boost ? base(r.boost) : 0) });
  if (r.chip === "noneg")
    out.list.push({
      k: "chip",
      label: "No Negative chip",
      pts: r.ids.reduce((s, id) => s + (Hind.pts(id, gd, "noneg") - base(id)) * mult(id), 0),
    });
  // F1 records 0 transfers made on a Wildcard round, so count the actual changes
  if (r.chip === "wildcard")
    out.list.push({
      k: "chip",
      label: "Wildcard (penalties avoided)",
      pts: 10 * Math.max(0, ins.length - (r.free || 0)),
    });
  if (r.chip === "autopilot")
    out.list.push({
      k: "chip",
      label: `Autopilot gave the Boost to ${r.boost ? code(byId[r.boost]) : "—"}`,
      pts: null,
    });
  if (r.chip === "finalfix" && r.ff)
    out.list.push({
      k: "chip",
      label: `Final Fix ${code(byId[r.ff.out])} → ${code(byId[r.ff.in])}`,
      pts:
        (Hind.sess(r.ff.in, gd, r.ff.cat, "post") - Hind.sess(r.ff.out, gd, r.ff.cat, "post")) *
        (r.boost === r.ff.in || r.boost === r.ff.out ? 2 : 1),
    });
  return out;
}
// one decision in a team's "why" line: what it was, what it was worth, and (transfers) the price change it bought
const decHtml = (x) =>
  `${esc(x.label)}${x.pts == null ? "" : ` <b class="${x.pts > 0 ? "good" : x.pts < 0 ? "bad" : "muted"}">${sgn(x.pts, 0) || "0"}</b>`}${x.d ? ` <span class="muted">Δ$ ${sgn(x.d, 1)}</span>` : ""}`;

// A line-up in the Calculator's columns: constructors, the Boosted driver(s), the other drivers (Final Fix: the driver
// brought in sits with the drivers, marked FF, the one taken out faded).
function hdCells(ids, boost, x3, start, gd, chipK, ff) {
  if (ff) ids = ids.concat([ff.in]);
  const slotB = ff && (boost === ff.in || boost === ff.out),
    isFF = (id) => ff && (id === ff.in || id === ff.out);
  const m = (id) => (isFF(id) ? (slotB ? 2 : 1) : id === x3 ? 3 : id === boost ? 2 : 1);
  const pts = (id) => (!isFF(id) ? Hind.pts(id, gd, chipK) : Hind.sess(id, gd, ff.cat, id === ff.in ? "post" : "pre"));
  const one = (id) => {
    const h = Hind.at(id, gd);
    return chip(id, {
      a: h ? f0(pts(id) * m(id)) : "—",
      b: h ? h.price.toFixed(1) : "",
      x: ff && id === ff.in ? "FF" : ff && id === ff.out ? "" : id === x3 ? "3×" : id === boost ? "2×" : "",
      cls: [start && !start.includes(id) && !isFF(id) ? "in" : "", ff && id === ff.out ? "out" : ""].join(" "),
    });
  };
  const byM = (a, b) => m(b) - m(a) || pts(b) - pts(a);
  const cons = ids.filter((id) => byId[id]?.kind === "C"),
    boosted = ids.filter((id) => byId[id]?.kind === "D" && !isFF(id) && (id === x3 || id === boost)).sort(byM),
    drs = ids.filter((id) => byId[id]?.kind === "D" && !boosted.includes(id)).sort(byM);
  const tiles = (xs) => `<div class="chips">${xs.map(one).join("")}</div>`;
  return `<td class="tl cr">${tiles(cons)}</td><td class="tl">${tiles(boosted)}</td><td class="tl dr">${tiles(drs)}</td>`;
}
const PERSON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;
const pill = (v, on, cls = "", title = "") =>
  `<span class="pill ${cls}${on ? " on" : ""}"${title ? ` title="${esc(title)}"` : ""}>${v}</span>`;
const NCOL = 9;
const HEAD =
  `<thead><tr><th>#</th><th style="text-align:left">CR</th><th style="text-align:left">x2</th><th style="text-align:left">DR</th>` +
  `<th title="Cost at that round's prices">$</th><th data-vc="1" aria-sort="descending">Pts ↓</th><th data-vc="1" title="Price change of the seven after the round">Δ$</th>` +
  `<th class="mv">Pts ↓<br>Δ$</th><th class="dots"></th></tr></thead>`;
const sec = (html) => `<tr class="sec"><td colspan="${NCOL}">${html}</td></tr>`;
const wide = (html, center) =>
  `<tr><td colspan="${NCOL}" class="${center ? "" : "muted"}" style="position:static;text-align:${center ? "center" : "left"}">${html}</td></tr>`;
// one line-up row, the Calculator's: rank, the three chip columns, cost, points (white), Δ$, ⋯
function hdRow(rank, cells, cost, pts, gap, dv, menu) {
  const d = pill(sgn(dv, 1), false, dv >= 0 ? "good" : "bad");
  const more = menu ? `<button class="tbtn" data-hmenu="${menu}" aria-label="More actions">⋯</button>` : "";
  return `<tr><td class="rk">${rank}${menu ? `<br><button class="tbtn mobonly" data-hmenu="${menu}" aria-label="More actions">⋯</button>` : ""}</td>${cells}
    <td>${pill(cost == null ? "—" : cost.toFixed(1), false, "", "Total cost")}</td>
    <td data-vc="1">${pill(pts, true)}${gap}</td><td data-vc="1" class="${dv >= 0 ? "good" : "bad"}">${sgn(dv, 1)}</td>
    <td class="mv">${pill(pts, true)}${d}${gap}</td><td class="dots">${more}</td></tr>`;
}
const HD_MODES = ["best", "mine", "season"];
export function showHdMode() {
  const m = HD_MODES.includes(state.hdMode) ? state.hdMode : "best";
  $$("#hdMode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hdmode === m)));
  $$("#view-hind [data-hm]").forEach((el) => (el.hidden = el.dataset.hm !== m));
}
// what the ⋯ menus act on: the rows as last drawn
let hdRows = { best: [], mine: [] };
let hdCtx = null; // the round, projection and best team behind the Drivers / Constructors panes

export function renderHind() {
  const done = DATA.done || [];
  $("#hindEmpty").hidden = !!done.length;
  $("#hindDash").hidden = !done.length;
  $("#view-hind .panel-tabs").hidden = !done.length;
  if (!done.length) return;
  const gd = done.includes(state.hdGd) ? state.hdGd : done[done.length - 1],
    cap = hdCap(gd),
    chipK = state.hdChip || "",
    chipLabel = { x3: "X3", noneg: "No Negative", finalfix: "Final Fix" }[chipK];
  const name = (g) => DATA.schedule.find((x) => x.gd === g)?.name || "";
  showHdMode();

  // Settings: round, budget, chip, filters (each section summarised in its header, as in the Calculator)
  for (const d of $$("#view-hind details.grp")) {
    const open = state.calcGrp[d.dataset.grp] !== false;
    if (d.open !== open) d.open = open;
  }
  $("#hdRound").innerHTML = done
    .map((g) => `<button data-hg="${g}" aria-pressed="${g === gd}" title="${esc(name(g))}">R${g}</button>`)
    .join("");
  $("#hdRoundName").textContent = `R${gd} ${name(gd)}`;
  $("#hdGrpRound").textContent = `R${gd} · ${name(gd).replace(" Grand Prix", " GP")}`;
  const capM = hdCapMode();
  $("#hdCapTeam").innerHTML = state.teams
    .map(
      (t, i) =>
        `<button data-hc="team:${i}" aria-pressed="${capM === "team:" + i}" title="${esc(t.name)}'s budget going into that round">${esc(t.name)}</button>`,
    )
    .join("");
  $("#hdCapFix").innerHTML = [
    ["100", "$100m"],
    ["none", "No cap"],
  ]
    .map(([k, n]) => `<button data-hc="${k}" aria-pressed="${k === capM}">${n}</button>`)
    .join("");
  $("#hdGrpCap").textContent = capM.startsWith("team:")
    ? `${(state.teams[+capM.slice(5)] || activeTeam()).name} · ${money(cap)}`
    : cap == null
      ? "no cap"
      : money(cap);
  $$("#hdChip button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hch === chipK)));
  $("#hdGrpChip").textContent = chipLabel || "none";
  const nf = filters("hd").length,
    nm = Object.keys(state.hdMarks || {}).length;
  $("#hdFilters").innerHTML = filterUI("hd");
  $("#hdGrpFilt").textContent = nf ? `${nf} filter${nf > 1 ? "s" : ""}` : "none";

  // best possible teams
  const showN = state.hdShowN || 10,
    list = hdBestList(gd, showN);
  $("#hdBestNote").textContent =
    `R${gd} ${name(gd)} · ${cap == null ? "no budget cap" : "budget " + money(cap)}${chipLabel ? " · " + chipLabel : ""}${nf ? ` · ${nf} filter${nf > 1 ? "s" : ""}` : ""}${nm ? ` · ${nm} Incl / Excl` : ""}`;
  $("#hdBestTip").innerHTML = infoTip(
    "The best line-ups for that round on the points each asset actually scored, at that round's prices and within the budget in Settings. Pts is the round score; the grey figure under it is the gap to #1. Δ$ is the price change the seven got after the round.",
  );
  hdRows.best = list.map((b, i) => {
    const boost = b.boost2 || b.boost,
      x3 = b.boost2 ? b.boost : null;
    return {
      ids: b.drivers.concat(b.cons),
      txt:
        teamText(`R${gd} best #${i + 1}`, b.cons, b.drivers, boost, x3, b.cost, b.score) +
        (b.ff ? ` | Final Fix ${code(byId[b.ff.out])} → ${code(byId[b.ff.in])}` : ""),
    };
  });
  $("#hdBest").innerHTML =
    HEAD +
    "<tbody>" +
    (list.length
      ? list
          .map((b, i) => {
            const ids = b.drivers.concat(b.cons),
              x3 = b.boost2 ? b.boost : null,
              boost = b.boost2 || b.boost,
              dv = ids.reduce((s, id) => s + Hind.delta(id, gd), 0);
            const gap = i ? `<span class="gap">${sgn(b.score - list[0].score, 0)}</span>` : "";
            return hdRow(
              i + 1,
              hdCells(ids, boost, x3, null, gd, chipK === "finalfix" ? "" : chipK, b.ff),
              b.cost,
              f0(b.score),
              gap,
              dv,
              `best:${i}`,
            );
          })
          .join("") +
        (list.length >= showN && showN < 50
          ? wide('<button class="btn ghost sm" data-hdmore="1">Load more teams</button>', true)
          : "")
      : wide(
          "No team fits this budget and these filters. Try another budget, or remove some filters or Incl / Excl marks.",
        )) +
    "</tbody>";

  // your teams: the line-up used, then the best move you had from the line-up going in
  const mine = state.teams.map((t) => ({
    t,
    r: (lineups(teamKey(t)) || {})[gd],
    off: teamHist(teamKey(t)).find((h) => h.gd === gd)?.pts,
  }));
  hdRows.mine = [];
  if (!LEAGUE_DATA)
    $("#hdMine").innerHTML =
      `<p class="note">Sign in and link your F1 Fantasy account to see the teams you played, and the best move each one had, round by round.</p>` +
      `<div class="chipbar"><button class="btn sm" data-signin="1" data-needsync="1">Sign in with Google</button></div>`;
  else
    $("#hdMine").innerHTML =
      `<div class="tw"><table class="bestt">${HEAD}<tbody>` +
      mine
        .map(({ t, r, off }, k) => {
          if (!r)
            return (
              sec(`<b>${esc(t.name)}</b>`) +
              wide(
                `No line-up saved for R${gd}. Line-ups come from a data export; collect a fresh one to fill new rounds.`,
              )
            );
          const b = Hind.own(r, gd),
            chipName = (CHIPS.find(([c]) => c === r.chip) || [])[2],
            fresh = Hind.fresh(gd, r.start);
          const bids = b.drivers.concat(b.cons),
            outs = r.start.filter((id) => !bids.includes(id)),
            ins = bids.filter((id) => !r.start.includes(id));
          const moves =
            fresh || ["wildcard", "limitless"].includes(r.chip)
              ? `${chipName || "Free"} rebuild`
              : ins.length
                ? `${ins.length} transfer${ins.length > 1 ? "s" : ""}: ` +
                  outs.map((id) => code(byId[id])).join(", ") +
                  " → " +
                  ins.map((id) => code(byId[id])).join(", ") +
                  (b.penalty ? ` (−${b.penalty})` : "")
                : "no transfers";
          const miss = off == null ? null : b.score - off,
            dec = hdDecisions(teamKey(t), gd);
          const boost = b.boost2 || b.boost,
            x3 = b.boost2 ? b.boost : null;
          hdRows.mine[k] = {
            ids: bids,
            txt: teamText(`${t.name} R${gd} best`, b.cons, b.drivers, boost, x3, b.cost, b.score),
          };
          const usedCost = r.ids.reduce((s, id) => s + (Hind.at(id, gd)?.price || 0), 0),
            usedDv = r.ids.reduce((s, id) => s + Hind.delta(id, gd), 0),
            bestDv = bids.reduce((s, id) => s + Hind.delta(id, gd), 0);
          const left =
            miss == null
              ? ""
              : `<span class="gap ${miss > 0 ? "bad" : "good"}">${miss > 0 ? "+" + f0(miss) + " missed" : "optimal"}</span>`;
          const why = [
            `Best move: ${esc(moves)}`,
            ...(dec ? dec.list.map(decHtml) : []),
            b.ff
              ? `Best Final Fix: ${esc(code(byId[b.ff.out]))} → ${esc(code(byId[b.ff.in]))} (+${f0(b.ff.gain)})`
              : "",
          ].filter(Boolean);
          return (
            sec(`<b>${esc(t.name)}</b>${chipName ? ` <span class="tag sprint">${esc(chipName)}</span>` : ""}`) +
            hdRow(
              `<span title="The line-up you played">${PERSON_ICON}</span>`,
              hdCells(r.ids, r.boost, r.x3, null, gd, r.chip, r.ff),
              usedCost,
              off ?? "—",
              "",
              usedDv,
              "",
            ).replace("<tr>", '<tr title="The line-up you played, with its official round points">') +
            hdRow(
              '<span class="dim" title="The best line-up you could have reached">★</span>',
              hdCells(bids, boost, x3, fresh ? null : r.start, gd, r.chip, b.ff),
              b.cost,
              f0(b.score),
              left,
              bestDv,
              `mine:${k}`,
            ).replace(
              "<tr>",
              '<tr class="joined" title="The best you could have reached from that line-up, budget and free transfers">',
            ) +
            `<tr class="why"><td></td><td colspan="${NCOL - 1}">${why.join(" · ")}</td></tr>`
          );
        })
        .join("") +
      "</tbody></table></div>";

  // season: official vs best reachable, every finished round
  const teams = mine.filter(({ t }) => lineups(teamKey(t)));
  const rows = done
    .slice()
    .reverse()
    .map((g) => {
      const bb = hdBestList(g, 1)[0];
      return (
        `<tr><td${g === gd ? ' style="background:var(--accent-soft)"' : ""}>R${g}</td><td>${bb ? f0(bb.score) : "—"}</td>` +
        teams
          .map(({ t }) => {
            const r = lineups(teamKey(t))[g],
              off = teamHist(teamKey(t)).find((h) => h.gd === g)?.pts;
            if (!r) return '<td class="dim">—</td><td class="dim">—</td>';
            const b = Hind.own(r, g),
              miss = off == null ? null : b.score - off;
            return `<td><b>${off ?? "—"}</b></td><td${heat(miss == null ? null : -miss, -80, 0)}>${f0(b.score)}${miss > 0 ? ` <span class="bad">−${f0(miss)}</span>` : ""}</td>`;
          })
          .join("") +
        "</tr>"
      );
    });
  const sum = (f) => done.reduce((acc, g) => acc + (f(g) || 0), 0);
  const tot =
    `<tr><td><b>Season</b></td><td><b>${f0(sum((g) => hdBestList(g, 1)[0]?.score))}</b></td>` +
    teams
      .map(({ t }) => {
        const rounds = lineups(teamKey(t)),
          off = sum((g) => (rounds[g] ? teamHist(teamKey(t)).find((h) => h.gd === g)?.pts : 0)),
          best = sum((g) => (rounds[g] ? Hind.own(rounds[g], g).score : 0));
        return `<td><b>${f0(off)}</b></td><td><b>${f0(best)}</b> <span class="muted">${best ? Math.round((off / best) * 100) + "%" : ""}</span></td>`;
      })
      .join("") +
    "</tr>";
  $("#hdSeason").innerHTML =
    `<thead><tr><th>Round</th><th title="Best team from scratch with the budget and chip in Settings">Best possible</th>${teams.map(({ t }) => `<th>${esc(t.name)}</th><th title="Best reachable from that team's line-up, budget, free transfers and chip">Best reachable</th>`).join("")}</tr></thead><tbody>${tot}${rows.join("")}</tbody>`;
  $("#hdFoot").innerHTML = infoTip(
    teams.length
      ? "Best reachable starts from the team's actual line-up going into the round, with its budget, free transfers (extra ones at −10) and the chip it played. The % is how much of that you banked."
      : "Sign in to compare your own teams.",
  );

  // decisions over the season, per team
  const dsum = teams.map(({ t }) => {
    const all = done
      .map((g) => hdDecisions(teamKey(t), g))
      .filter(Boolean)
      .flatMap((d) => d.list);
    const tr = all.filter((x) => x.k === "tr"),
      good = tr.filter((x) => x.pts > 0),
      bad = tr.filter((x) => x.pts < 0),
      x2 = all.filter((x) => x.k === "x2"),
      ch = all.filter((x) => x.k === "chip" && x.pts != null);
    const s_ = (xs) => xs.reduce((a, x) => a + x.pts, 0);
    return {
      t,
      n: tr.reduce((a, x) => a + x.n, 0),
      pen: tr.reduce((a, x) => a + x.pen, 0),
      good,
      bad,
      net: s_(tr),
      d: tr.reduce((a, x) => a + (x.d || 0), 0),
      x2n: x2.length,
      x2: s_(x2),
      ch,
    };
  });
  const td = (v) => `<td class="${v > 0 ? "good" : v < 0 ? "bad" : "muted"}">${sgn(v, 0) || "0"}</td>`;
  $("#hdDecide").innerHTML = teams.length
    ? `<thead><tr><th>Team</th><th>Transfers</th><th title="Penalty points paid">Penalties</th><th title="Rounds where the transfers gained / lost points">Good / bad rounds</th><th>Transfer impact</th><th title="Price change of assets in minus out">Δ$ impact</th><th>Boost changes</th><th style="text-align:left">Chips</th></tr></thead><tbody>` +
      dsum
        .map(
          (
            x,
          ) => `<tr><td><b>${esc(x.t.name)}</b></td><td>${x.n}</td><td class="${x.pen ? "bad" : "muted"}">${x.pen ? "−" + x.pen : "0"}</td><td><span class="good">${x.good.length} (${
            sgn(
              x.good.reduce((a, y) => a + y.pts, 0),
              0,
            ) || 0
          })</span> / <span class="bad">${x.bad.length} (${
            sgn(
              x.bad.reduce((a, y) => a + y.pts, 0),
              0,
            ) || 0
          })</span></td>${td(x.net)}<td class="${x.d >= 0 ? "good" : "bad"}">${sgn(x.d, 1)}</td><td>${x.x2n} · <span class="${x.x2 >= 0 ? "good" : "bad"}">${sgn(x.x2, 0) || 0}</span></td>
      <td style="text-align:left">${x.ch.map((c) => `${esc(c.label.replace(" chip", "").replace(/ \(.*\)| over .*/, ""))} <span class="${c.pts >= 0 ? "good" : "bad"}">${sgn(c.pts, 0)}</span>`).join(" · ") || "—"}</td></tr>`,
        )
        .join("") +
      "</tbody>"
    : `<tbody><tr><td class="muted" style="position:static">Sign in to see your decisions.</td></tr></tbody>`;

  renderModelTeam(gd);

  // Drivers / Constructors: every asset's round, with this model's pre-lock projection where it was saved
  hdCtx = { gd, proj: (DATA.projHist || {})[gd], best: list[0] ? list[0].drivers.concat(list[0].cons) : [] };
  $("#hdAssetsNote").textContent = `R${gd}`;
  $("#hdAssetsTip").innerHTML = infoTip(
    `Each asset's points that round, its price then and its price change after it. ● = in the #1 best team; T1–T3 = in your teams. Incl / Excl apply to the best teams.` +
      (hdCtx.proj ? ` Proj = this site's projection frozen at lock (${modelAccuracy(gd)}).` : ""),
  );
  renderHindAssets();
}

// the Drivers and Constructors panes (also redrawn alone as you type in their search boxes)
export function renderHindAssets() {
  if (!hdCtx) return;
  const { gd, proj, best } = hdCtx;
  const table = (kind, q) => {
    const list = DATA.assets
      .filter((a) => a.kind === kind && matchSearch(a, q))
      .map((a) => ({ a, h: Hind.at(a.id, gd) }))
      .filter((x) => x.h && (x.h.active || kind === "C"))
      .sort((x, y) => y.h.pts - x.h.pts);
    const head =
      `<thead><tr><th>${kind === "D" ? "DR" : "CR"}</th><th title="Price that round">$</th><th title="Points that round" aria-sort="descending">Pts ↓</th>` +
      (proj ? '<th title="Projection frozen at lock">Proj</th>' : "") +
      `<th title="Price change after the round">Δ$</th><th title="Include / exclude in the best teams">Incl / Excl</th></tr></thead>`;
    const line = ({ a, h }) => {
      const dv = Hind.delta(a.id, gd),
        tok = state.teams
          .map((t, i) =>
            ((lineups(teamKey(t)) || {})[gd]?.ids || []).includes(a.id)
              ? `<span class="chiptok" title="In ${esc(t.name)}">T${i + 1}</span>`
              : "",
          )
          .join("");
      return `<tr><td><span class="who">${codeBox(a)}${best.includes(a.id) ? '<span title="In the #1 best team" style="color:var(--accent)">●</span>' : ""}${tok}</span></td>
        <td>${f1(h.price)}</td><td${heat(h.pts, -20, 60)} title="No Negative ${f0(h.nn)} · ${f1(h.pts / h.price)} pts per $1m · owned by ${f0(h.own)}%"><b>${f0(h.pts)}</b></td>${proj ? `<td class="muted">${f1(proj[a.id])}</td>` : ""}
        <td class="${dv > 0 ? "good" : dv < 0 ? "bad" : "muted"}">${sgn(dv, 1)}</td><td>${inclExcl(a.id, (state.hdMarks || {})[a.id] || "", "hmark")}</td></tr>`;
    };
    return head + "<tbody>" + list.map(line).join("") + "</tbody>";
  };
  $("#hdDrv").innerHTML = table("D", $("#hdDrvSearch").value);
  $("#hdCon").innerHTML = table("C", $("#hdConSearch").value);
}

// the ⋯ menu on a Hindsight line-up: copy it, or keep it as a manual team (at today's prices) for the Calculator
let hdMenuRow = null;
export function openHdMenu(btn) {
  const [k, i] = btn.dataset.hmenu.split(":"),
    r = (hdRows[k] || [])[+i],
    m = $("#hdMenu");
  if (!r) return;
  if (!m.hidden && hdMenuRow === r) return void (m.hidden = true);
  hdMenuRow = r;
  m.innerHTML =
    '<button data-hmi="copy">Copy team as text</button><button data-hmi="save">Save as manual team</button>';
  const host = $("#view-hind").getBoundingClientRect(),
    b = btn.getBoundingClientRect();
  m.hidden = false;
  m.style.top = b.bottom - host.top + 4 + "px";
  m.style.left = Math.max(0, Math.min(host.width - m.offsetWidth, b.right - host.left - m.offsetWidth)) + "px";
}
export function hdMenuAction(a) {
  const r = hdMenuRow;
  $("#hdMenu").hidden = true;
  if (!r) return;
  if (a === "copy") return copyText(r.txt);
  if (a === "save" && addDraft("Hindsight " + (state.drafts.length + 1), r.ids)) {
    save();
    toast("Saved as a manual team, at today's prices (Calculator → Compare).");
  }
}

// How far the frozen projection was from what happened: this round's mean absolute error and rank correlation,
// and the average error over every round with a frozen projection (the model's live track record).
function modelAccuracy(gd) {
  const one = (g) => {
    const proj = (DATA.projHist || {})[g] || {},
      xs = [],
      ys = [];
    for (const [id, x] of Object.entries(proj)) {
      const h = Hind.at(id, g);
      if (!h || !h.active || x == null) continue;
      xs.push(x);
      ys.push(h.pts);
    }
    return xs.length
      ? { mae: xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0) / xs.length, rho: Engine.spearman(xs, ys) }
      : null;
  };
  const now = one(gd);
  if (!now) return "no result yet";
  const all = Object.keys(DATA.projHist || {})
    .map(Number)
    .filter((g) => DATA.done.includes(g))
    .map(one)
    .filter(Boolean);
  const avg = all.reduce((s, x) => s + x.mae, 0) / all.length;
  return (
    `off by ${f1(now.mae)} pts per asset, rank correlation ${now.rho.toFixed(2)}` +
    (all.length > 1 ? `; ${all.length} rounds average ${f1(avg)}` : "")
  );
}

// The model team (Hind.modelTeam): the frozen projection where the site saved one, else the rebuilt one. Computed
// once per page load; it doesn't depend on any setting.
let modelRounds = null;
function modelTeamRounds() {
  if (!modelRounds) {
    const proj = { ...(DATA.projRebuilt || {}), ...(DATA.projHist || {}) };
    modelRounds = Hind.modelTeam(proj).map((r) => ({
      ...r,
      src: (DATA.projHist || {})[r.gd] ? "Frozen" : (DATA.projRebuilt || {})[r.gd] ? "Rebuilt" : "Kept",
    }));
  }
  return modelRounds;
}
function renderModelTeam(gd) {
  const rs = modelTeamRounds();
  if (!rs.length) {
    $("#hdModelSum").textContent = "No projections for finished rounds yet.";
    $("#hdModel").innerHTML = "";
    return;
  }
  const gds = rs.map((r) => r.gd),
    span = `R${gds[0]}–R${gds[gds.length - 1]}`,
    total = rs[rs.length - 1].total;
  // your teams' official round points and the top-100 average, over the same rounds
  const teams = state.teams
    .map((t, i) => ({ t, i, by: Object.fromEntries(teamHist(teamKey(t)).map((h) => [h.gd, h.pts])) }))
    .filter((x) => gds.some((g) => x.by[g] != null));
  const el = Object.fromEntries(((DATA.elite && DATA.elite.history) || []).map((h) => [h.gd, h]));
  const top = (g) => el[g]?.avg?.["100"] ?? null;
  const hasTop = gds.some((g) => top(g) != null),
    est = gds.some((g) => el[g]?.est);
  // the gap counts only the rounds both have
  const byGd = Object.fromEntries(rs.map((r) => [r.gd, r.pts]));
  const vs = (name, val) => {
    const have = gds.filter((g) => val(g) != null),
      v = have.reduce((s, g) => s + val(g), 0),
      m = have.reduce((s, g) => s + byGd[g], 0);
    return `${esc(name)} ${f0(v)}${have.length < gds.length ? ` (${have.length} of ${gds.length} rounds)` : ""} <span class="${m >= v ? "good" : "bad"}">${sgn(m - v, 0) || "0"}</span>`;
  };
  const cmp = teams.map(({ t, by }) => vs(t.name, (g) => by[g]));
  if (hasTop) cmp.push(vs(`top-100 average${est ? " (partly estimated)" : ""}`, top));
  const nReb = rs.filter((r) => r.src === "Rebuilt").length,
    nFro = rs.filter((r) => r.src === "Frozen").length;
  $("#hdModelNote").textContent = `${span} · ${nFro} frozen, ${nReb} rebuilt`;
  $("#hdModelSum").innerHTML =
    `<b>${f0(total)} pts</b> over ${span}` +
    (cmp.length ? ` · against it: ${cmp.join(" · ")}` : " · sign in to compare your own teams");
  const moves = (r) => {
    if (!r.start.length) return "Fresh pick";
    const outs = r.start.filter((id) => !r.ids.includes(id)),
      ins = r.ids.filter((id) => !r.start.includes(id));
    if (!ins.length) return '<span class="muted">No transfers</span>';
    return (
      outs.map((id) => code(byId[id])).join(", ") +
      " → " +
      ins.map((id) => code(byId[id])).join(", ") +
      (r.penalty ? ` <span class="bad">(−${r.penalty})</span>` : "")
    );
  };
  const rows = rs
    .slice()
    .reverse()
    .map(
      (r) =>
        `<tr><td${r.gd === gd ? ' style="background:var(--accent-soft)"' : ""}>R${r.gd}</td><td class="muted">${r.src}</td>` +
        `<td style="text-align:left"><div class="chips">${hdChips(r.ids, r.boost, null, r.start.length ? r.start : null, r.gd, "", null)}</div></td>` +
        `<td style="text-align:left">${moves(r)}</td><td class="muted">${r.free ?? "∞"}</td><td class="muted">${money(r.budget)}</td>` +
        `<td class="muted">${f0(r.x)}</td><td><b>${r.pts}</b></td><td>${f0(r.total)}</td>` +
        teams
          .map(({ by }) => {
            const v = by[r.gd];
            return v == null ? '<td class="dim">—</td>' : `<td${heat(r.pts - v, -60, 60)}>${v}</td>`;
          })
          .join("") +
        (hasTop ? `<td class="muted">${f0(top(r.gd))}</td>` : "") +
        "</tr>",
    );
  $("#hdModel").innerHTML =
    `<thead><tr><th>Round</th><th title="Frozen before lock, or rebuilt afterwards from the data as it stood">Projection</th><th style="text-align:left">Line-up</th><th style="text-align:left">Transfers</th><th title="Free transfers going in">Free</th><th title="Budget going in">Budget</th><th title="Projected points of the pick, after penalties">xPts</th><th>Pts</th><th>Total</th>` +
    teams
      .map(({ t }) => `<th title="Official round points; green where the model team beat it">${esc(t.name)}</th>`)
      .join("") +
    (hasTop
      ? `<th title="Average round score of the global top 100${est ? " (estimated from today's top 100 before R15)" : ""}">Top-100 avg</th>`
      : "") +
    `</tr></thead><tbody>${rows.join("")}</tbody>`;
}
