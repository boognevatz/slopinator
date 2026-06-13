// ── Text module: Text placement and inline editing ─────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToCoords, svgToScreen } from './utils.js';
import { pushAction } from './history.js';
import { switchTool } from './tools.js';
import { selectElement } from './select.js';

let textEditOverlay = null;
let editingTextId = null;
let editingData = null;
let blurTimeout = null; // debounce blur to avoid race conditions

export function initText() {
  // Create the text editing overlay (textarea positioned over SVG)
  textEditOverlay = document.createElement('div');
  textEditOverlay.id = 'text-edit-overlay';
  const textarea = document.createElement('textarea');
  textarea.rows = 1;
  textEditOverlay.appendChild(textarea);
  document.getElementById('editor-container').appendChild(textEditOverlay);

  // Prevent clicks on the overlay from propagating to the SVG
  textEditOverlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  function keepEditing() {
    clearTimeout(blurTimeout);
  }

  function updateEditingUI() {
    const data = editingData;
    if (!data) return;
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
    if (textEl) {
      textEl.setAttribute('stroke', data.stroke || 'none');
      textEl.setAttribute('stroke-width', data.strokeWidth || 0);
      textEl.setAttribute('fill', data.fill);
    }
    const ctm = dom.svg.getScreenCTM();
    const scale = ctm ? ctm.a : 1;
    textarea.style.color = data.fill;
    textarea.style.webkitTextStroke = data.strokeWidth > 0 ? `${data.strokeWidth * scale}px ${data.stroke || 'none'}` : '';
  }

  document.addEventListener('palette-thickness-changed', (e) => {
    if (!editingData) return;
    editingData.strokeWidth = e.detail.thickness;
    updateEditingUI();
    keepEditing();
  });

  document.addEventListener('palette-color-changed', (e) => {
    if (!editingData) return;
    editingData.stroke = e.detail.color;
    updateEditingUI();
    keepEditing();
  });

  document.addEventListener('palette-bgcolor-changed', (e) => {
    if (!editingData) return;
    editingData.fill = e.detail.color;
    updateEditingUI();
    keepEditing();
  });

  document.addEventListener('palette-fontsize-changed', (e) => {
    if (!editingData) return;
    editingData.fontSize = e.detail.fontSize;
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(editingData.id)}`);
    if (!textEl) return;
    textEl.setAttribute('font-size', editingData.fontSize);

    const textRect = textEl.getBoundingClientRect();
    const container = document.getElementById('editor-container');
    const containerRect = container.getBoundingClientRect();

    const pt = dom.svg.createSVGPoint();
    pt.x = editingData.x;
    pt.y = editingData.y;
    const layerCtm = dom.annotationLayer.getScreenCTM();
    const anchorScreen = layerCtm ? pt.matrixTransform(layerCtm) : { x: textRect.left, y: textRect.top };
    const relX = anchorScreen.x - containerRect.left;
    const relY = textRect.top - containerRect.top;
    const centerY = relY + textRect.height / 2;
    const rotation = editingData.rotation || 0;

    textEditOverlay.style.width = textRect.width + 'px';
    textEditOverlay.style.height = textRect.height + 'px';

    if (rotation) {
      const centerX = relX + textRect.width / 2;
      textEditOverlay.style.left = centerX + 'px';
      textEditOverlay.style.top = centerY + 'px';
      textEditOverlay.style.transformOrigin = 'center center';
      textEditOverlay.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    } else {
      textEditOverlay.style.left = relX + 'px';
      textEditOverlay.style.top = centerY + 'px';
      textEditOverlay.style.transformOrigin = 'left center';
      textEditOverlay.style.transform = 'translate(0, -50%)';
    }

    const ctm = dom.svg.getScreenCTM();
    const scale = ctm ? ctm.a : 1;
    textarea.style.fontSize = (editingData.fontSize * scale) + 'px';
    keepEditing();
  });

  // Debounced blur: don't finish when focus moves to toolbar controls
  textarea.addEventListener('blur', (e) => {
    if (!e.relatedTarget || (e.relatedTarget.closest && e.relatedTarget.closest('#toolbar'))) {
      return;
    }
    clearTimeout(blurTimeout);
    blurTimeout = setTimeout(() => {
      finishEditing();
    }, 150);
  });

  // If textarea regains focus (e.g. clicking inside it), cancel the blur timeout
  textarea.addEventListener('focus', () => {
    clearTimeout(blurTimeout);
  });

  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't let tool shortcuts fire while typing
    if (e.key === 'Escape') {
      cancelEditing();
    }
    // Enter without shift commits
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finishEditing();
    }
  });

  textarea.addEventListener('input', () => {
    if (!editingTextId) return;
    const curW = parseFloat(textEditOverlay.style.width);

    // Measure content width using the textarea itself with no-wrap
    const prevWS = textarea.style.whiteSpace;
    const prevO = textarea.style.overflow;
    textarea.style.overflow = 'hidden';
    textarea.style.whiteSpace = 'nowrap';
    const textW = textarea.scrollWidth;
    textarea.style.whiteSpace = prevWS;
    textarea.style.overflow = prevO;

    textEditOverlay.style.width = Math.max(curW, textW + 5) + 'px';
    // Height is constant for single-line text — keep initial size
    textarea.scrollLeft = 0;
    textarea.scrollTop = 0;
  });
}

export function activateText() {
  dom.svg.style.cursor = 'text';
  dom.svg.addEventListener('mousedown', onMouseDown);
}

export function deactivateText() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('mousedown', onMouseDown);
  finishEditing();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (!state.hasImage) return;

  // If currently editing, finish that first and don't place new text
  if (editingTextId) {
    finishEditing();
    return;
  }

  // Don't place text on existing annotations
  const target = e.target;
  if (target.classList.contains('annotation-text') ||
      target.classList.contains('annotation-line') ||
      target.classList.contains('line-hit-area') ||
      target.classList.contains('handle')) return;

  // Prevent the browser from moving focus away from our textarea
  e.preventDefault();

  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  const id = generateId();
  const textData = {
    id,
    type: 'text',
    x: pt.x,
    y: pt.y,
    content: 'Text',
    fontSize: state.activeFontSize,
    fill: state.bgColor,
    stroke: state.activeColor,
    strokeWidth: state.activeThickness,
  };

  addTextElement(textData);
  state.elements.push(textData);

  pushAction({
    description: 'Add text',
    doFn: () => {
      addTextElement(textData);
      state.elements.push(textData);
    },
    undoFn: () => {
      removeTextElement(id);
      state.elements = state.elements.filter(el => el.id !== id);
    },
  });

  // Defer focus to next frame so mousedown processing is fully complete
  setTimeout(() => {
    startEditing(id);
  }, 0);
}

/**
 * Create SVG elements for a text annotation.
 */
export function addTextElement(data) {
  const textEl = svgEl('text', {
    id: data.id,
    x: data.x,
    y: data.y,
    'font-size': data.fontSize,
    fill: data.fill,
    stroke: data.stroke || 'none',
    'stroke-width': data.strokeWidth || 0,
    'font-family': 'sans-serif',
    'data-type': 'text',
    class: 'annotation-text',
  });
  textEl.textContent = data.content;
  dom.annotationLayer.appendChild(textEl);

  if (data.rotation) {
    // Need to wait for it to render to get bbox
    setTimeout(() => {
      try {
        const bbox = textEl.getBBox();
        const cx = bbox.x + bbox.width / 2;
        const cy = bbox.y + bbox.height / 2;
        textEl.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
      } catch {}
    }, 0);
  }
}

function removeTextElement(id) {
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (el) el.remove();
}

/**
 * Start inline editing of a text element.
 */
export function startEditing(id) {
  // If already editing something else, finish it first
  if (editingTextId && editingTextId !== id) {
    finishEditing();
  }

  const data = state.elements.find(el => el.id === id);
  if (!data || data.type !== 'text') return;

  editingTextId = id;
  editingData = data;

  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (!textEl) return;

  const textarea = textEditOverlay.querySelector('textarea');

  // Get the actual rendered bounding box of the SVG text element
  const textRect = textEl.getBoundingClientRect();

  const container = document.getElementById('editor-container');
  const containerRect = container.getBoundingClientRect();

  // Use the SVG coordinate anchor (data.x) for horizontal position via the
  // annotation layer CTM — more reliable than getBoundingClientRect().left
  // which can include font-metric padding quirks.
  const pt = dom.svg.createSVGPoint();
  pt.x = data.x;
  pt.y = data.y;
  const layerCtm = dom.annotationLayer.getScreenCTM();
  const anchorScreen = layerCtm ? pt.matrixTransform(layerCtm) : { x: textRect.left, y: textRect.top };
  const relX = anchorScreen.x - containerRect.left;
  const relY = textRect.top - containerRect.top;

  // Get the true SVG-to-screen scale via the CTM (handles letterboxing correctly)
  const ctm = dom.svg.getScreenCTM();
  const scale = ctm ? ctm.a : 1;
  const scaledFontSize = data.fontSize * scale;

  const centerY = relY + textRect.height / 2;
  const rotation = data.rotation || 0;

  textEditOverlay.style.display = 'block';
  textEditOverlay.style.width = textRect.width + 'px';
  textEditOverlay.style.height = textRect.height + 'px';

  if (rotation) {
    // Rotated text: center anchor — rotate around center to match SVG
    const centerX = relX + textRect.width / 2;
    textEditOverlay.style.left = centerX + 'px';
    textEditOverlay.style.top = centerY + 'px';
    textEditOverlay.style.transformOrigin = 'center center';
    textEditOverlay.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  } else {
    // Non-rotated: left anchor — expands only to the right while typing
    textEditOverlay.style.left = relX + 'px';
    textEditOverlay.style.top = centerY + 'px';
    textEditOverlay.style.transformOrigin = 'left center';
    textEditOverlay.style.transform = 'translate(0, -50%)';
  }

  textarea.style.fontSize = scaledFontSize + 'px';
  textarea.style.lineHeight = (textRect.height / scaledFontSize).toFixed(3);
  textarea.style.height = '100%';
  textarea.style.color = data.fill;
  const strokeW = data.stroke && data.stroke !== 'none' && data.strokeWidth ? data.strokeWidth * scale : 0;
  textarea.style.webkitTextStroke = strokeW > 0 ? `${strokeW}px ${data.stroke}` : '';
  textarea.style.fontFamily = 'sans-serif';
  textarea.style.width = '100%';
  textarea.style.boxSizing = 'border-box';
  textarea.style.transformOrigin = 'center center';
  textarea.value = data.content;

  // Hide the SVG text while editing
  textEl.setAttribute('visibility', 'hidden');

  // Cancel any pending blur timeout before focusing
  clearTimeout(blurTimeout);
  textarea.focus();
  textarea.select();
}

function finishEditing() {
  clearTimeout(blurTimeout);
  if (!editingTextId) return;

  const textarea = textEditOverlay.querySelector('textarea');
  const newContent = textarea.value.trim() || 'Text';
  const id = editingTextId;

  // Clear state before DOM updates to prevent re-entrant calls
  editingTextId = null;
  editingData = null;
  textEditOverlay.style.display = 'none';
  textEditOverlay.style.transform = 'none';

  const data = state.elements.find(el => el.id === id);
  if (data) {
    const oldContent = data.content;
    data.content = newContent;

    // Update SVG element
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
    if (textEl) {
      textEl.textContent = newContent;
      textEl.removeAttribute('visibility');
    }

    if (oldContent !== newContent) {
      pushAction({
        description: 'Edit text',
        doFn: () => {
          data.content = newContent;
          const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
          if (el) el.textContent = newContent;
        },
        undoFn: () => {
          data.content = oldContent;
          const el = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
          if (el) el.textContent = oldContent;
        },
      });
    }
  }

  // Switch to select tool and automatically select the newly edited text
  switchTool('select');
  selectElement(id);
}

/**
 * Cancel editing without saving changes.
 */
function cancelEditing() {
  clearTimeout(blurTimeout);
  if (!editingTextId) return;

  const id = editingTextId;
  editingTextId = null;
  editingData = null;
  textEditOverlay.style.display = 'none';
  textEditOverlay.style.transform = 'none';

  // Restore the SVG text visibility with original content
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (textEl) {
    textEl.removeAttribute('visibility');
  }
}

export function isEditing() {
  return editingTextId !== null;
}
