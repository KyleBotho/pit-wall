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

/* ---------- Rivals: teams the user picked to compare with ----------
   state.rivals holds three kinds of pick: {ak, tk} a tracking-league team (the account key loads its tracked_accounts
   row; tk = team key), {lg, tk} a member of one of your private leagues (league readers only; lg = the league's name)
   and {tpl} the global top-100 or top-500 template. Nobody becomes a rival by joining a league: only picks are listed. */

export const TEMPLATES = { top100: "Top-100 template", top500: "Top-500 template" };
const str = (v) => typeof v === "string" && v !== "";
// what identifies a pick: the template, else the team key (a team picked from two places is one rival)
export const pickKey = (p) => (p.tpl ? "tpl:" + p.tpl : p.tk);
// a saved list, cleaned: well-formed picks, each rival once
export function rivalPicks(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const c = !p
      ? null
      : p.tpl != null
        ? p.tpl in TEMPLATES
          ? { tpl: p.tpl }
          : null
        : str(p.tk) && str(p.ak)
          ? { ak: p.ak, tk: p.tk }
          : str(p.tk) && str(p.lg)
            ? { lg: p.lg, tk: p.tk }
            : null;
    if (c && !out.some((x) => pickKey(x) === pickKey(c))) out.push(c);
  }
  return out;
}
// the list with that pick added, or taken out if it was there
export function toggleRival(list, pick) {
  const l = rivalPicks(list),
    k = pickKey(pick);
  return l.some((p) => pickKey(p) === k) ? l.filter((p) => pickKey(p) !== k) : rivalPicks([...l, pick]);
}
// the tracking-league accounts whose rows the picks need
export const rivalAccounts = (list) => [...new Set(rivalPicks(list).flatMap((p) => (p.ak ? [p.ak] : [])))];

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
// the league payload with the picked tracking-league teams merged in (after your own data, which wins where both
// know a value); private-league members are in it already
export function mergeRivals(base, rows, list) {
  const tks = rivalPicks(list).flatMap((p) => (p.ak ? [p.tk] : []));
  if (!tks.length) return base || null;
  return (rows || []).reduce((acc, row) => mergeLeague(acc, rivalBody(row, tks)), base || null);
}
// The picks for the dialog: name, where it's from (username, league or "F1 Fantasy"), and whether it's gone (a team
// no longer in the tracking league or your leagues). rows: the loaded tracked_accounts rows, leagues: your private
// leagues [{name, members: [{key, name}]}] (null = not loaded yet: nothing is called gone). own: your team keys.
export function rivalList(list, rows, own = [], leagues = null) {
  return rivalPicks(list)
    .filter((p) => p.tpl || !own.includes(p.tk))
    .map((p) => {
      if (p.tpl) return { ...p, key: pickKey(p), name: TEMPLATES[p.tpl], user: "F1 Fantasy global", missing: false };
      if (p.lg) {
        const lg = (leagues || []).find((l) => (l.members || []).some((m) => m.key === p.tk));
        const m = lg && lg.members.find((x) => x.key === p.tk);
        return {
          ...p,
          key: p.tk,
          name: m ? m.name : "Unknown team",
          user: lg ? lg.name : p.lg,
          missing: !!leagues && !m,
        };
      }
      const row = (rows || []).find((r) => r.account_key === p.ak);
      const team = row && (row.teams || []).find((t) => t && t.tk === p.tk);
      return {
        ...p,
        key: p.tk,
        name: (team && team.name) || (row && row.body && row.body.names && row.body.names[p.tk]) || "Unknown team",
        user: row ? row.username : "",
        missing: rows != null && !team,
      };
    });
}
