import json
import re
from pathlib import Path

from chess_tracker.render import DEFAULT_TEMPLATE_DIR, render_all_pages


ROOT = Path(__file__).resolve().parents[1]
TRAINER_TEMPLATE = DEFAULT_TEMPLATE_DIR / "caro-kann-puzzles.html"
SERVICE_WORKER = ROOT / "dashboard" / "service-worker.js"
WEB_MANIFEST = ROOT / "dashboard" / "manifest.webmanifest"
TRAINER_CONTROLLER = ROOT / "dashboard" / "caro-kann-puzzles.js"


def test_public_trainer_shell_has_product_metadata_without_dashboard_chrome():
    html = TRAINER_TEMPLATE.read_text()

    assert "<title>Chess Opening Puzzle Trainer</title>" in html
    assert 'name="description"' in html
    assert "Train the tactics that actually arise from your openings" in html
    assert 'property="og:title" content="Chess Opening Puzzle Trainer"' in html
    assert 'property="og:image" content="https://mvvstudios.github.io/chess-tracker/og-opening-trainer.png"' in html
    assert 'property="og:image:width" content="1200"' in html
    assert 'property="og:image:height" content="630"' in html
    assert 'rel="canonical" href="https://mvvstudios.github.io/chess-tracker/trainer.html"' in html
    assert 'rel="icon" href="vendor/pieces/cburnett/wN.svg"' in html
    assert 'rel="manifest" href="manifest.webmanifest"' in html

    # The public trainer has one restrained Dashboard link, not the personal
    # dashboard's rating strip, profile links, tables, or full app bundle.
    assert 'id="kpi-strip"' not in html
    assert "strip-profile-links" not in html
    assert "tabulator" not in html.lower()
    assert '<script src="app.js"></script>' not in html
    assert "M_V-V" not in html
    assert "{{USERNAME}}" not in html

    scripts = [
        "vendor/chessground.min.js",
        "chess-ui.js",
        "puzzle-domain.js",
        "caro-kann-domain.js",
        "trainer-domain.js",
        "caro-kann-puzzles.js",
    ]
    positions = [html.index(f'<script src="{script}"></script>') for script in scripts]
    assert positions == sorted(positions)
    assert (ROOT / "dashboard" / "vendor" / "pieces" / "cburnett" / "wN.svg").is_file()
    assert (ROOT / "dashboard" / "og-opening-trainer.png").is_file()


def test_public_and_legacy_routes_render_the_same_compact_trainer(tmp_path):
    payload = {
        "username": "PublicUser",
        "kpis": {"current_rating": 1900},
        "private_dashboard_value": "must-not-reach-public-trainer",
    }
    render_all_pages(DEFAULT_TEMPLATE_DIR, tmp_path, payload)

    public_html = (tmp_path / "trainer.html").read_text()
    legacy_html = (tmp_path / "caro-kann-puzzles.html").read_text()
    assert public_html == legacy_html
    assert '<title>Chess Opening Puzzle Trainer</title>' in public_html
    assert '"username": "PublicUser"' in public_html
    assert "current_rating" not in public_html
    assert "must-not-reach-public-trainer" not in public_html
    assert (tmp_path / "index.html").is_file()
    assert "must-not-reach-public-trainer" in (tmp_path / "index.html").read_text()


def test_web_app_manifest_targets_public_route_and_has_real_icons():
    manifest = json.loads(WEB_MANIFEST.read_text())

    assert manifest["name"] == "Chess Opening Puzzle Trainer"
    assert manifest["start_url"] == "./trainer.html"
    assert manifest["id"] == "./trainer.html"
    assert manifest["scope"] == "./"
    assert manifest["display"] == "standalone"
    assert manifest["description"].startswith("Train the tactics")

    icons = {(icon["src"], icon["sizes"], icon["type"]) for icon in manifest["icons"]}
    assert ("./icon-192.png", "192x192", "image/png") in icons
    assert ("./icon-512.png", "512x512", "image/png") in icons
    for icon in manifest["icons"]:
        path = ROOT / "dashboard" / icon["src"].removeprefix("./")
        assert path.is_file()
        assert path.stat().st_size > 0


def test_service_worker_precaches_only_shell_and_lazily_caches_requested_deck_data():
    source = SERVICE_WORKER.read_text()
    match = re.search(r"const SHELL_ASSETS = (\[.*?\]);", source, re.DOTALL)
    assert match, "service worker must declare an explicit shell asset list"
    shell_assets = json.loads(match.group(1))

    assert "./trainer.html" in shell_assets
    assert "./caro-kann-puzzles.html" in shell_assets
    assert "./manifest.webmanifest" in shell_assets
    assert "./caro-kann-puzzles.js" in shell_assets
    assert all("data/" not in asset for asset in shell_assets)
    assert all("chunk-" not in asset for asset in shell_assets)

    # Catalogs, manifests, and balanced chunks enter the data cache only after
    # an actual trainer request. Full exports and analytical shards are never
    # part of the browser cache contract.
    assert 'path === "data/opening-puzzle-catalog.json"' in source
    assert "manifest\\.json" in source
    assert "chunks\\/chunk-" in source
    assert "event.respondWith(networkFirstData(request))" in source
    assert "cache.put(request, response.clone())" in source
    assert not re.search(r"chunk-\d{4}\.json", source)
    assert "all.jsonl" not in source
    assert "balanced.jsonl" not in source
    assert "by-difficulty" not in source
    assert "by-variation" not in source

    controller = TRAINER_CONTROLLER.read_text()
    assert 'serviceWorker.register("service-worker.js")' in controller
