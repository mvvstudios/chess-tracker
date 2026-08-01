// dashboard/puzzles-page.js
// Controller for the static My Blunder Puzzles page. Chess rules, candidate
// ordering, answer evaluation, and persistent progress live in PuzzleDomain.
(function () {
  "use strict";

  const page = document.getElementById("puzzles-page");
  if (!page) return;

  const DATA = window.DATA;
  const Domain = window.PuzzleDomain;
  const UI = window.ChessTrackerUI;
  const fallbackEscape = value => String(value == null ? "" : value).replace(
    /[&"'<>]/g,
    char => ({
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
      "<": "&lt;",
      ">": "&gt;",
    })[char]
  );
  const escapeHtml = UI && typeof UI.escapeHtml === "function"
    ? UI.escapeHtml
    : fallbackEscape;
  const reducedMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia
    && window.matchMedia("(pointer: coarse)").matches;

  const elements = {
    summary: document.getElementById("puzzle-progress-summary"),
    warning: document.getElementById("puzzle-storage-warning"),
    unsolvedTab: document.getElementById("puzzles-unsolved-tab"),
    solvedTab: document.getElementById("puzzles-solved-tab"),
    unsolvedCount: document.getElementById("puzzles-unsolved-count"),
    solvedCount: document.getElementById("puzzles-solved-count"),
    unsolvedPanel: document.getElementById("puzzles-unsolved-panel"),
    solvedPanel: document.getElementById("puzzles-solved-panel"),
    pageState: document.getElementById("puzzle-page-state"),
    workspace: document.getElementById("puzzle-workspace"),
    board: document.getElementById("puzzle-board"),
    prompt: document.getElementById("puzzle-prompt"),
    sideToMove: document.getElementById("puzzle-side-to-move"),
    feedback: document.getElementById("puzzle-feedback"),
    context: document.getElementById("puzzle-context-body"),
    queuePosition: document.getElementById("puzzle-queue-position"),
    continueButton: document.getElementById("puzzle-continue"),
    skipButton: document.getElementById("puzzle-skip"),
    resetButton: document.getElementById("puzzle-reset"),
    hintButton: document.getElementById("puzzle-hint"),
    showButton: document.getElementById("puzzle-show"),
    uciDisclosure: document.getElementById("puzzle-uci-disclosure"),
    uciForm: document.getElementById("puzzle-uci-form"),
    uciInput: document.getElementById("puzzle-uci-input"),
    promotionChooser: document.getElementById("puzzle-promotion-chooser"),
    promotionOptions: document.getElementById("puzzle-promotion-options"),
    promotionCancel: document.getElementById("puzzle-promotion-cancel"),
    solvedEmpty: document.getElementById("puzzles-solved-empty"),
    solvedLayout: document.getElementById("puzzles-solved-layout"),
    solvedList: document.getElementById("puzzles-solved-list"),
    solvedReview: document.getElementById("puzzle-solved-review"),
    solvedReviewTitle: document.getElementById("puzzle-solved-review-title"),
    solvedReviewClose: document.getElementById("puzzle-solved-review-close"),
    solvedBoard: document.getElementById("puzzle-solved-board"),
    solvedDetails: document.getElementById("puzzle-solved-details"),
  };

  const state = {
    catalog: null,
    candidates: [],
    invalid: [],
    total: 0,
    unsolved: [],
    solved: [],
    sessionIds: [],
    currentId: null,
    completedCandidate: null,
    revealed: false,
    feedbackMode: "idle",
    activeTab: "unsolved",
    selectedSolvedId: null,
    pendingPromotion: null,
    board: null,
    solvedBoard: null,
    store: null,
    incorrectTimer: null,
    transientWarning: null,
    solvedReviewTrigger: null,
  };

  bindEvents();
  initialize();

  function initialize() {
    if (!DATA) {
      showFatal("Puzzle data is unavailable. Run refresh.py and reload this page.");
      return;
    }
    if (!Domain || typeof Domain.createProgressStore !== "function"
        || typeof Domain.partitionCandidates !== "function"
        || typeof Domain.evaluateAttempt !== "function") {
      showFatal("The puzzle rules module did not load. Reload the page or rebuild the dashboard.");
      return;
    }
    if (!UI || typeof UI.makeBoard !== "function") {
      showFatal("The chessboard module did not load. Reload the page or rebuild the dashboard.");
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(DATA, "puzzle_catalog")) {
      showFatal("The generated dashboard does not include puzzle data. Run refresh.py and reload this page.");
      return;
    }

    state.catalog = readCatalog(DATA.puzzle_catalog);
    try {
      state.store = Domain.createProgressStore(DATA.username || "unknown");
    } catch (error) {
      showFatal("Puzzle progress could not be opened in this browser.");
      console.error("Could not create puzzle progress store", error);
      return;
    }

    const sorted = typeof Domain.sortCandidates === "function"
      ? Domain.sortCandidates(state.catalog.candidates.slice())
      : state.catalog.candidates.slice();
    state.candidates = Array.isArray(sorted) ? sorted : state.catalog.candidates.slice();
    if (!syncPartition(true)) return;
    renderAll();
  }

  function readCatalog(rawCatalog) {
    if (Array.isArray(rawCatalog)) {
      return { candidates: rawCatalog, meta: {} };
    }
    const raw = rawCatalog && typeof rawCatalog === "object" ? rawCatalog : {};
    const candidates = [raw.candidates, raw.puzzles, raw.items, raw.ready]
      .find(Array.isArray) || [];
    const coverage = raw.coverage && typeof raw.coverage === "object"
      ? raw.coverage
      : {};
    return {
      candidates,
      meta: Object.assign({}, coverage, raw, {
        diagnostic_errors: Array.isArray(raw.errors) ? raw.errors : [],
      }),
    };
  }

  function syncPartition(initial) {
    let partition;
    try {
      partition = Domain.partitionCandidates(state.candidates, state.store) || {};
    } catch (error) {
      showFatal("Your puzzle queue could not be prepared.");
      console.error("Could not partition puzzle candidates", error);
      return false;
    }

    state.unsolved = unwrapCandidates(partition.unsolved);
    state.solved = unwrapCandidates(partition.solved);
    state.invalid = Array.isArray(partition.invalid) ? partition.invalid : [];
    state.total = Number.isFinite(Number(partition.total))
      ? Number(partition.total)
      : state.unsolved.length + state.solved.length;

    const availableIds = new Set(state.unsolved.map(puzzleId));
    if (initial || state.sessionIds.length === 0) {
      state.sessionIds = state.unsolved.map(puzzleId);
    } else {
      state.sessionIds = state.sessionIds.filter(id => availableIds.has(id));
      state.unsolved.forEach(candidate => {
        const id = puzzleId(candidate);
        if (!state.sessionIds.includes(id)) state.sessionIds.push(id);
      });
    }
    if (!state.completedCandidate) {
      if (!state.currentId || !availableIds.has(state.currentId)) {
        state.currentId = state.sessionIds[0] || null;
      }
    }
    renderWarnings();
    return true;
  }

  function unwrapCandidates(items) {
    if (!Array.isArray(items)) return [];
    return items.map(item => item && (item.candidate || item.puzzle || item)).filter(Boolean);
  }

  function puzzleId(candidate) {
    if (!candidate) return "";
    if (candidate.puzzle_id) return String(candidate.puzzle_id);
    if (candidate.id) return String(candidate.id);
    return typeof Domain.stablePuzzleId === "function"
      ? String(Domain.stablePuzzleId(candidate))
      : "";
  }

  function currentCandidate() {
    if (state.completedCandidate) return state.completedCandidate;
    return state.unsolved.find(candidate => puzzleId(candidate) === state.currentId) || null;
  }

  function getProgress(candidate) {
    if (!candidate || !state.store || typeof state.store.get !== "function") return {};
    try {
      return state.store.get(puzzleId(candidate)) || {};
    } catch (error) {
      state.transientWarning = "Puzzle progress could not be read. Your latest change may not persist.";
      renderWarnings();
      return {};
    }
  }

  function renderAll() {
    renderCounts();
    renderUnsolved();
    renderSolvedArchive();
  }

  function renderCounts() {
    const solvedCount = state.solved.length;
    const unsolvedCount = state.unsolved.length;
    elements.summary.textContent = `${solvedCount} solved / ${state.total} total`;
    elements.unsolvedCount.textContent = `(${unsolvedCount})`;
    elements.solvedCount.textContent = `(${solvedCount})`;
    elements.unsolvedTab.setAttribute(
      "aria-label", `Unsolved puzzles, ${unsolvedCount}`
    );
    elements.solvedTab.setAttribute(
      "aria-label", `Solved puzzles, ${solvedCount}`
    );
  }

  function renderUnsolved() {
    const candidate = currentCandidate();
    if (!candidate) {
      elements.workspace.hidden = true;
      elements.pageState.hidden = false;
      elements.pageState.innerHTML = emptyQueueMarkup();
      return;
    }

    elements.pageState.hidden = true;
    elements.workspace.hidden = false;
    closePromotionChooser(false);

    const progress = getProgress(candidate);
    const completed = Boolean(state.completedCandidate);
    state.revealed = completed || progressWasRevealed(progress);
    if (completed) state.feedbackMode = "solved";
    else if (state.revealed && state.feedbackMode === "idle") state.feedbackMode = "revealed";

    const color = candidate.user_color || candidate.orientation || candidate.side || "white";
    const colorLabel = color === "black" ? "Black" : "White";
    const attempts = Number(progress.attempts || 0);
    elements.prompt.textContent = completed ? "Solved" : "Find the best move";
    elements.sideToMove.textContent = `${colorLabel} to move · You are ${colorLabel}`;
    elements.queuePosition.textContent = completed
      ? `${state.unsolved.length} unsolved remaining`
      : `${state.unsolved.length} unsolved remaining${attempts ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`;
    elements.board.setAttribute(
      "aria-label",
      `${completed ? "Solved" : "Interactive"} chess puzzle, ${colorLabel} to move, board oriented for ${colorLabel}`
    );

    elements.context.innerHTML = contextMarkup(candidate, progress, state.revealed);
    setFeedbackForMode(candidate);
    setControlState(completed);
    paintInteractiveBoard(candidate, completed);
  }

  function emptyQueueMarkup() {
    const meta = state.catalog ? state.catalog.meta : {};
    const status = String(meta.status || meta.state || "").toLowerCase();
    const gameCount = firstNumber(
      meta.game_count, meta.games_imported, meta.imported_games,
      meta.games_for_user, meta.eligible_games
    );
    const analyzedCount = firstNumber(meta.analyzed_games, meta.games_analyzed);
    const analysisPendingCount = firstNumber(
      meta.analysis_pending_games, meta.games_missing_analysis
    ) || 0;
    const incompleteCount = firstNumber(
      meta.incomplete_puzzles, meta.incomplete_blunders,
      meta.incomplete_count, meta.awaiting_engine_count
    ) || 0;
    const invalidCount = state.invalid.length;
    const malformedCount = firstNumber(meta.malformed_games) || 0;
    const diagnosticCount = Array.isArray(meta.diagnostic_errors)
      ? meta.diagnostic_errors.length
      : 0;
    const links = `<span class="puzzle-empty-links"><a href="index.html">Back to repertoire</a>`
      + ` · <a href="blunders.html">View game analysis</a></span>`;

    if (state.total > 0 && state.solved.length === state.total) {
      return `<h2>You’ve solved all available blunder puzzles.</h2>`
        + `<p>New eligible puzzles will appear after more games are imported and analyzed.</p>${links}`;
    }
    if ((malformedCount > 0 || diagnosticCount > 0)
        && firstNumber(meta.games_seen) > 0 && gameCount === 0) {
      return `<h2>Imported games could not be read</h2>`
        + `<p>The malformed records were skipped safely. Refresh the import or review the source PGN before trying again.</p>${links}`;
    }
    if (status === "no_games" || gameCount === 0) {
      return `<h2>No games imported</h2>`
        + `<p>Refresh the tracker after importing Chess.com games to build your puzzle queue.</p>${links}`;
    }
    if (["not_analyzed", "unanalyzed", "analysis_pending"].includes(status)
        || (gameCount > 0 && analyzedCount === 0)) {
      return `<h2>Your games still need engine analysis</h2>`
        + `<p>Run the normal refresh with Stockfish enabled, then reload this page.</p>${links}`;
    }
    if (incompleteCount > 0) {
      return `<h2>Puzzle analysis is still in progress</h2>`
        + `<p>${incompleteCount} blunder position${incompleteCount === 1 ? " is" : "s are"} waiting for a legal Stockfish best move. Ready puzzles will appear independently.</p>${links}`;
    }
    if (analysisPendingCount > 0) {
      return `<h2>More games are waiting for engine analysis</h2>`
        + `<p>${analysisPendingCount} imported game${analysisPendingCount === 1 ? " has" : "s have"} not been analyzed yet. Run the normal Stockfish refresh to discover more puzzles.</p>${links}`;
    }
    if (invalidCount > 0) {
      return `<h2>No ready puzzles</h2>`
        + `<p>${invalidCount} candidate${invalidCount === 1 ? " was" : "s were"} skipped because game or engine data was incomplete.</p>${links}`;
    }
    if (malformedCount > 0 || diagnosticCount > 0) {
      const skipped = Math.max(malformedCount, diagnosticCount);
      return `<h2>No ready puzzles</h2>`
        + `<p>${skipped} imported game or analysis record${skipped === 1 ? " was" : "s were"} malformed and skipped safely.</p>${links}`;
    }
    return `<h2>No personal blunders found</h2>`
      + `<p>The analyzed games do not currently contain an eligible blunder that you played.</p>${links}`;
  }

  function firstNumber(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return null;
  }

  function progressWasRevealed(progress) {
    return Boolean(
      progress.solutionRevealedAt || progress.solution_revealed_at
      || progress.solution_revealed
    );
  }

  function contextMarkup(candidate, progress, reveal) {
    const color = candidate.user_color || candidate.orientation || candidate.side || "white";
    const colorLabel = color === "black" ? "Black" : "White";
    const opponent = candidateOpponent(candidate);
    const opening = candidate.opening || candidate.opening_name || "Unknown opening";
    const date = formatGameDate(candidate.game_date || candidate.end_time);
    const move = moveNumberLabel(candidate, color);
    let markup = `<dl class="puzzle-context-grid">
      ${detailRow("Opponent", opponent)}
      ${detailRow("Date", date)}
      ${detailRow("Your color", colorLabel)}
      ${detailRow("Move", move)}
      ${detailRow("Opening", opening)}
    </dl>`;
    if (!reveal) return markup;

    const pv = principalVariation(candidate);
    const attempts = Number(progress.attempts || 0);
    const solved = progress.status === "solved" || Boolean(solvedTimestamp(progress));
    markup += `<div class="puzzle-solution-details">
      <h3>${solved ? "Solution" : "Revealed solution"}</h3>
      <dl class="puzzle-context-grid">
        ${detailRow("Played", candidate.played_move_san || candidate.played_move_uci || "—")}
        ${detailRow("Best move", candidate.best_move_san || candidate.best_move_uci || "—", "cell-strong")}
        ${detailRow("Eval before", formatEval(candidate.cp_before))}
        ${detailRow("Eval after blunder", formatEval(candidate.cp_after))}
        ${detailRow("Evaluation loss", formatEvalLoss(candidate.cp_loss))}
        ${pv ? detailRow("Principal variation", pv) : ""}
        ${attempts ? detailRow("Attempts", attempts) : ""}
      </dl>
      ${candidate.game_url
        ? `<a class="drill-link" href="${escapeHtml(candidate.game_url)}" target="_blank" rel="noopener">Open original game</a>`
        : ""}
    </div>`;
    return markup;
  }

  function detailRow(label, value, valueClass) {
    return `<div class="row"><dt class="k">${escapeHtml(label)}</dt>`
      + `<dd class="v${valueClass ? ` ${valueClass}` : ""}">${escapeHtml(value)}</dd></div>`;
  }

  function moveNumberLabel(candidate, color) {
    const move = candidate.fullmove || candidate.move_number;
    if (move == null) return "—";
    return color === "black" ? `${move}…` : `${move}.`;
  }

  function candidateOpponent(candidate) {
    return candidate.opponent || candidate.opponent_name || "Unknown opponent";
  }

  function formatGameDate(value) {
    if (!value) return "Unknown";
    let date;
    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      const numeric = Number(value);
      date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    } else {
      date = new Date(value);
    }
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }).format(date);
  }

  function formatTimestamp(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(date);
  }

  function formatEval(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value)) return value;
    const cp = Number(value);
    if (!Number.isFinite(cp)) return String(value);
    if (Math.abs(cp) >= 9900) return cp > 0 ? "Winning / mate" : "Losing / mate";
    const pawns = cp / 100;
    return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }

  function formatEvalLoss(value) {
    if (value === null || value === undefined || value === "") return "—";
    const cp = Number(value);
    if (!Number.isFinite(cp)) return String(value);
    return `${(cp / 100).toFixed(2)} pawns (${Math.round(cp)} cp)`;
  }

  function principalVariation(candidate) {
    const pv = candidate.principal_variation_san || candidate.principal_variation_uci
      || candidate.principal_variation || candidate.pv;
    if (Array.isArray(pv)) return pv.slice(0, 8).join(" ");
    if (typeof pv === "string") return pv.split(/\s+/).slice(0, 8).join(" ");
    return "";
  }

  function setFeedbackForMode(candidate) {
    const best = candidate.best_move_san || candidate.best_move_uci || "the engine move";
    if (state.feedbackMode === "solved") {
      elements.feedback.innerHTML = `<span class="ok">Solved.</span> `
        + `${escapeHtml(best)} was Stockfish’s best move.`;
    } else if (state.feedbackMode === "revealed") {
      elements.feedback.innerHTML = `<span class="puzzle-revealed-status">Solution revealed.</span> `
        + `Play ${escapeHtml(best)} to mark this puzzle solved.`;
    } else {
      elements.feedback.textContent = "Find the best move.";
    }
  }

  function setControlState(completed) {
    elements.continueButton.hidden = !completed;
    elements.skipButton.hidden = completed;
    elements.resetButton.hidden = completed;
    elements.hintButton.hidden = completed || state.revealed;
    elements.showButton.hidden = completed || state.revealed;
    elements.uciDisclosure.hidden = completed;
    if (completed) elements.uciDisclosure.open = false;
    elements.resetButton.disabled = completed;
    elements.hintButton.disabled = completed || state.revealed;
    elements.showButton.disabled = completed || state.revealed;
    elements.uciInput.disabled = completed;
    const submit = elements.uciForm.querySelector("button[type='submit']");
    if (submit) submit.disabled = completed;
  }

  function paintInteractiveBoard(candidate, completed) {
    const color = candidate.user_color || candidate.orientation || candidate.side || "white";
    const orientation = candidate.orientation || color;
    const fen = completed && candidate.post_best_fen
      ? candidate.post_best_fen
      : candidate.fen_before;
    const config = {
      fen,
      orientation: orientation === "black" ? "black" : "white",
      coordinatesOnSquares: true,
      viewOnly: completed,
      turnColor: color,
      lastMove: completed ? uciSquares(candidate.best_move_uci) : undefined,
      check: false,
      drawable: { enabled: false, visible: true },
      movable: {
        free: false,
        color: completed ? undefined : color,
        dests: completed ? new Map() : legalDests(candidate),
        events: { after: handleBoardMove },
      },
      draggable: { enabled: !completed && !coarsePointer },
      selectable: { enabled: !completed },
    };

    if (!state.board) {
      state.board = UI.makeBoard(elements.board, config);
    } else {
      state.board.set(config);
    }
    if (!state.board) {
      state.transientWarning = "The board could not be initialized. You can still enter a legal UCI move with the keyboard field.";
      renderWarnings();
      return;
    }
    if (completed || state.revealed) {
      drawMove(candidate.best_move_uci, "green");
    } else {
      state.board.setShapes([]);
    }
  }

  function legalDests(candidate) {
    const raw = candidate.legal_dests || {};
    return new Map(Object.entries(raw).map(([from, destinations]) => [
      from,
      Array.isArray(destinations) ? destinations : [],
    ]));
  }

  function uciSquares(move) {
    const normalized = normalizeUci(move);
    return normalized && normalized.length >= 4
      ? [normalized.slice(0, 2), normalized.slice(2, 4)]
      : undefined;
  }

  function normalizeUci(move) {
    return typeof Domain.normalizeUci === "function"
      ? Domain.normalizeUci(move)
      : String(move || "").trim().toLowerCase();
  }

  function drawMove(move, brush) {
    if (!state.board) return;
    const squares = uciSquares(move);
    state.board.setShapes(squares ? [{ orig: squares[0], dest: squares[1], brush }] : []);
  }

  function handleBoardMove(from, to) {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    const choices = promotionChoices(candidate, from, to);
    if (choices.length) {
      resetBoardPosition(candidate, false);
      openPromotionChooser(from, to, choices);
      return;
    }
    void evaluateMove(`${from}${to}`);
  }

  function promotionChoices(candidate, from, to) {
    if (typeof Domain.promotionChoices !== "function") return [];
    const raw = Domain.promotionChoices(candidate, from, to);
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(choice => {
      if (typeof choice === "string") {
        const normalized = choice.toLowerCase();
        return normalized.length >= 5 ? normalized.slice(-1) : normalized;
      }
      return String(choice && (choice.piece || choice.role || choice.promotion) || "").toLowerCase();
    }).filter(choice => ["q", "r", "b", "n"].includes(choice)))];
  }

  function openPromotionChooser(from, to, choices) {
    state.pendingPromotion = { from, to };
    const labels = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
    elements.promotionOptions.innerHTML = choices.map(choice =>
      `<button type="button" class="puzzle-promotion-option" data-piece="${choice}" aria-label="Promote to ${labels[choice]}">${labels[choice]}</button>`
    ).join("");
    elements.promotionChooser.hidden = false;
    elements.promotionChooser.setAttribute("aria-describedby", "puzzle-feedback");
    elements.feedback.textContent = "Choose the piece for your promotion.";
    const first = elements.promotionOptions.querySelector("button");
    if (first) first.focus();
  }

  function closePromotionChooser(restoreFeedback) {
    state.pendingPromotion = null;
    elements.promotionChooser.hidden = true;
    elements.promotionOptions.innerHTML = "";
    if (restoreFeedback) {
      const candidate = currentCandidate();
      if (candidate) setFeedbackForMode(candidate);
    }
  }

  async function evaluateMove(rawMove) {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    const move = normalizeUci(rawMove);
    let result;
    try {
      result = Domain.evaluateAttempt(candidate, move);
    } catch (error) {
      elements.feedback.textContent = "That move could not be checked. Reset the position and try again.";
      console.error("Puzzle attempt evaluation failed", error);
      return;
    }
    const kind = typeof result === "string" ? result : result && result.kind;
    if (kind === "illegal") {
      elements.feedback.innerHTML = `<span class="bad">Illegal move.</span> Choose a legal move for the side to move.`;
      resetBoardPosition(candidate, false);
      elements.uciInput.focus();
      return;
    }
    if (kind === "correct") {
      recordAttempt(candidate, true);
      markSolved(candidate);
      return;
    }
    if (kind === "incorrect") {
      recordAttempt(candidate, false);
      showIncorrect(candidate, move);
      return;
    }
    elements.feedback.textContent = "That move could not be checked because its engine data is incomplete.";
    resetBoardPosition(candidate, false);
  }

  function recordAttempt(candidate, correct) {
    try {
      state.store.recordAttempt(puzzleId(candidate), correct, new Date().toISOString());
    } catch (error) {
      state.transientWarning = "This attempt could not be saved. Progress may be lost when the page closes.";
      console.error("Could not save puzzle attempt", error);
    }
    renderWarnings();
  }

  function markSolved(candidate) {
    try {
      state.store.markSolved(puzzleId(candidate), new Date().toISOString());
    } catch (error) {
      state.transientWarning = "The solved state could not be saved. Keep this page open and try again.";
      console.error("Could not save solved puzzle", error);
      elements.feedback.textContent = state.transientWarning;
      renderWarnings();
      return;
    }

    clearIncorrectTimer();
    state.completedCandidate = candidate;
    state.currentId = null;
    state.revealed = true;
    state.feedbackMode = "solved";
    if (!syncPartition(false)) return;
    renderCounts();
    renderUnsolved();
    renderSolvedArchive();
    queueMicrotask(() => elements.continueButton.focus());
  }

  function showIncorrect(candidate, move) {
    state.feedbackMode = "incorrect";
    elements.feedback.innerHTML = `<span class="bad">Try again.</span> That move is legal, but it is not Stockfish’s best move.`;
    drawMove(move, "red");
    updateAttemptLabel(candidate);
    clearIncorrectTimer();
    const candidateId = puzzleId(candidate);
    state.incorrectTimer = window.setTimeout(() => {
      if (currentCandidate() && puzzleId(currentCandidate()) === candidateId
          && !state.completedCandidate) {
        resetBoardPosition(candidate, false);
      }
      state.incorrectTimer = null;
    }, reducedMotion ? 0 : 450);
  }

  function updateAttemptLabel(candidate) {
    const progress = getProgress(candidate);
    const attempts = Number(progress.attempts || 0);
    elements.queuePosition.textContent = `${state.unsolved.length} unsolved remaining`
      + `${attempts ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`;
  }

  function clearIncorrectTimer() {
    if (state.incorrectTimer !== null) {
      window.clearTimeout(state.incorrectTimer);
      state.incorrectTimer = null;
    }
  }

  function resetBoardPosition(candidate, restoreFeedback) {
    if (!candidate || !state.board) return;
    const color = candidate.user_color || candidate.orientation || candidate.side || "white";
    state.board.set({
      fen: candidate.fen_before,
      orientation: (candidate.orientation || color) === "black" ? "black" : "white",
      coordinatesOnSquares: true,
      viewOnly: false,
      turnColor: color,
      lastMove: undefined,
      check: false,
      movable: {
        free: false,
        color,
        dests: legalDests(candidate),
        events: { after: handleBoardMove },
      },
      draggable: { enabled: !coarsePointer },
      selectable: { enabled: true },
    });
    if (state.revealed) drawMove(candidate.best_move_uci, "green");
    else state.board.setShapes([]);
    if (restoreFeedback) {
      state.feedbackMode = state.revealed ? "revealed" : "idle";
      setFeedbackForMode(candidate);
    }
  }

  function revealSolution() {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    try {
      state.store.revealSolution(puzzleId(candidate), new Date().toISOString());
    } catch (error) {
      state.transientWarning = "The revealed-solution state could not be saved.";
      console.error("Could not save solution reveal", error);
    }
    state.revealed = true;
    state.feedbackMode = "revealed";
    renderWarnings();
    renderUnsolved();
  }

  function showHint() {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate || state.revealed || !state.board) return;
    const best = normalizeUci(candidate.best_move_uci);
    if (!best || best.length < 4) {
      elements.feedback.textContent = "A hint is unavailable for this puzzle.";
      return;
    }
    state.board.setShapes([{ orig: best.slice(0, 2), brush: "yellow" }]);
    elements.feedback.textContent = `Hint: start with the piece on ${best.slice(0, 2)}.`;
  }

  function skipCurrent() {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    if (state.unsolved.length <= 1) {
      elements.feedback.textContent = "This is the only unsolved puzzle, so it will stay here for now.";
      return;
    }
    clearIncorrectTimer();
    closePromotionChooser(false);
    const ordered = state.sessionIds
      .map(id => state.unsolved.find(candidateItem => puzzleId(candidateItem) === id))
      .filter(Boolean);
    let rotated = ordered;
    if (typeof Domain.rotateQueue === "function") {
      rotated = Domain.rotateQueue(ordered, puzzleId(candidate));
    } else {
      rotated = ordered.slice(1).concat(ordered[0]);
    }
    if (!Array.isArray(rotated) || rotated.length !== ordered.length) {
      rotated = ordered.slice(1).concat(ordered[0]);
    }
    state.sessionIds = rotated.map(puzzleId);
    state.currentId = state.sessionIds[0] || null;
    state.revealed = false;
    state.feedbackMode = "idle";
    elements.uciInput.value = "";
    renderUnsolved();
    focusPuzzleStart();
  }

  function continueQueue() {
    if (!state.completedCandidate) return;
    clearIncorrectTimer();
    state.completedCandidate = null;
    state.currentId = state.sessionIds[0] || null;
    state.revealed = false;
    state.feedbackMode = "idle";
    elements.uciInput.value = "";
    renderUnsolved();
    if (!state.currentId) {
      elements.pageState.focus && elements.pageState.focus();
    } else {
      focusPuzzleStart();
    }
  }

  function focusPuzzleStart() {
    if (!window.matchMedia || !window.matchMedia("(max-width: 760px)").matches) return;
    queueMicrotask(() => {
      const task = elements.prompt.closest(".puzzle-task") || elements.prompt;
      try {
        elements.prompt.focus({ preventScroll: true });
      } catch (_error) {
        elements.prompt.focus();
      }
      task.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  function renderSolvedArchive() {
    if (state.solved.length === 0) {
      elements.solvedLayout.hidden = true;
      elements.solvedEmpty.hidden = false;
      elements.solvedEmpty.innerHTML = `<h2>No solved puzzles yet</h2><p>Solved blunders will be kept here permanently.</p>`;
      elements.solvedReview.hidden = true;
      return;
    }

    elements.solvedEmpty.hidden = true;
    elements.solvedLayout.hidden = false;
    const solved = state.solved.slice().sort((a, b) => {
      const aTime = solvedTimestamp(getProgress(a));
      const bTime = solvedTimestamp(getProgress(b));
      return Date.parse(bTime || 0) - Date.parse(aTime || 0);
    });
    elements.solvedList.innerHTML = solved.map((candidate, index) => {
      const progress = getProgress(candidate);
      const color = candidate.user_color || candidate.orientation || candidate.side || "white";
      const colorLabel = color === "black" ? "Black" : "White";
      return `<article class="puzzle-solved-item">
        <div class="puzzle-solved-item-main">
          <h2>${escapeHtml(formatGameDate(candidate.game_date || candidate.end_time))} · ${escapeHtml(candidateOpponent(candidate))}</h2>
          <p>${escapeHtml(colorLabel)} · move ${escapeHtml(moveNumberLabel(candidate, color))}`
            + ` · played ${escapeHtml(candidate.played_move_san || candidate.played_move_uci || "—")}`
            + ` · best ${escapeHtml(candidate.best_move_san || candidate.best_move_uci || "—")}</p>
          <p class="puzzle-solved-meta">Loss ${escapeHtml(formatEvalLoss(candidate.cp_loss))}`
            + ` · solved ${escapeHtml(formatTimestamp(solvedTimestamp(progress)))}</p>
        </div>
        <button type="button" class="puzzle-review-button" data-solved-index="${index}" aria-label="Review solved puzzle from ${escapeHtml(formatGameDate(candidate.game_date || candidate.end_time))} against ${escapeHtml(candidateOpponent(candidate))}">Review</button>
      </article>`;
    }).join("");
    elements.solvedList._renderedCandidates = solved;

    if (state.selectedSolvedId) {
      const selected = solved.find(candidate => puzzleId(candidate) === state.selectedSolvedId);
      if (selected) renderSolvedReview(selected, false);
      else closeSolvedReview();
    }
  }

  function solvedTimestamp(progress) {
    return progress.solvedAt || progress.solved_at || null;
  }

  function renderSolvedReview(candidate, focusHeading) {
    state.selectedSolvedId = puzzleId(candidate);
    const progress = getProgress(candidate);
    const color = candidate.user_color || candidate.orientation || candidate.side || "white";
    elements.solvedReview.hidden = false;
    elements.solvedReviewTitle.textContent = `Solved puzzle · ${formatGameDate(candidate.game_date || candidate.end_time)} vs ${candidateOpponent(candidate)}`;
    elements.solvedDetails.innerHTML = contextMarkup(candidate, progress, true)
      + `<p class="puzzle-readonly-note">Read-only review · solved ${escapeHtml(formatTimestamp(solvedTimestamp(progress)))}</p>`;

    const config = {
      fen: candidate.fen_before,
      orientation: (candidate.orientation || color) === "black" ? "black" : "white",
      coordinatesOnSquares: true,
      viewOnly: true,
      lastMove: undefined,
      check: false,
      drawable: { enabled: false, visible: true },
      movable: { color: undefined, dests: new Map() },
    };
    if (!state.solvedBoard) state.solvedBoard = UI.makeBoard(elements.solvedBoard, config);
    else state.solvedBoard.set(config);
    if (state.solvedBoard) {
      const shapes = [];
      const played = uciSquares(candidate.played_move_uci);
      const best = uciSquares(candidate.best_move_uci);
      if (played) shapes.push({ orig: played[0], dest: played[1], brush: "red" });
      if (best) shapes.push({ orig: best[0], dest: best[1], brush: "green" });
      state.solvedBoard.setShapes(shapes);
      queueMicrotask(() => state.solvedBoard.redrawAll && state.solvedBoard.redrawAll());
    }
    if (focusHeading) elements.solvedReviewTitle.focus();
  }

  function closeSolvedReview(restoreFocus) {
    state.selectedSolvedId = null;
    elements.solvedReview.hidden = true;
    if (restoreFocus && state.solvedReviewTrigger && state.solvedReviewTrigger.isConnected) {
      state.solvedReviewTrigger.focus();
    }
    state.solvedReviewTrigger = null;
  }

  function renderWarnings() {
    const messages = [];
    if (state.store) {
      const persistent = typeof state.store.isPersistent === "function"
        ? state.store.isPersistent()
        : state.store.isPersistent !== false;
      if (!persistent) {
        messages.push("Puzzle progress is only available for this page session because browser storage is unavailable.");
      }
      if (typeof state.store.getLastError === "function") {
        const error = state.store.getLastError();
        if (error && persistent) messages.push("The last puzzle progress update may not have been saved.");
      }
    }
    const analysisPending = state.catalog && firstNumber(
      state.catalog.meta.analysis_pending_games,
      state.catalog.meta.games_missing_analysis
    );
    const incompletePuzzles = state.catalog && firstNumber(
      state.catalog.meta.incomplete_puzzles,
      state.catalog.meta.incomplete_blunders,
      state.catalog.meta.incomplete_count
    );
    if (analysisPending > 0 && state.candidates.length > 0) {
      messages.push(`${analysisPending} imported game${analysisPending === 1 ? " is" : "s are"} still awaiting engine analysis.`);
    }
    if (incompletePuzzles > 0 && state.candidates.length > 0) {
      messages.push(`${incompletePuzzles} blunder position${incompletePuzzles === 1 ? " is" : "s are"} waiting for complete engine data.`);
    }
    if (state.invalid.length > 0 && state.candidates.length > 0) {
      messages.push(`${state.invalid.length} malformed or incomplete candidate${state.invalid.length === 1 ? " was" : "s were"} skipped.`);
    }
    const diagnostics = state.catalog && state.catalog.meta.diagnostic_errors;
    if (Array.isArray(diagnostics) && diagnostics.length > 0 && state.candidates.length > 0) {
      messages.push(`${diagnostics.length} imported game or analysis record${diagnostics.length === 1 ? " was" : "s were"} skipped safely.`);
    }
    if (state.transientWarning) messages.push(state.transientWarning);
    elements.warning.hidden = messages.length === 0;
    elements.warning.textContent = messages.join(" ");
  }

  function showFatal(message) {
    elements.workspace.hidden = true;
    elements.summary.textContent = "Puzzles unavailable";
    elements.pageState.hidden = false;
    elements.pageState.innerHTML = `<h2>Couldn’t load puzzles</h2><p>${escapeHtml(message)}</p>`
      + `<p><a href="index.html">Back to repertoire</a></p>`;
  }

  function activateTab(name, focusTab) {
    const solved = name === "solved";
    state.activeTab = solved ? "solved" : "unsolved";
    elements.unsolvedTab.classList.toggle("active", !solved);
    elements.solvedTab.classList.toggle("active", solved);
    elements.unsolvedTab.setAttribute("aria-selected", String(!solved));
    elements.solvedTab.setAttribute("aria-selected", String(solved));
    elements.unsolvedTab.tabIndex = solved ? -1 : 0;
    elements.solvedTab.tabIndex = solved ? 0 : -1;
    elements.unsolvedPanel.hidden = solved;
    elements.solvedPanel.hidden = !solved;
    if (solved) renderSolvedArchive();
    else if (state.board && state.board.redrawAll) queueMicrotask(() => state.board.redrawAll());
    if (focusTab) (solved ? elements.solvedTab : elements.unsolvedTab).focus();
  }

  function bindEvents() {
    elements.unsolvedTab.addEventListener("click", () => activateTab("unsolved", false));
    elements.solvedTab.addEventListener("click", () => activateTab("solved", false));
    [elements.unsolvedTab, elements.solvedTab].forEach(tab => {
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === "ArrowLeft" || event.key === "Home"
          ? "unsolved"
          : "solved";
        activateTab(target, true);
      });
    });

    elements.uciForm.addEventListener("submit", event => {
      event.preventDefault();
      const candidate = currentCandidate();
      if (!candidate || state.completedCandidate) return;
      const move = normalizeUci(elements.uciInput.value);
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
        elements.feedback.innerHTML = `<span class="bad">Use UCI notation.</span> Example: e2e4 or a7a8q.`;
        elements.uciInput.focus();
        return;
      }
      const from = move.slice(0, 2);
      const to = move.slice(2, 4);
      const choices = promotionChoices(candidate, from, to);
      if (move.length === 4 && choices.length) {
        openPromotionChooser(from, to, choices);
        return;
      }
      closePromotionChooser(false);
      void evaluateMove(move);
    });

    elements.promotionOptions.addEventListener("click", event => {
      const button = event.target.closest("button[data-piece]");
      if (!button || !state.pendingPromotion) return;
      const { from, to } = state.pendingPromotion;
      const move = `${from}${to}${button.dataset.piece}`;
      closePromotionChooser(false);
      void evaluateMove(move);
    });
    elements.promotionCancel.addEventListener("click", () => {
      const candidate = currentCandidate();
      closePromotionChooser(true);
      if (candidate) resetBoardPosition(candidate, false);
    });

    elements.continueButton.addEventListener("click", continueQueue);
    elements.skipButton.addEventListener("click", skipCurrent);
    elements.resetButton.addEventListener("click", () => {
      const candidate = currentCandidate();
      if (!candidate || state.completedCandidate) return;
      clearIncorrectTimer();
      closePromotionChooser(false);
      resetBoardPosition(candidate, true);
      elements.uciInput.value = "";
    });
    elements.hintButton.addEventListener("click", showHint);
    elements.showButton.addEventListener("click", revealSolution);

    elements.solvedList.addEventListener("click", event => {
      const button = event.target.closest("button[data-solved-index]");
      if (!button) return;
      const candidates = elements.solvedList._renderedCandidates || [];
      const candidate = candidates[Number(button.dataset.solvedIndex)];
      if (candidate) {
        state.solvedReviewTrigger = button;
        renderSolvedReview(candidate, true);
      }
    });
    elements.solvedReviewClose.addEventListener("click", () => closeSolvedReview(true));

    window.addEventListener("storage", () => {
      if (!DATA || !Domain || typeof Domain.createProgressStore !== "function") return;
      try {
        state.store = Domain.createProgressStore(DATA.username || "unknown");
        state.completedCandidate = null;
        if (!syncPartition(false)) return;
        renderAll();
      } catch (error) {
        state.transientWarning = "Puzzle progress changed in another tab but could not be refreshed here.";
        renderWarnings();
      }
    });
  }
})();
