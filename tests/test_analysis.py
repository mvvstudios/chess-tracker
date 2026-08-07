# tests/test_analysis.py
import pytest
import chess

from chess_tracker.puzzles import find_engine_path


# --- pure math: win%, accuracy, classification, phase ---

def test_win_pct_is_50_at_equal():
    from chess_tracker.analysis import win_pct
    assert win_pct(0) == pytest.approx(50.0, abs=1e-6)


def test_win_pct_is_symmetric_and_monotonic():
    from chess_tracker.analysis import win_pct
    assert win_pct(-300) == pytest.approx(100 - win_pct(300), abs=1e-6)
    assert win_pct(800) > win_pct(100) > win_pct(0)


def test_accuracy_is_100_when_no_winpct_lost():
    from chess_tracker.analysis import accuracy_from_winpct_loss
    assert accuracy_from_winpct_loss(0.0) == pytest.approx(100.0, abs=0.01)


def test_accuracy_decreases_and_clamps_at_zero():
    from chess_tracker.analysis import accuracy_from_winpct_loss
    a0 = accuracy_from_winpct_loss(0.0)
    a10 = accuracy_from_winpct_loss(10.0)
    a30 = accuracy_from_winpct_loss(30.0)
    assert a0 > a10 > a30
    assert accuracy_from_winpct_loss(100.0) == 0.0  # clamped, not negative


def test_classify_thresholds():
    from chess_tracker.analysis import classify
    assert classify(5.0) == "ok"
    assert classify(10.0) == "inaccuracy"
    assert classify(20.0) == "mistake"
    assert classify(30.0) == "blunder"
    assert classify(45.0) == "blunder"


def test_game_phase_buckets():
    from chess_tracker.analysis import game_phase
    assert game_phase(fullmove=3, non_pawn_pieces=14) == "opening"
    assert game_phase(fullmove=20, non_pawn_pieces=12) == "middlegame"
    assert game_phase(fullmove=40, non_pawn_pieces=4) == "endgame"


def test_principal_variation_is_stored_as_legal_uci_and_san_prefix():
    from chess_tracker.analysis import _principal_variation

    board = chess.Board()
    info = {
        "pv": [
            chess.Move.from_uci("e2e4"),
            chess.Move.from_uci("e7e5"),
            chess.Move.from_uci("g1f3"),
        ]
    }

    uci, san = _principal_variation(board, info)

    assert uci == ["e2e4", "e7e5", "g1f3"]
    assert san == ["e4", "e5", "Nf3"]


def test_classify_blunder_categories_uses_deterministic_evidence():
    from chess_tracker.analysis import classify_blunder_categories
    cats = classify_blunder_categories(
        fullmove=7,
        phase="opening",
        cp_before=350,
        cp_after=-250,
        cp_loss=600,
        best_move_is_capture=True,
        played_move_is_capture=False,
        opponent_best_reply_captures_material=True,
        forced_mate_after=False,
    )
    assert cats == [
        "material_loss",
        "missed_capture_or_recapture",
        "opening_phase_blunder",
        "large_eval_swing",
        "conversion_error",
    ]


def test_move_eval_from_evals_computes_loss_and_label():
    from chess_tracker.analysis import MoveEval
    # Hanging the queen: eval crashes from slightly better to lost.
    m = MoveEval.from_evals(ply=4, fullmove=3, cp_before=50, cp_after=-700,
                            phase="middlegame")
    assert m.cp_loss == 750
    assert m.label == "blunder"
    # A move can't "gain" beyond best play; negative swings clamp to 0.
    clean = MoveEval.from_evals(ply=2, fullmove=2, cp_before=20, cp_after=25,
                               phase="opening")
    assert clean.cp_loss == 0
    assert clean.wp_loss == 0.0
    assert clean.label == "ok"


