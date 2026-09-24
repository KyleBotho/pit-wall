/* ---------- league ---------- */
// Leagues: auto-updated (decrypted) standings merged with anything imported (chips, bank, round history)
function leagueList() {
  const out = [];
  for (const L of (SEALED && SEALED.leagues) || []) {
    const imp = state.league && state.league.name === L.name ? state.league : null;
    const members = L.members
      .map((m) => {
        const im = imp && imp.members.find((x) => x.name === m.team);
        const ds = m.ids.filter((id) => byId[id]?.kind === "D"),
          cs = m.ids.filter((id) => byId[id]?.kind === "C");
        return {
          name: m.team,
          pts: +m.pts || 0,
          ids: ds.length === 5 && cs.length === 2 ? ds.concat(cs) : im ? im.ids : null,
          boost: im ? im.boost : "",
          bank: im ? im.bank : null,
          chips: im ? im.chips : {},
          hist: teamHist(m.team),
          mine: state.teams.some((t) => t.name === m.team),
        };
      })
      .sort((a, b) => b.pts - a.pts);
    out.push({ name: L.name, pending: L.pending, collected: L.feedTime || null, members, auto: true });
  }
  if (state.league && !out.some((l) => l.name === state.league.name)) out.push(state.league);
  return out;
}
function renderLeague() {
  $("#lgUnlock").hidden = !(DATA.leagueSealed && !SEALED);
  const all = leagueList(),
    L = all[Math.min(state.lgIdx | 0, all.length - 1)];
  $("#leagueEmpty").hidden = !!L || !!DATA.leagueSealed;
  $("#leagueDash").hidden = !L;
  if (!L) return;
  $("#lgPick").hidden = all.length < 2;
  $("#lgPick").innerHTML = all
    .map((l, i) => `<button data-lg="${i}" aria-pressed="${l === L}">${esc(l.name)}</button>`)
    .join("");
  const myIds = activeTeam().team,
    myName = activeTeam().name;
  $("#lgTitle").textContent = L.name;
  if (L.pending || !L.members.length) {
    $("#lgStamp").textContent = "standings not published yet";
    $("#lgTable").innerHTML =
      `<tbody><tr><td class="muted" style="position:static">F1 Fantasy hasn't published this league's standings file yet. New leagues usually appear after the next race's leaderboard update; the site picks it up automatically.</td></tr></tbody>`;
    $("#lgChart").innerHTML = "";
    $("#lgH2h").innerHTML = "";
    $("#lgOwn").innerHTML = "";
    return;
  }
  const when = L.collected ? new Date(L.collected) : null;
  $("#lgStamp").textContent =
    `${L.members.length} teams${L.auto ? " · auto-updated" : ""}${when && !isNaN(when) ? " · data from " + when.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}`;
  const lead = L.members[0].pts;
  const tok = (c) =>
    CHIPS.map(
      ([k, sh, n]) => `<span class="chiptok ${c[k] ? "used" : ""}" title="${n}${c[k] ? " (used)" : ""}">${sh}</span>`,
    ).join("");
  $("#lgTable").innerHTML =
    `<thead><tr><th>#</th><th style="text-align:left">Team</th><th>Pts</th><th>Gap</th><th title="Points in the latest round">Last</th><th style="text-align:left">Chips left</th><th>Bank</th></tr></thead><tbody>` +
    L.members
      .map((m, i) => {
        const last = m.hist.length ? m.hist[m.hist.length - 1].pts : null;
        return `<tr${m.name === myName ? ' style="background:var(--accent-soft)"' : ""}><td>${i + 1}</td><td style="text-align:left;position:static"><b>${esc(m.name)}</b>${m.mine ? ' <span class="tag sprint">you</span>' : ""}</td>
        <td><b>${m.pts.toLocaleString()}</b></td><td class="${i ? "bad" : "muted"}">${i ? "−" + (lead - m.pts).toLocaleString() : "—"}</td><td>${f0(last)}</td><td style="text-align:left">${Object.keys(m.chips || {}).length ? tok(m.chips) : '<span class="dim">import for chips</span>'}</td><td class="muted">${m.bank == null ? "—" : money(m.bank)}</td></tr>`;
      })
      .join("") +
    "</tbody>";
  renderLeagueChart(L);
  if (SEASON_OVER) {
    $("#lgH2hNote").textContent = "";
    $("#lgH2h").innerHTML = '<p class="note">The season is over: no race left to compare line-ups for.</p>';
    $("#lgOwn").innerHTML = "";
    return;
  }
  renderLeagueForecast(L, myIds, myName);
}
// Next race: head-to-head against each rival's current line-up, and league ownership
function renderLeagueForecast(L, myIds, myName) {
  // head-to-head: same simulated weekends for everyone, so the comparison is paired
  const mySmp = teamSamples(myIds, boostFor(myIds), ""),
    N = mySmp.length;
  const myMean = mySmp.reduce((a, b) => a + b, 0) / N;
  $("#lgH2hNote").textContent = `${myName} vs current rival line-ups`;
  const rivals = L.members.filter((m) => m.name !== myName && m.ids);
  $("#lgH2h").innerHTML =
    rivals
      .map((m) => {
        const ds = m.ids.slice(0, 5),
          boost = ds.includes(m.boost) ? m.boost : boostFor(m.ids, 0, { boost: "auto" });
        const smp = teamSamples(m.ids, boost, "");
        let win = 0,
          gap = 0;
        for (let s = 0; s < N; s++) {
          if (mySmp[s] > smp[s]) win++;
          gap += mySmp[s] - smp[s];
        }
        const drs = ds.slice().sort((x, y) => (x === boost ? -1 : y === boost ? 1 : xpts(y, 1) - xpts(x, 1)));
        const chipsHtml =
          m.ids
            .slice(5)
            .map((id) => chip(id, { pts: xpts(id, 1), cls: myIds.includes(id) ? "" : "in" }))
            .join("") +
          '<span class="sep"></span>' +
          drs
            .map((id) =>
              chip(id, {
                pts: xpts(id, 1) * (id === boost ? 2 : 1),
                x: id === boost ? "2×" : "",
                cls: myIds.includes(id) ? "" : "in",
              }),
            )
            .join("");
        const p = win / N;
        return `<div class="bt"><span class="rk"></span><div style="display:flex;flex-direction:column;gap:8px;min-width:0"><b>${esc(m.name)}</b><div class="chips">${chipsHtml}</div></div>
      <div class="num"><b class="${p >= 0.5 ? "good" : "bad"}">${pct(p)}</b><span class="muted">you win</span><span class="${gap >= 0 ? "good" : "bad"}">${sgn(gap / N)} pts</span></div></div>`;
      })
      .join("") +
    `<p class="note">Green dot = an asset you don't have. Uses rivals' current line-ups; they can still transfer before lock. Your team: ${f1(myMean)} xPts.</p>`;

  // league ownership
  const own = {};
  for (const m of rivals) for (const id of m.ids) own[id] = (own[id] || 0) + 1;
  const ids = Array.from(new Set(Object.keys(own).concat(myIds)));
  const nr = Math.max(1, rivals.length);
  const rows = ids
    .map((id) => ({ id, n: own[id] || 0, mine: myIds.includes(id), x: xpts(id, 1) }))
    .filter((r) => (r.mine && r.n < rivals.length) || (!r.mine && r.n > 0))
    .sort((a, b) => a.mine - b.mine || b.n * b.x - a.n * a.x);
  $("#lgOwn").innerHTML =
    `<thead><tr><th>Asset</th><th style="text-align:left">Type</th><th title="How many rivals own it">Rivals</th><th>xPts R${NEXT.gd}</th><th title="Expected swing against the field: positive helps you">Swing</th></tr></thead><tbody>` +
    (rows.length
      ? rows
          .map((r) => {
            const a = byId[r.id];
            const sw = r.mine ? r.x * (1 - r.n / nr) : -r.x * (r.n / nr);
            return `<tr><td><span class="who">${codeBox(a)}<span>${esc(a.kind === "D" ? a.short : a.team)}</span></span></td>
        <td style="text-align:left">${r.mine ? '<span class="good">Only you</span>' : '<span class="bad">Threat</span>'}</td><td>${r.n}/${rivals.length}</td><td>${f1(r.x)}</td><td${heat(sw, -30, 30)} class="${sw >= 0 ? "good" : "bad"}">${sgn(sw)}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="muted">Your line-up matches the whole league.</td></tr>`) +
    "</tbody>";
}
// Round points for a team: the private repo's round table (after unlocking) first, else an imported league.
function teamHist(name) {
  const rs = ((SEALED && SEALED.rounds) || [])
    .filter((r) => r.pts[name] != null)
    .map((r) => ({ gd: r.gd, pts: r.pts[name] }));
  if (rs.length) return rs;
  const im = state.league && state.league.members.find((m) => m.name === name);
  return im ? im.hist : [];
}
const cumPts = (hist, gds) => {
  let c = 0;
  const by = Object.fromEntries(hist.map((h) => [h.gd, h.pts]));
  return gds.map((gd) => ({ v: (c += by[gd] || 0), r: by[gd] ?? null }));
};
// chip badges for a team's line: your teams from the saved line-ups, rivals from an import
function chipMarks(name, gds) {
  const L = lineups(name),
    im = state.league && state.league.members.find((m) => m.name === name),
    short = (k) => (CHIPS.find(([c]) => c === k) || [])[1];
  const at = {};
  if (L) for (const [g, r] of Object.entries(L)) if (r.chip) at[+g] = short(r.chip);
  if (im && im.chipGd) for (const [k, g] of Object.entries(im.chipGd)) if (!at[g]) at[g] = short(k);
  return gds.map((g) => at[g] || null);
}
function renderLeagueChart(L) {
  const mode = state.lgMode || "total",
    withH = L.members.filter((m) => m.hist.length);
  const gds = [...new Set(withH.flatMap((m) => m.hist.map((h) => h.gd)))].sort((a, b) => a - b);
  const cum = new Map(withH.map((m) => [m.name, cumPts(m.hist, gds)]));
  const ref = cum.has(state.lgRef)
    ? state.lgRef
    : cum.has(activeTeam().name)
      ? activeTeam().name
      : withH[0] && withH[0].name;
  $$("#lgMode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lgm === mode)));
  $("#lgRefBox").hidden = mode !== "rel";
  $("#lgRef").innerHTML = withH
    .map((m) => `<option ${m.name === ref ? "selected" : ""}>${esc(m.name)}</option>`)
    .join("");
  $("#lgChips").checked = !!state.lgChips;
  // league rank after each round, from the running totals
  const rankAt = (i, name) =>
    1 + withH.filter((m) => m.name !== name && cum.get(m.name)[i].v > cum.get(name)[i].v).length;
  const series = withH.map((m) => {
    const c = cum.get(m.name);
    const pts =
      mode === "rel"
        ? c.map((p, i) => ({ v: p.v - cum.get(ref)[i].v, r: p.r }))
        : mode === "race"
          ? c.map((p) => ({ v: p.r, r: null }))
          : mode === "rank"
            ? c.map((p, i) => ({ v: rankAt(i, m.name), r: p.r }))
            : c;
    return {
      name: m.name,
      me: m.name === activeTeam().name,
      pts,
      marks: state.lgChips ? chipMarks(m.name, gds) : null,
    };
  });
  const opts =
    mode === "rank"
      ? { invert: true, fmt: (v) => "#" + v }
      : mode === "rel"
        ? { fmt: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString() }
        : {};
  lineChart(
    $("#lgChart"),
    gds,
    series,
    {
      total: "Cumulative league points by round",
      rel: `Points relative to ${ref}`,
      race: "Points scored each round",
      rank: "League position after each round",
    }[mode],
    opts,
  );
}
// Cumulative line chart on a gameday axis. series: [{name, me, color, dash, pts: [{v, r}] aligned with gds}]; v null = no data.
function lineChart(box, gds, series, label, opt = {}) {
  series = series.filter((s) => s.pts.some((p) => p.v != null));
  if (!series.length || !gds.length) {
    box.innerHTML = '<p class="note">No round history yet.</p>';
    return;
  }
  const W = 640,
    H = 260,
    ml = 44,
    mr = 120,
    mt = 10,
    mb = 26;
  const vs = series.flatMap((s) => s.pts.map((p) => p.v).filter((v) => v != null));
  const inv = !!opt.invert,
    fmt = opt.fmt || ((v) => (v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString());
  const maxV = inv ? Math.max(...vs) : Math.max(0, ...vs),
    minV = inv ? Math.min(1, ...vs) : Math.min(0, ...vs),
    span = Math.max(1, maxV - minV);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find((st) => span / st <= 7) || 5000;
  const top = Math.max(step, Math.ceil(maxV / step) * step),
    lo = inv ? Math.max(1, Math.floor(minV / step) * step) : Math.floor(minV / step) * step;
  const x = (i) => ml + (i / Math.max(1, gds.length - 1)) * (W - ml - mr);
  const y = (v) => {
    const t = (v - lo) / Math.max(1e-9, top - lo);
    return mt + (inv ? t : 1 - t) * (H - mt - mb);
  }; // rank: 1 at the top
  const col = (s) => (s.me ? "#A855F7" : s.color || "#71717A");
  const lastI = (s) => s.pts.reduce((k, p, i) => (p.v != null ? i : k), -1);
  let g = "";
  for (let v = lo; v <= top; v += step)
    g += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 && lo < 0 ? "#52525B" : "#27272A"}" stroke-width="1"/><text x="${ml - 8}" y="${y(v) + 4}" fill="#A1A1AA" font-size="11" text-anchor="end">${esc(fmt(v))}</text>`;
  const every = Math.ceil(gds.length / 12);
  gds.forEach((gd, i) => {
    if (i % every === 0 || i === gds.length - 1)
      g += `<text x="${x(i)}" y="${H - 6}" fill="#A1A1AA" font-size="11" text-anchor="middle">R${gd}</text>`;
  });
  const labels = series.map((s) => ({ s, y: y(s.pts[lastI(s)].v) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13; // keep end labels apart
  for (const s of series.slice().sort((a, b) => a.me - b.me)) {
    // draw the active team last, on top
    let d = "",
      pen = false;
    s.pts.forEach((p, i) => {
      if (p.v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    });
    g += `<path d="${d}" fill="none" stroke="${col(s)}" stroke-width="2"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    const li = lastI(s);
    g += `<circle cx="${x(li)}" cy="${y(s.pts[li].v)}" r="4" fill="${col(s)}" stroke="#0A0A0A" stroke-width="2"/>`;
  }
  // chip badges where a chip was played
  for (const s of series)
    (s.marks || []).forEach((m, i) => {
      if (!m || s.pts[i].v == null) return;
      const cx = x(i),
        cy = y(s.pts[i].v) - 13,
        w = m.length * 6.5 + 8;
      g += `<g><rect x="${cx - w / 2}" y="${cy - 8}" width="${w}" height="15" rx="4" fill="${col(s)}"/><text x="${cx}" y="${cy + 3}" fill="#0A0A0A" font-size="10" font-weight="700" text-anchor="middle">${esc(m)}</text><title>${esc(s.name)}: ${esc(m)} in R${gds[i]}</title></g>`;
    });
  for (const l of labels)
    g += `<text x="${W - mr + 10}" y="${l.y + 4}" fill="${l.s.me ? "#FAFAFA" : "#A1A1AA"}" font-size="11" font-weight="${l.s.me ? 600 : 400}">${esc(l.s.name.length > 16 ? l.s.name.slice(0, 15) + "…" : l.s.name)}</text>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">${g}<line class="cx" x1="0" x2="0" y1="${mt}" y2="${H - mb}" stroke="#A1A1AA" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="transparent"/></svg><div class="lgtip" hidden></div>`;
  const svg = box.querySelector("svg"),
    tip = box.querySelector(".lgtip"),
    cross = box.querySelector(".cx");
  const move = (ev) => {
    const r = svg.getBoundingClientRect(),
      px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(gds.length - 1, Math.round(((px - ml) / (W - ml - mr)) * (gds.length - 1))));
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    const rows = series
      .filter((s) => s.pts[i].v != null)
      .map((s) => ({ n: s.name, v: s.pts[i].v, r: s.pts[i].r, me: s.me, m: s.marks && s.marks[i] }))
      .sort((a, b) => (inv ? a.v - b.v : b.v - a.v));
    tip.innerHTML =
      `<b>Round ${gds[i]}</b>` +
      rows
        .map(
          (q) =>
            `<div style="${q.me ? "color:#FAFAFA;font-weight:600" : "color:#A1A1AA"}"><span>${esc(q.n)}${q.m ? ` <b style="color:var(--accent)">${esc(q.m)}</b>` : ""}</span><span>${esc(fmt(q.v))}${q.r != null ? ` <span class="dim">(+${q.r})</span>` : ""}</span></div>`,
        )
        .join("");
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth, Math.max(0, (x(i) / W) * r.width + 12)) + "px";
    tip.style.top = "8px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}
