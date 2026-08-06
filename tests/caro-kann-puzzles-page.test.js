const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "puzzle-domain.js"), "utf8");
const CARO_DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "caro-kann-domain.js"), "utf8");
const TRAINER_DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "trainer-domain.js"), "utf8");
const CONTROLLER_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "caro-kann-puzzles.js"), "utf8");

const ELEMENT_IDS = [
  "puzzles-page", "puzzles-title", "puzzle-intro", "puzzle-progress-summary", "puzzle-storage-warning",
  "opening-puzzle-deck",
  "caro-puzzle-filters", "caro-filter-mode", "caro-filter-variation",
  "variation-picker",
  "caro-filter-difficulty", "caro-filter-provenance", "caro-filter-lines", "caro-filter-theme",
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
  "trainer-header-deck", "trainer-header-progress", "trainer-onboarding",
  "trainer-onboarding-dismiss", "session-restart", "session-complete",
  "session-start-fresh",
  "session-complete-title", "session-results", "session-weak-spots",
  "session-review-mistakes", "session-start-another", "reviews-due-button",
  "review-mistakes-button", "puzzle-review-state", "training-length",
  "puzzle-progress-track", "puzzle-progress-fill",
  "customize-open", "customize-close", "customize-apply", "customize-search",
  "variation-choice-list", "theme-choice-list", "active-filter-chips",
  "progress-import", "progress-transfer-status",
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
    this.style = Object.create(null);
    this.queryResults = Object.create(null);
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
    if (name === "tabindex") this.tabIndex = Number(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name] : null;
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

  querySelectorAll(selector) {
    return this.queryResults[selector] || [];
  }

  focus() { this.focused = true; }
}

