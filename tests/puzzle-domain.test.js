const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PuzzleDomain = require("../dashboard/puzzle-domain.js");

test("UMD bundle exposes PuzzleDomain as a browser global", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "dashboard", "puzzle-domain.js"),
    "utf8",
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.PuzzleDomain.createProgressStore, "function");
  assert.equal(context.PuzzleDomain.normalizeUci("E2E4"), "e2e4");
});

function candidate(overrides = {}) {
  return {
    puzzle_id: "game-1:12",
    game_id: "game-1",
    ply: 12,
    cp_loss: 300,
    game_date: "2026-07-30T10:00:00Z",
    best_move_uci: "e2e4",
    legal_moves_uci: ["e2e4", "d2d4", "g1f3"],
    ...overrides,
  };
}

function explicitStep(overrides = {}) {
  return {
    fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    best_move_uci: "e2e4",
    best_move_san: "e4",
    post_best_fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    legal_moves_uci: ["e2e4", "d2d4", "g1f3"],
    legal_dests: { e2: ["e4"], d2: ["d4"], g1: ["f3"] },
    promotion_options: {},
    opponent_reply_uci: null,
    opponent_reply_san: null,
    post_reply_fen: null,
    ...overrides,
  };
}

function twoStepCandidate() {
  const afterReply = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  return candidate({
    solution_steps: [
      explicitStep({
        opponent_reply_uci: "e7e5",
        opponent_reply_san: "e5",
        post_reply_fen: afterReply,
      }),
      explicitStep({
        fen_before: afterReply,
        best_move_uci: "g1f3",
        best_move_san: "Nf3",
        post_best_fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        legal_moves_uci: ["g1f3", "f1c4"],
        legal_dests: { g1: ["f3"], f1: ["c4"] },
      }),
    ],
  });
}

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

test("normalizeUci validates coordinate moves and accepts move objects", () => {
  assert.equal(PuzzleDomain.normalizeUci(" E2E4 "), "e2e4");
  assert.equal(
    PuzzleDomain.normalizeUci({ orig: "A7", dest: "A8", promotion: "Q" }),
    "a7a8q",
  );
  assert.equal(PuzzleDomain.normalizeUci({ from: "g1", to: "f3" }), "g1f3");
  assert.equal(PuzzleDomain.normalizeUci("e2e2"), null);
  assert.equal(PuzzleDomain.normalizeUci("O-O"), null);
  assert.equal(PuzzleDomain.normalizeUci("e7e8k"), null);
  assert.equal(PuzzleDomain.isValidUci("a2a4"), true);
  assert.equal(PuzzleDomain.isValidUci("a9a4"), false);
});

test("normalizeUci canonicalizes Chessground castling aliases", () => {
  assert.equal(PuzzleDomain.normalizeUci("e1h1"), "e1g1");
  assert.equal(PuzzleDomain.normalizeUci("e1a1"), "e1c1");
  assert.equal(PuzzleDomain.normalizeUci("e8h8"), "e8g8");
  assert.equal(PuzzleDomain.normalizeUci("e8a8"), "e8c8");
});

test("evaluateAttempt distinguishes correct, incorrect legal, and illegal moves", () => {
  const puzzle = candidate();
  assert.deepEqual(PuzzleDomain.evaluateAttempt(puzzle, "e2e4"), {
    kind: "correct", uci: "e2e4", legal: true, correct: true,
  });
  assert.deepEqual(PuzzleDomain.evaluateAttempt(puzzle, "d2d4"), {
    kind: "incorrect", uci: "d2d4", legal: true, correct: false,
  });
  assert.deepEqual(PuzzleDomain.evaluateAttempt(puzzle, "e2e5"), {
    kind: "illegal", uci: "e2e5", legal: false, correct: false,
  });
});

