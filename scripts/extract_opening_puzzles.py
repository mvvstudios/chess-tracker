#!/usr/bin/env python3
"""Stream one or more exact-tag opening puzzle decks from Lichess.

The input is parsed and decompressed exactly once.  Each source row is routed
independently to the selected deck configurations and staged in one bounded,
disk-backed SQLite database.  Lichess's first stored move is the opponent's
setup move; it is applied before the displayed position and excluded from the
solver's continuation.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, Mapping, Sequence, TextIO

import chess

# Direct execution sets sys.path[0] to scripts/.  Keep the documented
# ``python scripts/...`` command working without requiring an installed wheel.
if __package__ in {None, ""}:  # pragma: no cover - exercised by CLI tests
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chess_tracker.opening_puzzle_decks import (  # noqa: E402
    DEFAULT_OPENING_PUZZLE_DECK_ID,
    OPENING_PUZZLE_DECK_ORDER,
    OPENING_PUZZLE_DECKS,
    OpeningPuzzleDeck,
    opening_puzzle_catalog,
    validate_catalog_manifest_path,
)
from scripts.extract_caro_kann_black import (  # noqa: E402
    DEFAULT_BALANCED_LIMIT,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_MAX_PER_VARIATION,
    DEFAULT_SEED,
    DIFFICULTIES,
    HEADERLESS_COLUMNS,
    LICHESS_EXPORT_URL,
    LICHESS_SOURCE_URL,
    PROVENANCES,
    PROVENANCE_FILES,
    REQUIRED_COLUMNS,
    TACTICAL_THEME_PRIORITY,
    _fields_to_row,
    _header_indexes,
    _input_file_identity,
    _is_header,
    _legal_move_metadata,
    _mating_moves,
    _normalise_uci,
    _open_input,
    classify_provenance,
    difficulty_for_rating,
    stable_sample_rank,
    variation_slug,
)


SCHEMA_VERSION = 2
DEFAULT_OUTPUT_ROOT = Path("public/data")
CATALOG_FILENAME = "opening-puzzle-catalog.json"
REJECTION_CODES = (
    "invalidCsvRow",
    "missingId",
    "duplicateId",
    "missingOpeningTag",
    "invalidFen",
    "wrongOriginalSideToMove",
    "missingMoves",
    "illegalSetupMove",
    "resultingPositionWrongSideToMove",
    "illegalSolutionMove",
)


class RowRejected(ValueError):
    """A recoverable deck-specific source-row rejection."""

    def __init__(self, code: str, detail: str = "") -> None:
        if code not in REJECTION_CODES:
            raise ValueError(f"Unknown rejection code: {code}")
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class DeckExtractionStats:
    deck_id: str
    rows_scanned: int = 0
    opening_matched_rows: int = 0
    perspective_matched_rows: int = 0
    valid_rows: int = 0
    invalid_rows: int = 0
    rejection_counts: Counter[str] = field(
        default_factory=lambda: Counter({code: 0 for code in REJECTION_CODES})
    )

    def reject(self, code: str) -> None:
        self.invalid_rows += 1
        self.rejection_counts[code] += 1

    def count_dict(self, *, balanced_exported: int = 0) -> dict[str, int]:
        counts = {
            "rowsScanned": self.rows_scanned,
            "openingMatchedRows": self.opening_matched_rows,
            "perspectiveMatchedRows": self.perspective_matched_rows,
            "validRows": self.valid_rows,
            "invalidRows": self.invalid_rows,
            "allExported": self.valid_rows,
            "balancedExported": balanced_exported,
        }
        deck = OPENING_PUZZLE_DECKS[self.deck_id]
        if deck.solver_color == "black":
            counts["blackToSolveRows"] = self.perspective_matched_rows
        else:
            counts["whiteToSolveRows"] = self.perspective_matched_rows
        if self.deck_id == DEFAULT_OPENING_PUZZLE_DECK_ID:
            counts["caroKannRows"] = self.opening_matched_rows
        return counts


@dataclass(frozen=True)
class MultiExtractionConfig:
    input_path: str
    deck_ids: tuple[str, ...] = OPENING_PUZZLE_DECK_ORDER
    output_root: Path | None = DEFAULT_OUTPUT_ROOT
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


def _turn_for_color(color: str) -> chess.Color:
    if color == "white":
        return chess.WHITE
    if color == "black":
        return chess.BLACK
    raise ValueError(f"Unsupported solver color: {color!r}")


def matching_opening_tags(
    opening_tags: str | Sequence[str], deck: OpeningPuzzleDeck
) -> list[str]:
    """Return exact/root-underscore matches, most specific first."""

    tokens = opening_tags.split() if isinstance(opening_tags, str) else opening_tags
    matches = {
        str(token)
        for token in tokens
        if any(
            str(token) == root or str(token).startswith(root + "_")
            for root in deck.opening_tag_roots
        )
    }
    return sorted(matches, key=lambda token: (-len(token), token))


def matched_root_for_tag(tag: str, deck: OpeningPuzzleDeck) -> str:
    """Return the most-specific configured root responsible for a tag match."""

    roots = [
        root
        for root in deck.opening_tag_roots
        if tag == root or tag.startswith(root + "_")
    ]
    if not roots:
        raise ValueError(f"{tag!r} does not match deck {deck.id!r}")
    return sorted(roots, key=lambda root: (-len(root), root))[0]


def variation_display_name(
    primary_tag: str, matched_root: str, deck: OpeningPuzzleDeck
) -> str:
    """Flatten a source tag into the configured deck's display family."""

    if primary_tag != matched_root and not primary_tag.startswith(matched_root + "_"):
        raise ValueError(f"{primary_tag!r} is not a descendant of {matched_root!r}")
    if primary_tag == matched_root:
        if (
            deck.id == "modern-black"
            and matched_root == "Queens_Pawn_Game_Modern_Defense"
        ):
            return "Modern Defense: Queen’s Pawn Move Order"
        return deck.opening_family
    suffix = primary_tag[len(matched_root) + 1 :].replace("_", " ")
    return f"{deck.opening_family}: {suffix}"


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


