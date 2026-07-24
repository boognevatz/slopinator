// ── Select module: Selection, move, resize, delete ─────────────

import { state, dom } from './editor.js';
import { svgEl, screenToCoords } from './utils.js';
import { captureElementState } from './dom-utils.js';
import { snapToGrid } from './grid.js';
import { pushAction } from './history.js';
import { startEditing, isEditing } from './text.js';
import { refreshPalette } from './palette.js';
import { selectLayer } from './layers.js';
import { normalizeLineStyle, setActiveLineStyle, setActiveLineMarkerSize, normalizeLineMarkerSize, updateLineElement, normalizeLineDecoration, styleToDecoration, decorationToStyle, legacyStyleToDecorations } from './line.js';
import { updateFreehandElement, syncFreehandEpsilonSlider } from './freehand.js';
import { updateRectangleElement } from './rectangle.js';

let isDragging = false;
let isResizing = false;
let dragStart = null;
let dragOriginal = null;
let dragOriginals = null;
let resizeHandle = null; // 'p1' | 'p2' for line endpoints, 'tl'|'tr'|'bl'|'br' for text corners
let resizeAnchor = null; // { x, y } — the fixed corner during text resize
let origBbox = null;     // original text bounding box at resize start
let origBaselineOffY = 0; // data.y - bbox.y at resize start
let origBaselineOffX = 0; // data.x - bbox.x at resize start
let origDiagLen = 0;      // diagonal length of original bbox
let origDiagVec = null;   // unit vector along anchor → dragged corner
let textInteractMode = 'resize'; // 'resize' | 'rotate'
let origRotation = 0;     // original rotation angle when starting rotation
let rotationCenter = null; // { cx, cy }
let lineEditMode = 'move';  // 'move' | 'change-end'
let _tempUngrouped = false;
let selectedLineEndpoint = 'end'; // 'start' | 'end'
let rotationTooltip = null;
let _lastClickTime = 0;
let _lastClickId = null;
let _renameTargetId = null;

// Pan state
let isPanning = false;
let panStart = null;


export function initSelect() {
  // Listen for color/thickness changes on selected element
  document.addEventListener('palette-color-changed', (e) => {
    applyColorToSelected(e.detail.color);
  });
  document.addEventListener('palette-thickness-changed', (e) => {
    applyThicknessToSelected(e.detail.thickness);
  });
  document.addEventListener('palette-bgcolor-changed', (e) => {
    if (!state.selectedId) return;
    const data = state.elements.find(el => el.id === state.selectedId);
    if (!data) return;
    const color = e.detail.color;
    const oldFill = data.fill;
    if (oldFill === color) return;
    if (data.type === 'text') {
      data.fill = color;
      updateTextSVG(data);
      drawHandles(data);
      pushAction({
        description: 'Change text fill color',
        doFn: () => { data.fill = color; updateTextSVG(data); drawHandles(data); },
        undoFn: () => { data.fill = oldFill; updateTextSVG(data); drawHandles(data); },
      });
    } else if (data.type === 'rectangle') {
      data.fill = color === 'transparent' ? 'none' : color;
      updateRectangleElement(data);
      drawHandles(data);
      pushAction({
        description: 'Change rectangle fill color',
        doFn: () => { data.fill = color; updateRectangleElement(data); drawHandles(data); },
        undoFn: () => { data.fill = oldFill; updateRectangleElement(data); drawHandles(data); },
      });
    } else if (data.type === 'line' && data.closed) {
      data.fill = color === 'transparent' ? 'none' : color;
      updateLineSVG(data);
      drawHandles(data);
      pushAction({
        description: 'Change polygon fill color',
        doFn: () => { data.fill = color; updateLineSVG(data); drawHandles(data); },
        undoFn: () => { data.fill = oldFill; updateLineSVG(data); drawHandles(data); },
      });
    }
  });
  document.addEventListener('line-style-changed', (e) => {
    applyLineStyleToSelected(e.detail.style);
  });
  document.addEventListener('line-marker-size-changed', (e) => {
    applyLineMarkerSizeToSelected(e.detail.size);
  });

  // Font size input
  const fontSizeInput = document.getElementById('font-size-input');
  fontSizeInput.addEventListener('input', () => {
    const val = parseFloat(fontSizeInput.value);
    if (isNaN(val) || val < 1) return;
    state.activeFontSize = val;
    applyFontSizeToSelected(val);
    document.dispatchEvent(new CustomEvent('palette-fontsize-changed', { detail: { fontSize: val } }));
  });

  const lineModeMove = document.getElementById('btn-line-mode-move');
  const lineModeChangeEnd = document.getElementById('btn-line-mode-change-end');
  if (lineModeMove && lineModeChangeEnd) {
    lineModeMove.addEventListener('click', () => setLineEditMode('move'));
    lineModeChangeEnd.addEventListener('click', () => setLineEditMode('change-end'));
  }

  setLineEditMode(state.activeLineEditMode || 'move');

  // Corner radius input
  const radiusInput = document.getElementById('corner-radius-input');
  if (radiusInput) {
    radiusInput.addEventListener('change', () => {
      const val = parseFloat(radiusInput.value);
      if (isNaN(val) || val < 0) return;
      state.activeCornerRadius = val;
      applyCornerRadiusToSelected(val);
    });
  }

  // Element ID rename
  var idInput = document.getElementById('element-id-input');
  var idSaveBtn = document.getElementById('btn-id-save');
  if (idInput) {
    function saveId() {
      var targetId = _renameTargetId || state.selectedId;
      if (!targetId) return;
      var raw = idInput.value.trim();
      var sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!sanitized) {
        idInput.value = targetId;
        return;
      }
      var data = state.elements.find(function (e) { return e.id === targetId; });
      if (!data) return;
      var dup = state.elements.find(function (e) { return e.id === sanitized; });
      if (dup && dup !== data) {
        idInput.value = targetId;
        return;
      }
      var oldId = data.id;

      // Find longest common prefix between old group ID and child IDs
      var prefix = oldId;
      if (data.type === 'group' && data.childIds) {
        for (var ci = 0; ci < data.childIds.length; ci++) {
          while (data.childIds[ci].indexOf(prefix) !== 0 && prefix.length > 0) {
            prefix = prefix.slice(0, -1);
          }
          if (prefix.length === 0) break;
        }
      }

      data.id = sanitized;

      if (data.type === 'group') {
        // Extra suffix on the group ID beyond the common prefix (e.g. "-group")
        var extraSuffix = prefix.length > 0 ? oldId.slice(prefix.length) : '';
        // Derive base name for children (strip same extra suffix if it matches)
        var newBase = (extraSuffix && sanitized.endsWith(extraSuffix)) ? sanitized.slice(0, -extraSuffix.length) : sanitized;

        var oldToNew = {};
        for (var ci = 0; ci < data.childIds.length; ci++) {
          var oldChildId = data.childIds[ci];
          var child = state.elements.find(function(e) { return e.id === oldChildId; });
          if (!child) continue;
          child.parentId = sanitized;
          if (prefix.length > 0 && oldChildId.indexOf(prefix) === 0) {
            var newChildId = newBase + oldChildId.slice(prefix.length);
            if (!state.elements.some(function(e) { return e.id === newChildId; }) || newChildId === oldChildId) {
              child.id = newChildId;
              var childSvg = dom.annotationLayer.querySelector('#' + CSS.escape(oldChildId));
              if (childSvg) childSvg.id = newChildId;
              oldToNew[oldChildId] = newChildId;
            }
          }
        }
        // Update childIds array
        for (var ci = 0; ci < data.childIds.length; ci++) {
          if (oldToNew[data.childIds[ci]]) {
            data.childIds[ci] = oldToNew[data.childIds[ci]];
          }
        }
      } else if (data.parentId) {
        var parentGroup = state.elements.find(function(e) { return e.id === data.parentId && e.type === 'group'; });
        if (parentGroup) {
          var pci = parentGroup.childIds.indexOf(oldId);
          if (pci !== -1) parentGroup.childIds[pci] = sanitized;
        }
      }
      var svgEl = dom.annotationLayer.querySelector('#' + CSS.escape(oldId));
      if (svgEl) svgEl.id = sanitized;
      if (state.selectedId === oldId) {
        state.selectedId = sanitized;
      }
      _renameTargetId = sanitized;
      idInput.value = sanitized;
      if (idSaveBtn) idSaveBtn.style.display = 'none';
      idInput.blur();
      document.dispatchEvent(new CustomEvent('selection-changed'));
    }

    function showSaveBtn() {
      if (idSaveBtn) idSaveBtn.style.display = '';
    }
    function hideSaveBtn() {
      if (idSaveBtn) idSaveBtn.style.display = 'none';
    }

    idInput.addEventListener('focus', function() {
      showSaveBtn();
      renderGroupChildrenPreview();
    });
    idInput.addEventListener('blur', function () {
      // Delay so click on save button registers first
      setTimeout(function() {
        hideSaveBtn();
        var preview = document.getElementById('group-children-preview');
        if (preview) preview.style.display = 'none';
      }, 150);
    });
    idInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveId();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        idInput.value = _renameTargetId || state.selectedId || '';
        if (idSaveBtn) idSaveBtn.style.display = 'none';
        renderGroupChildrenPreview();
        idInput.blur();
      }
    });
    idInput.addEventListener('input', function () {
      this.value = this.value.replace(/[^a-zA-Z0-9_-]/g, '');
      renderGroupChildrenPreview();
    });
    if (idSaveBtn) {
      idSaveBtn.addEventListener('click', function (e) {
        e.preventDefault();
        saveId();
      });
    }
  }
}

function setLineEditMode(mode) {
  lineEditMode = mode;
  state.activeLineEditMode = mode;
  const moveBtn = document.getElementById('btn-line-mode-move');
  const changeBtn = document.getElementById('btn-line-mode-change-end');
  if (moveBtn && changeBtn) {
    moveBtn.classList.toggle('active', mode === 'move');
    changeBtn.classList.toggle('active', mode === 'change-end');
  }
  const data = state.selectedId ? state.elements.find(el => el.id === state.selectedId) : null;
  if (mode === 'change-end') {
    selectedLineEndpoint = null;
  }
  refreshSelection();
  if (data) {
    document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: data.id, data } }));
  }
}

function setSelectedLineEndpoint(endpoint) {
  selectedLineEndpoint = endpoint === 'start' ? 'start' : 'end';
  state.activeLineEndpoint = selectedLineEndpoint;

  const el = state.selectedId ? dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId)) : null;
  if (el && el.dataset.type === 'line') {
    syncLineToolbarFromSelection(el);
  }
}

