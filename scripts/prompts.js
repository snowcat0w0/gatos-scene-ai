/**
 * Prompts (pure). English on purpose: every vision model follows English instructions, the replies are JSON
 * and never shown to the user.
 */

export const SYSTEM =
  "You analyse top-down battle maps for a virtual tabletop. You report only what is visible in the image, " +
  "with coordinates read carefully off the image, and you answer with a single JSON object and nothing else.";

/** One look at the whole map: what kind of map it is and how walls, doors and lights are drawn on it. */
export function overviewPrompt() {
  return [
    "This is a top-down battle map for a tabletop role-playing game, shown whole and scaled down.",
    "Describe briefly how to read it, so that someone tracing its walls from close-up sections knows what to look for.",
    "",
    "Answer with JSON only:",
    '{"type": "dungeon | cave | building interior | town | wilderness | ship | other",',
    ' "walls": "how impassable walls / solid areas are drawn (colour, thickness, fill), and what is walkable floor",',
    ' "doors": "how doors and windows are drawn, or \\"none visible\\"",',
    ' "lights": "what light sources are drawn (torches, braziers, fireplaces, lamps, glowing things), or \\"none visible\\"",',
    ' "notes": "anything else that matters: outdoor areas without walls, cliffs, water, multiple floors"}',
    "Keep every value under 30 words.",
  ].join("\n");
}

/** Is there a grid, and how many cells does the map span? Used when signal analysis finds no clear grid. */
export function gridEstimatePrompt({ width, height }) {
  return [
    `This is a top-down battle map, ${width}×${height} pixels in the original, shown whole.`,
    "Estimate how many grid squares the map spans.",
    "- If a square grid is drawn on the map, count its squares across the full width and down the full height.",
    "- If no grid is drawn, estimate from scale: one square is 5 feet (1.5 m), a single door is about one square " +
      "wide, a person fills one square, a corridor is usually one or two squares wide.",
    "Fractions are fine when the map ends in a partial square.",
    "",
    "Answer with JSON only:",
    '{"hasGrid": true, "cellsAcross": 0, "cellsDown": 0, "basis": "what you counted or measured, under 25 words"}',
  ].join("\n");
}

/** A crop with the detected grid drawn in magenta: does one overlay cell match one map square? */
export function gridVerifyPrompt({ cells }) {
  return [
    "This is a close-up of a top-down battle map. A dashed MAGENTA grid has been drawn on top of it by software that " +
      `tried to find the map's own square grid; the crop is ${cells} magenta cells wide. The map's own grid lines, ` +
      "if it has any, show through the gaps between the dashes.",
    "Compare the magenta grid with the grid squares drawn on the map itself (or, if the map has no drawn grid, " +
      "with the scale of the map: one square = 5 feet, a single door is about one square wide).",
    "",
    "Choose one verdict:",
    '- "ok": the magenta lines lie on the map\'s grid lines and one magenta cell is one map square.',
    '- "half": the magenta cells are too small — one map square holds 2×2 magenta cells.',
    '- "double": the magenta cells are too large — one magenta cell holds 2×2 map squares.',
    '- "shifted": the cell size matches but the magenta lines are clearly offset from the map\'s lines.',
    '- "wrong": the magenta grid does not correspond to the map\'s squares in any of these ways.',
    '- "nogrid": the map has no drawn grid and the magenta cell size is a plausible 5-foot square.',
    "",
    "Answer with JSON only:",
    '{"verdict": "ok", "reason": "under 20 words"}',
  ].join("\n");
}

const WALLS = [
  "WALLS — everything that blocks movement and line of sight:",
  "- the boundary between walkable floor and solid rock, earth, void or the unmapped area around rooms;",
  "- building walls, interior partitions, pillars and other floor-to-ceiling obstacles (pillars as closed outlines).",
  "Trace each wall as a polyline: a list of [x, y] points. A straight wall needs 2 points; a corner adds one point; " +
    "follow curved or cave walls with a point every half cell or so.",
  "A wall drawn as a line or band thinner than one cell: one polyline along the middle of the band. " +
    "A solid area wider than one cell: trace the edge of the walkable floor.",
  "Make walls that meet share the exact same point, so that rooms are closed and light cannot leak through corners.",
  "Leave an opening where a door, window, archway or open passage is: walls stop at both sides of it.",
  "NOT walls: the magenta overlay, the map's own grid lines, furniture, rugs, rubble, stairs, low objects, " +
    "shadows, floor patterns, water.",
].join("\n");

