/**
 * Walls, doors and lights from the background image.
 *
 * The map is cut into tiles of a few cells. Each tile is shown to the model with a numbered grid drawn on it, so
 * the model reads positions off the numbers instead of guessing pixels. The replies are snapped, clipped to the
 * part of the map each tile owns, and stitched back together.
 */
import { extractJson, JsonExtractError } from "./json.js";
import { planTiles, normalizeTileReply, mergeWallsAndDoors, dedupePoints } from "./geometry.js";
import { loadSource, renderTile, renderOverview } from "./image.js";
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
 * @property {Array<{c: number[], type: string}>} doors      type: door | secret | window
 * @property {Array<{x, y, kind, color}>} lights             canvas pixels
 * @property {number} tiles
 * @property {Array<{index: number, message: string}>} failed
 * @property {{input: number, output: number}} usage
 * @property {string} context
 */

/**
 * @param {Scene} scene
 * @param {object} o
 * @param {(request: object) => Promise<{text, truncated, usage}>} o.chat
 * @param {{walls: boolean, doors: boolean, lights: boolean}} o.want
 * @param {number} [o.tileCells=12]
 * @param {number} [o.snapStep=0.5]
 * @param {boolean} [o.overview=true]
 * @param {number} [o.maxImagePx=1024]
 * @param {number} [o.concurrency=1]
 * @param {AbortSignal} [o.signal]
 * @param {(p: {phase: string, done: number, total: number}) => void} [o.onProgress]
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeScene(scene, o) {
  const { chat, want, tileCells = 12, snapStep = 0.5, overview = true, maxImagePx = 1024, concurrency = 1, signal } = o;
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
  const doors = [];
  const lights = [];
  const failed = [];

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
      want,
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

  const merged = mergeWallsAndDoors(walls, doors, 0.05);
  const px = (v, origin) => Math.round((origin + v) * size);
  const toPixels = ([x1, y1, x2, y2]) => [px(x1, col0), px(y1, row0), px(x2, col0), px(y2, row0)];
  return {
    walls: merged.walls.map(toPixels),
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
