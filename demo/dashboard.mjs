// Visual dashboard for the never-stop-coding demo.
//   node dashboard.mjs   → http://0.0.0.0:8080  (preview-friendly: binds all interfaces,
//                            no host allowlist, same-origin relative API calls, zero CDN deps)
//
// Expects the demo stack on 127.0.0.1: mock subs (8891/8892),
// mock freebuff2api (8787), mini-gateway (20128).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, "workspace");
const PORT = Number(process.env.DASHBOARD_PORT ?? 8080);

let run = { running: false, lines: [], done: true };

function resetWorkspace() {
  rmSync(join(WS, "out"), { recursive: true, force: true });
  rmSync(join(WS, "state.json"), { force: true });
  rmSync(join(WS, "PROGRESS.md"), { force: true });
  mkdirSync(join(WS, "out"), { recursive: true });
}

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { up: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { up: false, error: String(e).slice(0, 80) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const [s8891, s8892, fb, gw, combos] = await Promise.all([
      probe("http://127.0.0.1:8891/health"),
      probe("http://127.0.0.1:8892/health"),
      probe("http://127.0.0.1:8787/health?verbose=1"),
      probe("http://127.0.0.1:20128/health"),
      probe("http://127.0.0.1:20128/api/combos"),
    ]);
    json(200, { subs: { s8891, s8892 }, freebuff: fb, gateway: gw, combos: combos.body });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    if (run.running) { json(409, { error: "already running" }); return; }
    run = { running: true, lines: [], done: false };
    const child = spawn("node", ["agent-loop.mjs"], { cwd: HERE });
    const push = (d) => run.lines.push(...String(d).split("\n").filter((l) => l.trim()));
    child.stdout.on("data", push);
    child.stderr.on("data", (d) => push("STDERR: " + d));
    child.on("close", (code) => {
      run.lines.push(`── loop exited (${code}) ──`);
      run.running = false; run.done = true;
    });
    json(200, { started: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/log") {
    const since = Number(url.searchParams.get("since") ?? 0);
    json(200, { lines: run.lines.slice(since), next: run.lines.length, running: run.running, done: run.done });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/progress") {
    const p = join(WS, "PROGRESS.md"), s = join(WS, "state.json");
    json(200, {
      progress: existsSync(p) ? readFileSync(p, "utf8") : "(not started)",
      state: existsSync(s) ? JSON.parse(readFileSync(s, "utf8")) : { completed: [] },
      files: existsSync(join(WS, "out")) ? readdirSync(join(WS, "out")) : [],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (run.running) { json(409, { error: "run in progress" }); return; }
    resetWorkspace();
    run = { running: false, lines: ["── workspace reset ──"], done: true };
    json(200, { reset: true });
    return;
  }

  json(404, { error: "not found" });
});

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>never-stop-coding · live demo</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#0b0e14;color:#d6deeb;
  font:14px/1.55 -apple-system,"Segoe UI",Roboto,Menlo,monospace;padding:24px;max-width:1060px}
  h1{font-size:22px;margin:0 0 4px} h1 .free{color:#7fdbca} p.sub{color:#697098;margin:0 0 18px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px} @media(max-width:800px){.grid{grid-template-columns:1fr}}
  .card{background:#11151f;border:1px solid #1f2740;border-radius:10px;padding:14px 16px}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#697098;margin:0 0 10px}
  .node{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #1f2740;
    border-radius:8px;margin-bottom:6px;background:#0e1320}
  .node .n{color:#697098;width:18px} .node code{flex:1;color:#addbff;font-size:13px}
  .tier{font-size:11px;padding:2px 8px;border-radius:20px;white-space:nowrap}
  .t-sub{background:#1d2b53;color:#82aaff} .t-5{background:#10352a;color:#7fdbca}
  .t-10{background:#2b230f;color:#ffcb6b} .t-15{background:#3a1d1d;color:#ff9cac}
  .dot{width:9px;height:9px;border-radius:50%;background:#3a435f} .dot.ok{background:#2fd08c}
  .btns{display:flex;gap:10px;margin:16px 0}
  button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:11px 26px;cursor:pointer}
  #run{background:#2fd08c;color:#06110c} #run:disabled{background:#1c2b25;color:#5b6b63;cursor:wait}
  #reset{background:#1c2438;color:#addbff}
  #meterWrap{background:#1c2438;border-radius:8px;height:14px;overflow:hidden;margin-top:6px}
  #meter{height:100%;width:100%;background:linear-gradient(90deg,#2fd08c,#7fdbca)}
  pre#log{background:#05070c;border:1px solid #1f2740;border-radius:10px;padding:14px;
    min-height:220px;max-height:380px;overflow:auto;white-space:pre-wrap;font-size:12.5px}
  pre#prog{background:#05070c;border:1px solid #1f2740;border-radius:10px;padding:14px;
    max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12.5px}
  .okline{color:#2fd08c} .muted{color:#697098}
</style></head><body>
<h1>never-stop-coding <span class="free">· live demo</span></h1>
<p class="sub">Autonomous agent loop over a priority combo: subscriptions first, FreeBuff free tier catches overflow. Every step checkpoints to disk, so any model resumes where the last one stopped.</p>
<div class="grid">
  <div class="card"><h2>Combo chain (failover order)</h2><div id="chain"><span class="muted">loading…</span></div></div>
  <div class="card"><h2>Tier health + Freebucks</h2><div id="health"><span class="muted">loading…</span></div>
    <div id="meterWrap"><div id="meter"></div></div><div id="fb" class="muted" style="margin-top:4px"></div></div>
</div>
<div class="btns"><button id="run">▶ Run autonomous loop</button><button id="reset">Reset workspace</button></div>
<div class="grid">
  <div class="card"><h2>Live log</h2><pre id="log">(press Run)</pre></div>
  <div class="card"><h2>Progress (PROGRESS.md + files)</h2><pre id="prog">(press Run)</pre></div>
</div>
<script>
const $=id=>document.getElementById(id);
let cursor=0, polling=false;
function tierClass(t){ if(t.includes('subscription'))return 't-sub';
  if(t.includes('5fb'))return 't-5'; if(t.includes('10fb'))return 't-10'; return 't-15'; }
async function status(){
  try{ const s=await (await fetch('api/status')).json();
    const combo=(s.combos&&s.combos.combos&&s.combos.combos[0])||{models:[]};
    $('chain').innerHTML=combo.models.map((m,i)=>
      '<div class="node"><span class="n">'+(i+1)+'</span><code>'+m.model+'</code>'+
      '<span class="tier '+tierClass(m.tier)+'">'+m.tier+'</span></div>').join('')||'(combo down)';
    const dot=x=>'<span class="dot '+(x&&x.up?'ok':'')+'"></span>';
    const fb=(s.freebuff.body||{});
    $('health').innerHTML=
      '<div class="node">'+dot(s.subs.s8891)+' <code>claude-sub :8891</code><span class="tier t-sub">'+((s.subs.s8891.body||{}).used??'?')+'/'+((s.subs.s8891.body||{}).quota??'?')+' used</span></div>'+
      '<div class="node">'+dot(s.subs.s8892)+' <code>codex-sub :8892</code><span class="tier t-sub">'+((s.subs.s8892.body||{}).used??'?')+'/'+((s.subs.s8892.body||{}).quota??'?')+' used</span></div>'+
      '<div class="node">'+dot(s.freebuff)+' <code>freebuff :8787</code><span class="tier t-5">openai-compatible</span></div>'+
      '<div class="node">'+dot(s.gateway)+' <code>gateway :20128</code><span class="tier t-10">priority combo</span></div>';
    const f=fb.freebucks;
    if(f){ $('meter').style.width=(100*f.remaining/f.limit)+'%';
      $('fb').textContent='Freebucks '+f.remaining+'/'+f.limit+' · sessions: '+(f.sessions.join(', ')||'none'); }
  }catch(e){ $('chain').innerHTML='<span class="muted">status error: '+e+'</span>'; }
}
async function progress(){
  try{ const p=await (await fetch('api/progress')).json();
    $('prog').innerHTML=p.progress.replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/^- \[x\].*/gm,m=>'<span class="okline">'+m+'</span>')
      +'<span class="muted">\\nfiles: '+(p.files.join(', ')||'—')+'</span>';
  }catch(e){}
}
async function pollLog(){
  if(!polling)return;
  try{ const l=await (await fetch('api/log?since='+cursor)).json();
    cursor=l.next;
    if(l.lines.length){ const el=$('log');
      if(el.textContent==='(press Run)')el.textContent='';
      el.textContent+=l.lines.join('\\n')+'\\n'; el.scrollTop=el.scrollHeight; }
    progress(); status();
    if(l.done&&!l.running){ polling=false; $('run').disabled=false; $('run').textContent='▶ Run autonomous loop'; return; }
  }catch(e){}
  setTimeout(pollLog,500);
}
$('run').onclick=async()=>{ $('run').disabled=true; $('run').textContent='running…';
  $('log').textContent=''; cursor=0; polling=true;
  await fetch('api/run',{method:'POST'}); pollLog(); };
$('reset').onclick=async()=>{ await fetch('api/reset',{method:'POST'});
  $('log').textContent='(press Run)'; cursor=0; progress(); status(); };
status(); progress(); setInterval(()=>{ if(!polling) status(); },4000);
</script></body></html>`;

resetWorkspace();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dashboard] → http://0.0.0.0:${PORT} (workspace reset for a clean run)`);
  console.log(`[dashboard] stack expected on 127.0.0.1:8891/8892/8787/20128`);
});
