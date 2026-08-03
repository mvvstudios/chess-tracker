const test = require("node:test");
const assert = require("node:assert/strict");

const Caro = require("../dashboard/caro-kann-domain.js");
const PuzzleDomain = require("../dashboard/puzzle-domain.js");

function record(overrides = {}) {
  const puzzleFen = "8/8/8/8/8/2P5/3k4/7K b - - 0 1";
  return {
    id: "caro-1",
    source: "lichess",
    sourceUrl: "https://lichess.org/example#42",
    openingFamily: "Caro-Kann Defense",
    variation: "Caro-Kann Defense: Advance Variation",
    openingTags: ["Caro-Kann_Defense_Advance_Variation"],
    originalFen: "8/8/8/8/8/2P5/4k3/7K w - - 0 1",
    setupMoveUci: "e2d2",
    setupMoveSan: "Kd2",
    puzzleFen,
    sideToMove: "black",
    orientation: "black",
    solutionUci: ["d2c3"],
    solutionSan: ["Kxc3"],
    solutionSteps: [{
      fenBefore: puzzleFen,
      bestMoveUci: "d2c3",
      bestMoveSan: "Kxc3",
      postBestFen: "8/8/8/8/8/2k5/8/7K w - - 0 2",
      legalMovesUci: ["d2c3", "d2e3"],
      legalDests: { d2: ["c3", "e3"] },
      promotionOptions: {},
      opponentReplyUci: null,
      opponentReplySan: null,
      postReplyFen: null,
    }],
    rating: 1450,
    difficulty: "developing",
    provenance: "standard",
    themes: ["fork", "opening"],
    isOpeningPuzzle: true,
    ...overrides,
  };
}

test("manifest normalization reads nested export counts and chunk metadata", () => {
  const manifest = Caro.normalizeManifest({
    schemaVersion: "1.0",
    counts: { balancedExported: 12 },
    variationCounts: {
      "Caro-Kann Defense: Advance Variation": 7,
      "Caro-Kann Defense: Unavailable Full-export Variation": 3,
    },
    balancedCounts: {
      variation: { "Caro-Kann Defense: Advance Variation": 7 },
      theme: { fork: 4 },
    },
    chunks: [{ path: "chunks/chunk-0001.json", count: 12 }],
  });
  assert.equal(manifest.balancedExported, 12);
  assert.deepEqual(manifest.chunks.map(chunk => [chunk.path, chunk.count]), [
    ["chunks/chunk-0001.json", 12],
  ]);
  assert.equal(manifest.variationCounts["Caro-Kann Defense: Advance Variation"], 7);
  assert.equal(manifest.variationCounts["Caro-Kann Defense: Unavailable Full-export Variation"], undefined);
  assert.deepEqual(manifest.themeCounts, { fork: 4 });
});

test("record adaptation enforces exact Caro tags and Black solver invariants", () => {
  const adapted = Caro.adaptRecord(record());
  assert.equal(adapted.puzzle_id, "caro-1");
  assert.equal(adapted.fen_before, adapted.puzzleFen);
  assert.equal(adapted.orientation, "black");
  assert.equal(adapted.user_color, "black");
  assert.equal(PuzzleDomain.solutionSteps(adapted).length, 1);

  assert.equal(Caro.adaptRecord(record({ id: "wrong-opening", openingTags: ["Sicilian_Defense"] })), null);
  assert.equal(Caro.adaptRecord(record({ id: "substring", openingTags: ["Not_Caro-Kann_Defense"] })), null);
  assert.equal(Caro.adaptRecord(record({ id: "white-puzzle", puzzleFen: record().originalFen })), null);
  assert.equal(Caro.adaptRecord(record({ id: "black-original", originalFen: record().puzzleFen })), null);
  assert.equal(Caro.adaptRecord(record({
    id: "mismatched-first-step",
    solutionSteps: [{ ...record().solutionSteps[0], fenBefore: "8/8/8/8/8/8/3k4/7K b - - 0 1" }],
  })), null);
});

test("specific prefixed and generic Caro-Kann tags are both accepted", () => {
  assert.equal(Caro.hasCaroKannTag("Caro-Kann_Defense"), true);
  assert.equal(Caro.hasCaroKannTag("Caro-Kann_Defense_Alien_Gambit"), true);
  assert.equal(Caro.primaryVariationTag([
    "Caro-Kann_Defense",
    "Caro-Kann_Defense_Advance_Variation",
  ]), "Caro-Kann_Defense_Advance_Variation");
  assert.equal(
    Caro.readableVariation("Caro-Kann_Defense_Advance_Variation"),
    "Caro-Kann Defense: Advance Variation",
  );
});

