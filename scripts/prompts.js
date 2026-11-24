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

const FLOOR = [
  "FLOOR — where creatures can walk, as spans read off the numbered lines.",
  "Take the map one band at a time. A band is the strip between two neighbouring horizontal lines and is named by " +
    'both of them: "3-4" is the strip between horizontal lines 3 and 4.',
  "For every band with walkable floor, list its spans of floor from left to right as [from, to]: the floor begins " +
    "at x = from and ends at x = to, read against the numbered vertical lines like every other x. [2, 6] is floor " +
    "all the way from vertical line 2 to vertical line 6. Use .5 where the floor begins or ends about halfway " +
    "between two lines. Leave out bands without floor.",
  "Where the edge of the floor cuts through a band at an angle, end the span where floor fills about half of the " +
    "band's height.",
  "Walkable: rooms, corridors, cave floor, doorways, stairs, ramps, bridges, ledges, shallow water.",
  "Not walkable: solid rock and earth, the mass of thick walls, the blank or decorated area around the map, " +
    "lettering outside rooms, deep pits and chasms.",
  "Follow every passage band by band, however narrow, so that areas connected on the map stay connected in your " +
    "list. Never close an opening that the map shows open.",
].join("\n");

const THIN_WALLS = [
  "WALLS — only thin walls, which the floor list cannot express: a wall, fence or partition drawn as a line or a " +
    "thin band with walkable cells on both sides of it (interior walls of a building, the wall between two rooms " +
    "that share a grid line, railings, bars).",
  "Do NOT trace where floor meets solid rock or the outside of the map: that outline is computed from the floor " +
    "list. If the map has no thin walls, give an empty array.",
  "Trace each thin wall as a polyline of [x, y] points along the middle of the line; a straight wall needs 2 " +
    "points. Leave an opening where a door, window or archway is.",
  "NOT walls: the magenta overlay, the map's own grid lines, furniture, rugs, rubble, stairs, shadows, floor " +
    "patterns, water.",
].join("\n");

const LEDGES = [
  "LEDGES — changes of height that are not walls: cliff edges, drop-offs, the rim of a pit or a raised platform, " +
    "steep slopes. Maps usually draw them as a line with hatching or short tick marks on the lower side.",
  "Trace each as a polyline of [x, y] points along the edge. Stairs, gentle ramps and arrows marking " +
    '"up"/"down" are not ledges.',
].join("\n");

const LEDGE_HEIGHTS = [
  "LEDGES — changes of height that are not walls: cliff edges, drop-offs, the rim of a pit or a raised platform, " +
    "steep slopes. Maps usually draw them as a line with hatching or short tick marks on the lower side.",
  'For each: "line" is a polyline of [x, y] points along the edge, carried on until it meets a wall or another ' +
    "ledge at both ends whenever the map shows that.",
  '"high" is one point about half a cell away from the line, on its HIGHER side: on top of the cliff, on the ' +
    "raised platform, on the ground around a pit.",
  '"drop" is the height difference in the map\'s units when the map states it (a label such as "10 ft"); ' +
    "leave it out when it does not.",
].join("\n");

const STEPS = [
  "STEPS — where the floor changes height and one can still walk: stairs, ramps, slopes, and passages marked " +
    '"up" or "down".',
  'For each: "line" is one straight line across the passage, from one side wall to the other, at the middle of ' +
    "the stairs or slope.",
  '"high" is one point about half a cell away from that line on the side that is HIGHER: where the stairs lead ' +
    'up to, where an "up" arrow points, where a "down" arrow comes from.',
  '"rise" is the height difference in the map\'s units when the map states it; leave it out when it does not.',
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
 * @param {{floor?: boolean, walls: boolean, ledges?: boolean, heights?: boolean, doors: boolean, lights: boolean}} p.want
 *        floor: ask for the spans of walkable floor (the outline is then traced in the pixels and "walls" means
 *        thin walls only); heights: also ask which side of every ledge is higher, and for stairs and slopes
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
  if (want.floor) {
    lines.push("", FLOOR);
    shape.push('"floor": {"0-1": [[3, 8]], "1-2": [[2.5, 9], [10, 12]]}');
  }
  if (want.walls) {
    lines.push("", want.floor ? THIN_WALLS : WALLS);
    shape.push('"walls": [[[x, y], [x, y], [x, y]], [[x, y], [x, y]]]');
  }
  if (want.ledges && want.heights) {
    lines.push("", LEDGE_HEIGHTS, "", STEPS);
    shape.push('"ledges": [{"line": [[x, y], [x, y], [x, y]], "high": [x, y]}]');
    shape.push('"steps": [{"line": [[x, y], [x, y]], "high": [x, y]}]');
  } else if (want.ledges) {
    lines.push("", LEDGES);
    shape.push('"ledges": [[[x, y], [x, y], [x, y]]]');
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
