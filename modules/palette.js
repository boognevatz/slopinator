import { state } from './editor.js';

let colorPickerTarget = null;
let activeTarget = 'foreground'; // 'foreground' | 'background'
let dropdownOpen = false;

function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 0.299 + g * 0.587 + b * 0.114) > 180;
}

export function initPalette() {
  setupIndicatorClicks();
  updateIndicator();
  renderSwatches();
  renderThickness();
  setupColorPicker();
  setupDropdownPicker();
  setupGlobalClose();
}

export function refreshPalette() {
  updateIndicator();
  renderSwatches();
  renderThickness();
}

// ── Foreground/Background Indicator ──────────────────────────────

function updateIndicator() {
  setSquareColor('fg-square', state.activeColor);
  setSquareColor('bg-square', state.bgColor);
}

function setSquareColor(id, color) {
  const el = document.getElementById(id);
  if (color === 'transparent') {
    el.classList.add('chessboard');
    el.style.background = '';
  } else {
    el.classList.remove('chessboard');
    el.style.background = color;
  }
}

function setupIndicatorClicks() {
  document.getElementById('fg-click-area').addEventListener('click', (e) => {
    e.stopPropagation();
    activeTarget = 'foreground';
    openDropdown();
  });

  document.getElementById('bg-click-area').addEventListener('click', (e) => {
    e.stopPropagation();
    activeTarget = 'background';
    openDropdown();
  });
}

// ── Dropdown ────────────────────────────────────────────────────

function openDropdown() {
  highlightActiveSwatch();
  const dd = document.getElementById('color-dropdown');
  dropdownOpen = true;
  dd.hidden = false;
}

function closeDropdown() {
  const dd = document.getElementById('color-dropdown');
  dropdownOpen = false;
  dd.hidden = true;
}

function setupGlobalClose() {
  document.addEventListener('click', (e) => {
    const indicator = document.getElementById('color-indicator');
    if (dropdownOpen && !indicator.contains(e.target)) {
      closeDropdown();
    }
  });
}

function renderSwatches() {
  const container = document.getElementById('color-dropdown-swatches');
  container.innerHTML = '';
  const targetColor = activeTarget === 'foreground' ? state.activeColor : state.bgColor;
  state.palette.forEach((color, i) => {
    const swatch = document.createElement('div');
    let cls = 'swatch' + (color === targetColor ? ' active' : '');
    if (isLightColor(color)) cls += ' swatch-light';
    swatch.className = cls;
    swatch.style.background = color;
    swatch.dataset.index = i;
    swatch.title = `${color} (right-click to edit)`;

    swatch.addEventListener('click', () => {
      applyColor(color);
      highlightActiveSwatch();
      closeDropdown();
    });

    swatch.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      colorPickerTarget = i;
      const picker = document.getElementById('color-picker-hidden');
      picker.value = state.palette[i];
      picker.click();
    });

    container.appendChild(swatch);
  });

  // Transparent swatch
  const transpSwatch = document.createElement('div');
  transpSwatch.className = 'swatch chessboard swatch-light' + (targetColor === 'transparent' ? ' active' : '');
  transpSwatch.title = 'transparent';
  transpSwatch.addEventListener('click', () => {
    applyColor('transparent');
    highlightActiveSwatch();
    closeDropdown();
  });
  container.appendChild(transpSwatch);
}

function applyColor(color) {
  if (activeTarget === 'foreground') {
    state.activeColor = color;
    setSquareColor('fg-square', color);
    document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color } }));
  } else {
    state.bgColor = color;
    setSquareColor('bg-square', color);
  }
}

function highlightActiveSwatch() {
  const swatches = document.querySelectorAll('#color-dropdown-swatches .swatch');
  const targetColor = activeTarget === 'foreground' ? state.activeColor : state.bgColor;
  swatches.forEach(s => {
    const idx = parseInt(s.dataset.index);
    if (!isNaN(idx)) {
      s.classList.toggle('active', state.palette[idx] === targetColor);
    } else {
      s.classList.toggle('active', targetColor === 'transparent');
    }
  });
}

function setupColorPicker() {
  const picker = document.getElementById('color-picker-hidden');
  picker.addEventListener('input', (e) => {
    if (colorPickerTarget !== null) {
      state.palette[colorPickerTarget] = e.target.value;
      applyColor(e.target.value);
      renderSwatches();
    }
  });
  picker.addEventListener('change', () => {
    colorPickerTarget = null;
  });
}

function setupDropdownPicker() {
  const picker = document.getElementById('color-dropdown-picker');
  picker.addEventListener('input', (e) => {
    applyColor(e.target.value);
    highlightActiveSwatch();
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

    btn.addEventListener('click', () => {
      state.activeThickness = val;
      highlightActiveThickness();
      document.dispatchEvent(new CustomEvent('palette-thickness-changed', { detail: { thickness: val } }));
    });

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
