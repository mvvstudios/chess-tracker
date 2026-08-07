from __future__ import annotations

from io import StringIO

import chess.pgn
import pytest

from chess_tracker.blunder_repertoire import (
    BLUNDER_REPERTOIRE_DECK_IDS,
    classify_blunder_repertoire,
)
from chess_tracker.opening_puzzle_decks import OPENING_PUZZLE_DECKS


def _game(moves: str, opening: str | None = None) -> dict[str, str]:
    headers = '[Event "Unit"]\n'
    if opening is not None:
        headers += f'[ECOUrl "https://www.chess.com/openings/{opening}"]\n'
    return {"pgn": f"{headers}\n{moves} *"}


@pytest.mark.parametrize(
    ("opening", "color", "expected"),
    [
        ("Caro-Kann-Defense-Advance-Variation-3...c5", "black", "caro-kann-black"),
        ("Colle-System-3...e6-4.Bd3", "white", "colle-white"),
        ("Indian-Game-East-Indian-Colle-System-4...O-O", "white", "colle-white"),
        ("London-System-3...Bf5-4.e3", "white", "london-white"),
        (
            "Queens-Pawn-Opening-Accelerated-London-System-2...Nf6-3.e3",
            "white",
            "london-white",
        ),
        (
            "Indian-Game-East-Indian-London-System-3...Bg7-4.e3",
            "white",
            "london-white",
        ),
        ("Englund-Gambit-Declined", "white", "englund-white"),
        ("Pirc-Defense-Classical-Variation-4...Bg7", "black", "pirc-black"),
        ("Modern-Defense-Standard-Two-Knights-Variation", "black", "modern-black"),
        ("Queens-Pawn-Game-Modern-Defense", "black", "modern-black"),
    ],
)
def test_exact_chess_com_families_and_descendants(opening, color, expected):
    assert classify_blunder_repertoire(_game("1. e4 e5", opening), color) == expected


def test_supported_ids_and_colors_come_from_the_opening_deck_registry():
    assert BLUNDER_REPERTOIRE_DECK_IDS == (
        "caro-kann-black",
        "colle-white",
        "london-white",
        "englund-white",
        "pirc-black",
        "modern-black",
    )
    assert [OPENING_PUZZLE_DECKS[deck_id].solver_color for deck_id in BLUNDER_REPERTOIRE_DECK_IDS] == [
        "black",
        "white",
        "white",
        "white",
        "black",
        "black",
    ]


@pytest.mark.parametrize(
    ("opening", "color"),
    [
        ("Caro-Kann-Defense", "white"),
        ("Colle-System", "black"),
        ("London-System", "black"),
        ("Englund-Gambit", "black"),
        ("Pirc-Defense", "white"),
        ("Modern-Defense", "white"),
    ],
)
def test_exact_label_requires_the_decks_solver_color(opening, color):
    assert classify_blunder_repertoire(_game("1. e4 e5", opening), color) is None


def test_pirc_modern_hybrid_label_uses_anchored_leading_family():
    game = _game(
        "1. e4 d6 2. Nf3 Nf6 3. Nc3 g6",
        "Pirc-Defense-Modern-Defense-Geller-System-2...Nf6-3.Nc3-g6",
    )
    assert classify_blunder_repertoire(game, "black") == "pirc-black"


@pytest.mark.parametrize(
    "opening",
    [
        "Kings-Gambit-Accepted-Modern-Defense",
        "Nimzowitsch-Larsen-Attack-Modern-Variation",
        "Reti-Opening-Pirc-Invitation",
        "Caro-Kann-Defensive-System",
    ],
)
def test_unrelated_middle_substrings_and_near_names_do_not_match(opening):
    assert classify_blunder_repertoire(_game("1. e4 e5", opening), "black") is None


@pytest.mark.parametrize(
    "opening",
    [
        "Grob-Opening-London-Defense",
        "Jobava-London-System",
        "Rapport-Jobava-System",
    ],
)
def test_unrelated_london_names_do_not_match_as_white(opening):
    assert classify_blunder_repertoire(_game("1. d4 d5", opening), "white") is None


