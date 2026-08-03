const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "puzzle-domain.js"), "utf8");
const CARO_DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "caro-kann-domain.js"), "utf8");
const CONTROLLER_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "caro-kann-puzzles.js"), "utf8");

const ELEMENT_IDS = [
  "puzzles-page", "puzzles-title", "puzzle-intro", "puzzle-progress-summary", "puzzle-storage-warning",
  "opening-puzzle-deck",
  "caro-puzzle-filters", "caro-filter-mode", "caro-filter-variation",
  "caro-filter-difficulty", "caro-filter-provenance", "caro-filter-theme",
  "caro-filter-opening", "caro-filter-status", "caro-filter-reset",
  "puzzles-unsolved-tab", "puzzles-solved-tab", "puzzles-unsolved-count",
  "puzzles-solved-count", "puzzles-unsolved-panel", "puzzles-solved-panel",
  "puzzle-page-state", "puzzle-workspace", "puzzle-board", "puzzle-board-help", "puzzle-prompt",
  "puzzle-side-to-move", "puzzle-feedback", "puzzle-context-body",
  "puzzle-queue-position", "puzzle-continue", "puzzle-skip", "puzzle-reset",
  "puzzle-hint", "puzzle-show", "puzzle-uci-disclosure", "puzzle-uci-form",
  "puzzle-uci-input", "puzzle-promotion-chooser", "puzzle-promotion-options",
  "puzzle-promotion-cancel", "puzzles-solved-empty", "puzzles-solved-layout",
  "puzzles-solved-list", "puzzle-solved-review", "puzzle-solved-review-title",
  "puzzle-solved-review-close", "puzzle-solved-board", "puzzle-solved-details",
];

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.tabIndex = 0;
    this.dataset = Object.create(null);
    this.isConnected = true;
    this.listeners = Object.create(null);
    this.attributes = Object.create(null);
    this.classList = { toggle() {} };
  }

  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }

  dispatch(type, event = {}) {
    const callback = this.listeners[type];
    if (callback) callback(Object.assign({ preventDefault() {} }, event));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  querySelector(selector) {
    if (this.id === "puzzle-uci-form" && selector === "button[type='submit']") {
      return this.submitButton;
    }
    if (this.id === "puzzle-promotion-options" && selector === "button") {
      return this.firstPromotionButton;
    }
    return null;
  }

  focus() {}
}

class FakeBoard {
  constructor(config) {
    this.config = config;
    this.configs = [config];
    this.shapes = [];
  }

  set(config) {
    this.config = config;
    this.configs.push(config);
  }

  setShapes(shapes) {
    this.shapes = shapes;
  }

  redrawAll() {}
}

function continuationRecord({ terminalReply = false } = {}) {
  const initialFen = "8/8/8/8/5K2/2Qp4/3k4/8 b - - 3 47";
  const afterBest = "8/8/8/8/5K2/2kp4/8/8 w - - 0 48";
  const afterReply = "8/8/8/8/4K3/2kp4/8/8 b - - 1 48";
  const afterFinal = "8/8/8/8/4K3/3p4/3k4/8 w - - 2 49";
  const finalReplyFen = "8/8/8/8/8/3pK3/3k4/8 b - - 3 49";
  const first = {
    fenBefore: initialFen,
    bestMoveUci: "d2c3",
    bestMoveSan: "Kxc3",
    postBestFen: afterBest,
    legalMovesUci: ["d2c3", "d2d1", "d2e2"],
    legalDests: { d2: ["c3", "d1", "e2"] },
    promotionOptions: {},
    opponentReplyUci: "f4e4",
    opponentReplySan: "Ke4",
    postReplyFen: afterReply,
  };
  const second = {
    fenBefore: afterReply,
    bestMoveUci: "c3d2",
    bestMoveSan: "Kd2",
    postBestFen: afterFinal,
    legalMovesUci: ["c3c4", "c3b4", "c3b3", "c3d2", "c3c2", "c3b2", "d3d2"],
    legalDests: { c3: ["c4", "b4", "b3", "d2", "c2", "b2"], d3: ["d2"] },
    promotionOptions: {},
    opponentReplyUci: terminalReply ? "e4e3" : null,
    opponentReplySan: terminalReply ? "Ke3" : null,
    postReplyFen: terminalReply ? finalReplyFen : null,
  };
  return {
    id: terminalReply ? "terminal-white-reply" : "black-continuation",
    source: "lichess",
    sourceUrl: "https://lichess.org/example#93",
    openingFamily: "Caro-Kann Defense",
    variation: "Caro-Kann Defense: Advance Variation",
    openingTags: ["Caro-Kann_Defense_Advance_Variation"],
    originalFen: "8/8/8/8/5K2/2Qp4/3k4/8 w - - 2 47",
    setupMoveUci: "c4c3",
    setupMoveSan: "Qc3+",
    puzzleFen: initialFen,
    sideToMove: "black",
    orientation: "black",
    solutionUci: terminalReply
      ? ["d2c3", "f4e4", "c3d2", "e4e3"]
      : ["d2c3", "f4e4", "c3d2"],
    solutionSan: terminalReply
      ? ["Kxc3", "Ke4", "Kd2", "Ke3"]
      : ["Kxc3", "Ke4", "Kd2"],
    solutionSteps: [first, second],
    rating: 1700,
    ratingDeviation: 70,
    popularity: 90,
    plays: 400,
    difficulty: "intermediate",
    provenance: "standard",
    themes: ["fork", "opening"],
    isOpeningPuzzle: true,
  };
}

