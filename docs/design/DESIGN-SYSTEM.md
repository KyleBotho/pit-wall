# Fantasy Pit Lane — design system 0.1

Status: proposed implementation system based on the approved dark editorial moodboard and integrated driver panel. The product name is Fantasy Pit Lane. The earlier Fantasy Pit Wall PW logo has not been adapted to the new name; the guide uses a typographic identity pending a separate logo decision.

## Purpose and deliverables

Open `index.html` in a browser for the visual reference, working controls, table specimens and charts. `tokens.css` provides framework-neutral design tokens and base styles; `tokens.json` provides the same variables as a simple JSON map (not a DTCG interchange file). `guide.css` and `guide.js` implement the demonstration. Local font and chart dependencies are bundled with their licenses. No external network is required to view the guide. No real simulator, authentication or race feed is implemented.

## 1. Design principles

1. Dark by default: continuous charcoal, gently raised neutral surfaces and soft white text. Avoid tinted purple panels, neon glows and gradients.
2. Editorial at the edges: broad, bold headings, deliberate whitespace, monochrome engineering photography and a lighter second brand line. Keep reading and analytical content plain.
3. Purple has meaning: selection, active scenario and fastest-lap highlight. Do not colour every positive number purple. When a selected comparison uses purple, label the baseline and sign explicitly.
4. One analytical object: identity, projected mean, delta and interval belong together in the driver projection panel.
5. Reveal detail intentionally: compact tables enable scanning; selected rows reveal the full breakdown. Do not place the large projection panel in every dense table row.

## 2. Foundations

### Semantic colour tokens

| Token | Dark | Light | Role |
|---|---|---|---|
| bg | #111316 | #F0F0EB | Page |
| surface | #181C21 | #FAFAF7 | Panel, input |
| raised | #22272E | #E6E8E4 | Selected row, floating content |
| hover | #2A2F36 | #DDE0DC | Hovered interactive item |
| text | #F2F2EF | #172027 | Primary text |
| muted | #A8AFB5 | #535E66 | Secondary text, axes |
| line | #343B43 | #C7CDCF | Decorative separators |
| control-line | #707982 | #737D83 | Essential input boundaries |
| purple | #A34DFF | #A34DFF | Brand swatch; not small text |
| accent-text | #C18AFF | #7326C9 | Small purple text, selected data |
| focus | #D2ACFF | #7326C9 | Keyboard focus outline |
| positive | #8BD5AF | #17653E | Explicit gain / success |
| warning | #E6C07B | #80550B | Stale / caution |
| negative | #FF9DAB | #A32340 | Error / negative delta |

The original graphite material colour #2A2F34 remains in the reference palette; semantic UI surfaces have finer steps. Never place body copy in #4E545B on dark surfaces. Purple should occupy only a small minority of the interface, not a fixed enforceable percentage. Team colours are secondary identity markers accompanied by names, not the chart-series palette.

### Typography

Use Inter Variable, locally bundled under its SIL Open Font License. This is a practical match to the generated art direction, not a claim that every rendered letter in the moodboard is Inter.

| Role | Size / line height | Weight | Tracking |
|---|---|---|---|
| Brand / editorial display | 48–88 / 0.98 | 800 and 400 | −0.045em |
| Simulator page heading | 32 / 40 | 650 | −0.025em |
| Section heading | 24 / 32 | 600 | −0.02em |
| Driver name | 24–28 / 32 | 600 | −0.02em |
| Key metric | 28–36 / 40 | 600 | −0.025em |
| Body | 16 / 24 | 400 | normal |
| Controls / tables | 14 / 20 | 400–600 | normal |
| Metadata / axes | 12 / 18 minimum | 400–500 | normal |
| Editorial eyebrow | 12 / 18 | 600 | 0.12–0.16em |

Use `font-variant-numeric: tabular-nums lining-nums` for values. Never apply wide letter spacing or all caps to dense table content. Body line length: 55–75 characters. Do not horizontally stretch the font to imitate the moodboard.

### Geometry, surfaces and motion

Spacing: 4, 8, 12, 16, 24, 32, 48, 64px. Controls: 6px radius; panels: 10px; portrait: circle; chart bars: 0–2px. One-pixel borders. Use spacing and row rules before nested panels. Shadows are reserved for floating menus and dialogs. Neutral primary action: soft white on dark with carbon text; dark on light. Limit animation to 120–180ms changes of state. Respect reduced-motion preferences and avoid animated counters or simulated progress percentages.

Photography is monochrome, consistent in contrast and crop, with authentic-looking pit garages, machined metal, carbon fibre and human engineering work. Use in introductions and context, never behind data. The bundled moodboard is a generated reference, not a licensed production photo collection. Final assets should be sourced/generated individually and checked before release. Use a single stroke icon family in implementation; 20px default and visible text labels for essential actions. The guide deliberately avoids introducing a competing icon style.