test("solutionSteps preserves legacy candidates as one terminal decision", () => {
  const puzzle = candidate();
  const steps = PuzzleDomain.solutionSteps(puzzle);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].best_move_uci, "e2e4");
  assert.deepEqual(steps[0].legal_moves_uci, ["e2e4", "d2d4", "g1f3"]);
  assert.equal(steps[0].opponent_reply_uci, null);

  const result = PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "E2E4");
  assert.equal(result.kind, "correct");
  assert.equal(result.isFinalStep, true);
  assert.equal(result.solved, true);
  assert.equal(result.nextStep, null);
  assert.equal(result.reply, null);
});

test("an explicit black king capture is normalized and accepted", () => {
  const puzzle = candidate({
    puzzle_id: "black-king-capture",
    solution_steps: [explicitStep({
      fen_before: "8/8/8/8/8/2P5/3k4/7K b - - 0 1",
      best_move_uci: "D2C3",
      best_move_san: "Kxc3",
      post_best_fen: "8/8/8/8/8/2k5/8/7K w - - 0 2",
      legal_moves_uci: ["d2c3", "d2e3"],
      legal_dests: { d2: ["c3", "e3"] },
    })],
  });

  assert.equal(PuzzleDomain.solutionSteps(puzzle)[0].best_move_uci, "d2c3");
  assert.equal(PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "d2c3").solved, true);
  assert.deepEqual(PuzzleDomain.partitionCandidates([puzzle], {}).unsolved, [puzzle]);
});

test("a correct intermediate step advances with its stored opponent reply", () => {
  const result = PuzzleDomain.evaluatePuzzleStep(twoStepCandidate(), 0, "e2e4");

  assert.equal(result.kind, "correct");
  assert.equal(result.isFinalStep, false);
  assert.equal(result.solved, false);
  assert.equal(result.nextStepIndex, 1);
  assert.equal(result.nextStep.best_move_uci, "g1f3");
  assert.deepEqual(result.reply, {
    uci: "e7e5",
    san: "e5",
    fen: result.nextStep.fen_before,
  });
  assert.equal(result.opponentReplyUci, "e7e5");
});

test("the final correct step solves without requiring another engine reply", () => {
  const result = PuzzleDomain.evaluatePuzzleStep(twoStepCandidate(), 1, "g1f3");

  assert.equal(result.kind, "correct");
  assert.equal(result.isFinalStep, true);
  assert.equal(result.solved, true);
  assert.equal(result.nextStepIndex, null);
  assert.equal(result.nextStep, null);
  assert.equal(result.reply, null);
});

test("wrong and illegal step attempts neither advance nor reveal replies", () => {
  const puzzle = twoStepCandidate();
  const wrong = PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "d2d4");
  assert.equal(wrong.kind, "incorrect");
  assert.equal(wrong.legal, true);
  assert.equal(wrong.solved, false);
  assert.equal(wrong.nextStep, null);
  assert.equal(wrong.reply, null);

  const illegal = PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "e2e5");
  assert.equal(illegal.kind, "illegal");
  assert.equal(illegal.legal, false);
  assert.equal(illegal.solved, false);
  assert.equal(illegal.nextStep, null);
  assert.equal(illegal.reply, null);
});

test("a two-decision puzzle stays unsolved until the final best move persists", () => {
  const puzzle = twoStepCandidate();
  const storage = new MemoryStorage();
  const store = PuzzleDomain.createProgressStore("me", storage);

  const first = PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "e2e4");
  assert.equal(first.solved, false);
  assert.deepEqual(PuzzleDomain.partitionCandidates([puzzle], store).unsolved, [puzzle]);

  const wrong = PuzzleDomain.evaluatePuzzleStep(puzzle, 1, "f1c4");
  assert.equal(wrong.kind, "incorrect");
  store.recordAttempt(puzzle, false, "2026-08-01T10:00:00Z");
  assert.deepEqual(PuzzleDomain.partitionCandidates([puzzle], store).unsolved, [puzzle]);

  const final = PuzzleDomain.evaluatePuzzleStep(puzzle, 1, "g1f3");
  assert.equal(final.solved, true);
  store.recordAttempt(puzzle, true, "2026-08-01T10:01:00Z");
  store.markSolved(puzzle, "2026-08-01T10:01:00Z");

  const reloaded = PuzzleDomain.createProgressStore("ME", storage);
  const partition = PuzzleDomain.partitionCandidates([puzzle], reloaded);
  assert.deepEqual(partition.unsolved, []);
  assert.deepEqual(partition.solved, [puzzle]);
});