function threeDecisionRecord() {
  const puzzle = continuationRecord();
  const thirdFen = "8/8/8/8/5K2/3p4/3k4/8 b - - 3 49";
  puzzle.id = "three-black-decisions";
  puzzle.solutionSteps[1].opponentReplyUci = "e4f4";
  puzzle.solutionSteps[1].opponentReplySan = "Kf4";
  puzzle.solutionSteps[1].postReplyFen = thirdFen;
  puzzle.solutionSteps.push({
    fenBefore: thirdFen,
    bestMoveUci: "d2e2",
    bestMoveSan: "Ke2",
    postBestFen: "8/8/8/8/5K2/3p4/4k3/8 w - - 4 50",
    legalMovesUci: ["d2e2", "d2c2", "d3d2"],
    legalDests: { d2: ["e2", "c2"], d3: ["d2"] },
    promotionOptions: {},
    opponentReplyUci: null,
    opponentReplySan: null,
    postReplyFen: null,
  });
  puzzle.solutionUci = ["d2c3", "f4e4", "c3d2", "e4f4", "d2e2"];
  puzzle.solutionSan = ["Kxc3", "Ke4", "Kd2", "Kf4", "Ke2"];
  return puzzle;
}

function alternativeMateRecord() {
  const puzzle = continuationRecord();
  const first = puzzle.solutionSteps[0];
  const alternativeFen = "8/8/8/8/5K2/2Qpk3/8/8 w - - 0 48";
  puzzle.id = "accepted-mate-alternative";
  first.opponentReplyUci = null;
  first.opponentReplySan = null;
  first.postReplyFen = null;
  first.acceptedMovesUci = [first.bestMoveUci, "d2e2"];
  // Deliberately provide the map only at record level: the Caro adapter must
  // carry it into the first normalized solution step.
  puzzle.acceptedMatingMovesUci = first.acceptedMovesUci.slice();
  puzzle.acceptedMovePostFens = {
    [first.bestMoveUci]: first.postBestFen,
    d2e2: alternativeFen,
  };
  puzzle.solutionSteps = [first];
  puzzle.solutionUci = [first.bestMoveUci];
  puzzle.solutionSan = [first.bestMoveSan];
  return { puzzle, alternativeFen };
}

function recordWithId(id, options) {
  return { ...continuationRecord(options), id };
}

function exchangeRecord(id) {
  const puzzle = recordWithId(id);
  const fen = puzzle.puzzleFen.replace(" 3 47", " 4 47");
  puzzle.variation = "Caro-Kann Defense: Exchange Variation";
  puzzle.openingTags = ["Caro-Kann_Defense_Exchange_Variation"];
  puzzle.puzzleFen = fen;
  puzzle.solutionSteps[0].fenBefore = fen;
  return puzzle;
}

