# Plan: DOM-based undo/redo — eliminate `state.elements` dependency

## Architecture overview

The undo/redo engine (`modules/history.js`) is a simple stack of `{ description, doFn, undoFn }` actions. It has **zero awareness** of `state` or `state.elements` — all business logic lives in the closures.

Currently, every action closure depends on `state.elements` in one of these ways:

| Dependency type | How it's used | Patterns affected |
|---|---|---|
| **Object reference** | `state.elements.find(id)` → mutate `.xxx = newVal` → `updateXxxSVG(data)` | 2, 3, 10 |
| **Array index** | `state.elements.findIndex(id)` → `.splice(idx, 1)` → undo uses `idx` for position | 4, 5, 6 |
| **Array push/filter** | `.push(data)` to add, `.filter()` to remove | 1, 5, 6 |
| **Deep clone** | `JSON.parse(JSON.stringify(state.elements))` for full state snapshot | 8 |
| **Full iteration** | `.map()` for coordinate transform, `.length` for loops | resize, export, load |

---

## The DOM-diff approach

### Principle

The SVG DOM **is** the source of truth. Every annotation element already stores all its state as DOM attributes (`x`, `y`, `stroke`, `points`, `data-type`, `data-line-style`, etc.). Undo/redo should:

1. **Read state from DOM** at action capture time — never from `state.elements`
2. **Store only the diff** — what changed, not a full copy
3. **Replay by setting DOM attributes** directly — no intermediate data objects

### Diff types

| Diff type | Stores | Used for |
|---|---|---|
| `attr-diff` | `{ elementId, attrs: { name: {old, new} } }` | Property changes (color, thickness, style, font size) |
| `geo-diff` | `{ elementId, geometry: { attr: {old, new} } }` | Moves, resizes, vertex drags |
| `content-diff` | `{ elementId, oldContent, newContent }` | Text content edits |
| `create-diff` | `{ elementData }` | Element creation (line, rect, freehand, text) |
| `delete-diff` | `{ elementData, parentId, nextSiblingId }` | Element deletion |
| `restructure-diff` | `{ type: 'group'/'ungroup', groupId, childIds }` | Group/ungroup |
| `full-diff` | `{ oldState, newState }` — full before/after snapshots | Crop, perspective, color correction |

---

## How "current state" is tracked during live DOM manipulation

The DOM **is** the live current state at all times. There is no separate JS buffer. The "before" snapshot is captured FROM the DOM at the start of an interaction; the "after" snapshot is captured FROM the DOM at the end.

### Example: dragging a vertex

```
1. mousedown → origPoints = readPointsFromDOM(el)    // snapshot BEFORE any change
2. mousemove → polyline.setAttribute('points', ...)  // mutate DOM directly
3. mouseup   → finalPoints = readPointsFromDOM(el)   // snapshot AFTER last change
               pushAction({ orig: origPoints, final: finalPoints })
```

No `state.elements` array needed at any step. The baseline is simply read earlier, the live state is the DOM at any moment, and the final state is read later.

### Same pattern for all interactions

| Interaction | Before (captured at start) | During (live state) | After (captured at end) |
|---|---|---|---|
| **Drag move** | `readLineGeometry(el)` | `el.setAttribute('x1', ...)` | `readLineGeometry(el)` |
| **Resize handle** | `readRectGeometry(el)` | `rectEl.setAttribute('width', ...)` | `readRectGeometry(el)` |
| **Vertex drag** | `readLineGeometry(el)` | `polyline.setAttribute('points', ...)` | `readLineGeometry(el)` |
| **Polyline extend** | `readLineGeometry(el)` | `polyline.setAttribute('points', ...)` | `readLineGeometry(el)` |
| **Property change** | `el.getAttribute('stroke')` | `el.setAttribute('stroke', newVal)` | `el.getAttribute('stroke')` |

