import { initEditor, state } from './modules/editor.js';
import { initHistory, undo, redo, canUndo, canRedo } from './modules/history.js';
import { initPalette } from './modules/palette.js';
import { rotateCW, rotateCCW, flipH, flipV, zoomIn, zoomOut, zoomFit, zoomOneToOne } from './modules/transform.js';
import { initLine, addLineElement, handlePolylineEscape } from './modules/line.js';
import { initText, addTextElement, isEditing } from './modules/text.js';
import { initSelect, deleteSelected, setModuleRefs, clearSelection, refreshSelection, selectElement, clearTempUngroup, duplicateSelected, moveInGroup, cycleGroupSelection } from './modules/select.js';
import { initTools, switchTool } from './modules/tools.js';
import { initFileIO, saveSVG } from './modules/fileio.js';
import { initFreehand, addFreehandElement } from './modules/freehand.js';
import { initRectangle, addRectangleElement } from './modules/rectangle.js';
import { initLayers, initLayerUI } from './modules/layers.js';
import { initGrid, toggleGrid } from './modules/grid.js';
import { initSettings, loadColorPreferences } from './modules/settings.js';
import { initAutosave, loadAutosave, saveAutosave } from './modules/opfs.js';
import { groupSelected, ungroupSelected } from './modules/group.js';

import { dom } from './modules/editor.js';

