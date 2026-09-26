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
