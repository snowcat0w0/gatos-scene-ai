/**
 * Pixel-precise floor outline from a coarse floor map (pure, no Foundry or DOM globals).
 *
 * A vision model is good at saying which grid cells are walkable and poor at giving the coordinates of the line
 * where the floor ends. So the model only labels cells, and the line is found in the pixels, the way an
 * interactive "rough selection → exact outline" tool does it:
 *
 *   1. Cells deep inside the floor and deep inside the rock are taken as they are. From their pixels two colour
 *      models are learned: what floor looks like on this map and what everything else looks like.
 *   2. In the cells along the border only the pixels that clearly look like their cell's label keep it; the
 *      rest are left open.
 *   3. A watershed on the image gradient settles the open pixels: both sides grow over flat areas first and
 *      meet on the strongest edge between them, which is the drawn wall line.
 *   4. The floor outline is traced and simplified into polylines.
 *
 * Coordinates of the result are in grid cells.
 */

/** Separable box blur of one channel. */
export function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pass = (from, to, len, stride, lines, lineStride) => {
    for (let line = 0; line < lines; line++) {
      const base = line * lineStride;
      let sum = 0;
      let count = 0;
      for (let i = 0; i <= r && i < len; i++) {
        sum += from[base + i * stride];
        count++;
      }
      for (let i = 0; i < len; i++) {
        to[base + i * stride] = sum / count;
        const add = i + r + 1;
        const drop = i - r;
        if (add < len) {
          sum += from[base + add * stride];
          count++;
        }
        if (drop >= 0) {
          sum -= from[base + drop * stride];
          count--;
        }
      }
    }
  };
  pass(src, tmp, w, 1, h, w);
  pass(tmp, out, h, w, w, 1);
  return out;
}

/** Colour-gradient magnitude scaled to 0..255 (the 99th percentile maps to 255). */
function gradientLevels(ch, w, h) {
  const n = w * h;
  const mag = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y;
    const yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      let sum = 0;
      for (const c of ch) {
        const dx = c[y * w + xr] - c[y * w + xl];
        const dy = c[yd * w + x] - c[yu * w + x];
        sum += dx * dx + dy * dy;
      }
      mag[y * w + x] = Math.sqrt(sum);
    }
  }
  const hist = new Uint32Array(1024);
  for (let i = 0; i < n; i++) hist[Math.min(1023, mag[i] | 0)]++;
  let seen = 0;
  let top = 1;
  for (let v = 0; v < 1024; v++) {
    seen += hist[v];
    if (seen >= n * 0.99) {
      top = Math.max(1, v);
      break;
    }
  }
  const levels = new Uint8Array(n);
  for (let i = 0; i < n; i++) levels[i] = Math.min(255, Math.round((mag[i] * 255) / top));
  return levels;
}

const BINS = 12;
const binOf = (r, g, b) => ((r * BINS) >> 8) * BINS * BINS + ((g * BINS) >> 8) * BINS + ((b * BINS) >> 8);

/** Spread every histogram count to its 26 neighbours, so a colour never seen exactly still gets a likelihood. */
function smoothHistogram(hist) {
  const out = new Float32Array(hist.length);
  for (let r = 0; r < BINS; r++) {
    for (let g = 0; g < BINS; g++) {
      for (let b = 0; b < BINS; b++) {
        let sum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dg = -1; dg <= 1; dg++) {
            for (let db = -1; db <= 1; db++) {
              const rr = r + dr;
              const gg = g + dg;
              const bb = b + db;
              if (rr < 0 || gg < 0 || bb < 0 || rr >= BINS || gg >= BINS || bb >= BINS) continue;
              sum += hist[rr * BINS * BINS + gg * BINS + bb] * (dr || dg || db ? 0.5 : 1);
            }
          }
        }
        out[r * BINS * BINS + g * BINS + b] = sum;
      }
    }
  }
  return out;
}

