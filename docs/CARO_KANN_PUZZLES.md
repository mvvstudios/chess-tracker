# Caro-Kann puzzles for Black

The Caro-Kann trainer is a static, Black-only puzzle queue built from the
[official Lichess puzzle database](https://database.lichess.org/#puzzles).
Lichess publishes that database under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/). The original
compressed export is deliberately not committed; downloads belong under the
ignored `data/` directory.

The Lichess line is already engine-derived. Normal extraction validates and
replays it with `python-chess`; it does not run Stockfish over every position a
second time.

## The Lichess setup-move convention

The `FEN` column is the position immediately *before* the first move in
`Moves`. That first move is a setup move from the source game, not the first
answer expected from the solver. Therefore a puzzle for Black starts with an
original FEN in which White is to move:

1. Parse the original FEN and require White to move.
2. Parse `Moves[0]`, generate its SAN in the original position, and play it.
3. Require the resulting position to have Black to move; this becomes
   `puzzleFen`.
4. Store `Moves[1:]` as `solutionUci` and replay the complete continuation,
   generating each SAN string before pushing its move.

Original FENs with Black to move are rejected because, after their setup move,
they normally produce a White-to-solve puzzle. The setup move is never included
in `solutionUci`, and the browser always starts from `puzzleFen` with a Black
orientation.

## Opening matching

`OpeningTags` is split on whitespace. A row qualifies only when at least one
token is exactly `Caro-Kann_Defense` or starts with
`Caro-Kann_Defense_`. This is token matching, not loose substring matching and
not a variation allow-list.

When several qualifying tags are present, the longest (most specific) token is
the primary variation. Normalized tags are retained unchanged in `openingTags`
and also converted to readable labels. For example:

```text
Caro-Kann_Defense_Advance_Variation
→ Caro-Kann Defense: Advance Variation
```

Variation filenames use deterministic, filename-safe slugs derived from the
normalized tags. The manifest is the source of truth for each tag-to-shard
mapping; records deliberately do not duplicate that slug, so a future
collision-safe filename suffix cannot disagree with record metadata. New
Lichess variation tags are accepted automatically.

## Record validation and schema

Every exported record has a unique puzzle ID, a valid White-to-move original
FEN, a legal White setup move, a resulting Black-to-move `puzzleFen`, and a
complete legal continuation beginning with Black. Malformed CSV rows are
counted and skipped rather than aborting the stream. Duplicate IDs are rejected;
exact position-and-line duplicates may additionally be de-duplicated.

The JSONL records include at least:

```json
{
  "id": "lichess-puzzle-id",
  "source": "lichess",
  "sourceUrl": "https://lichess.org/...",
  "openingFamily": "Caro-Kann Defense",
  "variation": "Caro-Kann Defense: Advance Variation",
  "openingTags": ["Caro-Kann_Defense_Advance_Variation"],
  "originalFen": "... w ...",
  "setupMoveUci": "...",
  "setupMoveSan": "...",
  "puzzleFen": "... b ...",
  "sideToMove": "black",
  "orientation": "black",
  "solutionUci": ["...", "..."],
  "solutionSan": ["...", "..."],
  "rating": 1600,
  "ratingDeviation": 75,
  "popularity": 90,
  "plays": 500,
  "themes": ["fork", "opening", "short"],
  "difficulty": "intermediate",
  "provenance": "standard",
  "isOpeningPuzzle": true,
  "isMasterGame": false,
  "isMasterVsMaster": false,
  "isSuperGM": false
}
```

Mate-in-one records may also contain every legal Black move that checkmates
immediately, allowing any correct mating move rather than only the stored line.
Every solution step includes `acceptedMovePostFens`, a deterministic mapping
from each accepted UCI move to the exact FEN obtained by legally pushing it;
the first step's map is mirrored at record level. This keeps the displayed
post-move board correct when an alternate mate is chosen. Additional board
metadata is informational and does not weaken the legal replay checks.

### Application difficulty categories

These labels are application puzzle-difficulty categories, not player titles:

| Category | Lichess puzzle rating |
| --- | ---: |
| Beginner | below 1200 |
| Developing | 1200–1599 |
| Intermediate | 1600–1999 |
| Advanced | 2000–2399 |
| Expert | 2400 and above |

### Provenance

All original themes are retained. Provenance uses the following priority:

1. `superGM`
2. `masterVsMaster`
3. `master`
4. `standard`

`isMasterGame` is true for `master`, `masterVsMaster`, or `superGM` themes;
the two narrower booleans retain their literal meanings. `isOpeningPuzzle` is
true only when the `opening` theme is present.

## Running the extractor

Install the normal project environment first:

```bash
uv sync --group dev
mkdir -p data
curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst \
  -o data/lichess_db_puzzle.csv.zst
```

For a standalone Python environment, the extractor dependencies are also
listed in `requirements-caro-kann.txt`.

Run the reproducible full extraction with:

```bash
uv run python scripts/extract_caro_kann_black.py \
  --input data/lichess_db_puzzle.csv.zst \
  --output public/data/caro-kann-black \
  --balanced-limit 10000 \
  --max-per-variation 1000 \
  --min-popularity 0 \
  --min-plays 20 \
  --max-rating-deviation 150 \
  --seed 20260803
```

Validation scans the source without publishing an export:

```bash
uv run python scripts/extract_caro_kann_black.py \
  --input data/lichess_db_puzzle.csv.zst \
  --validate-only
```

