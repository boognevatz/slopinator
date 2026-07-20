# Layer Save/Load Plan — SVG-as-source-of-truth

## Philosophy

Layers and groups are both `<g>` elements in the SVG. The SVG DOM hierarchy is the
source of truth for layer membership. `state.elements` is a flat convenience
index — it does NOT need layer fields. Only the save/load path needs to
understand the layer structure.

## Save path: `generateSVGString()` (fileio.js)

### Current code (lines ~1349-1369)

```
<g id="layer-image" visibility="...">
  <image data-type="background" .../>
</g>
<g id="layer-annotation" transform="..." visibility="...">
  // ALL state.elements serialized here (flat)
</g>
<defs>...</defs>  // buildWatermarkDefs
<g id="layer-watermark" transform="..." visibility="...">
  // watermark rect
</g>
```

Problem: all user layers are dumped into `layer-annotation`. User-created layers
(`layer-user-*`) are invisible to save.

### New approach

Walk the live SVG DOM children in order. For each `<g>` that is a user layer
(layer-annotation or layer-user-*), serialize its child elements separately.

```
// Save image block (unchanged)
<g id="layer-image" visibility="...">...</g>

// Walk dom.svg.children in order
// For each <g id="layer-annotation">, <g id="layer-user-1">, etc.:
<g id="layer-annotation" data-layer-name="Annotations"
    transform="..." visibility="...">
  // Elements belonging to this layer only
  <g id="line-1" data-type="line">...</g>
  <g id="group-1" data-type="group">
    <g id="line-2" data-type="line">...</g>
  </g>
</g>
<g id="layer-user-1" data-layer-name="My Layer"
    transform="..." visibility="hidden">
  <rect id="rect-1" data-type="rectangle">...</rect>
</g>

// Save watermark block (unchanged)
<defs>...</defs>
<g id="layer-watermark" ...>...</g>
```

#### Detailed algorithm

```
function generateSVGString() {
  ...
  svg += <g id="layer-image" visibility="...">...</g>

  // Walk DOM children in order — preserves layer ordering
  for each child of dom.svg:
    if child is <g> with id starting with "layer-" or "layer-user-":
      layerId = child.id
      if layerId is "layer-image", "layer-watermark", "layer-grid":
        continue  // handled separately

      visibility = child.getAttribute('visibility')
      layerName = child.getAttribute('data-layer-name') || layerId

      svg += <g id="LAYER_ID" data-layer-name="LAYER_NAME"
                 transform="TRANSFORM" visibility="VISIBILITY">

      // Find elements belonging to this layer in state.elements
      // by checking their DOM parentNode ancestry
      for each el in state.elements:
        if el.parentId: continue  // group children — serialized by parent
        domEl = document.getElementById(el.id)
        if domEl is inside the current layer's <g>:
          svg += serializeElement(el)

      svg += </g>

  svg += buildWatermarkDefs()
  svg += <g id="layer-watermark" ...>...</g>
  ...
}
```

#### Helper: `isElementInLayer(elementId, layerId)`

```
function isElementInLayer(elementId, layerId) {
  var domEl = document.getElementById(elementId);
  if (!domEl) return false;
  var p = domEl.parentNode;
  while (p && p.id && p.id !== layerId && !p.id.startsWith('layer-')) {
    p = p.parentNode;
  }
  return p && p.id === layerId;
}
```

This walks up from the element to find which layer `<g>` contains it. Correctly
handles elements nested inside group `<g>` elements (which have ids not starting
with "layer-", so the walk continues upward to the actual layer).

#### Performance

O(elements * layers) in worst case. With <500 elements and <10 layers, this is
negligible. Can be optimized later with a pre-grouping pass if needed.

## Open path: `openSVGProject()` (fileio.js)

### Current flow

1. Parse SVG text into `doc` document
2. Extract image info (dataURI, dimensions, rotation, flip)
3. Parse ALL annotation elements globally via `svgRoot.querySelectorAll(...)`
4. Parse groups globally
5. Set parentId on group children
6. `restoreState()` — clears and recreates the image in live editor SVG
7. Recreate ALL elements into `dom.annotationLayer` (single layer)
8. Recreate group structure (also in `dom.annotationLayer`)
9. Restore layer visibility (recent addition)
10. Transfer watermark pattern (recent addition)
11. `renderLayerList()`, `updateWatermark()`