/** Douglas–Peucker on an open polyline of [x, y] points. */
export function simplifyOpen(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed loop (first point not repeated). Returns a closed polyline (first = last). */
export function simplifyClosed(loop, tolerance) {
  if (loop.length < 4) return [...loop, loop[0]];
  // Split at the point farthest from the start, simplify both halves.
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const first = simplifyOpen(loop.slice(0, far + 1), tolerance);
  const second = simplifyOpen([...loop.slice(far), loop[0]], tolerance);
  return [...first, ...second.slice(1)];
}

/**
 * Trace the outline of the floor in a label map as polylines on the pixel-corner lattice.
 * Edges along the image border are left out, so floor running off the map gives open lines.
 * @returns {Array<{points: number[][], closed: boolean}>}
 */
export function traceOutlines(isFloor, w, h) {
  const pw = w + 1;
  // Up to two outgoing boundary edges per lattice point (two at a saddle, where floor pixels touch diagonally).
  const out = new Int32Array(pw * (h + 1) * 2).fill(-1);
  const indeg = new Uint8Array(pw * (h + 1));
  const add = (x0, y0, x1, y1) => {
    const a = y0 * pw + x0;
    const b = y1 * pw + x1;
    if (out[a * 2] < 0) out[a * 2] = b;
    else out[a * 2 + 1] = b;
    indeg[b]++;
  };
  // Clockwise around the floor: floor stays on the right-hand side of the direction of travel.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFloor[y * w + x]) continue;
      if (y > 0 && !isFloor[(y - 1) * w + x]) add(x, y, x + 1, y);
      if (x < w - 1 && !isFloor[y * w + x + 1]) add(x + 1, y, x + 1, y + 1);
      if (y < h - 1 && !isFloor[(y + 1) * w + x]) add(x + 1, y + 1, x, y + 1);
      if (x > 0 && !isFloor[y * w + x - 1]) add(x, y + 1, x, y);
    }
  }

  const lines = [];
  const walk = (start) => {
    const points = [];
    let at = start;
    let px = -1;
    let py = -1;
    for (;;) {
      const x = at % pw;
      const y = (at - x) / pw;
      points.push([x, y]);
      let slot = at * 2;
      if (out[slot] < 0 && out[slot + 1] < 0) return { points, closed: false };
      if (out[slot] >= 0 && out[slot + 1] >= 0 && px >= 0) {
        // Saddle: take the right turn, which stays with the floor pixel this outline has been following.
        const tx = x - (y - py);
        const ty = y + (x - px);
        if (out[slot + 1] === ty * pw + tx) slot++;
      } else if (out[slot] < 0) slot++;
      const next = out[slot];
      out[slot] = -1;
      px = x;
      py = y;
      at = next;
      if (at === start) return { points, closed: true };
    }
  };
  // Open lines start where an edge leaves a point that none enters.
  for (let p = 0; p < indeg.length; p++) {
    if (!indeg[p] && (out[p * 2] >= 0 || out[p * 2 + 1] >= 0)) lines.push(walk(p));
  }
  for (let p = 0; p < indeg.length; p++) {
    while (out[p * 2] >= 0 || out[p * 2 + 1] >= 0) lines.push(walk(p));
  }
  return lines;
}

/**
 * Flip connected regions to the other label when they are smaller than `minArea` pixels (stains, specks,
 * lettering) or, with `anchors`, when they do not cover the centre of a single cell the model gave their label.
 * The second rule removes what the colour model alone put there: a light patch of rock next to the floor, a dark
 * stain or a piece of furniture in the middle of it.
 */
function dissolve(labels, w, h, minArea, anchors = null) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const label = labels[start];
    let head = 0;
    let tail = 0;
    let anchored = !anchors;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      if (!anchored && anchors[i] === label) anchored = true;
      const x = i % w;
      if (x > 0 && !seen[i - 1] && labels[i - 1] === label) (seen[i - 1] = 1), (queue[tail++] = i - 1);
      if (x < w - 1 && !seen[i + 1] && labels[i + 1] === label) (seen[i + 1] = 1), (queue[tail++] = i + 1);
      if (i >= w && !seen[i - w] && labels[i - w] === label) (seen[i - w] = 1), (queue[tail++] = i - w);
      if (i < n - w && !seen[i + w] && labels[i + w] === label) (seen[i + w] = 1), (queue[tail++] = i + w);
    }
    if (tail < minArea || !anchored) for (let k = 0; k < tail; k++) labels[queue[k]] = label === 1 ? 2 : 1;
  }
}

