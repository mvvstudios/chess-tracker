# Dashboard dark theme — design

**Date:** 2026-05-26
**Scope:** Visual styling for the chess-tracker dashboard. Replaces the original
chess-green / amber / red palette specified in the bullet-chess-tracker plan
(Task 12) with a minimal warm-dark theme.

## Goal

A legible, minimal dark UI: two structural colors (warm dark gray + warm
off-white) plus one restrained accent (`#c9a574`) used sparingly to carry
meaning where shape and weight alone are insufficient.

## Palette

| Token              | Hex       | Role                                                |
|--------------------|-----------|-----------------------------------------------------|
| `--bg`             | `#262624` | Page background                                     |
| `--surface`        | `#2d2d2a` | Panels (leak rows, rule block, kpi strip); also row hover |
| `--accent-bg`      | `#332e26` | Tinted background for critical-severity blocks      |
| `--text`           | `#f0eee6` | Primary text                                        |
| `--muted`          | `#8a8a82` | Secondary text, table headers, draw bars            |
| `--border`         | `#3a3a37` | Hairlines, table row dividers, non-severity borders |
| `--accent`         | `#c9a574` | The only chromatic color in the UI                  |
| `--board-light`    | `#d8c9a8` | Chess board light squares                           |
| `--board-dark`     | `#5a5852` | Chess board dark squares                            |
| `--piece-fg`       | `#111111` | Chess piece glyph color (both square types)         |

## Accent usage rules

The accent (`#c9a574`) appears **only** in these places:

1. **Critical-severity leak** — 3px left border + `--accent-bg` panel background.
2. **Warn-severity leak** — 2px left border (panel background stays `--surface`).
3. **Win bars** in the recent-form sparkline. Loss bars are `--border`; draws are
   `--muted` at 60% bar height.
4. **Strong stat cells** — win% cells ≥ 60% in tables (`color: var(--accent)`,
   `font-weight: 600`). Weak cells (≤ 35%) are NOT colored — they stay
   `--text` to avoid a competing color.
5. **High-confidence indicator dot (`●`)** in the play-signatures table. Low
   confidence is `○` in `--muted`.
6. **Board light squares.**
7. **Primary button** (`#copy-suggestions`): accent background, `#1a1a18` text.
8. **The "recent form" KPI value** when `recent_form_win_pct >= 50`.

If a cue is not in this list, it does **not** get the accent.

## Typography

- Stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
- Body: 14–15px equivalent (browser default, no override)
- Section headings (`h2`): 1.1rem, weight 600, letter-spacing −0.01em
- Sub-labels in headings (`h2 small`): `--muted`, weight 400, 0.8rem
- Table column headers: 0.72rem, uppercase, letter-spacing 0.05em, `--muted`,
  weight 500
- KPI labels: 0.7rem, uppercase, letter-spacing 0.05em, `--muted`
- KPI values: 1.5rem, weight 600
- Numeric cells: `font-variant-numeric: tabular-nums`

## Layout rules

- Page bg `--bg`, max-width `1200px` main content, centered, 1.5rem padding.
- Sections: 2.5rem bottom margin between them.
- KPI strip: sticky top, `--surface` background, 1px `--border` bottom, 2rem
  gap between KPIs, 1.1rem vertical padding.
- Leak rows: 0.7rem vertical / 1rem horizontal padding, 0.4rem stacking gap,
  left border carries severity, no rounded corners.
- Rule block: `--surface`, 4px radius, 2-column grid (`max-content 1fr`), narrative
  separated by a 1px `--border` divider and rendered in `--muted` italic.
- Tables: full-width, `border-collapse: collapse`, 1px `--border` between rows,
  0.6rem vertical cell padding. Tabulator's *theme* CSS is replaced by custom
  rules; its *base* CSS is still required for column-width and scroll mechanics
  (see Implementation notes).
- Low-confidence rows: `opacity: 0.45`.
- Mini board cell: 8×8 grid of 14px squares (112×112px), piece glyphs 12px
  in `#111`.

## What is removed from the original Task 12 spec

- The chess-green `--accent: #769656` token.
- The amber `--warn: #c4a01e` token.
- The red `--bad: #b54a3f` token.
- Emoji indicators (`🟢`, `⚪`, `🔴`) — replaced with `●` / `○` glyphs in
  `--accent` / `--muted` respectively.
- Tabulator's `tabulator_midnight.min.css` — the custom CSS handles table
  styling directly. Tabulator's base layout JS still ships; only the theme CSS
  is dropped.

## What is kept from Task 12

- The semantic HTML structure of [chess_tracker/templates/index.html](../../../chess_tracker/templates/index.html) is unchanged.
- All Tabulator column definitions and formatter functions stay; only the
  classes they emit (`cell-strong`, `cell-weak`, `row-low-conf`, sparkline
  classes) change their visual treatment.
- The board renderer added previously (the `boardCell` formatter and `.board`
  CSS) stays — only the square colors change to `--board-light` /
  `--board-dark`.

## Implementation notes

- Tabulator vendoring changes: download `tabulator.min.css` (the base unstyled
  CSS, required for column-width and scroll machinery) **instead of**
  `tabulator_midnight.min.css`. Source URL:
  `https://unpkg.com/tabulator-tables@6.2.5/dist/css/tabulator.min.css`.
- The `<link rel="stylesheet" href="vendor/tabulator_midnight.min.css">` line
  in [chess_tracker/templates/index.html](../../../chess_tracker/templates/index.html) becomes
  `<link rel="stylesheet" href="vendor/tabulator.min.css">`.
- `dashboard/styles.css` is rewritten end-to-end per the rules above. The
  CSS file will be roughly the same length as the original spec (~120 lines)
  but with the new tokens and additional table-cell color overrides for
  Tabulator's base styles.
- No JS changes are required beyond what's already specified in Task 12 plus
  the board renderer already added. The `cell-weak` class becomes a no-op
  (still emitted, but the CSS for it just inherits `--text`) — leave it in
  place rather than ripping it out, so a future change of mind costs nothing.
- **This spec supersedes the board CSS values currently in the Task 12 plan**
  (lines 1991–2003 of `docs/superpowers/plans/2026-05-26-bullet-chess-tracker.md`).
  Implementation must update those values to: `grid-template-columns: repeat(8, 14px)`,
  `grid-auto-rows: 14px`, `width: 112px`, `height: 112px`, square colors
  `--board-light` / `--board-dark`, piece glyph color `--piece-fg`, font-size
  12px line-height 14px. The column width in `renderPlaySignatures` should
  drop from 144 to 128.

## Non-goals

- No light-mode toggle.
- No custom fonts beyond the system stack.
- No animated transitions.
- No icons beyond Unicode glyphs already in use.
- No responsive breakpoints below 800px (the dashboard is desktop-only).
