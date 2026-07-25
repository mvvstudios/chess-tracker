# Scramble Blunders — First-Class Partition

**Date:** 2026-07-25
**Status:** Approved

---

## Problem

The blunder table mixes moves played with time to think and moves played in a
clock scramble. Categories are multi-label, so a sub-10s panic piece-drop
counts under "Material loss", "Large eval swing", AND "Time pressure" at once —
scramble moves inflate every instructional row. Time-trouble mistakes are a
different failure mode (miscalibrated intuition, not bad calculation) and
deserve their own review surface, not co-tags.

## Decision (user-approved)

- **Exclusive partition**, not a filter/toggle: every analyzed blunder belongs
  to exactly one pool — **scramble** (post-move clock ≤ 10s) or **clear-headed**
  (everything else, including missing clock: no proof of panic ⇒ thinking pool).
- **Threshold:** ≤ 10.0 seconds, the existing constant. Boundary inclusive.
- **Two first-class tables**, same category → pattern → blunder tree run once
  per pool. Main table = "mistakes made thinking"; scramble table = "mistakes
  made moving" (failed intuition). "Scramble blunders" is our coinage (from
  chess "time scramble"); the established term is time trouble / Zeitnot.
- The `time_pressure_blunder` co-tag is **deleted** — the partition replaces it.

## Data layer (`chess_tracker/analysis.py`)

- `classify_blunder_categories` stops emitting `time_pressure_blunder` and
  loses its now-unused `clock_after_seconds` parameter (driver call updated).
- `blunder_evidence` entries keep recording `clock_after_seconds` — that is
  what the partition reads downstream.
- `TIME_PRESSURE_SECONDS` renamed `SCRAMBLE_SECONDS = 10.0`.
- **No `ANALYSIS_CACHE_VERSION` bump.** Cached v3 evidence still carrying the
  old tag is normalized at read time (below), so no engine re-analysis and the
  next deploy stays on the fast path (~1m15s).

## Aggregation (`chess_tracker/blunder_categories.py`)

- `_summary_blunders` strips any legacy `time_pressure_blunder` tag while
  reading cached evidence.
- `compute_blunder_analysis` partitions blunders into scramble / clear pools
  first (`clock_after_seconds is not None and <= SCRAMBLE_SECONDS`), then runs
  the existing tree-building — extracted into a per-pool helper — over each.
- Payload:
  - Existing keys (`categories`, `phase_breakdown`, `affected_openings`,
    `impact_rows`, `examples`) now computed from the **clear pool** only.
  - New flat key `scramble_impact_rows` — the scramble pool's tree.
  - `engine_coverage` gains `clear_blunders` and `scramble_blunders`.
  - `blunders` stays the complete list (both pools; board lookups by id);
    each blunder gains a `scramble: bool` flag.
- Deletions (dead after the partition): `_clock_band`, the
  `time_pressure_blunder` branch in `_pattern_for`, its entries in
  `CATEGORY_LABELS` / `CATEGORY_DESCRIPTIONS` / `CATEGORY_FOCUS_AREAS`, and its
  entry in `_overlap_label`'s priority list. Also the unreachable "mate-level"
  tier in `_severity_band` (`cp_loss` is capped at 2000 since the ACPL clamp).

## UI (`chess_tracker/templates/*.html`, `dashboard/app.js`)

- Both `index.html` and `blunders.html` keep block parity: new
  "Scramble blunders" section with `#scramble-review-table` below the existing
  table. Subtitle: "played with ≤10s on the clock — intuition failures, not
  calculation failures".
- `renderBlunderReview` parameterized to build both Tabulator trees; both share
  the single board panel and `blunderById`, so clicking a row in either table
  drives the board. Row-selection highlight clears across both tables.
- Scramble table adds one column the main table lacks: **Clock** (e.g. "4.2s")
  on exact-blunder rows, sortable — replaces the old under-5s/5–10s band
  patterns as the way panic depth stays visible. (The board meta panel already
  shows the clock for a selected blunder.)
- Coverage strip: "Blunders analyzed" card's subtitle becomes the split, e.g.
  "812 clear · 523 scramble".
- Empty-state handling clears both table containers.

## Testing

TDD. New: partition boundary (10.0 → scramble, 10.1 → clear, None → clear);
legacy-tag strip (cached evidence with the old tag yields no "Time pressure"
category row); coverage counts; `scramble` flag; clock present on scramble
child rows. Updated: the `classify_blunder_categories` expectation list and
kwargs. Existing fixtures carry no clock, so they land in the clear pool and
their expectations hold unchanged.

## Out of scope / accepted

- Homepage blunders-per-100 KPI stays a raw count over all moves.
- Losses-page puzzle drill untouched; no per-time-class thresholds (bullet-only
  table).
- Blunders whose only tag was time-pressure become uncategorized after the
  strip: still counted (coverage strip + scramble pool counts + full list) but
  not visible as tree rows — same existing behavior as today's 8 uncategorized.
