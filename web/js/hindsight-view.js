/* ---------- hindsight: best teams on actual points (scoring in hindsight.js, as Hind) ---------- */
const lineups = (name) => (SEALED && SEALED.lineups && SEALED.lineups[name]) || null;
// budget for the best teams: $100m, no cap, or one of your teams' budget that round ("team:i"; the default, the
// fair comparison)
const hdCapMode = () => state.hdCap || `team:${state.active}`;
function hdCap(gd) {
  const mode = hdCapMode();
  if (mode === "none") return null;
  if (mode.startsWith("team:")) {
    const T = state.teams[+mode.slice(5)] || activeTeam(),
      r = (lineups(T.name) || {})[gd];
    return r ? Hind.budget(r, gd) : 100;
  }
  return 100;
}
const hdMarks = (to) => Object.keys(state.hdMarks || {}).filter((k) => state.hdMarks[k] === to);
const hdBestList = (gd, top) => {
  const ff = state.hdChip === "finalfix",
    list = Hind.run(gd, {
      cap: hdCap(gd),
      chip: ff ? "" : state.hdChip || "",
      filters: filters("hd"),
      locks: hdMarks("lock"),
      bans: hdMarks("ban"),
      top,
    });
  return ff ? list.map((t) => Hind.withFF(t, gd, hdCap(gd))).sort((a, b) => b.score - a.score) : list;
};
function hdChips(ids, boost, x3, start, gd, chipK, ff) {
  if (ff) ids = ids.concat([ff.in]);
  const cons = ids.filter((id) => byId[id]?.kind === "C"),
    drs = ids.filter((id) => byId[id]?.kind === "D");
  const slotB = ff && (boost === ff.in || boost === ff.out),
    isFF = (id) => ff && (id === ff.in || id === ff.out);
  const m = (id) => (isFF(id) ? (slotB ? 2 : 1) : id === x3 ? 3 : id === boost ? 2 : 1);
  const pts = (id) => (!isFF(id) ? Hind.pts(id, gd, chipK) : Hind.sess(id, gd, ff.cat, id === ff.in ? "post" : "pre"));
  const one = (id) => {
    const h = Hind.at(id, gd);
    return chip(id, {
      a: h ? f0(pts(id) * m(id)) : "—",
      b: h ? h.price.toFixed(1) : "",
      x: ff && id === ff.in ? "FF" : ff && id === ff.out ? "" : id === x3 ? "3×" : id === boost ? "2×" : "",
      cls: [start && !start.includes(id) && !isFF(id) ? "in" : "", ff && id === ff.out ? "out" : ""].join(" "),
    });
  };
  return (
    cons.map(one).join("") +
    '<span class="sep"></span>' +
    drs
      .sort((a, b) => m(b) - m(a) || pts(b) - pts(a))
      .map(one)
      .join("")
  );
}
// What each decision was worth that round. Formulas as in the Decisions panel note.
function hdDecisions(name, gd) {
  const L = lineups(name) || {},
    r = L[gd];
  if (!r) return null;
  const prevGd = Object.keys(L)
      .map(Number)
      .filter((g) => g < gd)
      .sort((a, b) => b - a)[0],
    prev = prevGd ? L[prevGd] : null;
  const base = (id) => Hind.pts(id, gd, ""),
    mult = (id) => (id === r.x3 ? 3 : id === r.boost ? 2 : 1);
  const score = (ids, boost, x3) => ids.reduce((s, id) => s + base(id) * (id === x3 ? 3 : id === boost ? 2 : 1), 0);
  const out = { chip: r.chip, list: [] };
  if (gd === DATA.schedule[0].gd) {
    out.list.push({ k: "start", label: "Initial pick", pts: null });
    return out;
  }
  if (r.chip === "limitless") {
    if (prev) {
      const was = score(prev.ids, prev.ids.includes(prev.boost) ? prev.boost : null, null);
      out.list.push({
        k: "chip",
        label: `Limitless over keeping R${prevGd}'s team`,
        pts: score(r.ids, r.boost, r.x3) - was,
      });
    }
    return out;
  }
  const outs = r.start.filter((id) => !r.ids.includes(id)),
    ins = r.ids.filter((id) => !r.start.includes(id));
  const pen = r.chip === "wildcard" ? 0 : 10 * Math.max(0, (r.subs || 0) - (r.free || 0));
  if (ins.length)
    out.list.push({
      k: "tr",
      label: `${ins.length} transfer${ins.length > 1 ? "s" : ""} (${r.free ?? "?"} free): ${outs.map((id) => code(byId[id])).join(", ")} → ${ins.map((id) => code(byId[id])).join(", ")}${pen ? ` (−${pen})` : ""}`,
      pts: ins.reduce((s, id) => s + base(id), 0) - outs.reduce((s, id) => s + base(id), 0) - pen,
      d: ins.reduce((s, id) => s + Hind.delta(id, gd), 0) - outs.reduce((s, id) => s + Hind.delta(id, gd), 0),
      pen,
      n: ins.length,
    });
  if (prev && prev.boost && prev.boost !== r.boost && r.ids.includes(prev.boost) && r.boost)
    out.list.push({
      k: "x2",
      label: `Boost ${code(byId[prev.boost])} → ${code(byId[r.boost])}`,
      pts: base(r.boost) - base(prev.boost),
    });
  if (r.chip === "x3" && r.x3)
    out.list.push({ k: "chip", label: "X3 chip", pts: base(r.x3) + (r.boost ? base(r.boost) : 0) });
  if (r.chip === "noneg")
    out.list.push({
      k: "chip",
      label: "No Negative chip",
      pts: r.ids.reduce((s, id) => s + (Hind.pts(id, gd, "noneg") - base(id)) * mult(id), 0),
    });
  // F1 records 0 transfers made on a Wildcard round, so count the actual changes
  if (r.chip === "wildcard")
    out.list.push({
      k: "chip",
      label: "Wildcard (penalties avoided)",
      pts: 10 * Math.max(0, ins.length - (r.free || 0)),
    });
  if (r.chip === "autopilot")
    out.list.push({
      k: "chip",
      label: `Autopilot gave the Boost to ${r.boost ? code(byId[r.boost]) : "—"}`,
      pts: null,
    });
  if (r.chip === "finalfix" && r.ff)
    out.list.push({
      k: "chip",
      label: `Final Fix ${code(byId[r.ff.out])} → ${code(byId[r.ff.in])}`,
      pts:
        (Hind.sess(r.ff.in, gd, r.ff.cat, "post") - Hind.sess(r.ff.out, gd, r.ff.cat, "post")) *
        (r.boost === r.ff.in || r.boost === r.ff.out ? 2 : 1),
    });
  return out;
}
const decHtml = (dec) =>
  dec.list
    .map(
      (x) =>
        `<div class="dec"><span>${esc(x.label)}</span><span>${x.pts == null ? "" : `<b class="${x.pts > 0 ? "good" : x.pts < 0 ? "bad" : "muted"}">${sgn(x.pts, 0) || "0"}</b>`}${x.d ? ` <span class="muted">Δ$ ${sgn(x.d, 1)}</span>` : ""}</span></div>`,
    )
    .join("");

