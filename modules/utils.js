// ── Shared utility helpers ──────────────────────────────────────

let _idCounter = 0;

export function generateId() {
  return 'ann-' + (++_idCounter) + '-' + Date.now().toString(36);
}

export function resetIdCounter() {
  _idCounter = 0;
}

/**
 * Create an SVG element with attributes.
 */
export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Convert screen (client) coordinates to SVG user-space coordinates.
 */
export function screenToSVG(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const svgPt = pt.matrixTransform(ctm.inverse());
  return { x: svgPt.x, y: svgPt.y };
}

/**
 * Convert SVG user-space coordinates to screen (client) coordinates.
 */
export function svgToScreen(svg, svgX, svgY) {
  const pt = svg.createSVGPoint();
  pt.x = svgX;
  pt.y = svgY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const screenPt = pt.matrixTransform(ctm);
  return { x: screenPt.x, y: screenPt.y };
}

/**
 * Clamp a number between min and max.
 */
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Download a blob as a file.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download a string as a file.
 */
export function downloadString(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(blob, filename);
}
