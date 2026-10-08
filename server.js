#!/usr/bin/env node
// ============================================================================
//  Y70 Dashboard server — static files + Claude API proxy.
//  Zero dependencies. Binds to 127.0.0.1:8888.
//
//  Routes:
//    /            -> shell.html   (the app frame: apps + bottom widgets)
//    /callback    -> index.html   (Spotify OAuth landing)
//    /api/claude  -> proxies to Anthropic's Messages API using the key in
//                    claude-key.txt (so the key never ships to the page)
//    /api/pcstats -> live machine telemetry (RAM/CPU/GPU/network/top talkers)
//    /api/system  -> audio devices + per-app mixer + Windows media session
//    /api/lyrics  -> LRCLIB proxy (free, key-less), cached
//    /api/notes   -> reads/writes notes.txt in the data folder
//    /api/discord -> Discord RPC: real mute/deafen, voice channel, speaking
//    /api/phone   -> iPhone notifications, calls and battery over BLE (ANCS)
//    /api/jarvis/ -> the Jarvis assistant (see assistant.js)
//    everything else -> static files from this folder
//
//  Run with:   node server.js
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const https = require("https");
const discord = require("./discord");
const assistant = require("./assistant");

let Anthropic = null;
try { Anthropic = require("@anthropic-ai/sdk"); Anthropic = Anthropic.default || Anthropic; }
catch (e) { /* the Claude routes say so when asked */ }

const HOST = "127.0.0.1";
// The shell and every page assume 8888; the override exists so a second copy
// can be run alongside a live one to try something out.
const PORT = Number(process.env.Y70_PORT) || 8888;
const ROOT = __dirname;

// Everything the dashboard WRITES lives apart from the files it ships. Once
// installed, ROOT is inside Program Files and read-only, so saving notes or
// Discord credentials came back EPERM. The native shell passes its per-user
// folder in; run from source there is no shell, and beside the code is
// exactly where these belong.
const DATA = process.env.Y70_DATA || ROOT;
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}

// State written before that split may still be sitting beside the code. Carry
// it across once rather than silently starting the user over.
const STATE_FILES = ["claude-key.txt", "notes.txt", "discord-app.json", "discord-token.json"]
  .concat(assistant.STATE_FILES);
function stateFile(name) {
  const target = path.join(DATA, name);
  if (DATA !== ROOT && !fs.existsSync(target)) {
    try {
      const legacy = path.join(ROOT, name);
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, target);
    } catch (e) { /* nothing to carry over */ }
  }
  return target;
}
for (const name of STATE_FILES) stateFile(name);

const CLAUDE_MODEL = "claude-opus-5";
const CLAUDE_KEY_FILE = stateFile("claude-key.txt");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---- Claude proxy ----------------------------------------------------------
function readClaudeKey() {
  try {
    const key = fs.readFileSync(CLAUDE_KEY_FILE, "utf8").trim();
    if (!key || key.includes("PASTE")) return null;
    return key;
  } catch (e) {
    return null;
  }
}

// Written from Jarvis's settings. An empty key removes it.
function writeClaudeKey(key) {
  if (!key) { try { fs.unlinkSync(CLAUDE_KEY_FILE); } catch (e) {} return; }
  fs.writeFileSync(CLAUDE_KEY_FILE, key + "\n", "utf8");
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handleClaude(req, res) {
  const key = readClaudeKey();
  if (!key) {
    return json(res, 503, {
      error: "no_key",
      message: "Paste your Anthropic API key into claude-key.txt (get one at console.anthropic.com).",
    });
  }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100_000) req.destroy(); });
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "bad_json" }); }
    if (!payload.prompt) return json(res, 400, { error: "missing_prompt" });

    if (!Anthropic) return json(res, 503, { error: "no_sdk", message: "The Anthropic SDK is not installed (npm install)." });
    try {
      const client = new Anthropic({ apiKey: key });
      // Server-side fallback: if a safety classifier declines, the request is
      // automatically re-served by Anthropic's recommended fallback model.
      const data = await client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: payload.system || undefined,
        messages: [{ role: "user", content: payload.prompt }],
      });
      if (data.stop_reason === "refusal") {
        return json(res, 200, { text: null, error: "refusal" });
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return json(res, 200, { text, model: data.model });
    } catch (e) {
      if (e instanceof Anthropic.APIError && e.status) {
        console.error("Claude API error:", e.status, e.message.slice(0, 300));
        return json(res, e.status, { error: "api_error", detail: e.message });
      }
      console.error("Claude proxy failed:", e.message);
      return json(res, 502, { error: "proxy_failed", detail: e.message });
    }
  });
}

