# Image Annotator v0.1 — Specification & Implementation Plan

## 1. Overview

A single-page web application for annotating images. The user opens an image,
draws straight lines and places text on top of it, then exports the result as
JPG or saves the project as a self-contained SVG for later editing.

The entire UI is plain HTML + CSS + vanilla JavaScript. No frameworks, no build
step. One `index.html`, one `style.css`, one `main.js` (may be split into
modules later).

---

## 2. Feature Specification

### 2.1 Canvas / Editor Area

- The editor is an `<svg>` element that fills the available viewport area
  (below the toolbar).
- The opened image is rendered as an `<image>` element inside the SVG.
- The image **fits the editor** while maintaining aspect ratio (object-fit
  "contain" behaviour). Letterboxing is acceptable.
- The SVG `viewBox` is set to the image's native dimensions so all annotations
  are stored in image-pixel coordinates, making export deterministic.

### 2.2 Image Import

- A **file input button** ("Open Image") accepts `.png`, `.jpg`, `.jpeg`,
  `.gif`, `.bmp`, `.webp`.
- The same button also accepts `.svg` files (treated as a saved project — see
  §2.9).
- On load the image is converted to a **base64 data-URI** and embedded in the
  SVG `<image>` element so the project file is self-contained.

### 2.3 Image Transforms

All transforms apply to the image only (annotations stay in their logical
positions relative to the image).

| Transform          | Implementation                          |
| ------------------ | --------------------------------------- |
| Rotate 90° CW      | Cycle through 0 → 90 → 180 → 270 → 0   |
| Rotate 90° CCW     | Reverse cycle                           |
| Flip Horizontal    | Mirror on the vertical axis             |
| Flip Vertical      | Mirror on the horizontal axis           |

Transforms are stored as a single `transform` attribute on the `<image>`
element (composed matrix or individual transform functions). The `viewBox` is
updated on rotation so the editor area adapts from landscape to portrait and
vice-versa.

### 2.4 Drawing — Straight Lines

- **Tool activation**: click the "Line" button in the toolbar (or press `L`).
- **Drawing gesture**: click to set start point → drag → release to set end
  point. A preview line follows the cursor during the drag.
- Each line is an SVG `<line>` element with attributes:
  `x1, y1, x2, y2, stroke, stroke-width, data-type="line"`.
- After creation the line can be **selected, moved, resized (by dragging
  endpoints), and deleted**.

### 2.5 Text

- **Tool activation**: click the "Text" button in the toolbar (or press `T`).
- **Placement**: click on the canvas to place a text element. A default
  placeholder (`"Text"`) appears and immediately enters inline edit mode.
- Each text is an SVG `<text>` element with attributes:
  `x, y, font-size, fill, data-type="text"`.
- After creation the text can be:
  - **Selected** (click).
  - **Moved** (drag).
  - **Resized** (drag a resize handle; changes `font-size`).
  - **Re-edited** (double-click to enter edit mode).
  - **Deleted** (Delete / Backspace key, or toolbar button).

### 2.6 Selection & Interaction Model

Three toolbar modes (mutual-exclusive radio-style buttons):

| Mode   | Shortcut | Behaviour                                       |
| ------ | -------- | ----------------------------------------------- |
| Select | `V`      | Click an element to select. Drag to move. Handles shown for resize. |
| Line   | `L`      | Draw a new line.                                |
| Text   | `T`      | Click to place new text.                        |

When an element is selected:
- A dashed bounding box (or handles) appears around it.
- **Delete** / **Backspace** key removes it.
- The property bar (below toolbar) shows current color + thickness (lines) or
  color + font-size (text) and allows changing them.
- **Escape** deselects.
- Clicking empty canvas deselects.

### 2.7 Color Palette

- **12 preset swatches** shown in the toolbar as small colored squares.
- Defaults: black, white, red, green, blue, yellow, orange, purple, cyan,
  magenta, grey, brown.
- Each swatch is **editable**: right-click (or long-press) a swatch to open a
  native `<input type="color">` picker and replace that preset.
