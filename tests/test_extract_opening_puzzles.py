from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import chess
import pytest
import zstandard

import scripts.extract_opening_puzzles as opening_extractor

from chess_tracker.opening_puzzle_decks import (
    OPENING_PUZZLE_DECK_ORDER,
    OPENING_PUZZLE_DECKS,
    opening_puzzle_catalog,
    validate_catalog_manifest_path,
)
from scripts.extract_caro_kann_black import (
    ExtractionConfig as LegacyExtractionConfig,
)
from scripts.extract_caro_kann_black import extract_dataset as extract_legacy_dataset
from scripts.extract_opening_puzzles import (
    DEFAULT_OUTPUT_ROOT,
    MultiExtractionConfig,
    RowRejected,
    _resolve_deck_arguments,
    build_record,
    extract_opening_puzzles,
    matched_root_for_tag,
    matching_opening_tags,
    variation_display_name,
)


START_WHITE = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
START_BLACK = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
FIXTURE = Path(__file__).parent / "fixtures" / "sample_opening_puzzles.csv"
CARO_FIXTURE = Path(__file__).parent / "fixtures" / "sample_puzzles.csv"


def _row(*, solver_color: str = "black", **overrides: str) -> dict[str, str]:
    if solver_color == "white":
        row = {
            "PuzzleId": "white-unit",
            "FEN": START_BLACK,
            "Moves": "e7e5 g1f3 b8c6 d2d4",
            "OpeningTags": "Queens_Pawn_Game_Colle_System_Traditional_Colle",
        }
    else:
        row = {
            "PuzzleId": "black-unit",
            "FEN": START_WHITE,
            "Moves": "e2e4 c7c6 d2d4 d7d5",
            "OpeningTags": "Caro-Kann_Defense_Advance_Variation",
        }
    row.update(
        {
            "Rating": "1600",
            "RatingDeviation": "75",
            "Popularity": "90",
            "NbPlays": "500",
            "Themes": "fork opening short",
            "GameUrl": "https://lichess.org/unit#12",
            "DailyDate": "2026-08-03",
        }
    )
    row.update(overrides)
    return row


def _reject(deck_id: str, **overrides: str) -> str:
    deck = OPENING_PUZZLE_DECKS[deck_id]
    with pytest.raises(RowRejected) as caught:
        build_record(_row(solver_color=deck.solver_color, **overrides), deck)
    return caught.value.code


def _run(
    output_root: Path,
    *,
    input_path: Path = FIXTURE,
    deck_ids: tuple[str, ...] = OPENING_PUZZLE_DECK_ORDER,
    **overrides,
) -> dict:
    options = {
        "input_path": str(input_path),
        "deck_ids": deck_ids,
        "output_root": output_root,
        "balanced_limit": None,
        "max_per_variation": None,
        "chunk_size": 2,
        "progress_every": 0,
    }
    options.update(overrides)
    return extract_opening_puzzles(MultiExtractionConfig(**options))


def test_white_solver_applies_black_setup_and_replays_complete_line():
    record = build_record(_row(solver_color="white"), "colle-white")
    original = chess.Board(record["originalFen"])
    assert original.turn == chess.BLACK
    setup = chess.Move.from_uci(record["setupMoveUci"])
    assert original.san(setup) == record["setupMoveSan"] == "e5"
    original.push(setup)
    assert original.fen() == record["puzzleFen"]
    assert original.turn == chess.WHITE
    assert record["solutionUci"] == ["g1f3", "b8c6", "d2d4"]
    assert record["solutionSan"] == ["Nf3", "Nc6", "d4"]
    assert record["solverColor"] == record["sideToMove"] == "white"
    assert record["orientation"] == "white"
    assert record["solutionSteps"][0]["opponentReplyUci"] == "b8c6"
    assert record["solutionSteps"][1]["opponentReplyUci"] is None


def test_white_solver_rejects_original_white_turn():
    assert (
        _reject("colle-white", FEN=START_WHITE)
        == "wrongOriginalSideToMove"
    )


