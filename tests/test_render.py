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
        "blunders", "puzzles",
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
