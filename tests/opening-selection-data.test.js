const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Caro = require("../dashboard/caro-kann-domain.js");
const Trainer = require("../dashboard/trainer-domain.js");

const ROOT = path.join(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

test("real Colle Guided traversal diversifies the low-rating tactical cluster", () => {
  const manifest = Caro.normalizeManifest(readJson("public/data/colle-white/manifest.json"));
  const selectionIndex = Caro.normalizeSelectionIndex(
    readJson("public/data/colle-white/selection-index.json"),
    manifest,
  );
  assert.ok(selectionIndex);
  assert.equal(selectionIndex.count, 1054);

  const mainLines = selectionIndex.entries.filter(entry => entry.curriculumGroup === "Main lines");
  const oldFirstTwenty = Caro.curriculumOrder(mainLines).slice(0, 20);
  assert.ok(
    oldFirstTwenty.filter(entry => entry.themes.includes("mateIn1")).length >= 18,
    "the real fixture must retain the reported old-order failure mode",
  );

  const selected = Trainer.selectSession({
    index: selectionIndex,
    state: null,
    filters: {
      mode: "curriculum",
      variation: "all",
      difficulty: "all",
      provenance: "all",
      lineCoverage: "all",
      theme: "all",
      openingOnly: false,
      curriculumGroup: "Main lines",
    },
    request: { size: 20, trainingLength: "finite", fresh: true },
    now: "2026-08-04T12:00:00Z",
    rng: () => 0.25,
  });
  const byId = new Map(selectionIndex.entries.map(entry => [entry.id, entry]));
  const firstTwenty = selected.ids.map(id => byId.get(id));

  assert.equal(firstTwenty.length, 20);
  assert.equal(new Set(selected.ids).size, 20);
  assert.ok(firstTwenty.filter(entry => entry.themes.includes("mateIn1")).length <= 5);
  assert.ok(new Set(firstTwenty.map(entry => entry.primaryTheme)).size >= 6);
  assert.ok(new Set(firstTwenty.map(entry => entry.tacticalSignature)).size >= 12);
});

test("every canonical Guided deck avoids a first-window motif collapse", () => {
  const catalog = readJson("public/data/opening-puzzle-catalog.json");
  catalog.decks.forEach(deck => {
    const manifest = Caro.normalizeManifest(
      readJson(`public/data/${deck.id}/manifest.json`),
      deck,
    );
    const selectionIndex = Caro.normalizeSelectionIndex(
      readJson(`public/data/${deck.id}/selection-index.json`),
      manifest,
    );
    const selected = Trainer.selectSession({
      index: selectionIndex,
      state: null,
      filters: { mode: "curriculum" },
      request: { size: 20, trainingLength: "finite", fresh: true },
      now: "2026-08-04T12:00:00Z",
      rng: () => 0.25,
    });
    const byId = new Map(selectionIndex.entries.map(entry => [entry.id, entry]));
    const entries = selected.ids.map(id => byId.get(id));
    const countBy = key => entries.reduce((counts, entry) => {
      const value = key(entry);
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map());

    assert.equal(entries.length, 20, deck.id);
    assert.equal(new Set(selected.ids).size, 20, deck.id);
    assert.ok(Math.max(...countBy(entry => entry.primaryTheme).values()) <= 5, deck.id);
    assert.ok(Math.max(...countBy(entry => entry.tacticalSignature).values()) <= 2, deck.id);
  });
});
