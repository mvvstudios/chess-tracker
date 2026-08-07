"""Data contracts for exposing personal move-quality errors in the trainer."""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from copy import deepcopy
from pathlib import Path
from types import MappingProxyType
from typing import Final


MY_BLUNDER_PUZZLE_DATA_PATH: Final[str] = "my-blunder-puzzles.json"
PERSONAL_BLUNDER_SOURCE_KIND: Final[str] = "personal-blunders"
PERSONAL_BLUNDER_PROGRESS_SCOPE: Final[str] = "personal"

_SAFE_DECK_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _descriptor(
    deck_id: str,
    label: str,
    solver_color: str,
    repertoire_deck_id: str | None,
    quality_label: str = "blunder",
) -> Mapping[str, object]:
    return MappingProxyType(
        {
            "id": deck_id,
            "label": label,
            "openingFamily": label,
            "sourceKind": PERSONAL_BLUNDER_SOURCE_KIND,
            "dataPath": MY_BLUNDER_PUZZLE_DATA_PATH,
            "progressScope": PERSONAL_BLUNDER_PROGRESS_SCOPE,
            "repertoireDeckId": repertoire_deck_id,
            "qualityLabel": quality_label,
            "solverColor": solver_color,
            "orientation": solver_color,
        }
    )


MY_BLUNDER_DECK_DESCRIPTORS: Final[tuple[Mapping[str, object], ...]] = (
    _descriptor("my-blunders-all", "My Blunders — ALL", "mixed", None),
    _descriptor(
        "my-blunders-colle",
        "My Blunders — Colle System",
        "white",
        "colle-white",
    ),
    _descriptor(
        "my-blunders-pirc",
        "My Blunders — Pirc Defense",
        "black",
        "pirc-black",
    ),
    _descriptor(
        "my-blunders-englund",
        "My Blunders — Englund Gambit",
        "white",
        "englund-white",
    ),
    _descriptor(
        "my-blunders-modern",
        "My Blunders — Modern Defense",
        "black",
        "modern-black",
    ),
    _descriptor(
        "my-blunders-caro-kann",
        "My Blunders — Caro-Kann Defense",
        "black",
        "caro-kann-black",
    ),
    _descriptor(
        "my-blunders-london",
        "My Blunders — London System",
        "white",
        "london-white",
    ),
)

MY_BLUNDER_DECK_IDS: Final[tuple[str, ...]] = tuple(
    str(descriptor["id"]) for descriptor in MY_BLUNDER_DECK_DESCRIPTORS
)

MY_MISTAKE_DECK_DESCRIPTORS: Final[tuple[Mapping[str, object], ...]] = (
    _descriptor("my-mistakes-all", "My Mistakes — ALL", "mixed", None, "mistake"),
    _descriptor(
        "my-mistakes-colle", "My Mistakes — Colle System",
        "white", "colle-white", "mistake",
    ),
    _descriptor(
        "my-mistakes-pirc", "My Mistakes — Pirc Defense",
        "black", "pirc-black", "mistake",
    ),
    _descriptor(
        "my-mistakes-englund", "My Mistakes — Englund Gambit",
        "white", "englund-white", "mistake",
    ),
    _descriptor(
        "my-mistakes-modern", "My Mistakes — Modern Defense",
        "black", "modern-black", "mistake",
    ),
    _descriptor(
        "my-mistakes-caro-kann", "My Mistakes — Caro-Kann Defense",
        "black", "caro-kann-black", "mistake",
    ),
    _descriptor(
        "my-mistakes-london", "My Mistakes — London System",
        "white", "london-white", "mistake",
    ),
)

MY_MISTAKE_DECK_IDS: Final[tuple[str, ...]] = tuple(
    str(descriptor["id"]) for descriptor in MY_MISTAKE_DECK_DESCRIPTORS
)

PERSONAL_ERROR_DECK_DESCRIPTORS: Final[tuple[Mapping[str, object], ...]] = (
    *MY_BLUNDER_DECK_DESCRIPTORS,
    *MY_MISTAKE_DECK_DESCRIPTORS,
)

PERSONAL_ERROR_DECK_IDS: Final[tuple[str, ...]] = tuple(
    str(descriptor["id"]) for descriptor in PERSONAL_ERROR_DECK_DESCRIPTORS
)


def blunder_deck_catalog_entries() -> list[dict[str, object]]:
    """Return mutable, independent copies of the canonical deck descriptors."""

    return [dict(descriptor) for descriptor in MY_BLUNDER_DECK_DESCRIPTORS]


def personal_error_deck_catalog_entries() -> list[dict[str, object]]:
    """Return every personal Blunder and Mistake deck descriptor."""

    return [dict(descriptor) for descriptor in PERSONAL_ERROR_DECK_DESCRIPTORS]


def _validate_puzzle_catalog(puzzle_catalog: Mapping[str, object]) -> None:
    if not isinstance(puzzle_catalog.get("candidates"), list):
        raise ValueError("puzzle catalog candidates must be a list")
    if not isinstance(puzzle_catalog.get("coverage"), Mapping):
        raise ValueError("puzzle catalog coverage must be an object")
    if not isinstance(puzzle_catalog.get("errors"), list):
        raise ValueError("puzzle catalog errors must be a list")