function hydrateChoiceButtons(container) {
  const buttons = [...String(container.innerHTML || "").matchAll(
    /<button[^>]*role="radio"[^>]*aria-checked="([^"]+)"[^>]*tabindex="([^"]+)"[^>]*data-choice-value="([^"]*)"[^>]*data-choice-label="([^"]*)"[^>]*>/g,
  )].map((match, index) => {
    const button = new FakeElement(`choice-${index}`);
    button.tabIndex = Number(match[2]);
    button.dataset.choiceValue = match[3];
    button.dataset.choiceLabel = match[4];
    button.setAttribute("aria-checked", match[1]);
    return button;
  });
  container.queryResults["[data-choice-label]"] = buttons;
  container.queryResults["[role='radio']"] = buttons;
  container.queryResults["button[data-choice-value]"] = buttons;
  return buttons;
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

function personalBlunderRecord(color, id = `personal-${color}`) {
  const white = color === "white";
  const fenBefore = white
    ? "8/8/8/8/8/2k5/3K4/8 w - - 1 2"
    : "8/8/8/8/5K2/2Qp4/3k4/8 b - - 3 47";
  const bestMoveUci = white ? "d2e3" : "d2c3";
  const bestMoveSan = white ? "Ke3" : "Kxc3";
  const postBestFen = white
    ? "8/8/8/8/8/2k1K3/8/8 b - - 2 2"
    : "8/8/8/8/5K2/2kp4/8/8 w - - 0 48";
  const legalMoves = white ? ["d2e3", "d2e2"] : ["d2c3", "d2d1"];
  const legalDests = white ? { d2: ["e3", "e2"] } : { d2: ["c3", "d1"] };
  return {
    puzzle_id: id,
    game_id: `https://www.chess.com/game/live/${white ? "1" : "2"}`,
    game_url: `https://www.chess.com/game/live/${white ? "1" : "2"}`,
    user_color: color,
    orientation: color,
    side_to_move: color,
    fullmove: white ? 2 : 47,
    fen_before: fenBefore,
    played_move_uci: white ? "d2c2" : "d2d1",
    played_move_san: white ? "Kc2" : "Kd1",
    best_move_uci: bestMoveUci,
    best_move_san: bestMoveSan,
    post_best_fen: postBestFen,
    legal_moves_uci: legalMoves,
    legal_dests: legalDests,
    promotion_options: {},
    principal_variation_uci: [bestMoveUci],
    principal_variation_san: [bestMoveSan],
    solution_steps: [{
      fen_before: fenBefore,
      best_move_uci: bestMoveUci,
      best_move_san: bestMoveSan,
      post_best_fen: postBestFen,
      legal_moves_uci: legalMoves,
      legal_dests: legalDests,
      promotion_options: {},
      opponent_reply_uci: null,
      opponent_reply_san: null,
      post_reply_fen: null,
    }],
    opening: white ? "Colle System" : "Pirc Defense",
    repertoire_deck_id: white ? "colle-white" : "pirc-black",
    categories: ["personalBlunder"],
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

function seedPersonalSolved(storage, ids) {
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
    "chess-tracker:puzzle-progress:v1:me",
    JSON.stringify({ version: 1, username: "me", records }),
  );
}

function seedTrainerState(storage, {
  sessionMode = "finite",
  sessionSize = 10,
  reviews = {},
  reviewsByDeck = null,
} = {}) {
  const at = new Date().toISOString();
  storage.setItem("chess-tracker:opening-trainer:v2:me", JSON.stringify({
    version: 2,
    username: "me",
    preferences: {
      lastDeckId: "caro-kann-black",
      sessionMode,
      sessionSize,
      onboardingDismissed: true,
      updatedAt: at,
    },
    reviews: reviewsByDeck || { "caro-kann-black": reviews },
    updatedAt: at,
  }));
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

const PERSONAL_BLUNDER_DECK = {
  id: "my-blunders-all",
  label: "My Blunders — ALL",
  openingFamily: "My Blunders — ALL",
  sourceKind: "personal-blunders",
  dataPath: "my-blunder-puzzles.json",
  progressScope: "personal",
  repertoireDeckId: null,
  solverColor: "mixed",
  orientation: "mixed",
};

const PERSONAL_BLUNDER_COLLE_DECK = {
  id: "my-blunders-colle",
  label: "My Blunders — Colle System",
  openingFamily: "My Blunders — Colle System",
  sourceKind: "personal-blunders",
  dataPath: "my-blunder-puzzles.json",
  progressScope: "personal",
  repertoireDeckId: "colle-white",
  solverColor: "white",
  orientation: "white",
};

const PERSONAL_BLUNDER_DECKS = [PERSONAL_BLUNDER_DECK, PERSONAL_BLUNDER_COLLE_DECK];

function catalog(extraDecks = []) {
  return { schemaVersion: 1, defaultDeckId: "caro-kann-black", decks: DECKS.concat(extraDecks) };
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

function indexedDeckFixture(deckId, chunkPayloads, datasetVersion = "a".repeat(64)) {
  const records = chunkPayloads.flat();
  const fixtureManifest = deckManifest(deckId, chunkPayloads.length);
  fixtureManifest.counts.balancedExported = records.length;
  fixtureManifest.chunks = chunkPayloads.map((chunk, index) => ({
    path: `chunks/chunk-${String(index + 1).padStart(4, "0")}.json`,
    count: chunk.length,
  }));
  fixtureManifest.selectionIndex = "selection-index.json";
  fixtureManifest.datasetVersion = datasetVersion;
  fixtureManifest.variationCounts = Object.fromEntries(records.reduce((counts, record) => {
    counts.set(record.variation, (counts.get(record.variation) || 0) + 1);
    return counts;
  }, new Map()));
  fixtureManifest.difficultyCounts = Object.fromEntries(records.reduce((counts, record) => {
    counts.set(record.difficulty, (counts.get(record.difficulty) || 0) + 1);
    return counts;
  }, new Map()));
  fixtureManifest.provenanceCounts = Object.fromEntries(records.reduce((counts, record) => {
    counts.set(record.provenance, (counts.get(record.provenance) || 0) + 1);
    return counts;
  }, new Map()));
  fixtureManifest.themeCounts = Object.fromEntries(records.reduce((counts, record) => {
    record.themes.forEach(theme => counts.set(theme, (counts.get(theme) || 0) + 1));
    return counts;
  }, new Map()));

  const entries = [];
  chunkPayloads.forEach((chunk, chunkIndex) => {
    chunk.forEach((record, chunkOffset) => {
      const primaryTheme = record.themes.find(theme => theme !== "opening")
        || record.themes[0] || "opening";
      const firstStep = record.solutionSteps[0];
      const solutionLength = record.solutionLength || record.solutionUci.length;
      entries.push({
        id: record.id,
        chunkIndex,
        chunkOffset,
        variation: record.variation,
        difficulty: record.difficulty,
        rating: record.rating,
        provenance: record.provenance,
        themes: record.themes.slice(),
        primaryTheme,
        isOpeningPuzzle: record.isOpeningPuzzle === true,
        solutionLength,
        solverDecisionCount: record.solverDecisionCount || record.solutionSteps.length,
        tacticalSignature: `${primaryTheme}|${solutionLength}|K|${firstStep.bestMoveUci.slice(2, 4)}`,
      });
    });
  });
  return {
    manifest: fixtureManifest,
    index: {
      schemaVersion: 1,
      deckId,
      datasetVersion,
      count: entries.length,
      entries,
    },
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
  chunkPayloads = null,
  chunkPayloadsByDeck = null,
  selectionIndexesByDeck = null,
  trainerEnabled = false,
  personalEnvelope = null,
  delayedPersonalEnvelope = false,
} = {}) {
  const elements = Object.fromEntries(ELEMENT_IDS.map(id => [id, new FakeElement(id)]));
  elements["caro-filter-mode"].value = "all";
  elements["caro-filter-variation"].value = "all";
  elements["caro-filter-difficulty"].value = "all";
  elements["caro-filter-provenance"].value = "all";
  elements["caro-filter-lines"].value = "all";
  elements["caro-filter-theme"].value = "all";
  elements["training-length"].value = "endless";
  elements["puzzle-progress-track"].hidden = true;
  elements["caro-puzzle-filters"].hidden = true;
  elements["puzzle-uci-form"].submitButton = new FakeElement("uci-submit");
  elements["puzzle-promotion-options"].firstPromotionButton = new FakeElement("first-promotion");

  const boards = [];
  const fetches = [];
  const timers = new Map();
  const delayedManifestResolvers = new Map();
  const delayedChunkResolvers = new Map();
  const delayedPersonalRequests = [];
  const windowListeners = Object.create(null);
  let personalAbortCount = 0;
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
  if (delayedPersonalEnvelope) {
    context.window.AbortController = class FakeAbortController {
      constructor() {
        const listeners = [];
        this.signal = {
          aborted: false,
          addEventListener(type, callback) {
            if (type === "abort") listeners.push(callback);
          },
        };
        this.abort = () => {
          if (this.signal.aborted) return;
          this.signal.aborted = true;
          personalAbortCount += 1;
          listeners.splice(0).forEach(callback => callback());
        };
      }
    };
  }
  context.window.matchMedia = query => ({ matches: query === "(pointer: coarse)" });
  context.window.addEventListener = (type, callback) => {
    windowListeners[type] = callback;
  };
  context.window.setTimeout = callback => {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, callback);
    return id;
  };
  context.window.clearTimeout = id => timers.delete(id);
  context.window.fetch = async (url, options = {}) => {
    fetches.push(String(url));
    if (String(url) === "data/opening-puzzle-catalog.json") {
      const extraDecks = personalEnvelope ? PERSONAL_BLUNDER_DECKS : [];
      return { ok: true, async json() { return catalog(extraDecks); } };
    }
    if (String(url) === "data/my-blunder-puzzles.json") {
      if (personalEnvelope && delayedPersonalEnvelope) {
        return new Promise((resolve, reject) => {
          const request = {
            resolve() {
              resolve({ ok: true, async json() { return personalEnvelope; } });
            },
          };
          delayedPersonalRequests.push(request);
          if (options.signal && typeof options.signal.addEventListener === "function") {
            options.signal.addEventListener("abort", () => {
              const error = new Error("The personal puzzle request was aborted.");
              error.name = "AbortError";
              reject(error);
            });
          }
        });
      }
      return personalEnvelope
        ? { ok: true, async json() { return personalEnvelope; } }
        : { ok: false, status: 404 };
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
    const indexMatch = String(url).match(/^data\/([^/]+)\/selection-index\.json$/);
    if (indexMatch) {
      const deckId = indexMatch[1];
      const payload = selectionIndexesByDeck && selectionIndexesByDeck[deckId];
      return payload
        ? { ok: true, async json() { return payload; } }
        : { ok: false, status: 404 };
    }
    const deckMatch = String(url).match(/^data\/([^/]+)\/chunks\/chunk-(\d+)\.json$/);
    const match = String(url).match(/chunk-(\d+)\.json$/);
    const index = match ? Number(match[1]) - 1 : 0;
    if (failedChunks.includes(index + 1)) return { ok: false, status: 503 };
    const deckRecords = recordsByDeck && deckMatch && recordsByDeck[deckMatch[1]] || records;
    const deckPayloads = chunkPayloadsByDeck && deckMatch
      && chunkPayloadsByDeck[deckMatch[1]];
    const chunkPayload = deckPayloads && deckPayloads[index]
      || chunkPayloads && chunkPayloads[index];
    if (delayedChunkUrls.includes(String(url))) {
      return new Promise(resolve => delayedChunkResolvers.set(String(url), () => resolve({
        ok: true,
        async json() { return chunkPayload || [deckRecords[index] || deckRecords[0]]; },
      })));
    }
    return { ok: true, async json() { return chunkPayload || [deckRecords[index] || deckRecords[0]]; } };
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
  if (trainerEnabled) vm.runInContext(TRAINER_DOMAIN_SOURCE, context);
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
      const key = deckId
        ? `chess-tracker:puzzle-progress:v1:${deckId}:me`
        : "chess-tracker:puzzle-progress:v1:me";
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw).records[id] || null : null;
    },
    trainerState() {
      const raw = storage.getItem("chess-tracker:opening-trainer:v2:me");
      return raw ? JSON.parse(raw) : null;
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
    resolvePersonalEnvelope() {
      const request = delayedPersonalRequests[delayedPersonalRequests.length - 1];
      assert.ok(request, "expected a delayed personal-puzzle request");
      request.resolve();
    },
    get personalAbortCount() { return personalAbortCount; },
    async settle() {
      for (let index = 0; index < 4; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    dispatchWindow(type, event = {}) {
      const callback = windowListeners[type];
      assert.ok(callback, `expected a ${type} window listener`);
      callback(event);
    },
  };
}

test("loader fetches only the balanced chunks needed to fill the finite session", async () => {
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionSize: 10 });
  const harness = await createHarness([continuationRecord(), continuationRecord()], {
    chunkCount: 2,
    storage,
    trainerEnabled: true,
  });
  assert.deepEqual(harness.fetches, [
    "data/opening-puzzle-catalog.json",
    "data/caro-kann-black/manifest.json",
    "data/caro-kann-black/chunks/chunk-0001.json",
    "data/caro-kann-black/chunks/chunk-0002.json",
  ]);
  assert.equal(CONTROLLER_SOURCE.includes("all.jsonl"), false);
});

test("indexed Focused sessions consume one shared no-repeat traversal across 5, 10, and 20", async () => {
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionMode: "finite", sessionSize: 5 });
  const chunks = Array.from({ length: 6 }, (_unused, chunkIndex) => Array.from(
    { length: 10 },
    (_entry, offset) => recordWithId(`indexed-${chunkIndex}-${offset}`),
  ));
  const fixture = indexedDeckFixture("caro-kann-black", chunks);
  const harness = await createHarness(chunks.flat(), {
    storage,
    trainerEnabled: true,
    manifestsByDeck: { "caro-kann-black": fixture.manifest },
    selectionIndexesByDeck: { "caro-kann-black": fixture.index },
    chunkPayloadsByDeck: { "caro-kann-black": chunks },
  });

  const first = harness.trainerState().selection.active.puzzleIds.slice();
  assert.equal(first.length, 5);
  assert.equal(harness.fetches.filter(url => /chunks\/chunk-/.test(url)).length, 1);

  await harness.context.CaroKannTrainer.startSession(10);
  const second = harness.trainerState().selection.active.puzzleIds.slice();
  await harness.context.CaroKannTrainer.startSession(20);
  const third = harness.trainerState().selection.active.puzzleIds.slice();

  assert.equal(second.length, 10);
  assert.equal(third.length, 20);
  assert.equal(new Set(first.concat(second, third)).size, 35);
});

test("reload resumes indexed membership and Start fresh advances without overlap", async () => {
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionMode: "finite", sessionSize: 5 });
  const chunks = Array.from({ length: 3 }, (_unused, chunkIndex) => Array.from(
    { length: 10 },
    (_entry, offset) => recordWithId(`resume-${chunkIndex}-${offset}`),
  ));
  const fixture = indexedDeckFixture("caro-kann-black", chunks, "b".repeat(64));
  const options = {
    storage,
    trainerEnabled: true,
    manifestsByDeck: { "caro-kann-black": fixture.manifest },
    selectionIndexesByDeck: { "caro-kann-black": fixture.index },
    chunkPayloadsByDeck: { "caro-kann-black": chunks },
  };
  const firstHarness = await createHarness(chunks.flat(), options);
  const original = firstHarness.trainerState().selection.active.puzzleIds.slice();
  const originalToken = firstHarness.trainerState().selection.active.token;

  const resumedHarness = await createHarness(chunks.flat(), options);
  const resumed = resumedHarness.trainerState().selection.active;
  assert.deepEqual(resumed.puzzleIds, original);
  assert.equal(resumed.token, originalToken);
  assert.equal(resumedHarness.elements["session-start-fresh"].hidden, false);

  resumedHarness.elements["session-start-fresh"].dispatch("click");
  await resumedHarness.settle();
  const fresh = resumedHarness.trainerState().selection.active;
  assert.notEqual(fresh.token, originalToken);
  assert.equal(fresh.puzzleIds.length, 5);
  assert.equal(new Set(original.concat(fresh.puzzleIds)).size, 10);
  assert.equal(resumedHarness.elements["session-start-fresh"].hidden, true);
});

