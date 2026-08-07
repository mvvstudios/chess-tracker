from __future__ import annotations

from io import StringIO

import chess
import chess.pgn

from chess_tracker.puzzle_queue import (
    build_puzzle_queue,
    derive_puzzle_candidates,
    stable_puzzle_id,
)


MAINLINE_PGN = (
    '[Event "Queue test"]\n'
    '[Date "2026.07.04"]\n'
    '[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening"]\n\n'
    "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *"
)


def _game(
    pgn: str = MAINLINE_PGN,
    *,
    url: str = "https://www.chess.com/game/live/123",
    uuid: str = "game-uuid-123",
    user_color: str = "white",
    username: str = "Me",
    end_time: int = 1_783_123_200,
) -> dict:
    white = {"username": username if user_color == "white" else "Opponent", "rating": 700}
    black = {"username": username if user_color == "black" else "Opponent", "rating": 700}
    return {
        "url": url,
        "uuid": uuid,
        "pgn": pgn,
        "end_time": end_time,
        "white": white,
        "black": black,
    }


def _position_at_ply(pgn: str, ply: int) -> tuple[chess.Board, chess.Move]:
    parsed = chess.pgn.read_game(StringIO(pgn))
    assert parsed is not None
    board = parsed.board()
    for move in parsed.mainline_moves():
        if board.ply() == ply:
            return board, move
        board.push(move)
    raise AssertionError(f"ply {ply} not found")


def _evidence(
    pgn: str,
    ply: int,
    best_uci: str,
    *,
    side: str,
    cp_loss: int = 500,
    **extra,
) -> dict:
    board, played = _position_at_ply(pgn, ply)
    best_move = chess.Move.from_uci(best_uci)
    pv = _default_solution_pv(board, best_move)
    return {
        "ply": ply,
        "fullmove": board.fullmove_number,
        "side": side,
        "fen_before": board.fen(),
        "played_move_uci": played.uci(),
        "played_move_san": board.san(played),
        "best_move_uci": best_uci,
        "best_move_san": board.san(best_move),
        "principal_variation_uci": pv,
        "cp_before": 100,
        "cp_after": 100 - cp_loss,
        "cp_loss": cp_loss,
        "wp_loss": 40.0,
        **extra,
    }


def _default_solution_pv(board: chess.Board, best_move: chess.Move) -> list[str]:
    """Produce a deterministic legal test PV through a second user decision."""

    line = board.copy(stack=False)
    line.push(best_move)
    pv = [best_move.uci()]
    if line.is_game_over():
        return pv
    for reply in sorted(line.legal_moves, key=lambda move: move.uci()):
        after_reply = line.copy(stack=False)
        after_reply.push(reply)
        continuations = sorted(after_reply.legal_moves, key=lambda move: move.uci())
        if continuations:
            return [*pv, reply.uci(), continuations[0].uci()]
    return pv


def _cache(
    game: dict,
    evidence: list[dict],
    *,
    side: str,
    quality_label: str = "blunder",
) -> dict:
    return {
        game["url"]: {
            "version": 4,
            "depth": 12,
            "summary": {
                "game_url": game["url"],
                "side": side,
                "moves_analyzed": 3,
                "blunder_evidence": evidence if quality_label == "blunder" else [],
                "mistake_evidence": evidence if quality_label == "mistake" else [],
            },
        }
    }


def test_only_current_users_moves_become_candidates():
    game = _game(user_color="white")
    own = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    opponent = _evidence(MAINLINE_PGN, 3, "g8f6", side="white")

    result = build_puzzle_queue([game], _cache(game, [own, opponent], side="white"), "me")

    assert [candidate["ply"] for candidate in result["candidates"]] == [4]
    assert result["coverage"]["blunders_seen"] == 2
    assert result["coverage"]["incomplete_blunders"] == 1
    assert any(error["code"] == "opponent_move" for error in result["errors"])


def test_game_not_owned_by_current_user_is_excluded():
    game = _game(username="SomeoneElse")
    evidence = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")

    result = build_puzzle_queue([game], _cache(game, [evidence], side="white"), "me")

    assert result["candidates"] == []
    assert result["coverage"]["games_not_for_user"] == 1
    assert result["coverage"]["blunders_seen"] == 0


