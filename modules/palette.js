// ── Palette module: Color palette & thickness presets UI ────────

import { state } from './editor.js';

let colorPickerTarget = null; // index of swatch being edited

export function initPalette() {
  renderPalette();
  renderThickness();
  setupColorPicker();
}

/** Rebuild palette after restoring state */
export function refreshPalette() {
  renderPalette();
  renderThickness();
}

// ── Color Palette ───────────────────────────────────────────────

function renderPalette() {
  const container = document.getElementById('color-palette');
  container.innerHTML = '';
  state.palette.forEach((color, i) => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch' + (color === state.activeColor ? ' active' : '');
    swatch.style.background = color;
    swatch.dataset.index = i;
    swatch.title = `${color} (right-click to edit)`;

    // Left click: select color
    swatch.addEventListener('click', () => {
      state.activeColor = color;
      highlightActiveSwatch();
      // If an element is selected, update its color
      document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color } }));
    });

    // Right click: edit swatch color
    swatch.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      colorPickerTarget = i;
      const picker = document.getElementById('color-picker-hidden');
      picker.value = state.palette[i];
      picker.click();
    });

    container.appendChild(swatch);
  });
}

function highlightActiveSwatch() {
  const swatches = document.querySelectorAll('#color-palette .swatch');
  swatches.forEach(s => {
    const idx = parseInt(s.dataset.index);
    s.classList.toggle('active', state.palette[idx] === state.activeColor);
  });
}

function setupColorPicker() {
  const picker = document.getElementById('color-picker-hidden');
  picker.addEventListener('input', (e) => {
    if (colorPickerTarget !== null) {
      state.palette[colorPickerTarget] = e.target.value;
      state.activeColor = e.target.value;
      renderPalette();
      document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color: e.target.value } }));
    }
  });
  picker.addEventListener('change', () => {
    colorPickerTarget = null;
  });
}

// ── Thickness Presets ───────────────────────────────────────────

function renderThickness() {
  const container = document.getElementById('thickness-presets');
  container.innerHTML = '';
  state.thicknessPresets.forEach((val, i) => {
    const btn = document.createElement('button');
    btn.className = 'thickness-btn' + (val === state.activeThickness ? ' active' : '');
    btn.textContent = val;
    btn.title = `${val}px (right-click to edit)`;

    // Left click: select thickness
    btn.addEventListener('click', () => {
      state.activeThickness = val;
      highlightActiveThickness();
      document.dispatchEvent(new CustomEvent('palette-thickness-changed', { detail: { thickness: val } }));
    });

    // Right click: edit preset
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const newVal = prompt(`Enter new thickness value (replacing ${val}):`, val);
      const parsed = parseFloat(newVal);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
        state.thicknessPresets[i] = parsed;
        state.activeThickness = parsed;
        renderThickness();
        document.dispatchEvent(new CustomEvent('palette-thickness-changed', { detail: { thickness: parsed } }));
      }
    });

    container.appendChild(btn);
  });
}

function highlightActiveThickness() {
  const btns = document.querySelectorAll('#thickness-presets .thickness-btn');
  btns.forEach((btn, i) => {
    btn.classList.toggle('active', state.thicknessPresets[i] === state.activeThickness);
  });
}