The "current state" is always `readGeometryFromDOM(el)` — called at different times to produce before/after. The undo action stores only `{ before, after }` and replays by setting the captured DOM attributes.

---

## New utility functions

### `modules/dom-utils.js` (new file — shared across all phases)

```js
// ── Read state from DOM ──

function readElementAttrs(el, attrNames)
  // Returns { attrName: value } for each named attribute on el
  // Example: readElementAttrs(el, ['x','y','width','height'])
  //          → { x: '100', y: '200', width: '50', height: '30' }

function readLineGeometry(el)
  // For 2-point lines: reads x1,y1,x2,y2 from .annotation-line child
  // For polylines: reads points attribute, parses to points array
  // Returns { type: 'line'|'polyline'|'polygon', geometry }

function readElementData(el)
  // Full element read for create/delete snapshots
  // Combines all relevant attributes into a plain object
  // Used for: creation undo, deletion undo, crop/persist snapshots

// ── Apply state to DOM ──

function applyElementAttrs(el, attrs)
  // Sets each attribute in the { name: value } map on el

function applyLineGeometry(el, geometry)
  // Sets x1,y1,x2,y2 or points attribute on the appropriate child

// ── Capture helpers ──

function captureElementState(id)
  // Returns a plain object with all state for the given element
  // Used for: delete snapshot, group snapshot

function captureAllElementsState()
  // Returns an array of all element states (for crop/persist/color full snapshots)
  // Walks dom.annotationLayer.querySelectorAll('[id]')
  // Groups are represented by collecting their children's IDs

// ─── Element-type-specific reads ───

function getLineHandleAnchors(el)
  // Reads geometry from DOM and returns {x1,y1,x2,y2} for handle drawing
  // Replaces drawLineHandles(data) reading data.x1, data.y1, etc.

function getRectHandleAnchors(el)
  // Reads x,y,width,height from DOM rect-fill child
  // Replaces drawRectangleHandles(data) reading data.x, data.y, etc.

function getTextHandleAnchors(el)
  // Reads x,y,font-size from DOM text element

function getFreehandHandleAnchors(el)
  // Reads points from DOM polyline
```

---

## Per-pattern transformation

### Pattern 1: Element creation (line, rect, freehand, text)

**Current code** (`line.js:750`, `rectangle.js:267`, `freehand.js:157`, `text.js:211`):
```js
const data = { id, type: 'line', points, stroke, strokeWidth, ... };
addLineElement(data);        // creates DOM
state.elements.push(data);   // WRITE — to be removed

pushAction({
  doFn: () => {
    addLineElement(data);
    state.elements.push(data);   // WRITE
  },
  undoFn: () => {
    removeLineElement(id);
    state.elements = state.elements.filter(el => el.id !== id);  // WRITE
  },
});
```

**New DOM-diff approach:**
```js
const data = { id, type: 'line', points, stroke, strokeWidth, ... };
addLineElement(data);        // creates DOM — data object used only for creation

pushAction({
  type: 'create-line',
  doFn: () => { addLineElement(data); },
  undoFn: () => { removeLineElement(id); },
});
```

**Changes:**
- Remove all `state.elements.push(data)` and `state.elements.filter(...)` calls
- The `data` object is a plain JS local variable closed over in the closure — it lives only in the undo stack, not in a persistent array
- No change to doFn/undoFn logic (they already create/remove DOM correctly)

---

### Pattern 2: Property changes (color, thickness, line style, font size, corner radius, fill)

**Current** (`select.js:2029`, `select.js:2065`, etc.):
```js
const data = state.elements.find(el => el.id === state.selectedId);  // READ
const oldColor = data.stroke;
data.stroke = color;              // mutate data object
updateLineSVG(data);              // sync DOM from data

pushAction({
  doFn: () => { data.stroke = color; updateLineSVG(data); },
  undoFn: () => { data.stroke = oldColor; updateLineSVG(data); },
});
```

