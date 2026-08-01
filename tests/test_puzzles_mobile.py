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
    assert "draggable: { enabled: !completed && !coarsePointer && !locked }" in CONTROLLER
    assert "function focusPuzzleStart()" in CONTROLLER
    assert CONTROLLER.count("focusPuzzleStart();") >= 2
    assert 'elements.solvedReviewClose.addEventListener("click"' in CONTROLLER


def test_queue_board_keeps_pointer_listeners_across_white_to_black_transition():
    """Chessground drops handlers if orientation changes from a view-only board."""

    interactive = CONTROLLER.index("function paintInteractiveBoard")
    solved_review = CONTROLLER.index("function renderSolvedReview")
    queue_controller = CONTROLLER[interactive:solved_review]
    assert "viewOnly: false" in queue_controller
    assert "viewOnly: completed" not in queue_controller
    assert "color: locked ? undefined : color" in queue_controller
    assert "selectable: { enabled: !locked }" in queue_controller

    review_controller = CONTROLLER[solved_review:]
    assert "viewOnly: true" in review_controller


def test_controller_requires_two_user_decisions_and_auto_plays_the_reply():
    assert "Domain.evaluatePuzzleStep(candidate, state.stepIndex, move)" in CONTROLLER
    assert "function playOpponentReply(candidate, result)" in CONTROLLER
    assert 'state.linePhase = "playing_reply"' in CONTROLLER
    assert "state.stepIndex = result.nextStepIndex" in CONTROLLER
    assert "if (result.solved)" in CONTROLLER
    assert "recordAttempt(candidate, true)" in CONTROLLER
    assert 'state.linePhase = "choosing_promotion"' in CONTROLLER
    assert 'const wasChoosing = state.linePhase === "choosing_promotion"' in CONTROLLER
    assert 'elements.uciInput.value = "";' in CONTROLLER


def test_unsolved_queue_is_mixed_once_per_daily_session():
    assert "state.queueSeed = dailyQueueSeed(DATA.username" in CONTROLLER
    assert "Domain.mixCandidates(state.unsolved, state.queueSeed)" in CONTROLLER
    assert "function dailyQueueSeed(username)" in CONTROLLER


def test_solved_review_has_a_mobile_return_path_before_the_archive():
    review = TEMPLATE.index('id="puzzle-solved-review"')
    archive = TEMPLATE.index('id="puzzles-solved-list"')
    assert review < archive
    assert 'id="puzzle-solved-review-close"' in TEMPLATE
    assert "Back to solved puzzles" in TEMPLATE
