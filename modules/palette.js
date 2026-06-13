import { state } from './editor.js';

let colorPickerTarget = null;
let activeTarget = 'foreground';
let dropdownOpen = false;

function getBaseHex(color) {
  if (!color || color === 'transparent') return null;
  if (color.startsWith('#')) return color;
  const m = color.match(/\d+/g);
  if (m && m.length >= 3) {
    return '#' + [m[0], m[1], m[2]].map(v => parseInt(v).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function colorWithOpacity(hex, opacity) {
  if (opacity >= 255) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(opacity / 255).toFixed(2)})`;
}

function isLightColor(color) {
  const hex = getBaseHex(color);
  if (!hex) return false;
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
  setupOpacitySlider();
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
  syncOpacitySlider();
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
  const targetHex = getBaseHex(targetColor);
  state.palette.forEach((color, i) => {
    const swatch = document.createElement('div');
    let cls = 'swatch' + (getBaseHex(color) === targetHex ? ' active' : '');
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
  if (color === 'transparent') {
    if (activeTarget === 'foreground') {
      state.activeColor = 'transparent';
      setSquareColor('fg-square', 'transparent');
      document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color: 'transparent' } }));
    } else {
      state.bgColor = 'transparent';
      setSquareColor('bg-square', 'transparent');
      document.dispatchEvent(new CustomEvent('palette-bgcolor-changed', { detail: { color: 'transparent' } }));
    }
    return;
  }
  const hex = getBaseHex(color);
  if (!hex) return;
  if (activeTarget === 'foreground') {
    state.activeColor = colorWithOpacity(hex, state.activeOpacity);
    setSquareColor('fg-square', state.activeColor);
    document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color: state.activeColor } }));
  } else {
    state.bgColor = colorWithOpacity(hex, state.bgOpacity);
    setSquareColor('bg-square', state.bgColor);
    document.dispatchEvent(new CustomEvent('palette-bgcolor-changed', { detail: { color: state.bgColor } }));
  }
  syncOpacitySlider();
}

function highlightActiveSwatch() {
  const swatches = document.querySelectorAll('#color-dropdown-swatches .swatch');
  const targetColor = activeTarget === 'foreground' ? state.activeColor : state.bgColor;
  const targetHex = getBaseHex(targetColor);
  swatches.forEach(s => {
    const idx = parseInt(s.dataset.index);
    if (!isNaN(idx)) {
      s.classList.toggle('active', getBaseHex(state.palette[idx]) === targetHex);
    } else {
      s.classList.toggle('active', targetColor === 'transparent');
    }
  });
}

// ── Opacity Slider ──────────────────────────────────────────────

function setupOpacitySlider() {
  const slider = document.getElementById('color-opacity-slider');
  slider.addEventListener('input', (e) => {
    const opacity = parseInt(e.target.value);
    document.getElementById('color-opacity-value').textContent = opacity;
    if (activeTarget === 'foreground') {
      state.activeOpacity = opacity;
      const hex = getBaseHex(state.activeColor);
      if (hex) {
        state.activeColor = colorWithOpacity(hex, opacity);
        setSquareColor('fg-square', state.activeColor);
        document.dispatchEvent(new CustomEvent('palette-color-changed', { detail: { color: state.activeColor } }));
      }
    } else {
      state.bgOpacity = opacity;
      const hex = getBaseHex(state.bgColor);
      if (hex) {
        state.bgColor = colorWithOpacity(hex, opacity);
        setSquareColor('bg-square', state.bgColor);
        document.dispatchEvent(new CustomEvent('palette-bgcolor-changed', { detail: { color: state.bgColor } }));
      }
    }
    highlightActiveSwatch();
  });
}

function syncOpacitySlider() {
  const slider = document.getElementById('color-opacity-slider');
  const label = document.getElementById('color-opacity-value');
  const opacity = activeTarget === 'foreground' ? state.activeOpacity : state.bgOpacity;
  slider.disabled = false;
  slider.value = opacity;
  label.textContent = opacity;
}

// ── Custom Color Pickers ────────────────────────────────────────

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
