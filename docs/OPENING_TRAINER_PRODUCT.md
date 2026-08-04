# Chess Opening Puzzle Trainer product architecture

The Chess Opening Puzzle Trainer is the public, static training surface for the
promise: **“Train the tactics that actually arise from your openings.”** It is
an opening-conditioned tactics product, rather than a generic puzzle feed or a
move-order memorization tool.

## Routes and static build

`trainer.html` is the canonical public route. The historical
`caro-kann-puzzles.html` URL remains a fully compatible route, including deck
query strings such as `?deck=pirc-black`; returning bookmarks do not need a
redirect or a storage migration merely because the route changed.

Both files are rendered from
`chess_tracker/templates/caro-kann-puzzles.html`. `render_all_pages()` injects
only the normalized dashboard username into these two outputs. That compact
payload preserves the established browser-storage subject while keeping
personal ratings, games, and dashboard analysis out of the public trainer
HTML. Other dashboard pages continue to receive the complete computed payload.

The GitHub Pages workflow uploads `dashboard/`. A refresh copies the opening
catalog, each catalog manifest, its compact selection index, and only the
balanced JSON chunks referenced by those manifests from `public/data/` into
generated `dashboard/data/`. Full JSONL exports and analytical shards are not
published.

## Local storage and compatibility

There are two deliberately separate kinds of opening-trainer progress:

| Purpose | Key | Current schema |
| --- | --- | ---: |
| Permanent solved archive, one key per deck | `chess-tracker:puzzle-progress:v1:<deck-id>:<subject>` | 1 |
| Adaptive reviews and preferences | `chess-tracker:opening-trainer:v2:<subject>` | 2 |

`<subject>` is the lower-cased, URL-encoded username injected into the static
trainer page. Personal blunder puzzles use the unscoped
`chess-tracker:puzzle-progress:v1:<subject>` key, so opening-deck progress never
mixes with the personal puzzle queue.

The adaptive envelope stores:

- the last selected deck, Endless/finite training preference, last selected
  finite length (5, 10, or 20), and onboarding dismissal;
- review counters and scheduling per deck and puzzle ID;
- a small snapshot of variation, curriculum group, tactical themes, and
  application difficulty;
- bounded ephemeral traversal state: at most eight recently used cohorts, a
  small deck-wide recent-ID ring, and one resumable active run.

The current store reads and merges the previous
`chess-tracker:opening-trainer:v1:<subject>` envelope into v2. Existing solved
archive entries are migrated lazily when their puzzle is encountered: they
become a conservative learning review without deleting or weakening the
permanent solved record. Unsupported future versions fail closed, and storage
or quota failures fall back to the current in-memory visit while leaving the
solved archive authoritative.

The deck library’s export creates a versioned
`chess-opening-trainer-progress` JSON backup containing both permanent solved
records for every catalog deck and the adaptive trainer envelope. Import
validates the wrapper and known deck IDs, then merges with current device data;
it does not blindly replace newer local progress. Ephemeral selection cursors
and active membership are deliberately omitted from export and cannot be
replaced by import. This is the supported cross-device path while the product
remains account-free.

## Endless training and optional finite sessions

Normal opening training defaults to **Endless**. It continues serving positions
until the player stops or changes their study setup, with no artificial finish
line or session-complete screen. Players who want a bounded goal can choose a
5-, 10-, or 20-puzzle session from the visible Training length control; those
finite sessions retain the completion summary and mistake-review loop.

The stored `sessionMode` preference distinguishes Endless from finite training,
while `sessionSize` remembers the last finite length. An existing v2 envelope
without `sessionMode` safely defaults to Endless without discarding its saved
5/10/20 value. Explicit Due and Review Mistakes runs remain finite and do not
change the player's normal Training length preference.

Normal training membership is reserved before its puzzle chunks are loaded and
can be resumed for 24 hours on the same device. The resume token stores at most
20 IDs plus contiguous completed results; choosing **Start fresh** discards the
token but does not rewind the cohort cursor. A changed deck, dataset, study
setup, or Training length cannot resume the old token. A dataset-version
mismatch clears only ephemeral ordering and active-run state, never the solved
archive or adaptive reviews.

Durable learning is recorded per puzzle as each result is finalized. A result
is accepted once and records:

- solved, skipped, or revealed outcome;
- incorrect move count and hints used;
- first-try and unassisted status;
- variation, curriculum group, and tactical themes.

An unassisted solve requires a completed line on the first try with no hint,
skip, or revealed solution. Finite-session summaries derive completed puzzles,
first-try accuracy, unassisted solves, hints, reveals, skips, weak variations,
weak themes, and the IDs eligible for “Review mistakes.” Starting another
finite session creates a new bounded set; it does not reset permanent solved
progress. If a player changes deck, filters, mode, or Training length after
engaging with a position, the unfinished encounter is recorded as a supportive
review lapse before the active membership is replaced. An untouched position
is not penalized.

## Varied, bounded traversal

