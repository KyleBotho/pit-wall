/* ---------- statistics: every asset, every round ---------- */
import { $, $$, DATA, Hind, byId, code, esc, f0, f1, money, sgn } from "./core.js";
import { state } from "./state.js";
import { heat, heatKey, who } from "./forecast.js";
import { teamKey } from "./league.js";
import { EVLABEL, SESSN, evLabel } from "./filters.js";
import { lineups } from "./hindsight-view.js";
const ST_METRICS = [
  ["pts", "Fantasy points"],
  ["ppm", "Points per $1m"],
  ["price", "Price"],
  ["delta", "Price change"],
  ["own", "Ownership %"],
  ["qpos", "Qualifying position"],
  ["rpos", "Race position"],
  ["pg", "Race places gained"],
];
export const stExcluded = () => new Set(state.stOff || []);
function stPts(h) {
  const off = stExcluded();
  if (!off.size) return h.pts;
  return (h.ev || []).reduce((s, [ni, v]) => s + (off.has(DATA.evNames[ni].c) ? 0 : v), 0);
}
function stValue(a, gd, m) {
  const h = Hind.at(a.id, gd);
  if (!h) return null;
  if (m === "pts") return stPts(h);
  if (m === "ppm") return stPts(h) / h.price;
  if (m === "price") return h.price;
  if (m === "delta") return Hind.delta(a.id, gd);
  if (m === "own") return h.own;
  if (a.kind !== "D") return null;
  const q = (DATA.results.quali[gd] || []).find((x) => x.tla === a.tla),
    r = (DATA.results.race[gd] || []).find((x) => x.tla === a.tla);
  if (m === "qpos") return q ? q.pos : null;
  if (m === "rpos") return r && r.cls ? r.pos : null;
  if (m === "pg") return r && r.cls ? r.grid - r.pos : null;
  return null;
}
const stFmt = (v, m) =>
  v == null
    ? ""
    : m === "price"
      ? v.toFixed(1)
      : m === "delta"
        ? sgn(v, 1)
        : m === "ppm"
          ? v.toFixed(1)
          : m === "own"
            ? f0(v)
            : f0(v);
