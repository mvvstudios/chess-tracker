(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PuzzleDomain = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_VERSION = 1;
  const STORAGE_PREFIX = "chess-tracker:puzzle-progress:v1:";
  const UCI_RE = /^[a-h][1-8][a-h][1-8](?:[qrbn])?$/;
  const SQUARE_RE = /^[a-h][1-8]$/;
  const PROMOTION_ORDER = ["q", "r", "b", "n"];
  const CASTLE_ALIASES = Object.freeze({
    e1h1: "e1g1",
    e1a1: "e1c1",
    e8h8: "e8g8",
    e8a8: "e8c8",
  });

  function moveText(move) {
    if (typeof move === "string") return move;
    if (!move || typeof move !== "object") return "";
    if (typeof move.uci === "string") return move.uci;

    const orig = move.orig != null ? move.orig : move.from;
    const dest = move.dest != null ? move.dest : move.to;
    const promotion = move.promotion == null ? "" : move.promotion;
    if (orig == null || dest == null) return "";
    return String(orig) + String(dest) + String(promotion);
  }

  /** Return canonical lowercase UCI, or null for malformed coordinate moves. */
  function normalizeUci(move) {
    let normalized = moveText(move).trim().toLowerCase();
    if (!UCI_RE.test(normalized)) return null;
    if (normalized.slice(0, 2) === normalized.slice(2, 4)) return null;
    normalized = CASTLE_ALIASES[normalized] || normalized;
    return normalized;
  }

  function isValidUci(move) {
    return normalizeUci(move) !== null;
  }

  function normalizeSquare(square) {
    if (typeof square !== "string") return null;
    const value = square.trim().toLowerCase();
    return SQUARE_RE.test(value) ? value : null;
  }

  function legalMoveValues(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const fields = [
      candidate.legal_moves_uci,
      candidate.legalMovesUci,
      candidate.legal_moves,
      candidate.legalMoves,
    ];
    for (const value of fields) {
      if (Array.isArray(value)) return value;
    }
    return null;
  }

  function legalMoveSet(candidate) {
    const values = legalMoveValues(candidate);
    if (values === null) return null;
    const moves = new Set();
    values.forEach((value) => {
      const move = normalizeUci(value);
      if (move) moves.add(move);
    });
    return moves;
  }

  function legalDests(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const value = candidate.legal_dests || candidate.legalDests;
    return value && typeof value === "object" ? value : null;
  }

  function bestMove(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    return normalizeUci(
      candidate.best_move_uci != null
        ? candidate.best_move_uci
        : candidate.bestMoveUci
    );
  }

  /** Legal promotion pieces for an origin/destination pair, queen first. */
  function promotionChoices(candidate, from, to) {
    const orig = normalizeSquare(from);
    const dest = normalizeSquare(to);
    if (!orig || !dest) return [];
    const prefix = orig + dest;
    const found = new Set();
    const legal = legalMoveSet(candidate);
    if (legal) {
      legal.forEach((move) => {
        if (move.length === 5 && move.slice(0, 4) === prefix) {
          found.add(move[4]);
        }
      });
    }

    // A partially migrated candidate may only carry the answer move. This is
    // still enough to offer the correct promotion instead of failing closed.
    const best = bestMove(candidate);
    if (best && best.length === 5 && best.slice(0, 4) === prefix) {
      found.add(best[4]);
    }
    return PROMOTION_ORDER.filter((piece) => found.has(piece));
  }

  function isLegalByDests(candidate, move) {
    const dests = legalDests(candidate);
    if (!dests) return false;
    const allowed = dests[move.slice(0, 2)];
    if (!Array.isArray(allowed)) return false;
    const target = move.slice(2, 4);
    if (!allowed.map((value) => String(value).toLowerCase()).includes(target)) {
      return false;
    }

    // legal_dests predates promotion support and cannot distinguish the four
    // promotion moves. Require an explicit suffix whenever stored engine data
    // proves this origin/destination is a promotion.
    const answer = bestMove(candidate);
    if (answer && answer.length === 5 && answer.slice(0, 4) === move.slice(0, 4)) {
      return move.length === 5;
    }
    return true;
  }

  /** Classify one attempted move without mutating puzzle progress. */
  function evaluateAttempt(candidate, attemptedMove) {
    const uci = normalizeUci(attemptedMove);
    const answer = bestMove(candidate);
    if (!uci) {
      return { kind: "illegal", uci: null, legal: false, correct: false };
    }
    if (!answer) {
      return { kind: "illegal", uci, legal: false, correct: false };
    }

    const legalMoves = legalMoveSet(candidate);
    const legal = legalMoves !== null
      ? legalMoves.has(uci)
      : isLegalByDests(candidate, uci);
    if (!legal) {
      return { kind: "illegal", uci, legal: false, correct: false };
    }
    const correct = uci === answer;
    return {
      kind: correct ? "correct" : "incorrect",
      uci,
      legal: true,
      correct,
    };
  }

  function firstPresent(object, keys) {
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
    return null;
  }

  /** Stable identity. Username isolation is supplied by the progress namespace. */
  function stablePuzzleId(candidate) {
    if (typeof candidate === "string" || typeof candidate === "number") {
      const value = String(candidate).trim();
      return value || null;
    }
    if (!candidate || typeof candidate !== "object") return null;

    const explicit = firstPresent(candidate, ["puzzle_id", "puzzleId", "id"]);
    if (explicit !== null) return String(explicit).trim();

    const gameId = firstPresent(candidate, [
      "game_id", "gameId", "game_url", "gameUrl", "url",
    ]);
    const ply = firstPresent(candidate, ["ply", "blunder_ply", "blunderPly"]);
    if (gameId === null || ply === null) return null;
    return "game:" + encodeURIComponent(String(gameId)) + ":ply:" + encodeURIComponent(String(ply));
  }

  function numberField(candidate, keys, fallback) {
    const value = firstPresent(candidate, keys);
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function dateValue(candidate) {
    const epoch = firstPresent(candidate, ["end_time", "endTime"]);
    if (epoch !== null && Number.isFinite(Number(epoch))) {
      const value = Number(epoch);
      return value < 1e12 ? value * 1000 : value;
    }
    const date = firstPresent(candidate, ["game_date", "gameDate", "date"]);
    if (date === null) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(String(date));
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }

  function compareCandidates(a, b) {
    const aLoss = numberField(a, ["cp_loss", "cpLoss", "evaluation_loss", "evaluationLoss"], Number.NEGATIVE_INFINITY);
    const bLoss = numberField(b, ["cp_loss", "cpLoss", "evaluation_loss", "evaluationLoss"], Number.NEGATIVE_INFINITY);
    if (aLoss !== bLoss) return bLoss - aLoss;

    const aDate = dateValue(a);
    const bDate = dateValue(b);
    if (aDate !== bDate) return bDate - aDate;

    const aPly = numberField(a, ["ply", "blunder_ply", "blunderPly"], Number.POSITIVE_INFINITY);
    const bPly = numberField(b, ["ply", "blunder_ply", "blunderPly"], Number.POSITIVE_INFINITY);
    if (aPly !== bPly) return aPly - bPly;

    return String(stablePuzzleId(a) || "").localeCompare(String(stablePuzzleId(b) || ""));
  }

  function sortCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => compareCandidates(a.candidate, b.candidate) || a.index - b.index)
      .map((entry) => entry.candidate);
  }

  function candidateIsReady(candidate) {
    if (!stablePuzzleId(candidate) || !bestMove(candidate)) return false;
    const legalMoves = legalMoveSet(candidate);
    if (legalMoves !== null) return legalMoves.has(bestMove(candidate));
    return isLegalByDests(candidate, bestMove(candidate));
  }

  function progressFor(source, id) {
    if (!source) return null;
    try {
      if (typeof source.get === "function") return source.get(id);
      if (source instanceof Map) return source.get(id) || null;
      if (source.records && typeof source.records === "object") {
        return source.records[id] || null;
      }
      return source[id] || null;
    } catch (_error) {
      return null;
    }
  }

  function isSolvedProgress(progress) {
    return Boolean(progress && (progress.status === "solved" || progress.solvedAt));
  }

  /** Dedupe, deterministically order, and split ready candidates by progress. */
  function partitionCandidates(candidates, progressSource) {
    const unsolved = [];
    const solved = [];
    const invalid = [];
    const seen = new Set();

    sortCandidates(candidates).forEach((candidate) => {
      const id = stablePuzzleId(candidate);
      if (!id || !candidateIsReady(candidate)) {
        invalid.push(candidate);
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);
      if (isSolvedProgress(progressFor(progressSource, id))) solved.push(candidate);
      else unsolved.push(candidate);
    });

    return { unsolved, solved, invalid, total: unsolved.length + solved.length };
  }

  /** Move the selected queue item to the end without mutating the input. */
  function rotateQueue(queue, current) {
    if (!Array.isArray(queue)) return [];
    const rotated = queue.slice();
    if (rotated.length <= 1) return rotated;

    let index = 0;
    if (typeof current === "number" && Number.isInteger(current)) {
      index = current;
    } else if (current !== undefined && current !== null) {
      const wanted = stablePuzzleId(current);
      index = rotated.findIndex((candidate) => stablePuzzleId(candidate) === wanted);
      if (index < 0) return rotated;
    }
    if (index < 0 || index >= rotated.length) return rotated;
    rotated.push(rotated.splice(index, 1)[0]);
    return rotated;
  }

  function normalizedUsername(username) {
    const value = username == null ? "" : String(username).trim().toLowerCase();
    return value || "anonymous";
  }

  function storageKey(username) {
    return STORAGE_PREFIX + encodeURIComponent(normalizedUsername(username));
  }

  function emptyState(username) {
    return {
      version: STORAGE_VERSION,
      username: normalizedUsername(username),
      records: Object.create(null),
    };
  }

  function optionalTimestamp(value) {
    return typeof value === "string" && value ? value : null;
  }

  function sanitizeRecord(id, raw) {
    if (!raw || typeof raw !== "object") return null;
    const attempts = Math.max(0, Math.floor(Number(raw.attempts) || 0));
    const solvedAt = optionalTimestamp(raw.solvedAt);
    const solved = raw.status === "solved" || Boolean(solvedAt);
    return {
      id,
      status: solved ? "solved" : "unsolved",
      attempts,
      firstAttemptAt: optionalTimestamp(raw.firstAttemptAt),
      solvedAt,
      solutionRevealedAt: optionalTimestamp(raw.solutionRevealedAt),
      createdAt: optionalTimestamp(raw.createdAt),
      updatedAt: optionalTimestamp(raw.updatedAt),
    };
  }

  function sanitizeState(username, raw) {
    const state = emptyState(username);
    if (!raw || typeof raw !== "object" || !raw.records || typeof raw.records !== "object") {
      return state;
    }
    Object.keys(raw.records).forEach((id) => {
      const record = sanitizeRecord(id, raw.records[id]);
      if (record) state.records[id] = record;
    });
    return state;
  }

  function cloneRecord(record) {
    return record ? Object.assign({}, record) : null;
  }

  function cloneRecords(records) {
    const clone = Object.create(null);
    Object.keys(records).forEach((id) => {
      clone[id] = cloneRecord(records[id]);
    });
    return clone;
  }

  function timestamp(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return value;
    return new Date().toISOString();
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

  /**
   * Username-isolated puzzle progress. Storage failures transparently fall
   * back to the in-memory state so a private-mode/quota error never breaks play.
   */
  function createProgressStore(username, suppliedStorage) {
    const key = storageKey(username);
    let state = emptyState(username);
    let storage = arguments.length >= 2 ? suppliedStorage : browserStorage();
    let persistent = Boolean(
      storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
    );
    let lastError = null;

    function rememberError(error, disablePersistence) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (disablePersistence) persistent = false;
    }

    function sync() {
      if (!persistent) return;
      try {
        const raw = storage.getItem(key);
        if (raw === null) {
          state = emptyState(username);
          return;
        }
        state = sanitizeState(username, JSON.parse(raw));
      } catch (error) {
        // A read access error means localStorage is unavailable for this page.
        // Invalid JSON can be repaired by the next successful write.
        if (error instanceof SyntaxError) {
          state = emptyState(username);
          rememberError(error, false);
        } else {
          rememberError(error, true);
        }
      }
    }

    function persist() {
      if (!persistent) return;
      try {
        storage.setItem(key, JSON.stringify(state));
      } catch (error) {
        rememberError(error, true);
      }
    }

    function resolveId(candidateOrId) {
      return stablePuzzleId(candidateOrId);
    }

    function baseRecord(id, at) {
      return {
        id,
        status: "unsolved",
        attempts: 0,
        firstAttemptAt: null,
        solvedAt: null,
        solutionRevealedAt: null,
        createdAt: at,
        updatedAt: at,
      };
    }

    function mutate(candidateOrId, at, callback) {
      const id = resolveId(candidateOrId);
      if (!id) return null;
      sync();
      const moment = timestamp(at);
      const current = state.records[id] || baseRecord(id, moment);
      const next = callback(Object.assign({}, current), moment);
      if (!next) return cloneRecord(current);
      // Once set, solvedAt/status can only be removed through explicit reset().
      if (current.status === "solved" || current.solvedAt) {
        next.status = "solved";
        next.solvedAt = current.solvedAt || next.solvedAt;
      }
      state.records[id] = sanitizeRecord(id, next);
      persist();
      return cloneRecord(state.records[id]);
    }

    sync();

    return Object.freeze({
      key,

      get(candidateOrId) {
        const id = resolveId(candidateOrId);
        if (!id) return null;
        sync();
        return cloneRecord(state.records[id]);
      },

      all() {
        sync();
        return cloneRecords(state.records);
      },

      recordAttempt(candidateOrId, correct, at) {
        const wasCorrect = typeof correct === "object" && correct !== null
          ? Boolean(correct.correct)
          : Boolean(correct);
        return mutate(candidateOrId, at, (record, moment) => {
          if (record.status === "solved" || record.solvedAt) return null;
          record.attempts += 1;
          if (!record.firstAttemptAt) record.firstAttemptAt = moment;
          if (wasCorrect) {
            record.status = "solved";
            record.solvedAt = moment;
          }
          record.updatedAt = moment;
          return record;
        });
      },

      markSolved(candidateOrId, at) {
        return mutate(candidateOrId, at, (record, moment) => {
          if (record.status === "solved" || record.solvedAt) return null;
          record.status = "solved";
          record.solvedAt = moment;
          record.updatedAt = moment;
          return record;
        });
      },

      revealSolution(candidateOrId, at) {
        return mutate(candidateOrId, at, (record, moment) => {
          if (record.solutionRevealedAt) return null;
          record.solutionRevealedAt = moment;
          record.updatedAt = moment;
          return record;
        });
      },

      markSolutionRevealed(candidateOrId, at) {
        return mutate(candidateOrId, at, (record, moment) => {
          if (record.solutionRevealedAt) return null;
          record.solutionRevealedAt = moment;
          record.updatedAt = moment;
          return record;
        });
      },

      reset() {
        state = emptyState(username);
        if (!persistent) return true;
        try {
          if (typeof storage.removeItem === "function") storage.removeItem(key);
          else storage.setItem(key, JSON.stringify(state));
          return true;
        } catch (error) {
          rememberError(error, true);
          return false;
        }
      },

      isPersistent() {
        return persistent;
      },

      getLastError() {
        return lastError;
      },
    });
  }

  return Object.freeze({
    normalizeUci,
    isValidUci,
    promotionChoices,
    evaluateAttempt,
    stablePuzzleId,
    sortCandidates,
    partitionCandidates,
    rotateQueue,
    normalizedUsername,
    storageKey,
    createProgressStore,
  });
}));