function whiteDeckRecord(id = "colle-white-one") {
  const puzzleFen = "8/8/8/8/8/2k5/3K4/8 w - - 1 2";
  return {
    id,
    deckId: "colle-white",
    source: "lichess",
    sourceUrl: "https://lichess.org/colle#12",
    openingFamily: "Colle System",
    variation: "Colle System: Traditional Colle",
    openingTags: ["Queens_Pawn_Game_Colle_System_Traditional_Colle"],
    originalFen: "8/8/8/8/8/8/2kK4/8 b - - 0 1",
    setupMoveUci: "c2c3",
    setupMoveSan: "Kc3",
    puzzleFen,
    solverColor: "white",
    sideToMove: "white",
    orientation: "white",
    solutionUci: ["d2e3"],
    solutionSan: ["Ke3"],
    solutionSteps: [{
      fenBefore: puzzleFen,
      bestMoveUci: "d2e3",
      bestMoveSan: "Ke3",
      postBestFen: "8/8/8/8/8/2k1K3/8/8 b - - 2 2",
      legalMovesUci: ["d2e3", "d2e2"],
      legalDests: { d2: ["e3", "e2"] },
      promotionOptions: {},
      opponentReplyUci: null,
      opponentReplySan: null,
      postReplyFen: null,
    }],
    rating: 1300,
    difficulty: "developing",
    provenance: "standard",
    themes: ["opening", "quietMove"],
    isOpeningPuzzle: true,
  };
}

function blackDeckRecord(deckId, root, family, id = `${deckId}-one`) {
  const puzzle = continuationRecord();
  puzzle.id = id;
  puzzle.deckId = deckId;
  puzzle.openingFamily = family;
  puzzle.openingTags = [`${root}_Main_Line`];
  puzzle.variation = `${family}: Main Line`;
  puzzle.solverColor = "black";
  return puzzle;
}

function seedSolved(storage, ids) {
  const at = "2026-08-03T12:00:00Z";
  const records = Object.fromEntries(ids.map(id => [id, {
    id,
    status: "solved",
    attempts: 1,
    firstAttemptAt: at,
    solvedAt: at,
    solutionRevealedAt: null,
    createdAt: at,
    updatedAt: at,
  }]));
  storage.setItem(
    "chess-tracker:puzzle-progress:v1:caro-kann-black:me",
    JSON.stringify({ version: 1, username: "me", records }),
  );
}

function manifest(chunkCount = 1) {
  return {
    schemaVersion: "1",
    deckId: "caro-kann-black",
    displayName: "Caro-Kann Defense — Black",
    openingFamily: "Caro-Kann Defense",
    solverColor: "black",
    orientation: "black",
    openingTagRoots: ["Caro-Kann_Defense"],
    counts: { balancedExported: chunkCount },
    variationCounts: { "Caro-Kann Defense: Advance Variation": chunkCount },
    difficultyCounts: { intermediate: chunkCount },
    provenanceCounts: { standard: chunkCount },
    themeCounts: { fork: chunkCount, opening: chunkCount },
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      path: `chunks/chunk-${String(index + 1).padStart(4, "0")}.json`,
      count: 1,
    })),
  };
}

const DECKS = [{
  id: "caro-kann-black",
  label: "Caro-Kann Defense — Black",
  openingFamily: "Caro-Kann Defense",
  solverColor: "black",
  orientation: "black",
  manifestPath: "caro-kann-black/manifest.json",
}, {
  id: "colle-white",
  label: "Colle System — White",
  openingFamily: "Colle System",
  solverColor: "white",
  orientation: "white",
  manifestPath: "colle-white/manifest.json",
}, {
  id: "englund-white",
  label: "Englund Gambit — White",
  openingFamily: "Englund Gambit",
  solverColor: "white",
  orientation: "white",
  manifestPath: "englund-white/manifest.json",
}, {
  id: "pirc-black",
  label: "Pirc Defense — Black",
  openingFamily: "Pirc Defense",
  solverColor: "black",
  orientation: "black",
  manifestPath: "pirc-black/manifest.json",
}, {
  id: "modern-black",
  label: "Modern Defense — Black",
  openingFamily: "Modern Defense",
  solverColor: "black",
  orientation: "black",
  manifestPath: "modern-black/manifest.json",
}];

function catalog() {
  return { schemaVersion: 1, defaultDeckId: "caro-kann-black", decks: DECKS };
}