test("malformed explicit solution steps are rejected instead of using legacy aliases", () => {
  const empty = candidate({ puzzle_id: "empty-steps", solution_steps: [] });
  const badMove = candidate({
    puzzle_id: "bad-step-move",
    solution_steps: [explicitStep({ best_move_uci: "e2e5" })],
  });
  const brokenChain = twoStepCandidate();
  brokenChain.puzzle_id = "broken-chain";
  brokenChain.solution_steps[0].post_reply_fen = "not the next position";

  for (const puzzle of [empty, badMove, brokenChain]) {
    assert.deepEqual(PuzzleDomain.solutionSteps(puzzle), []);
    const result = PuzzleDomain.evaluatePuzzleStep(puzzle, 0, "e2e4");
    assert.equal(result.kind, "illegal");
    assert.equal(result.correct, false);
  }

  const partition = PuzzleDomain.partitionCandidates([empty, badMove, brokenChain], {});
  assert.deepEqual(partition.unsolved, []);
  assert.deepEqual(
    partition.invalid.map(PuzzleDomain.stablePuzzleId),
    ["bad-step-move", "broken-chain", "empty-steps"],
  );
});

test("castling aliases compare against the canonical legal Stockfish move", () => {
  const puzzle = candidate({
    best_move_uci: "e1g1",
    legal_moves_uci: ["e1g1", "e1f1"],
  });
  assert.equal(PuzzleDomain.evaluateAttempt(puzzle, "e1h1").kind, "correct");
  assert.equal(PuzzleDomain.evaluateAttempt(puzzle, "e1f1").kind, "incorrect");
});

test("promotion validation requires the exact normalized promotion move", () => {
  const puzzle = candidate({
    best_move_uci: "a7a8q",
    legal_moves_uci: ["a7a8q", "a7a8r", "a7a8b", "a7a8n"],
  });
  assert.deepEqual(
    PuzzleDomain.promotionChoices(puzzle, "a7", "a8"),
    ["q", "r", "b", "n"],
  );
  assert.equal(PuzzleDomain.evaluateAttempt(puzzle, "a7a8").kind, "illegal");
  assert.equal(PuzzleDomain.evaluateAttempt(puzzle, "a7a8r").kind, "incorrect");
  assert.equal(
    PuzzleDomain.evaluateAttempt(puzzle, { from: "a7", to: "a8", promotion: "q" }).kind,
    "correct",
  );
});

test("legacy legal_dests supports ordinary moves and explicit promotions", () => {
  const ordinary = candidate({ legal_moves_uci: undefined, legal_dests: { e2: ["e3", "e4"] } });
  assert.equal(PuzzleDomain.evaluateAttempt(ordinary, "e2e4").kind, "correct");

  const promotion = candidate({
    best_move_uci: "a7a8q",
    legal_moves_uci: undefined,
    legal_dests: { a7: ["a8"] },
  });
  assert.equal(PuzzleDomain.evaluateAttempt(promotion, "a7a8").kind, "illegal");
  assert.equal(PuzzleDomain.evaluateAttempt(promotion, "a7a8q").kind, "correct");
});

test("missing or invalid engine data fails closed without throwing", () => {
  assert.equal(PuzzleDomain.evaluateAttempt({}, "e2e4").kind, "illegal");
  assert.equal(
    PuzzleDomain.evaluateAttempt(candidate({ best_move_uci: "not-a-move" }), "e2e4").kind,
    "illegal",
  );
  assert.equal(
    PuzzleDomain.evaluateAttempt(candidate({ legal_moves_uci: undefined }), "e2e4").kind,
    "illegal",
  );
});

