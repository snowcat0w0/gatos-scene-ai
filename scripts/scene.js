/**
 * Scene access that differs between Foundry versions, kept in one place.
 *
 * v14: a scene is a stack of levels, each with its own background (`level.background.src`); the scene as a whole
 * is moved with `shiftX` / `shiftY`. Walls, lights and regions name the levels they belong to.
 */

/**
 * The level of a scene the module works on: the one shown on the canvas when the scene is being viewed, otherwise
 * the scene's initial level.
 */
export function sceneLevel(scene) {
  if (!scene) return null;
  if (globalThis.canvas?.scene === scene && canvas.level) return canvas.level;
  return scene.initialLevel ?? scene.firstLevel ?? null;
}

/** Path of the background image or video of the scene's level, or null. */
export function backgroundSrc(scene) {
  return sceneLevel(scene)?.background?.src || null;
}

/**
 * Where things made from the level's map belong: `levels` for walls, lights and regions, and the height of the
 * level's floor, which heights read off the map are counted from.
 * @returns {{levels: string[], base: number}}
 */
export function placement(scene) {
  const level = sceneLevel(scene);
  return { levels: level ? [level.id] : [], base: level?.elevation?.bottom ?? 0 };
}

/** Current grid-related values of a scene, in the shape `applyGridValues` takes. */
export function readGridValues(scene) {
  return {
    type: scene.grid.type,
    size: scene.grid.size,
    width: scene.width,
    height: scene.height,
    offsetX: scene.shiftX ?? 0,
    offsetY: scene.shiftY ?? 0,
  };
}

/** Write grid values to the scene. `extra` is merged into the same update (flags). */
export function applyGridValues(scene, values, extra = {}) {
  return scene.update({
    "grid.type": values.type,
    "grid.size": values.size,
    width: values.width,
    height: values.height,
    shiftX: values.offsetX,
    shiftY: values.offsetY,
    ...extra,
  });
}

/**
 * The cell range of the canvas grid that the background covers.
 * @returns {{size: number, col0: number, row0: number, cols: number, rows: number}}
 */
export function mapCells(scene) {
  const d = scene.dimensions;
  const size = d.size;
  const col0 = Math.floor(d.sceneX / size + 1e-6);
  const row0 = Math.floor(d.sceneY / size + 1e-6);
  const col1 = Math.ceil((d.sceneX + d.sceneWidth) / size - 1e-6);
  const row1 = Math.ceil((d.sceneY + d.sceneHeight) / size - 1e-6);
  return { size, col0, row0, cols: Math.max(1, col1 - col0), rows: Math.max(1, row1 - row0) };
}
