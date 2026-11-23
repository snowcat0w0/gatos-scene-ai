/**
 * Anthropic Messages API (`POST /v1/messages`) over plain fetch.
 *
 * A Foundry module is a browser ES module without a build step, so the official SDK is not available here; the
 * `anthropic-dangerous-direct-browser-access` header is what makes the API answer a browser (CORS) request.
 *
 * The request carries no `temperature` and no `thinking`: current models reject sampling parameters and explicit
 * thinking budgets, and decide by themselves how much to think.
 */
import { ProviderError, joinUrl, requestJson, requireModel } from "./common.js";

const API_VERSION = "2023-06-01";
/** Thinking tokens count against max_tokens, so this is the room for thinking plus the JSON answer. */
const MAX_TOKENS = 16000;

/** Accept both "https://api.anthropic.com" and ".../v1" as the base URL. */
const root = (config) => String(config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");

const headers = (config) => ({
  "x-api-key": config.apiKey ?? "",
  "anthropic-version": API_VERSION,
  "anthropic-dangerous-direct-browser-access": "true",
});

export async function chat(config, request) {
  requireModel(config);
  const body = {
    model: config.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          ...(request.images ?? []).map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mime, data: img.base64 },
          })),
          { type: "text", text: request.text },
        ],
      },
    ],
  };
  if (request.system) body.system = request.system;

  const data = await requestJson(joinUrl(root(config), "v1/messages"), {
    method: "POST",
    headers: headers(config),
    body,
    timeoutSec: config.timeoutSec,
    signal: request.signal,
  });

  // Check the stop reason before reading content: a refusal is an HTTP 200 with little or no text.
  if (data?.stop_reason === "refusal") {
    throw new ProviderError("refusal", data?.stop_details?.explanation ?? "the model declined this request");
  }
  const text = (data?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) {
    const why = data?.stop_reason === "max_tokens" ? "reply cut off before any text" : "empty reply";
    throw new ProviderError("empty", why);
  }
  return {
    text,
    truncated: data?.stop_reason === "max_tokens",
    usage: { input: data?.usage?.input_tokens ?? 0, output: data?.usage?.output_tokens ?? 0 },
  };
}

export async function listModels(config) {
  const data = await requestJson(joinUrl(root(config), "v1/models?limit=1000"), {
    headers: headers(config),
    timeoutSec: 30,
  });
  return (data?.data ?? []).map((m) => m?.id).filter(Boolean);
}
