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
  const Trainer = window.TrainerDomain;
  const UI = window.ChessTrackerUI;
  const CATALOG_URL = "data/opening-puzzle-catalog.json";
  const LEGACY_MANIFEST_URL = "data/caro-kann-black/manifest.json";
  const LEGACY_STORAGE_NAMESPACE = "caro-kann-black";
  const PAGE_TITLE = "Chess Opening Puzzle Trainer";
  const DEFAULT_SESSION_SIZE = 10;
  const SESSION_SIZES = [5, 10, 20];
  const DEFAULT_SESSION_MODE = "endless";
  const ENDLESS_BATCH_SIZE = 20;
  const DATA_CACHE = "chess-opening-trainer-data-v3";
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
    variationPicker: document.getElementById("variation-picker"),
    filterDifficulty: document.getElementById("caro-filter-difficulty"),
    filterProvenance: document.getElementById("caro-filter-provenance"),
    filterLines: document.getElementById("caro-filter-lines"),
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
    headerDeck: document.getElementById("trainer-header-deck"),
    headerProgress: document.getElementById("trainer-header-progress"),
    libraryOpen: document.getElementById("deck-library-open"),
    library: document.getElementById("deck-library"),
    libraryClose: document.getElementById("deck-library-close"),
    libraryCards: document.getElementById("deck-library-cards"),
    customizeOpen: document.getElementById("customize-open"),
    customizeClose: document.getElementById("customize-close"),
    customizeApply: document.getElementById("customize-apply"),
    customizeSearch: document.getElementById("customize-search"),
    variationChoices: document.getElementById("variation-choice-list"),
    themeChoices: document.getElementById("theme-choice-list"),
    filterChips: document.getElementById("active-filter-chips"),
    onboarding: document.getElementById("trainer-onboarding"),
    onboardingDismiss: document.getElementById("trainer-onboarding-dismiss"),
    trainingLength: document.getElementById("training-length"),
    sessionRestart: document.getElementById("session-restart"),
    sessionStartFresh: document.getElementById("session-start-fresh"),
    sessionComplete: document.getElementById("session-complete"),
    sessionCompleteTitle: document.getElementById("session-complete-title"),
    sessionResults: document.getElementById("session-results"),
    sessionWeakSpots: document.getElementById("session-weak-spots"),
    sessionReviewMistakes: document.getElementById("session-review-mistakes"),
    sessionStartAnother: document.getElementById("session-start-another"),
    reviewsDue: document.getElementById("reviews-due-button"),
    reviewMistakes: document.getElementById("review-mistakes-button"),
    reviewState: document.getElementById("puzzle-review-state"),
    progressTrack: document.getElementById("puzzle-progress-track"),
    progressFill: document.getElementById("puzzle-progress-fill"),
    curriculum: document.getElementById("curriculum-journey"),
    curriculumGroups: document.getElementById("curriculum-groups"),
    curriculumContinue: document.getElementById("curriculum-continue"),
    progressExport: document.getElementById("progress-export"),
    progressImport: document.getElementById("progress-import"),
    progressTransferStatus: document.getElementById("progress-transfer-status"),
  };

  const state = {
    catalog: null,
    deck: null,
    manifest: null,
    selectionIndex: null,
    selectionEntriesById: new Map(),
    datasetBase: "",
    loadGeneration: 0,
    abortController: null,
    candidates: [],
    candidateIds: new Set(),
    invalidCount: 0,
    invalidCandidateIds: new Set(),
    chunkIndex: 0,
    loadedChunkIndexes: new Set(),
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
    deckManifests: new Map(),
    personalEnvelope: null,
    personalEnvelopePromise: null,
    reviewStore: null,
    session: null,
    presentation: null,
    sessionMode: DEFAULT_SESSION_MODE,
    sessionSize: DEFAULT_SESSION_SIZE,
    endlessCompleted: 0,
    reviewModeIds: null,
    sessionCompletionTracked: false,
    lastMistakeIds: [],
    curriculumGroup: "",
    teachingPly: null,
    solvedTeachingPly: null,
    firstMoveTracked: false,
    lastFocus: null,
    fatalRetry: null,
    reviewRecords: Object.create(null),
    unavailableReviewIds: new Set(),
    customizeSnapshot: null,
    resumedActive: false,
    activeSelectionToken: null,
  };

  bindEvents();
  registerServiceWorker();
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
    startSession(length) {
      if (length === "endless") return startSession({ mode: "endless" });
      const size = Number(length);
      return SESSION_SIZES.includes(size)
        ? startSession({ mode: "finite", size })
        : startPreferredSession();
    },
    reviewMistakes() { return startMistakeReview(); },
    get sessionSummary() {
      if (!state.session) return null;
      if (isEndlessSession()) {
        return {
          completed: state.endlessCompleted + sessionCompletedCount(state.session),
          total: null,
          complete: false,
          mode: "endless",
        };
      }
      return sessionSummary(state.session);
    },
  });

  function progressUsername() {
    return window.DATA && window.DATA.username ? window.DATA.username : "local";
  }

  function isPersonalBlunderDeck(deck) {
    return Boolean(deck && Caro && typeof Caro.isPersonalBlunderDeck === "function"
      && Caro.isPersonalBlunderDeck(deck));
  }

  function progressNamespace(deck) {
    return isPersonalBlunderDeck(deck) ? undefined : deck && deck.id;
  }

  function createDeckProgressStore(deck) {
    return Domain.createProgressStore(
      progressUsername(), undefined, progressNamespace(deck),
    );
  }

  function initializeLearningStore() {
    if (!Trainer || typeof Trainer.createTrainerStore !== "function") return;
    try {
      state.reviewStore = Trainer.createTrainerStore(progressUsername());
    } catch (error) {
      console.error("Could not initialize local trainer progress", error);
      state.reviewStore = null;
    }
  }

  function restorePreferences() {
    state.sessionMode = preference("sessionMode", DEFAULT_SESSION_MODE) === "finite"
      ? "finite" : DEFAULT_SESSION_MODE;
    const size = Number(preference("sessionSize", DEFAULT_SESSION_SIZE));
    state.sessionSize = SESSION_SIZES.includes(size) ? size : DEFAULT_SESSION_SIZE;
    if (elements.trainingLength) {
      elements.trainingLength.value = state.sessionMode === "endless"
        ? "endless" : String(state.sessionSize);
    }
  }

  function preference(name, fallback) {
    if (!state.reviewStore || typeof state.reviewStore.getPreferences !== "function") return fallback;
    try {
      const preferences = state.reviewStore.getPreferences() || {};
      return preferences[name] == null ? fallback : preferences[name];
    } catch (_error) {
      return fallback;
    }
  }

  function setPreference(name, value) {
    if (!state.reviewStore) return;
    try {
      if (name === "lastDeckId" && typeof state.reviewStore.setLastDeck === "function") {
        state.reviewStore.setLastDeck(value);
      } else if (name === "sessionSize" && typeof state.reviewStore.setSessionSize === "function") {
        state.reviewStore.setSessionSize(value);
      } else if (name === "sessionMode" && typeof state.reviewStore.setSessionMode === "function") {
        state.reviewStore.setSessionMode(value);
      } else if (typeof state.reviewStore.setPreferences === "function") {
        state.reviewStore.setPreferences({ [name]: value });
      }
    } catch (error) {
      state.transientWarning = "Your trainer preference couldn’t be saved on this device.";
      console.error("Could not save trainer preference", error);
    }
  }

  function restorableActiveSelection() {
    if (!state.selectionIndex || !state.reviewStore
        || typeof state.reviewStore.getSelectionState !== "function") return null;
    try {
      const selection = state.reviewStore.getSelectionState() || {};
      const active = selection.active;
      if (!active || active.deckId !== state.deck.id
          || active.datasetVersion !== state.selectionIndex.datasetVersion
          || Date.parse(active.expiresAt || "") <= Date.now()
          || !Array.isArray(active.puzzleIds) || !active.puzzleIds.length
          || Number(active.nextIndex || 0) >= active.puzzleIds.length) return null;
      return active;
    } catch (_error) {
      return null;
    }
  }

  function restoreActiveTrainingSetup(active) {
    if (!active) return false;
    const filters = active.filters || {};
    const assignSelect = (select, value, fallback) => {
      if (!select) return;
      const requested = String(value == null ? fallback : value);
      const values = selectOptions(select).map(option => option.value);
      select.value = !values.length || values.includes(requested) ? requested : fallback;
    };
    assignSelect(elements.filterMode, filters.mode, "all");
    assignSelect(elements.filterVariation, filters.variation, "all");
    assignSelect(elements.filterDifficulty, filters.difficulty, "all");
    assignSelect(elements.filterProvenance, filters.provenance, "all");
    assignSelect(elements.filterLines, filters.lineCoverage, "all");
    assignSelect(elements.filterTheme, filters.theme, "all");
    if (elements.filterOpening) elements.filterOpening.checked = filters.openingOnly === true;
    state.curriculumGroup = filters.curriculumGroup || "";
    if (active.trainingLength === "endless") {
      state.sessionMode = "endless";
      if (elements.trainingLength) elements.trainingLength.value = "endless";
    } else {
      const size = Number(active.size || active.puzzleIds.length);
      if (SESSION_SIZES.includes(size)) {
        state.sessionMode = "finite";
        state.sessionSize = size;
        if (elements.trainingLength) elements.trainingLength.value = String(size);
      }
    }
    renderChoiceLists();
    return true;
  }

  function showOnboardingIfNeeded() {
    if (!elements.onboarding) return;
    elements.onboarding.hidden = Boolean(preference("onboardingDismissed", false));
  }

  function dismissOnboarding() {
    if (elements.onboarding) elements.onboarding.hidden = true;
    try {
      if (state.reviewStore && typeof state.reviewStore.dismissOnboarding === "function") {
        state.reviewStore.dismissOnboarding();
      } else {
        setPreference("onboardingDismissed", true);
      }
    } catch (_error) {
      // Dismissal remains effective for the current page even when storage is unavailable.
    }
  }

  function registerServiceWorker() {
    if (!window.navigator || !window.navigator.serviceWorker
        || typeof window.navigator.serviceWorker.register !== "function") return;
    window.navigator.serviceWorker.register("service-worker.js").catch(error => {
      console.debug("Opening trainer offline shell was not registered", error);
    });
  }

  function trackEvent(name, properties) {
    const detail = Object.assign({
      name,
      occurredAt: new Date().toISOString(),
      deckId: state.deck ? state.deck.id : null,
      sessionId: state.session && state.session.id || null,
    }, properties || {});
    try {
      if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new window.CustomEvent("chess-trainer:event", { detail }));
      }
      if (typeof window.ChessTrainerEventSink === "function") window.ChessTrainerEventSink(detail);
    } catch (_error) {
      // Product events are an optional first-party hook and must never interrupt training.
    }
  }

  async function initialize() {
    if (!Domain || typeof Domain.createProgressStore !== "function"
        || typeof Domain.partitionCandidates !== "function"
        || typeof Domain.evaluatePuzzleStep !== "function"
        || typeof Domain.solutionSteps !== "function") {
      showFatal("The trainer didn’t start correctly. Refresh and try again.");
      return false;
    }
    if (!Caro || typeof Caro.normalizeCatalog !== "function"
        || typeof Caro.normalizeManifest !== "function"
        || typeof Caro.adaptRecord !== "function"
        || typeof Caro.filterRecords !== "function") {
      showFatal("The trainer didn’t start correctly. Refresh and try again.");
      return false;
    }
    if (!UI || typeof UI.makeBoard !== "function") {
      showFatal("The board couldn’t start. Refresh and try again.");
      return false;
    }
    if (typeof window.fetch !== "function") {
      showFatal("This browser couldn’t load the deck. Try a current browser or reload the page.");
      return false;
    }

    try {
      initializeLearningStore();
      restorePreferences();
      const rawCatalog = await fetchJson(CATALOG_URL, 0, null);
      state.catalog = Caro.normalizeCatalog(rawCatalog);
      if (state.catalog.schemaVersion !== "1") {
        throw new Error("The opening catalog schema is unsupported.");
      }
      if (!state.catalog.decks.length) throw new Error("The opening catalog contains no valid decks.");
      populateDeckOptions();
      const requested = requestedDeckId();
      const loaded = await switchDeck(requested, true);
      if (loaded) {
        showOnboardingIfNeeded();
        trackEvent("trainer_opened");
      }
      return loaded;
    } catch (error) {
      console.error("Could not initialize opening puzzles", error);
      trackEvent("load_failure", { stage: "catalog" });
      showFatal("Couldn’t load the opening library.", () => initialize());
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
    cacheDownloadedDeckData(url, response);
    return response.json();
  }

  function cacheDownloadedDeckData(url, response) {
    if (!window.caches || typeof window.caches.open !== "function"
        || !response || typeof response.clone !== "function"
        || !/^(?:data\/(?:opening-puzzle-catalog|my-blunder-puzzles)\.json|data\/[^/]+\/(?:manifest\.json|selection-index\.json|chunks\/chunk-\d+\.json))$/.test(String(url))) {
      return;
    }
    try {
      const cacheUrl = window.URL && window.location
        ? new window.URL(url, window.location.href).toString() : url;
      const cachedResponse = response.clone();
      window.caches.open(DATA_CACHE)
        .then(cache => cache.put(cacheUrl, cachedResponse))
        .catch(error => console.debug("Opening deck could not be cached for offline use", error));
    } catch (error) {
      console.debug("Opening deck could not be cached for offline use", error);
    }
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
    if (state.catalog.decks.some(deck => deck.id === requested)) return requested;
    const preferred = preference("lastDeckId", "");
    return state.catalog.decks.some(deck => deck.id === preferred)
      ? preferred : state.catalog.defaultDeckId;
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
    state.selectionIndex = null;
    state.selectionEntriesById = new Map();
    state.datasetBase = "";
    state.candidates = [];
    state.candidateIds = new Set();
    state.invalidCount = 0;
    state.invalidCandidateIds = new Set();
    state.chunkIndex = 0;
    state.loadedChunkIndexes = new Set();
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
    state.session = null;
    state.presentation = null;
    state.endlessCompleted = 0;
    state.reviewModeIds = null;
    state.sessionCompletionTracked = false;
    state.unavailableReviewIds = new Set();
    state.lastMistakeIds = [];
    state.curriculumGroup = "";
    state.teachingPly = null;
    state.solvedTeachingPly = null;
    state.firstMoveTracked = false;
    state.resumedActive = false;
    state.activeSelectionToken = null;
    if (elements.filterVariation) elements.filterVariation.value = "all";
  }

  function normalizedSubject(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  async function personalEnvelopeForDeck(deck, generation, signal) {
    const dataPath = Caro.safeRelativePath(deck && deck.dataPath);
    if (dataPath !== "my-blunder-puzzles.json") {
      throw new Error("The personal puzzle data path is invalid.");
    }
    if (state.personalEnvelope) return state.personalEnvelope;
    if (!state.personalEnvelopePromise
        || state.personalEnvelopePromise.generation !== generation) {
      const request = { generation, promise: null };
      request.promise = fetchJson(`data/${dataPath}`, generation, signal)
        .then(envelope => {
          if (!envelope || Number(envelope.schemaVersion) !== 1
              || !envelope.catalog || !Array.isArray(envelope.catalog.candidates)
              || normalizedSubject(envelope.username) !== normalizedSubject(progressUsername())) {
            throw new Error("The personal puzzle export is invalid.");
          }
          state.personalEnvelope = envelope;
          return envelope;
        })
        .finally(() => {
          if (state.personalEnvelopePromise === request) {
            state.personalEnvelopePromise = null;
          }
        });
      state.personalEnvelopePromise = request;
    }
    return state.personalEnvelopePromise.promise;
  }

  function personalCandidatesForDeck(deck, envelope) {
    const candidates = [];
    const ids = new Set();
    const rawCandidates = envelope && envelope.catalog
      && Array.isArray(envelope.catalog.candidates) ? envelope.catalog.candidates : [];
    rawCandidates.forEach(rawCandidate => {
      const candidate = Caro.adaptPersonalBlunderRecord(rawCandidate, deck);
      const id = puzzleId(candidate);
      if (!candidate || !id || ids.has(id)) return;
      ids.add(id);
      candidates.push(candidate);
    });
    return candidates;
  }

  function personalRawCandidateBelongsToDeck(candidate, deck) {
    if (!candidate || typeof candidate !== "object") return false;
    const category = String(candidate.repertoire_deck_id
      || candidate.repertoireDeckId || "").trim().toLowerCase();
    const color = String(candidate.user_color || "").trim().toLowerCase();
    return (!deck.repertoireDeckId || deck.repertoireDeckId === category)
      && (deck.solverColor === "mixed" || deck.solverColor === color);
  }

  function countCandidateValues(candidates, getter) {
    return candidates.reduce((counts, candidate) => {
      const values = getter(candidate);
      (Array.isArray(values) ? values : [values]).filter(Boolean).forEach(value => {
        const key = String(value);
        counts[key] = (counts[key] || 0) + 1;
      });
      return counts;
    }, {});
  }

  function personalManifest(deck, candidates, envelope) {
    return {
      raw: envelope,
      schemaVersion: "personal-1",
      deckId: deck.id,
      id: deck.id,
      displayName: deck.label,
      name: deck.label,
      openingFamily: deck.openingFamily,
      solverColor: deck.solverColor,
      orientation: deck.orientation,
      openingTagRoots: [],
      generatedAt: String(envelope.generatedAt || ""),
      balancedExported: candidates.length,
      chunks: [],
      selectionIndex: null,
      datasetVersion: "",
      variationCounts: countCandidateValues(candidates, candidate => candidate.variation),
      difficultyCounts: {},
      provenanceCounts: { standard: candidates.length },
      themeCounts: countCandidateValues(candidates, candidate => candidate.themes || []),
    };
  }

  async function loadPersonalBlunderDeck(deck, generation) {
    const envelope = await personalEnvelopeForDeck(
      deck, generation, state.abortController && state.abortController.signal,
    );
    if (generation !== state.loadGeneration) return false;
    const eligibleCount = envelope.catalog.candidates.filter(candidate =>
      personalRawCandidateBelongsToDeck(candidate, deck)
    ).length;
    state.candidates = personalCandidatesForDeck(deck, envelope);
    state.candidateIds = new Set(state.candidates.map(puzzleId));
    state.invalidCount = Math.max(0, eligibleCount - state.candidates.length);
    state.manifest = personalManifest(deck, state.candidates, envelope);
    state.deckManifests.set(deck.id, state.manifest);
    state.store = createDeckProgressStore(deck);
    updateDeckChrome(false);
    populateFilterOptions();
    rebuildPartition(true);
    const started = await startPreferredSession({ preserveTab: true, resume: false });
    if (!started) renderAll();
    return true;
  }

  async function switchDeck(deckId, initial) {
    const deck = deckById(deckId);
    if (!deck) return false;
    finalizeAbandonedPresentation("deck_changed");
    state.loadGeneration += 1;
    const generation = state.loadGeneration;
    if (state.abortController && typeof state.abortController.abort === "function") {
      state.abortController.abort();
    }
    state.abortController = typeof window.AbortController === "function"
      ? new window.AbortController() : null;
    resetDatasetState();
    state.deck = deck;
    activateTab("unsolved", false);
    if (elements.deck) elements.deck.value = deck.id;
    setPreference("lastDeckId", deck.id);
    updateDeckChrome(true);
    renderAll();

    const manifestPath = Caro.safeRelativePath(deck.manifestPath);
    const manifestUrl = manifestPath ? `data/${manifestPath}` : "";
    state.datasetBase = datasetBaseForManifest(manifestPath);
    try {
      if (isPersonalBlunderDeck(deck)) {
        const loaded = await loadPersonalBlunderDeck(deck, generation);
        if (!loaded) return false;
        updateDeckUrl(deck.id, initial);
        trackEvent("deck_selected", { deckId: deck.id, solverColor: deck.solverColor });
        if (!initial) focusPuzzleStart();
        return true;
      }
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
      state.deckManifests.set(deck.id, manifest);
      updateDeckChrome(false);
      state.store = createDeckProgressStore(deck);
      await loadSelectionIndex(generation);
      if (generation !== state.loadGeneration) return false;
      populateFilterOptions();
      const resumable = restorableActiveSelection();
      restoreActiveTrainingSetup(resumable);
      if (!state.selectionIndex) {
        await loadNextChunk(false, generation);
        if (generation !== state.loadGeneration) return false;
      }
      rebuildPartition(true);
      if (!state.selectionIndex && !state.unsolved.length && hasMoreChunks()) {
        await ensureUnsolvedCandidates(1, generation);
      }
      const started = await startPreferredSession({ preserveTab: true, resume: true });
      if (!started && !state.candidates.length && (state.chunkErrors.length || state.invalidCount)) {
        trackEvent("load_failure", { stage: "positions", deckId: deck.id });
        showFatal(`No ${deck.openingFamily} positions could be prepared. Check your connection and retry.`, () => switchDeck(deck.id, false));
        return false;
      }
      updateDeckUrl(deck.id, initial);
      trackEvent("deck_selected", { deckId: deck.id, solverColor: deck.solverColor });
      if (!initial) focusPuzzleStart();
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") return false;
      console.error(`Could not initialize ${deck.id} puzzles`, error);
      if (generation === state.loadGeneration) {
        trackEvent("load_failure", { stage: "deck", deckId: deck.id });
        showFatal(`Couldn’t load the ${deck.openingFamily} deck.`, () => switchDeck(deck.id, false));
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

  function solverColor(candidate) {
    const selected = candidate || currentCandidate();
    const candidateColor = selected && String(
      selected.solverColor || selected.solver_color || selected.user_color || "",
    ).toLowerCase();
    if (candidateColor === "white" || candidateColor === "black") return candidateColor;
    const deckColor = state.manifest && state.manifest.solverColor
      || state.deck && state.deck.solverColor;
    return deckColor === "white" ? "white" : "black";
  }

  function boardOrientation(candidate) {
    const selected = candidate || currentCandidate();
    const candidateOrientation = selected && String(selected.orientation || "").toLowerCase();
    if (candidateOrientation === "white" || candidateOrientation === "black") {
      return candidateOrientation;
    }
    const deckOrientation = state.manifest && state.manifest.orientation
      || state.deck && state.deck.orientation;
    return deckOrientation === "white" ? "white" : solverColor(selected);
  }

  function openingFamily() {
    return state.manifest && state.manifest.openingFamily
      || state.deck && state.deck.openingFamily || "Opening";
  }

  function colorLabel(value) {
    return value === "mixed" ? "Both colors" : value === "white" ? "White" : "Black";
  }

  function opponentColor(candidate) {
    return solverColor(candidate) === "white" ? "black" : "white";
  }

  function updateDeckChrome(loading) {
    if (!state.deck) return;
    const side = colorLabel(state.deck.solverColor);
    if (elements.title) elements.title.textContent = PAGE_TITLE;
    if (elements.intro) {
      elements.intro.textContent = state.deck.solverColor === "mixed"
        ? `Train complete ${state.deck.openingFamily} tactical lines for both colors.`
        : `Train complete ${state.deck.openingFamily} tactical lines as ${side}.`;
    }
    if (elements.boardHelp) {
      elements.boardHelp.textContent = state.deck.solverColor === "mixed"
        ? "Select a piece and destination on the player-oriented board, or use the keyboard move field below the puzzle controls."
        : `Select a piece and destination on the ${side}-oriented board, or use the keyboard move field below the puzzle controls.`;
    }
    if (elements.headerDeck) elements.headerDeck.textContent = `${state.deck.openingFamily} · ${side}`;
    if (loading && elements.summary) elements.summary.textContent = "Preparing your training deck…";
  }

  function resolveChunkPath(path) {
    const value = Caro.safeRelativePath(String(path || "").trim().replace(/^\.\//, ""));
    if (!value || /(?:^|\/)all\.jsonl(?:$|\?)/i.test(value)
        || /(?:^|\/)balanced\.jsonl(?:$|\?)/i.test(value)) {
      return null;
    }
    return state.datasetBase + value;
  }

  async function loadSelectionIndex(requestedGeneration) {
    const generation = requestedGeneration || state.loadGeneration;
    const descriptor = state.manifest && state.manifest.selectionIndex;
    if (!descriptor || typeof Caro.normalizeSelectionIndex !== "function") return false;
    const relative = Caro.safeRelativePath(descriptor.path);
    if (!relative || relative !== "selection-index.json") return false;
    try {
      const payload = await fetchJson(
        state.datasetBase + relative,
        generation,
        state.abortController && state.abortController.signal,
      );
      if (generation !== state.loadGeneration) return false;
      const normalized = Caro.normalizeSelectionIndex(payload, state.manifest);
      if (!normalized || !Array.isArray(normalized.entries)
          || normalized.entries.length !== state.manifest.balancedExported) {
        throw new Error("The selection index does not match the deck manifest.");
      }
      state.selectionIndex = normalized;
      state.selectionEntriesById = new Map(normalized.entries.map(entry => [String(entry.id), entry]));
      return true;
    } catch (error) {
      if (generation !== state.loadGeneration || error && error.name === "AbortError") return false;
      state.selectionIndex = null;
      state.selectionEntriesById = new Map();
      state.transientWarning = "Full-deck traversal is temporarily unavailable; training will continue from downloaded positions.";
      trackEvent("load_failure", { stage: "index", deckId: state.deck && state.deck.id });
      console.error("Could not load the opening-puzzle selection index", error);
      return false;
    }
  }

  function chunkRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    return [payload.puzzles, payload.records, payload.items].find(Array.isArray) || [];
  }

  function hasMoreChunks() {
    if (!state.manifest) return false;
    let index = state.chunkIndex;
    while (index < state.manifest.chunks.length && state.loadedChunkIndexes.has(index)) index += 1;
    return index < state.manifest.chunks.length;
  }

  async function loadChunkAt(rawIndex, renderAfter, requestedGeneration) {
    const generation = requestedGeneration || state.loadGeneration;
    const index = Number(rawIndex);
    if (!state.manifest || !Number.isInteger(index) || index < 0
        || index >= state.manifest.chunks.length) return false;
    if (state.loadedChunkIndexes.has(index)) return true;
    if (state.chunkLoading) {
      await state.chunkLoading;
      if (generation !== state.loadGeneration) return false;
      if (state.loadedChunkIndexes.has(index)) return true;
    }

    const chunk = state.manifest.chunks[index];
    const path = resolveChunkPath(chunk.path);
    const loading = (async () => {
      if (!path) {
        state.chunkErrors.push(`Unsafe or unsupported chunk path: ${chunk.path}`);
        state.transientWarning = "Some positions in this deck are temporarily unavailable.";
        trackEvent("load_failure", { stage: "chunk", deckId: state.deck && state.deck.id });
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
        state.loadedChunkIndexes.add(index);
        populateFilterOptions();
        if (renderAfter) {
          rebuildPartition(false);
          renderAll();
        }
        return true;
      } catch (error) {
        if (generation !== state.loadGeneration || error && error.name === "AbortError") return false;
        state.chunkErrors.push(`${chunk.path}: ${error.message || error}`);
        state.transientWarning = "Some positions couldn’t be loaded. You can keep training or retry the deck.";
        trackEvent("load_failure", { stage: "chunk", deckId: state.deck && state.deck.id });
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

  async function loadNextChunk(renderAfter, requestedGeneration) {
    if (!state.manifest) return false;
    while (state.chunkIndex < state.manifest.chunks.length
        && state.loadedChunkIndexes.has(state.chunkIndex)) state.chunkIndex += 1;
    if (state.chunkIndex >= state.manifest.chunks.length) return false;
    const index = state.chunkIndex;
    state.chunkIndex += 1;
    return loadChunkAt(index, renderAfter, requestedGeneration);
  }

  async function ensureIndexedCandidates(ids, requestedGeneration) {
    if (!state.selectionIndex) return false;
    const generation = requestedGeneration || state.loadGeneration;
    const chunks = [];
    const seen = new Set();
    (ids || []).forEach(id => {
      const entry = state.selectionEntriesById.get(String(id));
      const index = Number(entry && (entry.chunkIndex !== undefined
        ? entry.chunkIndex : entry.chunk));
      if (Number.isInteger(index) && !seen.has(index)) {
        seen.add(index);
        chunks.push(index);
      }
    });
    for (const index of chunks) {
      await loadChunkAt(index, false, generation);
      if (generation !== state.loadGeneration) return false;
    }
    rebuildPartition(false);
    renderAll();
    return (ids || []).every(id => state.candidateIds.has(String(id)));
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
      state.transientWarning = `${missing.size} saved position${missing.size === 1 ? " is" : "s are"} not available in this deck version.`;
    }
    rebuildPartition(false);
    renderAll();
    return true;
  }

  function currentFilters() {
    return {
      mode: elements.filterMode && elements.filterMode.value || "all",
      variation: elements.filterVariation && elements.filterVariation.value || "all",
      difficulty: elements.filterDifficulty && elements.filterDifficulty.value || "all",
      provenance: elements.filterProvenance && elements.filterProvenance.value || "all",
      lineCoverage: elements.filterLines && elements.filterLines.value || "all",
      theme: elements.filterTheme && elements.filterTheme.value || "all",
      openingOnly: Boolean(elements.filterOpening && elements.filterOpening.checked),
      curriculumGroup: state.curriculumGroup || "",
    };
  }

  function filtersSignature(filters) {
    return [filters.mode, filters.variation, filters.difficulty, filters.provenance, filters.lineCoverage,
      filters.theme, filters.openingOnly ? "opening" : "any", filters.curriculumGroup].join("|");
  }

  function selectedCandidates(filters) {
    if (state.reviewModeIds) {
      const requested = new Set(state.reviewModeIds);
      return state.candidates.filter(candidate => requested.has(puzzleId(candidate)));
    }
    let selected = Caro.filterRecords(state.candidates, filters);
    if (filters.curriculumGroup) {
      selected = selected.filter(candidate => filters.curriculumGroup === "Master challenges"
        ? String(candidate.difficulty || "").toLowerCase() === "expert"
        : Caro.curriculumGroup(candidate) === filters.curriculumGroup);
    }
    return selected;
  }

  function rebuildPartition(resetQueue) {
    prepareReviewRecords();
    const filters = currentFilters();
    const signature = filtersSignature(filters);
    const selected = selectedCandidates(filters);
    let partition;
    try {
      partition = Domain.partitionCandidates(selected, state.store) || {};
    } catch (error) {
      console.error("Could not partition opening-puzzle candidates", error);
      showFatal("A position in this deck was incomplete. Retry the deck or choose another one.", () => switchDeck(state.deck.id, false));
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

    let ordered = trainableCandidates(selected, partition);
    if (filters.mode === "curriculum") {
      ordered = Caro.curriculumOrder(ordered);
    } else if (typeof Domain.mixCandidates === "function") {
      ordered = Domain.mixCandidates(ordered, dailyQueueSeed(signature));
    }
    const availableIds = new Set(ordered.map(puzzleId));
    if (!state.session) {
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
    }
    state.filterSignature = signature;
    if (!state.session && !state.completedCandidate
        && (!state.currentId || !availableIds.has(state.currentId))) {
      state.currentId = state.sessionIds[0] || null;
    }
    renderWarnings();
    return true;
  }

  function candidateSnapshot(candidate) {
    return {
      variation: candidate && candidate.variation || openingFamily(),
      curriculumGroup: candidate ? Caro.curriculumGroup(candidate) : "",
      themes: Array.isArray(candidate && candidate.themes) ? candidate.themes.slice(0, 12) : [],
      difficulty: candidate && candidate.difficulty || "",
    };
  }

  function prepareReviewRecords() {
    state.reviewRecords = Object.create(null);
    if (!state.reviewStore || !state.deck || typeof state.reviewStore.getState !== "function") return;
    try {
      const stored = state.reviewStore.getState();
      const deckRecords = stored && stored.reviews && stored.reviews[state.deck.id];
      if (deckRecords && typeof deckRecords === "object") state.reviewRecords = deckRecords;
    } catch (_error) {
      state.reviewRecords = Object.create(null);
    }
  }

  function reviewClass(candidate) {
    if (!candidate || !state.reviewStore) {
      return "New";
    }
    try {
      const id = puzzleId(candidate);
      const record = state.reviewRecords && state.reviewRecords[id];
      const value = Trainer && typeof Trainer.classifyReview === "function"
        ? Trainer.classifyReview(record, new Date().toISOString())
        : state.reviewStore.classify(state.deck.id, id, new Date().toISOString());
      const normalized = String(value && (value.label || value.status || value) || "New").toLowerCase();
      if (normalized.includes("master")) return "Mastered";
      if (normalized.includes("due")) return "Due";
      if (normalized.includes("learn")) return "Learning";
      return "New";
    } catch (_error) {
      return "New";
    }
  }

  function reviewLabel(candidate) {
    return reviewClass(candidate);
  }

  function reviewDueCount() {
    if (!state.reviewStore || !state.deck) return 0;
    try {
      if (typeof state.reviewStore.dueReviews === "function") {
        return state.reviewStore.dueReviews(state.deck.id, new Date().toISOString())
          .filter(review => !state.unavailableReviewIds.has(String(review.id || review.puzzleId || review)))
          .length;
      }
      const counts = state.reviewStore.reviewCounts && state.reviewStore.reviewCounts(state.deck.id);
      return Number(counts && (counts.due || counts.Due) || 0);
    } catch (_error) {
      return 0;
    }
  }

  function storedMistakeIds(limit) {
    if (!state.reviewStore || !state.deck || typeof state.reviewStore.mistakeIds !== "function") {
      return [];
    }
    try {
      return state.reviewStore.mistakeIds(state.deck.id, { limit: Math.max(1, Number(limit) || 20) })
        .map(String).filter(id => !state.unavailableReviewIds.has(id));
    } catch (_error) {
      return [];
    }
  }

  function migrateCandidateReview(candidate) {
    if (!state.reviewStore || !candidate || !state.deck) return;
    const progress = getProgress(candidate);
    const id = puzzleId(candidate);
    const snapshot = candidateSnapshot(candidate);
    try {
      if (progress && (progress.status === "solved" || progress.solvedAt)
          && typeof state.reviewStore.migrateLegacySolved === "function") {
        const migrated = state.reviewStore.migrateLegacySolved(state.deck.id, id, progress, snapshot);
        if (migrated && migrated.record) state.reviewRecords[id] = migrated.record;
      }
    } catch (_error) {
      // Permanent solved progress remains authoritative if adaptive storage fails.
    }
  }

  function trainableCandidates(selected, partition) {
    const solvedIds = new Set(unwrapCandidates(partition && partition.solved).map(puzzleId));
    const requested = state.reviewModeIds && new Set(state.reviewModeIds);
    const candidates = selected.filter(candidate => {
      migrateCandidateReview(candidate);
      const id = puzzleId(candidate);
      if (requested) return requested.has(id);
      if (!state.reviewStore) return !solvedIds.has(id);
      const review = reviewClass(candidate);
      // A recorded Learning/Mastered item stays spaced until its dueAt time.
      // New unsolved positions and genuinely Due reviews make up the queue.
      return review === "Due" || review === "New" && !solvedIds.has(id);
    });
    const priority = { Due: 0, Learning: 1, New: 2, Mastered: 3 };
    return candidates.slice().sort((left, right) => {
      const difference = priority[reviewClass(left)] - priority[reviewClass(right)];
      return difference || String(puzzleId(left)).localeCompare(String(puzzleId(right)));
    });
  }

  function orderedTrainingCandidates() {
    const filters = currentFilters();
    const selected = selectedCandidates(filters);
    const partition = Domain.partitionCandidates(selected, state.store) || {};
    let ordered = trainableCandidates(selected, partition);
    if (state.reviewModeIds) {
      const requestedOrder = new Map(state.reviewModeIds.map((id, index) => [id, index]));
      ordered.sort((left, right) => (requestedOrder.get(puzzleId(left)) || 0)
        - (requestedOrder.get(puzzleId(right)) || 0));
    } else if (filters.mode === "curriculum") ordered = Caro.curriculumOrder(ordered);
    else if (typeof Domain.mixCandidates === "function") {
      ordered = Domain.mixCandidates(ordered, dailyQueueSeed(filtersSignature(filters)));
      const priority = { Due: 0, Learning: 1, New: 2, Mastered: 3 };
      ordered.sort((left, right) => priority[reviewClass(left)] - priority[reviewClass(right)]);
    }
    return ordered;
  }

  async function ensureTrainingCandidates(target) {
    const wanted = Math.max(1, Number(target) || 1);
    while (orderedTrainingCandidates().length < wanted && hasMoreChunks()) {
      await loadNextChunk(false, state.loadGeneration);
      rebuildPartition(false);
    }
  }

  async function ensureReviewCandidates(ids) {
    const missing = new Set((ids || []).map(String));
    state.candidateIds.forEach(id => missing.delete(id));
    while (missing.size && hasMoreChunks()) {
      await loadNextChunk(false, state.loadGeneration);
      state.candidateIds.forEach(id => missing.delete(id));
    }
    rebuildPartition(false);
    return [...missing];
  }

  function preferredSessionSettings(options) {
    const preferenceSettings = state.sessionMode === "finite"
      ? { mode: "finite", size: state.sessionSize }
      : { mode: "endless" };
    return Object.assign({}, options || {}, preferenceSettings);
  }

  function startPreferredSession(options) {
    return startSession(preferredSessionSettings(options));
  }

  function clearActiveSelection() {
    if (state.reviewStore && typeof state.reviewStore.clearActiveSelection === "function") {
      try {
        const at = new Date().toISOString();
        if (state.activeSelectionToken) {
          state.reviewStore.clearActiveSelection(state.activeSelectionToken, at);
        } else {
          state.reviewStore.clearActiveSelection(at);
        }
      } catch (error) {
        console.error("Could not clear active training membership", error);
      }
    }
    state.activeSelectionToken = null;
    state.resumedActive = false;
  }

  async function startFreshSession() {
    clearActiveSelection();
    return startPreferredSession({ fresh: true });
  }

  function isEndlessSession(session) {
    const active = session || state.session;
    return Boolean(active && active.endless === true);
  }

  function isEndlessTraining() {
    return state.session
      ? isEndlessSession(state.session)
      : !state.reviewModeIds && state.sessionMode === "endless";
  }

  function displayPuzzleNumber() {
    const current = sessionPuzzleNumber();
    return isEndlessSession() ? state.endlessCompleted + current : current;
  }

  function indexedSelectionExclusions(at) {
    if (!state.selectionIndex) return [];
    prepareReviewRecords();
    const solved = storedSolvedIds();
    return state.selectionIndex.entries.map(entry => String(entry.id)).filter(id => {
      const record = state.reviewRecords[id];
      const classification = Trainer && typeof Trainer.classifyReview === "function"
        ? Trainer.classifyReview(record, at) : record ? reviewClass({ id }) : "New";
      return classification === "Learning" || classification === "Mastered"
        || classification === "New" && solved.has(id);
    });
  }

  function indexedDueIds(at) {
    if (!state.selectionIndex || !state.reviewStore
        || typeof state.reviewStore.dueReviews !== "function") return [];
    try {
      return state.reviewStore.dueReviews(state.deck.id, at)
        .map(review => String(review.id || review.puzzleId || review))
        .filter(id => state.selectionEntriesById.has(id));
    } catch (_error) {
      return [];
    }
  }

  async function reserveIndexedSession(desired, requestedMode, settings) {
    if (!state.selectionIndex || !state.reviewStore
        || typeof state.reviewStore.reserveSelectionSession !== "function") return null;
    const at = new Date().toISOString();
    const reserved = state.reviewStore.reserveSelectionSession({
      index: state.selectionIndex,
      filters: currentFilters(),
      request: {
        size: desired,
        trainingLength: requestedMode,
        resume: settings.resume === true,
        fresh: settings.fresh === true || !settings.resume && !settings.rollover,
        excludedIds: indexedSelectionExclusions(at),
        priorityIds: indexedDueIds(at),
      },
      now: at,
    });
    if (!reserved || !Array.isArray(reserved.ids) || !reserved.ids.length) return reserved || null;
    if (state.selectionIndex && reserved.active) {
      state.activeSelectionToken = reserved.active.token || null;
      state.resumedActive = reserved.resumed === true;
    }
    const generation = state.loadGeneration;
    const loadComplete = await ensureIndexedCandidates(reserved.ids, generation);
    return Object.assign({}, reserved, {
      loadComplete,
      aborted: generation !== state.loadGeneration,
    });
  }

  function restoreReservedSession(active) {
    if (!active || !state.session) return;
    const results = Array.isArray(active.results) ? active.results.slice() : [];
    state.session.id = active.token || state.session.id;
    state.session.startedAt = active.createdAt || active.startedAt || state.session.startedAt;
    if (Array.isArray(state.session.items)) {
      const resultById = new Map(results.map(result => [String(result.puzzleId), result]));
      state.session.items.forEach(item => {
        if (item && resultById.has(String(item.puzzleId))) {
          item.result = resultById.get(String(item.puzzleId));
        }
      });
      state.session.results = state.session.items.map(item => item && item.result).filter(Boolean);
      state.session.cursor = state.session.results.length;
    } else {
      state.session.results = results;
    }
  }

  async function startSession(options) {
    if (!state.manifest || !state.store) return false;
    const settings = options || {};
    const reviewSession = Array.isArray(settings.reviewIds);
    const hasExplicitSize = Object.prototype.hasOwnProperty.call(settings, "size");
    const explicitMode = settings.mode === "finite" || settings.mode === "endless"
      ? settings.mode : null;
    const requestedMode = reviewSession
      ? "finite" : explicitMode || (hasExplicitSize ? "finite" : state.sessionMode);
    const rawRequestedSize = Number(settings.size);
    const requestedSize = SESSION_SIZES.includes(rawRequestedSize)
      ? rawRequestedSize : state.sessionSize;
    if (!reviewSession && !settings.rollover) {
      finalizeAbandonedPresentation("session_restarted");
      state.sessionMode = requestedMode;
      setPreference("sessionMode", state.sessionMode);
      if (requestedMode === "finite") state.sessionSize = requestedSize;
      setPreference("sessionSize", state.sessionSize);
      state.endlessCompleted = 0;
      if (elements.trainingLength) {
        elements.trainingLength.value = state.sessionMode === "endless"
          ? "endless" : String(state.sessionSize);
      }
    }
    if (reviewSession) {
      const previousReviewModeIds = state.reviewModeIds;
      state.reviewModeIds = [...new Set(settings.reviewIds.map(String).filter(Boolean))];
      const missing = await ensureReviewCandidates(state.reviewModeIds);
      missing.forEach(id => state.unavailableReviewIds.add(id));
      state.reviewModeIds = state.reviewModeIds.filter(id => !state.unavailableReviewIds.has(id));
      if (missing.length) {
        state.transientWarning = `${missing.length} saved review${missing.length === 1 ? " is" : "s are"} no longer available in this deck version.`;
      }
      if (!state.reviewModeIds.length) {
        state.reviewModeIds = previousReviewModeIds;
        rebuildPartition(false);
        renderAll();
        return false;
      }
    } else if (!settings.keepReviewMode) {
      state.reviewModeIds = null;
    }
    if (reviewSession && !settings.rollover) {
      finalizeAbandonedPresentation("session_restarted");
    }
    state.session = null;
    state.sessionCompletionTracked = false;
    // Finite goals wait for enough positions to honor the selected size.
    // Endless starts immediately with what is already downloaded; when that
    // rolling batch is exhausted, the next batch fetches only as needed.
    const reviewLimit = Number.isInteger(rawRequestedSize) && rawRequestedSize > 0
      ? Math.min(20, rawRequestedSize) : Math.min(20, state.sessionSize);
    const desired = state.reviewModeIds
      ? Math.min(reviewLimit, state.reviewModeIds.length)
      : requestedMode === "endless" ? ENDLESS_BATCH_SIZE : state.sessionSize;
    let reserved = null;
    let ordered;
    if (!reviewSession && state.selectionIndex) {
      reserved = await reserveIndexedSession(desired, requestedMode, settings);
      if (reserved && reserved.aborted) return false;
      if (reserved && reserved.loadComplete === false) {
        state.sessionIds = reserved.ids.slice();
        state.currentId = null;
        showFatal(
          "Some selected positions couldn’t be downloaded. Check your connection and retry.",
          () => startPreferredSession({ preserveTab: true, resume: true }),
        );
        return false;
      }
      ordered = reserved && Array.isArray(reserved.ids)
        ? reserved.ids.map(id => state.candidates.find(candidate => puzzleId(candidate) === String(id)))
          .filter(Boolean)
        : [];
    } else {
      ordered = orderedTrainingCandidates();
      const minimumReady = requestedMode === "endless" && !state.reviewModeIds
        ? 1 : desired;
      if (ordered.length < minimumReady && hasMoreChunks()) {
        await ensureTrainingCandidates(minimumReady);
        ordered = orderedTrainingCandidates();
      }
    }
    const target = Math.min(desired, ordered.length);
    const puzzleIds = ordered.slice(0, target).map(puzzleId);
    if (!puzzleIds.length) {
      state.sessionIds = [];
      state.currentId = null;
      renderAll();
      return false;
    }
    try {
      if (SESSION_SIZES.includes(target) && state.reviewStore
          && typeof state.reviewStore.createSession === "function") {
        state.session = state.reviewStore.createSession({
          deckId: state.deck.id,
          size: target,
          puzzleIds,
          mode: state.reviewModeIds ? "review" : currentFilters().mode,
          filters: currentFilters(),
        });
      }
    } catch (error) {
      console.error("Could not persist the training session", error);
    }
    if (!state.session) {
      state.session = {
        id: `${state.deck.id}:${Date.now()}`,
        deckId: state.deck.id,
        size: target,
        puzzleIds,
        results: [],
        startedAt: new Date().toISOString(),
        finished: false,
      };
    }
    if (reserved && reserved.active) restoreReservedSession(reserved.active);
    state.session.size = target;
    state.session.endless = !reviewSession && requestedMode === "endless";
    state.session.trainingLength = reviewSession
      ? "review" : state.session.endless ? "endless" : "finite";
    state.session.puzzleIds = Array.isArray(state.session.puzzleIds)
      ? state.session.puzzleIds : puzzleIds;
    state.session.results = Array.isArray(state.session.results) ? state.session.results : [];
    state.sessionIds = puzzleIds;
    state.currentId = puzzleIds[sessionCompletedCount(state.session)] || null;
    state.completedCandidate = null;
    state.completedPostFen = null;
    state.completedMoveUci = null;
    state.teachingPly = null;
    resetPresentation(state.currentId);
    state.feedbackMode = "idle";
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    if (!settings.preserveTab) activateTab("unsolved", false);
    renderAll();
    if (!settings.rollover && !(reserved && reserved.resumed)) {
      trackEvent("session_started", {
        size: state.session.endless ? null : target,
        trainingLength: state.session.trainingLength,
        mode: state.reviewModeIds ? "review" : currentFilters().mode,
      });
    }
    return true;
  }

  function resetPresentation(id) {
    state.presentation = {
      puzzleId: id || null,
      incorrectCount: 0,
      hintUsed: false,
      revealed: false,
      skipped: false,
      finalized: false,
    };
    state.revealed = false;
    state.firstMoveTracked = false;
  }

  function sessionResults(session) {
    if (!session) return [];
    if (Array.isArray(session.items)) return session.items.map(item => item && item.result).filter(Boolean);
    return Array.isArray(session.results) ? session.results : [];
  }

  function sessionPuzzleIds(session) {
    if (!session) return [];
    if (Array.isArray(session.items)) return session.items.map(item => item && item.puzzleId).filter(Boolean);
    return Array.isArray(session.puzzleIds) ? session.puzzleIds : [];
  }

  function sessionCompletedCount(session) {
    return sessionResults(session).length;
  }

  function finalizePresentation(candidate, kind) {
    if (!state.session || !state.presentation || state.presentation.finalized) return false;
    const skipped = kind === "skipped";
    const solved = kind === "solved";
    const incorrectCount = Math.max(0, Number(state.presentation.incorrectCount) || 0);
    const firstTry = solved && incorrectCount === 0;
    const unassisted = solved && firstTry && !state.presentation.hintUsed
      && !state.presentation.revealed && !skipped;
    let result = {
      puzzleId: puzzleId(candidate),
      kind,
      solved,
      skipped,
      correct: solved,
      firstTry,
      unassisted,
      incorrectCount,
      hintUsed: Boolean(state.presentation.hintUsed),
      hintsUsed: state.presentation.hintUsed ? 1 : 0,
      revealed: Boolean(state.presentation.revealed),
      variation: candidate.variation || openingFamily(),
      curriculumGroup: Caro.curriculumGroup(candidate),
      themes: Array.isArray(candidate.themes) ? candidate.themes.slice() : [],
      completedAt: new Date().toISOString(),
    };
    state.presentation.finalized = true;
    let recordedBySessionStore = false;
    try {
      if (state.reviewStore && Array.isArray(state.session.items)
          && typeof state.reviewStore.finalizeCurrentSessionResult === "function") {
        const finalized = state.reviewStore.finalizeCurrentSessionResult(
          state.session,
          result,
          Object.assign({}, candidate, candidateSnapshot(candidate)),
          result.completedAt,
        );
        if (finalized && finalized.accepted) {
          state.session = finalized.session;
          result = Object.assign({}, result, finalized.result || {});
          recordedBySessionStore = true;
          if (typeof state.reviewStore.getReview === "function") {
            const review = state.reviewStore.getReview(state.deck.id, result.puzzleId);
            if (review) state.reviewRecords[result.puzzleId] = review;
          }
        }
      }
      if (!recordedBySessionStore && state.reviewStore
          && typeof state.reviewStore.recordOutcome === "function") {
        const review = state.reviewStore.recordOutcome(
          state.deck.id,
          result.puzzleId,
          result,
          candidateSnapshot(candidate),
          result.completedAt,
        );
        if (review) state.reviewRecords[result.puzzleId] = review;
      }
    } catch (error) {
      state.transientWarning = "This review result couldn’t be saved, but your permanent solved archive is intact.";
      console.error("Could not save adaptive review result", error);
    }
    if (!recordedBySessionStore) {
      if (!Array.isArray(state.session.results)) state.session.results = [];
      state.session.results.push(result);
    }
    if (!state.reviewModeIds && state.activeSelectionToken && state.reviewStore
        && typeof state.reviewStore.recordActiveSelectionResult === "function") {
      try {
        const recorded = state.reviewStore.recordActiveSelectionResult(
          state.activeSelectionToken,
          result,
          result.completedAt,
        );
        if (recorded && recorded.accepted === false) {
          state.transientWarning = "This run changed in another tab, so its resume position wasn’t overwritten.";
        }
      } catch (error) {
        state.transientWarning = "Your place in this training run couldn’t be saved, but puzzle progress is intact.";
        console.error("Could not save active training membership", error);
      }
    }
    if (!firstTry || !unassisted || skipped) {
      state.lastMistakeIds = [...new Set(state.lastMistakeIds.concat(result.puzzleId))];
    }
    renderWarnings();
    trackEvent("puzzle_completed", {
      outcome: kind,
      firstTry,
      unassisted,
      hintUsed: result.hintUsed,
      revealed: result.revealed,
    });
    if (!isEndlessSession() && !state.sessionCompletionTracked && state.session
        && sessionCompletedCount(state.session) >= state.session.size) {
      state.sessionCompletionTracked = true;
      trackEvent("session_completed", sessionEventSummary(state.session));
    }
    return true;
  }

  function finalizeAbandonedPresentation(reason) {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate || !state.presentation
        || state.presentation.finalized) return false;
    const engaged = state.firstMoveTracked || state.presentation.hintUsed
      || Number(state.presentation.incorrectCount) > 0;
    if (!engaged) return false;
    const puzzleNumber = displayPuzzleNumber();
    state.presentation.skipped = true;
    trackEvent("puzzle_skipped", { puzzleNumber, reason: reason || "study_changed" });
    return finalizePresentation(candidate, "skipped");
  }

  function sessionSummary(session) {
    if (!session) return null;
    if (Trainer && typeof Trainer.summarizeSession === "function") {
      try {
        const summary = Trainer.summarizeSession(session);
        if (summary) return summary;
      } catch (_error) {
        // Fall through to the browser controller's compatible summary.
      }
    }
    const results = sessionResults(session);
    const countBy = values => {
      const counts = new Map();
      values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
      return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    };
    const mistakes = results.filter(result => !result.firstTry || !result.unassisted || result.skipped);
    const firstTry = results.filter(result => result.firstTry).length;
    return {
      completed: results.length,
      total: session.size,
      firstTryCorrect: firstTry,
      firstTryAccuracy: results.length ? Math.round(firstTry / results.length * 100) : 0,
      unassisted: results.filter(result => result.unassisted).length,
      hints: results.filter(result => result.hintUsed).length,
      reveals: results.filter(result => result.revealed).length,
      skips: results.filter(result => result.skipped).length,
      weakVariations: countBy(mistakes.map(result => result.variation)).slice(0, 3),
      weakThemes: countBy(mistakes.flatMap(result => result.themes || [])).slice(0, 3),
      mistakeIds: [...new Set(mistakes.map(result => result.puzzleId))],
      complete: results.length >= session.size,
    };
  }

  function sessionEventSummary(session) {
    const summary = sessionSummary(session) || {};
    return {
      size: summary.total || session.size,
      completed: summary.completed || 0,
      firstTryAccuracy: summary.firstTryAccuracy || 0,
      unassisted: summary.unassisted || 0,
      hints: summary.hints || 0,
      reveals: summary.reveals || 0,
    };
  }

  function summaryPairs(values) {
    return (values || []).map(value => Array.isArray(value)
      ? { label: value[0], count: value[1] }
      : { label: value.label || value.name || "", count: value.count || value.misses || 0 });
  }

  function renderSessionComplete() {
    if (!elements.sessionComplete || !state.session) return;
    const summary = sessionSummary(state.session);
    elements.sessionComplete.hidden = false;
    const results = [
      [summary.completed, "Puzzles completed"],
      [`${summary.firstTryAccuracy}%`, "First-try accuracy"],
      [summary.unassisted, "Unassisted solves"],
      [summary.hints, "Hints used"],
      [summary.reveals, "Solutions revealed"],
    ];
    elements.sessionResults.innerHTML = results.map(([value, label]) =>
      `<div class="session-result"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
    ).join("");
    const variations = summaryPairs(summary.weakVariations);
    const themes = summaryPairs(summary.weakThemes);
    elements.sessionWeakSpots.innerHTML = variations.length || themes.length
      ? `<p><strong>Worth another look</strong></p>`
        + `${variations.length ? `<p>Variations: ${variations.map(item => `${escapeHtml(item.label)} (${item.count})`).join(", ")}</p>` : ""}`
        + `${themes.length ? `<p>Themes: ${themes.map(item => `${escapeHtml(formatTheme(item.label))} (${item.count})`).join(", ")}</p>` : ""}`
      : "<p>No weak pattern stood out in this session. Keep the spacing and come back fresh.</p>";
    state.lastMistakeIds = summary.mistakeIds || [];
    if (elements.sessionReviewMistakes) elements.sessionReviewMistakes.hidden = !state.lastMistakeIds.length;
  }

  async function startMistakeReview() {
    let ids = state.lastMistakeIds.slice();
    if (!ids.length) ids = storedMistakeIds(20);
    if (!ids.length) return false;
    trackEvent("review_mistakes_selected", { count: ids.length });
    return startSession({ size: Math.min(20, ids.length), reviewIds: ids });
  }

  async function startDueReview() {
    if (!state.reviewStore || typeof state.reviewStore.dueReviews !== "function") return false;
    let reviews = [];
    try {
      reviews = state.reviewStore.dueReviews(state.deck.id, new Date().toISOString());
    } catch (_error) {
      return false;
    }
    const ids = reviews.map(review => String(review.id || review.puzzleId || review)).filter(Boolean);
    if (!ids.length) return false;
    return startSession({ size: Math.min(20, ids.length), reviewIds: ids });
  }

  function sessionPuzzleNumber() {
    const completed = sessionCompletedCount(state.session);
    const target = state.session ? state.session.size : state.sessionSize;
    return state.completedCandidate
      ? Math.max(1, Math.min(completed, target))
      : Math.min(completed + 1, target);
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
    return state.candidates.find(candidate => puzzleId(candidate) === state.currentId) || null;
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
      const available = isPersonalBlunderDeck(state.deck) ? state.candidateIds : null;
      return Object.entries(state.store.all()).filter(([id, progress]) =>
        (!available || available.has(id))
        && progress && (progress.status === "solved" || progress.solvedAt)
      ).length;
    } catch (_error) {
      return state.solved.length;
    }
  }

  function renderAll() {
    renderCounts();
    renderFilterStatus();
    renderFilterChips();
    renderCurriculum();
    renderUnsolved();
    renderSolvedArchive();
  }

  function renderCounts() {
    const solvedCount = solvedProgressCount();
    const datasetTotal = state.manifest
      ? state.manifest.balancedExported || state.candidates.length
      : state.candidates.length;
    if (elements.summary) {
      elements.summary.textContent = `${solvedCount.toLocaleString()} solved · ${datasetTotal.toLocaleString()} available`;
    }
    elements.unsolvedCount.textContent = `(${state.unsolved.length})`;
    elements.solvedCount.textContent = `(${state.solved.length})`;
    elements.unsolvedTab.setAttribute("aria-label", `Training view, ${state.unsolved.length} ready positions`);
    elements.solvedTab.setAttribute("aria-label", `Solved archive, ${state.solved.length} available here`);
    const completed = sessionCompletedCount(state.session);
    const target = state.session ? state.session.size : state.sessionSize;
    if (elements.headerProgress) {
      if (isEndlessTraining()) {
        const trained = state.endlessCompleted + completed;
        elements.headerProgress.textContent = `${trained.toLocaleString()} trained`;
      } else {
        const position = state.completedCandidate || state.session && state.session.showSummary
          ? completed : completed + 1;
        elements.headerProgress.textContent = `${Math.min(position, target)} / ${target}`;
      }
    }
    if (elements.sessionRestart) {
      elements.sessionRestart.hidden = isEndlessTraining()
        || Boolean(state.reviewModeIds) || state.resumedActive;
    }
    if (elements.sessionStartFresh) {
      elements.sessionStartFresh.hidden = !state.resumedActive || Boolean(state.reviewModeIds);
    }
    if (elements.reviewsDue) {
      const due = reviewDueCount();
      elements.reviewsDue.textContent = `Reviews due: ${due}`;
      elements.reviewsDue.disabled = due === 0;
    }
    if (elements.reviewMistakes) {
      elements.reviewMistakes.hidden = !state.lastMistakeIds.length && !storedMistakeIds(1).length;
    }
  }

  function renderFilterStatus() {
    if (!state.manifest) return;
    const group = currentFilters().mode === "curriculum" && currentCandidate()
      ? ` · ${Caro.curriculumGroup(currentCandidate())}`
      : "";
    if (elements.filterStatus) {
      elements.filterStatus.textContent = `${state.filtered.length.toLocaleString()} matching position${state.filtered.length === 1 ? "" : "s"} ready now`
        + ` · ${state.manifest.balancedExported.toLocaleString()} in the complete deck${group}`;
    }
  }

  function renderUnsolved() {
    if (state.session && !isEndlessSession() && state.session.showSummary) {
      elements.workspace.hidden = true;
      elements.pageState.hidden = true;
      renderSessionComplete();
      return;
    }
    if (elements.sessionComplete) elements.sessionComplete.hidden = true;
    const candidate = currentCandidate();
    if (!candidate) {
      elements.workspace.hidden = true;
      elements.pageState.hidden = false;
      if (!state.manifest) {
        elements.pageState.innerHTML = `<h2>Preparing your next puzzle…</h2><p>Loading ${escapeHtml(openingFamily())} positions.</p>`;
      } else if (hasMoreChunks()) {
        elements.pageState.innerHTML = "<h2>Looking for a matching position…</h2><p>Checking more of this deck for your selected focus.</p>";
      } else if (state.filtered.length && state.solved.length === state.filtered.length) {
        elements.pageState.innerHTML = "<h2>You’ve completed this study set.</h2><p>Choose another focus or revisit your solved archive.</p>";
      } else {
        elements.pageState.innerHTML = "<h2>No puzzles match these filters</h2><p>Clear a filter or choose another study mode.</p><div class=\"state-actions\"><button type=\"button\" data-clear-filters>Clear filters</button></div>";
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
    state.revealed = completed || Boolean(state.presentation && state.presentation.revealed);
    if (completed && state.feedbackMode !== "revealed") state.feedbackMode = "solved";
    else if (state.revealed && state.feedbackMode === "idle") state.feedbackMode = "revealed";

    const side = colorLabel(solverColor(candidate));
    const decisionLabel = line.steps.length > 1 ? ` · ${line.index + 1} of ${line.steps.length}` : "";
    elements.prompt.textContent = completed
      ? state.feedbackMode === "revealed" ? "Solution revealed" : "Line complete"
      : line.index > 0 ? "Find the continuation" : "Find the best sequence";
    elements.sideToMove.textContent = completed
      ? state.feedbackMode === "revealed" ? "Review the stored continuation" : "Stored continuation complete"
      : `${side} to move${decisionLabel}`;
    const sessionPosition = displayPuzzleNumber();
    elements.queuePosition.textContent = isEndlessSession()
      ? `Puzzle ${sessionPosition}`
      : `Puzzle ${sessionPosition} of ${state.session ? state.session.size : state.sessionSize}`;
    if (elements.progressTrack) elements.progressTrack.hidden = isEndlessTraining();
    if (elements.progressFill) {
      const completedCount = sessionCompletedCount(state.session);
      elements.progressFill.style.width = isEndlessSession()
        ? "0%"
        : `${Math.min(100, completedCount / Math.max(1, state.session ? state.session.size : state.sessionSize) * 100)}%`;
    }
    if (elements.reviewState) elements.reviewState.textContent = reviewLabel(candidate);
    elements.board.setAttribute("aria-label", completed
      ? `Solved ${openingFamily()} puzzle, board oriented for ${side}`
      : `Interactive ${openingFamily()} puzzle, ${side} to move, board oriented for ${side}${decisionLabel}`
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

  function contextMarkup(candidate, progress, reveal, requestedTeachingPly) {
    if (!reveal) {
      return `<p class="puzzle-locked-details">The continuation, opening details, and tactical idea appear after you complete or reveal the line.</p>`;
    }
    const themes = Array.isArray(candidate.themes) && candidate.themes.length
      ? candidate.themes.map(formatTheme).join(", ")
      : "—";
    const setup = candidate.setupMoveSan || candidate.setup_move_san
      || candidate.setupMoveUci || candidate.setup_move_uci || "—";
    const attempts = Number(progress.attempts || 0);
    const source = safeHttpUrl(candidate.sourceUrl || candidate.source_url || candidate.gameUrl || candidate.game_url);
    const timeline = teachingTimeline(candidate);
    const solution = timeline.slice(1).map(entry => entry.san || entry.uci).filter(Boolean).join(" ")
      || solutionLabel(candidate);
    let teachingPly = requestedTeachingPly === undefined
      ? state.teachingPly : requestedTeachingPly;
    if (teachingPly == null || teachingPly < 0 || teachingPly >= timeline.length) {
      teachingPly = Math.max(0, timeline.length - 1);
    }
    if (requestedTeachingPly === undefined) state.teachingPly = teachingPly;
    const current = timeline[teachingPly] || timeline[0];
    const idea = candidate.primaryTacticalTheme || candidate.primary_tactical_theme
      || (Array.isArray(candidate.themes) && candidate.themes[0]) || "tactical continuation";
    const analysis = lichessAnalysisUrl(current && current.fen || candidate.puzzleFen);
    const lineMarkup = timeline.slice(1).map((entry, index) =>
      `<button type="button" class="teaching-move${teachingPly === index + 1 ? " current" : ""}" data-teaching-ply="${index + 1}" aria-label="Show position after ${escapeHtml(entry.san || entry.uci)}">${escapeHtml(entry.san || entry.uci)}</button>`
    ).join("");
    return `<div class="puzzle-teaching-summary">
      <p class="trainer-eyebrow">Tactical idea</p>
      <p>${escapeHtml(titleCase(idea))}</p>
    </div>
    <div class="puzzle-solution-details">
      <h3>${progress.status === "solved" || progress.solvedAt ? "Full continuation" : "Revealed continuation"}</h3>
      <span class="visually-hidden">${escapeHtml(solution)}</span>
      <div class="teaching-line">${lineMarkup}</div>
      <div class="teaching-controls" role="group" aria-label="Move through the continuation">
        <button type="button" data-teaching-previous aria-label="Previous move" ${teachingPly <= 0 ? "disabled" : ""}>←</button>
        <button type="button" data-teaching-next aria-label="Next move" ${teachingPly >= timeline.length - 1 ? "disabled" : ""}>→</button>
        <span>${escapeHtml(current && current.label || "Starting position")}</span>
      </div>
    </div>
    <dl class="puzzle-context-grid">
      ${detailRow("How it arose", setup)}
      ${detailRow("Puzzle rating", candidate.rating == null ? "—" : candidate.rating)}
      ${detailRow("Application level", titleCase(candidate.difficulty || "—"))}
      ${detailRow("Variation", candidate.variation || openingFamily())}
      ${detailRow("Themes", themes)}
      ${detailRow("Provenance", provenanceLabel(candidate.provenance))}
      ${detailRow("Opening phase", candidate.isOpeningPuzzle ? "Yes" : "Later position")}
      ${attempts ? detailRow("Attempts", attempts) : ""}
    </dl>
    <div class="puzzle-detail-actions">
      ${source ? `<a href="${escapeHtml(source)}" target="_blank" rel="noopener">View source game ↗</a>` : ""}
      ${analysis ? `<a href="${escapeHtml(analysis)}" target="_blank" rel="noopener">Analyze position ↗</a>` : ""}
    </div>`;
  }

  function teachingTimeline(candidate) {
    const entries = [{
      fen: candidate.puzzleFen || candidate.fen_before,
      uci: candidate.setupMoveUci || candidate.setup_move_uci || "",
      san: candidate.setupMoveSan || candidate.setup_move_san || "",
      label: candidate.setupMoveSan || candidate.setup_move_san
        ? `Position after ${candidate.setupMoveSan || candidate.setup_move_san}`
        : "Puzzle position",
      setup: true,
    }];
    candidateSteps(candidate).forEach(step => {
      entries.push({
        fen: step.post_best_fen,
        uci: step.best_move_uci,
        san: step.best_move_san || step.best_move_uci,
        label: `After ${step.best_move_san || step.best_move_uci}`,
      });
      if (step.opponent_reply_uci && step.post_reply_fen) {
        entries.push({
          fen: step.post_reply_fen,
          uci: step.opponent_reply_uci,
          san: step.opponent_reply_san || step.opponent_reply_uci,
          label: `After ${step.opponent_reply_san || step.opponent_reply_uci}`,
        });
      }
    });
    const timeline = entries.filter(entry => entry.fen);
    const showingCompletedCandidate = state.completedCandidate
      && puzzleId(state.completedCandidate) === puzzleId(candidate)
      && state.completedPostFen && state.completedMoveUci && timeline.length;
    if (showingCompletedCandidate) {
      const lastIndex = timeline.length - 1;
      const storedMove = normalizeUci(timeline[lastIndex].uci);
      const completedMove = normalizeUci(state.completedMoveUci);
      if (completedMove && completedMove !== storedMove) {
        timeline[lastIndex] = {
          fen: state.completedPostFen,
          uci: completedMove,
          san: completedMove,
          label: `Accepted alternative ${completedMove}`,
          acceptedAlternative: true,
        };
      } else {
        timeline[lastIndex] = Object.assign({}, timeline[lastIndex], {
          fen: state.completedPostFen,
          uci: completedMove || timeline[lastIndex].uci,
        });
      }
    }
    return timeline;
  }

  function lichessAnalysisUrl(fen) {
    const value = String(fen || "").trim();
    return value ? `https://lichess.org/analysis/${encodeURI(value.replace(/ /g, "_"))}` : "";
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
    elements.feedback.removeAttribute && elements.feedback.removeAttribute("data-state");
    if (state.feedbackMode === "solved") {
      elements.feedback.setAttribute("data-state", "success");
      elements.feedback.innerHTML = `<span class="ok">✓ Line complete</span> — review the tactical idea below.`;
    } else if (state.feedbackMode === "revealed") {
      elements.feedback.setAttribute("data-state", "revealed");
      elements.feedback.innerHTML = state.completedCandidate
        ? `<span class="puzzle-revealed-status">Solution revealed</span> — review the tactical idea below.`
        : `<span class="puzzle-revealed-status">Solution shown</span> — play ${escapeHtml(best)} to ${line && line.isFinalStep ? "finish" : "continue"}.`;
    } else if (state.feedbackMode === "continuation") {
      elements.feedback.setAttribute("data-state", "success");
      elements.feedback.innerHTML = `<span class="ok">✓ Correct</span> — ${colorLabel(opponentColor(candidate))} replied ${escapeHtml(state.lastReplySan || "with the stored move")}.`;
    } else if (state.feedbackMode === "incorrect") {
      elements.feedback.setAttribute("data-state", "incorrect");
      elements.feedback.innerHTML = `<span class="bad">× Try again</span> — that move is legal, but misses the stored tactic.`;
    } else if (state.linePhase === "playing_reply") {
      elements.feedback.setAttribute("data-state", "success");
      elements.feedback.innerHTML = `<span class="ok">✓ Correct</span> — ${colorLabel(opponentColor(candidate))} replied ${escapeHtml(state.lastReplySan || "with the stored move")}…`;
    } else {
      elements.feedback.textContent = line && (line.steps.length > 1 || step.opponent_reply_uci)
        ? "Find the best move, then complete the continuation."
        : "Find the best move.";
    }
  }

  function setControlState(completed) {
    const locked = completed || state.linePhase !== "awaiting_user";
    elements.continueButton.hidden = !completed;
    if (completed) {
      elements.continueButton.textContent = !isEndlessSession() && state.session
        && sessionCompletedCount(state.session) >= state.session.size
        ? "View session results" : "Next puzzle";
    }
    elements.skipButton.hidden = completed;
    elements.resetButton.hidden = completed;
    elements.hintButton.hidden = completed || state.revealed;
    elements.showButton.hidden = completed || state.revealed;
    elements.uciDisclosure.hidden = completed;
    if (completed) elements.uciDisclosure.open = false;
    elements.skipButton.disabled = locked;
    elements.resetButton.disabled = locked;
    elements.hintButton.disabled = locked || state.revealed
      || Boolean(state.presentation && state.presentation.hintUsed);
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
      const timeline = teachingTimeline(candidate);
      const selected = timeline[state.teachingPly == null ? timeline.length - 1 : state.teachingPly]
        || timeline[timeline.length - 1];
      const final = line.steps[line.steps.length - 1];
      const showingActualFinish = state.teachingPly == null
        || state.teachingPly === timeline.length - 1;
      fen = showingActualFinish && state.completedPostFen
        ? state.completedPostFen : selected && selected.fen
        || state.completedPostFen || final.post_reply_fen || final.post_best_fen;
      lastMove = showingActualFinish && state.completedMoveUci
        ? state.completedMoveUci : selected && selected.uci || state.completedMoveUci
        || final.opponent_reply_uci || final.best_move_uci;
    } else if (state.linePhase === "playing_reply") {
      fen = step.post_best_fen;
      lastMove = step.best_move_uci;
    } else if (line.index > 0) {
      lastMove = line.steps[line.index - 1].opponent_reply_uci;
    }
    const config = {
      fen,
      orientation: boardOrientation(candidate),
      coordinatesOnSquares: true,
      // Never put the reusable queue board through Chessground's view-only
      // lifecycle; disabling movable/selectable preserves phone listeners.
      viewOnly: false,
      turnColor: solverColor(candidate),
      lastMove: uciSquares(lastMove),
      check: false,
      drawable: { enabled: false, visible: true },
      movable: {
        free: false,
        color: locked ? undefined : solverColor(candidate),
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
      drawMove(completed && lastMove ? lastMove : step.best_move_uci, "green");
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
    const candidate = currentCandidate();
    state.pendingPromotion = { from, to };
    state.linePhase = "choosing_promotion";
    const labels = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
    elements.promotionOptions.innerHTML = choices.map(choice =>
      `<button type="button" class="puzzle-promotion-option" data-piece="${choice}" aria-label="Promote to ${labels[choice]}">${labels[choice]}</button>`
    ).join("");
    elements.promotionChooser.hidden = false;
    elements.promotionChooser.setAttribute("aria-describedby", "puzzle-feedback");
    elements.feedback.textContent = `Choose the piece for ${colorLabel(solverColor(candidate))}’s promotion.`;
    setControlState(false);
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
    if (!state.firstMoveTracked) {
      state.firstMoveTracked = true;
      trackEvent("first_move_attempted", { puzzleNumber: displayPuzzleNumber() });
    }
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
      elements.feedback.innerHTML = `<span class="bad">Illegal move.</span> Choose a legal move for ${colorLabel(solverColor(candidate))}.`;
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
      if (state.presentation) state.presentation.incorrectCount += 1;
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
    state.teachingPly = teachingTimeline(candidate).length - 1;
    finalizePresentation(candidate, "solved");
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
    elements.feedback.setAttribute("data-state", "incorrect");
    elements.feedback.innerHTML = `<span class="bad">× Try again</span> — that move is legal, but misses the stored tactic.`;
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
    const attempts = state.presentation ? state.presentation.incorrectCount : 0;
    const position = displayPuzzleNumber();
    elements.queuePosition.textContent = (isEndlessSession()
      ? `Puzzle ${position}`
      : `Puzzle ${position} of ${state.session ? state.session.size : state.sessionSize}`)
      + `${attempts ? ` · ${attempts} ${attempts === 1 ? "retry" : "retries"}` : ""}`;
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
      elements.feedback.textContent = `The stored ${colorLabel(opponentColor(candidate))} reply is incomplete. Reset the puzzle and try again.`;
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
    const puzzleNumber = displayPuzzleNumber();
    try {
      state.store.revealSolution(puzzleId(candidate), new Date().toISOString());
    } catch (error) {
      state.transientWarning = "The revealed-solution state could not be saved.";
      console.error("Could not save opening-puzzle reveal", error);
    }
    if (state.presentation) state.presentation.revealed = true;
    state.revealed = true;
    state.feedbackMode = "revealed";
    state.linePhase = "complete";
    state.completedCandidate = candidate;
    state.currentId = null;
    state.teachingPly = teachingTimeline(candidate).length - 1;
    trackEvent("solution_revealed", { puzzleNumber });
    finalizePresentation(candidate, "revealed");
    renderWarnings();
    renderCounts();
    renderUnsolved();
    queueMicrotask(() => elements.continueButton.focus());
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
    if (state.presentation) state.presentation.hintUsed = true;
    elements.hintButton.disabled = true;
    elements.feedback.textContent = `Hint: start with the ${colorLabel(solverColor(candidate))} piece on ${best.slice(0, 2)}.`;
    elements.feedback.setAttribute("data-state", "revealed");
    trackEvent("hint_used", { puzzleNumber: displayPuzzleNumber() });
  }

  async function skipCurrent() {
    const candidate = currentCandidate();
    if (!candidate || state.completedCandidate) return;
    const puzzleNumber = displayPuzzleNumber();
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    closePromotionChooser(false);
    if (state.presentation) state.presentation.skipped = true;
    trackEvent("puzzle_skipped", { puzzleNumber });
    finalizePresentation(candidate, "skipped");
    await advanceSession();
  }

  async function continueQueue() {
    if (!state.completedCandidate) return;
    await advanceSession();
  }

  async function advanceSession() {
    clearIncorrectTimer();
    clearOpponentReplyTimer();
    if (!state.session) return;
    if (sessionCompletedCount(state.session) >= state.session.size) {
      if (isEndlessSession()) {
        state.endlessCompleted += sessionCompletedCount(state.session);
        const started = await startSession({
          mode: "endless",
          preserveTab: true,
          rollover: true,
        });
        if (started) focusPuzzleStart();
        return;
      }
      if (!state.reviewModeIds) clearActiveSelection();
      state.session.showSummary = true;
      state.lastMistakeIds = sessionSummary(state.session).mistakeIds || [];
      renderAll();
      if (elements.sessionCompleteTitle) queueMicrotask(() => elements.sessionCompleteTitle.focus());
      return;
    }
    state.completedCandidate = null;
    state.completedPostFen = null;
    state.completedMoveUci = null;
    state.teachingPly = null;
    state.currentId = sessionPuzzleIds(state.session)[sessionCompletedCount(state.session)] || null;
    state.revealed = false;
    state.feedbackMode = "idle";
    state.stepIndex = 0;
    state.linePhase = "awaiting_user";
    state.lastReplySan = null;
    state.lastReplyUci = null;
    elements.uciInput.value = "";
    resetPresentation(state.currentId);
    renderAll();
    if (state.currentId) focusPuzzleStart();
    else elements.pageState.focus && elements.pageState.focus();
  }

  function focusPuzzleStart() {
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
          <p>${escapeHtml(colorLabel(solverColor(candidate)))} · ${escapeHtml(titleCase(candidate.difficulty || "—"))} · rating ${escapeHtml(candidate.rating == null ? "—" : candidate.rating)}</p>
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
    const selectedId = puzzleId(candidate);
    if (state.selectedSolvedId !== selectedId || state.solvedTeachingPly == null) {
      state.solvedTeachingPly = Math.max(0, teachingTimeline(candidate).length - 1);
    }
    state.selectedSolvedId = selectedId;
    const progress = getProgress(candidate);
    elements.solvedReview.hidden = false;
    elements.solvedReviewTitle.textContent = `Solved puzzle · ${candidate.variation || openingFamily()}`;
    elements.solvedDetails.innerHTML = contextMarkup(candidate, progress, true, state.solvedTeachingPly)
      + `<p class="puzzle-readonly-note">Read-only review · solved ${escapeHtml(formatTimestamp(solvedTimestamp(progress)))}</p>`;
    paintSolvedReviewBoard(candidate);
    if (focusHeading) elements.solvedReviewTitle.focus();
  }

  function paintSolvedReviewBoard(candidate) {
    const timeline = teachingTimeline(candidate);
    const selected = timeline[state.solvedTeachingPly] || timeline[timeline.length - 1] || {};
    const config = {
      fen: selected.fen || candidate.puzzleFen || candidate.fen_before,
      orientation: boardOrientation(candidate),
      coordinatesOnSquares: true,
      viewOnly: true,
      lastMove: uciSquares(selected.uci),
      check: false,
      drawable: { enabled: false, visible: true },
      movable: { color: undefined, dests: new Map() },
    };
    if (!state.solvedBoard) state.solvedBoard = UI.makeBoard(elements.solvedBoard, config);
    else state.solvedBoard.set(config);
    if (state.solvedBoard) {
      const move = uciSquares(selected.uci);
      state.solvedBoard.setShapes(move
        ? [{ orig: move[0], dest: move[1], brush: "green" }]
        : []);
      queueMicrotask(() => state.solvedBoard.redrawAll && state.solvedBoard.redrawAll());
    }
  }

  function closeSolvedReview(restoreFocus) {
    state.selectedSolvedId = null;
    state.solvedTeachingPly = null;
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
    renderChoiceLists();
    updateVariationControl();
  }

  function selectOptions(select) {
    if (!select) return [];
    if (select.options && typeof Array.from === "function") {
      return Array.from(select.options).map(option => ({ value: option.value, label: option.textContent }));
    }
    const matches = String(select.innerHTML || "").matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g);
    return [...matches].map(match => ({ value: match[1], label: match[2] }));
  }

  function updateVariationControl() {
    if (!elements.filterVariation || !elements.variationPicker) return;
    const options = selectOptions(elements.filterVariation);
    const useNativeSelect = options.length <= 12;
    const selected = options.find(option => option.value === elements.filterVariation.value)
      || options[0] || { value: "all", label: "All variations" };
    elements.filterVariation.hidden = !useNativeSelect;
    elements.variationPicker.hidden = useNativeSelect;
    elements.variationPicker.textContent = selected.label;
    elements.variationPicker.setAttribute(
      "aria-label",
      `Choose a variation. Current: ${selected.label}`,
    );
  }

  function renderChoiceList(container, select) {
    if (!container || !select) return;
    container.innerHTML = selectOptions(select).map(option =>
      `<button type="button" class="choice-option" role="radio" aria-checked="${String(select.value === option.value)}" tabindex="${select.value === option.value ? "0" : "-1"}" data-choice-value="${escapeHtml(option.value)}" data-choice-label="${escapeHtml(option.label.toLowerCase())}">${escapeHtml(option.label)}</button>`
    ).join("");
  }

  function renderChoiceLists() {
    renderChoiceList(elements.variationChoices, elements.filterVariation);
    renderChoiceList(elements.themeChoices, elements.filterTheme);
    updateVariationControl();
  }

  function chooseFromList(container, select, button) {
    if (!container || !select || !button) return;
    select.value = button.dataset.choiceValue;
    container.querySelectorAll && container.querySelectorAll("[role='radio']").forEach(option => {
      option.setAttribute("aria-checked", String(option === button));
      option.tabIndex = option === button ? 0 : -1;
    });
    if (select === elements.filterVariation) updateVariationControl();
  }

  function moveChoiceFocus(event, container, select) {
    if (!container || !container.querySelectorAll
        || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      return;
    }
    const choices = Array.from(container.querySelectorAll("button[data-choice-value]"))
      .filter(button => !button.hidden && !button.disabled);
    if (!choices.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, choices.indexOf(document.activeElement));
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = choices.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % choices.length;
    } else {
      nextIndex = (currentIndex - 1 + choices.length) % choices.length;
    }
    chooseFromList(container, select, choices[nextIndex]);
    choices[nextIndex].focus();
  }

  function searchCustomizeChoices(query) {
    const wanted = String(query || "").trim().toLowerCase();
    [elements.variationChoices, elements.themeChoices].forEach(container => {
      if (!container || !container.querySelectorAll) return;
      const buttons = Array.from(container.querySelectorAll("[data-choice-label]"));
      buttons.forEach(button => {
        button.hidden = Boolean(wanted && !String(button.dataset.choiceLabel || "").includes(wanted));
      });
      const visible = buttons.filter(button => !button.hidden && !button.disabled);
      const focusable = visible.find(button => button.getAttribute("aria-checked") === "true")
        || visible[0];
      buttons.forEach(button => { button.tabIndex = button === focusable ? 0 : -1; });
    });
  }

  function renderFilterChips() {
    if (!elements.filterChips) return;
    const filters = currentFilters();
    const chips = [];
    if (filters.mode !== "all") chips.push(["mode", elements.filterMode.options
      ? elements.filterMode.options[elements.filterMode.selectedIndex].textContent : titleCase(filters.mode)]);
    if (filters.variation !== "all") chips.push(["variation", filters.variation]);
    if (filters.difficulty !== "all") chips.push(["difficulty", titleCase(filters.difficulty)]);
    if (filters.provenance !== "all") chips.push(["provenance", provenanceLabel(filters.provenance)]);
    if (filters.lineCoverage !== "all") chips.push(["lineCoverage",
      filters.lineCoverage === "main-lines" ? "Main lines" : "Sidelines"]);
    if (filters.theme !== "all") chips.push(["theme", titleCase(filters.theme)]);
    if (filters.openingOnly) chips.push(["openingOnly", "Opening phase only"]);
    if (filters.curriculumGroup) chips.push(["curriculumGroup", filters.curriculumGroup]);
    elements.filterChips.innerHTML = chips.length
      ? chips.map(([name, label]) => `<button type="button" class="filter-chip" data-clear-filter="${name}" aria-label="Clear ${escapeHtml(label)} filter">${escapeHtml(label)} ×</button>`).join("")
      : "";
  }

  function clearFilter(name) {
    if (name === "mode") elements.filterMode.value = "all";
    if (name === "variation") elements.filterVariation.value = "all";
    if (name === "difficulty") elements.filterDifficulty.value = "all";
    if (name === "provenance") elements.filterProvenance.value = "all";
    if (name === "lineCoverage" && elements.filterLines) elements.filterLines.value = "all";
    if (name === "theme") elements.filterTheme.value = "all";
    if (name === "openingOnly") elements.filterOpening.checked = false;
    if (name === "curriculumGroup") state.curriculumGroup = "";
    renderChoiceLists();
    void handleFilterChange();
  }

  function curriculumGroups() {
    if (!state.manifest) return [];
    const grouped = new Map();
    Object.entries(state.manifest.variationCounts || {}).forEach(([variation, rawCount]) => {
      const name = Caro.curriculumGroup({ variation, openingFamily: openingFamily() });
      grouped.set(name, (grouped.get(name) || 0) + Math.max(0, Number(rawCount) || 0));
    });
    const expertCount = Math.max(0, Number(state.manifest.difficultyCounts
      && state.manifest.difficultyCounts.expert) || 0);
    if (expertCount) grouped.set("Master challenges", expertCount);
    const curriculumOrdered = [];
    const candidateOrder = Caro.curriculumOrder(state.candidates).map(Caro.curriculumGroup);
    candidateOrder.concat([...grouped.keys()].sort()).forEach(name => {
      if (grouped.has(name) && !curriculumOrdered.includes(name)) curriculumOrdered.push(name);
    });
    if (grouped.has("Master challenges")) {
      const index = curriculumOrdered.indexOf("Master challenges");
      if (index >= 0) curriculumOrdered.splice(index, 1);
      curriculumOrdered.push("Master challenges");
    }
    return curriculumOrdered.map(name => {
      const loaded = state.candidates.filter(candidate => name === "Master challenges"
        ? String(candidate.difficulty || "").toLowerCase() === "expert"
        : Caro.curriculumGroup(candidate) === name);
      const solvedIds = new Set(loaded.filter(candidate => {
        const progress = getProgress(candidate);
        return progress && (progress.status === "solved" || progress.solvedAt);
      }).map(puzzleId));
      const masteredIds = new Set();
      Object.entries(state.reviewRecords || {}).forEach(([id, record]) => {
        const snapshot = record && record.snapshot || {};
        const matches = name === "Master challenges"
          ? String(snapshot.difficulty || "").toLowerCase() === "expert"
          : snapshot.curriculumGroup === name;
        if (!matches) return;
        if (record.legacySolved || Number(record.cleanSolves) > 0 || Number(record.assistedSolves) > 0) {
          solvedIds.add(id);
        }
        if (Trainer && typeof Trainer.classifyReview === "function"
            && Trainer.classifyReview(record, new Date().toISOString()) === "Mastered") {
          masteredIds.add(id);
        }
      });
      const solved = solvedIds.size;
      return {
        name,
        count: grouped.get(name),
        solved,
        mastered: masteredIds.size,
        loaded: loaded.length,
        percent: grouped.get(name) ? Math.min(100, Math.round(solved / grouped.get(name) * 100)) : 0,
      };
    });
  }

  function renderCurriculum() {
    if (!elements.curriculum || !elements.curriculumGroups) return;
    const visible = Boolean(state.manifest && currentFilters().mode === "curriculum");
    elements.curriculum.hidden = !visible;
    if (!visible) return;
    const groups = curriculumGroups();
    if (!groups.length) {
      elements.curriculumGroups.innerHTML = "<p>No guided groups are available for this deck yet.</p>";
      return;
    }
    elements.curriculumGroups.innerHTML = groups.map(group =>
      `<button type="button" class="curriculum-card${state.curriculumGroup === group.name ? " active" : ""}" data-curriculum-group="${escapeHtml(group.name)}">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.solved.toLocaleString()} solved · ${group.mastered.toLocaleString()} mastered</span>
        <span>${group.count.toLocaleString()} available · beginner through expert</span>
        <span class="curriculum-meter" aria-hidden="true"><i style="width:${group.percent}%"></i></span>
      </button>`
    ).join("");
    const recommended = groups.find(group => group.percent < 100) || groups[0];
    if (elements.curriculumContinue) elements.curriculumContinue.dataset.group = recommended.name;
  }

  function customizeControlState() {
    return {
      mode: elements.filterMode && elements.filterMode.value || "all",
      variation: elements.filterVariation && elements.filterVariation.value || "all",
      difficulty: elements.filterDifficulty && elements.filterDifficulty.value || "all",
      provenance: elements.filterProvenance && elements.filterProvenance.value || "all",
      lineCoverage: elements.filterLines && elements.filterLines.value || "all",
      theme: elements.filterTheme && elements.filterTheme.value || "all",
      openingOnly: Boolean(elements.filterOpening && elements.filterOpening.checked),
      search: elements.customizeSearch && elements.customizeSearch.value || "",
      curriculumGroup: state.curriculumGroup || "",
    };
  }

  function restoreCustomizeControls(snapshot) {
    if (!snapshot) return;
    if (elements.filterMode) elements.filterMode.value = snapshot.mode;
    if (elements.filterVariation) elements.filterVariation.value = snapshot.variation;
    if (elements.filterDifficulty) elements.filterDifficulty.value = snapshot.difficulty;
    if (elements.filterProvenance) elements.filterProvenance.value = snapshot.provenance;
    if (elements.filterLines) elements.filterLines.value = snapshot.lineCoverage;
    if (elements.filterTheme) elements.filterTheme.value = snapshot.theme;
    if (elements.filterOpening) elements.filterOpening.checked = snapshot.openingOnly;
    if (elements.customizeSearch) elements.customizeSearch.value = snapshot.search;
    state.curriculumGroup = snapshot.curriculumGroup || "";
    renderChoiceLists();
    searchCustomizeChoices(snapshot.search);
  }

  function resetFilterControls() {
    if (elements.filterMode) elements.filterMode.value = "all";
    if (elements.filterVariation) elements.filterVariation.value = "all";
    if (elements.filterDifficulty) elements.filterDifficulty.value = "all";
    if (elements.filterProvenance) elements.filterProvenance.value = "all";
    if (elements.filterLines) elements.filterLines.value = "all";
    if (elements.filterTheme) elements.filterTheme.value = "all";
    if (elements.filterOpening) elements.filterOpening.checked = false;
    if (elements.customizeSearch) elements.customizeSearch.value = "";
    state.curriculumGroup = "";
    renderChoiceLists();
    searchCustomizeChoices("");
  }

  function openCustomize(focusSearch) {
    if (!elements.filters) return;
    state.lastFocus = document.activeElement;
    state.customizeSnapshot = customizeControlState();
    elements.filters.hidden = false;
    setModalOpen(true);
    renderChoiceLists();
    queueMicrotask(() => {
      const target = focusSearch ? elements.customizeSearch : elements.customizeClose;
      if (target && target.focus) target.focus();
    });
  }

  function closeCustomize(restoreFocus, applyChanges) {
    if (!elements.filters) return;
    if (!applyChanges) restoreCustomizeControls(state.customizeSnapshot);
    state.customizeSnapshot = null;
    elements.filters.hidden = true;
    setModalOpen(Boolean(elements.library && !elements.library.hidden));
    if (restoreFocus && state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    state.lastFocus = null;
  }

  async function fetchLibraryManifests() {
    if (!state.catalog) return;
    await Promise.all(state.catalog.decks.map(async deck => {
      if (state.deckManifests.has(deck.id)) return;
      try {
        if (isPersonalBlunderDeck(deck)) {
          const envelope = await personalEnvelopeForDeck(deck, 0, null);
          const candidates = personalCandidatesForDeck(deck, envelope);
          state.deckManifests.set(deck.id, personalManifest(deck, candidates, envelope));
        } else {
          const raw = await fetchJson(`data/${deck.manifestPath}`, 0, null);
          state.deckManifests.set(deck.id, Caro.normalizeManifest(raw, deck));
        }
      } catch (error) {
        console.error(`Could not load ${deck.id} library details`, error);
      }
    }));
  }

  function deckProgress(deck) {
    try {
      const store = createDeckProgressStore(deck);
      const allowed = isPersonalBlunderDeck(deck) && state.personalEnvelope
        ? new Set(personalCandidatesForDeck(deck, state.personalEnvelope).map(puzzleId)) : null;
      const solved = Object.entries(store.all()).filter(([id, record]) =>
        (!allowed || allowed.has(id))
        && record && (record.status === "solved" || record.solvedAt)).length;
      const counts = state.reviewStore && state.reviewStore.reviewCounts
        ? state.reviewStore.reviewCounts(deck.id) : {};
      return { solved, mastered: Number(counts && (counts.mastered || counts.Mastered) || 0) };
    } catch (_error) {
      return { solved: 0, mastered: 0 };
    }
  }

  function renderDeckLibrary() {
    if (!elements.libraryCards || !state.catalog) return;
    elements.libraryCards.innerHTML = state.catalog.decks.map(deck => {
      const manifest = state.deckManifests.get(deck.id);
      const available = manifest ? manifest.balancedExported : null;
      const progress = deckProgress(deck);
      const current = state.deck && deck.id === state.deck.id;
      const shortName = deck.openingFamily.replace(/ Defense$/, "");
      const perspective = deck.solverColor === "mixed"
        ? "Both colors · board follows each puzzle"
        : `Solve as ${colorLabel(deck.solverColor)} · board oriented for ${colorLabel(deck.solverColor)}`;
      return `<article class="deck-card${current ? " current" : ""}">
        <h3>${escapeHtml(deck.openingFamily)}</h3>
        <p>${escapeHtml(perspective)}</p>
        <p>${available == null ? "Loading availability…" : `${available.toLocaleString()} puzzles available`}</p>
        <p class="deck-card-progress">${progress.solved.toLocaleString()} solved · ${progress.mastered.toLocaleString()} mastered</p>
        <button type="button" data-select-deck="${escapeHtml(deck.id)}">${current ? `Continue ${escapeHtml(shortName)}` : progress.solved ? "Continue" : "Start"}</button>
      </article>`;
    }).join("");
  }

  async function openDeckLibrary() {
    if (!elements.library) return;
    state.lastFocus = document.activeElement;
    elements.library.hidden = false;
    setModalOpen(true);
    renderDeckLibrary();
    queueMicrotask(() => elements.libraryClose && elements.libraryClose.focus());
    await fetchLibraryManifests();
    renderDeckLibrary();
  }

  function closeDeckLibrary(restoreFocus) {
    if (!elements.library) return;
    elements.library.hidden = true;
    setModalOpen(Boolean(elements.filters && !elements.filters.hidden));
    if (restoreFocus && state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    state.lastFocus = null;
  }

  function setModalOpen(open) {
    if (document.body && document.body.classList) {
      document.body.classList.toggle("trainer-modal-open", Boolean(open));
    }
  }

  function activeModalPanel() {
    if (elements.filters && !elements.filters.hidden && elements.filters.querySelector) {
      return elements.filters.querySelector(".customize-sheet");
    }
    if (elements.library && !elements.library.hidden && elements.library.querySelector) {
      return elements.library.querySelector(".deck-library-panel");
    }
    return null;
  }

  function trapModalFocus(event) {
    const panel = activeModalPanel();
    if (!panel || !panel.querySelectorAll) return false;
    const focusable = Array.from(panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.hidden);
    if (!focusable.length) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const containsActive = typeof panel.contains === "function" && panel.contains(active);
    if (event.shiftKey && (active === first || !containsActive)) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && (active === last || !containsActive)) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function exportedProgress() {
    const decks = {};
    (state.catalog ? state.catalog.decks : []).forEach(deck => {
      try {
        const store = createDeckProgressStore(deck);
        decks[deck.id] = { permanentSolvedProgress: store.all() };
      } catch (_error) {
        decks[deck.id] = { permanentSolvedProgress: {} };
      }
    });
    let trainer = null;
    try {
      const exported = state.reviewStore && state.reviewStore.exportData
        ? state.reviewStore.exportData() : null;
      trainer = typeof exported === "string" ? JSON.parse(exported) : exported;
    } catch (_error) {
      trainer = null;
    }
    return {
      format: "chess-opening-trainer-progress",
      version: 1,
      exportedAt: new Date().toISOString(),
      decks,
      trainer,
    };
  }

  function exportProgress() {
    if (typeof window.Blob !== "function" || !window.URL || !window.URL.createObjectURL
        || !document.createElement) return;
    const blob = new window.Blob([JSON.stringify(exportedProgress(), null, 2)], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `opening-trainer-progress-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
    if (elements.progressTransferStatus) elements.progressTransferStatus.textContent = "Progress backup downloaded.";
  }

  function mergePermanentProgress(deckId, incoming) {
    let storage;
    try {
      storage = window.localStorage;
    } catch (_error) {
      return;
    }
    if (!storage || !incoming || typeof incoming !== "object") return;
    const deck = state.catalog && state.catalog.decks.find(item => item.id === deckId);
    const key = Domain.storageKey(progressUsername(), progressNamespace(deck || { id: deckId }));
    let current = { version: 1, username: String(progressUsername()).trim().toLowerCase(), records: {} };
    try {
      const raw = storage.getItem(key);
      if (raw) current = JSON.parse(raw);
    } catch (_error) {
      current = { version: 1, username: String(progressUsername()).trim().toLowerCase(), records: {} };
    }
    if (!current.records || typeof current.records !== "object") current.records = {};
    const timestamp = value => value && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
    const earlier = (left, right) => {
      const leftTime = timestamp(left);
      const rightTime = timestamp(right);
      if (leftTime === null) return right || null;
      if (rightTime === null) return left || null;
      return leftTime <= rightTime ? left : right;
    };
    const later = (left, right) => {
      const leftTime = timestamp(left);
      const rightTime = timestamp(right);
      if (leftTime === null) return right || null;
      if (rightTime === null) return left || null;
      return leftTime >= rightTime ? left : right;
    };
    Object.entries(incoming).forEach(([id, rawRecord]) => {
      if (!rawRecord || typeof rawRecord !== "object") return;
      const previous = current.records[id] || {};
      const solved = previous.status === "solved" || previous.solvedAt
        || rawRecord.status === "solved" || rawRecord.solvedAt;
      current.records[id] = Object.assign({}, previous, rawRecord, {
        id,
        status: solved ? "solved" : "unsolved",
        attempts: Math.max(0, Number(previous.attempts) || 0, Number(rawRecord.attempts) || 0),
        firstAttemptAt: earlier(previous.firstAttemptAt, rawRecord.firstAttemptAt),
        solvedAt: solved ? earlier(previous.solvedAt, rawRecord.solvedAt) : null,
        solutionRevealedAt: earlier(previous.solutionRevealedAt, rawRecord.solutionRevealedAt),
        createdAt: earlier(previous.createdAt, rawRecord.createdAt),
        updatedAt: later(previous.updatedAt, rawRecord.updatedAt),
      });
    });
    storage.setItem(key, JSON.stringify(current));
  }

  async function importProgressFile(file) {
    if (!file || typeof file.text !== "function") return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || payload.format !== "chess-opening-trainer-progress" || payload.version !== 1) {
        throw new Error("This file is not an opening trainer progress backup.");
      }
      const validDeckIds = new Set((state.catalog ? state.catalog.decks : []).map(deck => deck.id));
      Object.entries(payload.decks || {}).forEach(([deckId, entry]) => {
        if (validDeckIds.has(deckId)) mergePermanentProgress(deckId, entry && entry.permanentSolvedProgress);
      });
      if (payload.trainer && state.reviewStore && typeof state.reviewStore.importData === "function") {
        state.reviewStore.importData(payload.trainer);
      }
      state.store = createDeckProgressStore(state.deck);
      rebuildPartition(false);
      renderAll();
      renderDeckLibrary();
      if (elements.progressTransferStatus) elements.progressTransferStatus.textContent = "Progress restored and merged with this device.";
    } catch (error) {
      if (elements.progressTransferStatus) elements.progressTransferStatus.textContent = error.message || "Couldn’t import that progress file.";
    } finally {
      if (elements.progressImport) elements.progressImport.value = "";
    }
  }

  function renderWarnings() {
    const messages = [];
    let permanentPersistent = true;
    if (state.store) {
      const persistent = typeof state.store.isPersistent === "function"
        ? state.store.isPersistent()
        : state.store.isPersistent !== false;
      permanentPersistent = persistent;
      if (!persistent) messages.push("Progress will last only for this visit because device storage is unavailable.");
      if (typeof state.store.getLastError === "function" && state.store.getLastError() && persistent) {
        messages.push("Your latest progress update may not have been saved on this device.");
      }
    }
    if (state.reviewStore) {
      const persistent = typeof state.reviewStore.isPersistent === "function"
        ? state.reviewStore.isPersistent()
        : state.reviewStore.isPersistent !== false;
      if (!persistent && permanentPersistent) {
        messages.push("Review scheduling will last only for this visit because device storage is unavailable.");
      }
      if (typeof state.reviewStore.getLastError === "function"
          && state.reviewStore.getLastError() && persistent) {
        messages.push("Your latest review schedule may not have been saved on this device.");
      }
    }
    if (state.transientWarning) messages.push(state.transientWarning);
    elements.warning.hidden = !messages.length;
    elements.warning.innerHTML = escapeHtml(messages.join(" "))
      + `${state.chunkErrors.length && state.deck ? ' <button type="button" data-retry-deck>Retry deck</button>' : ""}`;
  }

  function showFatal(message, retry) {
    state.fatalRetry = typeof retry === "function" ? retry : null;
    elements.workspace.hidden = true;
    elements.summary.textContent = "Opening puzzles unavailable";
    elements.pageState.hidden = false;
    elements.pageState.innerHTML = `<h2>Couldn’t load this deck</h2><p>${escapeHtml(message)}</p>`
      + `<div class="state-actions">${state.fatalRetry ? '<button type="button" data-retry-load>Retry</button>' : ""}`
      + `${state.catalog ? '<button type="button" data-open-library>Choose another deck</button>' : ""}</div>`;
    queueMicrotask(() => elements.pageState.focus && elements.pageState.focus());
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
    finalizeAbandonedPresentation("filters_changed");
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
    state.session = null;
    state.reviewModeIds = null;
    if (elements.filterMode && elements.filterMode.value !== "curriculum") {
      state.curriculumGroup = "";
    }
    rebuildPartition(true);
    if (!state.selectionIndex && !state.unsolved.length && hasMoreChunks()) {
      await ensureUnsolvedCandidates();
    }
    await startPreferredSession({ preserveTab: true, fresh: true });
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

    // Primary study controls apply immediately. Advanced controls are staged
    // inside Customize and applied together by its explicit action.
    if (elements.filterMode) {
      elements.filterMode.addEventListener("change", () => { void handleFilterChange(); });
    }
    if (elements.filterVariation) {
      elements.filterVariation.addEventListener("change", () => {
        updateVariationControl();
        void handleFilterChange();
      });
    }
    elements.filters.addEventListener("reset", () => queueMicrotask(() => {
      resetFilterControls();
    }));

    if (elements.customizeOpen) elements.customizeOpen.addEventListener("click", () => openCustomize(false));
    if (elements.variationPicker) {
      elements.variationPicker.addEventListener("click", () => openCustomize(true));
    }
    if (elements.customizeClose) elements.customizeClose.addEventListener("click", () => closeCustomize(true));
    if (elements.customizeApply) elements.customizeApply.addEventListener("click", () => {
      closeCustomize(true, true);
      void handleFilterChange();
    });
    if (elements.filters) elements.filters.addEventListener("click", event => {
      if (event.target && event.target.closest && event.target.closest("[data-customize-close]")) {
        closeCustomize(true);
      }
    });
    if (elements.filters) elements.filters.addEventListener("submit", event => event.preventDefault());
    if (elements.customizeSearch) elements.customizeSearch.addEventListener("input", () => {
      searchCustomizeChoices(elements.customizeSearch.value);
    });
    [[elements.variationChoices, elements.filterVariation], [elements.themeChoices, elements.filterTheme]]
      .forEach(([container, select]) => {
        if (!container) return;
        container.addEventListener("click", event => {
          const button = event.target.closest && event.target.closest("button[data-choice-value]");
          if (button) chooseFromList(container, select, button);
        });
        container.addEventListener("keydown", event => moveChoiceFocus(event, container, select));
      });
    if (elements.filterChips) elements.filterChips.addEventListener("click", event => {
      const button = event.target.closest && event.target.closest("button[data-clear-filter]");
      if (button) clearFilter(button.dataset.clearFilter);
    });
    if (elements.onboardingDismiss) elements.onboardingDismiss.addEventListener("click", dismissOnboarding);
    if (elements.sessionRestart) elements.sessionRestart.addEventListener("click", () => {
      void startPreferredSession({ fresh: true });
    });
    if (elements.sessionStartFresh) {
      elements.sessionStartFresh.addEventListener("click", () => { void startFreshSession(); });
    }
    if (elements.trainingLength) {
      elements.trainingLength.addEventListener("change", () => {
        const value = elements.trainingLength.value;
        if (value === "endless") {
          void startSession({ mode: "endless" });
          return;
        }
        const size = Number(value);
        if (SESSION_SIZES.includes(size)) void startSession({ mode: "finite", size });
      });
    }
    if (elements.reviewsDue) elements.reviewsDue.addEventListener("click", () => { void startDueReview(); });
    if (elements.reviewMistakes) elements.reviewMistakes.addEventListener("click", () => { void startMistakeReview(); });
    if (elements.sessionReviewMistakes) elements.sessionReviewMistakes.addEventListener("click", () => { void startMistakeReview(); });
    if (elements.sessionStartAnother) elements.sessionStartAnother.addEventListener("click", () => {
      void startPreferredSession(state.reviewModeIds ? { resume: true } : { fresh: true });
    });
    if (elements.curriculumGroups) elements.curriculumGroups.addEventListener("click", event => {
      const button = event.target.closest && event.target.closest("button[data-curriculum-group]");
      if (!button) return;
      state.curriculumGroup = button.dataset.curriculumGroup;
      void handleFilterChange();
    });
    if (elements.curriculumContinue) elements.curriculumContinue.addEventListener("click", () => {
      state.curriculumGroup = elements.curriculumContinue.dataset.group || "";
      void handleFilterChange();
    });
    if (elements.libraryOpen) elements.libraryOpen.addEventListener("click", () => { void openDeckLibrary(); });
    if (elements.libraryClose) elements.libraryClose.addEventListener("click", () => closeDeckLibrary(true));
    if (elements.library) elements.library.addEventListener("click", event => {
      if (event.target && event.target.closest && event.target.closest("[data-library-close]")) {
        closeDeckLibrary(true);
        return;
      }
      const button = event.target && event.target.closest && event.target.closest("button[data-select-deck]");
      if (!button) return;
      const deckId = button.dataset.selectDeck;
      if (state.deck && deckId === state.deck.id) {
        closeDeckLibrary(false);
        activateTab("unsolved", false);
        if (state.session && state.session.showSummary) {
          void startPreferredSession();
        } else {
          renderAll();
          focusPuzzleStart();
        }
      } else {
        closeDeckLibrary(false);
        void switchDeck(deckId, false);
      }
    });
    if (elements.progressExport) elements.progressExport.addEventListener("click", exportProgress);
    if (elements.progressImport) elements.progressImport.addEventListener("change", () => {
      const file = elements.progressImport.files && elements.progressImport.files[0];
      void importProgressFile(file);
    });
    if (elements.pageState) elements.pageState.addEventListener("click", event => {
      if (event.target && event.target.closest && event.target.closest("[data-retry-load]") && state.fatalRetry) {
        void state.fatalRetry();
      } else if (event.target && event.target.closest && event.target.closest("[data-open-library]")) {
        void openDeckLibrary();
      } else if (event.target && event.target.closest && event.target.closest("[data-clear-filters]")) {
        resetFilterControls();
        void handleFilterChange();
      }
    });
    if (elements.warning) elements.warning.addEventListener("click", event => {
      const retry = event.target && event.target.closest && event.target.closest("[data-retry-deck]");
      if (retry && state.deck) void switchDeck(state.deck.id, false);
    });

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
    elements.context.addEventListener("click", event => {
      const candidate = currentCandidate();
      if (!candidate || !state.completedCandidate) return;
      const move = event.target.closest && event.target.closest("button[data-teaching-ply]");
      const previous = event.target.closest && event.target.closest("button[data-teaching-previous]");
      const next = event.target.closest && event.target.closest("button[data-teaching-next]");
      const timeline = teachingTimeline(candidate);
      if (move) state.teachingPly = Number(move.dataset.teachingPly);
      else if (previous) state.teachingPly = Math.max(0, Number(state.teachingPly || 0) - 1);
      else if (next) state.teachingPly = Math.min(timeline.length - 1, Number(state.teachingPly || 0) + 1);
      else return;
      elements.context.innerHTML = contextMarkup(candidate, getProgress(candidate), true);
      paintInteractiveBoard(candidate, true);
    });
    elements.solvedDetails.addEventListener("click", event => {
      const candidates = elements.solvedList._renderedCandidates || [];
      const candidate = candidates.find(item => puzzleId(item) === state.selectedSolvedId);
      if (!candidate) return;
      const move = event.target.closest && event.target.closest("button[data-teaching-ply]");
      const previous = event.target.closest && event.target.closest("button[data-teaching-previous]");
      const next = event.target.closest && event.target.closest("button[data-teaching-next]");
      const timeline = teachingTimeline(candidate);
      if (move) state.solvedTeachingPly = Number(move.dataset.teachingPly);
      else if (previous) state.solvedTeachingPly = Math.max(0, Number(state.solvedTeachingPly || 0) - 1);
      else if (next) state.solvedTeachingPly = Math.min(timeline.length - 1, Number(state.solvedTeachingPly || 0) + 1);
      else return;
      renderSolvedReview(candidate, false);
    });

    if (document.addEventListener) document.addEventListener("keydown", event => {
      if (event.key === "Tab" && activeModalPanel()) {
        trapModalFocus(event);
        return;
      }
      if (event.key !== "Escape") return;
      if (elements.filters && !elements.filters.hidden) closeCustomize(true);
      else if (elements.library && !elements.library.hidden) closeDeckLibrary(true);
    });

    window.addEventListener("pagehide", event => {
      if (!event || event.persisted !== true) finalizeAbandonedPresentation("page_closed");
    });

    window.addEventListener("storage", event => {
      const reviewKey = state.reviewStore && state.reviewStore.key;
      if (!state.store || (event && event.key && event.key !== state.store.key && event.key !== reviewKey)) return;
      try {
        if (event && event.key === reviewKey && state.reviewStore.refresh) state.reviewStore.refresh();
        state.store = createDeckProgressStore(state.deck);
        prepareReviewRecords();
        // Another tab may update the archives while this one is showing a
        // completed line. Refresh the backing stores without destroying the
        // active training queue or its teaching state.
        rebuildPartition(false);
        renderAll();
      } catch (error) {
        state.transientWarning = "Progress changed in another tab but could not be refreshed here.";
        renderWarnings();
      }
    });
  }
}());
