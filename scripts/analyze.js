/**
 * Walls, doors, ledges and lights from the background image.
 *
 * The map is cut into tiles of a few cells. Each tile is shown to the model with a numbered grid drawn on it, so
 * the model reads positions off the numbers instead of guessing pixels. The replies are clipped to the part of
 * the map each tile owns and stitched back together.
 *
 * Two ways to get the walls:
 *   - "coords" (default): the model traces every wall itself as coordinates. Coarser, but independent of how the
 *     map is painted, and what real models have done best so far.
 *   - "trace": the model says where the floor is, and the outline of that floor is traced in the pixels
 *     (segment.js). The model's coordinates are then only used for what a floor map cannot express: thin walls,
 *     doors, ledges, lights. Pixel-exact when the floor answer is right; a floor answer one cell off breaks the
 *     outline into steps, because the tracing only looks for the line within a cell of where the model put it.
 *
 * Walls given as coordinates are then pulled onto the line drawn in the picture (refine.js): the model gets the
 * course of a wall right but its position only to about half a cell.
 *
 * Heights: the model marks cliff edges and the middle of stairs and slopes, and which side of each is higher.
 * From those lines and the walls the height of every area of floor is worked out (heights.js).
 */
import { extractJson, JsonExtractError } from "./json.js";
import {
  planTiles,
  normalizeTileReply,
  mergeWallsAndDoors,
  mergeColinear,
  mergeHeightLines,
  polylineSegments,
  dedupePoints,
} from "./geometry.js";
import { loadSource, renderTile, renderOverview, renderWork } from "./image.js";
import { segmentFloor } from "./segment.js";
import { refineWalls } from "./refine.js";
import { computeHeights } from "./heights.js";
import { SYSTEM, tilePrompt, overviewPrompt, overviewToContext } from "./prompts.js";
import { ProviderError } from "./providers/index.js";
import { backgroundSrc, mapCells } from "./scene.js";

/** Errors that will hit every tile the same way: stop instead of failing tile after tile. */
const FATAL = new Set(["auth", "config", "network", "notfound", "aborted"]);

/** Run `worker` over `items` with at most `limit` running at once. Rejects on the first worker error. */
async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * @typedef AnalysisResult
 * @property {number[][]} walls                              `[x1, y1, x2, y2]` in canvas pixels
 * @property {number[][]} ledges                             cliff edges and drop-offs, same shape
 * @property {Array<{bottom: number, top: number}|null>} ledgeHeights   per ledge: the floor heights on its low and
 *           high side in scene distance units, or null where they could not be worked out
 * @property {number[][]} steps                              lines across stairs and slopes (no wall is made of them)
 * @property {Array<{elevation: number, shapes: Array<{points: number[], hole: boolean}>}>} areas
 *           areas of floor with their height; points are flat [x, y, …] lists in canvas pixels
 * @property {{resolved: number, unresolved: number, conflicts: number}|null} heights   how the height lines fared
 * @property {Array<{c: number[], type: string}>} doors      type: door | secret | window
 * @property {Array<{x, y, kind, color}>} lights             canvas pixels
 * @property {{chains: number, moved: number}|null} refined   wall stretches looked at / moved onto a drawn line
 * @property {number} tiles
 * @property {Array<{index: number, message: string}>} failed
 * @property {{input: number, output: number}} usage
 * @property {string} context
 */