**New DOM-diff approach:**
```js
const el = document.getElementById(state.selectedId);
const oldColor = el.getAttribute('stroke');
const newColor = color;

el.setAttribute('stroke', newColor);
// also update decorations (the updateLineSVG equivalent):
updateLineDecorations(el, { stroke: newColor });

pushAction({
  description: 'Change color',
  doFn: () => {
    el.setAttribute('stroke', newColor);
    updateLineDecorations(el, { stroke: newColor });
  },
  undoFn: () => {
    el.setAttribute('stroke', oldColor);
    updateLineDecorations(el, { stroke: oldColor });
  },
});
```

**But wait** — `updateLineSVG(data)` does much more than set one attribute. It re-renders points, decorations, line style, etc. For a color change, most of that is redundant.

**Better approach: attribute-diff wrapper:**
```js
function applyColor(el, color) {
  el.setAttribute('stroke', color);
  // Update decorations (which are stroke-colored polygons)
  const decorGroup = el.querySelector('.line-decorations');
  if (decorGroup) {
    decorGroup.querySelectorAll('polygon, circle').forEach(d => d.setAttribute('fill', color));
  }
}

// In applyColorToSelected:
const el = document.getElementById(state.selectedId);
const oldColor = el.getAttribute('stroke');
applyColor(el, color);

pushAction({
  description: 'Change color',
  doFn: () => applyColor(el, color),
  undoFn: () => applyColor(el, oldColor),
});
```

**For simple properties** (thickness, font-size, corner radius):
```js
// Thickness
const el = document.getElementById(state.selectedId);
const oldVal = el.getAttribute('stroke-width');
el.setAttribute('stroke-width', thickness);
pushAction({
  doFn: () => el.setAttribute('stroke-width', thickness),
  undoFn: () => el.setAttribute('stroke-width', oldVal),
});

// Font size
const textEl = document.getElementById(state.selectedId);
const oldSize = textEl.getAttribute('font-size');
textEl.setAttribute('font-size', fontSize);
pushAction({
  doFn: () => textEl.setAttribute('font-size', fontSize),
  undoFn: () => textEl.setAttribute('font-size', oldSize),
});
```

**For complex properties** (line style — changes decorations, data-* attributes, dasharray):
```js
function applyLineStyleToDOM(el, newStyle) {
  const lineEl = el.querySelector('.annotation-line');
  applyLineStyle(lineEl, newStyle);  // sets stroke-dasharray etc.
  el.dataset.lineStyle = normalizeLineStyle(newStyle);
  // update decorations...
}

const el = document.getElementById(state.selectedId);
const oldStyle = el.dataset.lineStyle;
const oldStartDecor = el.dataset.startDecoration;
const oldEndDecor = el.dataset.endDecoration;
const oldStartSize = el.dataset.startDecorationSize;
const oldEndSize = el.dataset.endDecorationSize;

// Store all old decoration attrs
const oldDecorState = {
  lineStyle: oldStyle,
  startDecoration: oldStartDecor,
  endDecoration: oldEndDecor,
  startDecorationSize: oldStartSize,
  endDecorationSize: oldEndSize,
};

applyLineStyleToDOM(el, newStyle);

// Read back new decoration attrs after apply
const newDecorState = {
  lineStyle: el.dataset.lineStyle,
  startDecoration: el.dataset.startDecoration,
  endDecoration: el.dataset.endDecoration,
  startDecorationSize: el.dataset.startDecorationSize,
  endDecorationSize: el.dataset.endDecorationSize,
};

pushAction({
  description: 'Change line style',
  doFn: () => applyLineStyleAttrs(el, newDecorState),
  undoFn: () => applyLineStyleAttrs(el, oldDecorState),
});
```

Where `applyLineStyleAttrs` is a helper that sets all the data-* attrs and re-renders decorations.

---

### Pattern 3: Move / Resize elements

