# FreeBuff live findings: economy, bridge gap, headless driving

Field notes from live testing on 2026-09-16 (device login, real backend,
real `freebuff2api`, real CLI runs). No budget is needed to re-read any of
this; budget is only needed to re-run the live parts.

## 1. Freebucks economy (live, `GET /api/v1/freebuff/session`)

- **100 FB/day** free, reset **midnight Pacific** (`dayResetAt`).
- Session price per model-hour, **charged once at session admit**, then
  the 1h session is reused:

| FB/hr | Models |
|---|---|
| 5 | `z-ai/glm-5.3-flash`, `crof/kimi-k3-eco` |
| 10 | `mimo/mimo-v2.5`, `upstage/solar-pro4` (limited trial) |
| 15 | `deepseek/deepseek-v4-flash`, `meta/muse-spark-1.3-contributor`, `meta/muse-spark-1.2-contributor` |
| 20 | `openai/gpt-5.6-luna`, `openai/gpt-5.6-luna-es` |
| 50 | `google/gemini-3.8-flash` |

- Premium pools additionally cap **5 sessions/day**: kimi-k3-eco,
  muse-spark-1.2, luna, luna-es, gemini-3.8-flash.
- Broke admit → `429` with `freebucksShortfall: {price, balance}` —
  exactly what the gateway fails over on. Observed verbatim; mirrored in
  `demo/mock-freebuff2api.mjs`.
- Default/reward model: `z-ai/glm-5.3-flash`
  (`FREEBUFF_REWARD_MODEL_ID` upstream).

## 2. Bridge gap: freebuff2api 1.0.3 vs the live catalog (CODE-LEVEL FINDING)

The router picks its agent id via `AGENT_BY_MODEL[model] ?? AGENT_FALLBACK`
(`router/freebuff.ts`). Its static map (Aug 2026) has **exact entries for
only 3 of the 10 live-priced models**: deepseek-v4-flash, mimo-v2.5,
gpt-5.6-luna. Everything else falls back to generic `base2-free`, and the
server is documented to reject wrong pairings
(`403 free_mode_invalid_agent_model`) — so the two cheapest models
(GLM 5.3 Flash, Kimi K3 Eco) are **untested and possibly broken** through
the bridge. (Upstream's own resolver also falls back to `base2-free`, so
the fallback *might* pass — unconfirmed either way.)

Exact mappings from the current official source
(`CodebuffAI/freebuff`, `common/src/constants/free-agents.ts` +
`freebuff-models.ts`). Already applied in
`production/freebuff2api-agent-map.patch` (agent map + `/v1/models`
catalog + price passthrough + updated tests) — apply with:

```ts
'z-ai/glm-5.3-flash': 'base2-free-glm-5-3-flash',
'crof/kimi-k3-eco': 'base2-free-kimi-k3-eco',
'upstage/solar-pro4': 'base2-free-solar-pro4',
'openai/gpt-5.6-luna-es': 'base2-free-luna-es',
'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
'meta/muse-spark-1.3-contributor': 'base2-free-muse-spark-1-3',
'google/gemini-3.8-flash': 'base2-free-gemini-3-8-flash',
'stealth/ox-alpha': 'base2-free-ox-alpha',
```

```bash
cd /path/to/freebuff2api && git apply /path/to/production/freebuff2api-agent-map.patch
```

Patch status (verified 2026-09-16, zero spend): router unit tests 55/55,
live `/v1/models` serves the new 10-model catalog with prices + real
premium remaining, GLM chat correctly relays the 429 budget gate.
Also load-bearing upstream: the chat gate rejects any request whose model
differs from the session-admitted model (`session_model_mismatch`) — the
router's per-model sessions already comply; don't share sessions across
models. **Verify-after-reset (5 FB):** one GLM chat through the patched
router; 200 = gap closed, 403 = needs deeper work.

## 3. Headless CLI driving (3 attempts → working recipe)

- Naive piping fails: the TUI boots into a **model picker**, joins the
  session only ~55s in, and swallows anything typed before the compose
  box is focused. Control test proved bytes deliver fine — it's focus.
- Working recipe (implemented in `run-freebuff-task.sh`):
  `Enter@20s` (confirm picker) → wait for join → `prompt@75s` →
  `Enter/30s` (approvals) → `Ctrl-C ×2` (exit).
- Render `script(1)` captures with **pyte**, not grep: OpenTUI uses
  full-screen redraws; only a terminal emulator shows true screen state.
- Conversations persist per project (`~/.config/manicode/projects/…`);
  `--continue <id>` resumes. Check spend before/after via
  `check-freebuff-budget.sh` (zero-spend GET).

## 4. Spend accounting, 2026-09-16

Daily 100 FB, all spent: ≈25 by live testing (one 15-FB Flash session
reused across all router chats + two 5-FB CLI sessions), ≈75 already
spent by the account owner. Premium pools untouched (5/5 each).

## 5. Attempt-4 runbook (after midnight-PT reset)

```bash
./check-freebuff-budget.sh          # expect 0/100 spent
./run-freebuff-task.sh "Create hello.mjs that prints HELLO_FROM_FREEBUFF, run it with node, show output. Just do it, no questions."
./check-freebuff-budget.sh          # expect 5/100 spent
```

## 6. Attempt-4 result (2026-09-17, ✅ SUCCESS)

Staged input worked first try. The real CLI created `hello.mjs`,
ran `node hello.mjs`, and reported `HELLO_FROM_FREEBUFF / exit code 0`.
Session: GLM 5.3 Flash, 14.2K tokens (1%), ads rendered inline.
Spend: 5 → 10 FB (one 5-FB session, as predicted). The app idled past
the double Ctrl-C, so `timeout 220` reaped it — driver now tolerates
that (`|| APP_EXIT=$?`, postflight always runs). Total live spend for
both reset-day items: 10 FB (patch check 5 + CLI task 5).
