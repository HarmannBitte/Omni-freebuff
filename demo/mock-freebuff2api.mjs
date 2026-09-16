// Mock freebuff2api: mirrors the REAL freebuff2api surface
// (https://github.com/yuzu-octopus/freebuff2api) AND the real Sept-2026
// Freebucks economy (observed live on 2026-09-16):
//   - 100 Freebucks/day free, reset midnight Pacific
//   - per-model $/hr session price, charged ONCE when the session starts
//   - premium pools capped at 5 sessions/day (pool cap AND FB price both apply)
//   - broke (price > balance) → 429 with freebucksShortfall (mirrored below)
//
//   node mock-freebuff2api.mjs   → http://127.0.0.1:8787
//
// Faithful bits:
//   GET  /health[?verbose=1]   tokens + tokensDetail + streak + freebucks
//   GET  /v1/streak             quota status passthrough shape
//   POST /v1/token-count        server-side token meter shape
//   GET  /v1/models             catalog + prices + live quota enrichment
//   POST /v1/chat/completions   OpenAI shape; session admit + charge first,
//                               then serve. 429s relayed like the real router.
//   Protocol log lines mimic: Pool.acquire → session admit → START run → chat → FINISH.
import http from "node:http";

const PORT = 8787;
const TOKEN = process.env.FREEBUFF_TOKEN ?? "mock-token";
const TOKENS = TOKEN.split(",").map((t) => t.trim()).filter(Boolean);

// Live price list, GET /api/v1/freebuff/session, 2026-09-16.
const DAILY_FB = 100;
const CATALOG = [
  { id: "z-ai/glm-5.3-flash", display: "GLM 5.3 Flash", price: 5, pool: "freebucks", premiumCap: null, context_window: 131072, max_output_tokens: 32768 },
  { id: "crof/kimi-k3-eco", display: "Kimi K3 Eco", price: 5, pool: "premium", premiumCap: 5, context_window: 131072, max_output_tokens: 32768 },
  { id: "mimo/mimo-v2.5", display: "MiMo 2.5", price: 10, pool: "freebucks", premiumCap: null, context_window: 131072, max_output_tokens: 32768 },
  { id: "upstage/solar-pro4", display: "Solar Pro 4", price: 10, pool: "freebucks", premiumCap: null, note: "Limited-time trial", context_window: 131072, max_output_tokens: 32768 },
  { id: "deepseek/deepseek-v4-flash", display: "DeepSeek V4 Flash", price: 15, pool: "freebucks", premiumCap: null, context_window: 1048576, max_output_tokens: 32768 },
  { id: "meta/muse-spark-1.3-contributor", display: "Muse Spark 1.3", price: 15, pool: "freebucks", premiumCap: null, context_window: 131072, max_output_tokens: 32768 },
  { id: "meta/muse-spark-1.2-contributor", display: "Muse Spark 1.2", price: 15, pool: "premium", premiumCap: 5, context_window: 131072, max_output_tokens: 32768 },
  { id: "openai/gpt-5.6-luna", display: "GPT-5.6 Luna", price: 20, pool: "premium", premiumCap: 5, context_window: 1000000, max_output_tokens: 32768 },
  { id: "openai/gpt-5.6-luna-es", display: "GPT-5.6 Luna ES", price: 20, pool: "premium", premiumCap: 5, context_window: 1000000, max_output_tokens: 32768 },
  { id: "google/gemini-3.8-flash", display: "Gemini 3.8 Flash", price: 50, pool: "premium", premiumCap: 5, context_window: 1000000, max_output_tokens: 32768 },
];

// Metered state: one admitted session per model (charged once at start,
// reused by later requests — like the real 1h sessions within a demo run).
let fbSpent = 0;
const sessions = new Set();
const premiumUsed = Object.fromEntries(CATALOG.filter((m) => m.premiumCap).map((m) => [m.id, 0]));
let runSeq = 0;

// Next midnight Pacific ≈ 07:00 UTC (PDT). Mock-grade is fine.
function nextReset() {
  const now = new Date();
  const r = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
  if (r <= now) r.setUTCDate(r.getUTCDate() + 1);
  return r;
}

// Session admission: the Freebucks gate. Returns null when admitted,
// otherwise { httpStatus, body } mirroring the real 429 shapes.
function admit(model) {
  const entry = CATALOG.find((m) => m.id === model);
  if (!entry) {
    return { httpStatus: 404, body: { error: { type: "not_found", message: `Model \`${model}\` is unavailable`, param: "model" } } };
  }
  if (sessions.has(model)) return { reused: true }; // active session: reuse, no recharge
  const reset = nextReset();
  if (entry.premiumCap !== null && (premiumUsed[model] ?? 0) >= entry.premiumCap) {
    return {
      httpStatus: 429,
      body: { status: "rate_limited", model, pool: "premium", poolLabel: "Premium", limit: entry.premiumCap, recentCount: entry.premiumCap, period: "pacific_day", resetAt: reset.toISOString() },
    };
  }
  if (entry.price > DAILY_FB - fbSpent) {
    // Observed verbatim 2026-09-16 (limit/recentCount/price/balance vary).
    return {
      httpStatus: 429,
      body: {
        status: "rate_limited", model, pool: "freebucks", poolLabel: "Freebucks",
        limit: DAILY_FB, recentCount: fbSpent, period: "pacific_day",
        resetTimeZone: "America/Los_Angeles", resetAt: reset.toISOString(), windowHours: 24,
        retryAfterMs: reset.getTime() - Date.now(),
        freebucksShortfall: { price: entry.price, balance: DAILY_FB - fbSpent },
        upgrade: { url: "https://freebuff.com/plans", message: "Get 150 Freebucks a day from $8/mo." },
      },
    };
  }
  fbSpent += entry.price;
  if (entry.premiumCap !== null) premiumUsed[model]++;
  sessions.add(model);
  return null;
}

