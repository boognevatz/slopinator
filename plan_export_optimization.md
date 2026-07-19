# Export Rendering Optimization Plan

## Goal

Replace the current slow export pipeline (build single monolithic SVG with embedded image dataURI → OPFS → Image decode → canvas) with a per-layer compositing approach: each visible layer renders independently onto the export canvas via `ctx.drawImage()`. The image layer draws directly from `dom.imageEl` (already decoded in GPU memory, zero re-decode), while annotation/watermark layers use small SVGs (no dataURI, tiny → fast decode).

---

## Architecture Overview

```
renderExportCanvas(targetWidth, targetHeight):

  canvas ← new offscreen canvas (targetW × targetH), init'd transparent
  ctx = canvas.getContext('2d')

  for each visible renderable layer (in SVG z-order):
    ───────────────────────────────────────────────────
    if layer === 'layer-image':
      applyImageCanvasTransform(ctx, targetW, targetH, dims)
      ctx.drawImage(dom.imageEl, 0, 0, naturalW, naturalH)
      ctx.restore()

    else:  // annotation, watermark, or user layer
      if layerEl has no visible children: skip
      layerSvg = buildLayerExportSvg(layerId, targetW, targetH, dims)
      await renderSvgToCtx(ctx, layerSvg, targetW, targetH)
    ───────────────────────────────────────────────────

  return canvas   // to caller for JPEG encode or buildPdf()
```

**No white fill** — the canvas starts transparent. Layers composite on top of each other
with transparent backgrounds. Callers add a background if needed (JPEG: white fill in
exportJPG; PDF: white fill per-page already in buildPdf).

---

## Detailed Step Plan

### Step 1 — Add `getLayerElementIds(layerId)` helper

**File:** `modules/fileio.js`

Returns a `Set` of element IDs that are DOM children of the given layer's `<g>` element.

```js
function getLayerElementIds(layerId) {
  var layerEl = document.getElementById(layerId);
  if (!layerEl) return new Set();
  var ids = new Set();
  layerEl.querySelectorAll('[id]').forEach(function(el) { ids.add(el.id); });
  return ids;
}
```

Used to filter `state.elements` for per-layer serialization.

---

### Step 2 — Extract `serializeElement(el, withinGroup)` as a module-level function

**File:** `modules/fileio.js`

Currently a nested function inside `generateSVGString()`. Move it to module scope so both `generateSVGString()` and `renderExportCanvas()` can call it without duplication. Keep the exact same logic — no behavioral change.

```js
function serializeElement(el, withinGroup) {
  // ... identical to current code at fileio.js:991-1051
}
```

**Callers:** `generateSVGString()`, `buildLayerExportSvg()`

---

### Step 3 — Add `buildLayerExportSvg(layerId, targetW, targetH, dims)`

**File:** `modules/fileio.js`

Builds a minimal SVG string containing only one layer's content:

```
<svg xmlns="..." xmlns:xlink="..." viewBox="0 0 {dims.w} {dims.h}"
     width="{targetW}" height="{targetH}">

  // For watermark layer: prepend buildWatermarkDefs()

  <g transform="{imgTransform}">
    // Filtered elements from state.elements belonging to this layer
    // Each serialized via serializeElement()
  </g>
</svg>
```

- For `layer-watermark`: also include `buildWatermarkDefs()` before the `<g>`
- For `layer-image`: return `null` (image layer uses direct canvas draw, not SVG)
- For annotation/user layers: filter `state.elements` using `getLayerElementIds(layerId)`, serialize each matching element via `serializeElement()`
- **No `<image>` element with dataURI** → SVG is tiny (just annotations)

---

### Step 4 — Add `applyImageCanvasTransform(ctx, targetW, targetH, dims)`

**File:** `modules/fileio.js`

Mirrors the SVG transform from `updateImageTransform()` (`editor.js:163-196`) using Canvas 2D API:

```
ctx.save()
ctx.scale(targetW / dims.w, targetH / dims.h)

cx = dims.w / 2
cy = dims.h / 2
ctx.translate(cx, cy)
if (rotation) ctx.rotate(rotation * Math.PI / 180)
if (flipH) ctx.scale(-1, 1)
if (flipV) ctx.scale(1, -1)
ctx.translate(-naturalW / 2, -naturalH / 2)
// drawImage called after, then ctx.restore()
```

Positioned right before `ctx.drawImage(dom.imageEl, 0, 0, naturalW, naturalH)`.

---

### Step 5 — Add `renderSvgToCtx(ctx, svgStr, targetW, targetH)` helper

**File:** `modules/fileio.js`

General-purpose function: writes an SVG string to OPFS, reads back as blob, creates ObjectURL, loads as Image, draws onto canvas, cleans up.

```js
async function renderSvgToCtx(ctx, svgStr, targetW, targetH) {
  await _tmpWrite('_export_tmp.svg', svgStr);
  svgStr = null;
  var blob = await _tmpReadBlob('_export_tmp.svg');
  var url = URL.createObjectURL(blob);
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() {
      ctx.drawImage(img, 0, 0, targetW, targetH);
      URL.revokeObjectURL(url);
      _tmpRemove('_export_tmp.svg');
      resolve();
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      _tmpRemove('_export_tmp.svg');
      reject(new Error('SVG render failed for layer'));
    };
    img.src = url;
  });
}
```

**Key:** The SVG has no background fill → compositing is additive with transparent gaps between layers.

---

### Step 6 — Add `renderExportCanvas(targetW, targetH)` orchestrator

**File:** `modules/fileio.js`

```js
async function renderExportCanvas(targetW, targetH) {
  var c = document.createElement('canvas');
  c.width = targetW; c.height = targetH;
  var ctx = c.getContext('2d');
  // NO white fill — canvas stays transparent. Callers add background if needed.

  var dims = getViewBoxDims();
  var img = state.image;

  // Determine layer render order (SVG z-order: image → user layers → watermark)
  var renderableLayers = [];

  // 1. layer-image is always first (if visible)
  if (isLayerVisible('layer-image')) renderableLayers.push('layer-image');

  // 2. User annotation layers (in DOM order before watermark)
  var layerOrder = getVisibleLayerOrder();  // see Step 6a
  for (var i = 0; i < layerOrder.length; i++) {
    var id = layerOrder[i];
    if (id === 'layer-image' || id === 'layer-watermark' || id === 'layer-grid') continue;
    if (isLayerVisible(id) && hasLayerContent(id)) renderableLayers.push(id);
  }

  // 3. Watermark layer (if visible)
  if (isLayerVisible('layer-watermark')) renderableLayers.push('layer-watermark');

  // Render each layer
  for (var li = 0; li < renderableLayers.length; li++) {
    var layerId = renderableLayers[li];

    if (layerId === 'layer-image') {
      // Direct canvas draw — no SVG, no OPFS, no Image decode
      applyImageCanvasTransform(ctx, targetW, targetH, dims);
      ctx.drawImage(dom.imageEl, 0, 0, img.naturalWidth, img.naturalHeight);
      ctx.restore();
    } else {
      // Build per-layer SVG (annotations or watermark — no dataURI)
      var svg = buildLayerExportSvg(layerId, targetW, targetH, dims);
      if (svg) await renderSvgToCtx(ctx, svg, targetW, targetH);
    }
  }

  return c;
}
```

#### Step 6a — Get visible layer order from layers module

Add an export to `modules/layers.js`:

```js
export function getLayerOrder() {
  return layerOrder.map(function(l) { return l.id; });
}
```

Or inline the logic in `fileio.js` by querying the SVG DOM order. The SVG DOM order (first child = bottom) mirrors the z-order. We can get layers in order:

```js
function getVisibleLayerOrder() {
  // Watermark is always last in SVG DOM; image first; user layers in between
  var order = [];
  var svg = document.getElementById('editor-svg');
  var children = svg.querySelectorAll('g[id^="layer-"], g[id^="layer-user-"]');
  for (var i = 0; i < children.length; i++) {
    order.push(children[i].id);
  }
  return order;
}
```

---

### Step 7 — Rewrite `exportJPG()` rendering section

**File:** `modules/fileio.js` — replace lines 1091-1224

Old code path (to be removed):
```
1. Build full SVG with embedded dataURI (large) → 600+ lines of annotation serialization
2. Write to OPFS → read blob → ObjectURL → Image decode (re-decodes entire dataURI)
3. Canvas ← drawImage(svgImage)
4. toBlob JPEG → download
```

New code path:
```
1. showExportProgress('1/N — Rendering image...')
2. canvas = await renderExportCanvas(targetWidth, targetHeight)
     └─ iterates visible layers, each drawn via ctx.drawImage() (transparent bg)
3. Fill background: since JPEG doesn't support alpha, fill canvas with white
     ctx = canvas.getContext('2d')
     ctx.globalCompositeOperation = 'destination-over'
     ctx.fillStyle = '#ffffff'
     ctx.fillRect(0, 0, targetWidth, targetHeight)
     ctx.globalCompositeOperation = 'source-over'
4. showExportProgress('N-1/N — Encoding JPEG...')
5. toBlob JPEG → download
6. showExportProgress('N/N — Done!')
```

**Progress steps:** N/N format where N = `visibleLayerCount + 2` (encoding + done). Example with 3 visible layers: 1/5 → 2/5 → 3/5 → 4/5 → 5/5 (3 layer renders + encoding + done).

**Background note:** `renderExportCanvas()` NEVER applies a background fill. Transparency passes through.
Each export format handles background as needed:
- **JPEG:** White fill added in `exportJPG()` using `destination-over` compositing (behind layers)
- **PDF:** `buildPdf()` already fills each page canvas with white (`ctx.fillRect` at lines 1530, 1559)
- **Future PNG export:** Just call `renderExportCanvas()` with no fill → true transparency

---

### Step 8 — Rewrite `exportPDF()` rendering section

**File:** `modules/fileio.js` — replace lines 1245-1374

Same replacement as Step 7. The `renderExportCanvas()` result feeds into `buildPdf()` identically to how the old canvas did.

---

### Step 9 — Replace `toDataURL` + `base64ToBytes` with `toBlob` in `buildPdf()`

**File:** `modules/fileio.js` — two locations:

1. Ref page canvas (line 1548):
   ```
   // OLD:
   var refJpeg = base64ToBytes(ref.toDataURL('image/jpeg', 0.92).split(',')[1]);
   // NEW:
   var refJpeg = await new Promise(function(resolve) {
     ref.toBlob(function(b) { resolve(new Uint8Array(await b.arrayBuffer())); }, 'image/jpeg', 0.92);
   });
   ```

2. Tile loop (line 1562):
   ```
   // OLD:
   var jpegBytes = base64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]);
   // NEW:
   var jpegBytes = await new Promise(function(resolve) {
     c.toBlob(function(b) { resolve(new Uint8Array(await b.arrayBuffer())); }, 'image/jpeg', 0.92);
   });
   ```

This eliminates the ~70% CPU waste from base64 encode→decode round-trip.

---

### Step 10 — Reuse single canvas in `buildPdf()` tile loop

**File:** `modules/fileio.js`

Move `document.createElement('canvas')` before the tile loop (outside `for (var ti = 0; ...)`):

```js
var sharedCanvas = document.createElement('canvas');
sharedCanvas.width = pgPxW;
sharedCanvas.height = pgPxH;

for (var ti = 0; ti < numPages; ti++) {
  var ctx = sharedCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pgPxW, pgPxH);
  ctx.drawImage(srcCanvas, t.sx, t.sy, t.sw, t.sh, t.dx, t.dy, t.dw, t.dh);
  // ... toBlob ...
}
```