def test_white_candidate_reconstructs_pre_blunder_fen_and_metadata():
    game = _game(user_color="white")
    evidence = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    expected_board, played = _position_at_ply(MAINLINE_PGN, 4)

    candidate = derive_puzzle_candidates([game], _cache(game, [evidence], side="white"), "ME")[0]

    assert candidate["fen_before"] == expected_board.fen()
    assert candidate["played_move_uci"] == played.uci() == "f1b5"
    assert candidate["played_move_san"] == "Bb5"
    assert candidate["best_move_uci"] == "f1c4"
    assert candidate["best_move_san"] == "Bc4"
    assert candidate["user_color"] == "white"
    assert candidate["orientation"] == "white"
    assert candidate["side_to_move"] == "white"
    assert candidate["opponent_name"] == "Opponent"
    assert candidate["opening"] == "Kings Pawn Opening"
    assert candidate["game_date"] == "2026-07-04"
    assert candidate["puzzle_id"] == stable_puzzle_id("me", game["url"], 4)


def test_black_candidate_uses_black_orientation_and_absolute_ply():
    game = _game(user_color="black")
    evidence = _evidence(MAINLINE_PGN, 1, "c7c5", side="black")

    candidate = derive_puzzle_candidates([game], _cache(game, [evidence], side="black"), "me")[0]

    assert candidate["ply"] == 1
    assert candidate["fullmove"] == 1
    assert candidate["move_label"] == "1..."
    assert candidate["played_move_uci"] == "e7e5"
    assert candidate["user_color"] == "black"
    assert candidate["orientation"] == "black"
    assert candidate["side_to_move"] == "black"


def test_candidate_copies_repertoire_classification_and_analysis_categories():
    pgn = (
        '[ECOUrl "https://www.chess.com/openings/Caro-Kann-Defense"]\n\n'
        "1. e4 c6 2. d4 d5 3. Nc3 *"
    )
    game = _game(pgn, user_color="black")
    evidence = _evidence(
        pgn,
        3,
        "g8f6",
        side="black",
        categories=["material_loss", "", "material_loss", 7],
    )

    candidate = derive_puzzle_candidates(
        [game], _cache(game, [evidence], side="black"), "me"
    )[0]

    assert candidate["repertoire_deck_id"] == "caro-kann-black"
    assert candidate["categories"] == ["material_loss"]
    assert candidate["puzzle_id"] == stable_puzzle_id("me", game["url"], 3)


def test_mistake_evidence_becomes_a_severity_scoped_drill_candidate():
    game = _game(user_color="white")
    evidence = _evidence(
        MAINLINE_PGN,
        4,
        "f1c4",
        side="white",
        quality_label="mistake",
        cp_loss=250,
    )

    result = build_puzzle_queue(
        [game],
        _cache(game, [evidence], side="white", quality_label="mistake"),
        "me",
    )

    assert result["candidates"][0]["quality_label"] == "mistake"
    assert result["coverage"]["mistakes_seen"] == 1
    assert result["coverage"]["eligible_mistake_candidates"] == 1
    assert result["coverage"]["blunders_seen"] == 0


def test_duplicate_imports_and_duplicate_evidence_do_not_duplicate_puzzles():
    game = _game()
    evidence = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    cache = _cache(game, [evidence, dict(evidence)], side="white")

    result = build_puzzle_queue([game, dict(game)], cache, "me")

    assert len(result["candidates"]) == 1
    assert result["coverage"]["duplicate_games"] == 1
    assert result["coverage"]["duplicate_candidates"] == 1


def test_missing_and_invalid_engine_moves_are_isolated():
    game = _game()
    missing = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    missing["best_move_uci"] = None
    missing["principal_variation_uci"] = []
    invalid = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    invalid["best_move_uci"] = "a1a8"
    invalid["principal_variation_uci"] = ["a1a8"]

    result = build_puzzle_queue([game], _cache(game, [missing, invalid], side="white"), "me")

    assert result["candidates"] == []
    assert result["coverage"]["incomplete_blunders"] == 2
    assert {error["code"] for error in result["errors"]} == {
        "missing_best_move",
        "illegal_best_move",
    }


