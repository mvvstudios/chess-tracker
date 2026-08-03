#!/usr/bin/env python3
"""Stream Black-to-solve Caro-Kann puzzles from the Lichess puzzle export.

The official database stores the position *before* the opponent's setup move.
For this trainer that means a qualifying source FEN has White to move.  The
first UCI move is applied to reach the displayed position, and every remaining
move is validated as the solution line.  No engine pass is needed.

The export is intentionally disk-backed.  Valid records and globally seen
puzzle IDs are staged in a temporary SQLite database, so scanning the complete
Lichess database does not retain the input or the qualifying records in RAM.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence, TextIO

import chess


LICHESS_SOURCE_URL = "https://database.lichess.org/#puzzles"
LICHESS_EXPORT_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
OPENING_ROOT = "Caro-Kann_Defense"
OPENING_FAMILY = "Caro-Kann Defense"
SCHEMA_VERSION = 1
DEFAULT_SEED = 20260803
DEFAULT_BALANCED_LIMIT = 10_000
DEFAULT_MAX_PER_VARIATION = 1_000
DEFAULT_CHUNK_SIZE = 1_000
DEFAULT_OUTPUT_PATH = Path("public/data/caro-kann-black")
INPUT_HASH_CHUNK_SIZE = 1024 * 1024

GENERATED_ROOT_FILES = {
    "all.jsonl",
    "balanced.jsonl",
    "manifest.json",
    "rejections-summary.json",
}
GENERATED_DIRECTORIES = {
    "chunks",
    "by-difficulty",
    "by-variation",
    "by-source",
}

# Lichess added DailyDate after OpeningTags in 2026.  It is optional here and
# any future trailing columns are ignored, keeping headerless exports forwards
# compatible while preserving the ten long-established required columns.
REQUIRED_COLUMNS = (
    "PuzzleId",
    "FEN",
    "Moves",
    "Rating",
    "RatingDeviation",
    "Popularity",
    "NbPlays",
    "Themes",
    "GameUrl",
    "OpeningTags",
)
OPTIONAL_COLUMNS = ("DailyDate",)
HEADERLESS_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS

REJECTION_CODES = (
    "invalidCsvRow",
    "missingId",
    "duplicateId",
    "missingCaroKannTag",
    "invalidFen",
    "wrongOriginalSideToMove",
    "missingMoves",
    "illegalSetupMove",
    "resultingPositionNotBlackToMove",
    "illegalSolutionMove",
)

DIFFICULTIES = ("beginner", "developing", "intermediate", "advanced", "expert")
PROVENANCES = ("standard", "master", "masterVsMaster", "superGM")
PROVENANCE_FILES = {
    "standard": "standard.jsonl",
    "master": "master.jsonl",
    "masterVsMaster": "master-vs-master.jsonl",
    "superGM": "super-gm.jsonl",
}

# This only chooses a representative balancing dimension.  Every original
# Lichess theme remains in the record and in manifest counts.
TACTICAL_THEME_PRIORITY = (
    "mateIn1",
    "mateIn2",
    "mateIn3",
    "mateIn4",
    "mateIn5",
    "fork",
    "pin",
    "sacrifice",
    "defensiveMove",
    "quietMove",
    "skewer",
    "discoveredAttack",
    "doubleCheck",
    "attraction",
    "clearance",
    "deflection",
    "interference",
    "overloading",
    "trappedPiece",
    "xRayAttack",
    "zugzwang",
)


class RowRejected(ValueError):
    """A recoverable, categorized source-row rejection."""

    def __init__(self, code: str, detail: str = "") -> None:
        if code not in REJECTION_CODES:
            raise ValueError(f"Unknown rejection code: {code}")
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class ExtractionStats:
    rows_scanned: int = 0
    caro_kann_rows: int = 0
    black_to_solve_rows: int = 0
    valid_rows: int = 0
    invalid_rows: int = 0
    rejection_counts: Counter[str] = field(
        default_factory=lambda: Counter({code: 0 for code in REJECTION_CODES})
    )

    def reject(self, code: str) -> None:
        self.invalid_rows += 1
        self.rejection_counts[code] += 1

    def count_dict(self, *, balanced_exported: int = 0) -> dict[str, int]:
        return {
            "rowsScanned": self.rows_scanned,
            "caroKannRows": self.caro_kann_rows,
            "blackToSolveRows": self.black_to_solve_rows,
            "validRows": self.valid_rows,
            "invalidRows": self.invalid_rows,
            "allExported": self.valid_rows,
            "balancedExported": balanced_exported,
        }


@dataclass(frozen=True)
class ExtractionConfig:
    input_path: str
    output_path: Path | None
    balanced_limit: int | None = DEFAULT_BALANCED_LIMIT
    max_per_variation: int | None = DEFAULT_MAX_PER_VARIATION
    min_popularity: int = 0
    min_plays: int = 20
    max_rating_deviation: int = 150
    seed: int = DEFAULT_SEED
    scan_limit: int | None = None
    chunk_size: int = DEFAULT_CHUNK_SIZE
    progress_every: int = 100_000
    validate_only: bool = False
    debug_rejections: Path | None = None


@dataclass(frozen=True)
class ScanMetadata:
    """Provenance showing exactly which input and scan scope produced output."""

    input_kind: str
    input_byte_size: int | None
    input_sha256: str | None
    scan_limit: int | None
    scan_complete: bool
    truncated: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputKind": self.input_kind,
            "inputByteSize": self.input_byte_size,
            "inputSha256": self.input_sha256,
            "inputSha256Scope": (
                "complete-file-bytes" if self.input_sha256 is not None else None
            ),
            "scanLimit": self.scan_limit,
            "scanComplete": self.scan_complete,
            "truncated": self.truncated,
        }


def difficulty_for_rating(rating: int) -> str:
    """Return the application's puzzle-difficulty category."""

    if rating < 1200:
        return "beginner"
    if rating < 1600:
        return "developing"
    if rating < 2000:
        return "intermediate"
    if rating < 2400:
        return "advanced"
    return "expert"