/**
 * @param {{width: number, height: number, data: ArrayLike<number>}} image  RGBA, exactly cols·cell × rows·cell
 *        pixels, one grid cell per `cell` pixels; alpha 0 marks pixels outside the map picture
 * @param {ArrayLike<number>} floor   cols·rows flags, row-major: 1 = the model called this cell walkable
 * @param {object} dims
 * @param {number} dims.cols
 * @param {number} dims.rows
 * @param {number} dims.cell          pixels per cell
 * @param {number} [dims.tolerance=0.1]  outline simplification in cells
 * @returns {{walls: number[][][], labels: Uint8Array}}  walls: polylines of [x, y] in cells (closed ones repeat
 *          their first point); labels: per pixel 1 = floor, 2 = not floor
 */
export function segmentFloor({ width: w, height: h, data }, floor, { cols, rows, cell, tolerance = 0.1 }) {
  const n = w * h;
  const labels = new Uint8Array(n);
  let floorCells = 0;
  for (let i = 0; i < cols * rows; i++) if (floor[i]) floorCells++;
  if (!floorCells) return { walls: [], labels: labels.fill(2) };

  // Channels, lightly smoothed for the gradient and more for the colour model (this also wipes out thin grid lines).
  const raw = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const valid = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    raw[0][i] = data[j];
    raw[1][i] = data[j + 1];
    raw[2][i] = data[j + 2];
    valid[i] = data[j + 3] > 0 ? 1 : 0;
  }
  const soft = raw.map((c) => boxBlur(c, w, h, 1));
  const colourRadius = Math.max(1, Math.round(cell / 8));
  const colour = raw.map((c) => boxBlur(c, w, h, colourRadius));
  const levels = gradientLevels(soft, w, h);

  // A cell is "interior" when all its neighbours carry the same label.
  const interior = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const mine = floor[cy * cols + cx] ? 1 : 0;
      let same = true;
      for (let dy = -1; dy <= 1 && same; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          if ((floor[y * cols + x] ? 1 : 0) !== mine) {
            same = false;
            break;
          }
        }
      }
      interior[cy * cols + cx] = same ? 1 : 0;
    }
  }

  // Colour models from the interior cells (from all cells of a label when it has too few interior ones).
  const train = (wantFloor, interiorOnly) => {
    const hist = new Float32Array(BINS * BINS * BINS);
    let count = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
        if (!!floor[c] !== wantFloor || (interiorOnly && !interior[c])) continue;
        for (let y = cy * cell; y < (cy + 1) * cell; y++) {
          for (let x = cx * cell; x < (cx + 1) * cell; x++) {
            const i = y * w + x;
            if (!valid[i]) continue;
            hist[binOf(colour[0][i], colour[1][i], colour[2][i])]++;
            count++;
          }
        }
      }
    }
    return { hist, count };
  };
  const enough = cell * cell * 3;
  let floorModel = train(true, true);
  if (floorModel.count < enough) floorModel = train(true, false);
  let solidModel = train(false, true);
  if (solidModel.count < enough) solidModel = train(false, false);
  const hf = smoothHistogram(floorModel.hist);
  const hs = smoothHistogram(solidModel.hist);
  const nf = Math.max(1, floorModel.count);
  const ns = Math.max(1, solidModel.count);
  /** Log-likelihood ratio: positive = looks like floor. */
  const ratio = (i) => {
    const bin = binOf(colour[0][i], colour[1][i], colour[2][i]);
    return Math.log((hf[bin] + 0.5) / nf) - Math.log((hs[bin] + 0.5) / ns);
  };

  // Markers.
  const SURE = 0.7;
  const hasModel = solidModel.count > 0 && floorModel.count > 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = cy * cols + cx;
      const label = floor[c] ? 1 : 2;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const i = y * w + x;
          if (!valid[i]) labels[i] = 2;
          else if (interior[c] || !hasModel) labels[i] = label;
          else {
            const r = ratio(i);
            if (label === 1 ? r > SURE : r < -SURE) labels[i] = label;
          }
        }
      }
    }
  }

  // Watershed: flood the open pixels from the markers in order of gradient level (first come, first served).
  const buckets = Array.from({ length: 256 }, () => []);
  const heads = new Int32Array(256);
  const pending = new Uint8Array(n);
  const offer = (j, label, level) => {
    if (labels[j] || pending[j]) return;
    pending[j] = label;
    buckets[level > levels[j] ? level : levels[j]].push(j);
  };
  const spread = (i, label, level) => {
    const x = i % w;
    if (x > 0) offer(i - 1, label, level);
    if (x < w - 1) offer(i + 1, label, level);
    if (i >= w) offer(i - w, label, level);
    if (i < n - w) offer(i + w, label, level);
  };
  for (let i = 0; i < n; i++) if (labels[i]) spread(i, labels[i], 0);
  for (let level = 0; level < 256; level++) {
    const bucket = buckets[level];
    while (heads[level] < bucket.length) {
      const i = bucket[heads[level]++];
      labels[i] = pending[i];
      spread(i, labels[i], level);
    }
  }
  for (let i = 0; i < n; i++) if (!labels[i]) labels[i] = 2;

  // Tidy the label map: a majority filter takes off one-pixel spikes and notches (hatch marks, lettering,
  // stains at the edge), then regions too small to be a pillar or an alcove are dissolved.
  const specks = Math.max(4, Math.round(cell * cell * 0.3));
  dissolve(labels, w, h, specks);
  const share = new Float32Array(n);
  for (let i = 0; i < n; i++) share[i] = labels[i] === 1 ? 1 : 0;
  const majority = boxBlur(share, w, h, Math.max(1, Math.round(cell / 10)));
  for (let i = 0; i < n; i++) labels[i] = majority[i] > 0.5 ? 1 : 2;
  // The centre pixel of every cell carries the model's label for it.
  const anchors = new Uint8Array(n);
  const mid = Math.floor(cell / 2);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) anchors[(cy * cell + mid) * w + cx * cell + mid] = floor[cy * cols + cx] ? 1 : 2;
  }
  // Twice: dissolving a floor island can leave the rock ring around it without an anchor of its own, and the
  // other way round.
  dissolve(labels, w, h, specks, anchors);
  dissolve(labels, w, h, specks, anchors);

  // Floor that hangs on the rest by a thread — a light patch of rock reached through a gap in the drawn line —
  // is cut off: shrink the floor, keep the shrunken parts that still hold a floor cell's centre, grow them back
  // and keep only the original floor within reach.
  const reach = Math.max(1, Math.round(cell / 8));
  for (let i = 0; i < n; i++) share[i] = labels[i] === 1 ? 1 : 0;
  const eroded = boxBlur(share, w, h, reach);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = eroded[i] > 0.999 ? 1 : 2;
  dissolve(core, w, h, 1, anchors);
  for (let i = 0; i < n; i++) share[i] = core[i] === 1 ? 1 : 0;
  const grown = boxBlur(share, w, h, reach + 1);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1 && !(grown[i] > 0)) labels[i] = 2;
    else if (labels[i] === 1) kept++;
  }
  // A map of corridors thinner than the shrink radius would lose all its floor: then leave the outline as it was.
  if (!kept) for (let i = 0; i < n; i++) labels[i] = majority[i] > 0.5 ? 1 : 2;

  const isFloor = new Uint8Array(n);
  for (let i = 0; i < n; i++) isFloor[i] = labels[i] === 1 ? 1 : 0;
  const tol = Math.max(0.75, tolerance * cell);
  const round = (v) => Math.round((v / cell) * 1000) / 1000;
  const walls = [];
  for (const line of traceOutlines(isFloor, w, h)) {
    const simple = line.closed ? simplifyClosed(line.points, tol) : simplifyOpen(line.points, tol);
    if (simple.length < 2) continue;
    const points = simple.map(([x, y]) => [round(x), round(y)]);
    if (line.closed) {
      // Shoelace area in cells: a loop smaller than a third of a cell is noise that simplification left over.
      let area = 0;
      for (let i = 0; i + 1 < points.length; i++) area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
      if (Math.abs(area) / 2 < 0.35) continue;
    }
    walls.push(points);
  }
  return { walls, labels };
}
