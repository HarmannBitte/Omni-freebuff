# Demo task queue

The agent loop works through these in order. State lives in `state.json`,
so any model / any session can resume mid-queue.

1. `t1-scaffold` — Scaffold project README → `out/README.md`
2. `t2-config` — Write config module → `out/config.mjs`
3. `t3-queue` — Write task-queue module → `out/queue.mjs`
4. `t4-worker` — Write worker module → `out/worker.mjs`
5. `t5-tests` — Write smoke tests → `out/smoke.mjs`
6. `t6-docs` — Write handoff notes → `out/HANDOFF.md`
7. `t7-changelog` — Write changelog → `out/CHANGELOG.md`

Expected demo arc (7 steps, mock quotas: claude-sub=3, codex-sub=2):

- steps 1–3 via `cc/claude-opus-4-6` (subscription)
- steps 4–5 via `cx/gpt-5.2-codex` (subscription, after Claude 429s)
- steps 6–7 via `z-ai/glm-5.3-flash` (FreeBuff free tier, after both subs 429)

Free tier is cheapest-first: one 5-Freebuck GLM session covers steps 6–7
(sessions are charged once at admit, then reused). Daily budget: 100 FB.
