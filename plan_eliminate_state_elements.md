# Plan: Eliminate `state.elements`

## What is `state`?

Defined in `modules/editor.js:12-55`, `state` is an exported plain object containing all application state:

| Group | Properties | Purpose |
|---|---|---|
| **Document** | `filename` | Current file name |
| **Image** | `image.dataURI`, `.naturalWidth`, `.naturalHeight`, `.rotation`, `.flipH`, `.flipV`, `.zoomScale`, `.fitScale`, `.dpi` | Background image metadata and transform |
| **Elements** | `elements` (array) | **The target for elimination** — redundant JS mirror of annotation SVG DOM |
| **Selection** | `selectedId`, `selectedIds` | Currently selected element(s) |
| **Tool state** | `activeTool`, `activeColor`, `activeThickness`, `activeLineStyle`, `activeLineMarkerSize`, `activeFreehandEpsilon`, `activeCornerRadius`, `activeFontSize`, etc. | Current tool settings |
| **Grid** | `grid.visible`, `.cellSize`, `.lineOpacity`, `.lineWidth`, `.snapToGrid` | Grid overlay settings |
| **UI** | `viewerWidth`, `viewerHeight`, `hasImage`, `originCoordinate`, `autosaveEnabled`, `palette` | Viewer dimensions and preferences |

These other `state` properties have **no DOM representation** and are legitimate JS state. Only `elements` has a full DOM equivalent.

## What is `state.elements`?

A plain JS array of ~100-200 objects — one per annotation element. Each object shape:

```js
{
  id: string,              // unique ID, also set as DOM element id attribute
  type: 'line'|'text'|'freehand'|'rectangle'|'group',
  parentId: string|null,   // group membership (optional)
  // type-specific geometry + styling...
}
```

Used in **159+ locations** across **15 files**:

- **READ** (~100): `state.elements.find(el => el.id === id)` then read `.type`, `.parentId`, `.stroke`, `.x`, `.y`, `.points`, etc.
- **WRITE** (~40): `.push()`, `.splice()`, `= []`, `= elements`, `.push(...elements)`
- **ITERATE** (~15): `.map()`, `.forEach()`, `.some()`, `.filter()`, `for` loops by `.length`

## Why eliminate it?

Every bit of data in `state.elements` already exists as SVG DOM attributes:

| Data property | DOM equivalent |
|---|---|
| `id` | `element.id` |
| `type` | `element.dataset.type` (`data-type` attribute) |
| `parentId` | Implicit via DOM parent-child nesting inside `<g data-type="group">` |
| `childIds` | Implicit via `groupEl.querySelectorAll('[id]')` |
| `x`, `y`, `width`, `height` | Attributes on `<rect>` / `<text>` / `<line>` |
| `points` | `points` attribute string on `<polyline>`/`<polygon>` |
| `stroke`, `strokeWidth`, `fill` | Attributes on visual SVG elements |
| `rotation` | Embedded in `transform="rotate(...)"` |
| `lineStyle`, `lineMarkerSize`, etc. | `data-line-style`, `data-line-marker-size` etc. on group container |

The array is **always out of sync risk**, requires **double-writes**, complicates **serialization**, and **duplicates memory**.

---

## The Plan: 5 Phases

### Phase 0: Groundwork — DOM query utilities

Create helper functions in `modules/dom-utils.js` (new file) that encapsulate all DOM-to-data conversion:

```js
function getElementData(id)        // O(1) lookup via document.getElementById + attribute reads
function readElementData(el)       // Dispatch to type-specific readers based on dataset.type
function readLineData(el)          // Parse points from <line>/<polyline>/<polygon>, read stroke, etc.
function readTextData(el)          // Read x, y, font-size, fill, content, etc.
function readFreehandData(el)      // Read points, epsilon, stroke, strokeWidth
function readRectData(el)          // Read x, y, width, height, rx, stroke, fill, rotation
function readGroupData(el)         // Read data-type, derive childIds from DOM children
function forEachElement(fn)        // Iterate dom.annotationLayer.querySelectorAll('[data-type]')
function elementExists(id)         // !!document.getElementById(id)
function getElementIds()           // [...dom.annotationLayer.querySelectorAll('[id]')].map(el => el.id)
function readAllElementsData()     // Serialize entire annotation DOM to portable data array
```