Avoids N canvas allocations (N = number of PDF pages).

---

### Step 11 — Clean up dead code

**File:** `modules/fileio.js`

- Remove `base64ToBytes()` if no remaining callers (check after Step 9)
- Remove the duplicated inline annotation serialization from `exportJPG()` (lines 1108-1162) and `exportPDF()` (lines 1257-1307) — replaced by `buildLayerExportSvg()` + `serializeElement()`
- Remove the SVGBuilder logic in `exportJPG()` (OPFS write/read for full SVG with dataURI, lines 1166-1196) and similar in `exportPDF()` (lines 1310-1338)

---

## Progress Bar Design

Dynamic step counting based on visible layers:

```
visibleLayers = count of renderable layers (image + annotation/user + watermark)
totalSteps = visibleLayers + 2   // + encoding + done
step = 0

for each visible layer:
  step++; updateExportProgress(`${step}/${totalSteps} — Rendering ${layerName}...`)

step++; updateExportProgress(`${step}/${totalSteps} — Encoding JPEG/PDF...`)
step++; updateExportProgress(`${step}/${totalSteps} — Done!`)
```

Layer name lookup: `layers.js` has `name` field per layer entry. Export a `getLayerName(layerId)` function or use a simple mapping.

---

## Key Files Modified

| File | Changes |
|------|---------|
| `modules/fileio.js` | Added 6 new functions (`getLayerElementIds`, `getExportLayerIds`, `buildLayerExportSvg`, `applyImageCanvasTransform`, `renderSvgToCtx`, `renderExportCanvas`), extracted `serializeElement` to module scope, rewrote `exportJPG`/`exportPDF` rendering, modified `buildPdf` (toBlob + canvas reuse) |
| `modules/editor.js` | No changes (uses existing `dom.imageEl`, `getViewBoxDims()`, `state.image`) |
| `modules/layers.js` | No changes (layer order queried from DOM via `getExportLayerIds()`) |

---

## Implementation Notes

- **Progress bar:** Uses simple labels (`"Rendering image..."`, `"Rendering Annotations..."`, `"Encoding JPEG..."`) with elapsed time appended as `[Xs]` or `[Xm Ys]`
- **Done + countdown:** `showExportDone()` shows `"Done! [Xs]  (auto-close in 5)"` counting down to 1 with an `×` button to dismiss early. Bar auto-hides after 5 seconds
- **White background:** `renderExportCanvas()` NEVER applies a background fill. Transparent by design.
  - JPEG: white fill via `globalCompositeOperation = 'destination-over'` in `exportJPG()`
  - PDF: `buildPdf()` already fills each page canvas with white
  - Future PNG: just call `renderExportCanvas()` → true transparency
- **No `modules/layers.js` changes needed:** Layer order is queried from DOM via `svg.querySelectorAll('g[id^="layer-"], g[id^="layer-user-"]')`

---

## Testing Checklist

- [x] Syntax validation: `node --check modules/fileio.js` passes
- [ ] Export JPG with all 3 layers visible → correct image with annotations + watermark
- [ ] Export JPG with image layer hidden → transparent background + annotations only
- [ ] Export JPG with annotation layer hidden → image + watermark only
- [ ] Export JPG with watermark hidden → image + annotations only
- [ ] Export JPG with user-created layers + visibility toggles
- [ ] Export PDF same combinations
- [ ] Export with rotation (90°, 180°, 270°) — annotations align
- [ ] Export with flipH / flipV — mirrors correctly
- [ ] No regression: SVG Save still works (`generateSVGString` unchanged behavior)
- [ ] `buildPdf()` produces valid PDF (Adobe Acrobat + browser viewer)
- [ ] Memory: single canvas reused in tile loop (no per-page allocation)
