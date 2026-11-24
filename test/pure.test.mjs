import { test } from "node:test";
import assert from "node:assert/strict";

import { extractJson, JsonExtractError } from "../scripts/json.js";
import { detectGrid } from "../scripts/grid-detect.js";
import {
  splitAxis,
  planTiles,
  snap,
  clipSegment,
  mergeColinear,
  mergeWallsAndDoors,
  normalizeTileReply,
  dedupePoints,
} from "../scripts/geometry.js";

/* -------------------------------------------- */
/*  json                                        */
/* -------------------------------------------- */

test("extractJson: plain, fenced, prefixed, think block, trailing comma", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```\nDone.'), { a: [1, 2] });
  assert.deepEqual(extractJson('Sure. {"walls": [[[0,0],[1,1]]]} hope that helps'), { walls: [[[0, 0], [1, 1]]] });
  assert.deepEqual(extractJson('<think>{"not": "this"}</think>{"a":2}'), { a: 2 });
  assert.deepEqual(extractJson('{"a":[1,2,],}'), { a: [1, 2] });
  assert.deepEqual(extractJson('{"s":"brace } in string"}'), { s: "brace } in string" });
});

test("extractJson: truncated reply is an error, not a fragment", () => {
  assert.throws(
    () => extractJson('{"walls": [[[0,0],[1,1]], [[2,2],[3,'),
    (err) => err instanceof JsonExtractError && err.kind === "truncated",
  );
  assert.throws(() => extractJson("   "), (err) => err.kind === "empty");
  assert.throws(() => extractJson("no json here"), (err) => err.kind === "invalid");
});

/* -------------------------------------------- */
/*  grid detection                              */
/* -------------------------------------------- */

/** Deterministic noise. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A noisy map-like image with a grid of the given period/phase, plus some non-periodic thick "walls". */
function syntheticMap({ w, h, period, phaseX, phaseY, lineDark = 35, noise = 12, seed = 1, grid = true }) {
  const rand = rng(seed);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = 150 + (rand() - 0.5) * 2 * noise;
  // Blotchy floor texture.
  for (let k = 0; k < 60; k++) {
    const cx = Math.floor(rand() * w);
    const cy = Math.floor(rand() * h);
    const r = 10 + Math.floor(rand() * 40);
    const dv = (rand() - 0.5) * 50;
    for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) data[y * w + x] += dv;
    }
  }
  if (grid) {
    for (let gx = phaseX; gx < w; gx += period) {
      const x = Math.round(gx);
      for (let y = 0; y < h; y++) data[y * w + x] -= lineDark;
    }
    for (let gy = phaseY; gy < h; gy += period) {
      const y = Math.round(gy);
      for (let x = 0; x < w; x++) data[y * w + x] -= lineDark;
    }
  }
  // Thick dark walls at irregular places.
  for (const [x0, y0, x1, y1] of [
    [100, 60, 108, 400],
    [100, 60, 520, 68],
    [333, 200, 341, 470],
  ]) {
    for (let y = y0; y < Math.min(h, y1); y++) for (let x = x0; x < Math.min(w, x1); x++) data[y * w + x] = 20;
  }
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i]));
  return { width: w, height: h, data };
}

test("detectGrid: finds period and phase of a faint grid under noise", () => {
  const img = syntheticMap({ w: 900, h: 700, period: 50, phaseX: 17, phaseY: 33 });
  const d = detectGrid(img);
  assert.ok(d, "detected");
  assert.ok(Math.abs(d.periodX - 50) < 0.15, `periodX ${d.periodX}`);
  assert.ok(Math.abs(d.periodY - 50) < 0.15, `periodY ${d.periodY}`);
  assert.ok(Math.abs(d.phaseX - 17) < 1.5, `phaseX ${d.phaseX}`);
  assert.ok(Math.abs(d.phaseY - 33) < 1.5, `phaseY ${d.phaseY}`);
  assert.notEqual(d.confidence, "low");
});

test("detectGrid: fractional period", () => {
  const img = syntheticMap({ w: 1000, h: 800, period: 70.4, phaseX: 5.2, phaseY: 60.1, seed: 7 });
  const d = detectGrid(img);
  assert.ok(Math.abs(d.periodX - 70.4) < 0.2, `periodX ${d.periodX}`);
  assert.ok(Math.abs(d.periodY - 70.4) < 0.2, `periodY ${d.periodY}`);
  // Lines were drawn at rounded positions, so allow a pixel.
  assert.ok(Math.abs(d.phaseX - 5.2) < 1.5, `phaseX ${d.phaseX}`);
  assert.ok(Math.abs(d.phaseY - 60.1) < 1.5, `phaseY ${d.phaseY}`);
});

test("detectGrid: no grid gives low confidence", () => {
  const img = syntheticMap({ w: 900, h: 700, period: 50, phaseX: 0, phaseY: 0, grid: false, seed: 3 });
  const d = detectGrid(img);
  assert.ok(!d || d.confidence === "low", `confidence ${d?.confidence} strength ${d?.strength} score ${d?.score}`);
});

test("detectGrid: hint selects the doubled period", () => {
  const img = syntheticMap({ w: 900, h: 700, period: 40, phaseX: 12, phaseY: 8, seed: 5 });
  const d = detectGrid(img, { hint: 80 });
  assert.ok(Math.abs(d.periodX - 80) < 0.3, `periodX ${d.periodX}`);
  // Any line of the 40 px grid is a valid origin for an 80 px grid.
  const rel = ((d.phaseX - 12) % 40 + 40) % 40;
  assert.ok(Math.min(rel, 40 - rel) < 1.5, `phaseX ${d.phaseX}`);
});

/* -------------------------------------------- */
/*  geometry                                    */
/* -------------------------------------------- */

test("splitAxis / planTiles: cores partition the map, views add one cell of context", () => {
  assert.deepEqual(splitAxis(10, 12), [{ core: [0, 10], view: [0, 10] }]);
  const parts = splitAxis(25, 12);
  assert.equal(parts[0].core[0], 0);
  assert.equal(parts.at(-1).core[1], 25);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].core[0], parts[i - 1].core[1]);
  for (const p of parts) {
    assert.ok(p.view[1] - p.view[0] <= 12, "view fits the tile");
    assert.ok(p.view[0] <= p.core[0] && p.view[1] >= p.core[1]);
  }
  assert.equal(planTiles(25, 10, 12).length, parts.length);
});

test("snap / clipSegment", () => {
  assert.equal(snap(2.26, 0.5), 2.5);
  assert.equal(snap(2.24, 0.5), 2);
  assert.equal(snap(2.26, 0.25), 2.25);
  assert.deepEqual(clipSegment([-2, 1, 5, 1], { x0: 0, y0: 0, x1: 3, y1: 3 }), [0, 1, 3, 1]);
  assert.equal(clipSegment([4, 4, 6, 6], { x0: 0, y0: 0, x1: 3, y1: 3 }), null);
  // A segment lying on the border is kept.
  assert.deepEqual(clipSegment([3, 0, 3, 2], { x0: 0, y0: 0, x1: 3, y1: 3 }), [3, 0, 3, 2]);
});

test("mergeColinear joins touching and overlapping pieces, keeps separate lines apart", () => {
  const merged = mergeColinear([
    [0, 0, 2, 0],
    [2, 0, 5, 0],
    [4, 0, 6, 0],
    [8, 0, 9, 0],
    [0, 1, 3, 1],
    [1, 1, 2, 2],
    [2, 2, 4, 4],
  ]);
  const has = (seg) => merged.some((m) => m.every((v, i) => Math.abs(v - seg[i]) < 1e-6));
  assert.equal(merged.length, 4);
  assert.ok(has([0, 0, 6, 0]));
  assert.ok(has([8, 0, 9, 0]));
  assert.ok(has([0, 1, 3, 1]));
  assert.ok(has([1, 1, 4, 4]));
});

test("mergeWallsAndDoors opens the wall under a door", () => {
  const { walls, doors } = mergeWallsAndDoors(
    [
      [0, 0, 10, 0],
      [0, 0, 0, 5],
    ],
    [{ c: [4, 0, 5, 0], type: "door" }],
  );
  assert.equal(doors.length, 1);
  assert.deepEqual(doors[0], { c: [4, 0, 5, 0], type: "door" });
  const horizontal = walls.filter((w) => w[1] === 0 && w[3] === 0).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(horizontal, [
    [0, 0, 4, 0],
    [5, 0, 10, 0],
  ]);
  assert.equal(walls.length, 3);
});

test("normalizeTileReply: local → map cells, snapping, clipping to the core, lenient shapes", () => {
  const tile = { view: { x0: 9, y0: 0, x1: 21, y1: 10 }, core: { x0: 10, y0: 0, x1: 20, y1: 10 } };
  const out = normalizeTileReply(
    {
      walls: [
        [
          [0, 2.1],
          [12, 2.1],
        ],
        [3, 3, 3, 6],
        { points: [{ x: 5, y: 5 }, { x: 7.26, y: 5 }] },
        [[50, 50], [60, 60]],
        "garbage",
      ],
      doors: [{ a: [2, 9], b: [3, 9], type: "Secret" }, [[5, 9], [6, 9]]],
      lights: [
        { x: 0.4, y: 1, kind: "torch" },
        { x: 4, y: 4, kind: "bonfire", color: "#12ABef" },
        { x: "6.5", y: "2", kind: "fire" },
      ],
    },
    tile,
    { snapStep: 0.5 },
  );
  // Long wall: view x 0..12 → map 9..21, clipped to core 10..20, y snapped 2.1 → 2.
  assert.deepEqual(out.walls[0], [10, 2, 20, 2]);
  assert.deepEqual(out.walls[1], [12, 3, 12, 6]);
  assert.deepEqual(out.walls[2], [14, 5, 16.5, 5]);
  assert.equal(out.walls.length, 3);
  assert.deepEqual(out.doors, [
    { c: [11, 9, 12, 9], type: "secret" },
    { c: [14, 9, 15, 9], type: "door" },
  ]);
  // First light is in the context column (x 9.4 < core.x0) and belongs to the neighbouring tile.
  assert.deepEqual(out.lights, [
    { x: 13, y: 4, kind: "torch", color: "#12abef" },
    { x: 15.5, y: 2, kind: "fire", color: null },
  ]);
});

test("dedupePoints", () => {
  const pts = dedupePoints(
    [
      { x: 1, y: 1 },
      { x: 1.2, y: 1.1 },
      { x: 3, y: 3 },
    ],
    0.5,
  );
  assert.equal(pts.length, 2);
});

/* -------------------------------------------- */
/*  floor cells and outline tracing             */
/* -------------------------------------------- */

import { floorCells } from "../scripts/geometry.js";
import { segmentFloor } from "../scripts/segment.js";

test("floorCells: spans per band in grid-line units", () => {
  // Floor from line 2 to line 4 is cells 2 and 3; a zero-length span or a bare number is the one cell there.
  assert.deepEqual(floorCells({ "1-2": [[2, 4]], "3-4": [[0, 0], 5] }, 6, 5), [
    [2, 1],
    [3, 1],
    [0, 3],
    [5, 3],
  ]);
  // Half cells: a cell counts when the span covers half of it.
  assert.deepEqual(floorCells({ "0-1": [[1.5, 3.4]] }, 6, 5), [
    [1, 0],
    [2, 0],
  ]);
  // A narrow passage straddling a line wins no cell by half, and still keeps the one it covers most.
  assert.deepEqual(floorCells({ "2-3": [[2.6, 3.3]] }, 6, 5), [[2, 2]]);
  // A bare [from, to] pair, a band named by its upper line, spans past the edge, a band past the edge.
  assert.deepEqual(floorCells({ 0: [4, 9], 7: [[0, 1]] }, 6, 5), [
    [4, 0],
    [5, 0],
  ]);
  assert.deepEqual(floorCells(["#..#", "####", "..##"], 4, 3), [
    [1, 0],
    [2, 0],
    [0, 2],
    [1, 2],
  ]);
  assert.deepEqual(floorCells(null, 4, 3), []);
});

test("normalizeTileReply: floor cells and ledges are mapped and clipped to the core", () => {
  const tile = { view: { x0: 9, y0: 0, x1: 21, y1: 10 }, core: { x0: 10, y0: 0, x1: 20, y1: 10 } };
  const out = normalizeTileReply({ floor: { "2-3": [[0, 4]] }, ledges: [[[1.3, 4.2], [5.1, 4.7]]] }, tile, { snapStep: 0.5 });
  // Column 0 of the view is the neighbour's context column.
  assert.deepEqual(out.floor, [
    [10, 2],
    [11, 2],
    [12, 2],
  ]);
  // Ledges keep their decimals (no snapping); a bare polyline says nothing about heights.
  assert.equal(out.ledges.length, 1);
  const { c, side, drop } = out.ledges[0];
  assert.ok(Math.abs(c[0] - 10.3) < 1e-6 && Math.abs(c[3] - 4.7) < 1e-6, String(c));
  assert.equal(side, 0);
  assert.equal(drop, null);
  assert.deepEqual(out.steps, []);
});

test("segmentFloor: the outline lands on the drawn edge, not on the cell borders", () => {
  const cell = 12;
  const cols = 12;
  const rows = 10;
  const w = cols * cell;
  const h = rows * cell;
  const rand = rng(11);
  // A light room from pixel (30, 25) to (100, 90) with a dark outline, in noisy brown rock.
  const room = { x0: 30, y0: 25, x1: 100, y1: 90 };
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= room.x0 && x < room.x1 && y >= room.y0 && y < room.y1;
      const edge = inside && (x < room.x0 + 2 || x >= room.x1 - 2 || y < room.y0 + 2 || y >= room.y1 - 2);
      const noise = (rand() - 0.5) * 24;
      const [r, g, b] = edge ? [30, 20, 15] : inside ? [215, 200, 170] : [110, 70, 60];
      data[i] = r + noise;
      data[i + 1] = g + noise;
      data[i + 2] = b + noise;
      data[i + 3] = 255;
    }
  }
  // The model's cell labels: a cell is floor when its centre is in the room.
  const floor = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = cx * cell + cell / 2;
      const py = cy * cell + cell / 2;
      if (px >= room.x0 && px < room.x1 && py >= room.y0 && py < room.y1) floor[cy * cols + cx] = 1;
    }
  }
  const { walls } = segmentFloor({ width: w, height: h, data }, floor, { cols, rows, cell });
  assert.equal(walls.length, 1, "one outline");
  const line = walls[0];
  assert.deepEqual(line[0], line.at(-1), "closed");
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  const near = (value, px) => Math.abs(value - px / cell) <= 0.3;
  assert.ok(near(Math.min(...xs), room.x0), `left ${Math.min(...xs)} vs ${room.x0 / cell}`);
  assert.ok(near(Math.max(...xs), room.x1), `right ${Math.max(...xs)} vs ${room.x1 / cell}`);
  assert.ok(near(Math.min(...ys), room.y0), `top ${Math.min(...ys)} vs ${room.y0 / cell}`);
  assert.ok(near(Math.max(...ys), room.y1), `bottom ${Math.max(...ys)} vs ${room.y1 / cell}`);
  assert.ok(line.length <= 12, `simplified to few points: ${line.length}`);
});

test("segmentFloor: no floor cells, no walls", () => {
  const data = new Uint8ClampedArray(24 * 24 * 4).fill(200);
  assert.deepEqual(segmentFloor({ width: 24, height: 24, data }, new Uint8Array(4), { cols: 2, rows: 2, cell: 12 }).walls, []);
});

/* -------------------------------------------- */
/*  Walls onto the drawn line                   */
/* -------------------------------------------- */

import { refineWalls } from "../scripts/refine.js";

/** A light room with a dark outline in noisy rock, 12 px per cell; the outline is the room's outer 2 px. */
function roomPicture({ cols = 12, rows = 10, cell = 12, room = { x0: 30, y0: 25, x1: 100, y1: 90 }, seed = 11 } = {}) {
  const w = cols * cell;
  const h = rows * cell;
  const rand = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = room && x >= room.x0 && x < room.x1 && y >= room.y0 && y < room.y1;
      const edge = inside && (x < room.x0 + 2 || x >= room.x1 - 2 || y < room.y0 + 2 || y >= room.y1 - 2);
      const noise = (rand() - 0.5) * 24;
      const [r, g, b] = edge ? [30, 20, 15] : inside ? [215, 200, 170] : [110, 70, 60];
      data[i] = r + noise;
      data[i + 1] = g + noise;
      data[i + 2] = b + noise;
      data[i + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data }, dims: { cols, rows, cell } };
}

test("refineWalls: walls half a cell off land on the drawn outline, corners stay corners", () => {
  const { image, dims } = roomPicture();
  // The outline runs at x ≈ 2.5..2.67 and 8.17..8.33, y ≈ 2.08..2.25 and 7.33..7.5 (cells).
  const walls = [
    [3, 2.5, 8, 2.5],
    [8, 2.5, 8, 7],
    [8, 7, 3, 7],
    [3, 7, 3, 2.5],
  ];
  const out = refineWalls(image, walls, [], dims);
  assert.equal(out.moved, 4);
  assert.equal(out.walls.length, 4, JSON.stringify(out.walls));
  const near = (v, a, b) => v >= a - 0.1 && v <= b + 0.1;
  for (const [x1, y1, x2, y2] of out.walls) {
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      assert.ok(near(x, 2.5, 2.67) || near(x, 8.17, 8.33), `x ${x}`);
      assert.ok(near(y, 2.08, 2.25) || near(y, 7.33, 7.5), `y ${y}`);
    }
  }
  // Still one closed outline: every corner is shared by exactly two walls.
  const uses = new Map();
  for (const [x1, y1, x2, y2] of out.walls) for (const k of [`${x1}|${y1}`, `${x2}|${y2}`]) uses.set(k, (uses.get(k) ?? 0) + 1);
  assert.deepEqual([...uses.values()], [2, 2, 2, 2]);
});

test("refineWalls: a door travels with the wall ends it sits between", () => {
  const { image, dims } = roomPicture();
  const walls = [
    [3, 2.5, 5, 2.5],
    [6, 2.5, 8, 2.5],
  ];
  const out = refineWalls(image, walls, [{ c: [5, 2.5, 6, 2.5], type: "door" }], dims);
  const [dx1, dy1, dx2, dy2] = out.doors[0].c;
  assert.equal(out.doors[0].type, "door");
  assert.ok(dy1 > 2 && dy1 < 2.35 && dy2 > 2 && dy2 < 2.35, String(out.doors[0].c));
  const ends = out.walls.flatMap(([x1, y1, x2, y2]) => [`${x1}|${y1}`, `${x2}|${y2}`]);
  assert.ok(ends.includes(`${dx1}|${dy1}`) && ends.includes(`${dx2}|${dy2}`), JSON.stringify(out));
});

test("refineWalls: nothing drawn, nothing moved", () => {
  // Texture only: the walls must come back exactly as they went in.
  const { image, dims } = roomPicture({ room: null });
  const walls = [
    [3, 2.5, 8, 2.5],
    [8, 2.5, 8, 7],
    [2, 4, 5.5, 8.5],
  ];
  const out = refineWalls(image, walls, [], dims);
  assert.equal(out.moved, 0);
  assert.deepEqual(out.walls, walls);
  assert.deepEqual(refineWalls(image, [], [], dims).walls, []);
});

/* -------------------------------------------- */
/*  Heights                                     */
/* -------------------------------------------- */

import { sideOf, mergeHeightLines } from "../scripts/geometry.js";
import { computeHeights } from "../scripts/heights.js";

test("normalizeTileReply: ledges and steps carry their higher side and height", () => {
  const tile = { view: { x0: 0, y0: 0, x1: 12, y1: 10 }, core: { x0: 0, y0: 0, x1: 12, y1: 10 } };
  const out = normalizeTileReply(
    {
      ledges: [{ line: [[6, 1], [6, 5], [8, 5]], high: [7, 3], drop: "10" }],
      steps: [{ line: [[2, 7], [4, 7]], high: [3, 6.5] }],
    },
    tile,
    {},
  );
  // The corner piece running the other way round the same high point has it on the same hand.
  assert.equal(out.ledges.length, 2);
  assert.equal(out.ledges[0].side, out.ledges[1].side);
  assert.notEqual(out.ledges[0].side, 0);
  assert.equal(out.ledges[0].drop, 10);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].drop, null);
  // The same line drawn in the other direction has the high point on the other hand.
  assert.equal(sideOf([[6, 5], [6, 1]], [7, 3]), -sideOf([[6, 1], [6, 5]], [7, 3]));
  assert.equal(sideOf([[6, 1], [6, 5]], null), 0);
});

test("mergeHeightLines: pieces join only when they agree on the higher side", () => {
  const side = sideOf([[0, 2], [4, 2]], [1, 1]);
  const merged = mergeHeightLines([
    { c: [0, 2, 2, 2], side, drop: null },
    // Same line, drawn backwards: the higher side is the same, the sign is not.
    { c: [4, 2, 2, 2], side: -side, drop: null },
    { c: [4, 2, 6, 2], side: -side, drop: null },
  ]);
  assert.equal(merged.length, 2);
  const long = merged.find((m) => m.c[2] - m.c[0] === 4);
  assert.deepEqual(long, { c: [0, 2, 4, 2], side, drop: null });
});

test("computeHeights: areas between walls and ledges get their heights, the largest is the main floor", () => {
  const walls = [
    [0.5, 0.5, 9.5, 0.5],
    [9.5, 0.5, 9.5, 5.5],
    [9.5, 5.5, 0.5, 5.5],
    [0.5, 5.5, 0.5, 0.5],
  ];
  const line = (c, high, drop = null) => ({ c, side: sideOf([[c[0], c[1]], [c[2], c[3]]], high), drop });
  const ledges = [
    // A cliff across the room, east side 10 higher; it stops a little short of the south wall.
    line([6, 0.5, 6, 5.1], [7, 3], 10),
    // A pit on the high part: lower inside, no height given.
    line([7, 2, 9, 2], [8, 1]),
    line([9, 2, 9, 4], [9.3, 3]),
    line([9, 4, 7, 4], [8, 5]),
    line([7, 4, 7, 2], [6.5, 3]),
  ];
  const out = computeHeights({ walls, ledges, cols: 10, rows: 6, defaultDrop: 5 });
  assert.deepEqual(out.stats, { resolved: 5, unresolved: 0, conflicts: 0 });
  assert.deepEqual(
    out.areas.map((a) => a.elevation),
    [0, 10, 5],
  );
  assert.deepEqual(out.ledges[0], { bottom: 0, top: 10 });
  assert.deepEqual(out.ledges[1], { bottom: 5, top: 10 });
  // The high part has the pit as a hole; outlines stay inside the room.
  assert.deepEqual(
    out.areas[1].shapes.map((s) => s.hole),
    [false, true],
  );
  for (const area of out.areas) for (const shape of area.shapes) assert.ok(shape.points.every((v) => v >= 0.5 && v <= 9.6), String(shape.points));
});

test("computeHeights: a ledge one can walk around, or without a higher side, decides nothing", () => {
  const walls = [
    [0.5, 0.5, 9.5, 0.5],
    [9.5, 0.5, 9.5, 5.5],
    [9.5, 5.5, 0.5, 5.5],
    [0.5, 5.5, 0.5, 0.5],
  ];
  const free = computeHeights({ walls, ledges: [{ c: [6, 2, 6, 4], side: 1, drop: 10 }], cols: 10, rows: 6, defaultDrop: 5 });
  assert.deepEqual(free.stats, { resolved: 0, unresolved: 1, conflicts: 0 });
  assert.deepEqual(free.areas, []);
  assert.deepEqual(free.ledges, [null]);
  const blind = computeHeights({ walls, ledges: [{ c: [6, 0.5, 6, 5.5], side: 0, drop: 10 }], cols: 10, rows: 6, defaultDrop: 5 });
  assert.equal(blind.stats.resolved, 0);
});

test("computeHeights: steps raise the floor without a wall, heights add up along the way", () => {
  // A corridor 1..9 × 2..3 with two flights of stairs, each going up to the east.
  const walls = [
    [1, 2, 9, 2],
    [9, 2, 9, 3],
    [9, 3, 1, 3],
    [1, 3, 1, 2],
  ];
  const step = (x) => ({ c: [x, 2, x, 3], side: sideOf([[x, 2], [x, 3]], [x + 0.5, 2.5]), drop: null });
  const out = computeHeights({ walls, ledges: [], steps: [step(4), step(6)], cols: 10, rows: 5, defaultDrop: 5 });
  assert.equal(out.stats.resolved, 2);
  // West part (3 cells) is the largest: the main floor.
  assert.deepEqual(out.areas.map((a) => a.elevation).sort((a, b) => a - b), [0, 5, 10]);
  assert.deepEqual(out.steps, [
    { bottom: 0, top: 5 },
    { bottom: 5, top: 10 },
  ]);
});