// ---- Claude usage stats (local, free) --------------------------------------
// Reads Claude Code's transcript files from ~/.claude/projects/**/*.jsonl and
// aggregates token usage. Purely local — no API calls, costs nothing.
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
const statsCache = new Map(); // filePath -> { mtimeMs, size, entries: [...] }

// Rough per-MTok pricing for "est. API value" (input, output).
function priceFor(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return [5, 25];
  if (m.includes("haiku")) return [1, 5];
  return [3, 15]; // sonnet & default
}

function localDay(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function walkJsonl(dir, out) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walkJsonl(p, out);
    else if (it.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function parseTranscript(file) {
  const entries = [];
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return entries; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const u = obj.type === "assistant" && obj.message && obj.message.usage;
    if (!u) continue;
    const day = localDay(obj.timestamp);
    if (!day) continue;
    const inn = u.input_tokens || 0, out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    const [pi, po] = priceFor(obj.message.model);
    entries.push({
      id: (obj.message.id || "") + "|" + (obj.requestId || ""),
      day,
      model: obj.message.model || "unknown",
      session: obj.sessionId || file,
      inn, out, cw, cr,
      cost: (inn * pi + out * po + cw * pi * 1.25 + cr * pi * 0.1) / 1e6,
    });
  }
  return entries;
}

function collectEntries() {
  const files = walkJsonl(CLAUDE_PROJECTS, []);
  const live = new Set(files);
  for (const key of statsCache.keys()) if (!live.has(key)) statsCache.delete(key);
  const all = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const cached = statsCache.get(f);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      statsCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, entries: parseTranscript(f) });
    }
    all.push(...statsCache.get(f).entries);
  }
  return all;
}

function handleClaudeStats(req, res) {
  try {
    const entries = collectEntries();
    if (!entries.length) return json(res, 200, { ok: false, error: "no_data" });

    // Dedup (the same message can appear in more than one transcript file).
    const seen = new Set();
    const perDay = new Map();
    const models30 = new Map();
    const now = new Date();
    const today = localDay(now);
    const monthPrefix = today.slice(0, 7);
    const cut30 = localDay(new Date(now - 29 * 864e5));

    const bucket = (day) => {
      if (!perDay.has(day)) perDay.set(day, { tok: 0, cost: 0, msgs: 0, sessions: new Set() });
      return perDay.get(day);
    };

    for (const e of entries) {
      if (e.id !== "|") {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
      }
      const b = bucket(e.day);
      b.tok += e.inn + e.out + e.cw + e.cr;
      b.cost += e.cost;
      b.msgs += 1;
      b.sessions.add(e.session);
      if (e.day >= cut30) models30.set(e.model, (models30.get(e.model) || 0) + e.inn + e.out + e.cw + e.cr);
    }

    const dayOr = (d) => perDay.get(d) || { tok: 0, cost: 0, msgs: 0, sessions: new Set() };
    const t = dayOr(today);

    // Last 7 days, oldest first.
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 864e5);
      const key = localDay(d);
      const b = dayOr(key);
      days.push({ date: key, label: i === 0 ? "Today" : DOW[d.getDay()], tok: b.tok, cost: b.cost });
    }

    let month = { tok: 0, cost: 0 }, allTime = { tok: 0, cost: 0, msgs: 0 };
    for (const [day, b] of perDay) {
      allTime.tok += b.tok; allTime.cost += b.cost; allTime.msgs += b.msgs;
      if (day.startsWith(monthPrefix)) { month.tok += b.tok; month.cost += b.cost; }
    }

    let topModel = null, topTok = 0;
    for (const [m, tok] of models30) if (tok > topTok) { topTok = tok; topModel = m; }
    if (topModel) topModel = topModel.replace(/^claude-/, "").replace(/-\d{8}$/, "");

    return json(res, 200, {
      ok: true,
      today: { tok: t.tok, cost: t.cost, msgs: t.msgs, sessions: t.sessions.size },
      month, allTime, days, topModel,
    });
  } catch (e) {
    console.error("Stats failed:", e.message);
    return json(res, 500, { ok: false, error: "stats_failed", detail: e.message });
  }
}

// ============================================================================
//  PC stats  —  GET /api/pcstats
//
//  A single long-lived PowerShell sampler (pcstats.ps1) streams raw cumulative
//  counters as JSON lines; everything rate-shaped is differentiated here from
//  the last two samples. Doing it this way means an HTTP request never waits on
//  PowerShell: it answers from the newest sample already in memory.
//
//  RAM and CPU% come straight from node — os.freemem() and os.cpus() are exact
//  and free, so there is no reason to ask PowerShell for them.
// ============================================================================
const PCSTATS_SCRIPT = path.join(ROOT, "pcstats.ps1");
const PC_IDLE_MS = 60 * 1000;      // stop sampling once the widget stops asking

