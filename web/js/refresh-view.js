/* ---------- Settings > Admin > Data refresh: the status block (pure, tested in tests/refresh.test.js) ----------
   st = the refresh function's status (supabase/functions/refresh: state, next planned, latest runs, token set);
   refresh = { err, busy } from admin.js. */
import { esc } from "./core.js";

export const at = (t) =>
  t
    ? new Date(t).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const RUN_BY = {
  schedule: "GitHub's timer",
  workflow_dispatch: "the refresh plan or Refresh now",
  push: "a code change",
};
export function refreshHtml(st, refresh) {
  const run = st && st.runs && st.runs[0],
    s = (st && st.state) || {},
    running = run && run.status !== "completed";
  const last = !run
    ? "No refresh found."
    : `${running ? "Running since" : "Last refresh"} ${esc(at(run.created))}` +
      (running
        ? ""
        : run.conclusion === "success"
          ? ' <span class="good">✓ finished</span>'
          : ` <span class="bad">✗ ${esc(run.conclusion || "failed")}</span>`) +
      ` · started by ${esc(RUN_BY[run.event] || run.event)}` +
      ` · <a href="${esc(run.url)}" target="_blank" rel="noopener">details</a>`;
  const why = s.started_at
    ? `Last start from here: ${esc(at(s.started_at))}, ${s.source === "admin" ? "Refresh now" : "planned: " + esc(s.reason || "")}.`
    : "";
  const err =
    s.error && (!s.started_at || s.error_at > s.started_at)
      ? `<p class="note bad">Last problem (${esc(at(s.error_at))}): ${esc(s.error)}</p>`
      : "";
  // the GitHub token stops the refreshes when it expires: say when, and warn three weeks ahead
  const days = st && st.tokenExpires ? (Date.parse(st.tokenExpires) - Date.now()) / 864e5 : null;
  const token =
    days == null
      ? ""
      : days < 21
        ? `<p class="note bad">The GitHub token ${days < 0 ? "expired" : "expires"} on ${esc(at(st.tokenExpires))}: after that the site stops refreshing itself. Make a new one (GitHub → Settings → Developer settings → Fine-grained tokens: pit-wall only, Actions read and write) and replace GITHUB_DISPATCH_TOKEN in Supabase (Edge Functions → Secrets).</p>`
        : `<p class="note">GitHub token valid until ${esc(at(st.tokenExpires))}.</p>`;
  const next = ((st && st.next) || [])
    .slice(0, 3)
    .map((e) => `<li>${esc(at(e.at))}: ${esc(e.why)}</li>`)
    .join("");
  return (
    `<div class="adminfield"><label>Data refresh</label>` +
    `<p class="note">The site fetches new data and rebuilds itself after each session, just before lock and until a race's points are certified. Use Refresh now if something looks out of date; a refresh takes about 5 minutes.</p>` +
    (refresh.err ? `<p class="note bad">${esc(refresh.err)}</p>` : "") +
    (st && !st.token
      ? `<p class="note bad">Not set up yet: the GitHub token (GITHUB_DISPATCH_TOKEN) is missing in Supabase.</p>`
      : "") +
    token +
    (st
      ? `<p class="note">${last}${why ? "<br>" + why : ""}</p>${err}` +
        (next ? `<p class="note">Next planned:</p><ul class="note">${next}</ul>` : "")
      : "") +
    `<div class="adminrow"><button class="btn sm" data-refreshnow="1"${refresh.busy || running ? " disabled" : ""}>${running ? "Refreshing…" : "Refresh now"}</button>` +
    `<button class="btn sm ghost" data-refreshstatus="1">Check status</button></div></div>`
  );
}