function deckManifest(deckId, chunkCount = 1) {
  const deck = DECKS.find(item => item.id === deckId) || DECKS[0];
  const roots = {
    "caro-kann-black": ["Caro-Kann_Defense"],
    "colle-white": ["Queens_Pawn_Game_Colle_System", "Indian_Defense_Colle_System", "Colle_System"],
    "englund-white": ["Englund_Gambit"],
    "pirc-black": ["Pirc_Defense"],
    "modern-black": ["Modern_Defense", "Queens_Pawn_Game_Modern_Defense"],
  }[deck.id];
  return {
    ...manifest(chunkCount),
    deckId: deck.id,
    displayName: deck.label,
    openingFamily: deck.openingFamily,
    solverColor: deck.solverColor,
    orientation: deck.orientation,
    openingTagRoots: roots,
    variationCounts: {},
  };
}

async function createHarness(records, {
  chunkCount = 1,
  storage = new MemoryStorage(),
  failedChunks = [],
  recordsByDeck = null,
  manifestsByDeck = null,
  delayedManifestDecks = [],
  delayedChunkUrls = [],
} = {}) {
  const elements = Object.fromEntries(ELEMENT_IDS.map(id => [id, new FakeElement(id)]));
  elements["caro-filter-mode"].value = "all";
  elements["caro-filter-variation"].value = "all";
  elements["caro-filter-difficulty"].value = "all";
  elements["caro-filter-provenance"].value = "all";
  elements["caro-filter-theme"].value = "all";
  elements["puzzle-uci-form"].submitButton = new FakeElement("uci-submit");
  elements["puzzle-promotion-options"].firstPromotionButton = new FakeElement("first-promotion");

  const boards = [];
  const fetches = [];
  const timers = new Map();
  const delayedManifestResolvers = new Map();
  const delayedChunkResolvers = new Map();
  let nextTimer = 1;
  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      return selector === "[data-caro-kann-trainer]" ? elements["puzzles-page"] : null;
    },
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: storage,
    Date,
    Intl,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    encodeURIComponent,
    queueMicrotask(callback) { callback(); },
  });
  context.window = context;
  context.window.DATA = { username: "me" };
  context.window.matchMedia = query => ({ matches: query === "(pointer: coarse)" });
  context.window.addEventListener = () => {};
  context.window.setTimeout = callback => {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, callback);
    return id;
  };
  context.window.clearTimeout = id => timers.delete(id);
  context.window.fetch = async url => {
    fetches.push(String(url));
    if (String(url) === "data/opening-puzzle-catalog.json") {
      return { ok: true, async json() { return catalog(); } };
    }
    const manifestMatch = String(url).match(/^data\/([^/]+)\/manifest\.json$/);
    if (manifestMatch) {
      const deckId = manifestMatch[1];
      const payload = manifestsByDeck && manifestsByDeck[deckId]
        || deckManifest(deckId, chunkCount);
      if (delayedManifestDecks.includes(deckId)) {
        return new Promise(resolve => delayedManifestResolvers.set(deckId, () => resolve({
          ok: true,
          async json() { return payload; },
        })));
      }
      return { ok: true, async json() { return payload; } };
    }
    const deckMatch = String(url).match(/^data\/([^/]+)\/chunks\/chunk-(\d+)\.json$/);
    const match = String(url).match(/chunk-(\d+)\.json$/);
    const index = match ? Number(match[1]) - 1 : 0;
    if (failedChunks.includes(index + 1)) return { ok: false, status: 503 };
    const deckRecords = recordsByDeck && deckMatch && recordsByDeck[deckMatch[1]] || records;
    if (delayedChunkUrls.includes(String(url))) {
      return new Promise(resolve => delayedChunkResolvers.set(String(url), () => resolve({
        ok: true,
        async json() { return [deckRecords[index] || deckRecords[0]]; },
      })));
    }
    return { ok: true, async json() { return [deckRecords[index] || deckRecords[0]]; } };
  };
  context.window.ChessTrackerUI = {
    escapeHtml(value) { return String(value == null ? "" : value); },
    makeBoard(_element, config) {
      const board = new FakeBoard(config);
      boards.push(board);
      return board;
    },
  };

  vm.runInContext(DOMAIN_SOURCE, context);
  vm.runInContext(CARO_DOMAIN_SOURCE, context);
  vm.runInContext(CONTROLLER_SOURCE, context);
  await context.CaroKannTrainer.ready;

  return {
    context,
    elements,
    storage,
    fetches,
    board: boards[0],
    flushTimer() {
      const entry = timers.entries().next();
      assert.equal(entry.done, false, "expected a queued controller timer");
      const [id, callback] = entry.value;
      timers.delete(id);
      callback();
    },
    progress(id = records[0].id, deckId = "caro-kann-black") {
      const key = `chess-tracker:puzzle-progress:v1:${deckId}:me`;
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw).records[id] || null : null;
    },
    resolveManifest(deckId) {
      const resolve = delayedManifestResolvers.get(deckId);
      assert.ok(resolve, `expected a delayed ${deckId} manifest request`);
      delayedManifestResolvers.delete(deckId);
      resolve();
    },
    resolveChunk(url) {
      const resolve = delayedChunkResolvers.get(url);
      assert.ok(resolve, `expected a delayed ${url} request`);
      delayedChunkResolvers.delete(url);
      resolve();
    },
    async settle() {
      for (let index = 0; index < 4; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  };
}