/**
 * @param {Scene} scene
 * @param {object} o
 * @param {(request: object) => Promise<{text, truncated, usage}>} o.chat
 * @param {{walls: boolean, ledges?: boolean, heights?: boolean, doors: boolean, lights: boolean}} o.want
 *        heights: work out the height of the floor on both sides of every ledge and step (asks for ledges too)
 * @param {number} [o.dropDefault]       height of a ledge or step the map gives no number for, in scene distance
 *                                       units (default: two cells)
 * @param {"trace"|"coords"} [o.method="coords"]
 * @param {number} [o.tileCells=12]
 * @param {number} [o.snapStep=0.5]
 * @param {boolean} [o.refine=true]      pull walls given as coordinates onto the drawn lines
 * @param {boolean} [o.overview=true]
 * @param {number} [o.maxImagePx=1024]
 * @param {number} [o.concurrency=1]
 * @param {AbortSignal} [o.signal]
 * @param {(p: {phase: string, done: number, total: number}) => void} [o.onProgress]
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeScene(scene, o) {
  const { chat, tileCells = 12, snapStep = 0.5, refine = true, overview = true, maxImagePx = 1024, concurrency = 1, signal } = o;
  // Heights are read off the ledges, so asking for heights asks for ledges.
  const want = { ...o.want, ledges: !!(o.want.ledges || o.want.heights) };
  const trace = want.walls && o.method === "trace";
  const onProgress = o.onProgress ?? (() => {});
  const src = backgroundSrc(scene);
  if (!src) throw new Error("scene has no background");
  const source = await loadSource(src);

  const d = scene.dimensions;
  const { size, col0, row0, cols, rows } = mapCells(scene);
  const tiles = planTiles(cols, rows, Math.max(4, Math.round(tileCells)));
  const total = tiles.length + (overview ? 1 : 0);
  let done = 0;
  const usage = { input: 0, output: 0 };
  const count = (u) => {
    usage.input += u?.input ?? 0;
    usage.output += u?.output ?? 0;
  };
  onProgress({ phase: overview ? "overview" : "tiles", done, total });

  let context = "";
  if (overview) {
    try {
      const reply = await chat({ system: SYSTEM, text: overviewPrompt(), images: [renderOverview(source, maxImagePx)], json: true, signal });
      count(reply.usage);
      context = overviewToContext(extractJson(reply.text));
    } catch (err) {
      // The overview only adds context; a model that fumbles it can still trace tiles.
      if (err instanceof ProviderError && FATAL.has(err.kind)) throw err;
    }
    onProgress({ phase: "tiles", done: ++done, total });
  }

  // Image pixels per canvas pixel: the background is stretched over the scene rectangle.
  const kx = source.width / d.sceneWidth;
  const ky = source.height / d.sceneHeight;
  const cellSize = `${scene.grid.distance} ${scene.grid.units ?? ""}`.trim();

  const walls = [];
  const ledges = [];
  const steps = [];
  const doors = [];
  const lights = [];
  const failed = [];
  /** Walkable cells reported by the model, row-major over the map's cols × rows. */
  const floor = new Uint8Array(cols * rows);

  const analyseTile = async (tile) => {
    const { view } = tile;
    const tc = view.x1 - view.x0;
    const tr = view.y1 - view.y0;
    const image = renderTile(source, {
      rect: {
        x: ((col0 + view.x0) * size - d.sceneX) * kx,
        y: ((row0 + view.y0) * size - d.sceneY) * ky,
        w: tc * size * kx,
        h: tr * size * ky,
      },
      cols: tc,
      rows: tr,
      maxEdge: maxImagePx,
    });
    const text = tilePrompt({
      cols: tc,
      rows: tr,
      want: { ...want, floor: trace },
      context,
      cellSize,
      continues: { left: view.x0 > 0, right: view.x1 < cols, top: view.y0 > 0, bottom: view.y1 < rows },
    });
    const reply = await chat({ system: SYSTEM, text, images: [image], json: true, signal });
    count(reply.usage);
    return normalizeTileReply(extractJson(reply.text), tile, { snapStep });
  };

  await pool(tiles, Math.max(1, concurrency), async (tile) => {
    let lastError = null;
    // One retry: a reply cut off or mangled once usually comes out fine the second time.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new ProviderError("aborted", "request cancelled");
      try {
        const part = await analyseTile(tile);
        if (want.walls) walls.push(...part.walls);
        if (want.ledges) ledges.push(...part.ledges);
        if (want.heights) steps.push(...part.steps);
        if (trace) for (const [c, r] of part.floor) floor[r * cols + c] = 1;
        if (want.doors) doors.push(...part.doors);
        if (want.lights) lights.push(...part.lights);
        lastError = null;
        break;
      } catch (err) {
        if (err instanceof ProviderError && FATAL.has(err.kind)) throw err;
        if (!(err instanceof ProviderError) && !(err instanceof JsonExtractError)) throw err;
        lastError = err;
      }
    }
    if (lastError) failed.push({ index: tile.index, message: lastError.detail || lastError.message });
    onProgress({ phase: "tiles", done: ++done, total });
  });

  // The picture at a fixed number of pixels per cell, for the passes that look at pixels.
  let work = null;
  const workImage = () => {
    if (work) return work;
    // As many pixels per cell as the picture has, within reason: more adds nothing, fewer loses the line.
    let cell = Math.max(10, Math.min(24, Math.round(size * kx)));
    while (cell > 8 && cols * rows * cell * cell > 6e6) cell--;
    const image = renderWork(source, {
      rect: { x: (col0 * size - d.sceneX) * kx, y: (row0 * size - d.sceneY) * ky, w: cols * size * kx, h: rows * size * ky },
      cols,
      rows,
      cell,
    });
    return (work = { cell, image });
  };

  // What the model gave as coordinates: merged, doors cut out of the walls, then moved onto the drawn lines.
  let merged = mergeWallsAndDoors(walls, doors, 0.05);
  let refined = null;
  if (refine && want.walls && merged.walls.length) {
    onProgress({ phase: "refine", done, total });
    const { cell, image } = workImage();
    const moved = refineWalls(image, merged.walls, merged.doors, { cols, rows, cell });
    merged = { walls: moved.walls, doors: moved.doors };
    refined = { chains: moved.chains, moved: moved.moved };
  }

  let floorCells = 0;
  if (trace) {
    for (let i = 0; i < floor.length; i++) floorCells += floor[i];
    onProgress({ phase: "trace", done, total });
    const { cell, image } = workImage();
    const outline = [];
    for (const line of segmentFloor(image, floor, { cols, rows, cell }).walls) outline.push(...polylineSegments(line));
    merged.walls = [...merged.walls, ...mergeColinear(outline, 0.05)];
  }

  // Heights of the floor on both sides of every ledge and step.
  const ledgeLines = mergeHeightLines(ledges, 0.05);
  const stepLines = mergeHeightLines(steps, 0.05);
  let heights = null;
  if (want.heights && ledgeLines.length + stepLines.length) {
    onProgress({ phase: "heights", done, total });
    heights = computeHeights({
      walls: merged.walls,
      ledges: ledgeLines,
      steps: stepLines,
      cols,
      rows,
      defaultDrop: o.dropDefault > 0 ? o.dropDefault : 2 * scene.grid.distance,
    });
  }

  const px = (v, origin) => Math.round((origin + v) * size);
  const toPixels = ([x1, y1, x2, y2]) => [px(x1, col0), px(y1, row0), px(x2, col0), px(y2, row0)];
  const notPoint = (c) => c[0] !== c[2] || c[1] !== c[3];
  const ledgeOut = ledgeLines.map((line, i) => ({ c: toPixels(line.c), height: heights?.ledges[i] ?? null })).filter((l) => notPoint(l.c));
  return {
    walls: merged.walls.map(toPixels).filter(notPoint),
    ledges: ledgeOut.map((l) => l.c),
    ledgeHeights: ledgeOut.map((l) => l.height),
    steps: stepLines.map((line) => toPixels(line.c)).filter(notPoint),
    areas: (heights?.areas ?? []).map((area) => ({
      elevation: area.elevation,
      shapes: area.shapes.map((shape) => ({ hole: shape.hole, points: shape.points.map((v, i) => px(v, i % 2 ? row0 : col0)) })),
    })),
    heights: heights?.stats ?? null,
    method: trace ? "trace" : "coords",
    floorCells,
    refined,
    doors: merged.doors.map((door) => ({ c: toPixels(door.c), type: door.type })),
    lights: dedupePoints(lights, 0.5).map((l) => ({ x: px(l.x, col0), y: px(l.y, row0), kind: l.kind, color: l.color })),
    tiles: tiles.length,
    failed: failed.sort((a, b) => a.index - b.index),
    usage,
    context,
  };
}

/** Number of requests an analysis will send, for the panel. */
export function requestCount(scene, { tileCells = 12, overview = true } = {}) {
  const { cols, rows } = mapCells(scene);
  return planTiles(cols, rows, Math.max(4, Math.round(tileCells))).length + (overview ? 1 : 0);
}