test("an expired indexed membership is discarded without rewinding traversal", async () => {
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionMode: "finite", sessionSize: 5 });
  const chunks = Array.from({ length: 2 }, (_unused, chunkIndex) => Array.from(
    { length: 10 },
    (_entry, offset) => recordWithId(`expired-${chunkIndex}-${offset}`),
  ));
  const fixture = indexedDeckFixture("caro-kann-black", chunks, "c".repeat(64));
  const options = {
    storage,
    trainerEnabled: true,
    manifestsByDeck: { "caro-kann-black": fixture.manifest },
    selectionIndexesByDeck: { "caro-kann-black": fixture.index },
    chunkPayloadsByDeck: { "caro-kann-black": chunks },
  };
  const firstHarness = await createHarness(chunks.flat(), options);
  const original = firstHarness.trainerState().selection.active.puzzleIds.slice();
  const envelope = firstHarness.trainerState();
  envelope.selection.active.expiresAt = "2000-01-01T00:00:00.000Z";
  storage.setItem("chess-tracker:opening-trainer:v2:me", JSON.stringify(envelope));

  const reloadedHarness = await createHarness(chunks.flat(), options);
  const replacement = reloadedHarness.trainerState().selection.active.puzzleIds;
  assert.equal(new Set(original.concat(replacement)).size, 10);
  assert.equal(reloadedHarness.elements["session-start-fresh"].hidden, true);
});

test("a partial indexed chunk failure preserves membership and blocks a compacted session", async () => {
  const storage = new MemoryStorage();
  const chunks = Array.from({ length: 2 }, (_unused, chunkIndex) => Array.from(
    { length: 3 },
    (_entry, offset) => recordWithId(`partial-${chunkIndex}-${offset}`),
  ));
  const dueIds = chunks.flat().slice(0, 5).map(record => record.id);
  const dueAt = "2026-08-01T12:00:00.000Z";
  seedTrainerState(storage, {
    sessionMode: "finite",
    sessionSize: 5,
    reviews: Object.fromEntries(dueIds.map(id => [id, {
      encounters: 1,
      dueAt,
      updatedAt: dueAt,
    }])),
  });
  const fixture = indexedDeckFixture("caro-kann-black", chunks, "d".repeat(64));
  const harness = await createHarness(chunks.flat(), {
    storage,
    trainerEnabled: true,
    failedChunks: [2],
    manifestsByDeck: { "caro-kann-black": fixture.manifest },
    selectionIndexesByDeck: { "caro-kann-black": fixture.index },
    chunkPayloadsByDeck: { "caro-kann-black": chunks },
  });

  assert.deepEqual(harness.trainerState().selection.active.puzzleIds, dueIds);
  assert.match(harness.elements["puzzle-page-state"].innerHTML, /couldn’t be downloaded/i);
  assert.equal(harness.fetches.some(url => /chunk-0002\.json$/.test(url)), true);
  assert.equal(harness.elements["puzzle-workspace"].hidden, true);
});

test("ordinary indexed training excludes permanently solved Due puzzles until explicit review", async () => {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 10 }, (_unused, index) =>
    recordWithId(`solved-due-${index + 1}`)
  );
  const solved = records[0];
  const dueAt = "2026-08-01T12:00:00.000Z";
  seedSolved(storage, [solved.id]);
  seedTrainerState(storage, {
    sessionMode: "finite",
    sessionSize: 5,
    reviews: {
      [solved.id]: {
        deckId: "caro-kann-black",
        puzzleId: solved.id,
        encounters: 1,
        dueAt,
        updatedAt: dueAt,
      },
    },
  });
  const fixture = indexedDeckFixture("caro-kann-black", [records], "e".repeat(64));
  const harness = await createHarness(records, {
    storage,
    trainerEnabled: true,
    manifestsByDeck: { "caro-kann-black": fixture.manifest },
    selectionIndexesByDeck: { "caro-kann-black": fixture.index },
    chunkPayloadsByDeck: { "caro-kann-black": [records] },
  });

  assert.equal(
    harness.trainerState().selection.active.puzzleIds.includes(solved.id),
    false,
  );
  assert.equal(harness.elements["reviews-due-button"].textContent, "Reviews due: 1");

  harness.elements["reviews-due-button"].dispatch("click");
  await harness.settle();
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 1);
  assert.equal(harness.elements["puzzle-review-state"].textContent, "Due");
});

test("catalog dropdown exposes all five opening decks", async () => {
  const harness = await createHarness([continuationRecord()]);
  const options = harness.elements["opening-puzzle-deck"].innerHTML;
  ["caro-kann-black", "colle-white", "englund-white", "pirc-black", "modern-black"]
    .forEach(deckId => assert.match(options, new RegExp(`value="${deckId}"`)));
});

test("My Blunders ALL loads its export, follows each puzzle color, and reuses personal progress", async () => {
  const opening = continuationRecord();
  const white = personalBlunderRecord("white");
  const black = personalBlunderRecord("black");
  const harness = await createHarness([opening], {
    personalEnvelope: {
      schemaVersion: 1,
      generatedAt: "2026-08-05T04:00:00.000Z",
      username: "ME",
      catalog: {
        candidates: [white, black],
        coverage: { eligible_candidates: 2 },
        errors: [],
      },
    },
  });

  assert.match(
    harness.elements["opening-puzzle-deck"].innerHTML,
    /value="my-blunders-all">My Blunders — ALL/,
  );
  assert.equal(await harness.context.CaroKannTrainer.selectDeck("my-blunders-all"), true);
  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "my-blunders-all");
  assert.equal(harness.fetches.includes("data/my-blunder-puzzles.json"), true);
  assert.equal(harness.fetches.some(url => url.includes("my-blunders-all/manifest")), false);

  const recordsByColor = { white, black };
  const firstColor = harness.board.config.orientation;
  const first = recordsByColor[firstColor];
  assert.ok(first);
  assert.equal(harness.board.config.fen, first.fen_before);
  assert.equal(harness.board.config.turnColor, firstColor);
  assert.equal(harness.board.config.movable.color, firstColor);

  const answer = first.solution_steps[0].best_move_uci;
  harness.board.config.movable.events.after(answer.slice(0, 2), answer.slice(2, 4));
  assert.equal(harness.progress(first.puzzle_id, null).status, "solved");
  assert.equal(
    harness.storage.getItem("chess-tracker:puzzle-progress:v1:my-blunders-all:me"),
    null,
  );
  assert.equal(harness.elements["puzzles-solved-count"].textContent, "(1)");

  harness.elements["puzzle-continue"].dispatch("click");
  await harness.settle();
  const secondColor = harness.board.config.orientation;
  const second = recordsByColor[secondColor];
  assert.ok(second);
  assert.notEqual(secondColor, firstColor);
  assert.equal(harness.board.config.fen, second.fen_before);
  assert.equal(harness.board.config.turnColor, secondColor);
  assert.equal(harness.board.config.movable.color, secondColor);

  assert.equal(await harness.context.CaroKannTrainer.selectDeck("caro-kann-black"), true);
  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "caro-kann-black");
  assert.equal(harness.board.config.fen, opening.puzzleFen);
  assert.equal(harness.board.config.orientation, "black");
  assert.equal(harness.board.config.movable.color, "black");
  assert.equal(harness.progress(opening.id), null);
  assert.equal(harness.progress(first.puzzle_id, null).status, "solved");
  assert.equal(
    harness.fetches.filter(url => url === "data/my-blunder-puzzles.json").length,
    1,
  );
});

