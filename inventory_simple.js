/**
 * GridInventory (simple version) - same public API as inventory.js, much shorter.
 *
 * Grid: `width` columns, `totalCells` usable cells, height = ceil(totalCells / width).
 * Cells past totalCells (the missing part of a partial last row) are invalid.
 * Items are w x h rectangles, `rotated` swaps to h x w, anchored at their top-left (x, y).
 *
 * moveItem / planMove: instead of explicit rules, every placement of the moved item
 * (both orientations, every origin) is a candidate with a cost. Cheapest wins.
 *
 *   cost = where  + rotation + others
 *
 *   where    on the drop   : 0 for the exact drop; for the other orientation any origin
 *                            still covering the dropped cell; + small centre distance
 *            off the drop  : 1e5 + 1e4 * centre distance (a "shift", only when nothing
 *                            on the drop works, and the nearest shift wins)
 *   rotation 1 if the orientation is flipped and no other item moves,
 *            1000 if flipped and other items move too (so rotating is used to AVOID
 *            displacement, and the held orientation is kept when displacing anyway)
 *   others   100 per other item whose position/rotation changes, plus 1e4 for each one
 *            that was NOT in the way (moving an uninvolved item costs as much as
 *            sliding the dragged item one cell)
 *
 * combineItem(src, dst, w, h): removes both items and places a new item at dst's spot
 * by running the same cost search as a move (the new item is the "dragged" one).
 * combineFrom(otherInv, src, dst, w, h): same, with src taken from another inventory.
 *
 * insertItem / transferItem: the same search with the dragged item coming from ANOTHER
 * inventory (planInsert is the dry run), so items can be dragged between two grids.
 *
 * Others are re-homed by a backtracking packer: first only the items in the way are
 * moved, and if that fails every other item may move. A candidate that cannot be
 * arranged is skipped. Candidates are tried in order of their lowest possible cost,
 * and the search stops once none can beat the best found.
 */
