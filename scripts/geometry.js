/**
 * Geometry for wall post-processing (pure, no Foundry globals). All coordinates are in grid cells unless a
 * function says otherwise; a segment is `[x1, y1, x2, y2]`.
 */

const EPS = 1e-6;

/* -------------------------------------------- */
/*  Tiles                                       */
/* -------------------------------------------- */

/**
 * Split `total` cells into tiles of at most `tileCells` cells shown to the model. Neighbouring tiles overlap by
 * one cell of context on each side (`view`); every cell belongs to exactly one tile's `core`.
 * @returns {Array<{core: [number, number], view: [number, number]}>}  half-open cell ranges
 */
export function splitAxis(total, tileCells) {
  if (total <= tileCells) return [{ core: [0, total], view: [0, total] }];
  const coreMax = Math.max(1, tileCells - 2);
  const count = Math.ceil(total / coreMax);
  const size = Math.ceil(total / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = i * size;
    const b = Math.min(total, a + size);
    if (a >= b) break;
    out.push({ core: [a, b], view: [Math.max(0, a - 1), Math.min(total, b + 1)] });
  }
  return out;
}

/**
 * Tiles covering a cols × rows map.
 * @returns {Array<{index: number, core: {x0, y0, x1, y1}, view: {x0, y0, x1, y1}}>}
 */
export function planTiles(cols, rows, tileCells) {
  const xs = splitAxis(cols, tileCells);
  const ys = splitAxis(rows, tileCells);
  const tiles = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({
        index: tiles.length,
        core: { x0: x.core[0], y0: y.core[0], x1: x.core[1], y1: y.core[1] },
        view: { x0: x.view[0], y0: y.view[0], x1: x.view[1], y1: y.view[1] },
      });
    }
  }
  return tiles;
}

/* -------------------------------------------- */
/*  Points and segments                         */
/* -------------------------------------------- */

/** Round to the nearest multiple of `step` (step <= 0: keep 3 decimals). */
export function snap(value, step) {
  if (!(step > 0)) return Math.round(value * 1000) / 1000;
  return Math.round(Math.round(value / step) * step * 1e6) / 1e6;
}

/** Consecutive point pairs of a polyline as segments; zero-length pieces are dropped. */
export function polylineSegments(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS) continue;
    out.push([x1, y1, x2, y2]);
  }
  return out;
}

/**
 * Clip a segment to a rectangle (Liang–Barsky).
 * @returns {number[]|null} the clipped segment, or null when nothing (or a single point) is left
 */
export function clipSegment([x1, y1, x2, y2], { x0, y0, x1: rx1, y1: ry1 }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, x1 - x0],
    [dx, rx1 - x1],
    [-dy, y1 - y0],
    [dy, ry1 - y1],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < EPS) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t1 - t0 < EPS) return null;
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

/* -------------------------------------------- */
/*  Colinear merging                            */
/* -------------------------------------------- */

const keyNum = (n) => (Math.round(n * 1000) / 1000 || 0).toFixed(3);

