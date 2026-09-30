/* ---------- Sim lab > Model health (owner only): how the model did, round by round (pure, tests/refresh.test.js) ----
   mh = DATA.modelHealth: accuracy (backtest/accuracy.js, recomputed when a round's points are certified or the engine
   changes) and fit (the weekly settings fit, .github/workflows/fit.yml). Changes to the model are the owner's call:
   the fit only proposes. */
import { esc } from "./core.js";

const f2 = (x) => (x == null ? "–" : (+x).toFixed(2));
const f1 = (x) => (x == null ? "–" : (+x).toFixed(1));
const pc = (x) => (x == null ? "–" : `${Math.round(100 * x)}%`);
const sg = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + (+x).toFixed(1));

function fitHtml(fit) {
  if (!fit) return `<p class="note">No weekly settings fit yet (it runs on Tuesdays after a race weekend).</p>`;
  const gain = fit.shipped.crps - fit.fitted.crps;
  const head =
    `<p class="note"><b>Weekly settings fit</b> (${esc(fit.generated.replace("T", " ").replace("Z", " UTC"))}, rounds ` +
    `R${fit.rounds[0]}–R${fit.rounds[fit.rounds.length - 1]}, ${fit.N.toLocaleString()} sims): CRPS ${f2(fit.shipped.crps)} as shipped → ${f2(fit.fitted.crps)} fitted` +
    ` (${gain > 0 ? "−" : "+"}${Math.abs(gain).toFixed(3)}), MAE ${f2(fit.shipped.mae)} → ${f2(fit.fitted.mae)}.` +
    (fit.holdout
      ? ` <b>On rounds it wasn't fitted to</b> (R${fit.holdout.rounds.join(", R")}${fit.holdout.folds ? ", each by a fit on the rounds before it" : ""}): ${f2(fit.holdout.shipped)} → ${f2(fit.holdout.fitted)}, ${fit.holdout.se != null && fit.holdout.dCrps <= -2 * fit.holdout.se ? "a gain beyond noise" : "within noise (" + (fit.holdout.dCrps > 0 ? "+" : "−") + Math.abs(fit.holdout.dCrps).toFixed(3) + (fit.holdout.se != null ? " ± " + fit.holdout.se.toFixed(3) : "") + ")"}.`
      : "") +
    `</p>`;
  const nf = fit.holdout && fit.holdout.folds ? fit.holdout.folds.length : 0;
  if (!fit.changes.length)
    return head + `<p class="note">The shipped settings are still the best fit: nothing to change.</p>`;
  const rows = fit.changes
    .map(
      (c) =>
        `<tr><td style="text-align:left">${esc(c.setting)}</td><td>${esc(String(c.shipped))}</td><td>${esc(String(c.fitted))}</td>` +
        (nf ? `<td class="${c.folds === nf ? "good" : c.folds ? "" : "bad"}">${c.folds ?? "–"} of ${nf}</td>` : "") +
        `</tr>`,
    )
    .join("");
  return (
    head +
    `<div class="tw"><table class="stat"><thead><tr><th style="text-align:left">Setting</th><th>Shipped</th><th>Fitted</th>${nf ? `<th title="How many of the held-out folds' fits (each on fewer rounds) made the same change: a change none of them made is fragile">Folds agree</th>` : ""}</tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="note">${gain < 0.1 ? "<b>Within noise:</b> a gain under about 0.1 CRPS can't be told from chance with this many rounds, so keep the shipped settings. " : ""}` +
    `The first figures are on the rounds it was fitted on (flattering); the held-out ones are the test. To adopt a change, ask for it to be applied in engine.js and checked with the backtest; it's worth it only if it holds over the next weeks too.</p>`
  );
}

