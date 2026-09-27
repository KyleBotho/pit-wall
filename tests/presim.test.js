// The build's sims (tools/presim.js) decode, in the page (web/js/presim.js), to exactly the default-settings run the
// page would do itself (Engine.forecastRaces): first part alone and both parts, both variants.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const zlib = require("node:zlib");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const E = require("../engine.js");
const { ROOT, loadData, pageModules } = require("./helpers.js");

const data = loadData();

test(
  "presim: shipped weekends and summaries match the page's own default run",
  { skip: !data && "no cache/data.json" },
  () => {
    // after lock with qualifying run (its order known), so both variants are shipped and differ in the coming race
    const next = data.schedule.find((g) => !data.done.includes(g.gd));
    const q = data.assets.filter((a) => a.kind === "D" && a.active).map((a) => a.tla);
    const D = {
      ...data,
      generated: new Date(Date.parse(next.lock) + 36e5).toISOString(),
      oddsLock: data.odds,
      weekend: { penalties: {}, ...data.weekend, gd: next.gd, grid: { q } },
    };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "presim-"));
    const res = spawnSync("node", [path.join(ROOT, "tools", "presim.js"), "--out", out], {
      input: JSON.stringify(D),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const meta = JSON.parse(res.stdout);
    assert.deepStrictEqual(Object.keys(meta.vars), ["lock", "live"]);
    const ab = (f) => {
      const b = zlib.gunzipSync(fs.readFileSync(path.join(out, f)));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    };
    const run = pageModules(
      ["presim.js"],
      { assets: [], schedule: [], done: [], cfg: { teams: {} } },
      {
        META: meta,
        A: ab(meta.files[0]),
        B: ab(meta.files[1]),
      },
    );
    const part = run("presimSamples(META, A, null)"),
      full = run("presimSamples(META, A, B)");
    assert.strictEqual(part.N, meta.first);
    assert.strictEqual(full.N, meta.N);

    const track = E.trackModel(D);
    const opts = {
      setup: (g, k) => ({
        next: k === 0,
        track,
        halfLife: E.DEFAULTS.halfLife,
        adj: {},
        pw: E.DEFAULTS.pw,
        oddsW: E.DEFAULTS.oddsW,
        pen: {},
        circuit: {},
      }),
      sprint0: !!next.sprint,
      sims: E.DEFAULTS.sims,
    };
    const finite = (x) =>
      typeof x === "number" ? Number.isFinite(x) : x && typeof x === "object" ? Object.values(x).every(finite) : true;
    for (const [v, ref] of [
      ["lock", E.forecastRaces(E.atLock(D), opts)],
      ["live", E.forecastRaces(D, opts)],
    ]) {
      assert.ok(finite(ref.setups[0]), `${v}: setup survives JSON`);
      assert.deepStrictEqual(meta.vars[v].setup, JSON.parse(JSON.stringify(ref.setups[0])), `${v}: setup`);
      ref.sims.forEach((sim, k) => {
        const { tot, nn, ...rest } = sim;
        assert.ok(finite(rest), `${v} R${k}: summaries survive JSON`);
        const shipped = meta.vars[v].sims[k] || meta.vars.lock.sims[k];
        if (v === "live") assert.strictEqual(meta.vars[v].sims[k] === null, k > 0, `live R${k}: shipped once`);
        assert.deepStrictEqual(shipped, JSON.parse(JSON.stringify(rest)), `${v} R${k}: summaries`);
        const N = sim.N,
          n = meta.first;
        for (const [name, arr] of [
          ["tot", tot],
          ["nn", nn],
        ]) {
          assert.deepStrictEqual(
            Array.from(full.vars[v][k][name]),
            Array.from(arr),
            `${v} R${k} ${name}: all weekends`,
          );
          const first = [];
          for (let i = 0; i < sim.ids.length; i++) first.push(...arr.subarray(i * N, i * N + n));
          assert.deepStrictEqual(Array.from(part.vars[v][k][name]), first, `${v} R${k} ${name}: the first part`);
        }
      });
    }
    fs.rmSync(out, { recursive: true, force: true });
  },
);