function renderHind() {
  const done = DATA.done || [];
  $("#hindEmpty").hidden = !!done.length;
  $("#hindDash").hidden = !done.length;
  if (!done.length) return;
  const gd = done.includes(state.hdGd) ? state.hdGd : done[done.length - 1],
    cap = hdCap(gd),
    chipK = state.hdChip || "";
  const name = (g) => DATA.schedule.find((x) => x.gd === g)?.name || "";
  $("#hdRound").innerHTML = done
    .map((g) => `<button data-hg="${g}" aria-pressed="${g === gd}" title="${esc(name(g))}">R${g}</button>`)
    .join("");
  const capM = hdCapMode();
  $("#hdCap").innerHTML = [["100", "$100m"], ...state.teams.map((t, i) => [`team:${i}`, t.name]), ["none", "No cap"]]
    .map(
      ([k, n]) =>
        `<button data-hc="${k}" aria-pressed="${k === capM}"${k.startsWith("team:") ? ' title="This team\'s budget that round"' : ""}>${esc(n)}</button>`,
    )
    .join("");
  $$("#hdChip button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.hch === chipK)));
  $("#hdFilters").innerHTML = filterUI("hd");

  // best possible teams
  const list = hdBestList(gd, 10),
    nf = filters("hd").length,
    nm = Object.keys(state.hdMarks || {}).length;
  $("#hdBestNote").textContent =
    `R${gd} ${name(gd)} · ${cap == null ? "no budget cap" : "budget " + money(cap)}${chipK ? " · " + { x3: "X3", noneg: "No Negative", finalfix: "Final Fix" }[chipK] : ""}${nf ? ` · ${nf} filter${nf > 1 ? "s" : ""}` : ""}${nm ? ` · ${nm} Incl/Excl` : ""}`;
  $("#hdBest").innerHTML = list.length
    ? list
        .map((b, i) => {
          const ids = b.drivers.concat(b.cons),
            x3 = b.boost2 ? b.boost : null,
            boost = b.boost2 || b.boost,
            dv = ids.reduce((s, id) => s + Hind.delta(id, gd), 0);
          const txt =
            teamText(`R${gd} best #${i + 1}`, b.cons, b.drivers, boost, x3, b.cost, b.score) +
            (b.ff ? ` | Final Fix ${code(byId[b.ff.out])} → ${code(byId[b.ff.in])}` : "");
          return `<div class="bt"><span class="rk">${i + 1}</span><div class="chips">${hdChips(ids, boost, x3, null, gd, chipK === "finalfix" ? "" : chipK, b.ff)}</div>
      <div class="num"><b>${f0(b.score)}</b>${i ? `<span class="bad">${sgn(b.score - list[0].score, 0)}</span>` : '<span class="muted">pts</span>'}</div>
      <div class="sub"><span>${money(b.cost)}</span><span class="${dv >= 0 ? "good" : "bad"}">Δ$ ${sgn(dv, 1)}</span><span class="acts"><button class="btn ghost sm" data-copy="${esc(txt)}">Copy</button></span></div></div>`;
        })
        .join("")
    : '<p class="note">No team fits this budget and these filters.</p>';

  // your teams: what was used, what it was worth, and the best move available from the line-up going in
  const mine = state.teams.map((t) => ({
    t,
    r: (lineups(t.name) || {})[gd],
    off: teamHist(t.name).find((h) => h.gd === gd)?.pts,
  }));
  if (!SEALED)
    $("#hdMine").innerHTML =
      '<p class="note">Unlock your leagues under Leagues → My leagues to see your teams here. Their round-by-round line-ups are saved (encrypted) from your data exports.</p>';
  else
    $("#hdMine").innerHTML = mine
      .map(({ t, r, off }) => {
        if (!r)
          return `<div class="bt"><span class="rk"></span><div><b>${esc(t.name)}</b><p class="note">No line-up saved for R${gd}. Line-ups come from a data export; collect a fresh one to fill new rounds.</p></div><div class="num"></div></div>`;
        const b = Hind.own(r, gd),
          chipName = (CHIPS.find(([k]) => k === r.chip) || [])[2],
          fresh = Hind.fresh(gd, r.start);
        const bids = b.drivers.concat(b.cons),
          outs = r.start.filter((id) => !bids.includes(id)),
          ins = bids.filter((id) => !r.start.includes(id));
        const moves =
          fresh || ["wildcard", "limitless"].includes(r.chip)
            ? `${chipName || "Free"} rebuild`
            : ins.length
              ? `${ins.length} transfer${ins.length > 1 ? "s" : ""}: ` +
                outs.map((id) => code(byId[id])).join(", ") +
                " → " +
                ins.map((id) => code(byId[id])).join(", ") +
                (b.penalty ? ` (−${b.penalty})` : "")
              : "No transfers";
        const miss = off == null ? null : b.score - off,
          dec = hdDecisions(t.name, gd);
        const txt = teamText(
          `${t.name} R${gd} best`,
          b.cons,
          b.drivers,
          b.boost2 || b.boost,
          b.boost2 ? b.boost : null,
          b.cost,
          b.score,
        );
        return `<div class="bt"><span class="rk"></span><div style="display:flex;flex-direction:column;gap:8px;min-width:0">
      <b>${esc(t.name)}${chipName ? ` <span class="tag sprint">${esc(chipName)}</span>` : ""}</b>
      <span class="muted" style="font-size:12px">Used · ${off == null ? "—" : off + " pts"}</span><div class="chips">${hdChips(r.ids, r.boost, r.x3, null, gd, r.chip, r.ff)}</div>
      ${dec && dec.list.length ? `<div>${decHtml(dec)}</div>` : ""}
      <span class="muted" style="font-size:12px">Best from your line-up · ${esc(moves)} <button class="btn ghost sm" data-copy="${esc(txt)}">Copy</button></span><div class="chips">${hdChips(bids, b.boost2 || b.boost, b.boost2 ? b.boost : null, fresh ? null : r.start, gd, r.chip, b.ff)}</div>
      ${b.ff ? `<p class="note">Best Final Fix: ${esc(code(byId[b.ff.out]))} → ${esc(code(byId[b.ff.in]))} before the race (+${f0(b.ff.gain)}).</p>` : ""}</div>
      <div class="num"><b>${f0(b.score)}</b><span class="muted">best</span>${miss == null ? "" : `<span class="${miss > 0 ? "bad" : "good"}">${miss > 0 ? "−" + f0(miss) + " left" : "optimal"}</span>`}</div></div>`;
      })
      .join("");

  // season: official vs best reachable, every finished round
  const teams = mine.filter(({ t }) => lineups(t.name));
  const rows = done
    .slice()
    .reverse()
    .map((g) => {
      const bb = hdBestList(g, 1)[0];
      return (
        `<tr><td${g === gd ? ' style="background:var(--accent-soft)"' : ""}>R${g}</td><td>${bb ? f0(bb.score) : "—"}</td>` +
        teams
          .map(({ t }) => {
            const r = lineups(t.name)[g],
              off = teamHist(t.name).find((h) => h.gd === g)?.pts;
            if (!r) return '<td class="dim">—</td><td class="dim">—</td>';
            const b = Hind.own(r, g),
              miss = off == null ? null : b.score - off;
            return `<td><b>${off ?? "—"}</b></td><td${heat(miss == null ? null : -miss, -80, 0)}>${f0(b.score)}${miss > 0 ? ` <span class="bad">−${f0(miss)}</span>` : ""}</td>`;
          })
          .join("") +
        "</tr>"
      );
    });
  const sum = (f) => done.reduce((acc, g) => acc + (f(g) || 0), 0);
  const tot =
    `<tr><td><b>Season</b></td><td><b>${f0(sum((g) => hdBestList(g, 1)[0]?.score))}</b></td>` +
    teams
      .map(({ t }) => {
        const L = lineups(t.name),
          off = sum((g) => (L[g] ? teamHist(t.name).find((h) => h.gd === g)?.pts : 0)),
          bs = sum((g) => (L[g] ? Hind.own(L[g], g).score : 0));
        return `<td><b>${f0(off)}</b></td><td><b>${f0(bs)}</b> <span class="muted">${bs ? Math.round((off / bs) * 100) + "%" : ""}</span></td>`;
      })
      .join("") +
    "</tr>";
  $("#hdSeason").innerHTML =
    `<thead><tr><th>Round</th><th title="Best team from scratch with the settings above">Best possible</th>${teams.map(({ t }) => `<th>${esc(t.name)}</th><th title="Best reachable from that team's line-up, budget, free transfers and chip">Best reachable</th>`).join("")}</tr></thead><tbody>${tot}${rows.join("")}</tbody>`;
  $("#hdFoot").textContent = teams.length
    ? "Best reachable starts from the team's actual line-up going into the round, with its budget, free transfers (extra ones at −10) and the chip it played. The % is how much of that you banked."
    : "Unlock your leagues to compare your own teams.";

  // decisions over the season, per team
  const dsum = teams.map(({ t }) => {
    const all = done
      .map((g) => hdDecisions(t.name, g))
      .filter(Boolean)
      .flatMap((d) => d.list);
    const tr = all.filter((x) => x.k === "tr"),
      good = tr.filter((x) => x.pts > 0),
      bad = tr.filter((x) => x.pts < 0),
      x2 = all.filter((x) => x.k === "x2"),
      ch = all.filter((x) => x.k === "chip" && x.pts != null);
    const s_ = (xs) => xs.reduce((a, x) => a + x.pts, 0);
    return {
      t,
      n: tr.reduce((a, x) => a + x.n, 0),
      pen: tr.reduce((a, x) => a + x.pen, 0),
      good,
      bad,
      net: s_(tr),
      d: tr.reduce((a, x) => a + (x.d || 0), 0),
      x2n: x2.length,
      x2: s_(x2),
      ch,
    };
  });
  const td = (v) => `<td class="${v > 0 ? "good" : v < 0 ? "bad" : "muted"}">${sgn(v, 0) || "0"}</td>`;
  $("#hdDecide").innerHTML = teams.length
    ? `<thead><tr><th>Team</th><th>Transfers</th><th title="Penalty points paid">Penalties</th><th title="Rounds where the transfers gained / lost points">Good / bad rounds</th><th>Transfer impact</th><th title="Price change of assets in minus out">Δ$ impact</th><th>Boost changes</th><th style="text-align:left">Chips</th></tr></thead><tbody>` +
      dsum
        .map(
          (
            x,
          ) => `<tr><td><b>${esc(x.t.name)}</b></td><td>${x.n}</td><td class="${x.pen ? "bad" : "muted"}">${x.pen ? "−" + x.pen : "0"}</td><td><span class="good">${x.good.length} (${
            sgn(
              x.good.reduce((a, y) => a + y.pts, 0),
              0,
            ) || 0
          })</span> / <span class="bad">${x.bad.length} (${
            sgn(
              x.bad.reduce((a, y) => a + y.pts, 0),
              0,
            ) || 0
          })</span></td>${td(x.net)}<td class="${x.d >= 0 ? "good" : "bad"}">${sgn(x.d, 1)}</td><td>${x.x2n} · <span class="${x.x2 >= 0 ? "good" : "bad"}">${sgn(x.x2, 0) || 0}</span></td>
      <td style="text-align:left">${x.ch.map((c) => `${esc(c.label.replace(" chip", "").replace(/ \(.*\)| over .*/, ""))} <span class="${c.pts >= 0 ? "good" : "bad"}">${sgn(c.pts, 0)}</span>`).join(" · ") || "—"}</td></tr>`,
        )
        .join("") +
      "</tbody>"
    : `<tbody><tr><td class="muted" style="position:static">Unlock your leagues to see your decisions.</td></tr></tbody>`;

  renderModelTeam(gd);

  // every asset's round, with this model's pre-lock projection where it was saved
  const proj = (DATA.projHist || {})[gd];
  $("#hdAssetsNote").textContent =
    `R${gd}` +
    (proj ? ` · projection frozen at lock (${modelAccuracy(gd)})` : "") +
    " · Incl / Excl apply to the best teams above";
  const bestIds = list[0] ? list[0].drivers.concat(list[0].cons) : [];
  const alist = DATA.assets
    .map((a) => ({ a, h: Hind.at(a.id, gd) }))
    .filter((x) => x.h && (x.h.active || x.a.kind === "C"))
    .sort((x, y) => y.h.pts - x.h.pts);
  $("#hdAssets").innerHTML =
    `<thead><tr><th>Asset</th><th>Price</th><th title="Price change after the round">Δ$</th><th>Pts</th><th title="No Negative points: negative events count as 0">NN</th><th title="Points per $1m">Pts/$m</th><th title="Share of all teams that picked it">Own</th>${proj ? "<th>Projected</th>" : ""}<th style="text-align:left">Best</th><th style="text-align:left">Your teams</th><th>Incl / Excl</th></tr></thead><tbody>` +
    alist
      .map(({ a, h }) => {
        const m = (state.hdMarks || {})[a.id] || "",
          dv = Hind.delta(a.id, gd);
        return `<tr><td>${who(a)}</td><td class="muted">${money(h.price)}</td><td class="${dv > 0 ? "good" : dv < 0 ? "bad" : "muted"}">${sgn(dv, 1)}</td><td${heat(h.pts, -20, 60)}><b>${f0(h.pts)}</b></td><td class="muted">${f0(h.nn)}</td><td>${f1(h.pts / h.price)}</td><td class="muted">${f0(h.own)}%</td>${proj ? `<td class="muted">${f1(proj[a.id])}</td>` : ""}
      <td style="text-align:left">${bestIds.includes(a.id) ? '<span class="good">✓</span>' : ""}</td><td style="text-align:left">${state.teams.map((t, i) => (((lineups(t.name) || {})[gd]?.ids || []).includes(a.id) ? `<span class="chiptok" title="${esc(t.name)}">T${i + 1}</span>` : "")).join("")}</td>
      <td>${inclExcl(a.id, m, "hmark")}</td></tr>`;
      })
      .join("") +
    "</tbody>";
}

// How far the frozen projection was from what happened: this round's mean absolute error and rank correlation,
// and the average error over every round with a frozen projection (the model's live track record).
function modelAccuracy(gd) {
  const one = (g) => {
    const proj = (DATA.projHist || {})[g] || {},
      xs = [],
      ys = [];
    for (const [id, x] of Object.entries(proj)) {
      const h = Hind.at(id, g);
      if (!h || !h.active || x == null) continue;
      xs.push(x);
      ys.push(h.pts);
    }
    return xs.length
      ? { mae: xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0) / xs.length, rho: Engine.spearman(xs, ys) }
      : null;
  };
  const now = one(gd);
  if (!now) return "no result yet";
  const all = Object.keys(DATA.projHist || {})
    .map(Number)
    .filter((g) => DATA.done.includes(g))
    .map(one)
    .filter(Boolean);
  const avg = all.reduce((s, x) => s + x.mae, 0) / all.length;
  return (
    `off by ${f1(now.mae)} pts per asset, rank correlation ${now.rho.toFixed(2)}` +
    (all.length > 1 ? `; ${all.length} rounds average ${f1(avg)}` : "")
  );
}