For a bounded development scan:

```bash
uv run python scripts/extract_caro_kann_black.py \
  --input data/lichess_db_puzzle.csv.zst \
  --output public/data/caro-kann-black-dev \
  --scan-limit 100000 \
  --balanced-limit 500
```

The extractor refuses to combine `--scan-limit` with the canonical
`public/data/caro-kann-black` output. This guard prevents a bounded development
scan from replacing a full production dataset while looking canonical; use a
distinct path such as `public/data/caro-kann-black-dev` as shown above.

The input may also be an uncompressed `.csv`, including a file with a header;
the official headerless layout is detected as well. `--input -` reads
uncompressed CSV from standard input. Input is streamed through the CSV parser
and valid records plus seen IDs are staged in a temporary standard-library
SQLite database, so the compressed export is not expanded into memory. Progress
summaries go to standard error periodically.

For file inputs, the extractor makes a bounded-memory pass over the source
bytes and records their exact byte size and SHA-256 in both the manifest and
validation summary. It also records `scanLimit`, `scanComplete`, and
`truncated`, making partial scans unambiguous. Standard input is non-rewindable
and may be intentionally truncated, so its `inputByteSize`, `inputSha256`, and
`inputSha256Scope` fields are explicitly `null` rather than claiming a digest
of the complete upstream source.

Use `--no-balanced-limit` (or `--balanced-limit none`) when the balanced quality
export should have no sample limit; `all`, `unlimited`, and `0` are accepted as
aliases. The per-variation cap and quality thresholds still apply unless their
own options are changed. Set `--max-per-variation none` (or `0`) separately to
remove the variation cap.

## Quality pool and deterministic balancing

`all.jsonl` contains every valid qualifying record, regardless of the balanced
quality thresholds. The balanced pool requires:

- popularity at least `--min-popularity` (default 0),
- plays at least `--min-plays` (default 20), and
- rating deviation at most `--max-rating-deviation` (default 150).

Selection is deterministic for a given source, configuration, and seed. It
balances cells across primary variation, difficulty, provenance, and tactical
theme where practical, enforces `--max-per-variation`, and then fills remaining
capacity from eligible records without violating that cap. Ranking is stored in
SQLite and derived from SHA-256 rather than Python's process-randomized
`hash()`.

The manifest, rather than this document, is authoritative for exact full-source
counts. It records the input filename, byte size, SHA-256, full/partial scan
status, UTC generation time, schema version, quality configuration,
scan/rejection/export totals, chunk counts, and breakdowns by difficulty,
variation, provenance, and theme. Never substitute fixture or development-scan
counts for a full-source run.

## Output and Pages deployment

The canonical local output is:

```text
public/data/caro-kann-black/
├── manifest.json
├── rejections-summary.json
├── all.jsonl
├── balanced.jsonl
├── chunks/chunk-0001.json ...
├── by-difficulty/*.jsonl
├── by-variation/*.jsonl
└── by-source/*.jsonl
```

Complete rejected rows are written only when an explicit path is supplied, for
example `--debug-rejections public/data/caro-kann-black/rejected-rows.jsonl`.
When that path is inside the output directory, the file participates in the
same atomic publish and is preserved. Paths that collide with the manifest,
summary, JSONL exports, chunks, or analytical shard directories are rejected.
The normal rejection summary contains aggregate reasons without copying the
source export.

GitHub Pages uploads `dashboard/`, so `refresh.py` performs a narrow build-time
sync into `dashboard/data/caro-kann-black/`. It validates the manifest, safe
relative chunk paths, JSON-array shape, and exact chunk counts, then copies only
`manifest.json` and the balanced `chunks/*.json` files referenced by it. It does
not copy `all.jsonl` or analytical shards. The generated dashboard copy is
ignored and replaced on each refresh so obsolete chunks cannot leak into a
deployment. If the canonical manifest is absent, refresh still succeeds and
removes any stale deployment copy.

The browser first fetches:

```text
data/caro-kann-black/manifest.json
```

It then loads only the balanced chunks needed by the static trainer. It never
needs a backend or the potentially large complete JSONL export.

## Training state

The trainer reuses the existing Chessground board factory, puzzle interactions,
daily queue behavior, and mobile layout. Black is always the user-controlled
side. After each correct Black move, the stored White reply is animated
automatically; the puzzle is solved only after the complete stored continuation
has finished. Wrong or illegal moves, skip, hint, and reveal do not mark a
puzzle solved.

Solved IDs are stored in browser `localStorage` under a Caro-Kann-specific
namespace, separate from the username-scoped personal blunder-puzzle state.
Progress survives reloads and regenerated dashboards on the same browser and
origin. It does not sync between devices and is lost when that site's browser
storage is cleared.

## Coverage limitations and optional extensions

Lichess opening tags are useful but incomplete: many tactics occurring later in
a game no longer carry an opening tag, so exact tag matching necessarily misses
some positions that arose from a Caro-Kann.

An optional broader pipeline could replay source PGNs and classify ECO codes
B10–B19 before applying the same Black-to-solve validation. That would be a
separate provenance path, not a reason to loosen current token matching.

An optional Stockfish verifier may re-evaluate exported positions or compare
alternative moves at a chosen depth. It is not required for extraction,
refresh, browser use, or Pages deployment, and the normal pipeline intentionally
does not rerun Stockfish for every Lichess puzzle.
