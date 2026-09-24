/* ---------- import from an F1 Fantasy data export (runs only in this browser) ---------- */
const dec = (x) => {
  try {
    return decodeURIComponent(x || "");
  } catch (e) {
    return x || "";
  }
};
const on = (v) => v != null && +v > 0;
// the gameday each chip was played, from an export's team record
const CHIP_GD = {
  wildcard: ["is_wildcard_taken_gd_id", "wildcardtakengd"],
  limitless: ["limitlesstakengd"],
  x3: ["extradrstakengd"],
  finalfix: ["finalfixtakengd"],
  autopilot: ["autopilottakengd"],
  noneg: ["nonigativetakengd"],
};
const chipRounds = (u) =>
  Object.fromEntries(
    Object.entries(CHIP_GD)
      .map(([k, fs]) => [k, fs.map((f) => +u[f] || 0).find((v) => v > 0) || null])
      .filter(([, v]) => v),
  );
function chipsFrom(u) {
  return {
    wildcard: on(u.is_wildcard_taken_gd_id) || on(u.wildcardtakengd),
    limitless: on(u.limitlesstakengd),
    x3: on(u.extradrstakengd),
    finalfix: on(u.finalfixtakengd),
    autopilot: on(u.autopilottakengd),
    noneg: on(u.nonigativetakengd),
  };
}
function lineup(u) {
  const ids = (u.playerid || []).map((p) => String(p.id)).filter((id) => byId[id]);
  const drs = ids.filter((id) => byId[id].kind === "D"),
    cons = ids.filter((id) => byId[id].kind === "C");
  return drs.length === 5 && cons.length === 2 ? drs.concat(cons) : null;
}
function importOfficial(d) {
  if (!d || d.source !== "fantasy.formula1.com" || !d.my_team)
    throw new Error("That file isn't an F1 Fantasy data export.");
  const res = { teams: 0, league: 0 };
  const tk = Object.keys(d.my_team.teams || {}),
    gdOf = (k) => +k.split("_gd")[1];
  const latest = Math.max(...tk.map(gdOf));
  const pick = (gd) => {
    const k = tk.find((x) => gdOf(x) === gd);
    return (k && d.my_team.teams[k]?.Data?.Value?.userTeam) || [];
  };
  const cur = pick(latest),
    prev = pick(latest - 1);
  for (const u of cur) {
    const i = (u.teamno | 0) - 1,
      ids = lineup(u);
    if (i < 0 || i > 2 || !ids) continue;
    const p = prev.find((x) => x.teamno === u.teamno);
    // 2 free per race; one unused transfer carries over (not out of a Limitless week)
    const carried = p && (p.usersubs | 0) < 2 && !(+p.limitlesstakengd === latest - 1) ? 1 : 0;
    const cap = String(u.capplayerid || "");
    Object.assign(state.teams[i], {
      name: dec(u.teamname) || state.teams[i].name,
      team: ids,
      bank: +u.teambal || 0,
      free: 2 + carried,
      boost: ids.slice(0, 5).includes(cap) ? cap : "auto",
      chipsUsed: chipsFrom(u),
      example: false,
      ovPts: +u.ovpoints || null,
      ovRank: +u.ovrank || null,
    });
    res.teams++;
  }
  const lg = d.league;
  if (lg && lg.members) {
    const info = lg.info?.Data?.Value || {};
    const mine = new Set(state.teams.map((t) => t.name));
    const members = Object.values(lg.members)
      .map((m) => {
        const meta = m.meta || {},
          name = dec(meta.team_name);
        const keys = Object.keys(m.teams || {})
          .map(Number)
          .sort((a, b) => a - b);
        const u = m.teams[keys[keys.length - 1]]?.Data?.Value?.userTeam?.[0] || {};
        const md = m.gamedays?.Data?.Value?.mdDetails || {};
        const hist = Object.keys(md)
          .map(Number)
          .sort((a, b) => a - b)
          .map((k) => ({ gd: k, pts: +md[k].pts || 0 }));
        // only what the planner needs: no account ids or user names are kept
        return {
          name,
          pts: +meta.cur_points || 0,
          ids: lineup(u),
          boost: String(u.capplayerid || ""),
          bank: +u.teambal || 0,
          chips: chipsFrom(u),
          chipGd: chipRounds(u),
          hist,
          mine: mine.has(name),
        };
      })
      .sort((a, b) => b.pts - a.pts);
    state.league = {
      name: dec(info.leagueName) || "League",
      max: info.maxMem,
      collected: d.collected_at,
      round: latest,
      members,
    };
    res.league = members.length;
  }
  return res;
}