// The model team (Hind.modelTeam): the frozen projection where the site saved one, else the rebuilt one. Computed
// once per page load; it doesn't depend on any setting.
let modelRounds = null;
function modelTeamRounds() {
  if (!modelRounds) {
    const proj = { ...(DATA.projRebuilt || {}), ...(DATA.projHist || {}) };
    modelRounds = Hind.modelTeam(proj).map((r) => ({
      ...r,
      src: (DATA.projHist || {})[r.gd] ? "Frozen" : (DATA.projRebuilt || {})[r.gd] ? "Rebuilt" : "Kept",
    }));
  }
  return modelRounds;
}
function renderModelTeam(gd) {
  const rs = modelTeamRounds();
  if (!rs.length) {
    $("#hdModelSum").textContent = "No projections for finished rounds yet.";
    $("#hdModel").innerHTML = "";
    return;
  }
  const gds = rs.map((r) => r.gd),
    span = `R${gds[0]}–R${gds[gds.length - 1]}`,
    total = rs[rs.length - 1].total;
  // your teams' official round points and the top-100 average, over the same rounds
  const teams = state.teams
    .map((t, i) => ({ t, i, by: Object.fromEntries(teamHist(t.name).map((h) => [h.gd, h.pts])) }))
    .filter((x) => gds.some((g) => x.by[g] != null));
  const el = Object.fromEntries(((DATA.elite && DATA.elite.history) || []).map((h) => [h.gd, h]));
  const top = (g) => el[g]?.avg?.["100"] ?? null;
  const hasTop = gds.some((g) => top(g) != null),
    est = gds.some((g) => el[g]?.est);
  // the gap counts only the rounds both have
  const byGd = Object.fromEntries(rs.map((r) => [r.gd, r.pts]));
  const vs = (name, val) => {
    const have = gds.filter((g) => val(g) != null),
      v = have.reduce((s, g) => s + val(g), 0),
      m = have.reduce((s, g) => s + byGd[g], 0);
    return `${esc(name)} ${f0(v)}${have.length < gds.length ? ` (${have.length} of ${gds.length} rounds)` : ""} <span class="${m >= v ? "good" : "bad"}">${sgn(m - v, 0) || "0"}</span>`;
  };
  const cmp = teams.map(({ t, by }) => vs(t.name, (g) => by[g]));
  if (hasTop) cmp.push(vs(`top-100 average${est ? " (partly estimated)" : ""}`, top));
  const nReb = rs.filter((r) => r.src === "Rebuilt").length,
    nFro = rs.filter((r) => r.src === "Frozen").length;
  $("#hdModelNote").textContent = `${span} · ${nFro} frozen, ${nReb} rebuilt`;
  $("#hdModelSum").innerHTML =
    `<b>${f0(total)} pts</b> over ${span}` +
    (cmp.length ? ` · against it: ${cmp.join(" · ")}` : " · unlock your leagues to compare your own teams");
  const moves = (r) => {
    if (!r.start.length) return "Fresh pick";
    const outs = r.start.filter((id) => !r.ids.includes(id)),
      ins = r.ids.filter((id) => !r.start.includes(id));
    if (!ins.length) return '<span class="muted">No transfers</span>';
    return (
      outs.map((id) => code(byId[id])).join(", ") +
      " → " +
      ins.map((id) => code(byId[id])).join(", ") +
      (r.penalty ? ` <span class="bad">(−${r.penalty})</span>` : "")
    );
  };
  const rows = rs
    .slice()
    .reverse()
    .map(
      (r) =>
        `<tr><td${r.gd === gd ? ' style="background:var(--accent-soft)"' : ""}>R${r.gd}</td><td class="muted">${r.src}</td>` +
        `<td style="text-align:left"><div class="chips">${hdChips(r.ids, r.boost, null, r.start.length ? r.start : null, r.gd, "", null)}</div></td>` +
        `<td style="text-align:left">${moves(r)}</td><td class="muted">${r.free ?? "∞"}</td><td class="muted">${money(r.budget)}</td>` +
        `<td class="muted">${f0(r.x)}</td><td><b>${r.pts}</b></td><td>${f0(r.total)}</td>` +
        teams
          .map(({ by }) => {
            const v = by[r.gd];
            return v == null ? '<td class="dim">—</td>' : `<td${heat(r.pts - v, -60, 60)}>${v}</td>`;
          })
          .join("") +
        (hasTop ? `<td class="muted">${f0(top(r.gd))}</td>` : "") +
        "</tr>",
    );
  $("#hdModel").innerHTML =
    `<thead><tr><th>Round</th><th title="Frozen before lock, or rebuilt afterwards from the data as it stood">Projection</th><th style="text-align:left">Line-up</th><th style="text-align:left">Transfers</th><th title="Free transfers going in">Free</th><th title="Budget going in">Budget</th><th title="Projected points of the pick, after penalties">xPts</th><th>Pts</th><th>Total</th>` +
    teams
      .map(({ t }) => `<th title="Official round points; green where the model team beat it">${esc(t.name)}</th>`)
      .join("") +
    (hasTop
      ? `<th title="Average round score of the global top 100${est ? " (estimated from today's top 100 before R15)" : ""}">Top-100 avg</th>`
      : "") +
    `</tr></thead><tbody>${rows.join("")}</tbody>`;
}
