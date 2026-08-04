# Chess Tracker

Local Chess.com bullet behavior recorder + feedback loop. Pulls your
games via the public API, computes per-session and per-opening
metrics, surfaces leaks, and proposes a next-session rule.

## Setup

    uv sync --group dev

## Refresh

    uv run refresh.py                       # default: bullet, user M_V-V
    uv run refresh.py --force               # re-fetch all months
    uv run refresh.py --analysis-max-games 20  # quick local smoke refresh

Browsers block `file://` subresources, so view via a local HTTP server:

    python3 -m http.server 8000

Then open <http://localhost:8000/dashboard/index.html>.

The published dashboard at <https://mvvstudios.github.io/chess-tracker/>
redeploys automatically every 6 hours and on every push to `main`. To refresh it
between those ticks — e.g. right after a session — use the **↻ Refresh** link in
the dashboard's KPI strip (or open the
[deploy workflow](https://github.com/mvvstudios/chess-tracker/actions/workflows/deploy.yml)
directly) and click **Run workflow**. The rebuild takes ~1 minute.

Engine analysis defaults to the full available game set. Use
`--analysis-max-games N` only when you want a deliberately bounded local run.

## What you'll see

1. **KPI strip** — current rating, total games, recent form
2. **Leak summary** — what's bleeding rating right now
3. **Next session rule** — game cap, move-10 target, stop signal
4. **Recent losses → error log** — click "Copy starter entries" to populate annotations
5. **Process metrics** — clock and session behavior
6. **Play signatures** — sortable; low-confidence rows (N<15) are dimmed; grouped by 8-ply FEN, not ECO label
7. **Sessions** — chronological list with tilt flags
8. **My Blunder Puzzles** — your engine-classified blunders as a persistent solve queue
9. **Chess Opening Puzzle Trainer** — five static, color-aware Lichess tactics curricula

## My Blunder Puzzles

Open `dashboard/puzzles.html` after a refresh. Candidates come from the same
Stockfish move-quality cache as Blunder Analysis: only moves played by the
configured Chess.com username and labeled `blunder` are eligible. Each PGN is
replayed with `python-chess` before publishing the pre-blunder FEN, legal moves,
and a validated Stockfish principal variation. A checkmating best move solves
immediately. Otherwise the puzzle asks for Stockfish's first move, plays the
stored opponent reply automatically, and requires the next best move to finish.
The active unsolved queue is deterministically mixed each day instead of being
shown in game-date order; it remains stable while you work through that day's
session, and **Skip for now** still rotates the current puzzle to the end.

Older cached blunders may only contain a one-move engine line. Normal refreshes
backfill up to 100 of those positions at a time (highest evaluation loss first)
and omit incomplete positions until their continuation is ready. Use
`--puzzle-line-max 0` to backfill the full legacy backlog in one refresh.

This repository has no server, database, or login system. Puzzle attempts and
solved state therefore use the documented fallback: browser `localStorage`,
namespaced by the configured Chess.com username. Progress survives reloads and
new dashboard builds on the same browser and origin, but it does not sync across
devices and is lost if that site's browser storage is cleared.

## Chess Opening Puzzle Trainer

Open `dashboard/trainer.html` through the local HTTP server. The historical
`dashboard/caro-kann-puzzles.html` URL remains compatible. This separate
trainer uses an official Lichess CC0 puzzle extract and offers five
narrow decks from one dataset selector: Caro-Kann for Black, Colle for White,
Englund for White, Pirc for Black, and Modern for Black. Every puzzle starts
after the opponent's stored setup move. Solver color and board orientation come
from the selected deck, and stored opponent replies play automatically until
the complete tactical continuation is finished.

Progress is isolated by deck in `localStorage`, remains separate from personal
blunder puzzles, and continues to read the original Caro-Kann namespace so
existing solves are preserved.

The large source download stays under ignored `data/`. One streaming extraction
routes the source to all five canonical directories and writes
`public/data/opening-puzzle-catalog.json`. A normal refresh copies only that
catalog, each manifest, and its referenced balanced browser chunks into the
generated `dashboard/data/` tree used by GitHub Pages. Extraction commands,
exact tag roots, perspective validation, schema, balancing, and deployment
details are in
[docs/OPENING_PUZZLE_DECKS.md](docs/OPENING_PUZZLE_DECKS.md). The original
Caro-Kann-only entry point remains documented in
[docs/CARO_KANN_PUZZLES.md](docs/CARO_KANN_PUZZLES.md). Public routes, local
review storage, Endless-by-default training with optional 5/10/20-puzzle
summaries, first-party events, export/import, and offline boundaries are
documented in
[docs/OPENING_TRAINER_PRODUCT.md](docs/OPENING_TRAINER_PRODUCT.md).

## Annotations

Edit `data/annotations.json` directly. Schema:

```json
{
  "openings": {
    "<opening name>": {"tag": "in_repertoire|experimenting|drop", "note": "..."}
  },
  "games":    { "<game_url>": {"tags": ["..."], "note": "..."} },
  "error_log": [{"id": "...", "title": "...", "pattern": "...", "game_refs": []}]
}
```

The dashboard generates starter entries for you (Recent Losses panel) — paste them in.

Re-running `refresh.py` picks up changes immediately.

## Testing

    uv run pytest
    node --test tests/*.test.js

The dependency-free Node suite covers the shared puzzle domain and both static
puzzle page controllers. Both suites run in the Pages workflow before deploy.

## Layout

- `refresh.py` — CLI entrypoint
- `chess_tracker/` — pipeline modules (api, pgn, metrics, annotations, render, play_signature)
- `dashboard/` — HTML/JS/CSS frontend; `vendor/` has Tabulator and Chessground (offline-safe)
- `chess_tracker/puzzle_queue.py` — validated candidate derivation and stable puzzle identity
- `chess_tracker/opening_puzzle_decks.py` — authoritative five-deck registry
- `dashboard/puzzle-domain.js` — answer checking, queue partitioning, and progress persistence
- `scripts/extract_opening_puzzles.py` — one-pass, multi-deck Lichess extractor
- `scripts/extract_caro_kann_black.py` — backward-compatible Caro-Kann entry point
- `public/data/opening-puzzle-catalog.json` — deployed opening-deck registry
- `public/data/<deck-id>/` — canonical manifests, exports, shards, and balanced chunks
- `data/` — generated (cached archives, computed.json, annotations.json)
- `docs/superpowers/` — spec + plan

## Design

See `docs/superpowers/specs/2026-05-26-bullet-chess-tracker-design.md`.
