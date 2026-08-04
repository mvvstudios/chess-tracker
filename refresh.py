"""CLI: pull Chess.com archives → compute metrics → render dashboard."""
import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from pathlib import PurePosixPath

from chess_tracker.api import fetch_archives_index, fetch_archive, fetch_player_stats, fetch_lichess_user
from chess_tracker.pgn import parse_game
from chess_tracker.metrics import compute_all
from chess_tracker.annotations import load_annotations
from chess_tracker.plan import load_plan
from chess_tracker.puzzles import find_engine_path
from chess_tracker.puzzle_queue import build_puzzle_queue
from chess_tracker.analysis import (
    run_move_quality_pass, run_move_quality_by_format, aggregate_move_quality,
    load_quality_cache, save_quality_cache, select_recent_games,
    run_puzzle_line_backfill,
)
from chess_tracker.blunder_phases import compute_blunder_phases
from chess_tracker.blunder_categories import compute_blunder_analysis
from chess_tracker.render import render_all_pages, DEFAULT_TEMPLATE_DIR


_FORMAT_ORDER = {"bullet": 0, "blitz": 1, "rapid": 2, "daily": 3}
_FORMAT_LABELS = {"bullet": "Bullet", "blitz": "Blitz", "rapid": "Rapid", "daily": "Daily"}
DEFAULT_ANALYSIS_MAX_GAMES = 0
DEFAULT_PUZZLE_LINE_MAX = 100
CARO_KANN_DATASET_NAME = "caro-kann-black"
DEFAULT_CARO_KANN_DATA_DIR = Path("public/data") / CARO_KANN_DATASET_NAME
OPENING_PUZZLE_CATALOG_NAME = "opening-puzzle-catalog.json"
DEFAULT_OPENING_PUZZLE_DATA_DIR = Path("public/data")
_SAFE_DECK_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SELECTION_INDEX_SCHEMA_VERSION = 1
SELECTION_INDEX_FILENAME = "selection-index.json"


def _validate_caro_kann_deployment_path(
    destination: Path,
    dashboard_root: Path,
) -> None:
    """Require the generated dataset path to remain inside dashboard/data.

    Comparing resolved parents catches a ``dashboard/data`` symlink before any
    staging or deletion can affect the symlink target. The dataset path itself
    is not resolved so an old dataset symlink can still be safely unlinked.
    """
    destination = Path(destination)
    if destination.name != CARO_KANN_DATASET_NAME or destination.parent.name != "data":
        raise ValueError(
            "refusing to remove a path outside data/caro-kann-black: "
            f"{destination}"
        )
    dashboard_root = Path(dashboard_root).resolve()
    expected_parent = dashboard_root / "data"
    resolved_parent = destination.parent.resolve()
    if resolved_parent != expected_parent:
        raise ValueError(
            "refusing Caro-Kann deployment outside the resolved dashboard root: "
            f"{destination}"
        )


def _remove_deployed_caro_kann_data(
    destination: Path,
    dashboard_root: Path,
) -> None:
    """Remove one generated web dataset directory, with a resolved path guard."""
    destination = Path(destination)
    _validate_caro_kann_deployment_path(destination, dashboard_root)
    if destination.is_symlink():
        destination.unlink()
    elif destination.exists():
        shutil.rmtree(destination)


def _manifest_balanced_count(manifest: dict) -> int:
    counts = manifest.get("counts")
    value = counts.get("balancedExported") if isinstance(counts, dict) else None
    if value is None:
        value = manifest.get("balancedExported")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("manifest is missing a non-negative balancedExported count")
    return value


