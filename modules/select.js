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
import { switchTool } from './tools.js';

let isDragging = false;
let isResizing = false;
let dragStart = null;
let dragOriginal = null;
let dragOriginals = null;
let resizeHandle = null; // 'tl'|'tr'|'bl'|'br' for corner handles
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
let _tempGroupParentId = null;
let selectedLineEndpoint = 'end'; // 'start' | 'end'
let rotationTooltip = null;
let _lastClickTime = 0;
let _lastClickId = null;
let _renameTargetId = null;
let _applyingRotation = false;

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
    const id = state.selectedId;
    const oldState = captureElementState(id);
    if (!oldState) return;
    const color = e.detail.color;
    const oldFill = oldState.fill;
    if (oldFill === color) return;
    if (oldState.type === 'text') {
      const newState = { ...oldState, fill: color };
      updateTextSVG(newState);
      drawHandles();
      pushAction({
        description: 'Change text fill color',
        doFn: () => { updateTextSVG(newState); drawHandles(); },
        undoFn: () => { updateTextSVG(oldState); drawHandles(); },
      });
    } else if (oldState.type === 'rectangle') {
      const newFill = color === 'transparent' ? 'none' : color;
      const newState = { ...oldState, fill: newFill };
      updateRectangleElement(newState);
      drawHandles();
      pushAction({
        description: 'Change rectangle fill color',
        doFn: () => { updateRectangleElement(newState); drawHandles(); },
        undoFn: () => { updateRectangleElement(oldState); drawHandles(); },
      });
    } else if (oldState.type === 'line' && oldState.closed) {
      const newFill = color === 'transparent' ? 'none' : color;
      const newState = { ...oldState, fill: newFill };
      updateLineSVG(newState);
      drawHandles();
      pushAction({
        description: 'Change polygon fill color',
        doFn: () => { updateLineSVG(newState); drawHandles(); },
        undoFn: () => { updateLineSVG(oldState); drawHandles(); },
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
      var targetEl = document.getElementById(targetId);
      if (!targetEl) return;
      if (document.getElementById(sanitized) && sanitized !== targetId) {
        idInput.value = targetId;
        return;
      }
      var oldId = targetId;
      var type = targetEl.dataset.type;

      // Find longest common prefix between old group ID and child IDs
      var prefix = oldId;
      if (type === 'group') {
        for (var ci = 0; ci < targetEl.children.length; ci++) {
          var childId = targetEl.children[ci].id;
          while (childId.indexOf(prefix) !== 0 && prefix.length > 0) {
            prefix = prefix.slice(0, -1);
          }
          if (prefix.length === 0) break;
        }
      }

      targetEl.id = sanitized;

      if (type === 'group') {
        var extraSuffix = prefix.length > 0 ? oldId.slice(prefix.length) : '';
        var newBase = (extraSuffix && sanitized.endsWith(extraSuffix)) ? sanitized.slice(0, -extraSuffix.length) : sanitized;

        for (var ci = 0; ci < targetEl.children.length; ci++) {
          var oldChildId = targetEl.children[ci].id;
          if (prefix.length > 0 && oldChildId.indexOf(prefix) === 0) {
            var newChildId = newBase + oldChildId.slice(prefix.length);
            if (!document.getElementById(newChildId) || newChildId === oldChildId) {
              targetEl.children[ci].id = newChildId;
            }
          }
        }
      }
      // For non-group elements inside a group, no parent group childIds array to update
      if (state.selectedId === oldId) {
        state.selectedId = sanitized;
      }
      for (var si = 0; si < state.selectedIds.length; si++) {
        if (state.selectedIds[si] === oldId) {
          state.selectedIds[si] = sanitized;
        }
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

  // Rotation input
  var rotationInput = document.getElementById('rotation-input');
  if (rotationInput) {
    rotationInput.addEventListener('input', function () {
      if (_applyingRotation) return;
      var raw = parseFloat(this.value);
      if (isNaN(raw)) return;
      var displayVal = ((raw % 360) + 360) % 360;
      if (displayVal === 360) displayVal = 0;
      var storedVal = (360 - displayVal) % 360;
      if (storedVal === 360) storedVal = 0;
      this.value = displayVal;
      applyRotationToSelected(storedVal);
    });
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
  if (mode === 'change-end') {
    selectedLineEndpoint = null;
  }
  refreshSelection();
  if (state.selectedId) {
    var selData = captureElementState(state.selectedId);
    if (selData) {
      document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: selData.id, data: selData } }));
    }
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
      textInteractMode = textInteractMode === 'resize' ? 'rotate' : 'resize';
      var _rig = document.getElementById('rotation-input-group');
      if (_rig) _rig.hidden = textInteractMode !== 'rotate';
      refreshSelection();
      return;
    }

    if (state.selectedId) {
      var selEl = dom.annotationLayer.querySelector('#' + CSS.escape(state.selectedId));
      if (selEl && selEl.dataset.type === 'line' && lineEditMode === 'change-end') {
        if (handleEl.dataset.handle === 'p1' || handleEl.dataset.handle === 'p2') {
          setSelectedLineEndpoint(handleEl.dataset.handle === 'p1' ? 'start' : 'end');
          refreshSelection();
          return;
        }
      }
    }

    // Double-click on group move handle → step into individual child
    if (handleEl.dataset.handle === 'move' && isGroupSelection()) {
      var now = Date.now();
      var isDblClick = e.detail >= 2 || (now - _lastClickTime < 600);
      _lastClickTime = now;
      if (isDblClick) {
        var els = document.elementsFromPoint(e.clientX, e.clientY);
        var actualAnnot = null;
        for (var ei = 0; ei < els.length; ei++) {
          var candidate = findActualAnnotation(els[ei]);
          if (candidate) { actualAnnot = candidate; break; }
        }
        if (actualAnnot) {
          _tempUngrouped = true;
          _tempGroupParentId = actualAnnot.parentElement ? actualAnnot.parentElement.id : null;
          selectElement(actualAnnot.id, false);
          return;
        }
        // No annotation found at click point → stay in group mode
      }
      // Single click on move handle → move the whole group
      startResize(handleEl, pt, e);
      return;
    }

    startResize(handleEl, pt, e);
    return;
  }

  // Check if clicking an annotation
  const annotGroup = findAnnotationParent(target);
  if (annotGroup) {
    e.preventDefault();
    const id = annotGroup.id;

    const annotType = annotGroup.dataset ? annotGroup.dataset.type : null;

    // Double-click on text → edit (defer to next frame so mousedown
    // processing completes and doesn't steal focus from the textarea)
    const now = Date.now();
    const isDblClick = (e.detail >= 2) || (id === _lastClickId && now - _lastClickTime < 600);
    _lastClickTime = now;
    _lastClickId = id;
    if (isDblClick) {
      if (annotType === 'group') {
        var actualAnnot = findActualAnnotation(target);
        if (actualAnnot) {
          _tempUngrouped = true;
          _tempGroupParentId = id;
          selectElement(actualAnnot.id, false);
          return;
        }
      }
      if (annotType === 'text') {
        switchTool('text');
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
      drawHandles();
    } else {
      selectElement(id, false);
    }

    if (annotType === 'line' && lineEditMode === 'change-end') {
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
    var data = captureElementState(sid);
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

  drawHandles();
}

function findAnnotationParent(target) {
  var el = target;
  while (el && el !== dom.svg) {
    if (el.dataset && (el.dataset.type === 'line' || el.dataset.type === 'freehand' || el.dataset.type === 'rectangle')) {
      var groupParent = el.parentElement;
      if (groupParent && groupParent.dataset && groupParent.dataset.type === 'group') {
        if (_tempUngrouped && _tempGroupParentId && groupParent.id === _tempGroupParentId) return el;
        return groupParent;
      }
      return el;
    }
    if (el.dataset && el.dataset.type === 'text') {
      var gp = el.parentElement;
      if (gp && gp.dataset && gp.dataset.type === 'group') {
        if (_tempUngrouped && _tempGroupParentId && gp.id === _tempGroupParentId) return el;
        return gp;
      }
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
  _tempGroupParentId = null;
}

function getGroupChildIds(id) {
  var el = document.getElementById(id);
  if (!el || el.dataset.type !== 'group') return null;
  var ids = [];
  for (var ci = 0; ci < el.children.length; ci++) {
    ids.push(el.children[ci].id);
  }
  return ids;
}

function hasParentGroup(id) {
  var el = document.getElementById(id);
  if (!el) return false;
  return el.parentElement && el.parentElement.dataset.type === 'group';
}

export function selectElement(id, addToSelection) {
  var groupChildIds = getGroupChildIds(id);
  if (groupChildIds) {
    _tempUngrouped = false;
    _tempGroupParentId = null;
    if (addToSelection) {
      var allSelected = true;
      for (var gg = 0; gg < groupChildIds.length; gg++) {
        if (state.selectedIds.indexOf(groupChildIds[gg]) === -1) {
          allSelected = false;
          break;
        }
      }
      if (allSelected) {
        for (var gg2 = 0; gg2 < groupChildIds.length; gg2++) {
          var idx = state.selectedIds.indexOf(groupChildIds[gg2]);
          if (idx !== -1) state.selectedIds.splice(idx, 1);
        }
        if (state.selectedIds.length === 0) { clearSelection(); return; }
        state.selectedId = state.selectedIds[state.selectedIds.length - 1];
        drawHandles();
        document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
        document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: state.selectedId, data: captureElementState(state.selectedId) } }));
        return;
      }
      for (var gg3 = 0; gg3 < groupChildIds.length; gg3++) {
        if (state.selectedIds.indexOf(groupChildIds[gg3]) === -1) {
          state.selectedIds.push(groupChildIds[gg3]);
        }
      }
    } else {
      clearSelection();
      state.selectedIds = groupChildIds.slice();
    }
    state.selectedId = groupChildIds[groupChildIds.length - 1];
    drawHandles();
    document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
    document.getElementById('element-id-input').value = id;
    _renameTargetId = id;
    renderGroupChildrenPreview();
    var groupEl = document.getElementById(id);
    document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id, data: { id, type: 'group', childIds: groupChildIds } } }));
    var groupBtn = document.getElementById('btn-group');
    if (groupBtn) groupBtn.disabled = true;
    updateUngroupButton();
    updateMoveButtons();
    return;
  }

  if (!addToSelection) {
    var _keepUngroup = _tempUngrouped && hasParentGroup(id);
    clearSelection();
    _tempUngrouped = _keepUngroup;
    _tempGroupParentId = _keepUngroup ? document.getElementById(id).parentElement.id : null;
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
      var remainingData = captureElementState(state.selectedId);
      if (remainingData) {
        drawHandles();
        document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
        var inp = document.getElementById('element-id-input');
        if (inp) { inp.value = remainingData.id; _renameTargetId = remainingData.id; renderGroupChildrenPreview(); }
        document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: remainingData.id, data: remainingData } }));
      }
      return;
    }
    state.selectedIds.push(id);
  } else {
    state.selectedIds = [id];
  }

  const data = captureElementState(id);
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

  drawHandles();
  document.getElementById('btn-delete').disabled = false; document.getElementById('btn-duplicate').disabled = false;
  refreshPalette();

  // Sync element ID display
  var idInput = document.getElementById('element-id-input');
  if (idInput) { idInput.value = data.id; _renameTargetId = data.id; }
  var rotInput = document.getElementById('rotation-input');
  if (rotInput) {
    rotInput.value = (360 - (data.rotation || 0)) % 360;
    rotInput.disabled = data.type === 'freehand';
  }
  var _rig = document.getElementById('rotation-input-group');
  if (_rig) _rig.hidden = textInteractMode !== 'rotate';
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
    var el = document.getElementById(state.selectedIds[gi]);
    if (el && el.parentElement && el.parentElement.dataset.type === 'group') { btn.disabled = true; return; }
  }
  btn.disabled = false;
}