def test_black_solver_applies_white_setup_and_replays_complete_line():
    record = build_record(_row(), "caro-kann-black")
    original = chess.Board(record["originalFen"])
    assert original.turn == chess.WHITE
    original.push_uci(record["setupMoveUci"])
    assert original.fen() == record["puzzleFen"]
    assert original.turn == chess.BLACK
    assert record["solutionUci"] == ["c7c6", "d2d4", "d7d5"]
    assert record["solverColor"] == record["sideToMove"] == "black"
    assert record["orientation"] == "black"


def test_black_solver_rejects_original_black_turn():
    assert (
        _reject("caro-kann-black", FEN=START_BLACK)
        == "wrongOriginalSideToMove"
    )


def test_white_mate_in_one_preserves_every_mating_move_and_exact_fen():
    record = build_record(
        _row(
            solver_color="white",
            FEN="rn3rk1/ppp2p2/2q3bQ/3pB3/3P4/2b5/P3PPPP/R2K1B1R b - - 2 17",
            Moves="c3d4 h6h8",
            Themes="mate mateIn1 oneMove",
        ),
        "colle-white",
    )
    assert record["acceptedMatingMovesUci"] == ["h6g7", "h6h8"]
    step = record["solutionSteps"][0]
    assert set(step["acceptedMovePostFens"]) == {"h6g7", "h6h8"}
    for uci, fen in step["acceptedMovePostFens"].items():
        board = chess.Board(step["fenBefore"])
        board.push_uci(uci)
        assert board.fen() == fen
        assert board.is_checkmate()


@pytest.mark.parametrize(
    ("deck_id", "tag"),
    [
        ("colle-white", "Queens_Pawn_Game_Colle_System"),
        ("colle-white", "Indian_Defense_Colle_System_Kings_Indian_Variation"),
        ("colle-white", "Colle_System_Pterodactyl_Variation"),
        ("london-white", "Queens_Pawn_Game_London_System"),
        ("london-white", "Queens_Pawn_Game_Accelerated_London_System"),
        ("london-white", "Indian_Defense_London_System"),
        ("london-white", "Indian_Defense_Accelerated_London_System"),
        ("london-white", "London_System_Poisoned_Pawn_Variation"),
        ("englund-white", "Englund_Gambit"),
        ("englund-white", "Englund_Gambit_Declined"),
        ("pirc-black", "Pirc_Defense_Austrian_Attack"),
        ("modern-black", "Modern_Defense"),
        ("modern-black", "Queens_Pawn_Game_Modern_Defense"),
    ],
)
def test_authoritative_exact_and_descendant_tags_are_accepted(
    deck_id: str, tag: str
):
    deck = OPENING_PUZZLE_DECKS[deck_id]
    assert matching_opening_tags(tag, deck) == [tag]


@pytest.mark.parametrize(
    ("deck_id", "tag"),
    [
        ("colle-white", "Queens_Pawn_Game_Zukertort_Variation"),
        ("colle-white", "Rubinstein_Opening"),
        ("london-white", "Grob_Opening_London_Defense"),
        ("london-white", "Queens_Pawn_Game_Jobava_London_System"),
        ("london-white", "Queens_Pawn_Game_Rapport_Jobava_System"),
        ("englund-white", "Queens_Pawn_Game"),
        ("pirc-black", "Rat_Defense"),
        ("pirc-black", "Modern_Defense"),
        ("modern-black", "Kings_Gambit_Accepted_Modern_Defense"),
        ("modern-black", "Hungarian_Opening_Reversed_Modern_Defense"),
        ("modern-black", "Robatsch_Defense"),
        ("caro-kann-black", "Caro-Kann_Defensive_System"),
    ],
)
def test_nearby_middle_substring_and_inactive_alias_tags_are_rejected(
    deck_id: str, tag: str
):
    assert matching_opening_tags(tag, OPENING_PUZZLE_DECKS[deck_id]) == []


def test_most_specific_tag_and_matched_root_are_deterministic():
    deck = OPENING_PUZZLE_DECKS["colle-white"]
    tags = (
        "Colle_System_Pterodactyl_Variation "
        "Queens_Pawn_Game_Colle_System "
        "Queens_Pawn_Game_Colle_System_Traditional_Colle"
    )
    matches = matching_opening_tags(tags, deck)
    assert matches == [
        "Queens_Pawn_Game_Colle_System_Traditional_Colle",
        "Colle_System_Pterodactyl_Variation",
        "Queens_Pawn_Game_Colle_System",
    ]
    assert matched_root_for_tag(matches[0], deck) == "Queens_Pawn_Game_Colle_System"


