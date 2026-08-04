const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Trainer = require("../dashboard/trainer-domain.js");
const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "dashboard", "trainer-domain.js"),
  "utf8",
);

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

function fixedClock(iso = "2026-08-03T12:00:00.000Z") {
  let current = iso;
  return {
    clock: () => current,
    set(value) { current = value; },
  };
}

function candidate(id, overrides = {}) {
  return {
    id,
    variation: "Caro-Kann Defense: Advance Variation",
    curriculumGroup: "Advance",
    themes: ["fork", "opening"],
    ...overrides,
  };
}

function puzzleIds(count) {
  return Array.from({ length: count }, (_, index) => `p${index + 1}`);
}

test("UMD bundle exposes TrainerDomain without depending on PuzzleDomain", () => {
  const context = vm.createContext({
    Date,
    JSON,
    Math,
    Number,
    Object,
    Array,
    Set,
    Map,
    String,
    Boolean,
    encodeURIComponent,
  });
  context.globalThis = context;
  vm.runInContext(SOURCE, context);
  assert.equal(typeof context.TrainerDomain.createTrainerStore, "function");
  assert.equal(context.PuzzleDomain, undefined);
});

test("storage keys normalize usernames and stay separate from puzzle progress", () => {
  assert.equal(Trainer.normalizedUsername(" Alice Smith "), "alice smith");
  assert.equal(
    Trainer.storageKey(" Alice Smith "),
    "chess-tracker:opening-trainer:v2:alice%20smith",
  );
  assert.equal(
    Trainer.legacyStorageKey("ALICE SMITH"),
    "chess-tracker:opening-trainer:v1:alice%20smith",
  );
  assert.doesNotMatch(Trainer.storageKey("alice"), /puzzle-progress/);
});

test("preferences default to endless and persist only supported session settings", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("Alice", { storage, clock: time.clock });
  assert.deepEqual(store.getPreferences(), {
    lastDeckId: null,
    sessionMode: "endless",
    sessionSize: 10,
    onboardingDismissed: false,
    updatedAt: null,
  });

  store.setLastDeck("PIRC-BLACK");
  store.setSessionMode("finite");
  store.setSessionSize(20);
  store.setSessionMode("sprint");
  store.setSessionSize(7);
  store.dismissOnboarding();
  assert.deepEqual(store.getPreferences(), {
    lastDeckId: "pirc-black",
    sessionMode: "finite",
    sessionSize: 20,
    onboardingDismissed: true,
    updatedAt: "2026-08-03T12:00:00.000Z",
  });

  const reloaded = Trainer.createTrainerStore(" alice ", { storage, clock: time.clock });
  assert.deepEqual(reloaded.getPreferences(), store.getPreferences());
  assert.equal(reloaded.isPersistent(), true);
});

test("v1 envelopes migrate into v2 without deleting or double-counting legacy data", () => {
  const storage = new MemoryStorage();
  const oldKey = Trainer.legacyStorageKey("alice");
  storage.setItem(oldKey, JSON.stringify({
    version: 1,
    username: "Alice",
    preferences: {
      lastDeck: "caro-kann-black",
      sessionLength: 5,
      onboardingSeen: true,
    },
    reviews: {
      "caro-kann-black": {
        legacy: {
          status: "mastered",
          timesSeen: 4,
          streak: 3,
          intervalDays: 14,
          dueAt: "2026-08-20T12:00:00Z",
          variation: "Caro-Kann Defense: Exchange Variation",
          curriculumGroup: "Exchange",
          themes: ["pin"],
          updatedAt: "2026-08-02T12:00:00Z",
        },
      },
    },
  }));

  const time = fixedClock();
  const store = Trainer.createTrainerStore("ALICE", { storage, clock: time.clock });
  assert.equal(store.getPreferences().lastDeckId, "caro-kann-black");
  assert.equal(store.getPreferences().sessionMode, "endless");
  assert.equal(store.getPreferences().sessionSize, 5);
  assert.equal(store.getPreferences().onboardingDismissed, true);
  assert.equal(store.getReview("caro-kann-black", "legacy").encounters, 4);
  assert.equal(store.classify("caro-kann-black", "legacy"), "Mastered");
  assert.ok(storage.getItem(store.key), "migration writes the current envelope");
  assert.ok(storage.getItem(oldKey), "legacy data is retained for recovery");

  const first = store.getState();
  const reloaded = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  assert.deepEqual(reloaded.getState(), first, "re-reading v1 is idempotent");
});

