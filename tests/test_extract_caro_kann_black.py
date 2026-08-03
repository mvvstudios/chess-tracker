from __future__ import annotations

import json
import io
import hashlib
from pathlib import Path

import chess
import pytest
import zstandard

from scripts.extract_caro_kann_black import (
    ExtractionConfig,
    DEFAULT_OUTPUT_PATH,
    RowRejected,
    build_record,
    caro_kann_tokens,
    classify_provenance,
    difficulty_for_rating,
    extract_dataset,
    variation_display_name,
    variation_slug,
)


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
FIXTURE = Path(__file__).parent / "fixtures" / "sample_puzzles.csv"


def _row(**overrides: str) -> dict[str, str]:
    row = {
        "PuzzleId": "unit-puzzle",
        "FEN": START_FEN,
        "Moves": "e2e4 c7c6 d2d4 d7d5 b1c3",
        "Rating": "1600",
        "RatingDeviation": "75",
        "Popularity": "90",
        "NbPlays": "500",
        "Themes": "fork opening short",
        "GameUrl": "https://lichess.org/unit#12",
        "OpeningTags": "Caro-Kann_Defense_Advance_Variation",
        "DailyDate": "2026-08-03",
    }
    row.update(overrides)
    return row


def _rejection_code(**overrides: str) -> str:
    with pytest.raises(RowRejected) as caught:
        build_record(_row(**overrides))
    return caught.value.code


def test_white_setup_reaches_black_position_and_preserves_complete_line():
    record = build_record(_row())

    original = chess.Board(record["originalFen"])
    assert original.turn == chess.WHITE
    setup = chess.Move.from_uci(record["setupMoveUci"])
    assert original.san(setup) == record["setupMoveSan"] == "e4"
    original.push(setup)
    assert original.fen() == record["puzzleFen"]
    assert original.turn == chess.BLACK
    assert record["sideToMove"] == record["orientation"] == "black"
    assert "variationSlug" not in record

    # The setup move is excluded. Black decisions are steps 0 and 2; the final
    # stored White reply is retained on the second interactive step.
    assert record["solutionUci"] == ["c7c6", "d2d4", "d7d5", "b1c3"]
    assert record["solutionSan"] == ["c6", "d4", "d5", "Nc3"]
    assert record["blackDecisionCount"] == 2
    assert record["solutionSteps"][0]["bestMoveUci"] == "c7c6"
    assert record["solutionSteps"][0]["opponentReplyUci"] == "d2d4"
    assert record["solutionSteps"][1]["bestMoveUci"] == "d7d5"
    assert record["solutionSteps"][1]["opponentReplyUci"] == "b1c3"
    assert record["solutionSteps"][1]["postReplyFen"] is not None


def test_every_solution_move_replays_legally_and_san_is_pre_push():
    record = build_record(_row())
    board = chess.Board(record["puzzleFen"])
    for uci, expected_san in zip(record["solutionUci"], record["solutionSan"], strict=True):
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        assert board.san(move) == expected_san
        board.push(move)


def test_original_black_turn_is_rejected():
    black_fen = START_FEN.replace(" w ", " b ")
    assert _rejection_code(FEN=black_fen, Moves="e7e5 g1f3") == "wrongOriginalSideToMove"


def test_generic_and_specific_caro_kann_tags_are_accepted():
    generic = build_record(_row(OpeningTags="Caro-Kann_Defense"))
    specific = build_record(
        _row(OpeningTags="Caro-Kann_Defense_Alien_Gambit unrelated")
    )

    assert generic["variation"] == "Caro-Kann Defense"
    assert specific["variation"] == "Caro-Kann Defense: Alien Gambit"
    assert specific["variationTag"] == "Caro-Kann_Defense_Alien_Gambit"


def test_longest_matching_token_is_primary_and_all_tags_are_preserved():
    tags = (
        "opening Caro-Kann_Defense "
        "Caro-Kann_Defense_Bronstein-Larsen_Variation"
    )
    record = build_record(_row(OpeningTags=tags))

    assert caro_kann_tokens(tags)[0] == "Caro-Kann_Defense_Bronstein-Larsen_Variation"
    assert record["variation"] == "Caro-Kann Defense: Bronstein-Larsen Variation"
    assert record["openingTags"] == tags.split()


