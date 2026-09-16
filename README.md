# Never-stop autonomous loop: OmniRoute subscriptions + FreeBuff free tier

**Your goal:** an agent that works autonomously, rides OmniRoute's
automatic subscription failover when a 5h window is spent, and keeps going
on FreeBuff's free ad-supported models — with each tier picking up exactly
where the previous one stopped.

**Yes, I built it.** Below: live demo results, how to run it, and the
production wiring for your machine.

---

## 1. What I verified first (this changed the plan)

- **OmniRoute → FreeBuff is the working direction**, via the community
  bridge `freebuff2api` (npm, MIT): a local OpenAI-compatible `/v1`
  server on `:8787` that speaks the FreeBuff session protocol for you.
  OmniRoute treats it as a standard custom endpoint. No fork needed.
- The **reverse direction** (FreeBuff CLI → OmniRoute backend) is the bad
  one: FreeBuff's CLI speaks Codebuff's agent-run protocol, not OpenAI, so
  pointing it at OmniRoute means emulating a backend. Fragile, breaks
  multi-agent features. Not built.
- **FreeBuff is not hardcoded** — its CLI respects `NEXT_PUBLIC_CODEBUFF_APP_URL`,
  and its token sits in `~/.config/manicode/credentials.json` after a
  normal login. No patching, no DNS tricks needed for our direction.
- OmniRoute fails over on **429/5xx/timeout** (exactly what a spent 5h
  subscription window looks like) and supports strict **priority combos**.
  FreeBuff's Flash/MiMo models are **unlimited** — a perfect bottom tier.

## 2. Demo results (ran in this workspace, no keys)

```
combo: never-stop-coding | strategy: priority
  1. cc/claude-opus-4-6      [subscription]
  2. cx/gpt-5.2-codex        [subscription]
  3. deepseek-v4-pro         [free-premium]
  4. deepseek-v4-flash       [free-unlimited]
  5. mimo-v2.5               [free-unlimited]

[agent] step 1/7: t1-scaffold via cc/claude-opus-4-6    fallbacks=0
[agent] step 2/7: t2-config   via cc/claude-opus-4-6    fallbacks=0
[agent] step 3/7: t3-queue    via cc/claude-opus-4-6    fallbacks=0
[agent] step 4/7: t4-worker   via cx/gpt-5.2-codex      fallbacks=1  ← Claude 429
[agent] step 5/7: t5-tests    via cx/gpt-5.2-codex      fallbacks=1
[agent] step 6/7: t6-docs     via deepseek-v4-pro       fallbacks=2  ← Codex 429
[agent] step 7/7: t7-changelog via deepseek-v4-pro      fallbacks=2
[agent] ✅ all tasks complete — 7/7, three tiers, zero human input
```

Resume test: deleted the last step from `state.json` + its file (simulated
crash) → loop resumed at 6/7 and finished. Handoff is provider-independent
in both directions: subs→free when windows exhaust, free→subs when they reset.

## 2b. Live test (real backend, real token — 2026-09-16)

Beyond mocks, the real chain was verified end-to-end with a user-approved
device login: real `bunx freebuff2api` :8787 → `codebuff.com` →
DeepSeek V4 Flash. `LIVE_ROUTE_OK` round-trip, real `/v1/models` quotas
(Luna `remaining=5`, reset midnight PT), and a **hybrid loop run**: steps
1–5 via mock subs, 6–7 via **real Flash** after both subs 429'd. Two
production hardenings came out of it: tolerant JSON extraction
(fence/comment stripping) and one automatic retry on transient relay
glitches (one truncated response observed and survived via checkpointed
resume). Premium 6/day models were deliberately excluded from the live run
to avoid spending daily sessions.

## 3. Run the demo yourself

```bash
cd demo
./run-demo.sh
# → starts mock subs + mock freebuff2api + mini-gateway, runs the agent,
#   prints PROGRESS.md. Pure Node 20+, no installs, ~2 seconds.
```

| File | What it is |
|---|---|
| `demo/mock-subscriptions.mjs` | Claude/Codex subs: serve N reqs, then 429 like a spent 5h window |
| `demo/mock-freebuff2api.mjs` | Faithful freebuff2api surface: `/health`, `/v1/models`+quotas, `/v1/streak`, chat with unlimited/premium pools |
| `demo/mini-gateway.mjs` | OmniRoute priority-combo semantics + `X-OmniRoute-*` headers |
| `demo/agent-loop.mjs` | **The autonomous loop.** State in `workspace/state.json`; runs unchanged vs production |
| `demo/combo.json` | The chain definition (mirrors the production combo) |

## 4. Production wiring (your machine, ~15 min)

```bash
cd production
cp .env.example .env            # fill in as you go

# A. FreeBuff side → local :8787
./setup-freebuff2api.sh         # installs bun + freebuff, login, starts router
# (or manually: freebuff login → ./extract-freebuff-token.sh → bunx freebuff2api)

# B. OmniRoute side → combo + key
npx omniroute                   # dashboard on :20128, connect cc/* + cx/* subs
./create-omniroute-combo.sh     # adds :8787 as custom endpoint, creates
                                # 'never-stop-coding' combo, mints a chat key

# C. Agent loop → point at the real thing
cd ../demo
GATEWAY=http://127.0.0.1:20128/v1 MODEL=never-stop-coding node agent-loop.mjs
```

The combo order (subscription → subscription → cheap → **free**) means
expensive tiers are always preferred while healthy; FreeBuff only catches
overflow. Prefer unlimited `flash`/`mimo` at the very bottom.

## 5. Honest warnings

- **ToS gray area you accepted:** freebuff2api's license states usage "may
  violate [FreeBuff's] Terms of Service" — the API path bypasses the CLI
  ads that fund the free tier. Codebuff can also break the protocol anytime.
- **Metered bottom tier.** 100 Freebucks/day free; sessions are priced
  per model-hour and charged at session start. Size overnight runs for
  ~20 GLM-hours/day, not infinity.
- **One session per FreeBuff account per model.** One token = one lane;
  add accounts for parallelism.
- **Bridge drift risk.** `freebuff2api`'s catalog predates the Freebucks
  economy (Aug 2026) — watch for updates; new models and 429 shapes may
  need router support.
- **Free models are weaker.** Keep loop steps small and verifiable so any
  tier can execute one step; the priority order keeps hard work on subs.
- Prefer the fully-official route? Skip FreeBuff: OmniRoute's dashboard
  `/dashboard/free-tiers` lists ~90+ official free providers for the
  bottom tier instead. The loop and combo work identically.

See `ARCHITECTURE.md` for the full design, protocol notes, and limits.