test("a v1 envelope found at the current key is rewritten in current format", () => {
  const storage = new MemoryStorage();
  const key = Trainer.storageKey("alice");
  storage.setItem(key, JSON.stringify({
    version: 1,
    preferences: { sessionLength: 20 },
    reviews: {},
  }));
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  assert.equal(store.getPreferences().sessionMode, "endless");
  assert.equal(store.getPreferences().sessionSize, 20);
  assert.equal(JSON.parse(storage.getItem(key)).version, Trainer.CURRENT_VERSION);
});

test("v2 preferences without a mode become endless without losing the finite size", () => {
  const storage = new MemoryStorage();
  const key = Trainer.storageKey("alice");
  storage.setItem(key, JSON.stringify({
    version: Trainer.CURRENT_VERSION,
    username: "alice",
    preferences: {
      lastDeckId: "modern-black",
      sessionSize: 5,
      onboardingDismissed: true,
      updatedAt: "2026-08-02T12:00:00Z",
    },
    reviews: {},
    updatedAt: "2026-08-02T12:00:00Z",
  }));

  const store = Trainer.createTrainerStore("alice", { storage, clock: fixedClock().clock });
  assert.deepEqual(store.getPreferences(), {
    lastDeckId: "modern-black",
    sessionMode: "endless",
    sessionSize: 5,
    onboardingDismissed: true,
    updatedAt: "2026-08-02T12:00:00.000Z",
  });
});

test("changing session mode does not mutate adaptive review records", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  store.recordOutcome("caro-kann-black", candidate("mode-independent"), { skipped: true });
  const reviewsBefore = store.getState().reviews;

  store.setSessionMode("finite");
  assert.deepEqual(store.getState().reviews, reviewsBefore);
  assert.equal(store.getPreferences().sessionMode, "finite");
  assert.equal(store.getPreferences().sessionSize, 10);

  store.setSessionMode(" ENDLESS ");
  assert.deepEqual(store.getState().reviews, reviewsBefore);
  assert.equal(store.getPreferences().sessionMode, "endless");
});

test("clean first-try unassisted solves grow intervals and eventually master", () => {
  const storage = new MemoryStorage();
  const time = fixedClock("2026-08-01T12:00:00Z");
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  const puzzle = candidate("clean");

  let review = store.recordOutcome("caro-kann-black", puzzle, { solved: true });
  assert.equal(review.correctStreak, 1);
  assert.equal(review.intervalDays, 1);
  assert.equal(review.dueAt, "2026-08-02T12:00:00.000Z");
  assert.equal(store.classify("caro-kann-black", puzzle), "Learning");

  time.set("2026-08-02T12:00:00Z");
  review = store.recordOutcome("caro-kann-black", puzzle, { solved: true });
  assert.equal(review.correctStreak, 2);
  assert.equal(review.intervalDays, 3);

  time.set("2026-08-05T12:00:00Z");
  review = store.recordOutcome("caro-kann-black", puzzle, { solved: true });
  assert.equal(review.correctStreak, 3);
  assert.equal(review.intervalDays, 7);
  assert.equal(review.unassistedSolves, 3);
  assert.equal(store.classify("caro-kann-black", puzzle), "Mastered");
  assert.equal(
    store.classify("caro-kann-black", puzzle, "2026-08-12T12:00:01Z"),
    "Due",
  );
});

