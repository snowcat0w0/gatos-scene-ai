/**
 * OpenAI-compatible Chat Completions: OpenAI, OpenRouter and the local servers (Ollama, LM Studio, llama.cpp,
 * vLLM, KoboldCpp…), which all speak `POST {base}/chat/completions`.
 *
 * Kept to the common subset on purpose: no `temperature` and no `max_tokens`, because current OpenAI reasoning
 * models reject both spellings that older servers require.
 */
import { ProviderError, joinUrl, requestJson, requireModel } from "./common.js";

/** Base URLs whose server rejected `response_format: json_object` (LM Studio only takes json_schema). */
const noJsonMode = new Set();

const authHeaders = (config) => (config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {});

function buildBody(config, request, jsonMode) {
  const content = [
    ...(request.images ?? []).map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mime};base64,${img.base64}` },
    })),
    { type: "text", text: request.text },
  ];
  const body = {
    model: config.model,
    messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content }],
    stream: false,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  return body;
}

function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  return "";
}

export async function chat(config, request) {
  requireModel(config);
  const url = joinUrl(config.baseUrl, "chat/completions");
  const send = (jsonMode) =>
    requestJson(url, {
      method: "POST",
      headers: authHeaders(config),
      body: buildBody(config, request, jsonMode),
      timeoutSec: config.timeoutSec,
      signal: request.signal,
    });

  let useJsonMode = !!request.json && config.jsonMode !== "off" && !noJsonMode.has(config.baseUrl);
  let data;
  try {
    data = await send(useJsonMode);
  } catch (err) {
    if (!(useJsonMode && err instanceof ProviderError && err.kind === "badrequest")) throw err;
    // Most likely the server does not know response_format; the prompt asks for JSON anyway.
    noJsonMode.add(config.baseUrl);
    useJsonMode = false;
    data = await send(false);
  }

  const choice = data?.choices?.[0];
  const text = textOf(choice?.message);
  if (choice?.message?.refusal && !text) throw new ProviderError("refusal", String(choice.message.refusal));
  if (!text.trim()) {
    const why = choice?.finish_reason === "length" ? "reply cut off before any text" : "empty reply";
    throw new ProviderError("empty", why);
  }
  return {
    text,
    truncated: choice?.finish_reason === "length",
    usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
  };
}

export async function listModels(config) {
  const data = await requestJson(joinUrl(config.baseUrl, "models"), {
    headers: authHeaders(config),
    timeoutSec: 30,
  });
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .map((m) => m?.id ?? m?.name)
    .filter(Boolean)
    .sort();
}