const DOORS = [
  "DOORS — each door, window or other closable opening in a wall, as one straight segment from point a to point b " +
    "spanning the opening, with both ends touching the walls beside it.",
  '"type" is "door" (also gates, portcullises, double doors), "secret" (a concealed door, often marked S) ' +
    'or "window". Open archways and plain gaps are not doors: leave them open.',
].join("\n");

const LIGHTS = [
  "LIGHTS — every light source drawn on the map, as the point where the light is:",
  '"kind" is one of: "torch" (wall torch, sconce), "candle", "lantern", "fire" (campfire, fireplace, brazier, forge), ' +
    '"magic" (glowing crystal, rune, portal), "lava", "lamp" (electric or modern light), ' +
    '"window" (daylight falling in through a window or skylight).',
  "A light mounted on a wall goes a quarter cell away from the wall, on the lit side — never exactly on a wall.",
  'Add "color": "#rrggbb" only when the light is clearly coloured (green flame, blue crystal).',
  "Report only light sources you can see drawn; do not add lights to rooms because they look bright.",
].join("\n");

/**
 * One tile with the coordinate overlay.
 * @param {object} p
 * @param {number} p.cols          overlay cells across
 * @param {number} p.rows          overlay cells down
 * @param {{walls: boolean, doors: boolean, lights: boolean}} p.want
 * @param {string} [p.context]     summary from the overview pass
 * @param {string} [p.cellSize]    e.g. "5 ft"
 * @param {{left, right, top, bottom}} [p.continues]  whether the map goes on beyond that edge of the picture
 */
export function tilePrompt({ cols, rows, want, context, cellSize, continues = {} }) {
  const edges = Object.entries(continues)
    .filter(([, more]) => more)
    .map(([side]) => side);
  const lines = [
    "The image is a section of a top-down battle map with a MAGENTA coordinate grid drawn on top.",
    `Vertical grid lines are numbered 0 to ${cols} from left to right (numbers above and below the map); ` +
      `horizontal grid lines are numbered 0 to ${rows} from top to bottom (numbers left and right of the map).`,
    "A position is [x, y] in grid-line units: x is read against the vertical lines, y against the horizontal lines. " +
      "Decimals are allowed: x = 2.5 is halfway between vertical lines 2 and 3.",
    `One grid cell is one map square${cellSize ? ` (${cellSize})` : ""}.`,
  ];
  if (edges.length) {
    lines.push(
      `The map continues beyond the ${edges.join(", ")} edge${edges.length > 1 ? "s" : ""} of this section: ` +
        "a wall running off the picture ends exactly at the border coordinate.",
    );
  }
  if (context) lines.push("", `About this map: ${context}`);
  lines.push("", "Find in this section:");
  const shape = [];
  if (want.walls) {
    lines.push("", WALLS);
    shape.push('"walls": [[[x, y], [x, y], [x, y]], [[x, y], [x, y]]]');
  }
  if (want.doors) {
    lines.push("", DOORS);
    shape.push('"doors": [{"a": [x, y], "b": [x, y], "type": "door"}]');
  }
  if (want.lights) {
    lines.push("", LIGHTS);
    shape.push('"lights": [{"x": 0, "y": 0, "kind": "torch"}]');
  }
  lines.push(
    "",
    "Work through the section systematically, room by room, and read each coordinate off the numbered lines.",
    "Use an empty array for anything this section does not contain.",
    "",
    "Answer with JSON only, in exactly this shape:",
    `{${shape.join(", ")}}`,
  );
  return lines.join("\n");
}

/** Connection test: a picture of one coloured square. */
export function probePrompt() {
  return 'The image shows one coloured square on a white background. Answer with JSON only: {"color": "<the colour of the square in one English word>"}';
}

/** Fold the overview reply into one context line for the tile prompts. */
export function overviewToContext(o) {
  if (!o || typeof o !== "object") return "";
  const sentence = (label, value) => `${label}${String(value).trim().replace(/[.\s]+$/, "")}.`;
  const parts = [];
  if (o.type) parts.push(sentence("", `${String(o.type).trim()} map`));
  if (o.walls) parts.push(sentence("Walls: ", o.walls));
  if (o.doors) parts.push(sentence("Doors: ", o.doors));
  if (o.lights) parts.push(sentence("Lights: ", o.lights));
  if (o.notes) parts.push(sentence("Notes: ", o.notes));
  return parts.join(" ").slice(0, 900);
}
