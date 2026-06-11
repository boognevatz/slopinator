// ── Text module: Text placement and inline editing ─────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToSVG, svgToScreen } from './utils.js';
import { pushAction } from './history.js';

let textEditOverlay = null;
let editingTextId = null;
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

  // Debounced blur: gives focus() calls time to land before we commit
  textarea.addEventListener('blur', () => {
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

  const pt = screenToSVG(dom.svg, e.clientX, e.clientY);

  const id = generateId();
  const textData = {
    id,
    type: 'text',
    x: pt.x,
    y: pt.y,
    content: 'Text',
    fontSize: state.activeFontSize,
    fill: state.activeColor,
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
    'font-family': 'sans-serif',
    'data-type': 'text',
    class: 'annotation-text',
  });
  textEl.textContent = data.content;
  dom.annotationLayer.appendChild(textEl);
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

  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (!textEl) return;

  // Position the textarea over the text element
  const screenPt = svgToScreen(dom.svg, data.x, data.y);
  const textarea = textEditOverlay.querySelector('textarea');

  // Compute approximate scale: how many screen pixels per SVG unit
  const svgRect = dom.svg.getBoundingClientRect();
  const viewBox = dom.svg.viewBox.baseVal;
  const scale = svgRect.width / viewBox.width;

  const scaledFontSize = data.fontSize * scale;

  // Convert viewport coords to container-relative coords
  const container = document.getElementById('editor-container');
  const containerRect = container.getBoundingClientRect();
  const relX = screenPt.x - containerRect.left;
  const relY = screenPt.y - containerRect.top;

  textEditOverlay.style.display = 'block';
  textEditOverlay.style.left = relX + 'px';
  textEditOverlay.style.top = (relY - scaledFontSize) + 'px';

  textarea.style.fontSize = scaledFontSize + 'px';
  textarea.style.color = data.fill;
  textarea.style.fontFamily = 'sans-serif';
  textarea.style.width = Math.max(200, containerRect.width - relX - 20) + 'px';
  textarea.style.minHeight = (scaledFontSize + 8) + 'px';
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
  textEditOverlay.style.display = 'none';

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
}

/**
 * Cancel editing without saving changes.
 */
function cancelEditing() {
  clearTimeout(blurTimeout);
  if (!editingTextId) return;

  const id = editingTextId;
  editingTextId = null;
  textEditOverlay.style.display = 'none';

  // Restore the SVG text visibility with original content
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(id)}`);
  if (textEl) {
    textEl.removeAttribute('visibility');
  }
}

export function isEditing() {
  return editingTextId !== null;
}
