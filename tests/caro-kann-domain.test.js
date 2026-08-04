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
  const datasetVersion = "a".repeat(64);
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
    selectionIndex: "selection-index.json",
    datasetVersion,
  });
  assert.equal(manifest.balancedExported, 12);
  assert.deepEqual(manifest.chunks.map(chunk => [chunk.path, chunk.count]), [
    ["chunks/chunk-0001.json", 12],
  ]);
  assert.equal(manifest.variationCounts["Caro-Kann Defense: Advance Variation"], 7);
  assert.equal(manifest.variationCounts["Caro-Kann Defense: Unavailable Full-export Variation"], undefined);
  assert.deepEqual(manifest.themeCounts, { fork: 4 });
  assert.deepEqual(manifest.selectionIndex, {
    path: "selection-index.json",
    count: 12,
    datasetVersion,
    schemaVersion: 1,
  });
  assert.equal(manifest.datasetVersion, datasetVersion);
});

test("selection index normalization validates identity and locations and adds curriculum fields", () => {
  const datasetVersion = "b".repeat(64);
  const manifest = Caro.normalizeManifest({
    schemaVersion: 2,
    deckId: "colle-white",
    openingFamily: "Colle System",
    solverColor: "white",
    orientation: "white",
    openingTagRoots: ["Queens_Pawn_Game_Colle_System"],
    counts: { balancedExported: 2 },
    chunks: [
      { path: "chunks/chunk-0001.json", count: 1 },
      { path: "chunks/chunk-0002.json", count: 1 },
    ],
    selectionIndex: "selection-index.json",
    datasetVersion,
  });
  const rawIndex = {
    schemaVersion: 1,
    deckId: "colle-white",
    datasetVersion,
    count: 2,
    entries: [{
      id: "main-1",
      chunkIndex: 0,
      chunkOffset: 0,
      variation: "Colle System",
      difficulty: "beginner",
      rating: 900,
      provenance: "standard",
      themes: ["fork", "opening"],
      primaryTheme: "fork",
      isOpeningPuzzle: true,
      solutionLength: 3,
      solverDecisionCount: 2,
      tacticalSignature: "fork|3|N|f3",
    }, {
      id: "side-1",
      chunkIndex: 1,
      chunkOffset: 0,
      variation: "Colle System: Rhamphorhynchus Variation",
      difficulty: "developing",
      rating: 1300,
      provenance: "master",
      themes: ["mate", "mateIn1"],
      primaryTheme: "mateIn1",
      isOpeningPuzzle: false,
      solutionLength: 1,
      solverDecisionCount: 1,
      tacticalSignature: "mateIn1|1|Q|h7",
    }],
  };

  const normalized = Caro.normalizeSelectionIndex(rawIndex, manifest);
  assert.equal(normalized.count, 2);
  assert.deepEqual(normalized.entries.map(entry => ({
    id: entry.id,
    curriculumGroup: entry.curriculumGroup,
    mainLine: entry.mainLine,
  })), [{
    id: "main-1",
    curriculumGroup: "Main lines",
    mainLine: true,
  }, {
    id: "side-1",
    curriculumGroup: "Rhamphorhynchus Variation",
    mainLine: false,
  }]);
  assert.notEqual(normalized.entries[0].themes, rawIndex.entries[0].themes);

  const invalidMutations = [
    index => { index.deckId = "caro-kann-black"; },
    index => { index.datasetVersion = "c".repeat(64); },
    index => { index.count = 1; },
    index => { index.entries[1].id = index.entries[0].id; },
    index => { index.entries[1].chunkIndex = 2; },
    index => { index.entries[1].chunkOffset = 1; },
    index => {
      index.entries[1].chunkIndex = 0;
      index.entries[1].chunkOffset = 0;
    },
  ];
  invalidMutations.forEach(mutate => {
    const invalid = JSON.parse(JSON.stringify(rawIndex));
    mutate(invalid);
    assert.equal(Caro.normalizeSelectionIndex(invalid, manifest), null);
  });
});