const pc = {
  proc: null, buf: "", prev: null, last: null,
  lastAsk: 0, err: null, starts: 0,
};

function pcStart() {
  if (pc.proc) return;
  if (process.platform !== "win32") { pc.err = "PC stats need Windows."; return; }
  if (!fs.existsSync(PCSTATS_SCRIPT)) { pc.err = "pcstats.ps1 is missing."; return; }

  pc.starts++;
  pc.err = null;
  const child = spawn("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PCSTATS_SCRIPT,
    "-IntervalMs", "2000", "-ParentPid", String(process.pid),
  ], { cwd: ROOT, windowsHide: true });
  pc.proc = child;

  child.stdout.on("data", (d) => {
    pc.buf += d.toString();
    let i;
    while ((i = pc.buf.indexOf("\n")) >= 0) {
      const line = pc.buf.slice(0, i).trim();
      pc.buf = pc.buf.slice(i + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        pc.prev = pc.last;
        pc.last = sample;
      } catch (e) { /* a partial or noisy line — the next one will be clean */ }
    }
    // A stuck consumer must not let the buffer grow without bound.
    if (pc.buf.length > 1e6) pc.buf = "";
  });
  child.stderr.on("data", (d) => { pc.err = String(d).slice(0, 300).trim() || pc.err; });
  child.on("error", (e) => { pc.err = e.message; pc.proc = null; });
  child.on("exit", () => {
    pc.proc = null; pc.buf = "";
    // Respawn only while something is still watching.
    if (Date.now() - pc.lastAsk < PC_IDLE_MS) setTimeout(pcStart, 2000);
  });
}

// Windows does not reap a child when its parent exits, so tidy up on the way
// out. pcstats.ps1 also watches our pid, which covers a hard kill.
for (const sig of ["exit", "SIGINT", "SIGTERM"]) process.on(sig, () => { pcStop(); sysStop(); phoneStop(); discord.stop(); });

function pcStop() {
  if (!pc.proc) return;
  pc.proc.kill();
  pc.proc = null;
  pc.buf = ""; pc.prev = null; pc.last = null;
}
setInterval(() => {
  if (pc.proc && Date.now() - pc.lastAsk > PC_IDLE_MS) pcStop();
}, 15000).unref();

// CPU load from os.cpus() deltas — the only honest way to get a percentage,
// since the raw values are cumulative ticks since boot. Returns the overall
// figure plus one per logical core, which is what the per-core strip draws.
let cpuPrev = null;
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  const total = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
  let pct = null, cores = [];
  if (cpuPrev && cpuPrev.length === now.length) {
    let dIdle = 0, dTotal = 0;
    for (let i = 0; i < now.length; i++) {
      const ci = now[i].idle - cpuPrev[i].idle;
      const ct = total(now[i]) - total(cpuPrev[i]);
      dIdle += ci; dTotal += ct;
      cores.push(ct > 0 ? Math.round(Math.max(0, Math.min(100, (1 - ci / ct) * 100))) : 0);
    }
    if (dTotal > 0) pct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  cpuPrev = now;
  return { pct, cores };
}

// ---- History ---------------------------------------------------------------
// A ring buffer sampled on its own timer rather than on request, so the graph
// keeps its shape whether or not the widget is on screen, and so two widgets
// asking at different rates see the same series.
const HIST_MAX = 180;                    // 180 * 2s = 6 minutes
const HIST_MS = 2000;
const history = { t: [], cpu: [], gpu: [], gpuTemp: [], cpuTemp: [], ram: [], down: [], up: [] };
let histTimer = null;

function pushHistory() {
  const b = pc.last, a = pc.prev;
  const cpu = cpuPercent();
  const totalMem = os.totalmem(), freeMem = os.freemem();

  let down = null, up = null;
  if (a && b && b.t > a.t) {
    const dt = (b.t - a.t) / 1000;
    const prevNet = new Map((a.net || []).map((n) => [n.n, n]));
    let rx = 0, tx = 0;
    for (const n of b.net || []) {
      const pn = prevNet.get(n.n);
      if (!pn) continue;
      if (n.rx >= pn.rx) rx += (n.rx - pn.rx) / dt;
      if (n.tx >= pn.tx) tx += (n.tx - pn.tx) / dt;
    }
    down = Math.round(rx); up = Math.round(tx);
  }

  const push = (k, v) => {
    history[k].push(v);
    if (history[k].length > HIST_MAX) history[k].shift();
  };
  push("t", Date.now());
  push("cpu", cpu.pct == null ? null : Math.round(cpu.pct));
  push("ram", Math.round(((totalMem - freeMem) / totalMem) * 100));
  push("gpu", b && b.gpu ? Math.round(b.gpu.util) : null);
  push("gpuTemp", b && b.gpu ? Math.round(b.gpu.temp) : null);
  push("cpuTemp", b && b.cpuTemp ? Math.round(b.cpuTemp.c) : null);
  push("down", down);
  push("up", up);
  lastCores = cpu.cores.length ? cpu.cores : lastCores;
}
let lastCores = [];

