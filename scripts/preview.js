/**
 * Canvas preview of an analysis result before anything is written to the scene: walls yellow, ledges orange,
 * doors violet, secret doors red, windows cyan, lights as tinted discs of their bright radius, and the areas of
 * floor with a worked-out height as tinted patches with the height written on them (steps as thin green lines).
 */
import { LIGHT_KINDS } from "./constants.js";

const COLORS = { wall: 0xffe14d, ledge: 0xff8a3d, door: 0xb46bff, secret: 0xff4d6d, window: 0x4dd2ff, step: 0x5fd38a };
/** Higher floor warm, lower floor blue, the main floor grey. */
const areaColor = (elevation) => (elevation > 0 ? 0xe8a23a : elevation < 0 ? 0x4d7bd6 : 0x7d98ad);

/**
 * A point inside a polygon to write on: the middle of the widest stretch of the polygon along the horizontal line
 * through the mean of its corners (the mean itself may lie outside a bent shape).
 * @param {number[]} points  flat [x, y, …]
 */
function labelPoint(points) {
  const count = points.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 2) {
    cx += points[i] / count;
    cy += points[i + 1] / count;
  }
  const crossings = [];
  for (let i = 0; i < points.length; i += 2) {
    const x1 = points[i];
    const y1 = points[i + 1];
    const x2 = points[(i + 2) % points.length];
    const y2 = points[(i + 3) % points.length];
    if (y1 <= cy === y2 <= cy) continue;
    crossings.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
  }
  crossings.sort((a, b) => a - b);
  let best = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    if (crossings[i + 1] - crossings[i] > best) {
      best = crossings[i + 1] - crossings[i];
      cx = (crossings[i] + crossings[i + 1]) / 2;
    }
  }
  return [cx, cy];
}

/** @type {PIXI.Container|null} */
let layer = null;

export function clearPreview() {
  if (!layer) return;
  layer.parent?.removeChild(layer);
  layer.destroy({ children: true });
  layer = null;
}

/**
 * @param {import("./analyze.js").AnalysisResult} result
 * @param {object} [options]
 * @param {number} [options.lightScale=1]
 * @param {boolean} [options.ledges=true]   draw the ledges (false when they will not be created)
 * @param {boolean} [options.areas=true]    draw the height areas (false when no regions will be created)
 */
export function showPreview(result, { lightScale = 1, ledges = true, areas = true } = {}) {
  clearPreview();
  if (!canvas?.ready || !result) return;
  const size = canvas.dimensions.size;
  const width = Math.max(3, size / 14);
  const root = new PIXI.Container();
  root.eventMode = "none";
  const g = root.addChild(new PIXI.Graphics());

  if (areas) {
    const units = canvas.scene.grid.units ?? "";
    for (const area of result.areas ?? []) {
      const color = areaColor(area.elevation);
      // Outer outline first, then its holes cut out of it.
      const [outer, ...holes] = [...area.shapes].sort((a, b) => Number(a.hole) - Number(b.hole));
      if (!outer) continue;
      g.lineStyle(Math.max(2, width / 2), color, 0.9);
      g.beginFill(color, 0.28);
      g.drawPolygon(outer.points);
      for (const hole of holes) {
        g.beginHole();
        g.drawPolygon(hole.points);
        g.endHole();
      }
      g.endFill();
      g.lineStyle(0);
      const [cx, cy] = labelPoint(outer.points);
      const text = new PIXI.Text(`${area.elevation > 0 ? "+" : ""}${area.elevation} ${units}`.trim(), {
        fontFamily: "Signika, sans-serif",
        fontSize: Math.max(24, size * 0.7),
        fontWeight: "bold",
        fill: 0xffffff,
        stroke: 0x000000,
        strokeThickness: Math.max(3, size / 22),
      });
      text.anchor.set(0.5);
      text.position.set(cx, cy);
      root.addChild(text);
    }
  }

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

  const stroke = (c, color, w = width) => {
    g.lineStyle(w, color, 0.95);
    g.moveTo(c[0], c[1]);
    g.lineTo(c[2], c[3]);
    g.lineStyle(0);
    g.beginFill(color, 1);
    g.drawCircle(c[0], c[1], w * 0.8);
    g.drawCircle(c[2], c[3], w * 0.8);
    g.endFill();
  };
  for (const c of result.walls) stroke(c, COLORS.wall);
  if (areas) for (const c of result.steps ?? []) stroke(c, COLORS.step, width * 0.6);
  if (ledges) for (const c of result.ledges ?? []) stroke(c, COLORS.ledge);
  for (const d of result.doors) stroke(d.c, COLORS[d.type] ?? COLORS.door);

  canvas.interface.addChild(root);
  layer = root;
}
