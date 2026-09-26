/* ---------- import from an F1 Fantasy data export (runs only in this browser) ---------- */
const dec = (x) => {
  try {
    return decodeURIComponent(x || "");
  } catch (e) {
    return x || "";
  }
};
const on = (v) => v != null && +v > 0;
// A team's key (see teamKey): the first 16 hex digits of SHA-256("<F1 account guid>:<team number>"), the same as
// f1feeds.team_key in Python. Hashed so no account id is kept; null where WebCrypto isn't available (plain http).
async function teamTk(guid, no) {
  if (!guid || no == null || !window.crypto || !crypto.subtle) return null;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${guid}:${no}`)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
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
// One played round from an export team record: the same fields the private repo's backfill.py keeps, so Hind.track
// reads imported and sealed rounds alike. A Final Fix lists both drivers: the qualifying team is kept as ids and the
// swap separately.
function roundRecord(u, gd, start) {
  const chip = Object.keys(CHIP_GD).find((k) => CHIP_GD[k].some((f) => +u[f] === gd)) || null;
  const ffIn = String(u.finalfxnewplayerid || ""),
    ffOut = String(u.finalfxoldplayerid || "");
  const ff = ffIn && ffOut ? { out: ffOut, in: ffIn, cat: u.finalfxracecat || "R" } : null;
  return {
    ids: (u.playerid || []).map((p) => String(p.id)).filter((id) => !ff || id !== ffIn),
    ff,
    start,
    boost: u.capplayerid,
    x3: u.mgcapplayerid,
    budget: u.maxteambal || (u.team_info && u.team_info.maxTeambal),
    bank: u.teambal,
    free: u.subsallowed,
    subs: u.usersubs,
    chip,
  };
}
// a member's played rounds; the team going into each is the previous round's (the one before a Limitless round)
function memberRounds(m) {
  const out = {};
  let held = [];
  for (const g of Object.keys(m.teams || {})
    .map(Number)
    .sort((a, b) => a - b)) {
    const u = m.teams[g]?.Data?.Value?.userTeam?.[0];
    if (!u || u.gdpoints == null) continue;
    const r = roundRecord(u, g, held);
    out[g] = r;
    if (r.chip !== "limitless") held = r.ids;
  }
  return out;
}
function lineup(u) {
  const ids = (u.playerid || []).map((p) => String(p.id)).filter((id) => byId[id]);
  const drs = ids.filter((id) => byId[id].kind === "D"),
    cons = ids.filter((id) => byId[id].kind === "C");
  return drs.length === 5 && cons.length === 2 ? drs.concat(cons) : null;
}
async function importOfficial(d) {
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
  // Your own team records carry no account id: find it from one of your teams in the league (same name and number)
  const rows = Object.values((d.league && d.league.members) || {}).map((m) => m.meta || {});
  const me = rows.find((r) => cur.some((u) => dec(r.team_name) === dec(u.teamname) && +r.team_no === +u.teamno));
  for (const u of cur) {
    const i = (u.teamno | 0) - 1,
      ids = lineup(u);
    if (i < 0 || i > 2 || !ids) continue;
    const p = prev.find((x) => x.teamno === u.teamno);
    // 2 free per race; one unused transfer carries over (not out of a Limitless week)
    const carried = p && (p.usersubs | 0) < 2 && !(+p.limitlesstakengd === latest - 1) ? 1 : 0;
    const cap = String(u.capplayerid || "");
    const tk = me ? await teamTk(me.user_guid, u.teamno) : null;
    if (tk) state.teams[i].tk = tk;
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
      asOf: latest, // set up for this race: tracking only takes over once it's been run
    });
    res.teams++;
  }
  const lg = d.league;
  if (lg && lg.members) {
    const info = lg.info?.Data?.Value || {};
    const mine = new Set(state.teams.map(teamKey));
    const tks = await Promise.all(Object.values(lg.members).map((m) => teamTk(m.meta?.user_guid, m.meta?.team_no)));
    const members = Object.values(lg.members)
      .map((m, j) => {
        const meta = m.meta || {},
          name = dec(meta.team_name),
          key = tks[j] || name;
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
          key,
          name,
          pts: +meta.cur_points || 0,
          ids: lineup(u),
          boost: String(u.capplayerid || ""),
          bank: +u.teambal || 0,
          chips: chipsFrom(u),
          chipGd: chipRounds(u),
          rounds: memberRounds(m),
          hist,
          mine: mine.has(key),
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