// History only accumulates while something is watching; the sampler it reads
// from is itself shut down after a minute of no requests.
function histEnsure() {
  if (histTimer) return;
  histTimer = setInterval(() => {
    if (Date.now() - pc.lastAsk > PC_IDLE_MS) { clearInterval(histTimer); histTimer = null; return; }
    pushHistory();
  }, HIST_MS);
  histTimer.unref();
}

function handlePcStats(req, res) {
  pc.lastAsk = Date.now();
  pcStart();
  histEnsure();

  const totalMem = os.totalmem(), freeMem = os.freemem();
  const base = {
    ok: true,
    ram: {
      usedMB: Math.round((totalMem - freeMem) / 1048576),
      totalMB: Math.round(totalMem / 1048576),
      pct: +(((totalMem - freeMem) / totalMem) * 100).toFixed(1),
    },
    cpu: { pct: null, name: (os.cpus()[0] || {}).model || "", cores: os.cpus().length, perCore: lastCores },
    uptime: os.uptime(),
    host: os.hostname(),
    history,
  };
  // The percentage comes off the history sampler so the number on screen and
  // the last point of the graph are the same reading, not two different ones.
  const lastCpu = history.cpu[history.cpu.length - 1];
  base.cpu.pct = lastCpu == null ? null : lastCpu;

  const a = pc.prev, b = pc.last;
  if (!b) {
    // First call: the sampler is up but has not produced two samples yet.
    return json(res, 200, Object.assign(base, { warming: true, error: pc.err }));
  }

  base.gpu = b.gpu || null;
  base.cpu.tempC = b.cpuTemp ? b.cpuTemp.c : null;
  base.cpu.tempSrc = b.cpuTemp ? b.cpuTemp.src : null;

  // --- Connections, grouped by owning process --------------------------------
  const nameOf = new Map();
  for (const p of b.procs || []) nameOf.set(p.p, p.n);
  const connBy = new Map();
  for (const c of b.conns || []) {
    const n = nameOf.get(c.p) || "pid " + c.p;
    let e = connBy.get(n);
    if (!e) { e = { name: n, conns: 0, remotes: new Set(), sample: c.r + ":" + c.o }; connBy.set(n, e); }
    e.conns++;
    e.remotes.add(c.r);
  }

  if (!a) return json(res, 200, Object.assign(base, { warming: true }));

  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return json(res, 200, Object.assign(base, { warming: true }));

  // --- Network throughput, summed across adapters ----------------------------
  const prevNet = new Map((a.net || []).map((n) => [n.n, n]));
  let rx = 0, tx = 0;
  for (const n of b.net || []) {
    const p = prevNet.get(n.n);
    if (!p) continue;
    // Counters reset when an adapter is reconnected; ignore a negative delta.
    if (n.rx >= p.rx) rx += (n.rx - p.rx) / dt;
    if (n.tx >= p.tx) tx += (n.tx - p.tx) / dt;
  }
  base.net = { downBps: Math.round(rx), upBps: Math.round(tx), adapters: (b.net || []).map((n) => n.n) };

  // --- Per-process I/O rate, totalled per program name -----------------------
  const prevIo = new Map((a.procs || []).map((p) => [p.p, p.io]));
  const ioBy = new Map();
  for (const p of b.procs || []) {
    const was = prevIo.get(p.p);
    if (was == null || p.io < was) continue;      // new pid, or a wrapped counter
    ioBy.set(p.n, (ioBy.get(p.n) || 0) + (p.io - was) / dt);
  }

  // --- Top talkers -----------------------------------------------------------
  // Every process holding a connection to another machine, busiest first. The
  // rate is that process's total I/O (Windows exposes no per-process *network*
  // byte counter), so it is labelled as I/O in the UI; the connection count and
  // remote endpoint next to it are network-specific and exact.
  const talkers = [...connBy.values()]
    .map((e) => ({
      name: e.name,
      conns: e.conns,
      hosts: e.remotes.size,
      sample: e.sample,
      ioBps: Math.round(ioBy.get(e.name) || 0),
    }))
    .sort((x, y) => y.ioBps - x.ioBps || y.conns - x.conns)
    .slice(0, 12);

  // Busiest processes overall, whether or not they hold a socket.
  const busiest = [...ioBy.entries()]
    .map((kv) => ({ name: kv[0], ioBps: Math.round(kv[1]) }))
    .filter((p) => p.ioBps > 0)
    .sort((x, y) => y.ioBps - x.ioBps)
    .slice(0, 8);

  base.talkers = talkers;
  base.busiest = busiest;
  base.connTotal = (b.conns || []).length;
  base.sampleAge = Date.now() - b.t;
  return json(res, 200, base);
}