def test_missing_analysis_is_reported_without_crashing():
    game = _game()

    result = build_puzzle_queue([game], {}, "me")

    assert result["candidates"] == []
    assert result["coverage"]["games_missing_analysis"] == 1
    assert result["coverage"]["analysis_pending_games"] == 1
    assert result["errors"] == []


def test_coverage_aliases_and_explicit_game_eligibility_filter():
    eligible = _game(url="eligible", uuid="eligible")
    unrated = _game(url="unrated", uuid="unrated")
    unrated["rated"] = False
    variant = _game(url="variant", uuid="variant")
    variant["rules"] = "chess960"
    evidence = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")

    result = build_puzzle_queue(
        [eligible, unrated, variant],
        _cache(eligible, [evidence], side="white"),
        "me",
    )

    coverage = result["coverage"]
    assert coverage["games_ineligible"] == 2
    assert coverage["imported_games"] == coverage["games_for_user"] == 1
    assert coverage["analyzed_games"] == coverage["games_analyzed"] == 1
    assert coverage["analysis_pending_games"] == 0
    assert coverage["blunders_found"] == coverage["blunders_seen"] == 1
    assert coverage["eligible_puzzles"] == coverage["eligible_candidates"] == 1
    assert coverage["incomplete_puzzles"] == coverage["incomplete_blunders"] == 0


def test_malformed_pgn_does_not_break_other_games():
    malformed = _game(
        "1. e4 e5 2. Bh6 *",
        url="bad",
        uuid="bad-uuid",
    )
    good = _game(url="good", uuid="good-uuid")
    good_evidence = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    cache = {
        **_cache(malformed, [], side="white"),
        **_cache(good, [good_evidence], side="white"),
    }

    result = build_puzzle_queue([malformed, good], cache, "me")

    assert [candidate["game_id"] for candidate in result["candidates"]] == ["good"]
    assert result["coverage"]["malformed_games"] == 1
    assert any(error["code"] == "malformed_pgn" for error in result["errors"])


def test_castling_is_replayed_and_validated_as_uci():
    pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *"
    game = _game(pgn)
    evidence = _evidence(pgn, 6, "d2d3", side="white")

    candidate = derive_puzzle_candidates([game], _cache(game, [evidence], side="white"), "me")[0]

    assert candidate["played_move_uci"] == "e1g1"
    assert candidate["played_move_san"] == "O-O"
    assert "g1" in candidate["legal_dests"]["e1"]
    post_best = chess.Board(candidate["post_best_fen"])
    assert post_best.piece_at(chess.D3) == chess.Piece(chess.PAWN, chess.WHITE)


def test_en_passant_solution_uses_the_reconstructed_post_move_position():
    pgn = "1. e4 Nf6 2. e5 d5 3. d3 *"
    game = _game(pgn)
    evidence = _evidence(pgn, 4, "e5d6", side="white")

    candidate = derive_puzzle_candidates(
        [game], _cache(game, [evidence], side="white"), "me"
    )[0]

    assert candidate["best_move_san"] == "exd6"
    post_best = chess.Board(candidate["post_best_fen"])
    assert post_best.piece_at(chess.D6) == chess.Piece(chess.PAWN, chess.WHITE)
    assert post_best.piece_at(chess.D5) is None


def test_promotion_keeps_the_uci_suffix_and_all_legal_choices():
    pgn = (
        '[SetUp "1"]\n'
        '[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n'
        "1. a8=Q+ *"
    )
    game = _game(pgn)
    evidence = _evidence(pgn, 0, "a7a8n", side="white")

    candidate = derive_puzzle_candidates([game], _cache(game, [evidence], side="white"), "me")[0]

    assert candidate["played_move_uci"] == "a7a8q"
    assert candidate["best_move_uci"] == "a7a8n"
    assert candidate["best_move_san"] == "a8=N"
    assert candidate["promotion_options"]["a7a8"] == [
        "a7a8b",
        "a7a8n",
        "a7a8q",
        "a7a8r",
    ]
    assert candidate["principal_variation_uci"] == ["a7a8n"]
    assert len(candidate["solution_steps"]) == 1
    assert candidate["solution_steps"][0]["best_move_uci"] == "a7a8n"
    assert candidate["solution_steps"][0]["opponent_reply_uci"] is None
    assert chess.Board(candidate["post_best_fen"]).is_game_over()


