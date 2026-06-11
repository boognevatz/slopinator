// ── App entry point: Wire all modules together ─────────────────

import { initEditor, state } from './modules/editor.js';
import { initHistory, undo, redo, canUndo, canRedo } from './modules/history.js';
import { initPalette } from './modules/palette.js';
import { rotateCW, rotateCCW, flipH, flipV, zoomIn, zoomOut, zoomFit } from './modules/transform.js';
import { initLine, addLineElement } from './modules/line.js';
import { initText, addTextElement, isEditing } from './modules/text.js';
import { initSelect, deleteSelected, setModuleRefs, clearSelection, refreshSelection } from './modules/select.js';
import { initCrop, setCropModuleRefs } from './modules/crop.js';
import { initTools, switchTool } from './modules/tools.js';
import { initFileIO, saveSVG } from './modules/fileio.js';

import { dom } from './modules/editor.js';

function init() {
  initEditor();

  // Give select module references to line/text for undo recreation
  setModuleRefs({ addLineElement }, { addTextElement });
  setCropModuleRefs({ addLineElement }, { addTextElement });

  // History: update undo/redo button states on change
  initHistory(updateUndoRedoButtons);

  initPalette();
  initLine();
  initText();
  initSelect();
  initCrop();
  initTools();
  initFileIO();

  // ── Toolbar button wiring ───────────────────────────────────

  document.getElementById('btn-rotate-cw').addEventListener('click', rotateCW);
  document.getElementById('btn-rotate-ccw').addEventListener('click', rotateCCW);
  document.getElementById('btn-flip-h').addEventListener('click', flipH);
  document.getElementById('btn-flip-v').addEventListener('click', flipV);

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomIn());
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomOut());
  document.getElementById('btn-zoom-fit').addEventListener('click', () => zoomFit());

  document.getElementById('btn-undo').addEventListener('click', () => {
    undo();
    refreshSelection();
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    redo();
    refreshSelection();
  });

  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  // ── Keyboard shortcuts ──────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Don't capture shortcuts when editing text
    if (isEditing()) return;

    // Don't capture when focus is on an input
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Ctrl+Z — Undo
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
      refreshSelection();
      return;
    }

    // Ctrl+Y or Ctrl+Shift+Z — Redo
    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
      e.preventDefault();
      redo();
      refreshSelection();
      return;
    }

    // Ctrl+S — Save SVG
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveSVG();
      return;
    }

    // Zoom shortcuts (+, -)
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
      return;
    }

    // Tool shortcuts (only without modifiers)
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'v':
          switchTool('select');
          break;
        case 'l':
          switchTool('line');
          break;
        case 't':
          switchTool('text');
          break;
        case 'c':
          switchTool('crop');
          break;
        case 'delete':
        case 'backspace':
          if (state.selectedId) {
            e.preventDefault();
            deleteSelected();
          }
          break;
        case 'escape':
          clearSelection();
          break;
      }
    }
  });

  // ── Mousewheel zooming ──────────────────────────────────────
  document.getElementById('editor-container').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.hasImage) return;

    if (e.deltaY < 0) {
      zoomIn(e.clientX, e.clientY);
    } else if (e.deltaY > 0) {
      zoomOut(e.clientX, e.clientY);
    }
  }, { passive: false });

  // ── Window resize handling ──────────────────────────────────
  // SVG auto-scales via viewBox, no extra handling needed.
}

function updateUndoRedoButtons() {
  document.getElementById('btn-undo').disabled = !canUndo();
  document.getElementById('btn-redo').disabled = !canRedo();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