// ============================================================================
//  System control  —  GET /api/system , POST /api/system
//
//  syscontrol.ps1 stays resident and speaks one JSON object per line: it pushes
//  a full state snapshot on a tick, and answers commands by id. Everything an
//  HTTP request needs is therefore already in memory, and a tap costs one pipe
//  write rather than a ~1s PowerShell start.
// ============================================================================
const SYSCTL_SCRIPT = path.join(ROOT, "syscontrol.ps1");
const SYS_IDLE_MS = 90 * 1000;

const sys = {
  proc: null, buf: "", state: null, at: 0,
  lastAsk: 0, err: null, seq: 0, pending: new Map(),
};

function sysStart() {
  if (sys.proc) return;
  if (process.platform !== "win32") { sys.err = "System control needs Windows."; return; }
  if (!fs.existsSync(SYSCTL_SCRIPT)) { sys.err = "syscontrol.ps1 is missing."; return; }

  sys.err = null;
  const child = spawn("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SYSCTL_SCRIPT,
    "-IntervalMs", "1000", "-ParentPid", String(process.pid),
  ], { cwd: ROOT, windowsHide: true });
  sys.proc = child;

  child.stdout.on("data", (d) => {
    sys.buf += d.toString();
    let i;
    while ((i = sys.buf.indexOf("\n")) >= 0) {
      const line = sys.buf.slice(0, i).trim();
      sys.buf = sys.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.push === "state") { sys.state = m.data; sys.at = Date.now(); continue; }
      const waiter = sys.pending.get(m.id);
      if (waiter) { sys.pending.delete(m.id); waiter(m); }
    }
    if (sys.buf.length > 4e6) sys.buf = "";
  });
  child.stderr.on("data", (d) => { sys.err = String(d).slice(0, 300).trim() || sys.err; });
  child.on("error", (e) => { sys.err = e.message; sys.proc = null; });
  child.on("exit", () => {
    sys.proc = null; sys.buf = "";
    for (const [, w] of sys.pending) w({ ok: false, error: "helper exited" });
    sys.pending.clear();
    if (Date.now() - sys.lastAsk < SYS_IDLE_MS) setTimeout(sysStart, 2000);
  });
}

function sysStop() {
  if (!sys.proc) return;
  sys.proc.kill();
  sys.proc = null; sys.buf = ""; sys.state = null;
}
setInterval(() => {
  if (sys.proc && Date.now() - sys.lastAsk > SYS_IDLE_MS) sysStop();
}, 20000).unref();

function sysSend(cmd, args, timeoutMs) {
  sys.lastAsk = Date.now();
  sysStart();
  return new Promise((resolve) => {
    if (!sys.proc) return resolve({ ok: false, error: sys.err || "helper not running" });
    const id = ++sys.seq;
    const timer = setTimeout(() => {
      sys.pending.delete(id);
      resolve({ ok: false, error: "timed out" });
    }, timeoutMs || 6000);
    sys.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try { sys.proc.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + "\n"); }
    catch (e) { clearTimeout(timer); sys.pending.delete(id); resolve({ ok: false, error: e.message }); }
  });
}

function handleSystemGet(req, res) {
  sys.lastAsk = Date.now();
  sysStart();
  if (!sys.state) return json(res, 200, { ok: true, warming: true, error: sys.err });
  return json(res, 200, { ok: true, age: Date.now() - sys.at, ...sys.state });
}

function handleSystemPost(req, res) {
  readJsonBody(req, res, async (body) => {
    if (!body || !body.cmd) return json(res, 400, { ok: false, error: "cmd required" });
    const m = await sysSend(String(body.cmd), body.args || {});
    return json(res, m.ok ? 200 : 500, m.ok ? { ok: true, data: m.data } : { ok: false, error: m.error });
  });
}

function readJsonBody(req, res, cb) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on("end", () => {
    try { cb(JSON.parse(body || "{}")); }
    catch (e) { json(res, 400, { ok: false, error: "bad JSON" }); }
  });
}