Problem: step 7 dumps everything into annotation layer, ignoring the layer
structure from the SVG file.

### New flow

#### Step A — Extract layer structure from parsed SVG (new, after step 2)

```
var parsedLayers = [];
for each child in svgRoot.children:
  if child.tagName === 'g' and attribute 'id' matches annotation/user:
    parsedLayers.push({
      id: child.getAttribute('id'),
      name: child.getAttribute('data-layer-name') || child.getAttribute('id'),
      visibility: child.getAttribute('visibility'),
      order: parsedLayers.length,  // preserve parsed order
    })
```

#### Step B — Assign layerId to each parsed element (new, after step 5)

After all elements are collected into the `elements` array (current code line 978
to 1036), add a pass to assign layer membership based on the parsed SVG DOM:

```
for each el in elements:
  domEl = doc.getElementById(el.id)
  if domEl:
    // Walk up from the element to find which layer <g> contains it
    p = domEl.parentNode
    while p and p.id and p.id !== 'layer-annotation'
          and !p.id.startsWith('layer-user-'):
      p = p.parentNode
    if p:
      el.layerId = p.id  // ephemeral — only used during open, not stored in state.elements
  if !el.layerId:
    el.layerId = 'layer-annotation'  // fallback for old files
```

Note: `el.layerId` is a temporary property used only during the open process.
It is NOT added to `state.elements`. After reconstruction, it's discarded.

#### Step C — Rebuild layerOrder and DOM structure (replaces step 6-8)

After `restoreState()`:

```
// Reset layerOrder to only system layers
layerOrder = layerOrder.filter(l => l.system)

// Determine userLayerCounter from parsed layer IDs
maxUserNum = 1
for each pl in parsedLayers:
  if pl.id starts with 'layer-user-':
    n = parseInt(pl.id.replace('layer-user-', ''))
    if n > maxUserNum: maxUserNum = n
userLayerCounter = maxUserNum

// Group parsed elements by layer
elsByLayer = {}
for each el in parsedElements:
  lid = el.layerId || 'layer-annotation'
  if !elsByLayer[lid]: elsByLayer[lid] = []
  elsByLayer[lid].push(el)

// For each parsed layer (in order), create DOM <g> and insert before watermark
watermarkIdx = layerOrder.findIndex(l => l.id === 'layer-watermark')
for each pl in parsedLayers:
  // Create or reuse <g> element
  liveG = document.getElementById(pl.id)
  if !liveG:
    liveG = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    liveG.setAttribute('id', pl.id)
  else:
    liveG.innerHTML = ''  // clear existing children

  // Insert before watermark <g>
  wmG = document.getElementById('layer-watermark')
  if wmG and wmG.parentNode:
    wmG.parentNode.insertBefore(liveG, wmG)

  // Add to layerOrder
  layerOrder.splice(watermarkIdx + index(pl), 0,
    { id: pl.id, name: pl.name, system: false })
```

#### Step D — Recreate elements into correct layers (replaces step 7-8)

```
state.elements = []

for each pl in parsedLayers:
  lid = pl.id
  liveG = document.getElementById(lid)
  if !liveG: continue

  // Set dom.annotationLayer to this layer's <g>
  // (direct assignment avoids selectLayer's renderLayerList overhead)
  dom.annotationLayer = liveG

  layerEls = elsByLayer[lid] || []
  if layerEls.length === 0:
    // Still add the layer entry to layerOrder for visibility persistence
    continue

  // First pass: non-group, non-child elements
  for each el in layerEls:
    if el.type === 'group' or el.parentId: continue
    recreateElement(el)
    state.elements.push(el)

  // Second pass: groups (move children inside group <g>)
  for each gData in layerEls where gData.type === 'group':
    gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    gEl.id = gData.id
    gEl.setAttribute('data-type', 'group')
    for each childId in gData.childIds:
      childDom = dom.annotationLayer.querySelector('#' + CSS.escape(childId))
      if childDom: gEl.appendChild(childDom)
    dom.annotationLayer.appendChild(gEl)
    state.elements.push(gData)
```