(function (global) {
  'use strict';

  const dims = (it, rot = it.rotated) => (rot ? [it.h, it.w] : [it.w, it.h]);

  class GridInventory {
    constructor(width, totalCells) {
      width = Math.floor(width);
      totalCells = Math.floor(totalCells);
      if (!(width >= 1) || !(totalCells >= 1)) throw new Error('width and totalCells must be >= 1');
      this.width = width;
      this.totalCells = totalCells;
      this.height = Math.ceil(totalCells / width);
      this.items = new Map();
      this._nextId = 1;
      this.searchBudget = 3000; // max packer placements per search
    }

    static dims(item, rotated) {
      return dims(item, rotated);
    }

    // ------------------------------------------------------------------ queries

    get usedCells() {
      return [...this.items.values()].reduce((s, it) => s + it.w * it.h, 0);
    }

    get freeCells() {
      return this.totalCells - this.usedCells;
    }

    isValidCell(x, y) {
      return x >= 0 && y >= 0 && x < this.width && y < this.height && y * this.width + x < this.totalCells;
    }

    getItem(id) {
      return this.items.get(id) || null;
    }

    getItemAt(x, y) {
      return [...this.items.values()].find(it => {
        const [w, h] = dims(it);
        return x >= it.x && x < it.x + w && y >= it.y && y < it.y + h;
      }) || null;
    }

    /** [{ item, origin:{x,y,index}, size:{w,h}, cells:[{x,y,index}] }] (item = null for empty cells) */
    _entry(item, x, y, w, h) {
      const cells = this._cover(x, y, w, h).map(index => ({ x: index % this.width, y: Math.floor(index / this.width), index }));
      return { item, origin: cells[0], size: { w, h }, cells };
    }

    getItemsWithCells() {
      return [...this.items.values()].map(it => this._entry(it, it.x, it.y, ...dims(it)));
    }

    /** Every usable free cell, row-major, in the same shape with item = null. */
    getEmptyCells() {
      const occ = this._occ([...this.items.values()]);
      return occ.flatMap((v, i) => (v === 0 ? [this._entry(null, i % this.width, Math.floor(i / this.width), 1, 1)] : []));
    }

    // ---------------------------------------------------------------- mutation

    /** Adds a w x h item (first free spot, else rearranging everything). Returns the item or false. */
    addItem(w, h, meta = {}) {
      w = Math.floor(w);
      h = Math.floor(h);
      if (!(w >= 1 && h >= 1) || w * h > this.freeCells) return false;
      const item = { ...meta, id: this._nextId, w, h, rotated: false, x: null, y: null };
      const existing = [...this.items.values()];
      const spot = this._spots(this._occ(existing), w, h)[0];
      let repacked = false;
      if (spot) {
        Object.assign(item, spot);
      } else {
        const sol = this._pack([...existing, item], this._occ([]));
        if (!sol) return false;
        this._apply(sol);
        Object.assign(item, sol.find(p => p.id === item.id));
        repacked = true;
      }
      this.items.set(item.id, item);
      this._nextId++;
      item._repacked = repacked;
      return item;
    }

    /**
     * Replaces two items with one new w x h item placed at the dst item's location
     * (its top-left cell, same orientation). Both old items are removed.
     * If the new item does not fit exactly there, the normal move cost rules decide:
     * it may rotate to avoid displacing others, displace others (they are re-homed),
     * or, only when the spot is impossible, slide to the nearest feasible spot.
     * opts: { allowAutoRotate, allowShift } as in planMove.
     * Returns the new item, or false (nothing changes) if no arrangement exists.
     */
    combineItem(srcId, dstId, w, h, meta = {}, opts = {}) {
      return this.combineFrom(this, srcId, dstId, w, h, meta, opts);
    }

    /**
     * combineItem where `src` lives in another inventory `from` (dst is in this one).
     * The new item is created HERE at dst's location; src is removed from `from` and dst from
     * this inventory, but only if the result fits (otherwise neither inventory changes).
     */
    combineFrom(from, srcId, dstId, w, h, meta = {}, opts = {}) {
      const src = from.items.get(srcId);
      const dst = this.items.get(dstId);
      w = Math.floor(w);
      h = Math.floor(h);
      if (!src || !dst || src === dst || !(w >= 1 && h >= 1)) return false;

      const snapshot = new Map(this.items);
      this.items.delete(dstId);
      if (from === this) this.items.delete(srcId);

      let plan = null;
      const item = { ...meta, id: this._nextId, w, h, rotated: w !== h && dst.rotated, x: dst.x, y: dst.y };
      if (w * h <= this.freeCells) {
        this.items.set(item.id, item); // sits at dst's spot; planMove treats it as the dragged item
        plan = this.planMove(item.id, dst.x, dst.y, 0, 0, undefined, opts);
      }
      if (!plan) {
        this.items.clear(); // restore src, dst and the original order
        snapshot.forEach((it, id) => this.items.set(id, it));
        return false;
      }
      this.applyPlan(plan);
      if (from !== this) from.items.delete(srcId);
      this._nextId++;
      item._repacked = plan.repacked;
      return item;
    }

    removeItem(id) {
      return this.items.delete(id);
    }

    clear() {
      this.items.clear();
    }

    /**
     * Dry run of a move. Returns a plan or null.
     * plan = { placements:[{id,x,y,rotated}], moved, displaced, changed, autoRotated,
     *          shifted, repacked, cost }
     * opts.allowAutoRotate / opts.allowShift (default true).
     */
    planMove(id, tx, ty, gx = 0, gy = 0, rotated, opts) {
      const item = this.items.get(id);
      return item ? this._plan(item, tx, ty, gx, gy, rotated, opts) : null;
    }

    /**
     * Dry run of putting a COPY of `src` (an item from any inventory) into this one at a
     * drop position, exactly like planMove (same costs: rotate to avoid displacing, displace
     * and re-home others, or slide to the nearest feasible spot).
     * plan.moved.id is the id the new item would get here.
     */
    planInsert(src, tx, ty, gx = 0, gy = 0, rotated, opts) {
      if (!src || !(src.w >= 1 && src.h >= 1) || src.w * src.h > this.freeCells) return null;
      const item = { ...src, id: this._nextId, x: null, y: null, rotated: rotated === undefined ? !!src.rotated : !!rotated };
      return this._plan(item, tx, ty, gx, gy, item.rotated, opts);
    }

    /** Adds a copy of `src` (from any inventory) at a drop position. Returns the new item or false. */
    insertItem(src, tx, ty, gx = 0, gy = 0, rotated, opts) {
      const plan = this.planInsert(src, tx, ty, gx, gy, rotated, opts);
      if (!plan) return false;
      const item = { ...src, ...plan.moved, _repacked: plan.repacked };
      this.applyPlan(plan); // re-homes the others; the new id is not in the map yet, so it is skipped
      this.items.set(item.id, item);
      this._nextId++;
      return item;
    }

    /**
     * Moves item `id` out of inventory `from` into this one at a drop position (the cross-inventory
     * moveItem). The source is only touched if the item fits here. Returns the new item or false.
     */
    transferItem(from, id, tx, ty, gx = 0, gy = 0, rotated, opts) {
      if (from === this) return this.moveItem(id, tx, ty, gx, gy, rotated, opts) ? this.items.get(id) : false;
      const src = from.items.get(id);
      const item = src ? this.insertItem(src, tx, ty, gx, gy, rotated, opts) : false;
      if (item) from.items.delete(id);
      return item;
    }

    _plan(item, tx, ty, gx, gy, rotated, opts = {}) {
      rotated = rotated === undefined ? item.rotated : !!rotated;
      const others = [...this.items.values()].filter(o => o.id !== item.id);
      const occ = this._occ(others);
      const [hw, hh] = dims(item, rotated);
      const [ox, oy] = [tx - gx, ty - gy]; // exact drop origin in the held orientation
      const orientations = opts.allowAutoRotate !== false && item.w !== item.h ? [rotated, !rotated] : [rotated];

      // 1. every legal placement, with the cost that does not depend on re-homing others
      const cands = [];
      for (const r of orientations) {
        const [w, h] = dims(item, r);
        for (let y = 0; y + h <= this.height; y++) {
          for (let x = 0; x + w <= this.width; x++) {
            const cells = this._cover(x, y, w, h);
            if (cells.some(i => occ[i] < 0)) continue; // touches a non-existent cell
            const drop = r === rotated ? x === ox && y === oy : x <= tx && tx < x + w && y <= ty && ty < y + h;
            if (!drop && opts.allowShift === false) continue;
            const dist = Math.hypot(x + w / 2 - (ox + hw / 2), y + h / 2 - (oy + hh / 2));
            const hit = new Set(cells.map(i => occ[i]).filter(Boolean)); // items in the way
            const base = drop ? dist : 1e5 + dist * 1e4;
            const flip = r !== rotated;
            cands.push({ x, y, r, drop, dist, hit, base, flip, lb: base + hit.size * 100 + (flip ? (hit.size ? 1000 : 1) : 0) });
          }
        }
      }

      // 2. cheapest first; stop when no remaining candidate can beat the best plan
      let best = null;
      for (const c of cands.sort((a, b) => a.lb - b.lb)) {
        if (best && c.lb >= best.cost) break;
        const moved = { id: item.id, x: c.x, y: c.y, rotated: c.r };
        const placed = { ...item, ...moved };
        const inWay = others.filter(o => c.hit.has(o.id));
        let sol = this._pack(inWay, this._occ([placed, ...others.filter(o => !c.hit.has(o.id))]));
        const repacked = !sol;
        sol = sol || this._pack(others, this._occ([placed]));
        if (!sol) continue;
        const changed = sol.filter(p => {
          const o = this.items.get(p.id);
          return p.x !== o.x || p.y !== o.y || p.rotated !== o.rotated;
        }).length;
        const cost = c.base + changed * 100 + (changed - c.hit.size) * 1e4 + (c.flip ? (changed ? 1000 : 1) : 0);
        if (!best || cost < best.cost) {
          best = {
            placements: [moved, ...sol], moved, displaced: c.hit.size, changed, autoRotated: c.flip,
            shifted: c.drop ? 0 : Math.round(c.dist * 10) / 10, repacked, cost,
          };
        }
      }
      return best;
    }

    moveItem(id, tx, ty, gx = 0, gy = 0, rotated, opts) {
      const plan = this.planMove(id, tx, ty, gx, gy, rotated, opts);
      if (plan) this.applyPlan(plan);
      return !!plan;
    }

    /** Rotate in place (others may shuffle), no auto-rotation or shifting. */
    rotateItem(id) {
      const it = this.items.get(id);
      return !!it && this.moveItem(id, it.x, it.y, 0, 0, !it.rotated, { allowAutoRotate: false, allowShift: false });
    }

    applyPlan(plan) {
      this._apply(plan.placements);
    }

    // ---------------------------------------------------------------- internals

    _apply(placements) {
      for (const p of placements) {
        const it = this.items.get(p.id);
        if (it) Object.assign(it, { x: p.x, y: p.y, rotated: p.rotated });
      }
    }

    /** Cell indices of a rectangle, or null if it leaves the grid. */
    _cover(x, y, w, h) {
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) return null;
      const cells = [];
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.push(j * this.width + i);
      return cells;
    }

    /** Occupancy: -1 invalid cell, 0 free, otherwise the occupying item's id. */
    _occ(items) {
      const occ = Array.from({ length: this.width * this.height }, (_, i) => (i < this.totalCells ? 0 : -1));
      for (const it of items) this._cover(it.x, it.y, ...dims(it)).forEach(i => (occ[i] = it.id));
      return occ;
    }

    /** All free placements of a w x h item: unrotated row-major, then rotated. */
    _spots(occ, w, h) {
      const spots = [];
      for (const rotated of w === h ? [false] : [false, true]) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const cells = this._cover(x, y, rotated ? h : w, rotated ? w : h);
            if (cells && cells.every(i => occ[i] === 0)) spots.push({ x, y, rotated });
          }
        }
      }
      return spots;
    }

    /**
     * Backtracking packer: place every `movable` item into the free cells of `occ`
     * (modified). Biggest first; each item tries free spots nearest its current
     * position first. Returns [{id,x,y,rotated}] or null.
     */
    _pack(movable, occ) {
      const order = [...movable].sort((a, b) => b.w * b.h - a.w * a.h || Math.max(b.w, b.h) - Math.max(a.w, a.h));
      const out = [];
      let nodes = 0;
      const put = (it, s, v) => this._cover(s.x, s.y, ...dims(it, s.rotated)).forEach(i => (occ[i] = v));
      const solve = k => {
        if (k === order.length) return true;
        const it = order[k];
        const near = s => (it.x == null ? 0 : Math.abs(s.x - it.x) + Math.abs(s.y - it.y) + (s.rotated !== it.rotated ? 0.5 : 0));
        for (const s of this._spots(occ, it.w, it.h).sort((a, b) => near(a) - near(b))) {
          if (++nodes > this.searchBudget) return false;
          put(it, s, it.id);
          out.push({ id: it.id, ...s });
          if (solve(k + 1)) return true;
          out.pop();
          put(it, s, 0);
          if (nodes > this.searchBudget) return false;
        }
        return false;
      };
      return solve(0) ? out : null;
    }
  }

  global.GridInventory = GridInventory;
})(typeof window !== 'undefined' ? window : globalThis);
