const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const DOMAIN_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "puzzle-domain.js"), "utf8");
const CONTROLLER_SOURCE = fs.readFileSync(path.join(ROOT, "dashboard", "puzzles-page.js"), "utf8");

const ELEMENT_IDS = [
  "puzzles-page", "puzzle-progress-summary", "puzzle-storage-warning",
  "puzzles-unsolved-tab", "puzzles-solved-tab", "puzzles-unsolved-count",
  "puzzles-solved-count", "puzzles-unsolved-panel", "puzzles-solved-panel",
  "puzzle-page-state", "puzzle-workspace", "puzzle-board", "puzzle-prompt",
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
    this.textContent = "";
    this.innerHTML = "";
    this.tabIndex = 0;
    this.dataset = Object.create(null);
    this.isConnected = true;
    this.listeners = Object.create(null);
    this.attributes = Object.create(null);
    this.classList = {
      add() {},
      toggle() {},
    };
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

  closest(selector) {
    if (this.id === "puzzle-prompt" && selector === ".puzzle-task") return this.task;
    return null;
  }

  focus() {}
  scrollIntoView() {}
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

function blackContinuationCandidate() {
  const initialFen = "8/8/8/8/5K2/2Qp4/3k4/8 b - - 3 47";
  const afterBest = "8/8/8/8/5K2/2kp4/8/8 w - - 0 48";
  const afterReply = "8/8/8/8/4K3/2kp4/8/8 b - - 1 48";
  const afterFinal = "8/8/8/8/4K3/3p4/3k4/8 w - - 2 49";
  const first = {
    fen_before: initialFen,
    best_move_uci: "d2c3",
    best_move_san: "Kxc3",
    post_best_fen: afterBest,
    legal_moves_uci: ["d2c3", "d2d1", "d2e2"],
    legal_dests: { d2: ["c3", "d1", "e2"] },
    promotion_options: {},
    opponent_reply_uci: "f4e4",
    opponent_reply_san: "Ke4",
    post_reply_fen: afterReply,
  };
  const second = {
    fen_before: afterReply,
    best_move_uci: "c3d2",
    best_move_san: "Kd2",
    post_best_fen: afterFinal,
    legal_moves_uci: ["c3c4", "c3b4", "c3b3", "c3d2", "c3c2", "c3b2", "d3d2"],
    legal_dests: {
      c3: ["c4", "b4", "b3", "d2", "c2", "b2"],
      d3: ["d2"],
    },
    promotion_options: {},
    opponent_reply_uci: null,
    opponent_reply_san: null,
    post_reply_fen: null,
  };
  return {
    puzzle_id: "black-kxc3",
    game_id: "game-black",
    game_url: "https://example.test/game-black",
    username: "me",
    user_color: "black",
    orientation: "black",
    side_to_move: "black",
    ply: 93,
    fullmove: 47,
    fen_before: initialFen,
    played_move_uci: "d2e2",
    played_move_san: "Ke2",
    best_move_uci: "d2c3",
    best_move_san: "Kxc3",
    post_best_fen: afterBest,
    legal_moves_uci: first.legal_moves_uci,
    legal_dests: first.legal_dests,
    promotion_options: {},
    cp_loss: 2000,
    principal_variation_uci: ["d2c3", "f4e4", "c3d2"],
    principal_variation_san: ["Kxc3", "Ke4", "Kd2"],
    solution_steps: [first, second],
    opponent_name: "VZbuddy",
    game_date: "2026-06-28",
  };
}

function promotionCandidate() {
  const before = "7k/P7/5KB1/8/8/8/8/8 w - - 0 1";
  const after = "Q6k/8/5KB1/8/8/8/8/8 b - - 0 1";
  const step = {
    fen_before: before,
    best_move_uci: "a7a8q",
    best_move_san: "a8=Q#",
    post_best_fen: after,
    legal_moves_uci: ["a7a8q", "a7a8r", "a7a8b", "a7a8n"],
    legal_dests: { a7: ["a8"] },
    promotion_options: { a7a8: ["q", "r", "b", "n"] },
    opponent_reply_uci: null,
    opponent_reply_san: null,
    post_reply_fen: null,
  };
  return {
    puzzle_id: "promotion",
    game_id: "promotion-game",
    username: "me",
    user_color: "white",
    orientation: "white",
    ply: 0,
    fullmove: 1,
    fen_before: before,
    played_move_uci: "h1g1",
    played_move_san: "Kg1",
    best_move_uci: step.best_move_uci,
    best_move_san: step.best_move_san,
    post_best_fen: after,
    legal_moves_uci: step.legal_moves_uci,
    legal_dests: step.legal_dests,
    promotion_options: step.promotion_options,
    solution_steps: [step],
  };
}

function createHarness(candidate, { coarsePointer = false } = {}) {
  const elements = Object.fromEntries(ELEMENT_IDS.map(id => [id, new FakeElement(id)]));
  elements["puzzle-uci-form"].submitButton = new FakeElement("uci-submit");
  elements["puzzle-promotion-options"].firstPromotionButton = new FakeElement("first-promotion");
  elements["puzzle-prompt"].task = new FakeElement("puzzle-task");

  const storage = new MemoryStorage();
  const boards = [];
  const timers = new Map();
  let nextTimer = 1;
  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };
  const context = vm.createContext({
    console,
    document,
    localStorage: storage,
    DATA: null,
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
    queueMicrotask(callback) {
      callback();
    },
  });
  context.window = context;
  context.window.DATA = {
    username: "me",
    puzzle_catalog: {
      candidates: [candidate],
      coverage: { games_seen: 1, games_for_user: 1, games_analyzed: 1 },
      errors: [],
    },
  };
  context.window.matchMedia = query => ({
    matches: query === "(pointer: coarse)" ? coarsePointer : false,
  });
  context.window.addEventListener = () => {};
  context.window.setTimeout = callback => {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, callback);
    return id;
  };
  context.window.clearTimeout = id => timers.delete(id);
  context.window.ChessTrackerUI = {
    escapeHtml(value) {
      return String(value == null ? "" : value);
    },
    makeBoard(_element, config) {
      const board = new FakeBoard(config);
      boards.push(board);
      return board;
    },
  };

  vm.runInContext(DOMAIN_SOURCE, context);
  vm.runInContext(CONTROLLER_SOURCE, context);

  return {
    elements,
    storage,
    board: boards[0],
    flushTimer() {
      const entry = timers.entries().next();
      assert.equal(entry.done, false, "expected a queued controller timer");
      const [id, callback] = entry.value;
      timers.delete(id);
      callback();
    },
    progress() {
      const raw = [...storage.values.values()][0];
      return raw ? JSON.parse(raw).records[candidate.puzzle_id] : null;
    },
  };
}