- The active color applies to the next drawn line or placed text, and can be
  changed on a selected element.
- The full 12-color palette (including any user modifications) is **persisted
  in the SVG** file as a comment block so it survives save/load:
  ```xml
  <!-- annotator-palette: #000000,#ffffff,#ff0000,...  -->
  ```

### 2.8 Line Thickness

- **6 presets** shown as a dropdown or segmented control:
  `1px, 2px, 4px, 6px, 8px, 12px` (values in SVG user units).
- Each preset is **editable**: the user can type a custom value to replace any
  preset.
- The active thickness applies to the next drawn line, and can be changed on a
  selected line.
- Presets are persisted in the SVG as a comment:
  ```xml
  <!-- annotator-thickness: 1,2,4,6,8,12 -->
  ```

### 2.9 Save as SVG (Project File)

- Button: **"Save SVG"** (or `Ctrl+S`).
- Produces a standalone `.svg` file containing:
  - The base64-embedded `<image>` (with transforms).
  - All `<line>` and `<text>` annotation elements.
  - Comment blocks for palette and thickness presets (§2.7, §2.8).
  - A root-level `data-annotator-version="0.1"` attribute to identify the
    file as a project file.
- Downloaded via a programmatic `<a download>` click.

### 2.10 Open SVG (Resume Editing)

- When the user opens a `.svg` file through the "Open Image" button:
  1. Detect the `data-annotator-version` attribute.
  2. Parse the embedded `<image>`, all `<line>` and `<text>` elements.
  3. Parse comment blocks to restore palette and thickness presets.
  4. Populate the editor exactly as it was when saved.
- If a `.svg` without the marker attribute is opened, treat it as a plain
  image (rasterize or embed as-is).

### 2.11 Export as JPG

- Button: **"Export JPG"**.
- Opens a small modal / dropdown with size options:

  | Label      | Behaviour                                       |
  | ---------- | ----------------------------------------------- |
  | 320 wide   | Scale to 320px width, proportional height       |
  | 640 wide   | Scale to 640px width, proportional height       |
  | 1920 wide  | Scale to 1920px width, proportional height      |
  | Original   | Native image dimensions                         |

- Rendering pipeline:
  1. Create an off-screen `<canvas>` at the target resolution.
  2. Serialize the SVG (image + annotations) to a data-URI.
  3. Draw the SVG onto the canvas via `Image` → `drawImage`.
  4. `canvas.toBlob('image/jpeg', 0.92)` → download.

### 2.12 Undo / Redo

- **Session-only** (not persisted to file).
- Stack-based: every mutating action (add, move, resize, delete, change
  property, image transform) pushes a snapshot or command onto the undo stack.
- `Ctrl+Z` — undo. `Ctrl+Y` / `Ctrl+Shift+Z` — redo.
- Toolbar buttons for undo/redo as well.

### 2.13 Keyboard Shortcuts Summary

| Key              | Action                    |
| ---------------- | ------------------------- |
| `V`              | Select mode               |
| `L`              | Line mode                 |
| `T`              | Text mode                 |
| `Delete` / `Backspace` | Delete selected element |
| `Escape`         | Deselect / cancel draw    |
| `Ctrl+Z`         | Undo                      |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo            |
| `Ctrl+S`         | Save SVG                  |

---

## 3. UI Layout

