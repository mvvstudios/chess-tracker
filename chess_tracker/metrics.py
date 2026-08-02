"""Pure-function metric computations over a list of GameRecord."""
from collections import Counter
from datetime import datetime
import statistics
from urllib.parse import urlencode
from chess_tracker.pgn import GameRecord, opening_family, opening_variation, parse_time_control
from chess_tracker.enrich import enrich_with_deltas, enrich_with_sessions
from chess_tracker.behavior import (
    compute_loss_streaks, compute_revenge_gap, compute_daily_drawdown,
    compute_time_of_day, compute_mate_loss_buckets,
)
from chess_tracker.play_signature import fens_from_san
from chess_tracker.opening_match import match_opening
from chess_tracker.opponent_openings import compute_opponent_opening_stats
from chess_tracker.trap_patterns import compute_trap_exposures


_DRAW_RESULTS = {"agreed", "repetition", "stalemate", "insufficient",
                 "50move", "timevsinsufficient"}

OUTLASTED_EDGE_SECONDS = 5.0   # minimum clock lead (seconds) to qualify as "outlasted"
OUTLASTED_MIN_PLY_INDEX = 9    # first ply index checked (0-indexed; ply 9 = move 10)

# Maps Chess.com family labels that fragment the same opening system into one
# canonical name. Applied in compute_all() before any aggregation so all
# downstream metrics (variations, plan compliance, sessions) see one name.
FAMILY_ALIASES: dict[str, str] = {
    "London System":   "Queens Pawn Opening",
    "Colle System":    "Queens Pawn Opening",
    "Bishops Opening": "Italian Game",
}


def _is_win(r: str) -> bool:
    return r == "win"


def _is_draw(r: str) -> bool:
    return r in _DRAW_RESULTS


def _is_loss(r: str) -> bool:
    return not _is_win(r) and not _is_draw(r)


def _tilt_color(win_pct: float) -> str:
    if win_pct >= 60:
        return "green"
    if win_pct >= 40:
        return "yellow"
    return "red"


def compute_kpis(records: list[GameRecord]) -> dict:
    if not records:
        return {"current_rating": None, "games_total": 0,
                "recent_form_win_pct": 0.0, "tilt": "yellow"}
    last = max(records, key=lambda r: r.end_time)
    last_5 = sorted(records, key=lambda r: r.end_time)[-5:]
    wins5 = sum(1 for r in last_5 if _is_win(r.result))
    form_pct = 100.0 * wins5 / len(last_5)
    return {
        "current_rating": last.my_rating,
        "games_total": len(records),
        "recent_form_win_pct": round(form_pct, 1),
        "tilt": _tilt_color(form_pct),
    }


def compute_sessions(records: list[GameRecord], gap_seconds: int = 600) -> list[dict]:
    if not records:
        return []
    ordered = sorted(records, key=lambda r: r.end_time)
    sessions = []
    current = [ordered[0]]
    for r in ordered[1:]:
        if r.end_time - current[-1].end_time > gap_seconds:
            sessions.append(current)
            current = []
        current.append(r)
    sessions.append(current)

    # For each session, the "start rating" should be the postgame rating of
    # the prior global game (so the first game of the session contributes to
    # the session delta). For the very first session in the dataset there is
    # no prior game — fall back to the first game's postgame rating and flag
    # rating_start_exact=False so consumers can show an asterisk.
    out = []
    prev_end_rating = None  # postgame rating of last record in the previous session
    for s in sessions:
        wins = sum(1 for r in s if _is_win(r.result))
        losses = sum(1 for r in s if _is_loss(r.result))
        draws = sum(1 for r in s if _is_draw(r.result))
        if prev_end_rating is not None:
            rating_start = prev_end_rating
            rating_start_exact = True
        else:
            rating_start = s[0].my_rating
            rating_start_exact = False
        rating_end = s[-1].my_rating
        delta = rating_end - rating_start
        out.append({
            "start": datetime.fromtimestamp(s[0].end_time).astimezone().isoformat(),
            "games": len(s),
            "duration_minutes": round((s[-1].end_time - s[0].end_time) / 60, 1),
            "wins": wins, "losses": losses, "draws": draws,
            "rating_start": rating_start,
            "rating_start_exact": rating_start_exact,
            "rating_end": rating_end,
            "rating_delta": delta,
            "tilt_flag": delta <= -50,
        })
        prev_end_rating = rating_end
    return out


def _result_letter(r: GameRecord) -> str:
    if _is_win(r.result): return "W"
    if _is_draw(r.result): return "D"
    return "L"


def _ply_clock(clocks: list[float], ply_index: int) -> float | None:
    """Return clock at a specific 0-indexed ply, or None if game was shorter."""
    if 0 <= ply_index < len(clocks):
        return clocks[ply_index]
    return None


def _bucket_stats(recs: list[GameRecord]) -> dict:
    n = len(recs)
    if n == 0:
        return {"games": 0, "win_pct": 0.0, "flag_pct": 0.0, "mate_pct": 0.0}
    wins = sum(1 for r in recs if _is_win(r.result))
    losses_recs = [r for r in recs if _is_loss(r.result)]
    losses = len(losses_recs)
    flag = sum(1 for r in losses_recs if r.result == "timeout")
    mate = sum(1 for r in losses_recs if r.result == "checkmated")
    return {
        "games": n,
        "win_pct": round(100 * wins / n, 1),
        "flag_pct": round(100 * flag / losses, 1) if losses else 0.0,
        "mate_pct": round(100 * mate / losses, 1) if losses else 0.0,
    }


