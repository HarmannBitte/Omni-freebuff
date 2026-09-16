// Autonomous agent loop with provider-independent handoff.
//
// How work survives provider switches (the whole point of this demo):
//   workspace/state.json   → machine state: completed steps, checkpoints
//   workspace/PROGRESS.md  → human log: who (which model) did what
//   workspace/TASK.md      → the queue (human-editable)
//
// Every iteration re-reads state.json from disk and sends the pending list
// to the gateway. Whichever model answers (Claude sub, Codex sub, or a
// FreeBuff free model) sees the SAME state, so it picks up exactly where
// the previous model stopped. Kill the loop mid-run and restart it — it
// resumes from state.json, possibly on a different provider.
//
//   GATEWAY=http://127.0.0.1:20128/v1 MODEL=never-stop-coding node agent-loop.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = process.env.AGENT_WORKSPACE ?? join(HERE, "workspace");
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:20128/v1";
const MODEL = process.env.MODEL ?? "never-stop-coding";
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 12);

const TASKS = [
  { id: "t1-scaffold", title: "Scaffold project README", file: "out/README.md", hint: "one-paragraph readme" },
  { id: "t2-config", title: "Write config module", file: "out/config.mjs", hint: "export PORT and RETRY constants" },
  { id: "t3-queue", title: "Write task-queue module", file: "out/queue.mjs", hint: "tiny in-memory fifo with push/shift" },
  { id: "t4-worker", title: "Write worker module", file: "out/worker.mjs", hint: "processes one queue item, returns ok flag" },
  { id: "t5-tests", title: "Write smoke tests", file: "out/smoke.mjs", hint: "assert queue+worker roundtrip" },
  { id: "t6-docs", title: "Write handoff notes", file: "out/HANDOFF.md", hint: "how the next agent continues" },
  { id: "t7-changelog", title: "Write changelog", file: "out/CHANGELOG.md", hint: "list t1..t6 as done" },
];

function loadState() {
  const p = join(WS, "state.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return { combo: MODEL, completed: [], log: [], startedAt: new Date().toISOString() };
}
function saveState(s) {
  s.updatedAt = new Date().toISOString();
  writeFileSync(join(WS, "state.json"), JSON.stringify(s, null, 2));
}
function appendProgress(line) {
  const p = join(WS, "PROGRESS.md");
  if (!existsSync(p)) writeFileSync(p, "# Progress log\n\n");
  writeFileSync(p, line + "\n", { flag: "a" });
}

async function askGateway(pending, completed) {
  const system = "You are a coding-agent worker. Reply ONLY with raw JSON for the next single step — no markdown fences, no commentary.";
  const user =
    `Completed: ${JSON.stringify(completed)}\n` +
    `PENDING_TASKS_JSON: ${JSON.stringify(pending)}\n` +
    `Pick the FIRST pending task and reply ONLY with raw JSON: {"done":false,"step":id,"title":..,"file":..,"content":..,"note":..}. ` +
    `If none pending: {"done":true}. No markdown, no backticks, just the JSON object.`;
  const r = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 1024 }),
  });
  const provider = r.headers.get("x-omniroute-provider") ?? "unknown";
  const servedModel = r.headers.get("x-omniroute-model") ?? MODEL;
  const fallbacks = r.headers.get("x-omniroute-fallback-attempts") ?? "0";
  const decision = r.headers.get("x-omniroute-decision") ?? "";
  const text = await r.text();
  if (!r.ok) throw new Error(`gateway ${r.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content ?? "";
  return { action: parseAction(content), provider, servedModel, fallbacks, decision };
}

// Tolerant JSON extraction: real models sometimes wrap JSON in fences or
// add commentary despite instructions. Mocks return raw JSON.
function parseAction(content) {
  const tries = [
    content,
    content.replace(/```json\s*/i, "").replace(/```\s*/g, ""),
  ];
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) tries.push(content.slice(first, last + 1));
  for (const t of tries) {
    try { return JSON.parse(t.trim()); } catch { /* next */ }
  }
  throw new Error(`unparseable model output: ${content.slice(0, 200)}`);
}

async function main() {
  mkdirSync(join(WS, "out"), { recursive: true });
  const state = loadState();
  console.log(`[agent] workspace=${WS} model=${MODEL} gateway=${GATEWAY}`);
  console.log(`[agent] resumed: ${state.completed.length}/${TASKS.length} done`);

  for (let i = 0; i < MAX_STEPS; i++) {
    const pending = TASKS.filter((t) => !state.completed.includes(t.id));
    if (!pending.length) { console.log("[agent] ✅ all tasks complete"); break; }

    let result;
    try {
      result = await askGateway(pending, state.completed);
    } catch (e) {
      console.log(`[agent] transient error (${String(e.message).slice(0, 120)}), retrying once…`);
      await new Promise((r) => setTimeout(r, 2000));
      result = await askGateway(pending, state.completed);
    }
    const { action, provider, servedModel, fallbacks } = result;
    if (action.done) { console.log("[agent] ✅ model reports done"); break; }

    const target = join(WS, action.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, (action.content ?? "") + `\n// — committed by agent-loop via ${servedModel}\n`);

    state.completed.push(action.step);
    state.log.push({ step: action.step, via: servedModel, provider, fallbacks: Number(fallbacks), at: new Date().toISOString() });
    saveState(state);
    const line = `- [x] **${action.step}** ${action.title} — via \`${servedModel}\` (${provider}, fallbacks=${fallbacks})`;
    appendProgress(line);
    console.log(`[agent] step ${state.completed.length}/${TASKS.length}: ${action.step} via ${servedModel} [${provider}] fallbacks=${fallbacks}`);
  }

  saveState(state);
  console.log(`[agent] finished: ${state.completed.length}/${TASKS.length} done. See workspace/PROGRESS.md`);
}

main().catch((e) => { console.error("[agent] FATAL:", e.message); process.exit(1); });