test("My Blunders starts fresh across reloads and circulates recent batches before reuse", async () => {
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionMode: "finite", sessionSize: 5 });
  const candidates = Array.from({ length: 20 }, (_unused, index) => {
    const candidate = personalBlunderRecord("white", `personal-circulation-${index + 1}`);
    candidate.opening = index < 10
      ? "Colle System: Main Line" : "Colle System: Rare Sideline";
    return candidate;
  });
  const mainLineIds = new Set(candidates.slice(0, 10).map(candidate => candidate.puzzle_id));
  const personalEnvelope = {
    schemaVersion: 1,
    generatedAt: "2026-08-05T04:00:00.000Z",
    username: "me",
    catalog: {
      candidates,
      coverage: { eligible_candidates: candidates.length },
      errors: [],
    },
  };
  const options = { storage, trainerEnabled: true, personalEnvelope };

  const firstHarness = await createHarness([continuationRecord()], options);
  assert.equal(await firstHarness.context.CaroKannTrainer.selectDeck("my-blunders-all"), true);
  const first = firstHarness.trainerState().selection.active.puzzleIds.slice();

  const stored = firstHarness.trainerState();
  const dueAt = "2026-08-01T12:00:00.000Z";
  stored.reviews["my-blunders-all"] = {
    [first[0]]: {
      deckId: "my-blunders-all",
      puzzleId: first[0],
      encounters: 1,
      dueAt,
      updatedAt: dueAt,
    },
  };
  storage.setItem("chess-tracker:opening-trainer:v2:me", JSON.stringify(stored));

  const reloadedHarness = await createHarness([continuationRecord()], options);
  assert.equal(reloadedHarness.context.CaroKannTrainer.selectedDeckId, "my-blunders-all");
  const second = reloadedHarness.trainerState().selection.active.puzzleIds.slice();
  assert.equal(first.length, 5);
  assert.equal(second.length, 5);
  assert.equal(new Set(first.concat(second)).size, 10);
  assert.equal(second.includes(first[0]), false, "personal Due items do not bypass circulation");

  reloadedHarness.elements["session-start-fresh"].dispatch("click");
  await reloadedHarness.settle();
  const third = reloadedHarness.trainerState().selection.active.puzzleIds.slice();
  assert.equal(third.length, 5);
  assert.equal(new Set(first.concat(second, third)).size, 15);

  reloadedHarness.elements["session-start-fresh"].dispatch("click");
  await reloadedHarness.settle();
  const fourth = reloadedHarness.trainerState().selection.active.puzzleIds.slice();
  assert.equal(fourth.length, 5);
  assert.equal(new Set(first.concat(second, third, fourth)).size, 20);

  reloadedHarness.elements["caro-filter-lines"].value = "main-lines";
  reloadedHarness.elements["customize-apply"].dispatch("click");
  await reloadedHarness.settle();
  assert.equal(
    reloadedHarness.trainerState().selection.active.puzzleIds.every(id => mainLineIds.has(id)),
    true,
  );
});

test("My Blunders shares monotonic solved progress across filters and reviews it only explicitly", async () => {
  const storage = new MemoryStorage();
  const candidates = Array.from({ length: 12 }, (_unused, index) =>
    personalBlunderRecord("white", `personal-shared-solved-${index + 1}`)
  );
  const solved = candidates[0];
  const dueAt = "2026-08-01T12:00:00.000Z";
  seedPersonalSolved(storage, [solved.puzzle_id]);
  seedTrainerState(storage, {
    sessionMode: "finite",
    sessionSize: 5,
    reviewsByDeck: {
      "my-blunders-colle": {
        [solved.puzzle_id]: {
          encounters: 1,
          dueAt,
          updatedAt: dueAt,
        },
      },
      "my-blunders-all": {
        [solved.puzzle_id]: {
          encounters: 1,
          dueAt,
          updatedAt: dueAt,
        },
      },
    },
  });
  const harness = await createHarness([continuationRecord()], {
    storage,
    trainerEnabled: true,
    personalEnvelope: {
      schemaVersion: 1,
      generatedAt: "2026-08-05T04:00:00.000Z",
      username: "me",
      catalog: {
        candidates,
        coverage: { eligible_candidates: candidates.length },
        errors: [],
      },
    },
  });

  assert.equal(await harness.context.CaroKannTrainer.selectDeck("my-blunders-colle"), true);
  assert.equal(
    harness.trainerState().selection.active.puzzleIds.includes(solved.puzzle_id),
    false,
  );
  assert.equal(harness.progress(solved.puzzle_id, null).status, "solved");

  assert.equal(await harness.context.CaroKannTrainer.selectDeck("my-blunders-all"), true);
  assert.equal(
    harness.trainerState().selection.active.puzzleIds.includes(solved.puzzle_id),
    false,
  );
  assert.equal(harness.progress(solved.puzzle_id, null).status, "solved");
  assert.equal(harness.elements["puzzles-solved-count"].textContent, "(1)");
  assert.equal(harness.elements["reviews-due-button"].textContent, "Reviews due: 1");

  harness.elements["reviews-due-button"].dispatch("click");
  await harness.settle();
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 1);
  assert.equal(harness.elements["puzzle-review-state"].textContent, "Due");
});

