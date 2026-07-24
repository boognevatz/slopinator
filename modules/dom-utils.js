// ── DOM utilities: read/write element state from/to SVG DOM ────

import { dom } from './editor.js';

/**
 * Read named attributes from a DOM element.
 * Returns { attrName: value } for each requested name.
 */
export function readElementAttrs(el, names) {
  const result = {};
  for (const name of names) {
    const val = el.getAttribute(name);
    if (val !== null) result[name] = val;
  }
  return result;
}

/**
 * Read line geometry from an SVG <g data-type="line"> element.
 * Returns an object like:
 *   { type: 'line', x1, y1, x2, y2 }
 *   { type: 'polyline', points: [{x,y},...] }
 *   { type: 'polygon', points: [{x,y},...], closed: true, fill }
 */
export function readLineGeometry(el) {
  const lineEl = el.querySelector('.annotation-line');
  if (!lineEl) return null;

  const tag = lineEl.tagName.toLowerCase();
  if (tag === 'line') {
    return {
      type: 'line',
      x1: parseFloat(lineEl.getAttribute('x1')),
      y1: parseFloat(lineEl.getAttribute('y1')),
      x2: parseFloat(lineEl.getAttribute('x2')),
      y2: parseFloat(lineEl.getAttribute('y2')),
    };
  }

  const ptsAttr = lineEl.getAttribute('points');
  const points = ptsAttr ? ptsAttr.trim().split(/\s+/).map(p => {
    const [x, y] = p.split(',').map(Number);
    return { x, y };
  }) : [];

  if (tag === 'polygon') {
    const fill = lineEl.getAttribute('fill');
    return {
      type: 'polygon',
      points,
      closed: true,
      fill: fill && fill !== 'none' ? fill : null,
    };
  }

  return { type: 'polyline', points };
}

/**
 * Read rectangle geometry from a <g data-type="rectangle"> element.
 * Returns { x, y, width, height, rx, rotation, fill, stroke, strokeWidth }
 */
export function readRectGeometry(el) {
  const fillRect = el.querySelector('.rect-fill');
  const strokeRect = el.querySelector('.rect-stroke');
  if (!fillRect || !strokeRect) return null;

  const x = parseFloat(fillRect.getAttribute('x'));
  const y = parseFloat(fillRect.getAttribute('y'));
  const width = parseFloat(fillRect.getAttribute('width'));
  const height = parseFloat(fillRect.getAttribute('height'));
  const rx = parseFloat(fillRect.getAttribute('rx') || 0);
  const fill = fillRect.getAttribute('fill');
  const stroke = strokeRect.getAttribute('stroke');
  const strokeWidth = parseFloat(strokeRect.getAttribute('stroke-width'));
  const rotation = parseFloat(el.getAttribute('transform')?.match(/rotate\(([^,)]+)/)?.[1] || 0);

  return { x, y, width, height, rx, rotation, fill, stroke, strokeWidth };
}

/**
 * Read text geometry from a <text data-type="text"> element.
 * Returns { x, y, fontSize, fill, stroke, strokeWidth, content, rotation }
 */
export function readTextGeometry(el) {
  const x = parseFloat(el.getAttribute('x'));
  const y = parseFloat(el.getAttribute('y'));
  const fontSize = parseFloat(el.getAttribute('font-size'));
  const fill = el.getAttribute('fill');
  const stroke = el.getAttribute('stroke');
  const strokeWidth = parseFloat(el.getAttribute('stroke-width') || 0);
  const content = el.textContent;
  const rotation = parseFloat(el.getAttribute('transform')?.match(/rotate\(([^,)]+)/)?.[1] || 0);

  return { x, y, fontSize, fill, stroke, strokeWidth, content, rotation };
}

/**
 * Read freehand geometry from a <g data-type="freehand"> element.
 * Returns { points: [{x,y},...], epsilon }
 */
