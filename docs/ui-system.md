# Fantasy Pit Wall: UI system

Started 2026-09-28. The user's complaint was that the tool feels disjointed **between pages** (each page built its
own way), not within one page. The look to keep is the **Calculator and Live Scoring**; every other page is
brought in line with those two. Five fresh visual directions were shown and rejected; on 2026-09-29 the user's own
design system (Pit Lane 0.2) was adopted as a **retexture** (below).

Previews shown to the user (private artifacts): the audit and system
https://claude.ai/artifact/UqCjFNVAkHJReX3Bp9Sozx, the three decisions
https://claude.ai/artifact/GJPxdTpsGv35nFG9youEic, and the retexture mockup (drafts 1-12)
https://claude.ai/artifact/8MG8xgqFdjEJh9AAnCBdRh.

## Retexture: Pit Lane 0.2 (user, 2026-09-29)
The user's mood board and design system "Fantasy Pit Lane" 0.2 (source kept in `docs/design/`: DESIGN-SYSTEM.md,
tokens.css, tokens.json; not formatted by Prettier) applied as a **retexture, not a relayout**: colours, surfaces and
a few controls change; layouts, panel names, control sizes and fonts stay.
- **Name** stays Fantasy Pit Wall (0.2 says Pit Lane). Logo, favicon, link preview unchanged.
- **Tokens** (`app.css :root`, the app's names with 0.2 values): page Carbon #111316, panels #181C21, raised
  #22272E, hover #2A2F36, lines #343B43, control borders #707982 (`--ctl`), soft white #F2F2EF (`--fg`), text on it
  `--ink`, Steel #A8AFB5, amber #E6C07B. Asset tiles: code #292D33, points band `--tile-pts`, price band `--tile-chg`,
  outline `--tile-out`. Every colour in the CSS and JS reads a token; charts drawn as SVG strings use core.js
  `TOKENS` (SVG presentation attributes don't take `var()` everywhere), kept in step by tests/tokens.test.js, which
  also fails on an old purple / green / red literal. Left as literals: two chart series (cyan, teal) and the avatar's
  brand gradient.
- **One green, one red, one purple.** Green #22C55E and red #EF4444 (exactly the old heat colours; softer 0.2 pairs
  were tried and rejected) for signed text AND heat, step headers, toggles, tags (`--good-rgb` / `--bad-rgb` for
  shading). Purple is the accent #A34DFF everywhere, Positions heat included (was #A855F7); `--accent-text`
  #C18AFF for small purple text, `--focus` #D2ACFF for the focus ring. Heat strengths unchanged.
- **Purple means selection**: pressed toggles and pins = purple outline and purple text (no solid fill); hero stats
  white; purple stays on 2x / x3 badges and range marks. Best Teams has no purple row edge: the # column carries the
  state (rank, pin, current team).
- **Kept**: control sizes (not 0.2's 44px), Inter + Inter Tight (0.2 is Inter only), dark only (0.2 has a light
  companion), heat colours, panel names, the rail and Best Teams layout (rows on the panel charcoal, raised section
  bands, lines inside the panel padding). Panels 10px corners (was 12).
- **Changed controls**: Incl / Excl became 0.2's **Policy** (calc.js `inclExcl`): Auto / In / Out, one of three,
  In lit green, Out red; the same `state.marks` / `state.hdMarks` values ("" / lock / ban), so no migration. The
  Drivers / Constructors panes got tighter cell padding so it fits at 1440px (at 1281-1400px they scroll sideways,
  as they did before).
- **Race bar**: "Next race · R16" as a spaced label above a 32px race name; lock time and data age on the right;
  the data age turns amber after 24 h while races remain (refreshes run after every session and at least every 6 h).
- **Budget tab**: the step headers are filled rounded tiles and the likely step a white rounded tile, drawn like
  the asset code tiles (option "C headers + A likely step" in the mockup).
- **Left out**: 0.2's driver projection panel (not even as a hover popup: it repeated the table row; the 25-75
  range is on the Points tab) and any per-driver baseline. Photography only ever on brand surfaces, not built.