test("a rapid personal-deck switch survives aborting a slow shared blunder export", async () => {
  const white = personalBlunderRecord("white");
  const harness = await createHarness([continuationRecord()], {
    delayedPersonalEnvelope: true,
    personalEnvelope: {
      schemaVersion: 1,
      generatedAt: "2026-08-05T04:00:00.000Z",
      username: "me",
      catalog: {
        candidates: [white, personalBlunderRecord("black")],
        coverage: { eligible_candidates: 2 },
        errors: [],
      },
    },
  });

  const stale = harness.context.CaroKannTrainer.selectDeck("my-blunders-all");
  await harness.settle();
  const latest = harness.context.CaroKannTrainer.selectDeck("my-blunders-colle");
  await harness.settle();
  assert.ok(harness.personalAbortCount > 0);

  harness.resolvePersonalEnvelope();
  assert.equal(await stale, false);
  assert.equal(await latest, true);
  assert.equal(harness.context.CaroKannTrainer.selectedDeckId, "my-blunders-colle");
  assert.equal(harness.board.config.fen, white.fen_before);
  assert.equal(harness.board.config.orientation, "white");
  assert.equal(harness.board.config.movable.color, "white");
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
  assert.equal(
    harness.elements["puzzles-title"].textContent,
    "Chess Opening Puzzle Trainer"
  );
  assert.equal(harness.elements["puzzle-side-to-move"].textContent, "White to move");
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
  const firstCaroChunk = [caro].concat(Array.from({ length: 9 }, (_unused, index) =>
    recordWithId(`caro-session-filler-${index + 1}`)
  ));
  const firstColleChunk = [colle].concat(Array.from({ length: 9 }, (_unused, index) =>
    whiteDeckRecord(`colle-session-filler-${index + 1}`)
  ));
  const harness = await createHarness([caro, saved], {
    chunkCount: 2,
    storage,
    recordsByDeck: {
      "caro-kann-black": [caro, saved],
      "colle-white": [colle],
    },
    chunkPayloadsByDeck: {
      "caro-kann-black": [firstCaroChunk, [saved]],
      "colle-white": [firstColleChunk],
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

test("short variation lists use the primary native select and apply immediately", async () => {
  const advance = recordWithId("primary-variation-advance");
  const exchange = exchangeRecord("primary-variation-exchange");
  const harness = await createHarness([advance, exchange], {
    chunkPayloads: [[advance, exchange]],
  });

  assert.equal(harness.elements["caro-filter-variation"].hidden, false);
  assert.equal(harness.elements["variation-picker"].hidden, true);
  assert.equal(harness.elements["caro-filter-variation"].value, "all");

  harness.elements["caro-filter-variation"].value = exchange.variation;
  harness.elements["caro-filter-variation"].dispatch("change");
  await harness.settle();

  assert.equal(harness.elements["caro-filter-variation"].value, exchange.variation);
  assert.equal(harness.board.config.fen, exchange.puzzleFen);
  assert.match(harness.elements["active-filter-chips"].innerHTML, /Exchange Variation/);
});

test("long variation lists reuse Customize search through the primary picker", async () => {
  const puzzle = recordWithId("long-variation-current");
  const longManifest = deckManifest("caro-kann-black", 1);
  longManifest.variationCounts = Object.fromEntries(Array.from(
    { length: 13 },
    (_unused, index) => [`Caro-Kann Defense: Branch ${index + 1}`, 1],
  ));
  const harness = await createHarness([puzzle], {
    manifestsByDeck: { "caro-kann-black": longManifest },
  });

  assert.equal(harness.elements["caro-filter-variation"].hidden, true);
  assert.equal(harness.elements["variation-picker"].hidden, false);
  assert.equal(harness.elements["variation-picker"].textContent, "All variations");

  harness.elements["variation-picker"].dispatch("click");
  assert.equal(harness.elements["caro-puzzle-filters"].hidden, false);
  assert.equal(harness.elements["customize-search"].focused, true);

  const choice = {
    dataset: { choiceValue: "Caro-Kann Defense: Branch 7" },
    closest(selector) { return selector === "button[data-choice-value]" ? this : null; },
  };
  harness.elements["variation-choice-list"].dispatch("click", { target: choice });
  assert.equal(harness.elements["variation-picker"].textContent, "Caro-Kann Defense: Branch 7");
  assert.match(
    harness.elements["variation-picker"].getAttribute("aria-label"),
    /Current: Caro-Kann Defense: Branch 7/,
  );
});

test("opening an empty solved archive does not fetch more chunks", async () => {
  const harness = await createHarness([
    recordWithId("archive-current"),
    recordWithId("archive-later"),
  ], { chunkCount: 2 });
  assert.equal(harness.fetches.length, 3, "Endless starts from the downloaded pool");
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
  const firstChunk = [current].concat(Array.from({ length: 9 }, (_unused, index) =>
    recordWithId(`archive-session-filler-${index + 1}`)
  ));
  seedSolved(storage, [solved.id]);
  const harness = await createHarness([current, solved, later], {
    chunkCount: 3,
    storage,
    chunkPayloads: [firstChunk, [solved], [later]],
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
  assert.match(
    harness.elements["puzzle-storage-warning"].innerHTML,
    /Some positions couldn’t be loaded.*retry the deck/i,
  );
});

test("changing to a filter with no loaded unsolved match loads later chunks", async () => {
  const advance = recordWithId("loaded-advance");
  const exchange = exchangeRecord("later-exchange");
  const advanceChunk = [advance].concat(Array.from({ length: 9 }, (_unused, index) =>
    recordWithId(`advance-session-filler-${index + 1}`)
  ));
  const harness = await createHarness([advance, exchange], {
    chunkCount: 2,
    chunkPayloads: [advanceChunk, [exchange]],
  });
  assert.equal(harness.fetches.length, 3);

  harness.elements["caro-filter-variation"].value = exchange.variation;
  harness.elements["customize-apply"].dispatch("click");
  await harness.settle();
  assert.equal(harness.fetches.length, 4);
  assert.match(harness.fetches[3], /chunk-0002\.json$/);
  assert.equal(harness.elements["caro-filter-variation"].value, exchange.variation);
  assert.equal(harness.board.config.fen, exchange.puzzleFen);
});

test("advanced line coverage filters main lines and sidelines independently of study mode", async () => {
  const mainLine = recordWithId("line-coverage-main");
  const sideline = recordWithId("line-coverage-side");
  sideline.variation = "Caro-Kann Defense: Hillbilly Attack";
  sideline.openingTags = ["Caro-Kann_Defense_Hillbilly_Attack"];
  sideline.puzzleFen = sideline.puzzleFen.replace(" 3 47", " 5 47");
  sideline.solutionSteps[0].fenBefore = sideline.puzzleFen;
  const harness = await createHarness([mainLine, sideline], {
    chunkPayloads: [[mainLine, sideline]],
  });

  assert.equal(harness.elements["caro-filter-mode"].value, "all");
  harness.elements["caro-filter-lines"].value = "main-lines";
  harness.elements["customize-apply"].dispatch("click");
  await harness.settle();

  assert.equal(harness.elements["caro-filter-mode"].value, "all");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.mode, "endless");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, null);
  assert.equal(harness.board.config.fen, mainLine.puzzleFen);
  assert.match(harness.elements["active-filter-chips"].innerHTML, /data-clear-filter="lineCoverage"/);
  assert.match(harness.elements["active-filter-chips"].innerHTML, /Main lines/);

  harness.elements["caro-filter-mode"].value = "curriculum";
  harness.elements["caro-filter-lines"].value = "sidelines";
  harness.elements["customize-apply"].dispatch("click");
  await harness.settle();

  assert.equal(harness.elements["caro-filter-mode"].value, "curriculum");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.mode, "endless");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, null);
  assert.equal(harness.board.config.fen, sideline.puzzleFen);
  assert.match(harness.elements["active-filter-chips"].innerHTML, /Sidelines/);
});

test("the visible Clear filters empty-state action resets every filter and restarts training", async () => {
  const advance = recordWithId("clear-filters-advance");
  const exchange = exchangeRecord("clear-filters-exchange");
  const harness = await createHarness([advance, exchange], {
    chunkPayloads: [[advance, exchange]],
  });

  harness.elements["caro-filter-mode"].value = "curriculum";
  harness.elements["caro-filter-variation"].value = exchange.variation;
  harness.elements["caro-filter-difficulty"].value = "expert";
  harness.elements["caro-filter-provenance"].value = "master";
  harness.elements["caro-filter-lines"].value = "sidelines";
  harness.elements["caro-filter-theme"].value = "pins";
  harness.elements["caro-filter-opening"].checked = true;
  harness.elements["customize-search"].value = "exchange";
  harness.elements["customize-apply"].dispatch("click");
  await harness.settle();

  assert.equal(harness.elements["puzzle-page-state"].hidden, false);
  assert.equal(harness.elements["puzzle-workspace"].hidden, true);
  assert.match(harness.elements["puzzle-page-state"].innerHTML, /No puzzles match these filters/);
  assert.match(harness.elements["puzzle-page-state"].innerHTML, /data-clear-filters/);

  const clearFiltersButton = {
    closest(selector) {
      return selector === "[data-clear-filters]" ? this : null;
    },
  };
  harness.elements["puzzle-page-state"].dispatch("click", { target: clearFiltersButton });
  await harness.settle();

  assert.equal(harness.elements["caro-filter-mode"].value, "all");
  assert.equal(harness.elements["caro-filter-variation"].value, "all");
  assert.equal(harness.elements["caro-filter-difficulty"].value, "all");
  assert.equal(harness.elements["caro-filter-provenance"].value, "all");
  assert.equal(harness.elements["caro-filter-lines"].value, "all");
  assert.equal(harness.elements["caro-filter-theme"].value, "all");
  assert.equal(harness.elements["caro-filter-opening"].checked, false);
  assert.equal(harness.elements["customize-search"].value, "");
  assert.equal(harness.elements["puzzle-page-state"].hidden, true);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, null);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.mode, "endless");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 0);
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1");
  assert.equal(harness.board.config.movable.color, "black");
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
  assert.match(elements["puzzle-feedback"].innerHTML, /✓ Correct.*White replied Ke4/);
  assert.equal(elements["puzzle-side-to-move"].textContent, "Black to move · 2 of 2");

  board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress().status, "solved");
  assert.equal(harness.progress().attempts, 1);
  assert.equal(board.config.orientation, "black");
  assert.match(elements["puzzle-feedback"].innerHTML, /✓ Line complete/);
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

test("wrong, illegal, hinted, revealed, reset, and skipped actions preserve permanent solve semantics", async () => {
  const wrongHarness = await createHarness([continuationRecord()]);
  wrongHarness.board.config.movable.events.after("d2", "d1");
  assert.equal(wrongHarness.progress().status, "unsolved");
  assert.match(wrongHarness.elements["puzzle-feedback"].innerHTML, /× Try again/);
  wrongHarness.flushTimer();
  assert.equal(wrongHarness.board.config.fen, continuationRecord().puzzleFen);

  const actionHarness = await createHarness([continuationRecord()]);
  actionHarness.board.config.movable.events.after("d2", "c2");
  assert.equal(actionHarness.progress(), null, "illegal moves are not attempts or solves");
  actionHarness.elements["puzzle-hint"].dispatch("click");
  assert.equal(actionHarness.progress(), null, "hints do not create solved progress");
  actionHarness.elements["puzzle-reset"].dispatch("click");
  assert.equal(actionHarness.progress(), null, "reset does not solve");
  actionHarness.elements["puzzle-show"].dispatch("click");
  assert.equal(actionHarness.progress().status, "unsolved");
  assert.equal(actionHarness.progress().attempts, 0);
  assert.match(actionHarness.elements["puzzle-feedback"].innerHTML, /Solution revealed/);
  assert.equal(actionHarness.elements["puzzle-queue-position"].textContent, "Puzzle 1");
  assert.equal(actionHarness.elements["trainer-header-progress"].textContent, "1 trained");
  assert.match(actionHarness.elements["puzzle-context-body"].innerHTML, /Qc3\+/);
  actionHarness.elements["puzzle-continue"].dispatch("click");
  await actionHarness.settle();
  assert.equal(actionHarness.progress().status, "unsolved", "revealing does not solve");

  const skipHarness = await createHarness([continuationRecord()]);
  skipHarness.elements["puzzle-skip"].dispatch("click");
  await skipHarness.settle();
  assert.equal(skipHarness.progress(), null, "skip does not create permanent solved progress");
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

test("training defaults to Endless without a completion boundary", async () => {
  const records = Array.from({ length: 6 }, (_unused, index) =>
    recordWithId(`endless-default-${index + 1}`)
  );
  const harness = await createHarness(records, {
    chunkPayloads: [records],
    trainerEnabled: true,
  });

  assert.equal(harness.elements["training-length"].value, "endless");
  assert.equal(harness.trainerState().preferences.sessionMode, "endless");
  assert.equal(harness.trainerState().preferences.sessionSize, 10);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "0 trained");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1");
  assert.equal(harness.elements["puzzle-progress-track"].hidden, true);
  assert.equal(harness.elements["session-restart"].hidden, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.context.CaroKannTrainer.sessionSummary)),
    { completed: 0, total: null, complete: false, mode: "endless" },
  );

  harness.elements["puzzle-skip"].dispatch("click");
  await harness.settle();
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 1);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.complete, false);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "1 trained");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 2");
  assert.equal(harness.elements["session-complete"].hidden, true);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
});