def test_move_eval_cp_loss_clamps_mate_evals():
    from chess_tracker.analysis import MATE_CP, MoveEval
    # Allowing mate from an equal position charges the ACPL clamp (1000), not
    # the ±10000 mate sentinel — one mate must not dominate a game's average.
    m = MoveEval.from_evals(ply=30, fullmove=16, cp_before=0, cp_after=-MATE_CP,
                            phase="endgame")
    assert m.cp_loss == 1000
    assert m.label == "blunder"  # win%-based label still sees the full swing


def test_move_eval_cp_loss_ignores_swings_beyond_lost():
    from chess_tracker.analysis import MATE_CP, MoveEval
    # Flailing from an already dead-lost position (≤ -1000) adds nothing:
    # both evals clamp to the floor, so the swing contributes 0 to ACPL.
    m = MoveEval.from_evals(ply=50, fullmove=26, cp_before=-1500,
                            cp_after=-MATE_CP, phase="endgame")
    assert m.cp_loss == 0


def test_summarize_aggregates_counts_phase_and_accuracy():
    from chess_tracker.analysis import MoveEval, summarize
    moves = [
        MoveEval.from_evals(ply=0, fullmove=1, cp_before=20, cp_after=15,
                            phase="opening"),
        MoveEval.from_evals(ply=10, fullmove=6, cp_before=30, cp_after=-500,
                            phase="middlegame"),
        MoveEval.from_evals(ply=40, fullmove=21, cp_before=-100, cp_after=-130,
                            phase="endgame"),
    ]
    s = summarize(moves)
    assert s["moves_analyzed"] == 3
    assert s["blunders"] == 1
    assert s["acpl_by_phase"]["middlegame"] == 530
    assert 0.0 <= s["accuracy"] <= 100.0


# --- aggregation + per-URL caching (pure; no engine) ---

def _summary(moves=1, acc=90.0, blunders=0, phase_acpl=None, phase_moves=None):
    return {"moves_analyzed": moves, "accuracy": acc, "blunders": blunders,
            "mistakes": 0, "inaccuracies": 0, "avg_cp_loss": 10,
            "acpl_by_phase": phase_acpl or {}, "moves_by_phase": phase_moves or {},
            "side": "white"}


def test_summarize_reports_moves_per_phase():
    from chess_tracker.analysis import MoveEval, summarize
    moves = [
        MoveEval.from_evals(0, 1, 20, 15, "opening"),
        MoveEval.from_evals(2, 2, 10, 12, "opening"),
        MoveEval.from_evals(10, 6, 30, -500, "middlegame"),
    ]
    s = summarize(moves)
    assert s["moves_by_phase"] == {"opening": 2, "middlegame": 1}


def test_attach_move_quality_serves_cache_and_analyzes_only_new():
    from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, attach_move_quality
    calls = []
    def fake(pgn, side, depth):
        calls.append((pgn, side, depth))
        return _summary(acc=90.0)
    games = [{"url": "g1", "pgn": "p1"}, {"url": "g2", "pgn": "p2"}]
    side_by_url = {"g1": "white", "g2": "black"}
    cache = {"g1": {
        "version": ANALYSIS_CACHE_VERSION,
        "depth": 12,
        "summary": _summary(acc=50.0),
    }}

    summaries = attach_move_quality(games, side_by_url, cache,
                                    depth=12, analyze_fn=fake)
    assert calls == [("p2", "black", 12)]   # g1 served from cache
    assert len(summaries) == 2
    assert summaries[0]["accuracy"] == 50.0  # cached
    assert "g2" in cache                      # newly stored


def test_attach_move_quality_reanalyzes_when_depth_differs():
    from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, attach_move_quality
    calls = []
    def fake(pgn, side, depth):
        calls.append(depth)
        return _summary(acc=90.0)
    games = [{"url": "g1", "pgn": "p1"}]
    cache = {"g1": {
        "version": ANALYSIS_CACHE_VERSION,
        "depth": 8,
        "summary": _summary(acc=50.0),
    }}

    summaries = attach_move_quality(games, {"g1": "white"}, cache,
                                    depth=12, analyze_fn=fake)
    assert calls == [12]
    assert summaries[0]["accuracy"] == 90.0
    assert cache["g1"]["depth"] == 12


