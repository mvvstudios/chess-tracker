(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.ChessTrackerUI = factory(root);
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function escapeHtml(value) {
    return String(value).replace(/[&"'<>]/g, character => ({
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
      "<": "&lt;",
      ">": "&gt;",
    })[character]);
  }

  function makeBoard(element, config) {
    const factory = (root.ChessgroundLib || {}).Chessground;
    if (!factory) {
      if (root.console && typeof root.console.error === "function") {
        root.console.error("Chessground not loaded");
      }
      return null;
    }
    const reducedMotion = root.matchMedia
      && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const defaults = {
      coordinates: true,
      animation: { enabled: !reducedMotion, duration: reducedMotion ? 0 : 150 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: false },
    };
    return factory(element, Object.assign({}, defaults, config));
  }

  return Object.freeze({
    makeBoard,
    escapeHtml,
  });
}));
