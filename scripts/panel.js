/**
 * The Scene AI panel: grid alignment, wall/door/light analysis with a canvas preview, apply and undo.
 * Works on the scene shown on the canvas.
 */
import { mod, MODULE_ID, FLAG_GRID_BACKUP } from "./constants.js";
import { confirm, pascal } from "./lib.js";
import { getProvider, getPanelOptions, setPanelOptions, isConfigured, chatWith, describeError } from "./config.js";
import { detectSceneGrid, gridValuesFor } from "./grid.js";
import { analyzeScene, requestCount } from "./analyze.js";
import { applyResult, removeGenerated, generatedIds, wallHeightActive } from "./apply.js";
import { showPreview, clearPreview } from "./preview.js";
import { backgroundSrc, readGridValues, applyGridValues } from "./scene.js";
import { ProviderConfig } from "./provider-config.js";
import { ProviderError } from "./providers/common.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const NUMBER_OPTIONS = new Set(["tileCells", "snap", "lightScale", "dropCells"]);
const LOG_LINES = 8;

/** Everything about a scene that makes an analysis result (canvas pixels) stale when it changes. */
function geometryKey(scene) {
  if (!scene) return "";
  const v = readGridValues(scene);
  return [scene.id, backgroundSrc(scene), v.type, v.size, v.width, v.height, v.offsetX, v.offsetY, scene.padding].join("|");
}

