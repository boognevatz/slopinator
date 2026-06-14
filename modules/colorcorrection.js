import { state, dom, loadImage } from './editor.js';
import { pushAction } from './history.js';
import { addLineElement } from './line.js';
import { addTextElement } from './text.js';
import { addFreehandElement } from './freehand.js';
import { addRectangleElement } from './rectangle.js';

let originalDataURI = null;
let origW = 0;
let origH = 0;
let currentResultURI = null;
let generation = 0;
let previewTimer = null;
let hasApplied = false;

let algorithm = 'gaussian';
let paramValue = 80;
let gaussianSigma = 80;
let morphKernel = 15;
let contrastBlack = 0;
let contrastWhite = 256;
let grayscaleMode = false;
let showIntermediate = false;
let showOriginal = false;

function maxFilter1D(arr, width, height, kernel) {
  const half = Math.floor(kernel / 2);
  const out = new Uint8ClampedArray(arr.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let maxV = 0;
      const s = Math.max(0, x - half);
      const e = Math.min(width - 1, x + half);
      for (let k = s; k <= e; k++) {
        if (arr[row + k] > maxV) maxV = arr[row + k];
      }
      out[row + x] = maxV;
    }
  }
  return out;
}

function minFilter1D(arr, width, height, kernel) {
  const half = Math.floor(kernel / 2);
  const out = new Uint8ClampedArray(arr.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let minV = 255;
      const s = Math.max(0, x - half);
      const e = Math.min(width - 1, x + half);
      for (let k = s; k <= e; k++) {
        if (arr[row + k] < minV) minV = arr[row + k];
      }
      out[row + x] = minV;
    }
  }
  return out;
}

function filterSeparable(data, width, height, kernel, filterFn) {
  const afterH = filterFn(data, width, height, kernel);
  const out = new Uint8ClampedArray(data.length);
  const half = Math.floor(kernel / 2);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let val = filterFn === maxFilter1D ? 0 : 255;
      const s = Math.max(0, y - half);
      const e = Math.min(height - 1, y + half);
      for (let ky = s; ky <= e; ky++) {
        const v = afterH[ky * width + x];
        if (filterFn === maxFilter1D ? v > val : v < val) val = v;
      }
      out[y * width + x] = val;
    }
  }
  return out;
}

function extractLuminance(data, width, height) {
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    lum[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
  }
  return lum;
}

function morphologicalClose(lum, width, height, kernel) {
  const dilated = filterSeparable(lum, width, height, kernel, maxFilter1D);
  return filterSeparable(dilated, width, height, kernel, minFilter1D);
}

function minMaxStretch(data, width, height) {
  let minV = 255, maxV = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < minV) minV = data[i];
    if (data[i] > maxV) maxV = data[i];
  }
  const range = maxV - minV;
  if (range < 1) return;
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round((data[i] - minV) / range * 255);
  }
}

function computeIlluminationGaussian(dataURI, width, height, sigma) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 500;
      const downScale = Math.min(1, maxDim / Math.max(width, height));
      const smallW = Math.round(width * downScale);
      const smallH = Math.round(height * downScale);

      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = smallW;
      blurCanvas.height = smallH;
      const blurCtx = blurCanvas.getContext('2d');
      blurCtx.filter = `blur(${sigma * downScale}px)`;
      blurCtx.drawImage(img, 0, 0, smallW, smallH);

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = width;
      fullCanvas.height = height;
      const fullCtx = fullCanvas.getContext('2d');
      fullCtx.drawImage(blurCanvas, 0, 0, width, height);
      const blurData = fullCtx.getImageData(0, 0, width, height);

      const lum = extractLuminance(blurData.data, width, height);
      resolve({ lum, minMax: null });
    };
    img.src = dataURI;
  });
}

