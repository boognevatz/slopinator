import { state, dom } from './editor.js';
import { svgEl, generateId } from './utils.js';
import { pushAction } from './history.js';
import { drawHandles, selectElement } from './select.js';

export function groupSelected() {
  var ids = state.selectedIds.slice();
  if (ids.length < 2) return;

  // Check if any element is already inside a group
  for (var gi = 0; gi < ids.length; gi++) {
    var el = dom.annotationLayer.querySelector('#' + CSS.escape(ids[gi]));
    if (!el) return;
    if (el.parentNode && el.parentNode.getAttribute('data-type') === 'group') return;
  }

  var groupId = 'group-' + generateId();

  var g = svgEl('g', { id: groupId, 'data-type': 'group' });
  for (var gi2 = 0; gi2 < ids.length; gi2++) {
    var childSvg = dom.annotationLayer.querySelector('#' + CSS.escape(ids[gi2]));
    if (childSvg) g.appendChild(childSvg);
  }
  dom.annotationLayer.appendChild(g);

  state.selectedId = groupId;
  state.selectedIds = ids.slice();

  drawHandles();

  var btn = document.getElementById('btn-group');
  if (btn) btn.disabled = true;
  document.getElementById('btn-delete').disabled = false;
  document.dispatchEvent(new CustomEvent('selection-changed', { detail: { id: groupId } }));

  pushAction({
    description: 'Group ' + ids.length + ' elements',
    doFn: function() {
      var dg = dom.annotationLayer.querySelector('#' + CSS.escape(groupId));
      if (!dg) {
        dg = svgEl('g', { id: groupId, 'data-type': 'group' });
        dom.annotationLayer.appendChild(dg);
      }
      for (var dj = 0; dj < ids.length; dj++) {
        var ds = dom.annotationLayer.querySelector('#' + CSS.escape(ids[dj]));
        if (ds && ds.parentNode !== dg) dg.appendChild(ds);
      }
    },
    undoFn: function() {
      var dgEl = dom.annotationLayer.querySelector('#' + CSS.escape(groupId));
      if (dgEl) {
        while (dgEl.children.length > 0) {
          dom.annotationLayer.appendChild(dgEl.children[0]);
        }
        dgEl.remove();
      }
    },
  });
}

export function ungroupSelected() {
  var ids = state.selectedIds.slice();
  if (ids.length < 2) return;

  var parentId = null;
  for (var i = 0; i < ids.length; i++) {
    var el = dom.annotationLayer.querySelector('#' + CSS.escape(ids[i]));
    if (!el) return;
    var parentG = el.parentNode && el.parentNode.closest ? el.parentNode.closest('[data-type="group"]') : null;
    if (!parentG) return;
    if (i === 0) parentId = parentG.id;
    else if (parentG.id !== parentId) return;
  }
  if (!parentId) return;

  // Verify all children of the group are selected
  var parentGEl = dom.annotationLayer.querySelector('#' + CSS.escape(parentId));
  if (!parentGEl) return;
  if (parentGEl.children.length !== ids.length) return;

  var gEl = dom.annotationLayer.querySelector('#' + CSS.escape(parentId));
  if (gEl) {
    while (gEl.children.length > 0) dom.annotationLayer.appendChild(gEl.children[0]);
    gEl.remove();
  }

  selectElement(ids[0], false);

  pushAction({
    description: 'Ungroup ' + ids.length + ' elements',
    doFn: function() {
      var dgEl = dom.annotationLayer.querySelector('#' + CSS.escape(parentId));
      if (dgEl) {
        while (dgEl.children.length > 0) dom.annotationLayer.appendChild(dgEl.children[0]);
        dgEl.remove();
      }
    },
    undoFn: function() {
      var rg = dom.annotationLayer.querySelector('#' + CSS.escape(parentId));
      if (!rg) {
        rg = svgEl('g', { id: parentId, 'data-type': 'group' });
        dom.annotationLayer.appendChild(rg);
      }
      for (var rj = 0; rj < ids.length; rj++) {
        var rs = dom.annotationLayer.querySelector('#' + CSS.escape(ids[rj]));
        if (rs && rs.parentNode !== rg) rg.appendChild(rs);
      }
    },
  });
}
