/**
 * Grid alignment: find the grid printed on the background and work out the scene values that put Foundry's grid
 * on top of it.
 *
 * Signal analysis (grid-detect.js) measures the period and phase; the model is used for what it is good at —
 * judging whether the measured grid is the right one (not half or double the real cell) and estimating the scale
 * of a map that has no drawn grid.
 */
import { detectGrid } from "./grid-detect.js";
import { extractJson, JsonExtractError } from "./json.js";
import { loadSource, toGray, renderGridCheck, renderOverview } from "./image.js";
import { SYSTEM, gridVerifyPrompt, gridEstimatePrompt } from "./prompts.js";
import { backgroundSrc } from "./scene.js";

/** Scale a detection made on the grayscale copy back to image pixels. */
function toImagePixels(d, gray) {
  if (!d) return null;
  return {
    ...d,
    periodX: d.periodX / gray.scaleX,
    periodY: d.periodY / gray.scaleY,
    phaseX: d.phaseX / gray.scaleX,
    phaseY: d.phaseY / gray.scaleY,
  };
}

/**
 * @typedef GridResult
 * @property {object} detection          periodX/periodY/phaseX/phaseY in image pixels, confidence
 * @property {{width, height}} image     natural size of the background
 * @property {"signal"|"signal+ai"|"ai"} method
 * @property {string|null} verdict       the model's verdict on the measured grid, when asked
 * @property {string|null} reason        the model's one-line reason
 * @property {object|null} estimate      the model's cell-count estimate, when asked
 */

/**
 * Detect the grid of a scene's background.
 * @param {Scene} scene
 * @param {object} [options]
 * @param {(request: object) => Promise<{text: string}>} [options.chat]  send a vision request; omit for signal analysis only
 * @param {AbortSignal} [options.signal]
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<GridResult|null>}  null when nothing usable was found
 */
export async function detectSceneGrid(scene, { chat, signal, onStep = () => {} } = {}) {
  const src = backgroundSrc(scene);
  if (!src) return null;
  onStep("load");
  const source = await loadSource(src);
  const gray = toGray(source, 2048);
  const image = { width: source.width, height: source.height };

  onStep("measure");
  let detection = toImagePixels(detectGrid(gray), gray);
  let method = "signal";
  let verdict = null;
  let reason = null;
  let estimate = null;

  if (chat && detection && detection.confidence !== "low") {
    // Two rounds: a "half"/"double" verdict changes the period, and the new grid is worth one more look.
    for (let round = 0; round < 2; round++) {
      onStep("verify");
      const crop = renderGridCheck(source, detection, gray);
      let reply;
      try {
        reply = extractJson(
          (await chat({ system: SYSTEM, text: gridVerifyPrompt({ cells: crop.cells }), images: [crop], json: true, signal })).text,
        );
      } catch (err) {
        // An unreadable verdict is no verdict: keep the measured grid.
        if (!(err instanceof JsonExtractError)) throw err;
        break;
      }
      verdict = typeof reply?.verdict === "string" ? reply.verdict.toLowerCase() : null;
      reason = typeof reply?.reason === "string" ? reply.reason : null;
      method = "signal+ai";
      if (verdict !== "half" && verdict !== "double") break;
      const target = detection.periodX * gray.scaleX * (verdict === "half" ? 2 : 0.5);
      const next = toImagePixels(detectGrid(gray, { hint: target }), gray);
      if (!next) break;
      detection = next;
    }
  }

  if (chat && (!detection || detection.confidence === "low" || verdict === "wrong")) {
    onStep("estimate");
    const overview = renderOverview(source, 1024);
    let reply = null;
    try {
      reply = extractJson(
        (await chat({ system: SYSTEM, text: gridEstimatePrompt(image), images: [overview], json: true, signal })).text,
      );
    } catch (err) {
      if (!(err instanceof JsonExtractError)) throw err;
    }
    const across = Number(reply?.cellsAcross);
    const down = Number(reply?.cellsDown);
    if (across >= 2 && down >= 2) {
      estimate = { hasGrid: !!reply.hasGrid, cellsAcross: across, cellsDown: down, basis: String(reply.basis ?? "") };
      // The count fixes the scale; where a drawn grid exists, the signal fit near that scale fixes the rest.
      const period = (image.width / across + image.height / down) / 2;
      const near = toImagePixels(detectGrid(gray, { hint: period * gray.scaleX }), gray);
      if (near && near.confidence !== "low") {
        detection = near;
        method = "signal+ai";
      } else {
        detection = {
          periodX: period,
          periodY: period,
          phaseX: 0,
          phaseY: 0,
          strength: 0,
          score: 0,
          confidence: "low",
          candidates: [],
        };
        method = "ai";
      }
      verdict = null;
    }
  }

  if (!detection) return null;
  return { detection, image, method, verdict, reason, estimate };
}

/**
 * Scene values that lay Foundry's square grid over the detected one.
 *
 * The background is stretched to the scene's width × height, so scaling those makes one printed cell exactly
 * `size` canvas pixels; the offset then slides the printed lines onto the canvas grid lines
 * (`sceneX = paddingX - offsetX`, and paddingX is a multiple of the grid size).
 * @param {{periodX, periodY, phaseX, phaseY}} det   image pixels
 * @param {{width, height}} image
 * @param {number} [minSize]                         smallest grid size Foundry accepts
 * @returns {{size, width, height, offsetX, offsetY}}
 */
export function gridValuesFor(det, image, minSize = 50) {
  const size = Math.max(minSize, Math.round((det.periodX + det.periodY) / 2));
  const kx = size / det.periodX;
  const ky = size / det.periodY;
  const wrap = (v) => {
    let o = ((Math.round(v) % size) + size) % size;
    if (o > size / 2) o -= size;
    return o;
  };
  return {
    size,
    width: Math.round(image.width * kx),
    height: Math.round(image.height * ky),
    offsetX: wrap(det.phaseX * kx),
    offsetY: wrap(det.phaseY * ky),
  };
}