def test_attach_move_quality_reanalyzes_when_cache_version_differs():
    from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, attach_move_quality
    calls = []

    def fake(pgn, side, depth):
        calls.append((pgn, side, depth))
        return _summary(acc=88.0)

    games = [{"url": "g1", "pgn": "p1"}]
    cache = {"g1": {"depth": 12, "summary": _summary(acc=50.0)}}
    summaries = attach_move_quality(games, {"g1": "white"}, cache,
                                    depth=12, analyze_fn=fake)
    assert calls == [("p1", "white", 12)]
    assert summaries[0]["accuracy"] == 88.0
    assert cache["g1"]["version"] == ANALYSIS_CACHE_VERSION


def test_attach_move_quality_reanalyzes_rounded_mistake_at_blunder_boundary():
    from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, attach_move_quality

    calls = []

    def fake(pgn, side, depth):
        calls.append((pgn, side, depth))
        summary = _summary(acc=88.0)
        summary["mistake_evidence"] = [{"wp_loss": 29.999}]
        return summary

    cached = _summary(acc=50.0)
    cached["mistake_evidence"] = [{"wp_loss": 30.0}]
    cache = {"g1": {
        "version": ANALYSIS_CACHE_VERSION,
        "depth": 12,
        "summary": cached,
    }}

    summaries = attach_move_quality(
        [{"url": "g1", "pgn": "p1"}], {"g1": "white"}, cache,
        depth=12, analyze_fn=fake,
    )

    assert calls == [("p1", "white", 12)]
    assert summaries[0]["mistake_evidence"][0]["wp_loss"] == 29.999
    assert cache["g1"]["summary"] == summaries[0]


def test_attach_move_quality_reuses_unrounded_mistake_below_blunder_boundary():
    from chess_tracker.analysis import ANALYSIS_CACHE_VERSION, attach_move_quality

    cached = _summary(acc=50.0)
    cached["mistake_evidence"] = [{"wp_loss": 29.999}]
    cache = {"g1": {
        "version": ANALYSIS_CACHE_VERSION,
        "depth": 12,
        "summary": cached,
    }}

    def should_not_run(*_args):
        raise AssertionError("unrounded Mistake evidence must remain reusable")

    summaries = attach_move_quality(
        [{"url": "g1", "pgn": "p1"}], {"g1": "white"}, cache,
        depth=12, analyze_fn=should_not_run,
    )

    assert summaries == [cached]


def test_load_quality_cache_discards_only_ambiguous_rounded_mistakes(tmp_path):
    import json
    from chess_tracker.analysis import load_quality_cache

    cache_path = tmp_path / "quality.json"
    cache_path.write_text(json.dumps({
        "ambiguous": {
            "summary": {"mistake_evidence": [{"wp_loss": "30.0"}]},
        },
        "safe-mistake": {
            "summary": {"mistake_evidence": [{"wp_loss": 29.999}]},
        },
        "valid-blunder": {
            "summary": {
                "mistake_evidence": [],
                "blunder_evidence": [{"wp_loss": 30.0}],
            },
        },
    }))

    cache = load_quality_cache(cache_path)

    assert set(cache) == {"safe-mistake", "valid-blunder"}


def test_aggregate_move_quality_weights_and_buckets():
    from chess_tracker.analysis import aggregate_move_quality
    summaries = [
        _summary(moves=10, acc=80.0, blunders=1,
                 phase_acpl={"opening": 20, "middlegame": 40},
                 phase_moves={"opening": 5, "middlegame": 5}),
        _summary(moves=10, acc=60.0, blunders=3,
                 phase_acpl={"middlegame": 60},
                 phase_moves={"middlegame": 10}),
    ]
    a = aggregate_move_quality(summaries)
    assert a["games_analyzed"] == 2
    assert a["moves_analyzed"] == 20
    assert a["blunders"] == 4
    assert a["blunders_per_100_moves"] == 20.0
    assert a["accuracy"] == 70.0                       # moves-weighted mean
    assert a["acpl_by_phase"]["opening"] == 20
    assert a["acpl_by_phase"]["middlegame"] == 53       # (40*5 + 60*10)/15


