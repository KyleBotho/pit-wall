/* ---------- Team Tracking: pure helpers (no DOM, no account calls; setup.js does those) ----------
   Users join Pit Wall's tracking league on F1 Fantasy and link their F1 Fantasy account once
   (docs/team-tracking-plan.md). The private workflow writes one public.tracked_accounts row per account in the league:
   {account_key, username, teams: [{tk, no, name}], body: {names, rounds, seen}}. */

// The league payload the page reads (sync.js LEAGUE_DATA): the owner's private leagues (league_data, readers only)
// with the linked account's teams merged in. Either can be missing. The league data wins where both know a value
// (its rounds come from exports too); the account adds its teams' names, rounds and seen line-ups.
export function mergeLeague(leagues, account) {
  if (!account) return leagues || null;
  const base = leagues || { v: 2, leagues: [], names: {}, rounds: [], lineups: {}, rivals: {}, seen: {} };
  const rounds = new Map((base.rounds || []).map((r) => [r.gd, { ...r.pts }]));
  for (const r of account.rounds || []) rounds.set(r.gd, { ...r.pts, ...rounds.get(r.gd) });
  const seen = { ...base.seen };
  for (const [k, v] of Object.entries(account.seen || {})) seen[k] = { ...v, ...seen[k] };
  return {
    ...base,
    names: { ...account.names, ...base.names },
    rounds: [...rounds].sort((a, b) => a[0] - b[0]).map(([gd, pts]) => ({ gd, pts })),
    seen,
  };
}

// Where the user stands with Team Tracking (Settings and the Calculator show what to do next). user: signed in;
// link: the linked account key (undefined = not loaded yet, null = none); row: its tracked_accounts row (null = not
// in the data, e.g. not in this season's tracking league yet).
export function setupStep({ user, link, row }) {
  if (!user) return "signin";
  if (link === undefined) return "loading";
  if (link) return row ? "linked" : "missing";
  return "join";
}

// A username search as an ilike pattern: the text anywhere in the name, with the user's own % _ \ taken literally.
// Null when there's too little to search for.
export function likePattern(q) {
  const t = String(q || "").trim();
  return t.length < 2 ? null : `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}

// The help contact an admin sets (app_config support_contact): an email address or an http(s) link, as {href, text};
// null for anything else, so a typo never becomes a broken or odd link.
export function contactLink(v) {
  const t = String(v || "").trim();
  if (/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(t)) return { href: "mailto:" + t, text: t };
  if (/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(t)) return { href: t, text: t.replace(/^https?:\/\//i, "") };
  return null;
}

// The linked account's teams in team-number order, at most three (the Calculator's slots).
export const accountTeams = (row) =>
  ((row && row.teams) || [])
    .filter((t) => t && t.tk)
    .slice()
    .sort((a, b) => (a.no ?? 9) - (b.no ?? 9))
    .slice(0, 3);

/* ---------- Rivals: tracking-league teams the user picked to compare with ----------
   state.rivals = [{ak, tk}]: the account key (to load its tracked_accounts row) and the team key. Nobody becomes a
   rival by joining the league: only teams picked here are listed. */

// a saved list, cleaned: well-formed picks, each team once
export function rivalPicks(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : [])
    if (p && typeof p.ak === "string" && typeof p.tk === "string" && p.ak && p.tk && !out.some((x) => x.tk === p.tk))
      out.push({ ak: p.ak, tk: p.tk });
  return out;
}
// the list with that team added, or taken out if it was there
export function toggleRival(list, ak, tk) {
  const l = rivalPicks(list);
  return l.some((p) => p.tk === tk) ? l.filter((p) => p.tk !== tk) : [...l, { ak, tk }];
}
// the accounts whose rows the picks need
export const rivalAccounts = (list) => [...new Set(rivalPicks(list).map((p) => p.ak))];

// One rival account's body cut down to the picked teams (null when none of them is picked), so the page never
// holds data on teams nobody picked.
export function rivalBody(row, tks) {
  const b = (row && row.body) || {};
  const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => tks.includes(k)));
  const names = pick(b.names);
  for (const t of (row && row.teams) || []) if (t && tks.includes(t.tk) && t.name) names[t.tk] = t.name;
  const rounds = (b.rounds || []).map((r) => ({ gd: r.gd, pts: pick(r.pts) })).filter((r) => Object.keys(r.pts).length);
  const seen = pick(b.seen);
  return Object.keys(names).length || rounds.length || Object.keys(seen).length ? { names, rounds, seen } : null;
}
// the league payload with the picked rivals' teams merged in (after your own data, which wins where both know a value)
export function mergeRivals(base, rows, list) {
  const tks = rivalPicks(list).map((p) => p.tk);
  if (!tks.length) return base || null;
  return (rows || []).reduce((acc, row) => mergeLeague(acc, rivalBody(row, tks)), base || null);
}
// The picked rivals for the dialog: team name, username, and whether the team is still in the tracking league
// (rows: the loaded tracked_accounts rows; null = not loaded yet). own: your own team keys, never listed.
export function rivalList(list, rows, own = []) {
  return rivalPicks(list)
    .filter((p) => !own.includes(p.tk))
    .map((p) => {
      const row = (rows || []).find((r) => r.account_key === p.ak);
      const team = row && (row.teams || []).find((t) => t && t.tk === p.tk);
      return {
        ...p,
        name: (team && team.name) || (row && row.body && row.body.names && row.body.names[p.tk]) || "Unknown team",
        user: row ? row.username : "",
        missing: rows != null && !team,
      };
    });
}
