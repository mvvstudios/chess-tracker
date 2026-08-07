// dashboard/app.js
// Trust boundary: leak.evidence, leak.suggested_action, rule.narrative,
// and suggested_entry.title are server-constructed in metrics.py from
// numeric inputs and hardcoded f-strings — safe to inline into HTML.
// game_url comes from Chess.com's API — escape before inlining.
(function() {
  const escapeAttr = s => String(s).replace(/[&"<>]/g,
    c => ({"&":"&amp;","\"":"&quot;","<":"&lt;",">":"&gt;"}[c]));

  function makeBoard(el, cfg) {
    const factory = (window.ChessgroundLib || {}).Chessground;
    if (!factory) { console.error("Chessground not loaded"); return null; }
    const reducedMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const defaults = {
      coordinates: true,
      animation: { enabled: !reducedMotion, duration: reducedMotion ? 0 : 150 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: false },
    };
    return factory(el, Object.assign({}, defaults, cfg));
  }

  // Small shared UI surface for page-specific controllers. Keeping the board
  // factory here ensures every page uses the same Chessground defaults and
  // reduced-motion behavior without introducing a frontend framework.
  window.ChessTrackerUI = Object.freeze({
    makeBoard,
    escapeHtml: escapeAttr,
  });

  const D = window.DATA;
  if (!D) {
    document.body.innerHTML = "<p style='padding:2rem'>No data. Run refresh.py.</p>";
    return;
  }
  renderKPI(D);
  renderLichessKPI(D);
  renderPlanBlock(D.plan_compliance);
  renderStudyRecommendations(D.study_recommendations);
  renderMoveQuality(D.move_quality);
  renderMoveQualityByFormat(D.move_quality_by_format, D.format, D.move_quality_by_time_control);
  renderFamilyBlock(D.opening_families, "white",
    "#white-families-table", "white-board", "white-board-meta", false);
  renderFamilyBlock(D.opening_families, "black",
    "#black-families-table", "black-board", "black-board-meta", true);
  renderBehavior(D.behavior);
  renderLeaks(D.leak_summary);
  renderRecentLosses(D.recent_losses);
  renderPuzzleDrill(D.recent_losses);
  renderLossSummary(D);
  renderReviewPicks(D.review_picks);
  renderErrorLog(D.error_log);
  renderProcess(D.process_metrics);
  renderSessionDecay(D.process_metrics?.session_decay);
  renderOpeningDetail(D);
  renderOpponentOpenings(D.opponent_openings);
  renderTrapExposures(D.trap_exposures, D.trap_exposure_audit);
  renderBlunderPhases(D.blunder_phases, D.engine_coverage);
  renderBlunderAnalysis(D.blunder_analysis);
  renderMistakeAnalysis(D.mistake_analysis);
  renderSessions(D.sessions);
  renderDrillinCards(D);

  function renderKPI(d) {
    const strip = document.getElementById("kpi-strip");
    if (!strip) return;
    const k = d.kpis;
    const lastDelta = (d.sessions && d.sessions.length > 0)
      ? d.sessions[d.sessions.length - 1].rating_delta
      : null;
    const lastStr = lastDelta == null ? "—" : (lastDelta >= 0 ? "+" : "") + lastDelta;

    const FMT_ORDER  = ["bullet", "blitz", "rapid", "daily"];
    const FMT_LABELS = {bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", daily: "Daily"};
    const byControl = Array.isArray(d.ratings_by_time_control)
      ? d.ratings_by_time_control.filter(item => item && item.label && item.rating != null)
      : [];
    const byFmt = d.ratings_by_format || {};
    const avail = FMT_ORDER.filter(f => byFmt[f] != null);
    const ratingHtml = byControl.length
      ? byControl.map(item =>
          `<div class="kpi${item.format === d.format ? " kpi-active" : ""}">` +
          `<span class="kpi-label kpi-rating-label">${escapeAttr(item.label)}</span>` +
          `<span class="kpi-value">${escapeAttr(item.rating)}</span></div>`
        ).join('')
      : avail.length
      ? avail.map(f =>
          `<div class="kpi${f === d.format ? " kpi-active" : ""}">` +
          `<span class="kpi-label">${FMT_LABELS[f]}</span>` +
          `<span class="kpi-value">${byFmt[f]}</span></div>`
        ).join('')
      : `<div class="kpi kpi-active"><span class="kpi-label">Rating</span>` +
        `<span class="kpi-value">${k.current_rating ?? "—"}</span></div>`;

    const hasDedicatedLichessStrip = document.getElementById("lichess-strip") != null;
    const pageName = window.location.pathname.split("/").pop();
    const puzzlesActive = pageName === "puzzles.html";
    const trainerActive = pageName === "trainer.html"
      || pageName === "caro-kann-puzzles.html";
    const profileLinks = `
      <div class="strip-profile-links">
        <a class="strip-platform-label" href="https://www.chess.com/member/M_V-V" target="_blank" rel="noopener">Chess.com</a>
        ${hasDedicatedLichessStrip ? "" : `<a class="strip-platform-label" href="https://lichess.org/@/M_V-v" target="_blank" rel="noopener">Lichess</a>`}
      </div>
      <a class="strip-nav-link${puzzlesActive ? " active" : ""}" href="puzzles.html"
         ${puzzlesActive ? 'aria-current="page"' : ""}>Puzzles</a>
      <a class="strip-nav-link${trainerActive ? " active" : ""}" href="trainer.html"
         ${trainerActive ? 'aria-current="page"' : ""}>Chess Opening Puzzle Trainer</a>`;
    const kpiHtml = `
      ${profileLinks}
      <div class="kpi kpi-sep"></div>
      ${ratingHtml}
      <div class="kpi kpi-sep"></div>
      <div class="kpi"><span class="kpi-label">Games</span>
        <span class="kpi-value">${k.games_total}</span></div>
      <div class="kpi"><span class="kpi-label">Recent form</span>
        <span class="kpi-value${k.recent_form_win_pct >= 50 ? " accent" : ""}">${k.recent_form_win_pct}%</span></div>
      <div class="kpi"><span class="kpi-label">Last session</span>
        <span class="kpi-value">${lastStr}</span></div>
      <div class="kpi"><span class="kpi-label">Updated</span>
        <span class="kpi-value" style="font-size:0.9rem">${new Date(d.generated_at).toLocaleString()}</span></div>
      <a class="refresh-link"
         href="https://github.com/mvvstudios/chess-tracker/actions/workflows/deploy.yml"
         target="_blank" rel="noopener"
         title="Re-run the deploy workflow on GitHub Actions to rebuild this dashboard now">↻ Refresh</a>
    `;
    const homeLink = strip.querySelector(".home-link");
    (homeLink || strip).insertAdjacentHTML(homeLink ? "afterend" : "afterbegin", kpiHtml);
  }

  function renderLichessKPI(d) {
    const strip = document.getElementById("lichess-strip");
    if (!strip || !d.lichess) return;
    const L = d.lichess;
    const FMT_ORDER  = ["bullet", "blitz", "rapid", "classical"];
    const FMT_LABELS = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical" };
    const ratingHtml = FMT_ORDER
      .filter(f => L[f] != null)
      .map(f =>
        `<div class="kpi">` +
        `<span class="kpi-label">${FMT_LABELS[f]}</span>` +
        `<span class="kpi-value">${L[f]}</span></div>`
      ).join("");
    const puzzleHtml = L.puzzle_score != null
      ? `<div class="kpi"><span class="kpi-label">Puzzles</span>` +
        `<span class="kpi-value">${L.puzzle_score}</span></div>`
      : "";
    const gamesHtml = L.game_count != null
      ? `<div class="kpi"><span class="kpi-label">Games</span>` +
        `<span class="kpi-value">${L.game_count}</span></div>`
      : "";
    strip.insertAdjacentHTML("beforeend",
      `<a class="lichess-label" href="https://lichess.org/@/M_V-v" target="_blank" rel="noopener">Lichess</a>` +
      `<div class="kpi kpi-sep"></div>` +
      ratingHtml + puzzleHtml + gamesHtml
    );
    strip.style.display = "";
  }

  // Move quality — engine-derived accuracy/blunders for the current format.
  // Only renders on index.html (where #move-quality-cards exists). All values
  // are server-computed numbers from analysis.aggregate_move_quality — safe to
  // inline. `mq` is null when no engine ran (e.g. --no-analysis).
  function renderMoveQuality(mq) {
    const root = document.getElementById("move-quality-cards");
    if (!root) return;
    if (!mq) {
      root.innerHTML =
        `<p class="mq-empty">Run refresh.py with Stockfish to see move quality.</p>`;
      return;
    }
    const cell = (label, value, sub, alert = false) =>
      `<div class="behavior-card${alert ? " alert" : ""}">
         <div class="bh-label">${label}</div>
         <div class="bh-value">${value}</div>
         <div class="bh-sub">${sub}</div>
       </div>`;
    const ph = mq.acpl_by_phase || {};
    const phSub = ["opening", "middlegame", "endgame"]
      .filter(p => ph[p] != null)
      .map(p => `${p.slice(0, 3)} ${ph[p]}`)
      .join(" · ") || "—";
    root.innerHTML = [
      cell("Accuracy", `${mq.accuracy}%`,
        `${mq.games_analyzed} games · ${mq.moves_analyzed} moves`),
      cell("Blunders / 100 moves", `${mq.blunders_per_100_moves}`,
        `${mq.blunders}B · ${mq.mistakes}M · ${mq.inaccuracies}I`,
        mq.blunders_per_100_moves >= 5),
      cell("Avg cp lost / move", `${mq.avg_cp_loss}`, phSub),
    ].join("");
  }

  // Cross-format comparison — one row per time class that has data. Hidden
  // when fewer than two formats are available (nothing to compare). Values are
  // server-computed numbers; current format is highlighted.
  function renderMoveQualityByFormat(byFmt, currentFmt, byControl) {
    const section = document.getElementById("move-quality-by-format");
    const root = document.getElementById("mqf-table");
    if (!section || !root) return;
    const controlRows = Array.isArray(byControl)
      ? byControl.filter(row => row && row.label && row.summary)
      : [];
    if (controlRows.length >= 2) {
      const body = controlRows.map(row => {
        const m = row.summary;
        const cur = row.format === currentFmt;
        return `<tr${cur ? ' class="mqf-current"' : ""}>
          <td>${escapeAttr(row.label)}${cur ? " ◂" : ""}</td>
          <td>${m.accuracy}%</td>
          <td>${m.blunders_per_100_moves}</td>
          <td>${m.avg_cp_loss}</td>
          <td>${m.games_analyzed}</td></tr>`;
      }).join("");
      root.innerHTML = `<table class="mqf-table">
        <thead><tr><th>Format</th><th>Accuracy</th><th>Blunders/100</th>
          <th>Avg cp lost</th><th>Games</th></tr></thead>
        <tbody>${body}</tbody></table>`;
      return;
    }

    const order = ["bullet", "blitz", "rapid", "daily"];
    const rows = order.filter(f => byFmt && byFmt[f]);
    if (rows.length < 2) { section.style.display = "none"; return; }
    const body = rows.map(f => {
      const m = byFmt[f];
      const cur = f === currentFmt;
      return `<tr${cur ? ' class="mqf-current"' : ""}>
        <td>${f}${cur ? " ◂" : ""}</td>
        <td>${m.accuracy}%</td>
        <td>${m.blunders_per_100_moves}</td>
        <td>${m.avg_cp_loss}</td>
        <td>${m.games_analyzed}</td></tr>`;
    }).join("");
    root.innerHTML = `<table class="mqf-table">
      <thead><tr><th>Format</th><th>Accuracy</th><th>Blunders/100</th>
        <th>Avg cp lost</th><th>Games</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  // Plan & adherence — only renders on index.html where the section exists.
  // Each prep opening shows adherence over the last N games + win-rate
  // comparison (on-plan vs deviated). Severity coloring matches the leaks
  // palette (severity-green / severity-yellow / severity-red / severity-neutral).
  function renderPlanBlock(pc) {
    const root = document.getElementById("plan-openings");
    if (!root || !pc) return;
    const openings = pc.openings || [];
    if (openings.length === 0) {
      root.innerHTML = `<p style="color:var(--muted)">No openings in plan. Edit chess_tracker/plan.json to add some.</p>`;
    } else {
      const sideRank = (o) => (o.side === "black" ? 0 : 1);
      const ordered = [...openings].sort((a, b) => sideRank(a) - sideRank(b));
      let lastSide = null;
      const cardsHtml = ordered.map((o, i) => {
        let prefix = "";
        if (o.side !== lastSide) {
          prefix += `<h3 class="plan-side-header">${o.side === "black" ? "As Black" : "As White"}</h3>`;
        }
        lastSide = o.side;
        const vs = o.vs_first_move ? `vs 1.${o.vs_first_move}` : `as ${o.side}`;
        const won = o.win_pct_when_played;
        const dev = o.win_pct_when_deviated;
        const wonStr = won == null ? "—" : `${won}%`;
        const devStr = dev == null ? "—" : `${dev}%`;
        const deltaNote = (won != null && dev != null)
          ? ` <span class="plan-delta">(${won >= dev ? "+" : ""}${(won - dev).toFixed(1)}pp on plan)</span>`
          : "";
        return `
          ${prefix}
          <div class="plan-card severity-${o.severity}">
            <div class="plan-head">
              <span class="plan-vs">${vs}</span>
              <span class="plan-name">${o.name}</span>
              <span class="plan-adherence">${o.adherence_pct}% adherence</span>
            </div>
            <div class="plan-counts">
              ${o.games_on_plan} of ${o.applicable_games} games played on plan
            </div>
            ${(o.gambit_breakdown && Object.keys(o.gambit_breakdown).length)
              ? `<div class="plan-gambits">of on-plan: ${
                  Object.entries(o.gambit_breakdown)
                    .map(([k, v]) => `${v} ${k}`).join(" · ")}</div>`
              : ""}
            <div class="plan-winrates">
              Win when played: <strong>${wonStr}</strong>
              · Win when deviated: <strong>${devStr}</strong>
              ${deltaNote}
            </div>
            <details class="plan-detail">
              <summary>Show moves &amp; plan</summary>
              ${(o.board_lines && o.board_lines.length
                  ? o.board_lines
                  : [{ moves: o.moves, fens: o.fens, ply_labels: o.ply_labels }]
                ).map((bl, j) => `
                ${bl.label ? `<div class="plan-line-label">${bl.label}</div>` : ""}
                <code class="plan-moves">${bl.moves || "—"}</code>
                ${(bl.fens && bl.fens.length > 1) ? `
                <div class="plan-board-wrap">
                  <div id="plan-board-${i}-${j}" class="board-large plan-board"></div>
                  <div class="plan-board-controls">
                    <button type="button" class="plan-step" id="plan-prev-${i}-${j}" aria-label="Previous move">◀</button>
                    <span class="plan-board-cap" id="plan-cap-${i}-${j}"></span>
                    <button type="button" class="plan-step" id="plan-next-${i}-${j}" aria-label="Next move">▶</button>
                  </div>
                </div>` : ""}
              `).join("")}
              <p class="plan-plan">${o.plan || ""}</p>
            </details>
          </div>
        `;
      }).join("");
      root.innerHTML = cardsHtml;
      // Wire up each card's move-by-move board. State (current ply) lives in
      // this closure per card; the board uses Chessground, updated by swapping
      // FENs. Black-defense lines render from Black's perspective.
      ordered.forEach((o, i) => {
        const flip = o.side === "black";
        const lines = (o.board_lines && o.board_lines.length)
          ? o.board_lines
          : [{ fens: o.fens, ply_labels: o.ply_labels }];
        lines.forEach((bl, j) => {
          const fens = bl.fens || [];
          if (fens.length < 2) return;
          const labels = bl.ply_labels || [];
          const boardEl = document.getElementById(`plan-board-${i}-${j}`);
          const capEl = document.getElementById(`plan-cap-${i}-${j}`);
          const prevEl = document.getElementById(`plan-prev-${i}-${j}`);
          const nextEl = document.getElementById(`plan-next-${i}-${j}`);
          if (!boardEl) return;
          let idx = fens.length - 1;  // open on the final position of the line
          // Initialize Chessground for this board on first paint
          if (!boardEl._cg) {
            boardEl._cg = makeBoard(boardEl, {
              viewOnly: true,
              orientation: flip ? 'black' : 'white',
            });
          }
          const paint = () => {
            if (boardEl._cg) boardEl._cg.set({ fen: fens[idx] });
            capEl.textContent = idx === 0
              ? "Start position"
              : `after ${labels[idx - 1]} · move ${idx} of ${fens.length - 1}`;
            prevEl.disabled = idx === 0;
            nextEl.disabled = idx === fens.length - 1;
          };
          prevEl.addEventListener("click", () => { if (idx > 0) { idx--; paint(); } });
          nextEl.addEventListener("click", () => { if (idx < fens.length - 1) { idx++; paint(); } });
          queueMicrotask(paint);
          // Force Chessground to re-measure when <details> is first opened
          const detailsEl = boardEl.closest("details");
          if (detailsEl) {
            detailsEl.addEventListener("toggle", function onToggle() {
              if (detailsEl.open && boardEl._cg) {
                boardEl._cg.redrawAll();
                detailsEl.removeEventListener("toggle", onToggle);
              }
            });
          }
        });
      });
    }
  }

  function renderStudyRecommendations(recommendations) {
    const root = document.getElementById("study-next-cards");
    if (!root) return;
    const rows = recommendations || [];
    if (rows.length === 0) {
      root.innerHTML = `<p style="color:var(--muted)">No urgent study item.</p>`;
      return;
    }
    const severityClass = s => {
      const v = String(s || "neutral");
      return ["green", "yellow", "red", "neutral"].includes(v) ? v : "neutral";
    };
    root.innerHTML = rows.map(r => {
      const href = r.href
        ? `<a class="drill-link" href="${escapeAttr(r.href)}">Open drill-in</a>`
        : "";
      return `
        <div class="plan-card severity-${severityClass(r.severity)}">
          <div class="plan-head">
            <span class="plan-vs">Coach pick</span>
            <span class="plan-name">${escapeAttr(r.title || "Study item")}</span>
          </div>
          <div class="plan-counts">${escapeAttr(r.reason || "")}</div>
          <p class="plan-plan">${escapeAttr(r.action || "")}</p>
          ${href ? `<div class="plan-counts">${href}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function renderLeaks(leaks) {
    const root = document.getElementById("leak-list");
    if (!root) return;
    if (!leaks || leaks.length === 0) {
      root.innerHTML = `<p style="color:var(--muted)">No leaks detected in the last 30 games.</p>`;
      return;
    }
    root.innerHTML = leaks.map(L => `
      <div class="leak severity-${L.severity}">
        <div class="leak-name">${L.name.replace(/_/g, " ")}</div>
        <div class="leak-evidence">${L.evidence}</div>
        <div class="leak-action">→ ${L.suggested_action}</div>
      </div>
    `).join("");
  }

  function renderRecentLosses(losses) {
    if (!document.getElementById("losses-table")) return;
    new Tabulator("#losses-table", {
      data: losses, layout: "fitDataStretch", pagination: false,
      columns: [
        {title: "Opening", field: "opening", widthGrow: 2},
        {title: "Loss", field: "loss_type"},
        {title: "Moves", field: "moves", sorter: "number"},
        {title: "Clock", field: "final_clock", sorter: "number"},
        {title: "OppΔ", field: "opp_rating_diff", sorter: "number"},
        {title: "Suggested entry", field: "suggested_entry",
         formatter: c => c.getValue().title, widthGrow: 3},
        {title: "Game", field: "game_url",
         formatter: c => `<a href="${escapeAttr(c.getValue())}" target="_blank">open</a>`},
      ],
    });
    const copyBtn = document.getElementById("copy-suggestions");
    if (losses.length === 0) {
      copyBtn.style.display = "none";
      return;
    }
    copyBtn.onclick = () => {
      const entries = losses.map(L => L.suggested_entry);
      const payload = JSON.stringify(entries, null, 2);
      navigator.clipboard.writeText(payload)
        .catch(() => { console.log(payload); alert("Copy failed — payload logged to console."); });
    };
  }

  // ---- Guided puzzle drill (losses.html) --------------------------------
  // Each loss carries a precomputed `puzzle` (chess_tracker/puzzles.py): the
  // position just before my worst move, my move, and the engine's better move.
  // The board accepts ONLY the engine move; anything else is "the kind of move
  // that lost the game" and reveals the answer. Chessground handles move
  // legality via the dests map — no move generator or engine needed in the browser.
  function renderPuzzleDrill(losses) {
    const root = document.getElementById("puzzle-drill");
    if (!root) return;
    const puzzles = (losses || []).filter(L => L.puzzle);
    if (puzzles.length === 0) {
      root.innerHTML = `<p class="puzzle-empty">No puzzles yet — run refresh.py with Stockfish installed.</p>`;
      return;
    }
    root.innerHTML = `
      <div class="puzzle-list" id="puzzle-list"></div>
      <div class="puzzle-stage">
        <div class="puzzle-board" id="puzzle-board"></div>
        <div class="puzzle-side">
          <div class="puzzle-prompt" id="puzzle-prompt"></div>
          <div class="puzzle-feedback" id="puzzle-feedback"></div>
          <div class="puzzle-controls">
            <button id="puzzle-show">Show answer</button>
            <button id="puzzle-reset">Reset</button>
          </div>
        </div>
      </div>`;

    const listEl = document.getElementById("puzzle-list");
    const boardEl = document.getElementById("puzzle-board");
    const promptEl = document.getElementById("puzzle-prompt");
    const fbEl = document.getElementById("puzzle-feedback");
    listEl.innerHTML = puzzles.map((L, i) => {
      const p = L.puzzle;
      return `<button class="puzzle-item" data-idx="${i}">
        <span class="pi-open">${escapeAttr(L.opening || "Unknown opening")}</span>
        <span class="pi-meta">${escapeAttr(L.loss_type)} · move ${p.fullmove}</span>
      </button>`;
    }).join("");

    const state = { puzzle: null, solved: false };

    // Initialize puzzle board once
    boardEl._cg = makeBoard(boardEl, {
      viewOnly: false,
      drawable: { enabled: true, visible: true },
      movable: {
        free: false,
        events: { after: handleMove },
      },
    });

    function handleMove(orig, dest) {
      if (state.solved || !state.puzzle) return;
      const best = state.puzzle.best_move_uci;
      const uci = orig + dest;
      if (uci === best || uci === best.slice(0, 4)) {
        // Correct: Chessground already moved the piece visually
        state.solved = true;
        fbEl.innerHTML = `<span class="ok">✓ Correct — ${escapeAttr(state.puzzle.best_move_san)} holds the position.</span>`;
      } else {
        // Wrong: reset board to pre-move FEN, draw answer arrow
        if (boardEl._cg) {
          boardEl._cg.set({ fen: state.puzzle.fen_before });
          boardEl._cg.setShapes([{
            orig: best.slice(0, 2),
            dest: best.slice(2, 4),
            brush: 'green',
          }]);
        }
        fbEl.innerHTML =
          `<span class="bad">✗ That's the kind of move that lost the game.</span> ` +
          `The move that holds was <strong>${escapeAttr(state.puzzle.best_move_san)}</strong>.`;
      }
    }

    function select(i) {
      const p = puzzles[i].puzzle;
      state.puzzle = p;
      state.solved = false;
      listEl.querySelectorAll(".puzzle-item").forEach(b =>
        b.classList.toggle("active", +b.dataset.idx === i));
      promptEl.innerHTML =
        `<strong>${p.side === "white" ? "White" : "Black"} to move.</strong> ` +
        `You played <span class="bad">${escapeAttr(p.my_move_san)}</span> here — find the move that holds.`;
      fbEl.innerHTML = "";
      if (boardEl._cg) {
        boardEl._cg.set({
          fen: p.fen_before,
          orientation: p.side === "black" ? "black" : "white",
          movable: {
            color: p.side,
            dests: new Map(Object.entries(p.legal_dests || {})),
          },
          lastMove: undefined,
          check: false,
        });
        boardEl._cg.setShapes([]);
      }
    }

    function currentIdx() {
      const active = listEl.querySelector(".puzzle-item.active");
      return active ? +active.dataset.idx : 0;
    }

    listEl.addEventListener("click", (e) => {
      const b = e.target.closest(".puzzle-item");
      if (b) select(+b.dataset.idx);
    });
    document.getElementById("puzzle-show").onclick = () => {
      if (!state.solved && state.puzzle) {
        const best = state.puzzle.best_move_uci;
        if (boardEl._cg) boardEl._cg.setShapes([{
          orig: best.slice(0, 2),
          dest: best.slice(2, 4),
          brush: 'green',
        }]);
      }
      if (state.puzzle) {
        fbEl.innerHTML = `Best move: <strong>${escapeAttr(state.puzzle.best_move_san)}</strong>.`;
      }
    };
    document.getElementById("puzzle-reset").onclick = () => select(currentIdx());

    queueMicrotask(() => select(0));
  }

  function renderErrorLog(rows) {
    if (!document.getElementById("error-log-table")) return;
    new Tabulator("#error-log-table", {
      data: rows, layout: "fitDataStretch",
      placeholder: "No entries yet. Paste from suggestions above into data/annotations.json.",
      columns: [
        {title: "Title", field: "title"},
        {title: "Pattern", field: "pattern"},
        {title: "# Games", field: "game_refs",
         formatter: c => (c.getValue() || []).length, sorter: "number"},
        {title: "Created", field: "created"},
      ],
    });
  }

  function renderProcess(pm) {
    if (!document.getElementById("process-block")) return;
    const fmt = v => v === null || v === undefined ? "—" : v;
    document.getElementById("process-block").innerHTML = `
      <div class="process-grid">
        <div class="process-card"><div class="pm-label">Reserve @ move 10 (median)</div><div class="pm-value">${fmt(pm.reserve_move_10_median)}s</div></div>
        <div class="process-card"><div class="pm-label">Reserve @ move 20 (median)</div><div class="pm-value">${fmt(pm.reserve_move_20_median)}s</div></div>
        <div class="process-card"><div class="pm-label">Opening velocity (median s on my first 8 moves)</div><div class="pm-value">${fmt(pm.opening_velocity_median)}s</div></div>
        <div class="process-card"><div class="pm-label">Time-burn delta (early − late)</div><div class="pm-value">${fmt(pm.time_burn_delta)}</div></div>
        <div class="process-card"><div class="pm-label">Outlasted-but-flagged</div><div class="pm-value">${pm.outlasted_but_flagged_count}</div></div>
      </div>
    `;
  }

  function renderSessionDecay(rows) {
    if (!document.getElementById("session-decay-table")) return;
    new Tabulator("#session-decay-table", {
      data: rows, layout: "fitColumns",
      columns: [
        {title: "Games in session", field: "bucket"},
        {title: "N", field: "games", sorter: "number"},
        {title: "Win%", field: "win_pct", sorter: "number", formatter: winPctCell},
        {title: "Flag%", field: "flag_pct", sorter: "number"},
        {title: "Mate%", field: "mate_pct", sorter: "number"},
      ],
    });
  }

  // Tier-1 family block on index.html — table + board panel. One row per
  // (family, color). Click row to update the board to the family's canonical
  // (most-played) position. Double-click row, or click "→ View variations"
  // in the meta panel, to drill into opening.html.
  function renderFamilyBlock(families, color, tableSelector, boardId, metaId, flip) {
    if (!document.querySelector(tableSelector)) return;
    const all = (families || []).filter(r => r.color === color);
    const rows = all.filter(r => !r.is_rare);
    const rare = all.filter(r => r.is_rare);
    let rareRowData = null;
    if (rare.length > 0) {
      const totalGames = rare.reduce((s, r) => s + r.games, 0);
      const totalDelta = rare.reduce((s, r) => s + r.sum_rating_delta, 0);
      const totalWins   = rare.reduce((s, r) => s + (r.wins   || 0), 0);
      const totalLosses = rare.reduce((s, r) => s + (r.losses || 0), 0);
      const approxFlags = rare.reduce((s, r) => s + Math.round((r.flag_pct || 0) / 100 * (r.losses || 0)), 0);
      const approxMates = rare.reduce((s, r) => s + Math.round((r.mate_pct || 0) / 100 * (r.losses || 0)), 0);
      rareRowData = {
        family: "Rare Openings",
        _is_rare_header: true,
        games: totalGames,
        sum_rating_delta: totalDelta,
        win_pct:  totalGames   > 0 ? Math.round(1000 * totalWins   / totalGames)   / 10 : null,
        flag_pct: totalLosses  > 0 ? Math.round(1000 * approxFlags / totalLosses)  / 10 : null,
        mate_pct: totalLosses  > 0 ? Math.round(1000 * approxMates / totalLosses)  / 10 : null,
        variation_count: rare.length, form: [], plan_status: null, color,
      };
    }

    const table = new Tabulator(tableSelector, {
      data: rareRowData ? [...rows, rareRowData] : rows,
      layout: "fitColumns", maxHeight: "540px",
      headerWordWrap: true,
      rowFormatter: row => {
        if (row.getData()._is_rare_header) {
          const el = row.getElement();
          el.style.color = "var(--muted, #888)";
          el.style.cursor = "pointer";
          el.style.borderTop = "1px solid rgba(255,255,255,.06)";
        }
      },
      columns: [
        {title: "Opening", field: "family", width: 210, minWidth: 160},
        {title: "Games", field: "games", width: 68, minWidth: 68, sorter: "number"},
        {title: "Δ Rating", field: "sum_rating_delta", width: 90, minWidth: 90, sorter: "number", formatter: ratingDeltaCell},
        {title: "Win%", field: "win_pct", width: 62, minWidth: 62, sorter: "number", formatter: winPctCell},
        {title: "Flag%", field: "flag_pct", width: 65, minWidth: 65, sorter: "number"},
        {title: "Mate%", field: "mate_pct", width: 65, minWidth: 65, sorter: "number"},
        {title: "#Vars", field: "variation_count", width: 65, minWidth: 65, sorter: "number"},
        {title: "Form", field: "form", width: 88, minWidth: 80, formatter: sparkline, headerSort: false},
      ],
      initialSort: [{column: "sum_rating_delta", dir: "asc"}],
    });

    table.on("rowClick", (e, row) => {
      const d = row.getData();
      if (d._is_rare_header) {
        const tableEl = row.getElement().closest(".tabulator");
        if (tableEl) tableEl.querySelectorAll(".tabulator-row.row-selected").forEach(el => el.classList.remove("row-selected"));
        row.getElement().classList.add("row-selected");
        const meta = document.getElementById(metaId);
        if (meta) {
          const colorLabel = d.color.charAt(0).toUpperCase() + d.color.slice(1);
          meta.innerHTML = `
            <div class="name">Rare Openings</div>
            <div class="stats">${colorLabel} · ${d.variation_count} families</div>
            <dl class="detail">
              <div class="row"><span class="k">Games</span><span class="v">${d.games}</span></div>
              <div class="row"><span class="k">Win</span><span class="v">${d.win_pct  != null ? d.win_pct  + "%" : "—"}</span></div>
              <div class="row"><span class="k">Flag</span><span class="v">${d.flag_pct != null ? d.flag_pct + "%" : "—"}</span></div>
              <div class="row"><span class="k">Mate</span><span class="v">${d.mate_pct != null ? d.mate_pct + "%" : "—"}</span></div>
            </dl>
            <a class="drill-link" href="opening.html?rare=1&color=${encodeURIComponent(d.color)}">→ View ${d.variation_count} rare families</a>
          `;
        }
        return;
      }
      selectFamilyRow(row, boardId, metaId, flip);
    });
    table.on("rowDblClick", (e, row) => {
      const d = row.getData();
      if (d._is_rare_header) {
        window.location.href = `opening.html?rare=1&color=${encodeURIComponent(d.color)}`;
        return;
      }
      drillIntoFamily(d);
    });
    // Initialize the Chessground board for this side (view-only)
    const boardEl = document.getElementById(boardId);
    if (boardEl) boardEl._cg = makeBoard(boardEl, {
      viewOnly: true,
      orientation: flip ? 'black' : 'white',
    });
    table.on("tableBuilt", () => {
      const first = table.getRows().find(r => !r.getData()._is_rare_header);
      if (first) selectFamilyRow(first, boardId, metaId, flip);
    });
  }

  function selectFamilyRow(row, boardId, metaId, flip) {
    const tableEl = row.getElement().closest(".tabulator");
    if (tableEl) {
      tableEl.querySelectorAll(".tabulator-row.row-selected")
        .forEach(el => el.classList.remove("row-selected"));
    }
    row.getElement().classList.add("row-selected");
    updateFamilyBoard(row.getData(), boardId, metaId, flip);
  }

  function drillIntoFamily(d) {
    const qs = `family=${encodeURIComponent(d.family)}&color=${encodeURIComponent(d.color)}`;
    window.location.href = `opening.html?${qs}`;
  }

  function updateFamilyBoard(data, boardId, metaId, flip) {
    const board = document.getElementById(boardId);
    const meta = document.getElementById(metaId);
    if (!board || !meta) return;
    if (board._cg) board._cg.set({ fen: data.canonical_play_signature });
    const gap = data.rating_gap;
    const gapStr = gap == null ? "—" : (gap >= 0 ? "+" : "") + gap;
    const qs = `family=${encodeURIComponent(data.family)}&color=${encodeURIComponent(data.color)}`;
    meta.innerHTML = `
      <div class="name">${data.family}</div>
      <div class="stats">${data.color} · ECO ${data.eco} · ${data.variation_count} variation${data.variation_count === 1 ? "" : "s"}</div>
      <dl class="detail">
        <div class="row"><span class="k">Games</span><span class="v">${data.games}</span></div>
        <div class="row"><span class="k">Win</span><span class="v">${data.win_pct}%</span></div>
        <div class="row"><span class="k">Flag</span><span class="v">${data.flag_pct}%</span></div>
        <div class="row"><span class="k">Mate</span><span class="v">${data.mate_pct}%</span></div>
        <div class="row"><span class="k">Median len</span><span class="v">${data.med_len}</span></div>
        <div class="row"><span class="k">Avg opp</span><span class="v">${data.avg_opp_rating}</span></div>
        <div class="row"><span class="k">Δ opp</span><span class="v">${gapStr}</span></div>
      </dl>
      <a class="drill-link" href="opening.html?${qs}">→ View ${data.variation_count} variation${data.variation_count === 1 ? "" : "s"}</a>
    `;
  }

  // Tier-2 view on opening.html — one row per unique named variation within
  // one family-color combo. The board panel shows the canonical (most-played)
  // position for the selected variation. Reads ?family=...&color=... from
  // the URL and filters opening_variations.
  function renderOpeningDetail(D) {
    const tableEl = document.getElementById("opening-variations-table");
    if (!tableEl) return;
    const params = new URLSearchParams(window.location.search);
    const color = params.get("color");

    // ?rare=1&color=... → show all rare families for this color
    if (params.get("rare") === "1" && color) {
      const rareFamilies = (D.opening_families || [])
        .filter(r => r.is_rare && r.color === color);
      const colorLabel = color.charAt(0).toUpperCase() + color.slice(1);
      const title = document.getElementById("opening-title");
      if (title) title.textContent = `Rare Openings as ${colorLabel} — ${rareFamilies.length} families`;
      if (rareFamilies.length === 0) {
        tableEl.innerHTML = `<p style="padding:1rem;color:var(--muted)">No rare openings found for ${color}.</p>`;
        return;
      }
      const flip = color === "black";
      const openingBoardEl = document.getElementById("opening-board");
      if (openingBoardEl) openingBoardEl._cg = makeBoard(openingBoardEl, {
        viewOnly: true,
        orientation: flip ? 'black' : 'white',
      });
      const rareTable = new Tabulator("#opening-variations-table", {
        data: rareFamilies, layout: "fitColumns", maxHeight: "540px",
        headerWordWrap: true,
        columns: [
          {title: "Opening", field: "family", width: 210, minWidth: 160},
          {title: "Games", field: "games", width: 68, minWidth: 68, sorter: "number"},
          {title: "Δ Rating", field: "sum_rating_delta", width: 90, minWidth: 90, sorter: "number", formatter: ratingDeltaCell},
          {title: "Win%", field: "win_pct", width: 62, minWidth: 62, sorter: "number", formatter: winPctCell},
          {title: "Flag%", field: "flag_pct", width: 65, minWidth: 65, sorter: "number"},
          {title: "Mate%", field: "mate_pct", width: 65, minWidth: 65, sorter: "number"},
          {title: "#Vars", field: "variation_count", width: 65, minWidth: 65, sorter: "number"},
          {title: "Form", field: "form", width: 88, minWidth: 80, formatter: sparkline, headerSort: false},
        ],
        initialSort: [{column: "sum_rating_delta", dir: "asc"}],
      });
      rareTable.on("rowClick", (e, row) => selectRareFamilyRow(row, flip));
      rareTable.on("rowDblClick", (e, row) => drillIntoFamily(row.getData()));
      rareTable.on("tableBuilt", () => {
        const first = rareTable.getRows()[0];
        if (first) selectRareFamilyRow(first, flip);
      });
      return;
    }

    const family = params.get("family");
    if (!family || !color) {
      tableEl.innerHTML = `<p style="padding:1rem;color:var(--muted)">No opening selected. <a href="index.html">Pick one from the repertoire</a>.</p>`;
      return;
    }
    const rows = (D.opening_variations || []).filter(
      r => r.family === family && r.color === color);
    const totalGames = rows.reduce((a, r) => a + r.games, 0);
    const title = document.getElementById("opening-title");
    if (title) {
      const colorLabel = color.charAt(0).toUpperCase() + color.slice(1);
      title.textContent = `${family} as ${colorLabel} — ${totalGames} games across ${rows.length} variation${rows.length === 1 ? "" : "s"}`;
    }
    if (rows.length === 0) {
      tableEl.innerHTML = `<p style="padding:1rem;color:var(--muted)">No games found for ${family} (${color}).</p>`;
      return;
    }
    const flip = color === "black";
    const openingBoardEl = document.getElementById("opening-board");
    if (openingBoardEl) openingBoardEl._cg = makeBoard(openingBoardEl, {
      viewOnly: true,
      orientation: flip ? 'black' : 'white',
    });
    const table = new Tabulator("#opening-variations-table", {
      data: rows, layout: "fitColumns", height: "540px",
      headerWordWrap: true,
      columns: [
        {title: "Variation", field: "variation", headerFilter: "input", minWidth: 220,
         formatter: c => c.getValue() || `<span class="ind-off">main line</span>`},
        {title: "ECO", field: "eco", width: 65},
        {title: "Games", field: "games", width: 75, sorter: "number"},
        {title: "Δ Rating", field: "sum_rating_delta", width: 90, sorter: "number", formatter: ratingDeltaCell},
        {title: "Win%", field: "win_pct", width: 75, sorter: "number", formatter: winPctCell},
        {title: "Flag%", field: "flag_pct", width: 75, sorter: "number"},
        {title: "Mate%", field: "mate_pct", width: 75, sorter: "number"},
        {title: "Form", field: "form", width: 110, formatter: sparkline, headerSort: false},
      ],
      initialSort: [{column: "sum_rating_delta", dir: "asc"}],
    });
    table.on("rowClick", (e, row) => selectOpeningRow(row, flip));
    table.on("tableBuilt", () => {
      const first = table.getRows()[0];
      if (first) selectOpeningRow(first, flip);
    });
  }

  function selectOpeningRow(row, flip) {
    document.querySelectorAll("#opening-variations-table .tabulator-row.row-selected")
      .forEach(el => el.classList.remove("row-selected"));
    row.getElement().classList.add("row-selected");
    updateOpeningBoard(row.getData(), flip);
  }

  function selectRareFamilyRow(row, flip) {
    document.querySelectorAll("#opening-variations-table .tabulator-row.row-selected")
      .forEach(el => el.classList.remove("row-selected"));
    row.getElement().classList.add("row-selected");
    updateFamilyBoard(row.getData(), "opening-board", "opening-board-meta", flip);
  }

  function updateOpeningBoard(data, flip) {
    const board = document.getElementById("opening-board");
    const meta = document.getElementById("opening-board-meta");
    const stepperEl = document.getElementById("opening-board-stepper");
    if (!board || !meta) return;

    const fens = data.canonical_fens || null;
    const labels = data.canonical_move_labels || [];
    board._fens = fens;
    board._labels = labels;
    board._ply = fens ? fens.length - 1 : 0;

    if (board._cg) {
      const fen = fens ? fens[board._ply] : data.canonical_play_signature;
      if (fen) board._cg.set({ fen });
    }
    if (stepperEl) _renderOpeningStepper(stepperEl, board);

    const gap = data.rating_gap;
    const gapStr = gap == null ? "—" : (gap >= 0 ? "+" : "") + gap;
    const variationLabel = data.variation || "main line";
    const positionsLabel = data.position_count > 1
      ? `${data.position_count} positions reached via transpositions`
      : `single canonical position`;
    meta.innerHTML = `
      <div class="name">${variationLabel}</div>
      <div class="stats">${data.color} · ECO ${data.eco} · ${positionsLabel}</div>
      <dl class="detail">
        <div class="row"><span class="k">Games</span><span class="v">${data.games}</span></div>
        <div class="row"><span class="k">Win</span><span class="v">${data.win_pct}%</span></div>
        <div class="row"><span class="k">Flag</span><span class="v">${data.flag_pct}%</span></div>
        <div class="row"><span class="k">Mate</span><span class="v">${data.mate_pct}%</span></div>
        <div class="row"><span class="k">Median len</span><span class="v">${data.med_len}</span></div>
        <div class="row"><span class="k">Avg opp</span><span class="v">${data.avg_opp_rating}</span></div>
        <div class="row"><span class="k">Δ opp</span><span class="v">${gapStr}</span></div>
      </dl>
    `;
  }

  function _renderOpeningStepper(el, board) {
    const maxPly = board._fens ? board._fens.length - 1 : 0;
    if (!board._fens || maxPly < 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button class="step-btn" id="step-prev" ${board._ply <= 0 ? 'disabled' : ''}>&#9664;</button>
      <span class="step-label" id="step-label"></span>
      <button class="step-btn" id="step-next" ${board._ply >= maxPly ? 'disabled' : ''}>&#9654;</button>
    `;
    _syncStepLabel(el, board._ply, board._labels);
    el.querySelector('#step-prev').addEventListener('click', () => {
      if (board._ply > 0) {
        board._ply--;
        if (board._cg) board._cg.set({ fen: board._fens[board._ply] });
        _syncStepLabel(el, board._ply, board._labels);
        el.querySelector('#step-prev').disabled = board._ply <= 0;
        el.querySelector('#step-next').disabled = false;
      }
    });
    el.querySelector('#step-next').addEventListener('click', () => {
      if (board._fens && board._ply < board._fens.length - 1) {
        board._ply++;
        if (board._cg) board._cg.set({ fen: board._fens[board._ply] });
        _syncStepLabel(el, board._ply, board._labels);
        el.querySelector('#step-prev').disabled = false;
        el.querySelector('#step-next').disabled = board._ply >= board._fens.length - 1;
      }
    });
  }

  function _syncStepLabel(el, ply, labels) {
    const span = el.querySelector('#step-label');
    if (!span) return;
    span.textContent = ply === 0 ? 'start' : (labels[ply - 1] || `ply ${ply}`);
  }

  function renderSessions(rows) {
    if (!document.getElementById("sessions-table")) return;
    new Tabulator("#sessions-table", {
      data: rows, layout: "fitDataStretch",
      columns: [
        {title: "Start", field: "start"},
        {title: "Games", field: "games", sorter: "number"},
        {title: "Span (min)", field: "duration_minutes", sorter: "number"},
        {title: "W", field: "wins", sorter: "number"},
        {title: "L", field: "losses", sorter: "number"},
        {title: "D", field: "draws", sorter: "number"},
        {title: "Δ Rating", field: "rating_delta", sorter: "number",
         formatter: c => {
           const v = c.getValue();
           const cls = v <= -50 ? "cell-weak" : v >= 30 ? "cell-strong" : "";
           return `<span class="${cls}">${v >= 0 ? "+" : ""}${v}</span>`;
         }},
        {title: "Tilt", field: "tilt_flag", width: 80,
         formatter: c => c.getValue() ? `<span class="ind-on">●</span>` : ""},
      ],
      initialSort: [{column: "start", dir: "desc"}],
    });
  }

  function renderDrillinCards(D) {
    const root = document.getElementById("drillin-cards");
    if (!root) return;
    const leaks = D.leak_summary || [];
    const losses = D.recent_losses || [];
    const sessions = D.sessions || [];
    const pm = D.process_metrics || {};

    // Leaks card: alert when any critical leak exists
    const critical = leaks.find(L => L.severity === "critical");
    const firstWarn = leaks.find(L => L.severity === "warn");
    const worstName = critical ? critical.name : (firstWarn ? firstWarn.name : null);
    const leaksAlert = critical != null;
    const leaksSub = leaks.length === 0 ? "all clear"
      : worstName ? `Worst: ${worstName.replace(/_/g, " ")}`
      : `${leaks.length} active`;

    // Recent losses card: alert when count >= 10
    const lossCounts = {};
    losses.forEach(L => { lossCounts[L.loss_type] = (lossCounts[L.loss_type] || 0) + 1; });
    const topLossTypes = Object.entries(lossCounts).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const lossesSub = losses.length === 0 ? "none in last 30"
      : topLossTypes.map(([t, n]) => `${n} ${t}`).join(", ");
    const lossesAlert = losses.length >= 10;

    // Process card: alert when opening_velocity_median > 8 (seconds spent
    // on first 8 moves; matches the leak detector's "time_burn_opening"
    // threshold of >8s). Lower velocity = faster opening play = better.
    const velocity = pm.opening_velocity_median;
    const processHeadline = velocity == null ? "—" : `${velocity}s @ 8`;
    const processSub = velocity == null ? "insufficient data" : "Target ≤ 8s";
    const processAlert = velocity != null && velocity > 8;

    // Sessions card: alert when most-recent session was tilted.
    // sessions are stored chronologically (oldest first); use slice(-5) and
    // [length-1] to read the latest entries.
    const sessionCount = sessions.length;
    const last5 = sessions.slice(-5);
    const tiltedCount = last5.filter(s => s.tilt_flag).length;
    const sessionsSub = sessionCount === 0 ? "no sessions"
      : `${tiltedCount} tilted of last 5`;
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const sessionsAlert = lastSession != null && lastSession.tilt_flag === true;
    const puzzleCount = D.puzzle_catalog?.coverage?.eligible_puzzles || 0;
    const puzzleSub = puzzleCount === 0
      ? "no analyzed blunders ready"
      : "from your analyzed games";

    root.innerHTML = [
      card("Leaks", `${leaks.length} active`, leaksSub, "leaks.html", leaksAlert),
      card("Recent losses", `${losses.length}`, lossesSub, "losses.html", lossesAlert),
      card("Process", processHeadline, processSub, "process.html", processAlert),
      card("Sessions", `${sessionCount} total`, sessionsSub, "sessions.html", sessionsAlert),
      card("Puzzles", `${puzzleCount}`, puzzleSub, "puzzles.html", false),
      card("Chess Opening Puzzle Trainer", "Five opening decks", "Lichess tactics · both colors", "trainer.html", false),
    ].join("");
  }

  function card(label, headline, sub, href, alert) {
    return `<a class="card${alert ? " alert" : ""}" href="${href}">
      <div class="label">${label}</div>
      <div class="headline">${headline}</div>
      <div class="sub">${sub}</div>
    </a>`;
  }

  function sparkline(cell) {
    const arr = cell.getValue() || [];
    return `<span class="sparkline">${
      arr.map(r => `<span class="spark-bar spark-${r}"></span>`).join("")
    }</span>`;
  }
  function renderBehavior(b) {
    const root = document.getElementById("behavior-cards");
    if (!root || !b) return;
    const ls = b.loss_streaks || {};
    const rg = b.revenge_gap || {};
    const dd = (b.daily_drawdown || []).slice(-7);  // last 7 days
    const tod = (b.time_of_day || []);
    const todWorst = [...tod].sort((a, b) => a.mean_session_delta - b.mean_session_delta)[0];
    const todBest = [...tod].sort((a, b) => b.mean_session_delta - a.mean_session_delta)[0];

    const cell = (label, value, sub, alert=false) =>
      `<div class="behavior-card${alert ? " alert" : ""}">
         <div class="bh-label">${label}</div>
         <div class="bh-value">${value}</div>
         <div class="bh-sub">${sub}</div>
       </div>`;

    const cards = [];
    cards.push(cell(
      "Current loss streak",
      String(ls.current_loss_streak ?? 0),
      ls.current_timeout_loss_streak
        ? `${ls.current_timeout_loss_streak} of them on time`
        : "",
      (ls.current_loss_streak ?? 0) >= 3
    ));
    cards.push(cell(
      "Longest loss streak (24h)",
      String(ls.longest_loss_streak_24h ?? 0),
      ls.longest_timeout_loss_streak_24h
        ? `timeout streak: ${ls.longest_timeout_loss_streak_24h}`
        : "",
      (ls.longest_loss_streak_24h ?? 0) >= 5
    ));
    const gap = rg.revenge_gap;
    cards.push(cell(
      "Revenge gap",
      gap == null ? "—" : `${gap > 0 ? "+" : ""}${gap}pp`,
      `${rg.wins_after_loss}/${rg.games_after_loss} after losses vs ${rg.wins_after_win}/${rg.games_after_win} after wins`,
      gap != null && gap <= -8
    ));
    const worstDay = dd.length ? dd.reduce((acc, d) =>
      d.max_drawdown < acc.max_drawdown ? d : acc, dd[0]) : null;
    cards.push(cell(
      "Worst day this week",
      worstDay ? `${worstDay.max_drawdown}` : "—",
      worstDay ? `${worstDay.date} (${worstDay.games} games)` : "",
      worstDay && worstDay.max_drawdown <= -50
    ));
    cards.push(cell(
      "Best time-of-day",
      todBest ? `${String(todBest.hour).padStart(2, "0")}:00` : "—",
      todBest ? `mean session Δ ${todBest.mean_session_delta > 0 ? "+" : ""}${todBest.mean_session_delta}` : ""
    ));
    cards.push(cell(
      "Worst time-of-day",
      todWorst ? `${String(todWorst.hour).padStart(2, "0")}:00` : "—",
      todWorst ? `mean session Δ ${todWorst.mean_session_delta > 0 ? "+" : ""}${todWorst.mean_session_delta}` : "",
      todWorst && todWorst.mean_session_delta <= -20
    ));
    root.innerHTML = cards.join("");
  }

  function renderLossSummary(D) {
    const root = document.getElementById("loss-summary-cards");
    const bucketsRoot = document.getElementById("mate-buckets");
    if (!root) return;
    const losses = D.recent_losses || [];
    if (losses.length === 0) {
      root.innerHTML = `<p style="color:var(--muted)">No losses in window.</p>`;
      if (bucketsRoot) bucketsRoot.innerHTML = "";
      return;
    }
    const byType = {};
    losses.forEach(L => { byType[L.loss_type] = (byType[L.loss_type] || 0) + 1; });
    const pct = (n) => `${Math.round(100 * n / losses.length)}%`;
    const cell = (label, value, sub) =>
      `<div class="behavior-card">
         <div class="bh-label">${label}</div>
         <div class="bh-value">${value}</div>
         <div class="bh-sub">${sub}</div>
       </div>`;
    root.innerHTML = [
      cell("Losses in window", String(losses.length), ""),
      cell("Timeouts", `${byType.timeout || 0}`, pct(byType.timeout || 0)),
      cell("Mates", `${byType.checkmated || 0}`, pct(byType.checkmated || 0)),
      cell("Abandoned", `${byType.abandoned || 0}`, pct(byType.abandoned || 0)),
    ].join("");

    if (bucketsRoot) {
      const mb = (D.behavior && D.behavior.mate_loss_buckets) || [];
      if (mb.length === 0) {
        bucketsRoot.innerHTML = `<p style="color:var(--muted)">No mate losses yet.</p>`;
      } else {
        new Tabulator("#mate-buckets", {
          data: mb, layout: "fitColumns",
          columns: [
            {title: "Side", field: "side"},
            {title: "Length", field: "bucket"},
            {title: "Count", field: "count", sorter: "number"},
          ],
          initialSort: [{column: "count", dir: "desc"}],
        });
      }
    }
  }

  function renderReviewPicks(picks) {
    const root = document.getElementById("review-picks-list");
    if (!root) return;
    if (!picks || picks.length === 0) {
      root.innerHTML = `<li style="color:var(--muted)">No recent losses to review.</li>`;
      return;
    }
    const label = {
      biggest_loss: "Biggest single-game rating loss",
      timeout: "Most recent timeout",
      fast_mate: "Most recent fast mate (≤15 moves)",
    };
    root.innerHTML = picks.map(p => {
      const delta = p.rating_delta == null ? "" :
        ` (${p.rating_delta > 0 ? "+" : ""}${p.rating_delta} rating)`;
      return `<li>
        <strong>${label[p.kind] || p.kind}</strong>${delta} —
        <a href="${escapeAttr(p.url)}" target="_blank">${p.loss_type}, ${p.moves} moves</a>
        <div style="color:var(--muted);font-size:0.9rem">${p.question}</div>
      </li>`;
    }).join("");
  }

  function renderOpponentOpenings(data) {
    const section = document.getElementById("opponent-openings-block");
    if (!section) return;
    const rows = data && data.rows;
    if (!rows || rows.length === 0) return;
    section.style.display = "";

    const confBadge = c => {
      const colors = {strong: "var(--accent)", medium: "var(--muted)", weak: "var(--muted)"};
      return `<span style="font-size:0.78rem;color:${colors[c] || "var(--muted)"};">${c || ""}</span>`;
    };
    const pctColor = p => p >= 70 ? "cell-weak" : p <= 40 ? "cell-strong" : "";

    const thead = `<thead><tr>
      <th>Opponent line</th>
      <th title="Total games from this opener">Games</th>
      <th>W</th><th>D</th><th>L</th>
      <th title="% of games in this line you lost">Loss%</th>
      <th>Signal</th>
    </tr></thead>`;

    const tbody = rows.map(r => `<tr>
      <td>${escapeAttr(r.opp_line)}</td>
      <td>${r.game_count}</td>
      <td>${r.win_count}</td>
      <td>${r.draw_count}</td>
      <td>${r.loss_count}</td>
      <td class="${pctColor(r.loss_pct)}">${r.loss_pct}%</td>
      <td>${confBadge(r.confidence)}</td>
    </tr>`).join("");

    document.getElementById("opponent-openings-table").innerHTML =
      `<table class="mqf-table opp-openings-table">${thead}<tbody>${tbody}</tbody></table>`;

    const a = data.audit || {};
    const shown = a.groups_shown ?? rows.length;
    const hidden = a.groups_hidden_low_sample ?? 0;
    const skipped = (a.games_excluded_null_opening ?? 0) + (a.games_excluded_too_short ?? 0);
    const note = [
      `${shown} pattern${shown !== 1 ? "s" : ""} shown`,
      hidden > 0 ? `${hidden} hidden (low sample)` : "",
      skipped > 0 ? `${skipped} game${skipped !== 1 ? "s" : ""} skipped (no opening data)` : "",
      data.grouping_level !== "exact_line" ? `grouped by: ${data.grouping_level}` : "",
    ].filter(Boolean).join(" · ");
    const auditEl = document.getElementById("opponent-openings-audit");
    if (auditEl) auditEl.textContent = note;
  }

  function renderTrapExposures(rows, audit) {
    const section = document.getElementById("trap-exposures-block");
    if (!section) return;
    if (!rows || rows.length === 0) return;
    section.style.display = "";

    const confBadge = c => {
      const colors = {strong: "var(--accent)", medium: "var(--muted)", weak: "var(--muted)"};
      return `<span style="font-size:0.78rem;color:${colors[c] || "var(--muted)"};">${c || ""}</span>`;
    };
    const pctColor = p => p >= 70 ? "cell-weak" : p <= 40 ? "cell-strong" : "";

    const thead = `<thead><tr>
      <th>Trap / System</th>
      <th title="Games where this pattern appeared">Seen</th>
      <th>W</th><th>D</th><th>L</th>
      <th title="% of sightings you lost">Loss%</th>
      <th>Signal</th>
    </tr></thead>`;

    const tbody = rows.map(r => `<tr>
      <td>${escapeAttr(r.name)}</td>
      <td>${r.hit_count}</td>
      <td>${r.win_count}</td>
      <td>${r.draw_count}</td>
      <td>${r.loss_count}</td>
      <td class="${pctColor(r.loss_pct)}">${r.loss_pct}%</td>
      <td>${confBadge(r.confidence)}</td>
    </tr>`).join("");

    document.getElementById("trap-exposures-table").innerHTML =
      `<table class="mqf-table opp-openings-table">${thead}<tbody>${tbody}</tbody></table>`;

    const a = audit || {};
    const note = [
      `${rows.length} trap${rows.length !== 1 ? "s" : ""} shown`,
      a.patterns_deferred ? `${a.patterns_deferred} deferred to V2` : "",
      a.games_scanned ? `${a.games_scanned} games scanned` : "",
    ].filter(Boolean).join(" · ");
    const auditEl = document.getElementById("trap-exposures-audit");
    if (auditEl) auditEl.textContent = note;
  }

  function renderBlunderPhases(phases, coverage) {
    const section = document.getElementById("blunder-phases-block");
    if (!section) return;
    const analyzed = coverage && coverage.analyzed_games || 0;
    const eligible = coverage && coverage.eligible_games || 0;

    // Show section even with no data — shows coverage note
    section.style.display = "";

    const phaseRows = [
      {key: "opening",          label: "Opening (moves 1–8)"},
      {key: "early_middlegame", label: "Early middlegame (moves 9–20)"},
    ];

    if (!phases || analyzed === 0) {
      document.getElementById("blunder-phases-table").innerHTML =
        `<p style="color:var(--muted);font-size:0.88rem">Engine analysis not yet run — blunder phase breakdown unavailable.</p>`;
      const covEl = document.getElementById("blunder-phases-coverage");
      if (covEl) covEl.textContent = `Engine coverage: 0 / ${eligible} games analyzed.`;
      return;
    }

    const thead = `<thead><tr>
      <th>Phase</th>
      <th title="Your moves in this phase">Moves</th>
      <th title="Blunders (≥30% win% loss)">Blunders</th>
      <th title="Blunders per 100 user moves">Rate</th>
      <th title="Games containing ≥1 blunder in this phase">Affected</th>
      <th title="Average cp loss on blunder moves">Avg cp loss</th>
      <th title="Worst single blunder">Worst cp</th>
    </tr></thead>`;

    const tbody = phaseRows.map(({key, label}) => {
      const p = (phases[key] || {});
      const bc = p.blunder_count || 0;
      const mc = p.user_move_count || 0;
      const rate = mc ? (bc / mc * 100).toFixed(1) : "—";
      const ag = p.affected_games || 0;
      const eg = p.phase_eligible_games || 0;
      const cls = bc >= 10 ? "cell-weak" : bc >= 3 ? "" : "";
      return `<tr>
        <td style="text-transform:none">${label}</td>
        <td>${mc || "—"}</td>
        <td class="${cls}">${bc}</td>
        <td>${rate}%</td>
        <td>${ag} / ${eg}</td>
        <td>${p.avg_loss_cp != null ? p.avg_loss_cp : "—"}</td>
        <td>${p.worst_single_loss_cp != null ? p.worst_single_loss_cp : "—"}</td>
      </tr>`;
    }).join("");

    document.getElementById("blunder-phases-table").innerHTML =
      `<table class="mqf-table opp-openings-table">${thead}<tbody>${tbody}</tbody></table>`;

    const covEl = document.getElementById("blunder-phases-coverage");
    if (covEl) covEl.textContent = `Engine coverage: ${analyzed} / ${eligible} games analyzed.`;
  }

  function renderBlunderAnalysis(analysis) {
    renderQualityAnalysis(analysis, {
      rootId: "blunder-analysis-block",
      cardsId: "blunder-coverage-cards",
      emptyId: "blunder-analysis-empty",
      tableId: "blunder-review-table",
      boardId: "blunder-board",
      metaId: "blunder-board-meta",
      scrambleTableId: "scramble-review-table",
      scrambleBoardId: "scramble-board",
      scrambleMetaId: "scramble-board-meta",
      itemsKey: "blunders",
      singular: "blunder",
      plural: "blunders",
      itemLabel: "Blunder",
      itemsLabel: "Blunders",
    });
  }

  function renderMistakeAnalysis(analysis) {
    renderQualityAnalysis(analysis, {
      rootId: "mistake-analysis-block",
      cardsId: "mistake-coverage-cards",
      emptyId: "mistake-analysis-empty",
      tableId: "mistake-review-table",
      boardId: "mistake-board",
      metaId: "mistake-board-meta",
      scrambleTableId: "scramble-mistake-review-table",
      scrambleBoardId: "scramble-mistake-board",
      scrambleMetaId: "scramble-mistake-board-meta",
      itemsKey: "mistakes",
      singular: "mistake",
      plural: "mistakes",
      itemLabel: "Mistake",
      itemsLabel: "Mistakes",
    });
  }

  function renderQualityAnalysis(analysis, config) {
    const root = document.getElementById(config.rootId);
    if (!root) return;

    const cardsEl = document.getElementById(config.cardsId);
    const emptyEl = document.getElementById(config.emptyId);
    if (!analysis) {
      if (cardsEl) cardsEl.innerHTML = "";
      if (emptyEl) {
        emptyEl.style.display = "";
        emptyEl.textContent = `Run refresh.py with Stockfish analysis to build ${config.singular} categories.`;
      }
      [config.tableId, config.scrambleTableId]
        .forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = "";
        });
      [config.metaId, config.scrambleMetaId].forEach(id => {
        const meta = document.getElementById(id);
        if (meta) meta.innerHTML = `<div class="empty">No ${config.plural} to review.</div>`;
      });
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    const cov = analysis.engine_coverage || {};
    const itemsAnalyzed = cov.items_analyzed ?? cov[`${config.plural}_analyzed`] ?? 0;
    const clearItems = cov.clear_items ?? cov[`clear_${config.plural}`];
    const scrambleItems = cov.scramble_items ?? cov[`scramble_${config.plural}`] ?? 0;
    const gamesWithItems = cov.games_with_items ?? cov[`games_with_${config.plural}`] ?? 0;
    const categorizedItems = cov.categorized_items ?? cov[`categorized_${config.plural}`] ?? 0;
    const uncategorizedItems = cov.uncategorized_items ?? cov[`uncategorized_${config.plural}`] ?? 0;
    const cell = (label, value, sub, alert = false) =>
      `<div class="behavior-card${alert ? " alert" : ""}">
         <div class="bh-label">${label}</div>
         <div class="bh-value">${value}</div>
         <div class="bh-sub">${sub}</div>
       </div>`;
    if (cardsEl) {
      cardsEl.innerHTML = [
        cell("Engine coverage", `${cov.analyzed_games || 0} / ${cov.eligible_games || 0}`,
          "games analyzed"),
        cell(`${config.itemsLabel} analyzed`, `${itemsAnalyzed}`,
          clearItems != null
            ? `${clearItems} clear · ${scrambleItems} scramble`
            : `${gamesWithItems} games with ${config.plural}`,
          itemsAnalyzed >= 10),
        cell("Categorized", `${categorizedItems}`,
          `${uncategorizedItems} uncategorized`),
      ].join("");
    }

    renderQualityReview(analysis, config);
  }

  function renderQualityReview(analysis, config) {
    const tableEl = document.getElementById(config.tableId);
    const boardEl = document.getElementById(config.boardId);
    const metaEl = document.getElementById(config.metaId);
    if (!tableEl) return;

    const items = analysis.items || analysis[config.itemsKey] || [];
    const itemById = {};
    items.forEach(item => { if (item.id) itemById[item.id] = item; });
    const clearItems = items.filter(item => item && item.scramble !== true);
    const scrambleItems = items.filter(item => item && item.scramble === true);
    const impactRows = Array.isArray(analysis.impact_rows)
      ? analysis.impact_rows : [];
    const scrambleImpactRows = Array.isArray(analysis.scramble_impact_rows)
      ? analysis.scramble_impact_rows : [];
    // An uncategorized engine error has no aggregate tree row. Keep it visible
    // as an exact-position row instead of implying that no error exists.
    const rows = impactRows.length
      ? impactRows.concat(clearItems.filter(item => !Array.isArray(item.categories)
        || item.categories.length === 0))
      : clearItems.length ? clearItems : analysis.examples || [];
    const scrambleRows = scrambleImpactRows.length
      ? scrambleImpactRows.concat(scrambleItems.filter(item => !Array.isArray(item.categories)
        || item.categories.length === 0))
      : scrambleItems;
    const scrambleEl = document.getElementById(config.scrambleTableId);
    const scrambleMetaEl = document.getElementById(config.scrambleMetaId);
    if (rows.length === 0 && scrambleRows.length === 0) {
      tableEl.innerHTML = `<p class="mq-empty">No ${config.plural} in the analyzed games.</p>`;
      if (metaEl) metaEl.innerHTML = `<div class="empty">No position selected.</div>`;
      if (scrambleEl) {
        scrambleEl.innerHTML = `<p class="mq-empty">No scramble ${config.plural} in the analyzed games.</p>`;
      }
      if (scrambleMetaEl) {
        scrambleMetaEl.innerHTML = `<div class="empty">No position selected.</div>`;
      }
      return;
    }

    const scrambleBoardEl = document.getElementById(config.scrambleBoardId);
    [boardEl, scrambleBoardEl].forEach(el => {
      if (el && !el._cg) {
        el._cg = makeBoard(el, {
          viewOnly: true,
          orientation: "white",
          drawable: { enabled: true, visible: true },
        });
      }
    });

    const labels = analysis.category_labels || {};
    if (rows.length === 0) {
      tableEl.innerHTML = `<p class="mq-empty">No clear-headed ${config.plural} in the analyzed games.</p>`;
      if (metaEl) metaEl.innerHTML = `<div class="empty">No position selected.</div>`;
    } else {
      buildBlunderTree(`#${config.tableId}`, rows, labels, itemById, {
        autoSelect: true,
        boardId: config.boardId,
        metaId: config.metaId,
        singular: config.singular,
        plural: config.plural,
        itemLabel: config.itemLabel,
        itemsLabel: config.itemsLabel,
      });
    }

    if (scrambleEl) {
      if (scrambleRows.length === 0) {
        scrambleEl.innerHTML = `<p class="mq-empty">No scramble ${config.plural} in the analyzed games.</p>`;
        if (scrambleMetaEl) scrambleMetaEl.innerHTML = `<div class="empty">No position selected.</div>`;
      } else {
        buildBlunderTree(`#${config.scrambleTableId}`, scrambleRows, labels, itemById, {
          clockColumn: true,
          autoSelect: true,
          boardId: config.scrambleBoardId,
          metaId: config.scrambleMetaId,
          singular: config.singular,
          plural: config.plural,
          itemLabel: config.itemLabel,
          itemsLabel: config.itemsLabel,
        });
      }
    }
  }

  // One category → pattern → exact-error tree. Each table (clear-headed
  // and scramble) drives its own board panel via opts.boardId/metaId; the
  // scramble table additionally shows a Clock column. Internal row_type and ID
  // fields retain their historic "blunder" names for payload compatibility.
  function buildBlunderTree(selector, rows, labels, itemById, opts = {}) {
    // Each table drives its own board panel; selection is scoped per table.
    const target = {
      containerSel: selector,
      boardId: opts.boardId || "blunder-board",
      metaId: opts.metaId || "blunder-board-meta",
      singular: opts.singular || "blunder",
      plural: opts.plural || "blunders",
      itemLabel: opts.itemLabel || "Blunder",
      itemsLabel: opts.itemsLabel || "Blunders",
    };
    const columns = [
      {title: `Category / ${target.singular}`, field: "label", minWidth: 240,
       formatter: c => blunderImpactNameCell(c.getData(), target)},
      {title: "Focus", field: "focus_area", width: 128,
       formatter: c => blunderImpactFocusCell(c.getData(), target)},
      {title: target.itemsLabel, field: "count", width: 88, sorter: "number",
       formatter: c => isBlunderAggregateRow(c.getData()) ? formatNumber(c.getValue()) : ""},
      {title: "Phase", field: "top_phase_label", minWidth: 130,
       formatter: c => isBlunderAggregateRow(c.getData())
         ? `${escapeAttr(c.getValue() || "—")} (${formatNumber(c.getData().top_phase_count || 0)})`
         : escapeAttr(c.getData().phase_label || "—")},
      {title: "Top opening", field: "top_opening_label", minWidth: 170,
       formatter: c => isBlunderAggregateRow(c.getData())
         ? `${escapeAttr(c.getValue() || "—")} (${formatNumber(c.getData().top_opening_count || 0)})`
         : escapeAttr(c.getData().opening_label || "—")},
    ];
    if (opts.clockColumn) {
      columns.splice(3, 0, {title: "Clock", field: "clock_after_seconds", width: 86,
        sorter: "number",
        formatter: c => isBlunderAggregateRow(c.getData())
          ? ""
          : (c.getValue() != null ? `${c.getValue()}s` : "—")});
    }
    const table = new Tabulator(selector, {
      data: rows,
      layout: "fitColumns",
      height: "560px",
      headerWordWrap: true,
      dataTree: true,
      dataTreeChildField: "_children",
      dataTreeStartExpanded: false,
      rowFormatter: row => {
        const d = row.getData();
        const el = row.getElement();
        el.classList.toggle("blunder-impact-row", d.row_type === "category");
        el.classList.toggle("blunder-pattern-row", d.row_type === "pattern");
        el.classList.toggle("blunder-detail-row", d.row_type === "blunder");
      },
      columns,
      initialSort: [{column: "count", dir: "desc"}],
    });
    table.on("rowClick", (e, row) => selectBlunderRow(e, row, labels, itemById, target));
    table.on("rowDblClick", (e, row) => {
      const d = resolveBlunderForRow(row.getData(), itemById);
      const url = d.position_url || d.game_url;
      if (url) window.open(url, "_blank", "noopener");
    });
    if (opts.autoSelect) {
      table.on("tableBuilt", () => {
        const first = table.getRows()[0];
        if (first) selectBlunderRow(null, first, labels, itemById, target);
      });
    }
    return table;
  }

  function qualityDescription(value, target) {
    const description = String(value || "");
    if (target.singular !== "mistake") return description;
    return description
      .replace(/\bBlunders\b/g, target.itemsLabel)
      .replace(/\bblunders\b/g, target.plural)
      .replace(/\bBlunder\b/g, target.itemLabel)
      .replace(/\bblunder\b/g, target.singular);
  }

  function blunderImpactNameCell(data, target) {
    if (data.row_type === "category") {
      return `<span class="blunder-label">${escapeAttr(data.label || "Category")}</span>` +
        `<div class="table-sub">${escapeAttr(qualityDescription(data.description, target))}</div>`;
    }
    if (data.row_type === "pattern") {
      return `<span class="blunder-pattern-label">${escapeAttr(data.label || "Pattern")}</span>` +
        `<div class="table-sub">${escapeAttr(qualityDescription(data.description, target))}</div>`;
    }
    return `<span>${escapeAttr(data.move_label || target.itemLabel)}</span>` +
      `<div class="table-sub">${escapeAttr(data.played_move_san || "—")} → ${escapeAttr(data.best_move_san || "—")}</div>`;
  }

  function blunderImpactFocusCell(data, target) {
    if (data.row_type === "category") return escapeAttr(data.focus_area || "—");
    if (data.row_type === "pattern") return escapeAttr(data.focus_area || "Pattern");
    return `<span class="table-sub">${escapeAttr(data.phase_label || `Exact ${target.singular}`)}</span>`;
  }

  function resolveBlunderForRow(data, itemById) {
    if (isBlunderAggregateRow(data)) {
      return itemById[data.representative_blunder_id] || {};
    }
    if (data.row_type === "blunder") {
      return itemById[data.blunder_id] || {};
    }
    return data || {};
  }

  function isBlunderAggregateRow(data) {
    return data && (data.row_type === "category" || data.row_type === "pattern");
  }

  function selectBlunderRow(event, row, labels, itemById, target) {
    document.querySelectorAll(
      `${target.containerSel} .tabulator-row.row-selected`
    ).forEach(el => el.classList.remove("row-selected"));
    row.getElement().classList.add("row-selected");
    const rowData = row.getData();
    if (isBlunderAggregateRow(rowData)) {
      const clickedTreeControl = event && event.target
        && event.target.closest
        && event.target.closest(".tabulator-data-tree-control");
      if (!clickedTreeControl) {
        if (typeof row.treeExpand === "function") {
          row.treeExpand();
        } else if (typeof row.treeToggle === "function") {
          row.treeToggle();
        }
      }
    }
    updateBlunderBoard(resolveBlunderForRow(rowData, itemById), labels, rowData, target);
  }

  function updateBlunderBoard(data, labels, rowContext, target) {
    const boardEl = document.getElementById(target.boardId);
    const metaEl = document.getElementById(target.metaId);
    if (!boardEl || !metaEl) return;

    const orientation = (data.game_side || data.side) === "black" ? "black" : "white";
    if (boardEl._cg && data.fen_before) {
      boardEl._cg.set({
        fen: data.fen_before,
        orientation,
        lastMove: undefined,
        check: false,
      });
      const shapes = [];
      if (data.played_move_uci && data.played_move_uci.length >= 4) {
        shapes.push({
          orig: data.played_move_uci.slice(0, 2),
          dest: data.played_move_uci.slice(2, 4),
          brush: "red",
        });
      }
      if (data.best_move_uci && data.best_move_uci.length >= 4) {
        shapes.push({
          orig: data.best_move_uci.slice(0, 2),
          dest: data.best_move_uci.slice(2, 4),
          brush: "green",
        });
      }
      boardEl._cg.setShapes(shapes);
    }

    const links = [
      data.game_url
        ? `<a class="drill-link" href="${escapeAttr(data.game_url)}" target="_blank" rel="noopener">Open game</a>`
        : "",
      data.position_url
        ? `<a class="drill-link" href="${escapeAttr(data.position_url)}" target="_blank" rel="noopener">Open position</a>`
        : "",
    ].filter(Boolean).join("");
    const reply = data.opponent_best_reply_san
      ? `<div class="row"><span class="k">Reply</span><span class="v">${escapeAttr(data.opponent_best_reply_san)}</span></div>`
      : "";
    const clock = data.clock_after_seconds != null
      ? `<div class="row"><span class="k">Clock</span><span class="v">${data.clock_after_seconds}s</span></div>`
      : "";
    const isAggregate = rowContext && isBlunderAggregateRow(rowContext);
    const contextTitle = isAggregate
      ? rowContext.label
      : (data.move_label || target.itemLabel);
    const contextStats = isAggregate
      ? `${formatNumber(rowContext.count)} ${target.plural} · ${formatNumber(rowContext.total_cp_loss)} total cp lost · representative example shown`
      : `${data.opening_label || "Unknown opening"} · ${phaseLabel(data.phase_bucket || data.phase)}`;
    const categoryDetail = isAggregate && rowContext.row_type === "pattern"
      ? `<div class="row"><span class="k">Category</span><span class="v">${escapeAttr(labels[rowContext.category_key] || rowContext.category_key || "—")}</span></div>`
      : "";
    const patternCountDetail = isAggregate && rowContext.row_type === "category"
      ? `<div class="row"><span class="k">Patterns</span><span class="v">${formatNumber(rowContext.pattern_count)}</span></div>`
      : "";
    const contextDetail = isAggregate
      ? `${categoryDetail}
         <div class="row"><span class="k">Top opening</span><span class="v">${escapeAttr(rowContext.top_opening_label || "—")}</span></div>
         <div class="row"><span class="k">Phase</span><span class="v">${escapeAttr(rowContext.top_phase_label || "—")}</span></div>
         ${patternCountDetail}`
      : "";
    metaEl.innerHTML = `
      <div class="name">${escapeAttr(contextTitle)}</div>
      <div class="stats">${escapeAttr(contextStats)}</div>
      <div class="blunder-tags blunder-meta-tags">${blunderTagList(data.categories, labels)}</div>
      <dl class="detail">
        ${contextDetail}
        <div class="row"><span class="k">Played</span><span class="v">${escapeAttr(data.played_move_san || data.played_move_uci || "—")}</span></div>
        <div class="row"><span class="k">Best</span><span class="v cell-strong">${escapeAttr(data.best_move_san || data.best_move_uci || "—")}</span></div>
        ${reply}
        <div class="row"><span class="k">cp before</span><span class="v">${formatNumber(data.cp_before)}</span></div>
        <div class="row"><span class="k">cp after</span><span class="v">${formatNumber(data.cp_after)}</span></div>
        <div class="row"><span class="k">cp loss</span><span class="v">${formatNumber(data.cp_loss)}</span></div>
        ${clock}
      </dl>
      <div class="blunder-links">${links}</div>
    `;
  }

  function phaseLabel(value) {
    const labels = {
      opening: "Opening",
      early_middlegame: "Early middlegame",
      middlegame: "Middlegame",
      endgame: "Endgame",
    };
    return labels[value] || value || "—";
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value);
  }

  function blunderTagList(cats, labels) {
    return (cats || []).map(c =>
      `<span class="blunder-chip">${escapeAttr(labels[c] || c.replace(/_/g, " "))}</span>`
    ).join("");
  }

  function renderBlunderCategoryTable(rows) {
    const el = document.getElementById("blunder-category-table");
    if (!el) return;
    if (rows.length === 0) {
      el.innerHTML = `<p class="mq-empty">No categorized blunders in the analyzed window.</p>`;
      return;
    }
    const body = rows.map(r => `<tr>
      <td><span class="blunder-label">${escapeAttr(r.label)}</span>
        <div class="table-sub">${escapeAttr(r.description || "")}</div></td>
      <td>${r.count}</td>
      <td>${r.pct}%</td>
      <td>${r.avg_cp_loss ?? "—"}</td>
      <td>${r.worst_cp_loss ?? "—"}</td>
    </tr>`).join("");
    el.innerHTML = `<table class="mqf-table blunder-table">
      <thead><tr><th>Category</th><th>Count</th><th>%</th><th>Avg cp</th><th>Worst cp</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function renderBlunderPhaseTable(rows) {
    const el = document.getElementById("blunder-phase-table");
    if (!el) return;
    if (rows.length === 0) {
      el.innerHTML = `<p class="mq-empty">No blunders available for phase breakdown.</p>`;
      return;
    }
    const body = rows.map(r => `<tr>
      <td>${escapeAttr(r.label)}</td>
      <td>${r.count}</td>
      <td>${r.pct}%</td>
      <td>${r.avg_cp_loss ?? "—"}</td>
      <td>${r.worst_cp_loss ?? "—"}</td>
    </tr>`).join("");
    el.innerHTML = `<table class="mqf-table blunder-table">
      <thead><tr><th>Phase</th><th>Blunders</th><th>%</th><th>Avg cp</th><th>Worst cp</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function renderBlunderOpeningTable(rows) {
    const el = document.getElementById("blunder-opening-table");
    if (!el) return;
    if (rows.length === 0) {
      el.innerHTML = `<p class="mq-empty">No affected openings in the analyzed window.</p>`;
      return;
    }
    const body = rows.map(r => `<tr>
      <td>${escapeAttr(r.label)}</td>
      <td>${escapeAttr(r.side || "—")}</td>
      <td>${r.count}</td>
      <td>${r.affected_games}</td>
      <td>${r.avg_cp_loss ?? "—"}</td>
      <td>${r.worst_cp_loss ?? "—"}</td>
    </tr>`).join("");
    el.innerHTML = `<table class="mqf-table blunder-table">
      <thead><tr><th>Opening family</th><th>Side</th><th>Blunders</th><th>Games</th><th>Avg cp</th><th>Worst cp</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function winPctCell(cell) {
    const v = cell.getValue();
    if (v == null) return "";
    const cls = v >= 60 ? "cell-strong" : v <= 35 ? "cell-weak" : "";
    return `<span class="${cls}">${v}%</span>`;
  }
  function ratingDeltaCell(cell) {
    const v = cell.getValue();
    if (v == null) return "—";
    const cls = v <= -20 ? "cell-weak" : v >= 20 ? "cell-strong" : "";
    return `<span class="${cls}">${v >= 0 ? "+" : ""}${v}</span>`;
  }
})();
