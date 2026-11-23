/**
 * "AI connection" window: which service or local server to talk to, with a model list and a connection test.
 */
import { mod, MODULE_ID } from "./constants.js";
import { pascal } from "./lib.js";
import { getProvider, setProvider, describeError } from "./config.js";
import { PRESETS, API_TYPES, normalizeConfig, chat, listModels } from "./providers/index.js";
import { renderProbe } from "./image.js";
import { probePrompt } from "./prompts.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ProviderConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gatos-scene-ai-provider",
    tag: "form",
    classes: ["gatos-scene-ai", "gsa-provider-config"],
    window: { title: "GATOSSA.Provider.Title", icon: "fa-solid fa-plug", contentClasses: ["standard-form"] },
    position: { width: 560, height: "auto" },
    form: { handler: ProviderConfig.#onSubmit, closeOnSubmit: true },
    actions: { listModels: ProviderConfig.#onListModels, test: ProviderConfig.#onTest },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/provider-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" },
  };

  async _prepareContext() {
    const config = getProvider();
    return {
      config,
      local: !!PRESETS[config.preset]?.local,
      presets: Object.fromEntries(Object.keys(PRESETS).map((k) => [k, mod.L(`Provider.Presets.${pascal(k)}`)])),
      types: Object.fromEntries(API_TYPES.map((k) => [k, mod.L(`Provider.Types.${pascal(k)}`)])),
      imageSizes: { 768: "768", 1024: "1024", 1536: "1536", 2048: "2048" },
      jsonMode: config.jsonMode !== "off",
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "GATOSSA.Provider.Save" }],
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector('select[name="preset"]')?.addEventListener("change", (event) => {
      const preset = PRESETS[event.currentTarget.value];
      if (!preset) return;
      const form = this.element;
      form.elements.type.value = preset.type;
      form.elements.baseUrl.value = preset.baseUrl;
      form.elements.model.value = preset.model;
      form.querySelector(".gsa-local-hint")?.toggleAttribute("hidden", !preset.local);
      this.#status("", "");
    });
  }

  /** The values currently in the form, saved or not. */
  #read() {
    const data = new foundry.applications.ux.FormDataExtended(this.element).object;
    return normalizeConfig({ ...data, jsonMode: data.jsonMode ? "auto" : "off" });
  }

  #status(level, text) {
    const el = this.element.querySelector(".gsa-status");
    if (!el) return;
    el.className = `gsa-status ${level}`;
    el.textContent = text;
    el.toggleAttribute("hidden", !text);
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    await setProvider({ ...data, jsonMode: data.jsonMode ? "auto" : "off" });
    Hooks.callAll(`${MODULE_ID}.providerChanged`);
  }

  static async #onListModels() {
    const config = this.#read();
    this.#status("busy", mod.L("Provider.Listing"));
    try {
      const models = await listModels(config);
      const list = this.element.querySelector("#gsa-model-list");
      list.replaceChildren(
        ...models.map((id) => {
          const option = document.createElement("option");
          option.value = id;
          return option;
        }),
      );
      this.#status(models.length ? "ok" : "warn", mod.L(models.length ? "Provider.Listed" : "Provider.ListedNone", { count: models.length }));
      if (models.length) this.element.elements.model.focus();
    } catch (err) {
      this.#status("error", describeError(err));
    }
  }

  static async #onTest() {
    const config = this.#read();
    this.#status("busy", mod.L("Provider.Testing"));
    try {
      const reply = await chat(config, { text: probePrompt(), images: [renderProbe()], json: true });
      // The picture is a red square: a model that says so both answered and saw the image.
      if (/\bred\b/i.test(reply.text)) this.#status("ok", mod.L("Provider.TestOk", { model: config.model }));
      else this.#status("warn", mod.L("Provider.TestNoVision", { answer: reply.text.trim().slice(0, 80) }));
    } catch (err) {
      this.#status("error", describeError(err));
    }
  }
}