def compute_process_metrics(records: list[GameRecord]) -> dict:
    """Clock-behavior metrics — the bullet-specific process signals."""
    if not records:
        return {
            "reserve_move_10_median": None,
            "reserve_move_20_median": None,
            "opening_velocity_median": None,
            "time_burn_delta": None,
            "outlasted_but_flagged_count": 0,
        }

    # Reserve at end of move 10 = my_clocks[9] (one entry per my-move; 0-indexed)
    res10 = [c for r in records if (c := _ply_clock(r.my_clocks, 9)) is not None]
    res20 = [c for r in records if (c := _ply_clock(r.my_clocks, 19)) is not None]

    # Opening velocity: seconds spent on my first 8 moves.
    # Use the game's actual starting clock, not a hardcoded bullet assumption.
    velocities = []
    for r in records:
        c = _ply_clock(r.my_clocks, 7)
        if c is not None:
            start_sec, _ = parse_time_control(r.time_control)
            velocities.append(round(start_sec - c, 2))

    # Time burn delta: mean s/move across my moves 1-8 vs my moves 9-20.
    # early_total uses the game's actual starting clock (not hardcoded 60s).
    # late_total is a clock delta and is unaffected by the starting clock.
    early_rates = []
    late_rates = []
    for r in records:
        if len(r.my_clocks) >= 8:
            start_sec, _ = parse_time_control(r.time_control)
            early_total = start_sec - r.my_clocks[7]
            early_rates.append(early_total / 8)
        if len(r.my_clocks) >= 20:
            late_total = r.my_clocks[7] - r.my_clocks[19]
            late_rates.append(late_total / 12)

    time_burn_delta = None
    if early_rates and late_rates:
        time_burn_delta = round(
            statistics.mean(early_rates) - statistics.mean(late_rates), 2)

    # "Outlasted but flagged": timeout-losses where I had a ≥5s clock edge
    # at some ply from move 10 onward (my_clocks index ≥ 9). Tiny early
    # edges don't count — this isolates panic-conversion failures.
    outlasted = 0
    for r in records:
        if r.result != "timeout":
            continue
        common = min(len(r.my_clocks), len(r.opp_clocks))
        for i in range(OUTLASTED_MIN_PLY_INDEX, common):
            if r.my_clocks[i] - r.opp_clocks[i] >= OUTLASTED_EDGE_SECONDS:
                outlasted += 1
                break

    return {
        "reserve_move_10_median": round(statistics.median(res10), 1) if res10 else None,
        "reserve_move_20_median": round(statistics.median(res20), 1) if res20 else None,
        "opening_velocity_median": round(statistics.median(velocities), 2) if velocities else None,
        "time_burn_delta": time_burn_delta,
        "outlasted_but_flagged_count": outlasted,
    }


def _session_position_groups(records: list[GameRecord], gap_seconds: int = 600) -> dict[str, list[GameRecord]]:
    if not records:
        return {"1-5": [], "6-10": [], "11-20": [], "21+": []}
    if any(r.session_id is None for r in records):
        enrich_with_sessions(records, gap_seconds)
    out: dict[str, list[GameRecord]] = {"1-5": [], "6-10": [], "11-20": [], "21+": []}
    for r in records:
        pos = r.game_index_in_session
        if pos <= 5:
            out["1-5"].append(r)
        elif pos <= 10:
            out["6-10"].append(r)
        elif pos <= 20:
            out["11-20"].append(r)
        else:
            out["21+"].append(r)
    return out


def compute_session_decay(records: list[GameRecord], gap_seconds: int = 600) -> list[dict]:
    """Win/flag/mate stats bucketed by position within session."""
    groups = _session_position_groups(records, gap_seconds)
    return [{"bucket": b, **_bucket_stats(recs)} for b, recs in groups.items()]


def _post_peak_decay(decay: list[dict]) -> tuple[bool, dict | None, dict | None]:
    """Detect peak-then-crash within session-position buckets.

    Returns (fired, peak_row, last_row). Fires iff there are >=2 buckets with
    games >= 5, the peak (highest win_pct, tie-broken by latest position) is
    not the same bucket as `last` (highest-position eligible), and
    peak.win_pct - last.win_pct >= 10.
    """
    bucket_order = {"1-5": 0, "6-10": 1, "11-20": 2, "21+": 3}
    eligible = [row for row in decay if row.get("games", 0) >= 5]
    if len(eligible) < 2:
        return False, None, None
    peak = max(eligible, key=lambda r: (r["win_pct"], bucket_order[r["bucket"]]))
    last = max(eligible, key=lambda r: bucket_order[r["bucket"]])
    if peak["bucket"] == last["bucket"]:
        return False, peak, last
    if peak["win_pct"] - last["win_pct"] >= 10:
        return True, peak, last
    return False, peak, last


