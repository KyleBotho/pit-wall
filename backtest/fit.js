// Fit the simulation's settings on this season, walk-forward (npm run fit). Coordinate descent: each setting in
// turn tries a few values with the others held, keeping whichever gives the lowest CRPS of the projected points
// (CRPS rewards both a good mean and an honest spread). Prints the best values; copy them into engine.js (SIM /
// MODEL, marked "fitted") and re-run `npm run backtest`. Uses the same rounds and seeds for every trial (common
// random numbers), so differences are the settings', not the dice's.
const W = require("./walk.js");
const { E } = W;

const N = +(process.env.FIT_N || 4000);
const PASSES = +(process.env.FIT_PASSES || 1);
// [object, key, candidate values]
const SPACE = [
  [E.MODEL, "paceShrink", [0.5, 0.6, 0.7, 0.8, 0.9, 1]],
  [E.SIM, "qSd", [0.12, 0.16, 0.2, 0.25, 0.3, 0.4]],
  [E.SIM, "rSd", [0.15, 0.2, 0.25, 0.3, 0.4, 0.5]],
  [E.SIM, "teamSd", [0, 0.05, 0.1, 0.15, 0.2]],
  [E.SIM, "drvSd", [0, 0.05, 0.08, 0.12, 0.16]],
  [E.SIM, "tau", [0.02, 0.03, 0.04, 0.05, 0.07, 0.1]],
  [E.SIM, "unc", [0, 0.5, 1, 1.5]],
  [E.SIM, "scNoise", [1, 1.2, 1.35, 1.6, 2]],
  [E.SIM, "incident", [0, 0.15, 0.3, 0.45]],
  [E.SIM, "oddsW", [0, 0.25, 0.5, 0.75, 1]],
  [E.SIM, "flDecay", [0.8, 1.1, 1.6, 2.2]],
  [E.SIM, "scPerDnf", [0.05, 0.1, 0.15, 0.25]],
  [E.MODEL, "prior", [0.5, 1, 1.5, 3, 5]],
  [E.MODEL, "gapCap", [2, 3, 4, 6]],
  [E.MODEL, "ovShrink", [3, 6, 12, 25, 1e6]],
  [E.SIM, "ovModel", [0, 1]],
  [E.SIM, "pitStops", [0, 1]],
];

const score = () => W.evaluate({ N, seed: 3 });
const fmt = (r) =>
  `CRPS ${r.crps.toFixed(3)}  MAE ${r.mae.toFixed(3)}  rho ${r.rho.toFixed(3)}  80% ${(100 * r.cover80).toFixed(1)}%  50% ${(100 * r.cover50).toFixed(1)}%  logQ ${r.lsQ.toFixed(3)}  logR ${r.lsR.toFixed(3)}`;

let best = score();
console.log(`start      ${fmt(best)}`);
for (let pass = 0; pass < PASSES; pass++)
  for (const [obj, key, vals] of SPACE) {
    const keep = obj[key];
    let bestV = keep;
    for (const v of vals) {
      if (v === keep) continue;
      obj[key] = v;
      const r = score();
      if (r.crps < best.crps - 0.005) {
        best = r;
        bestV = v;
      }
    }
    obj[key] = bestV;
    console.log(`${key.padEnd(10)} ${String(bestV).padEnd(6)} ${fmt(best)}`);
  }
console.log("\nbest settings:");
for (const [obj, key] of SPACE) console.log(`  ${obj === E.SIM ? "SIM" : "MODEL"}.${key} = ${obj[key]}`);
