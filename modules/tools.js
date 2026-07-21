// ── Tools module: Tool state machine (Select / Line / Text) ────

import { state } from './editor.js';
import { activateSelect, deactivateSelect, selectElement } from './select.js';
import { activateLine, deactivateLine, getPendingPolylineId } from './line.js';
import { activateText, deactivateText } from './text.js';
import { activateCrop, deactivateCrop } from './crop.js';
import { activateFreehand, deactivateFreehand } from './freehand.js';
import { activateRectangle, deactivateRectangle } from './rectangle.js';
import { activatePerspective, deactivatePerspective } from './perspective.js';
import { activateColorCorrection, deactivateColorCorrection } from './colorcorrection.js';
import { activateMeasure, deactivateMeasure } from './measure.js';

const toolButtons = {};
const TOOL_SETTINGS = {
  select: ['delete', 'color', 'thickness', 'element-id'],
  line: ['color', 'thickness', 'line-style', 'line-mode', 'element-id'],
  text: ['color', 'thickness', 'font-size', 'element-id'],
  freehand: ['color', 'thickness', 'freehand-epsilon', 'element-id'],
  rectangle: ['color', 'thickness', 'rectangle', 'element-id'],
  crop: ['crop'],
  perspective: ['perspective'],
  color: ['color-correction'],
};

export function initTools() {
  toolButtons.select = document.getElementById('btn-select');
  toolButtons.line = document.getElementById('btn-line');
  toolButtons.text = document.getElementById('btn-text');
  toolButtons.crop = document.getElementById('btn-crop');
  toolButtons.freehand = document.getElementById('btn-freehand');
  toolButtons.rectangle = document.getElementById('btn-rectangle');
  toolButtons.perspective = document.getElementById('btn-perspective');
  toolButtons.color = document.getElementById('btn-color');
  toolButtons.measure = document.getElementById('btn-measure');

  for (const [tool, btn] of Object.entries(toolButtons)) {
    if (btn) btn.addEventListener('click', () => switchTool(tool));
  }

  // Activate default tool
  activateSelect();
  updateToolSettingsVisibility(state.activeTool, null);

  document.addEventListener('selection-changed', (e) => {
    updateToolSettingsVisibility(state.activeTool, e.detail?.data?.type || null);
  });
}

export function switchTool(tool) {
  if (tool === state.activeTool) return;

  // Capture pending polyline before line deactivation finalizes it
  let pendingLineId = null;
  if (state.activeTool === 'line' && tool === 'select') {
    pendingLineId = getPendingPolylineId();
  }

  // Capture selected line data before deactivating (deactivateSelect clears selection)
  let selectedLineData = null;
  if (state.selectedId && tool === 'line') {
    const sel = state.elements.find(el => el.id === state.selectedId);
    if (sel && sel.type === 'line') selectedLineData = sel;
  }

  // Capture selected text id before deactivating (deactivateSelect clears selection)
  let selectedTextId = null;
  if (state.selectedId && tool === 'text') {
    const sel = state.elements.find(el => el.id === state.selectedId);
    if (sel && sel.type === 'text') selectedTextId = sel.id;
  }

  // Deactivate current
  switch (state.activeTool) {
    case 'select': deactivateSelect(); break;
    case 'line': deactivateLine(); break;
    case 'text': deactivateText(); break;
    case 'crop': deactivateCrop(); break;
    case 'freehand': deactivateFreehand(); break;
    case 'rectangle': deactivateRectangle(); break;
    case 'perspective': deactivatePerspective(); break;
    case 'color': deactivateColorCorrection(); break;
    case 'measure': deactivateMeasure(); break;
  }

  state.activeTool = tool;

  // Update button highlights
  for (const [t, btn] of Object.entries(toolButtons)) {
    if (btn) btn.classList.toggle('active', t === tool);
  }

  updateToolSettingsVisibility(tool, null);

  // Activate new
  switch (tool) {
    case 'select': activateSelect(); break;
    case 'line': activateLine(selectedLineData); break;
    case 'text': activateText(selectedTextId); break;
    case 'crop': activateCrop(); break;
    case 'freehand': activateFreehand(); break;
    case 'rectangle': activateRectangle(); break;
    case 'perspective': activatePerspective(); break;
    case 'color': activateColorCorrection(); break;
    case 'measure': activateMeasure(); break;
  }

  // If switching from line to select, select the just-finalized polyline
  if (pendingLineId) {
    const sel = state.elements.find(el => el.id === pendingLineId);
    if (sel) selectElement(sel.id);
  }
}

function setGroupVisible(id, visible) {
  var el = document.getElementById(id);
  if (el) el.hidden = !visible;
}

function updateToolSettingsVisibility(tool, selectedType = null) {
  const visible = new Set(TOOL_SETTINGS[tool] || []);

  setGroupVisible('color-group', visible.has('color'));
  setGroupVisible('thickness-group', visible.has('thickness'));
  setGroupVisible('line-style-group', visible.has('line-style'));
  setGroupVisible('line-mode-group', visible.has('line-mode'));
  setGroupVisible('font-size-group', visible.has('font-size'));
  setGroupVisible('delete-group', visible.has('delete'));
  setGroupVisible('freehand-epsilon-group', visible.has('freehand-epsilon'));
  setGroupVisible('rectangle-group', visible.has('rectangle'));
  setGroupVisible('crop-group', visible.has('crop'));
  setGroupVisible('perspective-group', visible.has('perspective'));
  setGroupVisible('color-correction-group', visible.has('color-correction'));
  setGroupVisible('element-id-group', visible.has('element-id'));
}