def detect_leaks(records: list[GameRecord]) -> list[dict]:
    """Rule-based leak detection over the recent window."""
    leaks = []
    if not records:
        return leaks
    # Window: last 30 games (or all if fewer)
    ordered = sorted(records, key=lambda r: r.end_time)
    window = ordered[-30:]

    pm = compute_process_metrics(window)

    # Time burn in opening. Spec says mean; we use median across games (robust to one slow think).
    if pm["opening_velocity_median"] is not None and pm["opening_velocity_median"] > 8.0:
        leaks.append({
            "name": "time_burn_opening",
            "severity": "critical" if pm["opening_velocity_median"] > 15 else "warn",
            "evidence": f"median {pm['opening_velocity_median']}s on my first 8 moves (target <8s)",
            "suggested_action": "Move 8 with ≥50s left; pre-pick first 6 moves before sit-down.",
        })

    # Flag-loss dominant
    losses_recs = [r for r in window if _is_loss(r.result)]
    if losses_recs:
        flag_pct = 100 * sum(1 for r in losses_recs if r.result == "timeout") / len(losses_recs)
        mate_pct = 100 * sum(1 for r in losses_recs if r.result == "checkmated") / len(losses_recs)
        if flag_pct >= 60:
            leaks.append({
                "name": "flag_loss_dominant",
                "severity": "warn",
                "evidence": f"{flag_pct:.0f}% of losses are timeouts in the last {len(window)} games",
                "suggested_action": "Reserve at move 20 too low; try 1+1 format to convert wins.",
            })
        if mate_pct >= 55:
            leaks.append({
                "name": "mate_loss_dominant",
                "severity": "warn",
                "evidence": f"{mate_pct:.0f}% of losses are checkmates in the last {len(window)} games",
                "suggested_action": "Middlegame tactics — file recurring patterns in the error log.",
            })

        # Outlasted-but-flagged: of the timeouts in the window, how many had
        # us ahead on the clock at some recorded ply? Min-4 timeouts gate
        # avoids 1/1 or 2/2 noise. >= 45% → critical, >= 30% → warn —
        # calibrated against 627 rolling 30-game windows of bullet history
        # (P90 ~29%, P99 ~40%, observed max 50%); the prior 70/50 cut never
        # fired against this player's actual distribution.
        timeouts = sum(1 for r in losses_recs if r.result == "timeout")
        if timeouts >= 4:
            outlasted = pm["outlasted_but_flagged_count"]
            pct = 100 * outlasted / timeouts
            if pct >= 45:
                sev = "critical"
            elif pct >= 30:
                sev = "warn"
            else:
                sev = None
            if sev is not None:
                leaks.append({
                    "name": "outlasted_but_flagged",
                    "severity": sev,
                    "evidence": f"{outlasted} of {timeouts} timeout losses ({pct:.0f}%) had you ahead on the clock at some ply",
                    "suggested_action": "Convert clock leads: simplify and trade in winning positions instead of grinding for more.",
                })

    # Any abandonment in last 30 games is a high-confidence tilt signal.
    abandoned = [r for r in window if r.result == "abandoned"]
    if abandoned:
        leaks.append({
            "name": "abandonment",
            "severity": "critical",
            "evidence": f"{len(abandoned)} abandoned game(s) in the last {len(window)} games",
            "suggested_action": "Walk away after the urge to close the tab — that is the stop signal.",
        })

    # Post-peak decay & tilt-session use full history; 30-game window starves the 21+ bucket.
    decay = compute_session_decay(records)
    fired, peak, last = _post_peak_decay(decay)
    if fired:
        leaks.append({
            "name": "post_peak_decay",
            "severity": "warn",
            "evidence": (
                f"win% drops from {peak['win_pct']:.0f}% in games {peak['bucket']} "
                f"to {last['win_pct']:.0f}% in games {last['bucket']}"
            ),
            "suggested_action": "Cap sessions — see Next Session Rule.",
        })

    # Tilt sessions in last 24h
    sessions = compute_sessions(records)
    now_seen = max(r.end_time for r in records)
    recent = [s for s in sessions if (now_seen - int(datetime.fromisoformat(s["start"]).timestamp())) < 86400]
    if any(s["tilt_flag"] for s in recent):
        leaks.append({
            "name": "tilt_session",
            "severity": "critical",
            "evidence": f"{sum(1 for s in recent if s['tilt_flag'])} session(s) lost ≥50 rating in last 24h",
            "suggested_action": "Stop-rule: leave the desk after -50 in 30 min.",
        })

    return leaks


def recent_losses_with_suggestions(records: list[GameRecord], limit: int = 20) -> list[dict]:
    """Recent losses with auto-generated error_log starter entries."""
    losses = sorted(
        [r for r in records if _is_loss(r.result)],
        key=lambda r: r.end_time,
        reverse=True,
    )[:limit]

    out = []
    for r in losses:
        final_clk = r.my_clocks[-1] if r.my_clocks else None
        if r.result == "timeout":
            title = f"Flagged at move {r.fullmoves} in {r.opening or 'unknown'}"
            pattern = (
                f"Ran out of time at move {r.fullmoves}. "
                f"Final clock {final_clk}s. Opponent rating {r.opp_rating}."
            )
        elif r.result == "checkmated":
            title = f"Mated by move {r.fullmoves} in {r.opening or 'unknown'}"
            pattern = (
                f"Checkmated at move {r.fullmoves} with {final_clk}s on clock. "
                f"Opponent rating {r.opp_rating}."
            )
        else:
            title = f"Lost ({r.result}) in {r.opening or 'unknown'}"
            pattern = f"Result {r.result} at move {r.fullmoves}."

        out.append({
            "game_url": r.url,
            "opening": r.opening,
            "eco": r.eco,
            "loss_type": r.result,
            "final_clock": final_clk,
            "moves": r.fullmoves,
            "opp_rating_diff": r.opp_rating - r.my_rating,
            "suggested_entry": {
                "title": title,
                "pattern": pattern,
                "game_refs": [r.url],
            },
        })
    return out


