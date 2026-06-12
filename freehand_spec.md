# Freehand Drawing — Specification

## 1. Overview

Add a freehand drawing tool that lets the user draw arbitrary strokes by
clicking and dragging. The captured raw points are simplified using the
Ramer-Douglas-Peucker algorithm so the stored result is a minimal polyline
that closely resembles the original gesture. The user can control the
simplification tightness with a slider.

---

## 2. Toolbar & UI

### 2.1 Tool Button

A new **Freehand** tool button sits alongside Select / Line / Text / Crop in the
first toolbar row. Label: "Freehand" (or pencil icon). Keyboard shortcut: `F`.

### 2.2 Toolbar Groups (second row)

When the Freehand tool is active, the following toolbar groups are visible:

| Group | Contents | Notes |
|-------|----------|-------|
| `color-group` | Color palette | Shared with line/text |
| `thickness-group` | Thickness presets | Shared with line |
| `freehand-epsilon-group` | Label + range slider | New group |

When a freehand element is selected (via Select tool), the same groups are shown.

### 2.3 Epsilon Slider

- HTML `<input type="range">` with min `0`, max `30`, step `0.5`
- Default value: proportional to stroke width (≈ `strokeWidth × 1.5`, clamped
  to `[0.5, 15]`)
- A read-only numeric display next to the slider shows the current value
- Label: "Smoothing"

### 2.4 Epsilon Slider Behavior

- **Pre-draw**: Sets the default epsilon for new strokes.
- **Post-draw** (element selected): Re-simplifies the selected freehand drawing
  in real-time as the slider is dragged.
- When the selected element has raw points stored (session-only), the
  re-simplification runs against those raw points.
- When the selected element has no raw points (loaded from SVG), the
  re-simplification runs against the current simplified polyline points — this
  is strictly lossy (can only simplify further, never recover detail).

---

## 3. Drawing Mechanics

### 3.1 Mouse Interaction

| Event | Action |
|-------|--------|
| `mousedown` | Record start point, begin capturing. Show raw preview polyline. |
| `mousemove` | Append point if enough time has elapsed. Update raw preview. |
| `mouseup` | Stop capturing. If bounding box ≥ 20px, run simplification and replace raw preview with simplified polyline. Otherwise discard. |

### 3.2 Point Capture

- Raw points are captured at ~30–60 Hz (throttled by time, not by distance).
- Each point is stored as `{x, y}` in image-pixel coordinates (same coordinate
  space as all other annotations).
- During the drag, a raw `<polyline>` preview is shown using all captured
  points (unsimplified), rendered at 60% opacity with `pointer-events: none`.

### 3.3 Minimum Stroke

- If the bounding box of the captured points (max-min in both axes) is less
  than 20px in either dimension, the stroke is discarded (no element created).

### 3.4 Cursor

- Freehand tool active: `crosshair`
- Hovering a freehand element (via Select tool): `pointer` (via CSS class on polyline)

---

## 4. Simplification Algorithm

### 4.1 Ramer-Douglas-Peucker

```
function rdp(points, epsilon):
    if len(points) < 3: return points
    dmax = 0, idx = 0
    end = len(points) - 1
    for i in 1..end-1:
        d = perpendicularDistance(points[i], points[0], points[end])
        if d > dmax: dmax = d, idx = i
    if dmax > epsilon:
        left = rdp(points[0..idx], epsilon)
        right = rdp(points[idx..end], epsilon)
        return left + right[1:]
    return [points[0], points[end]]
```

### 4.2 Epsilon (Tolerance)

- User-configurable via slider: `0`–`30` (image-pixel units)
- Default on tool activation: `strokeWidth × 1.5`, clamped to `[0.5, 15]`
- `epsilon = 0` means no simplification — all captured points are kept

---

## 5. Data Model

### 5.1 In-Memory Element

```js
{
  id: 'fh_abc123',
  type: 'freehand',
  points: [{x, y}, ...],       // simplified points (what gets rendered)
  rawPoints: [{x, y}, ...],    // original captured points (session-only, null after SVG load)
  epsilon: 2,                   // epsilon used for current simplification
  stroke: '#ff0000',
  strokeWidth: 2,
}
```

### 5.2 SVG Element (Save)

```svg
<polyline id="fh_abc123" data-type="freehand" data-epsilon="3"
  stroke="#ff0000" stroke-width="2" fill="none" stroke-linecap="round"
  stroke-linejoin="round"
  points="x1,y1 x2,y2 x3,y3 ..." />
```

- Uses native `<polyline>` SVG element.
- `points` attribute stores the **simplified** polyline coordinates.
- `data-epsilon` stores the epsilon value used (for reference/UI).
- `fill="none"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- No raw points saved — simplification is lossy on save.

### 5.3 SVG Load

- Parse `<polyline data-type="freehand">` back into element state.
- Set `rawPoints = null`.
- Set `epsilon` from `data-epsilon` attribute (default `3` if missing).
- The slider works on the loaded polyline too, but only for further
  simplification (no raw points to recover from).

---

## 6. Selection & Editing (Select Tool)

### 6.1 Click Detection

- The polyline has `pointer-events: stroke` and a wider invisible hit area
  (like lines: `stroke-width: 12`, transparent).
- Clicking the polyline or its hit area selects it.

### 6.2 Selection Handles

- A single move handle (4×4 px rect) at the centroid of the polyline points.
- No resize/move-point handles.

### 6.3 Move

- Dragging the center handle moves the entire polyline (all points offset by
  `dx, dy`). Same undo pattern as line/text move.

### 6.4 Delete

- Delete button / Backspace key deletes the selected freehand element.

### 6.5 Color / Thickness Change

- Changing color/thickness in the palette updates the selected freehand
  element's stroke and strokeWidth.
- These changes are undoable individually.

### 6.6 Epsilon Slider on Selection

- When a freehand element is selected, the epsilon slider is visible.
- Dragging it re-simplifies in real-time.
- Undo records the final state only (not each slider tick).
- Raw points are preserved in memory for re-simplification (session-only,
  lost on reload).

---

## 7. Undo / History

- Each drawn stroke is a single undoable action (add element).
- Each delete is a single undoable action (remove element).
- Each move is a single undoable action.
- Color/thickness changes are individual undoable actions.
- Epsilon slider adjustments are NOT individually undoable — only the final
  state before the next operation is recorded.

---

## 8. SVG Save & Load

### 8.1 Save (`saveSVG`)

- Freehand elements are serialized as `<polyline>` elements inside the
  `<g id="annotation-layer">`.
- Attributes: `id`, `data-type="freehand"`, `data-epsilon`, `stroke`,
  `stroke-width`, `fill="none"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`, `points`.
- No raw points or other internal state is saved.

### 8.2 Load (`openSVGProject`)

- `<polyline data-type="freehand">` elements are parsed into freehand
  element objects.
- `rawPoints` is set to `null`.
- The epsilon slider is still functional but operates on the loaded
  polyline points (lossy further-simplification only).

---

## 9. Edge Cases

| Case | Behavior |
|------|----------|
| Click without drag | Ignored (bounding box < 20px) |
| Very short drag (< 20px) | Ignored |
| Single point after simplification | Element is discarded (need ≥ 2 points for a polyline) |
| epsilon = 0 | All captured points kept |
| Very large epsilon (> bounding box) | Polyline collapses to 2 points (start + end) |
| Loaded polyline with rawPoints = null | Slider works on current points (lossy) |
| Rotated image | Freehand coordinates are in the same viewBox space as other annotations; rotation of image doesn't affect freehand data |
| Export JPG | Polyline is rendered in the SVG-to-canvas pipeline, same as lines |
