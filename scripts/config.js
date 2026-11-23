/**
 * Stored options: the AI connection and the panel options. Both are client settings — they live in this
 * browser's localStorage only, so an API key is never written to the world or sent to the players.
 */
import { mod, DEFAULT_PANEL_OPTIONS } from "./constants.js";
import { normalizeConfig, chat as providerChat, isConfigured } from "./providers/index.js";
import { ProviderError } from "./providers/common.js";
import { ImageError } from "./image.js";
import { JsonExtractError } from "./json.js";

export const getProvider = () => normalizeConfig(mod.setting("provider"));
export const setProvider = (config) => mod.setSetting("provider", normalizeConfig(config));

export const getPanelOptions = () => ({ ...DEFAULT_PANEL_OPTIONS, ...(mod.setting("panel") ?? {}) });
export const setPanelOptions = (options) => mod.setSetting("panel", { ...DEFAULT_PANEL_OPTIONS, ...options });

export { isConfigured };

/** A `chat(request)` function bound to a connection (default: the stored one). */
export function chatWith(config = getProvider()) {
  return (request) => providerChat(config, request);
}

/** A message the GM can act on, for any error the pipeline throws. */
export function describeError(err) {
  if (err instanceof ProviderError) {
    const known = ["network", "timeout", "aborted", "auth", "notfound", "rate", "refusal", "empty", "config"];
    if (known.includes(err.kind)) {
      const base = mod.L(`Error.${err.kind[0].toUpperCase()}${err.kind.slice(1)}`);
      return err.detail ? `${base} (${err.detail})` : base;
    }
    return mod.L("Error.Http", { status: err.status ?? "?", detail: err.detail || err.message });
  }
  if (err instanceof ImageError) return mod.L(err.kind === "tainted" ? "Error.ImageTainted" : "Error.ImageLoad");
  if (err instanceof JsonExtractError) return mod.L(err.kind === "truncated" ? "Error.JsonTruncated" : "Error.JsonInvalid");
  return err?.message ?? String(err);
}