def classify_provenance(themes: Sequence[str] | set[str]) -> str:
    """Classify Lichess provenance using the required strict priority."""

    theme_set = set(themes)
    if "superGM" in theme_set:
        return "superGM"
    if "masterVsMaster" in theme_set:
        return "masterVsMaster"
    if "master" in theme_set:
        return "master"
    return "standard"


def caro_kann_tokens(opening_tags: str | Sequence[str]) -> list[str]:
    """Return exact/prefixed Caro-Kann tokens, most specific first."""

    tokens = opening_tags.split() if isinstance(opening_tags, str) else opening_tags
    matches = {
        str(token)
        for token in tokens
        if token == OPENING_ROOT or str(token).startswith(OPENING_ROOT + "_")
    }
    return sorted(matches, key=lambda token: (-len(token), token))


def variation_display_name(tag: str) -> str:
    """Convert a normalized Lichess Caro-Kann tag into a readable label."""

    if tag == OPENING_ROOT:
        return OPENING_FAMILY
    if not tag.startswith(OPENING_ROOT + "_"):
        raise ValueError(f"Not a Caro-Kann opening tag: {tag}")
    suffix = tag[len(OPENING_ROOT) + 1 :].replace("_", " ")
    return f"{OPENING_FAMILY}: {suffix}"


def variation_slug(tag: str) -> str:
    """Return a filename-safe stable slug derived from the normalized tag."""

    normalized = unicodedata.normalize("NFKD", tag)
    ascii_tag = normalized.encode("ascii", "ignore").decode("ascii").lower()
    pieces: list[str] = []
    previous_hyphen = False
    for character in ascii_tag:
        if character.isalnum():
            pieces.append(character)
            previous_hyphen = False
        elif not previous_hyphen:
            pieces.append("-")
            previous_hyphen = True
    slug = "".join(pieces).strip("-")
    if not slug:
        raise ValueError(f"Opening tag has no filename-safe characters: {tag!r}")
    return slug


