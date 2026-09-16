// Mini-gateway: replicates OmniRoute's priority-combo failover for the demo.
//
//   node mini-gateway.mjs   → http://127.0.0.1:20128
//
// Behavior copied from OmniRoute docs:
//   - POST /v1/chat/completions with {"model": "<combo-name>"} walks the
//     chain in order; explicit "provider/model" ids route directly.
//   - Transient failures (429, 5xx, timeout, network error) FAIL OVER.
//   - Auth/permission/bad-request/unknown-model (400/401/403/404) do NOT
//     fail over blindly — returned immediately (matches
//     docs/OMNIROUTE_PROVIDER_FAILOVER.md).
//   - Telemetry headers like the real gateway: X-OmniRoute-Decision,
//     X-OmniRoute-Provider, X-OmniRoute-Model, X-OmniRoute-Fallback-Attempts.
import http from "node:http";
import { readFileSync } from "node:fs";

const PORT = 20128;
const COMBO = JSON.parse(readFileSync(new URL("./combo.json", import.meta.url), "utf8"));
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

const TRANSIENT = (status) => status === 429 || status === 408 || status >= 500;

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

async function tryUpstream(node, body, attemptNo) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(`${node.upstream}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model: node.model }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
    return {
      ok: r.ok, status: r.status, json,
      latencyMs: Date.now() - started,
      upstreamHeader: r.headers.get("x-mock-upstream"),
    };
  } catch (e) {
    return { ok: false, status: 0, networkError: String(e), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", combo: COMBO.name, strategy: COMBO.strategy, nodes: COMBO.models.length });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/combos") {
    sendJson(res, 200, { combos: [COMBO] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [
        { id: COMBO.name, object: "model", owned_by: "combo", strategy: COMBO.strategy },
        ...COMBO.models.map((m) => ({ id: m.model, object: "model", owned_by: m.tier })),
      ],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON body" } });
        return;
      }
      const requested = body.model;
      const chain = requested === COMBO.name
        ? COMBO.models
        : COMBO.models.filter((m) => m.model === requested);
      if (!chain.length) {
        sendJson(res, 404, { error: { type: "not_found", message: `Model \`${requested}\` is unavailable`, param: "model" } });
        return;
      }

      const errors = [];
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        const r = await tryUpstream(node, body, i);
        if (r.ok) {
          const headers = {
            "X-OmniRoute-Decision": `strategy=${requested === COMBO.name ? COMBO.strategy : "single"}; provider=${r.upstreamHeader ?? node.tier}; latency_ms=${r.latencyMs}`,
            "X-OmniRoute-Provider": r.upstreamHeader ?? node.tier,
            "X-OmniRoute-Model": node.model,
            ...(i > 0 ? { "X-OmniRoute-Fallback-Attempts": String(i) } : {}),
          };
          console.log(`[gateway] 200 ${requested} → ${node.model} (${r.upstreamHeader}) attempts=${i} ${r.latencyMs}ms`);
          sendJson(res, 200, r.json, headers);
          return;
        }
        errors.push({ model: node.model, status: r.status, detail: r.json?.error ?? r.networkError });
        if (!TRANSIENT(r.status)) {
          console.log(`[gateway] ${r.status} ${requested} → ${node.model} NON-retryable, stop`);
          sendJson(res, r.status || 502, r.json ?? { error: { message: "upstream error" } },
            { "X-OmniRoute-Fallback-Attempts": String(i), "X-OmniRoute-Provider": r.upstreamHeader ?? node.tier });
          return;
        }
        console.log(`[gateway] ${r.status || "net-err"} ${requested} → ${node.model} transient, fail over (${i + 1}/${chain.length})`);
      }
      sendJson(res, 503, {
        error: { type: "all_providers_failed", message: `Combo '${requested}': every provider failed`, attempts: errors },
      }, { "X-OmniRoute-Fallback-Attempts": String(chain.length) });
    });
    return;
  }

  sendJson(res, 404, { error: { message: "not found (mini-gateway)" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gateway] mini-gateway → http://127.0.0.1:${PORT}  combo='${COMBO.name}' (${COMBO.strategy})`);
  COMBO.models.forEach((m, i) => console.log(`[gateway]   ${i + 1}. ${m.model} [${m.tier}] → ${m.upstream}`));
});
