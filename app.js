/*
 * UI layer for the GridInventory prototype. All placement logic lives in the inventory script.
 *
 * The page declares how many grids it wants: <div id="views" data-grids="2"></div>.
 * Each grid is an independent inventory. With an engine that has transferItem
 * (inventory_simple.js) items can be dragged from one grid into another.
 * Combine (combineItem / combineFrom) works inside one grid or across grids (the result is
 * created in the grid holding the target item). It is only active when the page has the controls.
 */
(function () {
  'use strict';

  const CELL = 52;
  const GAP = 3;
  const PITCH = CELL + GAP;

  const $ = id => document.getElementById(id);
  const viewsEl = $('views');
  const logEl = $('log');
  const addTargetEl = $('add-target'); // optional: which grid the Add controls use
  const combineModeEl = $('combine-mode'); // optional: combine controls
  const combW = $('comb-w');
  const combH = $('comb-h');

  const count = Math.max(1, Number(viewsEl.dataset.grids) || 1); // number of grids on this page
  const PRESETS = [[5, 22], [6, 30], [8, 45], [10, 100]];
  const DEFAULT_GRIDS = [[5, 22], [6, 20]];
  const NAMES = 'ABCDEFGH';

  /** @type {Array<View>} */
  const views = [];
  let uid = 0; // display id: unique across all grids and stable when an item is transferred
  let drag = null;

  // --------------------------------------------------------------- helpers

  const label = it => `#${it.uid != null ? it.uid : it.id}`;
  const prefix = view => (views.length > 1 ? `${view.name}: ` : '');
  const readInt = el => Math.max(1, Math.floor(Number(el.value)) || 1);
  const dimsLabel = (w, h) => `${w}×${h}`;
  const px = cells => cells * PITCH - GAP;
  const canCombine = view => !!combineModeEl && typeof view.inv.combineFrom === 'function';
  const canTransfer = view => typeof view.inv.transferItem === 'function';

  function colorFor(it) {
    const hue = ((it.uid != null ? it.uid : it.id) * 137.508) % 360; // golden-angle spread
    return `hsl(${hue} 70% 62%)`;
  }

  function log(msg, cls = 'info') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    logEl.prepend(d);
    while (logEl.childElementCount > 200) logEl.lastChild.remove();
  }

  function placeBox(el, x, y, w, h) {
    el.style.left = `${x * PITCH}px`;
    el.style.top = `${y * PITCH}px`;
    el.style.width = `${px(w)}px`;
    el.style.height = `${px(h)}px`;
  }

  function addTag(box, text) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = text;
    box.appendChild(tag);
  }

  function itemHtml(it, rotated) {
    const [w, h] = GridInventory.dims(it, rotated);
    return `${dimsLabel(w, h)}<small>${label(it)}${rotated ? ' ↻' : ''}${it.combined ? ' ⊕' : ''}</small>`;
  }

  /** Short text for what a plan did besides moving the item. */
  function describePlan(plan, wasRotated) {
    const parts = [];
    if (plan.autoRotated) parts.push('auto-rotated');
    else if (plan.moved.rotated !== wasRotated) parts.push('rotated');
    if (plan.shifted) parts.push(`shifted ${plan.shifted} cells from drop`);
    if (plan.changed) {
      parts.push(`${plan.changed} other item${plan.changed > 1 ? 's' : ''} shifted${plan.repacked ? ' (full repack)' : ''}`);
    }
    return parts.length ? ' ' + parts.join(', ') : '';
  }

  // --------------------------------------------------------------- views

  function createView(index, width, cells) {
    const name = NAMES[index];
    const root = document.createElement('div');
    root.className = 'inv';
    root.innerHTML = `
      <div class="inv-head"><h2>${count > 1 ? `Inventory ${name}` : 'Inventory'}</h2><div class="stats"></div></div>
      <div class="inv-cfg">
        <label>Width <input class="cfg-width" type="number" min="1" max="16" value="${width}" /></label>
        <label>Cells <input class="cfg-cells" type="number" min="1" max="256" value="${cells}" /></label>
        <button class="rebuild primary">Rebuild</button>
        <button class="clear">Clear</button>
        <select class="preset" title="Grid preset">
          <option value="">Preset…</option>
          ${PRESETS.map(([w, c]) => `<option value="${w},${c}">${w} wide, ${c} cells</option>`).join('')}
        </select>
      </div>
      <div class="grid"><div class="cells"></div><div class="layer items"></div><div class="layer preview"></div></div>`;
    viewsEl.appendChild(root);

    const view = {
      index, name, root,
      inv: new GridInventory(width, cells),
      cellsEl: root.querySelector('.cells'),
      itemsEl: root.querySelector('.items'),
      previewEl: root.querySelector('.preview'),
      statsEl: root.querySelector('.stats'),
      cfgW: root.querySelector('.cfg-width'),
      cfgC: root.querySelector('.cfg-cells'),
    };

    view.itemsEl.addEventListener('pointerdown', e => onPointerDown(view, e));
    view.itemsEl.addEventListener('contextmenu', e => {
      const el = e.target.closest('.item');
      if (!el) return;
      e.preventDefault();
      if (drag) return;
      const id = Number(el.dataset.id);
      const it = view.inv.getItem(id);
      const ok = view.inv.rotateItem(id);
      log(`${prefix(view)}rotateItem(${label(it)}) ${ok ? '✓' : '✗ cannot rotate in place'}`, ok ? 'ok' : 'bad');
      renderItems(view, id);
    });
    view.itemsEl.addEventListener('dblclick', e => {
      const el = e.target.closest('.item');
      if (!el) return;
      const id = Number(el.dataset.id);
      log(`${prefix(view)}removeItem(${label(view.inv.getItem(id))})`, 'info');
      view.inv.removeItem(id);
      renderItems(view);
    });
    root.addEventListener('pointerdown', () => {
      if (addTargetEl) addTargetEl.value = String(index);
    });
    root.querySelector('.rebuild').addEventListener('click', () => rebuild(view, Number(view.cfgW.value), Number(view.cfgC.value)));
    root.querySelector('.clear').addEventListener('click', () => {
      view.inv.clear();
      log(`${prefix(view)}cleared all items`, 'info');
      renderItems(view);
    });
    root.querySelector('.preset').addEventListener('change', e => {
      if (!e.target.value) return;
      const [w, c] = e.target.value.split(',').map(Number);
      e.target.value = '';
      rebuild(view, w, c);
    });

    views.push(view);
    buildGrid(view);
    return view;
  }

  function rebuild(view, width, cells) {
    width = Math.max(1, Math.floor(width) || 1);
    cells = Math.max(1, Math.floor(cells) || 1);
    view.inv = new GridInventory(width, cells);
    view.cfgW.value = width;
    view.cfgC.value = cells;
    buildGrid(view);
    log(`${prefix(view)}new grid: width ${width}, ${cells} cells → ${view.inv.height} rows` +
      (cells % width ? `, last row has ${cells % width} cell(s)` : ''), 'info');
  }

  // --------------------------------------------------------------- rendering

  function buildGrid(view) {
    const { inv } = view;
    view.cellsEl.style.setProperty('--cols', inv.width);
    view.cellsEl.innerHTML = '';
    view.itemsEl.innerHTML = '';
    const total = inv.width * inv.height;
    for (let i = 0; i < total; i++) {
      const c = document.createElement('div');
      c.className = 'cell' + (i >= inv.totalCells ? ' void' : '');
      c.title = i < inv.totalCells ? `(${i % inv.width}, ${Math.floor(i / inv.width)})` : 'no cell';
      view.cellsEl.appendChild(c);
    }
    renderItems(view);
  }

  function renderItems(view, flashId = null) {
    const { inv, itemsEl } = view;
    const seen = new Set();
    for (const it of inv.items.values()) {
      seen.add(it.id);
      let el = itemsEl.querySelector(`[data-id="${it.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'item';
        el.dataset.id = it.id;
        itemsEl.appendChild(el);
      }
      el.style.background = colorFor(it); // an id can be reused by a different item after a transfer
      const [w, h] = GridInventory.dims(it);
      placeBox(el, it.x, it.y, w, h);
      el.innerHTML = itemHtml(it, it.rotated);
      el.title = `Item ${label(it)} ${dimsLabel(it.w, it.h)}${it.rotated ? ' (rotated)' : ''} at (${it.x}, ${it.y})` +
        (it.combined ? ` — combined from #${it.combined[0]} + #${it.combined[1]}` : '');
      if (flashId === it.id) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
    }
    for (const el of [...itemsEl.children]) {
      if (!seen.has(Number(el.dataset.id))) el.remove();
    }
    view.statsEl.innerHTML =
      `<span>Grid <b>${inv.width}×${inv.height}</b></span>` +
      `<span>Cells <b>${inv.totalCells}</b></span>` +
      `<span>Used <b>${inv.usedCells}</b></span>` +
      `<span>Free <b>${inv.freeCells}</b></span>` +
      `<span>Items <b>${inv.items.size}</b></span>`;
  }

  function clearPreviews() {
    views.forEach(v => { v.previewEl.innerHTML = ''; });
  }

  function renderCombinePreview(d) {
    const view = d.hover;
    const { dst, w, h, result } = d.combine;
    const [dw, dh] = GridInventory.dims(dst);

    // dotted outline of the target item, where the new item is meant to go
    const spot = document.createElement('div');
    spot.className = 'pv drop';
    placeBox(spot, dst.x, dst.y, dw, dh);
    view.previewEl.appendChild(spot);

    const main = document.createElement('div');
    if (!result) {
      main.className = 'pv bad';
      placeBox(main, dst.x, dst.y, dw, dh);
      addTag(main, `✗ cannot combine into ${w}×${h}`);
      view.previewEl.appendChild(main);
      return;
    }

    const { res, copy } = result;
    const [rw, rh] = GridInventory.dims(res);
    main.className = 'pv ok';
    placeBox(main, res.x, res.y, rw, rh);
    const tags = [`⊕ combine → ${w}×${h}`];
    if (view !== d.view) tags.push(`${d.view.name} + ${view.name}`);
    if (w !== h && res.rotated !== dst.rotated) tags.push('↻ rotated');
    if (res.x !== dst.x || res.y !== dst.y) tags.push('↔ moved from target spot');
    addTag(main, tags.join(' · '));
    view.previewEl.appendChild(main);

    for (const [id, next] of copy.items) {
      if (id === res.id) continue;
      const cur = view.inv.getItem(id);
      if (!cur || (cur.x === next.x && cur.y === next.y && cur.rotated === next.rotated)) continue;
      const [pw, ph] = GridInventory.dims(next);
      const box = document.createElement('div');
      box.className = 'pv shift';
      box.style.borderColor = colorFor(cur);
      placeBox(box, next.x, next.y, pw, ph);
      view.previewEl.appendChild(box);
    }
  }

  function renderPreview(d) {
    clearPreviews();
    const view = d.hover;
    if (!view || d.target == null) return;
    if (d.combine) return renderCombinePreview(d);

    const main = document.createElement('div');
    if (d.plan) {
      const m = d.plan.moved;
      const [w, h] = GridInventory.dims(d.item, m.rotated);
      main.className = 'pv ok';
      placeBox(main, m.x, m.y, w, h);
      const tags = [];
      if (view !== d.view) tags.push(`→ ${view.name}`);
      if (d.plan.autoRotated) tags.push('↻ auto-rotate');
      if (d.plan.shifted) tags.push(`↔ shifted ${d.plan.shifted}`);
      if (tags.length) addTag(main, tags.join(' · '));
      if (d.plan.shifted) {
        // faint outline of where the user actually dropped it
        const [hw, hh] = GridInventory.dims(d.item, d.rotated);
        const drop = document.createElement('div');
        drop.className = 'pv drop';
        placeBox(drop, d.target.x - d.grabX, d.target.y - d.grabY, hw, hh);
        view.previewEl.appendChild(drop);
      }
    } else {
      const [w, h] = GridInventory.dims(d.item, d.rotated);
      main.className = 'pv bad';
      placeBox(main, d.target.x - d.grabX, d.target.y - d.grabY, w, h);
    }
    view.previewEl.appendChild(main);

    if (d.plan) {
      for (const p of d.plan.placements) {
        if (p.id === d.plan.moved.id) continue;
        const other = view.inv.getItem(p.id);
        if (p.x === other.x && p.y === other.y && p.rotated === other.rotated) continue;
        const [pw, ph] = GridInventory.dims(other, p.rotated);
        const box = document.createElement('div');
        box.className = 'pv shift';
        box.style.borderColor = colorFor(other);
        placeBox(box, p.x, p.y, pw, ph);
        view.previewEl.appendChild(box);
      }
    }
  }

  // --------------------------------------------------------------- dragging

  function cloneInventory(inv) {
    const copy = new GridInventory(inv.width, inv.totalCells);
    inv.items.forEach((it, id) => copy.items.set(id, { ...it }));
    copy._nextId = inv._nextId;
    return copy;
  }

  /**
   * Runs the combine on copies of the inventories so the preview never touches the real ones.
   * `view` is where the target item (and the result) lives, `srcView` where the dragged item comes from.
   */
  function dryCombine(view, srcView, srcId, dstId, w, h) {
    const copy = cloneInventory(view.inv);
    const from = srcView === view ? copy : cloneInventory(srcView.inv);
    const res = copy.combineFrom(from, srcId, dstId, w, h);
    return res ? { res, copy } : null;
  }

  function itemAtCell(inv, x, y, excludeId) {
    for (const it of inv.items.values()) {
      if (it.id === excludeId) continue;
      const [w, h] = GridInventory.dims(it);
      if (x >= it.x && x < it.x + w && y >= it.y && y < it.y + h) return it;
    }
    return null;
  }

  function cellFromPointer(view, e) {
    const r = view.cellsEl.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / PITCH);
    const y = Math.floor((e.clientY - r.top) / PITCH);
    if (x < 0 || y < 0 || x >= view.inv.width || y >= view.inv.height) return null;
    return { x, y };
  }

  /** The grid (and cell) under the pointer, if any. */
  function hitTest(e) {
    for (const view of views) {
      const cell = cellFromPointer(view, e);
      if (cell) return { view, cell };
    }
    return null;
  }

  function updateGhostSize() {
    const [w, h] = GridInventory.dims(drag.item, drag.rotated);
    drag.ghost.style.width = `${px(w)}px`;
    drag.ghost.style.height = `${px(h)}px`;
    drag.ghost.innerHTML = itemHtml(drag.item, drag.rotated);
  }

  function moveGhost(e) {
    drag.last = { clientX: e.clientX, clientY: e.clientY };
    drag.ghost.style.left = `${e.clientX - (drag.grabX * PITCH + CELL / 2)}px`;
    drag.ghost.style.top = `${e.clientY - (drag.grabY * PITCH + CELL / 2)}px`;
  }

  function recomputePlan(e) {
    const hit = hitTest(e);
    const hover = hit ? hit.view : null;
    const target = hit ? hit.cell : null;
    const sameView = hover === drag.view;

    // Combine when the toggle is on (or Shift is held) and the cursor is over an item, in any grid.
    let dst = null;
    let cw = 0;
    let ch = 0;
    if (target && canCombine(hover) && (combineModeEl.checked || e.shiftKey)) {
      dst = itemAtCell(hover.inv, target.x, target.y, sameView ? drag.id : null);
      cw = readInt(combW);
      ch = readInt(combH);
    }

    const key = target
      ? `${hover.index},${target.x},${target.y},${drag.rotated},${dst ? `${dst.id}:${cw}x${ch}` : ''}`
      : 'none';
    if (key === drag.key) return;
    drag.key = key;
    drag.hover = hover;
    drag.target = target;
    drag.plan = null;
    drag.combine = null;

    if (dst) {
      drag.combine = { dst, w: cw, h: ch, result: dryCombine(hover, drag.view, drag.id, dst.id, cw, ch) };
    } else if (target && sameView) {
      drag.plan = hover.inv.planMove(drag.id, target.x, target.y, drag.grabX, drag.grabY, drag.rotated);
    } else if (target && canTransfer(hover)) {
      drag.plan = hover.inv.planInsert(drag.item, target.x, target.y, drag.grabX, drag.grabY, drag.rotated);
    }
    renderPreview(drag);
  }

  function onPointerDown(view, e) {
    if (e.button !== 0 || drag) return;
    const el = e.target.closest('.item');
    if (!el) return;
    e.preventDefault();

    const id = Number(el.dataset.id);
    const item = view.inv.getItem(id);
    const [w, h] = GridInventory.dims(item);
    const r = el.getBoundingClientRect();
    const grabX = Math.max(0, Math.min(w - 1, Math.floor((e.clientX - r.left) / PITCH)));
    const grabY = Math.max(0, Math.min(h - 1, Math.floor((e.clientY - r.top) / PITCH)));

    const ghost = el.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.classList.remove('dragging');
    document.body.appendChild(ghost);

    drag = {
      view, id, item, grabX, grabY,
      rotated: item.rotated,
      origin: { x: item.x, y: item.y, rotated: item.rotated },
      ghost, el, key: null, hover: null, target: null, plan: null, combine: null, moved: false,
      startX: e.clientX, startY: e.clientY, last: null,
    };
    el.classList.add('dragging');
    moveGhost(e);
    recomputePlan(e);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
    moveGhost(e);
    recomputePlan(e);
  }

  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    const src = d.view;
    const dest = d.hover;
    const name = label(d.item);
    const sameView = dest === src;
    const m = d.plan ? d.plan.moved : null;
    const unchanged = sameView && m && m.x === d.origin.x && m.y === d.origin.y && m.rotated === d.origin.rotated;
    let flash = { view: src, id: d.id };

    if (!d.moved && d.rotated === d.origin.rotated) {
      // Simple click, nothing to do (lets dblclick/contextmenu work).
    } else if (!d.target) {
      log(`moveItem(${name}) → dropped outside the grids, snapped back`, 'bad');
    } else if (d.combine) {
      const { dst, w, h } = d.combine;
      const dstName = label(dst);
      const newUid = ++uid;
      // the result is created in the grid holding the target item
      const res = dest.inv.combineFrom(src.inv, d.id, dst.id, w, h, { uid: newUid, combined: [d.item.uid, dst.uid] });
      const where = sameView ? prefix(src) : '';
      const names = sameView ? `${name}, ${dstName}` : `${name} (${src.name}), ${dstName} (${dest.name})`;
      if (res) {
        flash = { view: dest, id: res.id };
        log(
          `${where}combineItem(${names}) → #${newUid} ${w}×${h} at (${res.x}, ${res.y})${sameView ? '' : ` in ${dest.name}`} ✓` +
          `${res.x !== dst.x || res.y !== dst.y ? ' moved from target spot' : ''}` +
          `${res._repacked ? ' (full repack)' : ''}`,
          'ok'
        );
      } else {
        uid--;
        log(`${where}combineItem(${names}) ✗ no arrangement fits a ${w}×${h} item, nothing changed`, 'bad');
      }
    } else if (!sameView) {
      const res = d.plan
        ? dest.inv.transferItem(src.inv, d.id, d.target.x, d.target.y, d.grabX, d.grabY, d.rotated)
        : false;
      if (res) {
        flash = { view: dest, id: res.id };
        log(`transferItem(${name}) ${src.name} → ${dest.name} at (${res.x}, ${res.y}) ✓${describePlan(d.plan, d.rotated)}`, 'ok');
      } else {
        log(`transferItem(${name}) ${src.name} → ${dest.name} ✗ no arrangement fits there, snapped back`, 'bad');
      }
    } else if (unchanged) {
      // no-op
    } else if (d.plan) {
      src.inv.applyPlan(d.plan);
      log(`${prefix(src)}moveItem(${name}) → (${m.x}, ${m.y}) ✓${describePlan(d.plan, d.origin.rotated)}`, 'ok');
    } else {
      log(`${prefix(src)}moveItem(${name}) → (${d.target.x - d.grabX}, ${d.target.y - d.grabY}) ✗ no arrangement fits, snapped back`, 'bad');
    }
    cleanupDrag();
    views.forEach(v => renderItems(v, flash.view === v ? flash.id : null));
  }

  function cancelDrag() {
    if (!drag) return;
    log(`moveItem(${label(drag.item)}) cancelled`, 'info');
    cleanupDrag();
    views.forEach(v => renderItems(v));
  }

  function cleanupDrag() {
    drag.ghost.remove();
    drag.el.classList.remove('dragging');
    clearPreviews();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancelDrag);
    drag = null;
  }

  function rotateDrag() {
    const [, h] = GridInventory.dims(drag.item, drag.rotated); // current displayed height
    // 90° clockwise: cell (gx, gy) of a w×h box maps to (h-1-gy, gx) of the h×w box.
    const ngx = h - 1 - drag.grabY;
    const ngy = drag.grabX;
    drag.grabX = ngx;
    drag.grabY = ngy;
    drag.rotated = !drag.rotated;
    drag.key = null;
    updateGhostSize();
    moveGhost(drag.last); // keep the (new) grab cell under the pointer
  }

  // Re-evaluate at the last pointer position (after R or Shift changes the drag).
  function refreshPreview(shiftKey) {
    if (!drag || !drag.last) return;
    drag.key = null;
    recomputePlan({ ...drag.last, shiftKey });
  }

  window.addEventListener('keydown', e => {
    if (!drag) return;
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rotateDrag();
      refreshPreview(e.shiftKey);
    } else if (e.key === 'Escape') {
      cancelDrag();
    } else if (e.key === 'Shift' && !e.repeat) {
      refreshPreview(true);
    }
  });

  window.addEventListener('keyup', e => {
    if (drag && e.key === 'Shift') refreshPreview(false);
  });

  // --------------------------------------------------------------- controls

  const targetView = () => views[Number(addTargetEl ? addTargetEl.value : 0)] || views[0];

  function addItem(view, w, h) {
    const res = view.inv.addItem(w, h, { uid: ++uid });
    if (res) {
      const [dw, dh] = GridInventory.dims(res);
      log(
        `${prefix(view)}addItem(${w}, ${h}) ✓ ${label(res)} at (${res.x}, ${res.y})` +
        `${res.rotated ? ` rotated → ${dimsLabel(dw, dh)}` : ''}` +
        `${res._repacked ? ' (rearranged existing items)' : ''}`,
        'ok'
      );
      renderItems(view, res.id);
    } else {
      uid--;
      log(`${prefix(view)}addItem(${w}, ${h}) ✗ false — does not fit (free: ${view.inv.freeCells})`, 'bad');
    }
    return res;
  }

  $('btn-add').addEventListener('click', () => {
    addItem(targetView(), Number($('add-w').value), Number($('add-h').value));
  });

  document.querySelectorAll('[data-size]').forEach(b => {
    b.addEventListener('click', () => {
      const [w, h] = b.dataset.size.split(',').map(Number);
      $('add-w').value = w;
      $('add-h').value = h;
      addItem(targetView(), w, h);
    });
  });

  const RANDOM_SIZES = [[1, 1], [1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [4, 1], [3, 2], [2, 3], [4, 4]];
  const randomSize = () => RANDOM_SIZES[Math.floor(Math.random() * RANDOM_SIZES.length)];

  $('btn-random').addEventListener('click', () => {
    const [w, h] = randomSize();
    addItem(targetView(), w, h);
  });

  $('btn-fill').addEventListener('click', () => {
    const view = targetView();
    let added = 0, fails = 0;
    while (view.inv.freeCells > 0 && fails < 12) {
      const [w, h] = randomSize();
      if (view.inv.addItem(w, h, { uid: ++uid })) { added++; fails = 0; } else { uid--; fails++; }
    }
    log(`${prefix(view)}fill: added ${added} item(s), free cells left: ${view.inv.freeCells}`, 'info');
    renderItems(view);
  });

  document.querySelectorAll('[data-comb-size]').forEach(b => {
    b.addEventListener('click', () => {
      const [w, h] = b.dataset.combSize.split(',').map(Number);
      combW.value = w;
      combH.value = h;
    });
  });

  // --------------------------------------------------------------- boot

  const SEEDS = [
    [[2, 1], [4, 1], [2, 2], [1, 1], [3, 1]],
    [[2, 2], [1, 1], [3, 1], [1, 2]],
  ];
  for (let i = 0; i < count; i++) {
    const [w, c] = DEFAULT_GRIDS[i] || DEFAULT_GRIDS[0];
    createView(i, w, c);
  }
  log(`ready — ${views.map(v => `${v.name}: width ${v.inv.width}, ${v.inv.totalCells} cells`).join(' | ')}`, 'info');
  views.forEach((v, i) => (SEEDS[i] || SEEDS[0]).forEach(([w, h]) => addItem(v, w, h)));
})();