def test_aggregate_move_quality_empty_is_none():
    from chess_tracker.analysis import aggregate_move_quality
    assert aggregate_move_quality([]) is None


def test_select_recent_games_takes_newest_n():
    from chess_tracker.analysis import select_recent_games
    games = [{"url": "a", "end_time": 1}, {"url": "b", "end_time": 3},
             {"url": "c", "end_time": 2}]
    out = select_recent_games(games, 2)
    assert [g["url"] for g in out] == ["b", "c"]  # newest end_time first


def test_select_recent_games_nonpositive_means_unlimited():
    from chess_tracker.analysis import select_recent_games
    games = [{"url": "a", "end_time": 1}, {"url": "b", "end_time": 2}]
    assert len(select_recent_games(games, 0)) == 2
    assert len(select_recent_games(games, -1)) == 2


# --- bounded legacy puzzle-line backfill (pure; no engine process) ---

def _legacy_blunder(best_uci, cp_loss, *, ply=4, pv=None, marker=None):
    import chess

    evidence = {
        "fen_before": chess.STARTING_FEN,
        "best_move_uci": best_uci,
        "cp_loss": cp_loss,
        "ply": ply,
    }
    if pv is not None:
        evidence["principal_variation_uci"] = pv
    if marker is not None:
        evidence["puzzle_line_version"] = marker
    return evidence


def _cache_entry(game_url, evidence):
    return {
        "summary": {
            "game_url": game_url,
            "side": "white",
            "moves_analyzed": 1,
            "blunder_evidence": [evidence],
        }
    }


def _three_ply_info(board, best_move, *_ignored):
    """Deterministic legal PV constrained to the supplied first move."""
    line = board.copy(stack=False)
    line.push(best_move)
    reply = sorted(line.legal_moves, key=lambda move: move.uci())[0]
    line.push(reply)
    continuation = sorted(line.legal_moves, key=lambda move: move.uci())[0]
    return {"pv": [best_move, reply, continuation]}


def test_puzzle_line_backfill_uses_stable_priority_and_bound():
    from chess_tracker.analysis import PUZZLE_LINE_VERSION, backfill_puzzle_lines

    high = _legacy_blunder("e2e4", 900)
    newer_tie = _legacy_blunder("d2d4", 800)
    older_tie = _legacy_blunder("c2c4", 800)
    cache = {
        "old": _cache_entry("old", older_tie),
        "new": _cache_entry("new", newer_tie),
        "high": _cache_entry("high", high),
    }
    games = [
        {"url": "old", "end_time": 100},
        {"url": "new", "end_time": 200},
        {"url": "high", "end_time": 50},
    ]
    calls = []

    def analyze(board, best_move, depth):
        calls.append((best_move.uci(), depth))
        return _three_ply_info(board, best_move)

    stats = backfill_puzzle_lines(
        games, cache, depth=9, max_positions=2, analyze_fn=analyze
    )

    assert calls == [("e2e4", 9), ("d2d4", 9)]
    assert stats == {"backfilled": 2, "ready": 2, "pending": 1, "failed": 0}
    assert high["puzzle_line_version"] == PUZZLE_LINE_VERSION
    assert newer_tie["puzzle_line_version"] == PUZZLE_LINE_VERSION
    assert "puzzle_line_version" not in older_tie