export function readFreehandGeometry(el) {
  const polyline = el.querySelector('polyline');
  if (!polyline) return null;

  const ptsAttr = polyline.getAttribute('points');
  const points = ptsAttr ? ptsAttr.trim().split(/\s+/).map(p => {
    const [x, y] = p.split(',').map(Number);
    return { x, y };
  }) : [];

  const epsilon = parseFloat(el.getAttribute('data-epsilon') || 0);

  return { points, epsilon };
}

/**
 * Apply line geometry to a <g data-type="line"> DOM element.
 * geom: { type, x1, y1, x2, y2 } or { type, points, closed?, fill? }
 */
export function applyLineGeometry(el, geom) {
  const lineEl = el.querySelector('.annotation-line');
  const hitArea = el.querySelector('.line-hit-area');
  if (!lineEl) return;

  if (geom.type === 'line') {
    lineEl.setAttribute('x1', geom.x1);
    lineEl.setAttribute('y1', geom.y1);
    lineEl.setAttribute('x2', geom.x2);
    lineEl.setAttribute('y2', geom.y2);
    if (hitArea) {
      hitArea.setAttribute('x1', geom.x1);
      hitArea.setAttribute('y1', geom.y1);
      hitArea.setAttribute('x2', geom.x2);
      hitArea.setAttribute('y2', geom.y2);
    }
  } else {
    const ptsStr = geom.points.map(p => `${p.x},${p.y}`).join(' ');
    lineEl.setAttribute('points', ptsStr);
    if (hitArea) hitArea.setAttribute('points', ptsStr);
  }
}

/**
 * Apply rectangle geometry to a <g data-type="rectangle"> DOM element.
 * geom: { x, y, width, height, rx?, stroke?, strokeWidth?, fill? }
 */
export function applyRectGeometry(el, geom) {
  const fillRect = el.querySelector('.rect-fill');
  const strokeRect = el.querySelector('.rect-stroke');

  const attrs = { x: geom.x, y: geom.y, width: geom.width, height: geom.height };
  if (geom.rx !== undefined) attrs.rx = geom.rx;

  if (fillRect) {
    for (const [k, v] of Object.entries(attrs)) fillRect.setAttribute(k, v);
    if (geom.fill !== undefined) fillRect.setAttribute('fill', geom.fill);
  }
  if (strokeRect) {
    for (const [k, v] of Object.entries(attrs)) strokeRect.setAttribute(k, v);
    if (geom.stroke !== undefined) strokeRect.setAttribute('stroke', geom.stroke);
    if (geom.strokeWidth !== undefined) strokeRect.setAttribute('stroke-width', geom.strokeWidth);
  }
}

/**
 * Apply text geometry to a <text data-type="text"> DOM element.
 * geom: { x, y, fontSize?, fill?, stroke?, strokeWidth?, content?, rotation? }
 */
export function applyTextGeometry(el, geom) {
  if (geom.x !== undefined) el.setAttribute('x', geom.x);
  if (geom.y !== undefined) el.setAttribute('y', geom.y);
  if (geom.fontSize !== undefined) el.setAttribute('font-size', geom.fontSize);
  if (geom.fill !== undefined) el.setAttribute('fill', geom.fill);
  if (geom.stroke !== undefined) el.setAttribute('stroke', geom.stroke);
  if (geom.strokeWidth !== undefined) el.setAttribute('stroke-width', geom.strokeWidth);
  if (geom.content !== undefined) el.textContent = geom.content;
  if (geom.rotation !== undefined) {
    if (geom.rotation) {
      try {
        const bbox = el.getBBox();
        const cx = bbox.x + bbox.width / 2;
        const cy = bbox.y + bbox.height / 2;
        el.setAttribute('transform', `rotate(${geom.rotation}, ${cx}, ${cy})`);
      } catch {}
    } else {
      el.removeAttribute('transform');
    }
  }
}

/**
 * Apply freehand geometry to a <g data-type="freehand"> DOM element.
 * geom: { points, epsilon? }
 */
export function applyFreehandGeometry(el, geom) {
  const polyline = el.querySelector('polyline');
  const hitArea = el.querySelector('.line-hit-area');
  if (!polyline) return;

  const ptsStr = geom.points.map(p => `${p.x},${p.y}`).join(' ');
  polyline.setAttribute('points', ptsStr);
  if (hitArea) hitArea.setAttribute('points', ptsStr);
  if (geom.epsilon !== undefined) el.setAttribute('data-epsilon', geom.epsilon);
}