## 3. Components and contracts

### Integrated driver projection

Required data: driver ID and display name, projected mean, unit, baseline label and mean if delta is shown, optional P10/P90, model run ID, calculation timestamp, data freshness state. Portrait is optional and decorative when the name is adjacent.

Anatomy: circular portrait 56px compact / 80px detail; name; mean; signed comparison; details action; labelled range in the same panel. Padding 24px desktop / 16px mobile. On mobile keep name first, values second, range full width. The entire card is not a button when it contains controls.

Use the same data object for the headline and plot. Do not assume the mean lies midway between percentile endpoints. Central 80% range means P10–P90 of simulated outcomes, not a confidence interval for the mean. No percentiles means a labelled unavailable range, not fabricated endpoints. Delta = selected mean minus explicitly named baseline mean. Round for display only.

Accessibility: name and values in text; image alt empty if redundant; graph has text equivalent. Details uses a button with `aria-expanded` and a labelled region. One border around the analytical object; any external specimen boundary in a moodboard is not an extra production card.

### Forms, selection and actions

44px default control height and touch targets, including checkbox label hit areas. Persistent labels, units outside user-entered value, helper text linked with `aria-describedby`. Reject invalid values with a reason and retain input. Native selects and numeric inputs are preferred until custom behaviour is necessary. Chips are mutually exclusive pressed buttons or radios. Tabs controlling panels use actual tab semantics and arrow-key navigation; anchor navigation in the guide is not a tab list.

Neutral primary action, outlined secondary action, text tertiary action. Show focus with 2px outline and 3px offset. Selection is separate from hover and focus. Disable Run only while running or when the reason is discoverable. Reset destructive changes only with a clear scope; preserve results when cancelling an edit.

## 4. Tables

### Lineup table

Columns: compare checkbox, lineup name, cost ($m), projected mean (pts), P10–P90 (pts), signed delta vs named baseline, model status. Expanded detail must identify all five drivers and two constructors, boost/chip, transfer penalty and constraint validity. Recommended first screen shows 8–12 rows if space allows, with pagination or explicit load-more.

Standard row 56px, compact 44px minimum; 16px horizontal cell padding. Right-align numbers, align decimals through fixed precision, left-align names. One decimal for projected points and $m cost; signed one decimal for deltas; integer percentile endpoints in summary and more precision in details if needed. Use one locale consistently; do not mix decimal separators. Full names in primary identities; short codes can supplement them in dense views.

Sorting: button in heading, visible direction, `aria-sort` on the active header. Missing values stay last for either direction. Sort stable ties by existing order or a documented secondary key. Comparison checkboxes persist through sorting/filtering, with a selected-count announcement. Do not couple selection to hover. No whole-row click unless keyboard-equivalent and compatible with nested actions.

For large production datasets, sticky headings inside the table scroll container, pagination/virtualization with accessible row counts, and keyboard-reachable horizontal scrolling. The guide demonstrates sorting, filtering, selection and density, not virtualization. Below 768px retain a genuine table in its own horizontal scroll region; optionally provide a separately designed summary list. Never squeeze labels into unreadable abbreviations.

### Driver / constructor assumptions table

Columns: full name, cost ($m), projected points, expected price change ($m), inclusion policy. Policy is one mutually exclusive choice: Auto / Include / Exclude. Editable projections show model value, override indicator and Reset to model. Invalid fields remain visible with a message. Sticky name column is appropriate for wider tables. Do not infer a zero from missing projection data.

### Common table states

Loading: retain headings and previous data with explicit previous-run label. Empty before run: next action. Filter-empty: clear filters. Constraint-empty: explain budget or inclusion conflict. Partial: em dash plus reason. Error: retain settings and offer retry. Stale: label model time and show rerun action. Avoid shimmers under reduced motion.

## 5. Graph system

All graphs have a question-oriented title, axis units, an explanation of estimates, model/data timestamp in the real product, direct labels or legend, a textual summary and accessible data table. Use 12px minimum axis labels, 2px series strokes, 4px markers and 6–7px selected marker. Keep gridlines subtle but essential marks clearly visible. Chart tooltips show name, exact value, unit and run context; never make hover the only access to values. Small multiples share domains.

| Question | Pattern | Rules |
|---|---|---|
| Which lineup has more projected points? | Horizontal bars | Zero baseline; sort explicitly; direct names; selected purple, others steel. |
| How uncertain is the result? | Histogram | Fixed bin widths and boundaries; counts or % clearly labelled; frequencies total consistently; no smoothing invented from a few points. |
| How did the model change? | Line | Discrete model runs or actual dates; straight segments; missing data breaks the line; baseline dashed square markers, selected solid circles. |
| How do outcome ranges compare? | Interval plot | P10–P90 segments and mean marker; shared labelled axis; state any cropped domain; do not imply every point in the interval is equally likely. |
| Is a transfer worth its penalty? | Diverging delta bars | Zero reference, signed net gain, penalty disclosed; not demonstrated in this guide. |