function getDefaultLineEndpointFromEl(el) {
  if (normalizeLineDecoration(el.dataset.endDecoration) !== 'none') return 'end';
  if (normalizeLineDecoration(el.dataset.startDecoration) !== 'none') return 'start';
  return 'end';
}

function syncLineToolbarFromSelection(el) {
  const endpoint = selectedLineEndpoint === 'start' ? 'start' : 'end';
  const decoration = endpoint === 'start' ? normalizeLineDecoration(el.dataset.startDecoration) : normalizeLineDecoration(el.dataset.endDecoration);
  const size = endpoint === 'start' ? normalizeLineMarkerSize(el.dataset.startDecorationSize || el.dataset.lineMarkerSize) : normalizeLineMarkerSize(el.dataset.endDecorationSize || el.dataset.lineMarkerSize);
  setActiveLineStyle(decorationToStyle(decoration));
  setActiveLineMarkerSize(size);
}

export function activateSelect() {
  dom.svg.style.cursor = 'default';
  dom.svg.addEventListener('pointerdown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
}

export function deactivateSelect() {
  dom.svg.style.cursor = '';
  dom.svg.removeEventListener('pointerdown', onMouseDown);
  document.removeEventListener('keydown', onKeyDown);
  if (isPanning) {
    document.removeEventListener('pointermove', onPanMove);
    document.removeEventListener('pointerup', onPanEnd);
    isPanning = false;
    panStart = null;
  }
  clearSelection();
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  if (isEditing()) return;

  const target = e.target;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);

  // Check if clicking a handle (including child elements of a handle group)
  const handleEl = target.closest ? target.closest('.handle') : null;
  if (handleEl) {
    e.preventDefault();
    e.stopPropagation();
    
    // Toggle interact mode for center icon
    if (handleEl.dataset.handle === 'mode-toggle') {
      // Start drag immediately; onResizeEnd will detect if it was a click
      startResize(handleEl, pt, e);
      return;
    }

    if (state.selectedId) {
      const selected = state.elements.find(el => el.id === state.selectedId);
      if (selected && selected.type === 'line' && lineEditMode === 'change-end') {
        if (handleEl.dataset.handle === 'p1' || handleEl.dataset.handle === 'p2') {
          setSelectedLineEndpoint(handleEl.dataset.handle === 'p1' ? 'start' : 'end');
          refreshSelection();
          return;
        }
      }
    }

    startResize(handleEl, pt, e);
    return;
  }

  // Check if clicking an annotation
  const annotGroup = findAnnotationParent(target);
  if (annotGroup) {
    e.preventDefault();
    const id = annotGroup.id;

    const data = state.elements.find(el => el.id === id);

    // Double-click on text → edit (defer to next frame so mousedown
    // processing completes and doesn't steal focus from the textarea)
    const now = Date.now();
    const isDblClick = (e.detail >= 2) || (id === _lastClickId && now - _lastClickTime < 600);
    _lastClickTime = now;
    _lastClickId = id;
    if (isDblClick) {
      if (annotGroup.dataset && annotGroup.dataset.type === 'group') {
        var actualAnnot = findActualAnnotation(target);
        if (actualAnnot) {
          _tempUngrouped = true;
          selectElement(actualAnnot.id, false);
          return;
        }
      }
      if (data && data.type === 'text') {
        setTimeout(() => startEditing(id), 0);
        return;
      }
    }

    if (e.shiftKey) {
      selectElement(id, true);
      return;
    }

    if (state.selectedIds.includes(id) && state.selectedIds.length > 1) {
      state.selectedId = id;
      drawHandles(data);
    } else {
      selectElement(id, false);
    }

    if (data && data.type === 'line' && lineEditMode === 'change-end') {
      return;
    }
    startDrag(id, pt);
    return;
  }

  // Clicked empty space → pan
  clearSelection();
  if (state.hasImage) {
    e.preventDefault();
    const container = dom.svg.parentElement;
    isPanning = true;
    panStart = {
      clientX: e.clientX,
      clientY: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    dom.svg.style.cursor = 'grabbing';
    document.addEventListener('pointermove', onPanMove);
    document.addEventListener('pointerup', onPanEnd);
  }
}

function onPanMove(e) {
  if (!isPanning || !panStart) return;
  const container = dom.svg.parentElement;
  const dx = panStart.clientX - e.clientX;
  const dy = panStart.clientY - e.clientY;
  container.scrollLeft = panStart.scrollLeft + dx;
  container.scrollTop = panStart.scrollTop + dy;
}

function onPanEnd() {
  document.removeEventListener('pointermove', onPanMove);
  document.removeEventListener('pointerup', onPanEnd);
  isPanning = false;
  panStart = null;
  dom.svg.style.cursor = 'default';
}

function onKeyDown(e) {
  if (!state.selectedId) return;
  if (isEditing()) return;
  var tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  var dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  var dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!dx && !dy) return;
  e.preventDefault();

  for (var si = 0; si < state.selectedIds.length; si++) {
    var sid = state.selectedIds[si];
    var data = state.elements.find(function(el) { return el.id === sid; });
    if (!data) continue;

    if (data.type === 'line') {
      if (data.points) {
        data.points = data.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
        data.x1 = data.points[0].x;
        data.y1 = data.points[0].y;
        data.x2 = data.points[data.points.length - 1].x;
        data.y2 = data.points[data.points.length - 1].y;
      } else {
        data.x1 += dx;
        data.y1 += dy;
        data.x2 += dx;
        data.y2 += dy;
      }
      updateLineSVG(data);
    } else if (data.type === 'text') {
      data.x += dx;
      data.y += dy;
      updateTextSVG(data);
    } else if (data.type === 'freehand') {
      data.points = data.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      if (data.rawPoints) {
        data.rawPoints = data.rawPoints.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      }
      updateFreehandElement(data);
    } else if (data.type === 'rectangle') {
      data.x += dx;
      data.y += dy;
      updateRectangleElement(data);
    }
  }

  var primary = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (primary) drawHandles(primary);
}

function findAnnotationParent(target) {
  var el = target;
  while (el && el !== dom.svg) {
    if (el.dataset && (el.dataset.type === 'line' || el.dataset.type === 'freehand' || el.dataset.type === 'rectangle')) {
      var groupParent = el.parentElement;
      if (!_tempUngrouped && groupParent && groupParent.dataset && groupParent.dataset.type === 'group') return groupParent;
      return el;
    }
    if (el.dataset && el.dataset.type === 'text') {
      var gp = el.parentElement;
      if (!_tempUngrouped && gp && gp.dataset && gp.dataset.type === 'group') return gp;
      return el;
    }
    if (el.dataset && el.dataset.type === 'group') return el;
    el = el.parentElement;
  }
  return null;
}

function findActualAnnotation(target) {
  var el = target;
  while (el && el !== dom.svg) {
    if (el.dataset && (el.dataset.type === 'line' || el.dataset.type === 'freehand' || el.dataset.type === 'rectangle' || el.dataset.type === 'text')) return el;
    el = el.parentElement;
  }
  return null;
}

// ── Selection ───────────────────────────────────────────────────

export function clearTempUngroup() {
  _tempUngrouped = false;
}

export function selectElement(id, addToSelection) {
  var groupData = state.elements.find(function(el) { return el.id === id && el.type === 'group'; });
  if (groupData) {
    _tempUngrouped = false;
    if (addToSelection) {
      var allSelected = true;
      for (var gg = 0; gg < groupData.childIds.length; gg++) {
        if (state.selectedIds.indexOf(groupData.childIds[gg]) === -1) {
          allSelected = false;
          break;
        }
      }
      if (allSelected) {
        for (var gg2 = 0; gg2 < groupData.childIds.length; gg2++) {
          var idx = state.selectedIds.indexOf(groupData.childIds[gg2]);
          if (idx !== -1) state.selectedIds.splice(idx, 1);
        }
        if (state.selectedIds.length === 0) { clearSelection(); return; }
        state.selectedId = state.selectedIds[state.selectedIds.length - 1];
        var rem = state.elements.find(function(el) { return el.id === state.selectedId; });
        if (rem) { drawHandles(rem); document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false; document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: rem.id, data: rem } })); }
        return;
      }
      for (var gg3 = 0; gg3 < groupData.childIds.length; gg3++) {
        if (state.selectedIds.indexOf(groupData.childIds[gg3]) === -1) {
          state.selectedIds.push(groupData.childIds[gg3]);
        }
      }
    } else {
      clearSelection();
      state.selectedIds = groupData.childIds.slice();
    }
    state.selectedId = groupData.childIds[groupData.childIds.length - 1];
    var primChild = state.elements.find(function(el) { return el.id === state.selectedId; });
    if (primChild) drawHandles(primChild);
    document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
    document.getElementById('element-id-input').value = groupData.id;
    _renameTargetId = groupData.id;
    renderGroupChildrenPreview();
    document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id, data: groupData } }));
    var groupBtn = document.getElementById('btn-group');
    if (groupBtn) groupBtn.disabled = true;
    updateUngroupButton();
    updateMoveButtons();
    return;
  }

  if (!addToSelection) {
    var _selEl = state.elements.find(function(e) { return e.id === id; });
    var _keepUngroup = _tempUngrouped && _selEl && _selEl.parentId;
    clearSelection();
    _tempUngrouped = _keepUngroup;
  }

  state.selectedId = id;

  if (addToSelection) {
    var selIdx = state.selectedIds.indexOf(id);
    if (selIdx >= 0) {
      state.selectedIds.splice(selIdx, 1);
      if (state.selectedIds.length === 0) {
        clearSelection();
        return;
      }
      state.selectedId = state.selectedIds[state.selectedIds.length - 1];
      var remaining = state.elements.find(function(el) { return el.id === state.selectedId; });
      if (remaining) {
        drawHandles(remaining);
        document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
        var inp = document.getElementById('element-id-input');
        if (inp) { inp.value = remaining.id; _renameTargetId = remaining.id; renderGroupChildrenPreview(); }
        document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: remaining.id, data: remaining } }));
      }
      return;
    }
    state.selectedIds.push(id);
  } else {
    state.selectedIds = [id];
  }

  const data = state.elements.find(el => el.id === id);
  if (!data) return;

  // Switch to the layer this element belongs to
  var svgEl = dom.svg.querySelector('#' + CSS.escape(id));
  if (svgEl) {
    var parent = svgEl.parentElement;
    while (parent && parent !== dom.svg) {
      if (parent.id && (parent.id === 'layer-annotation' || parent.id.startsWith('layer-user-'))) {
        var currentLayerEl = document.querySelector('.layer-entry.selected');
        var currentLayerId = currentLayerEl ? currentLayerEl.dataset.layer : null;
        if (parent.id !== currentLayerId) {
          selectLayer(parent.id);
        }
        break;
      }
      parent = parent.parentElement;
    }
  }

  // Update active color/thickness from selected element
  if (data.type === 'line') {
    setLineEditMode('move');
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    setActiveLineStyle(data.lineStyle);
    setActiveLineMarkerSize(data.lineMarkerSize);
    if (data.closed) {
      state.bgColor = data.fill && data.fill !== 'none' ? data.fill : 'transparent';
    }
  } else if (data.type === 'text') {
    state.activeColor = data.stroke || state.activeColor;
    state.bgColor = data.fill || state.bgColor;
    state.activeThickness = data.strokeWidth || state.activeThickness;
    state.activeFontSize = data.fontSize;
    document.getElementById('font-size-input').value = data.fontSize;
  } else if (data.type === 'freehand') {
    state.activeColor = data.stroke;
    state.activeThickness = data.strokeWidth;
    syncFreehandEpsilonSlider(data.epsilon);
  } else if (data.type === 'rectangle') {
    state.activeColor = data.stroke;
    state.bgColor = data.fill === 'none' ? 'transparent' : (data.fill || state.bgColor);
    state.activeThickness = data.strokeWidth;
    state.activeCornerRadius = data.rx || 0;
    document.getElementById('corner-radius-input').value = data.rx || 0;
  }

  drawHandles(data);
  document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
  refreshPalette();

  // Sync element ID display
  var idInput = document.getElementById('element-id-input');
  if (idInput) { idInput.value = data.id; _renameTargetId = data.id; }
  renderGroupChildrenPreview();

  updateGroupButton();
  updateUngroupButton();
  updateMoveButtons();

  // Dispatch event so palette highlights update
  document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id, data } }));
}

