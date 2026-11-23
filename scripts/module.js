/**
 * Gato's Scene AI
 *
 * Connects a personal AI API key or a local LLM server and uses it on the scene's background image:
 *   - Grid: the grid printed on the map is measured by signal analysis and checked by the model, then Foundry's
 *     grid is laid on top of it (grid size, scene size, background offset).
 *   - Walls, doors, lights: the map is shown to the model tile by tile with a numbered coordinate grid; what it
 *     reports is previewed on the canvas and created as Wall / AmbientLight documents on request.
 *
 * System-agnostic: only core documents are touched.
 */
import { libActive } from "./lib.js";
import { mod, MODULE_ID, DEFAULT_PANEL_OPTIONS } from "./constants.js";
import { DEFAULT_CONFIG } from "./providers/index.js";
import { getProvider, chatWith } from "./config.js";
import { ScenePanel } from "./panel.js";
import { ProviderConfig } from "./provider-config.js";
import { detectSceneGrid, gridValuesFor } from "./grid.js";
import { analyzeScene } from "./analyze.js";
import { applyResult, removeGenerated, generatedIds } from "./apply.js";
import { showPreview, clearPreview } from "./preview.js";

const TOOL = "gatosSceneAi";

Hooks.once("init", () => {
  // Installed-but-disabled library = "half state" (gatos-lib PLAN §5.6); Foundry blocks activation when it is missing.
  if (!libActive()) Hooks.once("ready", () => ui.notifications.error(mod.L("NeedLib"), { permanent: true }));

  mod.registerSettings({
    providerMenu: { menu: { type: ProviderConfig, icon: "fa-solid fa-plug", restricted: true } },
    // Client scope: the connection (API key included) stays in this browser and is never sent to the server.
    provider: { scope: "client", hidden: true, type: Object, default: { ...DEFAULT_CONFIG } },
    panel: { scope: "client", hidden: true, type: Object, default: { ...DEFAULT_PANEL_OPTIONS } },
  });
});

/** A button in the Walls and Lighting tool groups that opens the panel. */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  for (const group of ["walls", "lighting"]) {
    const tools = controls[group]?.tools;
    if (!tools) continue;
    tools[TOOL] = {
      name: TOOL,
      title: "GATOSSA.Control.Open",
      icon: "fa-solid fa-wand-magic-sparkles",
      order: Object.keys(tools).length + 1,
      button: true,
      visible: true,
      onChange: () => ScenePanel.open(),
    };
  }
});

Hooks.on("canvasReady", () => ScenePanel.current?.refresh());
Hooks.on("canvasTearDown", () => clearPreview());
Hooks.on(`${MODULE_ID}.providerChanged`, () => ScenePanel.current?.refresh());
for (const hook of ["createWall", "deleteWall", "createAmbientLight", "deleteAmbientLight"]) {
  Hooks.on(hook, (doc) => {
    if (doc.parent === canvas?.scene) ScenePanel.current?.refresh();
  });
}

Hooks.once("ready", () => {
  mod.exposeApi({
    open: () => ScenePanel.open(),
    openProvider: () => new ProviderConfig().render({ force: true }),
    getProvider,
    /** detectGrid(scene, { ai: true }) → GridResult with `.values` to pass to scene.update. */
    async detectGrid(scene = canvas.scene, { ai = true } = {}) {
      const found = await detectSceneGrid(scene, { chat: ai ? chatWith() : undefined });
      return found && { ...found, values: gridValuesFor(found.detection, found.image, CONST.GRID_MIN_SIZE ?? 50) };
    },
    /** analyze(scene, options) → AnalysisResult; see analyze.js. */
    analyze(scene = canvas.scene, options = {}) {
      const provider = getProvider();
      return analyzeScene(scene, {
        chat: chatWith(provider),
        want: { walls: true, doors: true, lights: true },
        maxImagePx: provider.maxImagePx,
        concurrency: provider.concurrency,
        ...options,
      });
    },
    applyResult,
    removeGenerated,
    generatedIds,
    showPreview,
    clearPreview,
  });
  mod.log("ready");
});