**Current** (`select.js:1180` — move, `select.js:1516` — resize):
```js
// At drag start: orig values captured from data object
// At drag end: final values captured from data object
var snapshots = [{ id, orig: { x, y, x1, y1, ... }, final: { x, y, x1, y1, ... } }];

pushAction({
  doFn: function() {
    for each s:
      var e = state.elements.find(el2 => el2.id === s.id);  // READ
      Object.assign(e, s.final);
      updateLineSVG(e);
  },
  undoFn: function() {
    for each s:
      var e = state.elements.find(el2 => el2.id === s.id);  // READ
      Object.assign(e, s.orig);
      updateLineSVG(e);
  },
});
```

**New DOM-diff approach:**
```js
// At drag end, capture geometry from DOM directly:
var snapshots = [];
for each id in state.selectedIds:
  var el = document.getElementById(id);
  // capture current geometry from DOM
  snapshots.push({
    id: id,
    orig: readGeometryFromDOM(el),  // captured at drag start
    final: readGeometryFromDOM(el), // captured at drag end
  });

pushAction({
  description: 'Move elements',
  doFn: function() {
    for each s:
      var el = document.getElementById(s.id);
      applyGeometryToDOM(el, s.final);
  },
  undoFn: function() {
    for each s:
      var el = document.getElementById(s.id);
      applyGeometryToDOM(el, s.orig);
  },
});
```

Where `readGeometryFromDOM` and `applyGeometryToDOM` are type-aware:
- For lines: read/set `x1,y1,x2,y2` or `points`, and `transform` for rotation
- For text: read/set `x, y`, and `transform` for rotation
- For rectangles: read/set `x, y, width, height`, and `transform` for rotation
- For freehand: read/set `points`

**Key insight**: These functions replace `updateLineSVG(data)`, `updateTextSVG(data)`, etc., but read FROM and write TO the DOM directly — no `state.elements` involvement.

---

### Pattern 4: Delete

**Current** (`select.js:1575`):
```js
removed = [];
for each id in selectedIds:
  idx = state.elements.findIndex(el => el.id === id);  // ITERATE
  removed.push({ idx, data: {...state.elements[idx]} });  // deep copy
  state.elements.splice(idx, 1);   // WRITE
  document.getElementById(id).remove();

pushAction({
  doFn: () => {
    for each r:
      ci = state.elements.findIndex(e => e.id === r.data.id);
      if (ci !== -1) state.elements.splice(ci, 1);   // WRITE
      svgEl = document.getElementById(r.data.id);
      if (svgEl) svgEl.remove();
  },
  undoFn: () => {
    for each r:
      state.elements.splice(r.idx, 0, r.data);   // WRITE — uses array index!
      recreateElement(r.data);   // creates DOM from data
  },
});
```

**New DOM-diff approach (no array index)**:
```js
removed = [];
for each id in selectedIds:
  var el = document.getElementById(id);
  if (!el) continue;
  removed.push({
    data: captureElementState(el),  // read all state from DOM
    parentId: el.parentNode.id !== 'layer-annotation' ? el.parentNode.id : null,
    nextSiblingId: el.nextElementSibling ? el.nextElementSibling.id : null,
  });
  el.remove();

// Clean up empty groups (check DOM, not state.elements)
for each groupEl in dom.annotationLayer.querySelectorAll('[data-type="group"]'):
  if (groupEl.children.length === 0) groupEl.remove();

pushAction({
  description: 'Delete...',
  doFn: () => {
    for each r:
      var existing = document.getElementById(r.data.id);
      if (existing) existing.remove();
  },
  undoFn: () => {
    for each r:
      // Recreate element from captured data
      recreateElement(r.data);
      // Restore DOM position
      var recreated = document.getElementById(r.data.id);
      var parent = r.parentId ? document.getElementById(r.parentId) : dom.annotationLayer;
      var nextSib = r.nextSiblingId ? document.getElementById(r.nextSiblingId) : null;
      if (nextSib) parent.insertBefore(recreated, nextSib);
      else parent.appendChild(recreated);
  },
});
```