test("Endless rolls past its internal batch without showing a summary or resetting its counter", async () => {
  const records = Array.from({ length: 21 }, (_unused, index) =>
    recordWithId(`endless-rollover-${index + 1}`)
  );
  const harness = await createHarness(records, {
    chunkCount: 2,
    chunkPayloads: [records.slice(0, 20), records.slice(20)],
    trainerEnabled: true,
  });

  assert.equal(harness.fetches.some(url => /chunk-0002\.json$/.test(url)), false);

  for (let index = 0; index < 20; index += 1) {
    harness.elements["puzzle-skip"].dispatch("click");
    await harness.settle();
  }

  assert.equal(harness.elements["session-complete"].hidden, true);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 21");
  assert.equal(harness.elements["trainer-header-progress"].textContent, "20 trained");
  assert.equal(harness.elements["puzzle-progress-track"].hidden, true);
  assert.equal(harness.fetches.some(url => /chunk-0002\.json$/.test(url)), true);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 20);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.complete, false);
});

test("choosing a finite training length persists and restores the session goal", async () => {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 10 }, (_unused, index) =>
    recordWithId(`finite-choice-${index + 1}`)
  );
  const first = await createHarness(records, {
    storage,
    chunkPayloads: [records],
    trainerEnabled: true,
  });

  first.elements["training-length"].value = "5";
  first.elements["training-length"].dispatch("change");
  await first.settle();

  assert.equal(first.trainerState().preferences.sessionMode, "finite");
  assert.equal(first.trainerState().preferences.sessionSize, 5);
  assert.equal(first.elements["training-length"].value, "5");
  assert.equal(first.elements["trainer-header-progress"].textContent, "1 / 5");
  assert.equal(first.elements["puzzle-queue-position"].textContent, "Puzzle 1 of 5");
  assert.equal(first.elements["puzzle-progress-track"].hidden, false);
  assert.equal(first.elements["session-restart"].hidden, false);
  assert.equal(first.context.CaroKannTrainer.sessionSummary.total, 5);

  const reloaded = await createHarness(records, {
    storage,
    chunkPayloads: [records],
    trainerEnabled: true,
  });
  assert.equal(reloaded.elements["training-length"].value, "5");
  assert.equal(reloaded.trainerState().preferences.sessionMode, "finite");
  assert.equal(reloaded.trainerState().preferences.sessionSize, 5);
  assert.equal(reloaded.elements["trainer-header-progress"].textContent, "1 / 5");
  assert.equal(reloaded.elements["puzzle-progress-track"].hidden, false);
  assert.equal(reloaded.context.CaroKannTrainer.sessionSummary.total, 5);
});

test("five-puzzle sessions summarize hint, reveal, retry, skip, and clean outcomes", async () => {
  const records = Array.from({ length: 5 }, (_unused, index) =>
    recordWithId(`session-outcome-${index + 1}`)
  );
  const storage = new MemoryStorage();
  seedTrainerState(storage, { sessionSize: 5 });
  const harness = await createHarness(records, {
    chunkCount: 1,
    chunkPayloads: [records],
    storage,
    trainerEnabled: true,
  });

  const solveCurrentLine = () => {
    harness.board.config.movable.events.after("d2", "c3");
    harness.flushTimer();
    harness.board.config.movable.events.after("c3", "d2");
  };
  const continueToNext = async () => {
    harness.elements["puzzle-continue"].dispatch("click");
    await harness.settle();
  };

  assert.equal(harness.elements["trainer-header-progress"].textContent, "1 / 5");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1 of 5");

  harness.elements["puzzle-hint"].dispatch("click");
  assert.match(harness.elements["puzzle-feedback"].textContent, /^Hint:/);
  solveCurrentLine();
  await continueToNext();

  harness.elements["puzzle-show"].dispatch("click");
  assert.match(harness.elements["puzzle-feedback"].innerHTML, /Solution revealed/);
  assert.match(harness.elements["puzzle-context-body"].innerHTML, /Qc3\+/);
  await continueToNext();

  harness.board.config.movable.events.after("d2", "d1");
  assert.match(harness.elements["puzzle-feedback"].innerHTML, /× Try again/);
  harness.flushTimer();
  solveCurrentLine();
  await continueToNext();

  harness.elements["puzzle-skip"].dispatch("click");
  await harness.settle();

  solveCurrentLine();
  assert.equal(harness.elements["puzzle-continue"].textContent, "View session results");
  await continueToNext();

  const summary = harness.context.CaroKannTrainer.sessionSummary;
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    completed: 5,
    total: 5,
    firstTryCorrect: 2,
    firstTryAccuracy: 40,
    unassisted: 1,
    hints: 1,
    reveals: 1,
    skips: 1,
    weakVariations: [{ name: "Caro-Kann Defense: Advance Variation", count: 4 }],
    weakThemes: [{ name: "fork", count: 4 }, { name: "opening", count: 4 }],
    mistakeIds: Array.from(summary.mistakeIds),
    complete: true,
  });
  assert.equal(summary.mistakeIds.length, 4);
  assert.equal(harness.elements["session-complete"].hidden, false);
  assert.equal(harness.elements["puzzle-workspace"].hidden, true);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "5 / 5");
  ["Puzzles completed", "First-try accuracy", "Unassisted solves", "Hints used", "Solutions revealed"]
    .forEach(label => assert.match(harness.elements["session-results"].innerHTML, new RegExp(label)));
  assert.equal(harness.elements["session-review-mistakes"].hidden, false);

  const trainerState = harness.trainerState();
  const reviews = Object.values(trainerState.reviews["caro-kann-black"]);
  assert.equal(reviews.length, 5);
  assert.deepEqual(
    reviews.map(review => review.lastOutcome).sort(),
    ["hinted-solve", "revealed", "solved-after-mistake", "skipped", "clean-solve"].sort(),
  );
  assert.equal(reviews.reduce((total, review) => total + review.hints, 0), 1);
  assert.equal(reviews.reduce((total, review) => total + review.reveals, 0), 1);
  assert.equal(reviews.reduce((total, review) => total + review.skips, 0), 1);
  assert.equal(reviews.reduce((total, review) => total + review.totalIncorrect, 0), 1);
  assert.equal(reviews.reduce((total, review) => total + review.unassistedSolves, 0), 1);

  const permanent = JSON.parse(harness.storage.getItem(
    "chess-tracker:puzzle-progress:v1:caro-kann-black:me",
  )).records;
  assert.equal(Object.values(permanent).filter(record => record.status === "solved").length, 3);
  assert.equal(Object.values(permanent).filter(record => record.solutionRevealedAt).length, 1);
});