function computeIlluminationMorph(dataURI, width, height, kernel) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 500;
      const downScale = Math.min(1, maxDim / Math.max(width, height));
      const smallW = Math.round(width * downScale);
      const smallH = Math.round(height * downScale);

      const canvas = document.createElement('canvas');
      canvas.width = smallW;
      canvas.height = smallH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, smallW, smallH);
      const data = ctx.getImageData(0, 0, smallW, smallH);

      const lum = extractLuminance(data.data, smallW, smallH);
      const closed = morphologicalClose(lum, smallW, smallH, kernel);

      const mmClosed = new Uint8ClampedArray(closed);
      minMaxStretch(mmClosed, smallW, smallH);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = smallW;
      outCanvas.height = smallH;
      const outCtx = outCanvas.getContext('2d');
      const outData = outCtx.createImageData(smallW, smallH);
      for (let i = 0; i < smallW * smallH; i++) {
        const idx = i * 4;
        outData.data[idx] = closed[i];
        outData.data[idx + 1] = closed[i];
        outData.data[idx + 2] = closed[i];
        outData.data[idx + 3] = 255;
      }
      outCtx.putImageData(outData, 0, 0);

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = width;
      fullCanvas.height = height;
      const fullCtx = fullCanvas.getContext('2d');
      fullCtx.drawImage(outCanvas, 0, 0, width, height);
      const fullData = fullCtx.getImageData(0, 0, width, height);
      const lumFull = extractLuminance(fullData.data, width, height);

      resolve({ lum: lumFull, minMax: mmClosed });
    };
    img.src = dataURI;
  });
}

function renderCorrection(origData, width, height, illumLum, meanLum, gray, showInter, showOrig, origURI) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (showOrig) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0); resolve(canvas.toDataURL('image/jpeg', 0.95)); };
      img.src = origURI;
      return;
    }

    const outData = ctx.createImageData(width, height);
    const out = outData.data;
    const orig = origData.data;

    if (showInter) {
      for (let i = 0; i < out.length; i += 4) {
        const v = illumLum[i / 4];
        out[i] = out[i + 1] = out[i + 2] = v;
        out[i + 3] = 255;
      }
      ctx.putImageData(outData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.95));
      return;
    }

    for (let i = 0; i < out.length; i += 4) {
      const illum = Math.max(8, illumLum[i / 4]);
      const scale = meanLum / illum;

      if (gray) {
        const lum = 0.299 * orig[i] + 0.587 * orig[i + 1] + 0.114 * orig[i + 2];
        const v = Math.round(Math.max(0, Math.min(255, lum * scale)));
        out[i] = out[i + 1] = out[i + 2] = v;
      } else {
        out[i] = Math.round(Math.max(0, Math.min(255, orig[i] * scale)));
        out[i + 1] = Math.round(Math.max(0, Math.min(255, orig[i + 1] * scale)));
        out[i + 2] = Math.round(Math.max(0, Math.min(255, orig[i + 2] * scale)));
      }
      out[i + 3] = 255;
    }

    ctx.putImageData(outData, 0, 0);
    resolve(canvas.toDataURL('image/jpeg', 0.95));
  });
}

function computeMeanLuminance(lum) {
  let sum = 0;
  for (let i = 0; i < lum.length; i++) sum += lum[i];
  return sum / lum.length;
}

function stretchHsv(data, width, height, showInter) {
  const hsvArr = new Array(width * height);
  let minV = 1, maxV = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > 0.001) {
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    const s = mx < 0.001 ? 0 : d / mx;
    const v = mx;
    hsvArr[i / 4] = { h, s, v };
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const vRange = maxV - minV;
  if (vRange === 0) return;

  const stretchRange = Math.max(vRange, 0.01);

  if (showInter) {
    for (let i = 0; i < data.length; i += 4) {
      const v = (hsvArr[i / 4].v - minV) / stretchRange;
      const cv = Math.round(Math.max(0, Math.min(255, v * 255)));
      data[i] = data[i + 1] = data[i + 2] = cv;
      data[i + 3] = 255;
    }
    return;
  }

  for (let i = 0; i < data.length; i += 4) {
    const { h, s, v: oldV } = hsvArr[i / 4];
    if (oldV <= minV) {
      data[i] = data[i + 1] = data[i + 2] = 0;
    } else if (oldV >= maxV) {
      data[i] = data[i + 1] = data[i + 2] = 255;
    } else {
      const v = (oldV - minV) / stretchRange;
      if (s < 0.001) {
        const cv = Math.round(v * 255);
        data[i] = data[i + 1] = data[i + 2] = cv;
      } else {
        const hi = Math.floor(h * 6) % 6;
        const f = h * 6 - Math.floor(h * 6);
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);
        let r, g, b;
        switch (hi) {
          case 0: r = v; g = t; b = p; break;
          case 1: r = q; g = v; b = p; break;
          case 2: r = p; g = v; b = t; break;
          case 3: r = p; g = q; b = v; break;
          case 4: r = t; g = p; b = v; break;
          default: r = v; g = p; b = q; break;
        }
        data[i] = Math.round(r * 255);
        data[i + 1] = Math.round(g * 255);
        data[i + 2] = Math.round(b * 255);
      }
    }
    data[i + 3] = 255;
  }
}

