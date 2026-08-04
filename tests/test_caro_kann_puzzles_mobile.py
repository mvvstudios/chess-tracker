"""Static responsive and accessibility contracts for the public opening trainer."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "chess_tracker/templates/caro-kann-puzzles.html").read_text()
STYLES = (ROOT / "dashboard/styles.css").read_text()
CONTROLLER = (ROOT / "dashboard/caro-kann-puzzles.js").read_text()
TRAINER_STYLES = STYLES.index(".trainer-header {")
TRAINER_MOBILE = STYLES.index("@media (max-width: 760px) {", TRAINER_STYLES)


def css_declarations(selector, *, start=0):
    marker = f"{selector} {{"
    rule_start = STYLES.index(marker, start) + len(marker)
    return STYLES[rule_start : STYLES.index("}", rule_start)]


def test_public_trainer_has_a_compact_dedicated_shell_without_personal_chrome():
    assert "<title>Chess Opening Puzzle Trainer</title>" in TEMPLATE
    assert "{{USERNAME}}" not in TEMPLATE
    assert '<h1 id="puzzles-title">Chess Opening Puzzle Trainer</h1>' in TEMPLATE
    viewport_start = TEMPLATE.index('<meta name="viewport"')
    viewport = TEMPLATE[viewport_start : TEMPLATE.index(">", viewport_start)]
    assert "width=device-width" in viewport
    assert "viewport-fit=cover" in viewport
    assert "interactive-widget=resizes-content" in viewport
    assert "maximum-scale" not in viewport
    assert "user-scalable" not in viewport
    assert 'id="kpi-strip"' not in TEMPLATE

    header = TEMPLATE.index('class="trainer-header"')
    main = TEMPLATE.index('class="trainer-main"')
    assert header < main
    assert 'aria-label="Chess Opening Puzzle Trainer"' in TEMPLATE
    assert 'id="trainer-header-deck"' in TEMPLATE
    assert 'id="trainer-header-progress"' in TEMPLATE
    assert 'aria-label="Back to the main chess dashboard"' in TEMPLATE

    desktop_header = css_declarations(".trainer-header", start=TRAINER_STYLES)
    phone_header = css_declarations(".trainer-header", start=TRAINER_MOBILE)
    assert "min-height: 56px" in desktop_header
    assert "position: sticky" in desktop_header
    assert "54px + env(safe-area-inset-top)" in phone_header


def test_primary_phone_flow_is_task_board_feedback_actions_then_customize():
    task = TEMPLATE.index('class="puzzle-task"')
    board = TEMPLATE.index('id="puzzle-board"')
    feedback = TEMPLATE.index('id="puzzle-feedback"')
    controls = TEMPLATE.index('class="puzzle-controls puzzle-queue-controls"')
    keyboard = TEMPLATE.index('id="puzzle-uci-disclosure"')
    customize = TEMPLATE.index('id="caro-puzzle-filters" class="customize-panel"')
    assert task < board < feedback < controls < keyboard < customize

    assert 'id="puzzle-board-help" class="visually-hidden"' in TEMPLATE
    assert 'role="group" aria-label="Puzzle controls"' in TEMPLATE
    assert 'id="opening-puzzle-deck"' in TEMPLATE
    assert 'id="caro-filter-mode"' in TEMPLATE
    assert '<label for="caro-filter-variation">Variation</label>' in TEMPLATE
    assert 'id="caro-filter-variation" name="variation" form="caro-puzzle-filters"' in TEMPLATE
    assert '<option value="all" selected>All variations</option>' in TEMPLATE
    assert 'id="variation-picker" class="variation-picker"' in TEMPLATE
    assert 'aria-haspopup="dialog" aria-controls="customize-panel"' in TEMPLATE
    assert 'id="training-length"' in TEMPLATE


def test_training_length_defaults_to_endless_and_keeps_finite_sessions_optional():
    length_start = TEMPLATE.index('id="training-length"')
    length_end = TEMPLATE.index("</select>", length_start)
    length_control = TEMPLATE[length_start:length_end]

    assert 'name="trainingLength"' in length_control
    assert 'aria-describedby="training-length-help"' in length_control
    assert '<option value="endless" selected>Endless</option>' in length_control
    assert '<option value="5">5 puzzles</option>' in length_control
    assert '<option value="10">10 puzzles</option>' in length_control
    assert '<option value="20">20 puzzles</option>' in length_control
    assert 'name="sessionSize"' not in TEMPLATE
    assert 'id="training-length-help" class="visually-hidden"' in TEMPLATE
    assert 'id="trainer-header-progress">Endless</strong>' in TEMPLATE
    assert 'id="puzzle-queue-position">Puzzle 1</span>' in TEMPLATE
    assert 'id="puzzle-progress-track"' in TEMPLATE
    assert 'aria-hidden="true" hidden' in TEMPLATE
    assert 'id="session-restart" class="trainer-secondary-action" type="button" hidden>Restart session</button>' in TEMPLATE
    assert 'id="session-start-fresh" class="trainer-secondary-action" type="button" hidden>Start fresh</button>' in TEMPLATE

    mobile_study_bar = css_declarations(".trainer-study-bar", start=TRAINER_MOBILE)
    assert "repeat(3, minmax(0, 1fr))" in mobile_study_bar
    assert ".trainer-study-bar .opening-deck-filter { grid-column: 1 / -1; }" in STYLES[TRAINER_MOBILE:]
    assert ".training-length-control { grid-column: auto; }" in STYLES[TRAINER_MOBILE:]
    assert ".trainer-study-bar > .trainer-secondary-action { grid-column: 1 / -1; }" in STYLES[TRAINER_MOBILE:]
    assert ".session-size-options" not in STYLES[TRAINER_STYLES:]


def test_desktop_board_is_primary_and_phone_board_is_square_full_width_overflow_free():
    page = css_declarations(".puzzles-body")
    assert "overflow-x: clip" in page
    assert "overscroll-behavior-x: none" in page
    assert "touch-action: pan-y" in css_declarations(".puzzles-body #puzzles-page")

    desktop_workspace = css_declarations(
        ".opening-trainer-body .puzzle-workspace", start=TRAINER_STYLES
    )
    desktop_board = css_declarations(
        ".opening-trainer-body .puzzle-queue-board", start=TRAINER_STYLES
    )
    assert "minmax(460px, 520px)" in desktop_workspace
    assert "width: min(520px, 100%)" in desktop_board
    assert "aspect-ratio: 1" in desktop_board

    phone_workspace = css_declarations(
        ".opening-trainer-body .puzzle-workspace", start=TRAINER_MOBILE
    )
    phone_board = css_declarations(
        ".opening-trainer-body .puzzle-queue-board", start=TRAINER_MOBILE
    )
    assert '"task"' in phone_workspace
    assert '"board"' in phone_workspace
    assert '"feedback"' in phone_workspace
    assert '"side"' in phone_workspace
    assert phone_workspace.index('"task"') < phone_workspace.index('"board"')
    assert phone_workspace.index('"board"') < phone_workspace.index('"feedback"')
    assert phone_workspace.index('"feedback"') < phone_workspace.index('"side"')
    assert "width: 100%" in phone_board
    assert "max-width: 100%" in phone_board
    assert "height: auto" in phone_board
    assert "aspect-ratio: 1" in phone_board
    assert "100vw" not in phone_board
    assert ".opening-trainer-body [hidden] { display: none !important; }" in STYLES

    mobile_order = STYLES.index(
        ".opening-trainer-body #puzzles-page {", TRAINER_MOBILE
    )
    mobile_order_rules = STYLES[
        mobile_order : STYLES.index("@media (max-width: 410px)", mobile_order)
    ]
    assert "#puzzles-unsolved-panel { order: 3; }" in mobile_order_rules
    assert ".puzzle-tabs { order: 4; }" in mobile_order_rules
    assert ".trainer-session-summary { order: 6; }" in mobile_order_rules

    desktop_nav = css_declarations(".trainer-session-nav", start=TRAINER_STYLES)
    assert "grid-template-columns: auto minmax(0, 1fr)" in desktop_nav
    assert ".trainer-session-nav { display: contents; }" in STYLES[TRAINER_MOBILE:]


def test_customize_is_an_accessible_desktop_drawer_and_phone_bottom_sheet():
    assert 'id="customize-open"' in TEMPLATE
    assert 'aria-haspopup="dialog" aria-controls="customize-panel"' in TEMPLATE
    assert 'id="caro-puzzle-filters" class="customize-panel"' in TEMPLATE
    assert 'id="customize-panel" class="customize-sheet" role="dialog"' in TEMPLATE
    assert 'aria-modal="true" aria-labelledby="customize-title"' in TEMPLATE
    assert 'id="customize-close"' in TEMPLATE
    assert 'aria-label="Close Customize"' in TEMPLATE

    drawer = css_declarations(".customize-sheet", start=TRAINER_STYLES)
    assert "position: absolute" in drawer
    assert "top: 0" in drawer
    assert "right: 0" in drawer
    assert "width: min(500px, 100%)" in drawer
    assert "height: 100%" in drawer

    bottom_sheet = css_declarations(".customize-sheet", start=TRAINER_MOBILE)
    assert "top: auto" in bottom_sheet
    assert "bottom: 0" in bottom_sheet
    assert "width: 100%" in bottom_sheet
    assert "height: auto" in bottom_sheet
    assert "max-height: 88svh" in bottom_sheet
    assert "border-radius: 14px 14px 0 0" in bottom_sheet

    assert "state.lastFocus = document.activeElement" in CONTROLLER
    assert "const target = focusSearch ? elements.customizeSearch : elements.customizeClose" in CONTROLLER
    assert "if (target && target.focus) target.focus()" in CONTROLLER
    assert "state.lastFocus.focus" in CONTROLLER
    assert 'event.key !== "Escape"' in CONTROLLER


def test_trainer_focus_live_regions_touch_targets_and_reduced_motion_are_preserved():
    assert 'role="img" aria-label="Interactive opening puzzle board"' in TEMPLATE
    assert 'role="application"' not in TEMPLATE
    assert 'aria-describedby="puzzle-side-to-move puzzle-board-help"' in TEMPLATE
    assert 'role="status"' in TEMPLATE
    assert 'aria-live="polite" aria-atomic="true"' in TEMPLATE
    assert 'summary>Enter a move with the keyboard</summary>' in TEMPLATE

    focus = css_declarations(
        ".opening-trainer-body :is(button, a, select, input, summary, [tabindex]):focus-visible",
        start=TRAINER_STYLES,
    )
    assert "outline: 2px solid var(--accent)" in focus
    assert "outline-offset: 2px" in focus
    import_focus = css_declarations(".file-button:focus-within", start=TRAINER_STYLES)
    assert "outline: 2px solid var(--accent)" in import_focus
    phone_controls = css_declarations(
        ".opening-trainer-body .puzzle-queue-controls button", start=TRAINER_MOBILE
    )
    assert "min-height: 46px" in phone_controls

    reduced = STYLES.index("@media (prefers-reduced-motion: reduce)", TRAINER_MOBILE)
    progress = css_declarations(".puzzle-progress-track span", start=reduced)
    assert "transition: none" in progress


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