function updateGroupButton() {
  var btn = document.getElementById('btn-group');
  if (!btn) return;
  if (state.selectedIds.length < 2) { btn.disabled = true; return; }
  for (var gi = 0; gi < state.selectedIds.length; gi++) {
    var el = state.elements.find(function(e) { return e.id === state.selectedIds[gi]; });
    if (el && el.parentId) { btn.disabled = true; return; }
  }
  btn.disabled = false;
}

export function updateUngroupButton() {
  var btn = document.getElementById('btn-ungroup');
  if (!btn) return;
  if (state.selectedIds.length < 2) { btn.disabled = true; return; }
  var pid = null;
  for (var ui = 0; ui < state.selectedIds.length; ui++) {
    var el = state.elements.find(function(e) { return e.id === state.selectedIds[ui]; });
    if (!el || !el.parentId) { btn.disabled = true; return; }
    if (ui === 0) pid = el.parentId;
    else if (el.parentId !== pid) { btn.disabled = true; return; }
  }
  var gd = state.elements.find(function(e) { return e.id === pid && e.type === 'group'; });
  if (!gd || gd.childIds.length !== state.selectedIds.length) { btn.disabled = true; return; }
  btn.disabled = false;
}

export function cycleGroupSelection(direction) {
  if (!state.selectedId) return;
  var selData = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!selData || !selData.parentId) return;
  var groupData = state.elements.find(function(el) { return el.id === selData.parentId && el.type === 'group'; });
  if (!groupData || !groupData.childIds.length) return;
  var idx = groupData.childIds.indexOf(state.selectedId);
  if (idx === -1) return;
  var newIdx = (idx + direction + groupData.childIds.length) % groupData.childIds.length;
  selectElement(groupData.childIds[newIdx], false);
}

export function clearSelection() {
  _tempUngrouped = false;
  state.selectedId = null;
  state.selectedIds = [];
  dom.handleLayer.innerHTML = '';
  document.getElementById('btn-delete').disabled = true;
  document.getElementById('btn-duplicate').disabled = true;
  updateGroupButton();
  updateUngroupButton();
  updateMoveButtons();
  var idInput = document.getElementById('element-id-input');
  if (idInput) { idInput.value = ''; _renameTargetId = null; }
  var preview = document.getElementById('group-children-preview');
  if (preview) preview.style.display = 'none';
  textInteractMode = 'resize';
  hideRotationTooltip();
}

function buildLineDataFromEl(el) {
  var lineEl = el.querySelector('.annotation-line');
  if (!lineEl) return null;
  var tag = lineEl.tagName.toLowerCase();
  var transformAttr = el.getAttribute('transform');
  var rotation = parseFloat(transformAttr ? transformAttr.match(/rotate\(([^,)]+)/)[1] : 0);
  if (tag === 'line') {
    return {
      x1: parseFloat(lineEl.getAttribute('x1')),
      y1: parseFloat(lineEl.getAttribute('y1')),
      x2: parseFloat(lineEl.getAttribute('x2')),
      y2: parseFloat(lineEl.getAttribute('y2')),
      rotation: rotation || 0,
    };
  }
  var ptsAttr = lineEl.getAttribute('points');
  if (!ptsAttr) return null;
  var pts = ptsAttr.trim().split(/\s+/).map(function(p) {
    var parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  });
  if (pts.length < 2) return null;
  return {
    x1: pts[0].x, y1: pts[0].y,
    x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y,
    rotation: rotation || 0,
  };
}

function buildRectDataFromEl(el) {
  var fillRect = el.querySelector('.rect-fill');
  if (!fillRect) return null;
  return {
    x: parseFloat(fillRect.getAttribute('x')),
    y: parseFloat(fillRect.getAttribute('y')),
    width: parseFloat(fillRect.getAttribute('width')),
    height: parseFloat(fillRect.getAttribute('height')),
  };
}

function readPointsFromEl(el) {
  var polyline = el.querySelector('polyline, .annotation-line');
  if (!polyline) return [];
  var ptsAttr = polyline.getAttribute('points');
  if (!ptsAttr) return [];
  return ptsAttr.trim().split(/\s+/).map(function(p) {
    var parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  });
}

export function drawHandles(_data) {
  dom.handleLayer.innerHTML = '';

  for (var _i = 0; _i < state.selectedIds.length; _i++) {
    var _sid = state.selectedIds[_i];
    var svgEl = dom.annotationLayer.querySelector('#' + CSS.escape(_sid));
    if (!svgEl) continue;

    var type = svgEl.dataset.type;
    if (type === 'line') {
      var lineData = buildLineDataFromEl(svgEl);
      if (lineData) drawLineHandles(lineData);
    } else if (type === 'text') {
      var rotAttr = svgEl.getAttribute('transform');
      var rot = parseFloat(rotAttr ? rotAttr.match(/rotate\(([^,)]+)/)[1] : 0);
      drawTextHandles({ id: _sid, rotation: rot || 0 });
    } else if (type === 'freehand') {
      var pts = readPointsFromEl(svgEl);
      if (pts.length) drawFreehandHandles({ points: pts });
    } else if (type === 'rectangle') {
      var rectData = buildRectDataFromEl(svgEl);
      if (rectData) drawRectangleHandles(rectData);
    }
  }
}

function drawLineHandles(data) {
  const r = getHandleRadius();
  const startActive = lineEditMode === 'change-end' && selectedLineEndpoint === 'start';
  const endActive = lineEditMode === 'change-end' && selectedLineEndpoint === 'end';
  const startUnselected = lineEditMode === 'change-end' && !startActive;
  const endUnselected = lineEditMode === 'change-end' && !endActive;
  const isRotateMode = textInteractMode === 'rotate';

  const cursorStyle = isRotateMode ? 'cursor: grab;' : '';
  const cx = (data.x1 + data.x2) / 2;
  const cy = (data.y1 + data.y2) / 2;

  const handleGroup = svgEl('g', {
    transform: data.rotation ? `rotate(${data.rotation}, ${cx}, ${cy})` : ''
  });

  const h1 = svgEl('circle', {
    cx: data.x1, cy: data.y1, r,
    class: 'handle handle-endpoint' + (startActive ? ' active' : '') + (startUnselected ? ' unselected' : ''),
    'data-handle': 'p1',
    style: cursorStyle,
  });
  const h2 = svgEl('circle', {
    cx: data.x2, cy: data.y2, r,
    class: 'handle handle-endpoint' + (endActive ? ' active' : '') + (endUnselected ? ' unselected' : ''),
    'data-handle': 'p2',
    style: cursorStyle,
  });

  handleGroup.appendChild(h1);
  handleGroup.appendChild(h2);

  if (lineEditMode === 'move') {
    const mx = cx;
    const my = cy;
    const dx = data.x2 - data.x1;
    const dy = data.y2 - data.y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    const iconSize = 24;
    const desiredIconSize = Math.max(32, Math.min(72, len * 0.8));
    const iconScale = desiredIconSize / iconSize;
    const actualSize = iconSize * iconScale;

    const iconG = svgEl('g', {
      class: 'handle handle-icon',
      'data-handle': 'mode-toggle',
      transform: `translate(${mx - actualSize / 2}, ${my - actualSize / 2}) scale(${iconScale})`,
    });

    iconG.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 12, fill: '#000' }));

    const movePath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
    const rotatePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

    iconG.appendChild(svgEl('path', {
      d: isRotateMode ? rotatePath : movePath,
      fill: '#fff',
    }));

    handleGroup.appendChild(iconG);
  }

  dom.handleLayer.appendChild(handleGroup);
}

