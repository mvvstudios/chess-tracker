"""Derive personal error-puzzle candidates from imported game analysis.

The dashboard has two distinct kinds of puzzle data:

* a :class:`PuzzleCandidate`, derived from an imported Chess.com game and the
  existing Stockfish move-quality cache; and
* browser-local progress, which is intentionally not represented here.

This module is the trust boundary between cached engine output and the puzzle
UI.  It never trusts a cached FEN or move blindly: the PGN is replayed with
``python-chess``, the user-to-move relationship is checked, and both the played
move and proposed solution are validated against the reconstructed position.

Public API
----------

``build_puzzle_queue(games, analysis_cache, username)`` returns a JSON-ready
dictionary with ``candidates``, aggregate ``coverage``, and per-item ``errors``.
``derive_puzzle_candidates`` is a convenience wrapper returning candidates
only.  Candidate order is stable: evaluation loss descending, game timestamp
descending, then ply ascending.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from hashlib import sha256
from io import StringIO
from typing import Any, Iterable

import chess
import chess.pgn

from chess_tracker.blunder_repertoire import classify_blunder_repertoire
from chess_tracker.pgn import _clean_opening_label


ColorName = str
MAX_DIAGNOSTIC_ERRORS = 50


@dataclass(frozen=True)
class PuzzleCandidate:
    """A validated puzzle position derived from one personal move-quality error."""

    puzzle_id: str
    game_id: str
    game_uuid: str | None
    game_url: str | None
    username: str
    user_color: ColorName
    quality_label: str
    orientation: ColorName
    side_to_move: ColorName
    ply: int
    fullmove: int
    move_label: str
    fen_before: str
    played_move_uci: str
    played_move_san: str
    best_move_uci: str
    best_move_san: str
    post_best_fen: str
    legal_moves_uci: list[str]
    legal_dests: dict[str, list[str]]
    promotion_options: dict[str, list[str]]
    cp_before: int | None
    cp_after: int | None
    cp_loss: int | None
    wp_loss: float | None
    principal_variation_uci: list[str]
    principal_variation_san: list[str]
    solution_steps: list[dict[str, Any]]
    opponent_name: str | None
    game_date: str | None
    end_time: int | None
    opening: str | None
    repertoire_deck_id: str | None
    categories: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def stable_puzzle_id(username: str, game_id: str, ply: int) -> str:
    """Return a deterministic, opaque identity for ``user + game + ply``."""

    identity = f"{_normalise_username(username)}\x1f{game_id}\x1f{int(ply)}"
    return "puzzle-" + sha256(identity.encode("utf-8")).hexdigest()[:24]


def _quality_evidence_groups(
    summary: dict[str, Any] | None,
) -> list[tuple[str, list[Any]]]:
    if not isinstance(summary, dict):
        return []
    groups: list[tuple[str, list[Any]]] = []
    for quality_label, key in (
        ("blunder", "blunder_evidence"),
        ("mistake", "mistake_evidence"),
    ):
        evidence = summary.get(key)
        if isinstance(evidence, list):
            groups.append((quality_label, evidence))
    return groups


def build_puzzle_queue(
    games: Iterable[dict[str, Any]],
    analysis_cache: dict[str, Any] | None,
    username: str,
) -> dict[str, Any]:
    """Build validated personal-error candidates and coverage diagnostics.

    ``games`` are raw Chess.com game dictionaries. ``analysis_cache`` is the
    URL-keyed cache written by :func:`chess_tracker.analysis.save_quality_cache`.
    A malformed game or bad evidence item is recorded in ``errors`` and skipped;
    it never prevents valid games from producing candidates.
    """

    raw_games = list(games)
    cache = analysis_cache or {}
    errors: list[dict[str, Any]] = []
    coverage: dict[str, int] = {
        "games_seen": len(raw_games),
        "unique_games": 0,
        "duplicate_games": 0,
        "games_for_user": 0,
        "games_not_for_user": 0,
        "games_ineligible": 0,
        "games_analyzed": 0,
        "games_missing_analysis": 0,
        "games_with_blunders": 0,
        "games_with_mistakes": 0,
        "blunders_seen": 0,
        "mistakes_seen": 0,
        "eligible_candidates": 0,
        "duplicate_candidates": 0,
        "incomplete_blunders": 0,
        "incomplete_mistakes": 0,
        "malformed_games": 0,
        "pv_truncated": 0,
    }

    unique_games: dict[str, dict[str, Any]] = {}
    for raw_game in raw_games:
        if not isinstance(raw_game, dict):
            coverage["malformed_games"] += 1
            _add_error(errors, "invalid_game", "Imported game is not an object.")
            continue
        game_id = _game_id(raw_game)
        if game_id is None:
            coverage["malformed_games"] += 1
            _add_error(
                errors,
                "missing_game_id",
                "Imported game has neither a URL nor UUID.",
            )
            continue
        if game_id in unique_games:
            coverage["duplicate_games"] += 1
            # Prefer the richer duplicate so a truncated cached copy does not
            # hide an otherwise usable game.
            if _game_richness(raw_game) > _game_richness(unique_games[game_id]):
                unique_games[game_id] = raw_game
            continue
        unique_games[game_id] = raw_game

    coverage["unique_games"] = len(unique_games)
    target_username = _normalise_username(username)
    candidates: list[PuzzleCandidate] = []
    seen_candidate_ids: set[str] = set()

    for game_id, raw_game in unique_games.items():
        game_url = _optional_string(raw_game.get("url"))
        game_uuid = _optional_string(raw_game.get("uuid"))
        user_color = _user_color(raw_game, target_username)
        if user_color is None:
            coverage["games_not_for_user"] += 1
            continue
        # The refresh pipeline normally applies this filter before calling us,
        # but keep the domain boundary safe when it is used independently.
        if raw_game.get("rated") is False or (
            raw_game.get("rules") is not None and raw_game.get("rules") != "chess"
        ):
            coverage["games_ineligible"] += 1
            continue
        coverage["games_for_user"] += 1

        entry = _analysis_entry(cache, raw_game)
        summary = _summary_from_entry(entry)
        evidence_groups = _quality_evidence_groups(summary)
        if not evidence_groups:
            coverage["games_missing_analysis"] += 1
            continue
        coverage["games_analyzed"] += 1

        summary_side = summary.get("side")
        if summary_side is not None and summary_side != user_color:
            for quality_label, evidence in evidence_groups:
                coverage[f"incomplete_{quality_label}s"] += len(evidence)
            _add_error(
                errors,
                "analysis_side_mismatch",
                "Cached analysis side does not match the imported user's color.",
                game_id=game_id,
                game_url=game_url,
            )
            continue

        pgn_text = raw_game.get("pgn")
        if not isinstance(pgn_text, str) or not pgn_text.strip():
            coverage["malformed_games"] += 1
            _add_error(
                errors,
                "missing_pgn",
                "Imported game has no PGN to reconstruct the puzzle position.",
                game_id=game_id,
                game_url=game_url,
            )
            continue

        parsed_game, parse_error = _parse_pgn(pgn_text)
        if parsed_game is None:
            coverage["malformed_games"] += 1
            _add_error(
                errors,
                "malformed_pgn",
                parse_error or "PGN could not be parsed.",
                game_id=game_id,
                game_url=game_url,
            )
            continue

        positions, replay_error = _positions_by_ply(parsed_game)
        if replay_error is not None:
            coverage["malformed_games"] += 1
            _add_error(
                errors,
                "malformed_pgn",
                replay_error,
                game_id=game_id,
                game_url=game_url,
            )
            continue

        repertoire_deck_id = classify_blunder_repertoire(
            raw_game,
            user_color,
            parsed_game=parsed_game,
        )

        for quality_label, evidence in evidence_groups:
            if evidence:
                coverage[f"games_with_{quality_label}s"] += 1
            for raw_blunder in evidence:
                coverage[f"{quality_label}s_seen"] += 1
                candidate, issue, pv_was_truncated = _candidate_from_evidence(
                    raw_blunder=raw_blunder,
                    quality_label=quality_label,
                    positions=positions,
                    parsed_game=parsed_game,
                    raw_game=raw_game,
                    username=username,
                    user_color=user_color,
                    game_id=game_id,
                    game_uuid=game_uuid,
                    game_url=game_url,
                    repertoire_deck_id=repertoire_deck_id,
                )
                if pv_was_truncated:
                    coverage["pv_truncated"] += 1
                if issue is not None:
                    coverage[f"incomplete_{quality_label}s"] += 1
                    _add_error(
                        errors,
                        issue[0],
                        issue[1],
                        game_id=game_id,
                        game_url=game_url,
                        ply=_safe_ply(raw_blunder),
                    )
                    continue
                assert candidate is not None
                if candidate.puzzle_id in seen_candidate_ids:
                    coverage["duplicate_candidates"] += 1
                    continue
                seen_candidate_ids.add(candidate.puzzle_id)
                candidates.append(candidate)

    candidates.sort(
        key=lambda candidate: (
            -(candidate.cp_loss if candidate.cp_loss is not None else -1),
            -(candidate.end_time if candidate.end_time is not None else -1),
            candidate.ply,
            candidate.puzzle_id,
        )
    )
    coverage["eligible_candidates"] = len(candidates)
    coverage["eligible_blunder_candidates"] = sum(
        candidate.quality_label == "blunder" for candidate in candidates
    )
    coverage["eligible_mistake_candidates"] = sum(
        candidate.quality_label == "mistake" for candidate in candidates
    )
    # Concise aliases consumed by the page's empty/loading-state logic. Keep the
    # detailed counters above for diagnostics and backward-compatible tests.
    coverage.update({
        "imported_games": coverage["games_for_user"],
        "analyzed_games": coverage["games_analyzed"],
        "analysis_pending_games": coverage["games_missing_analysis"],
        "blunders_found": coverage["blunders_seen"],
        "mistakes_found": coverage["mistakes_seen"],
        "eligible_puzzles": coverage["eligible_candidates"],
        "incomplete_puzzles": (
            coverage["incomplete_blunders"] + coverage["incomplete_mistakes"]
        ),
    })
    return {
        "candidates": [candidate.to_dict() for candidate in candidates],
        "coverage": coverage,
        "errors": errors,
    }


def derive_puzzle_candidates(
    games: Iterable[dict[str, Any]],
    analysis_cache: dict[str, Any] | None,
    username: str,
) -> list[dict[str, Any]]:
    """Convenience wrapper returning only validated candidate dictionaries."""

    return build_puzzle_queue(games, analysis_cache, username)["candidates"]


def _candidate_from_evidence(
    *,
    raw_blunder: Any,
    quality_label: str,
    positions: dict[int, tuple[chess.Board, chess.Move]],
    parsed_game: chess.pgn.Game,
    raw_game: dict[str, Any],
    username: str,
    user_color: ColorName,
    game_id: str,
    game_uuid: str | None,
    game_url: str | None,
    repertoire_deck_id: str | None,
) -> tuple[PuzzleCandidate | None, tuple[str, str] | None, bool]:
    if not isinstance(raw_blunder, dict):
        return None, ("invalid_blunder", "Blunder evidence is not an object."), False
    raw_quality_label = str(raw_blunder.get("quality_label") or quality_label).strip().lower()
    if raw_quality_label != quality_label or quality_label not in {"blunder", "mistake"}:
        return None, (
            "invalid_quality_label",
            "Move-quality evidence has an invalid or mismatched severity.",
        ), False

    ply = _safe_ply(raw_blunder)
    if ply is None:
        return None, ("invalid_ply", "Blunder evidence has no non-negative integer ply."), False
    position = positions.get(ply)
    if position is None:
        return None, ("ply_out_of_range", "Blunder ply is not present in the PGN mainline."), False
    board, played_move = position

    expected_turn = chess.WHITE if user_color == "white" else chess.BLACK
    if board.turn != expected_turn:
        return None, (
            "opponent_move",
            "Blunder ply belongs to the opponent, not the configured user.",
        ), False
    evidence_side = raw_blunder.get("side")
    if evidence_side is not None and evidence_side != user_color:
        return None, (
            "analysis_side_mismatch",
            "Blunder evidence side does not match the configured user's color.",
        ), False

    cached_fen = raw_blunder.get("fen_before")
    if cached_fen:
        try:
            cached_board = chess.Board(str(cached_fen))
        except ValueError:
            return None, ("invalid_cached_fen", "Cached pre-blunder FEN is invalid."), False
        if cached_board.fen() != board.fen():
            return None, (
                "fen_mismatch",
                "Cached pre-blunder FEN does not match the reconstructed PGN position.",
            ), False

    played_uci = played_move.uci()
    cached_played = raw_blunder.get("played_move_uci")
    if cached_played:
        normalised_played = _normalise_uci(cached_played)
        if normalised_played is None or normalised_played != played_uci:
            return None, (
                "played_move_mismatch",
                "Cached played move does not match the PGN mainline at this ply.",
            ), False

    raw_pv = _raw_pv_uci(raw_blunder)
    best_uci = _normalise_uci(raw_blunder.get("best_move_uci"))
    if best_uci is None and raw_pv:
        best_uci = _normalise_uci(raw_pv[0])
    if best_uci is None:
        return None, ("missing_best_move", "Blunder has no normalized engine best move."), False

    try:
        best_move = chess.Move.from_uci(best_uci)
    except ValueError:
        return None, ("invalid_best_move", "Engine best move is not valid UCI."), False
    if best_move not in board.legal_moves:
        return None, (
            "illegal_best_move",
            "Engine best move is illegal in the reconstructed position.",
        ), False
    if best_move == played_move:
        return None, (
            "best_equals_played",
            "Engine best move is the same move that was played.",
        ), False

    if raw_pv:
        pv_first = _normalise_uci(raw_pv[0])
        if pv_first is None or pv_first != best_uci:
            return None, (
                "pv_best_move_mismatch",
                "The stored principal variation does not begin with the best move.",
            ), False
    else:
        raw_pv = [best_uci]

    pv_uci, pv_san, pv_was_truncated = _validated_pv(board, raw_pv)
    if not pv_uci:
        # This is defensive; best_move legality above guarantees one move.
        return None, ("invalid_principal_variation", "Principal variation is unusable."), False

    solution_steps = _build_solution_steps(board, pv_uci)
    first_post = board.copy(stack=False)
    first_post.push(best_move)
    if not first_post.is_game_over() and len(solution_steps) < 2:
        return None, (
            "incomplete_principal_variation",
            "A non-terminal puzzle requires a legal three-ply principal variation.",
        ), pv_was_truncated

    legal_moves = sorted(board.legal_moves, key=lambda move: move.uci())
    legal_moves_uci = [move.uci() for move in legal_moves]
    legal_dests = _legal_dests(legal_moves)
    promotion_options = _promotion_options(legal_moves)
    played_san = board.san(played_move)
    best_san = board.san(best_move)
    post_best = board.copy(stack=False)
    post_best.push(best_move)

    fullmove = board.fullmove_number
    end_time = _optional_int(raw_game.get("end_time"))
    return PuzzleCandidate(
        puzzle_id=stable_puzzle_id(username, game_id, ply),
        game_id=game_id,
        game_uuid=game_uuid,
        game_url=game_url,
        username=username,
        user_color=user_color,
        quality_label=quality_label,
        orientation=user_color,
        side_to_move="white" if board.turn == chess.WHITE else "black",
        ply=ply,
        fullmove=fullmove,
        move_label=f"{fullmove}{'...' if user_color == 'black' else '.'}",
        fen_before=board.fen(),
        played_move_uci=played_uci,
        played_move_san=played_san,
        best_move_uci=best_uci,
        best_move_san=best_san,
        post_best_fen=post_best.fen(),
        legal_moves_uci=legal_moves_uci,
        legal_dests=legal_dests,
        promotion_options=promotion_options,
        cp_before=_optional_int(raw_blunder.get("cp_before")),
        cp_after=_optional_int(raw_blunder.get("cp_after")),
        cp_loss=_optional_int(raw_blunder.get("cp_loss")),
        wp_loss=_optional_float(raw_blunder.get("wp_loss")),
        principal_variation_uci=pv_uci,
        principal_variation_san=pv_san,
        solution_steps=solution_steps,
        opponent_name=_opponent_name(raw_game, user_color),
        game_date=_game_date(raw_game, parsed_game),
        end_time=end_time,
        opening=_opening_name(raw_game, parsed_game),
        repertoire_deck_id=repertoire_deck_id,
        categories=_string_list(raw_blunder.get("categories")),
    ), None, pv_was_truncated


def _parse_pgn(pgn_text: str) -> tuple[chess.pgn.Game | None, str | None]:
    try:
        game = chess.pgn.read_game(StringIO(pgn_text))
    except Exception as exc:
        # PGN is imported, untrusted data. Isolating parser failures here is
        # what lets one malformed archive entry coexist with valid puzzles.
        return None, f"PGN parse failed: {exc}"
    if game is None:
        return None, "PGN contains no game."
    parser_errors = getattr(game, "errors", [])
    if parser_errors:
        return None, f"PGN contains an illegal or malformed move: {parser_errors[0]}"
    return game, None


def _positions_by_ply(
    game: chess.pgn.Game,
) -> tuple[dict[int, tuple[chess.Board, chess.Move]], str | None]:
    board = game.board()
    positions: dict[int, tuple[chess.Board, chess.Move]] = {}
    try:
        for move in game.mainline_moves():
            if move not in board.legal_moves:
                return {}, f"PGN mainline contains illegal move {move.uci()}."
            positions[board.ply()] = (board.copy(stack=False), move)
            board.push(move)
    except (AssertionError, ValueError) as exc:
        return {}, f"PGN replay failed: {exc}"
    return positions, None


def _validated_pv(
    starting_board: chess.Board,
    raw_pv: list[str],
) -> tuple[list[str], list[str], bool]:
    board = starting_board.copy(stack=False)
    uci_line: list[str] = []
    san_line: list[str] = []
    truncated = False
    for raw_move in raw_pv:
        uci = _normalise_uci(raw_move)
        if uci is None:
            truncated = True
            break
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            truncated = True
            break
        if move not in board.legal_moves:
            truncated = True
            break
        san_line.append(board.san(move))
        uci_line.append(move.uci())
        board.push(move)
    return uci_line, san_line, truncated


def _build_solution_steps(
    starting_board: chess.Board,
    pv_uci: list[str],
) -> list[dict[str, Any]]:
    """Turn a legal PV into one or two user-decision mini-candidates.

    The user plays PV plies 0 and 2. PV ply 1 is automatically played as the
    opponent response. A first move that ends the game is a complete one-step
    puzzle; every other puzzle needs all three plies so the second decision has
    a defined answer.
    """

    if not pv_uci:
        return []
    board = starting_board.copy(stack=False)
    first_move = chess.Move.from_uci(pv_uci[0])
    after_first = board.copy(stack=False)
    after_first.push(first_move)
    if after_first.is_game_over():
        return [_solution_step(board, first_move)]
    if len(pv_uci) < 3:
        return []

    opponent_reply = chess.Move.from_uci(pv_uci[1])
    first_step = _solution_step(board, first_move, opponent_reply)

    second_board = after_first.copy(stack=False)
    second_board.push(opponent_reply)
    second_move = chess.Move.from_uci(pv_uci[2])
    # The second user decision finishes this first version of the exercise.
    # Later PV plies remain available in principal_variation_* for revealed
    # review, but are not part of the interactive sequence.
    second_step = _solution_step(second_board, second_move)
    return [first_step, second_step]


def _solution_step(
    board: chess.Board,
    best_move: chess.Move,
    opponent_reply: chess.Move | None = None,
) -> dict[str, Any]:
    """Return the UI-ready fields for one user decision in the solution."""

    legal_moves = sorted(board.legal_moves, key=lambda move: move.uci())
    best_san = board.san(best_move)
    after_best = board.copy(stack=False)
    after_best.push(best_move)

    reply_uci: str | None = None
    reply_san: str | None = None
    post_reply_fen: str | None = None
    if opponent_reply is not None:
        reply_uci = opponent_reply.uci()
        reply_san = after_best.san(opponent_reply)
        after_reply = after_best.copy(stack=False)
        after_reply.push(opponent_reply)
        post_reply_fen = after_reply.fen()

    return {
        "fen_before": board.fen(),
        "best_move_uci": best_move.uci(),
        "best_move_san": best_san,
        "post_best_fen": after_best.fen(),
        "legal_moves_uci": [move.uci() for move in legal_moves],
        "legal_dests": _legal_dests(legal_moves),
        "promotion_options": _promotion_options(legal_moves),
        "opponent_reply_uci": reply_uci,
        "opponent_reply_san": reply_san,
        "post_reply_fen": post_reply_fen,
    }


def _raw_pv_uci(blunder: dict[str, Any]) -> list[str]:
    for key in ("principal_variation_uci", "pv_uci", "principal_variation", "pv"):
        raw = blunder.get(key)
        if isinstance(raw, str):
            return raw.split()
        if isinstance(raw, (list, tuple)):
            return [str(move) for move in raw]
    return []


def _legal_dests(moves: list[chess.Move]) -> dict[str, list[str]]:
    dests: dict[str, set[str]] = {}
    for move in moves:
        origin = chess.square_name(move.from_square)
        destination = chess.square_name(move.to_square)
        dests.setdefault(origin, set()).add(destination)
    return {origin: sorted(destinations) for origin, destinations in sorted(dests.items())}


def _promotion_options(moves: list[chess.Move]) -> dict[str, list[str]]:
    options: dict[str, list[str]] = {}
    for move in moves:
        if move.promotion is None:
            continue
        coordinate_move = move.uci()[:4]
        options.setdefault(coordinate_move, []).append(move.uci())
    return {key: sorted(value) for key, value in sorted(options.items())}


def _analysis_entry(cache: dict[str, Any], game: dict[str, Any]) -> Any:
    for key in (_optional_string(game.get("url")), _optional_string(game.get("uuid"))):
        if key and key in cache:
            return cache[key]
    game_url = _optional_string(game.get("url"))
    if game_url:
        for entry in cache.values():
            summary = _summary_from_entry(entry)
            if summary and summary.get("game_url") == game_url:
                return entry
    return None


def _summary_from_entry(entry: Any) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    summary = entry.get("summary")
    if isinstance(summary, dict):
        return summary
    if "blunder_evidence" in entry or "mistake_evidence" in entry:
        return entry
    return None


def _game_id(game: dict[str, Any]) -> str | None:
    # URL is the established cache/join key throughout this project. UUID is a
    # fallback for fixtures or future importers that omit Chess.com's game URL.
    return _optional_string(game.get("url")) or _optional_string(game.get("uuid"))


def _game_richness(game: dict[str, Any]) -> tuple[int, int, int]:
    pgn = game.get("pgn")
    return (
        1 if isinstance(pgn, str) and pgn.strip() else 0,
        len(pgn) if isinstance(pgn, str) else 0,
        1 if game.get("uuid") else 0,
    )


def _user_color(game: dict[str, Any], target_username: str) -> ColorName | None:
    white_player = game.get("white")
    black_player = game.get("black")
    white = _normalise_username(
        white_player.get("username", "") if isinstance(white_player, dict) else ""
    )
    black = _normalise_username(
        black_player.get("username", "") if isinstance(black_player, dict) else ""
    )
    if white == target_username:
        return "white"
    if black == target_username:
        return "black"
    return None


def _opponent_name(game: dict[str, Any], user_color: ColorName) -> str | None:
    opponent = game.get("black") if user_color == "white" else game.get("white")
    if not isinstance(opponent, dict):
        return None
    return _optional_string(opponent.get("username"))


def _opening_name(game: dict[str, Any], parsed_game: chess.pgn.Game) -> str | None:
    for key in ("opening", "opening_name"):
        value = _optional_string(game.get(key))
        if value:
            return value
    header_opening = _optional_string(parsed_game.headers.get("Opening"))
    if header_opening:
        return header_opening
    eco_url = _optional_string(parsed_game.headers.get("ECOUrl"))
    if eco_url:
        slug = eco_url.rstrip("/").rsplit("/", 1)[-1]
        return _clean_opening_label(slug)
    return None


def _game_date(game: dict[str, Any], parsed_game: chess.pgn.Game) -> str | None:
    end_time = _optional_int(game.get("end_time"))
    if end_time is not None:
        try:
            return datetime.fromtimestamp(end_time, tz=timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            pass
    for key in ("UTCDate", "Date"):
        raw = _optional_string(parsed_game.headers.get(key))
        if raw and "?" not in raw:
            return raw.replace(".", "-")
    return None


def _normalise_username(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalise_uci(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    uci = value.strip().lower()
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        return None
    return move.uci()


def _safe_ply(blunder: Any) -> int | None:
    if not isinstance(blunder, dict):
        return None
    value = blunder.get("ply")
    if isinstance(value, bool):
        return None
    try:
        ply = int(value)
    except (TypeError, ValueError):
        return None
    return ply if ply >= 0 else None


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return list(dict.fromkeys(
        text
        for item in value
        if isinstance(item, str)
        if (text := _optional_string(item)) is not None
    ))


def _add_error(
    errors: list[dict[str, Any]],
    code: str,
    message: str,
    *,
    game_id: str | None = None,
    game_url: str | None = None,
    ply: int | None = None,
) -> None:
    if len(errors) >= MAX_DIAGNOSTIC_ERRORS:
        return
    errors.append({
        "code": code,
        "message": message,
        "game_id": game_id,
        "game_url": game_url,
        "ply": ply,
    })
