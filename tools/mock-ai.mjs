// OpenAI-compatible stand-in for testing: saves each request's prompt and image, then waits for a reply file.
//   node mock-ai.mjs <dir> [port]
// Request N writes <dir>/req-N.txt and req-N.jpg; the reply is read from <dir>/resp-N.json (raw text of the answer).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 11500);
fs.mkdirSync(dir, { recursive: true });
let counter = 0;

const cors = (req) => ({
  "access-control-allow-origin": req.headers.origin ?? "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
});

const send = (req, res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", ...cors(req) });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    if (req.url.endsWith("/models")) return send(req, res, 200, { data: [{ id: "mock-vision" }, { id: "mock-other" }] });
    if (!req.url.endsWith("/chat/completions")) return send(req, res, 404, { error: { message: "not found" } });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // First request with response_format is rejected once, to exercise the fallback path.
    if (body.response_format && process.env.REJECT_JSON_MODE === "1") {
      return send(req, res, 400, { error: { message: "'response_format.type' must be 'json_schema' or 'text'" } });
    }
    const n = ++counter;
    const user = body.messages.find((m) => m.role === "user");
    const text = user.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    fs.writeFileSync(path.join(dir, `req-${n}.txt`), `MODEL: ${body.model}\nSYSTEM: ${system}\n\n${text}\n`);
    user.content
      .filter((p) => p.type === "image_url")
      .forEach((p, i) => {
        const b64 = p.image_url.url.split(",")[1];
        fs.writeFileSync(path.join(dir, `req-${n}${i ? `-${i}` : ""}.jpg`), Buffer.from(b64, "base64"));
      });
    console.log(`request ${n} waiting`);
    const file = path.join(dir, `resp-${n}.json`);
    let aborted = false;
    req.on("close", () => (aborted = !res.writableEnded));
    const started = Date.now();
    while (!fs.existsSync(file)) {
      if (aborted || Date.now() - started > 3_600_000) return res.destroy();
      await new Promise((r) => setTimeout(r, 300));
    }
    const answer = fs.readFileSync(file, "utf8");
    console.log(`request ${n} answered`);
    send(req, res, 200, {
      choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: Math.ceil(answer.length / 4) },
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock AI on http://127.0.0.1:${port}/v1 → ${dir}`));
