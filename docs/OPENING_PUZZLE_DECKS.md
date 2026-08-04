# Opening puzzle decks

The opening trainer is a static collection of five narrow tactical decks made
from the [official Lichess puzzle database](https://database.lichess.org/#puzzles),
which Lichess releases under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/). The original
`lichess_db_puzzle.csv.zst` download is ignored under `data/`; only the catalog,
manifests, compact selection indexes, and balanced browser chunks are versioned
for GitHub Pages.

The five canonical decks are:

| Deck ID | Display name | Solver | Board |
| --- | --- | --- | --- |
| `caro-kann-black` | Caro-Kann Defense — Black | Black | Black orientation |
| `colle-white` | Colle System — White | White | White orientation |
| `englund-white` | Englund Gambit — White | White | White orientation |
| `pirc-black` | Pirc Defense — Black | Black | Black orientation |
| `modern-black` | Modern Defense — Black | Black | Black orientation |

`chess_tracker/opening_puzzle_decks.py` is the authoritative registry for these
IDs, labels, colors, roots, output directories, and catalog manifest paths.

Lichess's stored continuation is already engine-derived. Extraction validates
the complete line with `python-chess`; it does not run Stockfish again.

The reader supports the official headerless order and exports with a header:
`PuzzleId`, `FEN`, `Moves`, `Rating`, `RatingDeviation`, `Popularity`,
`NbPlays`, `Themes`, `GameUrl`, and `OpeningTags`. `DailyDate` is optional and
future trailing fields are ignored safely.

## The setup-move convention

The export's `FEN` is the position immediately before the opponent makes the
first move in `Moves`. `Moves[0]` is that opponent setup move. The position
shown to the solver is the position after it, and `Moves[1:]` is the solution.

That makes the required perspective easy to state:

| Solver | Required side in `originalFen` | Setup move | Side in `puzzleFen` |
| --- | --- | --- | --- |
| White | Black | Black | White |
| Black | White | White | Black |

For each matching row, extraction parses the original FEN, generates setup SAN
before pushing `Moves[0]`, pushes it legally, and verifies that the resulting
side to move is the deck's solver color. It then saves that exact position as
`puzzleFen`, excludes the setup move from `solutionUci`, and replays every
solution move legally while generating SAN before each push. The first solution
move, `sideToMove`, and `orientation` must all agree with `solverColor`.

This is why a White deck must reject original White-to-move FENs and a Black
deck must reject original Black-to-move FENs. Using the solver's color in the
original FEN would create a puzzle for the other side.

## Exact opening-tag roots

`OpeningTags` is split on whitespace. A tag matches a root only when it is
exactly the root or begins with the root plus `_`:

```text
tag == root
tag.startswith(root + "_")
```

There is no substring search, ECO inference, position-pattern inference, or
transposition guess. A root in the middle of another tag does not qualify.
Every original token remains in `openingTags`; all qualifying tokens are kept
in `matchedOpeningTags`. The longest qualifying token becomes
`primaryOpeningTag`, with lexical ordering as the deterministic tie-breaker,
and `matchedTagRoot` records which configured root accepted it.

| Deck | Enabled roots |
| --- | --- |
| Caro-Kann | `Caro-Kann_Defense` |
| Colle | `Queens_Pawn_Game_Colle_System`, `Indian_Defense_Colle_System`, `Colle_System` |
| Englund | `Englund_Gambit` |
| Pirc | `Pirc_Defense` |
| Modern | `Modern_Defense`, `Queens_Pawn_Game_Modern_Defense` |

Colle needs three roots because Lichess classifies explicitly named Colle
lines under three independent prefixes. They are presented as one `Colle
System` family, but the original root and primary tag remain auditable in each
record. Generic Queen's Pawn positions and related Zukertort, Rubinstein,
London, Torre, Marienbad, Rapport-Jobava, and Yusupov-Rubinstein systems are not
inferred to be Colle positions.

The Englund deck accepts the exact `Englund_Gambit` family, including declined
descendants, but not generic Queen's Pawn positions, Blackmar-Diemer, Budapest,
Albin, or positions inferred merely from an early `...e5`.

The Pirc deck accepts current and future descendants of `Pirc_Defense`, but it
does not absorb Modern, Rat, Lion, Czech, Hippopotamus, Nimzowitsch/Pirc
Connection, or generic B06 positions.