def stable_sample_rank(seed: int, puzzle_id: str) -> int:
    """A cross-process/platform deterministic rank that fits SQLite INTEGER."""

    digest = hashlib.sha256(f"{seed}\x1f{puzzle_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)


def _primary_tactical_theme(themes: Sequence[str]) -> str:
    theme_set = set(themes)
    for theme in TACTICAL_THEME_PRIORITY:
        if theme in theme_set:
            return theme
    ignored = {
        "opening",
        "master",
        "masterVsMaster",
        "superGM",
        "short",
        "long",
        "veryLong",
    }
    remaining = sorted(theme_set - ignored)
    return remaining[0] if remaining else "unclassified"


def _as_int(row: Mapping[str, str], column: str) -> int:
    try:
        return int(row.get(column, "").strip())
    except (AttributeError, TypeError, ValueError) as exc:
        raise RowRejected("invalidCsvRow", f"{column} is not an integer") from exc


def _normalise_uci(raw_move: str, rejection_code: str) -> chess.Move:
    try:
        return chess.Move.from_uci(raw_move.strip().lower())
    except (AttributeError, ValueError) as exc:
        raise RowRejected(rejection_code, f"Invalid UCI move {raw_move!r}") from exc


def _legal_move_metadata(board: chess.Board) -> tuple[list[str], dict[str, list[str]], dict[str, list[str]]]:
    moves = sorted(board.legal_moves, key=lambda move: move.uci())
    legal_uci = [move.uci() for move in moves]
    dest_sets: dict[str, set[str]] = {}
    promotions: dict[str, list[str]] = {}
    for move in moves:
        origin = chess.square_name(move.from_square)
        destination = chess.square_name(move.to_square)
        dest_sets.setdefault(origin, set()).add(destination)
        if move.promotion is not None:
            promotions.setdefault(move.uci()[:4], []).append(move.uci())
    dests = {
        origin: sorted(destinations)
        for origin, destinations in sorted(dest_sets.items())
    }
    promotion_options = {
        coordinates: sorted(options)
        for coordinates, options in sorted(promotions.items())
    }
    return legal_uci, dests, promotion_options


def _mating_moves(board: chess.Board) -> list[str]:
    mating: list[str] = []
    for move in sorted(board.legal_moves, key=lambda item: item.uci()):
        after = board.copy(stack=False)
        after.push(move)
        if after.is_checkmate():
            mating.append(move.uci())
    return mating


def _solution_steps(
    starting_board: chess.Board,
    moves: Sequence[chess.Move],
    san_moves: Sequence[str],
    accepted_mating_moves: Sequence[str],
) -> list[dict[str, Any]]:
    """Build one UI step per Black decision, preserving trailing White replies."""

    steps: list[dict[str, Any]] = []
    board = starting_board.copy(stack=False)
    index = 0
    while index < len(moves):
        if board.turn != chess.BLACK:
            # End-to-end validation should make this unreachable.
            raise RowRejected("illegalSolutionMove", "Solution decision is not Black's")

        best_move = moves[index]
        best_san = san_moves[index]
        legal_uci, legal_dests, promotion_options = _legal_move_metadata(board)
        fen_before = board.fen()

        accepted = [best_move.uci()]
        if index == 0 and accepted_mating_moves:
            accepted = sorted(set(accepted_mating_moves) | {best_move.uci()})
        accepted_move_post_fens: dict[str, str] = {}
        for accepted_uci in accepted:
            accepted_move = chess.Move.from_uci(accepted_uci)
            if accepted_move not in board.legal_moves:
                raise RowRejected(
                    "illegalSolutionMove",
                    f"Accepted alternative {accepted_uci} is illegal",
                )
            after_accepted = board.copy(stack=False)
            after_accepted.push(accepted_move)
            accepted_move_post_fens[accepted_uci] = after_accepted.fen()

        board.push(best_move)
        post_best_fen = board.fen()

        reply_uci: str | None = None
        reply_san: str | None = None
        post_reply_fen: str | None = None
        if index + 1 < len(moves):
            if board.turn != chess.WHITE:
                raise RowRejected("illegalSolutionMove", "Stored reply is not White's")
            reply = moves[index + 1]
            reply_uci = reply.uci()
            reply_san = san_moves[index + 1]
            board.push(reply)
            post_reply_fen = board.fen()

        steps.append(
            {
                "fenBefore": fen_before,
                "bestMoveUci": best_move.uci(),
                "bestMoveSan": best_san,
                "acceptedMovesUci": accepted,
                "acceptedMovePostFens": accepted_move_post_fens,
                "postBestFen": post_best_fen,
                "legalMovesUci": legal_uci,
                "legalDests": legal_dests,
                "promotionOptions": promotion_options,
                "opponentReplyUci": reply_uci,
                "opponentReplySan": reply_san,
                "postReplyFen": post_reply_fen,
            }
        )
        index += 2
    return steps


def build_record(row: Mapping[str, str]) -> dict[str, Any]:
    """Validate one parsed CSV row and return its JSON-ready puzzle record.

    Duplicate IDs are a stream-level concern and are checked by
    :func:`extract_dataset` before this function is called.
    """

    puzzle_id = str(row.get("PuzzleId", "")).strip()
    if not puzzle_id:
        raise RowRejected("missingId")

    all_opening_tags = str(row.get("OpeningTags", "")).split()
    matches = caro_kann_tokens(all_opening_tags)
    if not matches:
        raise RowRejected("missingCaroKannTag")
    primary_tag = matches[0]

    raw_fen = str(row.get("FEN", "")).strip()
    try:
        original_board = chess.Board(raw_fen)
    except (TypeError, ValueError) as exc:
        raise RowRejected("invalidFen", str(exc)) from exc
    if not original_board.is_valid():
        raise RowRejected("invalidFen", "python-chess reports an invalid board status")
    if original_board.turn != chess.WHITE:
        raise RowRejected("wrongOriginalSideToMove")

    raw_moves = str(row.get("Moves", "")).split()
    if len(raw_moves) < 2:
        raise RowRejected("missingMoves", "At least setup + one solution move are required")

    setup_move = _normalise_uci(raw_moves[0], "illegalSetupMove")
    if setup_move not in original_board.legal_moves:
        raise RowRejected("illegalSetupMove", setup_move.uci())
    setup_san = original_board.san(setup_move)
    puzzle_board = original_board.copy(stack=False)
    puzzle_board.push(setup_move)
    if puzzle_board.turn != chess.BLACK:
        raise RowRejected("resultingPositionNotBlackToMove")

    solution_board = puzzle_board.copy(stack=False)
    solution_moves: list[chess.Move] = []
    solution_san: list[str] = []
    for raw_solution_move in raw_moves[1:]:
        move = _normalise_uci(raw_solution_move, "illegalSolutionMove")
        if move not in solution_board.legal_moves:
            raise RowRejected("illegalSolutionMove", move.uci())
        # SAN must be generated against the pre-move board.
        solution_san.append(solution_board.san(move))
        solution_moves.append(move)
        solution_board.push(move)

    if not solution_moves or puzzle_board.turn != chess.BLACK:
        raise RowRejected("illegalSolutionMove", "Solution does not start with Black")

    rating = _as_int(row, "Rating")
    rating_deviation = _as_int(row, "RatingDeviation")
    popularity = _as_int(row, "Popularity")
    plays = _as_int(row, "NbPlays")
    themes = str(row.get("Themes", "")).split()
    theme_set = set(themes)
    provenance = classify_provenance(themes)
    difficulty = difficulty_for_rating(rating)
    variation = variation_display_name(primary_tag)
    accepted_mating_moves = _mating_moves(puzzle_board) if "mateIn1" in theme_set else []
    steps = _solution_steps(
        puzzle_board,
        solution_moves,
        solution_san,
        accepted_mating_moves,
    )
    initial_legal_uci, initial_legal_dests, initial_promotions = _legal_move_metadata(
        puzzle_board
    )

    piece_values = {
        chess.PAWN: 1,
        chess.KNIGHT: 3,
        chess.BISHOP: 3,
        chess.ROOK: 5,
        chess.QUEEN: 9,
    }
    white_material = sum(
        len(puzzle_board.pieces(piece, chess.WHITE)) * value
        for piece, value in piece_values.items()
    )
    black_material = sum(
        len(puzzle_board.pieces(piece, chess.BLACK)) * value
        for piece, value in piece_values.items()
    )
    white_king = puzzle_board.king(chess.WHITE)
    black_king = puzzle_board.king(chess.BLACK)

    record: dict[str, Any] = {
        "id": puzzle_id,
        "source": "lichess",
        "sourceUrl": str(row.get("GameUrl", "")).strip(),
        "openingFamily": OPENING_FAMILY,
        "variation": variation,
        "variationTag": primary_tag,
        "openingTags": all_opening_tags,
        "originalFen": raw_fen,
        "setupMoveUci": setup_move.uci(),
        "setupMoveSan": setup_san,
        "puzzleFen": puzzle_board.fen(),
        "sideToMove": "black",
        "orientation": "black",
        "solutionUci": [move.uci() for move in solution_moves],
        "solutionSan": solution_san,
        "solutionSteps": steps,
        "acceptedMatingMovesUci": accepted_mating_moves,
        "acceptedMovePostFens": dict(steps[0]["acceptedMovePostFens"]),
        "legalMovesUci": initial_legal_uci,
        "legalDests": initial_legal_dests,
        "promotionOptions": initial_promotions,
        "rating": rating,
        "ratingDeviation": rating_deviation,
        "popularity": popularity,
        "plays": plays,
        "themes": themes,
        "primaryTacticalTheme": _primary_tactical_theme(themes),
        "difficulty": difficulty,
        "provenance": provenance,
        "isOpeningPuzzle": "opening" in theme_set,
        "isMasterGame": bool(theme_set & {"master", "masterVsMaster", "superGM"}),
        "isMasterVsMaster": "masterVsMaster" in theme_set,
        "isSuperGM": "superGM" in theme_set,
        "fullmoveNumber": puzzle_board.fullmove_number,
        "halfmoveClock": puzzle_board.halfmove_clock,
        "materialBalanceBlack": black_material - white_material,
        "whiteKingSquare": chess.square_name(white_king) if white_king is not None else None,
        "blackKingSquare": chess.square_name(black_king) if black_king is not None else None,
        "castlingRights": puzzle_board.fen().split()[2],
        "enPassantSquare": (
            chess.square_name(puzzle_board.ep_square)
            if puzzle_board.ep_square is not None
            else None
        ),
        "inCheck": puzzle_board.is_check(),
        "legalMoveCount": len(initial_legal_uci),
        "solutionLength": len(solution_moves),
        "blackDecisionCount": len(steps),
    }
    daily_date = str(row.get("DailyDate", "")).strip()
    if daily_date:
        record["dailyDate"] = daily_date
    return record


def _normalise_header(value: str) -> str:
    return value.lstrip("\ufeff").strip().lower()


def _is_header(fields: Sequence[str]) -> bool:
    normalized = {_normalise_header(value) for value in fields}
    if not fields:
        return False
    return _normalise_header(fields[0]) == "puzzleid" or (
        {"puzzleid", "fen", "moves", "openingtags"} <= normalized
    )


def _header_indexes(fields: Sequence[str]) -> dict[str, int]:
    by_name = {_normalise_header(value): index for index, value in enumerate(fields)}
    indexes: dict[str, int] = {}
    for column in HEADERLESS_COLUMNS:
        normalized = column.lower()
        if normalized in by_name:
            indexes[column] = by_name[normalized]
    return indexes


def _fields_to_row(fields: Sequence[str], indexes: Mapping[str, int]) -> dict[str, str]:
    if any(column not in indexes for column in REQUIRED_COLUMNS):
        raise RowRejected("invalidCsvRow", "Header is missing required columns")
    if any(indexes[column] >= len(fields) for column in REQUIRED_COLUMNS):
        raise RowRejected("invalidCsvRow", "CSV row has fewer than ten required fields")
    return {
        column: fields[indexes[column]] if indexes.get(column, len(fields)) < len(fields) else ""
        for column in HEADERLESS_COLUMNS
    }


@contextlib.contextmanager
def _open_input(path: str) -> Iterator[TextIO]:
    if path == "-":
        yield sys.stdin
        return

    source_path = Path(path)
    if source_path.suffix.lower() == ".zst":
        try:
            import zstandard
        except ImportError as exc:  # pragma: no cover - dependency failure path
            raise RuntimeError(
                "zstandard is required for .zst input; run `uv sync` first"
            ) from exc
        with source_path.open("rb") as compressed:
            decompressor = zstandard.ZstdDecompressor()
            with decompressor.stream_reader(compressed) as reader:
                with io.TextIOWrapper(reader, encoding="utf-8-sig", errors="replace", newline="") as text:
                    yield text
        return

    with source_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as text:
        yield text


def _input_file_identity(path: str) -> tuple[str, int | None, str | None]:
    """Return kind, exact byte count, and a bounded-memory SHA-256 digest."""

    if path == "-":
        # stdin may be a pipe and may be intentionally stopped by --scan-limit;
        # claiming a complete-byte digest would therefore be misleading.
        return "stdin", None, None

    byte_count = 0
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while True:
            block = stream.read(INPUT_HASH_CHUNK_SIZE)
            if not block:
                break
            byte_count += len(block)
            digest.update(block)
    return "file", byte_count, digest.hexdigest()


def _path_inside(path: Path, directory: Path) -> Path | None:
    try:
        return path.resolve().relative_to(directory.resolve())
    except ValueError:
        return None


def _validate_debug_relative_path(relative_path: Path) -> None:
    if relative_path == Path(".") or not relative_path.parts:
        raise ValueError("--debug-rejections must name a file, not the output directory")
    root_files = {name.casefold() for name in GENERATED_ROOT_FILES}
    generated_directories = {name.casefold() for name in GENERATED_DIRECTORIES}
    if len(relative_path.parts) == 1 and relative_path.name.casefold() in root_files:
        raise ValueError(
            f"--debug-rejections collides with generated output {relative_path.as_posix()}"
        )
    if relative_path.parts[0].casefold() in generated_directories:
        raise ValueError(
            f"--debug-rejections cannot write inside generated {relative_path.parts[0]}/"
        )


def _debug_relative_to_output(config: ExtractionConfig) -> Path | None:
    if config.debug_rejections is None or config.output_path is None:
        return None
    relative_path = _path_inside(config.debug_rejections, config.output_path)
    if relative_path is not None:
        _validate_debug_relative_path(relative_path)
    return relative_path


def _is_canonical_output(path: Path | None) -> bool:
    return path is not None and path.resolve() == DEFAULT_OUTPUT_PATH.resolve()


def _validate_config(config: ExtractionConfig) -> None:
    if not config.validate_only and config.output_path is None:
        raise ValueError("An output directory is required unless --validate-only is used")
    if (
        config.scan_limit is not None
        and not config.validate_only
        and _is_canonical_output(config.output_path)
    ):
        raise ValueError(
            "--scan-limit cannot target public/data/caro-kann-black; "
            "use a development output such as public/data/caro-kann-black-dev"
        )
    _debug_relative_to_output(config)


def _create_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode = OFF")
    connection.execute("PRAGMA synchronous = OFF")
    connection.execute("PRAGMA temp_store = FILE")
    connection.executescript(
        """
        CREATE TABLE seen_ids (
            id TEXT PRIMARY KEY
        ) WITHOUT ROWID;

        CREATE TABLE records (
            sequence INTEGER NOT NULL,
            id TEXT PRIMARY KEY,
            variation TEXT NOT NULL,
            variation_tag TEXT NOT NULL,
            variation_slug TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            provenance TEXT NOT NULL,
            primary_theme TEXT NOT NULL,
            balance_cell TEXT NOT NULL,
            quality_eligible INTEGER NOT NULL,
            sample_rank INTEGER NOT NULL,
            json TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE selected (
            id TEXT PRIMARY KEY,
            selection_order INTEGER NOT NULL UNIQUE
        ) WITHOUT ROWID;
        """
    )
    return connection


def _json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _write_debug_rejection(
    stream: TextIO | None,
    *,
    row_number: int,
    code: str,
    detail: str,
    row: Mapping[str, str] | None = None,
    raw_line: str | None = None,
) -> None:
    if stream is None:
        return
    payload: dict[str, Any] = {
        "rowNumber": row_number,
        "reason": code,
        "detail": detail,
    }
    if row is not None:
        payload["row"] = dict(row)
    if raw_line is not None:
        payload["rawLine"] = raw_line
    stream.write(_json_line(payload) + "\n")


def _progress(stats: ExtractionStats, started: float, *, final: bool = False) -> None:
    elapsed = time.monotonic() - started
    prefix = "Complete" if final else "Progress"
    print(
        f"{prefix}: Rows scanned={stats.rows_scanned:,}; "
        f"Caro-Kann rows={stats.caro_kann_rows:,}; "
        f"Black-to-solve rows={stats.black_to_solve_rows:,}; "
        f"Valid rows={stats.valid_rows:,}; Invalid rows={stats.invalid_rows:,}; "
        f"Elapsed={elapsed:.1f}s",
        file=sys.stderr,
        flush=True,
    )


def _scan_input(
    connection: sqlite3.Connection,
    config: ExtractionConfig,
    *,
    debug_path: Path | None,
) -> tuple[ExtractionStats, bool]:
    stats = ExtractionStats()
    started = time.monotonic()
    header_indexes: dict[str, int] | None = None
    header_decided = False
    truncated = False
    debug_stream: TextIO | None = None

    if debug_path is not None:
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        debug_stream = debug_path.open("w", encoding="utf-8")

    try:
        with _open_input(config.input_path) as source:
            for raw_line in source:
                if (
                    header_decided
                    and config.scan_limit is not None
                    and stats.rows_scanned >= config.scan_limit
                ):
                    truncated = True
                    break
                line = raw_line.rstrip("\r\n")
                try:
                    fields = next(csv.reader([line], strict=True))
                except (csv.Error, StopIteration) as exc:
                    if not header_decided:
                        header_indexes = {
                            column: index
                            for index, column in enumerate(HEADERLESS_COLUMNS)
                        }
                        header_decided = True
                    stats.rows_scanned += 1
                    stats.reject("invalidCsvRow")
                    _write_debug_rejection(
                        debug_stream,
                        row_number=stats.rows_scanned,
                        code="invalidCsvRow",
                        detail=str(exc),
                        raw_line=line,
                    )
                    continue

                if not header_decided and _is_header(fields):
                    header_indexes = _header_indexes(fields)
                    header_decided = True
                    continue
                if not header_decided:
                    header_indexes = {
                        column: index for index, column in enumerate(HEADERLESS_COLUMNS)
                    }
                    header_decided = True

                if config.scan_limit is not None and stats.rows_scanned >= config.scan_limit:
                    truncated = True
                    break
                stats.rows_scanned += 1
                parsed_row: dict[str, str] | None = None
                try:
                    assert header_indexes is not None
                    parsed_row = _fields_to_row(fields, header_indexes)
                    puzzle_id = parsed_row["PuzzleId"].strip()
                    if not puzzle_id:
                        raise RowRejected("missingId")

                    inserted = connection.execute(
                        "INSERT OR IGNORE INTO seen_ids(id) VALUES (?)", (puzzle_id,)
                    )
                    if inserted.rowcount != 1:
                        raise RowRejected("duplicateId", puzzle_id)

                    matches = caro_kann_tokens(parsed_row["OpeningTags"].split())
                    if not matches:
                        raise RowRejected("missingCaroKannTag")
                    stats.caro_kann_rows += 1

                    # Split the stages here so the progress counters have exact
                    # meanings even when later solution replay fails.
                    raw_fen = parsed_row["FEN"].strip()
                    try:
                        pre_setup = chess.Board(raw_fen)
                    except (TypeError, ValueError) as exc:
                        raise RowRejected("invalidFen", str(exc)) from exc
                    if not pre_setup.is_valid():
                        raise RowRejected("invalidFen", "invalid board status")
                    if pre_setup.turn != chess.WHITE:
                        raise RowRejected("wrongOriginalSideToMove")
                    raw_moves = parsed_row["Moves"].split()
                    if len(raw_moves) < 2:
                        raise RowRejected("missingMoves")
                    setup = _normalise_uci(raw_moves[0], "illegalSetupMove")
                    if setup not in pre_setup.legal_moves:
                        raise RowRejected("illegalSetupMove", setup.uci())
                    pre_setup.push(setup)
                    if pre_setup.turn != chess.BLACK:
                        raise RowRejected("resultingPositionNotBlackToMove")
                    stats.black_to_solve_rows += 1

                    record = build_record(parsed_row)
                    eligible = (
                        record["popularity"] >= config.min_popularity
                        and record["plays"] >= config.min_plays
                        and record["ratingDeviation"] <= config.max_rating_deviation
                    )
                    balance_cell = "\x1f".join(
                        (
                            record["variationTag"],
                            record["difficulty"],
                            record["provenance"],
                            record["primaryTacticalTheme"],
                        )
                    )
                    connection.execute(
                        """
                        INSERT INTO records(
                            sequence, id, variation, variation_tag, variation_slug,
                            difficulty, provenance, primary_theme, balance_cell,
                            quality_eligible, sample_rank, json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            stats.rows_scanned,
                            record["id"],
                            record["variation"],
                            record["variationTag"],
                            variation_slug(record["variationTag"]),
                            record["difficulty"],
                            record["provenance"],
                            record["primaryTacticalTheme"],
                            balance_cell,
                            int(eligible),
                            stable_sample_rank(config.seed, record["id"]),
                            _json_line(record),
                        ),
                    )
                    stats.valid_rows += 1
                except RowRejected as exc:
                    stats.reject(exc.code)
                    _write_debug_rejection(
                        debug_stream,
                        row_number=stats.rows_scanned,
                        code=exc.code,
                        detail=exc.detail,
                        row=parsed_row,
                        raw_line=None if parsed_row is not None else line,
                    )

                if (
                    config.progress_every > 0
                    and stats.rows_scanned % config.progress_every == 0
                ):
                    connection.commit()
                    _progress(stats, started)
    finally:
        if debug_stream is not None:
            debug_stream.close()

    connection.commit()
    _progress(stats, started, final=True)
    return stats, truncated


def _select_balanced(connection: sqlite3.Connection, config: ExtractionConfig) -> int:
    """Select deterministic, cell-round-robin quality records on disk."""

    connection.execute("DELETE FROM selected")
    per_variation: Counter[str] = Counter()
    selected_count = 0
    query = """
        WITH cell_ranked AS (
            SELECT
                id,
                variation_tag,
                sample_rank,
                ROW_NUMBER() OVER (
                    PARTITION BY balance_cell
                    ORDER BY sample_rank, id
                ) AS cell_position
            FROM records
            WHERE quality_eligible = 1
        )
        SELECT id, variation_tag
        FROM cell_ranked
        ORDER BY cell_position, sample_rank, id
    """
    for puzzle_id, variation_tag in connection.execute(query):
        if (
            config.max_per_variation is not None
            and per_variation[variation_tag] >= config.max_per_variation
        ):
            continue
        connection.execute(
            "INSERT INTO selected(id, selection_order) VALUES (?, ?)",
            (puzzle_id, selected_count),
        )
        selected_count += 1
        per_variation[variation_tag] += 1
        if config.balanced_limit is not None and selected_count >= config.balanced_limit:
            break
    connection.commit()
    return selected_count


def _query_counts(
    connection: sqlite3.Connection,
    column: str,
    *,
    selected: bool = False,
) -> dict[str, int]:
    allowed = {"difficulty", "variation", "provenance", "primary_theme"}
    if column not in allowed:
        raise ValueError(column)
    if selected:
        sql = f"""
            SELECT r.{column}, COUNT(*)
            FROM records r JOIN selected s ON s.id = r.id
            GROUP BY r.{column}
            ORDER BY r.{column}
        """
    else:
        sql = f"""
            SELECT {column}, COUNT(*)
            FROM records
            GROUP BY {column}
            ORDER BY {column}
        """
    return {str(name): int(count) for name, count in connection.execute(sql)}


def _theme_counts(connection: sqlite3.Connection, *, selected: bool = False) -> dict[str, int]:
    counts: Counter[str] = Counter()
    if selected:
        query = "SELECT r.json FROM records r JOIN selected s ON s.id=r.id"
    else:
        query = "SELECT json FROM records"
    for (raw_json,) in connection.execute(query):
        counts.update(json.loads(raw_json).get("themes", []))
    return dict(sorted(counts.items()))


def _variation_metadata(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    balanced = _query_counts(connection, "variation", selected=True)
    rows = connection.execute(
        """
        SELECT variation, variation_tag, variation_slug, COUNT(*)
        FROM records
        GROUP BY variation, variation_tag, variation_slug
        ORDER BY variation
        """
    )
    return [
        {
            "name": variation,
            "tag": tag,
            "slug": slug,
            "count": int(count),
            "balancedCount": balanced.get(variation, 0),
        }
        for variation, tag, slug, count in rows
    ]


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def _write_jsonl(path: Path, rows: Iterator[tuple[str]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as stream:
        for (raw_json,) in rows:
            stream.write(raw_json + "\n")
            count += 1
    return count


def _write_outputs(
    connection: sqlite3.Connection,
    config: ExtractionConfig,
    stats: ExtractionStats,
    balanced_count: int,
    scan_metadata: ScanMetadata,
    *,
    staged_debug_source: Path | None,
    debug_relative_path: Path | None,
) -> dict[str, Any]:
    assert config.output_path is not None
    output = config.output_path
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-build-", dir=output.parent))

    try:
        all_count = _write_jsonl(
            staging / "all.jsonl",
            connection.execute("SELECT json FROM records ORDER BY sequence, id"),
        )
        written_balanced = _write_jsonl(
            staging / "balanced.jsonl",
            connection.execute(
                """
                SELECT r.json
                FROM selected s JOIN records r ON r.id=s.id
                ORDER BY s.selection_order
                """
            ),
        )
        if all_count != stats.valid_rows or written_balanced != balanced_count:
            raise RuntimeError("Output count does not match validated staging count")

        for difficulty in DIFFICULTIES:
            _write_jsonl(
                staging / "by-difficulty" / f"{difficulty}.jsonl",
                connection.execute(
                    "SELECT json FROM records WHERE difficulty=? ORDER BY sequence, id",
                    (difficulty,),
                ),
            )

        variations = _variation_metadata(connection)
        seen_slugs: dict[str, str] = {}
        for variation in variations:
            slug = variation["slug"]
            tag = variation["tag"]
            if slug in seen_slugs and seen_slugs[slug] != tag:
                # A cryptographic suffix keeps the path stable if two future
                # Unicode tags transliterate to the same filename.
                suffix = hashlib.sha256(tag.encode("utf-8")).hexdigest()[:8]
                slug = f"{slug}-{suffix}"
                variation["slug"] = slug
            seen_slugs[slug] = tag
            _write_jsonl(
                staging / "by-variation" / f"{slug}.jsonl",
                connection.execute(
                    "SELECT json FROM records WHERE variation_tag=? ORDER BY sequence, id",
                    (tag,),
                ),
            )

        for provenance, filename in PROVENANCE_FILES.items():
            _write_jsonl(
                staging / "by-source" / filename,
                connection.execute(
                    "SELECT json FROM records WHERE provenance=? ORDER BY sequence, id",
                    (provenance,),
                ),
            )

        chunks: list[dict[str, Any]] = []
        chunk_number = 0
        chunk_stream: TextIO | None = None
        chunk_count = 0
        try:
            selected_rows = connection.execute(
                """
                SELECT r.json
                FROM selected s JOIN records r ON r.id=s.id
                ORDER BY s.selection_order
                """
            )
            for (raw_json,) in selected_rows:
                if chunk_stream is None:
                    chunk_number += 1
                    chunk_count = 0
                    chunk_path = staging / "chunks" / f"chunk-{chunk_number:04d}.json"
                    chunk_path.parent.mkdir(parents=True, exist_ok=True)
                    chunk_stream = chunk_path.open("w", encoding="utf-8")
                    chunk_stream.write("[\n")
                if chunk_count:
                    chunk_stream.write(",\n")
                chunk_stream.write(raw_json)
                chunk_count += 1
                if chunk_count >= config.chunk_size:
                    chunk_stream.write("\n]\n")
                    chunk_stream.close()
                    chunk_stream = None
                    chunks.append(
                        {
                            "path": f"chunks/chunk-{chunk_number:04d}.json",
                            "count": chunk_count,
                        }
                    )
            if chunk_stream is not None:
                chunk_stream.write("\n]\n")
                chunk_stream.close()
                chunk_stream = None
                chunks.append(
                    {
                        "path": f"chunks/chunk-{chunk_number:04d}.json",
                        "count": chunk_count,
                    }
                )
        finally:
            if chunk_stream is not None:
                chunk_stream.close()

        difficulty_counts = _query_counts(connection, "difficulty")
        variation_counts = _query_counts(connection, "variation")
        provenance_counts = _query_counts(connection, "provenance")
        theme_counts = _theme_counts(connection)
        balanced_dimensions = {
            "difficulty": _query_counts(connection, "difficulty", selected=True),
            "variation": _query_counts(connection, "variation", selected=True),
            "provenance": _query_counts(connection, "provenance", selected=True),
            "theme": _theme_counts(connection, selected=True),
            "primaryTacticalTheme": _query_counts(
                connection, "primary_theme", selected=True
            ),
        }
        counts = stats.count_dict(balanced_exported=balanced_count)
        quality_eligible = int(
            connection.execute(
                "SELECT COUNT(*) FROM records WHERE quality_eligible=1"
            ).fetchone()[0]
        )
        manifest: dict[str, Any] = {
            "datasetName": "Caro-Kann Puzzles for Black",
            "source": {
                "name": "Lichess Open Database: Puzzles",
                "url": LICHESS_SOURCE_URL,
                "exportUrl": LICHESS_EXPORT_URL,
            },
            "license": "CC0",
            "generatedAtUtc": datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            ),
            "solverColor": "black",
            "orientation": "black",
            "openingPrefix": OPENING_ROOT,
            "inputFilename": (
                "-" if config.input_path == "-" else Path(config.input_path).name
            ),
            **scan_metadata.to_dict(),
            "schemaVersion": SCHEMA_VERSION,
            "chunks": chunks,
            "counts": counts,
            "difficultyCounts": difficulty_counts,
            "variationCounts": variation_counts,
            "provenanceCounts": provenance_counts,
            "themeCounts": theme_counts,
            "balancedCounts": balanced_dimensions,
            "variations": variations,
            "qualityFilters": {
                "minPopularity": config.min_popularity,
                "minPlays": config.min_plays,
                "maxRatingDeviation": config.max_rating_deviation,
                "qualityEligible": quality_eligible,
            },
            "sampling": {
                "algorithm": "sha256-cell-round-robin-v1",
                "seed": config.seed,
                "balancedLimit": config.balanced_limit,
                "maxPerVariation": config.max_per_variation,
                "dimensions": [
                    "primaryVariation",
                    "difficulty",
                    "provenance",
                    "primaryTacticalTheme",
                ],
            },
            "difficultyBuckets": {
                "beginner": {"min": None, "max": 1199},
                "developing": {"min": 1200, "max": 1599},
                "intermediate": {"min": 1600, "max": 1999},
                "advanced": {"min": 2000, "max": 2399},
                "expert": {"min": 2400, "max": None},
            },
        }
        rejections_summary = {
            "rowsScanned": stats.rows_scanned,
            "totalRejected": stats.invalid_rows,
            **scan_metadata.to_dict(),
            "counts": {
                code: int(stats.rejection_counts.get(code, 0))
                for code in REJECTION_CODES
            },
        }
        _write_json(staging / "rejections-summary.json", rejections_summary)
        _write_json(staging / "manifest.json", manifest)
        if staged_debug_source is not None and debug_relative_path is not None:
            staged_debug_destination = staging / debug_relative_path
            staged_debug_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staged_debug_source, staged_debug_destination)

        backup = output.with_name(f".{output.name}-previous")
        if backup.exists():
            shutil.rmtree(backup)
        if output.exists():
            os.replace(output, backup)
        try:
            os.replace(staging, output)
        except BaseException:
            if backup.exists() and not output.exists():
                os.replace(backup, output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def extract_dataset(config: ExtractionConfig) -> dict[str, Any]:
    """Run a complete streaming extraction and return its summary/manifest."""

    _validate_config(config)
    input_kind, input_byte_size, input_sha256 = _input_file_identity(config.input_path)
    with tempfile.TemporaryDirectory(prefix="caro-kann-extractor-") as temp_dir:
        temporary_root = Path(temp_dir)
        database_path = temporary_root / "staging.sqlite3"
        debug_relative_path = _debug_relative_to_output(config)
        if debug_relative_path is not None:
            debug_scan_path = temporary_root / "rejected-rows.jsonl"
        else:
            debug_scan_path = config.debug_rejections
        connection = _create_database(database_path)
        try:
            stats, truncated = _scan_input(
                connection,
                config,
                debug_path=debug_scan_path,
            )
            scan_metadata = ScanMetadata(
                input_kind=input_kind,
                input_byte_size=input_byte_size,
                input_sha256=input_sha256,
                scan_limit=config.scan_limit,
                scan_complete=not truncated,
                truncated=truncated,
            )
            connection.executescript(
                """
                CREATE INDEX records_sequence_idx ON records(sequence, id);
                CREATE INDEX records_variation_idx ON records(variation_tag, sequence);
                CREATE INDEX records_difficulty_idx ON records(difficulty, sequence);
                CREATE INDEX records_provenance_idx ON records(provenance, sequence);
                CREATE INDEX records_quality_cell_idx
                    ON records(quality_eligible, balance_cell, sample_rank, id);
                """
            )
            connection.commit()
            balanced_count = _select_balanced(connection, config)
            counts = stats.count_dict(balanced_exported=balanced_count)
            if config.validate_only:
                summary = {
                    "valid": True,
                    **scan_metadata.to_dict(),
                    "counts": counts,
                    "rejections": {
                        code: int(stats.rejection_counts.get(code, 0))
                        for code in REJECTION_CODES
                    },
                    "qualityEligible": int(
                        connection.execute(
                            "SELECT COUNT(*) FROM records WHERE quality_eligible=1"
                        ).fetchone()[0]
                    ),
                }
                return summary
            return _write_outputs(
                connection,
                config,
                stats,
                balanced_count,
                scan_metadata,
                staged_debug_source=(
                    debug_scan_path if debug_relative_path is not None else None
                ),
                debug_relative_path=debug_relative_path,
            )
        finally:
            connection.close()


def _optional_limit(value: str) -> int | None:
    normalized = value.strip().lower()
    if normalized in {"0", "none", "all", "unlimited"}:
        return None
    try:
        parsed = int(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected a positive integer or 'none'") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("expected a positive integer or 'none'")
    return parsed


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected a positive integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        required=True,
        help="Official .csv.zst, uncompressed .csv, or - for uncompressed stdin",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Canonical output directory (ignored in --validate-only mode)",
    )
    parser.add_argument(
        "--balanced-limit",
        type=_optional_limit,
        default=DEFAULT_BALANCED_LIMIT,
        metavar="N|none",
        help="Maximum balanced records; none/all/unlimited/0 means no limit",
    )
    parser.add_argument(
        "--no-balanced-limit",
        action="store_const",
        const=None,
        dest="balanced_limit",
        help="Export every quality-eligible record allowed by the variation cap",
    )
    parser.add_argument(
        "--max-per-variation",
        type=_optional_limit,
        default=DEFAULT_MAX_PER_VARIATION,
        metavar="N|none",
        help="Hard variation cap; none/all/unlimited/0 disables it",
    )
    parser.add_argument("--min-popularity", type=int, default=0)
    parser.add_argument("--min-plays", type=int, default=20)
    parser.add_argument("--max-rating-deviation", type=int, default=150)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--scan-limit", type=_positive_int)
    parser.add_argument("--chunk-size", type=_positive_int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100_000,
        help="Progress interval in source rows; 0 disables periodic messages",
    )
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--debug-rejections",
        type=Path,
        metavar="PATH",
        help="Explicitly write complete rejected rows as JSONL",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    if args.progress_every < 0:
        parser.error("--progress-every must be zero or greater")
    if args.scan_limit is not None and not args.validate_only and _is_canonical_output(
        args.output
    ):
        parser.error(
            "--scan-limit cannot target public/data/caro-kann-black; "
            "choose a development output such as public/data/caro-kann-black-dev"
        )
    config = ExtractionConfig(
        input_path=args.input,
        output_path=None if args.validate_only else args.output,
        balanced_limit=args.balanced_limit,
        max_per_variation=args.max_per_variation,
        min_popularity=args.min_popularity,
        min_plays=args.min_plays,
        max_rating_deviation=args.max_rating_deviation,
        seed=args.seed,
        scan_limit=args.scan_limit,
        chunk_size=args.chunk_size,
        progress_every=args.progress_every,
        validate_only=args.validate_only,
        debug_rejections=args.debug_rejections,
    )
    # Keep the importable legacy implementation above stable for existing
    # callers and regression tests, but make the documented CLI rebuild the
    # schema-v2 deck consumed by the generalized catalog/browser.  The import
    # is intentionally local because the generic module reuses the hardened
    # parsing and balancing primitives from this module.
    if config.validate_only:
        result = extract_dataset(config)
    else:
        try:
            from scripts.extract_opening_puzzles import (
                MultiExtractionConfig,
                extract_opening_puzzles,
            )
        except ModuleNotFoundError:  # Direct ``python scripts/...`` execution.
            from extract_opening_puzzles import (  # type: ignore[no-redef]
                MultiExtractionConfig,
                extract_opening_puzzles,
            )

        assert config.output_path is not None
        output = config.output_path
        output.parent.mkdir(parents=True, exist_ok=True)
        debug_relative_path = _debug_relative_to_output(config)
        with tempfile.TemporaryDirectory(
            prefix="caro-kann-cli-", dir=output.parent
        ) as compatibility_temp:
            temporary_root = Path(compatibility_temp)
            generic_debug_path = (
                temporary_root / "rejected-rows.jsonl"
                if debug_relative_path is not None
                else config.debug_rejections
            )
            direct_catalog_output = output.name == DEFAULT_OUTPUT_PATH.name
            generic_root = output.parent if direct_catalog_output else temporary_root
            generic_result = extract_opening_puzzles(
                MultiExtractionConfig(
                    input_path=config.input_path,
                    deck_ids=("caro-kann-black",),
                    output_root=generic_root,
                    balanced_limit=config.balanced_limit,
                    max_per_variation=config.max_per_variation,
                    min_popularity=config.min_popularity,
                    min_plays=config.min_plays,
                    max_rating_deviation=config.max_rating_deviation,
                    seed=config.seed,
                    scan_limit=config.scan_limit,
                    chunk_size=config.chunk_size,
                    progress_every=config.progress_every,
                    validate_only=False,
                    debug_rejections=generic_debug_path,
                )
            )
            generated = generic_root / DEFAULT_OUTPUT_PATH.name
            if not direct_catalog_output:
                backup = output.with_name(f".{output.name}-previous")
                if backup.exists():
                    shutil.rmtree(backup)
                if output.exists():
                    os.replace(output, backup)
                try:
                    os.replace(generated, output)
                except BaseException:
                    if backup.exists() and not output.exists():
                        os.replace(backup, output)
                    raise
                if backup.exists():
                    shutil.rmtree(backup)
            if debug_relative_path is not None:
                debug_destination = output / debug_relative_path
                debug_destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(generic_debug_path, debug_destination)
            result = generic_result["manifests"]["caro-kann-black"]
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
