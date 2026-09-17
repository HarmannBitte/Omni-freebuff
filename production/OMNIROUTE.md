# Combining this repo with OmniRoute

`Omni-freebuff` (this repo) is the **autonomous loop + FreeBuff bottom
tier**. [OmniRoute](https://github.com/diegosouzapw/OmniRoute) is the
**gateway** that routes each request across your subscriptions with
automatic failover. You don't merge the codebases — you run both and plug
them together. This guide was verified against real OmniRoute **3.7.9**
(npm) with a live routing + failover test.

```
 Your tools / agent loop
        │  Base URL: http://127.0.0.1:20128/v1   Model: never-stop-coding
        ▼
 ┌──────────────┐  combo (strategy: priority, top→bottom)
 │  OmniRoute   │   1. cc/claude-opus-4-6 ──► your Claude subscription
 │  :20128      │   2. cx/gpt-5.2-codex ────► your Codex subscription
 │              │   3. <nodeId>/z-ai/glm-5.3-flash ─┐
 └──────────────┘   4. <nodeId>/crof/kimi-k3-eco ───┤ FreeBuff Freebucks
                    …                              │ (cheapest first)
        │                                          ▼
        │                              ┌────────────────────┐
        └────────── node ─────────────► │ freebuff2api :8787 │ (this repo's
          (openai-compatible,          │  + patch in this   │  setup + patch)
           prefix fb/)                 │  repo              │
                                       └────────────────────┘
```

## Prerequisites

- **Node 22.22+ or 24+** for OmniRoute (it runs Next.js 16 — on Node 20
  every API route 500s with an instrumentation-hook error; we hit this).
- OmniRoute installed: `npm install -g omniroute`, then run `omniroute`
  (dashboard + API on `:20128`).
- freebuff2api running on `:8787` (see `setup-freebuff2api.sh`, plus the
  `freebuff2api-agent-map.patch` in this repo for the Freebucks catalog).
- Subscription providers connected in OmniRoute (Dashboard → Providers):
  Claude Code (`cc/*`), Codex (`cx/*`), etc.
- A dashboard API key with the **`manage`** scope (Dashboard → API Keys).
  The script needs it; the agent loop gets its own key minted by the script.

## Option A — script (recommended, ~2 min)

```bash
cd production
export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
export OMNIROUTE_MANAGE_KEY="<key with manage scope>"
# optional: FREEBUFF2API_BASE_URL, ROUTER_KEY, SUB_MODELS (see script header)
./create-omniroute-combo.sh
# → creates node 'freebuff' + connection + 'never-stop-coding' combo,
#   mints a chat key, and smoke-tests the full route. Idempotent.
```

Then point the loop at the real thing:

```bash
cd ../demo
GATEWAY=http://127.0.0.1:20128/v1 MODEL=never-stop-coding node agent-loop.mjs
```

## Option B — dashboard clicks (same result, manual)

1. **Providers → Add OpenAI-Compatible**: name `freebuff`, prefix `fb`,
   base URL `http://127.0.0.1:8787/v1`, chat API. Note the node id
   (`openai-compatible-chat-…`).
2. **Providers → Add** on that node: any API key (or your `ROUTER_KEY`),
   active. This creates the connection carrying the base URL.
3. **Combos → Create**: name `never-stop-coding`, strategy **priority**,
   models top→bottom: your `cc/*` + `cx/*` subscription ids, then
   `<nodeId>/<upstreamModelId>` entries (e.g.
   `openai-compatible-chat-abc123/z-ai/glm-5.3-flash`), cheapest first.
4. **API Keys → Create**: key for the agent loop.
5. Smoke-test: `POST /v1/chat/completions` with
   `{"model":"never-stop-coding", …, "stream":false}`.

## Option C — zero-config alternative (`auto/thrifty`)

If you'd rather not maintain an explicit chain, OmniRoute 3.8+ has a
built-in subscription ladder: send `model: "auto/thrifty"` and it walks
subscription → keyless → free → cheap → premium rungs itself, returning
to subscriptions after reset. Trade-off vs our combo: adaptive scoring
instead of your deterministic order, and FreeBuff models join the pool
only via the node from Option A/B step 1–2. Our combo and `auto/thrifty`
can coexist — different model names, same providers.

## Details worth knowing

- **Combo target format for node models is `<nodeId>/<upstreamId>`**,
  e.g. `openai-compatible-chat-abc123/z-ai/glm-5.3-flash`. The `fb/`
  prefix is display-only. The upstream id must match the node's own
  `/v1/models` exactly (a bare `glm-5.3-flash` 404s when the router
  serves `z-ai/glm-5.3-flash` — verified live).
- **Node models never appear in OmniRoute's `/v1/models`** — only combos
  and managed-provider models do. The script enumerates FreeBuff models
  from `:8787` directly instead of discovering them via OmniRoute.
- **Call combos by exact name**: `{"model":"never-stop-coding"}`.
  `auto` does *not* consult your combos.
- **`stream:false` matters** if the upstream doesn't do SSE (our mock
  doesn't; the real freebuff2api does — either way `stream:false` is safe
  for the agent loop).
- **Localhost nodes are allowed by default** (OmniRoute is local-first;
  only cloud-metadata URLs are blocked). No flags needed for
  `http://127.0.0.1:8787/v1`.
- One FreeBuff token = one active session per model. The combo is a
  single lane; add tokens for parallelism (see README §5).

## What was live-tested (2026-09-17, OmniRoute 3.7.9 + mock :8787)

- Node + connection + `priority` combo created; chat via
  `model: "never-stop-coding"` returned a full completion relayed from
  the mock (`z-ai/glm-5.3-flash`).
- Failover combo `[dead-target, glm-target]` → dead target skipped,
  GLM answered. Priority fall-through works as designed.
- `GET /v1/models` exposes combos by exact name; node models stay hidden.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| All `/api/*` → `Internal Server Error` | Node 20 runtime — use Node 22.22+/24+ |
| `Authentication required` from script | `OMNIROUTE_MANAGE_KEY` missing/not manage-scoped |
| `Model X is unavailable` via combo | Upstream id mismatch — must equal the `:8787/v1/models` id |
| `Stream ended before producing useful content` | Upstream returned non-SSE — send `"stream":false` |
| Combo exists but chats fail | Connection `test_status` not ok — check Providers tab |
