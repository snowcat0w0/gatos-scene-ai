/**
 * Heights of the floor from ledges and steps (pure, no Foundry or DOM globals).
 *
 * The model does not say how high every spot of the map is. It marks the lines where the height changes — cliff
 * edges ("ledges") and the middle of stairs and slopes ("steps") — and which side of each line is the higher one.
 * The rest is worked out here:
 *
 *   1. Walls, ledges and steps are drawn into a coarse raster. They cut the map into areas.
 *   2. Every ledge or step lies between two areas and says "this one is higher than that one by so much".
 *   3. Starting from the largest area of each connected group (the main floor, height 0), the heights of the
 *      neighbours follow from those statements.
 *
 * A line that does not separate two areas — because it stops short of the walls and one can walk around its end —
 * changes nothing and is reported as unresolved. So is a line whose higher side the model did not give.
 *
 * Coordinates are in grid cells; heights in whatever unit the drops are given in (the scene's distance unit).
 */
import { traceOutlines, simplifyClosed } from "./segment.js";

/**
 * @typedef HeightLine
 * @property {number[]} c          segment `[x1, y1, x2, y2]` in cells
 * @property {number} side         which side is higher: the sign of the cross product of the segment's direction
 *                                 and the vector to a point on the higher side; 0 = not known
 * @property {number|null} drop    height difference, or null for the default
 */

/**
 * @param {object} p
 * @param {number[][]} p.walls                 segments in cells
 * @param {HeightLine[]} p.ledges
 * @param {HeightLine[]} [p.steps]
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {number} p.defaultDrop               height difference of a line that does not state one
 * @param {number} [p.res]                     raster pixels per cell (default: 8, fewer on very large maps)
 * @returns {{
 *   areas: Array<{elevation: number, size: number, shapes: Array<{points: number[], hole: boolean}>}>,
 *   ledges: Array<{bottom: number, top: number}|null>,
 *   steps: Array<{bottom: number, top: number}|null>,
 *   stats: {resolved: number, unresolved: number, conflicts: number}
 * }}  areas: size in cells², shape points as a flat [x, y, x, y, …] list in cells; ledges / steps: the heights
 *     on the low and the high side of each input line, or null where they could not be worked out
 */