#### Step E — Restore visibility and finish

```
// Restore visibility from parsed layer data
for each pl in parsedLayers:
  liveG = document.getElementById(pl.id)
  if !liveG: continue
  if pl.visibility === 'hidden':
    liveG.setAttribute('visibility', 'hidden')
  else if pl.visibility:
    liveG.removeAttribute('visibility')
  // If no visibility attr in file: leave default

// Update layer list UI
renderLayerList()

// Select first user layer
firstUser = layerOrder.find(l => !l.system)
if firstUser: selectLayer(firstUser.id)

// Watermark (handled separately)
updateWatermark()

// History, palette, tool
clearHistory()
refreshPalette()
switchTool(state.defaultTool || 'text')
```

### Helper: `recreateElement(el)`

Simple dispatch to avoid repetition:

```
function recreateElement(el) {
  if (el.type === 'line') addLineElement(el)
  else if (el.type === 'text') addTextElement(el)
  else if (el.type === 'freehand') addFreehandElement(el)
  else if (el.type === 'rectangle') addRectangleElement(el)
}
```

## What does NOT change

| Area | Reason |
|---|---|
| `state.elements` structure | Stays flat — no `layerId` field added |
| Element creation (line.js, text.js, etc.) | `dom.annotationLayer` already places nodes in the correct `<g>` |
| Undo/redo (history.js) | Command pattern — operates on DOM + state.elements as before |
| Group behavior (group.js) | Groups nest via DOM and `childIds`/`parentId` — unchanged |
| Layer add/remove/reorder (layers.js) | Modifies `layerOrder` and DOM — unchanged |
| Export rendering (buildLayerExportSvg) | Already queries elements per layer via DOM — unchanged |
| Eyeball toggle (layers.js) | Sets `visibility` on the layer `<g>` — unchanged |

## What changes

| File | Function | Change |
|---|---|---|
| `fileio.js` | `generateSVGString()` | Replace hardcoded `<g id="layer-annotation">` block with DOM walk over layer containers |
| `fileio.js` | `openSVGProject()` | After `restoreState()`, reconstruct layer structure and DOM, then rebuild `state.elements` per layer |
| `fileio.js` | (new helper) `isElementInLayer()` | DOM parent walk to find which layer an element belongs to |

## Backward compatibility

| Scenario | Behavior |
|---|---|
| Old SVG file (flat `<g id="layer-annotation">` all elements) | `parsedLayers` has one entry (`layer-annotation`). All elements assigned to `layer-annotation`. Works as before. |
| Old SVG file (no layer `<g>` structure, elements at root) | DOM parent walk finds no layer ancestor → `el.layerId = 'layer-annotation'`. All elements go to default layer. |
| New SVG file with multiple layers | Full round-trip preservation: layer names, visibility, ordering, element membership. |
| Groups inside layers | Group children have same ancestry as their parent group → both are in the same layer. `isElementInLayer()` follows parent chain past the group `<g>` to the layer `<g>`. |

## Order of operations in `openSVGProject()` (new)

```
1. Parse SVG into `doc` (current)
2. Extract image info (current)
3. Extract parsedLayers from svgRoot.children (NEW)
4. Parse annotation elements globally (current)
5. Parse groups globally (current)
6. Set parentId on group children (current)
7. Assign elements to parsed layers via DOM parent walk (NEW)
8. restoreState() (current — clears and recreates image)
9. Rebuild layerOrder from parsedLayers (NEW)
10. Create/clear layer <g> elements, insert before watermark (NEW)
11. For each layer: recreate elements, rebuild groups, push to state.elements (NEW)
12. Restore visibility from parsed layer data (modified)
13. renderLayerList() (current)
14. selectLayer(firstUser) (NEW)
15. Transfer watermark pattern (current)
16. updateWatermark() (current)
17. clearHistory(), refreshPalette(), switchTool() (current)
```