test("loader fetches catalog, then manifest, then only the first balanced chunk initially", async () => {
  const harness = await createHarness([continuationRecord(), continuationRecord()], { chunkCount: 2 });
  assert.deepEqual(harness.fetches, [
    "data/opening-puzzle-catalog.json",
    "data/caro-kann-black/manifest.json",
    "data/caro-kann-black/chunks/chunk-0001.json",
  ]);
  assert.equal(CONTROLLER_SOURCE.includes("all.jsonl"), false);
});

test("catalog dropdown exposes all five opening decks", async () => {
  const harness = await createHarness([continuationRecord()]);
  const options = harness.elements["opening-puzzle-deck"].innerHTML;
  ["caro-kann-black", "colle-white", "englund-white", "pirc-black", "modern-black"]
    .forEach(deckId => assert.match(options, new RegExp(`value="${deckId}"`)));
});

test("switching to a White deck clears the old queue and changes solver orientation", async () => {
  const caro = continuationRecord();
  const colle = whiteDeckRecord();
  const harness = await createHarness([caro], {
    recordsByDeck: {
      "caro-kann-black": [caro],
      "colle-white": [colle],
    },
  });
  harness.elements["caro-filter-variation"].value = caro.variation;

  assert.equal(await harness.context.CaroKannTrainer.selectDeck("colle-white"), true);
  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "colle-white");
  assert.equal(harness.elements["opening-puzzle-deck"].value, "colle-white");
  assert.equal(harness.elements["caro-filter-variation"].value, "all");
  assert.equal(harness.board.config.fen, colle.puzzleFen);
  assert.equal(harness.board.config.orientation, "white");
  assert.equal(harness.board.config.turnColor, "white");
  assert.equal(harness.board.config.movable.color, "white");
  assert.match(harness.elements["puzzles-title"].textContent, /Colle System/);
  assert.match(harness.elements["puzzle-side-to-move"].textContent, /White to move.*You are White/);
  assert.equal(harness.fetches.includes("data/colle-white/chunks/chunk-0001.json"), true);
  assert.notEqual(harness.board.config.fen, caro.puzzleFen);

  harness.board.config.movable.events.after("d2", "e3");
  assert.equal(harness.progress(colle.id, "colle-white").status, "solved");
  assert.equal(harness.progress(colle.id, "caro-kann-black"), null);
});

test("a slow previous manifest cannot overwrite a newer deck selection", async () => {
  const caro = continuationRecord();
  const colle = whiteDeckRecord();
  const pirc = blackDeckRecord("pirc-black", "Pirc_Defense", "Pirc Defense");
  const harness = await createHarness([caro], {
    recordsByDeck: {
      "caro-kann-black": [caro],
      "colle-white": [colle],
      "pirc-black": [pirc],
    },
    delayedManifestDecks: ["colle-white"],
  });

  const stale = harness.context.CaroKannTrainer.selectDeck("colle-white");
  await harness.settle();
  const latest = harness.context.CaroKannTrainer.selectDeck("pirc-black");
  assert.equal(await latest, true);
  harness.resolveManifest("colle-white");
  assert.equal(await stale, false);

  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "pirc-black");
  assert.equal(harness.board.config.fen, pirc.puzzleFen);
  assert.equal(harness.board.config.orientation, "black");
  assert.equal(harness.fetches.some(url => url.includes("colle-white/chunks/")), false);
  assert.equal(harness.fetches.some(url => url.includes("pirc-black/chunks/chunk-0001.json")), true);
});