test("incorrect, hinted, skipped, and revealed outcomes all return soon", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  const outcomes = {
    incorrect: { solved: true, incorrectCount: 2 },
    hinted: { solved: true, hintsUsed: 1 },
    skipped: { skipped: true },
    revealed: { revealed: true },
  };

  Object.entries(outcomes).forEach(([id, outcome]) => {
    const review = store.recordOutcome(
      "caro-kann-black",
      candidate(id, { variation: `Variation ${id}`, curriculumGroup: "Lessons" }),
      outcome,
    );
    assert.equal(review.correctStreak, 0);
    assert.equal(review.dueAt, "2026-08-03T12:10:00.000Z");
    assert.equal(review.mistakeAt, "2026-08-03T12:00:00.000Z");
    assert.equal(store.classify("caro-kann-black", id), "Learning");
    assert.deepEqual(review.snapshot.themes, ["fork", "opening"]);
  });

  assert.equal(store.getReview("caro-kann-black", "incorrect").totalIncorrect, 2);
  assert.equal(store.getReview("caro-kann-black", "hinted").hints, 1);
  assert.equal(store.getReview("caro-kann-black", "skipped").skips, 1);
  assert.equal(store.getReview("caro-kann-black", "revealed").reveals, 1);
});

test("adaptive review snapshots retain application difficulty", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });

  const review = store.recordOutcome(
    "caro-kann-black",
    candidate("difficulty-snapshot", { difficulty: "expert" }),
    { skipped: true },
  );

  assert.equal(review.snapshot.difficulty, "expert");
  assert.equal(
    store.getReview("caro-kann-black", "difficulty-snapshot").snapshot.difficulty,
    "expert",
  );
});

test("legacy solved progress migrates lazily and never earns unassisted credit", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  const oldProgress = {
    status: "solved",
    attempts: 1,
    solvedAt: "2026-08-01T09:00:00Z",
    solutionRevealedAt: null,
  };
  const puzzle = candidate("old-solved");

  const first = store.migrateLegacySolved("caro-kann-black", puzzle, oldProgress);
  assert.equal(first.migrated, true);
  assert.equal(first.record.encounters, 1);
  assert.equal(first.record.assistedSolves, 1);
  assert.equal(first.record.cleanSolves, 0);
  assert.equal(first.record.unassistedSolves, 0);
  assert.equal(first.record.legacySolved, true);
  assert.equal(store.classify("caro-kann-black", puzzle), "Due");

  const second = store.migrateLegacySolved("caro-kann-black", puzzle, oldProgress);
  assert.equal(second.migrated, false);
  assert.equal(second.record.encounters, 1);
  assert.deepEqual(oldProgress, {
    status: "solved",
    attempts: 1,
    solvedAt: "2026-08-01T09:00:00Z",
    solutionRevealedAt: null,
  });
});

test("due and mistake queries are sorted, bounded, and include review counts", () => {
  const storage = new MemoryStorage();
  const time = fixedClock("2026-08-03T12:00:00Z");
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  store.recordOutcome("pirc-black", candidate("later"), { solved: true, hintsUsed: 1 });
  time.set("2026-08-03T12:01:00Z");
  store.recordOutcome("pirc-black", candidate("earlier"), { skipped: true });
  time.set("2026-08-03T12:20:00Z");

  assert.deepEqual(
    store.dueReviews("pirc-black").map(record => record.puzzleId),
    ["later", "earlier"],
  );
  assert.deepEqual(store.mistakeIds("pirc-black", { limit: 1 }), ["earlier"]);
  assert.deepEqual(
    store.reviewCounts("pirc-black", ["later", "earlier", "unseen"]),
    { New: 1, Learning: 0, Due: 2, Mastered: 0, total: 3 },
  );
});

test("finite sessions enforce size and finalize each slot exactly once", () => {
  assert.throws(() => Trainer.createSession({
    deckId: "caro-kann-black",
    size: 5,
    puzzleIds: ["only-one"],
  }), /requires at least 5/);

  let session = Trainer.createSession({
    deckId: "caro-kann-black",
    size: 5,
    puzzleIds: puzzleIds(5),
  }, "2026-08-03T12:00:00Z");
  assert.equal(Trainer.currentSessionItem(session).puzzleId, "p1");
  assert.deepEqual(Trainer.sessionProgress(session), {
    completed: 0, total: 5, current: 1, complete: false,
  });

  const first = Trainer.finalizeSessionResult(
    session,
    0,
    { solved: true },
    candidate("p1"),
    "2026-08-03T12:01:00Z",
  );
  assert.equal(first.accepted, true);
  session = first.session;
  const duplicate = Trainer.finalizeSessionResult(
    session,
    0,
    { skipped: true },
    candidate("p1"),
    "2026-08-03T12:02:00Z",
  );
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.result.solved, true);
  assert.equal(Trainer.sessionProgress(duplicate.session).completed, 1);
});

