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