Each deck manifest points to a schema-versioned selection index containing a
stable puzzle ID, chunk locator, and only the metadata needed to filter and
order the complete balanced cohort. The controller chooses IDs from that index
first, then downloads only the chunks containing those IDs. Puzzle payloads
therefore remain lazy-loaded even though selection can reason over the full
cohort.

Focused Mix keeps a persisted seeded bag per deck, dataset version, and filter
signature. Session length is deliberately absent from that identity, so
consecutive 5-, 10-, and 20-puzzle starts consume forward through the same bag
instead of receiving prefixes of one daily shuffle. Reservation advances the
cursor, including when **Start fresh** replaces an untouched run. A bounded
deck-wide recent ring softens overlap when the player changes filters. Once a
finite cohort is exhausted, its next epoch reshuffles deterministically.

Guided uses the same no-repeat cursor with a curriculum-specific ordering. It
progresses by difficulty and bounded rating windows, shuffles under the
cohort's seed, and applies soft primary-theme and tactical-signature caps over
each recent window. If a genuinely narrow cohort cannot satisfy a cap, a
second pass relaxes it rather than hiding valid opening motifs.

The strict no-repeat guarantee applies to eligible New puzzles. Due reviews
remain intentionally eligible ahead of that lane and may recur according to
the adaptive schedule. **All variations** is the default cohort. Variation is
a primary study control: short deck lists use a native select, while longer
lists open the existing searchable picker.

## Adaptive review model

Review classifications are local and lightweight:

- **New:** no recorded encounter.
- **Learning:** encountered and scheduled in the future, without a mastered
  streak.
- **Due:** its `dueAt` time has arrived, including a previously mastered item
  whose interval elapsed.
- **Mastered:** at least three consecutive clean solves and a current interval
  of at least seven days.

Clean, unassisted solves advance intervals through 1, 3, 7, 14, 30, and 60
days. Any incorrect move, hint, skip, reveal, or incomplete result resets the
clean streak and returns the puzzle in approximately ten minutes. These
results also feed “Review mistakes.” Review state is supportive scheduling,
not a replacement for the permanent solved archive.

## First-party product events

There is no third-party analytics dependency. The controller emits a
`chess-trainer:event` `CustomEvent` and, when supplied by the host, calls
`window.ChessTrainerEventSink(detail)`. Events are best-effort and can never
interrupt training.

Every event includes `name`, ISO `occurredAt`, `deckId`, and `sessionId` when
available. Current event-specific properties are:

| Event | Additional properties |
| --- | --- |
| `trainer_opened` | none |
| `deck_selected` | `solverColor` |
| `session_started` | `size` (`null` for Endless), `mode`, `trainingLength` (`endless`, `finite`, or `review`) |
| `first_move_attempted` | `puzzleNumber` |
| `puzzle_completed` | `outcome`, `firstTry`, `unassisted`, `hintUsed`, `revealed` |
| `hint_used` | `puzzleNumber` |
| `solution_revealed` | `puzzleNumber` |
| `puzzle_skipped` | `puzzleNumber`, optional `reason` for an interrupted study |
| `session_completed` | Finite and explicit review runs only: `size`, `completed`, `firstTryAccuracy`, `unassisted`, `hints`, `reveals` |
| `review_mistakes_selected` | `count` |
| `load_failure` | `stage` (`catalog`, `deck`, `index`, `chunk`, or `positions`) and `deckId` when known |

Do not attach moves, FENs, source-game URLs, usernames, or imported progress to
events. If a future first-party collector needs a weekly user count, it should
attach a random installation identifier generated on-device and disclose that
collection. The initial north-star query is: distinct installations with at
least two non-review `session_completed` events in an ISO week. Because that
event is finite-only, this is explicitly a measure of focused finite-session
use, not of all Endless trainer activity. `session_started.trainingLength` can
be joined by `sessionId` to exclude review runs. Endless internal queue
rollovers do not emit `session_completed`. Without a first-party sink and
pseudonymous identifier, events remain local integration hooks and the
repository does not claim a weekly-user count.

## Offline boundary

The service worker pre-caches only the trainer shell: both routes, trainer
JavaScript and CSS, Chessground, pieces, icons, and the web-app manifest. It
does **not** enumerate or pre-cache opening data.

Catalogs, deck manifests, selection indexes, and balanced chunks use a
network-first runtime cache. An index or chunk is stored only after the trainer
actually requests it. This keeps installation small and avoids caching the
complete multi-deck puzzle payload. It also means:

- the first visit requires a network connection; offline support additionally
  requires a browser with service-worker support;
- an opening works offline only after its catalog, manifest, selection index,
  and required chunks have been downloaded on that device;
- selecting an unseen deck or reaching an uncached later chunk still requires
  the network;
- external source-game and analysis links remain online-only;
- browser eviction or cleared site data can remove cached decks and progress.

Service workers require HTTPS (GitHub Pages) or localhost. Local `file://`
viewing is unsupported; serve the repository with
`python3 -m http.server 8000` and open `/dashboard/trainer.html`.