def test_nonterminal_candidate_requires_three_ply_principal_variation():
    game = _game()
    fallback = _evidence(MAINLINE_PGN, 4, "f1c4", side="white")
    fallback["principal_variation_uci"] = []

    result = build_puzzle_queue([game], _cache(game, [fallback], side="white"), "me")

    assert result["candidates"] == []
    assert result["coverage"]["incomplete_puzzles"] == 1
    assert result["errors"][0]["code"] == "incomplete_principal_variation"


def test_solution_steps_expose_exactly_two_user_decisions():
    game = _game()
    evidence = _evidence(
        MAINLINE_PGN,
        4,
        "f1c4",
        side="white",
        principal_variation_uci=["f1c4", "g8f6", "d2d3", "f8c5", "c1g5"],
    )

    candidate = derive_puzzle_candidates(
        [game], _cache(game, [evidence], side="white"), "me"
    )[0]
    first, second = candidate["solution_steps"]

    assert len(candidate["solution_steps"]) == 2
    assert first["fen_before"] == candidate["fen_before"]
    assert first["best_move_uci"] == candidate["best_move_uci"] == "f1c4"
    assert first["best_move_san"] == "Bc4"
    assert first["post_best_fen"] == candidate["post_best_fen"]
    assert first["opponent_reply_uci"] == "g8f6"
    assert first["opponent_reply_san"] == "Nf6"
    assert first["post_reply_fen"] == second["fen_before"]
    assert "f1c4" in first["legal_moves_uci"]
    assert "c4" in first["legal_dests"]["f1"]
    assert second["best_move_uci"] == "d2d3"
    assert second["best_move_san"] == "d3"
    assert second["opponent_reply_uci"] is None
    assert second["opponent_reply_san"] is None
    # PV ply 4 is valid context but never creates a third user decision.
    assert candidate["principal_variation_uci"][-1] == "c1g5"
    assert len(candidate["solution_steps"]) == 2


def test_exact_black_kxc3_line_builds_black_oriented_two_step_solution():
    pgn = (
        '[SetUp "1"]\n'
        '[FEN "8/8/8/8/5K2/2Qp4/3k4/8 b - - 3 47"]\n\n'
        "47... Ke2 *"
    )
    game = _game(pgn, user_color="black")
    evidence = _evidence(
        pgn,
        93,
        "d2c3",
        side="black",
        principal_variation_uci=["d2c3", "f4e4", "c3d2"],
    )

    candidate = derive_puzzle_candidates(
        [game], _cache(game, [evidence], side="black"), "me"
    )[0]
    first, second = candidate["solution_steps"]

    assert candidate["orientation"] == "black"
    assert candidate["fen_before"] == "8/8/8/8/5K2/2Qp4/3k4/8 b - - 3 47"
    assert candidate["best_move_san"] == "Kxc3"
    assert first["best_move_uci"] == "d2c3"
    assert first["best_move_san"] == "Kxc3"
    assert "c3" in first["legal_dests"]["d2"]
    assert first["opponent_reply_uci"] == "f4e4"
    assert first["opponent_reply_san"] == "Ke4"
    assert first["post_reply_fen"] == second["fen_before"]
    assert second["best_move_uci"] == "c3d2"
    assert second["best_move_san"] == "Kd2"
    assert second["opponent_reply_uci"] is None


def test_candidates_sort_by_loss_then_newest_game_then_ply():
    older = _game(url="older", uuid="older", end_time=100)
    newer = _game(url="newer", uuid="newer", end_time=200)
    older_high = _evidence(MAINLINE_PGN, 4, "f1c4", side="white", cp_loss=800)
    newer_low = _evidence(MAINLINE_PGN, 4, "f1c4", side="white", cp_loss=400)
    cache = {
        **_cache(older, [older_high], side="white"),
        **_cache(newer, [newer_low], side="white"),
    }

    candidates = derive_puzzle_candidates([newer, older], cache, "me")

    assert [candidate["game_id"] for candidate in candidates] == ["older", "newer"]
