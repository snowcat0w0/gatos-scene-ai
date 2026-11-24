/**
 * Pull walls given as coordinates onto the line that is actually drawn (pure, no Foundry or DOM globals).
 *
 * A vision model that traces walls against the numbered grid gets their course and their openings right, but only
 * to about half a cell. The drawn line is somewhere within that half cell, so it is looked for there:
 *
 *   1. The walls are joined into chains: runs of segments between junctions, wall ends and doors.
 *   2. Along each chain, every fifth of a cell, the picture is probed across the chain for the strongest change of
 *      colour — the edge of the floor or the drawn wall line.
 *   3. One offset per probe is chosen for the whole chain at once (dynamic programming): strong edges are
 *      rewarded, jumping from one edge to another between neighbouring probes is not. Where nothing is drawn the
 *      chain carries on between the parts that are.
 *   4. A chain without a clear line under it stays exactly where the model put it.
 *
 * Only positions move. What is connected stays connected and what is open stays open: junctions are moved as one
 * point, and doors travel with the wall ends they sit between.
 *
 * Coordinates are in grid cells; a segment is `[x1, y1, x2, y2]`.
 */
import { boxBlur, simplifyOpen, simplifyClosed } from "./segment.js";

const EPS = 1e-6;
const nodeKey = (x, y) => `${Math.round(x * 1000)}|${Math.round(y * 1000)}`;
const round3 = (v) => Math.round(v * 1000) / 1000 || 0;

/** Cut walls where the end of another wall or door touches them, so that the meeting point becomes a junction. */
function splitAtTouches(walls, points) {
  const out = [];
  for (const [x1, y1, x2, y2] of walls) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) continue;
    const len = Math.sqrt(len2);
    const cuts = [];
    for (const [px, py] of points) {
      const t = ((px - x1) * dx + (py - y1) * dy) / len2;
      if (t * len < 0.02 || (1 - t) * len < 0.02) continue;
      if (Math.abs((px - x1) * dy - (py - y1) * dx) / len > 0.02) continue;
      cuts.push(t);
    }
    if (!cuts.length) {
      out.push([x1, y1, x2, y2]);
      continue;
    }
    cuts.sort((a, b) => a - b);
    let from = 0;
    for (const t of [...cuts, 1]) {
      if ((t - from) * len < 0.02) continue;
      out.push([x1 + from * dx, y1 + from * dy, x1 + t * dx, y1 + t * dy]);
      from = t;
    }
  }
  return out;
}

/**
 * @param {{width: number, height: number, data: ArrayLike<number>}} image  RGBA, exactly cols·cell × rows·cell
 *        pixels (image.js renderWork); alpha 0 marks pixels outside the map picture
 * @param {number[][]} walls                       segments in cells
 * @param {Array<{c: number[], type: string}>} doors
 * @param {object} dims
 * @param {number} dims.cols
 * @param {number} dims.rows
 * @param {number} dims.cell                       pixels per cell
 * @param {number} [dims.reach=0.6]                how far from the given position the line is looked for, in cells
 * @param {number} [dims.step=0.2]                 distance between probes along a wall, in cells
 * @param {number} [dims.tolerance=0.08]           simplification of the result, in cells
 * @returns {{walls: number[][], doors: Array<{c: number[], type: string}>, chains: number, moved: number}}
 */
