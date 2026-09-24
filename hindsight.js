// @ts-check
/* Hindsight scoring: best teams on actual points, and F1's official round score rebuilt from a line-up.
   Pure functions over the page's DATA (no DOM). Inlined into the page after engine.js; loadable from node
   (tests/hindsight.test.js checks score() against official round scores).

   Scoring = each asset's round points, Boost 2x, X3 3x, -10 per transfer over the free ones; No Negative floors every
   negative scoring EVENT at 0 (the transfer penalty still applies); Final Fix splits the slot at the swap: the
   outgoing driver keeps the sessions before it, the incoming one scores from it on, and the slot keeps its Boost. */
(function (root) {
  const SESS_ORDER = { S: 0, Q: 1, R: 2 }; // a weekend runs Sprint, Qualifying, Race (ff.cat R = before the race)
  /** @type {Record<string, number>} */
  const ORDER = SESS_ORDER;

  /** @typedef {{ ids: string[], start: string[], boost?: string | number | null, x3?: string | number | null, budget?: number | null, free?: number | null, subs?: number | null, chip?: string | null, ff?: { out: string, in: string, cat: string } | null }} Lineup */

  /** @param {any} data the page's DATA @param {any} engine window.Engine / require("./engine.js") */
  function create(data, engine) {
    /** @type {Record<string, any>} */
    const byId = Object.fromEntries(data.assets.map((/** @type {any} */ a) => [a.id, a]));
    /** @type {Record<string, any>} */
    const runCache = {};
    /** @type {Record<string, any>} */
    const candCache = {};

    /** An asset's history row for a finished round, or null. @param {string} id @param {number} gd */
    const at = (id, gd) => (byId[id] && byId[id].hist[data.done.indexOf(gd)]) || null;
    /** Price change after that round: the next round's price (or today's, after the latest round). */
    const delta = (/** @type {string} */ id, /** @type {number} */ gd) => {
      const a = byId[id],
        k = data.done.indexOf(gd),
        h = a && a.hist[k];
      if (!h) return 0;
      const nx = a.hist[k + 1];
      return Math.round(((nx ? nx.price : a.price) - h.price) * 10) / 10;
    };
    /** Round points, No Negative floored if that chip is on. */
    const pts = (/** @type {string} */ id, /** @type {number} */ gd, /** @type {string} */ chip) => {
      const h = at(id, gd);
      return h ? (chip === "noneg" ? (h.nn ?? Math.max(0, h.pts)) : h.pts) : 0;
    };
    /** A team's budget that round; if the export didn't record one, what its line-up cost (never "no cap"). */
    const budget = (/** @type {Lineup} */ r, /** @type {number} */ gd) =>
      r.budget || Math.round(r.ids.reduce((s, id) => s + (at(id, gd)?.price || 0), 0) * 10) / 10;
    /** No line-up going in (the first round, or a Limitless round's empty start): a fresh pick. */
    const fresh = (/** @type {number} */ gd, /** @type {string[] | undefined} */ start) =>
      !start || !start.length || gd === data.schedule[0].gd;

    /** Optimiser candidates for a round, with per-asset filter properties (Δ$, ownership, points per category). */
    function cand(/** @type {number} */ gd, /** @type {string} */ chip) {
      const key = gd + "|" + (chip === "noneg" ? "nn" : "");
      if (!candCache[key])
        candCache[key] = data.assets
          .map((/** @type {any} */ a) => {
            const x = at(a.id, gd);
            if (!x) return null;
            /** @type {Record<string, number>} */
            const f = { d: delta(a.id, gd), own: x.own || 0, Q: 0, S: 0, R: 0 };
            for (const [ni, v] of x.ev || []) {
              const c = data.evNames[ni].c;
              f[c] = (f[c] || 0) + v;
              f[c[0]] += v;
            }
            const e = pts(a.id, gd, chip);
            return { id: a.id, kind: a.kind, price: x.price, e, boostE: a.kind === "D" ? e : 0, active: x.active, f };
          })
          .filter(Boolean);
      return candCache[key];
    }

    /** Best teams for a round: from scratch (no line-up going in) or from a team's line-up going into it.
     * @param {number} gd
     * @param {{ cap?: number | null, start?: string[], free?: number | null, chip?: string | null, filters?: any[], locks?: string[], bans?: string[], top?: number }} o */
    function run(gd, o) {
      const key = JSON.stringify([
        gd,
        o.cap,
        o.start || [],
        o.free || 0,
        o.chip || "",
        o.filters || [],
        o.locks || [],
        o.bans || [],
        o.top || 1,
      ]);
      if (!runCache[key]) {
        const isFresh = fresh(gd, o.start),
          ch = o.chip || "";
        const mode =
          o.cap == null || ch === "limitless"
            ? "limitless"
            : ch === "x3"
              ? "x3"
              : isFresh || ch === "wildcard"
                ? "wildcard"
                : "";
        runCache[key] = engine.optimise(cand(gd, ch), isFresh ? [] : o.start || [], {
          cap: o.cap ?? 1e9,
          free: isFresh ? 7 : o.free || 0,
          maxT: 7,
          chip: mode,
          locks: new Set(o.locks || []),
          bans: new Set(o.bans || []),
          top: o.top || 1,
          filters: o.filters,
        });
      }
      return runCache[key];
    }

    /** Points from the sessions before ("pre") or from ("post") a Final Fix swap. */
    function sess(
      /** @type {string} */ id,
      /** @type {number} */ gd,
      /** @type {string} */ cat,
      /** @type {"pre" | "post"} */ part,
    ) {
      const h = at(id, gd),
        k = ORDER[cat] ?? 2;
      if (!h) return 0;
      let s = 0;
      for (const [ni, v] of h.ev || []) if ((ORDER[data.evNames[ni].s] ?? 2) >= k === (part === "post")) s += v;
      return s;
    }

    /** The best single Final Fix swap on top of a team (within the budget): the new driver's points from the swap
     * on minus the old driver's, times the slot's Boost. */
    function ff(/** @type {any} */ t, /** @type {number} */ gd, /** @type {number | null} */ cap, cat = "R") {
      let best = null;
      for (const d of t.drivers) {
        const hd = at(d, gd);
        if (!hd) continue;
        const m = d === t.boost ? 2 : 1;
        for (const a of data.assets) {
          if (a.kind !== "D" || t.drivers.includes(a.id)) continue;
          const h = at(a.id, gd);
          if (!h || !h.active) continue;
          if (cap != null && t.cost - hd.price + h.price > cap + 1e-6) continue;
          const gain = (sess(a.id, gd, cat, "post") - sess(d, gd, cat, "post")) * m;
          if (!best || gain > best.gain) best = { out: d, in: a.id, cat, gain };
        }
      }
      return best && best.gain > 0 ? best : null;
    }
    const withFF = (/** @type {any} */ t, /** @type {number} */ gd, /** @type {number | null} */ cap) => {
      if (!t) return t;
      const f = ff(t, gd, cap);
      return f ? { ...t, score: t.score + f.gain, ff: f } : t;
    };

    /** Best reachable team from a line-up going into the round, with its budget, free transfers and chip. */
    function own(/** @type {Lineup} */ r, /** @type {number} */ gd) {
      const b = run(gd, { cap: budget(r, gd), start: r.start, free: r.free, chip: r.chip })[0] || null;
      return r.chip === "finalfix" ? withFF(b, gd, budget(r, gd)) : b;
    }

    /** F1's official round score for a line-up that was played, rebuilt from the assets' points. */
    function score(/** @type {Lineup} */ r, /** @type {number} */ gd) {
      const chip = r.chip || "",
        boost = String(r.boost ?? ""),
        x3 = String(r.x3 ?? ""),
        f = r.ff;
      const mult = (/** @type {string} */ id) => (chip === "x3" && id === x3 ? 3 : id === boost ? 2 : 1);
      let s = 0;
      for (const id of r.ids.map(String)) {
        if (f && id === String(f.out)) {
          const slot = boost === String(f.out) || boost === String(f.in) ? 2 : 1;
          s += (sess(id, gd, f.cat, "pre") + sess(String(f.in), gd, f.cat, "post")) * slot;
        } else s += pts(id, gd, chip) * mult(id);
      }
      const unlimited = chip === "wildcard" || chip === "limitless" || fresh(gd, r.start);
      return s - (unlimited ? 0 : 10 * Math.max(0, (r.subs || 0) - (r.free || 0)));
    }

    return { SESS_ORDER, byId, at, delta, pts, budget, fresh, cand, run, sess, ff, withFF, own, score };
  }

  const api = { create, SESS_ORDER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else /** @type {any} */ (root).Hindsight = api;
})(typeof window !== "undefined" ? window : globalThis);