function contrastLevels(data, width, height, blackPoint, whitePoint, showInter) {
  blackPoint = Math.max(0, Math.min(128, blackPoint));
  whitePoint = Math.max(128, Math.min(256, whitePoint));

  const bpNorm = blackPoint / 255;
  const wpNorm = whitePoint / 255;
  const range = whitePoint - blackPoint;
  const rNorm = range / 255;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const v = Math.max(r, g, b);

    if (showInter) {
      let cv = 128;
      if (v <= bpNorm) cv = 0;
      else if (range <= 0 || v >= wpNorm) cv = 255;
      else cv = Math.round((v - bpNorm) / rNorm * 255);
      data[i] = data[i + 1] = data[i + 2] = cv;
      data[i + 3] = 255;
      continue;
    }

    if (v <= bpNorm) {
      data[i] = data[i + 1] = data[i + 2] = 0;
    } else if (range <= 0 || v >= wpNorm) {
      data[i] = data[i + 1] = data[i + 2] = 255;
    } else {
      const newV = (v - bpNorm) / rNorm;
      const scale = newV / v;
      data[i] = Math.round(Math.max(0, Math.min(255, data[i] * scale)));
      data[i + 1] = Math.round(Math.max(0, Math.min(255, data[i + 1] * scale)));
      data[i + 2] = Math.round(Math.max(0, Math.min(255, data[i + 2] * scale)));
    }
    data[i + 3] = 255;
  }
}

function processImage(dataURI, width, height, algo, param, gray, showInter, showOrig) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const origData = ctx.getImageData(0, 0, width, height);

      if (showOrig) {
        resolve(canvas.toDataURL('image/jpeg', 0.95));
        return;
      }

      if (algo === 'stretch') {
        stretchHsv(origData.data, width, height, showInter);
        if (document.getElementById('color-highlight').checked) {
          const data = origData.data;
          for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum > 250) {
              data[i] = 255; data[i + 1] = 255; data[i + 2] = 0;
            } else if (lum < 40) {
              data[i] = 0; data[i + 1] = 255; data[i + 2] = 0;
            }
          }
        }
        if (gray) {
          const data = origData.data;
          for (let i = 0; i < data.length; i += 4) {
            const v = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            data[i] = data[i + 1] = data[i + 2] = v;
          }
        }
        ctx.putImageData(origData, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.95));
        return;
      }

      if (algo === 'contrast') {
        contrastLevels(origData.data, width, height, contrastBlack, contrastWhite, showInter);
        if (document.getElementById('color-highlight').checked) {
          const data = origData.data;
          for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum > 250) {
              data[i] = 255; data[i + 1] = 255; data[i + 2] = 0;
            } else if (lum < 40) {
              data[i] = 0; data[i + 1] = 255; data[i + 2] = 0;
            }
          }
        }
        if (gray) {
          const data = origData.data;
          for (let i = 0; i < data.length; i += 4) {
            const v = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            data[i] = data[i + 1] = data[i + 2] = v;
          }
        }
        ctx.putImageData(origData, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.95));
        return;
      }

      const illumPromise = algo === 'morph'
        ? computeIlluminationMorph(dataURI, width, height, param)
        : computeIlluminationGaussian(dataURI, width, height, param);

      illumPromise.then(({ lum }) => {
        const meanLum = computeMeanLuminance(lum);
        renderCorrection(origData, width, height, lum, meanLum, gray, showInter, showOrig, dataURI)
          .then(resolve);
      });
    };
    img.src = dataURI;
  });
}