These don't change any behavior yet — they just provide the API the rest of the codebase will migrate to.

---

### Phase 1: Eliminate READ operations (~100 sites)

Replace every `state.elements.find(el => el.id === id)` with `getElementData(id)` or direct DOM attribute reads.

**Pattern replacements:**

| Before | After |
|---|---|
| `state.elements.find(el => el.id === state.selectedId)` | `getElementData(state.selectedId)` |
| `state.elements.find(el => el.id === id && el.type === 'group')` | `const el = document.getElementById(id); if (el?.dataset.type === 'group')` |
| `state.elements.find(el => el.id === selData.parentId && el.type === 'group')` | `const parent = document.getElementById(selData.parentId); if (parent?.dataset.type === 'group')` |
| `data.stroke` | `document.getElementById(id)?.getAttribute('stroke')` |
| `data.x`, `data.y` | `parseFloat(el.getAttribute('x'))`, `parseFloat(el.getAttribute('y'))` |
| `data.points` | Parse `el.getAttribute('points')` → `[{x,y}]` |

**Key consideration**: DOM attributes are always strings. Need `parseFloat()` for numbers, string splitting for `points` arrays.

**Files to modify** (sorted by reference count):
- `modules/select.js` (80 refs) — heaviest user
- `modules/group.js` (21 refs)
- `modules/rectangle.js` (14 refs)
- `modules/text.js` (5 refs)
- `modules/tools.js` (4 refs)
- `modules/freehand.js` (4 refs)
- `modules/fileio.js` (2 reads — `serializeElement` uses `state.elements.find`)
- `main.js` (3 refs)
- `pcb-main.js` (3 refs)
- `modules/symbols.js` (1 ref — only a WRITE, not a READ)

**Risk**: Low — mechanical replacement, testable after each file.

---

### Phase 2: Eliminate ITERATE operations (~15 sites)

Replace loops over `state.elements` with DOM iteration:

| Before | After |
|---|---|
| `state.elements.forEach(el => ...)` | `dom.annotationLayer.querySelectorAll('[data-type]').forEach(el => ...)` |
| `state.elements.some(el => el.id === id)` | `document.getElementById(id) !== null` |
| `state.elements.length` | `dom.annotationLayer.querySelectorAll('[id]').length` |
| `for (i=0; i<state.elements.length; i++)` (export) | Walk DOM children of each layer `<g>` directly |
| `state.elements.findIndex(el => el.id === id)` | Unnecessary — use `document.getElementById` for existence check |

**Critical sites:**

1. **SVG export** (`fileio.js:generateSVGString`, `serializeElement`, `buildLayerExportSvg`):
   Currently iterates `state.elements` to serialize. Replace with DOM walk:
   - Non-group elements: `layerEl.querySelectorAll(':scope > [id]:not([data-type="group"])')`
   - Group elements: `layerEl.querySelectorAll(':scope > [data-type="group"]')`
   - Children of groups: `groupEl.querySelectorAll(':scope > [id]')`
   This is actually *cleaner* because it respects whatever is currently in the DOM.

2. **ID dedup** (`select.js:nextDupPrefix`, `nextDupSuffix`):
   Iterate DOM IDs instead of `state.elements`.

3. **Group child validation** (`select.js:1559-1571`):
   Check DOM children of group `<g>` instead of `state.elements`.

4. **Undo delete array index** (`select.js:1550-1596`):
   Don't store index — capture `{data, nextSiblingId, parentId}` at action creation time to restore DOM position without an array index.

5. **Image resize** (`fileio.js:729-760`):
   `state.elements.map(el => ...)` to scale coordinates. Replace with DOM walk + `readElementData(el)` + scale + `recreateElement(el)`.

**Risk**: Medium — some iteration patterns have subtleties (backwards iteration for group cleanup, index-based restore in undo).

---

### Phase 3: Eliminate WRITE operations (~40 sites)

After READ and ITERATE are gone, WRITE sites become simpler:

| Before | After |
|---|---|
| `state.elements.push(data)` | Nothing — DOM already exists (creation functions already add to DOM) |
| `state.elements.splice(idx, 1)` | `document.getElementById(id)?.remove()` |
| `state.elements = elements` | Clear DOM and recreate (already done in `executeCrop`, `loadImage`) |
| `state.elements.filter(el => el.id !== id)` | `document.getElementById(id)?.remove()` |
| `state.elements.push(...oldElements)` | Nothing needed — elements already recreated via `addElement(el)` |

