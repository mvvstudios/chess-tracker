"""CLI: pull Chess.com archives → compute metrics → render dashboard."""
import argparse
import json
import sys
from pathlib import Path

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
)
from chess_tracker.blunder_phases import compute_blunder_phases
from chess_tracker.blunder_categories import compute_blunder_analysis
from chess_tracker.render import render_all_pages, DEFAULT_TEMPLATE_DIR


_FORMAT_ORDER = {"bullet": 0, "blitz": 1, "rapid": 2, "daily": 3}
_FORMAT_LABELS = {"bullet": "Bullet", "blitz": "Blitz", "rapid": "Rapid", "daily": "Daily"}
DEFAULT_ANALYSIS_MAX_GAMES = 0


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
    for loss in payload.get("recent_losses", []):
        loss["puzzle"] = None
    if args.no_puzzles:
        print("[4.5/5] Puzzle surfaces skipped (--no-puzzles).")
    else:
        print("[4.5/5] Puzzle candidates will reuse the move-quality cache.")

    if args.no_analysis or find_engine_path() is None:
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
            depth=args.analysis_depth, max_games=args.analysis_max_games)
        games_by_time_control = {
            item["key"]: [
                g for g in all_games
                if accept_game(g, item["format"], item["time_control"])
            ]
            for item in ratings_by_time_control
        }
        quality_by_time_control = run_move_quality_by_format(
            games_by_time_control, side_all, cache,
            depth=args.analysis_depth, max_games=args.analysis_max_games)
        payload["move_quality_by_time_control"] = build_move_quality_by_time_control(
            ratings_by_time_control,
            quality_by_time_control,
        )

        save_quality_cache(analysis_cache_path, cache)
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

    print(f"\nDone. Rendered to: {(dashboard_dir / 'index.html').resolve()}")
    print(f"  Browsers block file:// subresources; serve over HTTP instead:")
    print(f"    python3 -m http.server 8000")
    print(f"  Then open: http://localhost:8000/dashboard/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
