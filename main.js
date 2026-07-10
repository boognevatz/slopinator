// ── App entry point: Wire all modules together ─────────────────

import { initEditor, state } from './modules/editor.js';
import { initHistory, undo, redo, canUndo, canRedo } from './modules/history.js';
import { initPalette } from './modules/palette.js';
import { rotateCW, rotateCCW, flipH, flipV, zoomIn, zoomOut, zoomFit, zoomOneToOne } from './modules/transform.js';
import { initLine, addLineElement, handlePolylineEscape } from './modules/line.js';
import { initText, addTextElement, isEditing } from './modules/text.js';
import { initSelect, deleteSelected, setModuleRefs, clearSelection, refreshSelection } from './modules/select.js';
import { initCrop, setCropModuleRefs } from './modules/crop.js';
import { initTools, switchTool } from './modules/tools.js';
import { initFileIO, saveSVG } from './modules/fileio.js';
import { initFreehand, addFreehandElement } from './modules/freehand.js';
import { initRectangle, addRectangleElement } from './modules/rectangle.js';
import { initPerspective } from './modules/perspective.js';
import { initColorCorrection } from './modules/colorcorrection.js';
import { initLayers } from './modules/layers.js';

import { dom } from './modules/editor.js';

// ── Show last modified date of a source file ───────────
async function showFileDate() {
  const aboutVersion = document.getElementById('about-version');
  const files = ['index.html', 'style.css', 'main.js', 'modules/select.js', 'modules/text.js', 'modules/line.js'];
  for (const f of files) {
    try {
      const r = await fetch(f, { method: 'HEAD' });
      const header = r.headers.get('Last-Modified');
      if (header) {
        const d = new Date(header);
        const pad = (n) => String(n).padStart(2, '0');
        const formatted = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (aboutVersion) aboutVersion.textContent = formatted;
        return;
      }
    } catch {}
  }
}
showFileDate();

function init() {
  initEditor();

  // Give select module references to line/text/freehand for undo recreation
  setModuleRefs({ addLineElement }, { addTextElement }, { addFreehandElement }, { addRectangleElement });
  setCropModuleRefs({ addLineElement }, { addTextElement });

  // History: update undo/redo button states on change
  initHistory(updateUndoRedoButtons);

  initPalette();
  initLine();
  initText();
  initSelect();
  initCrop();
  initTools();
  initFreehand();
  initRectangle();
  initPerspective();
  initColorCorrection();
  initLayers();
  initFileIO();

  // ── Toolbar button wiring ───────────────────────────────────

  document.getElementById('btn-rotate-cw').addEventListener('click', rotateCW);
  document.getElementById('btn-rotate-ccw').addEventListener('click', rotateCCW);
  document.getElementById('btn-flip-h').addEventListener('click', flipH);
  document.getElementById('btn-flip-v').addEventListener('click', flipV);

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomIn());
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomOut());
  document.getElementById('btn-zoom-fit').addEventListener('click', () => zoomFit());
  document.getElementById('btn-zoom-11').addEventListener('click', () => zoomOneToOne());

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
        case 'f':
          switchTool('freehand');
          break;
        case 'r':
          switchTool('rectangle');
          break;
        case 'p':
          switchTool('perspective');
          break;
        case 'k':
          switchTool('color');
          break;
        case 'm':
          switchTool('measure');
          break;
        case 'delete':
        case 'backspace':
          if (state.selectedId) {
            e.preventDefault();
            deleteSelected();
          }
          break;
        case 'escape':
          if (!handlePolylineEscape()) {
            clearSelection();
          }
          break;
      }
    }
  });

  // ── Mousewheel / Pinch zooming ──────────────────────────────
  document.getElementById('editor-container').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.hasImage) return;

    if (e.deltaY < 0) {
      zoomIn(e.clientX, e.clientY);
    } else if (e.deltaY > 0) {
      zoomOut(e.clientX, e.clientY);
    }
  }, { passive: false });

  let pinchPointers = [];
  document.addEventListener('pointerdown', (e) => {
    const idx = pinchPointers.findIndex(p => p.pointerId === e.pointerId);
    if (idx !== -1) pinchPointers.splice(idx, 1);
    pinchPointers.push({ pointerId: e.pointerId, x: e.clientX, y: e.clientY });
  });
  document.addEventListener('pointermove', (e) => {
    const p = pinchPointers.find(p => p.pointerId === e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (pinchPointers.length !== 2) return;
    if (!state.hasImage) return;
    const p1 = pinchPointers[0], p2 = pinchPointers[1];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!pinchPointers._lastDist) { pinchPointers._lastDist = dist; return; }
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    if (dist > pinchPointers._lastDist * 1.02) zoomIn(midX, midY);
    else if (dist < pinchPointers._lastDist * 0.98) zoomOut(midX, midY);
    pinchPointers._lastDist = dist;
  });
  document.addEventListener('pointerup', (e) => {
    pinchPointers = pinchPointers.filter(p => p.pointerId !== e.pointerId);
    pinchPointers._lastDist = null;
  });
  document.addEventListener('pointercancel', (e) => {
    pinchPointers = pinchPointers.filter(p => p.pointerId !== e.pointerId);
    pinchPointers._lastDist = null;
  });

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