function drawTextHandles(data) {
  // Get bounding box of the text element
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!textEl) return;

  let bbox;
  try {
    bbox = textEl.getBBox();
  } catch {
    return;
  }

  const bx = bbox.x;
  const by = bbox.y;
  const bw = bbox.width;
  const bh = bbox.height;

  // Center of the text
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;

  // Create a group for the handles to apply the same rotation as the text
  const handleGroup = svgEl('g', {
    transform: `rotate(${data.rotation || 0}, ${cx}, ${cy})`
  });
  dom.handleLayer.appendChild(handleGroup);

  // Dashed selection box
  const selBox = svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'selection-box',
  });
  handleGroup.appendChild(selBox);

  // 4 corner resize handles, square, same size as line endpoint handles
  const r = getHandleRadius();
  const hw = r * 2;
  const hh = r * 2;

  const isRotate = textInteractMode === 'rotate';

  const corners = [
    { handle: 'tl', x: bx,            y: by,            cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: bx + bw - hw,  y: by,            cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'bl', x: bx,            y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'br', x: bx + bw - hw,  y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (const c of corners) {
    const h = svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    handleGroup.appendChild(h);
  }

  // Draw the center mode-toggle icon
  const iconSize = 24; // Base size for icon viewBox
  
  // Scale the icon so it stays visually proportional to the box size, clamped
  // Making it roughly twice the corner handles
  const desiredIconSize = Math.max(32, Math.min(72, Math.min(bw, bh) * 0.8));
  const iconScale = desiredIconSize / iconSize;
  const actualSize = iconSize * iconScale;

  const iconG = svgEl('g', {
    class: 'handle handle-icon',
    'data-handle': 'mode-toggle',
    transform: `translate(${cx - actualSize / 2}, ${cy - actualSize / 2}) scale(${iconScale})`,
  });

  // Background circle for visibility
  iconG.appendChild(svgEl('circle', {
    cx: 12, cy: 12, r: 12,
    fill: '#000',
  }));

  // SVG paths for icons (Material Design)
  const crossArrowPath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
  const recyclePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  const pathEl = svgEl('path', {
    d: isRotate ? recyclePath : crossArrowPath,
    fill: '#fff'
  });
  iconG.appendChild(pathEl);

  handleGroup.appendChild(iconG);
}

function drawFreehandHandles(data) {
  const r = getHandleRadius();
  let cx = 0, cy = 0;
  for (const p of data.points) { cx += p.x; cy += p.y; }
  cx /= data.points.length;
  cy /= data.points.length;
  const hm = svgEl('rect', {
    x: cx - r, y: cy - r, width: r * 2, height: r * 2,
    class: 'handle handle-move',
    'data-handle': 'move',
  });
  dom.handleLayer.appendChild(hm);
}

function drawRectangleHandles(data) {
  const viewBox = dom.svg.viewBox.baseVal;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox && viewBox.width ? viewBox.width / svgRect.width : 1;
  const hw = Math.max(22, 28 * scale);
  const hh = hw;
  const { x, y, width: w, height: h } = data;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const isRotate = textInteractMode === 'rotate';

  const handleGroup = svgEl('g', {
    transform: `rotate(${data.rotation || 0}, ${cx}, ${cy})`
  });

  const selBox = svgEl('rect', {
    x, y, width: w, height: h,
    class: 'selection-box',
  });
  handleGroup.appendChild(selBox);

  const corners = [
    { handle: 'tl', x, y, cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: x + w - hw, y, cursor: isRotate ? 'grab' : 'pointer' },
    { handle: 'bl', x, y: y + h - hh, cursor: isRotate ? 'grab' : 'pointer' },
    { handle: 'br', x: x + w - hw, y: y + h - hh, cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (const c of corners) {
    const h = svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    });
    handleGroup.appendChild(h);
  }

  const iconSize = 24;
  const desiredIconSize = Math.min(w, h) * 0.8;
  const iconScale = Math.max(1.0, Math.min(3.0, desiredIconSize / iconSize));
  const actualSize = iconSize * iconScale;

  const iconG = svgEl('g', {
    class: 'handle handle-icon',
    'data-handle': 'mode-toggle',
    transform: `translate(${cx - actualSize / 2}, ${cy - actualSize / 2}) scale(${iconScale})`,
  });

  iconG.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 12, fill: '#000' }));

  const movePath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
  const rotatePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  iconG.appendChild(svgEl('path', {
    d: isRotate ? rotatePath : movePath,
    fill: '#fff',
  }));

  handleGroup.appendChild(iconG);
  dom.handleLayer.appendChild(handleGroup);
}

function getHandleRadius() {
  // Scale handle size based on viewBox so they look consistent
  const viewBox = dom.svg.viewBox.baseVal;
  if (!viewBox || viewBox.width === 0) return 6;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox.width / svgRect.width;
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  return Math.max(isTouch ? 16 : 6, 8 * scale);
}

// ── Drag (move) ─────────────────────────────────────────────────

function getBBoxFromData(el) {
  if (el.type === 'line') {
    if (el.points && el.points.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var pi = 0; pi < el.points.length; pi++) {
        var p = el.points[pi];
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    var lx1 = Math.min(el.x1, el.x2), lx2 = Math.max(el.x1, el.x2);
    var ly1 = Math.min(el.y1, el.y2), ly2 = Math.max(el.y1, el.y2);
    return { x: lx1, y: ly1, width: lx2 - lx1, height: ly2 - ly1 };
  }
  if (el.type === 'text') {
    var textEl = dom.annotationLayer.querySelector('#' + CSS.escape(el.id));
    if (textEl) {
      try {
        var bbox = textEl.getBBox();
        return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
      } catch {}
    }
    var charCount = (el.content || 'Text').length;
    return { x: el.x, y: el.y - el.fontSize * 0.9, width: charCount * el.fontSize * 0.6, height: el.fontSize * 1.2 };
  }
  if (el.type === 'rectangle') {
    return { x: el.x, y: el.y, width: el.width || 0, height: el.height || 0 };
  }
  if (el.type === 'freehand') {
    var fxMin = Infinity, fyMin = Infinity, fxMax = -Infinity, fyMax = -Infinity;
    for (var fi = 0; fi < el.points.length; fi++) {
      var fp = el.points[fi];
      if (fp.x < fxMin) fxMin = fp.x; if (fp.y < fyMin) fyMin = fp.y;
      if (fp.x > fxMax) fxMax = fp.x; if (fp.y > fyMax) fyMax = fp.y;
    }
    return { x: fxMin, y: fyMin, width: fxMax - fxMin, height: fyMax - fyMin };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

function startDrag(id, startPt) {
  const data = state.elements.find(el => el.id === id);
  if (!data) return;

  // Combined bounding box of all selected elements
  var ids = state.selectedIds.length ? state.selectedIds : [id];
  var bbox = null;
  for (var si = 0; si < ids.length; si++) {
    var el = state.elements.find(function(e) { return e.id === ids[si]; });
    if (!el) continue;
    var eb = getBBoxFromData(el);
    if (!bbox) bbox = eb;
    else {
      var x1 = Math.min(bbox.x, eb.x);
      var y1 = Math.min(bbox.y, eb.y);
      var x2 = Math.max(bbox.x + bbox.width, eb.x + eb.width);
      var y2 = Math.max(bbox.y + bbox.height, eb.y + eb.height);
      bbox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }
  if (!bbox) bbox = { x: startPt.x, y: startPt.y, width: 0, height: 0 };

  // Find closest snap point (4 corners + center)
  var corners = [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x, y: bbox.y + bbox.height },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 },
  ];
  var closest = corners[0];
  var minDist = Infinity;
  for (var j = 0; j < corners.length; j++) {
    var d = Math.hypot(corners[j].x - startPt.x, corners[j].y - startPt.y);
    if (d < minDist) { minDist = d; closest = corners[j]; }
  }

  isDragging = true;
  dragStart = { x: closest.x, y: closest.y, _time: Date.now(), _offX: closest.x - startPt.x, _offY: closest.y - startPt.y };
  dragOriginal = { ...data };
  dragOriginals = state.selectedIds.map(function(sid) {
    var el = state.elements.find(function(e) { return e.id === sid; });
    return el ? { id: sid, x: el.x, y: el.y, x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2, points: el.points ? el.points.map(function(p) { return { x: p.x, y: p.y }; }) : null, rawPoints: el.rawPoints ? el.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }) : null } : null;
  }).filter(Boolean);

  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e) {
  if (!isDragging) return;
  const rawPt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const snappedPt = snapToGrid({ x: rawPt.x + dragStart._offX, y: rawPt.y + dragStart._offY });
  const dx = snappedPt.x - dragStart.x;
  const dy = snappedPt.y - dragStart.y;

  for (var i = 0; i < dragOriginals.length; i++) {
    var orig = dragOriginals[i];
    var el = state.elements.find(function(e) { return e.id === orig.id; });
    if (!el) continue;

    if (el.type === 'line') {
      if (el.points) {
        el.points = orig.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
        el.x1 = el.points[0].x;
        el.y1 = el.points[0].y;
        el.x2 = el.points[el.points.length - 1].x;
        el.y2 = el.points[el.points.length - 1].y;
      } else {
        el.x1 = orig.x1 + dx;
        el.y1 = orig.y1 + dy;
        el.x2 = orig.x2 + dx;
        el.y2 = orig.y2 + dy;
      }
      updateLineSVG(el);
    } else if (el.type === 'text') {
      el.x = orig.x + dx;
      el.y = orig.y + dy;
      updateTextSVG(el);
    } else if (el.type === 'freehand') {
      el.points = orig.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      if (el.rawPoints) {
        el.rawPoints = orig.rawPoints.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      }
      updateFreehandElement(el);
    } else if (el.type === 'rectangle') {
      el.x = orig.x + dx;
      el.y = orig.y + dy;
      updateRectangleElement(el);
    }
  }

  var primary = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (primary) drawHandles(primary);
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);

  if (!isDragging) return;
  isDragging = false;

  var primaryData = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!primaryData) { dragOriginal = null; dragOriginals = null; return; }

  // Single-element special behaviors: long-press text edit, mode-toggle click
  if (dragOriginals.length === 1) {
    const orig = { ...dragOriginal };
    const final = { ...primaryData };

    if (primaryData.type === 'text' && dragStart && dragStart._time) {
      const elapsed = Date.now() - dragStart._time;
      if (elapsed >= 400 && orig.x === final.x && orig.y === final.y) {
        dragOriginal = null; dragOriginals = null;
        setTimeout(function() { startEditing(state.selectedId); }, 0);
        return;
      }
    }

    if (dragStart && dragStart._dragSource === 'mode-toggle') {
      let dx, dy;
      if (primaryData.type === 'line') { dx = final.x1 - orig.x1; dy = final.y1 - orig.y1; }
      else { dx = (final.x || 0) - (orig.x || 0); dy = (final.y || 0) - (orig.y || 0); }
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        dragOriginal = null; dragOriginals = null;
        textInteractMode = textInteractMode === 'resize' ? 'rotate' : 'resize';
        refreshSelection();
        return;
      }
    }
  }

  // Build combined action for all moved elements
  var snapshots = [];
  var moved = false;
  for (var i = 0; i < dragOriginals.length; i++) {
    var orig = dragOriginals[i];
    var el = state.elements.find(function(e) { return e.id === orig.id; });
    if (!el) continue;
    var dx = el.x != null ? el.x - orig.x : 0;
    var dy = el.y != null ? el.y - orig.y : 0;
    if (el.type === 'line') {
      dx = el.x1 - orig.x1;
      dy = el.y1 - orig.y1;
    }
    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) moved = true;
    snapshots.push({ id: orig.id, orig: { x: orig.x, y: orig.y, x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2, points: orig.points ? orig.points.map(function(p) { return { x: p.x, y: p.y }; }) : null, rawPoints: orig.rawPoints ? orig.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }) : null }, final: null });
    // Capture final positions
    var snap = snapshots[snapshots.length - 1];
    if (el.type === 'line') {
      snap.final = { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2, points: el.points ? el.points.map(function(p) { return { x: p.x, y: p.y }; }) : null };
    } else if (el.type === 'text') {
      snap.final = { x: el.x, y: el.y };
    } else if (el.type === 'freehand') {
      snap.final = { points: el.points.map(function(p) { return { x: p.x, y: p.y }; }), rawPoints: el.rawPoints ? el.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }) : null };
    } else if (el.type === 'rectangle') {
      snap.final = { x: el.x, y: el.y };
    }
  }

  if (moved) {
    pushAction({
      description: 'Move ' + snapshots.length + ' element' + (snapshots.length > 1 ? 's' : ''),
      doFn: function() {
        for (var j = 0; j < snapshots.length; j++) {
          var s = snapshots[j];
          var e = state.elements.find(function(el2) { return el2.id === s.id; });
          if (!e) continue;
          if (e.type === 'line') {
            e.x1 = s.final.x1; e.y1 = s.final.y1; e.x2 = s.final.x2; e.y2 = s.final.y2;
            if (s.final.points) e.points = s.final.points.map(function(p) { return { x: p.x, y: p.y }; });
            updateLineSVG(e);
          } else if (e.type === 'text') { e.x = s.final.x; e.y = s.final.y; updateTextSVG(e); }
          else if (e.type === 'freehand') { e.points = s.final.points.map(function(p) { return { x: p.x, y: p.y }; }); if (s.final.rawPoints) e.rawPoints = s.final.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }); updateFreehandElement(e); }
          else if (e.type === 'rectangle') { e.x = s.final.x; e.y = s.final.y; updateRectangleElement(e); }
        }
        var prim = state.elements.find(function(el2) { return el2.id === state.selectedId; });
        if (prim) drawHandles(prim);
      },
      undoFn: function() {
        for (var j = 0; j < snapshots.length; j++) {
          var s = snapshots[j];
          var e = state.elements.find(function(el2) { return el2.id === s.id; });
          if (!e) continue;
          if (e.type === 'line') {
            e.x1 = s.orig.x1; e.y1 = s.orig.y1; e.x2 = s.orig.x2; e.y2 = s.orig.y2;
            if (s.orig.points) e.points = s.orig.points.map(function(p) { return { x: p.x, y: p.y }; });
            updateLineSVG(e);
          } else if (e.type === 'text') { e.x = s.orig.x; e.y = s.orig.y; updateTextSVG(e); }
          else if (e.type === 'freehand') { e.points = s.orig.points.map(function(p) { return { x: p.x, y: p.y }; }); if (s.orig.rawPoints) e.rawPoints = s.orig.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }); updateFreehandElement(e); }
          else if (e.type === 'rectangle') { e.x = s.orig.x; e.y = s.orig.y; updateRectangleElement(e); }
        }
        var prim = state.elements.find(function(el2) { return el2.id === state.selectedId; });
        if (prim) drawHandles(prim);
      },
    });
  }

  dragOriginal = null;
  dragOriginals = null;
}