export function updateUngroupButton() {
  var btn = document.getElementById('btn-ungroup');
  if (!btn) return;
  if (state.selectedIds.length < 2) { btn.disabled = true; return; }
  var pid = null;
  for (var ui = 0; ui < state.selectedIds.length; ui++) {
    var el = document.getElementById(state.selectedIds[ui]);
    if (!el || !el.parentElement || el.parentElement.dataset.type !== 'group') { btn.disabled = true; return; }
    if (ui === 0) pid = el.parentElement.id;
    else if (el.parentElement.id !== pid) { btn.disabled = true; return; }
  }
  if (!pid) { btn.disabled = true; return; }
  var parentG = document.getElementById(pid);
  if (!parentG || parentG.dataset.type !== 'group') { btn.disabled = true; return; }
  if (parentG.children.length !== state.selectedIds.length) { btn.disabled = true; return; }
  btn.disabled = false;
}

export function cycleGroupSelection(direction) {
  if (!state.selectedId) return;
  var selEl = document.getElementById(state.selectedId);
  if (!selEl || !selEl.parentElement || selEl.parentElement.dataset.type !== 'group') return;
  var parentG = selEl.parentElement;
  var childIds = [];
  for (var ci = 0; ci < parentG.children.length; ci++) {
    childIds.push(parentG.children[ci].id);
  }
  if (!childIds.length) return;
  var idx = childIds.indexOf(state.selectedId);
  if (idx === -1) return;
  var newIdx = (idx + direction + childIds.length) % childIds.length;
  selectElement(childIds[newIdx], false);
}