/** The infinite line a segment lies on (canonical direction, signed offset) and its interval along it. */
function lineOf([x1, y1, x2, y2]) {
  let dx = x2 - x1;
  let dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  dx /= len;
  dy /= len;
  if (dx < -EPS || (Math.abs(dx) <= EPS && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  const off = -dy * x1 + dx * y1;
  const a = dx * x1 + dy * y1;
  const b = dx * x2 + dy * y2;
  return { dx, dy, off, t0: Math.min(a, b), t1: Math.max(a, b), key: `${keyNum(dx)}|${keyNum(dy)}|${keyNum(off)}` };
}

const pointOn = (line, t) => [line.dx * t - line.dy * line.off, line.dy * t + line.dx * line.off];

/** Union of intervals; intervals closer than `gap` are joined. */
function unionIntervals(intervals, gap = EPS) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Remove `cuts` (a union) from `intervals` (a union). */
function subtractIntervals(intervals, cuts) {
  let out = intervals.map((i) => [...i]);
  for (const [c0, c1] of cuts) {
    const next = [];
    for (const [a, b] of out) {
      if (c1 <= a + EPS || c0 >= b - EPS) {
        next.push([a, b]);
        continue;
      }
      if (c0 - a > EPS) next.push([a, c0]);
      if (b - c1 > EPS) next.push([c1, b]);
    }
    out = next;
  }
  return out;
}

function groupByLine(segments) {
  const groups = new Map();
  for (const seg of segments) {
    const line = lineOf(seg);
    if (!line) continue;
    let g = groups.get(line.key);
    if (!g) groups.set(line.key, (g = { line, intervals: [] }));
    g.intervals.push([line.t0, line.t1]);
  }
  return groups;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6 || 0;

function emit(groups, minLength) {
  const out = [];
  for (const { line, intervals } of groups.values()) {
    for (const [a, b] of intervals) {
      if (b - a < minLength) continue;
      const [x1, y1] = pointOn(line, a);
      const [x2, y2] = pointOn(line, b);
      out.push([round6(x1), round6(y1), round6(x2), round6(y2)]);
    }
  }
  return out;
}

/**
 * Merge overlapping and touching colinear segments into single segments.
 * @param {number[][]} segments
 * @param {number} [minLength]  drop results shorter than this
 */
export function mergeColinear(segments, minLength = EPS) {
  const groups = groupByLine(segments);
  for (const g of groups.values()) g.intervals = unionIntervals(g.intervals);
  return emit(groups, minLength);
}

/**
 * Merge walls, merge doors per type, and open the walls where a door lies on them (a wall across a doorway
 * would keep the door from ever letting anyone through).
 * @param {number[][]} walls
 * @param {Array<{c: number[], type: string}>} doors
 * @param {number} [minLength]
 * @returns {{walls: number[][], doors: Array<{c: number[], type: string}>}}
 */
export function mergeWallsAndDoors(walls, doors, minLength = EPS) {
  const doorOut = [];
  const cuts = new Map();
  const byType = new Map();
  for (const d of doors) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type).push(d.c);
  }
  for (const [type, segs] of byType) {
    const groups = groupByLine(segs);
    for (const [key, g] of groups) {
      g.intervals = unionIntervals(g.intervals);
      cuts.set(key, unionIntervals([...(cuts.get(key) ?? []), ...g.intervals]));
    }
    for (const c of emit(groups, minLength)) doorOut.push({ c, type });
  }
  const wallGroups = groupByLine(walls);
  for (const [key, g] of wallGroups) {
    g.intervals = unionIntervals(g.intervals);
    if (cuts.has(key)) g.intervals = subtractIntervals(g.intervals, cuts.get(key));
  }
  return { walls: emit(wallGroups, minLength), doors: doorOut };
}

/** Keep one of several points that lie within `radius` of each other (first wins). */
export function dedupePoints(points, radius) {
  const out = [];
  for (const p of points) {
    if (out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) <= radius)) continue;
    out.push(p);
  }
  return out;
}

/* -------------------------------------------- */
/*  Model output → geometry                     */
/* -------------------------------------------- */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toNum = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
const toPoint = (p) => {
  if (Array.isArray(p) && p.length >= 2) {
    const x = toNum(p[0]);
    const y = toNum(p[1]);
    return isNum(x) && isNum(y) ? [x, y] : null;
  }
  if (p && typeof p === "object") {
    const x = toNum(p.x);
    const y = toNum(p.y);
    return isNum(x) && isNum(y) ? [x, y] : null;
  }
  return null;
};