@pytest.mark.parametrize(
    ("opening_tags", "expected"),
    [
        ("Sicilian_Defense", "missingCaroKannTag"),
        ("NotCaro-Kann_Defense", "missingCaroKannTag"),
        ("Caro-Kann_Defensive_System", "missingCaroKannTag"),
    ],
)
def test_non_caro_or_loose_substrings_are_rejected(opening_tags: str, expected: str):
    assert _rejection_code(OpeningTags=opening_tags) == expected


def test_illegal_setup_and_solution_are_categorized():
    assert _rejection_code(Moves="e2e5 c7c6") == "illegalSetupMove"
    assert _rejection_code(Moves="e2e4 e7e4") == "illegalSolutionMove"
    assert _rejection_code(Moves="e2e4") == "missingMoves"


@pytest.mark.parametrize(
    ("rating", "expected"),
    [
        (0, "beginner"),
        (1199, "beginner"),
        (1200, "developing"),
        (1599, "developing"),
        (1600, "intermediate"),
        (1999, "intermediate"),
        (2000, "advanced"),
        (2399, "advanced"),
        (2400, "expert"),
        (3000, "expert"),
    ],
)
def test_difficulty_boundaries(rating: int, expected: str):
    assert difficulty_for_rating(rating) == expected


@pytest.mark.parametrize(
    ("themes", "expected"),
    [
        ([], "standard"),
        (["master"], "master"),
        (["master", "masterVsMaster"], "masterVsMaster"),
        (["master", "masterVsMaster", "superGM"], "superGM"),
    ],
)
def test_provenance_priority(themes: list[str], expected: str):
    assert classify_provenance(themes) == expected


def test_provenance_flags_follow_original_themes():
    record = build_record(_row(Themes="master superGM opening"))
    assert record["provenance"] == "superGM"
    assert record["isSuperGM"] is True
    assert record["isMasterGame"] is True
    assert record["isMasterVsMaster"] is False
    assert record["isOpeningPuzzle"] is True


def test_mate_in_one_accepts_every_immediate_mating_move():
    record = build_record(
        _row(
            FEN="r2k1b1r/p3pppp/2B5/3p4/3Pb3/2Q3Bq/PPP2P2/RN3RK1 w - - 2 17",
            Moves="c6d5 h3h1",
            Themes="mate mateIn1 oneMove",
        )
    )

    assert record["acceptedMatingMovesUci"] == ["h3g2", "h3h1"]
    first_step = record["solutionSteps"][0]
    assert first_step["acceptedMovesUci"] == ["h3g2", "h3h1"]
    assert set(first_step["acceptedMovePostFens"]) == set(first_step["acceptedMovesUci"])
    assert record["acceptedMovePostFens"] == first_step["acceptedMovePostFens"]
    assert first_step["acceptedMovePostFens"]["h3h1"] == first_step["postBestFen"]
    for uci, resulting_fen in first_step["acceptedMovePostFens"].items():
        board = chess.Board(first_step["fenBefore"])
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        board.push(move)
        assert board.fen() == resulting_fen
        assert board.is_checkmate()


def test_every_solution_step_maps_each_accepted_move_to_its_exact_fen():
    record = build_record(_row())
    for step in record["solutionSteps"]:
        assert set(step["acceptedMovePostFens"]) == set(step["acceptedMovesUci"])
        for uci, resulting_fen in step["acceptedMovePostFens"].items():
            board = chess.Board(step["fenBefore"])
            move = chess.Move.from_uci(uci)
            assert move in board.legal_moves
            board.push(move)
            assert board.fen() == resulting_fen
        assert step["acceptedMovePostFens"][step["bestMoveUci"]] == step["postBestFen"]


def test_variation_names_and_slugs_are_readable_stable_and_safe():
    tag = "Caro-Kann_Defense_Bronstein-Larsen_Variation"
    assert variation_display_name(tag) == "Caro-Kann Defense: Bronstein-Larsen Variation"
    assert variation_slug(tag) == "caro-kann-defense-bronstein-larsen-variation"
    assert variation_slug(tag) == variation_slug(tag)


def _run_fixture(output: Path, **overrides) -> dict:
    options = {
        "input_path": str(FIXTURE),
        "output_path": output,
        "balanced_limit": None,
        "max_per_variation": None,
        "min_popularity": 0,
        "min_plays": 20,
        "max_rating_deviation": 150,
        "seed": 20260803,
        "chunk_size": 2,
        "progress_every": 0,
    }
    options.update(overrides)
    return extract_dataset(ExtractionConfig(**options))