test("filters canonicalize provenance and cover tactical study categories", () => {
  const records = [
    Caro.adaptRecord(record({ id: "master", provenance: "masterVsMaster", themes: ["mateIn2", "sacrifice"] })),
    Caro.adaptRecord(record({ id: "quiet", provenance: "superGM", themes: ["quietMove", "defensiveMove"] })),
  ];
  assert.deepEqual(
    Caro.filterRecords(records, { provenance: "master-vs-master", theme: "mates" }).map(item => item.id),
    ["master"],
  );
  assert.deepEqual(
    Caro.filterRecords(records, { provenance: "super-gm", theme: "quiet" }).map(item => item.id),
    ["quiet"],
  );
  assert.deepEqual(
    Caro.filterRecords(records, { theme: "defensive", openingOnly: true }).map(item => item.id),
    ["quiet"],
  );
});

test("curriculum rotates through available groups while ordering difficulty within each group", () => {
  const items = [
    { id: "advance-hard", variation: "Caro-Kann Defense: Advance Variation", difficulty: "advanced", rating: 2100 },
    { id: "exchange", variation: "Caro-Kann Defense: Exchange Variation", difficulty: "developing", rating: 1300 },
    { id: "advance-easy", variation: "Caro-Kann Defense: Advance Variation", difficulty: "beginner", rating: 1000 },
    { id: "rare", variation: "Caro-Kann Defense: Alien Gambit", difficulty: "beginner", rating: 900 },
  ];
  assert.deepEqual(Caro.curriculumOrder(items).map(item => item.id), [
    "advance-easy", "exchange", "rare", "advance-hard",
  ]);
  assert.equal(Caro.isMainLine(items[0]), true);
  assert.equal(Caro.isMainLine(items[3]), false);
});

test("accepted mating alternatives validate as correct legal answers", () => {
  const primaryFen = record().solutionSteps[0].postBestFen;
  const alternativeFen = "8/8/8/8/8/2Pk4/8/7K w - - 0 2";
  const adapted = Caro.adaptRecord(record({
    acceptedMatingMovesUci: ["d2c3", "d2e3"],
    acceptedMovePostFens: {
      d2c3: primaryFen,
      d2e3: alternativeFen,
    },
  }));
  const normalized = PuzzleDomain.solutionSteps(adapted)[0];
  assert.equal(normalized.accepted_move_post_fens.d2c3, primaryFen);
  assert.equal(normalized.accepted_move_post_fens.d2e3, alternativeFen);
  const alternative = PuzzleDomain.evaluatePuzzleStep(adapted, 0, "d2e3");
  assert.equal(alternative.kind, "correct");
  assert.equal(alternative.solved, true);
  assert.equal(alternative.attemptedPostFen, alternativeFen);
});

test("accepted move post-FEN maps fail closed when keys or primary FEN disagree", () => {
  const base = record();
  const primaryFen = base.solutionSteps[0].postBestFen;
  const accepted = ["d2c3", "d2e3"];
  const malformed = [
    { d2c3: primaryFen },
    { d2c3: primaryFen, d2e3: "alt", d2d1: "unknown" },
    { d2c3: "wrong-primary", d2e3: "alt" },
  ];
  malformed.forEach((acceptedMovePostFens, index) => {
    const adapted = Caro.adaptRecord(record({
      id: `bad-post-fen-map-${index}`,
      acceptedMatingMovesUci: accepted,
      acceptedMovePostFens,
    }));
    assert.deepEqual(PuzzleDomain.solutionSteps(adapted), []);
  });
});

test("a terminal White reply defers solved state until the controller animation phase", () => {
  const terminalReply = Caro.adaptRecord(record({
    solutionUci: ["d2c3", "h1g1"],
    solutionSan: ["Kxc3", "Kg1"],
    solutionSteps: [{
      ...record().solutionSteps[0],
      opponentReplyUci: "h1g1",
      opponentReplySan: "Kg1",
      postReplyFen: "8/8/8/8/8/2k5/8/6K1 b - - 1 2",
    }],
  }));
  const result = PuzzleDomain.evaluatePuzzleStep(terminalReply, 0, "d2c3");
  assert.equal(result.correct, true);
  assert.equal(result.solved, false);
  assert.equal(result.completesAfterReply, true);
  assert.equal(result.nextStepIndex, null);
  assert.equal(result.reply.uci, "h1g1");
});

test("Caro-Kann progress uses a key distinct from personal blunder progress", () => {
  const personal = PuzzleDomain.storageKey("Alice");
  const caro = PuzzleDomain.storageKey("Alice", "caro-kann-black");
  assert.equal(caro, "chess-tracker:puzzle-progress:v1:caro-kann-black:alice");
  assert.notEqual(caro, personal);
});
