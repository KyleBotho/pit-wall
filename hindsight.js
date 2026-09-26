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

  /** @typedef {{ ids: string[], start: string[], boost?: string | number | null, x3?: string | number | null, budget?: number | null, bank?: number | null, free?: number | null, subs?: number | null, chip?: string | null, ff?: { out: string, in: string, cat: string } | null }} Lineup */

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
      // an asset no longer in the game (a driver who moved team keeps his old asset, inactive): −25 each, −35 on a
      // sprint weekend (F1's inactive_driver_penality_points; seen on league rivals R12–R14)
      const inactive = r.ids.filter((id) => {
        const h = at(String(id), gd);
        return h && !h.active;
      }).length;
      const sprint = data.schedule.find((/** @type {any} */ x) => x.gd === gd)?.sprint;
      return s - (unlimited ? 0 : 10 * Math.max(0, (r.subs || 0) - (r.free || 0))) - inactive * (sprint ? 35 : 25);
    }

    /** The model team: a hands-off follower of the projections. A fresh $100m pick in the first projected round,
     * then each round the best team for that race alone on projected points, from last round's team, with its
     * budget (which moves with the price changes of the team held) and its free transfers (2 a race, one unused
     * carries: 3 max; −10 for each extra). The Boost goes to the top projected driver. No chips. A round without a
     * projection keeps the team. Scored on actual points with score().
     * @param {Record<string, Record<string, number>>} proj expected points per round per asset id
     * @param {{ cap?: number, perFree?: number, carryMax?: number }} [o] */
    function modelTeam(proj, o = {}) {
      const perFree = o.perFree ?? 2,
        carryMax = o.carryMax ?? 3,
        first = data.done.find((/** @type {number} */ g) => proj[g]);
      /** @type {any[]} */
      const out = [];
      if (first == null) return out;
      let budget = o.cap ?? 100,
        free = 0,
        /** @type {string[]} */ ids = [],
        boost = "",
        total = 0;
      for (const gd of data.done.filter((/** @type {number} */ g) => g >= first)) {
        const p = proj[gd],
          start = ids;
        let transfers = 0,
          penalty = 0,
          x = null;
        if (p) {
          const cs = data.assets
            .map((/** @type {any} */ a) => {
              const h = at(a.id, gd),
                e = p[a.id];
              if (!h || e == null) return null;
              return { id: a.id, kind: a.kind, price: h.price, e, boostE: a.kind === "D" ? e : 0, active: h.active };
            })
            .filter(Boolean);
          const isFresh = !start.length;
          const t = engine.optimise(cs, start, {
            cap: budget,
            free: isFresh ? 7 : free,
            maxT: 7,
            chip: isFresh ? "wildcard" : "",
            locks: new Set(),
            bans: new Set(),
            top: 1,
          })[0];
          if (t) {
            ids = t.drivers.concat(t.cons);
            boost = t.boost;
            transfers = isFresh ? 0 : t.transfers;
            penalty = t.penalty;
            x = t.score;
          }
        }
        const r = { ids, start, boost, free, subs: transfers, budget };
        const pts = score(r, gd);
        total += pts;
        const cost = Math.round(ids.reduce((s, id) => s + (at(id, gd)?.price || 0), 0) * 10) / 10;
        out.push({
          gd,
          ids,
          start,
          boost,
          transfers,
          penalty,
          free: start.length ? free : null,
          budget,
          cost,
          x,
          pts,
          total,
        });
        budget = Math.round((budget + ids.reduce((s, id) => s + delta(id, gd), 0)) * 10) / 10;
        free = !start.length ? perFree : Math.min(carryMax, perFree + Math.min(1, Math.max(0, free - transfers)));
      }
      return out;
    }

    const round1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
    const costAt = (/** @type {string[]} */ ids, /** @type {number} */ gd) =>
      round1(ids.reduce((s, id) => s + (at(id, gd)?.price || 0), 0));
    // chips tried when working a round out, fewest-assumption first: a chip is only credited when no plainer
    // explanation rebuilds the official score
    const TRY = ["", "noneg", "x3", "autopilot", "wildcard", "limitless", "finalfix"];

    /** Every (Boost, x3, chip, Final Fix) that rebuilds a round's official score from the line-up seen after it.
     * @param {string[]} ids the 7 assets that scored (after any Final Fix) @param {number} gd
     * @param {{ start: string[] | null, free: number | null, budget: number | null, used: Set<string>, pts: number }} o
     *   start null = the team going in is unknown (first seen mid-season): transfers unknown, up to 4 hits tried */
    function explain(ids, gd, o) {
      const drivers = ids.filter((id) => byId[id]?.kind === "D"),
        isFresh = gd === data.schedule[0].gd,
        start = o.start || ["?"], // score() treats an empty start as a fresh pick (no penalty)
        top = drivers.slice().sort((a, b) => pts(b, gd, "") - pts(a, gd, ""))[0];
      const subsOf = (/** @type {string[]} */ team) =>
        isFresh || !o.start ? 0 : team.filter((id) => !start.includes(id)).length;
      /** @type {any[]} */
      const hits = [];
      for (const chip of TRY) {
        if (chip && o.used.has(chip)) continue;
        /** @type {{ ids: string[], ff: any }[]} */
        const teams = [{ ids, ff: null }];
        if (chip === "finalfix") {
          // the seen team may be the qualifying team again (the swap lasts one race; the incoming driver is any driver
          // not in it) or hold the incoming driver (the one it replaced is any driver not in it). The swap is made
          // after qualifying (cat R), or on a sprint weekend also after sprint qualifying (cat S).
          teams.splice(0, 1);
          const sprint = data.schedule.find((/** @type {any} */ x) => x.gd === gd)?.sprint;
          for (const qualSeen of [true, false])
            for (const d of drivers)
              for (const a of data.assets) {
                if (a.kind !== "D" || ids.includes(a.id) || !at(a.id, gd)) continue;
                for (const cat of sprint ? ["R", "S"] : ["R"])
                  teams.push(
                    qualSeen
                      ? { ids, ff: { out: d, in: a.id, cat } }
                      : { ids: ids.map((id) => (id === d ? a.id : id)), ff: { out: a.id, in: d, cat } },
                  );
              }
        }
        for (const t of teams) {
          const subs = subsOf(t.ids);
          // a team over the budget can only be Limitless (and Limitless is only credited then); a Wildcard only when
          // it's needed (more transfers than free)
          const over = o.budget != null && costAt(t.ids, gd) > o.budget + 0.05;
          if (over !== (chip === "limitless")) continue;
          if (chip === "wildcard" && (o.free == null || subs <= o.free)) continue;
          const boosts = chip === "autopilot" ? [top] : drivers;
          const x3s = chip === "x3" ? drivers : [""];
          // free transfers unknown (no record to carry from): any number of −10 hits
          const unl = isFresh || chip === "wildcard" || chip === "limitless";
          const pens = unl ? 0 : !o.start ? 4 : o.free == null ? subs : 0;
          for (const x3 of x3s)
            for (const boost of boosts) {
              if (x3 && x3 === boost) continue;
              const r = { ids: t.ids, start, boost, x3, chip, ff: t.ff, subs, free: o.free ?? subs };
              const base = score(o.free == null ? { ...r, free: subs } : r, gd);
              for (let k = 0; k <= pens; k++)
                if (Math.abs(base - 10 * k - o.pts) < 0.5)
                  hits.push({
                    chip,
                    boost: t.ff && boost === t.ff.out ? t.ff.in : boost, // the slot's Boost, named as F1 does
                    x3: x3 || null,
                    ff: t.ff,
                    qual: t.ids,
                    subs: o.start ? subs : null,
                    free: o.free ?? (o.start ? subs - k : null),
                  });
            }
        }
        if (hits.length) break; // the plainest chip that explains it
      }
      return hits;
    }

    /** A team's season rebuilt from what's known: full records (an export) where they exist, else the line-up seen
     * after the race plus the official round points. For a seen round: transfers = assets not in the team held going
     * in; free transfers and budget carry on from the round before (2 free a race, one unused carries, none out of a
     * Wildcard or Limitless round; the budget moves with the price changes of the team held; a Limitless round
     * reverts to the team before it); Boost, x3 and chip = the plainest combination, among chips not yet used, that
     * rebuilds the official score exactly. Several Boosts can fit when two drivers scored the same (`sure` false).
     * No fit (a line-up changed after the race, or data missing) leaves the round unexplained. A line-up seen without
     * that round's points (a team first seen after it joined the tracking league mid-season) is kept the same way, so
     * the team going into the next round is still known.
     * @param {Record<string, Lineup>} known per gameday, from exports
     * @param {Record<string, string[]>} seen per gameday, the line-up that scored it
     * @param {Record<string, number>} official per gameday, official round points */
    function track(known, seen, official) {
      /** @type {any[]} */
      const rounds = [];
      /** @type {Record<string, number>} */
      const used = {};
      let held = /** @type {string[] | null} */ (null),
        budget = /** @type {number | null} */ (null),
        free = /** @type {number | null} */ (null);
      for (const gd of data.done) {
        const k = known[gd],
          ids = k ? k.ids.map(String) : (seen[gd] || []).map(String),
          p = official[gd];
        if (!k && ids.length !== 7) {
          held = budget = free = null; // a gap: nothing carries across it
          continue;
        }
        // an export's Limitless round has an empty start too; only round 1 is a real fresh pick
        const start = k ? (k.start || []).map(String) : held,
          isFresh = gd === data.schedule[0].gd;
        if (isFresh) {
          budget = budget ?? 100;
          free = 0;
        }
        /** @type {any} */
        let r;
        if (k) {
          r = { ...k, ids, start, src: "export", sure: true, pts: p ?? null };
          if (k.budget != null) budget = +k.budget;
        } else {
          const usedNow = new Set(Object.keys(used));
          let hits = p == null ? [] : explain(ids, gd, { start, free, budget, used: usedNow, pts: p });
          // Final Fix options that leave different teams going into the next round: keep those that also explain it
          const nx = data.done[data.done.indexOf(gd) + 1];
          if (new Set(hits.map((x) => x.qual.join())).size > 1 && !known[nx] && seen[nx] && official[nx] != null) {
            const ok = hits.filter(
              (x) =>
                explain(seen[nx].map(String), nx, {
                  start: x.qual,
                  free: x.free == null ? null : 2 + Math.min(1, Math.max(0, x.free - (x.subs || 0))),
                  budget: null,
                  used: new Set([...usedNow, x.chip]),
                  pts: official[nx],
                }).length,
            );
            if (ok.length) hits = ok;
          }
          const h = hits[0];
          r = h
            ? {
                ids: h.qual,
                ff: h.ff,
                start,
                boost: h.boost,
                x3: h.x3,
                chip: h.chip || null,
                subs: h.subs,
                free: free ?? (hits.every((x) => x.free === h.free) ? h.free : null),
                src: "seen",
                sure: hits.every(
                  (x) => x.chip === h.chip && x.boost === h.boost && JSON.stringify(x.ff) === JSON.stringify(h.ff),
                ),
                pts: p,
              }
            : {
                ids,
                ff: null,
                start,
                boost: null,
                x3: null,
                chip: null,
                subs: isFresh ? 0 : start ? ids.filter((id) => !start.includes(id)).length : null,
                free,
                src: "seen",
                sure: false,
                unexplained: true,
                pts: p ?? null,
              };
        }
        r.gd = gd;
        r.budget = budget;
        r.cost = costAt(r.ids, gd);
        // a Limitless round keeps the bank of the team it reverts to
        const banked = r.chip === "limitless" ? held && costAt(held, gd) : r.cost;
        r.bank = k && k.bank != null ? +k.bank : budget != null && banked != null ? round1(budget - banked) : null;
        if (r.chip) used[r.chip] = gd;
        rounds.push(r);
        // into the next round: a Limitless round reverts to the team held before it, a Final Fix to the qualifying
        // team (checked on MaxPeet R6 -> R7: the next start and budget follow the qualifying team)
        /** @type {string[]} */
        const nextHeld = r.chip === "limitless" && held ? held : r.ids.map(String);
        if (budget != null) budget = round1(budget + nextHeld.reduce((s, id) => s + delta(id, gd), 0));
        free =
          r.chip === "wildcard" || r.chip === "limitless" || isFresh
            ? 2
            : r.free == null
              ? null
              : 2 + Math.min(1, Math.max(0, r.free - (r.subs || 0)));
        held = nextHeld;
      }
      // the team going into the round after the last one known (asOf); older than the latest race if the data stops
      const last = rounds[rounds.length - 1];
      const next =
        held && last
          ? {
              ids: held,
              budget,
              free,
              bank: budget == null ? null : round1(budget - held.reduce((s, id) => s + (byId[id]?.price || 0), 0)),
              asOf: last.gd,
            }
          : null;
      return { rounds, used, next };
    }

    return {
      SESS_ORDER,
      byId,
      at,
      delta,
      pts,
      budget,
      fresh,
      cand,
      run,
      sess,
      ff,
      withFF,
      own,
      score,
      modelTeam,
      track,
      explain,
    };
  }

  const api = { create, SESS_ORDER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else /** @type {any} */ (root).Hindsight = api;
})(typeof window !== "undefined" ? window : globalThis);