**Changes:**
- No `state.elements.findIndex` or `.splice`
- Position is tracked via `parentId` + `nextSiblingId` (DOM-native) instead of array index
- Element state is captured from DOM via `captureElementState()`
- Empty group cleanup walks DOM, not `state.elements`
- doFn checks DOM existence (no need for array existence check)

---

### Pattern 5: Duplicate

**Current** (`select.js:1746,1807`):
```js
// Uses state.elements.find() to check existence, findIndex/splice for undo
```

**New DOM-diff approach:**
```js
// Duplicate creates new DOM elements with new IDs.
// The diff is: "create these new elements"

var dupes = [];
for each orig:
  var copyData = captureElementState(orig.id);  // read from DOM
  copyData.id = newId;                           // assign new ID
  recreateElement(copyData);                     // create DOM
  dupes.push(copyData);

pushAction({
  description: 'Duplicate...',
  doFn: () => {
    for each d in dupes:
      if (!document.getElementById(d.id)) {
        recreateElement(d);
      }
  },
  undoFn: () => {
    for each d in dupes:
      var el = document.getElementById(d.id);
      if (el) el.remove();
  },
});
```

**Changes:**
- Element data captured from DOM via `captureElementState()`, not cloned from `state.elements`
- Existence check uses `document.getElementById()`, not `state.elements.find()`
- Removal uses DOM removal, not `state.elements.findIndex` + `.splice()`

---

### Pattern 6: Group / Ungroup

**Current** (`group.js:45,113`):
```js
// Group:
for each id:
  elData = state.elements.find(e => e.id === ids[gii]);  // READ
  elData.parentId = groupId;                               // mutate

state.elements.push(groupData);   // WRITE

undoFn: () => {
  // move children out of <g>
  state.elements.findIndex(e => e.id === groupId);  // ITERATE
  state.elements.splice(dgIdx, 1);                    // WRITE
  for each id: ue.parentId = undefined;               // mutate
};
```

**New DOM-diff approach (parentId is implicit in DOM nesting)**:
```js
// Group:
var groupId = 'group-' + generateId();
var childIds = ids.slice();

// Create group <g> and move children into it
var g = svgEl('g', { id: groupId, 'data-type': 'group' });
for each id in ids:
  var childSvg = document.getElementById(id);
  if (childSvg) g.appendChild(childSvg);
dom.annotationLayer.appendChild(g);

pushAction({
  description: 'Group...',
  doFn: () => {
    // Create or re-use group <g>, move children in
    var dg = document.getElementById(groupId);
    if (!dg) {
      dg = svgEl('g', { id: groupId, 'data-type': 'group' });
      dom.annotationLayer.appendChild(dg);
    }
    for each id in ids:
      var ds = document.getElementById(id);
      if (ds && ds.parentNode !== dg) dg.appendChild(ds);
  },
  undoFn: () => {
    // Move children out of group, remove group <g>
    var dgEl = document.getElementById(groupId);
    if (dgEl) {
      while (dgEl.children.length > 0)
        dom.annotationLayer.appendChild(dgEl.children[0]);
      dgEl.remove();
    }
  },
});
```

**Changes:**
- No `parentId` property on data objects — group membership IS the DOM parent-child relationship
- `state.elements.push(groupData)` removed — group is purely a DOM `<g>` element
- `state.elements.findIndex` + `.splice()` removed — no array manipulation
- The doFn/undoFn move DOM elements between parents — that's all that's needed

---

### Pattern 7: Image transform (rotate, flip)

**Current** (`transform.js:15,41,63,81`):
```js
// Only touches state.image.* and SVG viewBox/transform
// NO state.elements dependency
```

**No change needed.** Already DOM-independent.

---

