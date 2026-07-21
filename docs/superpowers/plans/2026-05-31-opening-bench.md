# Browsable Opening Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scrollable "bench" of candidate openings to the landing-page Plan & adherence block, keeping committed (active) openings prominent while bench lines get the same adherence/win-rate stats and steppable board.

**Architecture:** A new optional `"status"` field on each `plan.json` opening (`"active"` default, or `"bench"`). `compute_plan_compliance` passes it through untouched — no math changes. `renderPlanBlock` in app.js groups by side, renders active cards as today, then a `.plan-bench` vertical-scroll shelf for bench cards, keeping a single shared global index for board element IDs. One CSS rule for the capped shelf.

**Tech Stack:** Python 3 (pytest, `uv run pytest`), vanilla JS dashboard, plain CSS. Spec: `docs/superpowers/specs/2026-05-31-opening-bench-design.md`.

---

### Task 1: Pass `status` through `compute_plan_compliance`

**Files:**
- Modify: `chess_tracker/metrics.py` (the `out_openings.append({...})` dict, ~line 779-798)
- Test: `tests/test_metrics.py` (add after line 679, near the other plan-compliance tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_metrics.py`:

```python
def test_compute_plan_compliance_status_defaults_to_active():
    """An opening with no status field is reported as active."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1_700_000_000, time_class="bullet", side="black",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=20, fullmoves=10, opening="Modern Defense", eco="B06",
        first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6")
    plan = {"openings": [{"name": "Modern", "side": "black",
                          "vs_first_move": "e4", "target_family": "Modern Defense"}]}
    out = compute_plan_compliance([rec], plan)
    assert out["openings"][0]["status"] == "active"


def test_compute_plan_compliance_status_bench_passes_through():
    """A bench opening keeps status='bench' and still computes adherence stats."""
    from chess_tracker.metrics import compute_plan_compliance
    from chess_tracker.pgn import GameRecord

    rec = GameRecord(
        url="x", end_time=1_700_000_000, time_class="bullet", side="black",
        my_rating=500, opp_rating=500, result="win", opp_result="checkmated",
        plies=20, fullmoves=10, opening="Modern Defense", eco="B06",
        first_moves="1.e4 g6 2.d4 Bg7 3.Nc3 d6 4.f4 c6")
    plan = {"openings": [{"name": "Modern", "side": "black", "status": "bench",
                          "vs_first_move": "e4", "target_family": "Modern Defense"}]}
    out = compute_plan_compliance([rec], plan)
    o = out["openings"][0]
    assert o["status"] == "bench"
    assert o["games_on_plan"] == 1          # stats still computed for bench
    assert o["adherence_pct"] == 100.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && uv run pytest tests/test_metrics.py::test_compute_plan_compliance_status_defaults_to_active tests/test_metrics.py::test_compute_plan_compliance_status_bench_passes_through -v`
Expected: FAIL with `KeyError: 'status'`.

- [ ] **Step 3: Add the field to the output dict**

In `chess_tracker/metrics.py`, inside `compute_plan_compliance`, locate the `out_openings.append({` block (~line 779). Add the `status` key (placed right after `"side": side,` for readability):

```python
        out_openings.append({
            "name": op.get("name", target),
            "side": side,
            "status": op.get("status", "active"),
            "vs_first_move": vs_move,
            "target_family": target,
            "moves": op.get("moves", ""),
```

(Leave every other key in the dict exactly as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && uv run pytest tests/test_metrics.py -k plan_compliance -v`
Expected: PASS — the two new tests plus all existing `*plan_compliance*` tests stay green.

- [ ] **Step 5: Commit**

```bash
cd /Users/madisonvelding-vandam/Developer/chess-tracker
git add chess_tracker/metrics.py tests/test_metrics.py
git commit -m "feat(metrics): pass opening status through plan compliance

```

---

### Task 2: Render the bench shelf in `renderPlanBlock`

**Files:**
- Modify: `dashboard/app.js` (`renderPlanBlock`, ~lines 125-226)

The current function (1) sorts openings black-then-white, (2) maps each to a `.plan-card` emitting a side `<h3>` header on side-change, (3) wires each card's board with `ordered.forEach((o, i) => ...)` using IDs `plan-board-${i}-${j}`. We must keep the **same flat `ordered` array and its index `i`** for board wiring, and only change the *markup pass* so that, within each side, active cards render first and bench cards render inside a `.plan-bench` wrapper.

The clean way: keep a single `ordered` array sorted by `(side, status)` so all of a side's active cards precede its bench cards. Then in the markup `.map`, open the side header on side-change and open/close a `.plan-bench` wrapper on the active→bench transition within a side. Board wiring is unchanged because it still iterates the same `ordered` with the same `i`.

- [ ] **Step 1: Change the sort to group active-before-bench within each side**

Replace the sort at ~line 133-134:

```javascript
      const ordered = [...openings].sort((a, b) =>
        (a.side === "black" ? 0 : 1) - (b.side === "black" ? 0 : 1));
```

with a two-key sort (side, then active-before-bench):

```javascript
      const sideRank = (o) => (o.side === "black" ? 0 : 1);
      const statusRank = (o) => (o.status === "bench" ? 1 : 0);
      const ordered = [...openings].sort((a, b) =>
        sideRank(a) - sideRank(b) || statusRank(a) - statusRank(b));
```

- [ ] **Step 2: Emit the bench wrapper boundaries in the markup pass**

The markup `.map` at ~line 136 currently tracks `lastSide` and emits a header on change. Extend it to also track `lastStatus` and emit the `.plan-bench` open/close tags. Replace the header-computation lines (~137-140):

```javascript
        const header = o.side !== lastSide
          ? `<h3 class="plan-side-header">${o.side === "black" ? "As Black" : "As White"}</h3>`
          : "";
        lastSide = o.side;
```

with:

```javascript
        let prefix = "";
        if (o.side !== lastSide) {
          // close an open bench wrapper from the previous side before its header
          if (lastStatus === "bench") prefix += `</div>`;
          prefix += `<h3 class="plan-side-header">${o.side === "black" ? "As Black" : "As White"}</h3>`;
          lastStatus = "active";
        }
        if (o.status === "bench" && lastStatus !== "bench") {
          prefix += `<div class="plan-bench-label">Bench — studying</div><div class="plan-bench">`;
        }
        lastSide = o.side;
        lastStatus = o.status || "active";
```

Declare the trackers before the `.map`. Replace the existing `let lastSide = null;` (~line 135) with:

```javascript
      let lastSide = null;
      let lastStatus = "active";
```

Then prepend `prefix` to each card's returned template. The return currently starts (~line 149-151):

```javascript
        return `
          ${header}
          <div class="plan-card severity-${o.severity}">
```

change to:

```javascript
        return `
          ${prefix}
          <div class="plan-card severity-${o.severity}">
```

- [ ] **Step 3: Close a trailing bench wrapper after the map**

The `.map(...).join("")` produces a string that may end inside an open `.plan-bench` div (if the last side ends on bench cards). Capture the joined HTML and append a closing tag when needed. Replace `root.innerHTML = ordered.map((o, i) => {` ... `}).join("");` so the assignment becomes:

```javascript
      const cardsHtml = ordered.map((o, i) => {
        // ... unchanged body, now returning `${prefix}` + card ...
      }).join("");
      root.innerHTML = cardsHtml + (lastStatus === "bench" ? "</div>" : "");
```

(Only the wrapping `root.innerHTML = ...` line changes; the map body is the same one edited in Steps 1-2.)

- [ ] **Step 4: Verify no JavaScript syntax errors**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && node --check dashboard/app.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/madisonvelding-vandam/Developer/chess-tracker
git add dashboard/app.js
git commit -m "feat(dashboard): render bench shelf in plan block

```

---

### Task 3: Style the bench shelf

**Files:**
- Modify: `dashboard/styles.css` (append near the other `.plan-*` rules)

- [ ] **Step 1: Confirm where plan-card styles live**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && grep -n "plan-card\|plan-side-header" dashboard/styles.css | head`
Expected: prints the line(s) where plan styles are defined. Add the new rules immediately after the last `.plan-*` rule block.

- [ ] **Step 2: Add the bench styles**

Append to `dashboard/styles.css`:

```css
/* Bench — a vertical scroll shelf of candidate openings under the active cards. */
.plan-bench-label {
  margin: 0.5rem 0 0.25rem;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.plan-bench {
  max-height: 360px;
  overflow-y: auto;
  padding-right: 4px;       /* keep scrollbar off the card edges */
}
```

- [ ] **Step 3: Verify the rules parse (no stray braces)**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && grep -c "{" dashboard/styles.css && grep -c "}" dashboard/styles.css`
Expected: the two counts are equal.

- [ ] **Step 4: Commit**

```bash
cd /Users/madisonvelding-vandam/Developer/chess-tracker
git add dashboard/styles.css
git commit -m "style(dashboard): vertical capped bench shelf

```

---

### Task 4: Add seed bench entries and verify end-to-end

**Files:**
- Modify: `chess_tracker/plan.json` (add one `status:"bench"` opening per side)

- [ ] **Step 1: Add a bench entry for each side**

In `chess_tracker/plan.json`, add two entries to the `"openings"` array (alongside the existing four). Keep them structurally identical to active entries plus `"status": "bench"`:

```json
{
  "name": "Caro-Kann (bench)",
  "side": "black",
  "status": "bench",
  "vs_first_move": "e4",
  "target_family": "Caro-Kann Defense",
  "moves": "1.e4 c6  2.d4 d5  3.Nc3 dxe4  4.Nxe4 Bf5  5.Ng3 Bg6  6.h4 h6  7.Nf3 Nd7",
  "plan": "Candidate vs 1.e4: solid pawn chain, trade light bishops early, aim for a safe ...c5/...e6 structure. Studying — not yet committed."
},
{
  "name": "London System (bench)",
  "side": "white",
  "status": "bench",
  "vs_first_move": "d4",
  "target_family": "London System",
  "moves": "1.d4 d5  2.Nf3 Nf6  3.Bf4 e6  4.e3 Bd6  5.Bg3 O-O  6.Bd3 b6  7.Nbd2 Bb7",
  "plan": "Candidate vs 1.d4: early Bf4 (contrast with the committed Colle-Zukertort, which forbids Bf4). Studying alternative setup."
}
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && python3 -c "import json; d=json.load(open('chess_tracker/plan.json')); print(len(d['openings']), 'openings;', sum(1 for o in d['openings'] if o.get('status')=='bench'), 'bench')"`
Expected: `6 openings; 2 bench`.

- [ ] **Step 3: Run the full test suite**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && uv run pytest -q`
Expected: all tests pass (note: `test_shipped_plan_has_white_entries_with_match_rules` only asserts presence of specific names, so the new bench entries do not break it).

- [ ] **Step 4: Refresh and verify in the browser preview**

Run: `cd /Users/madisonvelding-vandam/Developer/chess-tracker && uv run python refresh.py` (regenerates `data/computed.json`).
Then start the preview server for the `dashboard/` directory and load `index.html`. Verify:
1. Each side shows its active cards first (Black: Modern + Englund; White: Colle-Zukertort + Four Knights), unchanged.
2. A "Bench — studying" label and a scrollable `.plan-bench` shelf appear under each side with the new bench card.
3. Expanding "Show moves & plan" on a **bench** card renders a working steppable board (◀/▶ change the position).
4. Take a `preview_screenshot` of the plan block as proof.

- [ ] **Step 5: Commit**

```bash
cd /Users/madisonvelding-vandam/Developer/chess-tracker
git add chess_tracker/plan.json data/computed.json
git commit -m "feat(plan): seed bench candidate openings per side

```

---

## Notes for the implementer

- **Board-ID invariant:** never split `ordered` into two arrays. The board-wiring loop (`ordered.forEach((o, i) => ...)`, ~line 196) must see the exact same array and indices as the markup pass, or boards won't attach. The bench is created purely with wrapper `<div>`s inside one continuous render.
- **`refresh.py` regenerates `data/computed.json`** from your local Chess.com data; if no fresh data is available, the manual board/scroll checks can still be done against the last committed `computed.json` since bench cards render from `plan.json`-derived fields.
- **Black-perspective boards** already flip for `o.side === "black"` — bench black cards inherit this for free.