// ── Resize ──────────────────────────────────────────────────────

function startResize(handleEl, startPt, e) {
  e.preventDefault();
  const handleType = handleEl.dataset.handle;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  // Mode-toggle: start drag (move). _dragSource flags for click detection
  if (handleType === 'mode-toggle' && (data.type === 'line' || data.type === 'text' || data.type === 'rectangle')) {
    startDrag(state.selectedId, startPt);
    if (dragStart) dragStart._dragSource = 'mode-toggle';
    return;
  }

  isResizing = true;
  resizeHandle = handleType;
  dragStart = startPt;
  dragOriginal = { ...data };

  if (data.type === 'line' && (handleType === 'p1' || handleType === 'p2') && textInteractMode === 'rotate') {
    const cx = (data.x1 + data.x2) / 2;
    const cy = (data.y1 + data.y2) / 2;
    origRotation = data.rotation || 0;
    rotationCenter = { x: cx, y: cy };
    dragStart.angle = Math.atan2(startPt.y - cy, startPt.x - cx) * 180 / Math.PI;
  } else if (data.type === 'text' && ['tl', 'tr', 'bl', 'br'].includes(handleType)) {
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
    if (textEl) {
      try {
        const bb = textEl.getBBox();
        const pad = 4;
        origBbox = {
          x: bb.x - pad, y: bb.y - pad,
          width: bb.width + pad * 2, height: bb.height + pad * 2,
        };
      } catch {
        origBbox = { x: data.x, y: data.y - data.fontSize, width: data.fontSize * 4, height: data.fontSize };
      }
    }

    origRotation = data.rotation || 0;
    rotationCenter = {
      x: origBbox.x + origBbox.width / 2,
      y: origBbox.y + origBbox.height / 2
    };

    if (textInteractMode === 'rotate') {
      // Calculate original angle from center to mouse
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else {
      // Baseline offset relative to bbox top-left
      origBaselineOffX = data.x - origBbox.x;
      origBaselineOffY = data.y - origBbox.y;

      // Anchor = opposite corner of the bounding box
      const anchorMap = {
        tl: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
        tr: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
        bl: { x: origBbox.x + origBbox.width, y: origBbox.y },
        br: { x: origBbox.x,                  y: origBbox.y },
      };
      resizeAnchor = anchorMap[handleType];

      // Original diagonal length (anchor to dragged corner)
      const draggedCornerMap = {
        tl: { x: origBbox.x,                  y: origBbox.y },
        tr: { x: origBbox.x + origBbox.width, y: origBbox.y },
        bl: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
        br: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
      };
      const dc = draggedCornerMap[handleType];
      const dx = dc.x - resizeAnchor.x;
      const dy = dc.y - resizeAnchor.y;
      origDiagLen = Math.sqrt(dx * dx + dy * dy);
      origDiagVec = origDiagLen > 0
        ? { x: dx / origDiagLen, y: dy / origDiagLen }
        : { x: 1, y: 1 };
    }
  } else if (data.type === 'rectangle') {
    origRotation = data.rotation || 0;
    rotationCenter = {
      x: data.x + data.width / 2,
      y: data.y + data.height / 2
    };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else if (handleType === 'tl' || handleType === 'br') {
      const anchorMap = {
        tl: { x: data.x + data.width, y: data.y + data.height },
        br: { x: data.x, y: data.y },
      };
      resizeAnchor = anchorMap[handleType];
      const dc = handleType === 'tl'
        ? { x: data.x, y: data.y }
        : { x: data.x + data.width, y: data.y + data.height };
      const dx = dc.x - resizeAnchor.x;
      const dy = dc.y - resizeAnchor.y;
      origDiagLen = Math.sqrt(dx * dx + dy * dy);
      origDiagVec = origDiagLen > 0
        ? { x: dx / origDiagLen, y: dy / origDiagLen }
        : { x: 1, y: 1 };
    } else if (handleType === 'bl' || handleType === 'tr') {
      resizeAnchor = {
        x: handleType === 'bl' ? data.x : data.x + data.width,
        y: handleType === 'bl' ? data.y + data.height : data.y,
      };
    }
  }

  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  if (data.type === 'line') {
    if (textInteractMode === 'rotate' && (resizeHandle === 'p1' || resizeHandle === 'p2')) {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      newRot = Math.round(newRot / 5) * 5;
      newRot = ((newRot % 360) + 360) % 360;
      data.rotation = newRot;
      updateLineSVG(data);
      showRotationTooltip(e, newRot);
    } else if (resizeHandle === 'p1') {
      data.x1 = pt.x;
      data.y1 = pt.y;
      if (data.points) { data.points[0] = { x: pt.x, y: pt.y }; }
    } else if (resizeHandle === 'p2') {
      data.x2 = pt.x;
      data.y2 = pt.y;
      if (data.points) { data.points[data.points.length - 1] = { x: pt.x, y: pt.y }; }
    }
    updateLineSVG(data);
  } else if (data.type === 'text') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      
      // Snap to 5 degrees
      newRot = Math.round(newRot / 5) * 5;
      
      // Keep it 0-360
      newRot = ((newRot % 360) + 360) % 360;
      
      data.rotation = newRot;
      updateTextSVG(data);
    } else if (resizeAnchor) {
      // Un-rotate mouse point so it matches the unrotated bounding box space
      const angleRad = -(data.rotation || 0) * Math.PI / 180;
      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      const dxMouse = pt.x - rotationCenter.x;
      const dyMouse = pt.y - rotationCenter.y;
      const unrotatedPtX = rotationCenter.x + dxMouse * cosA - dyMouse * sinA;
      const unrotatedPtY = rotationCenter.y + dxMouse * sinA + dyMouse * cosA;

      // Project unrotated mouse vector onto original diagonal to get signed scale
      const mx = unrotatedPtX - resizeAnchor.x;
      const my = unrotatedPtY - resizeAnchor.y;
      const projLen = mx * origDiagVec.x + my * origDiagVec.y;
      const scaleFactor = origDiagLen > 0 ? projLen / origDiagLen : 1;

      // Clamp to minimum size
      const newSize = Math.max(8, Math.round(dragOriginal.fontSize * Math.abs(scaleFactor)));
      const s = newSize / dragOriginal.fontSize;

      data.fontSize = newSize;

      // Reposition so the anchor corner stays fixed.
      // New bbox top-left = anchor - (anchor_to_origTopLeft) * s
      // But which component depends on which corner is anchored.
      const handle = resizeHandle;
      if (handle === 'br') {
        // anchor = original top-left of bbox
        data.x = resizeAnchor.x + origBaselineOffX * s;
        data.y = resizeAnchor.y + origBaselineOffY * s;
      } else if (handle === 'bl') {
        // anchor = original top-right → new top-left = anchor.x - newWidth
        data.x = resizeAnchor.x - origBbox.width * s + origBaselineOffX * s;
        data.y = resizeAnchor.y + origBaselineOffY * s;
      } else if (handle === 'tr') {
        // anchor = original bottom-left → new top-left.y = anchor.y - newHeight
        data.x = resizeAnchor.x + origBaselineOffX * s;
        data.y = resizeAnchor.y - origBbox.height * s + origBaselineOffY * s;
      } else if (handle === 'tl') {
        // anchor = original bottom-right
        data.x = resizeAnchor.x - origBbox.width * s + origBaselineOffX * s;
        data.y = resizeAnchor.y - origBbox.height * s + origBaselineOffY * s;
      }

      updateTextSVG(data);
      document.getElementById('font-size-input').value = data.fontSize;
    }
  } else if (data.type === 'rectangle') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      newRot = Math.round(newRot / 5) * 5;
      newRot = ((newRot % 360) + 360) % 360;
      data.rotation = newRot;
      updateRectangleElement(data);
      showRotationTooltip(e, newRot);
    } else if (resizeHandle === 'tl' || resizeHandle === 'br') {
      const angleRad = -(data.rotation || 0) * Math.PI / 180;
      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      const dxMouse = pt.x - rotationCenter.x;
      const dyMouse = pt.y - rotationCenter.y;
      const unrotatedPtX = rotationCenter.x + dxMouse * cosA - dyMouse * sinA;
      const unrotatedPtY = rotationCenter.y + dxMouse * sinA + dyMouse * cosA;

      const mx = unrotatedPtX - resizeAnchor.x;
      const my = unrotatedPtY - resizeAnchor.y;
      const projLen = mx * origDiagVec.x + my * origDiagVec.y;
      const scaleFactor = origDiagLen > 0 ? Math.max(0.1, projLen / origDiagLen) : 1;

      const newW = Math.max(5, Math.round(dragOriginal.width * Math.abs(scaleFactor)));
      const newH = Math.max(5, Math.round(dragOriginal.height * Math.abs(scaleFactor)));

      if (resizeHandle === 'br') {
        data.x = resizeAnchor.x;
        data.y = resizeAnchor.y;
        data.width = newW;
        data.height = newH;
      } else { // tl
        data.x = resizeAnchor.x - newW;
        data.y = resizeAnchor.y - newH;
        data.width = newW;
        data.height = newH;
      }

      const maxRx = Math.min(data.width, data.height) / 2;
      if (data.rx > maxRx) {
        data.rx = maxRx;
        document.getElementById('corner-radius-input').value = data.rx;
        state.activeCornerRadius = data.rx;
      }

      updateRectangleElement(data);
    } else if (resizeHandle === 'bl' || resizeHandle === 'tr') {
      const cornerX = resizeAnchor.x;
      const cornerY = resizeAnchor.y;
      const dx = pt.x - cornerX;
      const dy = pt.y - cornerY;

      const diagX = resizeHandle === 'bl' ? data.width : -data.width;
      const diagY = resizeHandle === 'bl' ? -data.height : data.height;
      const diagLen = Math.sqrt(diagX * diagX + diagY * diagY);
      if (diagLen > 0) {
        const diagUnitX = diagX / diagLen;
        const diagUnitY = diagY / diagLen;
        const proj = dx * diagUnitX + dy * diagUnitY;
        const origRx = dragOriginal.rx || 0;
        const newRx = Math.max(0, Math.min(origRx + proj, Math.min(data.width, data.height) / 2));
        data.rx = newRx;
        updateRectangleElement(data);
        document.getElementById('corner-radius-input').value = data.rx;
        state.activeCornerRadius = data.rx;
      }
    }
  }

  drawHandles(data);
}