// ============================================================================
//  Lyrics  —  GET /api/lyrics?artist=&title=&album=&duration=
//
//  LRCLIB is free and key-less and returns LRC-timestamped lines. Proxied here
//  rather than fetched from the page so results can be cached across widget
//  reloads and track repeats, and so one lookup serves every surface.
// ============================================================================
const lyricsCache = new Map();          // key -> { at, data }
const LYRICS_TTL = 6 * 60 * 60 * 1000;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "Y70Dashboard/1.0 (local dashboard)" },
      timeout: 8000,
    }, (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => {
        if (r.statusCode === 404) return resolve(null);
        if (r.statusCode !== 200) return reject(new Error("HTTP " + r.statusCode));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
}

async function handleLyrics(req, res, query) {
  const artist = (query.get("artist") || "").trim();
  const title = (query.get("title") || "").trim();
  const album = (query.get("album") || "").trim();
  const duration = Math.round(Number(query.get("duration") || 0) / 1000);
  if (!artist || !title) return json(res, 400, { ok: false, error: "artist and title required" });

  const key = (artist + "|" + title + "|" + album).toLowerCase();
  const hit = lyricsCache.get(key);
  if (hit && Date.now() - hit.at < LYRICS_TTL) return json(res, 200, { ok: true, cached: true, ...hit.data });

  const q = (o) => Object.entries(o).filter(([, v]) => v)
    .map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");

  try {
    // Exact match first (it can use duration to pick the right release), then a
    // looser search, so a slightly different album title still finds lyrics.
    let d = await getJson("https://lrclib.net/api/get?" +
      q({ artist_name: artist, track_name: title, album_name: album, duration: duration || "" }));
    if (!d) {
      const list = await getJson("https://lrclib.net/api/search?" + q({ artist_name: artist, track_name: title }));
      if (Array.isArray(list) && list.length) {
        // Prefer a synced result whose length is closest to what is playing.
        const scored = list.map((x) => ({
          x, synced: !!x.syncedLyrics,
          gap: duration ? Math.abs((x.duration || 0) - duration) : 0,
        })).sort((a, b) => (b.synced - a.synced) || (a.gap - b.gap));
        d = scored[0].x;
      }
    }
    const data = d ? {
      found: true,
      instrumental: !!d.instrumental,
      synced: parseLrc(d.syncedLyrics),
      plain: d.plainLyrics || "",
      source: { artist: d.artistName, title: d.trackName, duration: d.duration },
    } : { found: false };
    lyricsCache.set(key, { at: Date.now(), data });
    if (lyricsCache.size > 300) lyricsCache.delete(lyricsCache.keys().next().value);
    return json(res, 200, { ok: true, ...data });
  } catch (e) {
    return json(res, 200, { ok: false, error: e.message });
  }
}

// "[01:23.45] words" -> [{ t: 83450, text: "words" }], sorted.
function parseLrc(lrc) {
  if (!lrc) return [];
  const out = [];
  for (const line of String(lrc).split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ============================================================================
//  Notes  —  GET /api/notes , POST /api/notes
//
//  Kept as a plain file rather than in the browser so it survives clearing site
//  data, and so the same text can be opened in an editor.
// ============================================================================
const NOTES_FILE = stateFile("notes.txt");

function handleNotes(req, res) {
  if (req.method === "GET") {
    fs.readFile(NOTES_FILE, "utf8", (err, text) => {
      json(res, 200, { ok: true, text: err ? "" : text });
    });
    return;
  }
  readJsonBody(req, res, (body) => {
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > 500000) return json(res, 413, { ok: false, error: "too long" });
    fs.writeFile(NOTES_FILE, text, "utf8", (err) => {
      if (err) return json(res, 500, { ok: false, error: err.message });
      json(res, 200, { ok: true, saved: text.length });
    });
  });
}

// ============================================================================
//  Discord  —  GET /api/discord , POST /api/discord
//  All the protocol lives in discord.js; this is just the HTTP surface.
// ============================================================================
function handleDiscord(req, res) {
  if (req.method === "GET") return json(res, 200, discord.status());
  readJsonBody(req, res, async (body) => {
    const r = await discord.action(String(body.action || ""), body.args || {});
    return json(res, r.ok ? 200 : 400, Object.assign({}, r, { status: discord.status() }));
  });
}

// ============================================================================
//  iPhone  —  GET /api/phone , POST /api/phone
//
//  ancs/bin/out/y70-ancs.exe holds the Bluetooth LE connection and streams JSON
//  lines. It is a compiled C# helper rather than PowerShell like the others,
//  because Windows PowerShell cannot subscribe to WinRT events at all and ANCS
//  is entirely event-driven.
// ============================================================================
const ANCS_EXE = path.join(ROOT, "ancs", "bin", "out", "y70-ancs.exe");
const PHONE_IDLE_MS = 5 * 60 * 1000;      // it is ambient; keep it up a while
const PHONE_MAX_NOTIFS = 60;

const phone = {
  proc: null, buf: "", lastAsk: 0, err: null,
  device: null, connected: false, battery: null, batteryAt: 0,
  notifications: [],                       // newest first
  call: null,                              // the live incoming/active call
  seq: 0,
};

function phoneStart() {
  if (phone.proc) return;
  if (process.platform !== "win32") { phone.err = "Windows only."; return; }
  // A second copy of the dashboard (a test server beside the installed app)
  // must not open a second Bluetooth link to the same iPhone.
  if (process.env.Y70_NO_PHONE) { phone.err = "The iPhone bridge is off in this copy (Y70_NO_PHONE)."; return; }
  if (!fs.existsSync(ANCS_EXE)) {
    phone.err = "The iPhone bridge is not built yet (ancs/bin/out/y70-ancs.exe).";
    return;
  }
  phone.err = null;
  const child = spawn(ANCS_EXE, ["--parent=" + process.pid], { cwd: ROOT, windowsHide: true });
  phone.proc = child;

  child.stdout.on("data", (d) => {
    phone.buf += d.toString();
    let i;
    while ((i = phone.buf.indexOf("\n")) >= 0) {
      const line = phone.buf.slice(0, i).trim();
      phone.buf = phone.buf.slice(i + 1);
      if (!line) continue;
      try { onPhoneMessage(JSON.parse(line)); } catch (e) { /* partial or noise */ }
    }
    if (phone.buf.length > 1e6) phone.buf = "";
  });
  child.stderr.on("data", (d) => { phone.err = String(d).slice(0, 300).trim() || phone.err; });
  child.on("error", (e) => { phone.err = e.message; phone.proc = null; });
  child.on("exit", () => {
    phone.proc = null; phone.buf = ""; phone.connected = false;
    // The phone wanders in and out of range all day; keep trying while anyone
    // is watching, but not so fast that it thrashes.
    if (Date.now() - phone.lastAsk < PHONE_IDLE_MS) setTimeout(phoneStart, 8000);
  });
}

function phoneStop() {
  if (!phone.proc) return;
  phone.proc.kill();
  phone.proc = null;
  phone.buf = "";
  phone.connected = false;
}
setInterval(() => {
  if (phone.proc && Date.now() - phone.lastAsk > PHONE_IDLE_MS) phoneStop();
}, 30000).unref();

function onPhoneMessage(m) {
  switch (m.type) {
    case "ready":
      phone.device = m.device;
      phone.connected = m.connection === "Connected";
      phone.err = null;
      break;
    case "subscribed": phone.connected = true; break;
    case "disconnected": phone.connected = false; break;
    case "battery":
      phone.battery = m.level;
      phone.batteryAt = Date.now();
      break;
    case "error": phone.err = m.error; break;
    case "notif": onPhoneNotification(m); break;
    default: break;
  }
}

function onPhoneNotification(m) {
  if (m.event === "removed") {
    phone.notifications = phone.notifications.filter((n) => n.uid !== m.uid);
    // A call notification disappearing is how iOS says the call is over —
    // whether it was answered elsewhere, declined, or simply stopped ringing.
    if (phone.call && phone.call.uid === m.uid && !phone.call.accepted) phone.call = null;
    else if (phone.call && phone.call.uid === m.uid) phone.call.ended = true;
    return;
  }

  const n = {
    uid: m.uid,
    at: Date.now(),
    seq: ++phone.seq,
    category: m.category,
    categoryId: m.categoryId,
    app: m.app || "",
    appName: m.appName || "",
    title: m.title || "",
    subtitle: m.subtitle || "",
    message: m.message || "",
    silent: !!m.silent,
    important: !!m.important,
    preExisting: !!m.preExisting,
    canAccept: !!m.positive,
    canDecline: !!m.negative,
  };

  const existing = phone.notifications.findIndex((x) => x.uid === n.uid);
  if (existing >= 0) phone.notifications[existing] = { ...phone.notifications[existing], ...n };
  else phone.notifications.unshift(n);
  if (phone.notifications.length > PHONE_MAX_NOTIFS) phone.notifications.length = PHONE_MAX_NOTIFS;

  if (n.category === "IncomingCall") {
    phone.call = {
      uid: n.uid, from: n.title || n.message || "Unknown",
      detail: n.subtitle || n.message || "",
      startedAt: Date.now(), accepted: false, ended: false,
      canAccept: n.canAccept, canDecline: n.canDecline,
    };
  }
}

function phoneSend(obj) {
  if (!phone.proc) return false;
  try { phone.proc.stdin.write(JSON.stringify(obj) + "\n"); return true; }
  catch (e) { return false; }
}

function handlePhoneGet(req, res) {
  phone.lastAsk = Date.now();
  phoneStart();
  return json(res, 200, {
    ok: true,
    running: !!phone.proc,
    connected: phone.connected,
    device: phone.device,
    battery: phone.battery,
    batteryAge: phone.battery == null ? null : Date.now() - phone.batteryAt,
    notifications: phone.notifications,
    call: phone.call,
    error: phone.err,
  });
}

function handlePhonePost(req, res) {
  phone.lastAsk = Date.now();
  readJsonBody(req, res, (body) => {
    const action = String(body.action || "");
    const uid = Number(body.uid);

    if (action === "accept" || action === "decline") {
      if (!phoneSend({ cmd: "action", uid, action: action === "accept" ? "positive" : "negative" })) {
        return json(res, 503, { ok: false, error: "the bridge is not running" });
      }
      if (phone.call && phone.call.uid === uid) {
        if (action === "accept") { phone.call.accepted = true; phone.call.answeredAt = Date.now(); }
        else phone.call = null;
      }
      return json(res, 200, { ok: true, call: phone.call });
    }
    // Hanging up: iOS removes the incoming-call notification the moment it is
    // answered, so the uid may no longer exist. Ask anyway, then let go of it
    // locally either way so the panel does not keep showing a dead call.
    if (action === "hangup") {
      phoneSend({ cmd: "action", uid, action: "negative" });
      phone.call = null;
      return json(res, 200, { ok: true, note: "asked to end; iOS may have already dropped the notification" });
    }
    if (action === "dismiss") {
      phone.notifications = phone.notifications.filter((n) => n.uid !== uid);
      return json(res, 200, { ok: true });
    }
    if (action === "clear") { phone.notifications = []; return json(res, 200, { ok: true }); }
    if (action === "restart") { phoneStop(); phoneStart(); return json(res, 200, { ok: true }); }
    return json(res, 400, { ok: false, error: "unknown action" });
  });
}

// ---- Server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (req.method === "POST" && urlPath === "/api/claude") return handleClaude(req, res);
  if (req.method === "GET" && urlPath === "/api/claude-stats") return handleClaudeStats(req, res);
  if (req.method === "GET" && urlPath === "/api/pcstats") return handlePcStats(req, res);
  if (urlPath === "/api/phone" && req.method === "GET") return handlePhoneGet(req, res);
  if (urlPath === "/api/phone" && req.method === "POST") return handlePhonePost(req, res);
  if (urlPath === "/api/discord" && (req.method === "GET" || req.method === "POST")) return handleDiscord(req, res);
  if (urlPath === "/api/notes" && (req.method === "GET" || req.method === "POST")) return handleNotes(req, res);
  if (req.method === "GET" && urlPath === "/api/system") return handleSystemGet(req, res);
  if (req.method === "POST" && urlPath === "/api/system") return handleSystemPost(req, res);
  if (req.method === "GET" && urlPath === "/api/lyrics") {
    return handleLyrics(req, res, new URL(req.url, "http://localhost").searchParams);
  }
  if (urlPath.startsWith("/api/jarvis/")) return assistant.handle(req, res, urlPath);

  // The shell (app frame) is the front door; the OAuth redirect lands on the
  // Spotify app directly so it can finish the login at top level.
  if (urlPath === "/") urlPath = "/shell.html";
  if (urlPath === "/callback") urlPath = "/index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  // Never serve secrets or local stores as static content. discord-app.json
  // holds a client SECRET and discord-token.json an access token. Matched by
  // name, not by path, so a stale copy left beside the code stays unreachable
  // too now that the live ones have moved to the data folder.
  if (STATE_FILES.includes(path.basename(filePath))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  // Screenshots Jarvis took (the data folder's captures/, which is beside the
  // code when run from source) are served only through /api/jarvis/capture.
  if (/[\\/]captures[\\/]/i.test(filePath) || /[\\/]downloads[\\/]/i.test(filePath)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found: " + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    // Everything here is on the loopback interface, so caching buys nothing —
    // and with no headers at all Chromium caches heuristically, which is how
    // an updated stylesheet can keep rendering the old one after a restart.
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("\n  Port " + PORT + " is already in use.");
    console.error("  It may already be running — try http://" + HOST + ":" + PORT);
    console.error("  Or stop the other process and run again.\n");
    process.exit(1);
  }
  throw err;
});

discord.init(DATA);
assistant.init({
  ROOT, DATA, PORT, stateFile, json, readJsonBody, readClaudeKey, writeClaudeKey,
  sysSend, sysState: () => { sys.lastAsk = Date.now(); sysStart(); return sys.state; },
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Y70 Dashboard is running.");
  console.log("  ->  http://" + HOST + ":" + PORT);
  console.log("");
  console.log("  Claude widget: " + (readClaudeKey() ? "API key found." : "no key yet — paste one into " + CLAUDE_KEY_FILE));
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
