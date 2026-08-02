"""Tests for metric computations."""
from tests.fixtures.sample_records import RECORDS, CLOCK_RECORDS, OUTLASTED_THEN_FLAG_RECORD, LONG_OUTLAST_RECORD, BLITZ_CLOCK_RECORDS
from chess_tracker.metrics import (
    compute_kpis,
    compute_sessions,
    compute_process_metrics,
    compute_session_decay,
    compute_study_recommendations,
)


def test_compute_kpis_current_rating_is_last_games():
    kpis = compute_kpis(RECORDS)
    assert kpis["current_rating"] == 485  # rating of last game


def test_compute_kpis_recent_form_counts_last_five():
    kpis = compute_kpis(RECORDS)
    # last 5: W=2 (games 0, 5 ... actually last 5 are records[1:6])
    # records[1]=L, [2]=W, [3]=L, [4]=L, [5]=W → 2W/3L → 40%
    assert kpis["recent_form_win_pct"] == 40.0
    assert kpis["tilt"] == "yellow"  # 40 ≤ win% < 60


def test_compute_sessions_detects_gaps():
    sessions = compute_sessions(RECORDS, gap_seconds=600)
    assert len(sessions) == 3
    assert sessions[0]["games"] == 3
    assert sessions[1]["games"] == 2
    assert sessions[2]["games"] == 1


def test_compute_sessions_tracks_rating_delta():
    sessions = compute_sessions(RECORDS, gap_seconds=600)
    # Session 1: started 500, ended 510
    assert sessions[0]["rating_start"] == 500
    assert sessions[0]["rating_end"] == 510
    assert sessions[0]["rating_delta"] == 10


def test_compute_sessions_flags_tilt_when_drop_50_or_more():
    sessions = compute_sessions(RECORDS, gap_seconds=600)
    # No session here has -50, but the flag must exist
    for s in sessions:
        assert "tilt_flag" in s
        assert s["tilt_flag"] == (s["rating_delta"] <= -50)


def test_compute_process_metrics_returns_required_keys():
    pm = compute_process_metrics(CLOCK_RECORDS)
    assert set(pm.keys()) >= {
        "reserve_move_10_median",
        "reserve_move_20_median",
        "opening_velocity_median",
        "time_burn_delta",
        "outlasted_but_flagged_count",
    }


def test_opening_velocity_reflects_first_8_plies():
    """Fast opener uses 4s on first 8 of-my-moves; slow opener uses 24s."""
    fast_only = [CLOCK_RECORDS[0], CLOCK_RECORDS[2]]  # both fast
    slow_only = [CLOCK_RECORDS[1]]
    fast_vel = compute_process_metrics(fast_only)["opening_velocity_median"]
    slow_vel = compute_process_metrics(slow_only)["opening_velocity_median"]
    assert fast_vel < slow_vel
    assert abs(fast_vel - 4.0) < 0.5
    assert abs(slow_vel - 24.0) < 0.5


def test_outlasted_but_flagged_ignores_early_only_edge():
    """Under the tightened definition, a brief opening clock lead that
    doesn't persist to move 10 is not 'outlasted'."""
    pm = compute_process_metrics([OUTLASTED_THEN_FLAG_RECORD])
    assert pm["outlasted_but_flagged_count"] == 0


def test_outlasted_but_flagged_counts_5s_edge_at_move_10_plus():
    """A 7-second lead at move 10 followed by a timeout is the textbook
    panic-conversion failure the metric was designed to catch."""
    pm = compute_process_metrics([LONG_OUTLAST_RECORD])
    assert pm["outlasted_but_flagged_count"] == 1


def test_outlasted_but_flagged_excludes_timeouts_where_you_were_always_behind():
    """Slow-opener timeout where opp had more time at every ply — not outlasted."""
    # CLOCK_RECORDS[1] is the slow-opener-mine vs fast-opener-opp timeout
    pm = compute_process_metrics([CLOCK_RECORDS[1]])
    assert pm["outlasted_but_flagged_count"] == 0


def test_time_burn_delta_is_positive_when_slow_opening():
    """Slow opener: 3s/move early, 1s/move late → delta = +2.0 exactly."""
    pm = compute_process_metrics([CLOCK_RECORDS[1]])
    assert pm["time_burn_delta"] is not None
    assert abs(pm["time_burn_delta"] - 2.0) < 0.1


def test_time_burn_delta_is_negative_when_fast_opening():
    """Fast opener: 0.5s/move early, 1.5s/move late → delta = -1.0 exactly."""
    pm = compute_process_metrics([CLOCK_RECORDS[0]])
    assert pm["time_burn_delta"] is not None
    assert abs(pm["time_burn_delta"] - (-1.0)) < 0.1


def test_compute_session_decay_returns_buckets():
    decay = compute_session_decay(RECORDS, gap_seconds=600)
    by_bucket = {row["bucket"]: row for row in decay}
    assert set(by_bucket.keys()) == {"1-5", "6-10", "11-20", "21+"}
    # Each row has the same keys as a generic stats row
    for row in decay:
        assert {"games", "win_pct", "flag_pct", "mate_pct"} <= set(row.keys())


from chess_tracker.metrics import _post_peak_decay


def _decay(rows):
    """Build a decay-bucket list from terse (bucket, games, win_pct) triples."""
    return [{"bucket": b, "games": g, "win_pct": w,
             "flag_pct": 0.0, "mate_pct": 0.0} for b, g, w in rows]


def test_post_peak_decay_fires_when_peak_crashes_to_last():
    decay = _decay([
        ("1-5",   5, 40.0),
        ("6-10",  5, 50.0),
        ("11-20", 10, 80.0),
        ("21+",   5, 20.0),
    ])
    fired, peak, last = _post_peak_decay(decay)
    assert fired is True
    assert peak["bucket"] == "11-20"
    assert last["bucket"] == "21+"


def test_post_peak_decay_does_not_fire_on_monotonic_increase():
    decay = _decay([
        ("1-5",   5, 20.0),
        ("6-10",  5, 40.0),
        ("11-20", 5, 60.0),
        ("21+",   5, 80.0),
    ])
    fired, _peak, _last = _post_peak_decay(decay)
    assert fired is False


def test_post_peak_decay_does_not_fire_when_drop_below_threshold():
    decay = _decay([
        ("1-5",   5, 60.0),
        ("6-10",  5, 70.0),
        ("11-20", 5, 80.0),
        ("21+",   5, 75.0),  # peak=80, last=75, drop=5pp < 10pp
    ])
    fired, _peak, _last = _post_peak_decay(decay)
    assert fired is False


