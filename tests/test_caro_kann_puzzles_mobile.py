"""Static contracts for the phone-first Caro-Kann trainer."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "chess_tracker/templates/caro-kann-puzzles.html").read_text()
STYLES = (ROOT / "dashboard/styles.css").read_text()
CONTROLLER = (ROOT / "dashboard/caro-kann-puzzles.js").read_text()


def css_declarations(selector, *, start=0):
    marker = f"{selector} {{"
    rule_start = STYLES.index(marker, start) + len(marker)
    return STYLES[rule_start : STYLES.index("}", rule_start)]


def test_caro_page_keeps_filters_and_primary_phone_flow_in_visual_order():
    assert "<title>Chess Opening Puzzle Trainer — {{USERNAME}}</title>" in TEMPLATE
    assert '<h1 id="puzzles-title">Chess Opening Puzzle Trainer</h1>' in TEMPLATE
    assert "width=device-width" in TEMPLATE
    assert "maximum-scale=1" in TEMPLATE
    assert "user-scalable=no" in TEMPLATE
    assert "viewport-fit=cover" in TEMPLATE
    assert "interactive-widget=resizes-content" in TEMPLATE

    filters = TEMPLATE.index('id="caro-puzzle-filters"')
    task = TEMPLATE.index('class="puzzle-task"')
    board = TEMPLATE.index('id="puzzle-board"')
    feedback = TEMPLATE.index('id="puzzle-feedback"')
    controls = TEMPLATE.index('class="puzzle-controls puzzle-queue-controls"')
    keyboard = TEMPLATE.index('id="puzzle-uci-disclosure"')
    assert filters < task < board < feedback < controls < keyboard
    assert 'id="puzzle-board-help" class="visually-hidden"' in TEMPLATE
    assert 'role="group" aria-label="Puzzle controls"' in TEMPLATE
    assert 'id="opening-puzzle-deck"' in TEMPLATE


def test_caro_phone_layout_is_square_full_width_and_overflow_free():
    page = css_declarations(".puzzles-body")
    assert "overflow-x: clip" in page
    assert "overscroll-behavior-x: none" in page
    assert "touch-action: pan-y" in css_declarations(".puzzles-body #puzzles-page")

    mobile_start = STYLES.index(
        "@media (max-width: 760px) {", STYLES.index("My Blunder Puzzles")
    )
    mobile_end = STYLES.index("@media (max-width: 380px)", mobile_start)
    board = css_declarations(".puzzles-body .puzzle-queue-board", start=mobile_start)
    filters = css_declarations(".caro-filter-grid", start=mobile_start)
    assert "width: 100%" in board
    assert "max-width: 100%" in board
    assert "height: auto" in board
    assert "aspect-ratio: 1" in board
    assert "100vw" not in board
    assert "minmax(0, 1fr)" in filters
    assert ".caro-filter-grid select:focus-visible" in STYLES
    assert "outline: 2px solid var(--accent)" in STYLES


def test_opening_controller_uses_selected_orientation_and_preserves_phone_interaction():
    interactive = CONTROLLER.index("function paintInteractiveBoard")
    solved_review = CONTROLLER.index("function renderSolvedReview")
    queue_controller = CONTROLLER[interactive:solved_review]
    assert "orientation: boardOrientation()" in queue_controller
    assert "turnColor: solverColor()" in queue_controller
    assert "viewOnly: false" in queue_controller
    assert "color: locked ? undefined : solverColor()" in queue_controller
    assert "draggable: { enabled: !completed && !coarsePointer && !locked }" in queue_controller
    assert "selectable: { enabled: !locked }" in queue_controller
    assert "focus({ preventScroll: true })" in CONTROLLER
    assert "scrollIntoView" not in CONTROLLER

    review_controller = CONTROLLER[solved_review:]
    assert "orientation: boardOrientation()" in review_controller
    assert "viewOnly: true" in review_controller
    assert 'const CATALOG_URL = "data/opening-puzzle-catalog.json"' in CONTROLLER
    assert 'const PAGE_TITLE = "Chess Opening Puzzle Trainer"' in CONTROLLER
    assert "state.loadGeneration += 1" in CONTROLLER


def test_caro_solved_review_precedes_the_responsive_archive():
    review = TEMPLATE.index('id="puzzle-solved-review"')
    archive = TEMPLATE.index('id="puzzles-solved-list"')
    assert review < archive
    assert 'id="puzzle-solved-review-close"' in TEMPLATE
    assert "Back to solved puzzles" in TEMPLATE
    assert ".puzzles-body .puzzle-solved-review .puzzle-review-board" in STYLES
