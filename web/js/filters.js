/* ---------- team filters (Best Teams and Hindsight) ---------- */
import { DATA, byId, code, esc, f0, money } from "./core.js";
import { state } from "./state.js";
// Rules of property + min/max, applied inside the optimiser. Per-asset properties are summed over the 7 assets
// (before Boost); "score" is the team's points after Boost and penalties.
const EVC = [...new Set((DATA.evNames || []).map((e) => e.c))].sort();
export const EVLABEL = {
  POS: "position",
  PG: "places gained",
  PL: "places lost",
  OV: "overtakes",
  FL: "fastest lap",
  DOTD: "Driver of the Day",
  NC: "not classified",
  DQ: "disqualified",
  TW: "Q2/Q3 bonus",
  FP: "fastest pit stop",
  FP2: "2nd fastest pit stop",
  PIT: "pit stops",
  WRFP: "world-record stop",
  OTH: "other",
};
export const SESSN = { Q: "Qualifying", S: "Sprint", R: "Race" };
export const evLabel = (c) => `${SESSN[c[0]] || c[0]} ${EVLABEL[c.slice(2)] || c.slice(2)}`;
export function fprops(scope) {
  if (scope === "calc")
    return [
      ["score", "Team xPts"],
      ["cost", "Cost ($m)"],
      ["d", "xΔ$ (sum)"],
      ["dnf", "Expected DNFs"],
      ["fl", "Fastest-lap odds (sum)"],
      ["dotd", "DotD odds (sum)"],
      ["ov", "Expected overtakes"],
      ["neg", "Expected negative points"],
    ];
  return [
    ["score", "Team points"],
    ["cost", "Cost ($m)"],
    ["d", "Δ$ (sum)"],
    ["own", "Ownership % (sum)"],
    ["Q", "Qualifying points"],
    ["S", "Sprint points"],
    ["R", "Race points"],
  ].concat(EVC.map((c) => [c, evLabel(c) + " points"]));
}
export const filters = (scope) => ((state.filters || {})[scope] || []).filter((f) => f.min != null || f.max != null);
export function filterUI(scope) {
  const rules = (state.filters || {})[scope] || [],
    props = fprops(scope);
  return (
    rules
      .map(
        (
          f,
          i,
        ) => `<div class="frule"><select data-flt="${scope}:${i}:k" aria-label="Filter property">${props.map(([k, n]) => `<option value="${k}" ${k === f.k ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <input class="inp" type="number" step="any" placeholder="min" aria-label="Minimum" data-flt="${scope}:${i}:min" value="${f.min ?? ""}"><input class="inp" type="number" step="any" placeholder="max" aria-label="Maximum" data-flt="${scope}:${i}:max" value="${f.max ?? ""}">
      <button class="tbtn ban" data-fdel="${scope}:${i}" aria-label="Remove filter">✕</button></div>`,
      )
      .join("") +
    `<div class="chipbar"><button class="btn ghost sm" data-fadd="${scope}">+ Add filter</button>${rules.length ? `<button class="btn ghost sm" data-fclear="${scope}">Clear filters</button>` : ""}</div>`
  );
}
export const teamText = (label, cons, drs, boost, x3, cost, pts) =>
  `${label}: ${cons.map((id) => code(byId[id])).join(", ")} | ` +
  drs.map((id) => code(byId[id]) + (id === x3 ? " (3×)" : id === boost ? " (2×)" : "")).join(", ") +
  ` | ${money(cost)} | ${f0(pts)} pts`;