def test_post_peak_decay_falls_back_to_alternate_peak_when_top_bucket_ineligible():
    # 11-20 would be the peak by win_pct, but has only 4 games -> ineligible.
    # Eligible buckets: 1-5 (60%) and 21+ (20%). Peak=1-5, last=21+, drop=40pp.
    decay = _decay([
        ("1-5",   5, 60.0),
        ("6-10",  4, 55.0),
        ("11-20", 4, 95.0),  # ineligible
        ("21+",   5, 20.0),
    ])
    fired, peak, last = _post_peak_decay(decay)
    assert fired is True  # still fires, but with a different peak
    assert peak["bucket"] == "1-5"
    assert last["bucket"] == "21+"


def test_post_peak_decay_does_not_fire_when_only_one_bucket_eligible():
    # Only 1-5 has >=5 games; the would-be peak (11-20) is ineligible at 4 games
    # and 6-10 / 21+ are also short. With <2 eligible buckets the rule cannot
    # fire even though 11-20 visibly outperforms 1-5.
    decay = _decay([
        ("1-5",   5, 40.0),
        ("6-10",  4, 50.0),
        ("11-20", 4, 95.0),
        ("21+",   3, 20.0),
    ])
    fired, peak, last = _post_peak_decay(decay)
    assert fired is False
    assert peak is None
    assert last is None


def test_post_peak_decay_does_not_fire_when_last_bucket_has_too_few_games():
    # 21+ has only 4 games -> ineligible. With 1-5, 6-10, 11-20 all eligible
    # at >=5 games and 11-20 having the highest win%, peak == last == 11-20
    # -> no fire even though 21+ visibly crashed.
    decay = _decay([
        ("1-5",   5, 40.0),
        ("6-10",  10, 60.0),
        ("11-20", 10, 80.0),
        ("21+",   4, 10.0),
    ])
    fired, _peak, _last = _post_peak_decay(decay)
    assert fired is False


def test_post_peak_decay_tie_break_picks_later_bucket():
    # 6-10 and 11-20 tied at 70%. Tie-break: later (11-20) wins as peak.
    decay = _decay([
        ("1-5",   5, 40.0),
        ("6-10",  5, 70.0),
        ("11-20", 5, 70.0),
        ("21+",   5, 30.0),
    ])
    fired, peak, last = _post_peak_decay(decay)
    assert fired is True
    assert peak["bucket"] == "11-20"
    assert last["bucket"] == "21+"


from chess_tracker.metrics import (
    detect_leaks, recent_losses_with_suggestions
)


def test_detect_leaks_returns_rows_with_required_fields():
    leaks = detect_leaks(RECORDS + CLOCK_RECORDS)
    for leak in leaks:
        assert set(leak.keys()) >= {"name", "severity", "evidence", "suggested_action"}
        assert leak["severity"] in ("info", "warn", "critical")


def test_detect_leaks_flags_slow_opening_when_velocity_high():
    # CLOCK_RECORDS has slow openers spending 24s on first 8 of-my-moves
    leaks = detect_leaks([CLOCK_RECORDS[1]])
    names = [l["name"] for l in leaks]
    assert "time_burn_opening" in names


from chess_tracker.pgn import GameRecord


def _session_with_results(results: list[str], start: int = 1_700_000_000) -> list[GameRecord]:
    """Build a single-session GameRecord list from per-position results.

    Games are spaced 60s apart so they all sit within a single session
    under the default 600s gap. Clocks are stubs (not exercised by the
    decay path).
    """
    out = []
    for i, r in enumerate(results):
        opp = "win" if r != "win" else "timeout"
        out.append(GameRecord(
            url=f"https://chess.com/game/{start + i * 60}",
            end_time=start + i * 60,
            time_class="bullet",
            side="white",
            my_rating=500, opp_rating=500,
            result=r, opp_result=opp,
            plies=20, fullmoves=10,
            opening="Test", eco="A00",
            my_clocks=[30.0], opp_clocks=[30.0],
            play_signature=None,
        ))
    return out


def test_detect_leaks_includes_post_peak_decay_when_peak_crashes():
    # Session of 25 games shaped so 11-20 peaks at 80% and 21+ crashes to 20%.
    # Positions:   1-5  (2W,3L), 6-10 (3W,2L), 11-20 (8W,2L), 21-25 (1W,4L)
    results = (
        ["win"] * 2 + ["timeout"] * 3 +
        ["win"] * 3 + ["timeout"] * 2 +
        ["win"] * 8 + ["timeout"] * 2 +
        ["win"] * 1 + ["timeout"] * 4
    )
    leaks = detect_leaks(_session_with_results(results))
    names = [l["name"] for l in leaks]
    assert "post_peak_decay" in names
    assert "mid_session_decay" not in names  # renamed
    leak = next(l for l in leaks if l["name"] == "post_peak_decay")
    assert leak["severity"] == "warn"
    assert "11-20" in leak["evidence"]
    assert "21+" in leak["evidence"]


# --- outlasted_but_flagged leak rule -----------------------------------------

def _pad_with_win(n: int, start: int = 1_700_100_000) -> list[GameRecord]:
    """Filler win-records to fill out the 30-game window without affecting
    the outlasted-but-flagged math (only timeout-losses count)."""
    return [
        GameRecord(
            url="x", end_time=start + i, time_class="bullet", side="white",
            my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
            plies=20, fullmoves=10, opening="Test", eco="A00",
            my_clocks=[30.0], opp_clocks=[30.0],
        )
        for i in range(n)
    ]