test("black king continuation auto-replies and solves only on the second user move", () => {
  const harness = createHarness(blackContinuationCandidate());
  const { board } = harness;

  assert.equal(board.config.orientation, "black");
  assert.equal(board.config.viewOnly, false);
  assert.deepEqual([...board.config.movable.dests.get("d2")], ["c3", "d1", "e2"]);

  board.config.movable.events.after("d2", "c3");
  assert.equal(harness.progress(), null, "the first best move must not persist solved state");
  assert.equal(board.config.fen, blackContinuationCandidate().solution_steps[0].post_best_fen);
  assert.equal(board.config.movable.color, undefined);

  harness.flushTimer();
  assert.equal(board.config.orientation, "black");
  assert.equal(board.config.fen, blackContinuationCandidate().solution_steps[1].fen_before);
  assert.deepEqual(Array.from(board.config.lastMove), ["f4", "e4"]);
  assert.equal(board.config.movable.color, "black");

  board.config.movable.events.after("c3", "d2");
  assert.equal(harness.progress().status, "solved");
  assert.equal(harness.progress().attempts, 1);
  assert.equal(board.config.viewOnly, false);
  assert.equal(board.config.fen, blackContinuationCandidate().solution_steps[1].post_best_fen);
});

test("a wrong second move returns to the initial FEN and clears keyboard input", () => {
  const candidate = blackContinuationCandidate();
  const harness = createHarness(candidate);
  const { board, elements } = harness;

  board.config.movable.events.after("d2", "c3");
  harness.flushTimer();
  elements["puzzle-uci-input"].value = "c3c4";
  board.config.movable.events.after("c3", "c4");
  assert.equal(harness.progress().status, "unsolved");
  assert.equal(harness.progress().attempts, 1);

  harness.flushTimer();
  assert.equal(board.config.fen, candidate.fen_before);
  assert.equal(board.config.orientation, "black");
  assert.equal(elements["puzzle-uci-input"].value, "");
  assert.equal(board.config.movable.color, "black");
});

test("promotion selection locks normal inputs and the exact suffix solves", () => {
  const candidate = promotionCandidate();
  const harness = createHarness(candidate, { coarsePointer: true });
  const { board, elements } = harness;
  const input = elements["puzzle-uci-input"];

  assert.equal(board.config.draggable.enabled, false);
  assert.equal(board.config.selectable.enabled, true);
  input.value = "a7a8";
  elements["puzzle-uci-form"].dispatch("submit");
  assert.equal(elements["puzzle-promotion-chooser"].hidden, false);
  assert.equal(input.disabled, true);
  assert.equal(board.config.movable.color, undefined);
  assert.equal(board.config.selectable.enabled, false);

  const queenButton = {
    dataset: { piece: "q" },
    closest() {
      return this;
    },
  };
  elements["puzzle-promotion-options"].dispatch("click", { target: queenButton });
  assert.equal(harness.progress().status, "solved");
  assert.equal(elements["puzzle-promotion-chooser"].hidden, true);
  assert.equal(board.config.fen, candidate.post_best_fen);
});
