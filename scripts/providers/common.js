/**
 * Shared plumbing of the provider adapters (pure: only `fetch`, `AbortController`, `URL`).
 *
 * Every adapter exposes
 *   chat(config, request)  → { text, truncated, usage: { input, output } }
 *   listModels(config)     → string[]
 * with
 *   config  = { type, baseUrl, apiKey, model, timeoutSec, jsonMode }
 *   request = { system?, text, images?: [{ mime, base64 }], json?: boolean, signal?: AbortSignal }
 */

export class ProviderError extends Error {
  /**
   * @param {"network"|"timeout"|"aborted"|"auth"|"notfound"|"rate"|"badrequest"|"server"|"refusal"|"empty"|"config"} kind
   * @param {string} message
   * @param {{status?: number, detail?: string}} [info]
   */
  constructor(kind, message, { status, detail } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** `base` + `path` with exactly one slash between them. */
export function joinUrl(base, path) {
  return `${String(base ?? "").replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

function kindOfStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notfound";
  if (status === 429) return "rate";
  if (status >= 500) return "server";
  return "badrequest";
}

/** The human-readable part of an error body, whatever shape the provider uses. */
function errorDetail(body) {
  if (!body) return "";
  try {
    const data = JSON.parse(body);
    const e = data.error ?? data;
    if (typeof e === "string") return e;
    return e?.message ?? e?.error?.message ?? JSON.stringify(e).slice(0, 400);
  } catch {
    return body.slice(0, 400);
  }
}

/**
 * fetch + JSON with a timeout, an outer abort signal and errors mapped to ProviderError.
 * @param {string} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {object} [options.body]        JSON body
 * @param {number} [options.timeoutSec]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>}
 */
export async function requestJson(url, { method = "GET", headers = {}, body, timeoutSec = 300, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutSec) * 1000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new ProviderError("timeout", `no reply within ${timeoutSec}s`);
      if (controller.signal.aborted) throw new ProviderError("aborted", "request cancelled");
      // A browser reports a refused connection and a CORS rejection the same way: TypeError, no details.
      throw new ProviderError("network", err?.message ?? "network error");
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(kindOfStatus(response.status), `HTTP ${response.status}`, {
        status: response.status,
        detail: errorDetail(text),
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("server", "reply is not JSON", { status: response.status, detail: text.slice(0, 400) });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

export function requireModel(config) {
  if (!String(config.model ?? "").trim()) throw new ProviderError("config", "no model selected");
}