def test_deck_specific_variation_labels_flatten_configured_roots():
    colle = OPENING_PUZZLE_DECKS["colle-white"]
    london = OPENING_PUZZLE_DECKS["london-white"]
    modern = OPENING_PUZZLE_DECKS["modern-black"]
    assert variation_display_name(
        "Indian_Defense_Colle_System_Kings_Indian_Variation",
        "Indian_Defense_Colle_System",
        colle,
    ) == "Colle System: Kings Indian Variation"
    assert variation_display_name(
        "London_System_Poisoned_Pawn_Variation",
        "London_System",
        london,
    ) == "London System: Poisoned Pawn Variation"
    assert variation_display_name(
        "Queens_Pawn_Game_Modern_Defense",
        "Queens_Pawn_Game_Modern_Defense",
        modern,
    ) == "Modern Defense: Queen’s Pawn Move Order"


def test_one_scan_routes_records_independently_to_all_six_decks(tmp_path: Path):
    root = tmp_path / "data"
    result = _run(root)
    expected_valid = {
        "caro-kann-black": 2,
        "colle-white": 1,
        "london-white": 0,
        "englund-white": 1,
        "pirc-black": 2,
        "modern-black": 2,
    }
    assert list(result["manifests"]) == list(OPENING_PUZZLE_DECK_ORDER)
    for deck_id, valid_count in expected_valid.items():
        manifest = result["manifests"][deck_id]
        deck = OPENING_PUZZLE_DECKS[deck_id]
        assert manifest["schemaVersion"] == 2
        assert manifest["counts"]["rowsScanned"] == 6
        assert manifest["counts"]["validRows"] == valid_count
        assert manifest["counts"]["openingMatchedRows"] == valid_count
        assert manifest["counts"]["perspectiveMatchedRows"] == valid_count
        assert manifest["solverColor"] == manifest["orientation"] == deck.solver_color
        assert manifest["openingTagRoots"] == list(deck.opening_tag_roots)
        assert manifest["inputByteSize"] == FIXTURE.stat().st_size
        assert manifest["inputSha256"] == hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
        assert manifest["selectionIndex"] == "selection-index.json"
        assert len(manifest["datasetVersion"]) == 64
        assert set(manifest["datasetVersion"]) <= set("0123456789abcdef")

        selection_index = json.loads(
            (root / deck_id / "selection-index.json").read_text()
        )
        assert selection_index["schemaVersion"] == 1
        assert selection_index["deckId"] == deck_id
        assert selection_index["datasetVersion"] == manifest["datasetVersion"]
        assert selection_index["count"] == manifest["counts"]["balancedExported"]
        assert len(selection_index["entries"]) == selection_index["count"]
        chunk_records = [
            json.loads((root / deck_id / chunk["path"]).read_text())
            for chunk in manifest["chunks"]
        ]
        indexed_ids = []
        for entry in selection_index["entries"]:
            assert set(entry) == {
                "id",
                "chunkIndex",
                "chunkOffset",
                "variation",
                "difficulty",
                "rating",
                "provenance",
                "themes",
                "primaryTheme",
                "isOpeningPuzzle",
                "solutionLength",
                "solverDecisionCount",
                "tacticalSignature",
            }
            indexed = chunk_records[entry["chunkIndex"]][entry["chunkOffset"]]
            indexed_ids.append(indexed["id"])
            assert entry["id"] == indexed["id"]
            assert entry["variation"] == indexed["variation"]
            assert entry["difficulty"] == indexed["difficulty"]
            assert entry["rating"] == indexed["rating"]
            assert entry["provenance"] == indexed["provenance"]
            assert entry["themes"] == indexed["themes"]
            assert entry["primaryTheme"] == indexed["primaryTacticalTheme"]
            assert entry["isOpeningPuzzle"] == indexed["isOpeningPuzzle"]
            assert entry["solutionLength"] == indexed["solutionLength"]
            assert entry["solverDecisionCount"] == indexed["solverDecisionCount"]
            first_move = chess.Move.from_uci(
                indexed["solutionSteps"][0]["bestMoveUci"]
            )
            indexed_board = chess.Board(indexed["puzzleFen"])
            moving_piece = indexed_board.piece_at(first_move.from_square)
            assert moving_piece is not None
            assert entry["tacticalSignature"] == "|".join((
                indexed["primaryTacticalTheme"],
                str(indexed["solutionLength"]),
                moving_piece.symbol().upper(),
                chess.square_name(first_move.to_square),
            ))
        assert indexed_ids == [record["id"] for chunk in chunk_records for record in chunk]

        records = [
            json.loads(line)
            for line in (root / deck_id / "all.jsonl").read_text().splitlines()
        ]
        assert len(records) == valid_count
        for record in records:
            assert record["deckId"] == deck_id
            assert record["solverColor"] == record["orientation"] == deck.solver_color
            board = chess.Board(record["puzzleFen"])
            assert board.turn == (chess.WHITE if deck.solver_color == "white" else chess.BLACK)
            assert record["setupMoveUci"] not in record["solutionUci"][:1]
            for uci, san in zip(record["solutionUci"], record["solutionSan"], strict=True):
                move = chess.Move.from_uci(uci)
                assert move in board.legal_moves
                assert board.san(move) == san
                board.push(move)

    shared_memberships = []
    for deck_id in OPENING_PUZZLE_DECK_ORDER:
        records = [
            json.loads(line)
            for line in (root / deck_id / "all.jsonl").read_text().splitlines()
        ]
        if any(record["id"] == "shared-black" for record in records):
            shared_memberships.append(deck_id)
    assert shared_memberships == ["caro-kann-black", "pirc-black", "modern-black"]


