# tests/test_refresh.py
import json
from unittest.mock import patch, MagicMock
import pytest
import refresh
from chess_tracker.puzzles import find_engine_path


def test_default_analysis_max_games_is_unlimited():
    assert refresh.DEFAULT_ANALYSIS_MAX_GAMES == 0


def test_default_puzzle_line_max_is_bounded():
    assert refresh.DEFAULT_PUZZLE_LINE_MAX == 100


def test_refresh_main_writes_computed_and_dashboard(tmp_path, monkeypatch):
    archives_index = {"archives": [
        "https://api.chess.com/pub/player/m_v-v/games/2026/05"
    ]}
    sample_game = {
        "url": "x", "end_time": 1_700_000_000, "time_class": "bullet",
        "white": {"username": "m_v-v", "rating": 500, "result": "win"},
        "black": {"username": "opp", "rating": 500, "result": "timeout"},
        "pgn": "[ECO \"A00\"]\n1. e4 {[%clk 0:00:59]} e5 {[%clk 0:00:59]}",
    }
    archive = {"games": [sample_game]}

    def fake_urlopen(req, timeout=30):
        url = req.full_url if hasattr(req, "full_url") else req
        mock = MagicMock()
        if url.endswith("/archives"):
            mock.read.return_value = json.dumps(archives_index).encode()
        else:
            mock.read.return_value = json.dumps(archive).encode()
        mock.__enter__.return_value = mock
        return mock

    monkeypatch.chdir(tmp_path)

    with patch("chess_tracker.api.urlopen", side_effect=fake_urlopen):
        refresh.main(["--username", "m_v-v"])

    assert (tmp_path / "data" / "computed.json").exists()
    for name in ["index", "leaks", "losses", "process", "sessions", "puzzles"]:
        out = tmp_path / "dashboard" / f"{name}.html"
        assert out.exists(), f"missing {name}.html"
        html = out.read_text()
        assert "window.DATA" in html


