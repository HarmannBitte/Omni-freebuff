# Architecture: autonomous loop over OmniRoute + FreeBuff

## The shape of the system

```
┌──────────────────────────────────────────────────────────────┐
│  agent-loop  (autonomous worker — the only thing you run)     │
│  reads state.json → asks gateway for next step → writes file │
│  → checkpoints state.json + PROGRESS.md → repeat             │
└──────────────────────────┬───────────────────────────────────┘
                           │ POST /v1/chat/completions
                           │ { "model": "never-stop-coding" }
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  OmniRoute :20128  — combo "never-stop-coding" (priority)     │
│  fails over on transient errors: 429 / 408 / 5xx / timeout   │
│  does NOT retry: 400 / 401 / 403 / 404                       │
└──┬──────────────┬────────────────┬───────────────────────────┘
   │ Tier 1       │ Tier 1         │ Tier 4 ($0)
   │ subscription │ subscription   │
   ▼              ▼                ▼
 Claude Code   Codex CLI     freebuff2api :8787
 (cc/*, 5h     (cx/*, 5h     OpenAI-compatible shim
 window)       window)            │
                        ┌─────────┴──────────┐
                        │ FreeBuff protocol  │
                        │ session admit →    │
                        │ START run → chat → │
                        │ FINISH run         │
                        └─────────┬──────────┘
                                  ▼
                        codebuff.com backend
                        flash/mimo unlimited
                        pro/minimax/luna 6/day
```

## Why the handoff works across different models

The gateway handles **who answers**. The workspace handles **what's true**:

| File | Role |
|---|---|
| `workspace/state.json` | Machine state: `completed[]`, per-step `via` model, timestamps. Re-read every iteration. |
| `workspace/PROGRESS.md` | Human audit trail: which model did which step. |
| `workspace/TASK.md` | The queue. Human-editable; loop derives `pending = queue − completed`. |

Each iteration sends the full pending list (`PENDING_TASKS_JSON`) to the
combo. The model that happens to be healthy picks the first pending task.
Claude dies mid-run → Codex continues → Codex dies → a FreeBuff free
model finishes. Kill the process and restart it: it resumes from
`state.json`, possibly on a provider whose quota window has since reset
(free → subscription direction works too).

## Failover semantics (copied from OmniRoute)

Source: `docs/OMNIROUTE_PROVIDER_FAILOVER.md` + combo API:

- **Transient → fail over**: timeouts, network errors, 429 (this is what a
  spent 5-hour subscription window surfaces as), provider 5xx.
- **Not retried blindly**: 400 invalid request, 401/403 auth/permission,
  404 unknown model.
- Combo `strategy: "priority"` = strict tier order. Alternatives the
  dashboard offers: load-balance, auto (learned scoring).
- Telemetry: `X-OmniRoute-Decision`, `X-OmniRoute-Provider`,
  `X-OmniRoute-Fallback-Attempts` — the agent logs these per step.

## FreeBuff protocol notes (what freebuff2api hides from you)

Reverse-engineered reference: `PROTOCOL.md` in
[yuzu-octopus/freebuff2api](https://github.com/yuzu-octopus/freebuff2api),
sourced from the Apache-2.0 `CodebuffAI/freebuff` repo.

- Auth: device-code login at freebuff.com → token in
  `~/.config/manicode/credentials.json` → `FREEBUFF_TOKEN` env.
- Session gate: `POST /api/v1/freebuff/session` admits **one global
  active session per account per model** — hence multi-token = parallelism.
- Chat requires `codebuff_metadata.cost_mode: 'free'` (else `402 out of
  credits`) and a first system message opening with the `You are Buffy…`
  marker (else `403 free_mode_cli_required`). freebuff2api injects both.
- Economy (Sept 2026, observed live): **100 Freebucks/day**, reset
  midnight Pacific. Session prices per model-hour, charged once at admit:
  GLM 5.3 Flash / Kimi K3 Eco 5 · MiMo 2.5 / Solar Pro 4 10 ·
  DeepSeek V4 Flash / Muse Spark 15 · Luna 20 · Gemini 3.8 Flash 50.
  Premium pools (Kimi, Muse 1.2, Luna, Gemini) additionally capped at
  **5 sessions/day**. Broke admits fail with `429 freebucksShortfall`.
  (The pre-Sept "unlimited Flash / 6-per-day premium" model is obsolete.)
- Env overrides the CLI itself respects: `NEXT_PUBLIC_CODEBUFF_APP_URL`
  (API host), `NEXT_PUBLIC_FREEBUFF_APP_URL` (login origin).

## Demo ↔ production mapping

| Demo (runs here, no keys) | Production (your machine) |
|---|---|
| `mock-subscriptions.mjs` (:8891/:8892) | Real OAuth subs in OmniRoute: `cc/*`, `cx/*` |
| `mock-freebuff2api.mjs` (:8787) | Real `bunx freebuff2api` + your `FREEBUFF_TOKEN` |
| `mini-gateway.mjs` (:20128) | Real OmniRoute (`npx omniroute`), combo via `create-omniroute-combo.sh` |
| `agent-loop.mjs` + `workspace/` | Same loop, pointed at real gateway (env: `GATEWAY`, `MODEL`) |

The agent loop is written against **plain OpenAI `/v1`** + standard
`X-OmniRoute-*` headers, so it runs unchanged against production.

## Known limits (read before relying on this)

1. **Unofficial bridge.** freebuff2api's own license warns usage "may
   violate [FreeBuff's] Terms of Service". Codebuff can break the protocol
   at any time; the router then needs an update.
2. **One session per account per model.** Parallel agents on one token
   serialize or steal each other's session (`model_locked` recovery
   churn). Scale = more accounts/tokens.
3. **Free models ≠ frontier models.** Flash/MiMo handle routine steps;
   keep hard reasoning on the subscription tiers (priority order does this
   automatically) and keep tasks small so any tier can execute one step.
4. **Ads don't render through the API.** The router bypasses the CLI ad
   surface that funds the free tier — the ethical/ToS gray area you
   accepted. If that bothers you, use OmniRoute's official free tiers
   instead (dashboard `/dashboard/free-tiers`, ~90+ free providers).
5. **State is files, not magic.** For real coding agents (Claude Code,
   Codex CLI) pointed at the combo, handoff = their own session +
   your repo state (git + task files). This repo's loop demonstrates the
   pattern in its simplest form.
