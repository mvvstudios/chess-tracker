# tests/test_render.py
from pathlib import Path
from chess_tracker.render import render_dashboard


def test_render_dashboard_injects_data_and_substitutes_username(tmp_path):
    template = tmp_path / "index.html"
    template.write_text(
        "<title>Chess Tracker — {{USERNAME}}</title>"
        "<script>/* DATA_INJECTION_POINT */</script>"
    )
    out = tmp_path / "out.html"
    payload = {"username": "alice", "kpis": {"current_rating": 444}}
    render_dashboard(template_path=template, output_path=out, payload=payload)
    html = out.read_text()
    assert "Chess Tracker — alice" in html
    assert "window.DATA =" in html
    assert "/* DATA_INJECTION_POINT */" not in html
    assert "alice" in html


def test_render_escapes_closing_script_in_payload(tmp_path):
    template = tmp_path / "index.html"
    template.write_text("<script>/* DATA_INJECTION_POINT */</script>")
    out = tmp_path / "out.html"
    # Payload contains "</script>" which would break out of the tag if unescaped
    payload = {"username": "x", "evil": "</script><b>oh no</b>"}
    render_dashboard(template_path=template, output_path=out, payload=payload)
    html = out.read_text()
    assert "</script><b>oh no</b>" not in html  # the literal substring is escaped


def test_render_all_pages_writes_one_file_per_template(tmp_path):
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    output_dir = tmp_path / "out"
    page_names = [
        "index", "leaks", "losses", "process", "sessions", "opening",
        "blunders", "puzzles", "caro-kann-puzzles",
    ]
    for name in page_names:
        (template_dir / f"{name}.html").write_text(
            f"<title>{{{{USERNAME}}}}</title>"
            f"<section id='{name}-section'></section>"
            f"<script>/* DATA_INJECTION_POINT */</script>"
        )
    from chess_tracker.render import render_all_pages
    payload = {"username": "alice", "kpis": {"current_rating": 444}}
    render_all_pages(template_dir, output_dir, payload)
    for name in page_names:
        out = output_dir / f"{name}.html"
        assert out.exists(), f"missing {name}.html"
        html = out.read_text()
        assert "alice" in html
        assert "window.DATA" in html
        assert f"id='{name}-section'" in html

    public_trainer = output_dir / "trainer.html"
    assert public_trainer.exists()
    public_html = public_trainer.read_text()
    assert "alice" in public_html
    assert "window.DATA" in public_html
    assert "id='caro-kann-puzzles-section'" in public_html


def test_opening_trainer_outputs_only_embed_compact_progress_identity(tmp_path):
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    output_dir = tmp_path / "out"
    for name in [
        "index", "leaks", "losses", "process", "sessions", "opening",
        "blunders", "puzzles", "caro-kann-puzzles",
    ]:
        (template_dir / f"{name}.html").write_text(
            "<title>{{USERNAME}}</title>"
            "<script>/* DATA_INJECTION_POINT */</script>"
        )

    from chess_tracker.render import render_all_pages
    payload = {
        "username": "alice",
        "kpis": {"current_rating": 444},
        "private_dashboard_value": "must-not-reach-trainer",
    }
    render_all_pages(template_dir, output_dir, payload)

    assert "must-not-reach-trainer" in (output_dir / "index.html").read_text()
    for name in ("caro-kann-puzzles", "trainer"):
        html = (output_dir / f"{name}.html").read_text()
        assert '"username": "alice"' in html
        assert "current_rating" not in html
        assert "must-not-reach-trainer" not in html


def test_index_places_quality_review_tables_after_opening_tables():
    html = Path("chess_tracker/templates/index.html").read_text()
    white_pos = html.index('id="white-block"')
    black_pos = html.index('id="black-block"')
    blunder_pos = html.index('id="blunder-analysis-block"')
    scramble_pos = html.index('id="scramble-review-block"')
    mistake_pos = html.index('id="mistake-analysis-block"')
    scramble_mistake_pos = html.index('id="scramble-mistake-review-block"')

    assert (
        white_pos
        < black_pos
        < blunder_pos
        < scramble_pos
        < mistake_pos
        < scramble_mistake_pos
    )


def test_dashboard_templates_include_independent_mistake_review_surfaces():
    required_ids = [
        "mistake-analysis-block",
        "mistake-coverage-cards",
        "mistake-analysis-empty",
        "mistake-review-table",
        "mistake-board",
        "mistake-board-meta",
        "scramble-mistake-review-table",
        "scramble-mistake-board",
        "scramble-mistake-board-meta",
    ]
    for template_name in ("index.html", "blunders.html"):
        html = Path("chess_tracker/templates", template_name).read_text()
        for element_id in required_ids:
            assert html.count(f'id="{element_id}"') == 1
        assert "Mistake table" in html
        assert "Scramble mistakes" in html


def test_dashboard_app_renders_mistakes_with_separate_tables_and_boards():
    app = Path("dashboard/app.js").read_text()

    assert "renderMistakeAnalysis(D.mistake_analysis);" in app
    assert 'tableId: "mistake-review-table"' in app
    assert 'boardId: "mistake-board"' in app
    assert 'scrambleTableId: "scramble-mistake-review-table"' in app
    assert 'scrambleBoardId: "scramble-mistake-board"' in app
    assert 'itemsKey: "mistakes"' in app
    assert 'singular: "mistake"' in app


def test_shared_navigation_links_both_puzzle_trainers_with_active_states():
    app = Path("dashboard/app.js").read_text()

    assert 'pageName === "puzzles.html"' in app
    assert 'pageName === "trainer.html"' in app
    assert 'pageName === "caro-kann-puzzles.html"' in app
    assert 'href="puzzles.html"' in app
    assert 'href="trainer.html"' in app
    assert "trainerActive ? 'aria-current=\"page\"'" in app
