// ── Tools module: Tool state machine (Select / Line / Text) ────

import { state } from './editor.js';
import { activateSelect, deactivateSelect } from './select.js';
import { activateLine, deactivateLine } from './line.js';
import { activateText, deactivateText } from './text.js';
import { activateCrop, deactivateCrop } from './crop.js';
import { activateFreehand, deactivateFreehand } from './freehand.js';

const toolButtons = {};
const TOOL_SETTINGS = {
  select: ['delete'],
  line: ['color', 'thickness', 'line-style'],
  text: ['color', 'font-size'],
  freehand: ['color', 'thickness', 'freehand-epsilon'],
  crop: ['crop'],
};

export function initTools() {
  toolButtons.select = document.getElementById('btn-select');
  toolButtons.line = document.getElementById('btn-line');
  toolButtons.text = document.getElementById('btn-text');
  toolButtons.crop = document.getElementById('btn-crop');
  toolButtons.freehand = document.getElementById('btn-freehand');

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

  // Deactivate current
  switch (state.activeTool) {
    case 'select': deactivateSelect(); break;
    case 'line': deactivateLine(); break;
    case 'text': deactivateText(); break;
    case 'crop': deactivateCrop(); break;
    case 'freehand': deactivateFreehand(); break;
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
    case 'line': activateLine(); break;
    case 'text': activateText(); break;
    case 'crop': activateCrop(); break;
    case 'freehand': activateFreehand(); break;
  }
}

function updateToolSettingsVisibility(tool, selectedType = null) {
  const visible = new Set(TOOL_SETTINGS[tool] || []);

  if (tool === 'select' && selectedType === 'line') {
    visible.add('color');
    visible.add('thickness');
  }
  if (tool === 'select' && selectedType === 'text') {
    visible.add('color');
    visible.add('font-size');
  }
  if (tool === 'select' && selectedType === 'freehand') {
    visible.add('color');
    visible.add('thickness');
    visible.add('freehand-epsilon');
  }

  document.getElementById('color-group').hidden = !visible.has('color');
  document.getElementById('thickness-group').hidden = !visible.has('thickness');
  const showLineStyle = tool === 'line' || (tool === 'select' && selectedType === 'line' && state.activeLineEditMode === 'change-end');
  document.getElementById('line-style-group').hidden = !showLineStyle;
  document.getElementById('line-mode-group').hidden = !(tool === 'select' && selectedType === 'line');
  document.getElementById('font-size-group').hidden = !visible.has('font-size');
  document.getElementById('delete-group').hidden = !visible.has('delete');
  document.getElementById('freehand-epsilon-group').hidden = !visible.has('freehand-epsilon');
  document.getElementById('crop-group').hidden = !visible.has('crop');
}
