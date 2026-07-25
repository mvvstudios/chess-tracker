"""Aggregate Stockfish blunder evidence into a compact dashboard payload."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import re

from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, SCRAMBLE_SECONDS


CATEGORY_LABELS: dict[str, str] = {
    "material_loss": "Material loss",
    "missed_capture_or_recapture": "Missed capture or recapture",
    "mate_threat_or_mate_allowed": "Mate threat or mate allowed",
    "opening_phase_blunder": "Opening phase",
    "early_middlegame_blunder": "Early middlegame",
    "endgame_blunder": "Endgame",
    "large_eval_swing": "Large eval swing",
    "conversion_error": "Conversion error",
}

CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "material_loss": "Opponent's best reply after your move captures material.",
    "missed_capture_or_recapture": "Stockfish's best move was a capture or recapture and your move was not.",
    "mate_threat_or_mate_allowed": "The position after your move is a forced mate against you.",
    "opening_phase_blunder": "The blunder happened by move 8.",
    "early_middlegame_blunder": "The blunder happened from moves 9-20.",
    "endgame_blunder": "The blunder happened in an endgame position.",
    "large_eval_swing": "The centipawn loss was at least 500.",
    "conversion_error": "You were clearly better before the move and the advantage collapsed.",
}

CATEGORY_FOCUS_AREAS: dict[str, str] = {
    "material_loss": "Tactical/material",
    "missed_capture_or_recapture": "Tactical opportunity",
    "mate_threat_or_mate_allowed": "King safety",
    "conversion_error": "Conversion",
    "large_eval_swing": "Severity",
    "opening_phase_blunder": "Phase context",
    "early_middlegame_blunder": "Phase context",
    "endgame_blunder": "Phase context",
}

PHASE_LABELS: dict[str, str] = {
    "opening": "Opening (moves 1-8)",
    "early_middlegame": "Early middlegame (moves 9-20)",
    "middlegame": "Middlegame (moves 21+)",
    "endgame": "Endgame",
}


def _phase_label(phase: str | None) -> str:
    return PHASE_LABELS.get(phase or "", phase or "Unknown")


def _phase_key(blunder: dict) -> str:
    return blunder.get("phase_bucket") or blunder.get("phase") or "unknown"


def _opening_label(blunder: dict) -> str:
    return blunder.get("opening_label") or blunder.get("opening") or blunder.get("family") or "Unknown opening"


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "unknown"


def _side_label(side: str | None) -> str:
    return side or "unknown"


def _material_value_label(value: int | None) -> tuple[str, str]:
    value = int(value or 0)
    if value >= 900:
        return "queen", "Queen loss"
    if value >= 500:
        return "rook", "Rook loss"
    if value >= 300:
        return "minor", "Minor-piece loss"
    if value >= 100:
        return "pawn", "Pawn loss"
    return "material", "Material loss"


def _severity_band(cp_loss: int) -> tuple[str, str, str]:
    if cp_loss >= 1_000:
        return (
            "decisive",
            "Decisive swing",
            "The position moved by at least 1000 centipawns.",
        )
    return (
        "major",
        "Major swing",
        "The position moved by 500-999 centipawns.",
    )


def _is_scramble(blunder: dict) -> bool:
    """True when the move was played in a clock scramble (≤ SCRAMBLE_SECONDS)."""
    clock = blunder.get("clock_after_seconds")
    return clock is not None and clock <= SCRAMBLE_SECONDS


def _overlap_label(category: str, blunder: dict) -> tuple[str, str]:
    overlaps = [c for c in blunder.get("categories", []) if c != category]
    priority = [
        "mate_threat_or_mate_allowed",
        "conversion_error",
        "material_loss",
        "missed_capture_or_recapture",
        "large_eval_swing",
    ]
    for key in priority:
        if key in overlaps:
            return key, CATEGORY_LABELS.get(key, key.replace("_", " ").title())
    return "other", "Other evidence"


def _pattern_for(category: str, blunder: dict) -> tuple[str, str, str]:
    """Deterministic subgroup used between category rows and exact blunders."""
    phase = _phase_key(blunder)
    phase_label = _phase_label(phase)
    opening = _opening_label(blunder)
    side = _side_label(blunder.get("game_side") or blunder.get("side"))
    cp_loss = int(blunder.get("cp_loss") or 0)

    if category == "large_eval_swing":
        band_key, band_label, desc = _severity_band(cp_loss)
        return f"{band_key}|{phase}", f"{band_label} · {phase_label}", desc

    if category == "material_loss":
        value_key, value_label = _material_value_label(
            blunder.get("opponent_reply_capture_value")
        )
        return (
            f"{value_key}|{phase}",
            f"{value_label} · {phase_label}",
            "The opponent's best reply wins this class of material.",
        )

    if category == "missed_capture_or_recapture":
        if blunder.get("best_move_is_recapture"):
            return (
                f"recapture|{phase}",
                f"Missed recapture · {phase_label}",
                "Stockfish's best move recaptured material and the played move did not.",
            )
        return (
            f"capture|{phase}",
            f"Missed capture · {phase_label}",
            "Stockfish's best move captured material and the played move did not.",
        )

    if category == "mate_threat_or_mate_allowed":
        reply = blunder.get("opponent_best_reply_san") or ""
        if "#" in reply:
            return (
                f"mate-in-reply|{phase}",
                f"Mate in reply · {phase_label}",
                "The opponent's best reply is checkmate.",
            )
        return (
            f"forced-mate|{phase}",
            f"Forced mate allowed · {phase_label}",
            "The post-move position is a forced mate against you.",
        )

    if category == "conversion_error":
        return (
            f"{phase}|{opening}|{side}",
            f"Conversion collapse · {phase_label} · {opening} · {side}",
            "Grouped by phase and opening context.",
        )

    if category in {
        "opening_phase_blunder",
        "early_middlegame_blunder",
        "endgame_blunder",
    }:
        return (
            f"{opening}|{side}",
            f"{opening} · {side}",
            "Repeated in this opening family and side.",
        )

    overlap_key, overlap = _overlap_label(category, blunder)
    return (
        f"{overlap_key}|{phase}|{opening}|{side}",
        f"{overlap} · {phase_label}",
        "Grouped by overlapping engine evidence and position context.",
    )


@dataclass
class _Accumulator:
    count: int = 0
    cp_sum: int = 0
    worst_cp_loss: int = 0

    def add(self, cp_loss: int) -> None:
        self.count += 1
        self.cp_sum += cp_loss
        self.worst_cp_loss = max(self.worst_cp_loss, cp_loss)

    def row(self, key: str, label: str, total: int, **extra) -> dict:
        return {
            "key": key,
            "label": label,
            "count": self.count,
            "pct": round(100.0 * self.count / total, 1) if total else 0.0,
            "avg_cp_loss": round(self.cp_sum / self.count) if self.count else None,
            "worst_cp_loss": self.worst_cp_loss if self.count else None,
            **extra,
        }


def _record_meta(record) -> dict:
    return {
        "opening": getattr(record, "opening", None),
        "family": getattr(record, "family", None),
        "side": getattr(record, "side", None),
        "eco": getattr(record, "eco", None),
        "end_time": getattr(record, "end_time", None),
    }


def _summary_blunders(summary: dict, record_by_url: dict[str, object]) -> list[dict]:
    url = summary.get("game_url")
    record = record_by_url.get(url) if url else None
    meta = _record_meta(record) if record else {}
    out = []
    for blunder in summary.get("blunder_evidence", []) or []:
        item = {
            **blunder,
            "game_url": url,
            "opening": meta.get("opening"),
            "family": meta.get("family"),
            "eco": meta.get("eco"),
            "game_side": meta.get("side") or blunder.get("side"),
            "end_time": meta.get("end_time"),
            # The time_pressure co-tag is retired — the scramble/clear pool
            # partition replaced it. Cached v3 evidence may still carry it.
            "categories": [
                c for c in (blunder.get("categories") or [])
                if c != "time_pressure_blunder"
            ],
        }
        out.append(item)
    return out


def _impact_rows(pool: list[dict]) -> list[dict]:
    """Category → pattern → blunder tree for one pool of decorated blunders."""
    pool_total = len(pool)
    category_blunders: dict[str, list[dict]] = defaultdict(list)
    for blunder in pool:
        for category in blunder.get("categories", []) or []:
            category_blunders[category].append(blunder)

    impact_rows = []
    for category, rows in category_blunders.items():
        total_cp_loss = sum(int(b.get("cp_loss") or 0) for b in rows)
        worst = max(rows, key=lambda b: int(b.get("cp_loss") or 0))

        phase_counts: dict[str, int] = defaultdict(int)
        opening_counts: dict[tuple[str, str], int] = defaultdict(int)
        for blunder in rows:
            phase = _phase_key(blunder)
            phase_counts[phase] += 1
            opening = _opening_label(blunder)
            side = blunder.get("game_side") or blunder.get("side") or "unknown"
            opening_counts[(opening, side)] += 1

        top_phase, top_phase_count = max(
            phase_counts.items(),
            key=lambda item: (item[1], item[0]),
        )
        (top_opening, top_side), top_opening_count = max(
            opening_counts.items(),
            key=lambda item: (item[1], item[0][0]),
        )

        pattern_groups: dict[str, dict] = {}
        for blunder in rows:
            pattern_key, pattern_label, pattern_description = _pattern_for(
                category, blunder
            )
            if pattern_key not in pattern_groups:
                pattern_groups[pattern_key] = {
                    "key": pattern_key,
                    "label": pattern_label,
                    "description": pattern_description,
                    "rows": [],
                }
            pattern_groups[pattern_key]["rows"].append(blunder)

        pattern_rows = []
        for pattern in pattern_groups.values():
            pattern_blunders = pattern["rows"]
            pattern_total_cp = sum(int(b.get("cp_loss") or 0) for b in pattern_blunders)
            pattern_worst = max(
                pattern_blunders,
                key=lambda b: int(b.get("cp_loss") or 0),
            )
            pattern_phase_counts: dict[str, int] = defaultdict(int)
            pattern_opening_counts: dict[tuple[str, str], int] = defaultdict(int)
            for blunder in pattern_blunders:
                pattern_phase_counts[_phase_key(blunder)] += 1
                pattern_opening_counts[(
                    _opening_label(blunder),
                    blunder.get("game_side") or blunder.get("side") or "unknown",
                )] += 1
            pattern_top_phase, pattern_top_phase_count = max(
                pattern_phase_counts.items(),
                key=lambda item: (item[1], item[0]),
            )
            (pattern_top_opening, pattern_top_side), pattern_top_opening_count = max(
                pattern_opening_counts.items(),
                key=lambda item: (item[1], item[0][0]),
            )
            pattern_rows.append({
                "row_type": "pattern",
                "key": pattern["key"],
                "id": f"pattern-{category}-{_safe_id(pattern['key'])}",
                "category_key": category,
                "label": pattern["label"],
                "description": pattern["description"],
                "focus_area": "Repeated pattern",
                "count": len(pattern_blunders),
                "pct": round(100.0 * len(pattern_blunders) / len(rows), 1)
                if rows else 0.0,
                "total_cp_loss": pattern_total_cp,
                "avg_cp_loss": round(pattern_total_cp / len(pattern_blunders))
                if pattern_blunders else None,
                "worst_cp_loss": int(pattern_worst.get("cp_loss") or 0),
                "top_phase": pattern_top_phase,
                "top_phase_label": _phase_label(pattern_top_phase),
                "top_phase_count": pattern_top_phase_count,
                "top_opening_label": pattern_top_opening,
                "top_opening_side": pattern_top_side,
                "top_opening_count": pattern_top_opening_count,
                "representative_blunder_id": pattern_worst["id"],
                "_children": [
                    {
                        "row_type": "blunder",
                        "id": f"{category}-{_safe_id(pattern['key'])}-{blunder['id']}",
                        "category_key": category,
                        "pattern_key": pattern["key"],
                        "blunder_id": blunder["id"],
                        "move_label": blunder.get("move_label"),
                        "opening_label": _opening_label(blunder),
                        "phase_label": _phase_label(_phase_key(blunder)),
                        "cp_loss": int(blunder.get("cp_loss") or 0),
                        "total_cp_loss": int(blunder.get("cp_loss") or 0),
                        "clock_after_seconds": blunder.get("clock_after_seconds"),
                        "played_move_san": blunder.get("played_move_san"),
                        "best_move_san": blunder.get("best_move_san"),
                        "game_url": blunder.get("game_url"),
                        "position_url": blunder.get("position_url"),
                    }
                    for blunder in pattern_blunders
                ],
            })
        pattern_rows.sort(
            key=lambda row: (
                -row["total_cp_loss"],
                -row["count"],
                -row["worst_cp_loss"],
                row["label"],
            )
        )

        impact_rows.append({
            "row_type": "category",
            "key": category,
            "id": f"category-{category}",
            "label": CATEGORY_LABELS.get(category, category.replace("_", " ").title()),
            "description": CATEGORY_DESCRIPTIONS.get(category, ""),
            "focus_area": CATEGORY_FOCUS_AREAS.get(category, "Evidence"),
            "count": len(rows),
            "pct": round(100.0 * len(rows) / pool_total, 1) if pool_total else 0.0,
            "total_cp_loss": total_cp_loss,
            "avg_cp_loss": round(total_cp_loss / len(rows)) if rows else None,
            "worst_cp_loss": int(worst.get("cp_loss") or 0),
            "top_phase": top_phase,
            "top_phase_label": _phase_label(top_phase),
            "top_phase_count": top_phase_count,
            "top_opening_label": top_opening,
            "top_opening_side": top_side,
            "top_opening_count": top_opening_count,
            "representative_blunder_id": worst["id"],
            "pattern_count": len(pattern_rows),
            "_children": pattern_rows,
        })
    impact_rows.sort(
        key=lambda row: (
            -row["total_cp_loss"],
            -row["count"],
            -row["worst_cp_loss"],
            row["label"],
        )
    )
    return impact_rows


def compute_blunder_analysis(
    summaries: list[dict],
    records: list[object],
    *,
    eligible_games: int,
    max_examples: int = 12,
    max_openings: int = 10,
) -> dict:
    """Return compact category/phase/opening/example tables for blunders.html."""
    analyzed = [s for s in summaries if s and s.get("moves_analyzed")]
    record_by_url = {
        getattr(record, "url", ""): record
        for record in records
        if getattr(record, "url", "")
    }

    blunders: list[dict] = []
    for summary in analyzed:
        blunders.extend(_summary_blunders(summary, record_by_url))

    total_blunders = len(blunders)
    categorized_blunders = sum(1 for b in blunders if b.get("categories"))
    games_with_blunders = {
        b.get("game_url") for b in blunders if b.get("game_url")
    }

    blunders_sorted = sorted(
        blunders,
        key=lambda b: (
            int(b.get("cp_loss") or 0),
            int(b.get("end_time") or 0),
        ),
        reverse=True,
    )
    for idx, blunder in enumerate(blunders_sorted, start=1):
        side = blunder.get("side")
        move_prefix = f"{blunder.get('fullmove') or '?'}."
        if side == "black":
            move_prefix += ".."
        category_keys = blunder.get("categories") or []
        primary = category_keys[0] if category_keys else None
        blunder["id"] = f"blunder-{idx}"
        blunder["scramble"] = _is_scramble(blunder)
        blunder["move_label"] = (
            f"{move_prefix} "
            f"{blunder.get('played_move_san') or blunder.get('played_move_uci') or 'unknown'}"
        )
        blunder["primary_category"] = primary
        blunder["primary_category_label"] = (
            CATEGORY_LABELS.get(primary, primary.replace("_", " ").title())
            if primary else "Uncategorized"
        )
        blunder["categories_label"] = ", ".join(
            CATEGORY_LABELS.get(category, category.replace("_", " ").title())
            for category in category_keys
        )
        blunder["opening_label"] = (
            blunder.get("opening") or blunder.get("family") or "Unknown opening"
        )
        if blunder.get("fen_before"):
            blunder["position_url"] = (
                "https://lichess.org/analysis/standard/"
                + blunder["fen_before"].replace(" ", "_")
            )

    # Exclusive pools: scramble (played on a dying clock) vs clear-headed.
    # A missing clock proves nothing, so it stays in the thinking pool.
    scramble_pool = [b for b in blunders_sorted if b["scramble"]]
    clear_pool = [b for b in blunders_sorted if not b["scramble"]]

    # The summary aggregates describe the clear pool only — scramble mistakes
    # are a different failure mode with their own tree below.
    clear_total = len(clear_pool)
    category_acc: dict[str, _Accumulator] = defaultdict(_Accumulator)
    phase_acc: dict[str, _Accumulator] = defaultdict(_Accumulator)
    opening_acc: dict[tuple[str, str], _Accumulator] = defaultdict(_Accumulator)
    opening_games: dict[tuple[str, str], set[str]] = defaultdict(set)

    for blunder in clear_pool:
        cp_loss = int(blunder.get("cp_loss") or 0)
        phase = blunder.get("phase_bucket") or blunder.get("phase") or "middlegame"
        phase_acc[phase].add(cp_loss)

        for category in blunder.get("categories", []) or []:
            category_acc[category].add(cp_loss)

        family = blunder.get("family") or blunder.get("opening") or "Unknown opening"
        side = blunder.get("game_side") or blunder.get("side") or "unknown"
        key = (family, side)
        opening_acc[key].add(cp_loss)
        if blunder.get("game_url"):
            opening_games[key].add(blunder["game_url"])

    categories = [
        acc.row(
            key,
            CATEGORY_LABELS.get(key, key.replace("_", " ").title()),
            clear_total,
            description=CATEGORY_DESCRIPTIONS.get(key, ""),
        )
        for key, acc in category_acc.items()
    ]
    categories.sort(key=lambda row: (-row["count"], -row["worst_cp_loss"], row["label"]))

    phase_order = ["opening", "early_middlegame", "middlegame", "endgame"]
    phase_breakdown = [
        phase_acc[key].row(key, PHASE_LABELS.get(key, key), clear_total)
        for key in phase_order
        if key in phase_acc
    ]

    affected_openings = []
    for (family, side), acc in opening_acc.items():
        affected_openings.append(acc.row(
            f"{family}|{side}",
            family,
            clear_total,
            side=side,
            affected_games=len(opening_games[(family, side)]),
        ))
    affected_openings.sort(
        key=lambda row: (-row["count"], -row["worst_cp_loss"], row["label"])
    )

    examples = clear_pool[:max_examples]
    impact_rows = _impact_rows(clear_pool)
    scramble_impact_rows = _impact_rows(scramble_pool)

    return {
        "cache_version": ANALYSIS_CACHE_VERSION,
        "engine_coverage": {
            "analyzed_games": len(analyzed),
            "eligible_games": eligible_games,
            "games_with_blunders": len(games_with_blunders),
            "blunders_analyzed": total_blunders,
            "categorized_blunders": categorized_blunders,
            "uncategorized_blunders": total_blunders - categorized_blunders,
            "clear_blunders": len(clear_pool),
            "scramble_blunders": len(scramble_pool),
        },
        "category_labels": CATEGORY_LABELS,
        "category_descriptions": CATEGORY_DESCRIPTIONS,
        "categories": categories,
        "phase_breakdown": phase_breakdown,
        "affected_openings": affected_openings[:max_openings],
        "blunders": blunders_sorted,
        "impact_rows": impact_rows,
        "scramble_impact_rows": scramble_impact_rows,
        "examples": examples,
    }