### Pattern 8: Crop / Perspective / Color correction (full state replacement)

**Current** (`crop.js:525`, `perspective.js:380`, `colorcorrection.js:636`):
```js
const oldElements = JSON.parse(JSON.stringify(state.elements));  // deep clone
// ...
doFn: () => {
  loadImage(newURI);
  for (el of oldElements) addElement(el);
  state.elements.push(...oldElements);  // WRITE
};
```

**New DOM-diff approach:**
```js
// Capture full state from DOM before any changes
const oldState = {
  imageDataURI: state.image.dataURI,
  imageW: state.image.naturalWidth,
  imageH: state.image.naturalHeight,
  elements: captureAllElementsState(),   // walk DOM, read all element attrs
};

// ... compute new state (crop/persp/color) ...

const newState = {
  imageDataURI: newURI,
  imageW: newW,
  imageH: newH,
  elements: newElements,                 // computed new element data
};

pushAction({
  description: 'Crop Image',
  doFn: () => applyFullState(newState),
  undoFn: () => applyFullState(oldState),
});

// Execute immediately
applyFullState(newState);
```

Where `applyFullState(state)` does:
```js
function applyFullState(state) {
  loadImage(state.imageDataURI, state.imageW, state.imageH);
  // loadImage already clears the DOM. Now re-create elements.
  for (const elData of state.elements) {
    recreateElement(elData);
  }
}
```

**Changes:**
- `captureAllElementsState()` reads from DOM instead of `JSON.parse(JSON.stringify(state.elements))`
- `applyFullState` only creates DOM elements (via `recreateElement`) — no `.push()` to array needed
- `loadImage()` already sets `state.elements = []` — but since we no longer use `state.elements`, this line becomes harmless (and will eventually be removed)

---

### Pattern 9: Perspective corner drag

**Current** (`perspective.js:166`):
```js
// Only touches local module state (corners array)
// NO state.elements dependency
```

**No change needed.** Already DOM-independent.

---

### Pattern 10: Text content edit

**Current** (`text.js:370`):
```js
const data = state.elements.find(el => el.id === id);  // READ reference
data.content = newContent;
textEl.textContent = newContent;

pushAction({
  doFn: () => { data.content = newContent; el.textContent = newContent; },
  undoFn: () => { data.content = oldContent; el.textContent = oldContent; },
});
```

**New DOM-diff approach:**
```js
const el = document.getElementById(id);
const oldContent = el.textContent;

el.textContent = newContent;

pushAction({
  description: 'Edit text',
  doFn: () => { el.textContent = newContent; },
  undoFn: () => { el.textContent = oldContent; },
});
```

**Changes:**
- Track DOM element directly, not data object reference
- Only `textContent` changes — no `state.elements.data.content` mutation

---

## Affected helper functions that also read from `state.elements`

### `drawHandles()` (`select.js:715`)
Currently reads geometry from data objects:
```js
var el = state.elements.find(e => e.id === _sid);  // READ
drawLineHandles(el);  // reads el.x1, el.y1, el.x2, el.y2
```

**New approach** — read geometry from DOM:
```js
var svgEl = document.getElementById(_sid);
if (!svgEl) continue;
var type = svgEl.dataset.type;
if (type === 'line') drawLineHandlesFromDOM(svgEl);
else if (type === 'text') drawTextHandlesFromDOM(svgEl);
// etc.
```

Where `drawLineHandlesFromDOM(el)` reads coordinates from DOM attributes:
```js
function drawLineHandlesFromDOM(el) {
  var lineEl = el.querySelector('.annotation-line');
  var x1, y1, x2, y2;
  if (lineEl.tagName === 'LINE') {
    x1 = parseFloat(lineEl.getAttribute('x1'));
    y1 = parseFloat(lineEl.getAttribute('y1'));
    x2 = parseFloat(lineEl.getAttribute('x2'));
    y2 = parseFloat(lineEl.getAttribute('y2'));
  } else {
    var pts = lineEl.getAttribute('points');
    // parse "x1,y1 x2,y2 ..." → [{x,y}]
    // use first and last points for handles
  }
  // ...draw handles at x1,y1 and x2,y2...
}
```