def _selection_dataset_version(
    deck_id: str,
    chunks: list[tuple[Path, int]],
    entries: list[dict],
) -> str:
    """Mirror the extractor's canonical selection-index version hash."""
    payload = {
        "schemaVersion": SELECTION_INDEX_SCHEMA_VERSION,
        "deckId": deck_id,
        "count": len(entries),
        "chunks": [
            {
                "index": index,
                "path": path.as_posix(),
                "count": count,
            }
            for index, (path, count) in enumerate(chunks)
        ],
        "entries": entries,
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _validated_opening_puzzle_selection_index(
    source_dir: Path,
    manifest: dict,
    chunks: list[tuple[Path, int]],
    *,
    deck_id: str,
    chunk_records: list[list[dict]] | None = None,
) -> Path | None:
    """Validate an optional bounded traversal index and return its safe path."""
    raw_path = manifest.get("selectionIndex")
    dataset_version = manifest.get("datasetVersion")
    if raw_path is None and dataset_version is None:
        return None
    if raw_path is None or dataset_version is None:
        raise ValueError(
            f"manifest selectionIndex and datasetVersion must appear together for {deck_id!r}"
        )
    if not isinstance(raw_path, str) or "\\" in raw_path:
        raise ValueError(f"manifest selectionIndex has an unsafe path for {deck_id!r}")
    relative = PurePosixPath(raw_path)
    if (
        relative.is_absolute()
        or relative.as_posix() != raw_path
        or relative.parts != (SELECTION_INDEX_FILENAME,)
    ):
        raise ValueError(
            "manifest selectionIndex must be the safe deck-relative "
            f"{SELECTION_INDEX_FILENAME!r} path: {raw_path!r}"
        )
    if (
        not isinstance(dataset_version, str)
        or not re.fullmatch(r"[0-9a-f]{64}", dataset_version)
    ):
        raise ValueError(f"manifest datasetVersion is invalid for {deck_id!r}")

    source_root = source_dir.resolve()
    relative_path = Path(SELECTION_INDEX_FILENAME)
    index_path = (source_dir / relative_path).resolve()
    if index_path.parent != source_root:
        raise ValueError(f"manifest selectionIndex escapes the dataset directory for {deck_id!r}")
    index = _read_json_object(index_path, "opening-puzzle selection index")
    if index.get("schemaVersion") != SELECTION_INDEX_SCHEMA_VERSION:
        raise ValueError(f"selection index schemaVersion must be 1 for {deck_id!r}")
    if index.get("deckId") != deck_id:
        raise ValueError(f"selection index deckId must be {deck_id!r}")
    if index.get("datasetVersion") != dataset_version:
        raise ValueError(f"selection index datasetVersion mismatch for {deck_id!r}")

    count = index.get("count")
    entries = index.get("entries")
    balanced_count = _manifest_balanced_count(manifest)
    if (
        isinstance(count, bool)
        or not isinstance(count, int)
        or count < 0
        or not isinstance(entries, list)
        or len(entries) != count
        or count != balanced_count
    ):
        raise ValueError(f"selection index count mismatch for {deck_id!r}")

    expected_version = _selection_dataset_version(deck_id, chunks, entries)
    if expected_version != dataset_version:
        raise ValueError(f"selection index metadata hash mismatch for {deck_id!r}")
    selection_entry_projector = None
    if chunk_records is not None:
        from scripts.extract_opening_puzzles import _selection_index_entry

        selection_entry_projector = _selection_index_entry

    seen_ids: set[str] = set()
    seen_locations: set[tuple[int, int]] = set()
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"selection index entry {position} must be an object")
        puzzle_id = entry.get("id")
        chunk_index = entry.get("chunkIndex")
        chunk_offset = entry.get("chunkOffset")
        if (
            not isinstance(puzzle_id, str)
            or not puzzle_id
            or puzzle_id != puzzle_id.strip()
            or puzzle_id in seen_ids
        ):
            raise ValueError(f"selection index IDs must be unique for {deck_id!r}")
        if (
            isinstance(chunk_index, bool)
            or not isinstance(chunk_index, int)
            or chunk_index < 0
            or chunk_index >= len(chunks)
            or isinstance(chunk_offset, bool)
            or not isinstance(chunk_offset, int)
            or chunk_offset < 0
            or chunk_offset >= chunks[chunk_index][1]
        ):
            raise ValueError(
                f"selection index entry {puzzle_id!r} has an invalid chunk location"
            )
        location = (chunk_index, chunk_offset)
        if location in seen_locations:
            raise ValueError(f"selection index chunk locations must be unique for {deck_id!r}")
        if chunk_records is not None and (
            chunk_records[chunk_index][chunk_offset].get("id") != puzzle_id
        ):
            raise ValueError(
                f"selection index entry {puzzle_id!r} does not match its chunk location"
            )

        themes = entry.get("themes")
        primary_theme = entry.get("primaryTheme")
        solution_length = entry.get("solutionLength")
        solver_decisions = entry.get("solverDecisionCount")
        signature = entry.get("tacticalSignature")
        if (
            not isinstance(entry.get("variation"), str)
            or not entry["variation"]
            or entry["variation"] != entry["variation"].strip()
            or entry.get("difficulty")
            not in {"beginner", "developing", "intermediate", "advanced", "expert"}
            or isinstance(entry.get("rating"), bool)
            or not isinstance(entry.get("rating"), int)
            or not isinstance(entry.get("provenance"), str)
            or not entry["provenance"]
            or entry["provenance"] != entry["provenance"].strip()
            or not isinstance(themes, list)
            or any(
                not isinstance(theme, str) or not theme or theme != theme.strip()
                for theme in themes
            )
            or not isinstance(primary_theme, str)
            or not primary_theme
            or "|" in primary_theme
            or not isinstance(entry.get("isOpeningPuzzle"), bool)
            or isinstance(solution_length, bool)
            or not isinstance(solution_length, int)
            or solution_length < 1
            or isinstance(solver_decisions, bool)
            or not isinstance(solver_decisions, int)
            or solver_decisions < 1
            or not isinstance(signature, str)
            or not re.fullmatch(
                re.escape(primary_theme)
                + r"\|"
                + str(solution_length)
                + r"\|[KQRBNP]\|[a-h][1-8]",
                signature,
            )
        ):
            raise ValueError(f"selection index entry {puzzle_id!r} has invalid metadata")
        if selection_entry_projector is not None:
            try:
                expected_entry = selection_entry_projector(
                    chunk_records[chunk_index][chunk_offset],
                    chunk_index=chunk_index,
                    chunk_offset=chunk_offset,
                )
            except (KeyError, RuntimeError, TypeError, ValueError) as exc:
                raise ValueError(
                    f"selection index source metadata is invalid for {puzzle_id!r}"
                ) from exc
            if entry != expected_entry:
                raise ValueError(
                    f"selection index entry {puzzle_id!r} does not match its chunk metadata"
                )
        seen_ids.add(puzzle_id)
        seen_locations.add(location)
    return relative_path


