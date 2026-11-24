/**
 * Turn an analysis result into Wall, AmbientLight and Region documents, and take them back out again.
 * Everything created here carries `flags.gatos-scene-ai.generated`, so removing or replacing the module's own
 * work never touches walls, lights and regions the GM placed by hand.
 */
import { mod, MODULE_ID, FLAG_GENERATED, FLAG_GROUND, LIGHT_KINDS } from "./constants.js";

const isGenerated = (doc) => !!doc.flags?.[MODULE_ID]?.[FLAG_GENERATED];

/** Ids of the walls, lights and height regions this module created in a scene. */
export function generatedIds(scene) {
  return {
    walls: scene.walls.filter(isGenerated).map((w) => w.id),
    lights: scene.lights.filter(isGenerated).map((l) => l.id),
    regions: scene.regions.filter(isGenerated).map((r) => r.id),
  };
}

/** Is the Wall Height module there to make sense of a wall's top? */
export const wallHeightActive = () => !!game.modules.get("wall-height")?.active;

/**
 * A region for one area of floor of a given height. The height is the region's own bottom elevation, so the GM
 * can change it in the region's configuration; ground.js puts tokens that walk in at that elevation.
 */
function regionData(area, scene, flags) {
  const e = area.elevation;
  const amount = `${e > 0 ? "+" : ""}${e} ${scene.grid.units ?? ""}`.trim();
  return {
    name: mod.L("Heights.RegionName", { amount }),
    color: e > 0 ? "#e8a23a" : e < 0 ? "#4d7bd6" : "#7d98ad",
    shapes: area.shapes.map((shape) => ({ type: "polygon", points: shape.points, hole: shape.hole })),
    elevation: { bottom: e, top: null },
    flags: { [MODULE_ID]: { ...flags[MODULE_ID], [FLAG_GROUND]: true } },
  };
}

function wallData(c, type, scene, flags) {
  const data = { c, flags };
  if (type === "door") data.door = CONST.WALL_DOOR_TYPES.DOOR;
  else if (type === "secret") data.door = CONST.WALL_DOOR_TYPES.SECRET;
  else if (type === "ledge-invisible") {
    // Foundry's Invisible wall: stops movement, lets sight, light and sound through. A drop you can see over.
    data.sight = data.light = data.sound = CONST.WALL_SENSE_TYPES.NONE;
  } else if (type === "ledge-terrain") {
    // Foundry's Terrain wall: sight and light pass the first such wall only.
    data.sight = data.light = data.sound = CONST.WALL_SENSE_TYPES.LIMITED;
  } else if (type === "window") {
    // Same values as Foundry's own Window wall tool.
    const d = scene.dimensions.distance;
    data.sight = data.light = CONST.WALL_SENSE_TYPES.PROXIMITY;
    data.threshold = { light: 2 * d, sight: 2 * d, attenuation: true };
  }
  return data;
}

function lightData(light, scene, flags, scale) {
  const preset = LIGHT_KINDS[light.kind] ?? LIGHT_KINDS.torch;
  const unit = scene.dimensions.distance * scale;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    x: light.x,
    y: light.y,
    config: {
      bright: round(preset.bright * unit),
      dim: round(preset.dim * unit),
      color: light.color ?? preset.color,
      alpha: preset.alpha,
      animation: { ...preset.animation },
    },
    flags,
  };
}

/**
 * Create the walls, doors and lights of a result in the scene.
 * @param {Scene} scene
 * @param {import("./analyze.js").AnalysisResult} result
 * @param {object} [options]
 * @param {boolean} [options.replace=true]   first delete what this module created before
 * @param {number} [options.lightScale=1]    multiplier on the light radii
 * @param {"invisible"|"terrain"|"wall"|"height"|"none"} [options.ledgeMode="invisible"]  what cliff edges become.
 *        "height": a full wall that carries the height of the upper floor as its top for the Wall Height module,
 *        so that it hides what is above from below and nothing from above. Ledges whose heights are not known,
 *        and all ledges when Wall Height is not active, become invisible walls instead.
 * @param {boolean} [options.heights=true]   create a region for every area of floor with a worked-out height
 * @returns {Promise<{walls: number, ledges: number, doors: number, lights: number, areas: number, removed: number}>}
 */
export async function applyResult(scene, result, { replace = true, lightScale = 1, ledgeMode = "invisible", heights = true } = {}) {
  const removed = replace ? await removeGenerated(scene) : 0;
  const flags = { [MODULE_ID]: { [FLAG_GENERATED]: { run: foundry.utils.randomID(8) } } };
  const ledgeType = { invisible: "ledge-invisible", terrain: "ledge-terrain", wall: "wall", height: "ledge-invisible" }[ledgeMode];
  const ledges = ledgeType ? (result.ledges ?? []) : [];
  const tall = ledgeMode === "height" && wallHeightActive();
  const ledgeWalls = ledges.map((c, i) => {
    const known = tall ? result.ledgeHeights?.[i] : null;
    if (!known) return wallData(c, ledgeType, scene, flags);
    // Wall Height: a wall stops the sight of eyes that are not above its top.
    return wallData(c, "wall", scene, { ...flags, "wall-height": { top: known.top } });
  });
  const walls = [
    ...result.walls.map((c) => wallData(c, "wall", scene, flags)),
    ...ledgeWalls,
    ...result.doors.map((d) => wallData(d.c, d.type, scene, flags)),
  ];
  const lights = result.lights.map((l) => lightData(l, scene, flags, lightScale));
  const regions = heights ? (result.areas ?? []).map((area) => regionData(area, scene, flags)) : [];
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
  if (lights.length) await scene.createEmbeddedDocuments("AmbientLight", lights);
  if (regions.length) await scene.createEmbeddedDocuments("Region", regions);
  return {
    walls: result.walls.length,
    ledges: ledges.length,
    doors: result.doors.length,
    lights: lights.length,
    areas: regions.length,
    removed,
  };
}

/**
 * Delete every wall, light and height region this module created in the scene.
 * @returns {Promise<number>} how many documents were deleted
 */
export async function removeGenerated(scene) {
  const ids = generatedIds(scene);
  if (ids.walls.length) await scene.deleteEmbeddedDocuments("Wall", ids.walls);
  if (ids.lights.length) await scene.deleteEmbeddedDocuments("AmbientLight", ids.lights);
  if (ids.regions.length) await scene.deleteEmbeddedDocuments("Region", ids.regions);
  return ids.walls.length + ids.lights.length + ids.regions.length;
}