```
┌──────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                      │
│ [Open] [Save SVG] [Export JPG ▼]                             │
│ [Select|Line|Text]   [Undo][Redo]                            │
│ [Rotate CW][Rotate CCW][Flip H][Flip V]                     │
│ Colors: [■][■][■][■][■][■][■][■][■][■][■][■]                │
│ Thickness: [1][2][4][6][8][12]                               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│                     SVG EDITOR AREA                          │
│                   (image + annotations)                      │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- The toolbar is a fixed bar at the top.
- The SVG editor fills the remaining viewport height.
- Responsive: works on desktop browsers. Mobile/touch is out of scope for
  v0.1.

---

## 4. Technical Architecture

### 4.1 File Structure

```
image_annotator/
├── index.html          # Single HTML page, loads CSS + JS
├── style.css           # All styling
├── main.js             # Application entry, initializes modules
├── modules/
│   ├── editor.js       # SVG editor setup, viewBox management, image loading
│   ├── tools.js        # Tool state machine (Select / Line / Text)
│   ├── select.js       # Selection, move, resize, delete logic
│   ├── line.js         # Line drawing logic
│   ├── text.js         # Text placement and inline editing logic
│   ├── transform.js    # Image rotate / flip
│   ├── history.js      # Undo / redo stack
│   ├── palette.js      # Color palette + thickness presets UI & state
│   ├── fileio.js       # Open image, open SVG project, save SVG, export JPG
│   └── utils.js        # Shared helpers (SVG element creation, coordinate math)
├── plan.md             # This file
└── README.md           # (optional) brief usage instructions
```

All modules use ES module `import`/`export`. The HTML loads `main.js` with
`<script type="module">`.

### 4.2 State Management

A single global state object (plain JS object) holds:

```js
state = {
  image: {
    dataURI: "...",           // base64 source
    naturalWidth: 0,
    naturalHeight: 0,
    rotation: 0,              // 0 | 90 | 180 | 270
    flipH: false,
    flipV: false,
  },
  elements: [],               // array of annotation descriptors
  selectedId: null,
  activeTool: "select",       // "select" | "line" | "text"
  activeColor: "#000000",
  activeThickness: 2,
  palette: [...],             // 12 hex strings
  thicknessPresets: [...],    // 6 numbers
};
```

Each annotation element descriptor:

```js
// Line
{ id, type: "line", x1, y1, x2, y2, stroke, strokeWidth }