test("legacy manifests omit selection metadata and unsafe index paths fail closed", () => {
  const legacy = Caro.normalizeManifest({
    chunks: [{ path: "chunks/chunk-0001.json", count: 1 }],
    counts: { balancedExported: 1 },
  });
  assert.equal(legacy.selectionIndex, null);
  assert.equal(legacy.datasetVersion, "");
  assert.equal(Caro.normalizeSelectionIndex({}, legacy), null);

  const unsafe = Caro.normalizeManifest({
    chunks: [{ path: "chunks/chunk-0001.json", count: 1 }],
    counts: { balancedExported: 1 },
    selectionIndex: "../selection-index.json",
    datasetVersion: "d".repeat(64),
  });
  assert.equal(unsafe.selectionIndex, null);
  assert.equal(unsafe.datasetVersion, "");

  const invalidVersion = Caro.normalizeManifest({
    chunks: [{ path: "chunks/chunk-0001.json", count: 1 }],
    counts: { balancedExported: 1 },
    selectionIndex: "selection-index.json",
    datasetVersion: "not-a-sha256",
  });
  assert.equal(invalidVersion.selectionIndex, null);
  assert.equal(invalidVersion.datasetVersion, "");
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

test("catalog accepts compact entries without roots and rejects unsafe manifest paths", () => {
  const normalized = Caro.normalizeCatalog({
    schemaVersion: 1,
    defaultDeckId: "caro-kann-black",
    decks: [{
      id: "caro-kann-black",
      label: "Caro-Kann Defense — Black",
      openingFamily: "Caro-Kann Defense",
      solverColor: "black",
      orientation: "black",
      manifestPath: "caro-kann-black/manifest.json",
    }, {
      id: "unsafe-white",
      label: "Unsafe — White",
      openingFamily: "Unsafe",
      solverColor: "white",
      orientation: "white",
      manifestPath: "../outside.json",
    }],
  });
  assert.deepEqual(normalized.decks.map(deck => deck.id), ["caro-kann-black"]);
  assert.deepEqual(normalized.decks[0].openingTagRoots, []);
  assert.equal(Caro.safeRelativePath("caro-kann-black\\manifest.json"), "");
  assert.equal(Caro.safeRelativePath("caro-kann-black//manifest.json"), "");
  assert.equal(Caro.safeRelativePath(" caro-kann-black/manifest.json"), "");
});

test("generic root matching requires an exact root or root plus underscore", () => {
  assert.equal(Caro.matchesOpeningRoot("Pirc_Defense", "Pirc_Defense"), true);
  assert.equal(Caro.matchesOpeningRoot("Pirc_Defense_Austrian_Attack", "Pirc_Defense"), true);
  assert.equal(Caro.matchesOpeningRoot("Pirc_Defensive_System", "Pirc_Defense"), false);
  assert.equal(Caro.matchesOpeningRoot("Nimzowitsch_Defense_Pirc_Defense", "Pirc_Defense"), false);
  assert.equal(Caro.matchesOpeningRoot("Kings_Gambit_Accepted_Modern_Defense", "Modern_Defense"), false);
});

test("White deck record adaptation enforces perspective, orientation, roots, and deck ID", () => {
  const config = Caro.normalizeManifest({
    schemaVersion: 2,
    deckId: "colle-white",
    displayName: "Colle System — White",
    openingFamily: "Colle System",
    solverColor: "white",
    orientation: "white",
    openingTagRoots: [
      "Queens_Pawn_Game_Colle_System",
      "Indian_Defense_Colle_System",
      "Colle_System",
    ],
  }, {
    id: "colle-white",
    label: "Colle System — White",
    openingFamily: "Colle System",
    solverColor: "white",
    orientation: "white",
    manifestPath: "colle-white/manifest.json",
  });
  const puzzleFen = "8/8/8/8/8/2k5/3K4/8 w - - 1 2";
  const whiteRecord = {
    ...record(),
    id: "colle-1",
    deckId: "colle-white",
    openingFamily: "Colle System",
    openingTags: ["Indian_Defense_Colle_System_Kings_Indian_Variation"],
    originalFen: "8/8/8/8/8/8/2kK4/8 b - - 0 1",
    puzzleFen,
    solverColor: "white",
    sideToMove: "white",
    orientation: "white",
    solutionSteps: [{
      fenBefore: puzzleFen,
      bestMoveUci: "d2e3",
      bestMoveSan: "Ke3",
      postBestFen: "8/8/8/8/8/2k1K3/8/8 b - - 2 2",
      legalMovesUci: ["d2e3"],
      legalDests: { d2: ["e3"] },
      promotionOptions: {},
      opponentReplyUci: null,
      opponentReplySan: null,
      postReplyFen: null,
    }],
  };
  const adapted = Caro.adaptRecord(whiteRecord, config);
  assert.equal(adapted.user_color, "white");
  assert.equal(adapted.orientation, "white");
  assert.equal(adapted.variation, "Colle System: Kings Indian Variation");
  assert.equal(adapted.matchedTagRoot, "Indian_Defense_Colle_System");
  assert.equal(Caro.adaptRecord({ ...whiteRecord, deckId: "caro-kann-black" }, config), null);
  assert.equal(Caro.adaptRecord({ ...whiteRecord, deckId: undefined }, config), null);
  assert.equal(Caro.adaptRecord({ ...whiteRecord, originalFen: puzzleFen }, config), null);
  assert.equal(Caro.adaptRecord({ ...whiteRecord, orientation: "black" }, config), null);
  assert.equal(Caro.adaptRecord({ ...whiteRecord, openingTags: ["Queens_Pawn_Game_Zukertort_Variation"] }, config), null);
});

test("generic readable variations flatten configured opening roots", () => {
  const colle = {
    id: "colle-white",
    openingFamily: "Colle System",
    openingTagRoots: ["Queens_Pawn_Game_Colle_System"],
  };
  assert.equal(
    Caro.readableVariation("Queens_Pawn_Game_Colle_System_Traditional_Colle", colle),
    "Colle System: Traditional Colle",
  );
  assert.equal(Caro.readableVariation("Queens_Pawn_Game_Modern_Defense", {
    id: "modern-black",
    openingFamily: "Modern Defense",
    openingTagRoots: ["Modern_Defense", "Queens_Pawn_Game_Modern_Defense"],
  }), "Modern Defense: Queen’s Pawn Move Order");
});

test("generic curriculum groups preserve punctuation from readable variation labels", () => {
  assert.equal(Caro.curriculumGroup({
    openingFamily: "Englund Gambit",
    variation: "Englund Gambit: Hartlaub-Charlick Gambit",
  }), "Hartlaub-Charlick Gambit");
  assert.equal(Caro.curriculumGroup({
    openingFamily: "Modern Defense",
    variation: "Modern Defense: Queen’s Pawn Move Order",
  }), "Queen’s Pawn Move Order");
});