For negative values, include negative axis space. Use zero-based bars; a cropped interval or line axis must be clear and consistent. Don’t use pies for close comparisons, 3D charts, dual axes or gradients as data encodings. More than three scenarios should use small multiples or a table rather than adding a rainbow. Do not stack driver percentile ranges to claim a team percentile: team outcomes depend on correlation and must come from team-level simulations.

Sample-data consistency: Plan A mean180, baseline168, delta+12; Plan A P10=140 and P90=220. Histogram percentages across eight equal bins are2,8,18,22,22,18,8,2, summing100 with weighted midpoint mean180. These are design examples only, not real forecasts. Driver panel is a separate example: mean100, baseline88, P10=80, P90=120.

## 6. Responsive simulator composition

Desktop >=1200px: 12-column grid, 24px gutters, 32px outer margins, content max1440–1600px. Setup rail280–320px; results flexible. Race header compact with page title32px, data timestamp, model status and timezone. Results begin with the ranked table; selected lineup opens integrated detail below or in a dedicated pane. Only one or two graphs at a time.

Tablet768–1199px: setup above results; collapsible advanced assumptions; tables retain horizontal scroll. Mobile<768px: 16px margins; controls stack; integrated panel reflows; chart minimum height240px except compact ranges; preserve all data through details. At 200% zoom reflow the surrounding layout. Data tables may scroll within a labelled region. Do not force a full desktop page into horizontal overflow.

The guide’s large masthead is a design-system specimen, not the proposed simulator header. Use the magazine imagery sparingly around the tool and keep it away from operational controls.

## 7. Accessibility and validation

Target WCAG2.2AA: normal text >=4.5:1; large text >=3:1; essential non-text component boundaries and chart marks >=3:1 against adjacent backgrounds. Decorative separators are not essential boundaries. Use the brighter/darker semantic accent text tokens rather than the brand swatch for small copy. Target44px controls as the product default; the WCAG minimum criterion has24px and spacing exceptions, which should not become the design default.

Check keyboard order, focus visibility, control names, selection announcements, table headers/sort state, chart text equivalents, screen-reader detail expansion, 200% zoom, mobile overflow, colour-independent state cues and reduced motion. Numeric contrast checks and browser inspection do not establish complete accessibility conformance. See `validation.md` for the checks performed on this guide.

## 8. Adoption

1. Import tokens.css once; use semantic variables rather than hardcoded component colours.
2. Implement controls and table shell first, including error/stale/missing states.
3. Connect projections to a shared data object used by text, table and chart.
4. Implement the integrated driver panel and selected-lineup breakdown.
5. Add graphs only for questions not already answered clearly by the table.
6. Validate real data, model meanings, target devices and assistive technology before release.

Light mode shares all geometry, type, interactions and chart semantics. Only semantic colour tokens change. No automatic theme switching is required; honour an explicit user preference in production.

## References

- Inter family and tabular numerals: https://rsms.me/inter/
- Chart.js documentation: https://www.chartjs.org/docs/latest/
- WCAG contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- WCAG target size: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

Bundled dependencies: Inter Variable (SIL OFL; assets/Inter-LICENSE.txt), Chart.js4.4.9 (MIT; assets/Chart-LICENSE.md). No relationship or endorsement by Formula1 is implied by this design study.


## v0.2 — Compact analytical hierarchy

The compact lineup recipe supersedes generic table density guidance for multi-asset lineup comparisons. Load tokens.css followed by lineup-components.css. See the live guide section “Compact lineup hierarchy”.

Dark roles: row #0C0E10; section #1B1E23; code #292D33; points #20242A; price movement #101215; muted numbers #A4AAB3. Light counterparts and team-border tokens are in tokens.json. Prefer these role tokens over literal values in new components.

Reading order: lineup identity and total expected points, individual projected points, then price changes and uncertainty. Code 12px/700; points 12px/650; changes 11px/400; total 13px/750. This is an explicit compact-data exception to the normal 12px metadata minimum. Codes and points retain full text contrast. Borders carry team identity but code labels remain necessary.

Group current, pinned and suggested lineups under full-width strips. Preserve column alignment. Keep constructor pair, boosted driver, and remaining drivers separated. Use a small purple multiplier badge. Tile points include boost; price movements never do. Price movements use two decimals, projected points one. Total expected points gets the highest-contrast pill; budget uses a darker pill. All metrics must identify units and the baseline.

Wide tables scroll inside their own named region, not the page. Preserve keyboard focus and native labelled controls. Pin, compare and view are separate actions. Current baseline remains visible when it exceeds budget, with an explicit over-budget label.

Production probabilities and ranges must come from the model. The simulator demo uses illustrative estimates. Do not present those values as calibrated forecasts. Team border hues in this package are demo identity cues, not a claim of official colour specifications.