def test_catalog_is_complete_safe_and_ordered_for_selected_build(tmp_path: Path):
    root = tmp_path / "data"
    selected = ("colle-white", "modern-black")
    _run(root, deck_ids=selected)
    catalog = json.loads((root / "opening-puzzle-catalog.json").read_text())
    assert catalog == opening_puzzle_catalog(selected)
    assert catalog["defaultDeckId"] == "colle-white"
    assert [entry["id"] for entry in catalog["decks"]] == list(selected)
    for entry in catalog["decks"]:
        relative = validate_catalog_manifest_path(entry["manifestPath"])
        assert (root / relative).is_file()


def test_subset_rebuild_preserves_other_complete_schema_v2_catalog_entries(
    tmp_path: Path,
):
    root = tmp_path / "data"
    _run(root)
    result = _run(root, deck_ids=("colle-white",))
    catalog = result["catalog"]
    assert [entry["id"] for entry in catalog["decks"]] == list(
        OPENING_PUZZLE_DECK_ORDER
    )
    assert catalog["defaultDeckId"] == "caro-kann-black"


def test_subset_rebuild_does_not_catalog_an_existing_deck_with_a_missing_index(
    tmp_path: Path,
):
    root = tmp_path / "data"
    _run(root)
    (root / "modern-black" / "selection-index.json").unlink()

    result = _run(root, deck_ids=("colle-white",))

    catalog_ids = [entry["id"] for entry in result["catalog"]["decks"]]
    assert "colle-white" in catalog_ids
    assert "modern-black" not in catalog_ids


@pytest.mark.parametrize(
    "unsafe",
    [
        "/tmp/manifest.json",
        "../deck/manifest.json",
        "deck\\manifest.json",
        "deck/data.json",
        "deck//manifest.json",
        " deck/manifest.json",
        "deck/manifest.json?raw=1",
    ],
)
def test_catalog_manifest_paths_reject_unsafe_values(unsafe: str):
    with pytest.raises(ValueError):
        validate_catalog_manifest_path(unsafe)


