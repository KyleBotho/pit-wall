// The page's forecast run at build time with the default settings (Engine.forecastRaces, as web/js/forecast.js runs
// it), so a visitor who hasn't changed a sim setting doesn't run 10,000 weekends x 3 races on their own device (the
// user's call, 2026-09-27). Two variants: "lock" (the data as at lock, Engine.atLock) and, once lock has passed,
// "live" (qualifying and all). Data (DATA as refresh.py builds it) on stdin; --out <dir> gets the samples, stdout the
// summaries (meta, embedded as DATA.presim).
// Samples: every asset's points (tot) and No Negative points (nn) per simulated weekend (whole points), one byte each
// minus the lowest (fmt "u8", lo) or else little-endian int16 (fmt "i16"), gzipped (the page unzips them itself: a
// .bin file may not be compressed on the way), in two files: part a = weekends [0, first), part b = [first, N). The
// page shows part a (the first 4,000 weekends, a valid sample of their own) and updates itself once part b is in. In
// each part, for each variant, race, array (tot, nn) and asset (the sim's ids order): its weekends of the part. A
// race that's the same in a later variant as in "lock" is null there (no samples).
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const same = (a, b) =>
  a.tot.every((x, i) => x === b.tot[i]) &&
  a.nn.every((x, i) => x === b.nn[i]) &&
  JSON.stringify({ ...a, tot: 0, nn: 0, ev: 0 }) === JSON.stringify({ ...b, tot: 0, nn: 0, ev: 0 });

// a sim's summary goes into the page as JSON: a typed array there (a new per-sample field) would ship as an object
// of every sample (sim.ev did, +360 KB, 2026-09-28), so any is refused here
function summary(rest) {
  for (const [k, v] of Object.entries(rest))
    if (ArrayBuffer.isView(v)) throw new Error(`presim: sim.${k} is per sample; leave it out of the page's summaries`);
  return rest;
}

function run(data, first) {
  const next = data.schedule.find((g) => !data.done.includes(g.gd));
  if (!next) return null;
  const track = E.trackModel(data);
  const D = E.DEFAULTS;
  // web/js/forecast.js setupOpts with every setting at its default (state.js defaults())
  const opts = {
    setup: (g, k) => ({
      next: k === 0,
      track,
      halfLife: D.halfLife,
      adj: {},
      pw: D.pw,
      oddsW: D.oddsW,
      pen: {},
      circuit: {},
    }),
    sprint0: !!next.sprint,
    sims: D.sims,
  };
  const inputs = { lock: E.atLock(data) };
  if (E.pastLock(data)) inputs.live = data;
  const variants = Object.fromEntries(Object.entries(inputs).map(([v, d]) => [v, E.forecastRaces(d, opts)]));
  // the same run cut at `first` weekends (the prefix of the full run: the streams don't depend on N), for the
  // summaries the page shows while only part a is in (third review: the full run's means over part a's samples)
  const heads = Object.fromEntries(
    Object.entries(inputs).map(([v, d]) => [v, E.forecastRaces(d, { ...opts, sims: first })]),
  );
  const N = D.sims;
  const parts = [[], []];
  const vars = {};
  for (const [v, f] of Object.entries(variants)) {
    vars[v] = {
      setup: f.setups[0],
      first: heads[v].sims.map((sim, k) => {
        const full = f.sims[k];
        for (let i = 0; i < sim.ids.length; i++)
          for (let s = 0; s < first; s++)
            if (sim.tot[i * first + s] !== full.tot[i * N + s])
              throw new Error("the short run isn't the full run's prefix");
        if (v !== "lock" && same(full, variants.lock.sims[k])) return null;
        const { tot, nn, ev, ...rest } = sim; // ev (per-sample flags): backtests only
        return summary(rest);
      }),
      sims: f.sims.map((sim, k) => {
        if (sim.N !== N) throw new Error(`expected ${N} weekends, got ${sim.N}`);
        // a race the same as in "lock" (the later races: only the coming one knows about lock) isn't shipped twice
        if (v !== "lock" && same(sim, variants.lock.sims[k])) return null;
        for (const arr of [sim.tot, sim.nn]) {
          for (let i = 0; i < sim.ids.length; i++) {
            const row = Int16Array.from(arr.subarray(i * N, (i + 1) * N), (x) => {
              if (x !== Math.round(x) || Math.abs(x) > 32767) throw new Error(`not whole points: ${x}`);
              return x;
            });
            parts[0].push(row.subarray(0, first));
            parts[1].push(row.subarray(first));
          }
        }
        const { tot, nn, ev, ...rest } = sim; // ev (per-sample flags): backtests only
        return summary(rest);
      }),
    };
  }
  // one byte a weekend when the points span at most 256 values (they do: about -60..150), stored minus the lowest
  let lo = Infinity,
    hi = -Infinity;
  for (const p of parts)
    for (const row of p)
      for (const x of row) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
  const u8 = hi - lo <= 255;
  const bufs = parts.map((p) => {
    const n = p.reduce((t, r) => t + r.length, 0),
      arr = u8 ? new Uint8Array(n) : new Int16Array(n);
    let o = 0;
    for (const row of p) {
      if (u8) for (let j = 0; j < row.length; j++) arr[o + j] = row[j] - lo;
      else arr.set(row, o);
      o += row.length;
    }
    return zlib.gzipSync(Buffer.from(arr.buffer), { level: 9 });
  });
  return { gd: next.gd, N, first, fmt: u8 ? "u8" : "i16", lo: u8 ? lo : 0, vars, bufs };
}

let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  const data = JSON.parse(s);
  const out = arg("--out");
  const res = run(data, +arg("--first", 4000));
  for (const f of fs.readdirSync(out)) if (/^presim-.*\.bin$/.test(f)) fs.unlinkSync(path.join(out, f));
  if (!res) {
    process.stdout.write("null");
    return;
  }
  // content-named files: a new build never meets an old file in the browser's cache
  const hash = crypto.createHash("sha256").update(res.bufs[0]).update(res.bufs[1]).digest("hex").slice(0, 12);
  const files = ["a", "b"].map((p) => `presim-${hash}-${p}.bin`);
  res.bufs.forEach((b, i) => fs.writeFileSync(path.join(out, files[i]), b));
  const { bufs, ...meta } = res;
  process.stdout.write(JSON.stringify({ ...meta, files }));
});