test("a stale solved-archive chunk cannot consume or mutate the newly selected deck", async () => {
  const storage = new MemoryStorage();
  const caro = recordWithId("caro-current");
  const saved = recordWithId("caro-saved-in-later-chunk");
  const colle = whiteDeckRecord();
  seedSolved(storage, [saved.id]);
  const delayedUrl = "data/caro-kann-black/chunks/chunk-0002.json";
  const harness = await createHarness([caro, saved], {
    chunkCount: 2,
    storage,
    recordsByDeck: {
      "caro-kann-black": [caro, saved],
      "colle-white": [colle],
    },
    delayedChunkUrls: [delayedUrl],
  });

  harness.elements["puzzles-solved-tab"].dispatch("click");
  await harness.settle();
  assert.equal(harness.fetches.includes(delayedUrl), true);

  assert.equal(await harness.context.CaroKannTrainer.selectDeck("colle-white"), true);
  harness.resolveChunk(delayedUrl);
  await harness.settle();

  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "colle-white");
  assert.equal(harness.board.config.fen, colle.puzzleFen);
  assert.equal(harness.board.config.orientation, "white");
  assert.equal(harness.fetches.some(url => url.includes("colle-white/chunks/chunk-0002")), false);
  assert.equal(harness.elements["puzzles-solved-count"].textContent, "(0)");
});

test("schema-v2 manifest identity fields fail closed before any chunk request", async () => {
  const broken = deckManifest("caro-kann-black", 1);
  broken.schemaVersion = 2;
  delete broken.openingTagRoots;
  const harness = await createHarness([continuationRecord()], {
    manifestsByDeck: { "caro-kann-black": broken },
  });
  assert.deepEqual(harness.fetches, [
    "data/opening-puzzle-catalog.json",
    "data/caro-kann-black/manifest.json",
  ]);
  assert.match(harness.elements["puzzle-progress-summary"].textContent, /unavailable/i);
  assert.equal(harness.elements["puzzle-workspace"].hidden, true);
});

test("aggregate tactical filters do not duplicate their raw Lichess themes", async () => {
  const harness = await createHarness([continuationRecord()]);
  const options = harness.elements["caro-filter-theme"].innerHTML;
  assert.match(options, /value="forks">Forks/);
  assert.doesNotMatch(options, /value="fork">Fork</);
  assert.doesNotMatch(options, /value="mate">Mate</);
});

test("opening an empty solved archive does not fetch more chunks", async () => {
  const harness = await createHarness([
    recordWithId("archive-current"),
    recordWithId("archive-later"),
  ], { chunkCount: 2 });
  assert.equal(harness.fetches.length, 3);
  harness.elements["puzzles-solved-tab"].dispatch("click");
  await harness.settle();
  assert.equal(harness.fetches.length, 3);
  assert.match(harness.elements["puzzles-solved-empty"].innerHTML, /No solved puzzles/i);
});

test("solved archive loads only until all stored solved IDs are found", async () => {
  const storage = new MemoryStorage();
  const current = recordWithId("archive-unsolved-first");
  const solved = recordWithId("archive-solved-second");
  const later = recordWithId("archive-unneeded-third");
  seedSolved(storage, [solved.id]);
  const harness = await createHarness([current, solved, later], {
    chunkCount: 3,
    storage,
  });
  assert.equal(harness.fetches.length, 3);

  harness.elements["puzzles-solved-tab"].dispatch("click");
  await harness.settle();
  assert.equal(harness.fetches.length, 4);
  assert.match(harness.fetches[3], /chunk-0002\.json$/);
  assert.equal(harness.elements["puzzles-solved-count"].textContent, "(1)");
  assert.equal(harness.elements["puzzles-solved-layout"].hidden, false);
});

test("initial loading continues past an all-solved matching chunk", async () => {
  const storage = new MemoryStorage();
  const solved = recordWithId("already-solved");
  const fresh = recordWithId("fresh-in-chunk-two");
  seedSolved(storage, [solved.id]);

  const harness = await createHarness([solved, fresh], { chunkCount: 2, storage });
  assert.deepEqual(harness.fetches, [
    "data/opening-puzzle-catalog.json",
    "data/caro-kann-black/manifest.json",
    "data/caro-kann-black/chunks/chunk-0001.json",
    "data/caro-kann-black/chunks/chunk-0002.json",
  ]);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.equal(harness.elements["puzzles-unsolved-count"].textContent, "(1)");
  assert.equal(harness.board.config.fen, fresh.puzzleFen);
  assert.equal(harness.progress(fresh.id), null);
});