def test_fixture_scan_isolates_duplicates_and_malformed_rows(tmp_path: Path):
    output = tmp_path / "dataset"
    manifest = _run_fixture(output)
    counts = manifest["counts"]

    assert counts == {
        "rowsScanned": 9,
        "caroKannRows": 6,
        "blackToSolveRows": 4,
        "validRows": 3,
        "invalidRows": 6,
        "allExported": 3,
        "balancedExported": 3,
    }
    rejections = json.loads((output / "rejections-summary.json").read_text())
    assert rejections["counts"]["duplicateId"] == 1
    assert rejections["counts"]["invalidCsvRow"] == 1
    assert rejections["counts"]["missingCaroKannTag"] == 1
    assert rejections["counts"]["wrongOriginalSideToMove"] == 1
    assert rejections["counts"]["illegalSetupMove"] == 1
    assert rejections["counts"]["illegalSolutionMove"] == 1


def test_output_json_jsonl_chunks_and_manifest_counts(tmp_path: Path):
    output = tmp_path / "dataset"
    manifest = _run_fixture(output)
    all_records = [json.loads(line) for line in (output / "all.jsonl").read_text().splitlines()]
    balanced_records = [
        json.loads(line) for line in (output / "balanced.jsonl").read_text().splitlines()
    ]

    assert len(all_records) == len(balanced_records) == 3
    assert all(chess.Board(record["puzzleFen"]).turn == chess.BLACK for record in all_records)
    assert manifest["solverColor"] == manifest["orientation"] == "black"
    assert manifest["scanLimit"] is None
    assert manifest["scanComplete"] is True
    assert manifest["truncated"] is False
    assert manifest["inputKind"] == "file"
    assert manifest["inputByteSize"] == FIXTURE.stat().st_size
    assert manifest["inputSha256"] == hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    assert manifest["inputSha256Scope"] == "complete-file-bytes"
    assert manifest["chunks"] == [
        {"path": "chunks/chunk-0001.json", "count": 2},
        {"path": "chunks/chunk-0002.json", "count": 1},
    ]
    chunk_records = []
    for chunk in manifest["chunks"]:
        chunk_records.extend(json.loads((output / chunk["path"]).read_text()))
    assert chunk_records == balanced_records
    assert sum(manifest["difficultyCounts"].values()) == 3
    assert sum(manifest["variationCounts"].values()) == 3
    assert sum(manifest["provenanceCounts"].values()) == 3
    assert (output / "by-difficulty" / "beginner.jsonl").exists()
    assert (output / "by-difficulty" / "developing.jsonl").exists()
    assert (output / "by-variation" / "caro-kann-defense.jsonl").exists()
    assert (output / "by-source" / "super-gm.jsonl").exists()


