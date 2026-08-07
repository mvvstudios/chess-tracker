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
  const SESSION_MODES = Object.freeze(["endless", "finite"]);
  const DEFAULT_SESSION_MODE = "finite";
  const TRAINING_DEFAULTS_VERSION = 1;
  const STORAGE_PREFIX = "chess-tracker:opening-trainer:v2:";
  const LEGACY_STORAGE_PREFIX = "chess-tracker:opening-trainer:v1:";
  const EXPORT_SCHEMA = "chess-tracker-opening-trainer";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETURN_SOON_MS = 10 * 60 * 1000;
  const CLEAN_INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30, 60]);
  const MASTER_STREAK = 3;
  const MASTER_INTERVAL_DAYS = 7;
  const SELECTION_SCHEMA_VERSION = 1;
  const MAX_SELECTION_COHORTS = 8;
  const SELECTION_RECENT_LIMIT = 64;
  const ACTIVE_SELECTION_TTL_MS = DAY_MS;
  const GUIDED_RATING_WINDOW_SIZE = 80;
  const GUIDED_THEME_CAP = 5;
  const GUIDED_SIGNATURE_CAP = 2;
  const GUIDED_CAP_WINDOW = 20;
  const DIFFICULTY_ORDER = Object.freeze([
    "beginner", "developing", "intermediate", "advanced", "expert",
  ]);
  const FOCUSED_DIFFICULTY_CADENCE = Object.freeze([
    "beginner", "developing", "intermediate", "advanced", "beginner",
    "developing", "expert", "intermediate", "beginner", "developing",
    "advanced", "beginner", "developing", "intermediate", "beginner",
    "developing", "advanced", "intermediate", "beginner", "developing",
  ]);
  const FOCUSED_DIFFICULTY_QUOTAS = Object.freeze({
    beginner: 6,
    developing: 6,
    intermediate: 4,
    advanced: 3,
    expert: 1,
  });
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

  function normalizeSessionMode(value, fallback) {
    const normalized = text(value).toLowerCase();
    if (SESSION_MODES.includes(normalized)) return normalized;
    const normalizedFallback = text(fallback).toLowerCase();
    return SESSION_MODES.includes(normalizedFallback)
      ? normalizedFallback
      : DEFAULT_SESSION_MODE;
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

  function collection(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    return [];
  }

  function boundedIds(values, limit) {
    const maximum = Math.max(0, nonnegativeInteger(limit, SELECTION_RECENT_LIMIT));
    return [...new Set(collection(values).map(resolvedPuzzleId).filter(Boolean))].slice(0, maximum);
  }

  function normalizedWords(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function normalizedSelectionMode(value) {
    return text(value).toLowerCase() === "curriculum" ? "curriculum" : "all";
  }

  function normalizeSelectionFilters(rawFilters) {
    const raw = object(rawFilters);
    const lineCoverage = text(raw.lineCoverage || raw.line_coverage || "all").toLowerCase();
    return {
      mode: normalizedSelectionMode(raw.mode),
      variation: text(raw.variation || "all") || "all",
      difficulty: text(raw.difficulty || "all").toLowerCase() || "all",
      provenance: normalizedWords(raw.provenance || "all").replace(/\s/g, "") || "all",
      lineCoverage: ["main-lines", "sidelines"].includes(lineCoverage) ? lineCoverage : "all",
      theme: text(raw.theme || "all").toLowerCase() || "all",
      openingOnly: raw.openingOnly === true || raw.opening_only === true,
      curriculumGroup: text(raw.curriculumGroup || raw.curriculum_group),
    };
  }

  function normalizeFilterPools(rawPools) {
    const pools = {};
    const source = object(rawPools);
    Object.keys(source).forEach(rawDeckId => {
      const deckId = normalizedDeckId(rawDeckId);
      if (!deckId) return;
      pools[deckId] = normalizeSelectionFilters(source[rawDeckId]);
    });
    return pools;
  }

  function selectionFilterSignature(rawFilters) {
    const filters = normalizeSelectionFilters(rawFilters);
    return JSON.stringify([
      filters.mode,
      filters.variation,
      filters.difficulty,
      filters.provenance,
      filters.lineCoverage,
      filters.theme,
      filters.openingOnly,
      filters.curriculumGroup,
    ]);
  }

  function normalizeSelectionIndexEntry(rawEntry, ordinal) {
    const raw = object(rawEntry);
    const id = resolvedPuzzleId(raw);
    if (!id) return null;
    const rawChunk = raw.chunkIndex !== undefined ? raw.chunkIndex
      : raw.chunk_index !== undefined ? raw.chunk_index : raw.chunk;
    const numericChunk = Number(rawChunk);
    const chunkIndex = Number.isInteger(numericChunk) && numericChunk >= 0
      ? numericChunk : text(rawChunk || "0");
    const rawOffset = raw.offset !== undefined ? raw.offset
      : raw.chunkOffset !== undefined ? raw.chunkOffset : raw.chunk_offset;
    const offset = nonnegativeInteger(rawOffset, nonnegativeInteger(ordinal, 0));
    const themes = uniqueStrings(raw.themes).map(theme => theme.toLowerCase());
    const primaryTheme = text(
      raw.primaryTacticalTheme || raw.primary_tactical_theme
      || raw.primaryTheme || raw.primary_theme || themes[0] || "unclassified"
    );
    const solutionLength = nonnegativeInteger(
      raw.solutionLength !== undefined ? raw.solutionLength : raw.solution_length,
      0,
    );
    const movingPiece = text(raw.movingPiece || raw.moving_piece || raw.piece || "?").toUpperCase();
    const destination = text(
      raw.destination || raw.destinationSquare || raw.destination_square || raw.to || "?"
    ).toLowerCase();
    const tacticalSignature = text(
      raw.tacticalSignature || raw.tactical_signature || raw.signature
    ) || [primaryTheme || "unclassified", solutionLength, movingPiece, destination].join("|");
    const rawRating = Number(raw.rating);
    return {
      id,
      chunkIndex,
      offset,
      variation: text(raw.variation || "all") || "all",
      difficulty: text(raw.difficulty).toLowerCase(),
      provenance: normalizedWords(raw.provenance).replace(/\s/g, ""),
      themes,
      primaryTacticalTheme: primaryTheme || "unclassified",
      tacticalSignature,
      rating: Number.isFinite(rawRating) ? rawRating : Number.MAX_SAFE_INTEGER,
      solutionLength,
      movingPiece,
      destination,
      mainLine: raw.mainLine === true || raw.main_line === true,
      openingOnly: raw.openingOnly === true || raw.opening_only === true
        || raw.isOpeningPuzzle === true || raw.is_opening_puzzle === true,
      curriculumGroup: text(raw.curriculumGroup || raw.curriculum_group),
      ordinal: nonnegativeInteger(ordinal, 0),
    };
  }

  function normalizeSelectionIndex(rawIndex) {
    const raw = object(rawIndex);
    const deckId = normalizedDeckId(raw.deckId || raw.deck_id);
    const datasetVersion = text(raw.datasetVersion || raw.dataset_version || raw.versionId);
    const rawEntries = raw.entries || raw.records || raw.items;
    if (!deckId) throw new TypeError("A valid selection-index deck ID is required.");
    if (!datasetVersion) throw new TypeError("A selection index requires a dataset version.");
    if (!Array.isArray(rawEntries)) throw new TypeError("A selection index requires an entries array.");
    const seen = new Set();
    const entries = [];
    rawEntries.forEach((entry, ordinal) => {
      const normalized = normalizeSelectionIndexEntry(entry, ordinal);
      if (!normalized || seen.has(normalized.id)) return;
      seen.add(normalized.id);
      entries.push(normalized);
    });
    return { deckId, datasetVersion, entries };
  }

  function selectionThemeMatches(entry, requested) {
    const wanted = text(requested).toLowerCase();
    if (!wanted || wanted === "all") return true;
    const themes = entry.themes || [];
    if (wanted === "mates") return themes.some(theme => /^mate(?:in\d+)?$/.test(theme));
    if (wanted === "forks") return themes.includes("fork");
    if (wanted === "pins") return themes.includes("pin");
    if (wanted === "sacrifices") return themes.includes("sacrifice");
    if (wanted === "defensive") return themes.includes("defensivemove");
    if (wanted === "quiet") return themes.includes("quietmove");
    return themes.includes(wanted);
  }

  function selectionEntryMatches(entry, rawFilters) {
    const filters = normalizeSelectionFilters(rawFilters);
    if (filters.variation !== "all" && entry.variation !== filters.variation) return false;
    if (filters.difficulty !== "all" && entry.difficulty !== filters.difficulty) return false;
    if (filters.provenance !== "all" && entry.provenance !== filters.provenance) return false;
    if (filters.lineCoverage === "main-lines" && !entry.mainLine) return false;
    if (filters.lineCoverage === "sidelines" && entry.mainLine) return false;
    if (filters.openingOnly && !entry.openingOnly) return false;
    if (!selectionThemeMatches(entry, filters.theme)) return false;
    if (filters.curriculumGroup === "Master challenges") return entry.difficulty === "expert";
    if (filters.curriculumGroup && entry.curriculumGroup !== filters.curriculumGroup) return false;
    return true;
  }

  function emptySelectionState() {
    return {
      schemaVersion: SELECTION_SCHEMA_VERSION,
      cohorts: [],
      recentByDeck: Object.create(null),
      active: null,
      updatedAt: null,
    };
  }

  function activeProgress(active) {
    const total = array(active && active.puzzleIds).length;
    const completed = Math.min(total, nonnegativeInteger(active && active.nextIndex, 0));
    return {
      completed,
      total,
      current: total ? Math.min(total, completed + 1) : 0,
      complete: Boolean(total && completed >= total),
    };
  }

  function sanitizeSelectionCohort(rawCohort) {
    const raw = object(rawCohort);
    const deckId = normalizedDeckId(raw.deckId || raw.deck_id);
    const datasetVersion = text(raw.datasetVersion || raw.dataset_version);
    const seed = text(raw.seed);
    if (!deckId || !datasetVersion || !seed) return null;
    const filters = normalizeSelectionFilters(raw.filters);
    const orderVersion = text(raw.orderVersion || raw.order_version)
      || (filters.mode === "curriculum" ? "guided-v1" : "focused-v1");
    if (!["focused-v1", "focused-v2", "guided-v1"].includes(orderVersion)) return null;
    const filterSignature = selectionFilterSignature(filters);
    return {
      key: [deckId, datasetVersion, orderVersion, filterSignature].join("|"),
      deckId,
      datasetVersion,
      filterSignature,
      filters,
      orderVersion,
      seed,
      cursor: nonnegativeInteger(raw.cursor, 0),
      epoch: nonnegativeInteger(raw.epoch, 0),
      deferredIds: boundedIds(raw.deferredIds || raw.deferred_ids || raw.deferred, SELECTION_RECENT_LIMIT),
      lastUsedAt: optionalTimestamp(raw.lastUsedAt || raw.last_used_at || raw.updatedAt),
    };
  }

  function sanitizeActiveSelection(rawActive) {
    const raw = object(rawActive);
    const deckId = normalizedDeckId(raw.deckId || raw.deck_id);
    const datasetVersion = text(raw.datasetVersion || raw.dataset_version);
    const rawPuzzleIds = collection(raw.puzzleIds || raw.puzzle_ids || raw.ids)
      .map(resolvedPuzzleId).filter(Boolean);
    if (!rawPuzzleIds.length || rawPuzzleIds.length > 20
        || new Set(rawPuzzleIds).size !== rawPuzzleIds.length) return null;
    const puzzleIds = rawPuzzleIds;
    const createdAt = optionalTimestamp(raw.createdAt || raw.created_at);
    const expiresAt = optionalTimestamp(raw.expiresAt || raw.expires_at);
    if (!deckId || !datasetVersion || !puzzleIds.length || !createdAt || !expiresAt) return null;
    const lifetime = timestampMillis(expiresAt) - timestampMillis(createdAt);
    if (lifetime <= 0 || lifetime > ACTIVE_SELECTION_TTL_MS) return null;
    const filters = normalizeSelectionFilters(raw.filters);
    const results = array(raw.results).slice(0, puzzleIds.length).map((result, index) => {
      const normalized = clone(object(result));
      return resolvedPuzzleId(normalized) === puzzleIds[index] ? normalized : null;
    });
    if (results.some(result => !result)) return null;
    const declaredNext = raw.nextIndex !== undefined ? raw.nextIndex : raw.next_index;
    const nextIndex = declaredNext === undefined
      ? results.length : nonnegativeInteger(declaredNext, Number.MAX_SAFE_INTEGER);
    if (nextIndex !== results.length || nextIndex > puzzleIds.length) return null;
    const active = {
      token: text(raw.token || raw.id) || `${deckId}:${createdAt}`,
      deckId,
      datasetVersion,
      filterSignature: selectionFilterSignature(filters),
      filters,
      puzzleIds,
      results,
      nextIndex,
      mode: normalizedSelectionMode(raw.mode || filters.mode),
      trainingLength: text(raw.trainingLength || raw.training_length || "finite") || "finite",
      requestedSize: normalizeSessionSize(
        raw.requestedSize !== undefined ? raw.requestedSize : raw.requested_size,
        puzzleIds.length,
      ),
      size: puzzleIds.length,
      createdAt,
      updatedAt: optionalTimestamp(raw.updatedAt || raw.updated_at) || createdAt,
      expiresAt,
      completedAt: optionalTimestamp(raw.completedAt || raw.completed_at),
    };
    active.progress = activeProgress(active);
    return active;
  }

  function sanitizeSelectionState(rawSelection) {
    const raw = object(rawSelection);
    if (Number(raw.schemaVersion || raw.schema_version) !== SELECTION_SCHEMA_VERSION) {
      return emptySelectionState();
    }
    const state = emptySelectionState();
    // focused-v2 has a different ordinal mapping. Discard only the obsolete
    // traversal cursor; active membership, the recent ring, and reviews remain intact.
    state.cohorts = array(raw.cohorts).map(sanitizeSelectionCohort).filter(cohort => (
      cohort && cohort.orderVersion !== "focused-v1"
    ))
      .sort((left, right) => (timestampMillis(left.lastUsedAt) || 0)
        - (timestampMillis(right.lastUsedAt) || 0))
      .slice(-MAX_SELECTION_COHORTS);
    const recent = object(raw.recentByDeck || raw.recent_by_deck);
    Object.keys(recent).forEach(rawDeckId => {
      const deckId = normalizedDeckId(rawDeckId);
      const value = object(recent[rawDeckId]);
      const datasetVersion = text(value.datasetVersion || value.dataset_version);
      const ids = boundedIds(Array.isArray(recent[rawDeckId]) ? recent[rawDeckId] : value.ids);
      if (deckId && datasetVersion && ids.length) {
        state.recentByDeck[deckId] = { datasetVersion, ids };
      }
    });
    state.active = sanitizeActiveSelection(raw.active || raw.activeSession || raw.active_session);
    state.updatedAt = optionalTimestamp(raw.updatedAt || raw.updated_at);
    return state;
  }

  function seedState(seed) {
    const value = text(seed);
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) || 0x9e3779b9;
  }

  function nextSeedState(value) {
    let next = value >>> 0;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    return next >>> 0;
  }

  function deterministicShuffle(values, seed) {
    const result = array(values).slice();
    let state = seedState(seed);
    for (let index = result.length - 1; index > 0; index -= 1) {
      state = nextSeedState(state);
      const target = state % (index + 1);
      const value = result[index];
      result[index] = result[target];
      result[target] = value;
    }
    return result;
  }

  function generatedSelectionSeed(rng) {
    let value;
    try {
      value = typeof rng === "function" ? rng() : Math.random();
    } catch (_error) {
      value = Math.random();
    }
    if (typeof value === "string" && value) return value;
    const number = Number(value);
    const normalized = Number.isFinite(number) ? Math.abs(number % 1) : Math.random();
    return Math.floor(normalized * 0x100000000).toString(16).padStart(8, "0");
  }

  function focusedChunkGroups(entries, seed, epoch) {
    const groups = new Map();
    array(entries).forEach(entry => {
      const key = String(entry.chunkIndex);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    });
    const groupEntries = [...groups.entries()].sort((left, right) => {
      const leftNumber = Number(left[0]);
      const rightNumber = Number(right[0]);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      return left[0].localeCompare(right[0]);
    });
    return deterministicShuffle(groupEntries, `${seed}:${epoch}:chunks`);
  }

  function focusedDifficulty(entry) {
    return DIFFICULTY_ORDER.includes(entry.difficulty) ? entry.difficulty : "";
  }

  function focusedQueues(values, seed) {
    const buckets = new Map(DIFFICULTY_ORDER.concat([""]).map(difficulty => [difficulty, []]));
    array(values).forEach(entry => buckets.get(focusedDifficulty(entry)).push(entry));
    return new Map([...buckets.entries()].map(([difficulty, matching]) => [difficulty, {
      entries: seed === null ? matching.slice() : deterministicShuffle(
        matching,
        `${seed}:difficulty:${difficulty || "other"}`,
      ),
      cursor: 0,
    }]));
  }

  function focusedQueueRemaining(queue) {
    return queue ? Math.max(0, queue.entries.length - queue.cursor) : 0;
  }

  function focusedCompleteCycles(queues) {
    return Math.min(...DIFFICULTY_ORDER.map(difficulty => Math.floor(
      focusedQueueRemaining(queues.get(difficulty)) / FOCUSED_DIFFICULTY_QUOTAS[difficulty]
    )));
  }

  function takeFocusedEntry(queues, difficulty) {
    const queue = queues.get(difficulty);
    if (!queue || queue.cursor >= queue.entries.length) return null;
    const entry = queue.entries[queue.cursor];
    queue.cursor += 1;
    return entry;
  }

  function takeFocusedCycles(queues, count) {
    const result = [];
    for (let cycle = 0; cycle < count; cycle += 1) {
      FOCUSED_DIFFICULTY_CADENCE.forEach(difficulty => {
        result.push(takeFocusedEntry(queues, difficulty));
      });
    }
    return result;
  }

  function appendFocusedRemainders(target, queues) {
    DIFFICULTY_ORDER.concat([""]).forEach(difficulty => {
      const queue = queues.get(difficulty);
      if (!queue) return;
      target.get(difficulty).push(...queue.entries.slice(queue.cursor));
      queue.cursor = queue.entries.length;
    });
  }

  function focusedRemainderEntries(queues) {
    return DIFFICULTY_ORDER.concat([""]).flatMap(difficulty => {
      const queue = queues.get(difficulty);
      return queue ? queue.entries.slice(queue.cursor) : [];
    });
  }

  function drainFocusedRemainders(queues) {
    const total = [...queues.values()].reduce(
      (count, queue) => count + focusedQueueRemaining(queue),
      0,
    );
    const result = [];
    while (result.length < total) {
      const cadenceIndex = result.length % FOCUSED_DIFFICULTY_CADENCE.length;
      let entry = takeFocusedEntry(queues, FOCUSED_DIFFICULTY_CADENCE[cadenceIndex]);
      if (!entry) {
        const fallback = [...new Set(
          FOCUSED_DIFFICULTY_CADENCE.slice(cadenceIndex + 1)
            .concat(FOCUSED_DIFFICULTY_CADENCE.slice(0, cadenceIndex + 1), [""])
        )];
        for (const difficulty of fallback) {
          entry = takeFocusedEntry(queues, difficulty);
          if (entry) break;
        }
      }
      if (!entry) break;
      result.push(entry);
    }
    return result;
  }

  function focusedEpochOrder(entries, seed, epoch) {
    const result = [];
    const pooled = new Map(DIFFICULTY_ORDER.concat([""]).map(difficulty => [difficulty, []]));
    const pooledChunkOrder = [];
    focusedChunkGroups(entries, seed, epoch).forEach(([key, values]) => {
      const canonical = values.slice().sort((left, right) => left.offset - right.offset
        || left.id.localeCompare(right.id));
      const queues = focusedQueues(canonical, `${seed}:${epoch}:chunk:${key}`);
      result.push(...takeFocusedCycles(queues, focusedCompleteCycles(queues)));
      pooledChunkOrder.push(...drainFocusedRemainders(focusedQueues(
        focusedRemainderEntries(queues),
        null,
      )));
      appendFocusedRemainders(pooled, queues);
    });

    // Prefer complete cycles from one chunk. Only leftovers cross chunk
    // boundaries, and any final cohort too narrow for another cycle stays lossless.
    const pooledQueues = focusedQueues(
      DIFFICULTY_ORDER.concat([""]).flatMap(difficulty => pooled.get(difficulty)),
      null,
    );
    const crossChunkCycles = takeFocusedCycles(
      pooledQueues,
      focusedCompleteCycles(pooledQueues),
    );
    const crossChunkIds = new Set(crossChunkCycles.map(entry => entry.id));
    result.push(...crossChunkCycles);
    result.push(...pooledChunkOrder.filter(entry => !crossChunkIds.has(entry.id)));
    return result;
  }

  function guidedDifficultyRank(entry) {
    const rank = DIFFICULTY_ORDER.indexOf(entry.difficulty);
    return rank < 0 ? DIFFICULTY_ORDER.length : rank;
  }

  function guidedEpochOrder(entries, seed, epoch, rawWindowSize) {
    const windowSize = Math.max(20, nonnegativeInteger(rawWindowSize, GUIDED_RATING_WINDOW_SIZE));
    const sorted = array(entries).slice().sort((left, right) => {
      const tier = guidedDifficultyRank(left) - guidedDifficultyRank(right);
      return tier || left.rating - right.rating || left.id.localeCompare(right.id);
    });
    const tiers = new Map();
    sorted.forEach(entry => {
      const rank = guidedDifficultyRank(entry);
      if (!tiers.has(rank)) tiers.set(rank, []);
      tiers.get(rank).push(entry);
    });
    const result = [];
    [...tiers.keys()].sort((left, right) => left - right).forEach(rank => {
      const tier = tiers.get(rank);
      const pool = [];
      for (let start = 0; start < tier.length; start += windowSize) {
        pool.push(...deterministicShuffle(
          tier.slice(start, start + windowSize),
          `${seed}:${epoch}:tier:${rank}:window:${Math.floor(start / windowSize)}`,
        ));
      }
      while (pool.length) {
        const recent = result.slice(-Math.min(GUIDED_CAP_WINDOW - 1, result.length));
        const themeCounts = Object.create(null);
        const signatureCounts = Object.create(null);
        recent.forEach(entry => {
          const theme = entry.primaryTacticalTheme.toLowerCase();
          const signature = entry.tacticalSignature.toLowerCase();
          themeCounts[theme] = (themeCounts[theme] || 0) + 1;
          signatureCounts[signature] = (signatureCounts[signature] || 0) + 1;
        });
        const allowed = entry => {
          const theme = entry.primaryTacticalTheme.toLowerCase();
          const signature = entry.tacticalSignature.toLowerCase();
          return (themeCounts[theme] || 0) < GUIDED_THEME_CAP
            && (signatureCounts[signature] || 0) < GUIDED_SIGNATURE_CAP;
        };
        let chosen = pool.slice(0, windowSize).findIndex(allowed);
        // If the current rating band is saturated, borrow the nearest later
        // same-difficulty motif before relaxing. Only a genuinely narrow
        // remaining tier can therefore exceed a soft cap.
        if (chosen < 0) chosen = pool.findIndex(allowed);
        if (chosen < 0) chosen = 0;
        result.push(pool.splice(chosen, 1)[0]);
      }
    });
    return result;
  }

  function selectGuidedCandidates(rawEntries, rawOptions) {
    const options = object(rawOptions);
    const sources = new Map();
    const entries = [];
    array(rawEntries).forEach((entry, ordinal) => {
      const normalized = normalizeSelectionIndexEntry(entry, ordinal);
      if (!normalized || sources.has(normalized.id)) return;
      sources.set(normalized.id, entry);
      entries.push(normalized);
    });
    return guidedEpochOrder(
      entries,
      text(options.seed) || "guided",
      nonnegativeInteger(options.epoch, 0),
      options.ratingWindowSize,
    ).map(entry => sources.get(entry.id));
  }

  function selectionOrderVersion(filters) {
    return filters.mode === "curriculum" ? "guided-v1" : "focused-v2";
  }

  function isolateSelectionDataset(rawState, deckId, datasetVersion) {
    const state = sanitizeSelectionState(rawState);
    state.cohorts = state.cohorts.filter(cohort => cohort.deckId !== deckId
      || cohort.datasetVersion === datasetVersion);
    const recent = state.recentByDeck[deckId];
    if (recent && recent.datasetVersion !== datasetVersion) delete state.recentByDeck[deckId];
    if (state.active && state.active.deckId === deckId
        && state.active.datasetVersion !== datasetVersion) state.active = null;
    return state;
  }

  function selectionRequestSize(rawRequest) {
    const request = object(rawRequest);
    return normalizeSessionSize(
      request.size !== undefined ? request.size : request.sessionSize,
      DEFAULT_SESSION_SIZE,
    );
  }

  function selectionActiveMatches(active, index, filters, request, nowMillis) {
    if (!active || active.deckId !== index.deckId
        || active.datasetVersion !== index.datasetVersion
        || active.filterSignature !== selectionFilterSignature(filters)) return false;
    if (active.completedAt || active.nextIndex >= active.puzzleIds.length) return false;
    const expiry = timestampMillis(active.expiresAt);
    if (expiry === null || nowMillis >= expiry) return false;
    const requestedLength = text(request.trainingLength || request.training_length);
    if (requestedLength && active.trainingLength !== requestedLength) return false;
    if ((request.size !== undefined || request.sessionSize !== undefined)
        && active.requestedSize !== selectionRequestSize(request)) return false;
    const entries = new Map(index.entries.map(entry => [entry.id, entry]));
    return active.puzzleIds.every(id => entries.has(id)
      && selectionEntryMatches(entries.get(id), filters));
  }

  function cohortOrder(entries, cohort) {
    if (cohort.orderVersion === "guided-v1") {
      return guidedEpochOrder(entries, cohort.seed, cohort.epoch, GUIDED_RATING_WINDOW_SIZE);
    }
    return focusedEpochOrder(entries, cohort.seed, cohort.epoch);
  }

  function appendDeferred(cohort, id) {
    if (cohort.deferredIds.includes(id)) return true;
    if (cohort.deferredIds.length >= SELECTION_RECENT_LIMIT) return false;
    cohort.deferredIds.push(id);
    return true;
  }

  function consumeCohort(cohort, entries, count, excludedIds, priorityIds, recentIds, selectedIds) {
    const selected = [];
    const selectedSet = new Set(selectedIds || []);
    const excluded = new Set(excludedIds || []);
    const priorities = new Set(priorityIds || []);
    const recent = new Set(recentIds || []);
    const eligible = new Map(entries.filter(entry => !excluded.has(entry.id)
      && !priorities.has(entry.id)).map(entry => [entry.id, entry]));

    cohort.deferredIds = cohort.deferredIds.filter(id => eligible.has(id));
    const takeDeferred = relaxRecent => {
      const remaining = [];
      cohort.deferredIds.forEach(id => {
        if (selected.length >= count || selectedSet.has(id)
            || !relaxRecent && recent.has(id)) {
          remaining.push(id);
          return;
        }
        selected.push(id);
        selectedSet.add(id);
      });
      cohort.deferredIds = remaining;
    };

    // A deferred cross-filter overlap gets first refusal once it has fallen out
    // of the bounded recent ring.
    takeDeferred(false);
    let safety = Math.max(1, entries.length * 4 + count * 4);
    while (selected.length < count && entries.length && safety > 0) {
      safety -= 1;
      const order = cohortOrder(entries, cohort);
      cohort.cursor = Math.min(cohort.cursor, order.length);
      while (selected.length < count && cohort.cursor < order.length) {
        const id = order[cohort.cursor].id;
        cohort.cursor += 1;
        if (!eligible.has(id)) continue;
        if (selectedSet.has(id)) {
          appendDeferred(cohort, id);
          continue;
        }
        if (recent.has(id) && appendDeferred(cohort, id)) continue;
        selected.push(id);
        selectedSet.add(id);
      }

      if (cohort.cursor < order.length) break;
      // Every ordinal in this epoch has now either been selected, deliberately
      // excluded, or retained in deferredIds. Relax the soft recent guard before
      // beginning another epoch so a narrow cohort cannot deadlock.
      takeDeferred(true);
      if (cohort.deferredIds.length) break;
      cohort.epoch += 1;
      cohort.cursor = 0;
    }
    return selected;
  }

  function updateRecentSelection(state, deckId, datasetVersion, ids) {
    const current = state.recentByDeck[deckId];
    const previous = current && current.datasetVersion === datasetVersion ? current.ids : [];
    const selected = boundedIds(ids, SELECTION_RECENT_LIMIT);
    const selectedSet = new Set(selected);
    state.recentByDeck[deckId] = {
      datasetVersion,
      ids: previous.filter(id => !selectedSet.has(id)).concat(selected).slice(-SELECTION_RECENT_LIMIT),
    };
  }

  function selectSession(rawConfig) {
    const config = object(rawConfig);
    const index = normalizeSelectionIndex(config.index);
    const filters = normalizeSelectionFilters(config.filters);
    const request = object(config.request);
    const now = optionalTimestamp(config.now) || new Date().toISOString();
    const nowMillis = timestampMillis(now);
    const signature = selectionFilterSignature(filters);
    const orderVersion = selectionOrderVersion(filters);
    const state = isolateSelectionDataset(config.state, index.deckId, index.datasetVersion);

    const explicitFresh = request.fresh === true || request.resume === false;
    if (!explicitFresh && selectionActiveMatches(state.active, index, filters, request, nowMillis)) {
      return {
        ids: state.active.puzzleIds.slice(),
        nextState: clone(state),
        resumed: true,
        active: clone(state.active),
      };
    }
    state.active = null;

    const cohortEntries = index.entries.filter(entry => selectionEntryMatches(entry, filters));
    const entryById = new Map(cohortEntries.map(entry => [entry.id, entry]));
    const excludedIds = boundedIds(request.excludedIds || request.excluded_ids, Number.MAX_SAFE_INTEGER);
    const excluded = new Set(excludedIds);
    // Due priorities intentionally precede the no-repeat New lane, but are
    // intersected with the static cohort and all of them are removed from the
    // New bag even when the requested session cannot fit every Due item.
    const priorityIds = boundedIds(request.priorityIds || request.priority_ids, Number.MAX_SAFE_INTEGER)
      .filter(id => entryById.has(id) && !excluded.has(id));
    const prioritySet = new Set(priorityIds);
    const availableNew = cohortEntries.filter(entry => !excluded.has(entry.id)
      && !prioritySet.has(entry.id)).length;
    const requestedSize = selectionRequestSize(request);
    const target = Math.min(requestedSize, priorityIds.length + availableNew);
    const ids = priorityIds.slice(0, target);

    const key = [index.deckId, index.datasetVersion, orderVersion, signature].join("|");
    let cohort = state.cohorts.find(item => item.key === key);
    if (!cohort) {
      cohort = {
        key,
        deckId: index.deckId,
        datasetVersion: index.datasetVersion,
        filterSignature: signature,
        filters,
        orderVersion,
        seed: generatedSelectionSeed(config.rng),
        cursor: 0,
        epoch: 0,
        deferredIds: [],
        lastUsedAt: now,
      };
    } else {
      cohort = clone(cohort);
      cohort.filters = filters;
      cohort.orderVersion = orderVersion;
    }
    const recent = state.recentByDeck[index.deckId];
    const recentIds = recent && recent.datasetVersion === index.datasetVersion ? recent.ids : [];
    ids.push(...consumeCohort(
      cohort,
      cohortEntries,
      Math.max(0, target - ids.length),
      excludedIds,
      priorityIds,
      recentIds,
      ids,
    ));

    cohort.lastUsedAt = now;
    state.cohorts = state.cohorts.filter(item => item.key !== key).concat(cohort)
      .slice(-MAX_SELECTION_COHORTS);
    updateRecentSelection(state, index.deckId, index.datasetVersion, ids);
    state.updatedAt = now;

    if (!ids.length) {
      return { ids: [], nextState: clone(state), resumed: false, active: null };
    }
    const trainingLength = text(request.trainingLength || request.training_length)
      || (requestedSize === ids.length ? "finite" : "endless");
    const active = {
      token: [index.deckId, now, cohort.seed, cohort.epoch, cohort.cursor].join(":"),
      deckId: index.deckId,
      datasetVersion: index.datasetVersion,
      filterSignature: signature,
      filters,
      puzzleIds: ids.slice(),
      results: [],
      nextIndex: 0,
      mode: filters.mode,
      trainingLength,
      requestedSize,
      size: ids.length,
      createdAt: now,
      updatedAt: now,
      expiresAt: addMilliseconds(now, ACTIVE_SELECTION_TTL_MS),
      completedAt: null,
    };
    active.progress = activeProgress(active);
    state.active = active;
    return {
      ids: ids.slice(),
      nextState: clone(state),
      resumed: false,
      active: clone(active),
    };
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
      sessionMode: DEFAULT_SESSION_MODE,
      sessionSize: DEFAULT_SESSION_SIZE,
      trainingDefaultsVersion: TRAINING_DEFAULTS_VERSION,
      filtersByDeck: {},
      onboardingDismissed: false,
      updatedAt: null,
    };
  }

  function sanitizePreferences(rawPreferences, fallbackUpdatedAt) {
    const raw = object(rawPreferences);
    const deckId = normalizedDeckId(
      raw.lastDeckId || raw.last_deck_id || raw.lastDeck || raw.deckId
    );
    const storedDefaultsVersion = nonnegativeInteger(
      raw.trainingDefaultsVersion !== undefined
        ? raw.trainingDefaultsVersion : raw.training_defaults_version,
      0,
    );
    const storedMode = normalizeSessionMode(
      raw.sessionMode !== undefined ? raw.sessionMode : raw.session_mode,
      DEFAULT_SESSION_MODE,
    );
    return {
      lastDeckId: deckId || null,
      // Before Focused Mix became the default, ordinary visits automatically
      // persisted Endless. An unmarked Endless value is therefore legacy app
      // behavior, not a reliable user choice. Once marked, explicit Endless is
      // preserved like any other preference.
      sessionMode: storedDefaultsVersion < TRAINING_DEFAULTS_VERSION
        && storedMode === "endless" ? DEFAULT_SESSION_MODE : storedMode,
      sessionSize: normalizeSessionSize(
        raw.sessionSize !== undefined ? raw.sessionSize
          : raw.session_size !== undefined ? raw.session_size
            : raw.sessionLength,
        DEFAULT_SESSION_SIZE,
      ),
      trainingDefaultsVersion: Math.max(
        TRAINING_DEFAULTS_VERSION,
        storedDefaultsVersion,
      ),
      filtersByDeck: normalizeFilterPools(
        raw.filtersByDeck !== undefined ? raw.filtersByDeck : raw.filters_by_deck,
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
      selection: emptySelectionState(),
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
    // Selection is an independently versioned, ephemeral add-on. Invalid or
    // future selection payloads reset only traversal state; reviews survive.
    state.selection = sanitizeSelectionState(raw.selection);
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
      || left.sessionMode !== DEFAULT_SESSION_MODE
      || left.sessionSize !== DEFAULT_SESSION_SIZE || left.onboardingDismissed
      || Object.keys(left.filtersByDeck).length);
    const rightHasData = Boolean(right.updatedAt || right.lastDeckId
      || right.sessionMode !== DEFAULT_SESSION_MODE
      || right.sessionSize !== DEFAULT_SESSION_SIZE || right.onboardingDismissed
      || Object.keys(right.filtersByDeck).length);
    const rightIsNewer = (!leftHasData && rightHasData)
      || (timestampMillis(right.updatedAt) || 0) > (timestampMillis(left.updatedAt) || 0);
    const preferred = rightIsNewer ? right : left;
    return {
      lastDeckId: preferred.lastDeckId || left.lastDeckId || right.lastDeckId || null,
      sessionMode: normalizeSessionMode(preferred.sessionMode, DEFAULT_SESSION_MODE),
      sessionSize: normalizeSessionSize(preferred.sessionSize, DEFAULT_SESSION_SIZE),
      trainingDefaultsVersion: Math.max(
        TRAINING_DEFAULTS_VERSION,
        left.trainingDefaultsVersion || 0,
        right.trainingDefaultsVersion || 0,
      ),
      filtersByDeck: Object.assign(
        {},
        rightIsNewer ? left.filtersByDeck : right.filtersByDeck,
        preferred.filtersByDeck,
      ),
      onboardingDismissed: Boolean(left.onboardingDismissed || right.onboardingDismissed),
      updatedAt: latestTimestamp(left.updatedAt, right.updatedAt),
    };
  }

  function mergeStates(username, leftState, rightState) {
    const left = leftState || emptyState(username);
    const right = rightState || emptyState(username);
    const merged = emptyState(username);
    merged.preferences = mergePreferences(left.preferences, right.preferences);
    // Ordering/session membership is device-local and must not be resurrected
    // from a legacy key or imported progress envelope.
    merged.selection = sanitizeSelectionState(left.selection);
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

  function isUnresolvedMistake(rawRecord) {
    if (!rawRecord || typeof rawRecord !== "object") return false;
    return timestampMillis(rawRecord.mistakeAt || rawRecord.mistake_at) !== null
      && nonnegativeInteger(
        rawRecord.correctStreak !== undefined
          ? rawRecord.correctStreak : rawRecord.correct_streak,
        0,
      ) === 0;
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
      let currentPreferences = {};
      if (currentRaw !== null) {
        try {
          const parsedCurrent = JSON.parse(currentRaw);
          currentVersion = Number(parsedCurrent.version);
          currentPreferences = object(parsedCurrent.preferences);
        } catch (_error) {
          currentVersion = null;
        }
      }
      const storedDefaultsVersion = nonnegativeInteger(
        currentPreferences.trainingDefaultsVersion !== undefined
          ? currentPreferences.trainingDefaultsVersion
          : currentPreferences.training_defaults_version,
        0,
      );
      const needsDefaultsMigration = Boolean(current)
        && currentVersion === CURRENT_VERSION
        && storedDefaultsVersion < TRAINING_DEFAULTS_VERSION;
      const needsMigrationWrite = currentVersion === 1 || needsDefaultsMigration || Boolean(legacy)
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

    function unresolvedMistakeReviews(deckValue, rawQuery) {
      const query = object(rawQuery);
      const limit = query.limit === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, nonnegativeInteger(query.limit, 0));
      return recordsForDeck(deckValue)
        .filter(isUnresolvedMistake)
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
      if (Object.prototype.hasOwnProperty.call(raw, "sessionMode")) {
        next.sessionMode = normalizeSessionMode(raw.sessionMode, next.sessionMode);
      }
      if (Object.prototype.hasOwnProperty.call(raw, "trainingDefaultsVersion")) {
        next.trainingDefaultsVersion = Math.max(
          next.trainingDefaultsVersion || 0,
          nonnegativeInteger(raw.trainingDefaultsVersion, 0),
        );
      }
      if (Object.prototype.hasOwnProperty.call(raw, "filtersByDeck")) {
        next.filtersByDeck = normalizeFilterPools(raw.filtersByDeck);
      }
      if (Object.prototype.hasOwnProperty.call(raw, "onboardingDismissed")) {
        next.onboardingDismissed = raw.onboardingDismissed === true;
      }
      next.updatedAt = when;
      state.preferences = sanitizePreferences(next, when);
      updateState(when);
      return clone(state.preferences);
    }

    function getFilterPool(deckValue) {
      sync();
      const deckId = normalizedDeckId(deckValue);
      if (!deckId) throw new TypeError("A valid opening deck ID is required.");
      return clone(state.preferences.filtersByDeck[deckId] || null);
    }

    function setFilterPool(deckValue, rawFilters, at) {
      sync();
      const deckId = normalizedDeckId(deckValue);
      if (!deckId) throw new TypeError("A valid opening deck ID is required.");
      const when = moment(at, clock);
      const next = clone(state.preferences);
      next.filtersByDeck[deckId] = normalizeSelectionFilters(rawFilters);
      next.updatedAt = when;
      state.preferences = sanitizePreferences(next, when);
      updateState(when);
      return clone(state.preferences.filtersByDeck[deckId]);
    }

    function exportedData() {
      sync();
      const exportedState = clone(state);
      delete exportedState.selection;
      return JSON.stringify({
        schema: EXPORT_SCHEMA,
        version: CURRENT_VERSION,
        exportedAt: moment(undefined, clock),
        data: exportedState,
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

    function getSelectionState() {
      sync();
      return clone(state.selection);
    }

    function reserveSelectionSession(rawConfig) {
      sync();
      const config = object(rawConfig);
      const when = moment(config.now, clock);
      const selected = selectSession({
        index: config.index,
        state: state.selection,
        filters: config.filters,
        request: config.request,
        now: when,
        rng: config.rng,
      });
      state.selection = sanitizeSelectionState(selected.nextState);
      updateState(when);
      return {
        ids: selected.ids.slice(),
        nextState: clone(state.selection),
        resumed: selected.resumed,
        active: clone(state.selection.active),
      };
    }

    function recordActiveSelectionResult(tokenOrResult, resultOrAt, at) {
      sync();
      let token = null;
      let result = tokenOrResult;
      let explicitAt = resultOrAt;
      if (typeof tokenOrResult === "string" && resultOrAt
          && typeof resultOrAt === "object" && !Array.isArray(resultOrAt)) {
        token = tokenOrResult;
        result = resultOrAt;
        explicitAt = at;
      }
      const active = sanitizeActiveSelection(state.selection && state.selection.active);
      const when = moment(explicitAt, clock);
      if (!active || token && token !== active.token
          || timestampMillis(when) >= timestampMillis(active.expiresAt)) {
        return { accepted: false, active: clone(active), selection: clone(state.selection) };
      }
      const expectedId = active.puzzleIds[active.nextIndex];
      const resultId = resolvedPuzzleId(result);
      if (!expectedId || resultId !== expectedId) {
        return { accepted: false, active: clone(active), selection: clone(state.selection) };
      }
      active.results.push(clone(object(result)));
      active.nextIndex += 1;
      active.updatedAt = when;
      if (active.nextIndex >= active.puzzleIds.length) active.completedAt = when;
      active.progress = activeProgress(active);
      state.selection.active = active;
      state.selection.updatedAt = when;
      updateState(when);
      return { accepted: true, active: clone(active), selection: clone(state.selection) };
    }

    function clearActiveSelection(tokenOrAt, at) {
      sync();
      const active = sanitizeActiveSelection(state.selection && state.selection.active);
      if (!active) return false;
      let token = null;
      let explicitAt = tokenOrAt;
      if (at !== undefined) {
        token = text(tokenOrAt);
        explicitAt = at;
      } else if (text(tokenOrAt) === active.token) {
        token = active.token;
        explicitAt = undefined;
      } else if (tokenOrAt !== undefined && timestampMillis(tokenOrAt) === null) {
        token = text(tokenOrAt);
        explicitAt = undefined;
      }
      if (token && token !== active.token) return false;
      const when = moment(explicitAt, clock);
      state.selection.active = null;
      state.selection.updatedAt = when;
      updateState(when);
      return true;
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
      getFilterPool,
      setFilterPool,
      getSelectionState,
      reserveSelectionSession,
      recordActiveSelectionResult,
      clearActiveSelection,

      setLastDeck(deckId, at) {
        return setPreferences({ lastDeckId: deckId }, at);
      },

      setSessionSize(size, at) {
        return setPreferences({ sessionSize: size }, at);
      },

      setSessionMode(mode, at) {
        return setPreferences({ sessionMode: mode }, at);
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
      unresolvedMistakeReviews,

      mistakeIds(deckId, query) {
        return mistakeReviews(deckId, query).map(record => record.puzzleId);
      },

      unresolvedMistakeIds(deckId, query) {
        return unresolvedMistakeReviews(deckId, query).map(record => record.puzzleId);
      },

      unresolvedMistakeCount(deckId) {
        return unresolvedMistakeReviews(deckId).length;
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
    SESSION_MODES,
    DEFAULT_SESSION_MODE,
    TRAINING_DEFAULTS_VERSION,
    STORAGE_PREFIX,
    LEGACY_STORAGE_PREFIX,
    EXPORT_SCHEMA,
    SELECTION_SCHEMA_VERSION,
    MAX_SELECTION_COHORTS,
    SELECTION_RECENT_LIMIT,
    ACTIVE_SELECTION_TTL_MS,
    normalizedUsername,
    storageKey,
    legacyStorageKey,
    normalizeSessionSize,
    normalizeSessionMode,
    normalizeSelectionFilters,
    selectionFilterSignature,
    isUnresolvedMistake,
    sanitizeSelectionState,
    selectGuidedCandidates,
    selectSession,
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
