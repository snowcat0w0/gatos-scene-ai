/**
 * Turn an analysis result into Wall and AmbientLight documents, and take them back out again.
 * Everything created here carries `flags.gatos-scene-ai.generated`, so removing or replacing the module's own
 * work never touches walls and lights the GM placed by hand.
 */
import { MODULE_ID, FLAG_GENERATED, LIGHT_KINDS } from "./constants.js";

const isGenerated = (doc) => !!doc.flags?.[MODULE_ID]?.[FLAG_GENERATED];

/** Ids of the walls and lights this module created in a scene. */
export function generatedIds(scene) {
  return {
    walls: scene.walls.filter(isGenerated).map((w) => w.id),
    lights: scene.lights.filter(isGenerated).map((l) => l.id),
  };
}

function wallData(c, type, scene, flags) {
  const data = { c, flags };
  if (type === "door") data.door = CONST.WALL_DOOR_TYPES.DOOR;
  else if (type === "secret") data.door = CONST.WALL_DOOR_TYPES.SECRET;
  else if (type === "window") {
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
 * @returns {Promise<{walls: number, doors: number, lights: number, removed: number}>}
 */
export async function applyResult(scene, result, { replace = true, lightScale = 1 } = {}) {
  const removed = replace ? await removeGenerated(scene) : 0;
  const flags = { [MODULE_ID]: { [FLAG_GENERATED]: { run: foundry.utils.randomID(8) } } };
  const walls = [
    ...result.walls.map((c) => wallData(c, "wall", scene, flags)),
    ...result.doors.map((d) => wallData(d.c, d.type, scene, flags)),
  ];
  const lights = result.lights.map((l) => lightData(l, scene, flags, lightScale));
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
  if (lights.length) await scene.createEmbeddedDocuments("AmbientLight", lights);
  return { walls: result.walls.length, doors: result.doors.length, lights: lights.length, removed };
}

/**
 * Delete every wall and light this module created in the scene.
 * @returns {Promise<number>} how many documents were deleted
 */
export async function removeGenerated(scene) {
  const ids = generatedIds(scene);
  if (ids.walls.length) await scene.deleteEmbeddedDocuments("Wall", ids.walls);
  if (ids.lights.length) await scene.deleteEmbeddedDocuments("AmbientLight", ids.lights);
  return ids.walls.length + ids.lights.length;
}