def compute_review_picks(records: list[GameRecord], window: int = 30) -> list[dict]:
    """Pick up to 3 recent-loss games worth a manual review.

    - biggest_loss: the loss in the recent window with the most-negative rating_delta.
    - timeout: the most recent timeout loss in the window.
    - fast_mate: the most recent checkmated loss with fullmoves <= 15.

    Each pick carries a one-line `question` framing what to look for.
    Returns [] if no losses in the window.

    Requires `enrich_with_deltas(records)` to have run first for accurate
    biggest_loss selection. `compute_all` enriches before calling.
    """
    if not records:
        return []
    ordered = sorted(records, key=lambda r: r.end_time)
    win_recs = ordered[-window:]
    losses = [r for r in win_recs if _is_loss(r.result)]
    if not losses:
        return []
    picks = []
    seen_urls = set()

    losses_with_delta = [r for r in losses if r.rating_delta is not None]
    if losses_with_delta:
        biggest = min(losses_with_delta, key=lambda r: r.rating_delta)
        picks.append({
            "kind": "biggest_loss",
            "url": biggest.url,
            "moves": biggest.fullmoves,
            "loss_type": biggest.result,
            "rating_delta": biggest.rating_delta,
            "question": "What single move made the position lost? Mark the ply.",
        })
        seen_urls.add(biggest.url)

    timeouts = [r for r in losses if r.result == "timeout" and r.url not in seen_urls]
    if timeouts:
        recent_timeout = timeouts[-1]
        picks.append({
            "kind": "timeout",
            "url": recent_timeout.url,
            "moves": recent_timeout.fullmoves,
            "loss_type": "timeout",
            "rating_delta": recent_timeout.rating_delta,
            "question": "At which move did the clock first slip below the opponent's by 5+ seconds?",
        })
        seen_urls.add(recent_timeout.url)

    fast_mates = [r for r in losses
                  if r.result == "checkmated" and r.fullmoves <= 15
                  and r.url not in seen_urls]
    if fast_mates:
        recent_fm = fast_mates[-1]
        picks.append({
            "kind": "fast_mate",
            "url": recent_fm.url,
            "moves": recent_fm.fullmoves,
            "loss_type": "checkmated",
            "rating_delta": recent_fm.rating_delta,
            "question": "Which opponent move first threatened mate? What did you miss?",
        })
    return picks