export class ScenePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gatos-scene-ai-panel",
    classes: ["gatos-scene-ai", "gsa-panel-app"],
    window: { title: "GATOSSA.Panel.Title", icon: "fa-solid fa-wand-magic-sparkles" },
    position: { width: 470, height: "auto" },
    actions: {
      openProvider: ScenePanel.#onOpenProvider,
      detectGrid: ScenePanel.#onDetectGrid,
      applyGrid: ScenePanel.#onApplyGrid,
      undoGrid: ScenePanel.#onUndoGrid,
      analyze: ScenePanel.#onAnalyze,
      cancel: ScenePanel.#onCancel,
      applyResult: ScenePanel.#onApplyResult,
      discardResult: ScenePanel.#onDiscardResult,
      removeGenerated: ScenePanel.#onRemoveGenerated,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/panel.hbs` } };

  /** @type {ScenePanel|null} */
  static #instance = null;

  static open() {
    ScenePanel.#instance ??= new ScenePanel();
    ScenePanel.#instance.render({ force: true });
    return ScenePanel.#instance;
  }

  /** The open panel, if any. */
  static get current() {
    return ScenePanel.#instance?.rendered ? ScenePanel.#instance : null;
  }

  /** null | "grid" | "analyze" | "apply" */
  #busy = null;
  /** @type {AbortController|null} */
  #abort = null;
  #progress = null;
  /** Grid detection result plus the scene values it leads to. */
  #grid = null;
  /** @type {import("./analyze.js").AnalysisResult|null} */
  #result = null;
  #log = [];
  #geometry = "";
  #sceneId = null;

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext() {
    const scene = canvas?.scene ?? null;
    this.#syncScene(scene);
    const provider = getProvider();
    const configured = isConfigured(provider);
    const opts = getPanelOptions();
    const src = scene ? backgroundSrc(scene) : null;
    const T = CONST.GRID_TYPES;
    const supported = !!scene && (scene.grid.type === T.SQUARE || scene.grid.type === T.GRIDLESS);
    const generated = scene ? generatedIds(scene) : { walls: [], lights: [] };
    const busy = !!this.#busy;
    const canWork = !!src && !busy;

    const grid = this.#grid && {
      cell: mod.L("Grid.Cell", {
        x: this.#grid.detection.periodX.toFixed(2),
        y: this.#grid.detection.periodY.toFixed(2),
      }),
      confidence: mod.L(`Grid.Confidence.${pascal(this.#grid.detection.confidence)}`),
      level: this.#grid.detection.confidence,
      method: mod.L(`Grid.Method.${pascal(this.#grid.method.replace("+", "-"))}`),
      verdict: this.#grid.verdict ? mod.L(`Grid.Verdict.${pascal(this.#grid.verdict)}`) : null,
      reason: this.#grid.reason,
      estimate: this.#grid.estimate
        ? mod.L("Grid.Estimate", { across: this.#grid.estimate.cellsAcross, down: this.#grid.estimate.cellsDown })
        : null,
      values: mod.L("Grid.Values", this.#grid.values),
    };

    const result = this.#result && {
      summary: mod.L("Analyze.Summary", {
        walls: this.#result.walls.length,
        ledges: this.#result.ledges.length,
        doors: this.#result.doors.length,
        lights: this.#result.lights.length,
      }),
      heights: this.#result.areas?.length ? mod.L("Analyze.HeightsSummary", { areas: this.#result.areas.length }) : null,
      failed: this.#result.failed.length
        ? mod.L("Analyze.Failed", { failed: this.#result.failed.length, tiles: this.#result.tiles })
        : null,
      empty: !(this.#result.walls.length + this.#result.ledges.length + this.#result.doors.length + this.#result.lights.length),
    };

    const p = this.#progress;
    return {
      scene: scene && {
        name: scene.name,
        hasBackground: !!src,
        supported,
        meta: mod.L("Panel.Meta", { width: scene.width, height: scene.height, size: scene.grid.size }),
      },
      provider: {
        configured,
        label: configured
          ? `${mod.L(`Provider.Presets.${pascal(provider.preset)}`)} · ${provider.model}`
          : mod.L("Panel.NoProvider"),
      },
      opts,
      busy,
      busyGrid: this.#busy === "grid",
      busyAnalyze: this.#busy === "analyze",
      canDetect: canWork,
      canApplyGrid: canWork && !!this.#grid,
      canUndoGrid: !busy && !!scene?.getFlag(MODULE_ID, FLAG_GRID_BACKUP),
      canAnalyze: canWork && supported && configured && (opts.walls || opts.doors || opts.lights),
      canApplyResult: !busy && !!this.#result && !result.empty,
      grid,
      result,
      requests: scene && src && supported ? requestCount(scene, opts) : 0,
      progress: p && {
        percent: p.total ? Math.round((p.done / p.total) * 100) : 0,
        label: mod.L(`Progress.${pascal(p.phase)}`, { done: p.done, total: p.total }),
      },
      generated: generated.walls.length + generated.lights.length + generated.regions.length,
      canRemove: !busy && generated.walls.length + generated.lights.length + generated.regions.length > 0,
      tileChoices: { 8: "8", 10: "10", 12: "12", 16: "16", 20: "20" },
      methodChoices: { coords: mod.L("Analyze.Method.Coords"), trace: mod.L("Analyze.Method.Trace") },
      ledgeChoices: Object.fromEntries(
        ["invisible", "terrain", "wall", "height", "none"].map((k) => [k, mod.L(`Analyze.Ledge.${pascal(k)}`)]),
      ),
      dropUnit: scene ? `${opts.dropCells * scene.grid.distance} ${scene.grid.units ?? ""}`.trim() : "",
      snapChoices: {
        1: mod.L("Analyze.Snap.Full"),
        0.5: mod.L("Analyze.Snap.Half"),
        0.25: mod.L("Analyze.Snap.Quarter"),
        0: mod.L("Analyze.Snap.None"),
      },
      log: this.#log.slice(-LOG_LINES),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector(".gsa-panel")?.addEventListener("change", (event) => this.#onOptionChange(event));
    const log = this.element.querySelector(".gsa-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  _onClose(options) {
    super._onClose(options);
    this.#abort?.abort();
    clearPreview();
    this.#result = null;
  }

  /** Called when the canvas was (re)drawn or the connection changed. */
  refresh() {
    if (this.rendered) this.render();
  }

  /** Drop results that no longer fit the scene on the canvas. */
  #syncScene(scene) {
    const key = geometryKey(scene);
    if (scene?.id !== this.#sceneId) {
      this.#sceneId = scene?.id ?? null;
      this.#grid = null;
    }
    if (key !== this.#geometry) {
      this.#geometry = key;
      if (this.#result) {
        this.#result = null;
        clearPreview();
      }
    } else if (this.#result && !this.#busy) {
      // The canvas was redrawn for another reason: the preview layer went with it.
      this.#preview();
    }
  }

  /** Draw the current result on the canvas with the current options. */
  #preview() {
    const opts = getPanelOptions();
    showPreview(this.#result, { lightScale: opts.lightScale, ledges: opts.ledgeMode !== "none", areas: opts.heights });
  }

  #say(level, key, data) {
    this.#sayText(level, mod.L(key, data));
  }

  #sayText(level, text) {
    this.#log.push({ level, text });
    if (this.#log.length > 50) this.#log.splice(0, this.#log.length - 50);
  }

  async #onOptionChange(event) {
    const input = event.target;
    const name = input?.name;
    if (!name) return;
    const opts = getPanelOptions();
    if (input.type === "checkbox") opts[name] = input.checked;
    else if (NUMBER_OPTIONS.has(name)) opts[name] = Number(input.value);
    else opts[name] = input.value;
    if (name === "lightScale") opts.lightScale = Math.min(4, Math.max(0.25, opts.lightScale || 1));
    if (name === "dropCells") opts.dropCells = Math.min(20, Math.max(0.5, opts.dropCells || 2));
    await setPanelOptions(opts);
    if ((name === "lightScale" || name === "ledgeMode" || name === "heights") && this.#result) this.#preview();
    this.render();
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onOpenProvider() {
    new ProviderConfig().render({ force: true });
  }

  static async #onDetectGrid() {
    const scene = canvas?.scene;
    if (!scene || this.#busy) return;
    const opts = getPanelOptions();
    const useAI = opts.aiGrid && isConfigured(getProvider());
    this.#busy = "grid";
    this.#abort = new AbortController();
    this.#grid = null;
    this.#say("info", useAI ? "Grid.StartAi" : "Grid.Start");
    this.render();
    try {
      const found = await detectSceneGrid(scene, { chat: useAI ? chatWith() : undefined, signal: this.#abort.signal });
      if (!found) this.#say("warn", "Grid.NotFound");
      else {
        const values = gridValuesFor(found.detection, found.image);
        this.#grid = { ...found, values };
        if (found.detection.confidence === "low") this.#say("warn", useAI ? "Grid.FoundLowAi" : "Grid.FoundLow");
        else if (found.verdict === "shifted" || found.verdict === "wrong") this.#say("warn", "Grid.FoundDoubt");
        else this.#say("ok", "Grid.Found");
      }
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === "aborted")) this.#sayText("error", describeError(err));
      else this.#say("warn", "Progress.Cancelled");
    } finally {
      this.#busy = null;
      this.#abort = null;
      this.render();
    }
  }

  static async #onApplyGrid() {
    const scene = canvas?.scene;
    if (!scene || !this.#grid || this.#busy) return;
    const placed =
      scene.walls.size + scene.lights.size + scene.tokens.size + scene.tiles.size + scene.drawings.size +
      scene.sounds.size + scene.templates.size + scene.notes.size + (scene.regions?.size ?? 0);
    if (placed) {
      const ok = await confirm({
        title: mod.L("Grid.ConfirmTitle"),
        content: mod.L("Grid.ConfirmPlaced", { count: placed }),
        yes: { label: mod.L("Grid.Apply") },
        no: { label: mod.L("Common.Cancel") },
      });
      if (!ok) return;
    }
    const backup = scene.getFlag(MODULE_ID, FLAG_GRID_BACKUP) ?? readGridValues(scene);
    const values = { type: CONST.GRID_TYPES.SQUARE, ...this.#grid.values };
    this.#busy = "apply";
    try {
      await applyGridValues(scene, values, { [`flags.${MODULE_ID}.${FLAG_GRID_BACKUP}`]: backup });
      this.#say("ok", "Grid.Applied", values);
    } catch (err) {
      this.#sayText("error", describeError(err));
    } finally {
      this.#busy = null;
      this.render();
    }
  }

  static async #onUndoGrid() {
    const scene = canvas?.scene;
    const backup = scene?.getFlag(MODULE_ID, FLAG_GRID_BACKUP);
    if (!backup || this.#busy) return;
    await applyGridValues(scene, backup, { [`flags.${MODULE_ID}.-=${FLAG_GRID_BACKUP}`]: null });
    this.#grid = null;
    this.#say("info", "Grid.Undone");
    this.render();
  }

  static async #onAnalyze() {
    const scene = canvas?.scene;
    if (!scene || this.#busy) return;
    const opts = getPanelOptions();
    const provider = getProvider();
    this.#busy = "analyze";
    this.#abort = new AbortController();
    this.#result = null;
    clearPreview();
    this.#progress = { phase: "tiles", done: 0, total: requestCount(scene, opts) };
    this.#say("info", "Analyze.Start", { model: provider.model, count: this.#progress.total });
    this.render();
    try {
      const result = await analyzeScene(scene, {
        chat: chatWith(provider),
        want: { walls: opts.walls, ledges: opts.ledgeMode !== "none", heights: opts.heights, doors: opts.doors, lights: opts.lights },
        dropDefault: opts.dropCells * scene.grid.distance,
        method: opts.method,
        tileCells: opts.tileCells,
        snapStep: opts.snap,
        refine: opts.refine,
        overview: opts.overview,
        maxImagePx: provider.maxImagePx,
        concurrency: provider.concurrency,
        signal: this.#abort.signal,
        onProgress: (p) => {
          this.#progress = p;
          this.render();
        },
      });
      this.#result = result;
      this.#geometry = geometryKey(scene);
      this.#preview();
      this.#say(result.failed.length ? "warn" : "ok", "Analyze.Done", {
        walls: result.walls.length,
        ledges: result.ledges.length,
        doors: result.doors.length,
        lights: result.lights.length,
      });
      if (result.refined?.chains) this.#say("info", "Analyze.Refined", result.refined);
      if (result.heights) {
        // Lines whose two sides could not be told apart are worth a warning: no height comes of them.
        const { resolved, unresolved, conflicts } = result.heights;
        this.#say(unresolved || conflicts ? "warn" : "info", "Analyze.Heights", { areas: result.areas.length, resolved, unresolved });
        if (conflicts) this.#say("warn", "Analyze.HeightConflicts", { conflicts });
      }
      // Tracing needs the floor list; a model that left it out produced no outline at all.
      if (result.method === "trace" && !result.floorCells) this.#say("warn", "Analyze.NoFloor");
      for (const f of result.failed.slice(0, 3)) this.#say("warn", "Analyze.TileFailed", { index: f.index + 1, message: f.message });
      if (result.usage.input + result.usage.output) this.#say("info", "Analyze.Usage", result.usage);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "aborted") this.#say("warn", "Progress.Cancelled");
      else this.#sayText("error", describeError(err));
    } finally {
      this.#busy = null;
      this.#abort = null;
      this.#progress = null;
      this.render();
    }
  }

  static #onCancel() {
    this.#abort?.abort();
  }

  static async #onApplyResult() {
    const scene = canvas?.scene;
    if (!scene || !this.#result || this.#busy) return;
    const opts = getPanelOptions();
    this.#busy = "apply";
    try {
      const made = await applyResult(scene, this.#result, {
        replace: opts.replace,
        lightScale: opts.lightScale,
        ledgeMode: opts.ledgeMode,
        heights: opts.heights,
      });
      if (opts.ledgeMode === "height" && made.ledges && !wallHeightActive()) this.#say("warn", "Analyze.NoWallHeight");
      this.#result = null;
      clearPreview();
      this.#say("ok", "Analyze.Applied", made);
    } catch (err) {
      this.#sayText("error", describeError(err));
    } finally {
      this.#busy = null;
      this.render();
    }
  }

  static #onDiscardResult() {
    this.#result = null;
    clearPreview();
    this.#say("info", "Analyze.Discarded");
    this.render();
  }

  static async #onRemoveGenerated() {
    const scene = canvas?.scene;
    if (!scene || this.#busy) return;
    const ids = generatedIds(scene);
    const count = ids.walls.length + ids.lights.length;
    if (!count) return;
    const ok = await confirm({
      title: mod.L("Remove.Title"),
      content: mod.L("Remove.Confirm", { walls: ids.walls.length, lights: ids.lights.length, regions: ids.regions.length }),
      yes: { label: mod.L("Remove.Yes") },
      no: { label: mod.L("Common.Cancel") },
    });
    if (!ok) return;
    const removed = await removeGenerated(scene);
    this.#say("info", "Remove.Done", { count: removed });
    this.render();
  }
}
