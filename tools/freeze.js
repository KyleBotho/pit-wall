// What refresh.py freezes for the coming race before lock (history/<season>/...): the shipped model's projection with
// its record (engine.project, detail), the challengers' projections (engine.projectChallengers) and, with --samples n,
// the first n joint samples of every asset as gzipped little-endian int16, base64 (ids in model order; sample k of
// asset i at i * n + k). Data (DATA as refresh.py builds it) on stdin; JSON on stdout.
const zlib = require("node:zlib");
const E = require("../engine.js");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  const data = JSON.parse(s);
  const samples = +(arg("--samples") || 0);
  const proj = E.project(data, { detail: true, samples });
  if (!proj) {
    process.stdout.write("null");
    return;
  }
  // the challengers, each with its input coverage and whether it came out as the shipped model (not evaluable)
  const out = { projection: proj, challengers: E.projectChallengers(data, undefined, proj), joint: null };
  if (proj.joint) {
    const { ids, n, tot } = proj.joint;
    const buf = Buffer.from(tot.buffer, tot.byteOffset, tot.byteLength);
    out.joint = { gd: proj.gd, ids, n, format: "int16le+gzip+base64", data: zlib.gzipSync(buf).toString("base64") };
    delete proj.joint;
  }
  process.stdout.write(JSON.stringify(out));
});
