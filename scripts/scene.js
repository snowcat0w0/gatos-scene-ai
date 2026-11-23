/**
 * Scene access that differs between Foundry versions, kept in one place.
 *
 * v13: one background per scene (`scene.background.src`), moved with `background.offsetX` / `background.offsetY`.
 */

/** Path of the scene's background image or video, or null. */
export function backgroundSrc(scene) {
  return scene?.background?.src || null;
}

/** Current grid-related values of a scene, in the shape `applyGridValues` takes. */
export function readGridValues(scene) {
  return {
    type: scene.grid.type,
    size: scene.grid.size,
    width: scene.width,
    height: scene.height,
    offsetX: scene.background?.offsetX ?? 0,
    offsetY: scene.background?.offsetY ?? 0,
  };
}

/** Write grid values to the scene. `extra` is merged into the same update (flags). */
export function applyGridValues(scene, values, extra = {}) {
  return scene.update({
    "grid.type": values.type,
    "grid.size": values.size,
    width: values.width,
    height: values.height,
    "background.offsetX": values.offsetX,
    "background.offsetY": values.offsetY,
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