def compute_opening_families(records: list[GameRecord], plan: dict | None = None) -> list[dict]:
    """Tier-1 aggregation: group records by (family, color).

    One row per family-color combo. Mirrors compute_play_signatures schema
    where applicable, plus `variation_count` (how many distinct play_signatures
    fall under this family-color). Drives the main-page family tables;
    variations within a family live on the opening detail page.

    Requires `enrich_with_deltas(records)` to have run first — otherwise
    every row's `sum_rating_delta` / `avg_rating_delta` silently returns 0.
    `compute_all` enriches before calling.
    """
    plan_lookup: dict[tuple[str, str], str] = {}
    for op in (plan or {}).get("openings", []):
        if not isinstance(op, dict):
            continue
        tf = op.get("target_family")
        side = op.get("side")
        if tf and side:
            plan_lookup[(tf, side)] = op.get("status", "active")

    # Baseline uses ALL records (incl. unclassified families) — true player win rate.
    total_records = len(records)
    overall_win_pct = (
        sum(1 for r in records if _is_win(r.result)) / total_records
        if total_records else 0.5
    )

    groups: dict[tuple[str, str], list[GameRecord]] = {}
    sig_keys: dict[tuple[str, str], set] = {}
    for r in records:
        if r.family is None:
            continue
        key = (FAMILY_ALIASES.get(r.family, r.family), r.side)
        groups.setdefault(key, []).append(r)
        if r.play_signature is not None:
            sig_keys.setdefault(key, set()).add(r.play_signature)

    out = []
    for (family, color), recs in groups.items():
        recs = sorted(recs, key=lambda r: r.end_time)
        n = len(recs)
        wins = sum(1 for r in recs if _is_win(r.result))
        losses_recs = [r for r in recs if _is_loss(r.result)]
        losses = len(losses_recs)
        draws = n - wins - losses
        flag = sum(1 for r in losses_recs if r.result == "timeout")
        mate = sum(1 for r in losses_recs if r.result == "checkmated")
        # Rating-weighted aggregates (require enrich_with_deltas to have run).
        deltas = [r.rating_delta for r in recs if r.rating_delta is not None]
        sum_delta = sum(deltas)
        avg_delta = round(sum_delta / len(deltas), 1) if deltas else 0.0
        timeout_delta = sum(
            r.rating_delta for r in recs
            if r.result == "timeout" and r.rating_delta is not None
        )
        mate_delta = sum(
            r.rating_delta for r in recs
            if r.result == "checkmated" and r.rating_delta is not None
        )
        med_len = statistics.median([r.fullmoves for r in recs])
        avg_opp = round(statistics.mean([r.opp_rating for r in recs]), 0)
        rating_gap = round(statistics.mean([r.my_rating - r.opp_rating for r in recs]), 0)
        eco_counts = Counter(r.eco for r in recs if r.eco)
        eco_top = eco_counts.most_common(1)[0][0] if eco_counts else None
        sig_counts = Counter(r.play_signature for r in recs if r.play_signature)
        canonical_sig = sig_counts.most_common(1)[0][0] if sig_counts else None
        plan_status = plan_lookup.get((family, color))

        smoothed_win_rate = round((wins + 2) / (n + 4), 3)

        if n < 10:
            sample_strength = "ignore"
        elif n < 30:
            sample_strength = "weak"
        elif n < 100:
            sample_strength = "usable"
        else:
            sample_strength = "strong"

        if plan_status == "active":
            repertoire_weight = 2.0
        else:
            repertoire_weight = 0.25
        underperformance = max(0.0, overall_win_pct - smoothed_win_rate)
        priority = round(n * underperformance * repertoire_weight, 2)

        out.append({
            "family": family,
            "color": color,
            "eco": eco_top,
            "games": n,
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "win_pct": round(100 * wins / n, 1),
            "flag_pct": round(100 * flag / losses, 1) if losses else 0.0,
            "mate_pct": round(100 * mate / losses, 1) if losses else 0.0,
            "sum_rating_delta": sum_delta,
            "avg_rating_delta": avg_delta,
            "timeout_rating_delta": timeout_delta,
            "checkmate_rating_delta": mate_delta,
            "med_len": med_len,
            "avg_opp_rating": int(avg_opp),
            "rating_gap": int(rating_gap),
            "variation_count": len(sig_keys.get((family, color), set())),
            "canonical_play_signature": canonical_sig,
            "form": [_result_letter(r) for r in recs[-10:]],
            "plan_status": plan_status,
            "smoothed_win_rate": smoothed_win_rate,
            "sample_strength": sample_strength,
            "is_rare": n < 10,
            "priority": priority,
        })
    out.sort(key=lambda x: (x["sum_rating_delta"], -x["games"]))
    return out


def compute_opening_variations(records: list[GameRecord]) -> list[dict]:
    """Tier-2 aggregation: group records by (family, variation, color).

    One row per unique named variation. The same variation reached via
    different move orders / transpositions (which produce different
    play_signatures) collapses into a single row. ``canonical_play_signature``
    is the most-frequent play_signature in the group — used to show a
    representative board on the opening detail page.

    Requires `enrich_with_deltas(records)` to have run first — otherwise
    every row's `sum_rating_delta` / `avg_rating_delta` silently returns 0.
    `compute_all` enriches before calling.
    """
    groups: dict[tuple[str, str, str], list[GameRecord]] = {}
    for r in records:
        if r.family is None:
            continue
        # variation may be None (no opening label parsed) or "" (main line)
        var = r.variation if r.variation is not None else ""
        key = (FAMILY_ALIASES.get(r.family, r.family), var, r.side)
        groups.setdefault(key, []).append(r)

    out = []
    for (family, variation, color), recs in groups.items():
        recs = sorted(recs, key=lambda r: r.end_time)
        n = len(recs)
        wins = sum(1 for r in recs if _is_win(r.result))
        losses_recs = [r for r in recs if _is_loss(r.result)]
        losses = len(losses_recs)
        draws = n - wins - losses
        flag = sum(1 for r in losses_recs if r.result == "timeout")
        mate = sum(1 for r in losses_recs if r.result == "checkmated")
        # Rating-weighted aggregates (require enrich_with_deltas to have run).
        deltas = [r.rating_delta for r in recs if r.rating_delta is not None]
        sum_delta = sum(deltas)
        avg_delta = round(sum_delta / len(deltas), 1) if deltas else 0.0
        timeout_delta = sum(
            r.rating_delta for r in recs
            if r.result == "timeout" and r.rating_delta is not None
        )
        mate_delta = sum(
            r.rating_delta for r in recs
            if r.result == "checkmated" and r.rating_delta is not None
        )
        med_len = statistics.median([r.fullmoves for r in recs])
        avg_opp = round(statistics.mean([r.opp_rating for r in recs]), 0)
        rating_gap = round(statistics.mean([r.my_rating - r.opp_rating for r in recs]), 0)
        eco_counts = Counter(r.eco for r in recs if r.eco)
        eco_top = eco_counts.most_common(1)[0][0] if eco_counts else None
        sig_counts = Counter(r.play_signature for r in recs if r.play_signature)
        canonical_sig = sig_counts.most_common(1)[0][0] if sig_counts else None
        canonical_fens = None
        canonical_move_labels = None
        if canonical_sig:
            rep = next(
                (r for r in recs if r.play_signature == canonical_sig and r.first_moves),
                None,
            )
            if rep:
                _fens, _labels = fens_from_san(rep.first_moves)
                if len(_fens) > 1:
                    canonical_fens = _fens
                    canonical_move_labels = _labels
        out.append({
            "family": family,
            "variation": variation,
            "color": color,
            "eco": eco_top,
            "games": n,
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "win_pct": round(100 * wins / n, 1),
            "flag_pct": round(100 * flag / losses, 1) if losses else 0.0,
            "mate_pct": round(100 * mate / losses, 1) if losses else 0.0,
            "sum_rating_delta": sum_delta,
            "avg_rating_delta": avg_delta,
            "timeout_rating_delta": timeout_delta,
            "checkmate_rating_delta": mate_delta,
            "med_len": med_len,
            "avg_opp_rating": int(avg_opp),
            "rating_gap": int(rating_gap),
            "position_count": len(sig_counts),
            "canonical_play_signature": canonical_sig,
            "canonical_fens": canonical_fens,
            "canonical_move_labels": canonical_move_labels,
            "form": [_result_letter(r) for r in recs[-10:]],
        })
    out.sort(key=lambda x: (x["sum_rating_delta"], -x["games"]))
    return out