test("adaptive sessions include Due reviews but leave not-yet-due Learning items spaced", async () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const learning = recordWithId("adaptive-learning-later");
  const due = recordWithId("adaptive-due-now");
  const newCandidates = Array.from({ length: 4 }, (_unused, index) =>
    recordWithId(`adaptive-new-${index + 1}`)
  );
  seedTrainerState(storage, {
    sessionSize: 5,
    reviews: {
      [learning.id]: {
        deckId: "caro-kann-black",
        puzzleId: learning.id,
        encounters: 1,
        cleanSolves: 1,
        firstTrySolves: 1,
        unassistedSolves: 1,
        correctStreak: 1,
        intervalDays: 1,
        dueAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        lastOutcome: "clean-solve",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      [due.id]: {
        deckId: "caro-kann-black",
        puzzleId: due.id,
        encounters: 1,
        assistedSolves: 1,
        lapses: 1,
        dueAt: new Date(now - 60 * 1000).toISOString(),
        lastSeenAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        lastOutcome: "hinted-solve",
        mistakeAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now - 60 * 1000).toISOString(),
      },
    },
  });
  const candidates = [learning, due, ...newCandidates];
  const harness = await createHarness(candidates, {
    storage,
    chunkPayloads: [candidates],
    trainerEnabled: true,
  });

  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 5);
  assert.equal(harness.elements["puzzle-review-state"].textContent, "Due");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1 of 5");

  for (let index = 0; index < 5; index += 1) {
    harness.elements["puzzle-skip"].dispatch("click");
    await harness.settle();
  }

  const mistakeIds = Array.from(harness.context.CaroKannTrainer.sessionSummary.mistakeIds).sort();
  assert.deepEqual(mistakeIds, [due.id, ...newCandidates.map(candidate => candidate.id)].sort());
  assert.equal(mistakeIds.includes(learning.id), false);

  const reviews = harness.trainerState().reviews["caro-kann-black"];
  assert.equal(reviews[learning.id].encounters, 1);
  assert.equal(reviews[learning.id].lastOutcome, "clean-solve");
  assert.equal(reviews[due.id].encounters, 2);
  assert.equal(reviews[due.id].lastOutcome, "skipped");
  newCandidates.forEach(candidate => {
    assert.equal(reviews[candidate.id].encounters, 1);
    assert.equal(reviews[candidate.id].lastOutcome, "skipped");
  });
});

test("short mistake reviews preserve the normal session-size preference", async () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const mistakeCandidates = Array.from({ length: 3 }, (_unused, index) =>
    recordWithId(`short-review-mistake-${index + 1}`)
  );
  const normalCandidates = Array.from({ length: 10 }, (_unused, index) =>
    recordWithId(`normal-session-${index + 1}`)
  );
  const reviews = Object.fromEntries(mistakeCandidates.map((candidate, index) => [candidate.id, {
    deckId: "caro-kann-black",
    puzzleId: candidate.id,
    encounters: 1,
    lapses: 1,
    skips: 1,
    dueAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    lastSeenAt: new Date(now - index * 1000).toISOString(),
    lastOutcome: "skipped",
    mistakeAt: new Date(now - index * 1000).toISOString(),
    createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now - index * 1000).toISOString(),
  }]));
  seedTrainerState(storage, { sessionSize: 10, reviews });
  const candidates = [...mistakeCandidates, ...normalCandidates];
  const harness = await createHarness(candidates, {
    storage,
    chunkPayloads: [candidates],
    trainerEnabled: true,
  });

  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 10);
  assert.equal(harness.trainerState().preferences.sessionSize, 10);

  assert.equal(await harness.context.CaroKannTrainer.reviewMistakes(), true);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 3);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "1 / 3");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1 of 3");
  assert.equal(harness.trainerState().preferences.sessionSize, 10);

  for (let index = 0; index < 3; index += 1) {
    harness.elements["puzzle-skip"].dispatch("click");
    await harness.settle();
  }
  assert.equal(harness.elements["session-complete"].hidden, false);

  harness.elements["session-start-another"].dispatch("click");
  await harness.settle();
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 10);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 0);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "1 / 10");
  assert.equal(harness.elements["puzzle-queue-position"].textContent, "Puzzle 1 of 10");
  assert.equal(harness.trainerState().preferences.sessionSize, 10);
});

test("missing saved reviews are pruned after a full scan without replacing the active session", async () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const staleId = "review-no-longer-in-deck";
  seedTrainerState(storage, {
    sessionSize: 10,
    reviews: {
      [staleId]: {
        deckId: "caro-kann-black",
        puzzleId: staleId,
        encounters: 1,
        lapses: 1,
        skips: 1,
        dueAt: new Date(now - 60 * 1000).toISOString(),
        lastSeenAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        lastOutcome: "skipped",
        mistakeAt: new Date(now - 60 * 1000).toISOString(),
        createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now - 60 * 1000).toISOString(),
      },
    },
  });
  const firstChunk = Array.from({ length: 10 }, (_unused, index) =>
    recordWithId(`stale-review-current-${index + 1}`)
  );
  const finalChunk = [recordWithId("stale-review-final-scan")];
  const harness = await createHarness([...firstChunk, ...finalChunk], {
    chunkCount: 2,
    storage,
    chunkPayloads: [firstChunk, finalChunk],
    trainerEnabled: true,
  });

  const initialFen = harness.board.config.fen;
  assert.equal(harness.fetches.length, 3, "normal session does not need the final chunk");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 10);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 0);
  assert.equal(harness.elements["reviews-due-button"].textContent, "Reviews due: 1");
  assert.equal(harness.elements["review-mistakes-button"].hidden, false);

  assert.equal(await harness.context.CaroKannTrainer.reviewMistakes(), false);
  assert.equal(harness.fetches.length, 4, "the missing review triggers a complete chunk scan");
  assert.match(harness.fetches[3], /chunk-0002\.json$/);
  assert.match(harness.elements["puzzle-storage-warning"].innerHTML, /no longer available/i);
  assert.equal(harness.elements["reviews-due-button"].textContent, "Reviews due: 0");
  assert.equal(harness.elements["reviews-due-button"].disabled, true);
  assert.equal(harness.elements["review-mistakes-button"].hidden, true);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 10);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 0);
  assert.equal(harness.elements["trainer-header-progress"].textContent, "1 / 10");
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.equal(harness.board.config.fen, initialFen);

  assert.equal(await harness.context.CaroKannTrainer.reviewMistakes(), false);
  assert.equal(harness.fetches.length, 4, "a pruned mistake is not searched for again");
});

test("searching custom role-radio choices keeps one visible option in the tab order", async () => {
  const advance = recordWithId("choice-advance");
  const exchange = exchangeRecord("choice-exchange");
  const harness = await createHarness([advance, exchange], {
    chunkPayloads: [[advance, exchange]],
  });
  const buttons = hydrateChoiceButtons(harness.elements["variation-choice-list"]);
  assert.ok(buttons.length >= 3, "expected All, Advance, and Exchange choices");

  harness.elements["customize-search"].value = "exchange";
  harness.elements["customize-search"].dispatch("input");

  const visible = buttons.filter(button => !button.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0].dataset.choiceLabel, /exchange/);
  assert.equal(visible.filter(button => button.tabIndex === 0).length, 1);
});

test("canceling Customize restores controls to their committed values", async () => {
  const harness = await createHarness([continuationRecord()]);
  assert.equal(harness.elements["caro-filter-difficulty"].value, "all");
  assert.equal(harness.elements["caro-filter-provenance"].value, "all");

  harness.elements["customize-open"].dispatch("click");
  harness.elements["caro-filter-difficulty"].value = "expert";
  harness.elements["caro-filter-provenance"].value = "master";
  harness.elements["customize-close"].dispatch("click");

  assert.equal(harness.elements["caro-filter-difficulty"].value, "all");
  assert.equal(harness.elements["caro-filter-provenance"].value, "all");
});

