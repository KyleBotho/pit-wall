/* ---------- the engine worker: simulations off the main thread (reviews' deferred item, 2026-09-28) ----------
   One worker for the Sim lab's runs and the Calculator's own (any non-default sim setting: the build's presim covers
   the defaults), so a run of 3 x 10,000 weekends doesn't freeze the page. Built in the page from its own engine
   script (the CSP allows blob: workers) plus the job functions below, injected as source: they may use only their
   arguments. The data goes over once. inWorker() rejects where a worker can't start or fails; callers then run the
   same job function here, so the answer is the same either way (same seeds). */
import { DATA } from "./core.js";

/** The Sim lab: one race under a set of switches (Engine.withSettings), setup and sims timed apart. */
export function labJob(E, data, job) {
  return E.withSettings(job.set, () => {
    const t0 = performance.now();
    const tm = E.trackModel(data);
    // the Calculator's options; the lab's switches act through the engine settings (practiceQ inside buildModel),
    // except the market weight, which raceSetup takes as an option
    const setup = E.raceSetup(data, job.g, {
      ...job.opts,
      track: tm,
      ...("SIM.oddsW" in job.set ? { oddsW: E.SIM.oddsW } : {}),
    });
    const t1 = performance.now();
    const sim = E.simulate(setup.model, setup.circuit, job.sprint, job.N, job.seed, {
      ...setup.simOpt,
      persist: job.persist,
      trace: true,
    });
    return { setup, sim, msSetup: t1 - t0, ms: performance.now() - t1 };
  });
}
/** The Calculator: the next three races (Engine.forecastRaces) under the page's settings; job.opts[k] = setupOpts
 * without the track model, which is built once per variant from that variant's data (ctx.tm[v]: as at lock, the
 * practice frozen at lock sets the next race's overtake level, not the live one; fourth review). */
export function racesJob(E, data, job, ctx) {
  const d = job.v === "live" ? data : E.atLock(data);
  ctx.tm = ctx.tm || {};
  const tm = ctx.tm[job.v] || (ctx.tm[job.v] = E.trackModel(d));
  return E.forecastRaces(d, {
    setup: (g, k) => ({ ...job.opts[k], track: tm }),
    sprint0: job.sprint0,
    sims: job.sims,
  });
}
/** One more run of a race already set up (the Calculator's near-tie check). */
export function simJob(E, data, job) {
  return E.simulate(job.model, job.circuit, job.sprint, job.N, job.seed, job.opt);
}

// two runs of the same race (the same assets in the same order) as one: each asset's weekends one after the other.
// Only the samples (ids, N, tot, nn, batches): the runs' summaries and flags describe one batch each, so they're left
// out rather than passed on under the combined N (fourth review). a null = b alone, as the same narrow object.
export function mergeRuns(a, b) {
  if (!a) return { ids: b.ids, N: b.N, tot: b.tot, nn: b.nn, batches: 1 };
  const A = a.ids.length,
    n = a.N + b.N,
    out = { ids: a.ids, N: n, batches: (a.batches || 1) + 1 };
  for (const k of ["tot", "nn"]) {
    const x = new Float32Array(A * n);
    for (let i = 0; i < A; i++) {
      x.set(a[k].subarray(i * a.N, (i + 1) * a.N), i * n);
      x.set(b[k].subarray(i * b.N, (i + 1) * b.N), i * n + a.N);
    }
    out[k] = x;
  }
  return out;
}

let worker = null,
  tried = false,
  sent = false,
  seq = 0;
const waiting = new Map();
function fail(err) {
  worker = null;
  for (const w of waiting.values()) w.reject(err);
  waiting.clear();
}
function engineWorker() {
  if (tried) return worker;
  tried = true;
  try {
    // the engine script: it starts with its header (the bundle only quotes it, mid-text)
    const eng = [...document.scripts].find((s) =>
      /^\s*\/\/ @ts-check\s+\/\* Pit Wall engine/.test(s.textContent || ""),
    );
    if (!eng || typeof Worker === "undefined") return null;
    const code =
      eng.textContent +
      `
const JOBS = { lab: ${labJob.toString()}, races: ${racesJob.toString()}, sim: ${simJob.toString()} };
const ctx = {};
let data = null;
self.onmessage = (e) => {
  if (e.data.data) data = e.data.data;
  try {
    const out = e.data.jobs.map((j) => JOBS[e.data.kind](self.Engine, data, j, ctx));
    self.postMessage({ id: e.data.id, out });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err) });
  }
};`;
    worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error));
      else w.resolve(e.data.out);
    };
    worker.onerror = () => fail(new Error("engine worker failed"));
  } catch {
    worker = null;
  }
  return worker;
}
/** Whether jobs can go to the worker (it starts on first use). */
export const workerOk = () => !!engineWorker();
/** Run jobs of a kind ("lab", "races", "sim") in the worker: a promise of their results, in order. */
export function inWorker(kind, jobs) {
  const w = engineWorker();
  if (!w) return Promise.reject(new Error("no engine worker"));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    try {
      w.postMessage(sent ? { id, kind, jobs } : { id, kind, jobs, data: DATA });
      sent = true;
    } catch (err) {
      waiting.delete(id);
      reject(err);
    }
  });
}