test("stablePuzzleId prefers explicit ids and otherwise uses game plus ply", () => {
  assert.equal(PuzzleDomain.stablePuzzleId(candidate()), "game-1:12");
  assert.equal(
    PuzzleDomain.stablePuzzleId({ game_url: "https://example.test/g/1", ply: 7 }),
    "game:https%3A%2F%2Fexample.test%2Fg%2F1:ply:7",
  );
  assert.equal(PuzzleDomain.stablePuzzleId({ game_id: "g" }), null);
});

test("partitionCandidates deduplicates, sorts stably, and separates solved progress", () => {
  const low = candidate({ puzzle_id: "low", cp_loss: 200, game_date: "2026-08-01", ply: 8 });
  const highOld = candidate({ puzzle_id: "high-old", cp_loss: 500, game_date: "2026-07-01", ply: 20 });
  const highNew = candidate({ puzzle_id: "high-new", cp_loss: 500, game_date: "2026-08-01", ply: 30 });
  const duplicate = { ...highNew };
  const malformed = candidate({ puzzle_id: "bad", best_move_uci: "bogus" });
  const progress = {
    "high-old": { status: "solved", solvedAt: "2026-08-01T00:00:00Z" },
  };

  const result = PuzzleDomain.partitionCandidates(
    [low, highOld, duplicate, malformed, highNew],
    progress,
  );
  assert.deepEqual(result.unsolved.map(PuzzleDomain.stablePuzzleId), ["high-new", "low"]);
  assert.deepEqual(result.solved.map(PuzzleDomain.stablePuzzleId), ["high-old"]);
  assert.deepEqual(result.invalid.map(PuzzleDomain.stablePuzzleId), ["bad"]);
  assert.equal(result.total, 3);
});

test("candidate ply breaks otherwise equal ordering ties", () => {
  const late = candidate({ puzzle_id: "late", ply: 24 });
  const early = candidate({ puzzle_id: "early", ply: 8 });
  assert.deepEqual(
    PuzzleDomain.sortCandidates([late, early]).map(PuzzleDomain.stablePuzzleId),
    ["early", "late"],
  );
});

test("rotateQueue skips to the next candidate without mutating or looping one item", () => {
  const a = candidate({ puzzle_id: "a" });
  const b = candidate({ puzzle_id: "b" });
  const c = candidate({ puzzle_id: "c" });
  const input = [a, b, c];
  assert.deepEqual(
    PuzzleDomain.rotateQueue(input).map(PuzzleDomain.stablePuzzleId),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    PuzzleDomain.rotateQueue(input, "b").map(PuzzleDomain.stablePuzzleId),
    ["a", "c", "b"],
  );
  assert.deepEqual(PuzzleDomain.rotateQueue([a]), [a]);
  assert.deepEqual(input, [a, b, c]);
});

test("progress records attempts, reveal state, and a persistent solution", () => {
  const storage = new MemoryStorage();
  const store = PuzzleDomain.createProgressStore("Alice", storage);
  const id = candidate();

  const first = store.recordAttempt(id, false, "2026-08-01T10:00:00Z");
  assert.equal(first.status, "unsolved");
  assert.equal(first.attempts, 1);
  assert.equal(first.firstAttemptAt, "2026-08-01T10:00:00Z");
  assert.equal(first.solvedAt, null);

  const revealed = store.revealSolution(id, "2026-08-01T10:01:00Z");
  assert.equal(revealed.status, "unsolved");
  assert.equal(revealed.solutionRevealedAt, "2026-08-01T10:01:00Z");

  const solved = store.recordAttempt(id, true, "2026-08-01T10:02:00Z");
  assert.equal(solved.status, "solved");
  assert.equal(solved.attempts, 2);
  assert.equal(solved.solvedAt, "2026-08-01T10:02:00Z");
  assert.equal(solved.createdAt, "2026-08-01T10:00:00Z");

  const reloaded = PuzzleDomain.createProgressStore("alice", storage);
  assert.deepEqual(reloaded.get(id), solved);
  assert.equal(reloaded.isPersistent(), true);
});

