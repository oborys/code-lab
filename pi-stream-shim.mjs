
import http from "node:http";

const PORT = Number(process.env.PI_SHIM_PORT || 11434);
const UPSTREAM = process.env.LLM_BASE_URL;
const FALLBACK_KEY = process.env.LLM_API_KEY;

if (!UPSTREAM) {
  console.error("FATAL: LLM_BASE_URL is not set");
  process.exit(1);
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handle(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: { message: "shim: invalid JSON body" } }));
    return;
  }

  const wasStream = body.stream === true;
  delete body.stream;
  delete body.stream_options;

  const authHeader =
    req.headers.authorization ||
    (FALLBACK_KEY ? `Bearer ${FALLBACK_KEY}` : undefined);

  const upstreamUrl = UPSTREAM.replace(/\/+$/, "") + req.url;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: { message: `shim upstream fetch failed: ${err.message}` } }),
    );
    return;
  }

  const text = await upstreamRes.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: { message: "shim: upstream did not return JSON", upstreamStatus: upstreamRes.status } }),
    );
    return;
  }

  if (!wasStream) {
    res.writeHead(upstreamRes.status, { "Content-Type": "application/json" })
      .end(JSON.stringify(json));
    return;
  }

  // Re-emit as SSE. Pi's openai-completions parser expects role -> content/tool_calls -> finish_reason chunks, then [DONE].
  res.writeHead(upstreamRes.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });

  if (!upstreamRes.ok || json.error) {
    sse(res, json);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const base = {
    id: json.id,
    object: "chat.completion.chunk",
    created: json.created,
    model: json.model,
  };

  sse(res, { ...base, choices: [{ index: 0, delta: { role: msg.role || "assistant" }, finish_reason: null }] });

  if (msg.reasoning_content) {
    sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }] });
  }

  if (typeof msg.content === "string" && msg.content.length > 0) {
    sse(res, { ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] });
  }

  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc, i) => {
      sse(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: tc.type || "function",
              function: { name: tc.function?.name, arguments: tc.function?.arguments },
            }],
          },
          finish_reason: null,
        }],
      });
    });
  }

  sse(res, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
    usage: json.usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: { message: `shim handler error: ${err.message}` } }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`pi-stream-shim listening on http://127.0.0.1:${PORT}, forwarding to ${UPSTREAM}`);
});