async function showFileDate() {
  const aboutVersion = document.getElementById('about-version');
  const files = ['pcb.html', 'style.css', 'pcb-main.js', 'modules/select.js', 'modules/text.js', 'modules/line.js'];
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
  state.defaultTool = 'select';

  setModuleRefs({ addLineElement }, { addTextElement }, { addFreehandElement }, { addRectangleElement });

  initHistory(updateUndoRedoButtons);

  loadColorPreferences();
  initPalette();
  initLine();
  initText();
  initSelect();
  initTools();
  initFreehand();
  initRectangle();
  initLayers();
  initLayerUI();
  initGrid();
  initSettings();
  initFileIO();

  initAutosave();
  loadAutosave();
  document.getElementById('btn-save-internal').addEventListener('click', function() { saveAutosave(true); });

  function positionMobileDropdown(content, btn) {
    if (window.innerWidth < 768) {
      var r = btn.getBoundingClientRect();
      content.style.position = 'fixed';
      content.style.top = (r.bottom + 4) + 'px';
      content.style.left = '4px';
      content.style.right = '4px';
      content.style.minWidth = 'auto';
    } else {
      content.style.position = '';
      content.style.top = '';
      content.style.left = '';
      content.style.right = '';
      content.style.minWidth = '';
    }
  }

  document.querySelectorAll('.mobile-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      const content = document.querySelector(`[data-group-content="${group}"]`);
      if (content) {
        const isOpen = content.classList.toggle('open');
        btn.textContent = group.charAt(0).toUpperCase() + group.slice(1) + (isOpen ? ' ▴' : ' ▾');
        if (isOpen) positionMobileDropdown(content, btn);
        else { content.style.position = ''; content.style.top = ''; content.style.left = ''; content.style.right = ''; content.style.minWidth = ''; }
      }
    });
  });
  function closeAllMobileDropdowns() {
    document.querySelectorAll('[data-group-content].open').forEach(el => {
      el.classList.remove('open');
      el.style.position = ''; el.style.top = ''; el.style.left = ''; el.style.right = ''; el.style.minWidth = '';
      const group = el.dataset.groupContent;
      const btn = document.querySelector(`.mobile-group-btn[data-group="${group}"]`);
      if (btn) btn.textContent = group.charAt(0).toUpperCase() + group.slice(1) + ' ▾';
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.mobile-group-wrap')) {
      closeAllMobileDropdowns();
      return;
    }
    var dd = e.target.closest('[data-group-content].open');
    if (dd) {
      var grp = dd.dataset.groupContent;
      if ((grp === 'tools' || grp === 'rotate') && e.target.closest('button')) {
        closeAllMobileDropdowns();
        return;
      }
    }
  });

  document.getElementById('btn-rotate-cw').addEventListener('click', function() {
    var a = parseInt(document.getElementById('rotate-angle-cw').value) || 90;
    rotateCW(a);
  });
  document.getElementById('btn-rotate-ccw').addEventListener('click', function() {
    var a = parseInt(document.getElementById('rotate-angle-ccw').value) || 90;
    rotateCCW(a);
  });
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
  document.getElementById('btn-duplicate').addEventListener('click', duplicateSelected);
  document.getElementById('btn-group').addEventListener('click', groupSelected);
  document.getElementById('btn-ungroup').addEventListener('click', ungroupSelected);
  document.getElementById('btn-move-up').addEventListener('click', function() { moveInGroup(1); });
  document.getElementById('btn-move-down').addEventListener('click', function() { moveInGroup(-1); });

  document.getElementById('btn-switch-slopinator').addEventListener('click', () => { location.href = 'index.html'; });

  document.addEventListener('keydown', (e) => {
    if (isEditing()) return;

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Tab' && state.selectedId) {
      var _sel = state.elements.find(function(el) { return el.id === state.selectedId; });
      if (_sel && _sel.parentId) {
        e.preventDefault();
        cycleGroupSelection(e.shiftKey ? -1 : 1);
        return;
      }
    }

    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
      refreshSelection();
      return;
    }

    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
      e.preventDefault();
      redo();
      refreshSelection();
      return;
    }

    if (e.ctrlKey && e.key === 'g') {
      e.preventDefault();
      groupSelected();
      return;
    }

    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveSVG();
      return;
    }

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
        case 'd':
          e.preventDefault();
          duplicateSelected();
          break;
        case 'f':
          switchTool('freehand');
          break;
        case 'r':
          switchTool('rectangle');
          break;
        case 'g':
          e.preventDefault();
          toggleGrid(!state.grid.visible);
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
            var selData = state.elements.find(function(el) { return el.id === state.selectedId; });
            if (selData && selData.parentId) {
              var groupData = state.elements.find(function(el) { return el.id === selData.parentId && el.type === 'group'; });
              if (groupData) { clearTempUngroup(); selectElement(groupData.id, false); break; }
            }
            clearSelection();
          }
          break;
      }
    }
  });

  var settingsPopup = document.getElementById('settings-popup');
  function _isOnPopup(e) { return settingsPopup && settingsPopup.contains(e.target); }

  document.getElementById('editor-container').addEventListener('wheel', (e) => {
    if (!state.hasImage) return;
    if (_isOnPopup(e)) return;
    e.preventDefault();

    if (e.deltaY < 0) {
      zoomIn(e.clientX, e.clientY);
    } else if (e.deltaY > 0) {
      zoomOut(e.clientX, e.clientY);
    }
  }, { passive: false });
  let pinchPointers = [];
  document.addEventListener('pointerdown', (e) => {
    if (_isOnPopup(e)) return;
    const idx = pinchPointers.findIndex(p => p.pointerId === e.pointerId);
    if (idx !== -1) pinchPointers.splice(idx, 1);
    pinchPointers.push({ pointerId: e.pointerId, x: e.clientX, y: e.clientY });
  });
  document.addEventListener('pointermove', (e) => {
    if (_isOnPopup(e)) return;
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
    if (_isOnPopup(e)) return;
    pinchPointers = pinchPointers.filter(p => p.pointerId !== e.pointerId);
    pinchPointers._lastDist = null;
  });
  document.addEventListener('pointercancel', (e) => {
    if (_isOnPopup(e)) return;
    pinchPointers = pinchPointers.filter(p => p.pointerId !== e.pointerId);
    pinchPointers._lastDist = null;
  });
}

function updateUndoRedoButtons() {
  document.getElementById('btn-undo').disabled = !canUndo();
  document.getElementById('btn-redo').disabled = !canRedo();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
