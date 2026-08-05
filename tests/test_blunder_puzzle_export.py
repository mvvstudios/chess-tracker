import json

import pytest

from chess_tracker.blunder_puzzle_export import (
    MY_BLUNDER_DECK_IDS,
    augment_opening_puzzle_catalog,
    blunder_deck_catalog_entries,
    write_my_blunder_puzzle_export,
)


EXPECTED_PERSONAL_DECKS = [
    {
        "id": "my-blunders-all",
        "label": "My Blunders — ALL",
        "openingFamily": "My Blunders — ALL",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": None,
        "solverColor": "mixed",
        "orientation": "mixed",
    },
    {
        "id": "my-blunders-colle",
        "label": "My Blunders — Colle System",
        "openingFamily": "My Blunders — Colle System",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": "colle-white",
        "solverColor": "white",
        "orientation": "white",
    },
    {
        "id": "my-blunders-pirc",
        "label": "My Blunders — Pirc Defense",
        "openingFamily": "My Blunders — Pirc Defense",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": "pirc-black",
        "solverColor": "black",
        "orientation": "black",
    },
    {
        "id": "my-blunders-englund",
        "label": "My Blunders — Englund Gambit",
        "openingFamily": "My Blunders — Englund Gambit",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": "englund-white",
        "solverColor": "white",
        "orientation": "white",
    },
    {
        "id": "my-blunders-modern",
        "label": "My Blunders — Modern Defense",
        "openingFamily": "My Blunders — Modern Defense",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": "modern-black",
        "solverColor": "black",
        "orientation": "black",
    },
    {
        "id": "my-blunders-caro-kann",
        "label": "My Blunders — Caro-Kann Defense",
        "openingFamily": "My Blunders — Caro-Kann Defense",
        "sourceKind": "personal-blunders",
        "dataPath": "my-blunder-puzzles.json",
        "progressScope": "personal",
        "repertoireDeckId": "caro-kann-black",
        "solverColor": "black",
        "orientation": "black",
    },
]


def _opening_catalog():
    return {
        "schemaVersion": 1,
        "defaultDeckId": "caro-kann-black",
        "release": {"channel": "test"},
        "decks": [
            {
                "id": "caro-kann-black",
                "label": "Caro-Kann Defense — Black",
                "manifestPath": "caro-kann-black/manifest.json",
            },
            {
                "id": "colle-white",
                "label": "Colle System — White",
                "manifestPath": "colle-white/manifest.json",
            },
        ],
    }


def test_personal_deck_descriptors_are_ordered_exact_and_deep_safe():
    first = blunder_deck_catalog_entries()
    second = blunder_deck_catalog_entries()

    assert first == EXPECTED_PERSONAL_DECKS
    assert MY_BLUNDER_DECK_IDS == tuple(deck["id"] for deck in EXPECTED_PERSONAL_DECKS)

    first[0]["label"] = "changed"
    first.append({"id": "extra"})
    assert second == EXPECTED_PERSONAL_DECKS
    assert blunder_deck_catalog_entries() == EXPECTED_PERSONAL_DECKS


def test_writer_creates_an_atomic_standalone_export(tmp_path):
    catalog = {
        "candidates": [{"puzzle_id": "puzzle-123", "opponent_name": "José"}],
        "coverage": {"eligible_candidates": 1},
        "errors": [],
    }
    destination = tmp_path / "dashboard" / "data" / "my-blunder-puzzles.json"

    result = write_my_blunder_puzzle_export(
        catalog,
        "M_V-V",
        destination,
        "2026-08-05T04:00:00Z",
    )

    expected = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-05T04:00:00Z",
        "username": "M_V-V",
        "catalog": json.loads(json.dumps(catalog)),
    }
    assert result == expected
    assert json.loads(destination.read_text()) == expected
    assert destination.read_text().endswith("\n")
    assert list(destination.parent.glob(".*.tmp")) == []

    catalog["candidates"][0]["puzzle_id"] = "changed-after-write"
    result["catalog"]["coverage"]["eligible_candidates"] = 99
    assert json.loads(destination.read_text()) == expected


@pytest.mark.parametrize(
    ("catalog", "message"),
    [
        ({"candidates": [], "coverage": {}}, "errors must be a list"),
        ({"candidates": {}, "coverage": {}, "errors": []}, "candidates must be a list"),
        ({"candidates": [], "coverage": [], "errors": []}, "coverage must be an object"),
    ],
)
def test_writer_rejects_an_invalid_puzzle_catalog(tmp_path, catalog, message):
    with pytest.raises(ValueError, match=message):
        write_my_blunder_puzzle_export(
            catalog,
            "M_V-V",
            tmp_path / "export.json",
            "2026-08-05T04:00:00Z",
        )


def test_augment_appends_personal_decks_without_mutating_existing_catalog():
    catalog = _opening_catalog()
    original = json.loads(json.dumps(catalog))

    augmented = augment_opening_puzzle_catalog(catalog)

    assert catalog == original
    assert augmented["defaultDeckId"] == "caro-kann-black"
    assert augmented["release"] == {"channel": "test"}
    assert augmented["decks"][:2] == original["decks"]
    assert augmented["decks"][2:] == EXPECTED_PERSONAL_DECKS

    augmented["decks"][0]["label"] = "changed"
    augmented["release"]["channel"] = "changed"
    assert catalog == original


def test_augment_replaces_personal_descriptor_in_place_and_appends_missing_ones():
    catalog = _opening_catalog()
    catalog["decks"].insert(
        1,
        {
            "id": "my-blunders-all",
            "label": "Old label",
            "sourceKind": "personal-blunders",
        },
    )

    augmented = augment_opening_puzzle_catalog(catalog)

    assert [deck["id"] for deck in augmented["decks"][:3]] == [
        "caro-kann-black",
        "my-blunders-all",
        "colle-white",
    ]
    assert augmented["decks"][1] == EXPECTED_PERSONAL_DECKS[0]
    assert augmented["decks"][3:] == EXPECTED_PERSONAL_DECKS[1:]


def test_augment_refuses_to_replace_an_ordinary_deck_on_id_collision():
    catalog = _opening_catalog()
    catalog["decks"][0]["id"] = "my-blunders-all"
    catalog["defaultDeckId"] = "my-blunders-all"

    with pytest.raises(ValueError, match="refusing to replace non-personal"):
        augment_opening_puzzle_catalog(catalog)


def test_augment_validates_default_and_personal_descriptor_contract():
    catalog = _opening_catalog()
    catalog["defaultDeckId"] = "missing"
    with pytest.raises(ValueError, match="defaultDeckId"):
        augment_opening_puzzle_catalog(catalog)

    invalid = blunder_deck_catalog_entries()
    invalid[0]["orientation"] = "white"
    with pytest.raises(ValueError, match="orientation must equal solverColor"):
        augment_opening_puzzle_catalog(_opening_catalog(), invalid)

    catalog = _opening_catalog()
    catalog["schemaVersion"] = 0
    with pytest.raises(ValueError, match="positive integer schemaVersion"):
        augment_opening_puzzle_catalog(catalog)