/** A wall entry as a list of points: accepts [[x,y],…], [x1,y1,x2,y2] and {points:[…]}. */
function toPolyline(entry) {
  if (entry && !Array.isArray(entry) && typeof entry === "object") entry = entry.points ?? entry.c ?? entry.path;
  if (!Array.isArray(entry)) return null;
  if (entry.length >= 4 && entry.every((v) => isNum(toNum(v)))) {
    const n = entry.map(toNum);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    return pts;
  }
  const pts = entry.map(toPoint).filter(Boolean);
  return pts.length >= 2 ? pts : null;
}

const DOOR_TYPES = new Set(["door", "secret", "window"]);
export const LIGHT_KIND_NAMES = ["torch", "candle", "lantern", "fire", "magic", "lava", "lamp", "window"];

/**
 * Normalise one tile reply into segments in map cells.
 * @param {any} reply                 parsed JSON of the model
 * @param {{view: object, core: object}} tile
 * @param {object} options
 * @param {number} options.snapStep   snap step in cells
 * @returns {{walls: number[][], doors: Array<{c: number[], type: string}>, lights: Array<{x, y, kind, color}>}}
 */
export function normalizeTileReply(reply, tile, { snapStep = 0.5 } = {}) {
  const { view, core } = tile;
  const vw = view.x1 - view.x0;
  const vh = view.y1 - view.y0;
  // A point slightly outside the picture is a rounding slip; one far outside is a hallucination.
  const inView = ([x, y]) => x >= -0.5 && y >= -0.5 && x <= vw + 0.5 && y <= vh + 0.5;
  const clampView = ([x, y]) => [Math.max(0, Math.min(vw, x)), Math.max(0, Math.min(vh, y))];
  const toMap = ([x, y]) => [snap(view.x0 + x, snapStep), snap(view.y0 + y, snapStep)];

  const walls = [];
  for (const entry of Array.isArray(reply?.walls) ? reply.walls : []) {
    const line = toPolyline(entry);
    if (!line) continue;
    const pts = line.filter(inView).map(clampView).map(toMap);
    for (const seg of polylineSegments(pts)) {
      const clipped = clipSegment(seg, core);
      if (clipped) walls.push(clipped);
    }
  }

  const doors = [];
  for (const entry of Array.isArray(reply?.doors) ? reply.doors : []) {
    let line = null;
    let type = "door";
    if (entry && !Array.isArray(entry) && typeof entry === "object") {
      if (typeof entry.type === "string" && DOOR_TYPES.has(entry.type.toLowerCase())) type = entry.type.toLowerCase();
      const a = toPoint(entry.a ?? entry.from);
      const b = toPoint(entry.b ?? entry.to);
      line = a && b ? [a, b] : toPolyline(entry);
    } else line = toPolyline(entry);
    if (!line) continue;
    const pts = line.filter(inView).map(clampView).map(toMap);
    for (const seg of polylineSegments(pts)) {
      const clipped = clipSegment(seg, core);
      if (clipped) doors.push({ c: clipped, type });
    }
  }

  const lights = [];
  for (const entry of Array.isArray(reply?.lights) ? reply.lights : []) {
    const p = toPoint(entry);
    if (!p || !inView(p)) continue;
    const [lx, ly] = clampView(p);
    const x = Math.round((view.x0 + lx) * 100) / 100;
    const y = Math.round((view.y0 + ly) * 100) / 100;
    // Half-open ownership, except at the far edge of the map where no neighbouring tile would claim the point.
    const ownX = x >= core.x0 && (x < core.x1 || (x === core.x1 && core.x1 === view.x1));
    const ownY = y >= core.y0 && (y < core.y1 || (y === core.y1 && core.y1 === view.y1));
    if (!ownX || !ownY) continue;
    const kindRaw = typeof entry?.kind === "string" ? entry.kind.toLowerCase() : "";
    const kind = LIGHT_KIND_NAMES.includes(kindRaw) ? kindRaw : "torch";
    const color = typeof entry?.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color.toLowerCase() : null;
    lights.push({ x, y, kind, color });
  }

  return { walls, doors, lights };
}
