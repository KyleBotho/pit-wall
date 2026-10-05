// Walk-forward projected minus actual points per team (drivers + constructor), shipped model vs pace variants: is one
// team projected too low or too high over a run of rounds (Red Bull R13-R16, 2026-10-05), and does a variant fix it?
//   node backtest/team_bias.js [from] [to]        (default 5 .. the last finished round; N=3000 sims, seeds 1-3)
// Bias = projected - actual (negative = projected too low), the mean per team-round of the team's drivers and
// constructor together. Needs cache/data.json (python refresh.py).
const { D, E, evaluate, mean } = require("./walk.js");

if (!D) {
  console.error("No cache/data.json: run python refresh.py first.");
  process.exit(1);
}
const from = +(process.argv[2] || 5),
  to = +(process.argv[3] || D.done[D.done.length - 1]);
const N = +(process.env.EXP_N || 3000),
  seeds = [1, 2, 3].slice(0, +(process.env.EXP_SEEDS || 3));
const VARIANTS = [
  ["shipped", {}, {}],
  ["half-life 2", {}, { halfLife: 2 }],
  ["half-life 6", {}, { halfLife: 6 }],
  ["shrink 0.9", { "MODEL.paceShrink": 0.9 }, {}],
  ["no shrink", { "MODEL.paceShrink": 1 }, {}],
];
// a team per asset: a driver's team, a constructor's own name (the feed's names differ only in "F1 Team")
const teamOf = (r) => (r.team || "").replace(/ F1 Team$/, "");
const rows = [];
for (const [label, set, opt] of VARIANTS) {
  const recs = E.withSettings(set, () =>
    seeds.flatMap((seed) => evaluate({ N, seed, ...opt }).recs.filter((r) => r.gd >= from && r.gd <= to)),
  );
  const by = {};
  for (const r of recs) (by[teamOf(r)] ||= {})[r.gd] = ((by[teamOf(r)] || {})[r.gd] || 0) + r.bias / seeds.length;
  rows.push([label, by]);
}
const teams = Object.keys(rows[0][1]).sort();
const last4 = [to - 3, to - 2, to - 1, to];
console.log(
  `Projected - actual points per team-round (drivers + constructor), R${from}-R${to}, ${seeds.length} x ${N}`,
);
console.log(`${"team".padEnd(16)}` + rows.map(([l]) => l.padStart(14)).join("") + `   (R${from}-R${to} / last 4)`);
for (const t of teams) {
  const cells = rows.map(([, by]) => {
    const r = by[t] || {};
    const all = mean(Object.values(r)),
      l4 = mean(last4.filter((g) => g in r).map((g) => r[g]));
    return `${all >= 0 ? "+" : ""}${all.toFixed(1)}/${l4 >= 0 ? "+" : ""}${l4.toFixed(1)}`.padStart(14);
  });
  console.log(t.padEnd(16) + cells.join(""));
}
const shipped = rows[0][1]["Red Bull Racing"] || rows[0][1]["Red Bull"] || {};
console.log(
  `\nRed Bull per round, shipped: ` +
    Object.entries(shipped)
      .map(([g, b]) => `R${g} ${b >= 0 ? "+" : ""}${b.toFixed(0)}`)
      .join(", "),
);