def _validated_caro_kann_chunks(
    source_dir: Path,
    manifest: dict,
    *,
    chunk_records: list[list[dict]] | None = None,
) -> list[tuple[Path, int]]:
    """Validate manifest chunk paths and their exact JSON-array record counts."""
    if manifest.get("solverColor") != "black":
        raise ValueError("Caro-Kann manifest solverColor must be black")
    if manifest.get("orientation") != "black":
        raise ValueError("Caro-Kann manifest orientation must be black")

    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        raise ValueError("Caro-Kann manifest chunks must be a list")

    source_root = source_dir.resolve()
    validated: list[tuple[Path, int]] = []
    seen_paths: set[str] = set()
    total = 0
    for index, item in enumerate(chunks):
        if not isinstance(item, dict):
            raise ValueError(f"manifest chunk {index} must be an object")
        raw_path = item.get("path")
        count = item.get("count")
        if not isinstance(raw_path, str) or not raw_path:
            raise ValueError(f"manifest chunk {index} has no path")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(f"manifest chunk {raw_path!r} has an invalid count")

        relative = PurePosixPath(raw_path)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or len(relative.parts) < 2
            or relative.parts[0] != "chunks"
            or relative.suffix != ".json"
        ):
            raise ValueError(
                f"manifest chunk path must be a relative chunks/*.json path: {raw_path!r}"
            )
        normalized = relative.as_posix()
        if normalized in seen_paths:
            raise ValueError(f"duplicate manifest chunk path: {raw_path!r}")
        seen_paths.add(normalized)

        chunk_path = (source_dir / Path(*relative.parts)).resolve()
        if source_root not in chunk_path.parents:
            raise ValueError(f"manifest chunk escapes the dataset directory: {raw_path!r}")
        try:
            records = json.loads(chunk_path.read_text())
        except FileNotFoundError as exc:
            raise ValueError(f"manifest chunk does not exist: {raw_path!r}") from exc
        except json.JSONDecodeError as exc:
            raise ValueError(f"manifest chunk is not valid JSON: {raw_path!r}") from exc
        if not isinstance(records, list):
            raise ValueError(f"manifest chunk is not a JSON array: {raw_path!r}")
        if len(records) != count:
            raise ValueError(
                f"manifest chunk count mismatch for {raw_path!r}: "
                f"expected {count}, found {len(records)}"
            )
        if chunk_records is not None:
            if any(not isinstance(record, dict) for record in records):
                raise ValueError(f"manifest chunk contains a non-object record: {raw_path!r}")
            chunk_records.append(records)
        validated.append((Path(*relative.parts), count))
        total += count

    balanced_count = _manifest_balanced_count(manifest)
    if total != balanced_count:
        raise ValueError(
            "manifest balancedExported count does not match its chunks: "
            f"expected {balanced_count}, found {total}"
        )
    return validated


def sync_caro_kann_web_data(
    source_dir: Path = DEFAULT_CARO_KANN_DATA_DIR,
    dashboard_dir: Path = Path("dashboard"),
) -> dict:
    """Copy the static trainer manifest, optional index, and balanced chunks.

    Full JSONL exports and analytical shards remain under ``public/``. The
    dashboard copy is generated afresh so removed chunks cannot linger in a
    Pages artifact. A missing canonical manifest is an expected state for a
    checkout that has not run the extractor yet.
    """
    source_dir = Path(source_dir)
    dashboard_dir = Path(dashboard_dir)
    destination = dashboard_dir / "data" / CARO_KANN_DATASET_NAME
    _validate_caro_kann_deployment_path(destination, dashboard_dir)
    manifest_path = source_dir / "manifest.json"
    if not manifest_path.is_file():
        _remove_deployed_caro_kann_data(destination, dashboard_dir)
        return {"available": False, "chunks": 0, "puzzles": 0}

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as exc:
        raise ValueError("Caro-Kann manifest is not valid JSON") from exc
    if not isinstance(manifest, dict):
        raise ValueError("Caro-Kann manifest must be a JSON object")
    chunk_records: list[list[dict]] = []
    chunks = _validated_caro_kann_chunks(
        source_dir,
        manifest,
        chunk_records=chunk_records,
    )
    selection_index = _validated_opening_puzzle_selection_index(
        source_dir,
        manifest,
        chunks,
        deck_id=manifest.get("deckId", CARO_KANN_DATASET_NAME),
        chunk_records=chunk_records,
    )

    destination.parent.mkdir(parents=True, exist_ok=True)
    _validate_caro_kann_deployment_path(destination, dashboard_dir)
    staging = Path(tempfile.mkdtemp(
        prefix=f".{CARO_KANN_DATASET_NAME}-sync-",
        dir=destination.parent,
    ))
    try:
        shutil.copyfile(manifest_path, staging / "manifest.json")
        if selection_index is not None:
            shutil.copyfile(source_dir / selection_index, staging / selection_index)
        for relative_path, _count in chunks:
            target = staging / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_dir / relative_path, target)
        _remove_deployed_caro_kann_data(destination, dashboard_dir)
        staging.replace(destination)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    return {
        "available": True,
        "chunks": len(chunks),
        "puzzles": _manifest_balanced_count(manifest),
    }


def _opening_puzzle_dashboard_data_dir(dashboard_dir: Path) -> Path:
    """Return ``dashboard/data`` only when it cannot escape the dashboard.

    Resolve the parent before creating a staging directory. In particular, an
    existing ``dashboard/data`` symlink must never let a refresh remove or
    replace files outside the generated Pages tree.
    """
    dashboard_dir = Path(dashboard_dir)
    dashboard_root = dashboard_dir.resolve()
    data_dir = dashboard_dir / "data"
    if data_dir.exists() and not data_dir.is_dir():
        raise ValueError(f"dashboard data path must be a directory: {data_dir}")
    resolved_data_dir = data_dir.resolve()
    if resolved_data_dir != dashboard_root / "data":
        raise ValueError(
            "refusing opening-puzzle deployment outside the resolved "
            f"dashboard root: {data_dir}"
        )
    return resolved_data_dir


def _safe_catalog_manifest_path(raw_path: object, deck_id: str) -> Path:
    """Validate the URL/filesystem-relative manifest path from the catalog."""
    if not isinstance(raw_path, str) or not raw_path or "\\" in raw_path:
        raise ValueError(f"catalog deck {deck_id!r} has an unsafe manifestPath")
    relative = PurePosixPath(raw_path)
    if (
        relative.is_absolute()
        or ".." in relative.parts
        or relative.as_posix() != raw_path
        or len(relative.parts) != 2
        or relative.parts[0] != deck_id
        or relative.parts[1] != "manifest.json"
    ):
        raise ValueError(
            "catalog manifestPath must be a safe relative "
            f"<deckId>/manifest.json path: {raw_path!r}"
        )
    return Path(*relative.parts)


def _read_json_object(path: Path, description: str) -> dict:
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ValueError(f"{description} does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{description} is not valid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{description} must be a JSON object: {path}")
    return value