def test_sampling_is_deterministic_and_variation_cap_is_enforced(tmp_path: Path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    _run_fixture(first, balanced_limit=2, max_per_variation=1)
    _run_fixture(second, balanced_limit=2, max_per_variation=1)

    assert (first / "balanced.jsonl").read_bytes() == (second / "balanced.jsonl").read_bytes()
    selected = [json.loads(line) for line in (first / "balanced.jsonl").read_text().splitlines()]
    assert len(selected) == 2
    assert len({record["variationTag"] for record in selected}) == 2


def test_headerless_and_zstandard_streams_are_supported(tmp_path: Path):
    lines = FIXTURE.read_text().splitlines()
    single_headerless = tmp_path / "one.csv"
    # Ten-field legacy headerless rows and the newer optional DailyDate field
    # are both supported; this deliberately removes the fixture's 11th field.
    single_headerless.write_text(lines[1].rsplit(",", 1)[0] + "\n")
    csv_output = tmp_path / "csv-output"
    csv_manifest = _run_fixture(csv_output, input_path=str(single_headerless))
    assert csv_manifest["counts"]["validRows"] == 1

    compressed = tmp_path / "one.csv.zst"
    compressed.write_bytes(zstandard.ZstdCompressor().compress(FIXTURE.read_bytes()))
    zst_output = tmp_path / "zst-output"
    zst_manifest = _run_fixture(zst_output, input_path=str(compressed))
    assert zst_manifest["counts"]["validRows"] == 3


def test_uncompressed_standard_input_is_streamed(monkeypatch, tmp_path: Path):
    header, valid, *_rest = FIXTURE.read_text().splitlines()
    monkeypatch.setattr("sys.stdin", io.StringIO(header + "\n" + valid + "\n"))

    output = tmp_path / "stdin-output"
    manifest = _run_fixture(output, input_path="-")
    assert manifest["counts"]["rowsScanned"] == 1
    assert manifest["counts"]["validRows"] == 1
    assert manifest["inputFilename"] == "-"


def test_validate_only_writes_no_dataset(tmp_path: Path):
    output = tmp_path / "must-not-exist"
    summary = extract_dataset(
        ExtractionConfig(
            input_path=str(FIXTURE),
            output_path=output,
            balanced_limit=1,
            max_per_variation=None,
            chunk_size=2,
            progress_every=0,
            validate_only=True,
        )
    )
    assert summary["valid"] is True
    assert summary["counts"]["validRows"] == 3
    assert summary["scanLimit"] is None
    assert summary["scanComplete"] is True
    assert summary["truncated"] is False
    assert summary["inputByteSize"] == FIXTURE.stat().st_size
    assert summary["inputSha256"] == hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    assert not output.exists()


def test_debug_rejected_rows_require_explicit_path(tmp_path: Path):
    output = tmp_path / "dataset"
    debug = tmp_path / "rejected.jsonl"
    _run_fixture(output, debug_rejections=debug)

    rejected = [json.loads(line) for line in debug.read_text().splitlines()]
    assert len(rejected) == 6
    assert {item["reason"] for item in rejected} >= {"duplicateId", "invalidCsvRow"}
    assert all("row" in item or "rawLine" in item for item in rejected)


def test_debug_rejections_inside_output_survive_atomic_publish(tmp_path: Path):
    output = tmp_path / "dataset"
    debug = output / "rejected-rows.jsonl"
    _run_fixture(output, debug_rejections=debug)

    rejected = [json.loads(line) for line in debug.read_text().splitlines()]
    assert len(rejected) == 6
    assert {item["reason"] for item in rejected} >= {"duplicateId", "invalidCsvRow"}


@pytest.mark.parametrize(
    "relative_debug_path",
    [
        "manifest.json",
        "Manifest.json",
        "rejections-summary.json",
        "all.jsonl",
        "balanced.jsonl",
        "chunks/debug.jsonl",
        "Chunks/debug.jsonl",
        "by-difficulty/debug.jsonl",
        "by-variation/debug.jsonl",
        "by-source/debug.jsonl",
    ],
)
def test_debug_rejections_cannot_collide_with_generated_outputs(
    tmp_path: Path, relative_debug_path: str
):
    output = tmp_path / "dataset"
    with pytest.raises(ValueError, match="debug-rejections"):
        _run_fixture(
            output,
            debug_rejections=output / relative_debug_path,
        )
    assert not output.exists()


def test_partial_scan_is_explicitly_marked_truncated(tmp_path: Path):
    output = tmp_path / "dataset-dev"
    manifest = _run_fixture(output, scan_limit=2)

    assert manifest["scanLimit"] == 2
    assert manifest["scanComplete"] is False
    assert manifest["truncated"] is True
    assert manifest["counts"]["rowsScanned"] == 2


def test_scan_limit_at_or_above_eof_is_marked_complete(tmp_path: Path):
    output = tmp_path / "dataset-dev"
    manifest = _run_fixture(output, scan_limit=9)

    assert manifest["scanLimit"] == 9
    assert manifest["scanComplete"] is True
    assert manifest["truncated"] is False
    assert manifest["counts"]["rowsScanned"] == 9


def test_validate_only_partial_summary_and_stdin_provenance(
    monkeypatch, tmp_path: Path
):
    header, valid, second, *_rest = FIXTURE.read_text().splitlines()
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO("\n".join((header, valid, second)) + "\n"),
    )
    summary = extract_dataset(
        ExtractionConfig(
            input_path="-",
            output_path=None,
            scan_limit=1,
            progress_every=0,
            validate_only=True,
        )
    )

    assert summary["scanLimit"] == 1
    assert summary["scanComplete"] is False
    assert summary["truncated"] is True
    assert summary["inputKind"] == "stdin"
    assert summary["inputByteSize"] is None
    assert summary["inputSha256"] is None
    assert summary["inputSha256Scope"] is None


def test_scan_limit_cannot_publish_to_canonical_output():
    with pytest.raises(ValueError, match="scan-limit"):
        extract_dataset(
            ExtractionConfig(
                input_path=str(FIXTURE),
                output_path=DEFAULT_OUTPUT_PATH,
                scan_limit=1,
                progress_every=0,
            )
        )