function onResizeEnd() {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);

  hideRotationTooltip();

  if (!isResizing) return;
  isResizing = false;

  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const orig = { ...dragOriginal };
  const final = { ...data };

  if (data.type === 'line') {
    const desc = textInteractMode === 'rotate' ? 'Rotate line' : 'Resize line';
    const changed = orig.rotation !== final.rotation || orig.x1 !== final.x1 || orig.y1 !== final.y1 || orig.x2 !== final.x2 || orig.y2 !== final.y2;
    if (changed) {
      pushAction({
        description: desc,
        doFn: () => { Object.assign(data, { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2, rotation: final.rotation, points: final.points ? final.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
        undoFn: () => { Object.assign(data, { x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2, rotation: orig.rotation, points: orig.points ? orig.points.map(p => ({...p})) : undefined }); updateLineSVG(data); drawHandles(data); },
      });
    }
  } else if (data.type === 'text' && (orig.fontSize !== final.fontSize || orig.x !== final.x || orig.y !== final.y || orig.rotation !== final.rotation)) {
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate text' : 'Resize text',
      doFn: () => { data.fontSize = final.fontSize; data.x = final.x; data.y = final.y; data.rotation = final.rotation; updateTextSVG(data); drawHandles(data); },
      undoFn: () => { data.fontSize = orig.fontSize; data.x = orig.x; data.y = orig.y; data.rotation = orig.rotation; updateTextSVG(data); drawHandles(data); },
    });
  } else if (data.type === 'rectangle' && (orig.width !== final.width || orig.height !== final.height || orig.x !== final.x || orig.y !== final.y || orig.rx !== final.rx || orig.rotation !== final.rotation)) {
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate rectangle' : 'Resize rectangle',
      doFn: () => { Object.assign(data, final); updateRectangleElement(data); drawHandles(data); },
      undoFn: () => { Object.assign(data, orig); updateRectangleElement(data); drawHandles(data); },
    });
  }

  dragOriginal = null;
  resizeAnchor = null;
  origBbox = null;
}

// ── Delete ──────────────────────────────────────────────────────

export function deleteSelected() {
  if (state.selectedIds.length === 0) return;

  var ids = state.selectedIds.slice();
  var removed = [];
  for (var di = 0; di < ids.length; di++) {
    var id = ids[di];
    var el = dom.annotationLayer.querySelector('#' + CSS.escape(id));
    if (!el) continue;

    removed.push({
      data: captureElementState(id),
      parentId: el.parentNode && el.parentNode.id !== 'layer-annotation' ? el.parentNode.id : null,
      nextSiblingId: el.nextElementSibling ? el.nextElementSibling.id : null,
    });
    el.remove();
  }

  // Clean up empty groups (walk DOM instead of state.elements)
  var groupEls = dom.annotationLayer.querySelectorAll('[data-type="group"]');
  for (var gi = 0; gi < groupEls.length; gi++) {
    if (groupEls[gi].children.length === 0) {
      groupEls[gi].remove();
    }
  }

  clearSelection();

  pushAction({
    description: 'Delete ' + removed.length + ' element' + (removed.length > 1 ? 's' : ''),
    doFn: function() {
      for (var i = 0; i < removed.length; i++) {
        var existing = dom.annotationLayer.querySelector('#' + CSS.escape(removed[i].data.id));
        if (existing) existing.remove();
      }
    },
    undoFn: function() {
      for (var i = 0; i < removed.length; i++) {
        var r = removed[i];
        var data = r.data;
        if (data.type === 'line') _lineModule.addLineElement(data);
        else if (data.type === 'text') _textModule.addTextElement(data);
        else if (data.type === 'freehand') _freehandModule.addFreehandElement(data);
        else if (data.type === 'rectangle') _rectangleModule.addRectangleElement(data);
        // Restore DOM position
        var recreated = dom.annotationLayer.querySelector('#' + CSS.escape(data.id));
        if (recreated && r.parentId) {
          var parent = dom.annotationLayer.querySelector('#' + CSS.escape(r.parentId));
          var nextSib = r.nextSiblingId ? dom.annotationLayer.querySelector('#' + CSS.escape(r.nextSiblingId)) : null;
          if (parent) {
            if (nextSib) parent.insertBefore(recreated, nextSib);
            else parent.appendChild(recreated);
          }
        }
      }
    },
  });
}

// ── Duplicate ────────────────────────────────────────────────────