def test_balancing_is_deterministic_per_deck(tmp_path: Path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    _run(first, balanced_limit=1)
    _run(second, balanced_limit=1)
    for deck_id in OPENING_PUZZLE_DECK_ORDER:
        assert (first / deck_id / "balanced.jsonl").read_bytes() == (
            second / deck_id / "balanced.jsonl"
        ).read_bytes()
        assert (first / deck_id / "selection-index.json").read_bytes() == (
            second / deck_id / "selection-index.json"
        ).read_bytes()


def test_dataset_version_includes_ordered_chunk_locators(tmp_path: Path):
    one_per_chunk = tmp_path / "one-per-chunk"
    two_per_chunk = tmp_path / "two-per-chunk"
    first = _run(
        one_per_chunk,
        deck_ids=("caro-kann-black",),
        chunk_size=1,
    )
    second = _run(
        two_per_chunk,
        deck_ids=("caro-kann-black",),
        chunk_size=2,
    )

    first_manifest = first["manifests"]["caro-kann-black"]
    second_manifest = second["manifests"]["caro-kann-black"]
    assert first_manifest["counts"]["balancedExported"] == 2
    assert second_manifest["counts"]["balancedExported"] == 2
    assert first_manifest["datasetVersion"] != second_manifest["datasetVersion"]


def test_generated_selection_index_passes_static_deployment_validation(
    tmp_path: Path,
):
    from refresh import sync_opening_puzzle_web_data

    root = tmp_path / "data"
    _run(root, deck_ids=("colle-white",))
    dashboard = tmp_path / "dashboard"

    result = sync_opening_puzzle_web_data(root, dashboard)

    assert result["decks"] == 1
    assert (
        dashboard / "data" / "colle-white" / "selection-index.json"
    ).read_bytes() == (root / "colle-white" / "selection-index.json").read_bytes()


def test_generic_caro_selection_order_matches_legacy_algorithm(tmp_path: Path):
    legacy_root = tmp_path / "legacy"
    generic_root = tmp_path / "generic"
    legacy_manifest = extract_legacy_dataset(
        LegacyExtractionConfig(
            input_path=str(CARO_FIXTURE),
            output_path=legacy_root,
            balanced_limit=2,
            max_per_variation=1,
            chunk_size=2,
            progress_every=0,
        )
    )
    generic = _run(
        generic_root,
        input_path=CARO_FIXTURE,
        deck_ids=("caro-kann-black",),
        balanced_limit=2,
        max_per_variation=1,
    )
    legacy_ids = [
        json.loads(line)["id"]
        for line in (legacy_root / "balanced.jsonl").read_text().splitlines()
    ]
    generic_ids = [
        json.loads(line)["id"]
        for line in (
            generic_root / "caro-kann-black" / "balanced.jsonl"
        ).read_text().splitlines()
    ]
    assert generic_ids == legacy_ids
    generic_manifest = generic["manifests"]["caro-kann-black"]
    assert generic_manifest["counts"]["caroKannRows"] == legacy_manifest["counts"]["caroKannRows"]
    assert generic_manifest["counts"]["blackToSolveRows"] == legacy_manifest["counts"]["blackToSolveRows"]


def test_duplicate_ids_are_rejected_within_each_matching_deck(tmp_path: Path):
    source = tmp_path / "duplicates.csv"
    header, first, *_ = FIXTURE.read_text().splitlines()
    source.write_text("\n".join((header, first, first)) + "\n")
    root = tmp_path / "data"
    result = _run(
        root,
        input_path=source,
        deck_ids=("caro-kann-black",),
    )
    manifest = result["manifests"]["caro-kann-black"]
    assert manifest["counts"]["validRows"] == 1
    summary = json.loads(
        (root / "caro-kann-black" / "rejections-summary.json").read_text()
    )
    assert summary["counts"]["duplicateId"] == 1


def test_debug_rejections_include_deck_id(tmp_path: Path):
    debug = tmp_path / "rejections.jsonl"
    _run(tmp_path / "data", debug_rejections=debug)
    rejected = [json.loads(line) for line in debug.read_text().splitlines()]
    assert rejected
    assert {item["deckId"] for item in rejected} == set(OPENING_PUZZLE_DECK_ORDER)


def test_input_is_opened_for_streaming_only_once_for_all_decks(
    monkeypatch, tmp_path: Path
):
    calls = 0
    original_open_input = opening_extractor._open_input

    @contextmanager
    def counted_open_input(path: str):
        nonlocal calls
        calls += 1
        with original_open_input(path) as stream:
            yield stream

    monkeypatch.setattr(opening_extractor, "_open_input", counted_open_input)
    _run(tmp_path / "data")
    assert calls == 1


def test_headerless_and_zstandard_inputs_use_generic_multi_deck_path(
    tmp_path: Path,
):
    lines = FIXTURE.read_text().splitlines()
    headerless = tmp_path / "one.csv"
    headerless.write_text(lines[1] + "\n")
    headerless_result = _run(
        tmp_path / "headerless",
        input_path=headerless,
        deck_ids=("caro-kann-black",),
    )
    assert (
        headerless_result["manifests"]["caro-kann-black"]["counts"]["validRows"]
        == 1
    )

    compressed = tmp_path / "all.csv.zst"
    compressed.write_bytes(zstandard.ZstdCompressor().compress(FIXTURE.read_bytes()))
    compressed_result = _run(tmp_path / "compressed", input_path=compressed)
    assert compressed_result["manifests"]["colle-white"]["counts"]["validRows"] == 1
    assert compressed_result["manifests"]["modern-black"]["counts"]["validRows"] == 2


def test_validate_only_writes_no_output(tmp_path: Path):
    root = tmp_path / "must-not-exist"
    result = extract_opening_puzzles(
        MultiExtractionConfig(
            input_path=str(FIXTURE),
            deck_ids=("colle-white", "englund-white"),
            output_root=None,
            validate_only=True,
            progress_every=0,
        )
    )
    assert result["valid"] is True
    assert set(result["decks"]) == {"colle-white", "englund-white"}
    assert not root.exists()


def test_partial_publish_requires_noncanonical_output_root(tmp_path: Path):
    with pytest.raises(ValueError, match="scan-limit"):
        extract_opening_puzzles(
            MultiExtractionConfig(
                input_path=str(FIXTURE),
                deck_ids=("caro-kann-black",),
                output_root=DEFAULT_OUTPUT_ROOT,
                scan_limit=1,
                progress_every=0,
            )
        )
    result = _run(
        tmp_path / "dev-data",
        deck_ids=("caro-kann-black",),
        scan_limit=1,
    )
    manifest = result["manifests"]["caro-kann-black"]
    assert manifest["scanComplete"] is False
    assert manifest["truncated"] is True


def test_deck_cli_resolution_is_canonical_and_rejects_mixed_all():
    assert _resolve_deck_arguments(None) == OPENING_PUZZLE_DECK_ORDER
    assert _resolve_deck_arguments(["modern-black", "colle-white"]) == (
        "colle-white",
        "modern-black",
    )
    with pytest.raises(ValueError):
        _resolve_deck_arguments(["all", "colle-white"])


def test_documented_cli_entry_point_runs_directly(tmp_path: Path):
    output = tmp_path / "cli-data"
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/extract_opening_puzzles.py",
            "--input",
            str(FIXTURE),
            "--deck",
            "colle-white",
            "--output-root",
            str(output),
            "--balanced-limit",
            "2",
            "--progress-every",
            "0",
        ],
        cwd=Path(__file__).parents[1],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert list(result["manifests"]) == ["colle-white"]
    assert (output / "opening-puzzle-catalog.json").is_file()


