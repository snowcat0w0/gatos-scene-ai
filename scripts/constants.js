import { defineModule } from "./lib.js";

export const MODULE_ID = "gatos-scene-ai";
export const mod = defineModule(MODULE_ID, { langPrefix: "GATOSSA" });

/** Flag on walls and lights this module created: `{ run: "<id>" }`. */
export const FLAG_GENERATED = "generated";
/** On a region: the floor inside lies at the region's bottom elevation (ground.js). */
export const FLAG_GROUND = "ground";
/** Flag on the scene: the grid settings before the last "apply grid", for undo. */
export const FLAG_GRID_BACKUP = "gridBackup";

/**
 * Light presets per kind the model can report. Radii are in grid cells and are multiplied by the scene's grid
 * distance when the light is created (a torch is 4 cells bright / 8 dim = 20 ft / 40 ft on a 5 ft grid).
 */
export const LIGHT_KINDS = Object.freeze({
  torch: { bright: 4, dim: 8, color: "#ff9329", alpha: 0.4, animation: { type: "torch", speed: 2, intensity: 3 } },
  candle: { bright: 1, dim: 2, color: "#ffb347", alpha: 0.35, animation: { type: "torch", speed: 2, intensity: 2 } },
  lantern: { bright: 6, dim: 12, color: "#ffc477", alpha: 0.35, animation: { type: "torch", speed: 1, intensity: 1 } },
  fire: { bright: 4, dim: 8, color: "#ff7a1a", alpha: 0.45, animation: { type: "flame", speed: 3, intensity: 4 } },
  magic: { bright: 2, dim: 4, color: "#7fb8ff", alpha: 0.5, animation: { type: "pulse", speed: 3, intensity: 3 } },
  lava: { bright: 1, dim: 3, color: "#ff4a12", alpha: 0.5, animation: { type: "pulse", speed: 2, intensity: 3 } },
  lamp: { bright: 4, dim: 8, color: "#fff1d0", alpha: 0.25, animation: { type: null, speed: 5, intensity: 5 } },
  window: { bright: 0, dim: 3, color: "#dbeaff", alpha: 0.2, animation: { type: null, speed: 5, intensity: 5 } },
});

/** Options of the panel, remembered per browser. */
export const DEFAULT_PANEL_OPTIONS = Object.freeze({
  aiGrid: true,
  walls: true,
  doors: true,
  lights: true,
  // "trace": the model marks walkable cells and the outline is traced in the pixels; "coords": the model
  // gives wall coordinates itself.
  method: "coords",
  // Pull walls given as coordinates onto the line drawn in the picture.
  refine: true,
  // What a cliff edge becomes: "invisible" (blocks movement only), "terrain" (limits sight), "wall", "height"
  // (a wall with the upper floor's height as its top, for the Wall Height module), "none".
  ledgeMode: "invisible",
  // Work out the height of the floor on both sides of ledges, stairs and slopes, and make regions of it.
  heights: true,
  // Height of a ledge or step the map gives no number for, in cells.
  dropCells: 2,
  overview: true,
  tileCells: 12,
  snap: 0.5,
  lightScale: 1,
  replace: true,
});
