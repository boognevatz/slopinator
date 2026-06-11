// ── Tools module: Tool state machine (Select / Line / Text) ────

import { state } from './editor.js';
import { activateSelect, deactivateSelect } from './select.js';
import { activateLine, deactivateLine } from './line.js';
import { activateText, deactivateText } from './text.js';

const toolButtons = {};

export function initTools() {
  toolButtons.select = document.getElementById('btn-select');
  toolButtons.line = document.getElementById('btn-line');
  toolButtons.text = document.getElementById('btn-text');

  for (const [tool, btn] of Object.entries(toolButtons)) {
    btn.addEventListener('click', () => switchTool(tool));
  }

  // Activate default tool
  activateSelect();
}

export function switchTool(tool) {
  if (tool === state.activeTool) return;

  // Deactivate current
  switch (state.activeTool) {
    case 'select': deactivateSelect(); break;
    case 'line': deactivateLine(); break;
    case 'text': deactivateText(); break;
  }

  state.activeTool = tool;

  // Update button highlights
  for (const [t, btn] of Object.entries(toolButtons)) {
    btn.classList.toggle('active', t === tool);
  }

  // Show/hide font size group
  document.getElementById('font-size-group').hidden = tool !== 'text';

  // Activate new
  switch (tool) {
    case 'select': activateSelect(); break;
    case 'line': activateLine(); break;
    case 'text': activateText(); break;
  }
}