### `refreshSelection()` (`select.js:2279`)
Currently reads from `state.elements.find()` to get `lineStyle`, `epsilon`, `rx`:
```js
const data = state.elements.find(el => el.id === state.selectedId);
setActiveLineStyle(normalizeLineStyle(data.lineStyle));
syncFreehandEpsilonSlider(data.epsilon);
document.getElementById('corner-radius-input').value = data.rx || 0;
```

**New approach** — read from DOM:
```js
const el = document.getElementById(state.selectedId);
if (!el) { clearSelection(); return; }
const type = el.dataset.type;
if (type === 'line') {
  setActiveLineStyle(normalizeLineStyle(el.dataset.lineStyle));
} else if (type === 'freehand') {
  syncFreehandEpsilonSlider(parseFloat(el.querySelector('[data-epsilon]')?.dataset.epsilon || 0));
} else if (type === 'rectangle') {
  const rx = el.querySelector('.rect-fill')?.getAttribute('rx') || 0;
  document.getElementById('corner-radius-input').value = rx;
  state.activeCornerRadius = parseFloat(rx);
}
drawHandlesFromDOM(el);
```

---

## Implementation order

The work can be done in 6 steps, each building on the last. Each step should be verified (load SVG, create elements, undo/redo, save/reload) before moving on.

### Step 1: Create `captureElementState()` and `applyGeometryToDOM()` helpers

New file: `modules/dom-utils.js`

Functions:
- `readElementAttrs(el, names)` — reads named attrs from a DOM element
- `readLineGeometry(el)` — reads x1,y1,x2,y2 or points from the `.annotation-line` child
- `readRectGeometry(el)` — reads x,y,width,height from `.rect-fill` child
- `readTextGeometry(el)` — reads x,y,font-size from a `<text>` element
- `readFreehandGeometry(el)` — reads points from the `<polyline>` child
- `applyLineGeometry(el, geom)` — sets geometry attrs on relevant children
- `applyRectGeometry(el, geom)` — sets x,y,width,height on rect children
- `applyTextGeometry(el, geom)` — sets x,y,font-size on text element
- `applyFreehandGeometry(el, geom)` — sets points on polyline
- `captureElementState(id)` — full element snapshot (for create/delete snapshots)
- `captureAllElementsState()` — snapshot all elements (for crop/persp/color)

### Step 2: Convert Pattern 1 (creation) — remove `.push()`/`.filter()`

**Files**: `line.js`, `rectangle.js`, `freehand.js`, `text.js`

Changes per file:
- Remove `state.elements.push(data)` after `addXxxElement(data)`
- Remove `state.elements.push(data)` inside doFn
- Replace `state.elements = state.elements.filter(el => el.id !== id)` inside undoFn with just `removeXxxElement(id)` (which already removes DOM)

### Step 3: Convert Pattern 4+5+6 (delete, duplicate, group/ungroup)

**Files**: `select.js` (delete + duplicate), `group.js`

Changes:
- Delete: replace `findIndex`/`splice` with `{parentId, nextSiblingId}` position tracking
- Delete: capture element state via `captureElementState()` instead of `{...state.elements[idx]}`
- Delete: empty group cleanup walks DOM, not `state.elements`
- Duplicate: capture from DOM via `captureElementState()`, DOM-only existence checks
- Group/Ungroup: remove all `state.elements` reads/writes; group membership is implicit in DOM

### Step 4: Convert Pattern 2+3+10 (property changes, move/resize, text edit)

