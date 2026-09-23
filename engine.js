/* Pit Wall engine: race-weekend Monte Carlo + official 2026 F1 Fantasy scoring + team optimiser.
   Pure functions, no DOM. Inlined into the page by refresh.py; also loadable from node for checks. */
(function (root) {
  const QPTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const RPTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const SPTS = [8, 7, 6, 5, 4, 3, 2, 1];

  // Circuit character: ov = overtake multiplier, grid = how much the start position decides the finish (0-1),
  // chaos = retirement / safety-car multiplier. Claude's estimates; editable in the Calendar tab.
  const CIRCUITS = [
    ["azerbaijan", { ov: 1.25, grid: 0.45, chaos: 1.3, note: "Street circuit, 2 km flat-out run; walls punish mistakes" }],
    ["bahrain", { ov: 1.3, grid: 0.4, chaos: 1.0, note: "Heavy braking zones, high tyre wear, easy passing" }],
    ["singapore", { ov: 0.6, grid: 0.65, chaos: 1.3, note: "Tight street circuit; qualifying is everything, safety cars likely" }],
    ["united states", { ov: 1.1, grid: 0.45, chaos: 1.0, note: "Long back straight into turn 12; plenty of passing" }],
    ["mexico", { ov: 0.95, grid: 0.5, chaos: 1.0, note: "Thin air, long run to turn 1; cooling-limited" }],
    ["paulo", { ov: 1.3, grid: 0.4, chaos: 1.2, note: "Short lap, weather risk, races often turned upside down" }],
    ["vegas", { ov: 1.3, grid: 0.42, chaos: 1.1, note: "Cold, low-grip street circuit with huge straights" }],
    ["qatar", { ov: 0.9, grid: 0.5, chaos: 1.0, note: "Fast, flowing; tyre limits and stint caps shape strategy" }],
    ["abu dhabi", { ov: 0.8, grid: 0.55, chaos: 0.9, note: "Season finale; processional unless strategy splits" }],
    ["monaco", { ov: 0.2, grid: 0.85, chaos: 1.1, note: "Near-impossible to pass" }],
  ];
  const DEFAULT_CIRCUIT = { ov: 1, grid: 0.5, chaos: 1, note: "Average circuit" };
  function circuitFor(name) {
    const n = (name || "").toLowerCase();
    const hit = CIRCUITS.find(([k]) => n.includes(k));
    return Object.assign({}, hit ? hit[1] : DEFAULT_CIRCUIT);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    let u = 0; while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }
  function poisson(l, r) {
    if (l <= 0) return 0;
    const L = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }
  function pick(weights, r) {
    let s = 0; for (const w of weights) s += w;
    let x = r() * s;
    for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
    return weights.length - 1;
  }

  /* ---------- model: pace, reliability, overtaking, pit stops from 2026 results ---------- */
  function buildModel(data, opt) {
    opt = Object.assign({ halfLife: 4, adj: {}, practice: [], practiceWeight: 1 }, opt);
    const decay = Math.pow(0.5, 1 / opt.halfLife);
    const drivers = data.assets.filter((a) => a.kind === "D" && a.active);
    const cons = data.assets.filter((a) => a.kind === "C");
    const rounds = Object.keys(data.results.race).map(Number).sort((a, b) => a - b);
    const last = rounds.length ? rounds[rounds.length - 1] : 0;

    let gD = 0, gN = 0; const tD = {}, tN = {};
    // reliability: retirements per car-race, recent races weighted (half-life 6), shrunk toward the grid rate
    const dDecay = Math.pow(0.5, 1 / 6);
    for (const r of rounds) for (const row of data.results.race[r]) {
      const w = Math.pow(dDecay, last - r);
      gN += w; tN[row.team] = (tN[row.team] || 0) + w;
      if (!row.cls) { gD += w; tD[row.team] = (tD[row.team] || 0) + w; }
    }
    const gRate = gN ? gD / gN : 0.12;

    const raw = drivers.map((a) => {
      let qs = 0, qw = 0, rs = 0, rw = 0, wk = 0, sp = 0;
      for (const r of rounds) {
        const w = Math.pow(decay, last - r);
        const rows = data.results.race[r] || [];
        const race = rows.find((x) => x.tla === a.tla);
        const ncls = rows.filter((x) => x.cls).length || 22;
        const q = (data.results.quali[r] || []).find((x) => x.tla === a.tla);
        if (race) { wk++; if (data.results.sprint[r]) sp++; }
        const same = (race && race.team === a.team) || (q && q.team === a.team);
        if (!same) continue;
        if (q) { qs += w * q.pos; qw += w; } else if (race) { qs += w * 22; qw += w; }
        // finishing rank rescaled to a full 22-car field, so other cars' retirements don't flatter it
        if (race && race.cls) { rs += w * (((race.pos - 0.5) / ncls) * 22 + 0.5); rw += w; }
      }
      return { a, qs, qw, rs, rw, wk, sp };
    });
    const team = {};
    for (const d of raw) {
      const t = team[d.a.team] || (team[d.a.team] = { qs: 0, qw: 0, rs: 0, rw: 0 });
      t.qs += d.qs; t.qw += d.qw; t.rs += d.rs; t.rw += d.rw;
    }
    const PRIOR = 1.5;
    const dModels = raw.map((d) => {
      const t = team[d.a.team];
      const tq = t.qw ? t.qs / t.qw : 16, tr = t.rw ? t.rs / t.rw : 15;
      const adj = opt.adj[d.a.id] || 0; // + = faster, in grid positions
      return {
        id: d.a.id, tla: d.a.tla, team: d.a.team,
        qMu: (d.qs + PRIOR * tq) / (d.qw + PRIOR) - adj,
        rMu: (d.rs + PRIOR * tr) / (d.rw + PRIOR) - adj,
        dnf: ((tD[d.a.team] || 0) + 4 * gRate) / ((tN[d.a.team] || 0) + 4),
        ov: d.wk ? d.a.overtakePts / (d.wk + 0.4 * d.sp) : 3,
      };
    });

    // Practice pace for this weekend. Backtested on 2026 R6-R14: blending practice short-run rank at ~30%
    // into season-form qualifying pace, and long runs at ~10% into race pace, predicted best.
    const pr = practiceRanks(opt.practice || [], dModels.map((d) => d.tla));
    const wq = Math.min(1, 0.3 * opt.practiceWeight), wr = Math.min(1, 0.1 * opt.practiceWeight);
    for (const d of dModels) {
      d.practiceQ = pr.q[d.tla] ?? null; d.practiceR = pr.r[d.tla] ?? null;
      d.formQ = d.qMu; d.formR = d.rMu;
      // one bad session (a spin, a red flag, no push lap) shouldn't wreck a driver: cap the pull at 6 places
      const pull = (v, form) => Math.max(-6, Math.min(6, v - (opt.adj[d.id] || 0) - form));
      if (d.practiceQ != null) d.qMu += wq * pull(d.practiceQ, d.qMu);
      if (d.practiceR != null) d.rMu += wr * pull(d.practiceR, d.rMu);
    }

    // Pit-stop points: constructor race score minus its drivers' race scores (DOTD adds back ~0.9/race)
    const cModels = cons.map((c) => {
      const res = [];
      c.hist.forEach((h, i) => {
        if (!h || h.r == null) return;
        let s = 0;
        for (const d of data.assets) {
          if (d.kind !== "D") continue;
          const dh = d.hist[i];
          if (dh && dh.team === c.team && dh.r != null) s += dh.r;
        }
        res.push(h.r - s);
      });
      const recent = res.slice(-8);
      const m = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 3;
      const sd = recent.length > 1 ? Math.sqrt(recent.reduce((a, b) => a + (b - m) ** 2, 0) / (recent.length - 1)) : 4;
      return { id: c.id, team: c.team, pitMu: Math.max(0, m + 0.9), pitSd: Math.max(2, Math.min(sd, 10)) };
    });
    return { drivers: dModels, cons: cModels, gRate };
  }

  // Combine practice sessions (later ones count more) into gap %, then into an implied grid position
  function practiceRanks(sessions, tlas) {
    const q = {}, qw = {}, r = {}, rn = {};
    sessions.filter((s) => s.done).forEach((s, i) => {
      const w = [1, 1, 2][Math.min(i, 2)];
      for (const [t, v] of Object.entries(s.drivers || {})) {
        if (v.laps < 6) continue; // barely ran: no signal
        if (v.q != null) { q[t] = (q[t] || 0) + w * v.q; qw[t] = (qw[t] || 0) + w; }
        if (v.r != null) { r[t] = (r[t] || 0) + v.r; rn[t] = (rn[t] || 0) + 1; }
      }
    });
    const gapQ = {}, gapR = {};
    for (const t of tlas) { if (qw[t]) gapQ[t] = q[t] / qw[t]; if (rn[t]) gapR[t] = r[t] / rn[t]; }
    const toPos = (gaps) => {
      const ks = Object.keys(gaps).sort((a, b) => gaps[a] - gaps[b]), n = ks.length, out = {};
      if (n < 6) return out; // too few drivers ran to compare
      ks.forEach((k, i) => (out[k] = ((i + 0.5) / n) * 22 + 0.5));
      return out;
    };
    return { q: toPos(gapQ), r: toPos(gapR), gapQ, gapR };
  }

  /* ---------- one race weekend, N times ---------- */
  function simulate(model, circuit, sprint, N, seed) {
    const D = model.drivers, C = model.cons, nd = D.length, nc = C.length, A = nd + nc;
    const r = mulberry32(seed);
    const tot = new Float32Array(A * N), nn = new Float32Array(A * N);
    const cOf = D.map((d) => C.findIndex((c) => c.team === d.team));
    const pts = new Float64Array(A), neg = new Float64Array(A);
    const qpos = new Int32Array(nd), sgrid = new Int32Array(nd);
    const w = circuit.grid;
    const qCount = new Uint32Array(nd * 22), rCount = new Uint32Array(nd * 23); // col 22 = DNF
    const flC = new Uint32Array(nd), dotdC = new Uint32Array(nd), ovSum = new Float64Array(nd);

    const qualiOrder = (out, withPoints) => {
      const arr = [];
      for (let i = 0; i < nd; i++) {
        const nc_ = r() < 0.012;
        arr.push({ i, s: nc_ ? 99 + r() : D[i].qMu + gauss(r) * (1.1 + 0.11 * D[i].qMu), nc: nc_ });
      }
      arr.sort((a, b) => a.s - b.s);
      arr.forEach((x, k) => {
        out[x.i] = k + 1;
        if (!withPoints) return;
        qCount[x.i * 22 + Math.min(k, 21)]++;
        if (x.nc) { pts[x.i] -= 5; neg[x.i] -= 5; }
        else if (k < 10) pts[x.i] += QPTS[k];
      });
      return arr;
    };

    const race = (grid, isSprint, dotdOut) => {
      const fin = [];
      for (let i = 0; i < nd; i++) {
        const pDnf = D[i].dnf * circuit.chaos * (isSprint ? 0.4 : 1);
        if (r() < pDnf) { const pen = isSprint ? 10 : 20; pts[i] -= pen; neg[i] -= pen; if (!isSprint) rCount[i * 23 + 22]++; continue; }
        fin.push({ i, s: w * grid[i] + (1 - w) * D[i].rMu + gauss(r) * (1.6 + 0.12 * D[i].rMu) * (isSprint ? 0.85 : 1) });
      }
      fin.sort((a, b) => a.s - b.s);
      const flW = [], dW = [];
      fin.forEach((x, k) => {
        const pos = k + 1, i = x.i;
        pts[i] += isSprint ? SPTS[k] || 0 : RPTS[k] || 0;
        let g = grid[i] - pos;
        if (isSprint && g < -10) g = -10;
        pts[i] += g; if (g < 0) neg[i] += g;
        const ov = poisson(D[i].ov * circuit.ov * (isSprint ? 0.4 : 1), r);
        pts[i] += ov; ovSum[i] += ov;
        if (!isSprint) rCount[i * 23 + Math.min(k, 21)]++;
        flW.push(Math.exp(-(pos - 1) / 3));
        dW.push((pos === 1 ? 12 : pos === 2 ? 4 : pos === 3 ? 3 : 0.3) + 0.5 * Math.max(0, g - 3));
      });
      if (fin.length) {
        const f = fin[pick(flW, r)].i;
        pts[f] += isSprint ? 5 : 10;
        if (!isSprint) { flC[f]++; const d = fin[pick(dW, r)].i; pts[d] += 10; dotdOut.i = d; dotdC[d]++; }
      }
    };

    for (let s = 0; s < N; s++) {
      pts.fill(0); neg.fill(0);
      const dotd = { i: -1 };
      qualiOrder(qpos, true);
      // constructor qualifying bonus
      const qb = new Float64Array(nc), qbNeg = new Float64Array(nc);
      for (let c = 0; c < nc; c++) {
        let q2 = 0, q3 = 0;
        for (let i = 0; i < nd; i++) if (cOf[i] === c) { if (qpos[i] <= 16) q2++; if (qpos[i] <= 10) q3++; }
        const b = q3 === 2 ? 10 : q3 === 1 ? 5 : q2 === 2 ? 3 : q2 === 1 ? 1 : -1;
        qb[c] = b; if (b < 0) qbNeg[c] = b;
      }
      if (sprint) { qualiOrder(sgrid, false); race(sgrid, true, {}); }
      race(qpos, false, dotd);
      for (let c = 0; c < nc; c++) {
        let t = qb[c], n = qbNeg[c];
        for (let i = 0; i < nd; i++) if (cOf[i] === c) { t += pts[i] - (dotd.i === i ? 10 : 0); n += neg[i]; }
        t += Math.max(0, Math.round(C[c].pitMu + gauss(r) * C[c].pitSd));
        pts[nd + c] = t; neg[nd + c] = n;
      }
      for (let a = 0; a < A; a++) { tot[a * N + s] = pts[a]; nn[a * N + s] = pts[a] - neg[a]; }
    }

    const ids = D.map((d) => d.id).concat(C.map((c) => c.id));
    const stats = ids.map((id, a) => {
      const sl = Array.from(tot.subarray(a * N, a * N + N)).sort((x, y) => x - y);
      let m = 0, mn = 0;
      for (let s = 0; s < N; s++) { m += tot[a * N + s]; mn += nn[a * N + s]; }
      const st = { id, mean: m / N, nnMean: mn / N, p10: sl[Math.floor(N * 0.1)], p25: sl[Math.floor(N * 0.25)], p50: sl[Math.floor(N * 0.5)], p75: sl[Math.floor(N * 0.75)], p90: sl[Math.floor(N * 0.9)] };
      if (a < nd) {
        st.dnf = rCount[a * 23 + 22] / N; st.fl = flC[a] / N; st.dotd = dotdC[a] / N; st.xov = ovSum[a] / N;
        st.q = Array.from(qCount.subarray(a * 22, a * 22 + 22), (v) => v / N);
        st.r = Array.from(rCount.subarray(a * 23, a * 23 + 23), (v) => v / N);
      }
      return st;
    });
    return { ids, N, tot, nn, stats };
  }

  /* ---------- price change rule (fitted to 2026 price history) ---------- */
  // bands per the game: 3-race average points / price, rounded to 3 dp: <0.605, <0.9, <1.195, else great
  const PRICE_BANDS = [0.605, 0.9, 1.195];
  function priceStep(price, avg) {
    const big = price >= 18.5, ppm = Math.round((avg / price) * 1000) / 1000;
    const step = ppm >= 1.195 ? 3 : ppm >= 0.9 ? 1 : ppm >= 0.605 ? -1 : -3;
    const d = big ? step * 0.1 : step * 0.2;
    return Math.max(3, Math.min(34, Math.round((price + d) * 10) / 10)) - price;
  }

  /* ---------- optimiser ---------- */
  // cand: [{id, kind, price, e, eNext, active}], team: ids, opts: {cap, free, maxT, chip, locks:Set, bans:Set, top}
  function optimise(cand, team, o) {
    const inTeam = new Set(team);
    const Ds = cand.filter((c) => c.kind === "D" && c.active && !o.bans.has(c.id));
    const Cs = cand.filter((c) => c.kind === "C" && !o.bans.has(c.id));
    const n = Ds.length, m = Cs.length;
    let curD = 0, lockD = 0, curC = 0, lockC = 0;
    Ds.forEach((d, i) => { if (inTeam.has(d.id)) curD |= 1 << i; if (o.locks.has(d.id)) lockD |= 1 << i; });
    Cs.forEach((c, i) => { if (inTeam.has(c.id)) curC |= 1 << i; if (o.locks.has(c.id)) lockC |= 1 << i; });
    const unlimited = o.chip === "wildcard" || o.chip === "limitless";
    const noCap = o.chip === "limitless";
    const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };

    const combos = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
      for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        const mask = (1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e);
        if ((mask & lockD) !== lockD) continue;
        const idx = [a, b, c, d, e];
        let cost = 0, sum = 0, m1 = -1e9, m2 = -1e9, i1 = -1, i2 = -1;
        for (const k of idx) {
          cost += Ds[k].price; sum += Ds[k].e;
          const v = Ds[k].boostE;
          if (v > m1) { m2 = m1; i2 = i1; m1 = v; i1 = k; } else if (v > m2) { m2 = v; i2 = k; }
        }
        const boost = o.chip === "x3" ? 2 * m1 + m2 : m1;
        combos.push({ mask, idx, cost, val: sum + boost, i1, i2, keep: pop(mask & curD) });
      }
    const pairs = [];
    for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) {
      const mask = (1 << a) | (1 << b);
      if ((mask & lockC) !== lockC) continue;
      pairs.push({ mask, a, b, cost: Cs[a].price + Cs[b].price, val: Cs[a].e + Cs[b].e, keep: pop(mask & curC) });
    }
    const top = [], K = o.top || 60;
    let floor = -1e9;
    for (const p of pairs) for (const c of combos) {
      if (!noCap && c.cost + p.cost > o.cap + 1e-6) continue;
      const t = 7 - c.keep - p.keep;
      if (!unlimited && t > o.maxT) continue;
      const pen = unlimited ? 0 : 10 * Math.max(0, t - o.free);
      const score = c.val + p.val - pen;
      if (score <= floor && top.length >= K) continue;
      top.push({ score, c, p, t, pen });
      if (top.length > K * 2) { top.sort((x, y) => y.score - x.score); top.length = K; floor = top[K - 1].score; }
    }
    top.sort((x, y) => y.score - x.score);
    return top.slice(0, K).map((x) => ({
      score: x.score, transfers: x.t, penalty: x.pen, cost: x.c.cost + x.p.cost,
      drivers: x.c.idx.map((k) => Ds[k].id), cons: [Cs[x.p.a].id, Cs[x.p.b].id],
      boost: Ds[x.c.i1].id, boost2: o.chip === "x3" ? Ds[x.c.i2].id : null,
    }));
  }

  const api = { QPTS, RPTS, SPTS, CIRCUITS, PRICE_BANDS, circuitFor, buildModel, practiceRanks, simulate, priceStep, optimise, mulberry32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
