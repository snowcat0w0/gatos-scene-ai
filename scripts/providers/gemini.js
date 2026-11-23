/**
 * Google Gemini API (`POST {base}/models/{model}:generateContent`).
 */
import { ProviderError, joinUrl, requestJson, requireModel } from "./common.js";

const headers = (config) => (config.apiKey ? { "x-goog-api-key": config.apiKey } : {});
const modelId = (config) => String(config.model).replace(/^models\//, "");

export async function chat(config, request) {
  requireModel(config);
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          ...(request.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } })),
          { text: request.text },
        ],
      },
    ],
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.json && config.jsonMode !== "off") body.generationConfig = { responseMimeType: "application/json" };

  const url = joinUrl(config.baseUrl, `models/${encodeURIComponent(modelId(config))}:generateContent`);
  const data = await requestJson(url, {
    method: "POST",
    headers: headers(config),
    body,
    timeoutSec: config.timeoutSec,
    signal: request.signal,
  });

  if (data?.promptFeedback?.blockReason) {
    throw new ProviderError("refusal", `blocked: ${data.promptFeedback.blockReason}`);
  }
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part?.thought && typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) {
    const reason = candidate?.finishReason;
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") throw new ProviderError("refusal", `blocked: ${reason}`);
    throw new ProviderError("empty", reason === "MAX_TOKENS" ? "reply cut off before any text" : "empty reply");
  }
  return {
    text,
    truncated: candidate?.finishReason === "MAX_TOKENS",
    usage: {
      input: data?.usageMetadata?.promptTokenCount ?? 0,
      output: data?.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

export async function listModels(config) {
  const data = await requestJson(joinUrl(config.baseUrl, "models?pageSize=1000"), {
    headers: headers(config),
    timeoutSec: 30,
  });
  return (data?.models ?? [])
    .filter((m) => !m?.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(m?.name ?? "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort();
}