def _normalise_generic_uci(raw_move: str, rejection_code: str) -> chess.Move:
    try:
        return _normalise_uci(raw_move, "illegalSolutionMove")
    except Exception as exc:
        # The legacy helper raises its own RowRejected class.  Translate it so
        # callers always receive the generic rejection vocabulary.
        raise RowRejected(rejection_code, f"Invalid UCI move {raw_move!r}") from exc


def _solution_steps(
    starting_board: chess.Board,
    moves: Sequence[chess.Move],
    san_moves: Sequence[str],
    accepted_mating_moves: Sequence[str],
    solver_turn: chess.Color,
) -> list[dict[str, Any]]:
    """Build one interactive step per solver decision for either color."""

    steps: list[dict[str, Any]] = []
    board = starting_board.copy(stack=False)
    index = 0
    while index < len(moves):
        if board.turn != solver_turn:
            raise RowRejected("illegalSolutionMove", "Decision is not the solver's")

        best_move = moves[index]
        legal_uci, legal_dests, promotion_options = _legal_move_metadata(board)
        fen_before = board.fen()
        accepted = [best_move.uci()]
        if index == 0 and accepted_mating_moves:
            accepted = sorted(set(accepted_mating_moves) | {best_move.uci()})

        accepted_move_post_fens: dict[str, str] = {}
        for accepted_uci in accepted:
            try:
                accepted_move = chess.Move.from_uci(accepted_uci)
            except ValueError as exc:  # pragma: no cover - internal invariant
                raise RowRejected("illegalSolutionMove", accepted_uci) from exc
            if accepted_move not in board.legal_moves:
                raise RowRejected("illegalSolutionMove", accepted_uci)
            after = board.copy(stack=False)
            after.push(accepted_move)
            accepted_move_post_fens[accepted_uci] = after.fen()

        board.push(best_move)
        post_best_fen = board.fen()
        reply_uci: str | None = None
        reply_san: str | None = None
        post_reply_fen: str | None = None
        if index + 1 < len(moves):
            if board.turn == solver_turn:
                raise RowRejected("illegalSolutionMove", "Reply belongs to solver")
            reply = moves[index + 1]
            reply_uci = reply.uci()
            reply_san = san_moves[index + 1]
            board.push(reply)
            post_reply_fen = board.fen()

        steps.append(
            {
                "fenBefore": fen_before,
                "bestMoveUci": best_move.uci(),
                "bestMoveSan": san_moves[index],
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


def build_record(
    row: Mapping[str, str], deck: OpeningPuzzleDeck | str
) -> dict[str, Any]:
    """Validate one row for one deck and return a JSON-serializable record."""

    if isinstance(deck, str):
        deck = OPENING_PUZZLE_DECKS[deck]
    puzzle_id = str(row.get("PuzzleId", "")).strip()
    if not puzzle_id:
        raise RowRejected("missingId")

    all_opening_tags = str(row.get("OpeningTags", "")).split()
    matches = matching_opening_tags(all_opening_tags, deck)
    if not matches:
        raise RowRejected("missingOpeningTag")
    primary_tag = matches[0]
    matched_root = matched_root_for_tag(primary_tag, deck)

    raw_fen = str(row.get("FEN", "")).strip()
    try:
        original_board = chess.Board(raw_fen)
    except (TypeError, ValueError) as exc:
        raise RowRejected("invalidFen", str(exc)) from exc
    if not original_board.is_valid():
        raise RowRejected("invalidFen", "python-chess reports an invalid board status")

    solver_turn = _turn_for_color(deck.solver_color)
    if original_board.turn == solver_turn:
        raise RowRejected("wrongOriginalSideToMove")

    raw_moves = str(row.get("Moves", "")).split()
    if len(raw_moves) < 2:
        raise RowRejected("missingMoves", "At least setup + one solution move are required")
    setup_move = _normalise_generic_uci(raw_moves[0], "illegalSetupMove")
    if setup_move not in original_board.legal_moves:
        raise RowRejected("illegalSetupMove", setup_move.uci())
    setup_san = original_board.san(setup_move)
    puzzle_board = original_board.copy(stack=False)
    puzzle_board.push(setup_move)
    if puzzle_board.turn != solver_turn:
        raise RowRejected("resultingPositionWrongSideToMove")

    solution_board = puzzle_board.copy(stack=False)
    solution_moves: list[chess.Move] = []
    solution_san: list[str] = []
    for raw_solution_move in raw_moves[1:]:
        move = _normalise_generic_uci(raw_solution_move, "illegalSolutionMove")
        if move not in solution_board.legal_moves:
            raise RowRejected("illegalSolutionMove", move.uci())
        solution_san.append(solution_board.san(move))
        solution_moves.append(move)
        solution_board.push(move)
    if not solution_moves or puzzle_board.turn != solver_turn:
        raise RowRejected("illegalSolutionMove", "Solution does not start with solver")

    rating = _as_int(row, "Rating")
    rating_deviation = _as_int(row, "RatingDeviation")
    popularity = _as_int(row, "Popularity")
    plays = _as_int(row, "NbPlays")
    themes = str(row.get("Themes", "")).split()
    theme_set = set(themes)
    accepted_mating_moves = _mating_moves(puzzle_board) if "mateIn1" in theme_set else []
    steps = _solution_steps(
        puzzle_board,
        solution_moves,
        solution_san,
        accepted_mating_moves,
        solver_turn,
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
    variation = variation_display_name(primary_tag, matched_root, deck)
    provenance = classify_provenance(themes)

    record: dict[str, Any] = {
        "id": puzzle_id,
        "deckId": deck.id,
        "source": "lichess",
        "sourceUrl": str(row.get("GameUrl", "")).strip(),
        "openingFamily": deck.opening_family,
        "variation": variation,
        "variationTag": primary_tag,
        "openingTags": all_opening_tags,
        "matchedOpeningTags": matches,
        "matchedTagRoot": matched_root,
        "primaryOpeningTag": primary_tag,
        "originalFen": raw_fen,
        "setupMoveUci": setup_move.uci(),
        "setupMoveSan": setup_san,
        "puzzleFen": puzzle_board.fen(),
        "solverColor": deck.solver_color,
        "sideToMove": deck.solver_color,
        "orientation": deck.orientation,
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
        "difficulty": difficulty_for_rating(rating),
        "provenance": provenance,
        "isOpeningPuzzle": "opening" in theme_set,
        "isMasterGame": bool(theme_set & {"master", "masterVsMaster", "superGM"}),
        "isMasterVsMaster": "masterVsMaster" in theme_set,
        "isSuperGM": "superGM" in theme_set,
        "fullmoveNumber": puzzle_board.fullmove_number,
        "halfmoveClock": puzzle_board.halfmove_clock,
        "materialBalanceBlack": black_material - white_material,
        "whiteKingSquare": (
            chess.square_name(white_king) if white_king is not None else None
        ),
        "blackKingSquare": (
            chess.square_name(black_king) if black_king is not None else None
        ),
        "castlingRights": puzzle_board.fen().split()[2],
        "enPassantSquare": (
            chess.square_name(puzzle_board.ep_square)
            if puzzle_board.ep_square is not None
            else None
        ),
        "inCheck": puzzle_board.is_check(),
        "legalMoveCount": len(initial_legal_uci),
        "solutionLength": len(solution_moves),
        "solverDecisionCount": len(steps),
    }
    if deck.solver_color == "black":
        record["blackDecisionCount"] = len(steps)
    else:
        record["whiteDecisionCount"] = len(steps)
    daily_date = str(row.get("DailyDate", "")).strip()
    if daily_date:
        record["dailyDate"] = daily_date
    return record


def _create_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode = OFF")
    connection.execute("PRAGMA synchronous = OFF")
    connection.execute("PRAGMA temp_store = FILE")
    connection.executescript(
        """
        CREATE TABLE seen_ids (
            deck_id TEXT NOT NULL,
            id TEXT NOT NULL,
            PRIMARY KEY(deck_id, id)
        ) WITHOUT ROWID;

        CREATE TABLE records (
            deck_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            id TEXT NOT NULL,
            variation TEXT NOT NULL,
            variation_tag TEXT NOT NULL,
            variation_slug TEXT NOT NULL,
            matched_root TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            provenance TEXT NOT NULL,
            primary_theme TEXT NOT NULL,
            balance_cell TEXT NOT NULL,
            quality_eligible INTEGER NOT NULL,
            sample_rank INTEGER NOT NULL,
            json TEXT NOT NULL,
            PRIMARY KEY(deck_id, id)
        ) WITHOUT ROWID;

        CREATE TABLE selected (
            deck_id TEXT NOT NULL,
            id TEXT NOT NULL,
            selection_order INTEGER NOT NULL,
            PRIMARY KEY(deck_id, id),
            UNIQUE(deck_id, selection_order)
        ) WITHOUT ROWID;
        """
    )
    return connection


def _json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _write_debug_rejection(
    stream: TextIO | None,
    *,
    deck_id: str,
    row_number: int,
    code: str,
    detail: str,
    row: Mapping[str, str] | None = None,
    raw_line: str | None = None,
) -> None:
    if stream is None:
        return
    payload: dict[str, Any] = {
        "deckId": deck_id,
        "rowNumber": row_number,
        "reason": code,
        "detail": detail,
    }
    if row is not None:
        payload["row"] = dict(row)
    if raw_line is not None:
        payload["rawLine"] = raw_line
    stream.write(_json_line(payload) + "\n")


def _progress(
    stats_by_deck: Mapping[str, DeckExtractionStats],
    started: float,
    *,
    final: bool = False,
) -> None:
    elapsed = time.monotonic() - started
    prefix = "Complete" if final else "Progress"
    parts = []
    for deck_id, stats in stats_by_deck.items():
        parts.append(
            f"{deck_id}: matched={stats.opening_matched_rows:,}, "
            f"perspective={stats.perspective_matched_rows:,}, "
            f"valid={stats.valid_rows:,}, invalid={stats.invalid_rows:,}"
        )
    rows = next(iter(stats_by_deck.values())).rows_scanned if stats_by_deck else 0
    print(
        f"{prefix}: Rows scanned={rows:,}; " + "; ".join(parts) + f"; Elapsed={elapsed:.1f}s",
        file=sys.stderr,
        flush=True,
    )


def _scan_input(
    connection: sqlite3.Connection,
    config: MultiExtractionConfig,
) -> tuple[dict[str, DeckExtractionStats], bool]:
    stats_by_deck = {
        deck_id: DeckExtractionStats(deck_id=deck_id) for deck_id in config.deck_ids
    }
    started = time.monotonic()
    header_indexes: dict[str, int] | None = None
    header_decided = False
    truncated = False
    debug_stream: TextIO | None = None
    if config.debug_rejections is not None:
        config.debug_rejections.parent.mkdir(parents=True, exist_ok=True)
        debug_stream = config.debug_rejections.open("w", encoding="utf-8")

    def reject_all(code: str, detail: str, raw_line: str) -> None:
        for deck_id, stats in stats_by_deck.items():
            stats.rows_scanned += 1
            stats.reject(code)
            _write_debug_rejection(
                debug_stream,
                deck_id=deck_id,
                row_number=stats.rows_scanned,
                code=code,
                detail=detail,
                raw_line=raw_line,
            )

    try:
        with _open_input(config.input_path) as source:
            for raw_line in source:
                current_rows = (
                    next(iter(stats_by_deck.values())).rows_scanned
                    if stats_by_deck
                    else 0
                )
                if (
                    header_decided
                    and config.scan_limit is not None
                    and current_rows >= config.scan_limit
                ):
                    truncated = True
                    break
                line = raw_line.rstrip("\r\n")
                try:
                    fields = next(csv.reader([line], strict=True))
                except (csv.Error, StopIteration) as exc:
                    if not header_decided:
                        header_indexes = {
                            column: index for index, column in enumerate(HEADERLESS_COLUMNS)
                        }
                        header_decided = True
                    reject_all("invalidCsvRow", str(exc), line)
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

                current_rows = (
                    next(iter(stats_by_deck.values())).rows_scanned
                    if stats_by_deck
                    else 0
                )
                if config.scan_limit is not None and current_rows >= config.scan_limit:
                    truncated = True
                    break

                parsed_row: dict[str, str] | None = None
                parse_error: RowRejected | None = None
                try:
                    assert header_indexes is not None
                    parsed_row = _fields_to_row(fields, header_indexes)
                except Exception as exc:
                    parse_error = RowRejected("invalidCsvRow", str(exc))

                for deck_id, stats in stats_by_deck.items():
                    stats.rows_scanned += 1
                    deck = OPENING_PUZZLE_DECKS[deck_id]
                    try:
                        if parse_error is not None:
                            raise parse_error
                        assert parsed_row is not None
                        puzzle_id = parsed_row["PuzzleId"].strip()
                        if not puzzle_id:
                            raise RowRejected("missingId")
                        matches = matching_opening_tags(
                            parsed_row["OpeningTags"].split(), deck
                        )
                        if not matches:
                            raise RowRejected("missingOpeningTag")
                        inserted = connection.execute(
                            "INSERT OR IGNORE INTO seen_ids(deck_id,id) VALUES (?,?)",
                            (deck_id, puzzle_id),
                        )
                        if inserted.rowcount != 1:
                            raise RowRejected("duplicateId", puzzle_id)
                        stats.opening_matched_rows += 1

                        raw_fen = parsed_row["FEN"].strip()
                        try:
                            pre_setup = chess.Board(raw_fen)
                        except (TypeError, ValueError) as exc:
                            raise RowRejected("invalidFen", str(exc)) from exc
                        if not pre_setup.is_valid():
                            raise RowRejected("invalidFen", "invalid board status")
                        solver_turn = _turn_for_color(deck.solver_color)
                        if pre_setup.turn == solver_turn:
                            raise RowRejected("wrongOriginalSideToMove")
                        raw_moves = parsed_row["Moves"].split()
                        if len(raw_moves) < 2:
                            raise RowRejected("missingMoves")
                        setup = _normalise_generic_uci(
                            raw_moves[0], "illegalSetupMove"
                        )
                        if setup not in pre_setup.legal_moves:
                            raise RowRejected("illegalSetupMove", setup.uci())
                        pre_setup.push(setup)
                        if pre_setup.turn != solver_turn:
                            raise RowRejected("resultingPositionWrongSideToMove")
                        stats.perspective_matched_rows += 1

                        record = build_record(parsed_row, deck)
                        eligible = (
                            record["popularity"] >= config.min_popularity
                            and record["plays"] >= config.min_plays
                            and record["ratingDeviation"]
                            <= config.max_rating_deviation
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
                                deck_id, sequence, id, variation, variation_tag,
                                variation_slug, matched_root, difficulty,
                                provenance, primary_theme, balance_cell,
                                quality_eligible, sample_rank, json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                deck_id,
                                stats.rows_scanned,
                                record["id"],
                                record["variation"],
                                record["variationTag"],
                                variation_slug(record["variationTag"]),
                                record["matchedTagRoot"],
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
                            deck_id=deck_id,
                            row_number=stats.rows_scanned,
                            code=exc.code,
                            detail=exc.detail,
                            row=parsed_row,
                            raw_line=None if parsed_row is not None else line,
                        )

                rows_scanned = (
                    next(iter(stats_by_deck.values())).rows_scanned
                    if stats_by_deck
                    else 0
                )
                if config.progress_every > 0 and rows_scanned % config.progress_every == 0:
                    connection.commit()
                    _progress(stats_by_deck, started)
    finally:
        if debug_stream is not None:
            debug_stream.close()

    connection.commit()
    _progress(stats_by_deck, started, final=True)
    return stats_by_deck, truncated


def _select_balanced(
    connection: sqlite3.Connection,
    config: MultiExtractionConfig,
    deck_id: str,
) -> int:
    """Use the existing SHA-256 cell-round-robin algorithm per deck."""

    connection.execute("DELETE FROM selected WHERE deck_id=?", (deck_id,))
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
            WHERE deck_id=? AND quality_eligible=1
        )
        SELECT id, variation_tag
        FROM cell_ranked
        ORDER BY cell_position, sample_rank, id
    """
    for puzzle_id, variation_tag in connection.execute(query, (deck_id,)):
        if (
            config.max_per_variation is not None
            and per_variation[variation_tag] >= config.max_per_variation
        ):
            continue
        connection.execute(
            "INSERT INTO selected(deck_id,id,selection_order) VALUES (?,?,?)",
            (deck_id, puzzle_id, selected_count),
        )
        selected_count += 1
        per_variation[variation_tag] += 1
        if config.balanced_limit is not None and selected_count >= config.balanced_limit:
            break
    connection.commit()
    return selected_count


def _query_counts(
    connection: sqlite3.Connection,
    deck_id: str,
    column: str,
    *,
    selected: bool = False,
) -> dict[str, int]:
    allowed = {
        "difficulty",
        "variation",
        "provenance",
        "primary_theme",
        "matched_root",
    }
    if column not in allowed:
        raise ValueError(column)
    if selected:
        sql = f"""
            SELECT r.{column}, COUNT(*)
            FROM records r
            JOIN selected s ON s.deck_id=r.deck_id AND s.id=r.id
            WHERE r.deck_id=?
            GROUP BY r.{column}
            ORDER BY r.{column}
        """
    else:
        sql = f"""
            SELECT {column}, COUNT(*)
            FROM records
            WHERE deck_id=?
            GROUP BY {column}
            ORDER BY {column}
        """
    return {
        str(name): int(count)
        for name, count in connection.execute(sql, (deck_id,))
    }


def _theme_counts(
    connection: sqlite3.Connection, deck_id: str, *, selected: bool = False
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    if selected:
        query = """
            SELECT r.json FROM records r
            JOIN selected s ON s.deck_id=r.deck_id AND s.id=r.id
            WHERE r.deck_id=?
        """
    else:
        query = "SELECT json FROM records WHERE deck_id=?"
    for (raw_json,) in connection.execute(query, (deck_id,)):
        counts.update(json.loads(raw_json).get("themes", []))
    return dict(sorted(counts.items()))


def _variation_metadata(
    connection: sqlite3.Connection, deck_id: str
) -> list[dict[str, Any]]:
    balanced = _query_counts(connection, deck_id, "variation", selected=True)
    rows = list(
        connection.execute(
            """
            SELECT variation, variation_tag, variation_slug, matched_root, COUNT(*)
            FROM records
            WHERE deck_id=?
            GROUP BY variation, variation_tag, variation_slug, matched_root
            ORDER BY variation, variation_tag
            """,
            (deck_id,),
        )
    )
    used_slugs: dict[str, str] = {}
    variations: list[dict[str, Any]] = []
    for variation, tag, base_slug, matched_root, count in rows:
        slug = base_slug
        if slug in used_slugs and used_slugs[slug] != tag:
            suffix = hashlib.sha256(tag.encode("utf-8")).hexdigest()[:8]
            slug = f"{slug}-{suffix}"
        used_slugs[slug] = tag
        variations.append(
            {
                "name": variation,
                "tag": tag,
                "matchedTagRoot": matched_root,
                "slug": slug,
                "count": int(count),
                "balancedCount": balanced.get(variation, 0),
            }
        )
    return variations


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


def _write_chunks(
    connection: sqlite3.Connection,
    deck_id: str,
    staging: Path,
    chunk_size: int,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    chunk_number = 0
    chunk_stream: TextIO | None = None
    chunk_count = 0
    try:
        selected_rows = connection.execute(
            """
            SELECT r.json FROM selected s
            JOIN records r ON r.deck_id=s.deck_id AND r.id=s.id
            WHERE s.deck_id=?
            ORDER BY s.selection_order
            """,
            (deck_id,),
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
            if chunk_count >= chunk_size:
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
    return chunks


def _dataset_name(deck: OpeningPuzzleDeck) -> str:
    if deck.id == DEFAULT_OPENING_PUZZLE_DECK_ID:
        return "Caro-Kann Puzzles for Black"
    return f"{deck.opening_family} puzzles for {deck.solver_color.title()}"


def _write_deck_outputs(
    connection: sqlite3.Connection,
    config: MultiExtractionConfig,
    deck: OpeningPuzzleDeck,
    stats: DeckExtractionStats,
    balanced_count: int,
    scan_metadata: ScanMetadata,
    generated_at: str,
) -> dict[str, Any]:
    assert config.output_root is not None
    output = config.output_root / deck.id
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-build-", dir=output.parent))
    try:
        all_count = _write_jsonl(
            staging / "all.jsonl",
            connection.execute(
                "SELECT json FROM records WHERE deck_id=? ORDER BY sequence,id",
                (deck.id,),
            ),
        )
        written_balanced = _write_jsonl(
            staging / "balanced.jsonl",
            connection.execute(
                """
                SELECT r.json FROM selected s
                JOIN records r ON r.deck_id=s.deck_id AND r.id=s.id
                WHERE s.deck_id=? ORDER BY s.selection_order
                """,
                (deck.id,),
            ),
        )
        if all_count != stats.valid_rows or written_balanced != balanced_count:
            raise RuntimeError(f"Output count mismatch for {deck.id}")

        for difficulty in DIFFICULTIES:
            _write_jsonl(
                staging / "by-difficulty" / f"{difficulty}.jsonl",
                connection.execute(
                    """
                    SELECT json FROM records
                    WHERE deck_id=? AND difficulty=? ORDER BY sequence,id
                    """,
                    (deck.id, difficulty),
                ),
            )

        variations = _variation_metadata(connection, deck.id)
        for variation in variations:
            _write_jsonl(
                staging / "by-variation" / f"{variation['slug']}.jsonl",
                connection.execute(
                    """
                    SELECT json FROM records
                    WHERE deck_id=? AND variation_tag=? ORDER BY sequence,id
                    """,
                    (deck.id, variation["tag"]),
                ),
            )

        for provenance, filename in PROVENANCE_FILES.items():
            _write_jsonl(
                staging / "by-source" / filename,
                connection.execute(
                    """
                    SELECT json FROM records
                    WHERE deck_id=? AND provenance=? ORDER BY sequence,id
                    """,
                    (deck.id, provenance),
                ),
            )

        chunks = _write_chunks(connection, deck.id, staging, config.chunk_size)
        counts = stats.count_dict(balanced_exported=balanced_count)
        quality_eligible = int(
            connection.execute(
                """
                SELECT COUNT(*) FROM records
                WHERE deck_id=? AND quality_eligible=1
                """,
                (deck.id,),
            ).fetchone()[0]
        )
        difficulty_counts = _query_counts(connection, deck.id, "difficulty")
        variation_counts = _query_counts(connection, deck.id, "variation")
        matched_root_counts = _query_counts(connection, deck.id, "matched_root")
        provenance_counts = _query_counts(connection, deck.id, "provenance")
        theme_counts = _theme_counts(connection, deck.id)
        balanced_counts = {
            "difficulty": _query_counts(
                connection, deck.id, "difficulty", selected=True
            ),
            "variation": _query_counts(
                connection, deck.id, "variation", selected=True
            ),
            "provenance": _query_counts(
                connection, deck.id, "provenance", selected=True
            ),
            "theme": _theme_counts(connection, deck.id, selected=True),
            "primaryTacticalTheme": _query_counts(
                connection, deck.id, "primary_theme", selected=True
            ),
        }
        quality_filter = {
            "minPopularity": config.min_popularity,
            "minPlays": config.min_plays,
            "maxRatingDeviation": config.max_rating_deviation,
        }
        quality_filters = {**quality_filter, "qualityEligible": quality_eligible}
        dataset_name = _dataset_name(deck)
        manifest: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "deckId": deck.id,
            "dataset": dataset_name,
            "datasetName": dataset_name,
            "displayName": deck.display_name,
            "openingFamily": deck.opening_family,
            "solverColor": deck.solver_color,
            "orientation": deck.orientation,
            "openingTagRoots": list(deck.opening_tag_roots),
            "openingPrefix": deck.opening_tag_roots[0],
            "source": {
                "name": "Lichess Open Database: Puzzles",
                "url": LICHESS_SOURCE_URL,
                "exportUrl": LICHESS_EXPORT_URL,
            },
            "license": "CC0",
            "generatedAt": generated_at,
            "generatedAtUtc": generated_at,
            "inputFile": (
                "-" if config.input_path == "-" else Path(config.input_path).name
            ),
            "inputFilename": (
                "-" if config.input_path == "-" else Path(config.input_path).name
            ),
            **scan_metadata.to_dict(),
            "counts": counts,
            "difficultyCounts": difficulty_counts,
            "variationCounts": variation_counts,
            "matchedRootCounts": matched_root_counts,
            "provenanceCounts": provenance_counts,
            "themeCounts": theme_counts,
            "balancedCounts": balanced_counts,
            "qualityFilter": quality_filter,
            "qualityFilters": quality_filters,
            "variations": variations,
            "chunks": chunks,
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
            "deckId": deck.id,
            "rowsScanned": stats.rows_scanned,
            "totalRejected": stats.invalid_rows,
            **scan_metadata.to_dict(),
            "counts": {
                code: int(stats.rejection_counts.get(code, 0))
                for code in REJECTION_CODES
            },
        }
        _write_json(staging / "manifest.json", manifest)
        _write_json(staging / "rejections-summary.json", rejections_summary)

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


def _existing_deck_output_is_catalog_ready(
    output_root: Path, deck: OpeningPuzzleDeck
) -> bool:
    """Return whether an unselected schema-v2 output is safe to preserve."""

    manifest_path = output_root / validate_catalog_manifest_path(deck.manifest_path)
    output_root_resolved = output_root.resolve()
    deck_root = (output_root_resolved / deck.id).resolve()
    if deck_root.parent != output_root_resolved:
        return False
    try:
        if manifest_path.resolve() != deck_root / "manifest.json":
            return False
    except OSError:
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(manifest, dict):
        return False
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("deckId") != deck.id
        or manifest.get("openingFamily") != deck.opening_family
        or manifest.get("solverColor") != deck.solver_color
        or manifest.get("orientation") != deck.orientation
        or manifest.get("openingTagRoots") != list(deck.opening_tag_roots)
    ):
        return False
    chunks = manifest.get("chunks")
    counts = manifest.get("counts")
    if not isinstance(chunks, list) or not isinstance(counts, dict):
        return False
    balanced_count = counts.get("balancedExported")
    if (
        isinstance(balanced_count, bool)
        or not isinstance(balanced_count, int)
        or balanced_count < 0
    ):
        return False
    counted = 0
    for chunk in chunks:
        if not isinstance(chunk, dict):
            return False
        raw_path = chunk.get("path")
        count = chunk.get("count")
        if (
            not isinstance(raw_path, str)
            or isinstance(count, bool)
            or not isinstance(count, int)
            or count < 1
            or "\\" in raw_path
        ):
            return False
        path = PurePosixPath(raw_path)
        if (
            path.is_absolute()
            or path.as_posix() != raw_path
            or any(part in {"", ".", ".."} for part in path.parts)
            or len(path.parts) != 2
            or path.parts[0] != "chunks"
            or path.suffix != ".json"
        ):
            return False
        candidate = (manifest_path.parent / path.as_posix()).resolve()
        try:
            candidate.relative_to(deck_root)
        except ValueError:
            return False
        if not candidate.is_file():
            return False
        try:
            records = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return False
        if not isinstance(records, list) or len(records) != count:
            return False
        counted += count
    return counted == balanced_count


def _write_catalog(
    output_root: Path, deck_ids: tuple[str, ...]
) -> dict[str, object]:
    included = set(deck_ids)
    for deck_id in OPENING_PUZZLE_DECK_ORDER:
        if deck_id in included:
            continue
        deck = OPENING_PUZZLE_DECKS[deck_id]
        if _existing_deck_output_is_catalog_ready(output_root, deck):
            included.add(deck_id)
    catalog_deck_ids = tuple(
        deck_id for deck_id in OPENING_PUZZLE_DECK_ORDER if deck_id in included
    )
    catalog = opening_puzzle_catalog(catalog_deck_ids)
    for entry in catalog["decks"]:  # type: ignore[index]
        validate_catalog_manifest_path(entry["manifestPath"])  # type: ignore[index]
    output_root.mkdir(parents=True, exist_ok=True)
    target = output_root / CATALOG_FILENAME
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{CATALOG_FILENAME}.", suffix=".tmp", dir=output_root
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        _write_json(temporary, catalog)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return catalog


def _validate_config(config: MultiExtractionConfig) -> None:
    if not config.deck_ids:
        raise ValueError("At least one deck must be selected")
    unknown = sorted(set(config.deck_ids) - set(OPENING_PUZZLE_DECKS))
    if unknown:
        raise ValueError(f"Unknown deck ID(s): {', '.join(unknown)}")
    if len(set(config.deck_ids)) != len(config.deck_ids):
        raise ValueError("Deck IDs must not be repeated")
    if not config.validate_only and config.output_root is None:
        raise ValueError("An output root is required unless --validate-only is used")
    if config.progress_every < 0:
        raise ValueError("progress_every must be zero or greater")
    if config.scan_limit is not None and not config.validate_only:
        assert config.output_root is not None
        if config.output_root.resolve() == DEFAULT_OUTPUT_ROOT.resolve():
            raise ValueError(
                "--scan-limit cannot target canonical public/data; "
                "use --output-root with a development directory"
            )
    if config.debug_rejections is not None and config.output_root is not None:
        debug = config.debug_rejections.resolve()
        if debug == (config.output_root / CATALOG_FILENAME).resolve():
            raise ValueError("--debug-rejections collides with the generated catalog")
        for deck_id in config.deck_ids:
            try:
                debug.relative_to((config.output_root / deck_id).resolve())
            except ValueError:
                continue
            raise ValueError(
                "--debug-rejections cannot be placed inside a generated deck directory"
            )


def extract_opening_puzzles(config: MultiExtractionConfig) -> dict[str, Any]:
    """Extract all selected decks in one streamed/decompressed input pass."""

    _validate_config(config)
    input_kind, input_byte_size, input_sha256 = _input_file_identity(config.input_path)
    with tempfile.TemporaryDirectory(prefix="opening-puzzles-extractor-") as temp_dir:
        connection = _create_database(Path(temp_dir) / "staging.sqlite3")
        try:
            stats_by_deck, truncated = _scan_input(connection, config)
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
                CREATE INDEX records_deck_sequence_idx
                    ON records(deck_id, sequence, id);
                CREATE INDEX records_deck_variation_idx
                    ON records(deck_id, variation_tag, sequence);
                CREATE INDEX records_deck_difficulty_idx
                    ON records(deck_id, difficulty, sequence);
                CREATE INDEX records_deck_provenance_idx
                    ON records(deck_id, provenance, sequence);
                CREATE INDEX records_deck_quality_cell_idx
                    ON records(
                        deck_id, quality_eligible, balance_cell, sample_rank, id
                    );
                """
            )
            balanced_counts = {
                deck_id: _select_balanced(connection, config, deck_id)
                for deck_id in config.deck_ids
            }
            if config.validate_only:
                return {
                    "valid": True,
                    **scan_metadata.to_dict(),
                    "decks": {
                        deck_id: {
                            "counts": stats.count_dict(
                                balanced_exported=balanced_counts[deck_id]
                            ),
                            "rejections": {
                                code: int(stats.rejection_counts.get(code, 0))
                                for code in REJECTION_CODES
                            },
                            "qualityEligible": int(
                                connection.execute(
                                    """
                                    SELECT COUNT(*) FROM records
                                    WHERE deck_id=? AND quality_eligible=1
                                    """,
                                    (deck_id,),
                                ).fetchone()[0]
                            ),
                        }
                        for deck_id, stats in stats_by_deck.items()
                    },
                }

            assert config.output_root is not None
            generated_at = datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
            manifests = {
                deck_id: _write_deck_outputs(
                    connection,
                    config,
                    OPENING_PUZZLE_DECKS[deck_id],
                    stats_by_deck[deck_id],
                    balanced_counts[deck_id],
                    scan_metadata,
                    generated_at,
                )
                for deck_id in config.deck_ids
            }
            catalog = _write_catalog(config.output_root, config.deck_ids)
            return {"catalog": catalog, "manifests": manifests}
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


def _resolve_deck_arguments(values: Sequence[str] | None) -> tuple[str, ...]:
    if not values or values == ["all"]:
        return OPENING_PUZZLE_DECK_ORDER
    if "all" in values:
        raise ValueError("--deck all cannot be combined with individual deck IDs")
    unknown = sorted(set(values) - set(OPENING_PUZZLE_DECKS))
    if unknown:
        raise ValueError(f"Unknown deck ID(s): {', '.join(unknown)}")
    if len(set(values)) != len(values):
        raise ValueError("A --deck value may not be repeated")
    selected = set(values)
    return tuple(deck_id for deck_id in OPENING_PUZZLE_DECK_ORDER if deck_id in selected)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        required=True,
        help="Official .csv.zst, uncompressed .csv, or - for uncompressed stdin",
    )
    parser.add_argument(
        "--deck",
        action="append",
        choices=("all", *OPENING_PUZZLE_DECK_ORDER),
        help="Deck to extract; repeat for several or use all (default: all)",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Root containing deck directories and the catalog",
    )
    parser.add_argument(
        "--balanced-limit",
        type=_optional_limit,
        default=DEFAULT_BALANCED_LIMIT,
        metavar="N|none",
    )
    parser.add_argument(
        "--no-balanced-limit",
        action="store_const",
        const=None,
        dest="balanced_limit",
    )
    parser.add_argument(
        "--max-per-variation",
        type=_optional_limit,
        default=DEFAULT_MAX_PER_VARIATION,
        metavar="N|none",
    )
    parser.add_argument("--min-popularity", type=int, default=0)
    parser.add_argument("--min-plays", type=int, default=20)
    parser.add_argument("--max-rating-deviation", type=int, default=150)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--scan-limit", type=_positive_int)
    parser.add_argument("--chunk-size", type=_positive_int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument("--progress-every", type=int, default=100_000)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--debug-rejections", type=Path, metavar="PATH")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        deck_ids = _resolve_deck_arguments(args.deck)
        config = MultiExtractionConfig(
            input_path=args.input,
            deck_ids=deck_ids,
            output_root=None if args.validate_only else args.output_root,
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
        result = extract_opening_puzzles(config)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