def test_puzzle_line_backfill_zero_bound_processes_every_pending_position():
    from chess_tracker.analysis import backfill_puzzle_lines

    first = _legacy_blunder("e2e4", 500)
    second = _legacy_blunder("d2d4", 400)
    cache = {
        "one": _cache_entry("one", first),
        "two": _cache_entry("two", second),
    }
    calls = []

    def analyze(board, best_move, depth):
        calls.append(best_move.uci())
        return _three_ply_info(board, best_move)

    stats = backfill_puzzle_lines(
        [{"url": "one"}, {"url": "two"}], cache,
        depth=8, max_positions=0, analyze_fn=analyze
    )

    assert calls == ["e2e4", "d2d4"]
    assert stats == {"backfilled": 2, "ready": 2, "pending": 0, "failed": 0}


def test_puzzle_line_backfill_includes_mistake_evidence():
    from chess_tracker.analysis import PUZZLE_LINE_VERSION, backfill_puzzle_lines

    mistake = _legacy_blunder("e2e4", 250)
    cache = {
        "game": {
            "summary": {
                "game_url": "game",
                "side": "white",
                "moves_analyzed": 1,
                "blunder_evidence": [],
                "mistake_evidence": [mistake],
            }
        }
    }

    stats = backfill_puzzle_lines(
        [{"url": "game"}], cache,
        depth=8, max_positions=1, analyze_fn=_three_ply_info,
    )

    assert stats == {"backfilled": 1, "ready": 1, "pending": 0, "failed": 0}
    assert mistake["puzzle_line_version"] == PUZZLE_LINE_VERSION


def test_puzzle_line_backfill_skips_ready_cache_and_sets_marker():
    from chess_tracker.analysis import PUZZLE_LINE_VERSION, backfill_puzzle_lines

    ready = _legacy_blunder(
        "e2e4",
        500,
        pv=["e2e4", "e7e5", "g1f3"],
    )
    cache = {"ready": _cache_entry("ready", ready)}

    def should_not_run(*_args):
        raise AssertionError("ready line must not call the engine")

    stats = backfill_puzzle_lines(
        [{"url": "ready"}], cache,
        depth=8, max_positions=100, analyze_fn=should_not_run
    )

    assert stats == {"backfilled": 0, "ready": 1, "pending": 0, "failed": 0}
    assert ready["puzzle_line_version"] == PUZZLE_LINE_VERSION
    assert ready["principal_variation_san"] == ["e4", "e5", "Nf3"]


def test_puzzle_line_backfill_retries_incomplete_marked_line():
    from chess_tracker.analysis import PUZZLE_LINE_VERSION, backfill_puzzle_lines

    attempted = _legacy_blunder(
        "e2e4",
        500,
        pv=["e2e4"],
        marker=PUZZLE_LINE_VERSION,
    )

    calls = []

    def analyze(board, best_move, depth):
        calls.append(best_move.uci())
        return _three_ply_info(board, best_move)

    stats = backfill_puzzle_lines(
        [{"url": "attempted"}],
        {"attempted": _cache_entry("attempted", attempted)},
        depth=8, max_positions=100, analyze_fn=analyze,
    )

    assert calls == ["e2e4"]
    assert stats == {"backfilled": 1, "ready": 1, "pending": 0, "failed": 0}
    assert attempted["puzzle_line_version"] == PUZZLE_LINE_VERSION


def test_puzzle_line_backfill_isolates_one_engine_failure():
    import chess.engine
    from chess_tracker.analysis import backfill_puzzle_lines

    broken = _legacy_blunder("e2e4", 600)
    valid = _legacy_blunder("d2d4", 500)
    cache = {
        "broken": _cache_entry("broken", broken),
        "valid": _cache_entry("valid", valid),
    }

    def analyze(board, best_move, depth):
        if best_move.uci() == "e2e4":
            raise chess.engine.EngineError("synthetic engine failure")
        return _three_ply_info(board, best_move)

    stats = backfill_puzzle_lines(
        [{"url": "broken"}, {"url": "valid"}], cache,
        depth=8, max_positions=100, analyze_fn=analyze
    )

    assert stats == {"backfilled": 1, "ready": 1, "pending": 1, "failed": 1}
    assert "puzzle_line_version" not in broken
    assert valid["principal_variation_uci"][0] == "d2d4"


