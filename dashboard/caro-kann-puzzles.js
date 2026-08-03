// Static opening puzzle trainer. Chess legality, continuation validation,
// queue helpers, and persistence are shared with PuzzleDomain. The historical
// filename and public global remain for backward compatibility.
(function () {
  "use strict";

  const page = document.querySelector
    ? document.querySelector("[data-caro-kann-trainer]")
    : document.getElementById("puzzles-page");
  if (!page) return;

  const Domain = window.PuzzleDomain;
  const Caro = window.CaroKannDomain;
  const UI = window.ChessTrackerUI;
  const CATALOG_URL = "data/opening-puzzle-catalog.json";
  const LEGACY_MANIFEST_URL = "data/caro-kann-black/manifest.json";
  const LEGACY_STORAGE_NAMESPACE = "caro-kann-black";
  const PAGE_TITLE = "Chess Opening Puzzle Trainer";
  const fallbackEscape = value => String(value == null ? "" : value).replace(
    /[&"'<>]/g,
    character => ({
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
      "<": "&lt;",
      ">": "&gt;",
    })[character]
  );
  const escapeHtml = UI && typeof UI.escapeHtml === "function"
    ? UI.escapeHtml
    : fallbackEscape;
  const reducedMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia
    && window.matchMedia("(pointer: coarse)").matches;

  const elements = {
    title: document.getElementById("puzzles-title"),
    intro: document.getElementById("puzzle-intro"),
    summary: document.getElementById("puzzle-progress-summary"),
    warning: document.getElementById("puzzle-storage-warning"),
    filters: document.getElementById("caro-puzzle-filters"),
    deck: document.getElementById("opening-puzzle-deck"),
    filterMode: document.getElementById("caro-filter-mode"),
    filterVariation: document.getElementById("caro-filter-variation"),
    filterDifficulty: document.getElementById("caro-filter-difficulty"),
    filterProvenance: document.getElementById("caro-filter-provenance"),
    filterTheme: document.getElementById("caro-filter-theme"),
    filterOpening: document.getElementById("caro-filter-opening"),
    filterStatus: document.getElementById("caro-filter-status"),
    unsolvedTab: document.getElementById("puzzles-unsolved-tab"),
    solvedTab: document.getElementById("puzzles-solved-tab"),
    unsolvedCount: document.getElementById("puzzles-unsolved-count"),
    solvedCount: document.getElementById("puzzles-solved-count"),
    unsolvedPanel: document.getElementById("puzzles-unsolved-panel"),
    solvedPanel: document.getElementById("puzzles-solved-panel"),
    pageState: document.getElementById("puzzle-page-state"),
    workspace: document.getElementById("puzzle-workspace"),
    board: document.getElementById("puzzle-board"),
    boardHelp: document.getElementById("puzzle-board-help"),
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
    deck: null,
    manifest: null,
    datasetBase: "",
    loadGeneration: 0,
    abortController: null,
    candidates: [],
    candidateIds: new Set(),
    invalidCount: 0,
    invalidCandidateIds: new Set(),
    chunkIndex: 0,
    chunkLoading: null,
    chunkErrors: [],
    filtered: [],
    unsolved: [],
    solved: [],
    sessionIds: [],
    currentId: null,
    completedCandidate: null,
    completedPostFen: null,
    completedMoveUci: null,
    revealed: false,
    feedbackMode: "idle",
    activeTab: "unsolved",
    selectedSolvedId: null,
    pendingPromotion: null,
    board: null,
    solvedBoard: null,
    store: null,
    incorrectTimer: null,
    opponentReplyTimer: null,
    stepIndex: 0,
    linePhase: "awaiting_user",
    lastReplySan: null,
    lastReplyUci: null,
    transientWarning: null,
    solvedReviewTrigger: null,
    filterSignature: "",
  };

  bindEvents();
  const ready = initialize();
  window.CaroKannTrainer = Object.freeze({
    ready,
    catalogUrl: CATALOG_URL,
    // Retain these two legacy fields for callers that only need the original
    // default deck's static locations.
    manifestUrl: LEGACY_MANIFEST_URL,
    storageNamespace: LEGACY_STORAGE_NAMESPACE,
    get selectedDeckId() { return state.deck ? state.deck.id : null; },
    selectDeck(deckId) { return switchDeck(deckId, false); },
  });

  async function initialize() {
    if (!Domain || typeof Domain.createProgressStore !== "function"
        || typeof Domain.partitionCandidates !== "function"
        || typeof Domain.evaluatePuzzleStep !== "function"
        || typeof Domain.solutionSteps !== "function") {
      showFatal("The shared puzzle rules module did not load.");
      return false;
    }
    if (!Caro || typeof Caro.normalizeCatalog !== "function"
        || typeof Caro.normalizeManifest !== "function"
        || typeof Caro.adaptRecord !== "function"
        || typeof Caro.filterRecords !== "function") {
      showFatal("The opening-puzzle dataset module did not load.");
      return false;
    }
    if (!UI || typeof UI.makeBoard !== "function") {
      showFatal("The chessboard module did not load.");
      return false;
    }
    if (typeof window.fetch !== "function") {
      showFatal("This browser cannot load the static puzzle dataset.");
      return false;
    }

    try {
      const rawCatalog = await fetchJson(CATALOG_URL, 0, null);
      state.catalog = Caro.normalizeCatalog(rawCatalog);
      if (state.catalog.schemaVersion !== "1") {
        throw new Error("The opening catalog schema is unsupported.");
      }
      if (!state.catalog.decks.length) throw new Error("The opening catalog contains no valid decks.");
      populateDeckOptions();
      const requested = requestedDeckId();
      return await switchDeck(requested, true);
    } catch (error) {
      console.error("Could not initialize opening puzzles", error);
      showFatal("The opening puzzle catalog is unavailable. Rebuild the dashboard data and reload this page.");
      return false;
    }
  }

  async function fetchJson(url, generation, signal) {
    const options = { credentials: "same-origin" };
    if (signal) options.signal = signal;
    const response = await window.fetch(url, options);
    if (generation && generation !== state.loadGeneration) {
      const error = new Error("A newer opening deck was selected.");
      error.name = "AbortError";
      throw error;
    }
    if (!response || response.ok === false) {
      const status = response && response.status ? ` (${response.status})` : "";
      throw new Error(`Could not fetch ${url}${status}`);
    }
    return response.json();
  }

  function requestedDeckId() {
    let requested = "";
    try {
      if (typeof window.URLSearchParams === "function" && window.location) {
        requested = new window.URLSearchParams(window.location.search || "").get("deck") || "";
      }
    } catch (_error) {
      requested = "";
    }
    return state.catalog.decks.some(deck => deck.id === requested)
      ? requested : state.catalog.defaultDeckId;
  }

  function populateDeckOptions() {
    if (!elements.deck || !state.catalog) return;
    elements.deck.innerHTML = state.catalog.decks.map(deck =>
      `<option value="${escapeHtml(deck.id)}">${escapeHtml(deck.label)}</option>`
    ).join("");
    elements.deck.value = state.catalog.defaultDeckId;
  }

  function deckById(deckId) {
    const requested = String(deckId || "").trim().toLowerCase();
    return state.catalog && (state.catalog.decks.find(deck => deck.id === requested)
      || state.catalog.decks.find(deck => deck.id === state.catalog.defaultDeckId)) || null;
  }

  function datasetBaseForManifest(path) {
    const safe = Caro.safeRelativePath(path);
    if (!safe) return "";
    const slash = safe.lastIndexOf("/");
    return "data/" + (slash >= 0 ? safe.slice(0, slash + 1) : "");
  }

  function resetDatasetState() {
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    closePromotionChooser(false);
    state.manifest = null;
    state.datasetBase = "";
    state.candidates = [];
    state.candidateIds = new Set();
    state.invalidCount = 0;
    state.invalidCandidateIds = new Set();
    state.chunkIndex = 0;
    state.chunkLoading = null;
    state.chunkErrors = [];
    state.filtered = [];
    state.unsolved = [];
    state.solved = [];
    state.sessionIds = [];
    state.currentId = null;
    state.completedCandidate = null;
    state.completedPostFen = null;
    state.completedMoveUci = null;
    state.revealed = false;
    state.feedbackMode = "idle";
    state.selectedSolvedId = null;
    state.pendingPromotion = null;
    state.store = null;
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    state.transientWarning = null;
    state.filterSignature = "";
    if (elements.filterVariation) elements.filterVariation.value = "all";
  }

  async function switchDeck(deckId, initial) {
    const deck = deckById(deckId);
    if (!deck) return false;
    state.loadGeneration += 1;
    const generation = state.loadGeneration;
    if (state.abortController && typeof state.abortController.abort === "function") {
      state.abortController.abort();
    }
    state.abortController = typeof window.AbortController === "function"
      ? new window.AbortController() : null;
    resetDatasetState();
    state.deck = deck;
    if (elements.deck) elements.deck.value = deck.id;
    updateDeckChrome(true);
    renderAll();

    const manifestPath = Caro.safeRelativePath(deck.manifestPath);
    const manifestUrl = manifestPath ? `data/${manifestPath}` : "";
    state.datasetBase = datasetBaseForManifest(manifestPath);
    try {
      if (!manifestUrl || !state.datasetBase) throw new Error("The catalog manifest path is invalid.");
      const rawManifest = await fetchJson(
        manifestUrl,
        generation,
        state.abortController && state.abortController.signal,
      );
      if (generation !== state.loadGeneration) return false;
      const manifest = Caro.normalizeManifest(rawManifest, deck);
      const schemaV2 = /^2(?:\.|$)/.test(String(rawManifest.schemaVersion || rawManifest.schema_version || ""));
      const explicitRoots = rawManifest.openingTagRoots || rawManifest.opening_tag_roots;
      if (schemaV2 && (!rawManifest.deckId && !rawManifest.deck_id
          || !rawManifest.openingFamily && !rawManifest.opening_family
          || !rawManifest.solverColor && !rawManifest.solver_color
          || !rawManifest.orientation || !Array.isArray(explicitRoots) || !explicitRoots.length)) {
        throw new Error("The schema-v2 manifest is missing required deck identity fields.");
      }
      if (deck.openingTagRoots.length) {
        const catalogRoots = deck.openingTagRoots.slice().sort();
        const manifestRoots = manifest.openingTagRoots.slice().sort();
        if (catalogRoots.length !== manifestRoots.length
            || catalogRoots.some((root, index) => root !== manifestRoots[index])) {
          throw new Error("The selected manifest opening roots do not match its catalog entry.");
        }
      }
      if (manifest.deckId !== deck.id || manifest.solverColor !== deck.solverColor
          || manifest.orientation !== deck.orientation
          || manifest.openingFamily !== deck.openingFamily
          || manifest.orientation !== manifest.solverColor
          || !manifest.openingTagRoots.length) {
        throw new Error("The selected manifest does not match its catalog deck.");
      }
      if (!manifest.chunks.length) throw new Error("The manifest contains no deployable balanced chunks.");
      state.manifest = manifest;
      updateDeckChrome(false);
      const username = window.DATA && window.DATA.username ? window.DATA.username : "local";
      state.store = Domain.createProgressStore(username, undefined, deck.id);
      populateFilterOptions();
      await loadNextChunk(false, generation);
      if (generation !== state.loadGeneration) return false;
      rebuildPartition(true);
      renderAll();
      if (!state.unsolved.length && hasMoreChunks()) await ensureUnsolvedCandidates(1, generation);
      updateDeckUrl(deck.id, initial);
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") return false;
      console.error(`Could not initialize ${deck.id} puzzles`, error);
      if (generation === state.loadGeneration) {
        showFatal(`The balanced ${deck.openingFamily} dataset is unavailable. Rebuild the dashboard data and reload this page.`);
      }
      return false;
    }
  }

  function updateDeckUrl(deckId, initial) {
    if (initial || !window.history || typeof window.history.replaceState !== "function"
        || !window.location || typeof window.URL !== "function") return;
    try {
      const url = new window.URL(window.location.href);
      if (deckId === state.catalog.defaultDeckId) url.searchParams.delete("deck");
      else url.searchParams.set("deck", deckId);
      window.history.replaceState(null, "", url.toString());
    } catch (_error) {
      // Query-string support is an enhancement; deck switching remains usable
      // in older browsers with an immutable location object.
    }
  }

  function solverColor() {
    return state.manifest && state.manifest.solverColor
      || state.deck && state.deck.solverColor || "black";
  }

  function boardOrientation() {
    return state.manifest && state.manifest.orientation
      || state.deck && state.deck.orientation || solverColor();
  }

  function openingFamily() {
    return state.manifest && state.manifest.openingFamily
      || state.deck && state.deck.openingFamily || "Opening";
  }

  function colorLabel(value) {
    return value === "white" ? "White" : "Black";
  }

  function opponentColor() {
    return solverColor() === "white" ? "black" : "white";
  }

  function updateDeckChrome(loading) {
    if (!state.deck) return;
    const side = colorLabel(state.deck.solverColor);
    if (elements.title) elements.title.textContent = PAGE_TITLE;
    if (elements.intro) {
      elements.intro.textContent = `Play ${side} through complete tactical continuations from the Lichess puzzle database.`;
    }
    const allOption = elements.filterMode && elements.filterMode.querySelector
      ? elements.filterMode.querySelector('option[value="all"]') : null;
    if (allOption) allOption.textContent = `All ${state.deck.openingFamily}`;
    if (elements.boardHelp) {
      elements.boardHelp.textContent = `Select a piece and destination on the ${side}-oriented board, or use the keyboard move field below the puzzle controls.`;
    }
    if (loading) elements.summary.textContent = `Loading ${state.deck.openingFamily} manifest…`;
  }

  function resolveChunkPath(path) {
    const value = Caro.safeRelativePath(String(path || "").trim().replace(/^\.\//, ""));
    if (!value || /(?:^|\/)all\.jsonl(?:$|\?)/i.test(value)
        || /(?:^|\/)balanced\.jsonl(?:$|\?)/i.test(value)) {
      return null;
    }
    return state.datasetBase + value;
  }

  function chunkRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    return [payload.puzzles, payload.records, payload.items].find(Array.isArray) || [];
  }

  function hasMoreChunks() {
    return Boolean(state.manifest && state.chunkIndex < state.manifest.chunks.length);
  }

  async function loadNextChunk(renderAfter, requestedGeneration) {
    const generation = requestedGeneration || state.loadGeneration;
    if (state.chunkLoading) return state.chunkLoading;
    if (!hasMoreChunks()) return false;

    const chunk = state.manifest.chunks[state.chunkIndex];
    state.chunkIndex += 1;
    const path = resolveChunkPath(chunk.path);
    const loading = (async () => {
      if (!path) {
        state.chunkErrors.push(`Unsafe or unsupported chunk path: ${chunk.path}`);
        state.transientWarning = "One manifest chunk path was invalid; the remaining chunks are still available.";
        if (renderAfter) {
          rebuildPartition(false);
          renderAll();
        }
        return false;
      }
      try {
        const payload = await fetchJson(
          path,
          generation,
          state.abortController && state.abortController.signal,
        );
        if (generation !== state.loadGeneration) return false;
        chunkRecords(payload).forEach(rawRecord => {
          const candidate = Caro.adaptRecord(rawRecord, state.manifest);
          if (!candidate) {
            state.invalidCount += 1;
            return;
          }
          const id = puzzleId(candidate);
          if (!id || state.candidateIds.has(id)) return;
          state.candidateIds.add(id);
          state.candidates.push(candidate);
        });
        populateFilterOptions();
        if (renderAfter) {
          rebuildPartition(false);
          renderAll();
        }
        return true;
      } catch (error) {
        if (generation !== state.loadGeneration || error && error.name === "AbortError") return false;
        state.chunkErrors.push(`${chunk.path}: ${error.message || error}`);
        state.transientWarning = "One balanced puzzle chunk could not be loaded; the remaining chunks are still available.";
        console.error("Could not load opening puzzle chunk", error);
        if (renderAfter) {
          rebuildPartition(false);
          renderAll();
        }
        return false;
      }
    })();
    state.chunkLoading = loading;
    try {
      return await loading;
    } finally {
      if (state.chunkLoading === loading) state.chunkLoading = null;
    }
  }

  async function ensureUnsolvedCandidates(minimum, requestedGeneration) {
    const generation = requestedGeneration || state.loadGeneration;
    const target = Math.max(1, Math.floor(Number(minimum) || 1));
    while (generation === state.loadGeneration && state.unsolved.length < target && hasMoreChunks()) {
      await loadNextChunk(false, generation);
      if (generation !== state.loadGeneration) return false;
      rebuildPartition(false);
    }
    renderAll();
    return true;
  }

  function storedSolvedIds() {
    if (!state.store || typeof state.store.all !== "function") return new Set();
    try {
      return new Set(Object.entries(state.store.all())
        .filter(([, progress]) => progress
          && (progress.status === "solved" || progress.solvedAt))
        .map(([id]) => id));
    } catch (_error) {
      return new Set();
    }
  }

  async function loadStoredSolvedCandidates() {
    const generation = state.loadGeneration;
    const missing = storedSolvedIds();
    if (!missing.size) return;
    state.candidateIds.forEach(id => missing.delete(id));
    while (generation === state.loadGeneration && missing.size && hasMoreChunks()) {
      await loadNextChunk(false, generation);
      if (generation !== state.loadGeneration) return false;
      state.candidateIds.forEach(id => missing.delete(id));
    }
    if (missing.size) {
      state.transientWarning = `${missing.size} saved solved puzzle${missing.size === 1 ? " is" : "s are"} not in the deployed balanced sample.`;
    }
    rebuildPartition(false);
    renderAll();
    return true;
  }

  function currentFilters() {
    return {
      mode: elements.filterMode.value || "all",
      variation: elements.filterVariation.value || "all",
      difficulty: elements.filterDifficulty.value || "all",
      provenance: elements.filterProvenance.value || "all",
      theme: elements.filterTheme.value || "all",
      openingOnly: Boolean(elements.filterOpening.checked),
    };
  }

  function filtersSignature(filters) {
    return [filters.mode, filters.variation, filters.difficulty, filters.provenance,
      filters.theme, filters.openingOnly ? "opening" : "any"].join("|");
  }

  function rebuildPartition(resetQueue) {
    const filters = currentFilters();
    const signature = filtersSignature(filters);
    const selected = Caro.filterRecords(state.candidates, filters);
    let partition;
    try {
      partition = Domain.partitionCandidates(selected, state.store) || {};
    } catch (error) {
      console.error("Could not partition opening-puzzle candidates", error);
      showFatal("The loaded puzzle chunk contains incomplete move data.");
      return false;
    }
    state.filtered = selected;
    state.unsolved = unwrapCandidates(partition.unsolved);
    state.solved = unwrapCandidates(partition.solved);
    if (Array.isArray(partition.invalid)) {
      partition.invalid.forEach(candidate => {
        const id = puzzleId(candidate);
        if (id) state.invalidCandidateIds.add(id);
      });
    }

    let ordered = state.unsolved.slice();
    if (filters.mode === "curriculum") {
      ordered = Caro.curriculumOrder(ordered);
    } else if (typeof Domain.mixCandidates === "function") {
      ordered = Domain.mixCandidates(ordered, dailyQueueSeed(signature));
    }
    const availableIds = new Set(ordered.map(puzzleId));
    if (resetQueue || signature !== state.filterSignature || !state.sessionIds.length
        || filters.mode === "curriculum") {
      state.sessionIds = ordered.map(puzzleId);
    } else {
      state.sessionIds = state.sessionIds.filter(id => availableIds.has(id));
      ordered.forEach(candidate => {
        const id = puzzleId(candidate);
        if (!state.sessionIds.includes(id)) state.sessionIds.push(id);
      });
    }
    state.filterSignature = signature;
    if (!state.completedCandidate
        && (!state.currentId || !availableIds.has(state.currentId))) {
      state.currentId = state.sessionIds[0] || null;
    }
    renderWarnings();
    return true;
  }

  function dailyQueueSeed(signature) {
    const day = new Date().toISOString().slice(0, 10);
    return `${state.deck ? state.deck.id : LEGACY_STORAGE_NAMESPACE}:${day}:${signature}`;
  }

  function unwrapCandidates(items) {
    if (!Array.isArray(items)) return [];
    return items.map(item => item && (item.candidate || item.puzzle || item)).filter(Boolean);
  }

  function puzzleId(candidate) {
    if (!candidate) return "";
    return String(candidate.id || candidate.puzzle_id
      || (Domain.stablePuzzleId && Domain.stablePuzzleId(candidate)) || "");
  }

  function currentCandidate() {
    if (state.completedCandidate) return state.completedCandidate;
    return state.unsolved.find(candidate => puzzleId(candidate) === state.currentId) || null;
  }

  function candidateSteps(candidate) {
    if (!candidate || typeof Domain.solutionSteps !== "function") return [];
    const steps = Domain.solutionSteps(candidate);
    return Array.isArray(steps) ? steps : [];
  }

  function activeStep(candidate) {
    const steps = candidateSteps(candidate);
    if (!steps.length) return null;
    const index = Math.max(0, Math.min(state.stepIndex, steps.length - 1));
    return { step: steps[index], steps, index, isFinalStep: index === steps.length - 1 };
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

  function solvedProgressCount() {
    if (!state.store || typeof state.store.all !== "function") return state.solved.length;
    try {
      return Object.values(state.store.all()).filter(progress =>
        progress && (progress.status === "solved" || progress.solvedAt)
      ).length;
    } catch (_error) {
      return state.solved.length;
    }
  }

  function renderAll() {
    renderCounts();
    renderFilterStatus();
    renderUnsolved();
    renderSolvedArchive();
  }

  function renderCounts() {
    const solvedCount = solvedProgressCount();
    const datasetTotal = state.manifest
      ? state.manifest.balancedExported || state.candidates.length
      : state.candidates.length;
    elements.summary.textContent = `${solvedCount} solved / ${datasetTotal} balanced puzzles`;
    elements.unsolvedCount.textContent = `(${state.unsolved.length})`;
    elements.solvedCount.textContent = `(${state.solved.length})`;
    elements.unsolvedTab.setAttribute("aria-label", `Unsolved filtered puzzles, ${state.unsolved.length} loaded`);
    elements.solvedTab.setAttribute("aria-label", `Solved filtered puzzles, ${state.solved.length} loaded`);
  }

  function renderFilterStatus() {
    if (!state.manifest) return;
    const loadedChunks = state.chunkIndex;
    const totalChunks = state.manifest.chunks.length;
    const group = currentFilters().mode === "curriculum" && currentCandidate()
      ? ` · ${Caro.curriculumGroup(currentCandidate())}`
      : "";
    elements.filterStatus.textContent = `${state.filtered.length} matching puzzle${state.filtered.length === 1 ? "" : "s"} loaded`
      + ` · chunk ${loadedChunks} of ${totalChunks}${group}`;
  }

  function renderUnsolved() {
    const candidate = currentCandidate();
    if (!candidate) {
      elements.workspace.hidden = true;
      elements.pageState.hidden = false;
      if (!state.manifest) {
        elements.pageState.innerHTML = `<h2>Loading ${escapeHtml(openingFamily())} puzzles…</h2><p>The catalog and manifest are loaded before any puzzle chunks.</p>`;
      } else if (hasMoreChunks()) {
        elements.pageState.innerHTML = "<h2>Searching the remaining chunks…</h2><p>The selected study filter is not in the chunks loaded so far.</p>";
      } else if (state.filtered.length && state.solved.length === state.filtered.length) {
        elements.pageState.innerHTML = "<h2>You’ve solved this study set.</h2><p>Choose another filter or review your solved puzzles.</p>";
      } else {
        elements.pageState.innerHTML = "<h2>No puzzles match these filters.</h2><p>Reset one or more filters to widen the study set.</p>";
      }
      return;
    }

    const line = activeStep(candidate);
    if (!line) {
      elements.workspace.hidden = true;
      elements.pageState.hidden = false;
      elements.pageState.innerHTML = "<h2>This puzzle was skipped safely.</h2><p>Its stored continuation is incomplete.</p>";
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

    const attempts = Number(progress.attempts || 0);
    const side = colorLabel(solverColor());
    const decisionLabel = line.steps.length > 1
      ? ` · ${side} move ${line.index + 1} of ${line.steps.length}`
      : "";
    elements.prompt.textContent = completed
      ? "Solved"
      : line.index > 0 ? "Find the continuation" : "Find the best sequence";
    elements.sideToMove.textContent = completed
      ? `Sequence complete · You played ${side}${decisionLabel}`
      : `${side} to move · You are ${side}${decisionLabel}`;
    elements.queuePosition.textContent = completed
      ? `${state.unsolved.length} filtered puzzles remaining`
      : `${state.unsolved.length} filtered puzzles remaining`
        + `${attempts ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`;
    elements.board.setAttribute("aria-label",
      `${completed ? "Solved" : "Interactive"} ${openingFamily()} puzzle, ${side} to move, board oriented for ${side}${decisionLabel}`
    );
    elements.context.innerHTML = contextMarkup(candidate, progress, state.revealed);
    setFeedbackForMode(candidate);
    setControlState(completed);
    paintInteractiveBoard(candidate, completed);
  }

  function progressWasRevealed(progress) {
    return Boolean(progress.solutionRevealedAt || progress.solution_revealed_at
      || progress.solution_revealed);
  }

  function contextMarkup(candidate, progress, reveal) {
    if (!reveal) {
      return `<p class="puzzle-locked-details">Puzzle metadata and the stored line appear after you solve or reveal it.</p>`;
    }
    const themes = Array.isArray(candidate.themes) && candidate.themes.length
      ? candidate.themes.map(formatTheme).join(", ")
      : "—";
    const solution = solutionLabel(candidate);
    const setup = candidate.setupMoveSan || candidate.setup_move_san
      || candidate.setupMoveUci || candidate.setup_move_uci || "—";
    const attempts = Number(progress.attempts || 0);
    const source = safeHttpUrl(candidate.sourceUrl || candidate.source_url || candidate.gameUrl || candidate.game_url);
    return `<dl class="puzzle-context-grid">
      ${detailRow("Setup move", setup)}
      ${detailRow("Rating", candidate.rating == null ? "—" : candidate.rating)}
      ${detailRow("Difficulty", titleCase(candidate.difficulty || "—"))}
      ${detailRow("Variation", candidate.variation || openingFamily())}
      ${detailRow("Themes", themes)}
      ${detailRow("Provenance", provenanceLabel(candidate.provenance))}
      ${detailRow("Opening puzzle", candidate.isOpeningPuzzle ? "Yes" : "No")}
      ${attempts ? detailRow("Attempts", attempts) : ""}
    </dl>
    <div class="puzzle-solution-details">
      <h3>${progress.status === "solved" || progress.solvedAt ? "Solution" : "Revealed solution"}</h3>
      <p class="caro-solution-line">${escapeHtml(solution)}</p>
      ${source ? `<a class="drill-link" href="${escapeHtml(source)}" target="_blank" rel="noopener">Open source game on Lichess</a>` : ""}
    </div>`;
  }

  function detailRow(label, value) {
    return `<div class="row"><dt class="k">${escapeHtml(label)}</dt>`
      + `<dd class="v">${escapeHtml(value)}</dd></div>`;
  }

  function safeHttpUrl(value) {
    const url = String(value || "").trim();
    return /^https?:\/\//i.test(url) ? url : "";
  }

  function titleCase(value) {
    return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
  }

  function formatTheme(value) {
    const labels = {
      defensiveMove: "defensive move",
      quietMove: "quiet move",
      masterVsMaster: "master vs master",
      superGM: "super-GM",
    };
    return labels[value] || String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }

  function provenanceLabel(value) {
    const normalized = String(value || "standard").toLowerCase().replace(/[^a-z]/g, "");
    if (normalized === "mastervsmaster") return "Master-vs-master";
    if (normalized === "supergm") return "Super-GM";
    if (normalized === "master") return "Master";
    return "Standard";
  }

  function solutionLabel(candidate) {
    if (Array.isArray(candidate.solutionSan) && candidate.solutionSan.length) {
      return candidate.solutionSan.join(" ");
    }
    const moves = [];
    candidateSteps(candidate).forEach(step => {
      moves.push(step.best_move_san || step.best_move_uci);
      if (step.opponent_reply_san || step.opponent_reply_uci) {
        moves.push(step.opponent_reply_san || step.opponent_reply_uci);
      }
    });
    return moves.filter(Boolean).join(" ") || "—";
  }

  function setFeedbackForMode(candidate) {
    const line = activeStep(candidate);
    const step = line && line.step;
    const best = step && (step.best_move_san || step.best_move_uci) || "the stored move";
    if (state.feedbackMode === "solved") {
      elements.feedback.innerHTML = `<span class="ok">Sequence solved.</span> You completed the stored tactical continuation.`;
    } else if (state.feedbackMode === "revealed") {
      elements.feedback.innerHTML = `<span class="puzzle-revealed-status">Solution revealed.</span> `
        + `Play ${escapeHtml(best)} to ${line && line.isFinalStep ? "finish" : "continue"}.`;
    } else if (state.feedbackMode === "continuation") {
      elements.feedback.innerHTML = `<span class="ok">Correct.</span> ${colorLabel(opponentColor())} replied ${escapeHtml(state.lastReplySan || "with the stored move")}. Find ${colorLabel(solverColor())}’s next move.`;
    } else if (state.feedbackMode === "incorrect") {
      elements.feedback.innerHTML = `<span class="bad">Try again.</span> That move was legal, but not part of the stored continuation.`;
    } else if (state.linePhase === "playing_reply") {
      elements.feedback.innerHTML = `<span class="ok">Correct.</span> ${colorLabel(opponentColor())} is replying ${escapeHtml(state.lastReplySan || "with the stored move")}…`;
    } else {
      elements.feedback.textContent = line && (line.steps.length > 1 || step.opponent_reply_uci)
        ? `Find ${colorLabel(solverColor())}’s best move, then finish the complete continuation.`
        : `Find ${colorLabel(solverColor())}’s best move.`;
    }
  }

  function setControlState(completed) {
    const locked = completed || state.linePhase !== "awaiting_user";
    elements.continueButton.hidden = !completed;
    elements.skipButton.hidden = completed;
    elements.resetButton.hidden = completed;
    elements.hintButton.hidden = completed || state.revealed;
    elements.showButton.hidden = completed || state.revealed;
    elements.uciDisclosure.hidden = completed;
    if (completed) elements.uciDisclosure.open = false;
    elements.skipButton.disabled = locked;
    elements.resetButton.disabled = locked;
    elements.hintButton.disabled = locked || state.revealed;
    elements.showButton.disabled = locked || state.revealed;
    elements.uciInput.disabled = locked;
    const submit = elements.uciForm.querySelector("button[type='submit']");
    if (submit) submit.disabled = locked;
  }

  function paintInteractiveBoard(candidate, completed) {
    const line = activeStep(candidate);
    if (!line) return;
    const step = line.step;
    const locked = completed || state.linePhase !== "awaiting_user";
    let fen = step.fen_before;
    let lastMove;
    if (completed) {
      const final = line.steps[line.steps.length - 1];
      fen = state.completedPostFen || final.post_reply_fen || final.post_best_fen;
      lastMove = state.completedMoveUci
        || final.opponent_reply_uci || final.best_move_uci;
    } else if (state.linePhase === "playing_reply") {
      fen = step.post_best_fen;
      lastMove = step.best_move_uci;
    } else if (line.index > 0) {
      lastMove = line.steps[line.index - 1].opponent_reply_uci;
    }
    const config = {
      fen,
      orientation: boardOrientation(),
      coordinatesOnSquares: true,
      // Never put the reusable queue board through Chessground's view-only
      // lifecycle; disabling movable/selectable preserves phone listeners.
      viewOnly: false,
      turnColor: solverColor(),
      lastMove: uciSquares(lastMove),
      check: false,
      drawable: { enabled: false, visible: true },
      movable: {
        free: false,
        color: locked ? undefined : solverColor(),
        dests: locked ? new Map() : legalDests(step),
        events: { after: handleBoardMove },
      },
      draggable: { enabled: !completed && !coarsePointer && !locked },
      selectable: { enabled: !locked },
    };
    if (!state.board) state.board = UI.makeBoard(elements.board, config);
    else state.board.set(config);
    if (!state.board) {
      state.transientWarning = "The board could not be initialized. Keyboard move entry is still available.";
      renderWarnings();
      return;
    }
    if (completed || state.revealed || state.linePhase === "playing_reply") {
      drawMove(completed && state.completedMoveUci
        ? state.completedMoveUci
        : step.best_move_uci, "green");
    } else {
      state.board.setShapes([]);
    }
  }

  function legalDests(step) {
    const raw = step.legal_dests || step.legalDests || {};
    return new Map(Object.entries(raw).map(([from, destinations]) => [
      from,
      Array.isArray(destinations) ? destinations : [],
    ]));
  }

  function normalizeUci(move) {
    return typeof Domain.normalizeUci === "function"
      ? Domain.normalizeUci(move)
      : String(move || "").trim().toLowerCase();
  }

  function uciSquares(move) {
    const normalized = normalizeUci(move);
    return normalized && normalized.length >= 4
      ? [normalized.slice(0, 2), normalized.slice(2, 4)]
      : undefined;
  }

  function drawMove(move, brush) {
    if (!state.board) return;
    const squares = uciSquares(move);
    state.board.setShapes(squares ? [{ orig: squares[0], dest: squares[1], brush }] : []);
  }

  function handleBoardMove(from, to) {
    const candidate = currentCandidate();
    const line = activeStep(candidate);
    if (!candidate || !line || state.completedCandidate || state.linePhase !== "awaiting_user") return;
    const choices = promotionChoices(line.step, from, to);
    if (choices.length) {
      resetBoardPosition(candidate, false);
      openPromotionChooser(from, to, choices);
      return;
    }
    void evaluateMove(`${from}${to}`);
  }

  function promotionChoices(step, from, to) {
    if (typeof Domain.promotionChoices !== "function") return [];
    const raw = Domain.promotionChoices(step, from, to);
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(choice => String(choice && (choice.piece || choice.role
      || choice.promotion) || choice || "").toLowerCase().slice(-1))
      .filter(choice => ["q", "r", "b", "n"].includes(choice)))];
  }

  function openPromotionChooser(from, to, choices) {
    state.pendingPromotion = { from, to };
    state.linePhase = "choosing_promotion";
    const labels = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
    elements.promotionOptions.innerHTML = choices.map(choice =>
      `<button type="button" class="puzzle-promotion-option" data-piece="${choice}" aria-label="Promote to ${labels[choice]}">${labels[choice]}</button>`
    ).join("");
    elements.promotionChooser.hidden = false;
    elements.promotionChooser.setAttribute("aria-describedby", "puzzle-feedback");
    elements.feedback.textContent = `Choose the piece for ${colorLabel(solverColor())}’s promotion.`;
    setControlState(false);
    const candidate = currentCandidate();
    if (candidate) paintInteractiveBoard(candidate, false);
    const first = elements.promotionOptions.querySelector("button");
    if (first) first.focus();
  }

  function closePromotionChooser(restoreFeedback) {
    const wasChoosing = state.linePhase === "choosing_promotion";
    state.pendingPromotion = null;
    elements.promotionChooser.hidden = true;
    elements.promotionOptions.innerHTML = "";
    if (wasChoosing) {
      state.linePhase = "awaiting_user";
      setControlState(false);
    }
    if (restoreFeedback) {
      const candidate = currentCandidate();
      if (candidate) setFeedbackForMode(candidate);
    }
  }

  async function evaluateMove(rawMove) {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate || state.linePhase !== "awaiting_user") return;
    const move = normalizeUci(rawMove);
    let result;
    try {
      result = Domain.evaluatePuzzleStep(candidate, state.stepIndex, move);
    } catch (error) {
      elements.feedback.textContent = "That move could not be checked. Reset the position and try again.";
      console.error("Opening-puzzle attempt evaluation failed", error);
      return;
    }
    const kind = result && result.kind;
    if (kind === "illegal") {
      elements.feedback.innerHTML = `<span class="bad">Illegal move.</span> Choose a legal move for ${colorLabel(solverColor())}.`;
      resetBoardPosition(candidate, false);
      elements.uciInput.focus();
      return;
    }
    if (kind === "correct") {
      if (result.solved) {
        state.completedPostFen = result.attemptedPostFen || null;
        state.completedMoveUci = result.uci || null;
        recordAttempt(candidate, true);
        markSolved(candidate);
      } else if (result.reply) {
        playOpponentReply(candidate, result);
      } else {
        elements.feedback.textContent = "The stored continuation is incomplete. Reset the puzzle and try again.";
        resetPuzzleLine(candidate, true);
      }
      return;
    }
    if (kind === "incorrect") {
      recordAttempt(candidate, false);
      showIncorrect(candidate, move);
      return;
    }
    elements.feedback.textContent = "That move could not be checked because its move data is incomplete.";
    resetBoardPosition(candidate, false);
  }

  function recordAttempt(candidate, correct) {
    try {
      state.store.recordAttempt(puzzleId(candidate), correct, new Date().toISOString());
    } catch (error) {
      state.transientWarning = "This attempt could not be saved. Progress may be lost when the page closes.";
      console.error("Could not save opening-puzzle attempt", error);
    }
    renderWarnings();
  }

  function markSolved(candidate) {
    try {
      state.store.markSolved(puzzleId(candidate), new Date().toISOString());
    } catch (error) {
      state.transientWarning = "The solved state could not be saved. Keep this page open and try again.";
      renderWarnings();
      return;
    }
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    state.linePhase = "complete";
    state.completedCandidate = candidate;
    state.currentId = null;
    state.revealed = true;
    state.feedbackMode = "solved";
    rebuildPartition(false);
    renderAll();
    queueMicrotask(() => elements.continueButton.focus());
    if (!state.unsolved.length && hasMoreChunks()) {
      void ensureUnsolvedCandidates();
    } else if (state.unsolved.length < 3 && hasMoreChunks()) {
      void loadNextChunk(true);
    }
  }

  function showIncorrect(candidate, move) {
    state.feedbackMode = "incorrect";
    state.linePhase = "incorrect";
    elements.feedback.innerHTML = `<span class="bad">Try again.</span> That move is legal, but it is not in the stored continuation.`;
    drawMove(move, "red");
    updateAttemptLabel(candidate);
    setControlState(false);
    clearIncorrectTimer();
    const candidateId = puzzleId(candidate);
    state.incorrectTimer = window.setTimeout(() => {
      if (currentCandidate() && puzzleId(currentCandidate()) === candidateId
          && !state.completedCandidate) {
        state.stepIndex = 0;
        state.linePhase = "awaiting_user";
        state.lastReplySan = null;
        state.lastReplyUci = null;
        elements.uciInput.value = "";
        renderUnsolved();
      }
      state.incorrectTimer = null;
    }, reducedMotion ? 0 : 450);
  }

  function updateAttemptLabel(candidate) {
    const progress = getProgress(candidate);
    const attempts = Number(progress.attempts || 0);
    elements.queuePosition.textContent = `${state.unsolved.length} filtered puzzles remaining`
      + `${attempts ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`;
  }

  function clearIncorrectTimer() {
    if (state.incorrectTimer !== null) {
      window.clearTimeout(state.incorrectTimer);
      state.incorrectTimer = null;
    }
  }

  function clearOpponentReplyTimer() {
    if (state.opponentReplyTimer !== null) {
      window.clearTimeout(state.opponentReplyTimer);
      state.opponentReplyTimer = null;
    }
  }

  function playOpponentReply(candidate, result) {
    if (!result || !result.reply) {
      elements.feedback.textContent = `The stored ${colorLabel(opponentColor())} reply is incomplete. Reset the puzzle and try again.`;
      resetPuzzleLine(candidate, true);
      return;
    }
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    state.linePhase = "playing_reply";
    state.lastReplySan = result.reply.san || result.reply.uci;
    state.lastReplyUci = result.reply.uci;
    state.feedbackMode = "replying";
    setFeedbackForMode(candidate);
    setControlState(false);
    paintInteractiveBoard(candidate, false);

    const candidateId = puzzleId(candidate);
    state.opponentReplyTimer = window.setTimeout(() => {
      state.opponentReplyTimer = null;
      const current = currentCandidate();
      if (!current || puzzleId(current) !== candidateId || state.completedCandidate) return;
      if (result.completesAfterReply) {
        state.completedPostFen = result.reply.fen || null;
        state.completedMoveUci = result.reply.uci || null;
        recordAttempt(candidate, true);
        markSolved(candidate);
        return;
      }
      if (result.nextStepIndex == null) {
        elements.feedback.textContent = "The stored continuation cannot advance. Reset the puzzle and try again.";
        resetPuzzleLine(candidate, true);
        return;
      }
      state.stepIndex = result.nextStepIndex;
      state.linePhase = "awaiting_user";
      state.feedbackMode = state.revealed ? "revealed" : "continuation";
      elements.uciInput.value = "";
      renderUnsolved();
    }, reducedMotion ? 0 : 650);
  }

  function resetBoardPosition(candidate, restoreFeedback) {
    if (!candidate) return;
    state.linePhase = "awaiting_user";
    paintInteractiveBoard(candidate, false);
    setControlState(false);
    if (restoreFeedback) {
      state.feedbackMode = state.revealed ? "revealed" : "idle";
      setFeedbackForMode(candidate);
    }
  }

  function resetPuzzleLine(candidate, restoreFeedback) {
    if (!candidate) return;
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    state.feedbackMode = state.revealed ? "revealed" : "idle";
    if (restoreFeedback) renderUnsolved();
    else paintInteractiveBoard(candidate, false);
  }

  function revealSolution() {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate || state.linePhase !== "awaiting_user") return;
    try {
      state.store.revealSolution(puzzleId(candidate), new Date().toISOString());
    } catch (error) {
      state.transientWarning = "The revealed-solution state could not be saved.";
      console.error("Could not save opening-puzzle reveal", error);
    }
    state.revealed = true;
    state.feedbackMode = "revealed";
    renderWarnings();
    renderUnsolved();
  }

  function showHint() {
    const candidate = currentCandidate();
    const line = activeStep(candidate);
    if (!candidate || !line || state.completedCandidate || state.revealed || !state.board
        || state.linePhase !== "awaiting_user") return;
    const best = normalizeUci(line.step.best_move_uci);
    if (!best || best.length < 4) {
      elements.feedback.textContent = "A hint is unavailable for this puzzle.";
      return;
    }
    state.board.setShapes([{ orig: best.slice(0, 2), brush: "yellow" }]);
    elements.feedback.textContent = `Hint: start with the ${colorLabel(solverColor())} piece on ${best.slice(0, 2)}.`;
  }

  async function skipCurrent() {
    let candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    if (state.unsolved.length <= 1 && hasMoreChunks()) {
      await ensureUnsolvedCandidates(2);
      candidate = currentCandidate();
    }
    if (!candidate || state.unsolved.length <= 1) {
      elements.feedback.textContent = "This is the only loaded unsolved puzzle in the study set.";
      return;
    }
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    closePromotionChooser(false);
    const ordered = state.sessionIds
      .map(id => state.unsolved.find(item => puzzleId(item) === id))
      .filter(Boolean);
    let rotated = typeof Domain.rotateQueue === "function"
      ? Domain.rotateQueue(ordered, puzzleId(candidate))
      : ordered.slice(1).concat(ordered[0]);
    if (!Array.isArray(rotated) || rotated.length !== ordered.length) {
      rotated = ordered.slice(1).concat(ordered[0]);
    }
    state.sessionIds = rotated.map(puzzleId);
    state.currentId = state.sessionIds[0] || null;
    state.revealed = false;
    state.feedbackMode = "idle";
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    elements.uciInput.value = "";
    renderAll();
    focusPuzzleStart();
  }

  async function continueQueue() {
    if (!state.completedCandidate) return;
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    state.completedCandidate = null;
    state.completedPostFen = null;
    state.completedMoveUci = null;
    state.currentId = state.sessionIds[0] || null;
    state.revealed = false;
    state.feedbackMode = "idle";
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    elements.uciInput.value = "";
    if (!state.currentId && hasMoreChunks()) {
      await ensureUnsolvedCandidates();
      state.currentId = state.sessionIds[0] || null;
    }
    renderUnsolved();
    if (state.currentId) focusPuzzleStart();
    else elements.pageState.focus && elements.pageState.focus();
  }

  function focusPuzzleStart() {
    if (!window.matchMedia || !window.matchMedia("(max-width: 760px)").matches) return;
    queueMicrotask(() => {
      try {
        elements.prompt.focus({ preventScroll: true });
      } catch (_error) {
        elements.prompt.focus();
      }
    });
  }

  function renderSolvedArchive() {
    if (!state.solved.length) {
      elements.solvedLayout.hidden = true;
      elements.solvedEmpty.hidden = false;
      elements.solvedEmpty.innerHTML = `<h2>No solved puzzles in this study set yet</h2><p>Solved ${escapeHtml(openingFamily())} puzzles stay here on this device.</p>`;
      elements.solvedReview.hidden = true;
      return;
    }
    elements.solvedEmpty.hidden = true;
    elements.solvedLayout.hidden = false;
    const solved = state.solved.slice().sort((left, right) =>
      Date.parse(solvedTimestamp(getProgress(right)) || 0)
      - Date.parse(solvedTimestamp(getProgress(left)) || 0)
    );
    elements.solvedList.innerHTML = solved.map((candidate, index) => {
      const progress = getProgress(candidate);
      return `<article class="puzzle-solved-item">
        <div class="puzzle-solved-item-main">
          <h2>${escapeHtml(candidate.variation || openingFamily())}</h2>
          <p>${escapeHtml(colorLabel(solverColor()))} · ${escapeHtml(titleCase(candidate.difficulty || "—"))} · rating ${escapeHtml(candidate.rating == null ? "—" : candidate.rating)}</p>
          <p class="puzzle-solved-meta">${escapeHtml(provenanceLabel(candidate.provenance))} · solved ${escapeHtml(formatTimestamp(solvedTimestamp(progress)))}</p>
        </div>
        <button type="button" class="puzzle-review-button" data-solved-index="${index}" aria-label="Review solved ${escapeHtml(candidate.variation || openingFamily())} puzzle">Review</button>
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

  function formatTimestamp(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }).format(date);
  }

  function renderSolvedReview(candidate, focusHeading) {
    state.selectedSolvedId = puzzleId(candidate);
    const progress = getProgress(candidate);
    elements.solvedReview.hidden = false;
    elements.solvedReviewTitle.textContent = `Solved puzzle · ${candidate.variation || openingFamily()}`;
    elements.solvedDetails.innerHTML = contextMarkup(candidate, progress, true)
      + `<p class="puzzle-readonly-note">Read-only review · solved ${escapeHtml(formatTimestamp(solvedTimestamp(progress)))}</p>`;
    const first = candidateSteps(candidate)[0];
    const config = {
      fen: candidate.puzzleFen || candidate.fen_before,
      orientation: boardOrientation(),
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
      const best = first && uciSquares(first.best_move_uci);
      state.solvedBoard.setShapes(best
        ? [{ orig: best[0], dest: best[1], brush: "green" }]
        : []);
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

  function populateFilterOptions() {
    if (!state.manifest) return;
    const selectedVariation = elements.filterVariation.value || "all";
    const variations = Caro.variationNames(state.manifest, state.candidates)
      .map(value => Caro.matchingOpeningTags([value], state.manifest.openingTagRoots).length
        ? Caro.readableVariation(value, state.manifest) : value);
    const uniqueVariations = [...new Set(variations)].sort((left, right) => left.localeCompare(right));
    elements.filterVariation.innerHTML = `<option value="all">All variations</option>`
      + uniqueVariations.map(variation => `<option value="${escapeHtml(variation)}">${escapeHtml(variation)}</option>`).join("");
    elements.filterVariation.value = uniqueVariations.includes(selectedVariation) ? selectedVariation : "all";

    const selectedTheme = elements.filterTheme.value || "all";
    const aggregateThemeAliases = new Set([
      "mate", "fork", "pin", "sacrifice", "defensivemove", "quietmove",
    ]);
    const standardOptions = [
      ["all", "All themes"], ["mates", "Mates"], ["forks", "Forks"],
      ["pins", "Pins"], ["sacrifices", "Sacrifices"],
      ["defensive", "Defensive moves"], ["quiet", "Quiet moves"],
    ];
    const exactThemes = Caro.themeNames(state.manifest, state.candidates)
      .filter(theme => !aggregateThemeAliases.has(String(theme).toLowerCase()));
    elements.filterTheme.innerHTML = standardOptions.map(([value, label]) =>
      `<option value="${value}">${label}</option>`
    ).join("") + exactThemes.map(theme =>
      `<option value="${escapeHtml(theme)}">${escapeHtml(titleCase(theme))}</option>`
    ).join("");
    const themeValues = standardOptions.map(option => option[0]).concat(exactThemes);
    elements.filterTheme.value = themeValues.includes(selectedTheme) ? selectedTheme : "all";
  }

  function renderWarnings() {
    const messages = [];
    if (state.store) {
      const persistent = typeof state.store.isPersistent === "function"
        ? state.store.isPersistent()
        : state.store.isPersistent !== false;
      if (!persistent) messages.push(`${openingFamily()} progress is available only for this page session because browser storage is unavailable.`);
      if (typeof state.store.getLastError === "function" && state.store.getLastError() && persistent) {
        messages.push(`The last ${openingFamily()} progress update may not have been saved.`);
      }
    }
    const invalidCount = state.invalidCount + state.invalidCandidateIds.size;
    if (invalidCount) messages.push(`${invalidCount} invalid loaded record${invalidCount === 1 ? " was" : "s were"} skipped safely.`);
    if (state.chunkErrors.length) messages.push(`${state.chunkErrors.length} puzzle chunk${state.chunkErrors.length === 1 ? "" : "s"} could not be loaded.`);
    if (state.transientWarning) messages.push(state.transientWarning);
    elements.warning.hidden = !messages.length;
    elements.warning.textContent = messages.join(" ");
  }

  function showFatal(message) {
    elements.workspace.hidden = true;
    elements.summary.textContent = "Opening puzzles unavailable";
    elements.pageState.hidden = false;
    elements.pageState.innerHTML = `<h2>Couldn’t load opening puzzles</h2><p>${escapeHtml(message)}</p>`
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
    if (solved) {
      renderSolvedArchive();
      if (hasMoreChunks() && storedSolvedIds().size) void loadStoredSolvedCandidates();
    } else if (state.board && state.board.redrawAll) {
      queueMicrotask(() => state.board.redrawAll());
    }
    if (focusTab) (solved ? elements.solvedTab : elements.unsolvedTab).focus();
  }

  async function handleFilterChange() {
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    closePromotionChooser(false);
    state.completedCandidate = null;
    state.completedPostFen = null;
    state.completedMoveUci = null;
    state.currentId = null;
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    state.revealed = false;
    state.feedbackMode = "idle";
    rebuildPartition(true);
    renderAll();
    if (!state.unsolved.length && hasMoreChunks()) await ensureUnsolvedCandidates();
  }

  function bindEvents() {
    if (elements.deck) {
      elements.deck.addEventListener("change", () => { void switchDeck(elements.deck.value, false); });
    }
    elements.unsolvedTab.addEventListener("click", () => activateTab("unsolved", false));
    elements.solvedTab.addEventListener("click", () => activateTab("solved", false));
    [elements.unsolvedTab, elements.solvedTab].forEach(tab => {
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        activateTab(event.key === "ArrowLeft" || event.key === "Home" ? "unsolved" : "solved", true);
      });
    });

    [elements.filterMode, elements.filterVariation, elements.filterDifficulty,
      elements.filterProvenance, elements.filterTheme, elements.filterOpening]
      .forEach(control => control.addEventListener("change", () => { void handleFilterChange(); }));
    elements.filters.addEventListener("reset", () => queueMicrotask(() => {
      if (elements.deck && state.deck) elements.deck.value = state.deck.id;
      void handleFilterChange();
    }));

    elements.uciForm.addEventListener("submit", event => {
      event.preventDefault();
      const candidate = currentCandidate();
      const line = activeStep(candidate);
      if (!candidate || !line || state.completedCandidate || state.linePhase !== "awaiting_user") return;
      const move = normalizeUci(elements.uciInput.value);
      if (!move || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
        elements.feedback.innerHTML = `<span class="bad">Use UCI notation.</span> Example: e7e5 or a2a1q.`;
        elements.uciInput.focus();
        return;
      }
      const from = move.slice(0, 2);
      const to = move.slice(2, 4);
      const choices = promotionChoices(line.step, from, to);
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
    elements.continueButton.addEventListener("click", () => { void continueQueue(); });
    elements.skipButton.addEventListener("click", () => { void skipCurrent(); });
    elements.resetButton.addEventListener("click", () => {
      const candidate = currentCandidate();
      if (!candidate || state.completedCandidate) return;
      closePromotionChooser(false);
      resetPuzzleLine(candidate, true);
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

    window.addEventListener("storage", event => {
      if (!state.store || (event && event.key && event.key !== state.store.key)) return;
      try {
        const username = window.DATA && window.DATA.username ? window.DATA.username : "local";
        state.store = Domain.createProgressStore(username, undefined, state.deck.id);
        state.completedCandidate = null;
        state.completedPostFen = null;
        state.completedMoveUci = null;
        state.stepIndex = 0;
        state.linePhase = "awaiting_user";
        state.feedbackMode = "idle";
        rebuildPartition(false);
        renderAll();
      } catch (error) {
        state.transientWarning = "Progress changed in another tab but could not be refreshed here.";
        renderWarnings();
      }
    });
  }
}());