**Files**: `select.js` (applyColor, applyThickness, applyFontSize, applyCornerRadius, applyLineStyle, applyLineMarkerSize, fill color change, move, resize), `rectangle.js` (resize), `line.js` (vertex drag), `text.js` (edit)

Changes:
- Replace `state.elements.find(id)` with `document.getElementById(id)`
- Replace `updateXxxSVG(data)` with direct DOM attribute manipulation
- Replace `Object.assign(data, final)` with `applyGeometryToDOM(el, final)`
- In move/resize: capture orig/final from DOM, not from data object

This is the largest step. The key is that `updateXxxSVG(data)` functions currently translate data→DOM. They need equivalent `applyXxxFromDOM` or direct DOM manipulation functions.

### Step 5: Convert Pattern 8 (crop, perspective, color correction)

**Files**: `crop.js`, `perspective.js`, `colorcorrection.js`

Changes:
- Replace `JSON.parse(JSON.stringify(state.elements))` with `captureAllElementsState()`
- Remove `state.elements.push(...oldElements)` inside doFn/undoFn — `addElement()` already creates DOM
- `loadImage()` already clears DOM, so re-creating via `addElement()` is sufficient

### Step 6: Remove the declaration

- Delete `elements: []` from `editor.js:25`
- Clean up any remaining references (verify with grep)

---

## Verification checklist

After each step:

| Test | Expected |
|---|---|
| Create a line, undo, redo | Line appears/disappears correctly |
| Create a rectangle, undo, redo | Rectangle appears/disappears correctly |
| Create a text, undo, redo | Text appears/disappears correctly |
| Create a freehand, undo, redo | Freehand appears/disappears correctly |
| Change color of a line, undo, redo | Color reverts and reapplies |
| Change thickness, undo, redo | Thickness reverts and reapplies |
| Change line style, undo, redo | Style reverts and reapplies |
| Change font size, undo, redo | Font size reverts and reapplies |
| Change corner radius, undo, redo | Radius reverts and reapplies |
| Drag-move a line, undo, redo | Line returns and moves again |
| Drag-resize a rectangle, undo, redo | Rectangle returns and resizes |
| Delete an element, undo, redo | Element returns and is removed again |
| Duplicate an element, undo, redo | Duplicate appears/disappears |
| Group 2 elements, undo, redo | Elements group/ungroup correctly |
| Ungroup, undo, redo | Elements ungroup/regroup correctly |
| Crop image, undo, redo | Image + annotations revert/apply |
| Perspective transform, undo, redo | Image + annotations revert/apply |
| Color correction, undo, redo | Image + annotations revert/apply |
| Edit text content, undo, redo | Text reverts and reapplies |
| Load SVG project file | All elements render correctly |
| Save SVG, reload | All elements persist correctly |
| Resize image | Elements scale correctly |
| Select element after undo | Handles draw correctly at the right position |
| Toolbar sync after undo | Line style dropdown, etc. show correct values |

---

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| `drawHandles()` reads geometry from data objects — after step 4, data objects don't exist | `drawHandlesFromDOM()` reads directly from DOM attributes |
| `updateXxxSVG()` functions are called from many places (not just undo/redo) | Keep `updateXxxSVG()` as-is for non-undo callers, or refactor them all to read options from a plain object |
| Line decoration re-rendering requires full geometry (not just stroke color) | Create `updateLineDecorations(el, opts)` that reads current geom from DOM + applies only the changed styling |
| `refreshSelection()` called after every undo/redo — reads from `state.elements` | Refactor to read from DOM (see above) |
| `updateLineElement(data)` does tag-type switching (line ↔ polyline ↔ polygon) — needs the `data` object | For move/resize undo, the geometry doesn't change the tag type, so only attributes need updating. If tag type changes (unusual), fall back to `addLineElement(data)` with captured data. |
| Crop/perspective/colorcorrection use `loadImage()` which sets `state.elements = []` — harmless after elimination | Remove the `state.elements = []` line in `loadImage()` during step 6 |