test("show solution never solves and repeated reveal preserves its first timestamp", () => {
  const store = PuzzleDomain.createProgressStore("alice", new MemoryStorage());
  const reveal = store.markSolutionRevealed;
  const one = reveal("p1", "2026-08-01T11:00:00Z");
  const two = store.revealSolution("p1", "2026-08-01T12:00:00Z");
  assert.equal(one.status, "unsolved");
  assert.equal(two.status, "unsolved");
  assert.equal(two.solutionRevealedAt, "2026-08-01T11:00:00Z");
  assert.equal(two.attempts, 0);
});

test("solved state is irreversible across later incorrect attempts", () => {
  const store = PuzzleDomain.createProgressStore("alice", new MemoryStorage());
  const solved = store.recordAttempt("p1", true, "2026-08-01T10:00:00Z");
  const later = store.recordAttempt("p1", false, "2026-08-02T10:00:00Z");
  assert.equal(later.status, "solved");
  assert.equal(later.solvedAt, solved.solvedAt);
  assert.equal(later.attempts, 1);
});

test("progress is isolated by normalized Chess.com username", () => {
  const storage = new MemoryStorage();
  const alice = PuzzleDomain.createProgressStore(" Alice ", storage);
  const bob = PuzzleDomain.createProgressStore("bob", storage);
  alice.recordAttempt("p1", true, "2026-08-01T10:00:00Z");
  assert.equal(PuzzleDomain.createProgressStore("ALICE", storage).get("p1").status, "solved");
  assert.equal(bob.get("p1"), null);
  assert.notEqual(alice.key, bob.key);
});

test("partitionCandidates reflects solved state after store reload", () => {
  const storage = new MemoryStorage();
  const puzzle = candidate({ puzzle_id: "persistent" });
  PuzzleDomain.createProgressStore("alice", storage)
    .recordAttempt(puzzle, true, "2026-08-01T10:00:00Z");
  const reloaded = PuzzleDomain.createProgressStore("alice", storage);
  const result = PuzzleDomain.partitionCandidates([puzzle], reloaded);
  assert.equal(result.unsolved.length, 0);
  assert.deepEqual(result.solved, [puzzle]);
});

test("incorrect then correct flow persists into the solved archive after reload", () => {
  const storage = new MemoryStorage();
  const puzzle = candidate({ puzzle_id: "flow-puzzle" });
  let store = PuzzleDomain.createProgressStore("alice", storage);

  const wrong = PuzzleDomain.evaluateAttempt(puzzle, "d2d4");
  assert.equal(wrong.kind, "incorrect");
  store.recordAttempt(puzzle, wrong.correct, "2026-08-01T10:00:00Z");
  let partition = PuzzleDomain.partitionCandidates([puzzle], store);
  assert.deepEqual(partition.unsolved, [puzzle]);
  assert.equal(partition.solved.length, 0);

  const correct = PuzzleDomain.evaluateAttempt(puzzle, "e2e4");
  assert.equal(correct.kind, "correct");
  store.recordAttempt(puzzle, correct.correct, "2026-08-01T10:01:00Z");

  store = PuzzleDomain.createProgressStore("alice", storage);
  partition = PuzzleDomain.partitionCandidates([puzzle], store);
  assert.equal(partition.unsolved.length, 0);
  assert.deepEqual(partition.solved, [puzzle]);
  assert.equal(store.get(puzzle).attempts, 2);
});

test("storage access errors fall back to usable in-memory progress", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const store = PuzzleDomain.createProgressStore("alice", broken);
  assert.equal(store.isPersistent(), false);
  const record = store.recordAttempt("p1", true, "2026-08-01T10:00:00Z");
  assert.equal(record.status, "solved");
  assert.equal(store.get("p1").status, "solved");
  assert.match(store.getLastError().message, /blocked/);
});

test("malformed stored JSON is ignored and repaired on the next write", () => {
  const storage = new MemoryStorage();
  const key = PuzzleDomain.storageKey("alice");
  storage.setItem(key, "{bad json");
  const store = PuzzleDomain.createProgressStore("alice", storage);
  assert.deepEqual(Object.keys(store.all()), []);
  store.recordAttempt("p1", false, "2026-08-01T10:00:00Z");
  assert.doesNotThrow(() => JSON.parse(storage.getItem(key)));
});