def test_outlasted_but_flagged_leak_fires_critical_at_high_pct():
    """4 of 5 timeout losses are outlasted (80%) → critical."""
    recs = ([LONG_OUTLAST_RECORD] * 4
            + [OUTLASTED_THEN_FLAG_RECORD]   # timeout that does NOT count
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    obf = [l for l in leaks if l["name"] == "outlasted_but_flagged"]
    assert len(obf) == 1
    assert obf[0]["severity"] == "critical"
    assert "4 of 5" in obf[0]["evidence"]
    assert "80%" in obf[0]["evidence"]


def test_outlasted_but_flagged_leak_fires_critical_at_45_percent_boundary():
    """3 of 6 timeout losses outlasted (50%) → critical under the
    recalibrated threshold (>= 45%)."""
    recs = ([LONG_OUTLAST_RECORD] * 3
            + [OUTLASTED_THEN_FLAG_RECORD] * 3
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    obf = [l for l in leaks if l["name"] == "outlasted_but_flagged"]
    assert len(obf) == 1
    assert obf[0]["severity"] == "critical"


def test_outlasted_but_flagged_leak_fires_warn_between_30_and_45_percent():
    """2 of 5 timeout losses outlasted (40%) → warn (not critical)."""
    recs = ([LONG_OUTLAST_RECORD] * 2
            + [OUTLASTED_THEN_FLAG_RECORD] * 3
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    obf = [l for l in leaks if l["name"] == "outlasted_but_flagged"]
    assert len(obf) == 1
    assert obf[0]["severity"] == "warn"


def test_outlasted_but_flagged_leak_fires_warn_at_30_percent_boundary():
    """3 of 10 timeout losses outlasted (30%) → warn under the
    recalibrated threshold (>= 30%)."""
    recs = ([LONG_OUTLAST_RECORD] * 3
            + [OUTLASTED_THEN_FLAG_RECORD] * 7
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    obf = [l for l in leaks if l["name"] == "outlasted_but_flagged"]
    assert len(obf) == 1
    assert obf[0]["severity"] == "warn"


def test_outlasted_but_flagged_leak_suppressed_below_min_n_timeouts():
    """3 of 3 outlasted (100%) but < 4 timeouts → no leak fired."""
    recs = [LONG_OUTLAST_RECORD] * 3 + _pad_with_win(20)
    leaks = detect_leaks(recs)
    assert "outlasted_but_flagged" not in [l["name"] for l in leaks]


def test_outlasted_but_flagged_leak_quiet_when_under_30_percent():
    """1 of 5 timeout losses outlasted (20%) → no leak fired (below the
    recalibrated 30% warn floor)."""
    recs = ([LONG_OUTLAST_RECORD]
            + [OUTLASTED_THEN_FLAG_RECORD] * 4
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    assert "outlasted_but_flagged" not in [l["name"] for l in leaks]


def test_outlasted_but_flagged_leak_evidence_carries_action():
    """The leak entry must include a non-empty suggested_action string."""
    recs = ([LONG_OUTLAST_RECORD] * 4
            + [OUTLASTED_THEN_FLAG_RECORD]
            + _pad_with_win(20))
    leaks = detect_leaks(recs)
    obf = next(l for l in leaks if l["name"] == "outlasted_but_flagged")
    assert obf["suggested_action"]
    assert len(obf["suggested_action"]) > 20  # not a stub


def test_recent_losses_includes_suggested_entry():
    losses = recent_losses_with_suggestions(RECORDS, limit=10)
    for L in losses:
        assert "game_url" in L
        assert "loss_type" in L
        assert "suggested_entry" in L
        # Suggested entry is a dict that maps onto annotations.json error_log shape
        assert {"title", "pattern", "game_refs"} <= set(L["suggested_entry"].keys())


def test_compute_study_recommendations_returns_deterministic_cards():
    cards = compute_study_recommendations(
        opening_families=[
            {
                "family": "Italian Game",
                "color": "white",
                "games": 24,
                "win_pct": 55.0,
                "sum_rating_delta": -15,
                "sample_strength": "weak",
                "priority": 1.5,
            },
            {
                "family": "Pirc Defense",
                "color": "black",
                "games": 14,
                "win_pct": 28.6,
                "sum_rating_delta": -42,
                "sample_strength": "weak",
                "priority": 3.75,
            },
        ],
        leak_summary=[{
            "name": "time_burn_opening",
            "severity": "critical",
            "evidence": "median 16.2s on my first 8 moves (target <8s)",
            "suggested_action": "Move 8 with >=50s left.",
        }],
        recent_losses=[],
        review_picks=[{
            "kind": "biggest_loss",
            "url": "https://chess.com/game/1",
            "moves": 31,
            "loss_type": "timeout",
            "rating_delta": -22,
            "question": "What single move made the position lost? Mark the ply.",
        }],
        process_metrics={"opening_velocity_median": 16.2},
    )
    assert [card["title"] for card in cards] == [
        "Study Pirc Defense as Black",
        "Tighten opening clock process",
        "Review the biggest recent loss",
    ]
    assert cards[0] == {
        "title": "Study Pirc Defense as Black",
        "reason": "14 games, 28.6% win rate, -42 rating delta.",
        "action": "Review the recurring line and choose one default response.",
        "severity": "red",
        "href": "opening.html?family=Pirc+Defense&color=black",
    }
    assert cards[1]["reason"] == "median 16.2s on my first 8 moves (target <8s)"
    assert cards[1]["action"] == "Move 8 with >=50s left."
    assert cards[1]["severity"] == "red"
    assert cards[1]["href"] == "process.html"
    assert cards[2]["reason"] == "timeout loss, 31 moves, -22 rating delta."
    assert cards[2]["href"] == "losses.html"


def test_compute_study_recommendations_empty_data_does_not_crash():
    cards = compute_study_recommendations(
        opening_families=[{
            "family": "Italian Game",
            "color": "white",
            "games": 9,
            "win_pct": 77.8,
            "sum_rating_delta": 18,
            "sample_strength": "ignore",
            "priority": 0.0,
        }],
        leak_summary=[],
        recent_losses=[],
        review_picks=[],
        process_metrics={},
    )
    assert cards == []


from chess_tracker.metrics import compute_all


def test_compute_all_has_new_panel_keys():
    annotations = {
        "openings": {"London System": {"tag": "in_repertoire", "note": "main"}},
        "games": {},
        "error_log": [],
    }
    payload = compute_all(RECORDS + CLOCK_RECORDS, annotations,
                          username="m_v-v", format="bullet")
    expected = {
        "username", "format", "generated_at",
        "kpis", "leak_summary",
        "recent_losses", "study_recommendations", "process_metrics",
        "play_signatures", "sessions", "error_log",
    }
    assert expected <= set(payload.keys())
    assert isinstance(payload["study_recommendations"], list)


def test_compute_all_play_signatures_has_low_confidence_flag():
    annotations = {"openings": {}, "games": {}, "error_log": []}
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    for row in payload["play_signatures"]:
        assert "low_confidence" in row
        assert row["low_confidence"] == (row["games"] < 15)


def test_compute_all_play_signatures_has_first_moves_field():
    annotations = {"openings": {}, "games": {}, "error_log": []}
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    for row in payload["play_signatures"]:
        assert "first_moves" in row
        # Fixture records don't set first_moves so it should be None here;
        # the test asserts the *field* is present (real ingestion populates it
        # from PGN via pgn.parse_game → play_signature.first_moves_san).
        assert row["first_moves"] is None


def test_compute_all_play_signatures_has_family_and_variation_fields():
    """Each play_signature row carries tier-1 (family) and tier-2 (variation)
    derived from display_name, so the dashboard can show them as columns."""
    annotations = {"openings": {}, "games": {}, "error_log": []}
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    for row in payload["play_signatures"]:
        assert "family" in row
        assert "variation" in row
    # London System fixture: family stops at "System", no variation
    london = next(r for r in payload["play_signatures"]
                  if r["display_name"] == "London System")
    assert london["family"] == "London System"
    assert london["variation"] == ""


def test_compute_all_includes_opening_families_and_variations():
    """compute_all payload exposes the two new tier-1/tier-2 aggregations."""
    annotations = {"openings": {}, "games": {}, "error_log": []}
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    assert "opening_families" in payload
    assert "opening_variations" in payload


def test_compute_all_includes_plan_compliance_with_empty_plan_default():
    """compute_all should not crash when no plan is passed — emit empty shape."""
    annotations = {"openings": {}, "games": {}, "error_log": []}
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    assert "plan_compliance" in payload
    pc = payload["plan_compliance"]
    assert pc["openings"] == []


def test_compute_plan_compliance_adherence_and_severity():
    """Adherence math, severity buckets, and win-rate split (on-plan vs deviated)."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    def _rec(family, result, first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6",
             side="black", end_time=1_700_000_000):
        return GameRecord(
            url="x", end_time=end_time, time_class="bullet", side=side,
            my_rating=500, opp_rating=500, result=result, opp_result="checkmated",
            plies=20, fullmoves=10, opening=family, eco="A00",
            first_moves=first_moves,
        )

    # 10 black games vs 1.e4: 6 played Modern (4 wins), 4 deviated to Pirc (1 win)
    recs = (
        [_rec("Modern Defense", "win", end_time=1_700_000_000 + i)
         for i in range(4)] +
        [_rec("Modern Defense", "timeout", end_time=1_700_000_010 + i)
         for i in range(2)] +
        [_rec("Pirc Defense", "win", end_time=1_700_000_020)] +
        [_rec("Pirc Defense", "checkmated", end_time=1_700_000_021 + i)
         for i in range(3)]
    )

    plan = {
        "openings": [
            {"name": "Modern Defense (c6 setup)", "side": "black",
             "vs_first_move": "e4", "target_family": "Modern Defense",
             "moves": "1.e4 g6 ...", "plan": "Hold the center."},
        ],
    }
    out = compute_plan_compliance(recs, plan, window=30)
    assert len(out["openings"]) == 1
    o = out["openings"][0]
    assert o["applicable_games"] == 10
    assert o["games_on_plan"] == 6
    assert o["adherence_pct"] == 60.0
    assert o["win_pct_when_played"] == round(100 * 4 / 6, 1)
    assert o["win_pct_when_deviated"] == 25.0
    assert o["severity"] == "green"  # adherence == 60


def test_compute_plan_compliance_severity_buckets():
    """Threshold edges: <40 red, [40,60) yellow, >=60 green, 0-applicable neutral."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    def _make_window(on_plan, deviated, first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6"):
        recs = []
        et = 1_700_000_000
        for i in range(on_plan):
            recs.append(GameRecord(
                url="x", end_time=et + i, time_class="bullet", side="black",
                my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
                plies=20, fullmoves=10, opening="Modern Defense", eco="A00",
                first_moves=first_moves,
            ))
        for i in range(deviated):
            recs.append(GameRecord(
                url="x", end_time=et + 100 + i, time_class="bullet", side="black",
                my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
                plies=20, fullmoves=10, opening="Pirc Defense", eco="A00",
                first_moves=first_moves,
            ))
        return recs

    plan = {"openings": [{"side": "black", "vs_first_move": "e4",
                          "target_family": "Modern Defense", "name": "M"}]}

    # Red: 30% adherence (3 of 10)
    out = compute_plan_compliance(_make_window(3, 7), plan)
    assert out["openings"][0]["severity"] == "red"
    # Yellow: 50% adherence (5 of 10)
    out = compute_plan_compliance(_make_window(5, 5), plan)
    assert out["openings"][0]["severity"] == "yellow"
    # Green: 80% adherence (8 of 10)
    out = compute_plan_compliance(_make_window(8, 2), plan)
    assert out["openings"][0]["severity"] == "green"
    # Neutral: 0 applicable (no 1.e4 games in window)
    out = compute_plan_compliance([], plan)
    # Empty records returns empty openings list, not neutral row
    assert out["openings"] == []


def test_compute_plan_compliance_filters_by_first_move():
    """A game where White played 1.d4 must NOT count toward a 'vs 1.e4' plan."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    recs = [
        GameRecord(url="x", end_time=1_700_000_000, time_class="bullet",
                   side="black", my_rating=500, opp_rating=500, result="win",
                   opp_result="checkmated", plies=20, fullmoves=10,
                   opening="Modern Defense", eco="A00",
                   first_moves="1.d4 g6 2.c4 Bg7"),  # white played d4, NOT e4
    ]
    plan = {"openings": [{"side": "black", "vs_first_move": "e4",
                          "target_family": "Modern Defense", "name": "M"}]}
    out = compute_plan_compliance(recs, plan)
    o = out["openings"][0]
    assert o["applicable_games"] == 0
    assert o["severity"] == "neutral"


def test_compute_plan_compliance_move_pattern_white_entry():
    """A `match` entry classifies by moves: Colle-Zukertort on-plan, London
    (via Bf4) deviated, even though both can carry a 'Queens Pawn' family."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    def _w(opening_moves, result, et):
        return GameRecord(
            url="x", end_time=et, time_class="bullet", side="white",
            my_rating=500, opp_rating=500, result=result,
            opp_result="checkmated", plies=24, fullmoves=12,
            opening="Queens Pawn Opening", eco="D02",
            first_moves=" ".join(opening_moves.split()[:8]),
            opening_moves=opening_moves,
        )

    cz = "1.d4 d5 2.Nf3 Nf6 3.e3 e6 4.Bd3 c5 5.b3 Nc6 6.Bb2 Bd6"
    london = "1.d4 d5 2.Nf3 Nf6 3.Bf4 e6 4.e3 Bd6 5.Bd3 O-O 6.O-O c5"
    recs = (
        [_w(cz, "win", 1_700_000_000 + i) for i in range(3)] +      # 3 on-plan
        [_w(london, "win", 1_700_000_100 + i) for i in range(2)]    # 2 deviated
    )
    plan = {"openings": [{
        "name": "Colle-Zukertort System", "side": "white", "vs_first_move": "d4",
        "target_family": "Colle Zukertort System",
        "moves": cz, "plan": "...",
        "match": {"white_requires_any": [["e3", "b3"], ["e3", "Bb2"]],
                  "white_forbids": ["Bf4"], "window_plies": 12},
    }]}
    out = compute_plan_compliance(recs, plan, window=30)
    o = out["openings"][0]
    assert o["applicable_games"] == 5
    assert o["games_on_plan"] == 3
    assert o["adherence_pct"] == 60.0
    assert o["severity"] == "green"


def test_compute_plan_compliance_gambit_breakdown():
    """Four Knights entry tallies gambit flags and ignores non-...e5 games."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    def _w(opening_moves, et):
        return GameRecord(
            url="x", end_time=et, time_class="bullet", side="white",
            my_rating=500, opp_rating=500, result="win",
            opp_result="checkmated", plies=20, fullmoves=10,
            opening="Four Knights Game", eco="C47",
            first_moves=" ".join(opening_moves.split()[:8]),
            opening_moves=opening_moves,
        )

    recs = [
        _w("1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.Nxe5 Nxe5", 1_700_000_000),   # Halloween
        _w("1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.d4 exd4 5.Nd5 Nxd5", 1_700_000_001),  # Belgrade
        _w("1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.Bb5 Bb4", 1_700_000_002),     # plain FK
        _w("1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 4.d4 Nf6", 1_700_000_003),    # Scandinavian: N/A
    ]
    plan = {"openings": [{
        "name": "Four Knights", "side": "white", "vs_first_move": "e4",
        "target_family": "Four Knights Game", "moves": "...", "plan": "...",
        "match": {"applicable_if_black_plays": "e5",
                  "white_requires": ["Nf3", "Nc3"],
                  "gambit_flags": {"Halloween": ["Nxe5"], "Belgrade": ["Nd5"]},
                  "window_plies": 12},
    }]}
    out = compute_plan_compliance(recs, plan, window=30)
    o = out["openings"][0]
    assert o["applicable_games"] == 3          # Scandinavian excluded
    assert o["games_on_plan"] == 3
    assert o["gambit_breakdown"] == {"Halloween": 1, "Belgrade": 1}


def test_compute_plan_compliance_family_entry_unchanged_has_no_breakdown():
    """Entries without a `match` block keep the family path and omit breakdown."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1_700_000_000, time_class="bullet", side="black",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=20, fullmoves=10, opening="Modern Defense", eco="B06",
        first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6")
    plan = {"openings": [{"name": "Modern", "side": "black",
                          "vs_first_move": "e4", "target_family": "Modern Defense"}]}
    out = compute_plan_compliance([rec], plan)
    o = out["openings"][0]
    assert o["games_on_plan"] == 1
    assert o["gambit_breakdown"] is None


def test_compute_plan_compliance_status_defaults_to_active():
    """An opening with no status field is reported as active."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1_700_000_000, time_class="bullet", side="black",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=20, fullmoves=10, opening="Modern Defense", eco="B06",
        first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6")
    plan = {"openings": [{"name": "Modern", "side": "black",
                          "vs_first_move": "e4", "target_family": "Modern Defense"}]}
    out = compute_plan_compliance([rec], plan)
    assert out["openings"][0]["status"] == "active"


def test_shipped_plan_has_white_entries_with_match_rules():
    """The shipped plan.json carries the two White move-pattern entries."""
    from chess_tracker.plan import load_plan

    plan = load_plan()
    by_name = {o["name"]: o for o in plan["openings"]}
    cz = by_name["Colle–Zukertort System"]
    assert cz["side"] == "white" and cz["vs_first_move"] == "d4"
    assert cz["match"]["white_forbids"] == ["Bf4"]
    anti_englund = by_name["Englund Gambit"]
    assert anti_englund["side"] == "white" and anti_englund["vs_first_move"] == "d4"
    assert anti_englund["target_family"] == "Englund Gambit"
    assert anti_englund["match"]["applicable_if_black_plays"] == "e5"
    assert anti_englund["match"]["white_requires"] == ["dxe5"]
    assert "gambit_flags" not in anti_englund["match"]
    assert "lines" not in anti_englund
    modern = by_name["Modern Defense"]
    assert modern["side"] == "black" and modern["vs_first_move"] == "e4"
    assert modern["target_family"] == "Modern Defense"


def test_compute_plan_compliance_multi_line_boards():
    """An entry with a `lines` array yields per-line board_lines with fens."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1, time_class="bullet", side="white",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=10, fullmoves=5, opening="Four Knights Game", eco="C47",
        first_moves="1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6",
        opening_moves="1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.Nxe5 Nxe5")
    plan = {"openings": [{
        "name": "Four Knights", "side": "white", "vs_first_move": "e4",
        "target_family": "Four Knights Game", "plan": "...",
        "lines": [
            {"label": "Halloween", "moves": "1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.Nxe5"},
            {"label": "Belgrade", "moves": "1.e4 e5 2.Nf3 Nc6 3.Nc3 Nf6 4.d4 exd4 5.Nd5"},
        ],
        "match": {"applicable_if_black_plays": "e5",
                  "white_requires": ["Nf3", "Nc3"], "window_plies": 12},
    }]}
    out = compute_plan_compliance([rec], plan)
    o = out["openings"][0]
    assert o["board_lines"] is not None
    assert [bl["label"] for bl in o["board_lines"]] == ["Halloween", "Belgrade"]
    assert len(o["board_lines"][0]["fens"]) > 1   # Halloween renders a board
    assert len(o["board_lines"][1]["fens"]) > 1   # Belgrade renders a board


def test_compute_plan_compliance_single_line_has_no_board_lines():
    """An entry without `lines` keeps the single board path; board_lines None."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1, time_class="bullet", side="black",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=8, fullmoves=4, opening="Modern Defense", eco="B06",
        first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6")
    plan = {"openings": [{"name": "Modern", "side": "black",
                          "vs_first_move": "e4", "target_family": "Modern Defense",
                          "moves": "1.e4 g6 2.d4 Bg7"}]}
    out = compute_plan_compliance([rec], plan)
    o = out["openings"][0]
    assert o["board_lines"] is None
    assert len(o["fens"]) > 1


def test_opening_families_aggregates_across_play_signatures():
    """A family-color row sums all games sharing that family + color,
    regardless of which play_signature they came from."""
    from chess_tracker.metrics import compute_opening_families
    from chess_tracker.pgn import GameRecord

    def _rec(family, color, sig):
        return GameRecord(
            url="x", end_time=0, time_class="bullet", side=color,
            my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
            plies=20, fullmoves=10,
            opening=f"{family} Whatever Variation",
            eco="A00", play_signature=sig, family=family, variation="Whatever Variation",
        )

    recs = [
        _rec("Queens Pawn Opening", "white", "sig-A"),
        _rec("Queens Pawn Opening", "white", "sig-A"),
        _rec("Queens Pawn Opening", "white", "sig-B"),  # different play_signature, same family+color
        _rec("Queens Pawn Opening", "black", "sig-C"),  # different color, separate row
    ]
    rows = compute_opening_families(recs)
    qp_white = next(r for r in rows if r["family"] == "Queens Pawn Opening" and r["color"] == "white")
    qp_black = next(r for r in rows if r["family"] == "Queens Pawn Opening" and r["color"] == "black")
    assert qp_white["games"] == 3
    assert qp_white["variation_count"] == 2  # sig-A and sig-B
    assert qp_black["games"] == 1
    # canonical_play_signature = most-frequent play_signature in the group;
    # sig-A appears 2x vs sig-B's 1x → sig-A wins
    assert qp_white["canonical_play_signature"] == "sig-A"


def test_opening_variations_collapses_transpositions_into_one_row():
    """The bug we fixed: same named variation reached via different move
    orders (different play_signatures) must collapse into ONE row per
    (family, variation, color)."""
    from chess_tracker.metrics import compute_opening_variations
    from chess_tracker.pgn import GameRecord

    def _rec(sig):
        return GameRecord(
            url="x", end_time=0, time_class="bullet", side="white",
            my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
            plies=20, fullmoves=10,
            opening="Queens Pawn Opening Zukertort Chigorin Variation",
            eco="D02", play_signature=sig,
        )

    # Three "different" 8-ply positions, same named variation
    recs = [_rec("sig-1"), _rec("sig-1"), _rec("sig-2"), _rec("sig-3")]
    rows = compute_opening_variations(recs)
    chig = [r for r in rows
            if r["family"] == "Queens Pawn Opening"
            and r["variation"] == "Zukertort Chigorin Variation"
            and r["color"] == "white"]
    assert len(chig) == 1, "duplicate variation rows — collapsing failed"
    assert chig[0]["games"] == 4
    assert chig[0]["position_count"] == 3  # three distinct play_signatures
    # canonical = most-frequent play_signature
    assert chig[0]["canonical_play_signature"] == "sig-1"


def test_opening_variations_separates_by_color_and_main_line():
    """Same variation as White vs Black = separate rows. Main-line (no
    variation suffix) gets its own row too."""
    from chess_tracker.metrics import compute_opening_variations
    from chess_tracker.pgn import GameRecord

    def _rec(side, opening):
        return GameRecord(
            url="x", end_time=0, time_class="bullet", side=side,
            my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
            plies=20, fullmoves=10,
            opening=opening, eco="A00", play_signature=f"sig-{side}-{opening}",
        )

    recs = [
        _rec("white", "London System"),                    # main line → aliased to Queens Pawn Opening
        _rec("white", "London System Indian Defense"),     # named variation → aliased
        _rec("black", "London System"),                    # main line, other color → aliased
    ]
    rows = compute_opening_variations(recs)
    # London System is aliased to Queens Pawn Opening at key-build time
    qp_white_main = [r for r in rows
                     if r["family"] == "Queens Pawn Opening"
                     and r["variation"] == ""
                     and r["color"] == "white"]
    qp_white_indian = [r for r in rows
                       if r["family"] == "Queens Pawn Opening"
                       and r["variation"] == "Indian Defense"
                       and r["color"] == "white"]
    qp_black_main = [r for r in rows
                     if r["family"] == "Queens Pawn Opening"
                     and r["variation"] == ""
                     and r["color"] == "black"]
    assert len(qp_white_main) == 1
    assert len(qp_white_indian) == 1
    assert len(qp_black_main) == 1


def test_compute_sessions_includes_first_game_delta():
    """Session rating delta uses prior global game's postgame rating as start,
    so the first game in a session contributes to the session's delta."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_sessions

    def _mk(t, rating, result="win", opp_result="checkmated"):
        return GameRecord(
            url=f"u{t}", end_time=t, time_class="bullet",
            side="white", my_rating=rating, opp_rating=500,
            result=result, opp_result=opp_result,
            plies=20, fullmoves=10, opening="x", eco="A00",
            play_signature="sig",
        )

    # Two sessions, separated by a >10min gap.
    # Session 1: 500 → 510 → 520 (two wins after starting at 490 prior). Delta should be 30 (520-490).
    # Session 2: starts with a 20-point loss (rating 520→500), then steady at 500. Delta should be -20.
    records = [
        _mk(1_700_000_000, 500),   # first game ever: prior rating unknown; falls back to postgame=500
        _mk(1_700_000_060, 510),   # +10
        _mk(1_700_000_120, 520),   # +10
        # Gap of 30 min
        _mk(1_700_002_000, 500, result="checkmated", opp_result="win"),  # -20 from 520
        _mk(1_700_002_060, 500),   # +0
    ]
    sessions = compute_sessions(records)
    assert len(sessions) == 2
    # Session 1: first session has no prior record → rating_start = 500 (postgame of game 1)
    assert sessions[0]["rating_start"] == 500
    assert sessions[0]["rating_end"] == 520
    assert sessions[0]["rating_delta"] == 20
    assert sessions[0]["rating_start_exact"] is False
    # Session 2: prior global record is rating 520 → start = 520
    assert sessions[1]["rating_start"] == 520
    assert sessions[1]["rating_end"] == 500
    assert sessions[1]["rating_delta"] == -20
    assert sessions[1]["rating_start_exact"] is True


def test_compute_all_merges_opening_annotations():
    annotations = {
        "openings": {"London System": {"tag": "in_repertoire", "note": "main d4"}},
        "games": {}, "error_log": [],
    }
    payload = compute_all(RECORDS, annotations, username="m_v-v")
    london = next(r for r in payload["play_signatures"]
                  if r["display_name"] == "London System")
    assert london["tag"] == "in_repertoire"
    assert london["note"] == "main d4"


def test_outlasted_but_flagged_requires_5s_edge_after_move_10():
    """Tighter definition: timeout loss with ≥5s clock edge at any ply
    from move 10 onward (my_clocks index >= 9). Tiny early edges don't count."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_process_metrics

    def _mk(my_clocks, opp_clocks):
        return GameRecord(
            url="u", end_time=1, time_class="bullet",
            side="white", my_rating=500, opp_rating=500,
            result="timeout", opp_result="win",
            plies=len(my_clocks) * 2, fullmoves=len(my_clocks),
            opening="x", eco="A00",
            my_clocks=my_clocks, opp_clocks=opp_clocks,
        )

    # Case 1: 0.2s edge at move 2, then opponent leads the rest. Should NOT count.
    too_early = _mk(
        my_clocks=[59.0, 50.0, 40.0, 30.0, 20.0, 10.0, 5.0, 2.0, 1.0, 0.0],
        opp_clocks=[58.8, 51.0, 45.0, 38.0, 30.0, 25.0, 20.0, 15.0, 12.0, 10.0],
    )
    # Case 2: 7s edge at move 10, still timed out. Should count.
    real_choke = _mk(
        my_clocks=[55.0, 50.0, 45.0, 40.0, 35.0, 30.0, 25.0, 20.0, 15.0, 12.0,
                   5.0, 0.0],
        opp_clocks=[50.0, 45.0, 40.0, 35.0, 30.0, 25.0, 20.0, 15.0, 10.0, 5.0,
                    4.0, 3.0],
    )
    pm = compute_process_metrics([too_early, real_choke])
    assert pm["outlasted_but_flagged_count"] == 1


def test_abandonment_leak_fires_on_any_abandonment_in_window():
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import detect_leaks

    def _mk(t, result):
        return GameRecord(
            url=f"u{t}", end_time=t, time_class="bullet",
            side="white", my_rating=500, opp_rating=500,
            result=result, opp_result="win",
            plies=20, fullmoves=10, opening="x", eco="A00",
        )

    # 30 games: 29 timeouts (boring losses), 1 abandonment. Should fire abandonment leak.
    records = [_mk(1_700_000_000 + i*60, "timeout") for i in range(29)]
    records.append(_mk(1_700_001_800, "abandoned"))
    leaks = detect_leaks(records)
    names = [L["name"] for L in leaks]
    assert "abandonment" in names
    ab = next(L for L in leaks if L["name"] == "abandonment")
    assert ab["severity"] == "critical"
    assert "1" in ab["evidence"]  # mentions the count


def test_opening_families_rating_weighted_columns_and_sort():
    """Each family row carries sum_rating_delta / avg_rating_delta /
    timeout_rating_delta / checkmate_rating_delta, and the default sort
    is by sum_rating_delta ascending (worst-bleeding family first)."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.enrich import enrich_with_deltas
    from chess_tracker.metrics import compute_opening_families

    def _mk(t, rating, opening, result, side="white"):
        return GameRecord(
            url=f"u{t}", end_time=t, time_class="bullet",
            side=side, my_rating=rating, opp_rating=500,
            result=result, opp_result="win" if result != "win" else "checkmated",
            plies=20, fullmoves=10, opening=opening, eco="A00",
        )

    # London System: net -30 across two games (timeout cost 20, mate cost 10)
    # Italian Game: net +20 across two games
    records = [
        _mk(1, 500, "London System", "win"),                # prev=None → delta=None
        _mk(2, 480, "London System", "timeout"),            # -20 timeout
        _mk(3, 470, "London System", "checkmated"),         # -10 mate
        _mk(4, 480, "Italian Game", "win"),                 # +10
        _mk(5, 490, "Italian Game", "win"),                 # +10
    ]
    enrich_with_deltas(records)
    rows = compute_opening_families(records)
    # London System is aliased to Queens Pawn Opening
    qp = next(r for r in rows if r["family"] == "Queens Pawn Opening")
    italian = next(r for r in rows if r["family"] == "Italian Game")
    assert qp["sum_rating_delta"] == -30
    assert qp["timeout_rating_delta"] == -20
    assert qp["checkmate_rating_delta"] == -10
    assert italian["sum_rating_delta"] == 20
    # Sort: worst (most negative sum) first
    assert rows[0]["family"] == "Queens Pawn Opening"


def test_review_picks_one_timeout_one_mate_one_biggest_loss():
    from chess_tracker.pgn import GameRecord
    from chess_tracker.enrich import enrich_with_deltas
    from chess_tracker.metrics import compute_review_picks

    def _mk(t, rating, result, fullmoves=20):
        return GameRecord(
            url=f"u{t}", end_time=t, time_class="bullet",
            side="white", my_rating=rating, opp_rating=500,
            result=result, opp_result="win",
            plies=fullmoves*2, fullmoves=fullmoves, opening="x", eco="A00",
        )

    records = [
        _mk(1, 500, "win"),
        _mk(2, 480, "timeout"),                  # -20 timeout
        _mk(3, 470, "checkmated", fullmoves=12), # -10 fast mate
        _mk(4, 430, "checkmated", fullmoves=40), # -40 long-game mate, largest single-game loss
        _mk(5, 425, "timeout"),                  # -5 timeout
    ]
    enrich_with_deltas(records)
    picks = compute_review_picks(records)
    # Three picks: kinds in this order.
    kinds = [p["kind"] for p in picks]
    assert kinds == ["biggest_loss", "timeout", "fast_mate"]
    # biggest_loss = -40 mate at game 4
    assert picks[0]["url"] == "u4"
    # timeout = most recent timeout (game 5)
    assert picks[1]["url"] == "u5"
    # fast_mate = most recent checkmated game with fullmoves <= 15 (game 3)
    assert picks[2]["url"] == "u3"


def test_opening_velocity_uses_actual_start_clock_not_hardcoded_60():
    """For 2+1 blitz (120s start), opening velocity must be computed from
    120s, not the bullet-only 60s hardcode.

    Fast blitz opener: 0.5s × 8 moves = 4s spent → velocity should be ~4s.
    With the 60s bug:  60 - 116 = -56s  (negative — physically impossible).
    With the fix:     120 - 116 =   4s  (correct).

    Test accepts 0–30s as the valid range; rejects negative values and
    values above 30s (which would indicate ignoring the blitz start clock).
    """
    pm = compute_process_metrics(BLITZ_CLOCK_RECORDS)
    vel = pm["opening_velocity_median"]
    assert vel is not None
    assert vel > 0, (
        f"opening_velocity_median is {vel} — negative value indicates "
        "hardcoded 60s baseline bug (clock[7]=116 for blitz, 60-116=-56)"
    )
    assert vel < 30, (
        f"opening_velocity_median is {vel} — expected ~4–24s for these records"
    )


def test_time_burn_delta_is_not_wildly_negative_for_blitz_records():
    """time_burn_delta = mean(early s/move) - mean(late s/move).

    For BLITZ_CLOCK_RECORDS, the fast and slow openers are evenly mixed
    and their pacing is consistent, so delta should be near zero.

    With the 60s bug, early_total = 60 - clock[7] goes negative for blitz
    games (e.g. 60 - 116 = -56), making early_rates negative and dragging
    time_burn_delta to ~ -7.5.

    Threshold: any value below -3.0 indicates the bug is present.
    """
    pm = compute_process_metrics(BLITZ_CLOCK_RECORDS)
    delta = pm["time_burn_delta"]
    assert delta is not None
    assert delta > -3.0, (
        f"time_burn_delta is {delta} — value below -3 strongly indicates "
        "early_total computed with hardcoded 60s instead of actual start clock"
    )


def test_compute_opening_families_plan_status_none_without_plan():
    """Without a plan arg, every row has plan_status=None."""
    from chess_tracker.metrics import compute_opening_families
    families = compute_opening_families(RECORDS)
    for row in families:
        assert "plan_status" in row
        assert row["plan_status"] is None


def test_compute_opening_families_plan_status_active():
    """plan_status='active' when family+side matches an active plan entry.
    RECORDS has 'London System' white games, aliased to 'Queens Pawn Opening'.
    Plan entries must use the canonical (post-alias) family name to match.
    """
    from chess_tracker.metrics import compute_opening_families
    plan = {
        "openings": [
            {"target_family": "Queens Pawn Opening", "side": "white",
             "name": "Queens Pawn Opening", "status": "active"},
        ]
    }
    families = compute_opening_families(RECORDS, plan=plan)
    qp_white = next(r for r in families
                    if r["family"] == "Queens Pawn Opening" and r["color"] == "white")
    assert qp_white["plan_status"] == "active"
    italian_black = next(r for r in families
                         if r["family"] == "Italian Game" and r["color"] == "black")
    assert italian_black["plan_status"] is None


def test_compute_opening_families_smoothed_win_rate_laplace():
    """smoothed_win_rate = round((wins + 2) / (games + 4), 3) for every row."""
    from chess_tracker.metrics import compute_opening_families
    families = compute_opening_families(RECORDS)
    for row in families:
        assert "smoothed_win_rate" in row
        expected = round((row["wins"] + 2) / (row["games"] + 4), 3)
        assert abs(row["smoothed_win_rate"] - expected) < 0.001


def test_compute_opening_families_sample_strength_thresholds():
    """sample_strength labels: <10→ignore, <30→weak, <100→usable, ≥100→strong."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_opening_families

    def _mk(n, result="win"):
        return [GameRecord(
            url=f"u{i}", end_time=i, time_class="bullet",
            side="white", my_rating=500, opp_rating=500,
            result=result, opp_result="checkmated",
            plies=20, fullmoves=10, opening="Test Opening", eco="A00",
        ) for i in range(n)]

    for n, expected_label in [(5, "ignore"), (15, "weak"), (50, "usable"), (100, "strong")]:
        rows = compute_opening_families(_mk(n))
        assert rows[0]["sample_strength"] == expected_label, (
            f"{n} games → expected {expected_label!r}, "
            f"got {rows[0]['sample_strength']!r}"
        )


def test_compute_all_applies_family_aliases_london_to_queens_pawn():
    """London System records must appear as Queens Pawn Opening in the payload."""
    from chess_tracker.metrics import compute_all
    annotations = {"openings": {}, "games": {}, "error_log": [], "blocked_dates": []}
    # RECORDS has 3 London System white games and no Queens Pawn Opening games
    payload = compute_all(RECORDS, annotations, username="x")
    families = payload["opening_families"]
    assert not any(f["family"] == "London System" for f in families), (
        "London System should be aliased away"
    )
    qp = next((f for f in families
               if f["family"] == "Queens Pawn Opening" and f["color"] == "white"), None)
    assert qp is not None, "Queens Pawn Opening white row should exist after alias"
    assert qp["games"] == 3


def test_compute_opening_families_applies_aliases_directly():
    """compute_opening_families() applies FAMILY_ALIASES at key-build time; no mutation needed."""
    from chess_tracker.metrics import compute_opening_families
    from chess_tracker.enrich import enrich_with_deltas, enrich_with_sessions
    recs = list(RECORDS)
    enrich_with_deltas(recs)
    enrich_with_sessions(recs)
    families = compute_opening_families(recs)
    # Aliases applied: London System merged into Queens Pawn Opening
    assert not any(f["family"] == "London System" for f in families)
    assert any(f["family"] == "Queens Pawn Opening" and f["color"] == "white" for f in families)
    # Original records are NOT mutated
    assert any(r.family == "London System" for r in recs)


def test_compute_opening_families_keeps_modern_separate_from_pirc():
    """Modern Defense is its own repertoire family, not folded into Pirc."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_opening_families
    from chess_tracker.enrich import enrich_with_deltas, enrich_with_sessions

    recs = [
        GameRecord(
            url="modern", end_time=1, time_class="bullet",
            side="black", my_rating=500, opp_rating=500,
            result="win", opp_result="checkmated",
            plies=20, fullmoves=10, opening="Modern Defense with", eco="B06",
            family="Modern Defense", variation="with",
        ),
        GameRecord(
            url="pirc", end_time=2, time_class="bullet",
            side="black", my_rating=508, opp_rating=500,
            result="timeout", opp_result="win",
            plies=20, fullmoves=10, opening="Pirc Defense", eco="B07",
            family="Pirc Defense", variation="",
        ),
    ]
    enrich_with_deltas(recs)
    enrich_with_sessions(recs)

    families = compute_opening_families(recs)
    assert any(f["family"] == "Modern Defense" and f["color"] == "black"
               for f in families)
    assert any(f["family"] == "Pirc Defense" and f["color"] == "black"
               for f in families)


def test_compute_opening_families_is_rare_flag():
    """is_rare=True when games < 10; False when games >= 10."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_opening_families
    from chess_tracker.enrich import enrich_with_deltas, enrich_with_sessions

    def _mk(n, family, result="win"):
        recs = [GameRecord(
            url=f"u{i}", end_time=i, time_class="bullet",
            side="white", my_rating=500, opp_rating=500,
            result=result, opp_result="checkmated",
            plies=20, fullmoves=10, opening=f"{family} Test Variation", eco="A00",
            family=family, variation="Test Variation",
        ) for i in range(n)]
        enrich_with_deltas(recs)
        enrich_with_sessions(recs)
        return recs

    # 5 games → rare
    rows = compute_opening_families(_mk(5, "Small Family"))
    assert rows[0]["is_rare"] is True

    # 9 games → rare (boundary: < 10)
    rows = compute_opening_families(_mk(9, "Almost Family"))
    assert rows[0]["is_rare"] is True

    # 10 games → not rare
    rows = compute_opening_families(_mk(10, "Big Family"))
    assert rows[0]["is_rare"] is False

    # 50 games → not rare
    rows = compute_opening_families(_mk(50, "Strong Family"))
    assert rows[0]["is_rare"] is False


def test_compute_opening_families_priority_underperformers_rank_higher():
    """priority ≥ 0 always; a below-average opening outranks an above-average one."""
    from chess_tracker.pgn import GameRecord
    from chess_tracker.metrics import compute_opening_families

    good = [GameRecord(url=f"g{i}", end_time=i, time_class="bullet",
                       side="white", my_rating=500, opp_rating=500,
                       result="win", opp_result="checkmated",
                       plies=20, fullmoves=10, opening="Good Opening", eco="A00")
            for i in range(10)]
    bad = [GameRecord(url=f"b{i}", end_time=100 + i, time_class="bullet",
                      side="white", my_rating=500, opp_rating=500,
                      result="timeout", opp_result="win",
                      plies=20, fullmoves=10, opening="Bad Opening", eco="B00")
           for i in range(10)]
    rows = compute_opening_families(good + bad)
    for row in rows:
        assert row["priority"] >= 0
    good_row = next(r for r in rows if r["family"] == "Good Opening")
    bad_row = next(r for r in rows if r["family"] == "Bad Opening")
    assert bad_row["priority"] > good_row["priority"]


def test_shipped_plan_has_no_bench_entries():
    """plan.json must not contain any bench entries."""
    from chess_tracker.plan import load_plan
    plan = load_plan()
    bench = [o for o in plan["openings"] if o.get("status") == "bench"]
    assert bench == [], f"Found bench entries: {[o['name'] for o in bench]}"
