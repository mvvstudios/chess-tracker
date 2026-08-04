(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TrainerDomain = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CURRENT_VERSION = 2;
  const SESSION_VERSION = 1;
  const SESSION_SIZES = Object.freeze([5, 10, 20]);
  const DEFAULT_SESSION_SIZE = 10;
  const STORAGE_PREFIX = "chess-tracker:opening-trainer:v2:";
  const LEGACY_STORAGE_PREFIX = "chess-tracker:opening-trainer:v1:";
  const EXPORT_SCHEMA = "chess-tracker-opening-trainer";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETURN_SOON_MS = 10 * 60 * 1000;
  const CLEAN_INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30, 60]);
  const MASTER_STREAK = 3;
  const MASTER_INTERVAL_DAYS = 7;
  const COUNTER_FIELDS = Object.freeze([
    "encounters",
    "cleanSolves",
    "assistedSolves",
    "firstTrySolves",
    "unassistedSolves",
    "lapses",
    "totalIncorrect",
    "hints",
    "reveals",
    "skips",
  ]);

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function array(value) {
    return Array.isArray(value) ? value : [];
  }

  function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function nonnegativeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : (fallback === undefined ? 0 : fallback);
  }

  function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function normalizedUsername(username) {
    const value = text(username).toLowerCase();
    return value || "anonymous";
  }

  function storageKey(username) {
    return STORAGE_PREFIX + encodeURIComponent(normalizedUsername(username));
  }

  function legacyStorageKey(username) {
    return LEGACY_STORAGE_PREFIX + encodeURIComponent(normalizedUsername(username));
  }

  function normalizedDeckId(value) {
    const id = text(value).toLowerCase();
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : "";
  }

  function resolvedPuzzleId(value) {
    const raw = value && typeof value === "object"
      ? value.id || value.puzzleId || value.puzzle_id
      : value;
    const id = text(raw);
    return id && id.length <= 512 ? id : "";
  }

  function normalizeSessionSize(value, fallback) {
    const parsed = Math.floor(Number(value));
    if (SESSION_SIZES.includes(parsed)) return parsed;
    const normalizedFallback = Math.floor(Number(fallback));
    return SESSION_SIZES.includes(normalizedFallback)
      ? normalizedFallback
      : DEFAULT_SESSION_SIZE;
  }

  function timestampMillis(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  function optionalTimestamp(value) {
    const milliseconds = timestampMillis(value);
    return milliseconds === null ? null : new Date(milliseconds).toISOString();
  }

  function latestTimestamp(left, right) {
    const leftMs = timestampMillis(left);
    const rightMs = timestampMillis(right);
    if (leftMs === null) return optionalTimestamp(right);
    if (rightMs === null) return optionalTimestamp(left);
    return new Date(Math.max(leftMs, rightMs)).toISOString();
  }

  function earliestTimestamp(left, right) {
    const leftMs = timestampMillis(left);
    const rightMs = timestampMillis(right);
    if (leftMs === null) return optionalTimestamp(right);
    if (rightMs === null) return optionalTimestamp(left);
    return new Date(Math.min(leftMs, rightMs)).toISOString();
  }

  function clockValue(clock) {
    try {
      return typeof clock === "function" ? clock() : new Date();
    } catch (_error) {
      return new Date();
    }
  }

  function moment(at, clock) {
    return optionalTimestamp(at) || optionalTimestamp(clockValue(clock)) || new Date().toISOString();
  }

  function addMilliseconds(iso, milliseconds) {
    return new Date(Date.parse(iso) + milliseconds).toISOString();
  }

  function addDays(iso, days) {
    return addMilliseconds(iso, days * DAY_MS);
  }

  function uniqueStrings(values) {
    return [...new Set(array(values).map(text).filter(Boolean))];
  }

  function snapshotFrom(value) {
    const source = object(value);
    const nested = object(source.snapshot);
    const variation = text(nested.variation || source.variation);
    const curriculumGroup = text(
      nested.curriculumGroup || nested.curriculum_group
      || source.curriculumGroup || source.curriculum_group
    );
    const themes = uniqueStrings(
      nested.themes !== undefined ? nested.themes : source.themes
    );
    const difficulty = text(nested.difficulty || source.difficulty).toLowerCase();
    return { variation, curriculumGroup, themes, difficulty };
  }

  function mergeSnapshots(left, right) {
    const previous = snapshotFrom(left);
    const incoming = snapshotFrom(right);
    return {
      variation: incoming.variation || previous.variation,
      curriculumGroup: incoming.curriculumGroup || previous.curriculumGroup,
      themes: uniqueStrings(previous.themes.concat(incoming.themes)),
      difficulty: incoming.difficulty || previous.difficulty,
    };
  }

  function emptyPreferences() {
    return {
      lastDeckId: null,
      sessionSize: DEFAULT_SESSION_SIZE,
      onboardingDismissed: false,
      updatedAt: null,
    };
  }

  function sanitizePreferences(rawPreferences, fallbackUpdatedAt) {
    const raw = object(rawPreferences);
    const deckId = normalizedDeckId(
      raw.lastDeckId || raw.last_deck_id || raw.lastDeck || raw.deckId
    );
    return {
      lastDeckId: deckId || null,
      sessionSize: normalizeSessionSize(
        raw.sessionSize !== undefined ? raw.sessionSize
          : raw.session_size !== undefined ? raw.session_size
            : raw.sessionLength,
        DEFAULT_SESSION_SIZE,
      ),
      onboardingDismissed: raw.onboardingDismissed === true
        || raw.onboarding_dismissed === true
        || raw.onboardingSeen === true,
      updatedAt: optionalTimestamp(raw.updatedAt || raw.updated_at || fallbackUpdatedAt),
    };
  }

  function emptyReview(deckId, puzzleId, at) {
    return {
      deckId,
      puzzleId,
      encounters: 0,
      cleanSolves: 0,
      assistedSolves: 0,
      firstTrySolves: 0,
      unassistedSolves: 0,
      lapses: 0,
      totalIncorrect: 0,
      hints: 0,
      reveals: 0,
      skips: 0,
      correctStreak: 0,
      intervalDays: 0,
      dueAt: null,
      lastSeenAt: null,
      lastOutcome: null,
      mistakeAt: null,
      masteredAt: null,
      legacySolved: false,
      legacySolvedAt: null,
      snapshot: { variation: "", curriculumGroup: "", themes: [], difficulty: "" },
      createdAt: at || null,
      updatedAt: at || null,
    };
  }

  function sanitizeReview(deckId, puzzleId, rawReview) {
    const raw = object(rawReview);
    const fallbackAt = optionalTimestamp(raw.updatedAt || raw.updated_at || raw.lastSeenAt);
    const record = emptyReview(deckId, puzzleId, fallbackAt);
    COUNTER_FIELDS.forEach(field => {
      const snake = field.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`);
      record[field] = nonnegativeInteger(
        raw[field] !== undefined ? raw[field] : raw[snake],
        0,
      );
    });
    record.encounters = nonnegativeInteger(
      raw.encounters !== undefined ? raw.encounters
        : raw.timesSeen !== undefined ? raw.timesSeen
          : raw.times_seen,
      record.encounters,
    );
    record.correctStreak = nonnegativeInteger(
      raw.correctStreak !== undefined ? raw.correctStreak
        : raw.correct_streak !== undefined ? raw.correct_streak
          : raw.streak,
      0,
    );
    record.intervalDays = Math.max(0, finiteNumber(
      raw.intervalDays !== undefined ? raw.intervalDays : raw.interval_days,
      0,
    ));
    const legacyStatus = text(raw.classification || raw.status).toLowerCase();
    if (legacyStatus === "mastered") {
      record.correctStreak = Math.max(MASTER_STREAK, record.correctStreak);
      record.intervalDays = Math.max(MASTER_INTERVAL_DAYS, record.intervalDays);
      record.encounters = Math.max(1, record.encounters);
    }
    record.dueAt = optionalTimestamp(raw.dueAt || raw.due_at);
    record.lastSeenAt = optionalTimestamp(raw.lastSeenAt || raw.last_seen_at);
    record.lastOutcome = text(raw.lastOutcome || raw.last_outcome) || null;
    record.mistakeAt = optionalTimestamp(
      raw.mistakeAt || raw.mistake_at || raw.lastMistakeAt || raw.last_mistake_at
    );
    record.masteredAt = optionalTimestamp(raw.masteredAt || raw.mastered_at);
    record.legacySolved = raw.legacySolved === true || raw.legacy_solved === true;
    record.legacySolvedAt = optionalTimestamp(raw.legacySolvedAt || raw.legacy_solved_at);
    record.snapshot = snapshotFrom(raw.snapshot && typeof raw.snapshot === "object"
      ? raw.snapshot
      : raw);
    record.createdAt = optionalTimestamp(raw.createdAt || raw.created_at) || fallbackAt;
    record.updatedAt = fallbackAt || record.createdAt;
    return record;
  }

  function emptyState(username) {
    return {
      version: CURRENT_VERSION,
      username: normalizedUsername(username),
      preferences: emptyPreferences(),
      reviews: Object.create(null),
      updatedAt: null,
    };
  }

  function reviewContainers(raw) {
    const direct = object(raw.reviews);
    if (Object.keys(direct).length) return direct;
    const decks = object(raw.decks);
    const result = Object.create(null);
    Object.keys(decks).forEach(deckId => {
      const deck = object(decks[deckId]);
      result[deckId] = object(deck.reviews && typeof deck.reviews === "object"
        ? deck.reviews : deck);
    });
    return result;
  }

  function assertSupportedEnvelope(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("Trainer progress must be a JSON object.");
    }
    const version = Number(raw.version);
    if (version !== 1 && version !== CURRENT_VERSION) {
      throw new Error(`Unsupported trainer progress version: ${text(raw.version) || "missing"}.`);
    }
    if (raw.preferences !== undefined
        && (!raw.preferences || typeof raw.preferences !== "object" || Array.isArray(raw.preferences))) {
      throw new TypeError("Trainer preferences must be an object.");
    }
    if (raw.reviews !== undefined
        && (!raw.reviews || typeof raw.reviews !== "object" || Array.isArray(raw.reviews))) {
      throw new TypeError("Trainer reviews must be grouped by deck.");
    }
    if (raw.decks !== undefined
        && (!raw.decks || typeof raw.decks !== "object" || Array.isArray(raw.decks))) {
      throw new TypeError("Trainer deck reviews must be an object.");
    }
    return version;
  }

  function sanitizeEnvelope(username, rawEnvelope) {
    assertSupportedEnvelope(rawEnvelope);
    const raw = object(rawEnvelope);
    const state = emptyState(username);
    state.preferences = sanitizePreferences(raw.preferences, raw.updatedAt || raw.updated_at);
    const containers = reviewContainers(raw);
    Object.keys(containers).forEach(rawDeckId => {
      const deckId = normalizedDeckId(rawDeckId);
      if (!deckId) return;
      const records = object(containers[rawDeckId]);
      const sanitized = Object.create(null);
      Object.keys(records).forEach(rawPuzzleId => {
        const puzzleId = resolvedPuzzleId(rawPuzzleId);
        if (!puzzleId) return;
        sanitized[puzzleId] = sanitizeReview(deckId, puzzleId, records[rawPuzzleId]);
      });
      if (Object.keys(sanitized).length) state.reviews[deckId] = sanitized;
    });
    state.updatedAt = optionalTimestamp(raw.updatedAt || raw.updated_at)
      || state.preferences.updatedAt;
    return state;
  }

  function reviewRecency(record) {
    return timestampMillis(record && (record.updatedAt || record.lastSeenAt || record.createdAt)) || 0;
  }

  function mergeReviewRecords(leftRecord, rightRecord) {
    if (!leftRecord) return clone(rightRecord);
    if (!rightRecord) return clone(leftRecord);
    const left = sanitizeReview(leftRecord.deckId, leftRecord.puzzleId, leftRecord);
    const right = sanitizeReview(rightRecord.deckId, rightRecord.puzzleId, rightRecord);
    const latest = reviewRecency(right) >= reviewRecency(left) ? right : left;
    const merged = clone(latest);
    COUNTER_FIELDS.forEach(field => {
      merged[field] = Math.max(left[field] || 0, right[field] || 0);
    });
    merged.snapshot = mergeSnapshots(left.snapshot, right.snapshot);
    merged.createdAt = earliestTimestamp(left.createdAt, right.createdAt);
    merged.updatedAt = latestTimestamp(left.updatedAt, right.updatedAt);
    merged.lastSeenAt = latestTimestamp(left.lastSeenAt, right.lastSeenAt);
    merged.mistakeAt = latestTimestamp(left.mistakeAt, right.mistakeAt);
    merged.legacySolved = Boolean(left.legacySolved || right.legacySolved);
    merged.legacySolvedAt = earliestTimestamp(left.legacySolvedAt, right.legacySolvedAt);
    return merged;
  }

  function mergePreferences(leftPreferences, rightPreferences) {
    const left = sanitizePreferences(leftPreferences);
    const right = sanitizePreferences(rightPreferences);
    const leftHasData = Boolean(left.updatedAt || left.lastDeckId
      || left.sessionSize !== DEFAULT_SESSION_SIZE || left.onboardingDismissed);
    const rightHasData = Boolean(right.updatedAt || right.lastDeckId
      || right.sessionSize !== DEFAULT_SESSION_SIZE || right.onboardingDismissed);
    const rightIsNewer = (!leftHasData && rightHasData)
      || (timestampMillis(right.updatedAt) || 0) > (timestampMillis(left.updatedAt) || 0);
    const preferred = rightIsNewer ? right : left;
    return {
      lastDeckId: preferred.lastDeckId || left.lastDeckId || right.lastDeckId || null,
      sessionSize: normalizeSessionSize(preferred.sessionSize, DEFAULT_SESSION_SIZE),
      onboardingDismissed: Boolean(left.onboardingDismissed || right.onboardingDismissed),
      updatedAt: latestTimestamp(left.updatedAt, right.updatedAt),
    };
  }

  function mergeStates(username, leftState, rightState) {
    const left = leftState || emptyState(username);
    const right = rightState || emptyState(username);
    const merged = emptyState(username);
    merged.preferences = mergePreferences(left.preferences, right.preferences);
    const deckIds = new Set(Object.keys(object(left.reviews)).concat(Object.keys(object(right.reviews))));
    deckIds.forEach(deckId => {
      const normalized = normalizedDeckId(deckId);
      if (!normalized) return;
      const leftRecords = object(left.reviews && left.reviews[deckId]);
      const rightRecords = object(right.reviews && right.reviews[deckId]);
      const ids = new Set(Object.keys(leftRecords).concat(Object.keys(rightRecords)));
      const records = Object.create(null);
      ids.forEach(puzzleId => {
        records[puzzleId] = mergeReviewRecords(leftRecords[puzzleId], rightRecords[puzzleId]);
      });
      if (Object.keys(records).length) merged.reviews[normalized] = records;
    });
    merged.updatedAt = latestTimestamp(left.updatedAt, right.updatedAt)
      || merged.preferences.updatedAt;
    return merged;
  }

  function classifyReview(rawRecord, at) {
    if (!rawRecord || typeof rawRecord !== "object") return "New";
    const encounters = nonnegativeInteger(rawRecord.encounters, 0);
    if (!encounters) return "New";
    const suppliedNowMs = timestampMillis(at);
    const nowMs = suppliedNowMs === null ? Date.now() : suppliedNowMs;
    const dueMs = timestampMillis(rawRecord.dueAt || rawRecord.due_at);
    if (dueMs !== null && dueMs <= nowMs) return "Due";
    const streak = nonnegativeInteger(
      rawRecord.correctStreak !== undefined ? rawRecord.correctStreak : rawRecord.correct_streak,
      0,
    );
    const interval = Math.max(0, finiteNumber(
      rawRecord.intervalDays !== undefined ? rawRecord.intervalDays : rawRecord.interval_days,
      0,
    ));
    if (streak >= MASTER_STREAK && interval >= MASTER_INTERVAL_DAYS) return "Mastered";
    return "Learning";
  }

  function normalizeOutcome(rawOutcome) {
    const raw = object(rawOutcome);
    const incorrectCount = nonnegativeInteger(
      raw.incorrectCount !== undefined ? raw.incorrectCount
        : raw.incorrect_count !== undefined ? raw.incorrect_count
          : raw.incorrect,
      0,
    );
    const hintsUsed = nonnegativeInteger(
      raw.hintsUsed !== undefined ? raw.hintsUsed
        : raw.hints !== undefined ? raw.hints
          : raw.hintUsed || raw.hinted ? 1 : 0,
      0,
    );
    const solved = raw.solved === true;
    const revealed = raw.revealed === true || raw.solutionRevealed === true;
    const skipped = raw.skipped === true;
    const firstTry = solved && incorrectCount === 0 && !revealed && !skipped;
    const unassisted = firstTry && hintsUsed === 0;
    const mistake = !solved || incorrectCount > 0 || hintsUsed > 0 || revealed || skipped;
    return {
      solved,
      incorrectCount,
      hintsUsed,
      revealed,
      skipped,
      firstTry,
      unassisted,
      mistake,
    };
  }

  function outcomeName(outcome) {
    if (outcome.skipped) return "skipped";
    if (outcome.revealed) return "revealed";
    if (outcome.incorrectCount > 0) return outcome.solved ? "solved-after-mistake" : "incorrect";
    if (outcome.hintsUsed > 0) return outcome.solved ? "hinted-solve" : "hinted";
    if (outcome.unassisted) return "clean-solve";
    if (outcome.solved) return "assisted-solve";
    return "incomplete";
  }

  function reviewAfterOutcome(rawRecord, rawOutcome, rawSnapshot, at) {
    const existing = sanitizeReview(rawRecord.deckId, rawRecord.puzzleId, rawRecord);
    const outcome = normalizeOutcome(rawOutcome);
    const next = clone(existing);
    next.encounters += 1;
    next.totalIncorrect += outcome.incorrectCount;
    next.hints += outcome.hintsUsed;
    next.reveals += outcome.revealed ? 1 : 0;
    next.skips += outcome.skipped ? 1 : 0;
    if (outcome.firstTry) next.firstTrySolves += 1;
    if (outcome.unassisted) next.unassistedSolves += 1;
    if (outcome.solved && outcome.unassisted) next.cleanSolves += 1;
    if (outcome.solved && !outcome.unassisted) next.assistedSolves += 1;
    next.snapshot = mergeSnapshots(existing.snapshot, rawSnapshot);
    next.lastSeenAt = at;
    next.lastOutcome = outcomeName(outcome);
    next.updatedAt = at;
    next.createdAt = existing.createdAt || at;

    if (outcome.unassisted) {
      next.correctStreak += 1;
      const index = Math.min(next.correctStreak - 1, CLEAN_INTERVAL_DAYS.length - 1);
      next.intervalDays = CLEAN_INTERVAL_DAYS[index];
      next.dueAt = addDays(at, next.intervalDays);
      if (next.correctStreak >= MASTER_STREAK
          && next.intervalDays >= MASTER_INTERVAL_DAYS) {
        next.masteredAt = next.masteredAt || at;
      }
    } else {
      next.lapses += 1;
      next.correctStreak = 0;
      next.intervalDays = RETURN_SOON_MS / DAY_MS;
      next.dueAt = addMilliseconds(at, RETURN_SOON_MS);
      next.masteredAt = null;
      next.mistakeAt = at;
    }
    return next;
  }

  function browserStorage() {
    try {
      return typeof globalThis !== "undefined" && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    } catch (_error) {
      return null;
    }
  }

  function storageOptions(rawOptions) {
    if (rawOptions && typeof rawOptions.getItem === "function") {
      return { storage: rawOptions };
    }
    return object(rawOptions);
  }

  function createTrainerStore(username, rawOptions) {
    const subject = normalizedUsername(username);
    const options = storageOptions(rawOptions);
    const key = storageKey(subject);
    const oldKey = legacyStorageKey(subject);
    const clock = typeof options.clock === "function" ? options.clock : () => new Date();
    let storage = Object.prototype.hasOwnProperty.call(options, "storage")
      ? options.storage : browserStorage();
    let persistent = Boolean(
      storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
    );
    let lastError = null;
    let state = emptyState(subject);

    function rememberError(error, disablePersistence) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (disablePersistence) persistent = false;
    }

    function parseStored(raw, sourceKey) {
      if (raw === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        rememberError(error, false);
        return null;
      }
      try {
        return sanitizeEnvelope(subject, parsed);
      } catch (error) {
        const futureVersion = parsed && Number(parsed.version) > CURRENT_VERSION;
        rememberError(new Error(`${sourceKey}: ${error.message || error}`), futureVersion);
        return null;
      }
    }

    function writeState() {
      if (!persistent) return false;
      try {
        storage.setItem(key, JSON.stringify(state));
        return true;
      } catch (error) {
        rememberError(error, true);
        return false;
      }
    }

    function sync() {
      if (!persistent) return;
      let currentRaw;
      let legacyRaw;
      try {
        currentRaw = storage.getItem(key);
        legacyRaw = storage.getItem(oldKey);
      } catch (error) {
        rememberError(error, true);
        return;
      }
      const current = parseStored(currentRaw, key);
      if (!persistent) return;
      const legacy = parseStored(legacyRaw, oldKey);
      if (!persistent) return;
      const next = mergeStates(subject, current || emptyState(subject), legacy);
      let currentVersion = null;
      if (currentRaw !== null) {
        try {
          currentVersion = Number(JSON.parse(currentRaw).version);
        } catch (_error) {
          currentVersion = null;
        }
      }
      const needsMigrationWrite = currentVersion === 1 || Boolean(legacy)
        && (currentRaw === null || JSON.stringify(current) !== JSON.stringify(next));
      state = next;
      if (needsMigrationWrite) writeState();
    }

    function updateState(at) {
      state.version = CURRENT_VERSION;
      state.username = subject;
      state.updatedAt = at;
      writeState();
    }

    function requireDeckAndPuzzle(deckValue, candidateOrId) {
      const deckId = normalizedDeckId(deckValue);
      const puzzleId = resolvedPuzzleId(candidateOrId);
      if (!deckId) throw new TypeError("A valid opening deck ID is required.");
      if (!puzzleId) throw new TypeError("A valid puzzle ID is required.");
      return { deckId, puzzleId };
    }

    function reviewAt(deckId, puzzleId) {
      return state.reviews[deckId] && state.reviews[deckId][puzzleId] || null;
    }

    function saveReview(record, at) {
      if (!state.reviews[record.deckId]) state.reviews[record.deckId] = Object.create(null);
      state.reviews[record.deckId][record.puzzleId] = sanitizeReview(
        record.deckId,
        record.puzzleId,
        record,
      );
      updateState(at);
      return clone(state.reviews[record.deckId][record.puzzleId]);
    }

    function getReview(deckValue, candidateOrId) {
      sync();
      const ids = requireDeckAndPuzzle(deckValue, candidateOrId);
      return clone(reviewAt(ids.deckId, ids.puzzleId));
    }

    function recordOutcome(deckValue, candidateOrId, rawOutcome, explicitSnapshot, at) {
      sync();
      const ids = requireDeckAndPuzzle(deckValue, candidateOrId);
      const when = moment(at, clock);
      const current = reviewAt(ids.deckId, ids.puzzleId)
        || emptyReview(ids.deckId, ids.puzzleId, when);
      const candidateSnapshot = snapshotFrom(candidateOrId);
      const combinedSnapshot = mergeSnapshots(candidateSnapshot, explicitSnapshot);
      return saveReview(reviewAfterOutcome(current, rawOutcome, combinedSnapshot, when), when);
    }

    function migrateLegacySolved(deckValue, candidateOrId, legacyProgress, explicitSnapshot, at) {
      sync();
      const ids = requireDeckAndPuzzle(deckValue, candidateOrId);
      const legacy = object(legacyProgress);
      const solvedAt = optionalTimestamp(legacy.solvedAt || legacy.solved_at);
      const solved = legacy.status === "solved" || Boolean(solvedAt);
      const existing = reviewAt(ids.deckId, ids.puzzleId);
      const combinedSnapshot = mergeSnapshots(snapshotFrom(candidateOrId), explicitSnapshot);
      if (!solved) return { record: clone(existing), migrated: false };
      if (existing) {
        const mergedSnapshot = mergeSnapshots(existing.snapshot, combinedSnapshot);
        if (JSON.stringify(existing.snapshot) !== JSON.stringify(mergedSnapshot)) {
          const when = moment(at, clock);
          const updated = clone(existing);
          updated.snapshot = mergedSnapshot;
          updated.updatedAt = when;
          return { record: saveReview(updated, when), migrated: false };
        }
        return { record: clone(existing), migrated: false };
      }

      const when = moment(at, clock);
      const seenAt = solvedAt || when;
      const record = emptyReview(ids.deckId, ids.puzzleId, seenAt);
      record.encounters = 1;
      record.assistedSolves = 1;
      record.correctStreak = 0;
      record.intervalDays = 1;
      record.lastSeenAt = seenAt;
      record.lastOutcome = "legacy-solved";
      record.legacySolved = true;
      record.legacySolvedAt = solvedAt;
      record.snapshot = combinedSnapshot;
      record.dueAt = addDays(seenAt, 1);
      const attempts = nonnegativeInteger(legacy.attempts, 0);
      const revealedAt = optionalTimestamp(
        legacy.solutionRevealedAt || legacy.solution_revealed_at
      );
      if (attempts > 1 || revealedAt) record.mistakeAt = revealedAt || seenAt;
      record.updatedAt = when;
      return { record: saveReview(record, when), migrated: true };
    }

    function upsertSnapshot(deckValue, candidateOrId, explicitSnapshot, at) {
      sync();
      const ids = requireDeckAndPuzzle(deckValue, candidateOrId);
      const when = moment(at, clock);
      const existing = reviewAt(ids.deckId, ids.puzzleId)
        || emptyReview(ids.deckId, ids.puzzleId, when);
      const next = clone(existing);
      next.snapshot = mergeSnapshots(
        mergeSnapshots(existing.snapshot, snapshotFrom(candidateOrId)),
        explicitSnapshot,
      );
      next.updatedAt = when;
      return saveReview(next, when);
    }

    function recordsForDeck(deckValue) {
      const deckId = normalizedDeckId(deckValue);
      if (!deckId) throw new TypeError("A valid opening deck ID is required.");
      sync();
      return Object.values(object(state.reviews[deckId]));
    }

    function dueReviews(deckValue, at) {
      const when = moment(at, clock);
      return recordsForDeck(deckValue)
        .filter(record => classifyReview(record, when) === "Due")
        .sort((left, right) => (timestampMillis(left.dueAt) || 0) - (timestampMillis(right.dueAt) || 0)
          || left.puzzleId.localeCompare(right.puzzleId))
        .map(record => ({ ...clone(record), classification: "Due" }));
    }

    function mistakeReviews(deckValue, rawQuery) {
      const query = object(rawQuery);
      const sinceMs = timestampMillis(query.since);
      const limit = query.limit === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, nonnegativeInteger(query.limit, 0));
      return recordsForDeck(deckValue)
        .filter(record => record.mistakeAt
          && (sinceMs === null || timestampMillis(record.mistakeAt) >= sinceMs))
        .sort((left, right) => (timestampMillis(right.mistakeAt) || 0)
          - (timestampMillis(left.mistakeAt) || 0)
          || left.puzzleId.localeCompare(right.puzzleId))
        .slice(0, limit)
        .map(record => ({
          ...clone(record),
          classification: classifyReview(record, moment(query.at, clock)),
        }));
    }

    function reviewCounts(deckValue, candidateValues, at) {
      sync();
      const deckId = normalizedDeckId(deckValue);
      if (!deckId) throw new TypeError("A valid opening deck ID is required.");
      const when = moment(at, clock);
      const supplied = Array.isArray(candidateValues);
      const ids = supplied
        ? candidateValues.map(resolvedPuzzleId).filter(Boolean)
        : Object.keys(object(state.reviews[deckId]));
      const counts = { New: 0, Learning: 0, Due: 0, Mastered: 0, total: 0 };
      [...new Set(ids)].forEach(puzzleId => {
        const classification = classifyReview(reviewAt(deckId, puzzleId), when);
        counts[classification] += 1;
        counts.total += 1;
      });
      return counts;
    }

    function setPreferences(patch, at) {
      sync();
      const raw = object(patch);
      const when = moment(at, clock);
      const next = clone(state.preferences);
      if (Object.prototype.hasOwnProperty.call(raw, "lastDeckId")) {
        next.lastDeckId = raw.lastDeckId === null ? null : normalizedDeckId(raw.lastDeckId) || next.lastDeckId;
      }
      if (Object.prototype.hasOwnProperty.call(raw, "sessionSize")) {
        next.sessionSize = normalizeSessionSize(raw.sessionSize, next.sessionSize);
      }
      if (Object.prototype.hasOwnProperty.call(raw, "onboardingDismissed")) {
        next.onboardingDismissed = raw.onboardingDismissed === true;
      }
      next.updatedAt = when;
      state.preferences = sanitizePreferences(next, when);
      updateState(when);
      return clone(state.preferences);
    }

    function exportedData() {
      sync();
      return JSON.stringify({
        schema: EXPORT_SCHEMA,
        version: CURRENT_VERSION,
        exportedAt: moment(undefined, clock),
        data: clone(state),
      }, null, 2);
    }

    function importedEnvelope(payload) {
      let parsed = payload;
      if (typeof payload === "string") {
        try {
          parsed = JSON.parse(payload);
        } catch (error) {
          throw new SyntaxError(`Could not parse trainer progress JSON: ${error.message}`);
        }
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("Trainer progress import must be a JSON object.");
      }
      if (parsed.schema !== undefined && parsed.schema !== EXPORT_SCHEMA) {
        throw new Error("This file is not a Chess Opening Puzzle Trainer export.");
      }
      if (parsed.schema === EXPORT_SCHEMA
          && (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data))) {
        throw new TypeError("The trainer export does not contain a progress envelope.");
      }
      const envelope = parsed.data !== undefined ? parsed.data : parsed;
      assertSupportedEnvelope(envelope);
      return sanitizeEnvelope(subject, envelope);
    }

    function countReviews(rawState) {
      return Object.values(object(rawState.reviews))
        .reduce((total, records) => total + Object.keys(object(records)).length, 0);
    }

    function importData(payload, at) {
      const incoming = importedEnvelope(payload);
      sync();
      const before = countReviews(state);
      state = mergeStates(subject, state, incoming);
      const when = moment(at, clock);
      state.updatedAt = when;
      writeState();
      return {
        imported: countReviews(incoming),
        total: countReviews(state),
        added: Math.max(0, countReviews(state) - before),
        state: clone(state),
      };
    }

    function createStoredSession(config) {
      sync();
      const raw = { ...object(config) };
      if (raw.size === undefined) raw.size = state.preferences.sessionSize;
      return createSession(raw, moment(undefined, clock));
    }

    function finalizeAndRecord(session, index, rawOutcome, candidate, at) {
      const when = moment(at, clock);
      const finalized = finalizeSessionResult(session, index, rawOutcome, candidate, when);
      if (finalized.accepted) {
        recordOutcome(
          finalized.session.deckId,
          finalized.result.puzzleId,
          rawOutcome,
          snapshotFrom(candidate),
          when,
        );
      }
      return finalized;
    }

    sync();

    return Object.freeze({
      key,
      legacyKey: oldKey,
      version: CURRENT_VERSION,

      getState() {
        sync();
        return clone(state);
      },

      getPreferences() {
        sync();
        return clone(state.preferences);
      },

      setPreferences,

      setLastDeck(deckId, at) {
        return setPreferences({ lastDeckId: deckId }, at);
      },

      setSessionSize(size, at) {
        return setPreferences({ sessionSize: size }, at);
      },

      dismissOnboarding(at) {
        return setPreferences({ onboardingDismissed: true }, at);
      },

      getReview,

      classify(deckId, candidateOrId, at) {
        return classifyReview(getReview(deckId, candidateOrId), moment(at, clock));
      },

      recordOutcome,
      migrateLegacySolved,
      upsertSnapshot,
      dueReviews,
      mistakeReviews,

      mistakeIds(deckId, query) {
        return mistakeReviews(deckId, query).map(record => record.puzzleId);
      },

      reviewCounts,

      createSession: createStoredSession,

      finalizeSessionResult(session, index, outcome, candidate, at) {
        return finalizeAndRecord(session, index, outcome, candidate, at);
      },

      finalizeCurrentSessionResult(session, outcome, candidate, at) {
        const item = currentSessionItem(session);
        if (!item) {
          return { session: clone(session), accepted: false, result: null };
        }
        return finalizeAndRecord(session, item.index, outcome, candidate, at);
      },

      exportData: exportedData,
      importData,

      refresh() {
        sync();
        return clone(state);
      },

      isPersistent() {
        return persistent;
      },

      getLastError() {
        return lastError;
      },
    });
  }

  function sessionPuzzleIds(config) {
    const raw = object(config);
    const values = raw.puzzleIds || raw.puzzle_ids || raw.candidateIds || raw.candidate_ids;
    return array(values).map(resolvedPuzzleId).filter(Boolean);
  }

  function createSession(rawConfig, at) {
    const config = object(rawConfig);
    const deckId = normalizedDeckId(config.deckId || config.deck_id);
    if (!deckId) throw new TypeError("A valid opening deck ID is required for a session.");
    const size = normalizeSessionSize(config.size, DEFAULT_SESSION_SIZE);
    const ids = sessionPuzzleIds(config);
    if (ids.length < size) {
      throw new RangeError(`A ${size}-puzzle session requires at least ${size} puzzle IDs.`);
    }
    const startedAt = moment(config.startedAt || config.started_at || at);
    const sessionId = text(config.id) || `${deckId}:${startedAt}`;
    return {
      version: SESSION_VERSION,
      id: sessionId,
      deckId,
      mode: text(config.mode) || "adaptive",
      size,
      startedAt,
      completedAt: null,
      finished: false,
      cursor: 0,
      // `puzzleIds` and `results` are controller-friendly aliases. The indexed
      // items remain authoritative for exactly-once pure finalization.
      puzzleIds: ids.slice(0, size),
      results: [],
      items: ids.slice(0, size).map((puzzleId, index) => ({
        index,
        puzzleId,
        result: null,
      })),
    };
  }

  function validSession(rawSession) {
    const session = object(rawSession);
    return Number(session.version) === SESSION_VERSION
      && Boolean(normalizedDeckId(session.deckId))
      && SESSION_SIZES.includes(Number(session.size))
      && Array.isArray(session.items)
      && session.items.length === Number(session.size);
  }

  function currentSessionItem(rawSession) {
    if (!validSession(rawSession)) return null;
    const item = rawSession.items.find(entry => entry && !entry.result);
    return item ? clone(item) : null;
  }

  function sessionProgress(rawSession) {
    if (!validSession(rawSession)) {
      return { completed: 0, total: 0, current: 0, complete: false };
    }
    const completed = rawSession.items.filter(item => item && item.result).length;
    return {
      completed,
      total: rawSession.size,
      current: completed >= rawSession.size ? rawSession.size : completed + 1,
      complete: completed === rawSession.size,
    };
  }

  function resultSnapshot(candidate) {
    return snapshotFrom(candidate);
  }

  function finalizeSessionResult(rawSession, rawIndex, rawOutcome, candidate, at) {
    if (!validSession(rawSession)) throw new TypeError("A valid finite trainer session is required.");
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= rawSession.items.length) {
      throw new RangeError("The session result index is out of range.");
    }
    const session = clone(rawSession);
    const item = session.items[index];
    if (item.result) {
      return { session, accepted: false, result: clone(item.result) };
    }
    const when = moment(at);
    const outcome = normalizeOutcome(rawOutcome);
    const snapshot = resultSnapshot(candidate);
    const result = {
      index,
      puzzleId: item.puzzleId,
      solved: outcome.solved,
      incorrectCount: outcome.incorrectCount,
      hintsUsed: outcome.hintsUsed,
      revealed: outcome.revealed,
      skipped: outcome.skipped,
      firstTry: outcome.firstTry,
      unassisted: outcome.unassisted,
      mistake: outcome.mistake,
      variation: snapshot.variation,
      curriculumGroup: snapshot.curriculumGroup,
      themes: snapshot.themes,
      difficulty: snapshot.difficulty,
      completedAt: when,
    };
    item.result = result;
    session.results = session.items.map(entry => entry && entry.result).filter(Boolean);
    const next = session.items.find(entry => entry && !entry.result);
    session.cursor = next ? next.index : session.size;
    if (!next) {
      session.completedAt = when;
      session.finished = true;
    }
    return { session, accepted: true, result: clone(result) };
  }

  function finalizeCurrentSessionResult(session, outcome, candidate, at) {
    const item = currentSessionItem(session);
    if (!item) return { session: clone(session), accepted: false, result: null };
    return finalizeSessionResult(session, item.index, outcome, candidate, at);
  }

  function rankedCounts(map) {
    return [...map.entries()].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }

  function summarizeSession(rawSession) {
    const session = object(rawSession);
    const controllerResults = array(session.results).filter(result => result && typeof result === "object");
    const itemResults = validSession(session)
      ? session.items.map(item => item && item.result).filter(Boolean)
      : [];
    const results = controllerResults.length ? controllerResults : itemResults;
    const total = nonnegativeInteger(session.size, 0);
    if (!total || (!validSession(session) && !Array.isArray(session.results))) {
      throw new TypeError("A valid finite trainer session is required.");
    }
    const weakVariations = new Map();
    const weakThemes = new Map();
    const mistakeIds = [];
    const seenMistakes = new Set();
    let firstTryCorrect = 0;
    let unassisted = 0;
    let hints = 0;
    let reveals = 0;
    let skips = 0;
    results.forEach(result => {
      if (result.firstTry) firstTryCorrect += 1;
      if (result.unassisted) unassisted += 1;
      hints += nonnegativeInteger(
        result.hintsUsed !== undefined ? result.hintsUsed : result.hintUsed ? 1 : 0,
        0,
      );
      reveals += result.revealed ? 1 : 0;
      skips += result.skipped ? 1 : 0;
      const mistake = result.mistake === true || result.skipped === true
        || result.revealed === true || result.hintUsed === true
        || nonnegativeInteger(result.hintsUsed, 0) > 0
        || nonnegativeInteger(result.incorrectCount, 0) > 0
        || result.firstTry !== true || result.unassisted !== true;
      if (!mistake) return;
      if (!seenMistakes.has(result.puzzleId)) {
        seenMistakes.add(result.puzzleId);
        mistakeIds.push(result.puzzleId);
      }
      const variation = text(result.variation);
      if (variation) weakVariations.set(variation, (weakVariations.get(variation) || 0) + 1);
      uniqueStrings(result.themes).forEach(theme => {
        weakThemes.set(theme, (weakThemes.get(theme) || 0) + 1);
      });
    });
    const completed = results.length;
    return {
      completed,
      total,
      firstTryCorrect,
      firstTryAccuracy: completed ? Math.round((firstTryCorrect / completed) * 1000) / 10 : 0,
      unassisted,
      hints,
      reveals,
      skips,
      weakVariations: rankedCounts(weakVariations),
      weakThemes: rankedCounts(weakThemes),
      mistakeIds,
      complete: completed >= total,
    };
  }

  return Object.freeze({
    CURRENT_VERSION,
    SESSION_SIZES,
    DEFAULT_SESSION_SIZE,
    STORAGE_PREFIX,
    LEGACY_STORAGE_PREFIX,
    EXPORT_SCHEMA,
    normalizedUsername,
    storageKey,
    legacyStorageKey,
    normalizeSessionSize,
    classifyReview,
    normalizeOutcome,
    createTrainerStore,
    createSession,
    currentSessionItem,
    sessionProgress,
    finalizeSessionResult,
    finalizeCurrentSessionResult,
    summarizeSession,
  });
}));