def _validated_opening_puzzle_chunks(
    source_dir: Path,
    manifest: dict,
    *,
    deck: dict,
    chunk_records: list[list[dict]] | None = None,
) -> list[tuple[Path, int]]:
    """Validate one catalog deck's identity, perspective, and browser chunks."""
    deck_id = deck["id"]
    schema_version = manifest.get("schemaVersion")
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version < 2
    ):
        raise ValueError(f"manifest schemaVersion must be at least 2 for {deck_id!r}")
    if manifest.get("deckId") != deck_id:
        raise ValueError(f"manifest deckId must be {deck_id!r}")
    if manifest.get("solverColor") != deck["solverColor"]:
        raise ValueError(f"manifest solverColor does not match catalog deck {deck_id!r}")
    if manifest.get("orientation") != deck["orientation"]:
        raise ValueError(f"manifest orientation does not match catalog deck {deck_id!r}")
    if manifest.get("orientation") != manifest.get("solverColor"):
        raise ValueError(f"manifest orientation must equal solverColor for {deck_id!r}")
    if manifest.get("openingFamily") != deck["openingFamily"]:
        raise ValueError(f"manifest openingFamily does not match catalog deck {deck_id!r}")
    opening_tag_roots = manifest.get("openingTagRoots")
    if (
        not isinstance(opening_tag_roots, list)
        or not opening_tag_roots
        or any(not isinstance(root, str) or not root for root in opening_tag_roots)
        or len(set(opening_tag_roots)) != len(opening_tag_roots)
    ):
        raise ValueError(
            f"manifest openingTagRoots must be unique non-empty strings for {deck_id!r}"
        )

    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        raise ValueError(f"manifest chunks must be a list for {deck_id!r}")

    source_root = source_dir.resolve()
    validated: list[tuple[Path, int]] = []
    seen_paths: set[str] = set()
    total = 0
    for index, item in enumerate(chunks):
        if not isinstance(item, dict):
            raise ValueError(f"manifest chunk {index} must be an object for {deck_id!r}")
        raw_path = item.get("path")
        count = item.get("count")
        if not isinstance(raw_path, str) or not raw_path or "\\" in raw_path:
            raise ValueError(f"manifest chunk {index} has an unsafe path for {deck_id!r}")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(f"manifest chunk {raw_path!r} has an invalid count")

        relative = PurePosixPath(raw_path)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.as_posix() != raw_path
            or len(relative.parts) != 2
            or relative.parts[0] != "chunks"
            or relative.suffix != ".json"
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json", relative.name)
        ):
            raise ValueError(
                "manifest chunk path must be a relative chunks/*.json path: "
                f"{raw_path!r}"
            )
        normalized = relative.as_posix()
        if normalized in seen_paths:
            raise ValueError(f"duplicate manifest chunk path: {raw_path!r}")
        seen_paths.add(normalized)

        relative_path = Path(*relative.parts)
        chunk_path = (source_dir / relative_path).resolve()
        if source_root not in chunk_path.parents:
            raise ValueError(f"manifest chunk escapes the dataset directory: {raw_path!r}")
        try:
            records = json.loads(chunk_path.read_text())
        except FileNotFoundError as exc:
            raise ValueError(f"manifest chunk does not exist: {raw_path!r}") from exc
        except json.JSONDecodeError as exc:
            raise ValueError(f"manifest chunk is not valid JSON: {raw_path!r}") from exc
        if not isinstance(records, list):
            raise ValueError(f"manifest chunk is not a JSON array: {raw_path!r}")
        if len(records) != count:
            raise ValueError(
                f"manifest chunk count mismatch for {raw_path!r}: "
                f"expected {count}, found {len(records)}"
            )
        if chunk_records is not None:
            if any(not isinstance(record, dict) for record in records):
                raise ValueError(f"manifest chunk contains a non-object record: {raw_path!r}")
            chunk_records.append(records)
        validated.append((relative_path, count))
        total += count

    balanced_count = _manifest_balanced_count(manifest)
    if total != balanced_count:
        raise ValueError(
            f"manifest balancedExported count for {deck_id!r} does not match "
            f"its chunks: expected {balanced_count}, found {total}"
        )
    return validated


def _validate_opening_puzzle_catalog(
    source_root: Path,
    catalog: dict,
) -> list[dict]:
    """Validate catalog entries and all referenced manifests before copying."""
    schema_version = catalog.get("schemaVersion")
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version < 1
    ):
        raise ValueError("opening-puzzle catalog requires a positive integer schemaVersion")
    decks = catalog.get("decks")
    if not isinstance(decks, list) or not decks:
        raise ValueError("opening-puzzle catalog decks must be a non-empty list")

    source_root = Path(source_root).resolve()
    plans: list[dict] = []
    seen_ids: set[str] = set()
    seen_manifest_paths: set[str] = set()
    for index, deck in enumerate(decks):
        if not isinstance(deck, dict):
            raise ValueError(f"catalog deck {index} must be an object")
        deck_id = deck.get("id")
        if not isinstance(deck_id, str) or not _SAFE_DECK_ID.fullmatch(deck_id):
            raise ValueError(f"catalog deck {index} has an unsafe id")
        if deck_id in seen_ids:
            raise ValueError(f"duplicate catalog deck id: {deck_id!r}")
        seen_ids.add(deck_id)

        solver_color = deck.get("solverColor")
        orientation = deck.get("orientation")
        if solver_color not in {"white", "black"}:
            raise ValueError(f"catalog deck {deck_id!r} has an invalid solverColor")
        if orientation != solver_color:
            raise ValueError(
                f"catalog deck {deck_id!r} orientation must equal solverColor"
            )
        if not isinstance(deck.get("label"), str) or not deck["label"].strip():
            raise ValueError(f"catalog deck {deck_id!r} has no label")
        if (
            not isinstance(deck.get("openingFamily"), str)
            or not deck["openingFamily"].strip()
        ):
            raise ValueError(f"catalog deck {deck_id!r} has no openingFamily")

        manifest_relative = _safe_catalog_manifest_path(
            deck.get("manifestPath"), deck_id
        )
        manifest_key = manifest_relative.as_posix()
        if manifest_key in seen_manifest_paths:
            raise ValueError(f"duplicate catalog manifestPath: {manifest_key!r}")
        seen_manifest_paths.add(manifest_key)

        manifest_path = (source_root / manifest_relative).resolve()
        if source_root not in manifest_path.parents:
            raise ValueError(
                f"catalog manifest escapes the canonical data directory: {manifest_key!r}"
            )
        manifest = _read_json_object(manifest_path, "opening-puzzle manifest")
        source_dir = manifest_path.parent
        chunk_records: list[list[dict]] = []
        chunks = _validated_opening_puzzle_chunks(
            source_dir,
            manifest,
            deck=deck,
            chunk_records=chunk_records,
        )
        selection_index = _validated_opening_puzzle_selection_index(
            source_dir,
            manifest,
            chunks,
            deck_id=deck_id,
            chunk_records=chunk_records,
        )
        plans.append({
            "deck": deck,
            "manifest": manifest,
            "manifestPath": manifest_path,
            "sourceDir": source_dir,
            "chunks": chunks,
            "selectionIndex": selection_index,
        })

    default_deck_id = catalog.get("defaultDeckId")
    if default_deck_id not in seen_ids:
        raise ValueError("catalog defaultDeckId must reference a catalog deck")
    return plans