test("session summaries report accuracy, assistance, weaknesses, and mistakes", () => {
  let session = Trainer.createSession({
    deckId: "caro-kann-black",
    size: 5,
    puzzleIds: puzzleIds(5),
  }, "2026-08-03T12:00:00Z");
  const presentations = [
    [{ solved: true }, candidate("p1", { variation: "A", themes: ["fork"] })],
    [{ solved: true, hintsUsed: 1 }, candidate("p2", { variation: "A", themes: ["pin"] })],
    [{ revealed: true }, candidate("p3", { variation: "B", themes: ["fork"] })],
    [{ skipped: true }, candidate("p4", { variation: "C", themes: ["quietMove"] })],
    [{ solved: true, incorrectCount: 1 }, candidate("p5", { variation: "D", themes: ["pin"] })],
  ];
  presentations.forEach(([outcome, puzzle], index) => {
    session = Trainer.finalizeCurrentSessionResult(
      session,
      outcome,
      puzzle,
      `2026-08-03T12:0${index + 1}:00Z`,
    ).session;
  });

  const summary = Trainer.summarizeSession(session);
  assert.equal(summary.completed, 5);
  assert.equal(summary.total, 5);
  assert.equal(summary.firstTryCorrect, 2);
  assert.equal(summary.firstTryAccuracy, 40);
  assert.equal(summary.unassisted, 1);
  assert.equal(summary.hints, 1);
  assert.equal(summary.reveals, 1);
  assert.equal(summary.skips, 1);
  assert.deepEqual(summary.weakThemes, [
    { name: "pin", count: 2 },
    { name: "fork", count: 1 },
    { name: "quietMove", count: 1 },
  ]);
  assert.deepEqual(summary.mistakeIds, ["p2", "p3", "p4", "p5"]);
  assert.equal(summary.complete, true);
});

test("session summaries accept the controller's puzzleIds/results aliases", () => {
  const session = Trainer.createSession({
    deckId: "caro-kann-black",
    size: 5,
    puzzleIds: puzzleIds(5),
  }, "2026-08-03T12:00:00Z");
  session.results.push({
    puzzleId: "p1",
    solved: true,
    firstTry: true,
    unassisted: false,
    hintUsed: true,
    revealed: false,
    skipped: false,
    incorrectCount: 0,
    variation: "Advance",
    themes: ["fork"],
  });
  const summary = Trainer.summarizeSession(session);
  assert.equal(summary.completed, 1);
  assert.equal(summary.firstTryAccuracy, 100);
  assert.equal(summary.unassisted, 0);
  assert.equal(summary.hints, 1);
  assert.deepEqual(summary.weakVariations, [{ name: "Advance", count: 1 }]);
  assert.deepEqual(summary.mistakeIds, ["p1"]);
});

test("store-backed session finalization mutates review state only when accepted", () => {
  const storage = new MemoryStorage();
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  let session = store.createSession({
    deckId: "modern-black",
    size: 5,
    puzzleIds: puzzleIds(5),
  });
  const first = store.finalizeCurrentSessionResult(
    session,
    { solved: true },
    candidate("p1", { curriculumGroup: "Averbakh" }),
  );
  assert.equal(first.accepted, true);
  session = first.session;
  assert.equal(store.getReview("modern-black", "p1").encounters, 1);

  const duplicate = store.finalizeSessionResult(
    session,
    0,
    { skipped: true },
    candidate("p1"),
  );
  assert.equal(duplicate.accepted, false);
  assert.equal(store.getReview("modern-black", "p1").encounters, 1);
});