function readSettings() {
  algorithm = document.getElementById('color-algorithm').value;
  paramValue = parseInt(document.getElementById('color-param-slider').value) || 80;
  if (algorithm === 'morph') morphKernel = paramValue;
  else gaussianSigma = paramValue;
  contrastBlack = parseInt(document.getElementById('color-contrast-black').value) || 0;
  contrastWhite = parseInt(document.getElementById('color-contrast-white').value) || 256;
  grayscaleMode = document.getElementById('color-grayscale').checked;
  showIntermediate = document.getElementById('color-show-intermediate').checked;
  showOriginal = document.getElementById('color-show-original').checked;
}

function updateUIForAlgorithm() {
  const label = document.getElementById('color-param-label');
  const slider = document.getElementById('color-param-slider');
  const value = document.getElementById('color-param-value');

  label.hidden = true;
  slider.hidden = true;
  value.hidden = true;
  document.getElementById('color-contrast-black-label').hidden = true;
  document.getElementById('color-contrast-black').hidden = true;
  document.getElementById('color-contrast-black-value').hidden = true;
  document.getElementById('color-contrast-white-label').hidden = true;
  document.getElementById('color-contrast-white').hidden = true;
  document.getElementById('color-contrast-white-value').hidden = true;

  if (algorithm === 'stretch') return;

  if (algorithm === 'contrast') {
    document.getElementById('color-contrast-black-label').hidden = false;
    document.getElementById('color-contrast-black').hidden = false;
    document.getElementById('color-contrast-black-value').hidden = false;
    document.getElementById('color-contrast-white-label').hidden = false;
    document.getElementById('color-contrast-white').hidden = false;
    document.getElementById('color-contrast-white-value').hidden = false;
    return;
  }

  label.hidden = false;
  slider.hidden = false;
  value.hidden = false;
  if (algorithm === 'morph') {
    label.textContent = 'Kernel';
    slider.min = 3;
    slider.max = 51;
    slider.step = 2;
    slider.value = String(morphKernel);
    paramValue = morphKernel;
  } else {
    label.textContent = 'Sigma';
    slider.min = 10;
    slider.max = 200;
    slider.step = 5;
    slider.value = String(gaussianSigma);
    paramValue = gaussianSigma;
  }
  value.textContent = paramValue;
}

function showOriginalURI() {
  if (originalDataURI) {
    dom.imageEl.setAttribute('href', originalDataURI);
  }
  document.getElementById('btn-color-correct').disabled = true;
  document.getElementById('btn-color-reset').disabled = false;
}

function schedulePreview() {
  generation++;
  const gen = generation;
  clearTimeout(previewTimer);

  readSettings();

  if (showOriginal) {
    showOriginalURI();
    return;
  }

  if (!originalDataURI) return;
  document.getElementById('color-param-value').textContent = paramValue;
  document.getElementById('color-contrast-black-value').textContent = contrastBlack;
  document.getElementById('color-contrast-white-value').textContent = contrastWhite;

  previewTimer = setTimeout(() => {
    processImage(originalDataURI, origW, origH, algorithm, paramValue, grayscaleMode, showIntermediate, showOriginal)
      .then((newURI) => {
        if (gen !== generation) return;
        dom.imageEl.setAttribute('href', newURI);
        currentResultURI = newURI;
        document.getElementById('btn-color-correct').disabled = false;
        document.getElementById('btn-color-reset').disabled = false;
      });
  }, 200);
}

function onSettingChange() {
  readSettings();
  updateUIForAlgorithm();
  schedulePreview();
}

