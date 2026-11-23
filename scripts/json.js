/**
 * Lenient JSON extraction from a model reply (pure, no Foundry globals).
 *
 * Models wrap JSON in code fences, prepend a sentence, emit <think> blocks (local reasoning models) or leave a
 * trailing comma. A reply that was cut off is reported as such instead of returning a fragment of it.
 */

export class JsonExtractError extends Error {
  /** @param {"empty"|"truncated"|"invalid"} kind */
  constructor(kind, message) {
    super(message);
    this.name = "JsonExtractError";
    this.kind = kind;
  }
}

/** Index of the bracket closing the one at `start`, or -1 when the text ends first. Strings are skipped. */
function matchBalanced(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    // Trailing commas and // comments are the two usual slips of small local models.
    const relaxed = s.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
    if (relaxed !== s) {
      try {
        return { ok: true, value: JSON.parse(relaxed) };
      } catch {
        /* fall through */
      }
    }
    return { ok: false };
  }
}

/**
 * Parse the first JSON object/array found in a model reply.
 * @param {string} text
 * @returns {any}
 * @throws {JsonExtractError}
 */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new JsonExtractError("empty", "empty reply");
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const direct = tryParse(s);
  if (direct.ok) return direct.value;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) return fenced.value;
  }

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const end = matchBalanced(s, i);
    // An opening bracket that never closes means the reply was cut off: anything parsed from inside it would be
    // a fragment (one polyline instead of the whole answer).
    if (end < 0) throw new JsonExtractError("truncated", "reply ended inside a JSON value");
    const parsed = tryParse(s.slice(i, end + 1));
    if (parsed.ok) return parsed.value;
    i = end + 1;
  }
  throw new JsonExtractError("invalid", "no JSON value in reply");
}