function nextDupPrefix() {
  var maxN = 0;
  var allElements = dom.annotationLayer.querySelectorAll('[id]');
  for (var j = 0; j < allElements.length; j++) {
    var id = allElements[j].id;
    var m = id.match(/^dup(\d+)-/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return 'dup' + (maxN + 1) + '-';
}

function nextDupSuffix(id) {
  var n = 1;
  var candidate;
  do {
    candidate = id + '-' + n;
    n++;
  } while (dom.annotationLayer.querySelector('#' + CSS.escape(candidate)));
  return candidate;
}

function renderGroupChildrenPreview() {
  var preview = document.getElementById('group-children-preview');
  if (!preview) return;
  var data = _renameTargetId ? captureElementState(_renameTargetId) : null;
  if (!data || data.type !== 'group' || !data.childIds || data.childIds.length === 0) {
    preview.style.display = 'none';
    return;
  }
  var newGroupId = document.getElementById('element-id-input').value.trim();
  if (!newGroupId) { preview.style.display = 'none'; return; }

  // Find longest common prefix between old group ID and all child IDs
  var prefix = _renameTargetId;
  for (var ci = 0; ci < data.childIds.length; ci++) {
    while (data.childIds[ci].indexOf(prefix) !== 0 && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) break;
  }

  // Extra suffix on the group ID beyond the common prefix (e.g. "-group")
  var extraSuffix = prefix.length > 0 ? _renameTargetId.slice(prefix.length) : '';
  // Derive base name to use for children (strip same extra suffix if it matches)
  var newBase = (extraSuffix && newGroupId.endsWith(extraSuffix)) ? newGroupId.slice(0, -extraSuffix.length) : newGroupId;

  preview.style.display = 'block';
  preview.innerHTML = '';

  for (var ci = 0; ci < data.childIds.length; ci++) {
    var childId = data.childIds[ci];
    var line = document.createElement('div');
    line.className = 'child-id-line';

    if (prefix.length > 0 && childId.indexOf(prefix) === 0) {
      var rest = childId.slice(prefix.length);
      var oldSpan = document.createElement('span');
      oldSpan.className = 'child-id-old';
      oldSpan.textContent = prefix;
      line.appendChild(oldSpan);

      var restSpan = document.createElement('span');
      restSpan.className = 'child-id-rest';
      restSpan.textContent = rest;
      line.appendChild(restSpan);

      var arrowSpan = document.createElement('span');
      arrowSpan.className = 'child-id-arrow';
      arrowSpan.textContent = '\u2192';
      line.appendChild(arrowSpan);

      var newSpan = document.createElement('span');
      newSpan.className = 'child-id-new';
      newSpan.textContent = newBase;
      line.appendChild(newSpan);

      var rest2Span = document.createElement('span');
      rest2Span.className = 'child-id-rest';
      rest2Span.textContent = rest;
      line.appendChild(rest2Span);
    } else {
      line.textContent = childId + ' (no match)';
    }
    preview.appendChild(line);
  }

  // Flip to right edge if dropdown overflows viewport
  preview.style.left = '';
  preview.style.right = '';
  var rect = preview.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    preview.style.left = 'auto';
    preview.style.right = '0';
  }
}

export function duplicateSelected() {
  if (state.selectedIds.length === 0) return;
  var ids = state.selectedIds.slice();

  // Check if selection represents a full group (all children of the same <g data-type="group">)
  var parentGroupEl = null;
  for (var gi = 0; gi < ids.length; gi++) {
    var el = dom.annotationLayer.querySelector('#' + CSS.escape(ids[gi]));
    if (!el) { parentGroupEl = null; break; }
    var parentG = el.parentNode && el.parentNode.closest ? el.parentNode.closest('[data-type="group"]') : null;
    if (!parentG) { parentGroupEl = null; break; }
    if (gi === 0) parentGroupEl = parentG;
    else if (parentG !== parentGroupEl) { parentGroupEl = null; break; }
  }

  if (parentGroupEl) {
    var dupPrefix = nextDupPrefix();
    var newGroupId = dupPrefix + parentGroupEl.id;
    var newChildIds = [];
    var dupes = [];

    for (var gi2 = 0; gi2 < parentGroupEl.children.length; gi2++) {
      var oldId = parentGroupEl.children[gi2].id;
      var origData = captureElementState(oldId);
      if (!origData) continue;
      var copy = { ...origData };
      var newId = dupPrefix + oldId;
      copy.id = newId;
      newChildIds.push(newId);
      if (copy.type === 'line') _lineModule.addLineElement(copy);
      else if (copy.type === 'text') _textModule.addTextElement(copy);
      else if (copy.type === 'freehand') _freehandModule.addFreehandElement(copy);
      else if (copy.type === 'rectangle') _rectangleModule.addRectangleElement(copy);
      dupes.push(copy);
    }
    if (dupes.length === 0) return;

    var g = svgEl('g', { id: newGroupId, 'data-type': 'group' });
    for (var gi3 = 0; gi3 < newChildIds.length; gi3++) {
      var childSvg = dom.annotationLayer.querySelector('#' + CSS.escape(newChildIds[gi3]));
      if (childSvg) g.appendChild(childSvg);
    }
    dom.annotationLayer.appendChild(g);

    selectElement(newGroupId, false);

    pushAction({
      description: 'Duplicate group (' + newChildIds.length + ' elements)',
      doFn: function() {
        var dg = dom.annotationLayer.querySelector('#' + CSS.escape(newGroupId));
        if (!dg) {
          dg = svgEl('g', { id: newGroupId, 'data-type': 'group' });
          dom.annotationLayer.appendChild(dg);
        }
        for (var di = 0; di < dupes.length; di++) {
          var d = dupes[di];
          if (!dom.annotationLayer.querySelector('#' + CSS.escape(d.id))) {
            if (d.type === 'line') _lineModule.addLineElement(d);
            else if (d.type === 'text') _textModule.addTextElement(d);
            else if (d.type === 'freehand') _freehandModule.addFreehandElement(d);
            else if (d.type === 'rectangle') _rectangleModule.addRectangleElement(d);
            var ds = dom.annotationLayer.querySelector('#' + CSS.escape(d.id));
            if (ds) dg.appendChild(ds);
          }
        }
      },
      undoFn: function() {
        for (var di = 0; di < dupes.length; di++) {
          var svgChild = dom.annotationLayer.querySelector('#' + CSS.escape(dupes[di].id));
          if (svgChild) svgChild.remove();
        }
        var dgEl = dom.annotationLayer.querySelector('#' + CSS.escape(newGroupId));
        if (dgEl) dgEl.remove();
      },
    });
    return;
  }

  // Fallback: duplicate individual elements
  var dupes = [];
  for (var di = 0; di < ids.length; di++) {
    var origData = captureElementState(ids[di]);
    if (!origData) continue;
    var copy = { ...origData };
    copy.id = nextDupSuffix(origData.id);
    if (origData.type === 'group') {
      // Groups as individual selection: capture children too
      // (handled by captureElementState for group type)
    }
    if (copy.type === 'line') _lineModule.addLineElement(copy);
    else if (copy.type === 'text') _textModule.addTextElement(copy);
    else if (copy.type === 'freehand') _freehandModule.addFreehandElement(copy);
    else if (copy.type === 'rectangle') _rectangleModule.addRectangleElement(copy);
    dupes.push(copy);
  }
  if (dupes.length === 0) return;
  selectElement(dupes[dupes.length - 1].id, false);
  var desc = 'Duplicate ' + dupes.length + ' element' + (dupes.length > 1 ? 's' : '');
  pushAction({
    description: desc,
    doFn: function() {
      for (var ri = 0; ri < dupes.length; ri++) {
        var d = dupes[ri];
        if (!dom.annotationLayer.querySelector('#' + CSS.escape(d.id))) {
          if (d.type === 'line') _lineModule.addLineElement(d);
          else if (d.type === 'text') _textModule.addTextElement(d);
          else if (d.type === 'freehand') _freehandModule.addFreehandElement(d);
          else if (d.type === 'rectangle') _rectangleModule.addRectangleElement(d);
        }
      }
    },
    undoFn: function() {
      for (var ri = 0; ri < dupes.length; ri++) {
        var svgChild = dom.annotationLayer.querySelector('#' + CSS.escape(dupes[ri].id));
        if (svgChild) svgChild.remove();
      }
    },
  });
}

// ── Move in Group ─────────────────────────────────────────────────

export function moveInGroup(direction) {
  if (!state.selectedId) return;
  var selData = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!selData || !selData.parentId) return;
  var groupData = state.elements.find(function(el) { return el.id === selData.parentId && el.type === 'group'; });
  if (!groupData) return;
  var idx = groupData.childIds.indexOf(state.selectedId);
  if (idx === -1) return;
  var newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= groupData.childIds.length) return;
  groupData.childIds[idx] = groupData.childIds[newIdx];
  groupData.childIds[newIdx] = state.selectedId;
  var parentG = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.id));
  if (parentG) {
    var childEl = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
    var refEl = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.childIds[idx]));
    if (childEl && refEl) {
      if (direction === -1) parentG.insertBefore(childEl, refEl);
      else parentG.insertBefore(childEl, refEl.nextSibling);
    }
  }
  updateMoveButtons();
  pushAction({
    description: 'Move ' + (direction === -1 ? 'up' : 'down') + ' in group',
    doFn: function() {
      var ci = groupData.childIds.indexOf(state.selectedId);
      if (ci === -1) return;
      var ni = ci + direction;
      if (ni < 0 || ni >= groupData.childIds.length) return;
      groupData.childIds[ci] = groupData.childIds[ni];
      groupData.childIds[ni] = state.selectedId;
      var pg = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.id));
      if (pg) {
        var ce = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
        var re = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.childIds[ci]));
        if (ce && re) {
          if (direction === -1) pg.insertBefore(ce, re);
          else pg.insertBefore(ce, re.nextSibling);
        }
      }
    },
    undoFn: function() {
      var ci = groupData.childIds.indexOf(state.selectedId);
      if (ci === -1) return;
      var revDir = direction === -1 ? 1 : -1;
      var ni = ci + revDir;
      if (ni < 0 || ni >= groupData.childIds.length) return;
      groupData.childIds[ci] = groupData.childIds[ni];
      groupData.childIds[ni] = state.selectedId;
      var pg = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.id));
      if (pg) {
        var ce = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
        var re = dom.annotationLayer.querySelector('#' + CSS.escape(groupData.childIds[ci]));
        if (ce && re) {
          if (revDir === -1) pg.insertBefore(ce, re);
          else pg.insertBefore(ce, re.nextSibling);
        }
      }
    },
  });
}

