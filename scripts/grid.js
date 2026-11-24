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
  const measured = toImagePixels(detectGrid(gray), gray);
  let detection = measured;
  let method = "signal";
  let verdict = null;
  let reason = null;
  let estimate = null;

  /** Show the model the current grid on a crop. A "half"/"double" verdict changes the period and earns a second look. */
  const verify = async () => {
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
        return;
      }
      verdict = typeof reply?.verdict === "string" ? reply.verdict.toLowerCase() : null;
      reason = typeof reply?.reason === "string" ? reply.reason : null;
      method = "signal+ai";
      if (verdict !== "half" && verdict !== "double") return;
      const target = detection.periodX * gray.scaleX * (verdict === "half" ? 2 : 0.5);
      const next = toImagePixels(detectGrid(gray, { hint: target }), gray);
      if (!next) return;
      detection = next;
    }
  };

  if (chat && detection && detection.confidence !== "low") await verify();

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
      const period = (image.width / across + image.height / down) / 2;
      // The model's count is a rough scale, a measurement is a measurement. A faint grid that was measured with
      // low confidence and lands near the count is kept as it is; otherwise the fit is repeated near the count.
      // Only when neither shows a grid does the count itself become the answer (and then nothing fixes where
      // the lines are).
      const usable = (d) => !!d && (d.confidence !== "low" || d.strength >= 0.15);
      const agrees = (d) => !!d && d.strength >= 0.1 && Math.abs(d.periodX / period - 1) <= 0.25;
      const near =
        verdict !== "wrong" && agrees(measured)
          ? measured
          : toImagePixels(detectGrid(gray, { hint: period * gray.scaleX }), gray);
      verdict = null;
      reason = null;
      if (usable(near) || agrees(near)) {
        detection = near.confidence === "low" ? { ...near, confidence: "medium" } : near;
        method = "signal+ai";
        await verify();
      } else {
        detection = {
          periodX: period,
          periodY: period,
          phaseX: 0,
          phaseY: 0,
          strength: 0,
          score: 0,
          z: 0,
          confidence: "low",
          candidates: [],
        };
        method = "ai";
      }
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
 * @param {object} [options]
 * @param {number} [options.minSize=50]        cells narrower than this on the image are scaled up
 * @param {number} [options.scaledSize=100]    grid size used when scaling up
 * @returns {{size, width, height, offsetX, offsetY}}
 */
export function gridValuesFor(det, image, { minSize = 50, scaledSize = 100 } = {}) {
  // A map with cells of 50 px or more keeps its own resolution. A small scan (17 px cells) is enlarged to a
  // 100 px grid: tokens stay legible, and the whole-pixel background offset is then fine enough to matter.
  const period = (det.periodX + det.periodY) / 2;
  const size = period >= minSize ? Math.round(period) : scaledSize;
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