test("Review mistakes bypasses active filters and preserves mistake recency order", async () => {
  const storage = new MemoryStorage();
  const now = Date.now();
  const older = recordWithId("review-older-advance");
  const newer = recordWithId("review-newer-advance");
  const exchangeCandidates = Array.from({ length: 5 }, (_unused, index) =>
    exchangeRecord(`review-filter-exchange-${index + 1}`)
  );
  const review = (puzzle, mistakeAt) => ({
    deckId: "caro-kann-black",
    puzzleId: puzzle.id,
    encounters: 1,
    lapses: 1,
    dueAt: new Date(now - 60 * 1000).toISOString(),
    lastSeenAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    lastOutcome: "skipped",
    mistakeAt,
    snapshot: {
      variation: puzzle.variation,
      curriculumGroup: "Advance",
      themes: puzzle.themes,
      difficulty: puzzle.difficulty,
    },
    createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: mistakeAt,
  });
  seedTrainerState(storage, {
    sessionSize: 5,
    reviews: {
      [older.id]: review(older, new Date(now - 2 * 60 * 1000).toISOString()),
      [newer.id]: review(newer, new Date(now - 60 * 1000).toISOString()),
    },
  });
  const candidates = [older, newer, ...exchangeCandidates];
  const harness = await createHarness(candidates, {
    storage,
    chunkPayloads: [candidates],
    trainerEnabled: true,
  });

  harness.elements["caro-filter-variation"].value = exchangeCandidates[0].variation;
  harness.elements["customize-apply"].dispatch("click");
  await harness.settle();
  assert.match(harness.elements["caro-filter-status"].textContent, /5 matching positions/);

  assert.equal(await harness.context.CaroKannTrainer.reviewMistakes(), true);
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.total, 2);
  harness.elements["puzzle-skip"].dispatch("click");
  await harness.settle();

  const reviews = harness.trainerState().reviews["caro-kann-black"];
  assert.equal(reviews[newer.id].skips, 1, "newest mistake is reviewed first");
  assert.equal(reviews[older.id].skips, 0);
});

test("progress import merges permanent solved records monotonically", async () => {
  const storage = new MemoryStorage();
  const puzzle = recordWithId("permanent-merge");
  const progressKey = "chess-tracker:puzzle-progress:v1:caro-kann-black:me";
  storage.setItem(progressKey, JSON.stringify({
    version: 1,
    username: "me",
    records: {
      [puzzle.id]: {
        id: puzzle.id,
        status: "solved",
        attempts: 5,
        firstAttemptAt: "2026-07-02T12:00:00Z",
        solvedAt: "2026-07-03T12:00:00Z",
        solutionRevealedAt: "2026-07-04T12:00:00Z",
        createdAt: "2026-07-01T12:00:00Z",
        updatedAt: "2026-07-05T12:00:00Z",
      },
    },
  }));
  const harness = await createHarness([puzzle], { storage, trainerEnabled: true });
  const payload = {
    format: "chess-opening-trainer-progress",
    version: 1,
    decks: {
      "caro-kann-black": {
        permanentSolvedProgress: {
          [puzzle.id]: {
            id: puzzle.id,
            status: "unsolved",
            attempts: 2,
            firstAttemptAt: "2026-07-06T12:00:00Z",
            solvedAt: null,
            solutionRevealedAt: "2026-06-30T12:00:00Z",
            createdAt: "2026-07-06T12:00:00Z",
            updatedAt: "2026-07-04T12:00:00Z",
          },
        },
      },
    },
    trainer: null,
  };
  harness.elements["progress-import"].files = [{
    async text() { return JSON.stringify(payload); },
  }];
  harness.elements["progress-import"].dispatch("change");
  await harness.settle();

  const merged = JSON.parse(storage.getItem(progressKey)).records[puzzle.id];
  assert.equal(merged.status, "solved");
  assert.equal(merged.attempts, 5);
  assert.equal(merged.firstAttemptAt, "2026-07-02T12:00:00Z");
  assert.equal(merged.solvedAt, "2026-07-03T12:00:00Z");
  assert.equal(merged.solutionRevealedAt, "2026-06-30T12:00:00Z");
  assert.equal(merged.createdAt, "2026-07-01T12:00:00Z");
  assert.equal(merged.updatedAt, "2026-07-05T12:00:00Z");
  assert.match(harness.elements["progress-transfer-status"].textContent, /restored and merged/i);
});

test("pagehide finalizes engaged attempts except when the page enters the back-forward cache", async () => {
  const scenarios = [{
    name: "incorrect",
    engage(harness) {
      harness.board.config.movable.events.after("d2", "d1");
      assert.match(harness.elements["puzzle-feedback"].innerHTML, /Try again/);
    },
    incorrect: 1,
    hints: 0,
  }, {
    name: "hinted",
    engage(harness) {
      harness.elements["puzzle-hint"].dispatch("click");
      assert.match(harness.elements["puzzle-feedback"].textContent, /^Hint:/);
    },
    incorrect: 0,
    hints: 1,
  }];

  for (const scenario of scenarios) {
    const closingRecords = Array.from({ length: 5 }, (_unused, index) =>
      recordWithId(`pagehide-${scenario.name}-close-${index + 1}`)
    );
    const closingStorage = new MemoryStorage();
    seedTrainerState(closingStorage, { sessionSize: 5 });
    const closing = await createHarness(closingRecords, {
      chunkPayloads: [closingRecords],
      storage: closingStorage,
      trainerEnabled: true,
    });
    scenario.engage(closing);
    assert.equal(closing.context.CaroKannTrainer.sessionSummary.completed, 0);

    closing.dispatchWindow("pagehide", { persisted: false });
    const closingSummary = closing.context.CaroKannTrainer.sessionSummary;
    assert.equal(closingSummary.completed, 1, `${scenario.name} presentation is finalized`);
    assert.equal(closingSummary.skips, 1);
    assert.equal(closingSummary.hints, scenario.hints);
    const closingReviews = Object.values(
      closing.trainerState().reviews["caro-kann-black"] || {},
    );
    assert.equal(closingReviews.length, 1);
    assert.equal(closingReviews[0].lastOutcome, "skipped");
    assert.equal(closingReviews[0].totalIncorrect, scenario.incorrect);
    assert.equal(closingReviews[0].hints, scenario.hints);
    assert.equal(closingReviews[0].skips, 1);

    const cachedRecords = Array.from({ length: 5 }, (_unused, index) =>
      recordWithId(`pagehide-${scenario.name}-cached-${index + 1}`)
    );
    const cachedStorage = new MemoryStorage();
    seedTrainerState(cachedStorage, { sessionSize: 5 });
    const cached = await createHarness(cachedRecords, {
      chunkPayloads: [cachedRecords],
      storage: cachedStorage,
      trainerEnabled: true,
    });
    scenario.engage(cached);
    cached.dispatchWindow("pagehide", { persisted: true });

    assert.equal(cached.context.CaroKannTrainer.sessionSummary.completed, 0,
      `${scenario.name} presentation remains active in bfcache`);
    assert.equal(Object.keys(
      cached.trainerState().reviews["caro-kann-black"] || {},
    ).length, 0);
  }
});

test("cross-tab review refresh preserves a completed session presentation", async () => {
  const storage = new MemoryStorage();
  const records = Array.from({ length: 5 }, (_unused, index) =>
    recordWithId(`cross-tab-session-${index + 1}`)
  );
  const harness = await createHarness(records, {
    storage,
    chunkPayloads: [records],
    trainerEnabled: true,
  });

  harness.board.config.movable.events.after("d2", "c3");
  harness.flushTimer();
  harness.board.config.movable.events.after("c3", "d2");
  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 1);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.match(harness.elements["puzzle-feedback"].innerHTML, /Line complete/);

  harness.dispatchWindow("storage", {
    key: "chess-tracker:opening-trainer:v2:me",
  });

  assert.equal(harness.context.CaroKannTrainer.sessionSummary.completed, 1);
  assert.equal(harness.elements["puzzle-workspace"].hidden, false);
  assert.equal(harness.elements["puzzle-continue"].hidden, false);
  assert.match(harness.elements["puzzle-feedback"].innerHTML, /Line complete/);
  assert.match(harness.elements["puzzle-context-body"].innerHTML, /Full continuation/);
});
