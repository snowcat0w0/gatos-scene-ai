/**
 * Provider registry: presets for the settings form and the dispatch by API type (pure).
 */
import * as openai from "./openai.js";
import * as anthropic from "./anthropic.js";
import * as gemini from "./gemini.js";
import { ProviderError } from "./common.js";

export { ProviderError };

/** API dialects. */
export const API_TYPES = ["openai", "anthropic", "gemini"];
const ADAPTERS = { openai, anthropic, gemini };

/**
 * Presets of the settings form. `local` servers need no key; an empty `model` means "pick one from the list",
 * since model names of those services change faster than this file.
 */
export const PRESETS = {
  anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", local: false },
  openai: { type: "openai", baseUrl: "https://api.openai.com/v1", model: "", local: false },
  gemini: { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "", local: false },
  openrouter: { type: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", local: false },
  ollama: { type: "openai", baseUrl: "http://localhost:11434/v1", model: "", local: true },
  lmstudio: { type: "openai", baseUrl: "http://localhost:1234/v1", model: "", local: true },
  llamacpp: { type: "openai", baseUrl: "http://localhost:8080/v1", model: "", local: true },
  custom: { type: "openai", baseUrl: "", model: "", local: true },
};

export const DEFAULT_CONFIG = Object.freeze({
  preset: "anthropic",
  type: "anthropic",
  baseUrl: PRESETS.anthropic.baseUrl,
  apiKey: "",
  model: PRESETS.anthropic.model,
  timeoutSec: 300,
  concurrency: 2,
  maxImagePx: 1024,
  jsonMode: "auto",
});

/** Fill gaps of a stored config with defaults and coerce the numbers. */
export function normalizeConfig(stored) {
  const c = { ...DEFAULT_CONFIG, ...(stored ?? {}) };
  if (!API_TYPES.includes(c.type)) c.type = "openai";
  if (!PRESETS[c.preset]) c.preset = "custom";
  c.baseUrl = String(c.baseUrl ?? "").trim();
  c.apiKey = String(c.apiKey ?? "").trim();
  c.model = String(c.model ?? "").trim();
  c.timeoutSec = Math.min(3600, Math.max(10, Number(c.timeoutSec) || DEFAULT_CONFIG.timeoutSec));
  c.concurrency = Math.min(8, Math.max(1, Math.round(Number(c.concurrency) || 1)));
  c.maxImagePx = Math.min(4096, Math.max(512, Math.round(Number(c.maxImagePx) || DEFAULT_CONFIG.maxImagePx)));
  c.jsonMode = c.jsonMode === "off" ? "off" : "auto";
  return c;
}

/** Is there enough to send a request? */
export function isConfigured(config) {
  return !!(config?.baseUrl && config?.model && (config.apiKey || PRESETS[config.preset]?.local));
}

function adapter(config) {
  const a = ADAPTERS[config?.type];
  if (!a) throw new ProviderError("config", `unknown API type "${config?.type}"`);
  if (!config.baseUrl) throw new ProviderError("config", "no server address");
  return a;
}

/** Send one vision request. See providers/common.js for the shapes. */
export function chat(config, request) {
  return adapter(config).chat(config, request);
}

/** Model ids the server offers. */
export function listModels(config) {
  return adapter(config).listModels(config);
}
