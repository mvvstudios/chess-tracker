# Post-peak decay reshape — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 `mid_session_decay` leak with a peak-aware `post_peak_decay` rule, and re-derive the `next_session_rule` game cap from the same signal.

**Architecture:** Add a private helper `_post_peak_decay(decay)` to `chess_tracker/metrics.py` that returns `(fired, peak_row, last_row)` over the existing four session-position buckets. Both `detect_leaks` and `next_session_rule` consume the helper so they cannot disagree. No new modules, no new dependencies, no dashboard changes.

**Tech Stack:** Python 3 (stdlib only), pytest, `uv run` for execution. Source lives in `chess_tracker/metrics.py`; tests in `tests/test_metrics.py`.

**Spec:** `docs/superpowers/specs/2026-05-27-post-peak-decay-reshape-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `chess_tracker/metrics.py` | Modify | Add `_post_peak_decay` helper near `compute_session_decay`. Replace `mid_session_decay` block in `detect_leaks` (currently lines 284-295). Replace game-cap loop in `next_session_rule` (currently lines 319-326). |
| `tests/test_metrics.py` | Modify | Add a small in-file fixture builder `_session_with_results`, six unit tests against `_post_peak_decay`, one integration test against `detect_leaks`, two integration tests against `next_session_rule`. |

No other files are touched. Dashboard, render layer, API layer, and existing fixtures are out of scope.

---

## Task 1: Add `_post_peak_decay` helper with unit tests

**Files:**
- Modify: `chess_tracker/metrics.py` (add helper after `compute_session_decay`, around line 242)
- Modify: `tests/test_metrics.py` (add 6 unit tests, import helper)

- [ ] **Step 1: Add the six failing unit tests**

Open `tests/test_metrics.py`. After the existing `test_compute_session_decay_returns_buckets` (around line 135), append:

```python
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


def test_post_peak_decay_excludes_peak_bucket_with_too_few_games():
    # 11-20 would be the peak by win_pct, but has only 4 games → ineligible.
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
```

- [ ] **Step 2: Run the six new tests and verify they fail**

Run: `uv run pytest tests/test_metrics.py -k post_peak_decay -v`

Expected: 6 failures with `ImportError` (cannot import `_post_peak_decay` from `chess_tracker.metrics`).

- [ ] **Step 3: Add the `_post_peak_decay` helper to `chess_tracker/metrics.py`**

Open `chess_tracker/metrics.py`. Locate `compute_session_decay` (around line 238). Immediately after its function body ends (right before `def detect_leaks` at line 244), insert:

```python
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
```

- [ ] **Step 4: Run the six unit tests and verify they pass**

Run: `uv run pytest tests/test_metrics.py -k post_peak_decay -v`

Expected: 6 passed.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `uv run pytest -q`

Expected: 46 passed (40 existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add chess_tracker/metrics.py tests/test_metrics.py
git commit -m "$(cat <<'EOF'
feat(metrics): add _post_peak_decay helper for v1.1 reshape

Algorithm-only commit. The helper finds the peak session-position bucket
(highest win_pct, tie-broken by latest position) and returns whether win%
dropped >=10pp from peak to the latest-position eligible bucket. Not yet
wired into detect_leaks or next_session_rule.

EOF
)"
```

---

## Task 2: Wire helper into `detect_leaks` (rename rule to `post_peak_decay`)

**Files:**
- Modify: `chess_tracker/metrics.py` (replace `mid_session_decay` block at lines 284-295)
- Modify: `tests/test_metrics.py` (add `_session_with_results` builder + 1 integration test)

- [ ] **Step 1: Add the failing integration test**

Open `tests/test_metrics.py`. Below the existing `test_detect_leaks_flags_slow_opening_when_velocity_high` (around line 154), append:

```python
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
```

- [ ] **Step 2: Run the new integration test and verify it fails**

Run: `uv run pytest tests/test_metrics.py::test_detect_leaks_includes_post_peak_decay_when_peak_crashes -v`

Expected: FAIL — assertion error on `"post_peak_decay" in names` because the current leak is still named `mid_session_decay` and uses the old monotonic comparison.

- [ ] **Step 3: Replace the `mid_session_decay` block in `detect_leaks`**

Open `chess_tracker/metrics.py`. Find the block currently at lines 284-295:

```python
    # Mid-session decay & tilt-session use full history; 30-game window starves the 21+ bucket.
    decay = compute_session_decay(records)
    by_bucket = {row["bucket"]: row for row in decay}
    early = by_bucket.get("1-5", {}).get("win_pct", 0.0)
    late = by_bucket.get("21+", {}).get("win_pct", 0.0)
    if early - late >= 10 and by_bucket.get("21+", {}).get("games", 0) >= 5:
        leaks.append({
            "name": "mid_session_decay",
            "severity": "warn",
            "evidence": f"win% drops from {early:.0f}% in games 1-5 to {late:.0f}% after game 21",
            "suggested_action": "Cap sessions — see Next Session Rule.",
        })
```

Replace it with:

```python
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
```

- [ ] **Step 4: Run the integration test and verify it passes**

Run: `uv run pytest tests/test_metrics.py::test_detect_leaks_includes_post_peak_decay_when_peak_crashes -v`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -q`

Expected: 47 passed (no regressions; the existing `test_detect_leaks_returns_rows_with_required_fields` only checks shape and `test_detect_leaks_flags_slow_opening_when_velocity_high` only checks `time_burn_opening`).

If the full-suite count differs or any existing test fails: stop and investigate. Do NOT proceed to Task 3.

- [ ] **Step 6: Commit**

```bash
git add chess_tracker/metrics.py tests/test_metrics.py
git commit -m "$(cat <<'EOF'
feat(metrics): rename mid_session_decay to post_peak_decay