// Text
{ id, type: "text", x, y, content, fontSize, fill }
```

The SVG DOM is the **source of truth for rendering**; the state object is the
source of truth for serialization and undo/redo.

### 4.3 Undo / Redo Implementation

- **Command pattern**: each action records a `{ do(), undo() }` pair pushed
  onto an undo stack.
- Redo stack is cleared on any new action.
- Actions: `addElement`, `removeElement`, `moveElement`, `resizeElement`,
  `changeProperty`, `transformImage`.

### 4.4 Coordinate System

- The SVG `viewBox` matches the image's natural pixel dimensions (after
  accounting for rotation: if rotated 90°/270°, width and height swap).
- All annotations are stored in this coordinate space.
- Mouse events are converted from screen coords to SVG coords using
  `SVGSVGElement.createSVGPoint()` and `getScreenCTM().inverse()`.

### 4.5 JPG Export Pipeline

1. Clone the SVG DOM (strip selection handles, data attributes).
2. Serialize to XML string → `encodeURIComponent` → data-URI.
3. Create `new Image()`, set `src` to the SVG data-URI.
4. On `load`, draw to an offscreen `<canvas>` at the target size.
5. `canvas.toBlob("image/jpeg", 0.92)` → `URL.createObjectURL` →
   programmatic `<a download>` click.

---

## 5. Implementation Phases

### Phase 1 — Skeleton & Image Loading
- [ ] Create `index.html` with toolbar markup and SVG container.
- [ ] Create `style.css` with layout (toolbar fixed top, SVG fills rest).
- [ ] Implement `editor.js`: initialize SVG, set viewBox.
- [ ] Implement `fileio.js` (partial): open image file, convert to base64,
      render `<image>` in SVG, auto-fit viewBox.

### Phase 2 — Image Transforms
- [ ] Implement `transform.js`: rotate CW, rotate CCW, flip H, flip V.
- [ ] Update viewBox on rotation (swap width/height for 90°/270°).
- [ ] Wire toolbar buttons.

### Phase 3 — Line Drawing
- [ ] Implement `line.js`: mousedown → create preview line → mousemove
      update → mouseup finalize.
- [ ] Store line in state + render as `<line>` in SVG.
- [ ] Apply active color and thickness.

### Phase 4 — Text Placement
- [ ] Implement `text.js`: click to place `<text>`, enter inline edit mode.
- [ ] Double-click to re-edit.
- [ ] Apply active color and font-size.

### Phase 5 — Selection & Manipulation
- [ ] Implement `select.js`: click to select, show handles.
- [ ] Drag to move (lines: translate both endpoints; text: update x/y).
- [ ] Resize lines (drag individual endpoints).
- [ ] Resize text (drag handle to change font-size).
- [ ] Delete selected element (Delete key + toolbar button).
- [ ] Implement `tools.js`: mode switching (Select / Line / Text).

### Phase 6 — Color Palette & Thickness
- [ ] Implement `palette.js`: render 12 color swatches, click to select,
      right-click to edit via color picker.
- [ ] Render 6 thickness presets, click to select, mechanism to edit.
- [ ] Changing color/thickness on a selected element updates it live.

### Phase 7 — Undo / Redo
- [ ] Implement `history.js`: command stack, push/pop, undo/redo.
- [ ] Integrate with all mutating operations.
- [ ] Wire `Ctrl+Z`, `Ctrl+Y`, toolbar buttons.

### Phase 8 — Save SVG
- [ ] Serialize SVG DOM to string.
- [ ] Inject comment blocks for palette + thickness presets.
- [ ] Add `data-annotator-version="0.1"` to root `<svg>`.
- [ ] Trigger download as `.svg`.

### Phase 9 — Open SVG (Resume Editing)
- [ ] Detect project SVG vs plain image on file open.
- [ ] Parse `<image>`, `<line>`, `<text>` elements back into state.
- [ ] Parse comment blocks to restore palette and thickness presets.
- [ ] Restore editor state fully.

### Phase 10 — Export JPG
- [ ] Build export modal with size options (320, 640, 1920, original).
- [ ] Implement SVG-to-canvas-to-JPEG pipeline.
- [ ] Trigger download as `.jpg`.

### Phase 11 — Polish
- [ ] Keyboard shortcuts for all actions.
- [ ] Cursor changes per tool mode (crosshair, text, pointer).
- [ ] Prevent default browser behaviours (Ctrl+S, context menu on canvas).
- [ ] Edge cases: no image loaded → disable tools, empty annotations, etc.
- [ ] Basic cross-browser testing (Chrome, Firefox, Edge).

---

## 6. Known Limitations (v0.1)

- **Rotation displaces annotations**: Image transforms (rotate/flip) change
  the viewBox but annotations remain at their original coordinates. This means
  annotations added *before* a rotation will appear shifted relative to the
  image content. **Recommendation**: set rotation/flip *before* drawing
  annotations, or be aware that existing annotations will not track the image.
- **JPG export may fail in some browsers**: The SVG-to-canvas pipeline can be
  blocked by browser security policies (canvas taint). Works reliably in
  Chrome, Firefox, and Edge with base64-embedded images.
- **No multi-line text wrapping in SVG**: SVG `<text>` does not auto-wrap.
  Long text will extend beyond the image boundary. The user can insert
  line-breaks in the edit textarea (Shift+Enter), but they won't render as
  separate lines in the SVG `<text>` element. (Multi-line support via
  `<tspan>` is a v0.2 candidate.)
- **Single font**: All text uses `sans-serif`. No font family, bold, or
  italic options.

## 7. Out of Scope (v0.1)

- Freehand / pen drawing
- Shapes (rectangles, circles, arrows)
- Multiple fonts / bold / italic
- Layers / z-order management (beyond default SVG paint order)
- Touch / mobile support
- Zoom / pan of the editor
- Cloud storage / multi-user
- PNG export (only JPG)
- Drag-and-drop file open (file input only)
- History persistence across sessions

---

## 7. Open Questions (Resolved)

| # | Question | Decision |
|---|----------|----------|
| 1 | Line type | Straight lines only |
| 2 | Element editing | Full: select, move, resize, delete |
| 3 | Color selection | 12 editable presets |
| 4 | Vertical flip | Yes, both H and V |
| 5 | SVG image embed | Base64, self-contained |
| 6 | Undo/redo | Basic, session-only |
| 7 | Line thickness | 6 editable presets |
| 8 | Preset persistence | Saved as SVG comments |