def test_legacy_caro_cli_rebuilds_schema_v2_at_the_existing_output_path(
    tmp_path: Path,
):
    output = tmp_path / "data" / "caro-kann-black"
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/extract_caro_kann_black.py",
            "--input",
            str(CARO_FIXTURE),
            "--output",
            str(output),
            "--balanced-limit",
            "2",
            "--max-per-variation",
            "1",
            "--progress-every",
            "0",
        ],
        cwd=Path(__file__).parents[1],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["schemaVersion"] == 2
    assert result["deckId"] == "caro-kann-black"
    assert json.loads((output / "manifest.json").read_text()) == result
    catalog = json.loads(
        (output.parent / "opening-puzzle-catalog.json").read_text()
    )
    assert [entry["id"] for entry in catalog["decks"]] == ["caro-kann-black"]


def test_legacy_caro_cli_preserves_custom_development_output_name(tmp_path: Path):
    output = tmp_path / "caro-kann-black-dev"
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/extract_caro_kann_black.py",
            "--input",
            str(CARO_FIXTURE),
            "--output",
            str(output),
            "--scan-limit",
            "2",
            "--progress-every",
            "0",
        ],
        cwd=Path(__file__).parents[1],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["schemaVersion"] == 2
    assert manifest["scanLimit"] == 2
    assert manifest["truncated"] is True
    assert not (tmp_path / "caro-kann-black").exists()
