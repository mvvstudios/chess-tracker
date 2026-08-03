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

  function acceptedMoveValues(candidate, answer) {
    if (!candidate || typeof candidate !== "object" || !answer) return null;
    const fields = [
      candidate.accepted_moves_uci,
      candidate.acceptedMovesUci,
      candidate.accepted_mating_moves_uci,
      candidate.acceptedMatingMovesUci,
    ];
    const raw = fields.find(Array.isArray);
    if (!raw) return [answer];

    const accepted = [];
    const seen = new Set();
    for (const value of raw) {
      const move = normalizeUci(value);
      if (!move) return null;
      if (!seen.has(move)) {
        seen.add(move);
        accepted.push(move);
      }
    }
    if (!seen.has(answer)) accepted.unshift(answer);
    return accepted;
  }

  function acceptedMovePostFens(candidate, accepted, answer, primaryPostFen) {
    if (!candidate || typeof candidate !== "object" || !Array.isArray(accepted)) return null;
    const raw = candidate.accepted_move_post_fens != null
      ? candidate.accepted_move_post_fens
      : candidate.acceptedMovePostFens;
    if (raw == null) return accepted.length === 1 ? Object.create(null) : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const acceptedSet = new Set(accepted);
    const normalized = Object.create(null);
    for (const [rawMove, rawFen] of Object.entries(raw)) {
      const move = normalizeUci(rawMove);
      const fen = typeof rawFen === "string" ? rawFen.trim() : "";
      if (!move || !fen || !acceptedSet.has(move)
          || Object.prototype.hasOwnProperty.call(normalized, move)) {
        return null;
      }
      normalized[move] = fen;
    }
    if (accepted.some(move => !Object.prototype.hasOwnProperty.call(normalized, move))) {
      return null;
    }
    if (primaryPostFen && normalized[answer] !== primaryPostFen) return null;
    return normalized;
  }

  function optionalText(object, keys) {
    if (!object || typeof object !== "object") return null;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
    return null;
  }

  function normalizedMoveValues(candidate) {
    const values = legalMoveValues(candidate);
    if (values === null) return { present: false, valid: true, moves: null };

    const moves = [];
    const seen = new Set();
    for (const value of values) {
      const move = normalizeUci(value);
      if (!move) return { present: true, valid: false, moves: null };
      if (!seen.has(move)) {
        seen.add(move);
        moves.push(move);
      }
    }
    return { present: true, valid: true, moves };
  }

  function cloneObjectOfArrays(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const clone = Object.create(null);
    for (const key of Object.keys(value)) {
      if (!Array.isArray(value[key])) return null;
      clone[key] = value[key].slice();
    }
    return clone;
  }

  function normalizeSolutionStep(rawStep, requirePosition, allowReply) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return null;

    const answer = bestMove(rawStep);
    const legalValues = normalizedMoveValues(rawStep);
    const accepted = acceptedMoveValues(rawStep, answer);
    if (!answer || !accepted || !legalValues.valid) return null;

    const rawDests = rawStep.legal_dests != null
      ? rawStep.legal_dests
      : rawStep.legalDests;
    const rawPromotions = rawStep.promotion_options != null
      ? rawStep.promotion_options
      : rawStep.promotionOptions;
    const dests = rawDests == null ? null : cloneObjectOfArrays(rawDests);
    const promotions = rawPromotions == null ? null : cloneObjectOfArrays(rawPromotions);
    if ((rawDests != null && !dests) || (rawPromotions != null && !promotions)) return null;

    const fenBefore = optionalText(rawStep, ["fen_before", "fenBefore"]);
    const postBestFen = optionalText(rawStep, ["post_best_fen", "postBestFen"]);
    if (requirePosition && (!fenBefore || !postBestFen)) return null;
    const acceptedPostFens = acceptedMovePostFens(
      rawStep, accepted, answer, postBestFen
    );
    if (!acceptedPostFens) return null;

    const rawReply = allowReply
      ? optionalText(rawStep, ["opponent_reply_uci", "opponentReplyUci"])
      : null;
    const reply = rawReply === null ? null : normalizeUci(rawReply);
    const postReplyFen = allowReply
      ? optionalText(rawStep, ["post_reply_fen", "postReplyFen"])
      : null;
    if (rawReply !== null && !reply) return null;
    if (reply && !postReplyFen) return null;
    if (!reply && postReplyFen) return null;

    const step = {
      fen_before: fenBefore,
      best_move_uci: answer,
      accepted_moves_uci: accepted,
      accepted_move_post_fens: acceptedPostFens,
      best_move_san: optionalText(rawStep, ["best_move_san", "bestMoveSan"]),
      post_best_fen: postBestFen,
      legal_moves_uci: legalValues.moves,
      legal_dests: dests,
      promotion_options: promotions,
      opponent_reply_uci: reply,
      opponent_reply_san: reply
        ? optionalText(rawStep, ["opponent_reply_san", "opponentReplySan"])
        : null,
      post_reply_fen: reply ? postReplyFen : null,
    };

    // Every solution move must be provably legal from the supplied move map.
    // This deliberately fails closed when both modern and legacy legal data
    // are absent, just like evaluateAttempt().
    if (accepted.some(move => !evaluateAttempt(step, move).correct)) return null;
    return step;
  }

  function explicitSolutionStepValues(candidate) {
    if (!candidate || typeof candidate !== "object") return { present: false, value: null };
    if (Object.prototype.hasOwnProperty.call(candidate, "solution_steps")) {
      return { present: true, value: candidate.solution_steps };
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "solutionSteps")) {
      return { present: true, value: candidate.solutionSteps };
    }
    return { present: false, value: null };
  }

  /**
   * Return validated, normalized solution decisions for a puzzle candidate.
   * Older queue payloads become a single step from their top-level fields.
   * An explicitly supplied sequence is authoritative and never falls back to
   * those aliases when malformed.
   */
  function solutionSteps(candidate) {
    const explicit = explicitSolutionStepValues(candidate);
    if (!explicit.present) {
      const legacy = normalizeSolutionStep(candidate, false, false);
      return legacy ? [legacy] : [];
    }
    if (!Array.isArray(explicit.value) || explicit.value.length === 0) return [];

    const steps = [];
    for (const rawStep of explicit.value) {
      const step = normalizeSolutionStep(rawStep, true, true);
      if (!step) return [];
      steps.push(step);
    }

    // A later user decision is only reachable after a validated automatic
    // opponent reply, and its starting FEN must be that reply's resulting FEN.
    for (let index = 0; index < steps.length - 1; index += 1) {
      const step = steps[index];
      if (!step.opponent_reply_uci || !step.post_reply_fen) return [];
      if (step.post_reply_fen !== steps[index + 1].fen_before) return [];
    }
    return steps;
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
    const accepted = acceptedMoveValues(candidate, answer);
    if (!accepted) {
      return { kind: "illegal", uci, legal: false, correct: false };
    }
    const correct = accepted.includes(uci);
    return {
      kind: correct ? "correct" : "incorrect",
      uci,
      legal: true,
      correct,
    };
  }

  /**
   * Classify the user's move at one decision in a stored engine line.
   * Sequence metadata is only exposed after a correct move, so an incorrect
   * attempt cannot reveal either the reply or the next answer position.
   */
  function evaluatePuzzleStep(candidate, stepIndex, attemptedMove) {
    const steps = solutionSteps(candidate);
    const index = Number(stepIndex);
    const validIndex = Number.isInteger(index) && index >= 0 && index < steps.length;
    const attemptedUci = normalizeUci(attemptedMove);
    if (!validIndex) {
      return {
        kind: "illegal",
        uci: attemptedUci,
        legal: false,
        correct: false,
        stepIndex: Number.isInteger(index) ? index : null,
        step: null,
        isFinalStep: false,
        solved: false,
        nextStepIndex: null,
        nextStep: null,
        reply: null,
        opponentReplyUci: null,
        opponentReplySan: null,
        postReplyFen: null,
      };
    }

    const step = steps[index];
    const classification = evaluateAttempt(step, attemptedMove);
    const mayAdvance = classification.correct;
    const isFinalStep = index === steps.length - 1;
    const nextStepIndex = mayAdvance && !isFinalStep ? index + 1 : null;
    const nextStep = nextStepIndex === null ? null : steps[nextStepIndex];
    const reply = mayAdvance && step.opponent_reply_uci
      ? {
        uci: step.opponent_reply_uci,
        san: step.opponent_reply_san,
        fen: step.post_reply_fen,
      }
      : null;
    const completesAfterReply = Boolean(mayAdvance && isFinalStep && reply);
    const attemptedPostFen = mayAdvance
      ? step.accepted_move_post_fens[classification.uci]
        || (classification.uci === step.best_move_uci ? step.post_best_fen : null)
      : null;

    return {
      ...classification,
      stepIndex: index,
      step,
      isFinalStep,
      solved: mayAdvance && isFinalStep && !completesAfterReply,
      completesAfterReply,
      attemptedPostFen,
      nextStepIndex,
      nextStep,
      reply,
      opponentReplyUci: reply ? reply.uci : null,
      opponentReplySan: reply ? reply.san : null,
      postReplyFen: reply ? reply.fen : null,
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

  function seedState(seed) {
    const value = seed == null ? "" : String(seed);
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // Xorshift32's all-zero state never advances. FNV-1a very rarely lands
    // there, so substitute a fixed non-zero state when it does.
    return (hash >>> 0) || 0x9e3779b9;
  }

  function nextSeedState(state) {
    let next = state >>> 0;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    return next >>> 0;
  }

  /** Deterministically mix a queue without mutating the caller's array. */
  function mixCandidates(candidates, seed) {
    if (!Array.isArray(candidates)) return [];
    const mixed = candidates.slice();
    let state = seedState(seed);
    for (let index = mixed.length - 1; index > 0; index -= 1) {
      state = nextSeedState(state);
      const target = state % (index + 1);
      const candidate = mixed[index];
      mixed[index] = mixed[target];
      mixed[target] = candidate;
    }
    if (mixed.length > 1 && mixed.every((candidate, index) => candidate === candidates[index])) {
      mixed.push(mixed.shift());
    }
    return mixed;
  }

  function candidateIsReady(candidate) {
    return Boolean(stablePuzzleId(candidate) && solutionSteps(candidate).length);
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

  function normalizedNamespace(namespace) {
    if (namespace === undefined || namespace === null || String(namespace).trim() === "") {
      return null;
    }
    return String(namespace).trim().toLowerCase();
  }

  function storageKey(username, namespace) {
    const subject = encodeURIComponent(normalizedUsername(username));
    const scope = normalizedNamespace(namespace);
    return scope
      ? STORAGE_PREFIX + encodeURIComponent(scope) + ":" + subject
      : STORAGE_PREFIX + subject;
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
  function createProgressStore(username, suppliedStorage, namespace) {
    const key = storageKey(username, namespace);
    let state = emptyState(username);
    let storage = suppliedStorage === undefined ? browserStorage() : suppliedStorage;
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
    solutionSteps,
    evaluatePuzzleStep,
    stablePuzzleId,
    sortCandidates,
    mixCandidates,
    partitionCandidates,
    rotateQueue,
    normalizedUsername,
    normalizedNamespace,
    storageKey,
    createProgressStore,
  });
}));
