// ── Text module: Text placement and inline editing ─────────────

import { state, dom } from './editor.js';
import { generateId, svgEl, screenToSVG, svgToScreen } from './utils.js';
import { pushAction } from './history.js';

let textEditOverlay = null;
let editingTextId = null;

export function initText() {
  // Create the text editing overlay (textarea positioned over SVG)
  textEditOverlay = document.createElement('div');
  textEditOverlay.id = 'text-edit-overlay';
  const textarea = document.createElement('textarea');
  textarea.rows = 1;
  textEditOverlay.appendChild(textarea);
  document.getElementById('editor-container').appendChild(textEditOverlay);

  textarea.addEventListener('blur', finishEditing);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      finishEditing();
      e.stopPropagation();
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

  // Don't place text on existing annotations
  const target = e.target;
  if (target.classList.contains('annotation-text') ||
      target.classList.contains('annotation-line') ||
      target.classList.contains('line-hit-area') ||
      target.classList.contains('handle')) return;

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

  // Immediately start editing
  startEditing(id);
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

  textarea.focus();
  textarea.select();
}

function finishEditing() {
  if (!editingTextId) return;

  const textarea = textEditOverlay.querySelector('textarea');
  const newContent = textarea.value.trim() || 'Text';
  const id = editingTextId;

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

  textEditOverlay.style.display = 'none';
  editingTextId = null;
}

export function isEditing() {
  return editingTextId !== null;
}