export function clearSelection() {
  _tempUngrouped = false;
  _tempGroupParentId = null;
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
  var rotInput = document.getElementById('rotation-input');
  if (rotInput) { rotInput.value = '0'; rotInput.disabled = false; }
  var _rig = document.getElementById('rotation-input-group');
  if (_rig) _rig.hidden = true;
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

  if (isGroupSelection()) {
    var combinedBbox = getCombinedBBox();
    drawGroupHandles(combinedBbox);
    return;
  }

  for (var _i = 0; _i < state.selectedIds.length; _i++) {
    var _sid = state.selectedIds[_i];
    var svgEl = dom.annotationLayer.querySelector('#' + CSS.escape(_sid));
    if (!svgEl) continue;

    var type = svgEl.dataset.type;
    if (type === 'line') {
      var rotAttr = svgEl.getAttribute('transform');
      var rot = parseFloat(rotAttr ? rotAttr.match(/rotate\(([^,)]+)/)[1] : 0);
      drawLineHandles({ id: _sid, rotation: rot || 0 });
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
  const el = dom.annotationLayer.querySelector(`#${CSS.escape(data.id)}`);
  if (!el) return;

  const lineEl = el.querySelector('.annotation-line');
  if (!lineEl) return;

  let bbox;
  try { bbox = lineEl.getBBox(); } catch { return; }

  const sw = parseFloat(lineEl.getAttribute('stroke-width')) || 1;
  const hsw = sw / 2;
  const bx = bbox.x - hsw, by = bbox.y - hsw, bw = bbox.width + sw, bh = bbox.height + sw;
  const cx = bx + bw / 2, cy = by + bh / 2;
  const r = getHandleRadius();
  const hw = r * 2, hh = r * 2;
  const isRotate = textInteractMode === 'rotate';

  const handleGroup = svgEl('g', {
    transform: `rotate(${data.rotation || 0}, ${cx}, ${cy})`
  });

  handleGroup.appendChild(svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'selection-box',
  }));

  handleGroup.appendChild(svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'handle',
    'data-handle': 'move',
    style: 'fill: transparent; cursor: move;',
  }));

  const corners = [
    { handle: 'tl', x: bx,            y: by,            cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: bx + bw - hw,  y: by,            cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'bl', x: bx,            y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'br', x: bx + bw - hw,  y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (const c of corners) {
    handleGroup.appendChild(svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: `cursor: ${c.cursor}`,
    }));
  }

  const viewBox = dom.svg.viewBox.baseVal;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox && svgRect.width ? viewBox.width / svgRect.width : 1;
  const iconScreenPx = 32;
  const iconSVGSize = iconScreenPx * scale;
  const iconScale = iconSVGSize / 24;
  const actualSize = iconSVGSize;

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
  const viewBox = dom.svg.viewBox.baseVal;
  const svgRect = dom.svg.getBoundingClientRect();
  const scale = viewBox && svgRect.width ? viewBox.width / svgRect.width : 1;
  const iconScreenPx = 32;
  const iconSVGSize = iconScreenPx * scale;
  const iconScale = iconSVGSize / 24;
  const actualSize = iconSVGSize;

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

  const iconScreenPx = 32;
  const iconSVGSize = iconScreenPx * scale;
  const iconScale = iconSVGSize / 24;
  const actualSize = iconSVGSize;

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
  var data = captureElementState(id);
  if (!data) return;

  // Combined bounding box of all selected elements
  var ids = state.selectedIds.length ? state.selectedIds : [id];
  var bbox = null;
  for (var si = 0; si < ids.length; si++) {
    var el = captureElementState(ids[si]);
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
    return captureElementState(sid);
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
    var el = { ...orig };
    if (orig.points) el.points = orig.points.map(function(p) { return { x: p.x, y: p.y }; });
    if (orig.rawPoints) el.rawPoints = orig.rawPoints.map(function(p) { return { x: p.x, y: p.y }; });

    if (el.type === 'line') {
      if (el.points) {
        el.points = el.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
        el.x1 = el.points[0].x;
        el.y1 = el.points[0].y;
        el.x2 = el.points[el.points.length - 1].x;
        el.y2 = el.points[el.points.length - 1].y;
      } else {
        el.x1 = el.x1 + dx;
        el.y1 = el.y1 + dy;
        el.x2 = el.x2 + dx;
        el.y2 = el.y2 + dy;
      }
      updateLineSVG(el);
    } else if (el.type === 'text') {
      el.x = el.x + dx;
      el.y = el.y + dy;
      updateTextSVG(el);
    } else if (el.type === 'freehand') {
      el.points = el.points.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      if (el.rawPoints) {
        el.rawPoints = el.rawPoints.map(function(p) { return { x: p.x + dx, y: p.y + dy }; });
      }
      updateFreehandElement(el);
    } else if (el.type === 'rectangle') {
      el.x = el.x + dx;
      el.y = el.y + dy;
      updateRectangleElement(el);
    }
  }

  drawHandles();
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);

  if (!isDragging) return;
  isDragging = false;

  var primaryFinal = captureElementState(state.selectedId);
  if (!primaryFinal) { dragOriginal = null; dragOriginals = null; return; }

  // Single-element special behavior: long-press text edit
  if (dragOriginals.length === 1) {
    const orig = { ...dragOriginal };
    const final = { ...primaryFinal };

    if (primaryFinal.type === 'text' && dragStart && dragStart._time) {
      const elapsed = Date.now() - dragStart._time;
      if (elapsed >= 400 && orig.x === final.x && orig.y === final.y) {
        dragOriginal = null; dragOriginals = null;
        switchTool('text');
        setTimeout(function() { startEditing(state.selectedId); }, 0);
        return;
      }
    }


  }

  // Build combined action for all moved elements
  var snapshots = [];
  var moved = false;
  for (var i = 0; i < dragOriginals.length; i++) {
    var orig = dragOriginals[i];
    var final = captureElementState(orig.id);
    if (!final) continue;
    var dx = final.x != null ? final.x - orig.x : 0;
    var dy = final.y != null ? final.y - orig.y : 0;
    if (final.type === 'line') {
      dx = final.x1 - orig.x1;
      dy = final.y1 - orig.y1;
    }
    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) moved = true;
    snapshots.push({ id: orig.id, orig: { x: orig.x, y: orig.y, x1: orig.x1, y1: orig.y1, x2: orig.x2, y2: orig.y2, points: orig.points ? orig.points.map(function(p) { return { x: p.x, y: p.y }; }) : null, rawPoints: orig.rawPoints ? orig.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }) : null }, final: null });
    var snap = snapshots[snapshots.length - 1];
    if (final.type === 'line') {
      snap.final = { x1: final.x1, y1: final.y1, x2: final.x2, y2: final.y2, points: final.points ? final.points.map(function(p) { return { x: p.x, y: p.y }; }) : null };
    } else if (final.type === 'text') {
      snap.final = { x: final.x, y: final.y };
    } else if (final.type === 'freehand') {
      snap.final = { points: final.points.map(function(p) { return { x: p.x, y: p.y }; }), rawPoints: final.rawPoints ? final.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }) : null };
    } else if (final.type === 'rectangle') {
      snap.final = { x: final.x, y: final.y };
    }
  }

  if (moved) {
    pushAction({
      description: 'Move ' + snapshots.length + ' element' + (snapshots.length > 1 ? 's' : ''),
      doFn: function() {
        for (var j = 0; j < snapshots.length; j++) {
          var s = snapshots[j];
          var data = captureElementState(s.id);
          if (!data) continue;
          if (data.type === 'line') {
            data.x1 = s.final.x1; data.y1 = s.final.y1; data.x2 = s.final.x2; data.y2 = s.final.y2;
            if (s.final.points) data.points = s.final.points.map(function(p) { return { x: p.x, y: p.y }; });
            updateLineSVG(data);
          } else if (data.type === 'text') { data.x = s.final.x; data.y = s.final.y; updateTextSVG(data); }
          else if (data.type === 'freehand') { data.points = s.final.points.map(function(p) { return { x: p.x, y: p.y }; }); if (s.final.rawPoints) data.rawPoints = s.final.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }); updateFreehandElement(data); }
          else if (data.type === 'rectangle') { data.x = s.final.x; data.y = s.final.y; updateRectangleElement(data); }
        }
        drawHandles();
      },
      undoFn: function() {
        for (var j = 0; j < snapshots.length; j++) {
          var s = snapshots[j];
          var data = captureElementState(s.id);
          if (!data) continue;
          if (data.type === 'line') {
            data.x1 = s.orig.x1; data.y1 = s.orig.y1; data.x2 = s.orig.x2; data.y2 = s.orig.y2;
            if (s.orig.points) data.points = s.orig.points.map(function(p) { return { x: p.x, y: p.y }; });
            updateLineSVG(data);
          } else if (data.type === 'text') { data.x = s.orig.x; data.y = s.orig.y; updateTextSVG(data); }
          else if (data.type === 'freehand') { data.points = s.orig.points.map(function(p) { return { x: p.x, y: p.y }; }); if (s.orig.rawPoints) data.rawPoints = s.orig.rawPoints.map(function(p) { return { x: p.x, y: p.y }; }); updateFreehandElement(data); }
          else if (data.type === 'rectangle') { data.x = s.orig.x; data.y = s.orig.y; updateRectangleElement(data); }
        }
        drawHandles();
      },
    });
  }

  dragOriginal = null;
  dragOriginals = null;
}

