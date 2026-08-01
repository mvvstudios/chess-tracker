"""Static contracts for the phone-first puzzle layout."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "chess_tracker/templates/puzzles.html").read_text()
STYLES = (ROOT / "dashboard/styles.css").read_text()
CONTROLLER = (ROOT / "dashboard/puzzles-page.js").read_text()


def test_puzzle_page_keeps_the_primary_phone_flow_in_visual_order():
    assert 'content="width=device-width, initial-scale=1"' in TEMPLATE
    assert "maximum-scale" not in TEMPLATE
    assert "user-scalable=no" not in TEMPLATE

    task = TEMPLATE.index('class="puzzle-task"')
    board = TEMPLATE.index('id="puzzle-board"')
    feedback = TEMPLATE.index('id="puzzle-feedback"')
    controls = TEMPLATE.index('class="puzzle-controls puzzle-queue-controls"')
    keyboard = TEMPLATE.index('id="puzzle-uci-disclosure"')
    assert task < board < feedback < controls < keyboard

    assert '<details id="puzzle-uci-disclosure"' in TEMPLATE
    assert 'role="group" aria-label="Puzzle controls"' in TEMPLATE
    assert 'id="puzzle-board-help" class="visually-hidden"' in TEMPLATE


def test_puzzle_phone_layout_has_touch_and_overflow_guards():
    assert "touch-action: pan-y" in STYLES
    assert ".puzzle-solved-item-main" in STYLES
    assert "overflow-wrap: anywhere" in STYLES
    assert "min-height: 44px" in STYLES
    assert "min-height: 48px" in STYLES
    assert '"task"\n      "board"\n      "feedback"\n      "side"\n      "keyboard"' in STYLES
    assert ".puzzles-body .puzzle-solved-review .puzzle-review-board" in STYLES
    assert "width: 100%" in STYLES


def test_puzzle_controller_uses_phone_safe_board_and_navigation_settings():
    assert 'window.matchMedia("(pointer: coarse)").matches' in CONTROLLER
    assert "coordinatesOnSquares: true" in CONTROLLER
    assert "draggable: { enabled: !completed && !coarsePointer }" in CONTROLLER
    assert "function focusPuzzleStart()" in CONTROLLER
    assert CONTROLLER.count("focusPuzzleStart();") >= 2
    assert 'elements.solvedReviewClose.addEventListener("click"' in CONTROLLER


def test_solved_review_has_a_mobile_return_path_before_the_archive():
    review = TEMPLATE.index('id="puzzle-solved-review"')
    archive = TEMPLATE.index('id="puzzles-solved-list"')
    assert review < archive
    assert 'id="puzzle-solved-review-close"' in TEMPLATE
    assert "Back to solved puzzles" in TEMPLATE
