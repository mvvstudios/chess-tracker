(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CaroKannDomain = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CARO_TAG = "Caro-Kann_Defense";
  const DIFFICULTY_ORDER = Object.freeze([
    "beginner", "developing", "intermediate", "advanced", "expert",
  ]);
  const CURRICULUM_ORDER = Object.freeze([
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

  function hasCaroKannTag(tag) {
    const value = text(tag);
    return value === CARO_TAG || value.startsWith(CARO_TAG + "_");
  }

  function primaryVariationTag(tags) {
    return array(tags)
      .map(text)
      .filter(hasCaroKannTag)
      .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] || "";
  }

  function readableVariation(tag) {
    const value = text(tag);
    if (!hasCaroKannTag(value)) return "Caro-Kann Defense";
    const suffix = value.slice(CARO_TAG.length).replace(/^_/, "");
    if (!suffix) return "Caro-Kann Defense";
    return "Caro-Kann Defense: " + suffix.replace(/_/g, " ");
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

  function normalizeManifest(rawManifest) {
    const raw = object(rawManifest);
    const chunks = array(raw.chunks).map((entry, index) => {
      if (typeof entry === "string") {
        return { path: entry, count: null, index };
      }
      const item = object(entry);
      const path = text(item.path || item.file || item.url);
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

    return {
      raw,
      name: text(raw.datasetName || raw.name || "Caro-Kann Puzzles for Black"),
      schemaVersion: text(raw.schemaVersion || raw.schema_version || ""),
      generatedAt: text(raw.generatedAtUtc || raw.generatedAt || raw.generated_at || ""),
      balancedExported,
      chunks,
      variationCounts: balancedCountMap(raw, "variation", ["variationCounts", "variation_counts"], ["variation", "variations"]),
      difficultyCounts: balancedCountMap(raw, "difficulty", ["difficultyCounts", "difficulty_counts"], ["difficulty", "difficulties"]),
      provenanceCounts: balancedCountMap(raw, "provenance", ["provenanceCounts", "provenance_counts"], ["provenance", "sources"]),
      themeCounts: balancedCountMap(raw, "theme", ["themeCounts", "theme_counts"], ["theme", "themes"]),
    };
  }

  function sideFromFen(fen) {
    return text(fen).split(/\s+/)[1] || "";
  }

  function adaptRecord(rawRecord) {
    const record = object(rawRecord);
    const id = text(record.id || record.puzzleId || record.puzzle_id);
    const originalFen = text(record.originalFen || record.original_fen);
    const puzzleFen = text(record.puzzleFen || record.puzzle_fen);
    const openingTags = array(record.openingTags || record.opening_tags).map(text).filter(Boolean);
    const tag = primaryVariationTag(openingTags);
    const sideToMove = text(record.sideToMove || record.side_to_move).toLowerCase();
    const orientation = text(record.orientation).toLowerCase();
    const rawSteps = array(record.solutionSteps || record.solution_steps);
    const firstRawStep = object(rawSteps[0]);
    const firstFen = rawSteps.length
      ? text(firstRawStep.fenBefore || firstRawStep.fen_before)
      : "";
    if (!id || !tag || !originalFen || sideFromFen(originalFen) !== "w"
        || !puzzleFen || sideFromFen(puzzleFen) !== "b"
        || sideToMove !== "black" || orientation !== "black" || !rawSteps.length
        || firstFen !== puzzleFen) {
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
    const variation = text(record.variation) || readableVariation(tag);

    return Object.assign({}, record, {
      id,
      puzzle_id: id,
      openingTags,
      primaryVariationTag: tag,
      variation,
      originalFen,
      puzzleFen,
      fen_before: puzzleFen,
      sideToMove: "black",
      side_to_move: "black",
      side: "black",
      user_color: "black",
      orientation: "black",
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

  function normalizedWords(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function curriculumGroup(variation) {
    const words = normalizedWords(variation);
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

  function isMainLine(record) {
    return curriculumGroup(record && record.variation) !== "Rare sidelines and gambits";
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
      if (mode === "main-lines" && !isMainLine(record)) return false;
      if (mode === "sidelines" && isMainLine(record)) return false;
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
      const group = curriculumGroup(record && record.variation);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(record);
    });
    groups.forEach(items => items.sort(recordSort));
    const names = CURRICULUM_ORDER.filter(name => groups.has(name));
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
    CARO_TAG,
    DIFFICULTY_ORDER,
    CURRICULUM_ORDER,
    hasCaroKannTag,
    primaryVariationTag,
    readableVariation,
    normalizeManifest,
    adaptRecord,
    curriculumGroup,
    isMainLine,
    themeMatches,
    filterRecords,
    curriculumOrder,
    variationNames,
    themeNames,
  });
}));