Modern uses a second explicit root because Lichess gives the Queen's Pawn
move-order branch the independent `Queens_Pawn_Game_Modern_Defense` tag. Both
roots display as one `Modern Defense` family. Top-level Robatsch, Rat,
Hippopotamus, King's Indian, Grunfeld, Neo-Grunfeld, reversed Modern, and King's
Gambit `Modern_Defense` suffixes remain excluded. In particular,
`Robatsch_Defense` is deliberately an inactive alias: it may be treated as a
Modern synonym elsewhere, but this canonical dataset favors narrow,
source-auditable Lichess classification.

## Record schema and validation

All records preserve the existing Caro-Kann puzzle fields and add generic deck
metadata. A representative White-deck record is:

```json
{
  "id": "lichess-puzzle-id",
  "deckId": "colle-white",
  "source": "lichess",
  "sourceUrl": "https://lichess.org/...",
  "openingFamily": "Colle System",
  "variation": "Colle System: Traditional Colle",
  "openingTags": ["Queens_Pawn_Game_Colle_System_Traditional_Colle"],
  "matchedOpeningTags": ["Queens_Pawn_Game_Colle_System_Traditional_Colle"],
  "matchedTagRoot": "Queens_Pawn_Game_Colle_System",
  "primaryOpeningTag": "Queens_Pawn_Game_Colle_System_Traditional_Colle",
  "originalFen": "... b ...",
  "setupMoveUci": "...",
  "setupMoveSan": "...",
  "puzzleFen": "... w ...",
  "solverColor": "white",
  "sideToMove": "white",
  "orientation": "white",
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

IDs are unique within a deck. A source puzzle can occur in two decks only when
its own `OpeningTags` independently satisfies both configurations. Malformed
CSV, missing IDs, duplicate IDs, invalid FENs, perspective errors, missing or
illegal setup moves, and illegal solution continuations are counted per deck
without aborting the stream. Full rejected rows are written only behind the
explicit debug option.

For mate-in-one positions, all legal immediate mates may be accepted. The
existing `acceptedMovePostFens` map associates each accepted UCI move with the
exact legally reached FEN so choosing a non-principal mate leaves the browser
board in the correct final position.

### Difficulty and provenance

Difficulty names are application puzzle-difficulty categories, not player
titles:

| Category | Lichess puzzle rating |
| --- | ---: |
| Beginner | below 1200 |
| Developing | 1200–1599 |
| Intermediate | 1600–1999 |
| Advanced | 2000–2399 |
| Expert | 2400 and above |

All Lichess themes are retained. Provenance priority is `superGM`, then
`masterVsMaster`, then `master`, then `standard`. `isMasterGame` covers any of
the first three master themes, while `isMasterVsMaster`, `isSuperGM`, and
`isOpeningPuzzle` retain their literal theme meanings.

## One-pass extraction

Install dependencies and place the source under the ignored data directory:

```bash
uv sync --group dev
mkdir -p data
curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst \
  -o data/lichess_db_puzzle.csv.zst
```

Build all five canonical datasets in one streaming scan and generate the
catalog:

```bash
uv run python scripts/extract_opening_puzzles.py \
  --input data/lichess_db_puzzle.csv.zst \
  --deck all \
  --balanced-limit 10000 \
  --max-per-variation 1000 \
  --min-popularity 0 \
  --min-plays 20 \
  --max-rating-deviation 150 \
  --seed 20260803
```

Build one deck or an explicit subset without scanning once per selected deck:

```bash
uv run python scripts/extract_opening_puzzles.py \
  --input data/lichess_db_puzzle.csv.zst \
  --deck colle-white

uv run python scripts/extract_opening_puzzles.py \
  --input data/lichess_db_puzzle.csv.zst \
  --deck englund-white \
  --deck pirc-black \
  --deck modern-black
```

A fresh subset build writes an internally complete catalog containing only the
selected decks. When rebuilding a subset inside an existing output root, valid
unselected schema-2 deck outputs remain in the catalog; incomplete or stale
outputs are not referenced. The canonical `--deck all` build writes the
required five-deck catalog and keeps Caro-Kann as its default.

Validate all five perspectives and legal continuations without publishing:

```bash
uv run python scripts/extract_opening_puzzles.py \
  --input data/lichess_db_puzzle.csv.zst \
  --deck all \
  --validate-only
```

Use an ignored, noncanonical output root for a bounded development scan:

```bash
uv run python scripts/extract_opening_puzzles.py \
  --input data/lichess_db_puzzle.csv.zst \
  --deck all \
  --output-root data/opening-puzzles-dev \
  --scan-limit 100000 \
  --balanced-limit 500