test("validated export/import merges records idempotently without reducing local progress", () => {
  const sourceStorage = new MemoryStorage();
  const sourceTime = fixedClock("2026-08-01T12:00:00Z");
  const source = Trainer.createTrainerStore("source", {
    storage: sourceStorage,
    clock: sourceTime.clock,
  });
  source.setSessionMode("finite");
  source.setSessionSize(5);
  source.dismissOnboarding();
  source.recordOutcome("caro-kann-black", candidate("shared"), { solved: true });
  source.recordOutcome("caro-kann-black", candidate("imported-only"), { skipped: true });
  const exported = source.exportData();
  assert.equal(JSON.parse(exported).data.preferences.sessionMode, "finite");

  const roundTrip = Trainer.createTrainerStore("round-trip", {
    storage: new MemoryStorage(),
    clock: fixedClock("2026-08-03T12:00:00Z").clock,
  });
  roundTrip.importData(exported);
  assert.equal(roundTrip.getPreferences().sessionMode, "finite");
  assert.equal(roundTrip.getPreferences().sessionSize, 5);
  assert.ok(roundTrip.getReview("caro-kann-black", "imported-only"));

  const targetStorage = new MemoryStorage();
  const targetTime = fixedClock("2026-08-02T12:00:00Z");
  const target = Trainer.createTrainerStore("target", {
    storage: targetStorage,
    clock: targetTime.clock,
  });
  target.setSessionMode("endless");
  target.setSessionSize(20);
  target.recordOutcome("caro-kann-black", candidate("shared"), { solved: true });
  target.recordOutcome("caro-kann-black", candidate("shared"), { solved: true });
  target.recordOutcome("pirc-black", candidate("local-only"), { solved: true });

  const report = target.importData(exported);
  assert.equal(report.added, 1);
  assert.equal(target.getReview("caro-kann-black", "shared").encounters, 2);
  assert.ok(target.getReview("caro-kann-black", "imported-only"));
  assert.ok(target.getReview("pirc-black", "local-only"));
  assert.equal(target.getPreferences().sessionMode, "endless", "newer local mode wins");
  assert.equal(target.getPreferences().sessionSize, 20, "newer local preference wins");
  assert.equal(target.getPreferences().onboardingDismissed, true, "dismissal merges monotonically");

  target.importData(exported);
  assert.equal(target.getReview("caro-kann-black", "shared").encounters, 2);
  assert.throws(() => target.importData("{bad json"), /Could not parse/);
  assert.throws(() => target.importData({ schema: "wrong", version: 2 }), /not a Chess/);
  assert.throws(() => target.importData({ version: 99, reviews: {} }), /Unsupported/);
  assert.ok(target.getReview("pirc-black", "local-only"), "failed imports do not alter local data");
});

test("storage read failures fall back to usable in-memory trainer state", () => {
  const broken = {
    getItem() { throw new Error("blocked read"); },
    setItem() { throw new Error("blocked write"); },
  };
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage: broken, clock: time.clock });
  assert.equal(store.isPersistent(), false);
  const review = store.recordOutcome("caro-kann-black", candidate("memory"), { skipped: true });
  assert.equal(review.skips, 1);
  assert.equal(store.getReview("caro-kann-black", "memory").skips, 1);
  assert.match(store.getLastError().message, /blocked read/);
});

test("storage write failures retain the latest trainer state in memory", () => {
  const values = new Map();
  const broken = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem() { throw new Error("quota exceeded"); },
  };
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage: broken, clock: time.clock });
  const review = store.recordOutcome("caro-kann-black", candidate("memory"), { solved: true });
  assert.equal(review.cleanSolves, 1);
  assert.equal(store.isPersistent(), false);
  assert.equal(store.getReview("caro-kann-black", "memory").cleanSolves, 1);
  assert.match(store.getLastError().message, /quota exceeded/);
});

test("malformed stored JSON is repaired by the next successful mutation", () => {
  const storage = new MemoryStorage();
  storage.setItem(Trainer.storageKey("alice"), "{bad json");
  const time = fixedClock();
  const store = Trainer.createTrainerStore("alice", { storage, clock: time.clock });
  assert.match(store.getLastError().message, /JSON/);
  store.recordOutcome("caro-kann-black", candidate("repair"), { solved: true });
  const repaired = JSON.parse(storage.getItem(store.key));
  assert.equal(repaired.version, Trainer.CURRENT_VERSION);
  assert.equal(repaired.reviews["caro-kann-black"].repair.cleanSolves, 1);
});