def test_puzzle_line_backfill_short_result_stays_pending_and_retryable():
    from chess_tracker.analysis import PUZZLE_LINE_VERSION, backfill_puzzle_lines

    evidence = _legacy_blunder("e2e4", 500)
    cache = {"game": _cache_entry("game", evidence)}
    games = [{"url": "game"}]

    def short_line(board, best_move, depth):
        return {"pv": [best_move]}

    first = backfill_puzzle_lines(
        games, cache, depth=8, max_positions=1, analyze_fn=short_line
    )

    assert first == {"backfilled": 1, "ready": 0, "pending": 1, "failed": 1}
    assert "puzzle_line_version" not in evidence

    second = backfill_puzzle_lines(
        games, cache, depth=8, max_positions=1, analyze_fn=_three_ply_info
    )

    assert second == {"backfilled": 1, "ready": 1, "pending": 0, "failed": 0}
    assert evidence["puzzle_line_version"] == PUZZLE_LINE_VERSION


def test_puzzle_line_backfill_ignores_stale_cache_entries_for_budget():
    from chess_tracker.analysis import backfill_puzzle_lines

    current = _legacy_blunder("d2d4", 100)
    stale = _legacy_blunder("e2e4", 1_000)
    cache = {
        "current": _cache_entry("current", current),
        "stale": _cache_entry("stale", stale),
    }
    calls = []

    def analyze(board, best_move, depth):
        calls.append(best_move.uci())
        return _three_ply_info(board, best_move)

    stats = backfill_puzzle_lines(
        [{"url": "current"}], cache,
        depth=8, max_positions=1, analyze_fn=analyze,
    )

    assert calls == ["d2d4"]
    assert stats == {"backfilled": 1, "ready": 1, "pending": 0, "failed": 0}
    assert "principal_variation_uci" not in stale


def test_run_puzzle_line_backfill_isolates_engine_startup_failure(monkeypatch):
    import chess.engine
    from chess_tracker.analysis import run_puzzle_line_backfill

    evidence = _legacy_blunder("e2e4", 500)
    cache = {"game": _cache_entry("game", evidence)}

    def fail_to_start(_path):
        raise OSError("synthetic Stockfish startup failure")

    monkeypatch.setattr(chess.engine.SimpleEngine, "popen_uci", fail_to_start)

    stats = run_puzzle_line_backfill(
        [{"url": "game"}],
        cache,
        engine_path="/broken/stockfish",
        depth=8,
        max_positions=100,
    )

    assert stats == {"backfilled": 0, "ready": 0, "pending": 1, "failed": 1}
    assert "puzzle_line_version" not in evidence


def test_aggregate_by_format_runs_each_format_and_nulls_empty():
    from chess_tracker.analysis import aggregate_by_format
    def fake(pgn, side, depth):
        return _summary(moves=2, acc=70.0, blunders=1,
                        phase_acpl={"opening": 50}, phase_moves={"opening": 2})
    games_by_format = {
        "bullet": [{"url": "b1", "pgn": "p", "end_time": 1}],
        "daily": [{"url": "d1", "pgn": "p", "end_time": 1}],
        "rapid": [],  # no games → None
    }
    side = {"b1": "white", "d1": "black"}
    cache = {}
    out = aggregate_by_format(games_by_format, side, cache,
                             analyze_fn=fake, depth=8, max_games=200)
    assert set(out) == {"bullet", "daily", "rapid"}
    assert out["bullet"]["games_analyzed"] == 1
    assert out["daily"]["games_analyzed"] == 1
    assert out["rapid"] is None
    assert {"b1", "d1"} <= set(cache)   # both analyzed games cached


# --- engine driver: real Stockfish on a known blunder ---

