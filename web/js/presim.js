/* ---------- the build's default-settings sims (tools/presim.js): decoding the shipped samples (pure) ----------
   meta = DATA.presim; a = part a (weekends [0, first)), b = part b ([first, N)) or null, both unzipped (gunzip).
   Returns N and, per variant, per race, the tot / nn arrays laid out as Engine.simulate's (asset i's weekend s at
   i * N + s). Values are one byte each plus meta.lo ("u8") or int16 ("i16"). A null race in a variant is the
   same as in "lock" (tools/presim.js). */
export function presimSamples(meta, a, b) {
  const T = meta.fmt === "u8" ? Uint8Array : Int16Array,
    A = new T(a),
    B = b ? new T(b) : null,
    lo = meta.lo || 0,
    n1 = meta.first,
    n2 = meta.N - meta.first,
    N = B ? meta.N : n1;
  let pa = 0,
    pb = 0;
  const vars = {};
  for (const [v, x] of Object.entries(meta.vars))
    vars[v] = x.sims.map((sim, k) => {
      if (!sim) return vars.lock[k]; // the same as in "lock"
      const o = {};
      for (const k of ["tot", "nn"]) {
        const arr = new Float32Array(sim.ids.length * N);
        for (let i = 0; i < sim.ids.length; i++) {
          for (let s = 0; s < n1; s++) arr[i * N + s] = A[pa + s] + lo;
          pa += n1;
          if (B) {
            for (let s = 0; s < n2; s++) arr[i * N + n1 + s] = B[pb + s] + lo;
            pb += n2;
          }
        }
        o[k] = arr;
      }
      return o;
    });
  if (pa !== A.length || (B && pb !== B.length)) throw new Error("presim: the samples don't match the summaries");
  return { N, vars };
}
// a gzipped part (the build zips them), unzipped in the browser; anything else is returned as it came
export async function gunzip(buf) {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x1f || u[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}