// ── Resize ──────────────────────────────────────────────────────

let dragCurrent = null;
let dragGroupOriginals = null; // array of original states for group members during resize

function isGroupSelection() {
  if (state.selectedIds.length < 2) return false;
  if (_tempUngrouped) return false;
  var groupEl = null;
  for (var i = 0; i < state.selectedIds.length; i++) {
    var el = document.getElementById(state.selectedIds[i]);
    if (!el) return false;
    var parent = el.parentElement;
    if (!parent || parent.dataset.type !== 'group') return false;
    if (i === 0) groupEl = parent;
    else if (parent !== groupEl) return false;
  }
  return groupEl !== null && groupEl.children.length === state.selectedIds.length;
}

function getCombinedBBox() {
  var bbox = null;
  for (var i = 0; i < state.selectedIds.length; i++) {
    var data = captureElementState(state.selectedIds[i]);
    if (!data) continue;
    var eb = getBBoxFromData(data);
    if (!bbox) bbox = eb;
    else {
      var x1 = Math.min(bbox.x, eb.x);
      var y1 = Math.min(bbox.y, eb.y);
      var x2 = Math.max(bbox.x + bbox.width, eb.x + eb.width);
      var y2 = Math.max(bbox.y + bbox.height, eb.y + eb.height);
      bbox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }
  return bbox || { x: 0, y: 0, width: 0, height: 0 };
}

function drawGroupHandles(bbox) {
  var bx = bbox.x, by = bbox.y, bw = bbox.width, bh = bbox.height;
  var cx = bx + bw / 2, cy = by + bh / 2;
  var r = getHandleRadius();
  var hw = r * 2, hh = r * 2;
  var isRotate = textInteractMode === 'rotate';

  var handleGroup = svgEl('g', {});

  handleGroup.appendChild(svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'selection-box',
  }));

  handleGroup.appendChild(svgEl('rect', {
    x: bx, y: by, width: bw, height: bh,
    class: 'handle',
    'data-handle': 'move',
    style: 'fill: transparent; cursor: move;',
  }));

  var corners = [
    { handle: 'tl', x: bx,            y: by,            cursor: isRotate ? 'grab' : 'nwse-resize' },
    { handle: 'tr', x: bx + bw - hw,  y: by,            cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'bl', x: bx,            y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nesw-resize' },
    { handle: 'br', x: bx + bw - hw,  y: by + bh - hh,  cursor: isRotate ? 'grab' : 'nwse-resize' },
  ];

  for (var ci = 0; ci < corners.length; ci++) {
    var c = corners[ci];
    handleGroup.appendChild(svgEl('rect', {
      x: c.x, y: c.y, width: hw, height: hh,
      class: 'handle handle-resize-corner',
      'data-handle': c.handle,
      style: 'cursor: ' + c.cursor,
    }));
  }

  var viewBox = dom.svg.viewBox.baseVal;
  var svgRect = dom.svg.getBoundingClientRect();
  var scale = viewBox && svgRect.width ? viewBox.width / svgRect.width : 1;
  var iconScreenPx = 32;
  var iconSVGSize = iconScreenPx * scale;
  var iconScale = iconSVGSize / 24;
  var actualSize = iconSVGSize;

  var iconG = svgEl('g', {
    class: 'handle handle-icon',
    'data-handle': 'mode-toggle',
    transform: 'translate(' + (cx - actualSize / 2) + ', ' + (cy - actualSize / 2) + ') scale(' + iconScale + ')',
  });

  iconG.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 12, fill: '#000' }));

  var movePath = 'M12 2L8 6h3v5H6V8L2 12l4 4v-3h5v5H8l4 4 4-4h-3v-5h5v3l4-4-4-4v3h-5V6h3z';
  var rotatePath = 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  iconG.appendChild(svgEl('path', {
    d: isRotate ? rotatePath : movePath,
    fill: '#fff',
  }));

  handleGroup.appendChild(iconG);
  dom.handleLayer.appendChild(handleGroup);
}

