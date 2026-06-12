# Freehand Drawing — Implementation Todo

## Phase 1: Module & Data Model

- [ ] **1.1 Create `modules/freehand.js`** — New module with:
  - `initFreehand()` — register tool button listener, epsilon slider
  - `activateFreehand()` / `deactivateFreehand()` — attach/remove SVG listeners
  - `addFreehandElement(data)` — create `<polyline>` SVG element and append
  - `updateFreehandElement(data)` — remove + re-add (same pattern as `updateLineElement`)
  - `removeFreehandElement(id)` — remove from DOM
  - Ramer-Douglas-Peucker implementation (`simplifyPolyline(points, epsilon)`)
  - `perpendicularDistance(point, lineStart, lineEnd)` helper
  - State variables: `isDrawing`, `rawPoints`, `previewPolyline`, `startPt`

- [ ] **1.2 Add state defaults in `modules/editor.js`** — Add:
  - `state.activeFreehandEpsilon` — default `0` (will be set from stroke width on tool activate)

- [ ] **1.3 Register module in `main.js`** — Import `freehand.js`, call `initFreehand()`, pass module refs for undo/redo

## Phase 2: Toolbar UI

- [ ] **2.1 Add Freehand tool button in `index.html`** — In first toolbar row, after Crop button:
  ```html
  <button id="btn-freehand" class="tool-btn" title="Freehand (F)" data-tool="freehand">Freehand</button>
  ```

- [ ] **2.2 Add epsilon slider group in `index.html`** — In second toolbar row:
  ```html
  <div class="toolbar-group separator" id="freehand-epsilon-group" hidden>
    <span class="toolbar-label">Smoothing:</span>
    <input type="range" id="freehand-epsilon-slider" min="0" max="30" step="0.5">
    <span class="toolbar-label" id="freehand-epsilon-value">0</span>
  </div>
  ```

- [ ] **2.3 Update `modules/tools.js`** — Add to `TOOL_SETTINGS`:
  ```js
  freehand: ['color', 'thickness', 'freehand-epsilon'],
  ```
  And in `updateToolSettingsVisibility`, add visibility for `freehand-epsilon` when:
  - `tool === 'freehand'`
  - `tool === 'select'` and `selectedType === 'freehand'`

## Phase 3: Drawing

- [ ] **3.1 Implement `onMouseDown` in freehand.js** — Start capture:
  - Check `state.hasImage`
  - Don't start on existing annotations/handles
  - Record start point, initialize `rawPoints = [startPt]`
  - Create raw preview `<polyline>` with all points (initially just start point)
  - Attach `mousemove`, `mouseup` listeners

- [ ] **3.2 Implement `onMouseMove` in freehand.js** — Capture points:
  - Throttle to ~30–60 Hz (e.g. skip if < 16ms since last capture)
  - Append current `{x, y}` to `rawPoints`
  - Update preview polyline `points` attribute

- [ ] **3.3 Implement `onMouseUp` in freehand.js** — Finalize:
  - Detach `mousemove`, `mouseup` listeners
  - Remove preview polyline
  - Compute bounding box of `rawPoints` — if < 20px in either axis, discard
  - Compute default epsilon: `Math.max(0.5, Math.min(15, state.activeThickness * 1.5))`
  - Run `simplifyPolyline(rawPoints, epsilon)`
  - If result has < 2 points, discard
  - Create element data object with `type: 'freehand'`, `points`, `rawPoints`, `epsilon`, `stroke`, `strokeWidth`
  - Call `addFreehandElement(data)`, push to `state.elements`, push undo action

## Phase 4: Simplification

- [ ] **4.1 Implement `simplifyPolyline(points, epsilon)`** — Iterative or recursive RDP:
  ```js
  export function simplifyPolyline(points, epsilon) {
    if (points.length < 3) return points.slice();
    // Ramer-Douglas-Peucker
    ...
  }
  ```

- [ ] **4.2 Implement `perpendicularDistance(point, a, b)`** — Perpendicular distance from point to line AB

- [ ] **4.3 Integrate epsilon slider** — Connect slider to:
  - Default value set on tool activation
  - `input` event re-simplifies selected freehand element in real-time
  - Numeric display updates with slider value

## Phase 5: Selection & Editing

- [ ] **5.1 Update `modules/select.js`**:
  - Add `drawFreehandHandles(data)` — centroid move handle
  - Handle click on `<polyline data-type="freehand">` in `findAnnotationParent` and `onMouseDown`
  - In `selectElement`, handle `data.type === 'freehand'` (set active color/thickness, dispatch `selection-changed`)
  - In `applyColorToSelected`, handle `'freehand'` type (update `stroke`)
  - In `applyThicknessToSelected`, handle `'freehand'` type (update `strokeWidth`)
  - Drag (move) support — offset all points in `onDragMove`

- [ ] **5.2 Epsilon slider on selection** — When a freehand element is selected:
  - Show the epsilon group
  - Set slider to element's `epsilon` value
  - On slider `input`, re-simplify from `rawPoints` (or current `points` if `rawPoints` is null), update polyline element, update handles

## Phase 6: SVG Save & Load

- [ ] **6.1 Update `modules/fileio.js` — `saveSVG`**:
  - In the annotation loop, handle `el.type === 'freehand'`:
    ```js
    svg += `<polyline id="${el.id}" data-type="freehand" data-epsilon="${el.epsilon}" ... points="..." />\n`;
    ```
  - Use `fill="none"`, `stroke-linecap="round"`, `stroke-linejoin="round"`

- [ ] **6.2 Update `modules/fileio.js` — `openSVGProject`**:
  - Parse `<polyline data-type="freehand">` elements:
    - Extract `points` attribute into array of `{x, y}`
    - Set `rawPoints = null`
    - Read `stroke`, `stroke-width`, `data-epsilon`
    - Create element object and pass through `restoreState` / `addFreehandElement`

- [ ] **6.3 Update `modules/fileio.js` — Export JPG**:
  - Include freehand polylines in the export SVG string (same as save)

## Phase 7: Undo / History Integration

- [ ] **7.1 Draw undo** — Similar to line drawing: `pushAction({ description: 'Draw freehand', doFn, undoFn })` with `addFreehandElement` / `removeFreehandElement`

- [ ] **7.2 Delete undo** — Select module `deleteSelected` needs a case for `type: 'freehand'`

- [ ] **7.3 Move undo** — Select module `onDragEnd` handles `type: 'freehand'` (offset all points)

- [ ] **7.4 Color/thickness undo** — `applyColorToSelected` and `applyThicknessToSelected` handle `'freehand'` type

## Phase 8: Keyboard Shortcut & Polish

- [ ] **8.1 Keyboard shortcut `F`** — In `main.js` keydown handler, add case `'f'` → `switchTool('freehand')`

- [ ] **8.2 Wire delete button** — Ensure `btn-delete` works for selected freehand elements

- [ ] **8.3 Test all flows**:
  - Draw stroke → appears simplified
  - Adjust epsilon slider → re-simplifies in real-time
  - Select freehand → move handle + slider visible
  - Move freehand → correct positions
  - Change color/thickness → updates immediately
  - Delete freehand → undo/redo works
  - Save SVG → reload → polyline loads, slider can still simplify further
  - Export JPG → polyline included in output
  - Undo/redo across all operations
  - Click without drag → no element created
  - Very small stroke (< 20px) → no element created
