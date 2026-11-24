/**
 * Tokens follow the height of the floor.
 *
 * The regions made from an analysis ("ground" regions) each stand for an area of floor at one height: the
 * region's own bottom elevation, which the GM can change in the region's configuration. When a token that was
 * standing on the ground ends a move inside such a region, its elevation is set to that height. Foundry then uses
 * the elevation for distances, and Wall Height for what the token can see over.
 *
 * Only the active GM's client does this, so it happens once however many people are connected.
 */
import { mod, MODULE_ID, FLAG_GROUND } from "./constants.js";

/** Elevations that went through an animated move come back with rounding noise (29.999999999999996). */
const same = (a, b) => Math.abs(a - b) < 1e-3;

/**
 * Height of the floor at a point of a scene, or null where no ground region covers it.
 * @param {Scene} scene
 * @param {{x: number, y: number}} point
 * @param {string} [level]   only regions of this level count (default: every level)
 */
export function groundAt(scene, point, level) {
  let height = null;
  for (const region of scene.regions) {
    if (!region.flags?.[MODULE_ID]?.[FLAG_GROUND]) continue;
    if (level && !region.includedInLevel(level)) continue;
    // In plan only: the region's elevation range says how high its floor is, not who is inside.
    if (!region.polygonTree.testPoint(point)) continue;
    const bottom = region.elevation.bottom ?? 0;
    if (height === null || bottom > height) height = bottom;
  }
  return height;
}

async function onMoveToken(token, movement, operation) {
  if (!game.users.activeGM?.isSelf || !mod.setting("groundFollow")) return;
  if (operation?.[MODULE_ID]?.ground) return; // the update made below
  if (movement.pending?.waypoints?.length) return; // still on its way
  const scene = token.parent;
  if (!scene?.regions?.size) return;
  const { origin, destination } = movement;
  // The move itself changed the elevation or the level: whoever moved the token meant that.
  if (!same(origin.elevation, destination.elevation)) return;
  if ((origin.level ?? null) !== (destination.level ?? null)) return;
  const to = groundAt(scene, token.getCenterPoint(destination), destination.level ?? token.level);
  if (to === null || same(to, destination.elevation)) return;
  // A token that was not standing on the ground where it came from is flying or climbing: leave it alone.
  const from = groundAt(scene, token.getCenterPoint(origin), origin.level ?? token.level);
  if (from !== null && !same(origin.elevation, from)) return;

  // Let the move play out first; changing the elevation is a move of its own and would cut the animation short.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await token.object?.movementAnimationPromise;
  if (token.x !== destination.x || token.y !== destination.y || !same(token.elevation, destination.elevation)) return;
  await token.update({ elevation: to }, { [MODULE_ID]: { ground: true }, animate: false });
}

export function registerGround() {
  Hooks.on("moveToken", (token, movement, operation) => {
    onMoveToken(token, movement, operation).catch((err) => mod.log("ground", err));
  });
}