test("a failed chunk is consumed while seeking a later unsolved match", async () => {
  const storage = new MemoryStorage();
  const solved = recordWithId("solved-before-error");
  const fresh = recordWithId("fresh-after-error");
  seedSolved(storage, [solved.id]);

  const harness = await createHarness([solved, recordWithId("unused"), fresh], {
    chunkCount: 3,
    storage,
    failedChunks: [2],
  });
  assert.equal(harness.fetches.length, 5);
  assert.match(harness.fetches[4], /chunk-0003\.json$/);
  assert.equal(harness.board.config.fen, fresh.puzzleFen);
  assert.match(harness.elements["puzzle-storage-warning"].textContent, /could not be loaded/);
});

test("changing to a filter with no loaded unsolved match loads later chunks", async () => {
  const advance = recordWithId("loaded-advance");
  const exchange = exchangeRecord("later-exchange");
  const harness = await createHarness([advance, exchange], { chunkCount: 2 });
  assert.equal(harness.fetches.length, 3);

  harness.elements["caro-filter-variation"].value = exchange.variation;
  harness.elements["caro-filter-variation"].dispatch("change");
  await harness.settle();
  assert.equal(harness.fetches.length, 4);
  assert.match(harness.fetches[3], /chunk-0002\.json$/);
  assert.equal(harness.elements["caro-filter-variation"].value, exchange.variation);
  assert.equal(harness.board.config.fen, exchange.puzzleFen);
});

test("Black board advances arbitrary continuation and White reply is automatic", async () => {
  const record = continuationRecord();
  const harness = await createHarness([record]);
  const { board, elements } = harness;

  assert.equal(board.config.orientation, "black");
  assert.equal(board.config.turnColor, "black");
  assert.equal(board.config.viewOnly, false);
  assert.equal(board.config.draggable.enabled, false);
  assert.equal(board.config.selectable.enabled, true);
  assert.equal(elements["puzzle-context-body"].innerHTML.includes("Kxc3"), false);
  assert.equal(elements["puzzle-context-body"].innerHTML.includes("Qc3+"), false);

  board.config.movable.events.after("d2", "c3");
  assert.equal(harness.progress(), null);
  assert.equal(board.config.fen, record.solutionSteps[0].postBestFen);
  assert.equal(board.config.movable.color, undefined);

  harness.flushTimer();
  assert.equal(board.config.orientation, "black");
  assert.equal(board.config.fen, record.solutionSteps[1].fenBefore);
  assert.deepEqual(Array.from(board.config.lastMove), ["f4", "e4"]);
  assert.equal(board.config.movable.color, "black");

  board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress().status, "solved");
  assert.equal(harness.progress().attempts, 1);
  assert.equal(board.config.orientation, "black");
  assert.match(elements["puzzle-context-body"].innerHTML, /Qc3\+/);
  assert.match(elements["puzzle-context-body"].innerHTML, /Kxc3 Ke4 Kd2/);
});

test("keyboard entry renders a non-primary accepted mate at its exact mapped FEN", async () => {
  const { puzzle, alternativeFen } = alternativeMateRecord();
  const harness = await createHarness([puzzle]);
  harness.elements["puzzle-uci-input"].value = "d2e2";
  harness.elements["puzzle-uci-form"].dispatch("submit");

  assert.equal(harness.progress().status, "solved");
  assert.equal(harness.board.config.fen, alternativeFen);
  assert.deepEqual(Array.from(harness.board.config.lastMove), ["d2", "e2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.board.shapes)), [
    { orig: "d2", dest: "e2", brush: "green" },
  ]);
});

test("terminal White reply animates before the puzzle becomes solved", async () => {
  const record = continuationRecord({ terminalReply: true });
  const harness = await createHarness([record]);
  const { board } = harness;

  board.config.movable.events.after("d2", "c3");
  harness.flushTimer();
  board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress(), null, "final Black decision is not complete until White replies");
  assert.equal(board.config.fen, record.solutionSteps[1].postBestFen);

  harness.flushTimer();
  assert.equal(harness.progress().status, "solved");
  assert.equal(board.config.fen, record.solutionSteps[1].postReplyFen);
  assert.deepEqual(Array.from(board.config.lastMove), ["e4", "e3"]);
  assert.equal(board.config.orientation, "black");
});

