"""Authoritative configuration for the static opening-puzzle datasets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Final, Mapping


@dataclass(frozen=True)
class OpeningPuzzleDeck:
    """One exact-tag Lichess puzzle deck."""

    id: str
    display_name: str
    opening_family: str
    solver_color: str
    orientation: str
    opening_tag_roots: tuple[str, ...]
    output_path: Path
    manifest_path: str
    optional_alias_roots: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.solver_color not in {"white", "black"}:
            raise ValueError(f"Unsupported solver color: {self.solver_color!r}")
        if self.orientation != self.solver_color:
            raise ValueError("Opening-puzzle orientation must equal solver color")
        if not self.opening_tag_roots:
            raise ValueError("At least one opening tag root is required")
        validate_catalog_manifest_path(self.manifest_path)

    def catalog_entry(self) -> dict[str, str]:
        return {
            "id": self.id,
            "label": self.display_name,
            "openingFamily": self.opening_family,
            "solverColor": self.solver_color,
            "orientation": self.orientation,
            "manifestPath": self.manifest_path,
        }


def validate_catalog_manifest_path(raw_path: str) -> str:
    """Validate and return a safe POSIX path relative to ``public/data``."""

    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("manifestPath must be a non-empty string")
    if raw_path != raw_path.strip():
        raise ValueError("manifestPath must not contain surrounding whitespace")
    if "\\" in raw_path or any(character in raw_path for character in "?#\0"):
        raise ValueError("manifestPath must use POSIX separators")
    path = PurePosixPath(raw_path)
    if path.is_absolute() or raw_path.startswith("/"):
        raise ValueError("manifestPath must be relative")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("manifestPath contains an unsafe path segment")
    if path.as_posix() != raw_path:
        raise ValueError("manifestPath must be a normalized relative path")
    if path.suffix != ".json" or path.name != "manifest.json":
        raise ValueError("manifestPath must end in manifest.json")
    return path.as_posix()


_DECKS: Final[tuple[OpeningPuzzleDeck, ...]] = (
    OpeningPuzzleDeck(
        id="caro-kann-black",
        display_name="Caro-Kann Defense — Black",
        opening_family="Caro-Kann Defense",
        solver_color="black",
        orientation="black",
        opening_tag_roots=("Caro-Kann_Defense",),
        output_path=Path("public/data/caro-kann-black"),
        manifest_path="caro-kann-black/manifest.json",
    ),
    OpeningPuzzleDeck(
        id="colle-white",
        display_name="Colle System — White",
        opening_family="Colle System",
        solver_color="white",
        orientation="white",
        opening_tag_roots=(
            "Queens_Pawn_Game_Colle_System",
            "Indian_Defense_Colle_System",
            "Colle_System",
        ),
        output_path=Path("public/data/colle-white"),
        manifest_path="colle-white/manifest.json",
    ),
    OpeningPuzzleDeck(
        id="englund-white",
        display_name="Englund Gambit — White",
        opening_family="Englund Gambit",
        solver_color="white",
        orientation="white",
        opening_tag_roots=("Englund_Gambit",),
        output_path=Path("public/data/englund-white"),
        manifest_path="englund-white/manifest.json",
    ),
    OpeningPuzzleDeck(
        id="pirc-black",
        display_name="Pirc Defense — Black",
        opening_family="Pirc Defense",
        solver_color="black",
        orientation="black",
        opening_tag_roots=("Pirc_Defense",),
        output_path=Path("public/data/pirc-black"),
        manifest_path="pirc-black/manifest.json",
    ),
    OpeningPuzzleDeck(
        id="modern-black",
        display_name="Modern Defense — Black",
        opening_family="Modern Defense",
        solver_color="black",
        orientation="black",
        opening_tag_roots=(
            "Modern_Defense",
            "Queens_Pawn_Game_Modern_Defense",
        ),
        output_path=Path("public/data/modern-black"),
        manifest_path="modern-black/manifest.json",
        optional_alias_roots=("Robatsch_Defense",),
    ),
)

OPENING_PUZZLE_DECKS: Final[Mapping[str, OpeningPuzzleDeck]] = MappingProxyType(
    {deck.id: deck for deck in _DECKS}
)
OPENING_PUZZLE_DECK_ORDER: Final[tuple[str, ...]] = tuple(deck.id for deck in _DECKS)
DEFAULT_OPENING_PUZZLE_DECK_ID: Final[str] = "caro-kann-black"


def opening_puzzle_catalog(
    deck_ids: tuple[str, ...] = OPENING_PUZZLE_DECK_ORDER,
) -> dict[str, object]:
    """Return a deterministic, internally complete browser catalog."""

    if not deck_ids:
        raise ValueError("A catalog must contain at least one deck")
    unknown = set(deck_ids) - set(OPENING_PUZZLE_DECKS)
    if unknown:
        raise ValueError(f"Unknown catalog deck IDs: {sorted(unknown)!r}")
    default_deck_id = (
        DEFAULT_OPENING_PUZZLE_DECK_ID
        if DEFAULT_OPENING_PUZZLE_DECK_ID in deck_ids
        else deck_ids[0]
    )

    return {
        "schemaVersion": 1,
        "defaultDeckId": default_deck_id,
        "decks": [
            OPENING_PUZZLE_DECKS[deck_id].catalog_entry()
            for deck_id in OPENING_PUZZLE_DECK_ORDER
            if deck_id in deck_ids
        ],
    }