// the challengers frozen next to the shipped model at every lock (engine CHALLENGERS), scored per certified round
function challengersHtml(ch) {
  const list = (ch && ch.summary) || [];
  if (!list.length)
    return `<p class="note"><b>Challengers:</b> frozen next to the shipped model from R16; scored once a round they were frozen for is certified.</p>`;
  const rows = list
    .map((c) => {
      const clear = c.dqsSe != null && Math.abs(c.dqs) > 2 * c.dqsSe;
      const verdict =
        c.n < 5
          ? "too few rounds"
          : !clear
            ? "within noise"
            : c.dqs < 0
              ? "<b class=good>better</b>"
              : "<span class=bad>worse</span>";
      // rounds frozen without the challenger's own input, or identical to the shipped model: not counted
      const skip = c.skipped
        ? ` <span class="dim" title="Rounds frozen without its own input, or identical to the shipped model: not counted">+${c.skipped} not evaluable</span>`
        : "";
      return `<tr><td style="text-align:left">${esc(c.label)}</td><td>${c.n}${skip}</td><td>${c.dqs > 0 ? "+" : ""}${f2(c.dqs)}${c.dqsSe != null ? ` ± ${f2(c.dqsSe)}` : ""}</td><td>${sg(c.dmae)}</td><td>${verdict}</td></tr>`;
    })
    .join("");
  return (
    `<p class="note"><b>Challengers</b> (frozen at lock next to the shipped model, scored on the rounds they hadn't seen): score difference, lower is better; ± is the standard error over rounds.</p>` +
    `<div class="tw"><table class="stat"><thead><tr><th style="text-align:left">Challenger</th><th>Rounds</th><th title="Quantile score (≈ CRPS) minus the shipped model's">Δ score</th><th title="MAE minus the shipped model's">Δ MAE</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

// The season report (backtest/season_report.js, made by the season fold-over: .github/workflows/fold.yml): every
// challenger against the live model over the season's rounds. rep = mh.report, fold = mh.fold (what was folded).
const VERDICT = {
  "better-lock": ["good", "Better at lock"],
  "worse-lock": ["bad", "Worse at lock"],
  "better-back": ["", "Better looking back: not a test yet"],
  "worse-back": ["bad", "Worse looking back"],
  noise: ["dim", "No difference beyond noise"],
  same: ["dim", "Never differed from the live model"],
};
const f3 = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + (+x).toFixed(3));
const when = (t) => esc(String(t).slice(0, 16).replace("T", " ").replace("Z", "")) + " UTC";
export function seasonReportHtml(rep, fold) {
  const folded = fold
    ? `<p class="note">Last fold-over ${when(fold.at)}: past seasons through ${esc(String(fold.through))} ` +
      `(${fold.priors.races} races of circuit history; ${fold.skills.wetQ} wet-qualifying and ${fold.skills.sprFin} sprint results for the drivers' skills).</p>`
    : "";
  if (!rep) return folded + `<p class="note">No season report yet: it's made by the fold-over.</p>`;
  const L = rep.live;
  const rows = rep.challengers
    .map((c) => {
      const b = c.back,
        k = c.lock;
      const [cls, text] = VERDICT[c.verdict] || ["dim", c.verdict];
      const cov =
        c.coverage && c.coverage.n < c.coverage.of
          ? ` <span class="dim" title="Its own input: ${esc(c.coverage.what)}">(${c.coverage.n} of ${c.coverage.of})</span>`
          : "";
      return (
        `<tr><td style="text-align:left">${esc(c.label)}${cov}</td><td>${b.differs} of ${b.n}</td>` +
        `<td>${f3(b.d)}${b.se != null ? ` ± ${(+b.se).toFixed(3)}` : ""}</td><td>${f3(b.dMae)}</td><td>${b.dTeam > 0 ? "+" : ""}${b.dTeam}</td>` +
        `<td>${k && k.n ? `${k.dqs > 0 ? "+" : ""}${f2(k.dqs)}${k.dqsSe != null ? ` ± ${f2(k.dqsSe)}` : ""} <span class="dim">(${k.n})</span>` : `<span class="dim">–</span>`}</td>` +
        `<td style="text-align:left" class="${cls}">${esc(text)}</td></tr>`
      );
    })
    .join("");
  return (
    `<p class="note"><b>Season report ${esc(String(rep.season))}</b>, R${rep.from}–R${rep.to} (${rep.final ? "the full season" : "the season so far"}; made ${when(rep.generated)}). ` +
    `The live model: CRPS ${f2(L.crps)}, MAE ${f2(L.mae)} (simple guesses: season average ${f2(L.seasonAvg)}, recent form ${f2(L.form)}), ` +
    `inside the 10–90% range ${pc(L.cover80)}; a team picked on its projections each round ${L.team} pts of the best possible ${L.best}.</p>` +
    `<div class="tw"><table class="stat"><thead><tr><th style="text-align:left">Challenger</th>` +
    `<th title="Rounds where it came out different from the live model at all">Differed</th>` +
    `<th title="Looking back: its CRPS minus the live model's per round (the data as it stood before each round, same seeds); lower is better; ± the standard error over rounds">Δ CRPS</th>` +
    `<th title="Looking back: MAE minus the live model's">Δ MAE</th>` +
    `<th title="Looking back: the points of the team picked on its projections each round, minus the live model's">Δ team pts</th>` +
    `<th title="Frozen at lock before each round (rounds it could be scored on): score minus the live model's; the only figures from rounds it hadn't seen">At lock</th>` +
    `<th style="text-align:left">Verdict</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="note">Looking back is an indication, not a test: the challengers were built with these rounds in view. A challenger earns a change only at lock: 5 or more scored rounds and a gain beyond twice its ± (then ask for it to be adopted in engine.js). A difference under about 0.1 CRPS can't be told from chance with this many rounds.</p>` +
    folded
  );
}

// calibration by group (drivers / constructors, sprint / normal, wet / dry, safety car or not): walk-forward and,
// pooled over the certified rounds, the frozen projections
function groupsHtml(acc) {
  const w = (acc.season && acc.season.groups) || {},
    fz = acc.frozenGroups || {};
  const keys = [...new Set([...Object.keys(w), ...Object.keys(fz)])];
  if (!keys.length) return "";
  const rows = keys
    .map((k) => {
      const a = w[k] || {},
        b = fz[k] || {};
      return (
        `<tr><td style="text-align:left">${esc(k)}</td><td>${a.rounds ?? "–"}</td><td>${f2(a.crps)}</td><td>${f1(a.mae)}</td><td>${sg(a.bias)}</td><td>${pc(a.cover80)}</td><td>${pc(a.cover50)}</td>` +
        `<td>${a.cond ? `${pc(a.cond.cover80)} / ${pc(a.cond.cover50)}` : ""}</td>` +
        `<td>${b.rounds ?? "–"}</td><td>${f1(b.mae)}</td><td>${sg(b.bias)}</td><td>${pc(b.cover50)}</td></tr>`
      );
    })
    .join("");
  return (
    `<p class="note"><b>By group</b>: a group running hot or cold while the whole looks fine. Few rounds in a group (wet, sprint) = an indication only.</p>` +
    `<div class="tw"><table class="stat"><thead><tr><th style="text-align:left">Group</th><th title="Walk-forward rounds">Rounds</th><th>CRPS</th><th>MAE</th><th title="Projected minus actual (+ = too high)">Bias</th><th title="80% is honest">In 10–90%</th><th title="50% is honest">In 25–75%</th><th title="Wet / safety-car groups scored against only the simulated races that had (or didn't have) the same: grouping by what happened makes even a perfect forecast look too narrow where it happened. 80% / 50% is honest">Matching races</th>` +
    `<th title="Frozen at lock: certified rounds">Frozen rounds</th><th>Frozen MAE</th><th>Frozen bias</th><th>Frozen in 25–75%</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

export function modelHealthHtml(mh, schedule = []) {
  const acc = mh && mh.accuracy;
  if (!acc || !acc.rounds || !acc.rounds.length)
    return (
      `<p class="note">No model health yet: it's worked out once a round's points are certified.</p>` +
      fitHtml(mh && mh.fit) +
      (mh && mh.report ? seasonReportHtml(mh.report, mh.fold) : "")
    );
  const s = acc.season;
  const name = (gd) => (schedule.find((g) => g.gd === gd)?.name || "").replace(" Grand Prix", "");
  const walk = acc.rounds.filter((r) => r.walk);
  const top = Math.max(...walk.map((r) => r.walk.crps), 1);
  const summary = s
    ? `<p class="note">Walk-forward, R${s.from}–R${acc.rounds[acc.rounds.length - 1].gd} (the data as it stood before each round, today's engine): ` +
      `<b>CRPS ${f2(s.crps)}</b>, MAE ${f2(s.mae)} (drivers ${f1(s.maeD)}, constructors ${f1(s.maeC)}), rank corr ${f2(s.rho)}. ` +
      `Inside the 10–90% range ${pc(s.cover80)} (80% is honest), inside 25–75% ${pc(s.cover50)} (50%). ` +
      `Simple guesses, MAE: season average ${f2(s.baselines?.seasonAvg)}, recent form ${f2(s.baselines?.form)}. ` +
      `A team picked on our projections each round: ${s.team} pts (the best possible ${s.best}).</p>`
    : "";
  const rows = acc.rounds
    .filter((r) => r.walk || r.frozen)
    .reverse()
    .map((r) => {
      const w = r.walk || {},
        fz = r.frozen || {};
      const bar = r.walk
        ? `<div style="display:flex;align-items:center;gap:6px"><span style="display:inline-block;height:8px;border-radius:2px;background:var(--accent);width:${Math.round((60 * w.crps) / top)}px"></span>${f2(w.crps)}</div>`
        : "–";
      return (
        `<tr><td style="text-align:left">R${r.gd} ${esc(name(r.gd))}</td><td>${bar}</td><td>${f1(w.mae)}</td><td>${sg(w.bias)}</td><td>${f2(w.rho)}</td>` +
        `<td>${f2(fz.crps)}</td><td>${f1(fz.mae)}</td><td>${f2(fz.rho)}</td><td>${pc(fz.in50)}</td></tr>`
      );
    })
    .join("");
  const last = acc.rounds.filter((r) => r.frozen).pop();
  const miss = last
    ? `<p class="note">Biggest misses at R${last.gd} (frozen projection → actual): ` +
      last.frozen.miss.map((m) => `${esc(m.name)} ${f1(m.x)} → ${m.y}`).join(", ") +
      ".</p>"
    : "";
  return (
    summary +
    `<div class="tw"><table class="stat"><thead><tr><th style="text-align:left">Round</th><th title="Walk-forward CRPS: lower is better">CRPS</th><th title="Mean absolute error, points">MAE</th><th title="Projected minus actual, points (+ = too high)">Bias</th><th title="Rank correlation">Rank</th>` +
    `<th title="Exact CRPS of the forecast frozen at lock (from its stored samples, R16 on)">Frozen CRPS</th><th title="What the site showed at lock vs the result">Frozen MAE</th><th title="Frozen projection, rank correlation">Frozen rank</th><th title="Share of assets inside the frozen 25–75% range (50% is honest)">In 25–75%</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    miss +
    groupsHtml(acc) +
    `<p class="note">Recomputed when a round's points are certified or any input or the engine changes (last ${esc(acc.generated.replace("T", " ").replace("Z", " UTC"))}). One round is mostly noise: judge trends over several.</p>` +
    challengersHtml(acc.challengers) +
    (mh.report ? seasonReportHtml(mh.report, mh.fold) : "") +
    fitHtml(mh.fit)
  );
}