export function refineWalls({ width: w, height: h, data }, walls, doors, { cols, rows, cell, reach = 0.6, step = 0.2, tolerance = 0.08 }) {
  const unchanged = { walls, doors, chains: 0, moved: 0 };
  if (!walls.length) return unchanged;

  /* ---------- the picture ---------- */
  const n = w * h;
  const raw = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const valid = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    raw[0][i] = data[j];
    raw[1][i] = data[j + 1];
    raw[2][i] = data[j + 2];
    valid[i] = data[j + 3] > 0 ? 1 : 0;
  }
  const ch = raw.map((c) => boxBlur(c, w, h, 1));
  const bilinear = (c, x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    return (c[i] * (1 - fx) + c[i + 1] * fx) * (1 - fy) + (c[i + w] * (1 - fx) + c[i + w + 1] * fx) * fy;
  };
  const usable = (x, y) => x >= 0 && y >= 0 && x < w - 1 && y < h - 1 && valid[Math.round(y) * w + Math.round(x)];
  // Half the distance over which the change of colour across the line is measured, in pixels.
  const half = Math.max(1, cell / 12);
  /** Change of colour across a line through pixel (x, y) with unit normal (nx, ny). */
  const strength = (x, y, nx, ny) => {
    const ax = x + nx * half;
    const ay = y + ny * half;
    const bx = x - nx * half;
    const by = y - ny * half;
    if (!usable(ax, ay) || !usable(bx, by)) return 0;
    let sum = 0;
    for (const c of ch) {
      const d = bilinear(c, ax, ay) - bilinear(c, bx, by);
      sum += d * d;
    }
    return Math.sqrt(sum);
  };

  /* ---------- walls → graph → chains ---------- */
  const touchPoints = [];
  for (const s of walls) touchPoints.push([s[0], s[1]], [s[2], s[3]]);
  for (const d of doors) touchPoints.push([d.c[0], d.c[1]], [d.c[2], d.c[3]]);
  const pieces = splitAtTouches(walls, touchPoints);

  const nodes = [];
  const byKey = new Map();
  const nodeAt = (x, y) => {
    const k = nodeKey(x, y);
    let id = byKey.get(k);
    if (id === undefined) {
      id = nodes.length;
      byKey.set(k, id);
      nodes.push({ x, y, edges: [], doors: 0, ends: [], nx: x, ny: y });
    }
    return id;
  };
  const edges = [];
  const seenEdge = new Set();
  for (const [x1, y1, x2, y2] of pieces) {
    const a = nodeAt(x1, y1);
    const b = nodeAt(x2, y2);
    if (a === b) continue;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    nodes[a].edges.push(edges.length);
    nodes[b].edges.push(edges.length);
    edges.push([a, b]);
  }
  for (const d of doors) {
    for (const [x, y] of [
      [d.c[0], d.c[1]],
      [d.c[2], d.c[3]],
    ]) {
      const id = byKey.get(nodeKey(x, y));
      if (id !== undefined) nodes[id].doors++;
    }
  }
  // A real corner — two straight walls of some length meeting at an angle — also ends a chain: each wall is then
  // probed across its own direction and the corner is put where the two moved walls meet. (Short pieces at an
  // angle to each other are a curve drawn on the half-cell lattice, and are followed as a curve.)
  const CORNER_EDGE = 0.75;
  const CORNER_TURN = Math.cos((35 * Math.PI) / 180);
  const isCorner = (v) => {
    const node = nodes[v];
    const dirs = node.edges.map((e) => {
      const o = nodes[edges[e][0] === v ? edges[e][1] : edges[e][0]];
      return [o.x - node.x, o.y - node.y, Math.hypot(o.x - node.x, o.y - node.y)];
    });
    if (dirs[0][2] < CORNER_EDGE || dirs[1][2] < CORNER_EDGE) return false;
    // Straight on means the two directions away from the node are opposite.
    const straight = -(dirs[0][0] * dirs[1][0] + dirs[0][1] * dirs[1][1]) / (dirs[0][2] * dirs[1][2]);
    return straight < CORNER_TURN;
  };
  const breaks = new Uint8Array(nodes.length);
  for (let v = 0; v < nodes.length; v++) breaks[v] = nodes[v].edges.length !== 2 || nodes[v].doors > 0 || isCorner(v) ? 1 : 0;
  const isBreak = (v) => breaks[v] === 1;
  const used = new Uint8Array(edges.length);
  const walk = (start, first) => {
    const path = [start];
    let at = start;
    let e = first;
    for (;;) {
      used[e] = 1;
      at = edges[e][0] === at ? edges[e][1] : edges[e][0];
      path.push(at);
      if (at === start || isBreak(at)) break;
      const next = nodes[at].edges.find((x) => !used[x]);
      if (next === undefined) break;
      e = next;
    }
    return path;
  };
  const chains = [];
  for (let v = 0; v < nodes.length; v++) {
    if (!isBreak(v)) continue;
    for (const e of nodes[v].edges) if (!used[e]) chains.push({ path: walk(v, e), closed: false });
  }
  for (let e = 0; e < edges.length; e++) {
    if (used[e]) continue;
    const path = walk(edges[e][0], e);
    chains.push({ path, closed: path[path.length - 1] === path[0] });
  }

  /* ---------- probes ---------- */
  const K = Math.max(2, Math.round(reach * cell));
  const width = 2 * K + 1;
  for (const chain of chains) {
    const pts = chain.path.map((v) => [nodes[v].x, nodes[v].y]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    chain.length = L;
    const pointAt = (s) => {
      if (chain.closed) s = ((s % L) + L) % L;
      else s = Math.max(0, Math.min(L, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const span = cum[i] - cum[i - 1] || 1;
      const t = (s - cum[i - 1]) / span;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    };
    const N = Math.max(2, Math.ceil(L / step));
    const count = chain.closed ? N : N + 1;
    chain.stepPx = (L / N) * cell;
    // Direction over half a cell to either side: a chain that zigzags between half-cell positions is probed across
    // its general course, and around a real corner the probes fan out.
    const span = Math.min(0.5, L / 2);
    chain.samples = [];
    for (let i = 0; i < count; i++) {
      const s = (i * L) / N;
      const [x, y] = pointAt(s);
      const [ax, ay] = pointAt(s - span);
      const [bx, by] = pointAt(s + span);
      let tx = bx - ax;
      let ty = by - ay;
      let len = Math.hypot(tx, ty);
      if (len < 1e-3) {
        tx = pts[pts.length - 1][0] - pts[0][0];
        ty = pts[pts.length - 1][1] - pts[0][1];
        len = Math.hypot(tx, ty) || 1;
      }
      const nx = -ty / len;
      const ny = tx / len;
      const e = new Float32Array(width);
      let best = 0;
      for (let j = 0; j < width; j++) {
        const k = j - K;
        // Cell coordinates count from the corner of the first pixel, the channels from its centre.
        e[j] = strength(x * cell - 0.5 + nx * k, y * cell - 0.5 + ny * k, nx, ny);
        if (e[j] > best) best = e[j];
      }
      chain.samples.push({ x, y, nx, ny, e, best, k: 0 });
    }
  }

  // What a drawn line is worth on this map: a little less than the typical strongest response under a wall.
  // Everything above that counts the same, so that among the positions that are all "on the line" — the middle of
  // a drawn stroke and its two flanks — the one nearest to where the model put the wall wins, and a wall that was
  // already exact stays exact.
  const bests = [];
  for (const chain of chains) for (const s of chain.samples) bests.push(s.best);
  bests.sort((a, b) => a - b);
  const scale = 0.75 * (bests[bests.length >> 1] ?? 0);
  if (!(scale >= 5)) return { ...unchanged, chains: chains.length };
  const worth = (e) => Math.min(1, e / scale);

  /* ---------- one offset per probe ---------- */
  // Pull towards the given position: a steady part, so that between positions that are equally "on the line" a wall
  // does not leave where the model put it, and a part that grows towards the far end of the reach.
  const NEAR = 0.15;
  const STAY = 0.2;
  const BEND = 0.6; // cost of a 45° slope between neighbouring probes
  const LINE = 1.15; // how much stronger than a texture the runs have to be for the map to count as drawn in lines
  /**
   * The best run of offsets through a chain's probes, and how much of a line lies under it (0..1).
   * `shifts` rolls every probe's readings round by its own amount (the test below); the offsets it returns are
   * then meaningless.
   */
  const solve = (chain, shifts) => {
    const S = chain.samples;
    const count = S.length;
    // A closed chain is run round twice and read from the middle, where both ends of the run are far away.
    const order = chain.closed ? Array.from({ length: 2 * count }, (_, i) => i % count) : S.map((_, i) => i);
    const T = order.length;
    const maxJump = Math.max(1, Math.ceil(1.25 * chain.stepPx));
    const cost = new Float32Array(T * width);
    const back = new Int16Array(T * width);
    const reading = (t, j) => worth(S[order[t]].e[shifts ? (j + shifts[order[t]]) % width : j]);
    const unary = (t, j) => {
      const far = Math.abs(j - K) / K;
      return -reading(t, j) + far * (NEAR + STAY * far);
    };
    for (let j = 0; j < width; j++) cost[j] = unary(0, j);
    for (let t = 1; t < T; t++) {
      for (let j = 0; j < width; j++) {
        let best = Infinity;
        let from = j;
        const lo = Math.max(0, j - maxJump);
        const hi = Math.min(width - 1, j + maxJump);
        for (let i = lo; i <= hi; i++) {
          const slope = (j - i) / chain.stepPx;
          const c = cost[(t - 1) * width + i] + BEND * slope * slope;
          if (c < best) {
            best = c;
            from = i;
          }
        }
        cost[t * width + j] = best + unary(t, j);
        back[t * width + j] = from;
      }
    }
    let j = 0;
    for (let i = 1; i < width; i++) if (cost[(T - 1) * width + i] < cost[(T - 1) * width + j]) j = i;
    const first = chain.closed ? count >> 1 : 0;
    const offsets = new Int16Array(count);
    let onPath = 0;
    let raw = 0;
    for (let t = T - 1; t >= 0; t--) {
      if (t >= first && t < first + count) {
        offsets[order[t]] = j - K;
        onPath += reading(t, j);
        // Uncapped, for telling a line from a texture: a line is stronger than the hatching next to it even where
        // both are strong enough to follow.
        raw += Math.min(2, S[order[t]].e[shifts ? (j + shifts[order[t]]) % width : j] / scale);
      }
      j = back[t * width + j];
    }
    return { offsets, onPath: onPath / count, raw: raw / count };
  };

  // Is that a line, or just the busiest spots of a texture strung together? A line is where it is from one probe to
  // the next. Roll the readings of every other probe round by half the reach and that is gone, while a texture
  // looks the same as before. So the runs have to be clearly stronger than the best runs through the rolled
  // readings: over the whole map (a painted map without drawn lines is left alone altogether), and each chain at
  // least a little (a wall the model put where nothing is drawn stays where it is).
  let lineSum = 0;
  let textureSum = 0;
  for (const chain of chains) {
    chain.found = solve(chain, null);
    chain.rolled = solve(
      chain,
      chain.samples.map((_, i) => (i % 2 ? K : 0)),
    );
    lineSum += chain.found.raw * chain.samples.length;
    textureSum += chain.rolled.raw * chain.samples.length;
  }
  if (!(lineSum >= LINE * textureSum)) return { ...unchanged, chains: chains.length };
  let moved = 0;
  for (const chain of chains) {
    const S = chain.samples;
    chain.moved = chain.found.onPath >= 0.5 && chain.found.raw >= chain.rolled.raw;
    if (chain.moved) moved++;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      s.k = chain.moved ? chain.found.offsets[i] : 0;
      // Is anything drawn where this probe ended up?
      s.ok = chain.moved && worth(s.e[s.k + K]) >= 0.5;
      s.px = Math.max(0, Math.min(cols, s.x + (s.nx * s.k) / cell));
      s.py = Math.max(0, Math.min(rows, s.y + (s.ny * s.k) / cell));
    }
  }

  /* ---------- junctions and ends ---------- */
  // Each chain says where it ends up running near its end: a line through the last stretch that has something
  // drawn under it. The end itself is not asked, because the model's end point may lie past the end of the drawn
  // wall, where there is nothing to find.
  const stretch = (chain) => Math.max(2, Math.round(0.8 / (chain.stepPx / cell)));
  const endLine = (chain, atStart) => {
    const S = chain.samples;
    const at = (i) => S[atStart ? i : S.length - 1 - i];
    if (!chain.moved) return { qx: at(0).x, qy: at(0).y, mx: at(0).nx, my: at(0).ny, skip: 0 };
    let skip = 0;
    while (skip < S.length - 1 && !at(skip).ok) skip++;
    const pts = [];
    for (let i = skip; i < S.length && i < skip + stretch(chain); i++) if (at(i).ok) pts.push(at(i));
    let cx = 0;
    let cy = 0;
    for (const q of pts) {
      cx += q.px / pts.length;
      cy += q.py / pts.length;
    }
    // Direction of the stretch: principal axis of its points.
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const q of pts) {
      sxx += (q.px - cx) ** 2;
      sxy += (q.px - cx) * (q.py - cy);
      syy += (q.py - cy) ** 2;
    }
    let mx = at(skip).nx;
    let my = at(skip).ny;
    if (sxx + syy > 1e-4) {
      const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      mx = -Math.sin(angle);
      my = Math.cos(angle);
    }
    return { qx: cx, qy: cy, mx, my, skip };
  };
  for (const chain of chains) {
    if (chain.closed) continue;
    const a = endLine(chain, true);
    const b = endLine(chain, false);
    chain.skipStart = a.skip;
    chain.skipEnd = b.skip;
    nodes[chain.path[0]].ends.push(a);
    nodes[chain.path[chain.path.length - 1]].ends.push(b);
  }
  for (const node of nodes) {
    if (!node.ends.length) continue;
    // The point nearest to all those lines: where two walls meet at a corner, and for a single wall the model's
    // end point dropped onto the line. The ridge keeps it near where it was along directions no line decides.
    const RIDGE = 0.01;
    let a = RIDGE;
    let b = 0;
    let d = RIDGE;
    let u = RIDGE * node.x;
    let v = RIDGE * node.y;
    for (const line of node.ends) {
      const along = line.mx * line.qx + line.my * line.qy;
      a += line.mx * line.mx;
      b += line.mx * line.my;
      d += line.my * line.my;
      u += line.mx * along;
      v += line.my * along;
    }
    const det = a * d - b * b;
    let mx = (d * u - b * v) / det - node.x;
    let my = (a * v - b * u) / det - node.y;
    const far = Math.hypot(mx, my);
    const limit = 1.5 * reach;
    if (far > limit) {
      mx *= limit / far;
      my *= limit / far;
    }
    node.nx = Math.max(0, Math.min(cols, node.x + mx));
    node.ny = Math.max(0, Math.min(rows, node.y + my));
  }

  /* ---------- result ---------- */
  const out = [];
  const emit = (points) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const seg = [round3(points[i][0]), round3(points[i][1]), round3(points[i + 1][0]), round3(points[i + 1][1])];
      if (seg[0] !== seg[2] || seg[1] !== seg[3]) out.push(seg);
    }
  };
  for (const chain of chains) {
    if (!chain.moved) {
      // Untouched, except that its ends follow the junctions they belong to.
      const pts = chain.path.map((v) => [nodes[v].x, nodes[v].y]);
      if (!chain.closed) {
        const a = nodes[chain.path[0]];
        const b = nodes[chain.path[chain.path.length - 1]];
        pts[0] = [a.nx, a.ny];
        pts[pts.length - 1] = [b.nx, b.ny];
      }
      emit(pts);
      continue;
    }
    const S = chain.samples;
    if (chain.closed) {
      emit(simplifyClosed(S.map((q) => [q.px, q.py]), tolerance));
      continue;
    }
    const a = nodes[chain.path[0]];
    const b = nodes[chain.path[chain.path.length - 1]];
    const pts = [[a.nx, a.ny]];
    for (let i = Math.max(1, chain.skipStart); i < S.length - Math.max(1, chain.skipEnd); i++) pts.push([S[i].px, S[i].py]);
    pts.push([b.nx, b.ny]);
    // A chain that leaves a junction and comes back to it is a loop: simplified as an open line between two
    // identical ends it would collapse to nothing.
    emit(a === b ? simplifyClosed(pts.slice(0, -1), tolerance) : simplifyOpen(pts, tolerance));
  }
  const doorsOut = doors.map((door) => {
    const c = [...door.c];
    for (const at of [0, 2]) {
      const id = byKey.get(nodeKey(c[at], c[at + 1]));
      if (id === undefined) continue;
      c[at] = round3(nodes[id].nx);
      c[at + 1] = round3(nodes[id].ny);
    }
    return { ...door, c };
  });
  return { walls: out, doors: doorsOut, chains: chains.length, moved };
}
