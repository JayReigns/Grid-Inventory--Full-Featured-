/**
 * GridInventory (plain-loop version of inventory_simple.js) - same public API and behaviour,
 * but written with ordinary for/while loops and if statements only.
 *
 * Not used anywhere in this file: Array methods such as map / filter / some / every / find /
 * reduce / flatMap / forEach / sort / Array.from, the spread operator (...), destructuring,
 * arrow functions, callbacks, Object.assign and Set. Sorting is done by hand with insertion sort. (`items` is still a Map because app.js reads it
 * with .values(), .size and for...of.)
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

  // ------------------------------------------------------------------ helpers

  /** [width, height] of an item in the given orientation (defaults to its own). */
  function dims(it, rot) {
    if (rot === undefined) rot = it.rotated;
    if (rot) return [it.h, it.w];
    return [it.w, it.h];
  }

  /** Copies every own property of `from` onto `to` (replacement for spread / Object.assign). */
  function copyProps(to, from) {
    for (const key in from) {
      if (Object.prototype.hasOwnProperty.call(from, key)) to[key] = from[key];
    }
    return to;
  }

  // Three insertion sorts, one per ordering, each with the comparison written inline
  // (no comparison function is passed around). All are stable: equal elements keep
  // their original order, because an element only moves past strictly "later" ones.

  /** Sorts candidate placements in place by ascending lower-bound cost `lb`. */
  function sortCandidatesByCost(list) {
    for (let i = 1; i < list.length; i++) {
      const x = list[i];
      let j = i - 1;
      while (j >= 0 && list[j].lb > x.lb) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = x;
    }
    return list;
  }

  /** Sorts free spots in place by ascending `near` (distance from the item's current position). */
  function sortSpotsByNear(list) {
    for (let i = 1; i < list.length; i++) {
      const x = list[i];
      let j = i - 1;
      while (j >= 0 && list[j].near > x.near) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = x;
    }
    return list;
  }

  /** Returns a NEW array of items, biggest area first, ties broken by longest side first. */
  function sortedBySize(items) {
    const list = items.slice();
    for (let i = 1; i < list.length; i++) {
      const x = list[i];
      const area = x.w * x.h;
      const side = Math.max(x.w, x.h);
      let j = i - 1;
      while (j >= 0) {
        const p = list[j];
        const pArea = p.w * p.h;
        // p should come after x when x has the bigger area, or equal area and a longer side
        if (pArea < area || (pArea === area && Math.max(p.w, p.h) < side)) {
          list[j + 1] = p;
          j--;
        } else {
          break;
        }
      }
      list[j + 1] = x;
    }
    return list;
  }

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

    /** All items as a plain array, in insertion order. */
    _list() {
      const list = [];
      for (const it of this.items.values()) list.push(it);
      return list;
    }

    get usedCells() {
      let sum = 0;
      for (const it of this.items.values()) sum += it.w * it.h;
      return sum;
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
      for (const it of this.items.values()) {
        const d = dims(it);
        if (x >= it.x && x < it.x + d[0] && y >= it.y && y < it.y + d[1]) return it;
      }
      return null;
    }

    /** { item, origin:{x,y,index}, size:{w,h}, cells:[{x,y,index}] } (item = null for empty cells) */
    _entry(item, x, y, w, h) {
      const indexes = this._cover(x, y, w, h);
      const cells = [];
      for (let k = 0; k < indexes.length; k++) {
        const index = indexes[k];
        cells.push({ x: index % this.width, y: Math.floor(index / this.width), index: index });
      }
      return { item: item, origin: cells[0], size: { w: w, h: h }, cells: cells };
    }

    getItemsWithCells() {
      const out = [];
      for (const it of this.items.values()) {
        const d = dims(it);
        out.push(this._entry(it, it.x, it.y, d[0], d[1]));
      }
      return out;
    }

    /** Every usable free cell, row-major, in the same shape with item = null. */
    getEmptyCells() {
      const occ = this._occ(this._list());
      const out = [];
      for (let i = 0; i < occ.length; i++) {
        if (occ[i] === 0) out.push(this._entry(null, i % this.width, Math.floor(i / this.width), 1, 1));
      }
      return out;
    }

    // ---------------------------------------------------------------- mutation

    /** Adds a w x h item (first free spot, else rearranging everything). Returns the item or false. */
    addItem(w, h, meta) {
      w = Math.floor(w);
      h = Math.floor(h);
      if (!(w >= 1 && h >= 1) || w * h > this.freeCells) return false;
      const item = copyProps({}, meta || {});
      item.id = this._nextId;
      item.w = w;
      item.h = h;
      item.rotated = false;
      item.x = null;
      item.y = null;

      const existing = this._list();
      const spots = this._spots(this._occ(existing), w, h);
      let repacked = false;
      if (spots.length > 0) {
        item.x = spots[0].x;
        item.y = spots[0].y;
        item.rotated = spots[0].rotated;
      } else {
        const all = existing.slice();
        all.push(item);
        const sol = this._pack(all, this._occ([]));
        if (!sol) return false;
        this._apply(sol);
        for (let k = 0; k < sol.length; k++) {
          if (sol[k].id === item.id) {
            item.x = sol[k].x;
            item.y = sol[k].y;
            item.rotated = sol[k].rotated;
            break;
          }
        }
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
    combineItem(srcId, dstId, w, h, meta, opts) {
      return this.combineFrom(this, srcId, dstId, w, h, meta, opts);
    }

    /**
     * combineItem where `src` lives in another inventory `from` (dst is in this one).
     * The new item is created HERE at dst's location; src is removed from `from` and dst from
     * this inventory, but only if the result fits (otherwise neither inventory changes).
     */
    combineFrom(from, srcId, dstId, w, h, meta, opts) {
      meta = meta || {};
      opts = opts || {};
      const src = from.items.get(srcId);
      const dst = this.items.get(dstId);
      w = Math.floor(w);
      h = Math.floor(h);
      if (!src || !dst || src === dst || !(w >= 1 && h >= 1)) return false;

      const snapshotIds = [];
      const snapshotItems = [];
      for (const it of this.items.values()) {
        snapshotIds.push(it.id);
        snapshotItems.push(it);
      }
      this.items.delete(dstId);
      if (from === this) this.items.delete(srcId);

      let plan = null;
      const item = copyProps({}, meta);
      item.id = this._nextId;
      item.w = w;
      item.h = h;
      item.rotated = w !== h && dst.rotated;
      item.x = dst.x;
      item.y = dst.y;
      if (w * h <= this.freeCells) {
        this.items.set(item.id, item); // sits at dst's spot; planMove treats it as the dragged item
        plan = this.planMove(item.id, dst.x, dst.y, 0, 0, undefined, opts);
      }
      if (!plan) {
        this.items.clear(); // restore src, dst and the original order
        for (let k = 0; k < snapshotIds.length; k++) this.items.set(snapshotIds[k], snapshotItems[k]);
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
    planMove(id, tx, ty, gx, gy, rotated, opts) {
      const item = this.items.get(id);
      return item ? this._plan(item, tx, ty, gx || 0, gy || 0, rotated, opts) : null;
    }

    /**
     * Dry run of putting a COPY of `src` (an item from any inventory) into this one at a
     * drop position, exactly like planMove (same costs: rotate to avoid displacing, displace
     * and re-home others, or slide to the nearest feasible spot).
     * plan.moved.id is the id the new item would get here.
     */
    planInsert(src, tx, ty, gx, gy, rotated, opts) {
      if (!src || !(src.w >= 1 && src.h >= 1) || src.w * src.h > this.freeCells) return null;
      const item = copyProps({}, src);
      item.id = this._nextId;
      item.x = null;
      item.y = null;
      item.rotated = rotated === undefined ? !!src.rotated : !!rotated;
      return this._plan(item, tx, ty, gx || 0, gy || 0, item.rotated, opts);
    }

    /** Adds a copy of `src` (from any inventory) at a drop position. Returns the new item or false. */
    insertItem(src, tx, ty, gx, gy, rotated, opts) {
      const plan = this.planInsert(src, tx, ty, gx, gy, rotated, opts);
      if (!plan) return false;
      const item = copyProps(copyProps({}, src), plan.moved);
      item._repacked = plan.repacked;
      this.applyPlan(plan); // re-homes the others; the new id is not in the map yet, so it is skipped
      this.items.set(item.id, item);
      this._nextId++;
      return item;
    }

    /**
     * Moves item `id` out of inventory `from` into this one at a drop position (the cross-inventory
     * moveItem). The source is only touched if the item fits here. Returns the new item or false.
     */
    transferItem(from, id, tx, ty, gx, gy, rotated, opts) {
      if (from === this) return this.moveItem(id, tx, ty, gx, gy, rotated, opts) ? this.items.get(id) : false;
      const src = from.items.get(id);
      const item = src ? this.insertItem(src, tx, ty, gx, gy, rotated, opts) : false;
      if (item) from.items.delete(id);
      return item;
    }

    _plan(item, tx, ty, gx, gy, rotated, opts) {
      opts = opts || {};
      rotated = rotated === undefined ? item.rotated : !!rotated;

      const others = [];
      for (const o of this.items.values()) {
        if (o.id !== item.id) others.push(o);
      }
      const occ = this._occ(others);
      const held = dims(item, rotated);
      const hw = held[0];
      const hh = held[1];
      const ox = tx - gx; // exact drop origin in the held orientation
      const oy = ty - gy;
      const orientations = [rotated];
      if (opts.allowAutoRotate !== false && item.w !== item.h) orientations.push(!rotated);

      // 1. every legal placement, with the cost that does not depend on re-homing others
      const cands = [];
      for (let oi = 0; oi < orientations.length; oi++) {
        const r = orientations[oi];
        const d = dims(item, r);
        const w = d[0];
        const h = d[1];
        for (let y = 0; y + h <= this.height; y++) {
          for (let x = 0; x + w <= this.width; x++) {
            const cells = this._cover(x, y, w, h);
            let invalid = false;
            const hit = {}; // ids of the items in the way
            let hitCount = 0;
            for (let k = 0; k < cells.length; k++) {
              const v = occ[cells[k]];
              if (v < 0) {
                invalid = true; // touches a non-existent cell
                break;
              }
              if (v !== 0 && hit[v] !== true) {
                hit[v] = true;
                hitCount++;
              }
            }
            if (invalid) continue;

            let drop;
            if (r === rotated) drop = x === ox && y === oy;
            else drop = x <= tx && tx < x + w && y <= ty && ty < y + h;
            if (!drop && opts.allowShift === false) continue;

            const dist = Math.hypot(x + w / 2 - (ox + hw / 2), y + h / 2 - (oy + hh / 2));
            const base = drop ? dist : 1e5 + dist * 1e4;
            const flip = r !== rotated;
            let lb = base + hitCount * 100;
            if (flip) lb += hitCount > 0 ? 1000 : 1;
            cands.push({ x: x, y: y, r: r, drop: drop, dist: dist, hit: hit, hitCount: hitCount, base: base, flip: flip, lb: lb });
          }
        }
      }

      // 2. cheapest first; stop when no remaining candidate can beat the best plan
      let best = null;
      const ordered = sortCandidatesByCost(cands);
      for (let ci = 0; ci < ordered.length; ci++) {
        const c = ordered[ci];
        if (best && c.lb >= best.cost) break;

        const moved = { id: item.id, x: c.x, y: c.y, rotated: c.r };
        const placed = copyProps(copyProps({}, item), moved);

        const inWay = [];
        const notInWay = [placed];
        for (let k = 0; k < others.length; k++) {
          if (c.hit[others[k].id] === true) inWay.push(others[k]);
          else notInWay.push(others[k]);
        }

        let sol = this._pack(inWay, this._occ(notInWay));
        const repacked = !sol;
        if (!sol) sol = this._pack(others, this._occ([placed]));
        if (!sol) continue;

        let changed = 0;
        for (let k = 0; k < sol.length; k++) {
          const p = sol[k];
          const o = this.items.get(p.id);
          if (p.x !== o.x || p.y !== o.y || p.rotated !== o.rotated) changed++;
        }
        let cost = c.base + changed * 100 + (changed - c.hitCount) * 1e4;
        if (c.flip) cost += changed > 0 ? 1000 : 1;

        if (!best || cost < best.cost) {
          const placements = [moved];
          for (let k = 0; k < sol.length; k++) placements.push(sol[k]);
          best = {
            placements: placements,
            moved: moved,
            displaced: c.hitCount,
            changed: changed,
            autoRotated: c.flip,
            shifted: c.drop ? 0 : Math.round(c.dist * 10) / 10,
            repacked: repacked,
            cost: cost,
          };
        }
      }
      return best;
    }

    moveItem(id, tx, ty, gx, gy, rotated, opts) {
      const plan = this.planMove(id, tx, ty, gx, gy, rotated, opts);
      if (plan) this.applyPlan(plan);
      return !!plan;
    }

    /** Rotate in place (others may shuffle), no auto-rotation or shifting. */
    rotateItem(id) {
      const it = this.items.get(id);
      if (!it) return false;
      return this.moveItem(id, it.x, it.y, 0, 0, !it.rotated, { allowAutoRotate: false, allowShift: false });
    }

    applyPlan(plan) {
      this._apply(plan.placements);
    }

    // ---------------------------------------------------------------- internals

    _apply(placements) {
      for (let k = 0; k < placements.length; k++) {
        const p = placements[k];
        const it = this.items.get(p.id);
        if (it) {
          it.x = p.x;
          it.y = p.y;
          it.rotated = p.rotated;
        }
      }
    }

    /** Cell indices of a rectangle, or null if it leaves the grid. */
    _cover(x, y, w, h) {
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) return null;
      const cells = [];
      for (let j = y; j < y + h; j++) {
        for (let i = x; i < x + w; i++) cells.push(j * this.width + i);
      }
      return cells;
    }

    /** Occupancy: -1 invalid cell, 0 free, otherwise the occupying item's id. */
    _occ(items) {
      const size = this.width * this.height;
      const occ = [];
      for (let i = 0; i < size; i++) occ.push(i < this.totalCells ? 0 : -1);
      for (let n = 0; n < items.length; n++) {
        const it = items[n];
        const d = dims(it);
        const cells = this._cover(it.x, it.y, d[0], d[1]);
        for (let k = 0; k < cells.length; k++) occ[cells[k]] = it.id;
      }
      return occ;
    }

    /** All free placements of a w x h item: unrotated row-major, then rotated. */
    _spots(occ, w, h) {
      const spots = [];
      const orientations = w === h ? [false] : [false, true];
      for (let oi = 0; oi < orientations.length; oi++) {
        const rotated = orientations[oi];
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const cells = this._cover(x, y, rotated ? h : w, rotated ? w : h);
            if (!cells) continue;
            let free = true;
            for (let k = 0; k < cells.length; k++) {
              if (occ[cells[k]] !== 0) {
                free = false;
                break;
              }
            }
            if (free) spots.push({ x: x, y: y, rotated: rotated });
          }
        }
      }
      return spots;
    }

    /** Sets every cell covered by item `it` placed at spot `s` to value `v`. */
    _fill(occ, it, s, v) {
      const d = dims(it, s.rotated);
      const cells = this._cover(s.x, s.y, d[0], d[1]);
      for (let k = 0; k < cells.length; k++) occ[cells[k]] = v;
    }

    /**
     * Backtracking packer: place every `movable` item into the free cells of `occ`
     * (modified). Biggest first; each item tries free spots nearest its current
     * position first. Returns [{id,x,y,rotated}] or null.
     */
    _pack(movable, occ) {
      const order = sortedBySize(movable);
      const out = [];
      const self = this;
      let nodes = 0;

      function solve(k) {
        if (k === order.length) return true;
        const it = order[k];
        const spots = self._spots(occ, it.w, it.h);
        // distance from the item's current position (spots are tried nearest first)
        for (let n = 0; n < spots.length; n++) {
          const s = spots[n];
          if (it.x == null) s.near = 0;
          else s.near = Math.abs(s.x - it.x) + Math.abs(s.y - it.y) + (s.rotated !== it.rotated ? 0.5 : 0);
        }
        const sorted = sortSpotsByNear(spots);
        for (let n = 0; n < sorted.length; n++) {
          const s = sorted[n];
          nodes++;
          if (nodes > self.searchBudget) return false;
          self._fill(occ, it, s, it.id);
          out.push({ id: it.id, x: s.x, y: s.y, rotated: s.rotated });
          if (solve(k + 1)) return true;
          out.pop();
          self._fill(occ, it, s, 0);
          if (nodes > self.searchBudget) return false;
        }
        return false;
      }

      return solve(0) ? out : null;
    }
  }

  global.GridInventory = GridInventory;
})(typeof window !== 'undefined' ? window : globalThis);