test("three Black decisions complete only after the arbitrary-length line ends", async () => {
  const record = threeDecisionRecord();
  const harness = await createHarness([record]);

  harness.board.config.movable.events.after("d2", "c3");
  harness.flushTimer();
  harness.board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress(), null);
  harness.flushTimer();
  assert.equal(harness.board.config.fen, record.solutionSteps[2].fenBefore);
  assert.equal(harness.progress(), null);

  harness.board.config.movable.events.after("d2", "e2");
  assert.equal(harness.progress().status, "solved");
  assert.equal(harness.progress().attempts, 1);
});

test("wrong, illegal, hinted, revealed, reset, and skipped actions never solve", async () => {
  const wrongHarness = await createHarness([continuationRecord()]);
  wrongHarness.board.config.movable.events.after("d2", "d1");
  assert.equal(wrongHarness.progress().status, "unsolved");
  wrongHarness.flushTimer();
  assert.equal(wrongHarness.board.config.fen, continuationRecord().puzzleFen);

  const actionHarness = await createHarness([continuationRecord()]);
  actionHarness.board.config.movable.events.after("d2", "c2");
  assert.equal(actionHarness.progress(), null, "illegal moves are not attempts or solves");
  actionHarness.elements["puzzle-hint"].dispatch("click");
  assert.equal(actionHarness.progress(), null, "hints do not create solved progress");
  actionHarness.elements["puzzle-reset"].dispatch("click");
  assert.equal(actionHarness.progress(), null, "reset does not solve");
  actionHarness.elements["puzzle-skip"].dispatch("click");
  assert.equal(actionHarness.progress(), null, "skip does not solve");
  actionHarness.elements["puzzle-show"].dispatch("click");
  assert.equal(actionHarness.progress().status, "unsolved");
  assert.equal(actionHarness.progress().attempts, 0);
  assert.match(actionHarness.elements["puzzle-context-body"].innerHTML, /Qc3\+/);
});

test("namespaced solved progress survives a controller reload", async () => {
  const storage = new MemoryStorage();
  const first = await createHarness([continuationRecord()], { storage });
  first.board.config.movable.events.after("d2", "c3");
  first.flushTimer();
  first.board.config.movable.events.after("c3", "d2");
  assert.equal(first.progress().status, "solved");

  const reloaded = await createHarness([continuationRecord()], { storage });
  assert.equal(reloaded.elements["puzzles-solved-count"].textContent, "(1)");
  assert.equal(reloaded.elements["puzzle-workspace"].hidden, true);
  assert.match(reloaded.elements["puzzle-progress-summary"].textContent, /^1 solved/);
});

test("completion scans past solved-only chunks before Continue advances", async () => {
  const storage = new MemoryStorage();
  const current = recordWithId("solve-now");
  const solvedMiddle = recordWithId("solved-middle");
  const next = recordWithId("next-unsolved");
  seedSolved(storage, [solvedMiddle.id]);
  const harness = await createHarness([current, solvedMiddle, next], {
    chunkCount: 3,
    storage,
  });

  harness.board.config.movable.events.after("d2", "c3");
  harness.flushTimer();
  harness.board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress(current.id).status, "solved");
  await harness.settle();
  assert.equal(harness.fetches.length, 5);

  harness.elements["puzzle-continue"].dispatch("click");
  await harness.settle();
  assert.equal(harness.board.config.fen, next.puzzleFen);
  assert.equal(harness.progress(next.id), null);
  assert.match(harness.elements["puzzle-context-body"].innerHTML, /metadata.*after/i);
});

test("Skip scans solved-only chunks until another unsolved match is available", async () => {
  const storage = new MemoryStorage();
  const current = recordWithId("skip-current");
  const solvedMiddle = recordWithId("skip-solved-middle");
  const next = exchangeRecord("skip-next");
  seedSolved(storage, [solvedMiddle.id]);
  const harness = await createHarness([current, solvedMiddle, next], {
    chunkCount: 3,
    storage,
  });

  harness.elements["puzzle-skip"].dispatch("click");
  await harness.settle();
  assert.equal(harness.fetches.length, 5);
  assert.equal(harness.board.config.fen, next.puzzleFen);
  assert.equal(harness.progress(current.id), null);
  assert.equal(harness.progress(next.id), null);
});