def _deployed_opening_puzzle_deck_ids(data_dir: Path) -> set[str]:
    """Read only safe deck IDs from the previous generated catalog."""
    catalog_path = data_dir / OPENING_PUZZLE_CATALOG_NAME
    try:
        catalog = json.loads(catalog_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return set()
    decks = catalog.get("decks") if isinstance(catalog, dict) else None
    if not isinstance(decks, list):
        return set()
    return {
        deck["id"]
        for deck in decks
        if isinstance(deck, dict)
        and isinstance(deck.get("id"), str)
        and _SAFE_DECK_ID.fullmatch(deck["id"])
    }


def _remove_opening_puzzle_deployment(path: Path, data_dir: Path) -> None:
    """Remove one generated catalog/deck path without following symlinks."""
    path = Path(path)
    data_dir = Path(data_dir)
    if path.parent != data_dir or data_dir.resolve() != data_dir:
        raise ValueError(f"refusing to remove an unmanaged dashboard path: {path}")
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def sync_opening_puzzle_web_data(
    source_root: Path = DEFAULT_OPENING_PUZZLE_DATA_DIR,
    dashboard_dir: Path = Path("dashboard"),
) -> dict:
    """Deploy each manifest, optional selection index, and balanced chunks.

    The complete JSONL exports and analytical shards remain canonical local
    artifacts under ``public/data``. Every path and count is validated before
    the generated Pages tree is changed, and the old Caro-Kann-only sync entry
    point remains available for callers that have not adopted the catalog.
    """
    source_root = Path(source_root)
    dashboard_dir = Path(dashboard_dir)
    data_dir = _opening_puzzle_dashboard_data_dir(dashboard_dir)
    catalog_path = source_root / OPENING_PUZZLE_CATALOG_NAME
    previous_deck_ids = _deployed_opening_puzzle_deck_ids(data_dir)

    if not catalog_path.is_file():
        # Caro-Kann predates the catalog, so clear that one legacy path even
        # when there is no previous catalog from which to discover it.
        previous_deck_ids.add(CARO_KANN_DATASET_NAME)
        if data_dir.exists():
            for deck_id in sorted(previous_deck_ids):
                _remove_opening_puzzle_deployment(data_dir / deck_id, data_dir)
            _remove_opening_puzzle_deployment(
                data_dir / OPENING_PUZZLE_CATALOG_NAME,
                data_dir,
            )
        return {"available": False, "decks": 0, "chunks": 0, "puzzles": 0}

    source_root_resolved = source_root.resolve()
    if catalog_path.resolve().parent != source_root_resolved:
        raise ValueError("opening-puzzle catalog escapes the canonical data directory")
    catalog = _read_json_object(catalog_path, "opening-puzzle catalog")
    plans = _validate_opening_puzzle_catalog(source_root, catalog)

    data_dir.mkdir(parents=True, exist_ok=True)
    if data_dir.resolve() != data_dir:
        raise ValueError(
            "refusing opening-puzzle deployment outside the resolved dashboard root"
        )
    staging = Path(tempfile.mkdtemp(prefix=".opening-puzzles-sync-", dir=data_dir))
    try:
        shutil.copyfile(catalog_path, staging / OPENING_PUZZLE_CATALOG_NAME)
        for plan in plans:
            deck_id = plan["deck"]["id"]
            staged_deck = staging / deck_id
            staged_deck.mkdir()
            shutil.copyfile(plan["manifestPath"], staged_deck / "manifest.json")
            if plan["selectionIndex"] is not None:
                shutil.copyfile(
                    plan["sourceDir"] / plan["selectionIndex"],
                    staged_deck / plan["selectionIndex"],
                )
            for relative_path, _count in plan["chunks"]:
                target = staged_deck / relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(plan["sourceDir"] / relative_path, target)

        new_deck_ids = {plan["deck"]["id"] for plan in plans}
        for deck_id in sorted(previous_deck_ids | new_deck_ids):
            _remove_opening_puzzle_deployment(data_dir / deck_id, data_dir)
        for deck_id in sorted(new_deck_ids):
            (staging / deck_id).replace(data_dir / deck_id)
        _remove_opening_puzzle_deployment(
            data_dir / OPENING_PUZZLE_CATALOG_NAME,
            data_dir,
        )
        (staging / OPENING_PUZZLE_CATALOG_NAME).replace(
            data_dir / OPENING_PUZZLE_CATALOG_NAME
        )
    finally:
        if staging.exists():
            shutil.rmtree(staging)

    deck_counts = {
        plan["deck"]["id"]: {
            "chunks": len(plan["chunks"]),
            "puzzles": _manifest_balanced_count(plan["manifest"]),
        }
        for plan in plans
    }
    return {
        "available": True,
        "decks": len(plans),
        "chunks": sum(item["chunks"] for item in deck_counts.values()),
        "puzzles": sum(item["puzzles"] for item in deck_counts.values()),
        "deckCounts": deck_counts,
    }


def accept_game(game: dict, time_class: str, time_control: str | None = None) -> bool:
    """True if a Chess.com game dict is a rated standard-chess game in the
    requested time class.

    time_control=None accepts every control within the class; pass an exact
    Chess.com TimeControl string (e.g. "60", "60+1", "1/86400") to narrow.
    """
    if game.get("time_class") != time_class:
        return False
    if time_control is not None and str(game.get("time_control")) != str(time_control):
        return False
    return game.get("rated") is True and game.get("rules") == "chess"


def _seconds_control_label(seconds: int) -> str:
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds // 60}min"
    return f"{seconds}s"


def _time_control_label(time_control: str) -> str:
    raw = str(time_control or "").strip()
    if not raw:
        return "unknown"

    if "/" in raw:
        parts = raw.split("/", 1)
        try:
            seconds = int(parts[1])
        except (IndexError, ValueError):
            return raw
        if seconds % 86_400 == 0:
            days = seconds // 86_400
            return f"{days} day" if days == 1 else f"{days} days"
        return raw

    base, _, inc = raw.partition("+")
    try:
        base_seconds = int(base)
    except ValueError:
        return raw

    label = _seconds_control_label(base_seconds)
    if inc and inc != "0":
        label += f"+{inc}s"
    return label


def _time_control_sort_key(time_control: str) -> tuple[int, int, str]:
    raw = str(time_control or "")
    if "/" in raw:
        try:
            return (int(raw.split("/", 1)[1]), 0, raw)
        except (IndexError, ValueError):
            return (999_999_999, 0, raw)

    base, _, inc = raw.partition("+")
    try:
        base_seconds = int(base)
    except ValueError:
        base_seconds = 999_999_999
    try:
        increment_seconds = int(inc) if inc else 0
    except ValueError:
        increment_seconds = 999_999_999
    return (base_seconds, increment_seconds, raw)


def _player_rating(game: dict, username: str) -> int | None:
    target = username.lower()
    for color in ("white", "black"):
        player = game.get(color, {})
        if player.get("username", "").lower() == target:
            return player.get("rating")
    return None


def compute_ratings_by_time_control(games: list[dict], username: str) -> list[dict]:
    """Latest observed rating for each exact Chess.com time control.

    Chess.com ratings are stored by broad pool, but each archived game carries
    the user's post-game rating and exact TimeControl. This reports the latest
    rating observed after a game in each control, e.g. Blitz (3min) vs Blitz
    (5min), so the top strip no longer collapses them into one label.
    """
    latest_by_control: dict[tuple[str, str], dict] = {}

    for game in games:
        fmt = game.get("time_class")
        if fmt not in _FORMAT_ORDER or not accept_game(game, fmt):
            continue
        time_control = str(game.get("time_control", "")).strip()
        if not time_control:
            continue
        rating = _player_rating(game, username)
        if rating is None:
            continue
        end_time = int(game.get("end_time") or 0)
        key = (fmt, time_control)
        current = latest_by_control.get(key)
        if current is None or end_time >= current["latest_end_time"]:
            latest_by_control[key] = {
                "key": f"{fmt}:{time_control}",
                "format": fmt,
                "time_control": time_control,
                "label": f"{_FORMAT_LABELS[fmt]} ({_time_control_label(time_control)})",
                "rating": rating,
                "latest_end_time": end_time,
            }

    return sorted(
        latest_by_control.values(),
        key=lambda item: (
            _FORMAT_ORDER[item["format"]],
            *_time_control_sort_key(item["time_control"]),
        ),
    )


def build_move_quality_by_time_control(
    controls: list[dict],
    quality_by_control: dict,
) -> list[dict]:
    """Attach move-quality summaries to ordered time-control metadata."""
    rows = []
    for control in controls:
        summary = quality_by_control.get(control["key"])
        if not summary:
            continue
        rows.append({
            "key": control["key"],
            "format": control["format"],
            "time_control": control["time_control"],
            "label": control["label"],
            "summary": summary,
        })
    return rows


def _legacy_loss_puzzle(candidate: dict) -> dict:
    """Adapt a canonical queue candidate for the older losses-page drill.

    The new Puzzles page is the source of truth. Keeping this tiny adapter lets
    the existing recent-loss drill reuse the same eligibility and cached engine
    result instead of launching a second Stockfish analysis pass.
    """
    return {
        "puzzle_id": candidate.get("puzzle_id"),
        "ply": candidate.get("ply"),
        "fullmove": candidate.get("fullmove"),
        "side": candidate.get("user_color"),
        "fen_before": candidate.get("fen_before"),
        "my_move_uci": candidate.get("played_move_uci"),
        "my_move_san": candidate.get("played_move_san"),
        "best_move_uci": candidate.get("best_move_uci"),
        "best_move_san": candidate.get("best_move_san"),
        "cp_before": candidate.get("cp_before"),
        "cp_after": candidate.get("cp_after"),
        "cp_loss": candidate.get("cp_loss"),
        "legal_dests": candidate.get("legal_dests", {}),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Refresh chess tracker dashboard.")
    ap.add_argument("--username", default="M_V-V")
    ap.add_argument("--format", default="bullet",
                    choices=["bullet", "blitz", "rapid", "daily"])
    ap.add_argument("--time-control", default=None,
                    help="Optional exact Chess.com time_control filter "
                         "(e.g. 60, 60+1, 1/86400). Default: all controls in the class.")
    ap.add_argument("--force", action="store_true",
                    help="Re-fetch all archives, not just current month.")
    ap.add_argument("--no-puzzles", action="store_true",
                    help="Exclude puzzle candidates and the recent-loss puzzle drill.")
    ap.add_argument("--no-analysis", action="store_true",
                    help="Skip the Stockfish move-quality pass (accuracy%%, blunders, cp-loss).")
    ap.add_argument("--analysis-depth", type=int, default=12,
                    help="Search depth for the move-quality pass (default 12).")
    ap.add_argument("--analysis-max-games", type=int, default=DEFAULT_ANALYSIS_MAX_GAMES,
                    help="Analyze the N most recent games. Default: 0, meaning "
                         "no limit / all games. Use a positive value for a "
                         "bounded local smoke refresh; the cache fills "
                         "incrementally across refreshes.")
    ap.add_argument(
        "--puzzle-line-max",
        type=int,
        default=DEFAULT_PUZZLE_LINE_MAX,
        help="Backfill Stockfish lines for at most N legacy blunders per refresh "
             "(default 100; 0 means unlimited).",
    )
    ap.add_argument("--compare-formats", nargs="+",
                    default=["bullet", "blitz", "rapid", "daily"],
                    choices=["bullet", "blitz", "rapid", "daily"],
                    help="Time classes to include in the cross-format move-quality "
                         "comparison (the active --format is always included).")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--dashboard-dir", default="dashboard")
    ap.add_argument("--template-dir", default=str(DEFAULT_TEMPLATE_DIR))
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    raw_dir = data_dir / "raw"
    dashboard_dir = Path(args.dashboard_dir)
    template_dir = Path(args.template_dir)
    annotations_path = data_dir / "annotations.json"

    print(f"[1/5] Loading archives index + stats for {args.username}...")
    archives = fetch_archives_index(args.username)
    print(f"      {len(archives)} archive(s)")
    _STAT_KEYS = {"bullet": "chess_bullet", "blitz": "chess_blitz",
                  "rapid": "chess_rapid", "daily": "chess_daily"}
    try:
        _stats = fetch_player_stats(args.username)
        ratings_by_format = {
            fmt: _stats[key]["last"]["rating"]
            for fmt, key in _STAT_KEYS.items()
            if key in _stats and "last" in _stats.get(key, {})
        }
        print(f"      ratings: { {k: v for k, v in ratings_by_format.items()} }")
    except Exception as exc:
        print(f"      stats fetch failed ({exc}); ratings_by_format will be empty")
        ratings_by_format = {}

    print(f"[2/5] Fetching archives (force={args.force})...")
    all_games = []
    # Assumes /archives returns months chronologically, oldest first (Chess.com behaviour).
    current_month_url = archives[-1] if archives else None
    for url in archives:
        force_this = args.force or (url == current_month_url)
        data = fetch_archive(url, cache_dir=raw_dir, force=force_this)
        all_games.extend(data.get("games", []))
    print(f"      {len(all_games)} games total")
    ratings_by_time_control = compute_ratings_by_time_control(all_games, args.username)
    if ratings_by_time_control:
        ratings_by_control_print = {
            item["label"]: item["rating"] for item in ratings_by_time_control
        }
        print(f"      ratings by time control: {ratings_by_control_print}")

    tc_label = args.time_control or "all controls"
    print(f"[3/5] Filtering to rated standard {args.format} games ({tc_label})...")
    in_format = [g for g in all_games
                 if accept_game(g, args.format, args.time_control)]
    records = [parse_game(g, username=args.username) for g in in_format]
    print(f"      {len(records)} rated {args.format} games parsed")

    print("[4/5] Computing metrics + merging annotations + plan...")
    annotations = load_annotations(annotations_path)
    plan = load_plan()
    # blunder_phases populated after analysis pass below; set empty default now
    payload = compute_all(records, annotations,
                          username=args.username, format=args.format,
                          plan=plan)

    analysis_cache_path = data_dir / "analysis_cache.json"
    cache = load_quality_cache(analysis_cache_path)
    engine_path = None if args.no_analysis else find_engine_path()
    for loss in payload.get("recent_losses", []):
        loss["puzzle"] = None
    if args.no_puzzles:
        print("[4.5/5] Puzzle surfaces skipped (--no-puzzles).")
    else:
        print("[4.5/5] Puzzle candidates will reuse the move-quality cache.")

    if args.no_analysis or engine_path is None:
        payload["move_quality"] = None
        payload["move_quality_by_format"] = None
        payload["move_quality_by_time_control"] = None
        payload["blunder_analysis"] = None
        why = "--no-analysis" if args.no_analysis else "no Stockfish found"
        print(f"[4.6/5] Move-quality analysis skipped ({why}).")
    else:
        # Single-format detail — respects --format and --time-control.
        side_by_url = {r.url: r.side for r in records if r.url}
        to_analyze = select_recent_games(in_format, args.analysis_max_games)
        summaries = run_move_quality_pass(to_analyze, side_by_url, cache,
                                          engine_path=engine_path,
                                          depth=args.analysis_depth)
        payload["move_quality"] = aggregate_move_quality(summaries)
        payload["blunder_analysis"] = compute_blunder_analysis(
            summaries,
            records,
            eligible_games=len(records),
        )

        # Cross-format comparison — whole time class per format, current format
        # always included. Shares the URL cache, so games analyzed above are
        # reused rather than re-run.
        def _side(g):
            return ("white" if g.get("white", {}).get("username", "").lower()
                    == args.username.lower() else "black")
        compare = sorted(set(args.compare_formats) | {args.format})
        games_by_format = {fmt: [g for g in all_games if accept_game(g, fmt)]
                           for fmt in compare}
        side_all = {
            g["url"]: _side(g)
            for g in all_games
            if g.get("url")
            and g.get("time_class") in _FORMAT_ORDER
            and accept_game(g, g.get("time_class"))
        }
        payload["move_quality_by_format"] = run_move_quality_by_format(
            games_by_format, side_all, cache,
            engine_path=engine_path, depth=args.analysis_depth,
            max_games=args.analysis_max_games)
        games_by_time_control = {
            item["key"]: [
                g for g in all_games
                if accept_game(g, item["format"], item["time_control"])
            ]
            for item in ratings_by_time_control
        }
        quality_by_time_control = run_move_quality_by_format(
            games_by_time_control, side_all, cache,
            engine_path=engine_path, depth=args.analysis_depth,
            max_games=args.analysis_max_games)
        payload["move_quality_by_time_control"] = build_move_quality_by_time_control(
            ratings_by_time_control,
            quality_by_time_control,
        )

        nfmt = sum(1 for v in payload["move_quality_by_format"].values() if v)
        ntc = len(payload["move_quality_by_time_control"])
        print(f"[4.6/5] Move-quality: {len(summaries)} {args.format} games "
              f"+ {nfmt} format(s) / {ntc} control(s) compared "
              f"(depth {args.analysis_depth}).")

        # Recompute with blunder_phases now that quality data is available.
        all_summaries = [v["summary"] for v in cache.values()
                         if v.get("summary") and v["summary"].get("moves_analyzed")]
        bp_result = compute_blunder_phases(all_summaries, total_eligible=len(records))
        payload["blunder_phases"] = bp_result["blunder_phases"]
        payload["engine_coverage"] = bp_result["engine_coverage"]

        if not args.no_puzzles:
            line_stats = run_puzzle_line_backfill(
                all_games,
                cache,
                engine_path=engine_path,
                depth=args.analysis_depth,
                max_positions=args.puzzle_line_max,
            )
            print(
                "[4.62/5] Puzzle-line backfill: "
                f"{line_stats['backfilled']} updated, "
                f"{line_stats['ready']} ready, "
                f"{line_stats['pending']} pending, "
                f"{line_stats['failed']} failed."
            )

        # Persist both ordinary analysis and any incremental puzzle-line work
        # before deriving the static puzzle catalog from the cache.
        save_quality_cache(analysis_cache_path, cache)

    # The canonical queue is derived from the same blunder evidence used by
    # Blunder Analysis. Every candidate is replayed from its PGN and validated
    # before it reaches the browser; incomplete records remain out of the queue.
    puzzle_catalog = build_puzzle_queue(all_games, cache, args.username)
    if args.no_puzzles:
        puzzle_catalog["candidates"] = []
        puzzle_catalog.setdefault("coverage", {})["eligible_puzzles"] = 0
        puzzle_catalog["coverage"]["disabled"] = True
    payload["puzzle_catalog"] = puzzle_catalog

    # Preserve the existing recent-loss drill, but feed it from the canonical
    # queue rather than running a second engine pass with different thresholds.
    first_candidate_by_url: dict[str, dict] = {}
    for candidate in puzzle_catalog.get("candidates", []):
        game_url = candidate.get("game_url")
        if game_url:
            first_candidate_by_url.setdefault(game_url, candidate)
    for loss in payload.get("recent_losses", []):
        candidate = first_candidate_by_url.get(loss.get("game_url"))
        loss["puzzle"] = _legacy_loss_puzzle(candidate) if candidate else None

    coverage = puzzle_catalog.get("coverage", {})
    print(
        "[4.65/5] Personal blunder puzzles: "
        f"{coverage.get('eligible_puzzles', 0)} ready, "
        f"{coverage.get('incomplete_puzzles', 0)} incomplete."
    )

    payload["ratings_by_format"] = ratings_by_format
    payload["ratings_by_time_control"] = ratings_by_time_control

    # Lichess stats (public API, no auth — null on network failure)
    print("[4.7/5] Fetching Lichess profile...")
    raw_lichess = fetch_lichess_user(args.username)
    if raw_lichess:
        perfs = raw_lichess.get("perfs", {})
        payload["lichess"] = {
            "bullet":       perfs.get("bullet",    {}).get("rating"),
            "blitz":        perfs.get("blitz",     {}).get("rating"),
            "rapid":        perfs.get("rapid",     {}).get("rating"),
            "classical":    perfs.get("classical", {}).get("rating"),
            "puzzle_score": perfs.get("puzzle",    {}).get("score"),
            "game_count":   raw_lichess.get("count", {}).get("all"),
        }
    else:
        payload["lichess"] = None

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "computed.json").write_text(json.dumps(payload, indent=2))

    print("[5/5] Rendering dashboard...")
    render_all_pages(template_dir=template_dir, output_dir=dashboard_dir, payload=payload)
    opening_puzzle_sync = sync_opening_puzzle_web_data(
        source_root=DEFAULT_OPENING_PUZZLE_DATA_DIR,
        dashboard_dir=dashboard_dir,
    )
    if opening_puzzle_sync["available"]:
        print(
            "      Opening trainer data: "
            f"{opening_puzzle_sync['puzzles']} puzzles across "
            f"{opening_puzzle_sync['decks']} deck(s) in "
            f"{opening_puzzle_sync['chunks']} chunk(s)."
        )
    else:
        print(
            "      Opening trainer data unavailable; run the extractor to "
            f"create {DEFAULT_OPENING_PUZZLE_DATA_DIR / OPENING_PUZZLE_CATALOG_NAME}."
        )

    print(f"\nDone. Rendered to: {(dashboard_dir / 'index.html').resolve()}")
    print(f"  Browsers block file:// subresources; serve over HTTP instead:")
    print(f"    python3 -m http.server 8000")
    print(f"  Then open: http://localhost:8000/dashboard/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