function stHeat(v, m, lo, hi) {
  if (v == null) return "";
  if (m === "qpos" || m === "rpos") return heat(11.5 - v, -10.5, 10.5); // lower is better
  if (m === "price") return "";
  return heat(v, lo, hi);
}
export function renderStats() {
  const kind = state.stKind || "D",
    m = state.stMetric || "pts",
    done = DATA.done || [];
  $$("#stKind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sk === kind)));
  $("#stMetric").innerHTML = ST_METRICS.filter(([k]) => kind === "D" || !["qpos", "rpos", "pg"].includes(k))
    .map(([k, n]) => `<option value="${k}" ${k === m ? "selected" : ""}>${n}</option>`)
    .join("");
  const hi = state.stTeam ?? -1;
  $("#stTeam").innerHTML =
    `<button data-stt="-1" aria-pressed="${hi < 0}">None</button>` +
    state.teams
      .map((t, i) => `<button data-stt="${i}" aria-pressed="${hi === i}" title="${esc(t.name)}">T${i + 1}</button>`)
      .join("");

  // category toggles: whole sessions, then each category in them
  const off = stExcluded(),
    codes = [...new Set((DATA.evNames || []).map((e) => e.c))];
  $("#stCatField").hidden = !["pts", "ppm"].includes(m);
  $("#stCatN").textContent = `${codes.filter((c) => !off.has(c)).length} / ${codes.length}`;
  $("#stCats").innerHTML = ["Q", "S", "R"]
    .map((ss) => {
      const cs = codes.filter((c) => c[0] === ss).sort();
      if (!cs.length) return "";
      const all = cs.every((c) => !off.has(c));
      return `<div class="catrow"><button class="tbtn" data-stsess="${ss}" aria-pressed="${all}">${SESSN[ss]}</button>${cs.map((c) => `<button class="tbtn" data-stcat="${c}" aria-pressed="${!off.has(c)}" title="${esc(evLabel(c))}">${esc(EVLABEL[c.slice(2)] || c.slice(2))}</button>`).join("")}</div>`;
    })
    .join("");

  const assets = DATA.assets.filter((a) => a.kind === kind && a.hist.some((h) => h));
  const vals = Object.fromEntries(assets.map((a) => [a.id, done.map((g) => stValue(a, g, m))]));
  const avg = (xs) => {
    const v = xs.filter((x) => x != null);
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null;
  };
  const rows = assets.map((a) => ({ a, v: vals[a.id], avg: avg(vals[a.id]) }));
  const posM = m === "qpos" || m === "rpos",
    sort = state.stSort || { k: "avg", d: posM ? 1 : -1 }; // positions: best (lowest) first
  const key = (r) => (sort.k === "avg" ? r.avg : r.v[done.indexOf(+sort.k)]);
  rows.sort((x, y) => {
    const a = key(x),
      b = key(y);
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * sort.d;
  });
  const flat = rows.flatMap((r) => r.v).filter((v) => v != null),
    lo = Math.min(0, ...flat),
    hiV = Math.max(0, ...flat);

  // your team's picks that round: dashed = picked, solid = Boost, thick = X3 (needs unlocked leagues)
  const team = hi >= 0 ? state.teams[hi] : null,
    L = team ? lineups(teamKey(team)) : null;
  const pick = (id, g) => {
    if (!team) return "";
    const r = L && L[g];
    if (!r) return !L && team.team.includes(id) ? "hl" : "";
    return id === String(r.x3)
      ? "hl3"
      : id === String(r.boost)
        ? "hl2"
        : r.ids.includes(id) || (r.ff && r.ff.in === id)
          ? "hl"
          : "";
  };
  const th = (k, label, title) =>
    `<th class="sort" data-stsort="${k}" ${String(sort.k) === String(k) ? `aria-sort="${sort.d < 0 ? "descending" : "ascending"}"` : ""} title="${esc(title || "")}">${label}${String(sort.k) === String(k) ? (sort.d < 0 ? " ↓" : " ↑") : ""}</th>`;
  const sched = (g) => DATA.schedule.find((x) => x.gd === g) || {};
  $("#stTable").innerHTML =
    `<thead><tr><th>${kind === "D" ? "DR" : "CR"}</th>${th("avg", "AVG", "Average over the rounds shown")}${done.map((g) => th(g, `R${g}${sched(g).sprint ? "<sup>S</sup>" : ""}`, sched(g).name)).join("")}</tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td>${who(r.a)}</td><td${stHeat(r.avg, m, lo, hiV)}><b>${stFmt(r.avg, m)}</b></td>` +
          done
            .map((g, i) => {
              const h = Hind.at(r.a.id, g),
                v = r.v[i],
                cls = [pick(r.a.id, g), h && !h.active && r.a.kind === "D" ? "inact" : ""].filter(Boolean).join(" ");
              return `<td${stHeat(v, m, lo, hiV)}${cls ? ` class="${cls}"` : ""}${h ? ` data-stcell="${r.a.id}:${g}"` : ""}>${stFmt(v, m)}</td>`;
            })
            .join("") +
          "</tr>",
      )
      .join("") +
    `</tbody><tfoot><tr><td>AVG</td><td>${stFmt(avg(rows.map((r) => r.avg)), m)}</td>${done.map((g, i) => `<td>${stFmt(avg(rows.map((r) => r.v[i])), m)}</td>`).join("")}</tr></tfoot>`;
  $("#stKey").innerHTML =
    m === "price"
      ? ""
      : m === "qpos" || m === "rpos"
        ? heatKey("further back", "further up")
        : heatKey("lower", "higher");
  $("#stNote").textContent =
    `${ST_METRICS.find(([k]) => k === m)[1]} by round. Click a cell for that round's scoring lines; click a header to sort.` +
    (off.size && ["pts", "ppm"].includes(m)
      ? ` ${off.size} scoring categor${off.size > 1 ? "ies" : "y"} left out.`
      : "") +
    (team && !L
      ? " Unlock your leagues to highlight each round's picks; showing your current team."
      : team
        ? " Dashed = picked, solid = Boost, thick = X3."
        : "") +
    (posM ? " Blank = no classified result." : "");
}
export function stCell(id, gd) {
  const a = byId[id],
    h = Hind.at(id, gd),
    g = DATA.schedule.find((x) => x.gd === gd) || {};
  if (!h) return;
  const groups = {};
  for (const [ni, v, f] of h.ev || []) {
    const e = DATA.evNames[ni];
    (groups[e.s] = groups[e.s] || []).push({ n: e.n, f, v });
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  $("#modalBody").innerHTML =
    `<h3 id="modalTitle">${esc(code(a))} · R${gd} ${esc(g.name || "")}</h3>
    <div class="mline"><span>Price at lock</span><span>${money(h.price)} <span class="${Hind.delta(id, gd) >= 0 ? "good" : "bad"}">${sgn(Hind.delta(id, gd), 1)}</span></span></div>
    <div class="mline"><span>Owned by</span><span>${f1(h.own)}%</span></div>` +
    ["Q", "S", "R"]
      .filter((ss) => groups[ss])
      .map(
        (ss) =>
          `<div class="mline" style="margin-top:8px"><b>${SESSN[ss]}</b><b>${groups[ss].reduce((p, x) => p + x.v, 0)}</b></div>` +
          groups[ss]
            .map(
              (x) =>
                `<div class="mline"><span class="muted">${esc(cap(x.n.trim()))}${x.f && x.f !== "-" ? ` (${esc(x.f)})` : ""}</span><span class="${x.v < 0 ? "bad" : ""}">${x.v}</span></div>`,
            )
            .join(""),
      )
      .join("") +
    `<div class="mline" style="margin-top:8px"><b>Total</b><b>${f0(h.pts)}</b></div>${h.nn !== h.pts ? `<div class="mline"><span class="muted">With No Negative</span><span>${f0(h.nn)}</span></div>` : ""}`;
  $("#modal").hidden = false;
}