def test_refresh_bullet_filter_default_and_time_control_narrowing(tmp_path, monkeypatch):
    """Default bullet keeps all rated standard controls; --time-control narrows.

    Unrated (u3) and non-standard variants (u4) are always dropped. The 2+1
    bullet game (u2) now survives by default but is excluded when an exact
    --time-control 60 is requested (the old strict 1+0 behavior).
    """
    from refresh import main
    archives = {
        "games": [
            # Keep: rated 60-second standard chess bullet
            {"url": "u1", "end_time": 1, "time_class": "bullet",
             "time_control": "60", "rated": True, "rules": "chess",
             "white": {"username": "me", "rating": 500, "result": "win"},
             "black": {"username": "opp", "rating": 500, "result": "checkmated"},
             "pgn": "[ECO \"A00\"]\n*"},
            # Drop: 2+1 bullet
            {"url": "u2", "end_time": 2, "time_class": "bullet",
             "time_control": "120+1", "rated": True, "rules": "chess",
             "white": {"username": "me", "rating": 500, "result": "win"},
             "black": {"username": "opp", "rating": 500, "result": "checkmated"},
             "pgn": "*"},
            # Drop: unrated
            {"url": "u3", "end_time": 3, "time_class": "bullet",
             "time_control": "60", "rated": False, "rules": "chess",
             "white": {"username": "me", "rating": 500, "result": "win"},
             "black": {"username": "opp", "rating": 500, "result": "checkmated"},
             "pgn": "*"},
            # Drop: variant
            {"url": "u4", "end_time": 4, "time_class": "bullet",
             "time_control": "60", "rated": True, "rules": "kingofthehill",
             "white": {"username": "me", "rating": 500, "result": "win"},
             "black": {"username": "opp", "rating": 500, "result": "checkmated"},
             "pgn": "*"},
        ]
    }
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc1"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    import json

    # Default: no time-control filter → keep u1 (60) and u2 (120+1); drop u3, u4.
    rc = main(["--username", "me",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    payload = json.loads((tmp_path / "data" / "computed.json").read_text())
    assert payload["kpis"]["games_total"] == 2

    # Explicit --time-control 60 reproduces the old strict 1+0 filter → only u1.
    rc = main(["--username", "me", "--time-control", "60",
               "--data-dir", str(tmp_path / "data2"),
               "--dashboard-dir", str(tmp_path / "dash2")])
    assert rc == 0
    payload = json.loads((tmp_path / "data2" / "computed.json").read_text())
    assert payload["kpis"]["games_total"] == 1


def test_refresh_ingests_daily_games(tmp_path, monkeypatch):
    """Daily games flow through the whole pipeline (impossible before the unlock)."""
    from refresh import main
    archives = {"games": [
        {"url": "d1", "end_time": 10, "time_class": "daily",
         "time_control": "1/86400", "rated": True, "rules": "chess",
         "white": {"username": "me", "rating": 1000, "result": "win"},
         "black": {"username": "opp", "rating": 1000, "result": "resigned"},
         "pgn": "[ECO \"D02\"]\n1. d4 d5 2. Nf3 *"},
    ]}
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc1"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    import json
    rc = main(["--username", "me", "--format", "daily", "--no-puzzles",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    payload = json.loads((tmp_path / "data" / "computed.json").read_text())
    assert payload["format"] == "daily"
    assert payload["kpis"]["games_total"] == 1


def test_refresh_no_analysis_flag_sets_move_quality_none(tmp_path, monkeypatch):
    """--no-analysis skips the engine pass and leaves move_quality null."""
    from refresh import main
    archives = {"games": [
        {"url": "d1", "end_time": 10, "time_class": "daily",
         "time_control": "1/86400", "rated": True, "rules": "chess",
         "white": {"username": "me", "rating": 1000, "result": "win"},
         "black": {"username": "opp", "rating": 1000, "result": "resigned"},
         "pgn": "[ECO \"D02\"]\n1. d4 d5 2. Nf3 *"},
    ]}
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc1"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    rc = main(["--username", "me", "--format", "daily",
               "--no-puzzles", "--no-analysis",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    payload = json.loads((tmp_path / "data" / "computed.json").read_text())
    assert payload["move_quality"] is None
    assert payload["move_quality_by_format"] is None
    assert payload["move_quality_by_time_control"] is None


@pytest.mark.skipif(find_engine_path() is None, reason="Stockfish not installed")
def test_refresh_move_quality_by_format(tmp_path, monkeypatch):
    """The cross-format pass aggregates each time class present in the archive."""
    from refresh import main
    archives = {"games": [
        {"url": "b1", "end_time": 2, "time_class": "bullet", "time_control": "60",
         "rated": True, "rules": "chess",
         "white": {"username": "me", "rating": 500, "result": "resigned"},
         "black": {"username": "opp", "rating": 500, "result": "win"},
         "pgn": "[ECO \"C20\"]\n1. e4 e5 2. Qh5 Nc6 3. Qxe5 Nxe5 *"},
        {"url": "d1", "end_time": 1, "time_class": "daily", "time_control": "1/86400",
         "rated": True, "rules": "chess",
         "white": {"username": "me", "rating": 1000, "result": "win"},
         "black": {"username": "opp", "rating": 1000, "result": "resigned"},
         "pgn": "[ECO \"D02\"]\n1. d4 d5 2. Nf3 Nc6 3. e3 *"},
    ]}
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    rc = main(["--username", "me", "--format", "bullet", "--no-puzzles",
               "--analysis-depth", "8", "--analysis-max-games", "50",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    mqbf = json.loads((tmp_path / "data" / "computed.json").read_text())["move_quality_by_format"]
    assert mqbf["bullet"] and mqbf["bullet"]["games_analyzed"] == 1
    assert mqbf["daily"] and mqbf["daily"]["games_analyzed"] == 1
    assert mqbf["rapid"] is None and mqbf["blitz"] is None   # present but empty


@pytest.mark.skipif(find_engine_path() is None, reason="Stockfish not installed")
def test_refresh_attaches_move_quality_and_caches(tmp_path, monkeypatch):
    """The engine pass populates move_quality and writes a per-URL cache."""
    from refresh import main
    archives = {"games": [
        {"url": "b1", "end_time": 10, "time_class": "bullet",
         "time_control": "60", "rated": True, "rules": "chess",
         "white": {"username": "me", "rating": 500, "result": "resigned"},
         "black": {"username": "opp", "rating": 500, "result": "win"},
         "pgn": "[ECO \"C20\"]\n1. e4 e5 2. Qh5 Nc6 3. Qxe5 Nxe5 *"},
    ]}
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc1"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    rc = main(["--username", "me", "--no-puzzles", "--analysis-depth", "8",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    payload = json.loads((tmp_path / "data" / "computed.json").read_text())
    mq = payload["move_quality"]
    assert mq is not None
    assert mq["games_analyzed"] == 1
    assert mq["blunders"] >= 1
    assert (tmp_path / "data" / "analysis_cache.json").exists()
    cache = json.loads((tmp_path / "data" / "analysis_cache.json").read_text())
    assert "b1" in cache


@pytest.mark.skipif(find_engine_path() is None, reason="Stockfish not installed")
def test_refresh_analysis_max_games_bounds_the_pass(tmp_path, monkeypatch):
    """--analysis-max-games analyzes only the newest N games."""
    from refresh import main
    pgn = "[ECO \"C20\"]\n1. e4 e5 2. Qh5 Nc6 3. Qxe5 Nxe5 *"
    def g(url, end_time):
        return {"url": url, "end_time": end_time, "time_class": "bullet",
                "time_control": "60", "rated": True, "rules": "chess",
                "white": {"username": "me", "rating": 500, "result": "resigned"},
                "black": {"username": "opp", "rating": 500, "result": "win"},
                "pgn": pgn}
    archives = {"games": [g("old", 1), g("mid", 2), g("new", 3)]}
    monkeypatch.setattr("refresh.fetch_archives_index", lambda u: ["arc1"])
    monkeypatch.setattr("refresh.fetch_archive", lambda url, cache_dir, force: archives)
    rc = main(["--username", "me", "--no-puzzles",
               "--analysis-depth", "8", "--analysis-max-games", "1",
               "--data-dir", str(tmp_path / "data"),
               "--dashboard-dir", str(tmp_path / "dash")])
    assert rc == 0
    payload = json.loads((tmp_path / "data" / "computed.json").read_text())
    assert payload["move_quality"]["games_analyzed"] == 1
    cache = json.loads((tmp_path / "data" / "analysis_cache.json").read_text())
    assert list(cache) == ["new"]   # only the newest game analyzed


# --- accept_game: multi-format ingestion filter ---

def _game(**kw):
    base = {"time_class": "bullet", "time_control": "60",
            "rated": True, "rules": "chess"}
    base.update(kw)
    return base


def test_accept_game_keeps_daily_games():
    """Daily games must survive the filter (previously discarded entirely)."""
    from refresh import accept_game
    g = _game(time_class="daily", time_control="1/86400")
    assert accept_game(g, "daily") is True


def test_accept_game_keeps_bullet_variant_when_no_time_control():
    """With no explicit --time-control, all rated standard bullet is kept."""
    from refresh import accept_game
    assert accept_game(_game(time_control="120+1"), "bullet") is True


def test_accept_game_narrows_to_exact_time_control_when_given():
    """An explicit time_control reproduces the old strict 1+0 filter."""
    from refresh import accept_game
    assert accept_game(_game(time_control="60"), "bullet", "60") is True
    assert accept_game(_game(time_control="120+1"), "bullet", "60") is False


def test_accept_game_rejects_unrated_variants_and_other_classes():
    from refresh import accept_game
    assert accept_game(_game(rated=False), "bullet") is False
    assert accept_game(_game(rules="kingofthehill"), "bullet") is False
    assert accept_game(_game(time_class="blitz"), "bullet") is False


def test_time_control_labels_are_user_facing():
    from refresh import _time_control_label
    assert _time_control_label("60") == "1min"
    assert _time_control_label("180") == "3min"
    assert _time_control_label("300") == "5min"
    assert _time_control_label("600") == "10min"
    assert _time_control_label("120+1") == "2min+1s"
    assert _time_control_label("1/86400") == "1 day"
    assert _time_control_label("1/259200") == "3 days"


def test_compute_ratings_by_time_control_uses_latest_rating_per_control():
    from refresh import compute_ratings_by_time_control

    def g(url, end_time, time_class, time_control, rating):
        return {
            "url": url,
            "end_time": end_time,
            "time_class": time_class,
            "time_control": time_control,
            "rated": True,
            "rules": "chess",
            "white": {"username": "me", "rating": rating, "result": "win"},
            "black": {"username": "opp", "rating": 500, "result": "checkmated"},
        }

    entries = compute_ratings_by_time_control([
        g("old-3", 10, "blitz", "180", 700),
        g("new-3", 30, "blitz", "180", 725),
        g("five", 20, "blitz", "300", 650),
        g("bullet", 40, "bullet", "60", 525),
        g("rapid", 50, "rapid", "600", 900),
        g("daily", 60, "daily", "1/259200", 1100),
        {**g("unrated", 70, "blitz", "180", 999), "rated": False},
        {**g("variant", 80, "blitz", "180", 999), "rules": "kingofthehill"},
    ], "me")

    assert [(e["label"], e["rating"]) for e in entries] == [
        ("Bullet (1min)", 525),
        ("Blitz (3min)", 725),
        ("Blitz (5min)", 650),
        ("Rapid (10min)", 900),
        ("Daily (3 days)", 1100),
    ]
    assert entries[1]["key"] == "blitz:180"


def test_build_move_quality_by_time_control_preserves_labels_and_order():
    from refresh import build_move_quality_by_time_control

    controls = [
        {"key": "bullet:60", "format": "bullet", "time_control": "60",
         "label": "Bullet (1min)", "rating": 600},
        {"key": "blitz:180", "format": "blitz", "time_control": "180",
         "label": "Blitz (3min)", "rating": 464},
        {"key": "blitz:300", "format": "blitz", "time_control": "300",
         "label": "Blitz (5min)", "rating": 494},
    ]
    summaries = {
        "bullet:60": {"accuracy": 82.9, "games_analyzed": 200},
        "blitz:300": {"accuracy": 85.4, "games_analyzed": 30},
    }

    rows = build_move_quality_by_time_control(controls, summaries)

    assert [(r["label"], r["summary"]["accuracy"]) for r in rows] == [
        ("Bullet (1min)", 82.9),
        ("Blitz (5min)", 85.4),
    ]


# --- puzzle-line backfill wiring ---

def _refresh_game_for_backfill():
    return {
        "url": "game-1",
        "uuid": "uuid-1",
        "end_time": 1_700_000_000,
        "time_class": "bullet",
        "time_control": "60",
        "rated": True,
        "rules": "chess",
        "white": {"username": "me", "rating": 500, "result": "win"},
        "black": {"username": "opp", "rating": 500, "result": "checkmated"},
        "pgn": '[ECO "A00"]\n1. e4 e5 *',
    }


def _stub_refresh_for_backfill(monkeypatch, events):
    game = _refresh_game_for_backfill()
    monkeypatch.setattr("refresh.fetch_archives_index", lambda _username: ["archive"])
    monkeypatch.setattr(
        "refresh.fetch_archive",
        lambda _url, cache_dir, force: {"games": [game]},
    )
    monkeypatch.setattr("refresh.fetch_player_stats", lambda _username: {})
    monkeypatch.setattr("refresh.fetch_lichess_user", lambda _username: {})
    monkeypatch.setattr("refresh.render_all_pages", lambda **_kwargs: None)

    engine_resolutions = []

    def resolve_engine():
        engine_resolutions.append(True)
        return "/test/stockfish"

    monkeypatch.setattr("refresh.find_engine_path", resolve_engine)

    def quality_pass(games, sides, cache, *, engine_path, depth):
        events.append(("ordinary", engine_path, depth))
        return []

    def quality_by_format(
        games_by_format, sides, cache, *, engine_path, depth, max_games
    ):
        return {key: None for key in games_by_format}

    monkeypatch.setattr("refresh.run_move_quality_pass", quality_pass)
    monkeypatch.setattr("refresh.run_move_quality_by_format", quality_by_format)
    return engine_resolutions


def test_refresh_backfills_after_analysis_saves_then_builds_catalog(
    tmp_path, monkeypatch, capsys
):
    events = []
    engine_resolutions = _stub_refresh_for_backfill(monkeypatch, events)

    def backfill(games, cache, *, engine_path, depth, max_positions):
        events.append(("backfill", engine_path, depth, max_positions))
        cache["backfill-marker"] = {"summary": {"moves_analyzed": 0}}
        return {"backfilled": 2, "ready": 3, "pending": 4, "failed": 1}

    def save(path, cache):
        assert "backfill-marker" in cache
        events.append(("save", path))

    def build(games, cache, username):
        assert "backfill-marker" in cache
        events.append(("build", username))
        return {
            "candidates": [],
            "coverage": {"eligible_puzzles": 0, "incomplete_puzzles": 0},
            "errors": [],
        }

    monkeypatch.setattr("refresh.run_puzzle_line_backfill", backfill)
    monkeypatch.setattr("refresh.save_quality_cache", save)
    monkeypatch.setattr("refresh.build_puzzle_queue", build)

    rc = refresh.main([
        "--username", "me",
        "--analysis-depth", "7",
        "--puzzle-line-max", "0",
        "--data-dir", str(tmp_path / "data"),
        "--dashboard-dir", str(tmp_path / "dashboard"),
    ])

    assert rc == 0
    assert engine_resolutions == [True]
    assert events[0] == ("ordinary", "/test/stockfish", 7)
    assert ("backfill", "/test/stockfish", 7, 0) in events
    assert [event[0] for event in events][-3:] == ["backfill", "save", "build"]
    assert (
        "Puzzle-line backfill: 2 updated, 3 ready, 4 pending, 1 failed."
        in capsys.readouterr().out
    )


@pytest.mark.parametrize("skip_flag", ["--no-analysis", "--no-puzzles"])
def test_refresh_skips_puzzle_line_backfill_for_disabled_surface(
    skip_flag, tmp_path, monkeypatch
):
    events = []
    engine_resolutions = _stub_refresh_for_backfill(monkeypatch, events)
    monkeypatch.setattr(
        "refresh.run_puzzle_line_backfill",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("puzzle-line backfill should be skipped")
        ),
    )
    monkeypatch.setattr("refresh.save_quality_cache", lambda *_args: None)
    monkeypatch.setattr(
        "refresh.build_puzzle_queue",
        lambda *_args: {
            "candidates": [],
            "coverage": {"eligible_puzzles": 0, "incomplete_puzzles": 0},
            "errors": [],
        },
    )

    rc = refresh.main([
        "--username", "me",
        skip_flag,
        "--data-dir", str(tmp_path / "data"),
        "--dashboard-dir", str(tmp_path / "dashboard"),
    ])

    assert rc == 0
    if skip_flag == "--no-analysis":
        assert engine_resolutions == []
        assert not any(event[0] == "ordinary" for event in events)
    else:
        assert engine_resolutions == [True]
        assert any(event[0] == "ordinary" for event in events)