def compute_play_signatures(records: list[GameRecord]) -> list[dict]:
    """Group records by (play_signature, color). Records without a
    play_signature (game < 8 plies) are skipped. Each row carries
    display_name = most common opening label among the group's games.
    """
    groups: dict[tuple[str, str], list[GameRecord]] = {}
    for r in records:
        if r.play_signature is None:
            continue
        key = (r.play_signature, r.side)
        groups.setdefault(key, []).append(r)

    out = []
    for (sig, color), recs in groups.items():
        recs = sorted(recs, key=lambda r: r.end_time)
        # display_name ties break on earliest-end_time of the tied label
        # (Counter.most_common is insertion-order on ties; recs is end_time-sorted).
        name_counts = Counter(r.opening for r in recs if r.opening)
        display_name = name_counts.most_common(1)[0][0] if name_counts else "Unnamed"
        n = len(recs)
        wins = sum(1 for r in recs if _is_win(r.result))
        losses_recs = [r for r in recs if _is_loss(r.result)]
        losses = len(losses_recs)
        draws = n - wins - losses
        flag = sum(1 for r in losses_recs if r.result == "timeout")
        mate = sum(1 for r in losses_recs if r.result == "checkmated")
        med_len = statistics.median([r.fullmoves for r in recs])
        avg_opp = round(statistics.mean([r.opp_rating for r in recs]), 0)
        rating_gap = round(statistics.mean([r.my_rating - r.opp_rating for r in recs]), 0)
        eco_counts = Counter(r.eco for r in recs if r.eco)
        eco_top = eco_counts.most_common(1)[0][0] if eco_counts else None
        # Representative move sequence: first game's SAN (records are
        # sorted by end_time, so this is the earliest-played bucket entry).
        first_moves = next((r.first_moves for r in recs if r.first_moves), None)
        out.append({
            "play_signature": sig,
            "first_moves": first_moves,
            "display_name": display_name,
            "family": opening_family(display_name),
            "variation": opening_variation(display_name),
            "color": color,
            "eco": eco_top,
            "games": n,
            "wins": wins,
            "losses": losses,
            "draws": draws,
            "win_pct": round(100 * wins / n, 1),
            "flag_pct": round(100 * flag / losses, 1) if losses else 0.0,
            "mate_pct": round(100 * mate / losses, 1) if losses else 0.0,
            "med_len": med_len,
            "avg_opp_rating": int(avg_opp),
            "rating_gap": int(rating_gap),
            "form": [_result_letter(r) for r in recs[-10:]],
        })
    out.sort(key=lambda x: (-x["games"], -x["win_pct"]))
    return out