Wire the _post_peak_decay helper into detect_leaks. The leak now fires
on a >=10pp drop from the peak session-position bucket to the latest
eligible bucket, replacing the old monotonic 1-5 vs 21+ comparison.

EOF
)"
```

---

## Task 3: Re-derive `next_session_rule` game cap from peak signal

**Files:**
- Modify: `chess_tracker/metrics.py` (replace cap loop at lines 319-326)
- Modify: `tests/test_metrics.py` (add 2 integration tests)

- [ ] **Step 1: Add the two failing integration tests**

Open `tests/test_metrics.py`. Below `test_next_session_rule_has_three_fields_plus_narrative` (around line 162), append:

```python
def test_next_session_rule_caps_at_peak_bucket_end_when_decay_fires():
    # Same fixture shape as the leak test: peak at 11-20, crash at 21+.
    results = (
        ["win"] * 2 + ["timeout"] * 3 +
        ["win"] * 3 + ["timeout"] * 2 +
        ["win"] * 8 + ["timeout"] * 2 +
        ["win"] * 1 + ["timeout"] * 4
    )
    rule = next_session_rule(_session_with_results(results))
    assert rule["game_cap"] == 20


def test_next_session_rule_keeps_default_cap_when_no_decay():
    # Monotonic increase: 1-5 (1W,4L), 6-10 (2W,3L), 11-20 (6W,4L), 21+ (4W,1L)
    # Peak == last == 21+, no fire, cap should stay at 30.
    results = (
        ["win"] * 1 + ["timeout"] * 4 +
        ["win"] * 2 + ["timeout"] * 3 +
        ["win"] * 6 + ["timeout"] * 4 +
        ["win"] * 4 + ["timeout"] * 1
    )
    rule = next_session_rule(_session_with_results(results))
    assert rule["game_cap"] == 30
```

- [ ] **Step 2: Run the two new tests and verify they fail**

Run: `uv run pytest tests/test_metrics.py -k next_session_rule -v`

Expected: the two new tests FAIL. (The first because the old "first bucket where win% < 40" rule would set cap = 5; the second may pass or fail depending on bucket win-percentages — verify it fails on the new expectation if applicable.) `test_next_session_rule_has_three_fields_plus_narrative` should continue to pass.

- [ ] **Step 3: Replace the cap loop in `next_session_rule`**

Open `chess_tracker/metrics.py`. Find the block currently at lines 319-326:

```python
    # Game cap: first session-position bucket where win% < 40
    decay = compute_session_decay(records)
    cap = 30  # default
    for row in decay:
        if row["games"] >= 5 and row["win_pct"] < 40:
            bucket = row["bucket"]
            cap = {"1-5": 5, "6-10": 10, "11-20": 20, "21+": 30}[bucket]
            break
```

Replace it with:

```python
    # Game cap: tied 1:1 to the post_peak_decay leak. End of peak bucket
    # when fired; default 30 otherwise.
    decay = compute_session_decay(records)
    fired, peak, _last = _post_peak_decay(decay)
    cap = 30
    if fired:
        cap = {"1-5": 5, "6-10": 10, "11-20": 20}[peak["bucket"]]
```

- [ ] **Step 4: Run the next_session_rule tests and verify they pass**

Run: `uv run pytest tests/test_metrics.py -k next_session_rule -v`

Expected: all `next_session_rule` tests pass (3 total: the existing shape test + the two new ones).

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -q`

Expected: 49 passed (40 baseline + 6 helper unit tests + 1 leak integration test + 2 cap integration tests).

- [ ] **Step 6: Commit**

```bash
git add chess_tracker/metrics.py tests/test_metrics.py
git commit -m "$(cat <<'EOF'
feat(metrics): tie next-session game cap to post_peak_decay signal

next_session_rule now caps at the end of the peak session-position bucket
when post_peak_decay fires (1-5->5, 6-10->10, 11-20->20). Default cap of
30 applies when the leak does not fire. Removes the "first bucket where
win% < 40" fallback whose cold-start dip behavior was empirically wrong.

EOF
)"
```

---

## Final verification

- [ ] **Run the full suite one more time from a clean state**

Run: `uv run pytest -q`

Expected: 49 passed.

- [ ] **Confirm the working tree is clean**

Run: `git status --short`

Expected: empty output.

- [ ] **Confirm three commits land cleanly**

Run: `git log --oneline -4`

Expected (top three, in order):
1. `feat(metrics): tie next-session game cap to post_peak_decay signal`
2. `feat(metrics): rename mid_session_decay to post_peak_decay`
3. `feat(metrics): add _post_peak_decay helper for v1.1 reshape`
4. `docs(spec): v1.1 post-peak decay reshape design`

- [ ] **Smoke test against real data (optional, recommended)**

If `data/refresh.py` (or the documented refresh path) is available locally:

```bash
uv run python -m chess_tracker.api  # whatever invokes a refresh / render
```

Then open `dashboard/index.html` via `python3 -m http.server 8000` and visually confirm that any `post_peak_decay` leak renders with the expected evidence wording and that the next-session cap matches the bucket implied by the table.

This is a sanity check, not a gate. If you cannot run it locally, mark the box "n/a" and proceed.