def write_my_blunder_puzzle_export(
    puzzle_catalog: Mapping[str, object],
    username: str,
    output_path: Path | str,
    generated_at: str,
) -> dict[str, object]:
    """Atomically write the standalone personal-blunder browser payload."""

    if not isinstance(puzzle_catalog, Mapping):
        raise TypeError("puzzle_catalog must be a mapping")
    _validate_puzzle_catalog(puzzle_catalog)
    if not isinstance(username, str) or not username.strip():
        raise ValueError("username must be a non-empty string")
    if not isinstance(generated_at, str) or not generated_at.strip():
        raise ValueError("generated_at must be a non-empty ISO timestamp")

    destination = Path(output_path)
    if destination.name in {"", ".", ".."}:
        raise ValueError("output_path must name a JSON file")
    destination.parent.mkdir(parents=True, exist_ok=True)

    payload: dict[str, object] = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "username": username,
        "catalog": deepcopy(dict(puzzle_catalog)),
    }

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
    except BaseException:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise

    return deepcopy(payload)


def _validate_catalog_decks(decks: object) -> list[Mapping[str, object]]:
    if not isinstance(decks, list):
        raise ValueError("catalog decks must be a list")

    validated: list[Mapping[str, object]] = []
    seen_ids: set[str] = set()
    for index, deck in enumerate(decks):
        if not isinstance(deck, Mapping):
            raise ValueError(f"catalog deck {index} must be an object")
        deck_id = deck.get("id")
        if not isinstance(deck_id, str) or _SAFE_DECK_ID.fullmatch(deck_id) is None:
            raise ValueError(f"catalog deck {index} has an unsafe id")
        if deck_id in seen_ids:
            raise ValueError(f"duplicate catalog deck id: {deck_id!r}")
        if not isinstance(deck.get("label"), str) or not deck["label"].strip():
            raise ValueError(f"catalog deck {deck_id!r} has no label")
        seen_ids.add(deck_id)
        validated.append(deck)
    return validated


def _validate_personal_entries(
    entries: Iterable[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    try:
        resolved = list(entries)
    except TypeError as error:
        raise TypeError("entries must be an iterable of mappings") from error
    if not resolved:
        raise ValueError("at least one personal-blunder deck entry is required")

    validated = _validate_catalog_decks(resolved)
    for entry in validated:
        deck_id = str(entry["id"])
        if entry.get("sourceKind") != PERSONAL_BLUNDER_SOURCE_KIND:
            raise ValueError(
                f"personal deck {deck_id!r} must use sourceKind "
                f"{PERSONAL_BLUNDER_SOURCE_KIND!r}"
            )
        if (
            not isinstance(entry.get("openingFamily"), str)
            or not entry["openingFamily"].strip()
        ):
            raise ValueError(f"personal deck {deck_id!r} has no openingFamily")
        if entry.get("dataPath") != MY_BLUNDER_PUZZLE_DATA_PATH:
            raise ValueError(
                f"personal deck {deck_id!r} must use dataPath "
                f"{MY_BLUNDER_PUZZLE_DATA_PATH!r}"
            )
        if entry.get("progressScope") != PERSONAL_BLUNDER_PROGRESS_SCOPE:
            raise ValueError(
                f"personal deck {deck_id!r} must use progressScope "
                f"{PERSONAL_BLUNDER_PROGRESS_SCOPE!r}"
            )

        solver_color = entry.get("solverColor")
        orientation = entry.get("orientation")
        if solver_color not in {"white", "black", "mixed"}:
            raise ValueError(f"personal deck {deck_id!r} has an invalid solverColor")
        if orientation != solver_color:
            raise ValueError(
                f"personal deck {deck_id!r} orientation must equal solverColor"
            )
        repertoire_deck_id = entry.get("repertoireDeckId")
        if repertoire_deck_id is not None and (
            not isinstance(repertoire_deck_id, str)
            or _SAFE_DECK_ID.fullmatch(repertoire_deck_id) is None
        ):
            raise ValueError(
                f"personal deck {deck_id!r} has an invalid repertoireDeckId"
            )
        if entry.get("qualityLabel") not in {"blunder", "mistake"}:
            raise ValueError(
                f"personal deck {deck_id!r} has an invalid qualityLabel"
            )
    return validated


def augment_opening_puzzle_catalog(
    catalog: Mapping[str, object],
    entries: Iterable[Mapping[str, object]] = PERSONAL_ERROR_DECK_DESCRIPTORS,
) -> dict[str, object]:
    """Add or replace personal decks without disturbing ordinary deck entries."""

    if not isinstance(catalog, Mapping):
        raise TypeError("catalog must be a mapping")
    schema_version = catalog.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version < 1
    ):
        raise ValueError("catalog requires a positive integer schemaVersion")
    existing_decks = _validate_catalog_decks(catalog.get("decks"))
    personal_entries = _validate_personal_entries(entries)

    default_deck_id = catalog.get("defaultDeckId")
    existing_ids = {str(deck["id"]) for deck in existing_decks}
    if not isinstance(default_deck_id, str) or default_deck_id not in existing_ids:
        raise ValueError("catalog defaultDeckId must reference an existing catalog deck")

    incoming_by_id = {str(entry["id"]): entry for entry in personal_entries}
    output_decks: list[dict[str, object]] = []
    replaced_ids: set[str] = set()

    for deck in existing_decks:
        deck_id = str(deck["id"])
        replacement = incoming_by_id.get(deck_id)
        if replacement is None:
            output_decks.append(deepcopy(dict(deck)))
            continue
        if deck.get("sourceKind") != PERSONAL_BLUNDER_SOURCE_KIND:
            raise ValueError(
                f"refusing to replace non-personal catalog deck {deck_id!r}"
            )
        output_decks.append(deepcopy(dict(replacement)))
        replaced_ids.add(deck_id)

    for entry in personal_entries:
        deck_id = str(entry["id"])
        if deck_id not in existing_ids and deck_id not in replaced_ids:
            output_decks.append(deepcopy(dict(entry)))

    augmented = deepcopy(dict(catalog))
    augmented["decks"] = output_decks
    return augmented