def compute_plan_compliance(records: list[GameRecord], plan: dict,
                            window: int = 30) -> dict:
    """For each opening in the plan, measure adherence over the last N games.

    For an opening entry like {"side":"black","vs_first_move":"e4",
    "target_family":"Modern Defense"}, we filter games on the last `window`
    games to those played as the given side where White's first move matches
    `vs_first_move` (if specified). Of those *applicable* games, we count
    how many had family == target_family (on-plan) and compute win rates
    both when on-plan and when deviated.

    Severity assignment for the dashboard:
      adherence_pct >= 60 → "green"
      adherence_pct >= 40 → "yellow"
      adherence_pct <  40 → "red"
    If no applicable games occurred in the window, severity is "neutral"
    (no opportunity to adhere — don't punish).
    """
    if not records:
        return {"openings": [], "window": window}
    ordered = sorted(records, key=lambda r: r.end_time)
    window_recs = ordered[-window:]

    out_openings = []
    for op in plan.get("openings", []):
        side = op.get("side")
        vs_move = op.get("vs_first_move")
        target = op.get("target_family")
        applicable = [r for r in window_recs if r.side == side]
        if vs_move:
            prefix = f"1.{vs_move.lower()}"
            applicable = [r for r in applicable
                          if r.first_moves
                          and r.first_moves.lower().startswith(prefix)]
        match_rule = op.get("match")
        gambit_breakdown = None
        if match_rule:
            verdicts = [(r, match_opening(r.opening_moves or r.first_moves,
                                          match_rule)) for r in applicable]
            applicable_recs = [r for r, m in verdicts if m["applicable"]]
            played = [r for r, m in verdicts if m["applicable"] and m["on_plan"]]
            deviated = [r for r, m in verdicts
                        if m["applicable"] and not m["on_plan"]]
            total = len(applicable_recs)
            if match_rule.get("gambit_flags"):
                gambit_breakdown = {}
                for r, m in verdicts:
                    if m["applicable"] and m["on_plan"]:
                        for flag in m["flags"]:
                            gambit_breakdown[flag] = gambit_breakdown.get(flag, 0) + 1
        else:
            total = len(applicable)
            played = [r for r in applicable if r.family == target]
            deviated = [r for r in applicable if r.family != target]
        played_wins = sum(1 for r in played if _is_win(r.result))
        dev_wins = sum(1 for r in deviated if _is_win(r.result))
        adherence_pct = (100 * len(played) / total) if total else 0.0
        if total == 0:
            severity = "neutral"
        elif adherence_pct >= 60:
            severity = "green"
        elif adherence_pct >= 40:
            severity = "yellow"
        else:
            severity = "red"
        fens, ply_labels = fens_from_san(op.get("moves", ""))
        # Multi-line cards (e.g. Four Knights = Halloween + Belgrade): precompute
        # a board per named line. None for ordinary single-line openings.
        board_lines = None
        if op.get("lines"):
            board_lines = []
            for ln in op["lines"]:
                f, pl = fens_from_san(ln.get("moves", ""))
                board_lines.append({
                    "label": ln.get("label", ""),
                    "moves": ln.get("moves", ""),
                    "fens": f,
                    "ply_labels": pl,
                })
        out_openings.append({
            "name": op.get("name", target),
            "side": side,
            "status": op.get("status", "active"),
            "vs_first_move": vs_move,
            "target_family": target,
            "moves": op.get("moves", ""),
            "fens": fens,
            "ply_labels": ply_labels,
            "board_lines": board_lines,
            "plan": op.get("plan", ""),
            "applicable_games": total,
            "games_on_plan": len(played),
            "adherence_pct": round(adherence_pct, 1),
            "win_pct_when_played": round(100 * played_wins / len(played), 1)
                if played else None,
            "win_pct_when_deviated": round(100 * dev_wins / len(deviated), 1)
                if deviated else None,
            "severity": severity,
            "gambit_breakdown": gambit_breakdown,
        })
    return {
        "openings": out_openings,
        "window": window,
    }


def _severity_for_recommendation(value: str | None) -> str:
    mapping = {
        "critical": "red",
        "warn": "yellow",
        "info": "neutral",
        "green": "green",
        "yellow": "yellow",
        "red": "red",
        "neutral": "neutral",
    }
    return mapping.get(value or "", "neutral")


def _signed_rating_delta(value) -> str:
    if value is None:
        return "0"
    return f"{value:+g}"


def _opening_recommendation(opening_families: list[dict]) -> dict | None:
    meaningful = [
        row for row in (opening_families or [])
        if row.get("games", 0) >= 10
        or (row.get("sample_strength") is not None and row.get("sample_strength") != "ignore")
    ]
    candidates = [
        row for row in meaningful
        if row.get("priority", 0) > 0 or row.get("sum_rating_delta", 0) < 0
    ]
    if not candidates:
        return None

    row = max(
        candidates,
        key=lambda r: (
            r.get("priority", 0),
            -r.get("sum_rating_delta", 0),
            r.get("games", 0),
            r.get("family", ""),
            r.get("color", ""),
        ),
    )
    delta = _signed_rating_delta(row.get("sum_rating_delta"))
    family = row.get("family") or "opening"
    color = row.get("color") or "unknown"
    severity = (
        "red"
        if row.get("sum_rating_delta", 0) <= -30 or row.get("win_pct", 100) < 40
        else "yellow"
    )
    query = urlencode({"family": family, "color": color})
    return {
        "title": f"Study {family} as {str(color).title()}",
        "reason": (
            f"{row.get('games', 0)} games, {row.get('win_pct', 0)}% win rate, "
            f"{delta} rating delta."
        ),
        "action": "Review the recurring line and choose one default response.",
        "severity": severity,
        "href": f"opening.html?{query}",
    }


def _leak_recommendation(leak_summary: list[dict]) -> dict | None:
    leak = next(
        (row for row in (leak_summary or [])
         if row.get("severity") in {"critical", "warn"}),
        None,
    )
    if leak is None:
        return None

    titles = {
        "time_burn_opening": "Tighten opening clock process",
        "flag_loss_dominant": "Reduce flag losses",
        "mate_loss_dominant": "Run a safety review",
        "outlasted_but_flagged": "Convert clock leads",
        "abandonment": "Use the stop signal",
        "post_peak_decay": "Cap session length",
        "tilt_session": "Enforce the stop rule",
    }
    process_names = {
        "time_burn_opening",
        "flag_loss_dominant",
        "outlasted_but_flagged",
        "post_peak_decay",
        "tilt_session",
    }
    name = leak.get("name", "process")
    return {
        "title": titles.get(name, f"Fix {name.replace('_', ' ')}"),
        "reason": leak.get("evidence", ""),
        "action": leak.get("suggested_action", ""),
        "severity": _severity_for_recommendation(leak.get("severity")),
        "href": "process.html" if name in process_names else "leaks.html",
    }