export function computeHeights({ walls, ledges, steps = [], cols, rows, defaultDrop, res }) {
  const r = res ?? Math.max(4, Math.min(8, Math.floor(Math.sqrt(2e6 / Math.max(1, cols * rows)))));
  // One pixel of margin all round, itself a barrier: areas never run around the outside of the map, and their
  // outlines are closed.
  const w = cols * r + 2;
  const h = rows * r + 2;
  const n = w * h;
  /** 0 = free, -1 = wall or margin, k > 0 = line k - 1 (ledges first, then steps). */
  const kind = new Int32Array(n);
  for (let x = 0; x < w; x++) kind[x] = kind[(h - 1) * w + x] = -1;
  for (let y = 0; y < h; y++) kind[y * w] = kind[y * w + w - 1] = -1;

  const px = (v) => Math.max(0, Math.min(w - 1, Math.floor(v * r) + 1));
  const py = (v) => Math.max(0, Math.min(h - 1, Math.floor(v * r) + 1));
  /** Bresenham: an 8-connected line, which a 4-connected fill cannot cross. Stops when `visit` returns false. */
  const trace = (x0, y0, x1, y1, visit) => {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (visit(x0, y0) === false) return;
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  };
  for (const [x1, y1, x2, y2] of walls) trace(px(x1), py(y1), px(x2), py(y2), (x, y) => void (kind[y * w + x] = -1));
  const lines = [...ledges, ...steps];
  lines.forEach((line, i) => {
    const [x1, y1, x2, y2] = line.c;
    trace(px(x1), py(y1), px(x2), py(y2), (x, y) => {
      if (kind[y * w + x] === 0) kind[y * w + x] = i + 1;
    });
  });

  // A line that stops a little short of a wall or of another line is carried on to it: the model rarely ends a
  // ledge exactly on the wall, and a gap of a few pixels would let the two sides run together.
  const reach = Math.max(2, Math.round(0.75 * r));
  lines.forEach((line, i) => {
    const [x1, y1, x2, y2] = line.c;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-6) return;
    for (const [ex, ey, dx, dy] of [
      [x2, y2, (x2 - x1) / len, (y2 - y1) / len],
      [x1, y1, (x1 - x2) / len, (y1 - y2) / len],
    ]) {
      const cx = px(ex);
      const cy = py(ey);
      // Already touching something else?
      let joined = false;
      for (let yy = cy - 1; yy <= cy + 1 && !joined; yy++) {
        for (let xx = cx - 1; xx <= cx + 1; xx++) {
          const k = kind[yy * w + xx];
          if (k !== 0 && k !== i + 1) {
            joined = true;
            break;
          }
        }
      }
      if (joined) continue;
      const tx = Math.max(0, Math.min(w - 1, Math.round(cx + dx * reach)));
      const ty = Math.max(0, Math.min(h - 1, Math.round(cy + dy * reach)));
      const passed = [];
      let hit = false;
      trace(cx, cy, tx, ty, (x, y) => {
        const k = kind[y * w + x];
        if (k !== 0 && k !== i + 1) {
          hit = true;
          return false;
        }
        if (k === 0) passed.push(y * w + x);
        return true;
      });
      if (hit) for (const p of passed) kind[p] = i + 1;
    }
  });

  /* ---------- areas ---------- */
  const area = new Int32Array(n);
  const sizes = [0];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (kind[start] !== 0 || area[start]) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    area[start] = id;
    while (head < tail) {
      const i = queue[head++];
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (kind[j] === 0 && !area[j]) {
          area[j] = id;
          queue[tail++] = j;
        }
      }
    }
    sizes.push(tail);
  }

  /* ---------- which area is higher than which ---------- */
  /**
   * The area a little way off a point, across the line: the first free pixel within half a cell. A wall in between
   * ends the search — what lies behind a wall is not beside the line.
   */
  const areaBeside = (x, y, nx, ny) => {
    for (let d = 1.5; d <= r / 2 + 1.5; d += 1) {
      const xx = Math.round(x + nx * d);
      const yy = Math.round(y + ny * d);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || kind[yy * w + xx] === -1) return 0;
      if (area[yy * w + xx]) return area[yy * w + xx];
    }
    return 0;
  };
  const rules = lines.map((line) => {
    const [x1, y1, x2, y2] = line.c;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!line.side || len < 1e-6) return null;
    // Unit normal pointing to the side where the cross product is positive.
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const votes = new Map();
    const count = Math.max(1, Math.round(len * r));
    for (let k = 0; k <= count; k++) {
      const x = (x1 + ((x2 - x1) * k) / count) * r + 1;
      const y = (y1 + ((y2 - y1) * k) / count) * r + 1;
      const plus = areaBeside(x, y, nx, ny);
      const minus = areaBeside(x, y, -nx, -ny);
      if (!plus || !minus || plus === minus) continue;
      const key = line.side > 0 ? `${plus}|${minus}` : `${minus}|${plus}`;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
    let best = null;
    let apart = 0;
    for (const [key, v] of votes) {
      apart += v;
      if (!best || v > best[1]) best = [key, v];
    }
    // Where the line has the same area on both sides — it runs on into the rock, or one can walk around its end
    // there — it says nothing. Where it does separate two areas, it has to be the same two for most of the way.
    if (!best || best[1] < Math.max(2, apart / 2)) return null;
    const [hi, lo] = best[0].split("|").map(Number);
    return { hi, lo, drop: line.drop ?? defaultDrop };
  });

  /* ---------- heights ---------- */
  const links = new Map();
  const link = (a, b, diff) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a).push([b, diff]);
  };
  for (const rule of rules) {
    if (!rule) continue;
    link(rule.lo, rule.hi, rule.drop);
    link(rule.hi, rule.lo, -rule.drop);
  }
  const height = new Map();
  let conflicts = 0;
  const pending = [...links.keys()].sort((a, b) => sizes[b] - sizes[a]);
  for (const base of pending) {
    if (height.has(base)) continue;
    // The largest area of a group that has no height yet is that group's main floor.
    height.set(base, 0);
    const stack = [base];
    while (stack.length) {
      const a = stack.pop();
      for (const [b, diff] of links.get(a)) {
        const value = Math.round((height.get(a) + diff) * 1000) / 1000;
        if (!height.has(b)) {
          height.set(b, value);
          stack.push(b);
        } else if (Math.abs(height.get(b) - value) > 1e-6) conflicts++;
      }
    }
  }
  // Every contradiction is met from both of its ends.
  conflicts = Math.ceil(conflicts / 2);

  /* ---------- result ---------- */
  const resolved = rules.map((rule) => {
    if (!rule) return null;
    const bottom = height.get(rule.lo);
    const top = height.get(rule.hi);
    // Left over from a contradiction: the two sides ended up level or the wrong way round.
    return top > bottom ? { bottom, top } : null;
  });

  const round = (v, max) => Math.max(0, Math.min(max, Math.round(((v - 1) / r) * 1000) / 1000));
  const areas = [];
  const mask = new Uint8Array(n);
  for (const [id, elevation] of height) {
    for (let i = 0; i < n; i++) mask[i] = area[i] === id ? 1 : 0;
    const loops = [];
    for (const line of traceOutlines(mask, w, h)) {
      if (!line.closed) continue;
      const simple = simplifyClosed(line.points, 0.9).slice(0, -1);
      if (simple.length < 3) continue;
      let twice = 0;
      for (let i = 0; i < simple.length; i++) {
        const [ax, ay] = simple[i];
        const [bx, by] = simple[(i + 1) % simple.length];
        twice += ax * by - bx * ay;
      }
      loops.push({ points: simple, size: Math.abs(twice) / 2 / (r * r) });
    }
    if (!loops.length) continue;
    // An area is one piece, so it has one outer outline — the largest loop; the others are holes in it.
    loops.sort((a, b) => b.size - a.size);
    const shapes = loops
      .filter((loop, i) => i === 0 || loop.size >= 0.25)
      .map((loop, i) => ({ points: loop.points.flatMap(([x, y]) => [round(x, cols), round(y, rows)]), hole: i > 0 }));
    areas.push({ elevation, size: sizes[id] / (r * r), shapes });
  }
  areas.sort((a, b) => b.size - a.size);

  const done = resolved.filter(Boolean).length;
  return {
    areas,
    ledges: resolved.slice(0, ledges.length),
    steps: resolved.slice(ledges.length),
    stats: { resolved: done, unresolved: lines.length - done, conflicts },
  };
}