@pytest.mark.parametrize(
    ("game", "color", "expected"),
    [
        (_game("1. e4 c6 2. d4 d5", "Kings-Pawn-Opening"), "black", "caro-kann-black"),
        (_game("1. d4 e5 2. dxe5 Nc6", "Queens-Pawn-Opening"), "white", "englund-white"),
        (
            _game(
                "1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. b3 Nc6 6. Bb2 Bd6",
                "Queens-Pawn-Opening-Zukertort-Variation",
            ),
            "white",
            "colle-white",
        ),
        (
            _game(
                "1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 Nc6",
                "Queens-Pawn-Opening",
            ),
            "white",
            "colle-white",
        ),
        (
            _game(
                "1. d4 d5 2. Nf3 Nf6 3. Bf4 e6 4. e3 Bd6",
                "Queens-Pawn-Opening-Zukertort-Chigorin-Variation",
            ),
            "white",
            "london-white",
        ),
        (
            _game("1. d4 d5 2. Bf4 Nf6", "Queens-Pawn-Opening"),
            "white",
            "london-white",
        ),
        (
            _game("1. e4 d6 2. d4 Nf6 3. Nc3 g6", "Undefined"),
            "black",
            "pirc-black",
        ),
        (
            _game("1. e4 g6 2. d4 Bg7 3. Nc3 d6", "Undefined"),
            "black",
            "modern-black",
        ),
        (
            _game("1. d4 g6 2. Nf3 Bg7 3. e3 d6", "Queens-Pawn-Opening"),
            "black",
            "modern-black",
        ),
    ],
)
def test_generic_labels_use_narrow_ordered_move_fallbacks(game, color, expected):
    assert classify_blunder_repertoire(game, color) == expected


def test_generic_zukertort_label_separates_london_from_colle():
    game = _game(
        "1. d4 d5 2. Nf3 Nf6 3. Bf4 e6 4. e3 Bd6 5. b3 O-O 6. Bd3 c5",
        "Queens-Pawn-Opening-Zukertort-Chigorin-Variation",
    )
    assert classify_blunder_repertoire(game, "white") == "london-white"


@pytest.mark.parametrize(
    ("moves", "opening"),
    [
        (
            "1. d4 d5 2. Nc3 Nf6 3. Bf4 e6 4. e3",
            "Queens-Pawn-Opening-Jobava-London-System",
        ),
        (
            "1. d4 d5 2. Bf4 Nf6 3. Nc3 e6 4. e3",
            "Queens-Pawn-Opening-Jobava-London-System",
        ),
        (
            "1. d4 d5 2. Bf4 Nf6",
            "Queens-Pawn-Opening-Jobava-London-System",
        ),
        (
            "1. d4 d5 2. Bf4 Nf6",
            "Queens-Pawn-Opening-Rapport-Jobava-System",
        ),
        (
            "1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bf4",
            "Queens-Pawn-Opening",
        ),
        (
            "1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 Bd6 5. Bf4",
            "Queens-Pawn-Opening",
        ),
    ],
)
def test_generic_london_fallback_rejects_jobava_queens_gambit_and_late_bf4(
    moves, opening
):
    assert classify_blunder_repertoire(_game(moves, opening), "white") is None


def test_specific_unrelated_label_blocks_move_fallback():
    game = _game("1. e4 c6 2. d4 d5", "French-Defense")
    assert classify_blunder_repertoire(game, "black") is None


def test_generic_d6_without_complete_pirc_order_is_not_guessed():
    game = _game("1. e4 d6 2. d4 g6 3. Nc3 Nf6", "Kings-Pawn-Opening")
    assert classify_blunder_repertoire(game, "black") is None


def test_preparsed_game_is_accepted_without_a_pgn_mapping():
    parsed = chess.pgn.read_game(StringIO("1. d4 e5 2. dxe5 Nc6 *"))
    assert parsed is not None
    assert (
        classify_blunder_repertoire({}, "white", parsed_game=parsed)
        == "englund-white"
    )


def test_custom_start_position_and_malformed_inputs_do_not_fallback():
    custom = {
        "pgn": (
            '[Event "Unit"]\n[SetUp "1"]\n'
            '[FEN "4k3/8/8/8/8/8/4K3/8 w - - 0 1"]\n\n1. Kd3 *'
        )
    }
    assert classify_blunder_repertoire(custom, "white") is None
    assert classify_blunder_repertoire({"pgn": "not pgn"}, "black") is None
    assert classify_blunder_repertoire({}, "chartreuse") is None