@pytest.mark.skipif(find_engine_path() is None, reason="Stockfish not installed")
def test_analyze_move_quality_flags_white_queen_blunder():
    from chess_tracker.analysis import analyze_move_quality
    # White plays 3.Qxe5?? hanging the queen to ...Nxe5.
    pgn = '[Event "x"]\n1. e4 e5 2. Qh5 Nc6 3. Qxe5 Nxe5 *'
    q = analyze_move_quality(pgn, "white", depth=10)
    assert q is not None
    assert q["moves_analyzed"] == 3        # white made e4, Qh5, Qxe5
    assert q["blunders"] >= 1
    assert all(item["quality_label"] == "blunder" for item in q["blunder_evidence"])
    assert all(item["quality_label"] == "mistake" for item in q["mistake_evidence"])
    assert q["accuracy"] < 100


def test_analyze_move_quality_preserves_unrounded_mistake_boundary():
    from chess_tracker.analysis import analyze_move_quality, win_pct

    class FakeEngine:
        def __init__(self):
            self.infos = [
                {
                    "score": chess.engine.PovScore(chess.engine.Cp(-85), chess.WHITE),
                    "pv": [chess.Move.from_uci("e2e4")],
                },
                {
                    "score": chess.engine.PovScore(chess.engine.Cp(-535), chess.WHITE),
                    "pv": [chess.Move.from_uci("e7e5")],
                },
            ]

        def analyse(self, _board, _limit):
            return self.infos.pop(0)

    raw_loss = win_pct(-85) - win_pct(-535)
    assert raw_loss < 30
    assert round(raw_loss, 2) == 30.0

    quality = analyze_move_quality(
        '[Event "boundary"]\n1. d4 *', "white", FakeEngine(), depth=1,
    )

    assert quality is not None
    assert quality["blunder_evidence"] == []
    assert len(quality["mistake_evidence"]) == 1
    evidence = quality["mistake_evidence"][0]
    assert evidence["quality_label"] == "mistake"
    assert evidence["wp_loss"] == pytest.approx(raw_loss)
    assert evidence["wp_loss"] < 30


def test_summarize_includes_blunders_by_phase():
    from chess_tracker.analysis import MoveEval, summarize
    moves = [
        MoveEval.from_evals(ply=0, fullmove=1, cp_before=20, cp_after=-600, phase="opening"),
        MoveEval.from_evals(ply=2, fullmove=2, cp_before=20, cp_after=-600, phase="opening"),
        MoveEval.from_evals(ply=4, fullmove=3, cp_before=20, cp_after=-600, phase="middlegame"),
        MoveEval.from_evals(ply=6, fullmove=4, cp_before=20, cp_after=10,   phase="endgame"),
    ]
    s = summarize(moves)
    assert "blunders_by_phase" in s
    assert s["blunders_by_phase"]["opening"] == 2
    assert s["blunders_by_phase"]["middlegame"] == 1
    assert s["blunders_by_phase"].get("endgame", 0) == 0


def test_summarize_blunders_by_phase_empty_when_no_moves():
    from chess_tracker.analysis import summarize
    s = summarize([])
    assert "blunders_by_phase" in s
    assert s["blunders_by_phase"] == {}


def test_aggregate_move_quality_sums_blunders_by_phase():
    from chess_tracker.analysis import aggregate_move_quality
    summaries = [
        {
            "moves_analyzed": 2, "accuracy": 80.0, "avg_cp_loss": 50,
            "blunders": 1, "mistakes": 0, "inaccuracies": 0,
            "acpl_by_phase": {"opening": 50}, "moves_by_phase": {"opening": 2},
            "blunders_by_phase": {"opening": 1},
        },
        {
            "moves_analyzed": 3, "accuracy": 70.0, "avg_cp_loss": 30,
            "blunders": 2, "mistakes": 0, "inaccuracies": 0,
            "acpl_by_phase": {"middlegame": 30}, "moves_by_phase": {"middlegame": 3},
            "blunders_by_phase": {"opening": 1, "middlegame": 1},
        },
    ]
    result = aggregate_move_quality(summaries)
    assert "blunders_by_phase" in result
    assert result["blunders_by_phase"]["opening"] == 2
    assert result["blunders_by_phase"]["middlegame"] == 1
