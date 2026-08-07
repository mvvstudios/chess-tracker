const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "dashboard", "app.js"),
  "utf8",
);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, enabled) {
    if (enabled) this.add(value);
    else this.remove(value);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.style = {};
    this.classList = new FakeClassList();
  }
}

class FakeRow {
  constructor(data) {
    this.data = data;
    this.element = new FakeElement("row");
  }

  getData() {
    return this.data;
  }

  getElement() {
    return this.element;
  }
}

class FakeTabulator {
  constructor(selector, config) {
    this.selector = selector;
    this.handlers = {};
    this.rows = config.data.map(data => new FakeRow(data));
    FakeTabulator.instances.set(selector, this);
  }

  on(event, callback) {
    this.handlers[event] = callback;
    if (event === "tableBuilt") callback();
  }

  getRows() {
    return this.rows;
  }

  emit(event, rowIndex) {
    this.handlers[event]({}, this.rows[rowIndex]);
  }
}
FakeTabulator.instances = new Map();

function qualityItem(id, fen, overrides = {}) {
  return {
    id,
    fen_before: fen,
    game_side: "white",
    move_label: id,
    opening_label: "Test opening",
    phase_bucket: "opening",
    played_move_uci: "e2e4",
    played_move_san: "e4",
    best_move_uci: "d2d4",
    best_move_san: "d4",
    cp_before: 25,
    cp_after: -175,
    cp_loss: 200,
    categories: [],
    ...overrides,
  };
}

function qualityAnalysis(items) {
  return {
    engine_coverage: {
      analyzed_games: 1,
      eligible_games: 1,
      items_analyzed: items.length,
    },
    category_labels: {},
    impact_rows: [],
    scramble_impact_rows: [],
    items,
  };
}

test("selecting a Mistake row updates only the Mistake board", () => {
  FakeTabulator.instances.clear();
  const elementIds = [
    "blunder-analysis-block",
    "blunder-coverage-cards",
    "blunder-analysis-empty",
    "blunder-review-table",
    "blunder-board",
    "blunder-board-meta",
    "mistake-analysis-block",
    "mistake-coverage-cards",
    "mistake-analysis-empty",
    "mistake-review-table",
    "mistake-board",
    "mistake-board-meta",
  ];
  const elements = Object.fromEntries(
    elementIds.map(id => [id, new FakeElement(id)]),
  );
  const boards = new Map();
  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const blunder = qualityItem(
    "Blunder example",
    "8/8/8/8/8/8/4K3/6k1 w - - 0 1",
  );
  const firstMistake = qualityItem(
    "First mistake",
    "8/8/8/8/8/8/3K4/6k1 w - - 0 1",
  );
  const selectedMistake = qualityItem(
    "Selected mistake",
    "8/8/8/8/8/8/2K5/6k1 b - - 0 1",
    {
      game_side: "black",
      played_move_uci: "g8f6",
      played_move_san: "Nf6",
      best_move_uci: "g8h6",
      best_move_san: "Nh6",
    },
  );
  const context = vm.createContext({
    console,
    document,
    DATA: {
      blunder_analysis: qualityAnalysis([blunder]),
      mistake_analysis: qualityAnalysis([firstMistake, selectedMistake]),
    },
    Tabulator: FakeTabulator,
  });
  context.window = context;
  context.window.DATA = context.DATA;
  context.window.matchMedia = () => ({ matches: false });
  context.window.ChessgroundLib = {
    Chessground(element, config) {
      const board = {
        initialConfig: config,
        sets: [],
        shapes: [],
        set(next) {
          this.sets.push(next);
        },
        setShapes(next) {
          this.shapes = next;
        },
      };
      boards.set(element.id, board);
      return board;
    },
  };

  vm.runInContext(APP_SOURCE, context);

  const blunderBoard = boards.get("blunder-board");
  const mistakeBoard = boards.get("mistake-board");
  const blunderSetCount = blunderBoard.sets.length;
  const blunderLastSet = blunderBoard.sets.at(-1);
  const blunderMeta = elements["blunder-board-meta"].innerHTML;

  FakeTabulator.instances.get("#mistake-review-table").emit("rowClick", 1);

  const mistakeSet = mistakeBoard.sets.at(-1);
  assert.equal(mistakeSet.fen, selectedMistake.fen_before);
  assert.equal(mistakeSet.orientation, "black");
  assert.equal(mistakeSet.lastMove, undefined);
  assert.equal(mistakeSet.check, false);
  assert.equal(mistakeBoard.shapes.length, 2);
  assert.equal(mistakeBoard.shapes[0].orig, "g8");
  assert.equal(mistakeBoard.shapes[0].dest, "f6");
  assert.equal(mistakeBoard.shapes[0].brush, "red");
  assert.equal(mistakeBoard.shapes[1].orig, "g8");
  assert.equal(mistakeBoard.shapes[1].dest, "h6");
  assert.equal(mistakeBoard.shapes[1].brush, "green");
  assert.match(elements["mistake-board-meta"].innerHTML, /Selected mistake/);
  assert.equal(blunderBoard.sets.length, blunderSetCount);
  assert.equal(blunderBoard.sets.at(-1), blunderLastSet);
  assert.equal(elements["blunder-board-meta"].innerHTML, blunderMeta);
});
