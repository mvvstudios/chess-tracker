"""Classify personal games into the opening trainer's repertoire decks.

Chess.com's opening label is authoritative when it names one of the five
configured trainer families.  Some Queen's/King's Pawn and Indian labels are
too broad to identify the user's repertoire, so those labels may fall back to
a deliberately small set of ordered opening-move signatures.

The classifier returns at most one existing opening-deck ID.  It does not
create puzzle identity or mutate puzzle records.
"""

from __future__ import annotations

from collections.abc import Mapping
from io import StringIO
import re
from typing import Any
from urllib.parse import unquote, urlsplit

import chess
import chess.pgn

from chess_tracker.opening_puzzle_decks import (
    OPENING_PUZZLE_DECK_ORDER,
    OPENING_PUZZLE_DECKS,
)
from chess_tracker.pgn import _clean_opening_label


_SUPPORTED_DECK_IDS = frozenset(
    {
        "caro-kann-black",
        "colle-white",
        "englund-white",
        "pirc-black",
        "modern-black",
    }
)

# Keep classification order and perspective sourced from the trainer registry.
BLUNDER_REPERTOIRE_DECK_IDS = tuple(
    deck_id
    for deck_id in OPENING_PUZZLE_DECK_ORDER
    if deck_id in _SUPPORTED_DECK_IDS
)

_CHESS_COM_LABEL_ALIASES: Mapping[str, tuple[str, ...]] = {
    # Chess.com names these branches differently from Lichess's configured
    # Indian_Defense_Colle_System root.
    "colle-white": (
        "Indian Game East Indian Colle System",
        "Colle Zukertort System",
    ),
}

# Only source families that do not identify a competing opening may use the
# move fallback.  Descendants of Queen's Pawn Opening and Indian Game commonly
# describe Black's reply while leaving White's Colle setup unnamed.
_GENERIC_EXACT_LABELS = frozenset(
    {
        "undefined",
        "unknown",
        "unrecognized",
        "kings pawn opening",
        "kings pawn game",
    }
)
_GENERIC_LABEL_ROOTS = (
    "queens pawn opening",
    "queens pawn game",
    "indian game",
)

_MOVE_LIMIT = 12
_ECO_CODE_RE = re.compile(r"^[a-e][0-9]{2}$", re.IGNORECASE)
_WORD_RE = re.compile(r"[a-z0-9]+")


def classify_blunder_repertoire(
    game: Mapping[str, Any] | Any,
    user_color: str,
    *,
    parsed_game: chess.pgn.Game | None = None,
) -> str | None:
    """Return the matching opening-trainer deck ID for one personal game.

    ``game`` may be a raw Chess.com mapping, a ``GameRecord``-like object, or
    a parsed ``python-chess`` game.  ``parsed_game`` lets callers that already
    validated the PGN avoid parsing it again.

    A source opening label wins over move inference.  Move inference is used
    only when every available label is missing or belongs to an explicitly
    generic source family.  The configured deck's solver color must match
    ``user_color``.
    """

    color = str(user_color or "").strip().lower()
    if color not in {"white", "black"}:
        return None

    parsed = _parsed_game(game, parsed_game)
    labels = _opening_labels(game, parsed)

    for label in labels:
        deck_id = _deck_for_exact_label(label)
        if deck_id is None:
            continue
        deck = OPENING_PUZZLE_DECKS[deck_id]
        return deck_id if deck.solver_color == color else None

    if labels and not all(_is_generic_label(label) for label in labels):
        return None

    moves = _opening_moves(parsed)
    if not moves:
        return None

    for deck_id in BLUNDER_REPERTOIRE_DECK_IDS:
        deck = OPENING_PUZZLE_DECKS[deck_id]
        if deck.solver_color != color:
            continue
        if _MOVE_FALLBACKS[deck_id](moves):
            return deck_id
    return None


def _value(game: Mapping[str, Any] | Any, key: str) -> Any:
    if isinstance(game, Mapping):
        return game.get(key)
    return getattr(game, key, None)


def _parsed_game(
    game: Mapping[str, Any] | Any,
    supplied: chess.pgn.Game | None,
) -> chess.pgn.Game | None:
    if supplied is not None:
        return supplied
    if isinstance(game, chess.pgn.Game):
        return game
    pgn = _value(game, "pgn")
    if not isinstance(pgn, str) or not pgn.strip():
        return None
    try:
        return chess.pgn.read_game(StringIO(pgn))
    except (ValueError, TypeError, UnicodeError):
        return None


def _opening_labels(
    game: Mapping[str, Any] | Any,
    parsed_game: chess.pgn.Game | None,
) -> tuple[str, ...]:
    values: list[Any] = []
    for key in ("opening", "opening_name", "family", "eco"):
        values.append(_value(game, key))
    if parsed_game is not None:
        values.extend(
            (
                parsed_game.headers.get("Opening"),
                parsed_game.headers.get("ECOUrl"),
            )
        )

    labels: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        if _ECO_CODE_RE.fullmatch(value.strip()):
            continue
        label = _normalise_opening_label(value)
        if label and label not in labels:
            labels.append(label)
    return tuple(labels)