def _review_pick_recommendation(review_picks: list[dict]) -> dict | None:
    if not review_picks:
        return None
    pick = review_picks[0]
    kind_title = {
        "biggest_loss": "Review the biggest recent loss",
        "timeout": "Review a clock loss",
        "fast_mate": "Review a fast mate",
    }
    parts = [
        f"{pick.get('loss_type', 'loss')} loss",
        f"{pick.get('moves', 0)} moves",
    ]
    if pick.get("rating_delta") is not None:
        parts.append(f"{_signed_rating_delta(pick.get('rating_delta'))} rating delta")
    rating_delta = pick.get("rating_delta")
    severity = "red" if rating_delta is not None and rating_delta <= -20 else "yellow"
    return {
        "title": kind_title.get(pick.get("kind"), "Review a recent loss"),
        "reason": ", ".join(parts) + ".",
        "action": pick.get("question", ""),
        "severity": severity,
        "href": "losses.html",
    }


def compute_study_recommendations(
    opening_families: list[dict] | None = None,
    leak_summary: list[dict] | None = None,
    recent_losses: list[dict] | None = None,
    review_picks: list[dict] | None = None,
    process_metrics: dict | None = None,
    limit: int = 3,
) -> list[dict]:
    """Return concise coach-style next-study cards from existing metrics."""
    del recent_losses, process_metrics  # Inputs kept for stable helper shape.
    cards = [
        _opening_recommendation(opening_families or []),
        _leak_recommendation(leak_summary or []),
        _review_pick_recommendation(review_picks or []),
    ]
    return [card for card in cards if card is not None][:limit]


def compute_all(records: list[GameRecord], annotations: dict,
                username: str, format: str = "bullet",
                low_confidence_threshold: int = 15,
                plan: dict | None = None,
                blunder_phases: dict | None = None,
                engine_coverage: dict | None = None,
                blunder_analysis: dict | None = None) -> dict:
    """Top-level dashboard payload. All panel data merged + annotations applied."""
    blocked = set(annotations.get("blocked_dates", []))
    if blocked:
        records = [r for r in records
                   if datetime.fromtimestamp(r.end_time).astimezone().date().isoformat()
                   not in blocked]
    enrich_with_deltas(records)
    enrich_with_sessions(records)

    play_signatures = compute_play_signatures(records)
    opening_notes = annotations.get("openings", {})
    for row in play_signatures:
        ann = opening_notes.get(row["display_name"], {})
        row["tag"] = ann.get("tag", "")
        row["note"] = ann.get("note", "")
        row["low_confidence"] = row["games"] < low_confidence_threshold

    leak_summary = detect_leaks(records)
    recent_losses = recent_losses_with_suggestions(records)
    review_picks = compute_review_picks(records)
    process_metrics = {
        **compute_process_metrics(records),
        "session_decay": compute_session_decay(records),
    }
    opening_families = compute_opening_families(records, plan=plan or {})
    study_recommendations = compute_study_recommendations(
        opening_families=opening_families,
        leak_summary=leak_summary,
        recent_losses=recent_losses,
        review_picks=review_picks,
        process_metrics=process_metrics,
    )

    return {
        "username": username,
        "format": format,
        "generated_at": datetime.now().astimezone().isoformat(),
        "kpis": compute_kpis(records),
        "leak_summary": leak_summary,
        "recent_losses": recent_losses,
        "review_picks": review_picks,
        "study_recommendations": study_recommendations,
        "process_metrics": process_metrics,
        "opening_families": opening_families,
        "opening_variations": compute_opening_variations(records),
        "play_signatures": play_signatures,
        "sessions": compute_sessions(records),
        "behavior": {
            "loss_streaks": compute_loss_streaks(records),
            "revenge_gap": compute_revenge_gap(records),
            "daily_drawdown": compute_daily_drawdown(records),
            "time_of_day": compute_time_of_day(records),
            "mate_loss_buckets": compute_mate_loss_buckets(records),
        },
        "error_log": annotations.get("error_log", []),
        "plan_compliance": compute_plan_compliance(records, plan or {}),
        "opponent_openings": compute_opponent_opening_stats(records),
        **compute_trap_exposures(records),
        "blunder_phases": blunder_phases or {
            "opening": {"user_move_count": 0, "blunder_count": 0, "blunder_rate": 0.0,
                        "affected_games": 0, "phase_eligible_games": 0,
                        "affected_game_pct": 0.0, "avg_loss_cp": None, "worst_single_loss_cp": None},
            "early_middlegame": {"user_move_count": 0, "blunder_count": 0, "blunder_rate": 0.0,
                                 "affected_games": 0, "phase_eligible_games": 0,
                                 "affected_game_pct": 0.0, "avg_loss_cp": None, "worst_single_loss_cp": None},
        },
        "engine_coverage": engine_coverage or {"analyzed_games": 0, "eligible_games": len(records)},
        "blunder_analysis": blunder_analysis,
    }
