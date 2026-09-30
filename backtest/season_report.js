// Season report (npm run report; the season fold-over runs it, .github/workflows/fold.yml): every challenger against
// the live model over this season's rounds, written to history/<season>/season-report.json for Settings > Admin and
// the Sim lab's Model health.
//   back    looking back: the walk-forward (the data as it stood before each round, today's engine) run once as
//           shipped and once under each challenger's settings, same seeds; the difference per round, its mean and
//           standard error over the rounds (the weekend is the independent unit), and the points of the team picked
//           on each one's projections. Not a test of a challenger built on these same rounds: an indication.
//   lock    at lock: the challengers frozen next to the shipped model before each round (backtest/accuracy.js, from
//           history/<season>/accuracy.json): the only figures from rounds a challenger hadn't seen.
// A challenger that never came out different from the live model (no rain forecast for the wet-qualifying skill, no
// sprint for the sprint skill, its input missing) says nothing, and is marked so.
const fs = require("node:fs");
const path = require("node:path");
const W = require("./walk.js");
const { D, E, mean } = W;

const N = +(process.env.REPORT_N || 10000);
const FROM = 5; // as the walk-forward everywhere: a few rounds of the season first
const ROOT = path.join(__dirname, "..");

/** Mean and standard error of per-round differences. @param {number[]} xs */
function paired(xs) {
  const m = mean(xs);
  const se = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) : null;
  return { d: m, se };
}
const r3 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);

/** What the figures say about one challenger ("lock" = frozen rounds, the test; "back" = looking back).
 * @param {{ differs: number, d: number | null, se: number | null }} back
 * @param {{ n: number, dqs: number | null, dqsSe: number | null } | null} lock */
function verdict(back, lock) {
  if (lock && lock.n >= 5 && lock.dqs != null && lock.dqsSe != null && Math.abs(lock.dqs) > 2 * lock.dqsSe)
    return lock.dqs < 0 ? "better-lock" : "worse-lock";
  if (!back.differs) return "same";
  if (back.d == null || back.se == null || Math.abs(back.d) <= 2 * back.se) return "noise";
  return back.d < 0 ? "better-back" : "worse-back";
}

function report() {
  const certified = D.done.filter((gd) => {
    const g = D.schedule.find((x) => x.gd === gd);
    return g && g.certified !== false;
  });
  const rounds = certified.filter((gd) => gd >= FROM);
  if (!rounds.length) return null;
  const run = () => W.evaluate({ N, rounds, decision: true });
  const live = run();
  const arch = path.join(ROOT, "history", String(D.season));
  const read = (f) =>
    fs.existsSync(path.join(arch, f)) ? JSON.parse(fs.readFileSync(path.join(arch, f), "utf8")) : null;
  const acc = read("accuracy.json");
  const frozen = Object.fromEntries((((acc && acc.challengers) || {}).summary || []).map((s) => [s.id, s]));
  const challengers = E.CHALLENGERS.map((c) => {
    const ev = E.withSettings(c.set, run);
    const dc = ev.byRound.map((b, i) => b.crps - live.byRound[i].crps);
    const { d, se } = paired(dc);
    const back = {
      n: rounds.length,
      // rounds where it came out different from the live model at all
      differs: dc.filter((x, i) => Math.abs(x) > 1e-9 || Math.abs(ev.byRound[i].mae - live.byRound[i].mae) > 1e-9)
        .length,
      d: r3(d),
      se: r3(se),
      dMae: r3(paired(ev.byRound.map((b, i) => b.mae - live.byRound[i].mae)).d),
      dTeam: Math.round(ev.team - live.team),
      cover80: r3(ev.cover80),
    };
    const f = frozen[c.id];
    const lock = f ? { n: f.n, skipped: f.skipped || 0, dqs: f.dqs, dqsSe: f.dqsSe, dmae: f.dmae } : null;
    return {
      id: c.id,
      label: c.label,
      coverage: c.needs ? c.needs(D) : null,
      back,
      lock,
      verdict: verdict(back, lock),
    };
  });
  const base = W.baselines();
  return {
    generated: new Date().toISOString().slice(0, 16) + "Z",
    season: D.season,
    final: !D.schedule.some((g) => !D.done.includes(g.gd)), // the season's last race is in
    from: rounds[0],
    to: rounds[rounds.length - 1],
    rounds: rounds.length,
    N,
    live: {
      crps: r3(live.crps),
      mae: r3(live.mae),
      cover80: r3(live.cover80),
      cover50: r3(live.cover50),
      team: Math.round(live.team),
      best: Math.round(live.best),
      seasonAvg: r3(base.seasonAvg),
      form: r3(base.form),
    },
    challengers,
  };
}

if (require.main === module) {
  if (!D) {
    console.log("  season report: no cache/data.json (run python refresh.py first): skipped");
    process.exit(0);
  }
  const t0 = Date.now();
  const out = report();
  if (!out) {
    console.log(`  season report: no certified round from R${FROM} yet: skipped`);
    process.exit(0);
  }
  const file = path.join(ROOT, "history", String(D.season), "season-report.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(
    `  season report ${out.season} R${out.from}-R${out.to}: live CRPS ${out.live.crps}; ` +
      out.challengers.map((c) => `${c.id} ${c.back.d > 0 ? "+" : ""}${c.back.d} (${c.verdict})`).join(", ") +
      ` (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
}
module.exports = { verdict, paired };
