/* ---------- My rivals: you against the rivals you picked (rivals.js), next race and season ----------
   A view of its own in the Leagues group, so the League views stay limited to real leagues. The next race reuses the
   League head-to-head (league.js h2h, ownTable) with the rivals' current line-ups (forecast.js rivalTeams); the
   season reuses the points race (pointsRace) with your teams, the picked teams and, for a picked template, the
   global cut-off it stands for (the templates have no season of their own). */
import { $, DATA, NEXT, SEASON_OVER, esc, f1, infoTip } from "./core.js";
import { activeTeam, state } from "./state.js";
import { rivalTeams } from "./forecast.js";
import { h2h, ownTable, pointsRace, teamHist, teamKey, teamLabel } from "./league.js";
import { needSync, syncState } from "./sync.js";

// the team you compare with: the one picked here (state.rvMe), else your active team; example teams only when
// nothing else is there
function myTeam() {
  const real = state.teams.filter((t) => !t.example);
  const t = state.teams[state.rvMe ?? state.active];
  return t && !t.example ? t : real.includes(activeTeam()) ? activeTeam() : real[0] || activeTeam();
}
// the global cut-off a picked template is compared with over the season (cumulative points by round)
const CUT = { top100: ["100", "#100 cut-off"], top500: ["500", "#500 cut-off"] };
function cutLine(tpl) {
  const [k, name] = CUT[tpl];
  const total = {};
  for (const h of (DATA.elite && DATA.elite.history) || []) if (h.cut && h.cut[k] != null) total[h.gd] = h.cut[k];
  return Object.keys(total).length ? { key: "tpl:" + tpl, name, total, color: "#71717A" } : null;
}

export function renderRivals() {
  const picks = state.rivals;
  $("#rivalsEmpty").hidden = picks.length > 0;
  $("#rivalsDash").hidden = !picks.length;
  $("#rivalsEmptyText").textContent = syncState.user
    ? "No rivals yet. Pick teams from the tracking league, your private leagues or the top-100/500 templates, and see how you stack up against them here."
    : "Sign in to pick rivals: teams from the tracking league or the top-100/500 templates.";
  needSync();
  if (!picks.length) return;
  const me = myTeam(),
    mine = state.teams.filter((t) => !t.example),
    rv = rivalTeams();
  $("#rvStamp").textContent =
    `${picks.length} picked${rv.length < picks.length ? ` · ${picks.length - rv.length} without a line-up yet` : ""}`;
  $("#rvMe").hidden = mine.length < 2;
  $("#rvMe").innerHTML = mine
    .map((t) => `<button data-rvme="${state.teams.indexOf(t)}" aria-pressed="${t === me}">${esc(t.name)}</button>`)
    .join("");

  // next race
  if (SEASON_OVER || !NEXT) {
    $("#rvH2hNote").textContent = $("#rvH2hTip").innerHTML = "";
    $("#rvH2h").innerHTML = '<p class="note">The season is over: no race left to compare line-ups for.</p>';
    $("#rvOwnBox").hidden = true;
  } else if (!rv.length) {
    $("#rvH2hNote").textContent = $("#rvH2hTip").innerHTML = "";
    $("#rvH2h").innerHTML =
      '<p class="note">None of your rivals has a line-up yet: a tracking-league team shows up after the first race since it joined.</p>';
    $("#rvOwnBox").hidden = true;
  } else {
    const h = h2h(
      me.team,
      rv.map((r) => ({ ...r, sub: r.user, goal: true })),
      { range: true },
    );
    $("#rvH2hNote").textContent =
      `${me.name}${me.example ? " (example team)" : ""} (${f1(h.mean)} xPts) vs your rivals, R${NEXT.gd}`;
    $("#rvH2hTip").innerHTML = infoTip(
      "Same simulated weekends for everyone. Green dot = an asset you don't have. The range is your points minus theirs on 80% of weekends. Rivals' line-ups are the ones F1's standings showed after the last race; they can still transfer before lock.",
    );
    $("#rvH2h").innerHTML = h.html;
    $("#rvOwnBox").hidden = false;
    $("#rvOwn").innerHTML = ownTable(me.team, rv, "Your line-up matches all your rivals.");
  }

  // season
  const late = [];
  const members = mine.map((t) => ({ key: teamKey(t), name: t.name, me: t === me, hist: teamHist(teamKey(t)) }));
  for (const p of picks) {
    if (p.tpl) {
      const c = cutLine(p.tpl);
      if (c) members.push(c);
      continue;
    }
    if (members.some((m) => m.key === p.tk)) continue; // one of your teams
    const hist = teamHist(p.tk);
    const name = (rv.find((r) => r.key === p.tk) || {}).name || teamLabel(p.tk);
    members.push({ key: p.tk, name, hist });
    const first = Math.min(...hist.map((h) => h.gd));
    if (hist.length && first > 1) late.push(`${name} (from R${first})`);
  }
  pointsRace("rv", members, "Rival");
  $("#rvSeasonNote").innerHTML = infoTip(
    (picks.some((p) => p.tpl)
      ? "A template has no season of its own: its dashed line is the global cut-off it stands for. "
      : "") +
      (late.length
        ? esc(
            `Points before a team was first seen aren't known, so its line starts later: ${late.join(", ")}. Race points compare them round by round.`,
          )
        : ""),
  );
}