function planNextStep(messages, display) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  const m = text.match(/PENDING_TASKS_JSON:\s*(\[.*?\])/s);
  let pending = [];
  try { pending = JSON.parse(m?.[1] ?? "[]"); } catch { pending = []; }
  if (!pending.length) return { done: true, note: "no pending tasks" };
  const t = pending[0];
  return {
    done: false,
    step: t.id,
    title: t.title,
    file: t.file,
    content:
      `// ${t.title}\n` +
      `// generated by freebuff tier (mock ${display})\n` +
      `// hint: ${t.hint ?? "n/a"}\n` +
      `export const ${t.id.replace(/-/g, "_")} = ${JSON.stringify(t.title)};\n`,
    note: `picked ${t.id} (${pending.length - 1} remaining after this)`,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader("X-Mock-Upstream", "freebuff-mock");

  if (req.method === "GET" && url.pathname === "/health") {
    const verbose = url.searchParams.get("verbose") === "1";
    const body = { status: "ok", tokens: TOKENS.length };
    if (verbose) {
      body.tokensDetail = TOKENS.map((t) => ({
        token: t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "***",
        busy: false, sessionModel: [...sessions][0] ?? null, toolQuotaExhausted: false,
      }));
      body.streak = { streak: 1, todayUsed: fbSpent > 0, timeZone: "America/Los_Angeles", note: "mock" };
      body.freebucks = { limit: DAILY_FB, spent: fbSpent, remaining: DAILY_FB - fbSpent, sessions: [...sessions] };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/v1/streak" || url.pathname === "/streak")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ streak: 1, todayUsed: fbSpent > 0, timeZone: "America/Los_Angeles", note: "mock" }));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/token-count" || url.pathname === "/token-count")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ inputTokens: Math.ceil(raw.length / 4), note: "mock" }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const now = Math.floor(Date.now() / 1000);
    const data = CATALOG.map((m) => ({
      id: m.id, object: "model", created: now, owned_by: "freebuff",
      display: m.display, display_name: m.display,
      context_window: m.context_window, max_output_tokens: m.max_output_tokens,
      priceFbPerHr: m.price, pool: m.pool,
      ...(m.premiumCap !== null
        ? { userRemaining: Math.max(0, m.premiumCap - (premiumUsed[m.id] ?? 0)), userResetAt: nextReset().toISOString() }
        : {}),
      dailyFbRemaining: DAILY_FB - fbSpent,
      ...(m.note ? { note: m.note } : {}),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const model = body.model ?? "z-ai/glm-5.3-flash";
      const entry = CATALOG.find((m) => m.id === model);

      const runId = `run-mock-${++runSeq}`;
      console.log(`[freebuff-mock] Pool.acquire(${model}) → token#1`);
      const gate = admit(model);
      if (gate && !gate.reused) {
        res.writeHead(gate.httpStatus, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify(gate.body.error ? gate.body : { error: { type: "rate_limit_error", message: JSON.stringify(gate.body).slice(0, 200) } }));
        console.log(`[freebuff-mock] ${gate.httpStatus} session gate for ${model} (fb ${fbSpent}/${DAILY_FB})`);
        return;
      }
      console.log(`[freebuff-mock] session ${gate && gate.reused ? "reused" : "admitted"} for ${model} (fb ${fbSpent}/${DAILY_FB})`);
      console.log(`[freebuff-mock] POST /api/v1/agent-runs START → ${runId}`);

      const action = planNextStep(body.messages ?? [], entry.display);
      const payload = {
        id: `chatcmpl-fbmock-${runSeq}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(action) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 140, completion_tokens: 70, total_tokens: 210 },
      };
      res.writeHead(200, { "Content-Type": "application/json", "X-Mock-Upstream": "freebuff-mock" });
      res.end(JSON.stringify(payload));
      console.log(`[freebuff-mock] chat → ${action.step ?? "done"} via ${model} → FINISH ${runId}`);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found (mock)" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] freebuff2api-mock → http://127.0.0.1:${PORT}  tokens=${TOKENS.length}`);
  console.log(`[mock] Freebucks: ${DAILY_FB}/day, charged once per model session (glm/kimi 5, mimo/solar 10, flash/muse 15, luna 20, gemini 50)`);
});