export function updateMoveButtons() {
  var upBtn = document.getElementById('btn-move-up');
  var downBtn = document.getElementById('btn-move-down');
  if (!upBtn || !downBtn) return;
  upBtn.disabled = true;
  downBtn.disabled = true;
  if (!state.selectedId || !_tempUngrouped) { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  var selData = state.elements.find(function(el) { return el.id === state.selectedId; });
  if (!selData || !selData.parentId) { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  var groupData = state.elements.find(function(el) { return el.id === selData.parentId && el.type === 'group'; });
  if (!groupData) { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  var idx = groupData.childIds.indexOf(state.selectedId);
  if (idx === -1) { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  setMoveBtnVisibility(upBtn, downBtn, true);
  if (idx < groupData.childIds.length - 1) upBtn.disabled = false;
  if (idx > 0) downBtn.disabled = false;
}

function setMoveBtnVisibility(upBtn, downBtn, visible) {
  upBtn.classList.toggle('show', visible);
  downBtn.classList.toggle('show', visible);
}

function addLineSVGAtIndex(data, _idx) {
  // Re-import to avoid circular dep issues at module level
  const { addLineElement } = _lineModule;
  addLineElement(data);
}

function addTextSVGAtIndex(data, _idx) {
  const { addTextElement } = _textModule;
  addTextElement(data);
}

function addFreehandSVGAtIndex(data, _idx) {
  const { addFreehandElement } = _freehandModule;
  addFreehandElement(data);
}

function addRectangleSVGAtIndex(data, _idx) {
  const { addRectangleElement } = _rectangleModule;
  addRectangleElement(data);
}

// We'll set these from main.js to avoid circular imports
let _lineModule = {};
let _textModule = {};
let _freehandModule = {};
let _rectangleModule = {};

export function setModuleRefs(lineMod, textMod, freehandMod, rectangleMod) {
  _lineModule = lineMod;
  _textModule = textMod;
  _freehandModule = freehandMod || {};
  _rectangleModule = rectangleMod || {};
}

// ── SVG Update Helpers ──────────────────────────────────────────

function updateLineSVG(data) {
  updateLineElement(data);
}

function updateTextSVG(data) {
  const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!textEl) return;
  textEl.setAttribute('x', data.x);
  textEl.setAttribute('y', data.y);
  textEl.setAttribute('font-size', data.fontSize);
  textEl.setAttribute('fill', data.fill);
  textEl.setAttribute('stroke', data.stroke || 'none');
  textEl.setAttribute('stroke-width', data.strokeWidth || 0);
  textEl.textContent = data.content;
  
  if (data.rotation) {
    try {
      const bbox = textEl.getBBox();
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      textEl.setAttribute('transform', `rotate(${data.rotation}, ${cx}, ${cy})`);
    } catch {
      // ignore
    }
  } else {
    textEl.removeAttribute('transform');
  }
}

// ── Rotation Tooltip ────────────────────────────────────────────

function showRotationTooltip(e, angle) {
  if (!rotationTooltip) {
    rotationTooltip = document.createElement('div');
    rotationTooltip.style.cssText = 'position:fixed;background:rgba(0,0,0,0.75);color:#fff;padding:2px 7px;border-radius:3px;font-size:12px;pointer-events:none;z-index:100;font-family:monospace;';
    document.body.appendChild(rotationTooltip);
  }
  rotationTooltip.textContent = `${angle}°`;
  rotationTooltip.style.left = (e.clientX + 14) + 'px';
  rotationTooltip.style.top = (e.clientY - 26) + 'px';
}

function hideRotationTooltip() {
  if (rotationTooltip) {
    rotationTooltip.remove();
    rotationTooltip = null;
  }
}

// ── Apply property changes to selected ──────────────────────────

function applyColorToSelected(color) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data) return;

  const oldColor = data.type === 'text' ? data.stroke : data.stroke;
  if (oldColor === color) return;

  if (data.type === 'line') {
    data.stroke = color;
    updateLineSVG(data);
  } else if (data.type === 'text') {
    data.stroke = color;
    updateTextSVG(data);
  } else if (data.type === 'freehand') {
    data.stroke = color;
    updateFreehandElement(data);
  } else if (data.type === 'rectangle') {
    data.stroke = color;
    updateRectangleElement(data);
  }

  pushAction({
    description: 'Change color',
    doFn: () => {
      if (data.type === 'line') { data.stroke = color; updateLineSVG(data); }
      else if (data.type === 'text') { data.stroke = color; updateTextSVG(data); }
      else if (data.type === 'freehand') { data.stroke = color; updateFreehandElement(data); }
      else if (data.type === 'rectangle') { data.stroke = color; updateRectangleElement(data); }
    },
    undoFn: () => {
      if (data.type === 'line') { data.stroke = oldColor; updateLineSVG(data); }
      else if (data.type === 'text') { data.stroke = oldColor; updateTextSVG(data); }
      else if (data.type === 'freehand') { data.stroke = oldColor; updateFreehandElement(data); }
      else if (data.type === 'rectangle') { data.stroke = oldColor; updateRectangleElement(data); }
    },
  });
}

function applyThicknessToSelected(thickness) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || (data.type !== 'line' && data.type !== 'freehand' && data.type !== 'rectangle' && data.type !== 'text')) return;

  const oldThickness = data.strokeWidth;
  if (oldThickness === thickness) return;

  data.strokeWidth = thickness;
  if (data.type === 'line') {
    updateLineSVG(data);
  } else if (data.type === 'rectangle') {
    updateRectangleElement(data);
  } else if (data.type === 'text') {
    updateTextSVG(data);
  } else {
    updateFreehandElement(data);
  }

  pushAction({
    description: 'Change thickness',
    doFn: () => { data.strokeWidth = thickness; if (data.type === 'line') updateLineSVG(data); else if (data.type === 'rectangle') updateRectangleElement(data); else if (data.type === 'text') updateTextSVG(data); else updateFreehandElement(data); },
    undoFn: () => { data.strokeWidth = oldThickness; if (data.type === 'line') updateLineSVG(data); else if (data.type === 'rectangle') updateRectangleElement(data); else if (data.type === 'text') updateTextSVG(data); else updateFreehandElement(data); },
  });
}

function applyLineMarkerSizeToSelected(size) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'line') return;

  const newSize = normalizeLineMarkerSize(size);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldSize = data[sizeKey];
    const normOld = normalizeLineMarkerSize(oldSize ?? data.lineMarkerSize);
    if (normOld === newSize) return;

    const oldStartSize = data.startDecorationSize;
    const oldEndSize = data.endDecorationSize;

    data[sizeKey] = newSize;
    updateLineSVG(data);

    pushAction({
      description: 'Change line end marker size',
      doFn: () => { data[sizeKey] = newSize; updateLineSVG(data); },
      undoFn: () => {
        data.startDecorationSize = oldStartSize;
        data.endDecorationSize = oldEndSize;
        updateLineSVG(data);
      },
    });
    return;
  }

  const oldSize = normalizeLineMarkerSize(data.lineMarkerSize);
  const oldStartSize = data.startDecorationSize;
  const oldEndSize = data.endDecorationSize;
  if (oldSize === newSize) return;

  data.lineMarkerSize = newSize;
  data.startDecorationSize = newSize;
  data.endDecorationSize = newSize;
  updateLineSVG(data);

  pushAction({
    description: 'Change line marker size',
    doFn: () => {
      data.lineMarkerSize = newSize;
      data.startDecorationSize = newSize;
      data.endDecorationSize = newSize;
      updateLineSVG(data);
    },
    undoFn: () => {
      data.lineMarkerSize = oldSize;
      data.startDecorationSize = oldStartSize;
      data.endDecorationSize = oldEndSize;
      updateLineSVG(data);
    },
  });
}

function applyLineStyleToSelected(style) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'line') return;

  const newStyle = normalizeLineStyle(style);
  const newDecor = styleToDecoration(newStyle);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const decorKey = selectedLineEndpoint === 'start' ? 'startDecoration' : 'endDecoration';
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldDecor = normalizeLineDecoration(data[decorKey]);
    const oldSize = data[sizeKey];
    if (oldDecor === newDecor) return;

    const oldStartDecor = data.startDecoration;
    const oldEndDecor = data.endDecoration;
    const oldStartSize = data.startDecorationSize;
    const oldEndSize = data.endDecorationSize;

    data[decorKey] = newDecor;
    data[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
    updateLineSVG(data);

    pushAction({
      description: 'Change line end decoration',
      doFn: () => {
        data[decorKey] = newDecor;
        data[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
        updateLineSVG(data);
      },
      undoFn: () => {
        data.startDecoration = oldStartDecor;
        data.endDecoration = oldEndDecor;
        data.startDecorationSize = oldStartSize;
        data.endDecorationSize = oldEndSize;
        updateLineSVG(data);
      },
    });
    return;
  }

  const oldStyle = data.lineStyle;
  const oldStartDecor = data.startDecoration;
  const oldEndDecor = data.endDecoration;
  const oldStartDecorSize = data.startDecorationSize;
  const oldEndDecorSize = data.endDecorationSize;

  const targetDecor = styleToDecoration(newStyle);
  const startHas = data.startDecoration && data.startDecoration !== 'none';

  if (targetDecor === 'none') {
    data.lineStyle = 'normal';
    data.startDecoration = 'none';
    data.endDecoration = 'none';
  } else if (!startHas && !endHas) {
    const decors = legacyStyleToDecorations(newStyle, state.activeLineMarkerSize);
    data.lineStyle = newStyle;
    data.startDecoration = decors.startDecoration;
    data.endDecoration = decors.endDecoration;
    data.startDecorationSize = decors.startDecorationSize;
    data.endDecorationSize = decors.endDecorationSize;
  } else {
    data.lineStyle = newStyle;
    if (startHas) {
      data.startDecoration = targetDecor;
      data.startDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
    if (endHas) {
      data.endDecoration = targetDecor;
      data.endDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
  }
  updateLineSVG(data);

  pushAction({
    description: 'Change line style',
    doFn: () => {
      data.lineStyle = newStyle;
      if (targetDecor === 'none') {
        data.startDecoration = 'none';
        data.endDecoration = 'none';
      } else if (!startHas && !endHas) {
        const d = legacyStyleToDecorations(newStyle, state.activeLineMarkerSize);
        data.startDecoration = d.startDecoration;
        data.endDecoration = d.endDecoration;
        data.startDecorationSize = d.startDecorationSize;
        data.endDecorationSize = d.endDecorationSize;
      } else {
        if (startHas) { data.startDecoration = targetDecor; data.startDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize); }
        if (endHas) { data.endDecoration = targetDecor; data.endDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize); }
      }
      updateLineSVG(data);
    },
    undoFn: () => {
      data.lineStyle = oldStyle;
      data.startDecoration = oldStartDecor;
      data.endDecoration = oldEndDecor;
      data.startDecorationSize = oldStartDecorSize;
      data.endDecorationSize = oldEndDecorSize;
      updateLineSVG(data);
    },
  });
}

function applyFontSizeToSelected(fontSize) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'text') return;

  const oldSize = data.fontSize;
  if (oldSize === fontSize) return;

  data.fontSize = fontSize;
  updateTextSVG(data);
  drawHandles(data);

  pushAction({
    description: 'Change font size',
    doFn: () => { data.fontSize = fontSize; updateTextSVG(data); },
    undoFn: () => { data.fontSize = oldSize; updateTextSVG(data); },
  });
}

function applyCornerRadiusToSelected(radius) {
  if (!state.selectedId) return;
  const data = state.elements.find(el => el.id === state.selectedId);
  if (!data || data.type !== 'rectangle') return;

  const oldRadius = data.rx || 0;
  if (oldRadius === radius) return;

  const clampedRadius = Math.min(radius, Math.min(data.width, data.height) / 2);
  data.rx = clampedRadius;
  updateRectangleElement(data);
  drawHandles(data);

  pushAction({
    description: 'Change corner radius',
    doFn: () => { data.rx = clampedRadius; updateRectangleElement(data); drawHandles(data); },
    undoFn: () => { data.rx = oldRadius; updateRectangleElement(data); drawHandles(data); },
  });
}

/**
 * Refresh handles for the currently selected element (e.g., after undo/redo).
 */
export function refreshSelection() {
  if (!state.selectedId) {
    clearSelection();
    return;
  }
  var el = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
  if (!el) {
    clearSelection();
    return;
  }
  var type = el.dataset.type;
  if (type === 'line' && lineEditMode === 'change-end') {
    syncLineToolbarFromSelection(el);
  } else if (type === 'line') {
    setActiveLineStyle(normalizeLineStyle(el.dataset.lineStyle));
  } else if (type === 'freehand') {
    syncFreehandEpsilonSlider(parseFloat(el.getAttribute('data-epsilon') || 0));
  } else if (type === 'rectangle') {
    var fillRect = el.querySelector('.rect-fill');
    var rx = fillRect ? parseFloat(fillRect.getAttribute('rx') || 0) : 0;
    document.getElementById('corner-radius-input').value = rx;
    state.activeCornerRadius = rx;
  }
  drawHandles(el);
  updateGroupButton();
  updateUngroupButton();
  updateMoveButtons();
}
