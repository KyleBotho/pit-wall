/* ---------- the Sim lab's own data (user, 2026-09-28) ----------
   refresh.py lab_split keeps what only the owner-only Sim lab uses (Model health, the challengers' inputs: the pooled
   race pace, safety car timings) out of the page everyone downloads, in lab-<hash>.json next to index.html
   (DATA.labFile). Fetched for owners and admins only and merged into DATA; the engine worker then gets the data again
   (worker.js dataChanged). State: "idle" (not asked for), "loading", "ready" (merged), "error" (failed: the lab
   offers a retry). Fifth review: a failure is retried rather than kept, and every attempt that ends tells its
   caller (onDone), so the lab always redraws. */
import { DATA } from "./core.js";
import { dataChanged } from "./worker.js";

const load = { state: "idle", p: /** @type {Promise<boolean> | null} */ (null) };
export const labDataState = () => load.state;
/** Load the lab's data (once; again after a failure): resolves true once it's merged, false if it failed; onDone(ok)
 * runs when an attempt this call started ends. */
export function labData(onDone) {
  if (load.state === "loading" || load.state === "ready") return load.p;
  if (!DATA.labFile) {
    load.state = "ready"; // a build without a lab file: nothing to wait for
    return (load.p = Promise.resolve(true));
  }
  load.state = "loading";
  load.p = fetch(DATA.labFile)
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((x) => {
      mergeLab(x);
      load.state = "ready";
      return true;
    })
    .catch(() => {
      load.state = "error";
      return false;
    })
    .then((ok) => {
      if (onDone) onDone(ok);
      return ok;
    });
  return load.p;
}
/** The payload into DATA: whole keys (modelHealth), and fields into raceInfo's blocks and the priors' rows. */
export function mergeLab(x) {
  if (x.modelHealth) DATA.modelHealth = x.modelHealth;
  for (const [gd, blocks] of Object.entries(x.raceInfo || {}))
    for (const [s, f] of Object.entries(blocks)) {
      const b = DATA.raceInfo && DATA.raceInfo[gd] && DATA.raceInfo[gd][s];
      if (b) Object.assign(b, f);
    }
  const rows = (DATA.priors && DATA.priors.races) || [];
  for (const [i, f] of Object.entries(x.priorRows || {})) if (rows[i]) Object.assign(rows[i], f);
  dataChanged();
}
// settings that read the lab's data (the challengers' inputs): a lab run with them waits for it, and won't run
// without it (the engine would quietly fall back to the shipped inputs)
const NEEDS_LAB = { "MODEL.racePace": (v) => v === "pool", "SIM.scTimed": (v) => !!v };
export const needsLabData = (set) => Object.entries(set).some(([k, v]) => NEEDS_LAB[k] && NEEDS_LAB[k](v));
