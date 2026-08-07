(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    // Keep the original public name so bookmarks, tests, and cached pages that
    // load this script continue to work while the implementation serves every
    // configured opening deck.
    root.CaroKannDomain = factory();
    root.OpeningPuzzleDomain = root.CaroKannDomain;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_DECK_ID = "caro-kann-black";
  const CARO_TAG = "Caro-Kann_Defense";
  const DEFAULT_CARO_CONFIG = Object.freeze({
    id: DEFAULT_DECK_ID,
    deckId: DEFAULT_DECK_ID,
    label: "Caro-Kann Defense — Black",
    displayName: "Caro-Kann Defense — Black",
    openingFamily: "Caro-Kann Defense",
    solverColor: "black",
    orientation: "black",
    openingTagRoots: Object.freeze([CARO_TAG]),
    manifestPath: "caro-kann-black/manifest.json",
  });
  const DIFFICULTY_ORDER = Object.freeze([
    "beginner", "developing", "intermediate", "advanced", "expert",
  ]);
  const CARO_CURRICULUM_ORDER = Object.freeze([
    "Main lines",
    "Advance",
    "Exchange",
    "Panov",
    "Classical",
    "Tartakower",
    "Karpov",
    "Two Knights",
    "Accelerated Panov",
    "Rare sidelines and gambits",
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

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function color(value) {
    const normalized = text(value).toLowerCase();
    return normalized === "white" || normalized === "black" ? normalized : "";
  }

  function perspective(value) {
    const normalized = text(value).toLowerCase();
    return normalized === "mixed" ? normalized : color(normalized);
  }

  function oppositeColor(value) {
    return value === "white" ? "black" : value === "black" ? "white" : "";
  }

  function safeRelativePath(value) {
    const raw = value === undefined || value === null ? "" : String(value);
    const path = raw.trim();
    if (!path || raw !== path || path.includes("\\") || path.startsWith("/")
        || path.includes("?") || path.includes("#") || path.includes("\0")
        || /^[a-z][a-z0-9+.-]*:/i.test(path)) return "";
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) return "";
    return path;
  }

  function normalizeDeck(rawDeck) {
    const raw = object(rawDeck);
    const id = text(raw.id || raw.deckId || raw.deck_id).toLowerCase();
    const sourceKind = text(raw.sourceKind || raw.source_kind).toLowerCase();
    const personalBlunders = sourceKind === "personal-blunders";
    const qualityLabel = text(raw.qualityLabel || raw.quality_label || "blunder")
      .toLowerCase();
    const solverColor = perspective(raw.solverColor || raw.solver_color || raw.sideToMove);
    const orientation = perspective(raw.orientation);
    const manifestPath = safeRelativePath(raw.manifestPath || raw.manifest_path);
    const dataPath = safeRelativePath(raw.dataPath || raw.data_path);
    const roots = array(raw.openingTagRoots || raw.opening_tag_roots)
      .map(text).filter(Boolean);
    // The deploy catalog is intentionally compact and may leave tag roots to
    // the authoritative manifest. Record adaptation still requires manifest
    // roots and therefore never turns this into fuzzy matching.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !solverColor
        || orientation !== solverColor) return null;
    if (personalBlunders) {
      if (dataPath !== "my-blunder-puzzles.json"
          || text(raw.progressScope || raw.progress_scope).toLowerCase() !== "personal"
          || !["blunder", "mistake"].includes(qualityLabel)) {
        return null;
      }
    } else if (!manifestPath || manifestPath !== `${id}/manifest.json`
        || !color(solverColor)) return null;
    const openingFamily = text(raw.openingFamily || raw.opening_family) || id;
    const displayName = text(raw.label || raw.displayName || raw.display_name)
      || `${openingFamily} — ${solverColor === "mixed" ? "ALL" : solverColor === "white" ? "White" : "Black"}`;
    return {
      raw,
      id,
      deckId: id,
      label: displayName,
      displayName,
      openingFamily,
      solverColor,
      orientation,
      openingTagRoots: [...new Set(roots)],
      manifestPath,
      dataPath,
      sourceKind,
      qualityLabel: personalBlunders ? qualityLabel : "",
      progressScope: personalBlunders ? "personal" : "deck",
      repertoireDeckId: text(raw.repertoireDeckId || raw.repertoire_deck_id).toLowerCase(),
    };
  }

  function isPersonalBlunderDeck(value) {
    return Boolean(value && text(value.sourceKind || value.source_kind).toLowerCase()
      === "personal-blunders");
  }

  function normalizeCatalog(rawCatalog) {
    const raw = object(rawCatalog);
    const seen = new Set();
    const decks = array(raw.decks).map(normalizeDeck).filter(deck => {
      if (!deck || seen.has(deck.id)) return false;
      seen.add(deck.id);
      return true;
    });
    const requestedDefault = text(raw.defaultDeckId || raw.default_deck_id).toLowerCase();
    const fallback = decks.find(deck => deck.id === DEFAULT_DECK_ID) || decks[0] || null;
    const selected = decks.find(deck => deck.id === requestedDefault) || fallback;
    return {
      raw,
      schemaVersion: text(raw.schemaVersion || raw.schema_version || ""),
      defaultDeckId: selected ? selected.id : "",
      decks,
    };
  }

  function matchesOpeningRoot(tag, root) {
    const value = text(tag);
    const prefix = text(root);
    return Boolean(value && prefix && (value === prefix || value.startsWith(prefix + "_")));
  }

  function matchingOpeningTags(tags, roots) {
    const configuredRoots = array(roots).map(text).filter(Boolean);
    return array(tags).map(text).filter(Boolean).filter(tag =>
      configuredRoots.some(root => matchesOpeningRoot(tag, root))
    ).sort((left, right) => right.length - left.length || left.localeCompare(right));
  }

  function matchingRoot(tag, roots) {
    return array(roots).map(text).filter(root => matchesOpeningRoot(tag, root))
      .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] || "";
  }

  function hasCaroKannTag(tag) {
    return matchesOpeningRoot(tag, CARO_TAG);
  }

  function primaryVariationTag(tags) {
    return matchingOpeningTags(tags, [CARO_TAG])[0] || "";
  }

  function readableSuffix(value) {
    return text(value).replace(/_/g, " ");
  }

  function readableVariation(tag, config, explicitRoot) {
    const deck = config && (config.openingFamily || config.openingTagRoots)
      ? config : DEFAULT_CARO_CONFIG;
    const family = text(deck.openingFamily) || "Opening";
    const roots = array(deck.openingTagRoots).length
      ? deck.openingTagRoots : DEFAULT_CARO_CONFIG.openingTagRoots;
    const root = text(explicitRoot) || matchingRoot(tag, roots);
    if (!root) return family;
    const suffix = text(tag).slice(root.length).replace(/^_/, "");
    if (!suffix) {
      if (deck.id === "modern-black" && root === "Queens_Pawn_Game_Modern_Defense") {
        return "Modern Defense: Queen’s Pawn Move Order";
      }
      return family;
    }
    return `${family}: ${readableSuffix(suffix)}`;
  }

  function countMap(raw, directKeys, nestedKeys) {
    for (const key of directKeys) {
      if (object(raw[key]) === raw[key]) return Object.assign({}, raw[key]);
    }
    const counts = object(raw.counts);
    for (const key of nestedKeys) {
      if (object(counts[key]) === counts[key]) return Object.assign({}, counts[key]);
    }
    return {};
  }

  function balancedCountMap(raw, key, directKeys, nestedKeys) {
    const balanced = object(raw.balancedCounts || raw.balanced_counts);
    const available = object(balanced[key]);
    return Object.keys(available).length
      ? Object.assign({}, available)
      : countMap(raw, directKeys, nestedKeys);
  }

  function normalizeManifest(rawManifest, catalogDeck) {
    const raw = object(rawManifest);
    const fallbackDeck = normalizeDeck(catalogDeck) || DEFAULT_CARO_CONFIG;
    const deckId = text(raw.deckId || raw.deck_id || fallbackDeck.id).toLowerCase();
    const solverColor = color(raw.solverColor || raw.solver_color || fallbackDeck.solverColor);
    const orientation = color(raw.orientation || fallbackDeck.orientation);
    const roots = array(raw.openingTagRoots || raw.opening_tag_roots).map(text).filter(Boolean);
    const openingTagRoots = roots.length ? roots : array(fallbackDeck.openingTagRoots).slice();
    const openingFamily = text(raw.openingFamily || raw.opening_family || fallbackDeck.openingFamily);
    const displayName = text(raw.displayName || raw.display_name || fallbackDeck.displayName
      || fallbackDeck.label) || openingFamily;
    const chunks = array(raw.chunks).map((entry, index) => {
      if (typeof entry === "string") {
        const path = safeRelativePath(entry);
        return path ? { path, count: null, index } : null;
      }
      const item = object(entry);
      const path = safeRelativePath(item.path || item.file || item.url);
      return path ? { path, count: number(item.count, null), index } : null;
    }).filter(Boolean);
    const exact = object(raw.exactCounts || raw.exact_counts);
    const counts = object(raw.counts);
    const balancedExported = number(
      raw.balancedExported != null ? raw.balancedExported
        : raw.balanced_exported != null ? raw.balanced_exported
          : exact.balancedExported != null ? exact.balancedExported
            : exact.balanced_exported != null ? exact.balanced_exported
              : counts.balancedExported != null ? counts.balancedExported
                : counts.balanced_exported,
      chunks.reduce((total, chunk) => total + (chunk.count || 0), 0),
    );
    const rawSelectionIndex = safeRelativePath(
      raw.selectionIndex || raw.selection_index,
    );
    const rawDatasetVersion = text(raw.datasetVersion || raw.dataset_version);
    const datasetVersion = rawSelectionIndex === "selection-index.json"
      && /^[0-9a-f]{64}$/.test(rawDatasetVersion) ? rawDatasetVersion : "";
    const selectionIndex = rawSelectionIndex === "selection-index.json" && datasetVersion
      ? {
        path: rawSelectionIndex,
        count: balancedExported,
        datasetVersion,
        schemaVersion: 1,
      }
      : null;

    return {
      raw,
      deckId,
      id: deckId,
      name: text(raw.datasetName || raw.dataset || raw.name || displayName),
      displayName,
      openingFamily,
      solverColor,
      orientation,
      openingTagRoots,
      schemaVersion: text(raw.schemaVersion || raw.schema_version || ""),
      generatedAt: text(raw.generatedAtUtc || raw.generatedAt || raw.generated_at || ""),
      balancedExported,
      chunks,
      selectionIndex,
      datasetVersion,
      variationCounts: balancedCountMap(raw, "variation", ["variationCounts", "variation_counts"], ["variation", "variations"]),
      difficultyCounts: balancedCountMap(raw, "difficulty", ["difficultyCounts", "difficulty_counts"], ["difficulty", "difficulties"]),
      provenanceCounts: balancedCountMap(raw, "provenance", ["provenanceCounts", "provenance_counts"], ["provenance", "sources"]),
      themeCounts: balancedCountMap(raw, "theme", ["themeCounts", "theme_counts"], ["theme", "themes"]),
    };
  }

  function sideFromFen(fen) {
    return text(fen).split(/\s+/)[1] || "";
  }

  function adaptRecord(rawRecord, rawConfig) {
    const record = object(rawRecord);
    const config = rawConfig && rawConfig.openingTagRoots
      ? rawConfig : DEFAULT_CARO_CONFIG;
    const deckId = text(config.deckId || config.id || DEFAULT_DECK_ID).toLowerCase();
    const solverColor = color(config.solverColor) || "black";
    const orientation = color(config.orientation) || solverColor;
    const roots = array(config.openingTagRoots).map(text).filter(Boolean);
    const id = text(record.id || record.puzzleId || record.puzzle_id);
    const recordDeckId = text(record.deckId || record.deck_id).toLowerCase();
    const requiresDeckId = /^2(?:\.|$)/.test(text(config.schemaVersion));
    const originalFen = text(record.originalFen || record.original_fen);
    const puzzleFen = text(record.puzzleFen || record.puzzle_fen);
    const openingTags = array(record.openingTags || record.opening_tags).map(text).filter(Boolean);
    const matches = matchingOpeningTags(openingTags, roots);
    const tag = matches[0] || "";
    const root = matchingRoot(tag, roots);
    const sideToMove = color(record.sideToMove || record.side_to_move);
    const recordSolver = color(record.solverColor || record.solver_color);
    const recordOrientation = color(record.orientation);
    const rawSteps = array(record.solutionSteps || record.solution_steps);
    const firstRawStep = object(rawSteps[0]);
    const firstFen = rawSteps.length
      ? text(firstRawStep.fenBefore || firstRawStep.fen_before)
      : "";
    if (!id || !tag || (requiresDeckId && !recordDeckId)
        || (recordDeckId && recordDeckId !== deckId)
        || !originalFen || sideFromFen(originalFen) !== oppositeColor(solverColor)[0]
        || !puzzleFen || sideFromFen(puzzleFen) !== solverColor[0]
        || sideToMove !== solverColor || (requiresDeckId && !recordSolver)
        || (recordSolver && recordSolver !== solverColor)
        || recordOrientation !== orientation || orientation !== solverColor
        || !rawSteps.length || firstFen !== puzzleFen) {
      return null;
    }

    const steps = rawSteps.map((rawStep, index) => {
      const step = Object.assign({}, object(rawStep));
      if (index === 0 && !Array.isArray(step.acceptedMovesUci)
          && !Array.isArray(step.accepted_moves_uci)) {
        const accepted = record.acceptedMatingMovesUci || record.accepted_mating_moves_uci
          || record.acceptedMovesUci || record.accepted_moves_uci;
        if (Array.isArray(accepted)) step.acceptedMovesUci = accepted.slice();
      }
      if (index === 0 && step.acceptedMovePostFens == null
          && step.accepted_move_post_fens == null) {
        const postFens = record.acceptedMovePostFens || record.accepted_move_post_fens;
        if (postFens && typeof postFens === "object" && !Array.isArray(postFens)) {
          step.acceptedMovePostFens = Object.assign({}, postFens);
        }
      }
      return step;
    });
    const first = object(steps[0]);
    // Display classification is derived from the same audited primary tag and
    // root used for inclusion; contradictory source fields cannot leak a
    // variation label from another deck into the UI.
    const variation = readableVariation(tag, config, root);

    return Object.assign({}, record, {
      id,
      puzzle_id: id,
      deckId,
      deck_id: deckId,
      openingFamily: text(config.openingFamily || record.openingFamily) || "Opening",
      openingTags,
      matchedOpeningTags: matches,
      matchedTagRoot: root,
      primaryOpeningTag: tag,
      primaryVariationTag: tag,
      variation,
      originalFen,
      puzzleFen,
      fen_before: puzzleFen,
      solverColor,
      solver_color: solverColor,
      sideToMove: solverColor,
      side_to_move: solverColor,
      side: solverColor,
      user_color: solverColor,
      orientation,
      solutionSteps: steps,
      solution_steps: steps,
      best_move_uci: first.bestMoveUci || first.best_move_uci,
      best_move_san: first.bestMoveSan || first.best_move_san,
      post_best_fen: first.postBestFen || first.post_best_fen,
      legal_moves_uci: first.legalMovesUci || first.legal_moves_uci,
      legal_dests: first.legalDests || first.legal_dests,
      promotion_options: first.promotionOptions || first.promotion_options || {},
    });
  }

  function adaptPersonalBlunderRecord(rawRecord, rawDeck) {
    const record = object(rawRecord);
    const deck = normalizeDeck(rawDeck);
    if (!deck || !isPersonalBlunderDeck(deck)) return null;

    const id = text(record.puzzle_id || record.puzzleId || record.id);
    const solverColor = color(record.user_color || record.solverColor || record.solver_color);
    const orientation = color(record.orientation);
    const sideToMove = color(record.side_to_move || record.sideToMove);
    const puzzleFen = text(record.fen_before || record.puzzleFen || record.puzzle_fen);
    const rawSteps = array(record.solution_steps || record.solutionSteps);
    const firstRawStep = object(rawSteps[0]);
    const firstFen = text(firstRawStep.fen_before || firstRawStep.fenBefore);
    const category = text(record.repertoire_deck_id || record.repertoireDeckId).toLowerCase();
    const qualityLabel = text(record.quality_label || record.qualityLabel || "blunder")
      .toLowerCase();
    if (!id || id !== String(record.puzzle_id || record.puzzleId || record.id || "").trim()
        || !solverColor || orientation !== solverColor || sideToMove !== solverColor
        || !puzzleFen || sideFromFen(puzzleFen) !== solverColor[0]
        || !rawSteps.length || firstFen !== puzzleFen
        || !["blunder", "mistake"].includes(qualityLabel)
        || qualityLabel !== deck.qualityLabel
        || (deck.solverColor !== "mixed" && deck.solverColor !== solverColor)
        || (deck.repertoireDeckId && deck.repertoireDeckId !== category)) {
      return null;
    }

    const steps = rawSteps.map(rawStep => Object.assign({}, object(rawStep)));
    const first = object(steps[0]);
    const opening = text(record.opening) || deck.openingFamily;
    const themes = array(record.categories).map(text).filter(Boolean);
    return Object.assign({}, record, {
      id,
      puzzle_id: id,
      deckId: deck.id,
      deck_id: deck.id,
      sourceKind: "personal-blunders",
      qualityLabel,
      quality_label: qualityLabel,
      source: "chess.com",
      sourceUrl: text(record.game_url || record.gameUrl),
      openingFamily: deck.openingFamily,
      variation: opening,
      originalFen: puzzleFen,
      puzzleFen,
      fen_before: puzzleFen,
      solverColor,
      solver_color: solverColor,
      sideToMove,
      side_to_move: sideToMove,
      side: solverColor,
      user_color: solverColor,
      orientation,
      solutionSteps: steps,
      solution_steps: steps,
      solutionUci: array(record.principal_variation_uci).slice(),
      solutionSan: array(record.principal_variation_san).slice(),
      solutionLength: array(record.principal_variation_uci).length || steps.length,
      solverDecisionCount: steps.length,
      best_move_uci: first.bestMoveUci || first.best_move_uci,
      best_move_san: first.bestMoveSan || first.best_move_san,
      post_best_fen: first.postBestFen || first.post_best_fen,
      legal_moves_uci: first.legalMovesUci || first.legal_moves_uci,
      legal_dests: first.legalDests || first.legal_dests,
      promotion_options: first.promotionOptions || first.promotion_options || {},
      themes,
      primaryTacticalTheme: themes[0]
        || (qualityLabel === "mistake" ? "personalMistake" : "personalBlunder"),
      provenance: "standard",
      difficulty: "",
      rating: null,
      isOpeningPuzzle: Number(record.fullmove) <= 8,
    });
  }

  function normalizedWords(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function curriculumGroup(value) {
    const record = value && typeof value === "object" ? value : null;
    const variation = record ? record.variation : value;
    const readableVariation = text(variation);
    const readableFamily = record ? text(record.openingFamily) : "";
    const family = record ? normalizedWords(record.openingFamily) : "";
    const words = normalizedWords(variation);
    if (!family || family === "caro kann defense" || words.startsWith("caro kann defense")) {
      if (words.includes("accelerated panov")) return "Accelerated Panov";
      if (words.includes("panov")) return "Panov";
      if (words.includes("advance")) return "Advance";
      if (words.includes("exchange")) return "Exchange";
      if (words.includes("classical")) return "Classical";
      if (words.includes("tartakower")) return "Tartakower";
      if (words.includes("karpov")) return "Karpov";
      if (words.includes("two knights")) return "Two Knights";
      if (words === "caro kann defense" || words.endsWith(" main line")) return "Main lines";
      return "Rare sidelines and gambits";
    }
    if (words === family || words.endsWith(" main line")) return "Main lines";
    let suffix = readableVariation;
    if (family && words.startsWith(family)) {
      suffix = readableVariation.toLowerCase().startsWith(readableFamily.toLowerCase())
        ? readableVariation.slice(readableFamily.length)
        : readableVariation.slice(readableVariation.indexOf(":") + 1);
      suffix = suffix.replace(/^[\s:–—-]+/, "").trim();
    }
    return suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : "Main lines";
  }

  function isMainLine(record) {
    const group = curriculumGroup(record);
    if (group === "Main lines") return true;
    const words = normalizedWords(record && record.variation);
    const family = normalizedWords(record && record.openingFamily);
    if ((!family || family === "caro kann defense" || words.startsWith("caro kann defense"))
        && group !== "Rare sidelines and gambits") return true;
    return ["classical", "standard", "traditional", "main line"].some(term => words.includes(term));
  }

  function normalizeSelectionIndex(rawIndex, rawManifest) {
    const raw = object(rawIndex);
    const suppliedManifest = object(rawManifest);
    const manifest = suppliedManifest.raw === undefined
      ? normalizeManifest(suppliedManifest) : suppliedManifest;
    const descriptor = object(manifest.selectionIndex);
    if (descriptor.path !== "selection-index.json"
        || descriptor.schemaVersion !== 1
        || descriptor.datasetVersion !== manifest.datasetVersion
        || descriptor.count !== manifest.balancedExported
        || !manifest.datasetVersion
        || raw.schemaVersion !== 1
        || typeof raw.deckId !== "string" || raw.deckId !== manifest.deckId
        || typeof raw.datasetVersion !== "string"
        || raw.datasetVersion !== manifest.datasetVersion) {
      return null;
    }
    const count = raw.count;
    const entries = raw.entries;
    if (!Number.isInteger(count) || count < 0 || !Array.isArray(entries)
        || entries.length !== count || count !== manifest.balancedExported) {
      return null;
    }

    const ids = new Set();
    const locations = new Set();
    const normalized = [];
    for (const rawEntry of entries) {
      const entry = object(rawEntry);
      const id = text(entry.id);
      const chunkIndex = entry.chunkIndex;
      const chunkOffset = entry.chunkOffset;
      const chunk = manifest.chunks[chunkIndex];
      const location = `${chunkIndex}:${chunkOffset}`;
      if (typeof entry.id !== "string" || id !== entry.id || !id || ids.has(id)
          || !Number.isInteger(chunkIndex) || chunkIndex < 0 || !chunk
          || !Number.isInteger(chunkOffset) || chunkOffset < 0
          || !Number.isInteger(chunk.count) || chunkOffset >= chunk.count
          || locations.has(location)) {
        return null;
      }

      const variation = text(entry.variation);
      const difficulty = text(entry.difficulty).toLowerCase();
      const provenance = text(entry.provenance);
      const primaryTheme = text(entry.primaryTheme || entry.primary_theme);
      const themes = entry.themes;
      const solutionLength = entry.solutionLength;
      const solverDecisionCount = entry.solverDecisionCount;
      const tacticalSignature = text(
        entry.tacticalSignature || entry.tactical_signature,
      );
      const signatureParts = tacticalSignature.split("|");
      if (typeof entry.variation !== "string" || variation !== entry.variation
          || !variation || !DIFFICULTY_ORDER.includes(difficulty)
          || typeof entry.difficulty !== "string" || difficulty !== entry.difficulty
          || !Number.isInteger(entry.rating)
          || typeof entry.provenance !== "string" || provenance !== entry.provenance
          || !provenance || !Array.isArray(themes)
          || themes.some(theme => typeof theme !== "string" || !theme || theme !== theme.trim())
          || typeof entry.primaryTheme !== "string" || primaryTheme !== entry.primaryTheme
          || !primaryTheme || typeof entry.isOpeningPuzzle !== "boolean"
          || !Number.isInteger(solutionLength) || solutionLength < 1
          || !Number.isInteger(solverDecisionCount) || solverDecisionCount < 1
          || signatureParts.length !== 4 || signatureParts[0] !== primaryTheme
          || signatureParts[1] !== String(solutionLength)
          || !/^[KQRBNP]$/.test(signatureParts[2])
          || !/^[a-h][1-8]$/.test(signatureParts[3])) {
        return null;
      }

      const classified = { variation, openingFamily: manifest.openingFamily };
      ids.add(id);
      locations.add(location);
      normalized.push({
        id,
        chunkIndex,
        chunkOffset,
        variation,
        difficulty,
        rating: entry.rating,
        provenance,
        themes: themes.slice(),
        primaryTheme,
        isOpeningPuzzle: entry.isOpeningPuzzle,
        solutionLength,
        solverDecisionCount,
        tacticalSignature,
        curriculumGroup: curriculumGroup(classified),
        mainLine: isMainLine(classified),
      });
    }

    return {
      raw,
      schemaVersion: 1,
      deckId: manifest.deckId,
      datasetVersion: manifest.datasetVersion,
      count,
      entries: normalized,
    };
  }

  function themeMatches(themes, requested) {
    const wanted = text(requested).toLowerCase();
    if (!wanted || wanted === "all") return true;
    const normalized = array(themes).map(theme => text(theme).toLowerCase());
    if (wanted === "mates") return normalized.some(theme => /^mate(?:in\d+)?$/.test(theme));
    if (wanted === "forks") return normalized.includes("fork");
    if (wanted === "pins") return normalized.includes("pin");
    if (wanted === "sacrifices") return normalized.includes("sacrifice");
    if (wanted === "defensive") return normalized.includes("defensivemove");
    if (wanted === "quiet") return normalized.includes("quietmove");
    return normalized.includes(wanted);
  }

  function filterRecords(records, filters) {
    const selected = object(filters);
    const mode = text(selected.mode || "all").toLowerCase();
    const lineCoverage = text(
      selected.lineCoverage || selected.line_coverage
      || (mode === "main-lines" || mode === "sidelines" ? mode : "all")
    ).toLowerCase();
    const variation = text(selected.variation || "all");
    const difficulty = text(selected.difficulty || "all").toLowerCase();
    const provenance = normalizedWords(selected.provenance || "all").replace(/\s/g, "");
    return array(records).filter(record => {
      if (!record) return false;
      if (variation !== "all" && text(record.variation) !== variation) return false;
      if (difficulty !== "all" && text(record.difficulty).toLowerCase() !== difficulty) return false;
      const recordProvenance = normalizedWords(record.provenance).replace(/\s/g, "");
      if (provenance !== "all" && recordProvenance !== provenance) return false;
      if (selected.openingOnly && !record.isOpeningPuzzle) return false;
      if (!themeMatches(record.themes, selected.theme)) return false;
      if (lineCoverage === "main-lines" && !isMainLine(record)) return false;
      if (lineCoverage === "sidelines" && isMainLine(record)) return false;
      return true;
    });
  }

  function recordSort(left, right) {
    const leftDifficulty = DIFFICULTY_ORDER.indexOf(text(left.difficulty).toLowerCase());
    const rightDifficulty = DIFFICULTY_ORDER.indexOf(text(right.difficulty).toLowerCase());
    const leftRank = leftDifficulty < 0 ? DIFFICULTY_ORDER.length : leftDifficulty;
    const rightRank = rightDifficulty < 0 ? DIFFICULTY_ORDER.length : rightDifficulty;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const ratingDifference = number(left.rating, Number.MAX_SAFE_INTEGER)
      - number(right.rating, Number.MAX_SAFE_INTEGER);
    if (ratingDifference) return ratingDifference;
    return text(left.id || left.puzzle_id).localeCompare(text(right.id || right.puzzle_id));
  }

  function curriculumOrder(records) {
    const groups = new Map();
    array(records).forEach(record => {
      const group = curriculumGroup(record);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(record);
    });
    groups.forEach(items => items.sort(recordSort));
    const names = CARO_CURRICULUM_ORDER.filter(name => groups.has(name));
    [...groups.keys()].sort().forEach(name => {
      if (!names.includes(name)) names.push(name);
    });
    const ordered = [];
    let added = true;
    while (added) {
      added = false;
      names.forEach(name => {
        const items = groups.get(name);
        if (items && items.length) {
          ordered.push(items.shift());
          added = true;
        }
      });
    }
    return ordered;
  }

  function variationNames(manifest, records) {
    const names = new Set(Object.keys(object(manifest && manifest.variationCounts)));
    array(records).forEach(record => {
      if (record && text(record.variation)) names.add(text(record.variation));
    });
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  function themeNames(manifest, records) {
    const names = new Set(Object.keys(object(manifest && manifest.themeCounts)));
    array(records).forEach(record => array(record && record.themes).forEach(theme => names.add(text(theme))));
    return [...names].filter(Boolean).sort((left, right) => left.localeCompare(right));
  }

  return Object.freeze({
    DEFAULT_DECK_ID,
    DEFAULT_CARO_CONFIG,
    CARO_TAG,
    DIFFICULTY_ORDER,
    CURRICULUM_ORDER: CARO_CURRICULUM_ORDER,
    safeRelativePath,
    normalizeDeck,
    normalizeCatalog,
    isPersonalBlunderDeck,
    matchesOpeningRoot,
    matchingOpeningTags,
    hasCaroKannTag,
    primaryVariationTag,
    readableVariation,
    normalizeManifest,
    normalizeSelectionIndex,
    adaptRecord,
    adaptPersonalBlunderRecord,
    curriculumGroup,
    isMainLine,
    themeMatches,
    filterRecords,
    curriculumOrder,
    variationNames,
    themeNames,
  });
}));