/**
 * Read type-aware geometry from any annotation element.
 * Dispatches to readLineGeometry / readRectGeometry / readTextGeometry / readFreehandGeometry.
 */
export function readGeometryFromDOM(el) {
  if (!el) return null;
  const type = el.dataset.type || el.getAttribute('data-type');
  if (type === 'line') return readLineGeometry(el);
  if (type === 'rectangle') return readRectGeometry(el);
  if (type === 'text') return readTextGeometry(el);
  if (type === 'freehand') return readFreehandGeometry(el);
  if (type === 'group') return null;
  return null;
}

/**
 * Apply type-aware geometry to any annotation element.
 * Dispatches to applyLineGeometry / applyRectGeometry / applyTextGeometry / applyFreehandGeometry.
 */
export function applyGeometryToDOM(el, geom) {
  if (!el || !geom) return;
  const type = el.dataset.type || el.getAttribute('data-type');
  if (type === 'line') applyLineGeometry(el, geom);
  else if (type === 'rectangle') applyRectGeometry(el, geom);
  else if (type === 'text') applyTextGeometry(el, geom);
  else if (type === 'freehand') applyFreehandGeometry(el, geom);
}

/**
 * Capture full element state from the DOM for a given element ID.
 * Returns a plain object suitable for recreating the element.
 */
export function captureElementState(id) {
  const el = document.getElementById(id);
  if (!el) return null;

  const type = el.dataset.type || el.getAttribute('data-type');

  if (type === 'line') {
    const lineEl = el.querySelector('.annotation-line');
    const stroke = lineEl?.getAttribute('stroke');
    const strokeWidth = parseFloat(lineEl?.getAttribute('stroke-width') || 2);
    const geom = readLineGeometry(el);
    const result = {
      id, type: 'line',
      points: geom.points,
      x1: geom.x1, y1: geom.y1,
      x2: geom.x2, y2: geom.y2,
      stroke: el.dataset.startDecoration ? undefined : stroke,
      strokeWidth,
      lineStyle: el.dataset.lineStyle,
      lineMarkerSize: el.dataset.lineMarkerSize,
      startDecoration: el.dataset.startDecoration,
      endDecoration: el.dataset.endDecoration,
      startDecorationSize: el.dataset.startDecorationSize,
      endDecorationSize: el.dataset.endDecorationSize,
    };
    if (geom.closed) {
      result.closed = true;
      result.fill = geom.fill || 'none';
    }
    if (stroke !== undefined) result.stroke = stroke;
    return result;
  }

  if (type === 'rectangle') {
    const geom = readRectGeometry(el);
    return { id, type: 'rectangle', ...geom };
  }

  if (type === 'text') {
    const geom = readTextGeometry(el);
    return { id, type: 'text', ...geom };
  }

  if (type === 'freehand') {
    const geom = readFreehandGeometry(el);
    const polyline = el.querySelector('polyline');
    const stroke = polyline?.getAttribute('stroke');
    const strokeWidth = parseFloat(polyline?.getAttribute('stroke-width') || 2);
    return {
      id, type: 'freehand',
      points: geom.points,
      rawPoints: geom.points,
      epsilon: geom.epsilon,
      stroke,
      strokeWidth,
    };
  }

  if (type === 'group') {
    const childIds = [];
    for (let i = 0; i < el.children.length; i++) {
      childIds.push(el.children[i].id);
    }
    return { id, type: 'group', childIds };
  }

  return null;
}

/**
 * Capture state of all annotation elements from the DOM.
 * Returns an array of element state objects.
 */
export function captureAllElementsState() {
  const els = dom.annotationLayer.querySelectorAll('[id]');
  const result = [];
  for (const el of els) {
    if (el.tagName === 'g' || el.tagName === 'text') {
      const state = captureElementState(el.id);
      if (state) result.push(state);
    }
  }
  return result;
}
