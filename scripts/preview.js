/**
 * Canvas preview of an analysis result before anything is written to the scene: walls yellow, doors violet,
 * secret doors red, windows cyan, lights as tinted discs of their bright radius.
 */
import { LIGHT_KINDS } from "./constants.js";

const COLORS = { wall: 0xffe14d, door: 0xb46bff, secret: 0xff4d6d, window: 0x4dd2ff };

/** @type {PIXI.Graphics|null} */
let graphics = null;

export function clearPreview() {
  if (!graphics) return;
  graphics.parent?.removeChild(graphics);
  graphics.destroy();
  graphics = null;
}

/**
 * @param {import("./analyze.js").AnalysisResult} result
 * @param {object} [options]
 * @param {number} [options.lightScale=1]
 */
export function showPreview(result, { lightScale = 1 } = {}) {
  clearPreview();
  if (!canvas?.ready || !result) return;
  const size = canvas.dimensions.size;
  const width = Math.max(3, size / 14);
  const g = new PIXI.Graphics();
  g.eventMode = "none";

  for (const light of result.lights) {
    const preset = LIGHT_KINDS[light.kind] ?? LIGHT_KINDS.torch;
    const color = PIXI.Color ? new PIXI.Color(light.color ?? preset.color).toNumber() : 0xffaa33;
    const radius = Math.max(size * 0.5, preset.bright * size * lightScale);
    g.lineStyle(Math.max(2, width / 2), color, 0.8);
    g.beginFill(color, 0.12);
    g.drawCircle(light.x, light.y, radius);
    g.endFill();
    g.lineStyle(0);
    g.beginFill(color, 1);
    g.drawCircle(light.x, light.y, Math.max(5, size / 9));
    g.endFill();
  }

  const stroke = (c, color) => {
    g.lineStyle(width, color, 0.95);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
    g.lineStyle(0);
    g.beginFill(color, 1);
    g.drawCircle(c[0], c[1], width * 0.8);
    g.drawCircle(c[2], c[3], width * 0.8);
    g.endFill();
  };
  for (const c of result.walls) stroke(c, COLORS.wall);
  for (const d of result.doors) stroke(d.c, COLORS[d.type] ?? COLORS.door);

  canvas.interface.addChild(g);
  graphics = g;
}