function startResize(handleEl, startPt, e) {
  e.preventDefault();
  const handleType = handleEl.dataset.handle;

  // Group selection resize/rotation
  if (isGroupSelection()) {
    if (handleType === 'move') {
      startDrag(state.selectedIds[0], startPt);
      return;
    }
    isResizing = true;
    resizeHandle = handleType;
    dragStart = startPt;

    dragGroupOriginals = [];
    for (var gi = 0; gi < state.selectedIds.length; gi++) {
      var cData = captureElementState(state.selectedIds[gi]);
      if (cData) dragGroupOriginals.push(JSON.parse(JSON.stringify(cData)));
    }
    if (dragGroupOriginals.length === 0) return;

    var combinedBbox = getCombinedBBox();
    origBbox = combinedBbox;
    origRotation = 0;
    rotationCenter = { x: combinedBbox.x + combinedBbox.width / 2, y: combinedBbox.y + combinedBbox.height / 2 };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else if (['tl', 'tr', 'bl', 'br'].includes(handleType)) {
      var anchorMap = {
        tl: { x: combinedBbox.x + combinedBbox.width, y: combinedBbox.y + combinedBbox.height },
        tr: { x: combinedBbox.x, y: combinedBbox.y + combinedBbox.height },
        bl: { x: combinedBbox.x + combinedBbox.width, y: combinedBbox.y },
        br: { x: combinedBbox.x, y: combinedBbox.y },
      };
      resizeAnchor = anchorMap[handleType];

      var draggedCornerMap = {
        tl: { x: combinedBbox.x, y: combinedBbox.y },
        tr: { x: combinedBbox.x + combinedBbox.width, y: combinedBbox.y },
        bl: { x: combinedBbox.x, y: combinedBbox.y + combinedBbox.height },
        br: { x: combinedBbox.x + combinedBbox.width, y: combinedBbox.y + combinedBbox.height },
      };
      var dc = draggedCornerMap[handleType];
      var dx = dc.x - resizeAnchor.x;
      var dy = dc.y - resizeAnchor.y;
      origDiagLen = Math.sqrt(dx * dx + dy * dy);
      origDiagVec = origDiagLen > 0 ? { x: dx / origDiagLen, y: dy / origDiagLen } : { x: 1, y: 1 };
    }

    document.addEventListener('pointermove', onResizeMove);
    document.addEventListener('pointerup', onResizeEnd);
    return;
  }

  const data = captureElementState(state.selectedId);
  if (!data) return;

  if (handleType === 'move' && data.type === 'line') {
    startDrag(state.selectedId, startPt);
    return;
  }

  isResizing = true;
  resizeHandle = handleType;
  dragStart = startPt;
  dragOriginal = { ...data };
  dragCurrent = { ...data };

  if (data.type === 'line' && ['tl', 'tr', 'bl', 'br'].includes(handleType)) {
    const el = dom.annotationLayer.querySelector(`#${CSS.escape(dragCurrent.id)}`);
    const lineChild = el?.querySelector('.annotation-line');
    if (lineChild) {
      try {
        const bb = lineChild.getBBox();
        const sw = parseFloat(lineChild.getAttribute('stroke-width')) || 1;
        const hsw = sw / 2;
        origBbox = { x: bb.x - hsw, y: bb.y - hsw, width: bb.width + sw, height: bb.height + sw };
      } catch {
        const pts = dragCurrent.points || [{x: dragCurrent.x1, y: dragCurrent.y1}, {x: dragCurrent.x2, y: dragCurrent.y2}];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
        origBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
    } else {
      origBbox = { x: dragCurrent.x1, y: dragCurrent.y1, width: 1, height: 1 };
    }

    origRotation = dragCurrent.rotation || 0;
    rotationCenter = { x: origBbox.x + origBbox.width / 2, y: origBbox.y + origBbox.height / 2 };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else {
      const anchorMap = {
        tl: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
        tr: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
        bl: { x: origBbox.x + origBbox.width, y: origBbox.y },
        br: { x: origBbox.x,                  y: origBbox.y },
      };
      resizeAnchor = anchorMap[handleType];

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
  } else if (data.type === 'text' && ['tl', 'tr', 'bl', 'br'].includes(handleType)) {
    const textEl = dom.annotationLayer.querySelector(`#${CSS.escape(dragCurrent.id)}`);
    if (textEl) {
      try {
        const bb = textEl.getBBox();
        const pad = 4;
        origBbox = {
          x: bb.x - pad, y: bb.y - pad,
          width: bb.width + pad * 2, height: bb.height + pad * 2,
        };
      } catch {
        origBbox = { x: dragCurrent.x, y: dragCurrent.y - dragCurrent.fontSize, width: dragCurrent.fontSize * 4, height: dragCurrent.fontSize };
      }
    }

    origRotation = dragCurrent.rotation || 0;
    rotationCenter = {
      x: origBbox.x + origBbox.width / 2,
      y: origBbox.y + origBbox.height / 2
    };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else {
      origBaselineOffX = dragCurrent.x - origBbox.x;
      origBaselineOffY = dragCurrent.y - origBbox.y;

      const anchorMap = {
        tl: { x: origBbox.x + origBbox.width, y: origBbox.y + origBbox.height },
        tr: { x: origBbox.x,                  y: origBbox.y + origBbox.height },
        bl: { x: origBbox.x + origBbox.width, y: origBbox.y },
        br: { x: origBbox.x,                  y: origBbox.y },
      };
      resizeAnchor = anchorMap[handleType];

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
    origRotation = dragCurrent.rotation || 0;
    rotationCenter = {
      x: dragCurrent.x + dragCurrent.width / 2,
      y: dragCurrent.y + dragCurrent.height / 2
    };

    if (textInteractMode === 'rotate') {
      dragStart.angle = Math.atan2(startPt.y - rotationCenter.y, startPt.x - rotationCenter.x) * 180 / Math.PI;
    } else if (handleType === 'tl' || handleType === 'br') {
      const anchorMap = {
        tl: { x: dragCurrent.x + dragCurrent.width, y: dragCurrent.y + dragCurrent.height },
        br: { x: dragCurrent.x, y: dragCurrent.y },
      };
      resizeAnchor = anchorMap[handleType];
      const dc = handleType === 'tl'
        ? { x: dragCurrent.x, y: dragCurrent.y }
        : { x: dragCurrent.x + dragCurrent.width, y: dragCurrent.y + dragCurrent.height };
      const dx = dc.x - resizeAnchor.x;
      const dy = dc.y - resizeAnchor.y;
      origDiagLen = Math.sqrt(dx * dx + dy * dy);
      origDiagVec = origDiagLen > 0
        ? { x: dx / origDiagLen, y: dy / origDiagLen }
        : { x: 1, y: 1 };
    } else if (handleType === 'bl' || handleType === 'tr') {
      resizeAnchor = {
        x: handleType === 'bl' ? dragCurrent.x : dragCurrent.x + dragCurrent.width,
        y: handleType === 'bl' ? dragCurrent.y + dragCurrent.height : dragCurrent.y,
      };
    }
  }

  document.addEventListener('pointermove', onResizeMove);
  document.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e) {
  if (!isResizing) return;
  const pt = screenToCoords(dom.svg, dom.annotationLayer, e.clientX, e.clientY);
  const data = dragCurrent;
  if (!data && !dragGroupOriginals) return;

  // ── Group resize/rotation ──────────────────────────────────
  if (dragGroupOriginals) {
    if (textInteractMode === 'rotate') {
      var currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      var angleDiff = currentAngle - dragStart.angle;
      var snappedAngle = Math.round(angleDiff / 5) * 5;

      for (var gi = 0; gi < dragGroupOriginals.length; gi++) {
        var origData = dragGroupOriginals[gi];
        var curData = captureElementState(origData.id);
        if (!curData) continue;
        var newRot = ((origData.rotation || 0) + snappedAngle) % 360;
        if (newRot < 0) newRot += 360;
        curData.rotation = newRot;
        applyElementState(curData);
      }

      var displayRot = (360 - ((snappedAngle % 360) + 360) % 360) % 360;
      var _ri = document.getElementById('rotation-input');
      if (_ri) { _applyingRotation = true; _ri.value = displayRot; _applyingRotation = false; }
      showRotationTooltip(e, displayRot);
    } else if (resizeAnchor) {
      var mx = pt.x - resizeAnchor.x;
      var my = pt.y - resizeAnchor.y;
      var projLen = mx * origDiagVec.x + my * origDiagVec.y;
      var scaleFactor = origDiagLen > 0 ? Math.max(0.1, projLen / origDiagLen) : 1;

      for (var gi = 0; gi < dragGroupOriginals.length; gi++) {
        var origData = dragGroupOriginals[gi];
        var curData = captureElementState(origData.id);
        if (!curData) continue;

        if (curData.type === 'rectangle') {
          curData.x = resizeAnchor.x + (origData.x - resizeAnchor.x) * scaleFactor;
          curData.y = resizeAnchor.y + (origData.y - resizeAnchor.y) * scaleFactor;
          curData.width = Math.max(5, Math.round(origData.width * scaleFactor));
          curData.height = Math.max(5, Math.round(origData.height * scaleFactor));
          var maxRx = Math.min(curData.width, curData.height) / 2;
          if (curData.rx > maxRx) curData.rx = maxRx;
          updateRectangleElement(curData);
        } else if (curData.type === 'line') {
          var srcPts = origData.points || [{x: origData.x1, y: origData.y1}, {x: origData.x2, y: origData.y2}];
          var newPts = srcPts.map(function(p) {
            return { x: resizeAnchor.x + (p.x - resizeAnchor.x) * scaleFactor, y: resizeAnchor.y + (p.y - resizeAnchor.y) * scaleFactor };
          });
          curData.points = newPts;
          curData.x1 = newPts[0].x; curData.y1 = newPts[0].y;
          curData.x2 = newPts[newPts.length - 1].x; curData.y2 = newPts[newPts.length - 1].y;
          updateLineSVG(curData);
        } else if (curData.type === 'text') {
          curData.x = resizeAnchor.x + (origData.x - resizeAnchor.x) * scaleFactor;
          curData.y = resizeAnchor.y + (origData.y - resizeAnchor.y) * scaleFactor;
          curData.fontSize = Math.max(8, Math.round(origData.fontSize * Math.abs(scaleFactor)));
          updateTextSVG(curData);
        } else if (curData.type === 'freehand') {
          curData.points = origData.points.map(function(p) {
            return { x: resizeAnchor.x + (p.x - resizeAnchor.x) * scaleFactor, y: resizeAnchor.y + (p.y - resizeAnchor.y) * scaleFactor };
          });
          if (curData.rawPoints) {
            curData.rawPoints = origData.rawPoints.map(function(p) {
              return { x: resizeAnchor.x + (p.x - resizeAnchor.x) * scaleFactor, y: resizeAnchor.y + (p.y - resizeAnchor.y) * scaleFactor };
            });
          }
          updateFreehandElement(curData);
        }
      }
    }
    drawHandles();
    return;
  }

  if (data.type === 'line') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      newRot = Math.round(newRot / 5) * 5;
      newRot = ((newRot % 360) + 360) % 360;
      data.rotation = newRot;
      updateLineSVG(data);
      var displayRot = (360 - newRot) % 360;
      var _ri = document.getElementById('rotation-input');
      if (_ri) { _applyingRotation = true; _ri.value = displayRot; _applyingRotation = false; }
      showRotationTooltip(e, displayRot);
    } else if (resizeAnchor) {
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

      const srcPts = dragOriginal.points || [{x: dragOriginal.x1, y: dragOriginal.y1}, {x: dragOriginal.x2, y: dragOriginal.y2}];
      const pts = srcPts.map(p => ({
        x: resizeAnchor.x + (p.x - resizeAnchor.x) * scaleFactor,
        y: resizeAnchor.y + (p.y - resizeAnchor.y) * scaleFactor,
      }));
      data.points = pts;
      data.x1 = pts[0].x; data.y1 = pts[0].y;
      data.x2 = pts[pts.length - 1].x; data.y2 = pts[pts.length - 1].y;

      updateLineSVG(data);
    }
  } else if (data.type === 'text') {
    if (textInteractMode === 'rotate') {
      const currentAngle = Math.atan2(pt.y - rotationCenter.y, pt.x - rotationCenter.x) * 180 / Math.PI;
      const angleDiff = currentAngle - dragStart.angle;
      let newRot = origRotation + angleDiff;
      newRot = Math.round(newRot / 5) * 5;
      newRot = ((newRot % 360) + 360) % 360;
      data.rotation = newRot;
      updateTextSVG(data);
      var displayRot = (360 - newRot) % 360;
      var _ri = document.getElementById('rotation-input');
      if (_ri) { _applyingRotation = true; _ri.value = displayRot; _applyingRotation = false; }
      showRotationTooltip(e, displayRot);
    } else if (resizeAnchor) {
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
      const scaleFactor = origDiagLen > 0 ? projLen / origDiagLen : 1;

      const newSize = Math.max(8, Math.round(dragOriginal.fontSize * Math.abs(scaleFactor)));
      const s = newSize / dragOriginal.fontSize;

      data.fontSize = newSize;

      const handle = resizeHandle;
      if (handle === 'br') {
        data.x = resizeAnchor.x + origBaselineOffX * s;
        data.y = resizeAnchor.y + origBaselineOffY * s;
      } else if (handle === 'bl') {
        data.x = resizeAnchor.x - origBbox.width * s + origBaselineOffX * s;
        data.y = resizeAnchor.y + origBaselineOffY * s;
      } else if (handle === 'tr') {
        data.x = resizeAnchor.x + origBaselineOffX * s;
        data.y = resizeAnchor.y - origBbox.height * s + origBaselineOffY * s;
      } else if (handle === 'tl') {
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
      var displayRot = (360 - newRot) % 360;
      var _ri = document.getElementById('rotation-input');
      if (_ri) { _applyingRotation = true; _ri.value = displayRot; _applyingRotation = false; }
      showRotationTooltip(e, displayRot);
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
      } else {
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

  drawHandles();
}

function deepCloneState(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function applyStateToCapture(target, source) {
  for (var key in source) {
    if (key === 'id') continue;
    if (Array.isArray(source[key])) {
      target[key] = source[key].map(function(item) {
        if (typeof item === 'object' && item !== null) return { x: item.x, y: item.y };
        return item;
      });
    } else {
      target[key] = source[key];
    }
  }
}

function onResizeEnd() {
  document.removeEventListener('pointermove', onResizeMove);
  document.removeEventListener('pointerup', onResizeEnd);

  hideRotationTooltip();

  if (!isResizing) return;
  isResizing = false;

  // ── Group resize/rotation undo ──────────────────────────────
  if (dragGroupOriginals) {
    var groupSnapshots = [];
    var groupChanged = false;
    for (var gi = 0; gi < dragGroupOriginals.length; gi++) {
      var origData = dragGroupOriginals[gi];
      var finalData = captureElementState(origData.id);
      if (!finalData) continue;
      if (JSON.stringify(origData) !== JSON.stringify(finalData)) groupChanged = true;
      groupSnapshots.push({ id: origData.id, orig: deepCloneState(origData), final: deepCloneState(finalData) });
    }
    if (groupChanged) {
      pushAction({
        description: (textInteractMode === 'rotate' ? 'Rotate' : 'Resize') + ' group (' + groupSnapshots.length + ' elements)',
        doFn: function() {
          for (var si = 0; si < groupSnapshots.length; si++) {
            var snap = groupSnapshots[si];
            var d = captureElementState(snap.id);
            if (!d) continue;
            applyStateToCapture(d, snap.final);
            applyElementState(d);
          }
          drawHandles();
        },
        undoFn: function() {
          for (var si = 0; si < groupSnapshots.length; si++) {
            var snap = groupSnapshots[si];
            var d = captureElementState(snap.id);
            if (!d) continue;
            applyStateToCapture(d, snap.orig);
            applyElementState(d);
          }
          drawHandles();
        },
      });
    }
    dragGroupOriginals = null;
    dragOriginal = null;
    dragCurrent = null;
    resizeAnchor = null;
    origBbox = null;
    return;
  }

  const data = dragCurrent;
  if (!data) return;

  const orig = { ...dragOriginal };
  const final = { ...data };

  if (data.type === 'line') {
    const desc = textInteractMode === 'rotate' ? 'Rotate line' : 'Resize line';
    const changed = orig.rotation !== final.rotation || orig.x1 !== final.x1 || orig.y1 !== final.y1 || orig.x2 !== final.x2 || orig.y2 !== final.y2 || JSON.stringify(orig.points) !== JSON.stringify(final.points);
    if (changed) {
      var sid = state.selectedId;
      pushAction({
        description: desc,
        doFn: () => {
          var d = captureElementState(sid);
          if (!d) return;
          d.x1 = final.x1; d.y1 = final.y1; d.x2 = final.x2; d.y2 = final.y2;
          d.rotation = final.rotation;
          if (final.points) d.points = final.points.map(p => ({...p}));
          updateLineSVG(d);
          drawHandles();
        },
        undoFn: () => {
          var d = captureElementState(sid);
          if (!d) return;
          d.x1 = orig.x1; d.y1 = orig.y1; d.x2 = orig.x2; d.y2 = orig.y2;
          d.rotation = orig.rotation;
          if (orig.points) d.points = orig.points.map(p => ({...p}));
          updateLineSVG(d);
          drawHandles();
        },
      });
    }
  } else if (data.type === 'text' && (orig.fontSize !== final.fontSize || orig.x !== final.x || orig.y !== final.y || orig.rotation !== final.rotation)) {
    var sid = state.selectedId;
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate text' : 'Resize text',
      doFn: () => {
        var d = captureElementState(sid);
        if (!d) return;
        d.fontSize = final.fontSize; d.x = final.x; d.y = final.y; d.rotation = final.rotation;
        updateTextSVG(d);
        drawHandles();
      },
      undoFn: () => {
        var d = captureElementState(sid);
        if (!d) return;
        d.fontSize = orig.fontSize; d.x = orig.x; d.y = orig.y; d.rotation = orig.rotation;
        updateTextSVG(d);
        drawHandles();
      },
    });
  } else if (data.type === 'rectangle' && (orig.width !== final.width || orig.height !== final.height || orig.x !== final.x || orig.y !== final.y || orig.rx !== final.rx || orig.rotation !== final.rotation)) {
    var sid = state.selectedId;
    pushAction({
      description: textInteractMode === 'rotate' ? 'Rotate rectangle' : 'Resize rectangle',
      doFn: () => {
        var d = captureElementState(sid);
        if (!d) return;
        Object.assign(d, final);
        updateRectangleElement(d);
        drawHandles();
      },
      undoFn: () => {
        var d = captureElementState(sid);
        if (!d) return;
        Object.assign(d, orig);
        updateRectangleElement(d);
        drawHandles();
      },
    });
  }

  dragOriginal = null;
  dragCurrent = null;
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

  // Clean up empty groups
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
  var selEl = document.getElementById(state.selectedId);
  if (!selEl || !selEl.parentElement || selEl.parentElement.dataset.type !== 'group') return;
  var parentG = selEl.parentElement;
  var idx = Array.prototype.indexOf.call(parentG.children, selEl);
  if (idx === -1) return;
  var newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= parentG.children.length) return;
  var refEl = parentG.children[newIdx];
  if (direction === -1) parentG.insertBefore(selEl, refEl);
  else parentG.insertBefore(selEl, refEl.nextSibling);
  updateMoveButtons();
  pushAction({
    description: 'Move ' + (direction === -1 ? 'up' : 'down') + ' in group',
    doFn: function() {
      var ce = document.getElementById(state.selectedId);
      if (!ce || !ce.parentElement || ce.parentElement.dataset.type !== 'group') return;
      var pg = ce.parentElement;
      var ci = Array.prototype.indexOf.call(pg.children, ce);
      if (ci === -1) return;
      var ni = ci + direction;
      if (ni < 0 || ni >= pg.children.length) return;
      var re = pg.children[ni];
      if (direction === -1) pg.insertBefore(ce, re);
      else pg.insertBefore(ce, re.nextSibling);
    },
    undoFn: function() {
      var ce = document.getElementById(state.selectedId);
      if (!ce || !ce.parentElement || ce.parentElement.dataset.type !== 'group') return;
      var pg = ce.parentElement;
      var ci = Array.prototype.indexOf.call(pg.children, ce);
      if (ci === -1) return;
      var revDir = direction === -1 ? 1 : -1;
      var ni = ci + revDir;
      if (ni < 0 || ni >= pg.children.length) return;
      var re = pg.children[ni];
      if (revDir === -1) pg.insertBefore(ce, re);
      else pg.insertBefore(ce, re.nextSibling);
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
  var selEl = document.getElementById(state.selectedId);
  if (!selEl || !selEl.parentElement || selEl.parentElement.dataset.type !== 'group') { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  var parentG = selEl.parentElement;
  var idx = Array.prototype.indexOf.call(parentG.children, selEl);
  if (idx === -1) { setMoveBtnVisibility(upBtn, downBtn, false); return; }
  setMoveBtnVisibility(upBtn, downBtn, true);
  if (idx < parentG.children.length - 1) upBtn.disabled = false;
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

function applyElementState(data) {
  if (!data) return;
  if (data.type === 'line') updateLineSVG(data);
  else if (data.type === 'text') updateTextSVG(data);
  else if (data.type === 'freehand') updateFreehandElement(data);
  else if (data.type === 'rectangle') updateRectangleElement(data);
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

function applyRotationToSelected(val) {
  if (!state.selectedId) return;
  var id = state.selectedId;
  var data = captureElementState(id);
  if (!data) return;
  if (data.type === 'freehand') return;
  var oldVal = data.rotation || 0;
  if (oldVal === val) return;
  data.rotation = val;
  applyElementState(data);
  drawHandles();
  pushAction({
    description: 'Set rotation',
    doFn: function() {
      var cur = captureElementState(id);
      if (!cur) return;
      cur.rotation = val;
      applyElementState(cur);
      drawHandles();
    },
    undoFn: function() {
      var cur = captureElementState(id);
      if (!cur) return;
      cur.rotation = oldVal;
      applyElementState(cur);
      drawHandles();
    },
  });
}

// ── Apply property changes to selected ──────────────────────────

function applyColorToSelected(color) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState) return;
  const oldColor = oldState.stroke;
  if (oldColor === color) return;
  const newState = { ...oldState, stroke: color };
  applyElementState(newState);
  drawHandles();
  pushAction({
    description: 'Change color',
    doFn: () => { applyElementState(newState); drawHandles(); },
    undoFn: () => { applyElementState(oldState); drawHandles(); },
  });
}

function applyThicknessToSelected(thickness) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState || (oldState.type !== 'line' && oldState.type !== 'freehand' && oldState.type !== 'rectangle' && oldState.type !== 'text')) return;
  const oldThickness = oldState.strokeWidth;
  if (oldThickness === thickness) return;
  const newState = { ...oldState, strokeWidth: thickness };
  applyElementState(newState);
  drawHandles();
  pushAction({
    description: 'Change thickness',
    doFn: () => { applyElementState(newState); drawHandles(); },
    undoFn: () => { applyElementState(oldState); drawHandles(); },
  });
}

function applyLineMarkerSizeToSelected(size) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState || oldState.type !== 'line') return;
  const newSize = normalizeLineMarkerSize(size);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldVal = oldState[sizeKey] ?? oldState.lineMarkerSize;
    const normOld = normalizeLineMarkerSize(oldVal);
    if (normOld === newSize) return;
    const newState = { ...oldState };
    newState.startDecorationSize = oldState.startDecorationSize;
    newState.endDecorationSize = oldState.endDecorationSize;
    newState[sizeKey] = newSize;
    updateLineSVG(newState);
    drawHandles();
    pushAction({
      description: 'Change line end marker size',
      doFn: () => {
        var cur = captureElementState(id);
        if (!cur) return;
        cur.startDecorationSize = cur.startDecorationSize ?? cur.lineMarkerSize;
        cur.endDecorationSize = cur.endDecorationSize ?? cur.lineMarkerSize;
        cur[sizeKey] = newSize;
        updateLineSVG(cur); drawHandles();
      },
      undoFn: () => { updateLineSVG(oldState); drawHandles(); },
    });
    return;
  }

  const oldSize = normalizeLineMarkerSize(oldState.lineMarkerSize);
  if (oldSize === newSize) return;
  const newState = {
    ...oldState,
    lineMarkerSize: newSize,
    startDecorationSize: newSize,
    endDecorationSize: newSize,
  };
  updateLineSVG(newState);
  drawHandles();
  pushAction({
    description: 'Change line marker size',
    doFn: () => {
      var cur = captureElementState(id);
      if (!cur) return;
      cur.lineMarkerSize = newSize;
      cur.startDecorationSize = newSize;
      cur.endDecorationSize = newSize;
      updateLineSVG(cur); drawHandles();
    },
    undoFn: () => { updateLineSVG(oldState); drawHandles(); },
  });
}

function applyLineStyleToSelected(style) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState || oldState.type !== 'line') return;

  const newStyle = normalizeLineStyle(style);
  const newDecor = styleToDecoration(newStyle);

  if (lineEditMode === 'change-end') {
    if (!selectedLineEndpoint) return;
    const decorKey = selectedLineEndpoint === 'start' ? 'startDecoration' : 'endDecoration';
    const sizeKey = selectedLineEndpoint === 'start' ? 'startDecorationSize' : 'endDecorationSize';
    const oldDecor = normalizeLineDecoration(oldState[decorKey]);
    if (oldDecor === newDecor) return;
    const newState = { ...oldState };
    newState[decorKey] = newDecor;
    newState[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
    updateLineSVG(newState);
    drawHandles();
    pushAction({
      description: 'Change line end decoration',
      doFn: () => {
        var cur = captureElementState(id);
        if (!cur) return;
        cur[decorKey] = newDecor;
        cur[sizeKey] = normalizeLineMarkerSize(state.activeLineMarkerSize);
        updateLineSVG(cur); drawHandles();
      },
      undoFn: () => { updateLineSVG(oldState); drawHandles(); },
    });
    return;
  }

  const oldStateClone = { ...oldState };
  const startHas = oldStateClone.startDecoration && oldStateClone.startDecoration !== 'none';
  const endHas = oldStateClone.endDecoration && oldStateClone.endDecoration !== 'none';
  const targetDecor = styleToDecoration(newStyle);

  var newState;
  if (targetDecor === 'none') {
    newState = { ...oldStateClone, lineStyle: 'normal', startDecoration: 'none', endDecoration: 'none' };
  } else if (!startHas && !endHas) {
    const decors = legacyStyleToDecorations(newStyle, state.activeLineMarkerSize);
    newState = { ...oldStateClone, lineStyle: newStyle, ...decors };
  } else {
    newState = { ...oldStateClone, lineStyle: newStyle };
    if (startHas) {
      newState.startDecoration = targetDecor;
      newState.startDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
    if (endHas) {
      newState.endDecoration = targetDecor;
      newState.endDecorationSize = normalizeLineMarkerSize(state.activeLineMarkerSize);
    }
  }
  updateLineSVG(newState);
  drawHandles();
  pushAction({
    description: 'Change line style',
    doFn: () => { updateLineSVG(newState); drawHandles(); },
    undoFn: () => { updateLineSVG(oldStateClone); drawHandles(); },
  });
}

function applyFontSizeToSelected(fontSize) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState || oldState.type !== 'text') return;
  const oldSize = oldState.fontSize;
  if (oldSize === fontSize) return;
  const newState = { ...oldState, fontSize };
  updateTextSVG(newState);
  drawHandles();
  pushAction({
    description: 'Change font size',
    doFn: () => { updateTextSVG(newState); drawHandles(); },
    undoFn: () => { updateTextSVG(oldState); drawHandles(); },
  });
}

function applyCornerRadiusToSelected(radius) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const oldState = captureElementState(id);
  if (!oldState || oldState.type !== 'rectangle') return;
  const oldRadius = oldState.rx || 0;
  if (oldRadius === radius) return;
  const clampedRadius = Math.min(radius, Math.min(oldState.width, oldState.height) / 2);
  const newState = { ...oldState, rx: clampedRadius };
  updateRectangleElement(newState);
  drawHandles();
  pushAction({
    description: 'Change corner radius',
    doFn: () => { updateRectangleElement(newState); drawHandles(); },
    undoFn: () => { updateRectangleElement(oldState); drawHandles(); },
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