```

The extractor refuses a publishing scan limit at the canonical output root so
a partial dataset cannot look complete. The legacy
`scripts/extract_caro_kann_black.py` entry point remains a backward-compatible
wrapper, so existing Caro-Kann rebuild commands still work.

The reader accepts `.csv.zst`, uncompressed `.csv`, header/headerless exports,
and uncompressed standard input. Future trailing CSV fields are ignored. It
streams rows into bounded disk-backed SQLite staging keyed by deck and puzzle
ID, routes each source row to every independently matched configuration, and
hashes a file input only once. Every manifest records the same complete input
byte size and SHA-256, whether the scan was complete, and whether a scan limit
truncated it. Exact production counts come from each generated manifest, never
from estimates or the rolling count on the Lichess website.

## Quality pool and balancing

Each deck's `all.jsonl` retains every valid exact-tag match. The balanced
quality pool independently requires:

- popularity at least 0,
- at least 20 plays, and
- rating deviation at most 150.

These thresholds are configurable. Deterministic SHA-256 ranking with seed
`20260803` balances variation, difficulty, provenance, and a representative
tactical theme, then fills remaining capacity without violating the configured
per-variation cap. The 10,000 limit is a maximum, not a quota: a narrow deck is
never padded, duplicated, weakened, or filled from a neighboring opening.

## Output, catalog, and GitHub Pages

Canonical generation produces:

```text
public/data/
├── opening-puzzle-catalog.json
├── caro-kann-black/
├── colle-white/
├── englund-white/
├── pirc-black/
└── modern-black/
```

Each deck contains `manifest.json`, `selection-index.json`,
`rejections-summary.json`, `all.jsonl`, `balanced.jsonl`, `chunks/*.json`, and
analytical shards under `by-difficulty/`, `by-variation/`, and `by-source/`.
Manifests use schema 2 and record deck identity, roots, perspective, source
provenance, exact scan and export counts, quality settings, breakdowns, exact
balanced chunk paths and counts, and the selection index's dataset-version
hash. The schema-1 index maps every balanced puzzle ID to a zero-based chunk
and offset and carries only filtering and diversity metadata; it never embeds
FENs or solution lines. Temporary legacy Caro-Kann count aliases remain
available where older consumers need them.

GitHub Pages uploads `dashboard/`, not `public/`. During a normal refresh,
`refresh.py` validates every catalog `manifestPath`, deck identity,
solver/orientation pair, manifest chunk path, JSON-array shape, and exact count.
It then copies only:

```text
dashboard/data/opening-puzzle-catalog.json
dashboard/data/<deck-id>/manifest.json
dashboard/data/<deck-id>/selection-index.json
dashboard/data/<deck-id>/chunks/*.json
```

The generated copy is ignored. Full JSONL files, rejection data, and analytical
shards never enter the Pages artifact. Path traversal and a symlinked
`dashboard/data` parent are rejected before generated files are removed. If the
canonical catalog is absent, refresh still succeeds and clears stale managed
trainer assets while preserving unrelated dashboard data.

## Browser loading and progress

The existing `caro-kann-puzzles.html` URL remains the single opening-trainer
application. It loads `data/opening-puzzle-catalog.json`, defaults to
`caro-kann-black`, and uses the selected catalog entry and manifest to set the
heading, filters, counts, solver color, and board orientation. A generation
token or aborted request prevents a slow chunk response from a previous deck
from entering the new deck's queue. Optional `?deck=<deck-id>` links select a
known deck; unknown IDs fall back to Caro-Kann safely.

Puzzle progress remains local to the browser and is namespaced by `deckId`, so
the same puzzle ID in two decks cannot cross-solve. The existing Caro-Kann key
continues to be read, preserving current progress. Solved IDs survive reloads
and dashboard rebuilds on the same origin, but they do not sync across devices
and disappear if site storage is cleared.

## Coverage limitation and future expansion

Lichess supplies `OpeningTags` only to puzzles that begin before move 20. Exact
tag extraction therefore does **not** contain every later tactic from games
that began in one of these openings. The strict source rule is intentional and
keeps all five datasets reproducible and auditable.

A later, separate pipeline could classify source PGNs by exact move sequence,
generate Stockfish positions, label them with distinct provenance, and
deduplicate against these Lichess records. PGN generation and mandatory
Stockfish re-verification are not part of the canonical datasets described
here.