export function initColorCorrection() {
  document.getElementById('btn-color-correct').addEventListener('click', applyCorrection);
  document.getElementById('btn-color-reset').addEventListener('click', resetTool);

  const paramSlider = document.getElementById('color-param-slider');
  const algoSelect = document.getElementById('color-algorithm');
  const grayCheck = document.getElementById('color-grayscale');
  const showInterCheck = document.getElementById('color-show-intermediate');
  const showOrigCheck = document.getElementById('color-show-original');
  const highlightCheck = document.getElementById('color-highlight');
  const contrastBlackSlider = document.getElementById('color-contrast-black');
  const contrastWhiteSlider = document.getElementById('color-contrast-white');

  paramSlider.addEventListener('input', onSettingChange);
  algoSelect.addEventListener('change', onSettingChange);
  grayCheck.addEventListener('change', onSettingChange);
  showInterCheck.addEventListener('change', onSettingChange);
  showOrigCheck.addEventListener('change', onSettingChange);
  highlightCheck.addEventListener('change', onSettingChange);
  contrastBlackSlider.addEventListener('input', onSettingChange);
  contrastWhiteSlider.addEventListener('input', onSettingChange);
}

export function activateColorCorrection() {
  if (!state.hasImage) return;

  originalDataURI = state.image.dataURI;
  origW = state.image.naturalWidth;
  origH = state.image.naturalHeight;
  currentResultURI = null;
  generation++;
  hasApplied = false;

  document.getElementById('color-correction-group').hidden = false;

  readSettings();
  updateUIForAlgorithm();
  schedulePreview();
}

export function deactivateColorCorrection() {
  document.getElementById('color-correction-group').hidden = true;
  clearTimeout(previewTimer);

  if (!hasApplied && currentResultURI) {
    dom.imageEl.setAttribute('href', originalDataURI);
  }

  originalDataURI = null;
  currentResultURI = null;
  hasApplied = false;
}

function resetTool() {
  clearTimeout(previewTimer);
  if (originalDataURI) {
    dom.imageEl.setAttribute('href', originalDataURI);
  }
  currentResultURI = null;

  document.getElementById('color-algorithm').value = 'gaussian';
  document.getElementById('color-param-slider').value = '80';
  document.getElementById('color-contrast-black').value = '0';
  document.getElementById('color-contrast-white').value = '256';
  document.getElementById('color-grayscale').checked = false;
  document.getElementById('color-show-intermediate').checked = false;
  document.getElementById('color-show-original').checked = false;

  algorithm = 'gaussian';
  paramValue = 80;
  gaussianSigma = 80;
  morphKernel = 15;
  contrastBlack = 0;
  contrastWhite = 256;
  grayscaleMode = false;
  showIntermediate = false;
  showOriginal = false;
  hasApplied = false;
  updateUIForAlgorithm();
  schedulePreview();
}

function addElement(el) {
  if (el.type === 'line') addLineElement(el);
  else if (el.type === 'text') addTextElement(el);
  else if (el.type === 'freehand') addFreehandElement(el);
  else if (el.type === 'rectangle') addRectangleElement(el);
}

function applyCorrection() {
  if (!currentResultURI || !originalDataURI) return;

  const oldURI = originalDataURI;
  const oldW = origW;
  const oldH = origH;
  const newURI = currentResultURI;
  const newW = origW;
  const newH = origH;
  const oldElements = JSON.parse(JSON.stringify(state.elements));

  pushAction({
    description: 'Color correction',
    doFn: () => {
      loadImage(newURI, newW, newH);
      for (const el of oldElements) addElement(el);
      state.elements.push(...oldElements);
    },
    undoFn: () => {
      loadImage(oldURI, oldW, oldH);
      for (const el of oldElements) addElement(el);
      state.elements.push(...oldElements);
    },
  });

  loadImage(newURI, newW, newH);
  for (const el of oldElements) addElement(el);
  state.elements.push(...oldElements);

  originalDataURI = newURI;
  hasApplied = true;
  currentResultURI = null;
  document.getElementById('btn-color-correct').disabled = true;
  document.getElementById('btn-color-reset').disabled = false;
  schedulePreview();
}