**Key files**:
- `editor.js:98,275` — Already clears DOM. Just stop the `state.elements = []`.
- `fileio.js:395` (new blank image) — Same.
- `fileio.js:786` (image resize) — Elements already re-created. Just stop the `.push`.
- `fileio.js:1193,1208` (project load) — Elements already in DOM. Just stop the `.push`.
- `select.js` (delete, duplicate, group/ungroup) — DOM already reflects the change.
- `text.js`, `line.js`, `rectangle.js`, `freehand.js` (create/undo/redo) — DOM already created.
- `group.js` (group/ungroup) — DOM already reflects the change.
- `crop.js`, `perspective.js`, `colorcorrection.js` — Already call `addElement()` which creates DOM. Just stop `.push()`.
- `symbols.js:408` — Already called `recreateElement()`. Just stop `.push()`.

**Risk**: Low-Medium — each WRITE site needs verification that the corresponding DOM operation already occurs.

---

### Phase 4: Refactor undo/redo

Undo/redo currently stores data snapshots:

```js
// Delete undo stores: { idx, data: {...state.elements[idx]} }
// doFn:  state.elements.splice(idx, 1) + DOM remove
// undoFn: state.elements.splice(idx, 0, r.data) + recreateElement(r.data)
```

**Strategy: DOM-sourced snapshots**

At action creation time, read current DOM state into data objects using `readElementData()` from Phase 0. Store those ephemeral data objects in the undo stack. On undo/redo, recreate from data. Data objects exist only in the undo stack as closed-over values — never in a persistent array.

**Changes needed per action type:**

| Action | Current pattern | New pattern |
|---|---|---|
| **Delete** | `{idx, data}` — idx is array index | `{data, nextSiblingId, parentId}` — use DOM position not array index |
| **Draw new element** | `pushAction` after creation, no data stored | Capture element data after creation for undo |
| **Edit (move/resize)** | Already stores delta/old values | Same, but read old values from DOM |
| **Group/Ungroup** | References `state.elements.find` | Read from DOM before action |
| **Duplicate** | References `state.elements.find` | Read from DOM before action |
| **Crop/Perspective/ColorCorrection** | `JSON.parse(JSON.stringify(state.elements))` | `readAllElementsData()` then pass data through do/undo |

**Special: Delete undo position restore**

Instead of array index, capture the DOM position at delete time:
```js
function deleteSelected() {
  var ids = state.selectedIds.slice();
  var removed = [];
  for (var di = 0; di < ids.length; di++) {
    var id = ids[di];
    var el = document.getElementById(id);
    if (!el) continue;
    removed.push({
      data: readElementData(el),
      parentId: el.parentNode?.id || null,
      nextSiblingId: el.nextElementSibling?.id || null,
    });
    el.remove();
  }
  // undo: re-insert at correct DOM position using parentId + nextSiblingId
}
```

**Risk**: High — but well-isolated. Can be done as the final step.

---

### Phase 5: Remove the declaration

Delete `elements: []` from `editor.js:25` and remove all remaining references. Clean up the `state` object.

---

## Summary

| Phase | Files affected | Sites | Risk | Description |
|---|---|---|---|---|
| 0. DOM utilities | New file (`modules/dom-utils.js`) | 0 | None | Create `readElementData()`, `getElementData()`, `forEachElement()` helpers |
| 1. Eliminate READs | 15 files | ~100 | Low | Mechanical `find()` → `getElementData()` / DOM attribute read replacement |
| 2. Eliminate ITERATEs | 5 files | ~15 | Medium | Replace loops with DOM queries; rewrite SVG export serialization |
| 3. Eliminate WRITEs | 12 files | ~40 | Low-Med | Remove `.push()`/`.splice()` — DOM already handled |
| 4. Refactor undo/redo | 6 files | ~25 | High | Capture DOM snapshots instead of persistent `state.elements` array |
| 5. Remove declaration | 1 file | 1 | None | Delete `elements: []` line |

**Total**: ~180 line changes across ~16 files.