def _normalise_opening_label(value: str) -> str:
    text = value.strip()
    if "/openings/" in text:
        text = text.split("/openings/", 1)[1]
        text = text.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    elif "://" in text:
        path = urlsplit(text).path.rstrip("/")
        text = path.rsplit("/", 1)[-1]
    text = unquote(text)
    text = _clean_opening_label(text)
    return " ".join(_WORD_RE.findall(text.lower()))


def _configured_label_roots() -> dict[str, tuple[str, ...]]:
    roots_by_deck: dict[str, tuple[str, ...]] = {}
    for deck_id in BLUNDER_REPERTOIRE_DECK_IDS:
        deck = OPENING_PUZZLE_DECKS[deck_id]
        roots: list[str] = [
            _normalise_opening_label(root) for root in deck.opening_tag_roots
        ]
        # Chess.com says "Opening" where Lichess says "Game" for Queen's
        # Pawn roots.  This is a token-level source alias, not a substring
        # search.
        roots.extend(
            root.replace("queens pawn game", "queens pawn opening", 1)
            for root in tuple(roots)
            if root.startswith("queens pawn game ")
        )
        roots.extend(
            _normalise_opening_label(alias)
            for alias in _CHESS_COM_LABEL_ALIASES.get(deck_id, ())
        )
        roots_by_deck[deck_id] = tuple(dict.fromkeys(roots))
    return roots_by_deck


_LABEL_ROOTS_BY_DECK = _configured_label_roots()


def _deck_for_exact_label(label: str) -> str | None:
    for deck_id in BLUNDER_REPERTOIRE_DECK_IDS:
        for root in _LABEL_ROOTS_BY_DECK[deck_id]:
            if label == root or label.startswith(f"{root} "):
                return deck_id
    return None


def _is_generic_label(label: str) -> bool:
    if label in _GENERIC_EXACT_LABELS:
        return True
    return any(
        label == root or label.startswith(f"{root} ")
        for root in _GENERIC_LABEL_ROOTS
    )


def _opening_moves(game: chess.pgn.Game | None) -> tuple[str, ...]:
    if game is None:
        return ()
    try:
        board = game.board()
    except (ValueError, TypeError):
        return ()
    if board.fen() != chess.STARTING_FEN:
        return ()

    moves: list[str] = []
    try:
        for move in game.mainline_moves():
            if len(moves) >= _MOVE_LIMIT:
                break
            if move not in board.legal_moves:
                return ()
            moves.append(move.uci())
            board.push(move)
    except (ValueError, TypeError):
        return ()
    return tuple(moves)


def _starts_with(moves: tuple[str, ...], prefix: tuple[str, ...]) -> bool:
    return moves[: len(prefix)] == prefix


def _is_caro_kann(moves: tuple[str, ...]) -> bool:
    return _starts_with(moves, ("e2e4", "c7c6")) or _starts_with(
        moves,
        ("d2d4", "c7c6", "e2e4", "d7d5"),
    )


def _is_colle(moves: tuple[str, ...]) -> bool:
    white_moves = moves[0::2]
    black_moves = moves[1::2]
    if not white_moves or white_moves[0] != "d2d4":
        return False
    if black_moves and black_moves[0] == "e7e5":
        return False
    if "c1f4" in white_moves:  # London, not Colle.
        return False
    required = {"g1f3", "e2e3"}
    if not required.issubset(white_moves):
        return False
    standard_colle = "c2c3" in white_moves and "f1d3" in white_moves
    zukertort_colle = "b2b3" in white_moves or "c1b2" in white_moves
    return standard_colle or zukertort_colle


def _is_englund(moves: tuple[str, ...]) -> bool:
    return _starts_with(moves, ("d2d4", "e7e5"))


def _black_move_order(moves: tuple[str, ...]) -> tuple[str, ...]:
    return moves[1::2]


def _is_pirc(moves: tuple[str, ...]) -> bool:
    if not moves or moves[0] != "e2e4":
        return False
    black_moves = _black_move_order(moves)
    # Knight-before-fianchetto is the canonical Pirc move order.  Requiring
    # all three moves keeps a generic 1...d6 game out of both Pirc and Modern.
    return black_moves[:3] == ("d7d6", "g8f6", "g7g6")


def _is_modern(moves: tuple[str, ...]) -> bool:
    if not moves or moves[0] not in {"e2e4", "d2d4"}:
        return False
    black_moves = _black_move_order(moves)
    # Pawn/fianchetto before ...Nf6 is the distinct Modern move order.
    return len(black_moves) >= 2 and black_moves[:2] == ("g7g6", "f8g7")


_MOVE_FALLBACKS = {
    "caro-kann-black": _is_caro_kann,
    "colle-white": _is_colle,
    "englund-white": _is_englund,
    "pirc-black": _is_pirc,
    "modern-black": _is_modern,
}
