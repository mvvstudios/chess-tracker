# chess_tracker/render.py
"""Render dashboard HTML by injecting computed JSON into a template."""
import json
from pathlib import Path

INJECT_MARKER = "/* DATA_INJECTION_POINT */"
DEFAULT_TEMPLATE_DIR = Path(__file__).parent / "templates"
DEFAULT_TEMPLATE_PATH = DEFAULT_TEMPLATE_DIR / "index.html"
PAGE_TEMPLATES = [
    "index", "leaks", "losses", "process", "sessions", "opening", "blunders",
    "puzzles", "caro-kann-puzzles",
]
PAGE_ALIASES = {
    "trainer": "caro-kann-puzzles",
}
TRAINER_TEMPLATE = "caro-kann-puzzles"


def _safe_json(payload: dict) -> str:
    """Serialize for inline <script> embedding.

    Escapes </script> sequences which would otherwise break out of the tag.
    """
    raw = json.dumps(payload, indent=2)
    return raw.replace("</", "<\\/")


def render_dashboard(template_path: Path, output_path: Path, payload: dict) -> None:
    template_path = Path(template_path)
    output_path = Path(output_path)
    html = template_path.read_text()
    username = payload.get("username", "")
    html = html.replace("{{USERNAME}}", username)
    # Use window.DATA (not bare `const DATA`) so the dashboard's app.js can
    # read `window.DATA` — top-level `const` in a script tag does NOT attach
    # to the window object.
    embed = f"window.DATA = {_safe_json(payload)};"
    html = html.replace(INJECT_MARKER, embed)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html)


def render_all_pages(template_dir: Path, output_dir: Path, payload: dict) -> None:
    """Render dashboard templates and their public aliases.

    Opening-trainer pages only need the username used to retain the existing
    browser progress namespace. Keeping the rest of the personal dashboard
    payload out of both trainer URLs also keeps the public shell compact.
    """
    template_dir = Path(template_dir)
    output_dir = Path(output_dir)
    outputs = [(name, name) for name in PAGE_TEMPLATES]
    outputs.extend(PAGE_ALIASES.items())
    for output_name, template_name in outputs:
        page_payload = (
            {"username": payload.get("username", "")}
            if template_name == TRAINER_TEMPLATE
            else payload
        )
        render_dashboard(
            template_path=template_dir / f"{template_name}.html",
            output_path=output_dir / f"{output_name}.html",
            payload=page_payload,
        )
