// ── History module: Undo / Redo ─────────────────────────────────

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 100;

let onChangeCallback = null;

export function initHistory(onChange) {
  onChangeCallback = onChange;
}

/**
 * Push an action onto the undo stack.
 * action = { description, doFn, undoFn }
 * doFn is NOT called here (caller already performed the action).
 */
export function pushAction(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0; // clear redo on new action
  notifyChange();
  document.dispatchEvent(new CustomEvent('editor-dirty'));
}

export function undo() {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();
  action.undoFn();
  redoStack.push(action);
  notifyChange();
}

export function redo() {
  if (redoStack.length === 0) return;
  const action = redoStack.pop();
  action.doFn();
  undoStack.push(action);
  notifyChange();
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  notifyChange();
}

function notifyChange() {
  if (onChangeCallback) onChangeCallback();
}