## Decisions (user, 2026-09-28)
1. **Hindsight is a workspace** like the Calculator: done 2026-09-28 (below).
2. **Panel names stay as they are.** Alternatives kept for later, if a rename is ever wanted (the rule behind them:
   a panel title names what's inside, the tab says where you are):
   - Points tab: "Projections" -> **Expected points**
   - Budget tab: "Budget Builder" -> **Price changes** (also drops f1fantasytools' exact tool name)
   - Statistics tab: "Statistics" -> **Points by round** (follows the Data picker)
3. **Heat colours stay as they are** (Positions purple, Budget red / green by direction, points red -> green): they
   help legibility. Don't swap them for a grey probability ramp.

## Page templates
- **Workspace** (`main.ws`): results on the left, a Settings panel in the middle, Drivers + Constructors on the
  right. Wide screens (>= 1281px): fits the window below the race bar (and sub-tabs), each pane scrolls on its own.
  901-1280px: two columns, Drivers / Constructors below. Phones: the panes are a swipe strip with a bottom bar
  (`.panel-tabs`, `data-pane` / `data-pane-btn`). main.js `PANE_KEY` lists the workspaces and where each remembers
  its pane (`state.pane`, `state.hdPane`). Used by: Calculator, Hindsight.
- **Board** (from Live Scoring): a status panel first, then content panels at full width. Live Scoring, leagues,
  Global elite, Practice, Settings.
- **Table**: one full-width panel (title row, one picker row, legend, table). Points, Budget, Positions, Statistics.

## Rules
- One control per job: segmented control (`.seg`) switches a view or mode; toggle buttons (`.tbtn`, purple when on)
  pick things (chips, Incl / Excl); underlined tabs only for a group's pages.
- Buttons: white primary (one per panel at most), ghost secondary; 28px (`.btn.sm`).
- Panel title row: title, ⓘ, then a short muted stamp; switches and ghost buttons on the right.
- A team in a list is the Calculator's row (`.bestt`): rank, CR / x2 / DR chips, cost, points in the white pill,
  Δ$, ⋯ menu (copy, save as manual team) instead of per-row buttons.
- How-it-works text goes in ⓘ (see CLAUDE.md code conventions).
- Team pickers say "Team 1", never "T1"; one signed-out state (sentence + Sign in with Google).

## Hindsight as a workspace (2026-09-28)
- Left: **Best teams | Your teams | Season** (`state.hdMode`). Best teams uses the Calculator's table (points in
  the white pill, the gap to #1 under it, ⋯ = copy / save as manual team, Load more up to 50). Your teams: per
  team the line-up played (official points) and the best reachable (★, "+N missed" / "optimal"), then a line with
  the best move and what each decision was worth. Season: the season table, Decisions, Model team (scrolls whole).
- Middle: Settings with the Calculator's collapsible sections (summaries in the headers, open state in
  `state.calcGrp`): Round (grid of R1..Rn), Budget (your team's budget that round OR $100m / no cap), Chip (toggle,
  click again for none), Team filters. ↺ resets round, budget, chip, filters, Incl / Excl.
- Right: Drivers and Constructors (search, Pts heat, frozen projection, Δ$, Incl / Excl; ● = in the #1 team,
  T1-T3 = in your teams; NN, pts per $1m and ownership in the Pts tooltip). They replace the old Round scores table.
- The Calculator's layout CSS became the shared `.ws` rules; wide screens now size the workspace with flex instead
  of `calc(100dvh - 92px)`, so it fills to the bottom padding whatever sits above it (16px taller than before).

## Projections group (2026-09-28)
- Every title row: title, ⓘ, then a `.stamp` (which race, which sim: "Pit Wall sim · early", "after R16 Bahrain"),
  then the switches on the right. CSS: the stamp, not the ⓘ, takes `margin-right: auto`.
- Practice: the session cards became Live Scoring's session tags (`.tag.done` / `.tag.up`) and one status line; the
  "green in Practice Q" explanation moved into its ⓘ.
- Positions: driver names next to the codes, as on Points. Budget keeps its four tier tables (codes only, to fit).

## Leagues group (2026-09-28)
- A small in a title row is its stamp: `.panel h3 > small` takes `margin-right: auto`, the ⓘ goes before it
  (title, ⓘ, stamp, then controls). Title rows across the page were reordered to match.
- My leagues: the league switch sits in the standings' title row. Round by round: rounds as a button grid (was a
  dropdown) and the member cards became the Calculator's team rows (a header row per team: name, chip, bank,
  transfers, where it came from; then CR / x2 / DR and the round score in the white pill; league.js
  `lineupCells`). Panels in pairs: Round by round | Next race head-to-head, Points race | Differentials.
- Head-to-head (My leagues and My rivals, league.js `h2h`): the same team rows, then "You win" and the xPts gap.
- Global elite: the cut-offs are one joined tile strip (`.stats`); the Global rank column shows only when a team
  has one (only old imports did).
- The old card styles (`.rcard`, `.bt`, `.bts`) are gone: nothing uses them.

- Board layout (after the user's review): `.board` = CSS columns (2, balanced by height; `.wide` spans both), capped
  at 1480px so tables don't spread on very wide screens; team-row chip columns shrink to their chips. My rivals' row
  actions moved into a ⋯ menu (Aim to beat in the Calculator, Remove from my rivals). Chart end labels stay above the
  x-axis. The Top-100 and Top-500 templates showing the same line-up is real (same five most-owned drivers).

## Settings (2026-09-28)
- A Board: Account & data, Admin (owners), Model settings and How it works in balanced columns; Circuits a wide panel
  (title row with ⓘ and "remaining races", the season-trend line, then one tile per remaining race: `.ccard` inside
  `.cgrid`, no panel inside a panel). How it works folds (`details.fold`, closed by default). `.sethead` and
  `.grid-cards` are gone.

## Previewing the league pages locally
Sign-in doesn't work on the local preview, so the league views would be empty. `python tools/dev_league.py`
rebuilds the league payload and your linked account from the private clone's snapshots into `build/dev-league.json`
(gitignored, never deployed); `http://localhost:8765/?league` then loads it as if signed in (sync.js `devLeague`, a
no-op anywhere but localhost).

## Also fixed on the way
- `lineups()` (hindsight-view.js) now returns league.js `tracked()`: rounds after the last data export are worked
  out from the league feeds, so Hindsight's Your teams, the Statistics highlight, Global elite's chip rounds and
  Live Scoring's finished round no longer go empty after the last export (seen: R15 empty for all three teams).

## Still to do (proposed in the audit; not yet agreed page by page)
Shared team / round pickers, one signed-out state, title-row order, and the type (13 sizes) and radius (11 values)
scales (0.2 proposes radius 6 controls / 10 panels and a 4-8-12-16-24-32-48-64 spacing scale). The chart colours
became tokens on 2026-09-29 (Retexture).
