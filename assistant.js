// ============================================================================
//  Jarvis — the assistant's server side.
//
//    /api/jarvis/events     SSE: wake word, live transcript, game state, status
//    /api/jarvis/turn       one exchange, streamed back as NDJSON
//    /api/jarvis/listen     start hearing a request (cancel to stop)
//    /api/jarvis/tts        text -> WAV in the chosen Windows voice
//    /api/jarvis/settings   GET / POST the settings
//    /api/jarvis/key        POST an Anthropic API key (never read back)
//    /api/jarvis/memory     GET / POST remembered facts
//    /api/jarvis/history    recent exchanges
//    /api/jarvis/local      local model: status, start, stop, edit
//
//  Two brains, one loop. Claude goes through the Anthropic SDK; the local model
//  is llama-server in router mode (jarvis-llm.bat), spoken to through its
//  OpenAI-compatible endpoint. Conversations are stored in Claude's content
//  block shape and translated for the local model, so a conversation can move
//  between them.
//
//  Tools run where their effect is. Search, weather, volume, Discord, notes and
//  memory run here. Music, timers, alarms, opening apps and putting things on
//  screen run in the panel: the stream stops with a "client" event, the panel
//  does the work and posts the results back, and the loop carries on.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const web = require("./assistant-web");
const models = require("./assistant-models");
const govee = require("./govee");
const discord = require("./discord");

let Anthropic = null;
try { Anthropic = require("@anthropic-ai/sdk"); Anthropic = Anthropic.default || Anthropic; }
catch (e) { /* reported as a status; Jarvis still works on the local model */ }

let H = null;          // what server.js hands over: paths, helpers, the key
let settings = null;

// ---------------------------------------------------------------- settings --
const DEFAULTS = {
  provider: "auto",                 // claude | local | auto (local when it is up)
  claudeModel: "claude-haiku-4-5",
  localUrl: "http://127.0.0.1:8081",
  localModel: "jarvis-9b",          // any [section] of jarvis-models.ini
  autoGameModel: true,              // use the 4B while a game is in front
  localBat: "",                     // jarvis-llm.bat, so the panel can start it
  wake: true,
  wakePhrase: "jarvis",
  sensitivity: 0.5,
  onlineSpeech: true,               // (older setting; stt replaces it)
  stt: "",                          // whisper | online | offline; "" = from onlineSpeech
  whisperDir: "",                   // whisper.cpp: Release\whisper-server.exe + a ggml model
  whisperGpu: true,
  stopWords: true,                  // "stop" / "Jarvis..." cut him off while he talks
  bargeIn: false,                   // just talking over him interrupts (headphones)
  speak: true,
  tts: "",                          // kokoro | windows; "" = Kokoro when installed
  kokoroDir: "",                    // kokoro-v1.0.onnx + voices-v1.0.bin
  kokoroVoice: "bm_george",
  voice: "Microsoft Mark",          // the Windows voice (fallback)
  rate: 1.05,
  name: "",
  addressAs: "",
  about: "",
  home: null,                       // { name, lat, lon }
  graphFile: "",                    // the MCP memory server's knowledge graph (JSONL)
  useGraph: true,
  memoryUrl: "http://127.0.0.1:8001/mcp",   // that server (memory-server.bat)
};
const CLAUDE_MODELS = ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"];

function settingsFile() { return H.stateFile("jarvis.json"); }

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; }
  catch (e) { settings = { ...DEFAULTS }; }
}

function saveSettings(patch) {
  const next = { ...settings };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    next[k] = v;
  }
  if (!["claude", "local", "auto"].includes(next.provider)) next.provider = DEFAULTS.provider;
  if (!CLAUDE_MODELS.includes(next.claudeModel)) next.claudeModel = DEFAULTS.claudeModel;
  if (!/^[\w.\-]{1,64}$/.test(String(next.localModel || ""))) next.localModel = DEFAULTS.localModel;
  next.sensitivity = Math.max(0, Math.min(1, Number(next.sensitivity) || 0.5));
  next.rate = Math.max(0.6, Math.min(2, Number(next.rate) || 1));
  next.wakePhrase = String(next.wakePhrase || "jarvis").trim().toLowerCase().slice(0, 30) || "jarvis";
  for (const k of ["name", "addressAs", "voice", "localBat", "graphFile", "localUrl", "memoryUrl", "whisperDir", "kokoroDir"]) next[k] = String(next[k] || "").slice(0, 400);
  if (!["", "kokoro", "windows"].includes(next.tts)) next.tts = "";
  if (!/^[a-z]{2}_[a-z]+$/.test(String(next.kokoroVoice || ""))) next.kokoroVoice = DEFAULTS.kokoroVoice;
  if (!["", "whisper", "online", "offline"].includes(next.stt)) next.stt = "";
  next.about = String(next.about || "").slice(0, 4000);
  const prev = settings;
  settings = next;
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { return e.message; }
  // Whisper restarts to pick up GPU/CPU or a new folder, and stops (freeing
  // its VRAM) when another recognizer is chosen.
  if (prev && (prev.whisperGpu !== next.whisperGpu || prev.whisperDir !== next.whisperDir || sttEngine() !== "whisper")) whisperStop();
  if (prev && (prev.kokoroDir !== next.kokoroDir || ttsEngine() !== "kokoro")) { kokoroStop(); if (prev.kokoroDir !== next.kokoroDir) kokoro.err = null; }
  if (ttsEngine() === "kokoro") kokoroStart();
  applyVoiceSettings();
  return null;
}

// ------------------------------------------------------------------- events --
// The panel holds one EventSource open; everything that happens without being
// asked (the wake word, a game starting) arrives this way.
const listeners = new Set();
function broadcast(ev) {
  const line = "data: " + JSON.stringify(ev) + "\n\n";
  for (const res of listeners) { try { res.write(line); } catch (e) {} }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  listeners.add(res);
  res.write("data: " + JSON.stringify({ type: "hello", status: status() }) + "\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
  req.on("close", () => { clearInterval(ping); listeners.delete(res); });
  voiceStart();
}

// -------------------------------------------------------------------- voice --
// y70-voice.exe: the wake word, hearing a request, the voices. See voice/.
const voice = {
  proc: null, buf: "", err: null, ready: false,
  voices: [], offline: false,
  onlineBlocked: false,            // Windows refused online speech (privacy switch)
  listening: false, engine: null,
  seq: 0, ttsWaiters: new Map(),
};
const game = { on: false, exe: null };

function voiceExe() {
  return path.join(H.ROOT, "voice", "bin", "out", "y70-voice.exe");
}

function voiceSend(obj) {
  if (!voice.proc) return false;
  try { voice.proc.stdin.write(JSON.stringify(obj) + "\n"); return true; } catch (e) { return false; }
}

function voiceStart() {
  if (voice.proc) return true;
  if (process.platform !== "win32") { voice.err = "Windows only."; return false; }
  if (!fs.existsSync(voiceExe())) { voice.err = "The voice helper is not built (voice/bin/out/y70-voice.exe)."; return false; }
  voice.err = null;
  const child = spawn(voiceExe(), ["--parent=" + process.pid], { cwd: H.ROOT, windowsHide: true });
  voice.proc = child;
  child.stdout.on("data", (d) => {
    voice.buf += d.toString();
    let i;
    while ((i = voice.buf.indexOf("\n")) >= 0) {
      const line = voice.buf.slice(0, i).trim();
      voice.buf = voice.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      onVoice(m);
    }
    if (voice.buf.length > 8e6) voice.buf = "";
  });
  child.stderr.on("data", (d) => { voice.err = String(d).slice(0, 300).trim() || voice.err; });
  child.on("error", (e) => { voice.err = e.message; voice.proc = null; });
  child.on("exit", () => {
    voice.proc = null; voice.ready = false; voice.listening = false; voice.buf = "";
    for (const [, w] of voice.ttsWaiters) w({ error: "voice helper exited" });
    voice.ttsWaiters.clear();
    broadcast({ type: "status", status: status() });
    // It is meant to be resident while the wake word is on; come back.
    if (settings.wake && listeners.size) setTimeout(voiceStart, 3000);
  });
  return true;
}

// Which recognizer hears a request. Whisper when it is installed and chosen;
// otherwise Windows online (falls back to offline itself) or offline.
function sttEngine() {
  const want = settings.stt || (settings.onlineSpeech ? "online" : "offline");
  if (want === "whisper" && !whisperPaths()) return settings.onlineSpeech ? "online" : "offline";
  return want;
}

function applyVoiceSettings() {
  if (!voice.proc || !voice.ready) return;
  voiceSend({
    cmd: "wake", on: !!settings.wake, phrase: settings.wakePhrase, sensitivity: settings.sensitivity,
    stopWords: settings.stopWords !== false, bargeIn: !!settings.bargeIn, audio: sttEngine() === "whisper",
  });
  voiceSend({ cmd: "game", on: !!settings.autoGameModel });
  if (sttEngine() === "whisper") whisperStart();
}

// ------------------------------------------------------------------ whisper --
//  whisper.cpp's server, resident on 8082 with the model loaded, so a request
//  is transcribed in well under a second (measured 65-80 ms on the 4080 for a
//  sentence, about 0.4 s on the first after loading). SAPI still does the
//  listening: it hears the wake word, knows when you have stopped talking and
//  shows the words as you go; the audio it heard then goes to Whisper for the
//  words themselves ("place on low Fi beads on spot if I" became "play some
//  lo-fi beats on Spotify").
const WHISPER_PORT = 8082;
const whisper = { proc: null, ready: false, starting: null, err: null };

function whisperPaths() {
  const dir = settings.whisperDir;
  if (!dir) return null;
  const exe = [path.join(dir, "Release", "whisper-server.exe"), path.join(dir, "whisper-server.exe")].find((p) => fs.existsSync(p));
  if (!exe) return null;
  let models = [];
  try { models = fs.readdirSync(dir).filter((f) => /^ggml-.*\.bin$/i.test(f)); } catch (e) {}
  // The best model present: large-v3-turbo, then medium, small, base.
  const order = ["large-v3-turbo", "large", "medium", "small", "base", "tiny"];
  models.sort((a, b) => order.findIndex((o) => a.includes(o)) - order.findIndex((o) => b.includes(o)));
  if (!models.length) return null;
  return { exe, model: path.join(dir, models[0]), name: models[0] };
}

async function whisperProbe() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch("http://127.0.0.1:" + WHISPER_PORT + "/", { signal: ctl.signal });
    clearTimeout(t);
    return r.status > 0;
  } catch (e) { return false; }
}

function whisperStart() {
  if (whisper.ready) return Promise.resolve(true);
  if (whisper.starting) return whisper.starting;
  whisper.starting = (async () => {
    // Already up (left over from a restart): use it.
    if (await whisperProbe()) { whisper.ready = true; return true; }
    const p = whisperPaths();
    if (!p) { whisper.err = "whisper.cpp is not installed"; return false; }
    // Names it should expect, so it spells them the way you do.
    const prompt = [settings.name, "Jarvis", "Spotify", "Discord", "Govee", "Qwen", "Hugging Face", "lo-fi"].filter(Boolean).join(", ") + ".";
    const args = ["-m", p.model, "--host", "127.0.0.1", "--port", String(WHISPER_PORT), "-t", "8", "-l", "en", "--prompt", prompt];
    if (!settings.whisperGpu) args.push("-ng");
    const child = spawn(p.exe, args, { cwd: path.dirname(p.exe), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    whisper.proc = child;
    child.stderr.on("data", (d) => { const s = String(d); if (/error|fail/i.test(s)) whisper.err = s.slice(0, 200).trim(); });
    child.on("exit", () => { whisper.proc = null; whisper.ready = false; });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await whisperProbe()) { whisper.ready = true; whisper.err = null; return true; }
      if (!whisper.proc) break;
    }
    whisper.err = whisper.err || "whisper-server did not start";
    return false;
  })().finally(() => { whisper.starting = null; broadcast({ type: "status", status: status() }); });
  return whisper.starting;
}

function whisperStop() {
  if (whisper.proc) { try { whisper.proc.kill(); } catch (e) {} }
  whisper.proc = null;
  whisper.ready = false;
}

// What Whisper says on near-silence instead of nothing.
const PHANTOM = /^(\[?blank_audio\]?|\(.*\)|\[.*\]|thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+)$/i;

async function transcribe(b64) {
  if (!b64) return null;
  if (!(await whisperStart())) return null;
  try {
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from(b64, "base64")], { type: "audio/wav" }), "speech.wav");
    fd.append("temperature", "0");
    fd.append("response_format", "json");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch("http://127.0.0.1:" + WHISPER_PORT + "/inference", { method: "POST", body: fd, signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const text = String(j.text || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    return PHANTOM.test(text) ? "" : text;
  } catch (e) {
    whisper.ready = false;
    return null;
  }
}

// The wake phrase off the front of what was said in one breath.
function stripWake(text) {
  const ph = settings.wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "").replace(new RegExp("^\\s*(?:(?:hey|okay|ok)[\\s,]+)?" + ph + "[\\s,.!?:;-]*", "i"), "").trim();
}

function onVoice(m) {
  switch (m.type) {
    case "ready":
      voice.ready = true;
      voice.offline = !!m.offline;
      voice.voices = Array.isArray(m.voices) ? m.voices : [];
      applyVoiceSettings();
      broadcast({ type: "status", status: status() });
      return;
    case "tts": {
      const w = voice.ttsWaiters.get(m.id);
      if (w) { voice.ttsWaiters.delete(m.id); w(m); }
      return;
    }
    case "listening":
      voice.listening = true; voice.engine = m.engine;
      break;
    case "final":
      voice.listening = false;
      if (m.engine === "online") voice.onlineBlocked = false;
      // Whisper's words replace SAPI's, a beat later. SAPI's stand if Whisper
      // is unavailable.
      if (m.audio) {
        const audio = m.audio;
        delete m.audio;
        broadcast({ type: "transcribing" });
        return void transcribeFinal(m, audio);
      }
      break;
    case "wake":
      if (m.audio) {
        const audio = m.audio;
        delete m.audio;
        return void transcribeWake(m, audio);
      }
      break;
    case "online-unavailable":
      voice.onlineBlocked = true;
      break;
    case "game":
      game.on = !!m.on; game.exe = m.exe || null;
      onGameChange();
      break;
    case "error":
      voice.err = m.error;
      break;
    default: break;
  }
  broadcast(m);
}

async function transcribeFinal(m, audio) {
  const t = await transcribe(audio);
  if (t !== null) { m.sapi = m.text; m.text = t; m.engine = "whisper"; }
  else m.engine = "offline";
  broadcast(m);
}

// "Jarvis, set a timer" in one breath: Whisper re-hears the whole utterance and
// the name comes off the front. If Whisper only hears the name, the panel
// listens for the rest as usual.
async function transcribeWake(m, audio) {
  const t = await transcribe(audio);
  if (t) { m.sapiTail = m.tail; m.tail = stripWake(t); m.whisper = true; }
  broadcast(m);
}

// ------------------------------------------------------------------- kokoro --
//  Jarvis's real voice: Kokoro-82M (tts-kokoro.py, kokoro-onnx), resident so
//  the model stays loaded. On the CPU, so it takes no VRAM from games or the
//  local models: about 0.5 s for a sentence (measured), and the panel asks
//  for the next sentence while the current one plays. The Windows voices are
//  the fallback whenever it is missing or fails.
const kokoro = { proc: null, buf: "", ready: false, starting: null, voices: [], err: null, seq: 0, waiters: new Map() };

function kokoroPaths() {
  const dir = settings.kokoroDir;
  if (!dir) return null;
  const model = ["kokoro-v1.0.onnx", "kokoro-v1.0.fp16.onnx", "kokoro-v1.0.int8.onnx"].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));
  const voices = path.join(dir, "voices-v1.0.bin");
  if (!model || !fs.existsSync(voices)) return null;
  return { model, voices };
}

function ttsEngine() {
  if (settings.tts === "windows") return "windows";
  return kokoroPaths() && kokoro.err !== "unavailable" ? "kokoro" : "windows";
}

function kokoroStart() {
  if (kokoro.ready) return Promise.resolve(true);
  if (kokoro.starting) return kokoro.starting;
  const p = kokoroPaths();
  if (!p) return Promise.resolve(false);
  kokoro.starting = new Promise((resolve) => {
    const child = spawn("python", [path.join(H.ROOT, "tts-kokoro.py"), p.model, p.voices], { cwd: H.ROOT, windowsHide: true });
    kokoro.proc = child;
    const timer = setTimeout(() => { kokoro.err = "Kokoro took too long to start"; resolve(false); }, 30000);
    child.stdout.on("data", (d) => {
      kokoro.buf += d.toString();
      let i;
      while ((i = kokoro.buf.indexOf("\n")) >= 0) {
        const line = kokoro.buf.slice(0, i).trim();
        kokoro.buf = kokoro.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.type === "ready") {
          kokoro.ready = true; kokoro.err = null; kokoro.voices = m.voices || [];
          clearTimeout(timer); resolve(true);
          broadcast({ type: "status", status: status() });
        } else if (m.type === "error") {
          // Python or kokoro-onnx missing: stop trying for this session.
          kokoro.err = /ModuleNotFoundError|No module/.test(m.error) ? "unavailable" : m.error;
          clearTimeout(timer); resolve(false);
        } else if (m.type === "tts") {
          const w = kokoro.waiters.get(m.id);
          if (w) { kokoro.waiters.delete(m.id); w(m); }
        }
      }
      if (kokoro.buf.length > 8e6) kokoro.buf = "";
    });
    child.stderr.on("data", () => {});
    child.on("error", (e) => { kokoro.err = /ENOENT/.test(e.code || "") ? "unavailable" : e.message; clearTimeout(timer); resolve(false); });
    child.on("exit", () => {
      kokoro.proc = null; kokoro.ready = false; kokoro.buf = "";
      for (const [, w] of kokoro.waiters) w({ error: "kokoro exited" });
      kokoro.waiters.clear();
    });
  }).finally(() => { kokoro.starting = null; });
  return kokoro.starting;
}

function kokoroStop() {
  if (kokoro.proc) { try { kokoro.proc.kill(); } catch (e) {} }
  kokoro.proc = null; kokoro.ready = false;
}

async function kokoroSpeak(text) {
  if (!(await kokoroStart())) return { error: kokoro.err || "kokoro not available" };
  return new Promise((resolve) => {
    const id = ++kokoro.seq;
    const timer = setTimeout(() => { kokoro.waiters.delete(id); resolve({ error: "timed out" }); }, 20000);
    kokoro.waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try {
      // Python reads a pipe as cp1252 on Windows, so nothing but ASCII goes
      // down it: a curly ’ arrived as "â€™" and Kokoro said "euro trademark".
      const line = JSON.stringify({ id, text: String(text).slice(0, 2000), voice: settings.kokoroVoice, speed: settings.rate })
        .replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
      kokoro.proc.stdin.write(line + "\n");
    } catch (e) { kokoro.waiters.delete(id); clearTimeout(timer); resolve({ error: e.message }); }
  });
}

// Typographic punctuation, plain: both engines say ' and " best.
function speechText(t) {
  return String(t || "")
    .replace(/[‘’ʼ′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/…/g, "...").replace(/\s*[–—]\s*/g, ", ").replace(/ /g, " ");
}

// Kokoro when it is the engine and it works; a Windows voice otherwise.
async function speak(text) {
  text = speechText(text);
  if (ttsEngine() === "kokoro") {
    const r = await kokoroSpeak(text);
    if (r && r.data) return r;
  }
  return speakWindows(text);
}

function speakWindows(text) {
  return new Promise((resolve) => {
    if (!voiceStart()) return resolve({ error: voice.err || "no voice helper" });
    const id = ++voice.seq;
    const timer = setTimeout(() => { voice.ttsWaiters.delete(id); resolve({ error: "timed out" }); }, 15000);
    voice.ttsWaiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    const send = () => voiceSend({ cmd: "speak", id, text: String(text).slice(0, 2000), voice: settings.voice, rate: settings.rate });
    if (voice.ready) send();
    else {
      // First use: the helper is still starting. Give it a moment.
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (voice.ready) { clearInterval(iv); send(); }
        else if (Date.now() - t0 > 8000) { clearInterval(iv); }
      }, 100);
    }
  });
}

// ------------------------------------------------------------------ status --
function status() {
  return {
    sdk: !!Anthropic,
    hasKey: !!H.readClaudeKey(),
    voice: {
      running: !!voice.proc, ready: voice.ready, error: voice.err,
      offline: voice.offline, onlineBlocked: voice.onlineBlocked,
      listening: voice.listening, voices: voice.voices,
      stt: sttEngine(),
    },
    whisper: (() => {
      const p = whisperPaths();
      return { installed: !!p, model: p ? p.name : null, running: whisper.ready, error: whisper.err };
    })(),
    tts: {
      engine: ttsEngine(), installed: !!kokoroPaths(), running: kokoro.ready,
      voices: kokoro.voices, error: kokoro.err,
    },
    game,
    local: {
      up: local.up, checkedAt: local.checkedAt, model: localModelNow(), loaded: local.loaded,
      models: localModels(), needsRestart: local.needsRestart,
    },
    memory: { mode: graphMode() ? "graph" : "local", server: memoryServer.up },
    downloads: models.list(),
    lights: govee.status(),
  };
}

// -------------------------------------------------------------- local model --
//  jarvis-llm.bat runs llama-server in router mode with every model in
//  jarvis-models.ini (the 27B, the 9B, the 4B, and whatever Jarvis downloads).
const local = { up: false, checkedAt: 0, loaded: null, served: [], needsRestart: false };

async function localProbe(force) {
  if (!force && Date.now() - local.checkedAt < 8000) return local.up;
  local.checkedAt = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1200);
    const r = await fetch(settings.localUrl.replace(/\/+$/, "") + "/v1/models", { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    local.up = r.ok;
    local.served = (j.data || []).map((m) => m.id);
    const loaded = (j.data || []).find((m) => m.status && m.status.value === "loaded");
    local.loaded = loaded ? loaded.id : null;
    // A model added to the preset since the router started is not served
    // until it restarts.
    if (local.up) local.needsRestart = models.readIni(settings).some((m) => !local.served.includes(m.id));
  } catch (e) {
    local.up = false;
    local.loaded = null;
    local.served = [];
  }
  return local.up;
}

// Everything the preset lists, marked with what the router actually serves.
function localModels() {
  const ini = models.readIni(settings);
  const ids = ini.length ? ini.map((m) => m.id) : local.served;
  return ids.map((id) => {
    const m = ini.find((x) => x.id === id);
    return { id, file: m && m.file ? path.basename(m.file) : null, loaded: local.loaded === id, served: local.served.includes(id), big: isBig(id, m && m.file) };
  });
}

// A 14B-and-up model gets every tool and the whole memory graph; small ones a
// short list, which they choose from far more reliably.
function isBig(id, file) {
  const m = (String(id) + " " + String(file || "")).match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return !!m && Number(m[1]) >= 14;
}

function localModelNow() {
  return settings.autoGameModel && game.on ? "jarvis-4b" : settings.localModel;
}

// A game just came to the front. If the big model is sitting in VRAM, hand it
// back now rather than at the next question.
async function onGameChange() {
  broadcast({ type: "status", status: status() });
  if (!settings.autoGameModel || !game.on) return;
  if (!(await localProbe(true))) return;
  if (local.loaded && local.loaded !== "jarvis-4b") {
    try {
      await fetch(settings.localUrl.replace(/\/+$/, "") + "/models/unload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: local.loaded }),
      });
      local.loaded = null;
    } catch (e) { /* the router unloads on idle anyway */ }
  }
}

function localStart() {
  const bat = settings.localBat;
  if (!bat) return { ok: false, error: "Set the path to jarvis-llm.bat first." };
  if (!fs.existsSync(bat)) return { ok: false, error: "Can't find " + bat };
  // Its own minimised console, like your other model bats, so its log is there
  // to read and closing that window stops it.
  const child = spawn("cmd.exe", ["/c", "start", "\"Jarvis llama-server\"", "/min", "cmd", "/c", "\"" + bat + "\""], {
    cwd: path.dirname(bat), detached: true, stdio: "ignore", windowsVerbatimArguments: true,
  });
  child.unref();
  local.checkedAt = 0;
  return { ok: true };
}

// Stops the router (and the model processes it spawned). The console the bat
// opened is only closed when it really is running jarvis-llm.bat.
function localStop() {
  return new Promise((resolve) => {
    const port = (settings.localUrl.match(/:(\d+)/) || [])[1] || "8081";
    const ps =
      "$c = Get-NetTCPConnection -LocalPort " + Number(port) + " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" +
      "if (-not $c) { 'none'; exit }" +
      "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\";" +
      "$q = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\";" +
      "$target = $p.ProcessId;" +
      "if ($q -and $q.Name -eq 'cmd.exe' -and $q.CommandLine -like ('*jarvis-ll' + 'm.bat*')) { $target = $q.ProcessId }" +
      "taskkill /PID $target /T /F | Out-Null; 'stopped'";
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      local.checkedAt = 0;
      local.up = false;
      if (err) return resolve({ ok: false, error: err.message });
      resolve({ ok: true, result: String(out).trim() });
    });
  });
}

function localEdit() {
  const bat = settings.localBat;
  if (!bat || !fs.existsSync(bat)) return { ok: false, error: "Set the path to jarvis-llm.bat first." };
  const files = [bat];
  const ini = path.join(path.dirname(bat), "jarvis-models.ini");
  if (fs.existsSync(ini)) files.push(ini);
  for (const f of files) spawn("notepad.exe", [f], { detached: true, stdio: "ignore" }).unref();
  return { ok: true, opened: files };
}

// The router only reads its preset at start, so a newly added model needs this.
async function localRestart() {
  const stop = await localStop();
  if (!stop.ok) return stop;
  await new Promise((r) => setTimeout(r, 1500));
  const r = localStart();
  local.needsRestart = false;
  return r;
}

// ------------------------------------------------------------------ memory --
//  One memory for every assistant on this PC: the knowledge graph the MCP
//  memory server keeps in memory.json. memory-server.bat runs it, and both
//  qwen27b-iq4.bat and jarvis-llm.bat start that, so the web UI and Jarvis
//  read and write the same entities.
//
//  Writes go through the server when it is up, so it stays the one writer.
//  When it is down, Jarvis edits the file in the same JSONL format; the
//  server re-reads the file on every request, so nothing is lost either way.
//  Reads go straight to the file: the server runs without sessions and takes
//  about 1.4 s a call (measured), too slow to pay on every question.
//
//  With no graph file set, Jarvis keeps his own jarvis-memory.json instead.
function graphMode() { return !!(settings.useGraph && settings.graphFile); }
function userEntity() { return settings.name || "User"; }

function readGraph() {
  const g = { entities: [], relations: [] };
  let text = "";
  try { text = fs.readFileSync(settings.graphFile, "utf8"); } catch (e) { return g; }
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch (e) { continue; }
    if (o.type === "entity") g.entities.push({ name: o.name, entityType: o.entityType, observations: o.observations || [] });
    else if (o.type === "relation") g.relations.push({ from: o.from, to: o.to, relationType: o.relationType });
  }
  return g;
}

// The server's own format: one JSON object per line, entities then relations.
function writeGraph(g) {
  const lines = g.entities.map((e) => JSON.stringify({ type: "entity", name: e.name, entityType: e.entityType, observations: e.observations }))
    .concat(g.relations.map((r) => JSON.stringify({ type: "relation", from: r.from, to: r.to, relationType: r.relationType })));
  const tmp = settings.graphFile + ".jarvis-tmp";
  fs.writeFileSync(tmp, lines.join("\n"), "utf8");
  fs.renameSync(tmp, settings.graphFile);
}

// The MCP memory server, spoken to without a session (it is run stateless,
// so a single tools/call works on its own — verified).
const memoryServer = { up: false, checkedAt: 0 };
async function mcpTool(name, args) {
  if (!settings.memoryUrl) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(settings.memoryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
      signal: ctl.signal,
    });
    const text = await r.text();
    let msg = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5)); } catch (e) {} }
    }
    if (!msg && text.trim().startsWith("{")) { try { msg = JSON.parse(text); } catch (e) {} }
    memoryServer.up = true;
    memoryServer.checkedAt = Date.now();
    if (!msg) return null;
    const out = msg.result && msg.result.content && msg.result.content.map((c) => c.text || "").join("\n");
    if (msg.error || (msg.result && msg.result.isError)) return { ok: false, error: out || (msg.error && msg.error.message) || "error" };
    return { ok: true, text: out };
  } catch (e) {
    memoryServer.up = false;
    memoryServer.checkedAt = Date.now();
    return null;
  } finally { clearTimeout(t); }
}

// ---- Jarvis's own facts, when there is no graph ----
function memoryFile() { return H.stateFile("jarvis-memory.json"); }
function loadFacts() {
  try { const j = JSON.parse(fs.readFileSync(memoryFile(), "utf8")); return Array.isArray(j.facts) ? j.facts : []; }
  catch (e) { return []; }
}
function saveFacts(facts) {
  fs.writeFileSync(memoryFile(), JSON.stringify({ facts }, null, 2));
}

async function remember(text, about, type) {
  const t = String(text || "").trim().slice(0, 500);
  if (!t) return { ok: false, error: "nothing to remember" };
  if (!graphMode()) {
    const facts = loadFacts();
    if (facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) return { ok: true, already: true };
    facts.push({ id: "m" + Date.now().toString(36), text: t, at: new Date().toISOString().slice(0, 10) });
    saveFacts(facts);
    return { ok: true, saved: t, count: facts.length };
  }
  const want = String(about || "").trim() || userEntity();
  const g = readGraph();
  const e = g.entities.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (e && e.observations.some((o) => o.toLowerCase() === t.toLowerCase())) return { ok: true, already: true, about: e.name };
  const name = e ? e.name : want;
  const kind = String(type || "").trim() || (name === userEntity() ? "Person" : "Note");
  const r = e
    ? await mcpTool("add_observations", { observations: [{ entityName: name, contents: [t] }] })
    : await mcpTool("create_entities", { entities: [{ name, entityType: kind, observations: [t] }] });
  if (r && r.ok) { graphCache.mtime = 0; return { ok: true, saved: t, about: name, via: "memory server" }; }
  // The server is not running: write the file the same way it would.
  const g2 = readGraph();
  let e2 = g2.entities.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!e2) { e2 = { name, entityType: kind, observations: [] }; g2.entities.push(e2); }
  e2.observations.push(t);
  writeGraph(g2);
  graphCache.mtime = 0;
  return { ok: true, saved: t, about: name, via: "memory file" };
}

// Removes observations containing the text, or exactly one when the panel
// names both the entity and the observation.
async function forget(text, entity) {
  const t = String(text || "").trim();
  if (!graphMode()) {
    const facts = loadFacts();
    const keep = facts.filter((f) => !(t && (f.text.toLowerCase().includes(t.toLowerCase()) || f.id === t)));
    saveFacts(keep);
    return { ok: true, removed: facts.length - keep.length };
  }
  if (!t) return { ok: false, error: "what should I forget?" };
  const g = readGraph();
  const deletions = [];
  for (const e of g.entities) {
    if (entity && e.name !== entity) continue;
    const hit = e.observations.filter((o) => (entity ? o === t : o.toLowerCase().includes(t.toLowerCase())));
    if (hit.length) deletions.push({ entityName: e.name, observations: hit });
  }
  const count = deletions.reduce((s, d) => s + d.observations.length, 0);
  if (!count) return { ok: true, removed: 0 };
  const r = await mcpTool("delete_observations", { deletions });
  if (!(r && r.ok)) {
    for (const d of deletions) {
      const e = g.entities.find((x) => x.name === d.entityName);
      e.observations = e.observations.filter((o) => !d.observations.includes(o));
    }
    writeGraph(g);
  }
  graphCache.mtime = 0;
  return { ok: true, removed: count, via: r && r.ok ? "memory server" : "memory file" };
}

// Searches the graph for the words in a question, best matches first, with the
// relations that touch them.
function recall(query) {
  if (!graphMode()) {
    const q = String(query || "").toLowerCase();
    const hits = loadFacts().filter((f) => q.split(/\s+/).some((w) => w.length > 2 && f.text.toLowerCase().includes(w)));
    return { ok: true, facts: hits.map((f) => f.text) };
  }
  const words = String(query || "").toLowerCase().match(/[a-z0-9']{3,}/g) || [];
  const g = readGraph();
  const scored = g.entities.map((e) => {
    const name = e.name.toLowerCase(), type = String(e.entityType || "").toLowerCase();
    let score = 0;
    const obs = [];
    for (const o of e.observations) {
      const low = o.toLowerCase();
      const n = words.filter((w) => low.includes(w)).length;
      if (n) { score += n; obs.push(o); }
    }
    const nameHit = words.some((w) => name.includes(w) || type.includes(w));
    if (nameHit) score += 5;
    return { e, score, obs: nameHit ? e.observations : obs };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  const names = new Set(scored.map((x) => x.e.name));
  return {
    ok: true,
    found: scored.map((x) => ({ name: x.e.name, type: x.e.entityType, observations: x.obs.slice(0, 20) })),
    relations: g.relations.filter((r) => names.has(r.from) || names.has(r.to)).slice(0, 30),
  };
}

let graphCache = { file: "", mtime: 0, text: "" };
function graphSummary() {
  if (!graphMode()) return "";
  const file = settings.graphFile;
  try {
    const st = fs.statSync(file);
    if (graphCache.file === file && graphCache.mtime === st.mtimeMs) return graphCache.text;
    const g = readGraph();
    // The user first, so a cut-off summary still says who they are.
    const me = userEntity().toLowerCase();
    g.entities.sort((a, b) => (b.name.toLowerCase() === me) - (a.name.toLowerCase() === me));
    const ents = g.entities.map((e) => "- " + e.name + " (" + e.entityType + "): " + e.observations.join("; "));
    const rels = g.relations.map((r) => "- " + r.from + " " + r.relationType + " " + r.to);
    let text = ents.join("\n") + (rels.length ? "\nRelations:\n" + rels.join("\n") : "");
    if (text.length > 8000) text = text.slice(0, 8000) + "\n(more in memory: use recall)";
    graphCache = { file, mtime: st.mtimeMs, text };
    return text;
  } catch (e) { return ""; }
}

// Facts Jarvis kept before the memory was shared move into the graph once.
async function migrateFacts() {
  if (!graphMode()) return;
  const facts = loadFacts();
  if (!facts.length) return;
  for (const f of facts) await remember(f.text);
  saveFacts([]);
}

// ------------------------------------------------------------------- tools --
// `core` marks the set the local model gets: small models pick tools far more
// reliably from a short list.
const TOOLS = [
  {
    name: "web_search", where: "server", core: true,
    description: "Search the web, like Google. Returns titles, links and snippets, and shows them on screen. Use it for anything current or anything you are not sure of.",
    input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", description: "How many results, 1-8. Default 5." } }, required: ["query"] },
  },
  {
    name: "read_page", where: "server", core: true,
    description: "Fetch a web page and return its readable text, to answer from or to summarise. Use a link from search results or one the user gave.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "image_search", where: "server", core: true,
    description: "Find pictures and show them on screen. Use it whenever the user wants to see what something looks like.",
    input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" } }, required: ["query"] },
  },
  {
    name: "weather", where: "server", core: true,
    description: "Current conditions and the forecast, shown on screen. Leave place empty for home. Each forecast day is labelled today, tomorrow or a weekday.",
    input_schema: { type: "object", properties: { place: { type: "string" }, days: { type: "integer", description: "How many days of forecast, 3-7. Default 3." } } },
  },
  {
    name: "music", where: "client", core: true,
    description: "Music. action=play with a query finds it on Spotify and plays it (kind: track, album, artist or playlist; 'liked songs' plays the user's Liked Songs). pause, resume, next and previous control whatever is playing on the PC. now_playing says what is on.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "pause", "resume", "next", "previous", "now_playing"] },
        query: { type: "string" },
        kind: { type: "string", enum: ["track", "album", "artist", "playlist"] },
      },
      required: ["action"],
    },
  },
  {
    name: "volume", where: "server", core: true,
    description: "PC sound. set takes level 0-100; up and down step by 10 unless amount is given; mute and unmute the speakers. output / input switch the default speakers or microphone to the device named in device. mic_mute, mic_unmute. app sets one program's volume (app = its name, level 0-100, or mute true/false). list returns devices and programs.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "up", "down", "mute", "unmute", "output", "input", "mic_mute", "mic_unmute", "app", "list"] },
        level: { type: "integer" }, amount: { type: "integer" }, device: { type: "string" }, app: { type: "string" }, mute: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "timer", where: "client", core: true,
    description: "Countdown timers, shown in the top bar. set needs seconds and takes an optional label; cancel takes a label, or cancels all without one; list returns them.",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["set", "cancel", "list"] }, seconds: { type: "integer" }, label: { type: "string" } },
      required: ["action"],
    },
  },
  {
    name: "alarm", where: "client", core: true,
    description: "Alarms. set needs time as 24-hour HH:MM and takes an optional label and days (\"weekdays\", \"weekends\", \"daily\" or day names like \"mon\"); with no days it rings once, at the next occurrence. cancel by time or label, or all; list returns them.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "cancel", "list"] },
        time: { type: "string", description: "HH:MM, 24-hour" },
        label: { type: "string" },
        days: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
  },
  {
    name: "show", where: "client", core: true,
    description: "Put something on the screen as a titled list of cards: steps, lists, comparisons, anything easier to read than to hear. Say one short line instead of reading it all out.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, text: { type: "string" }, image: { type: "string" }, url: { type: "string" } },
          },
        },
      },
      required: ["title", "items"],
    },
  },
  {
    name: "remember", where: "server", core: true,
    description: "Save a fact to the shared memory (the same memory the user's other assistant uses), for future conversations: preferences, people, plans, routines. about = who or what it is about (default: the user; use a person's name for facts about them). With forget=true, removes remembered facts containing the text instead.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string" }, about: { type: "string" },
        type: { type: "string", description: "for a new entry: Person, Place, Project, Thing..." },
        forget: { type: "boolean" },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall", where: "server", core: true,
    description: "Search the shared memory for what is known about someone or something, when it is not already in front of you.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "find_model", where: "server", core: true,
    description: "Find an AI model to download for the local model server: searches Hugging Face for GGUF builds and lists the files with sizes, marking the one that fits this PC's 16 GB GPU. Shows them on screen. Takes words (\"qwen 3.5 27b\"), a repo id (\"unsloth/Qwen3.5-27B-GGUF\") or a Hugging Face link, and optionally a quant (\"Q4_K_M\").",
    input_schema: { type: "object", properties: { query: { type: "string" }, quant: { type: "string" } }, required: ["query"] },
  },
  {
    name: "download_model", where: "client", core: true,
    description: "Download a GGUF model into the local models folder and add it to the model list. Opens the model's page and asks the user to confirm on screen first; nothing downloads without their tap. Give repo and file from find_model, or a direct https link to a .gguf file from any site.",
    input_schema: {
      type: "object",
      properties: { repo: { type: "string" }, file: { type: "string" }, url: { type: "string" } },
    },
  },
  {
    name: "open_web", where: "client", core: true,
    description: "Open a web page on the panel, in its Web app.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "lights", where: "server", core: true,
    description: "The user's Govee lights (an RGBIC LED strip). on, off, brightness (level 1-100), color (a name like purple or warm white, or #hex), white (kelvin 2000-9000), status, scene (by name; needs a Govee API key), scan (list them). device = a light's name; empty means all.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["on", "off", "brightness", "color", "white", "status", "scene", "scan"] },
        device: { type: "string" }, level: { type: "integer" }, color: { type: "string" },
        kelvin: { type: "integer" }, scene: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "info", where: "server", core: true,
    description: "Everything the dashboard knows, to answer from. about: pc (CPU, GPU, temperatures, memory, network, busiest programs, uptime), phone (iPhone battery, notifications, calls), discord (voice channel, who is in it and talking, mute/deafen), audio (speakers, microphones, per-program volume), media (what is playing on the PC), claude_usage (Claude tokens and cost today, this month), lights, local_models, or everything.",
    input_schema: {
      type: "object",
      properties: { about: { type: "string", enum: ["everything", "pc", "phone", "discord", "audio", "media", "claude_usage", "lights", "local_models"] } },
      required: ["about"],
    },
  },
  {
    name: "panel", where: "client", core: true,
    description: "This dashboard app itself (for what is on screen, use layout). status (version, update, fork). check_updates; install_update restarts the app into a downloaded update (only when the user asks). switch_fork (fork: main or jarvis) downloads the other line of the app; install_update then switches. theme (name). settings opens a page (jarvis, appearance, drawer, close). reload. keyboard, never_take_focus, start_with_windows, taskbar_icon take on: true/false.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "check_updates", "install_update", "switch_fork", "cancel_fork_switch", "theme", "settings", "reload", "keyboard", "never_take_focus", "start_with_windows", "taskbar_icon"],
        },
        name: { type: "string" }, fork: { type: "string" }, on: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "layout", where: "client", core: true,
    description: "The panel's screen: what is where, and changing it. Apps (spotify, weather, youtube, shorts, tiktok, snapchat, web) and widgets (claude, weather, pc, calc, media, lyrics, audio, timer, notes, discord, face, pin) share one column of resizable panels under the main app. status: the main app, every panel top to bottom with its height, and what each is for. open (app): the main area. focus (app): that app gets the whole screen, widgets hidden; exit_focus brings them back. home: the Home layout; save_home saves what is on screen as Home. widget (name, on). dock (app, height, position): an app in a panel among the widgets; undock (app). resize (name, height in px, or size small/medium/large/half). move (name, position top/bottom/number, or before/after a panel's name). collapse / expand (name). scene (name: home, working, gaming, music, idle); save_scene (name). calculator (expression): put a sum on the calculator widget and solve it. pin (window: part of its title or program) holds another program's window in the pin widget; unpin.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "open", "focus", "exit_focus", "home", "save_home", "widget", "dock", "undock", "resize", "move", "collapse", "expand", "scene", "save_scene", "calculator", "pin", "unpin"],
        },
        app: { type: "string" }, name: { type: "string" }, on: { type: "boolean" },
        height: { type: "integer" }, size: { type: "string", enum: ["small", "medium", "large", "half"] },
        position: { type: "string", description: "top, bottom, or a number counting from 0 at the top" },
        before: { type: "string" }, after: { type: "string" },
        expression: { type: "string" }, window: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "youtube", where: "client", core: true,
    description: "YouTube on the panel. play (query, or a url) finds the video and plays it. view: full (the default: just the video, the whole screen, widgets hidden), app (the YouTube page, whole screen), panel (just the video, in a panel among the widgets), normal (the YouTube page in the main area, widgets stay). search (query) shows YouTube's results to browse. pause, resume. exit leaves full screen.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "search", "pause", "resume", "exit"] },
        query: { type: "string" }, url: { type: "string" },
        view: { type: "string", enum: ["full", "app", "panel", "normal"] },
      },
      required: ["action"],
    },
  },
  {
    name: "discord", where: "server", core: true,
    description: "Discord voice. mute, unmute, deafen, undeafen. status: the channel, who is in it and who is talking. join (channel name, optional server) and leave a voice channel. channels lists a server's voice channels (server optional). input_volume (level 0-100) and output_volume (level 0-200) are Discord's own sliders. user_volume sets one person's volume (user, level 0-200, 100 is normal); user_mute (user, mute true/false) mutes them for you only.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "mute", "unmute", "deafen", "undeafen", "join", "leave", "channels", "input_volume", "output_volume", "user_volume", "user_mute"] },
        channel: { type: "string" }, server: { type: "string" }, user: { type: "string" }, level: { type: "integer" }, mute: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "notes", where: "server", core: true,
    description: "The Notes widget; every change opens it on screen and highlights what changed. The notes are text with light formatting: # heading, ## subheading, - bullet, - [ ] checkbox, - [x] ticked, 1. numbered, **bold**, --- line. read returns them with line numbers. write (text) replaces everything. append (text) adds at the end, or at the end of the section named in section (made if missing). insert (text) after the line containing after, or at line. replace (find, text) swaps a passage or line. delete (find, or line) removes the lines. check / uncheck (find) ticks a checklist item. clear empties them.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "append", "insert", "replace", "delete", "check", "uncheck", "clear"] },
        text: { type: "string" }, find: { type: "string" }, after: { type: "string" }, section: { type: "string" }, line: { type: "integer" },
      },
      required: ["action"],
    },
  },
  {
    name: "phone", where: "server", core: true,
    description: "The user's iPhone, over Bluetooth. answer, decline or hang_up the current call. dismiss a notification from the panel's list (app or index from info), or clear them all. To read the phone, use info about phone.",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", enum: ["answer", "decline", "hang_up", "dismiss", "clear"] }, app: { type: "string" }, index: { type: "integer" } },
      required: ["action"],
    },
  },
];
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

function claudeTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}
function openaiTools(all) {
  return TOOLS.filter((t) => all || t.core).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// The dashboard's own endpoints (PC stats, phone, Claude usage), as the
// widgets read them.
async function selfJson(p, body, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try {
    const r = await fetch("http://127.0.0.1:" + H.PORT + p, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }
      : { signal: ctl.signal });
    return await r.json();
  } catch (e) { return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message }; }
  finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "the headphones" -> "XM5-Wired (Realtek USB Audio)": exact, then prefix,
// then contains, then every word somewhere in the name.
function bestMatch(list, q, nameOf) {
  const n = String(q || "").toLowerCase().trim();
  if (!n) return null;
  const nm = (x) => String(nameOf(x) || "").toLowerCase();
  const words = n.split(/\s+/).filter((w) => w.length > 1 && !/^(the|my|a|to)$/.test(w));
  return list.find((x) => nm(x) === n) || list.find((x) => nm(x).startsWith(n)) || list.find((x) => nm(x).includes(n))
    || (words.length ? list.find((x) => words.every((w) => nm(x).includes(w))) : null) || null;
}

// ---- notes: the Notes widget's text, edited line by line ---------------------------
// Edits find lines by what they say (forgiving of the markdown around it),
// because a model is far better at quoting a line than counting to it.
const plainLine = (l) => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|>\s?)/, "").replace(/\*\*|__|~~|`/g, "").trim().toLowerCase();
function findLine(lines, q, from) {
  const n = String(q || "").trim().toLowerCase();
  if (!n) return -1;
  const bare = plainLine(n);
  for (let i = from || 0; i < lines.length; i++) if (lines[i].toLowerCase().trim() === n || plainLine(lines[i]) === bare) return i;
  for (let i = from || 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(n) || (bare && plainLine(lines[i]).includes(bare))) return i;
  return -1;
}
const headingLevel = (l) => { const m = l.match(/^\s*(#{1,6})\s/); return m ? m[1].length : 0; };
function numbered(text) {
  const lines = String(text || "").replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && !lines[0]) return "";
  const shown = lines.length > 120 ? lines.slice(-120) : lines;
  const off = lines.length - shown.length;
  return (off ? "(first " + off + " lines not shown)\n" : "") + shown.map((l, i) => (i + off + 1) + ": " + l).join("\n");
}
function editNotes(text, a) {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && !lines[0]) lines.length = 0;
  const add = String(a.text || "").replace(/\r/g, "").replace(/^\s*\n/, "").replace(/\s+$/, "");
  const addLines = add ? add.split("\n") : [];
  const join = (ls) => (ls.length ? ls.join("\n") + "\n" : "");
  const range = (start, n) => Array.from({ length: n }, (_, i) => start + i);
  switch (a.action) {
    case "read": return { msg: "" };
    case "write":
      if (!add) return { error: "write needs text (to empty the notes, use clear)" };
      return { text: join(addLines), changed: range(0, addLines.length), msg: "Wrote the notes (" + addLines.length + " lines)." };
    case "clear": return { text: "", changed: [], msg: "Cleared the notes." };
    case "append": {
      if (!add) return { error: "append needs text" };
      if (a.section) {
        let h = -1;
        for (let i = 0; i < lines.length; i++) if (headingLevel(lines[i]) && plainLine(lines[i]).includes(String(a.section).toLowerCase().trim())) { h = i; break; }
        if (h < 0) {
          // A new section at the end.
          const lead = lines.length && lines[lines.length - 1].trim() ? [""] : [];
          const start = lines.length + lead.length;
          const out = lines.concat(lead, ["## " + String(a.section).trim()], addLines);
          return { text: join(out), changed: range(start, addLines.length + 1), msg: "Added a new section, " + String(a.section).trim() + "." };
        }
        // The section runs to the next heading of the same or a higher level.
        const lvl = headingLevel(lines[h]);
        let end = lines.length;
        for (let i = h + 1; i < lines.length; i++) if (headingLevel(lines[i]) && headingLevel(lines[i]) <= lvl) { end = i; break; }
        let at = end;
        while (at > h + 1 && !lines[at - 1].trim()) at--;     // before the blank lines that close it
        lines.splice(at, 0, ...addLines);
        return { text: join(lines), changed: range(at, addLines.length), msg: "Added " + addLines.length + " line(s) under " + lines[h].replace(/^#+\s*/, "") + "." };
      }
      const start = lines.length;
      // Say where it really landed, so nobody has to guess.
      let under = "";
      for (let i = lines.length - 1; i >= 0; i--) if (headingLevel(lines[i])) { under = lines[i].replace(/^\s*#+\s*/, ""); break; }
      return { text: join(lines.concat(addLines)), changed: range(start, addLines.length), msg: "Added " + addLines.length + " line(s) at the very end" + (under ? ", which is under the heading \"" + under + "\"" : "") + ". (To put it under another heading, append with section.)" };
    }
    case "insert": {
      if (!add) return { error: "insert needs text" };
      let at;
      if (a.line != null) at = Math.max(0, Math.min(lines.length, Number(a.line) - 1));
      else {
        const i = findLine(lines, a.after);
        if (i < 0) return { error: "No line like \"" + (a.after || "") + "\" in the notes. Read them first." };
        at = i + 1;
      }
      lines.splice(at, 0, ...addLines);
      return { text: join(lines), changed: range(at, addLines.length), msg: "Inserted " + addLines.length + " line(s) at line " + (at + 1) + "." };
    }
    case "replace": {
      const find = String(a.find || "");
      if (!find.trim()) return { error: "replace needs find (the text to change)" };
      // A passage across lines: replace it as text.
      const whole = join(lines);
      const hit = whole.indexOf(find) >= 0 ? whole.indexOf(find) : whole.toLowerCase().indexOf(find.toLowerCase());
      if (find.includes("\n")) {
        if (hit < 0) return { error: "That passage isn't in the notes. Read them first." };
        const before = whole.slice(0, hit), after = whole.slice(hit + find.length);
        const out = before + add + after;
        const first = before.split("\n").length - 1;
        return { text: out.replace(/\s+$/, "") + "\n", changed: range(first, Math.max(1, addLines.length)), msg: "Replaced it." };
      }
      const i = findLine(lines, find);
      if (i < 0) return { error: "No line like \"" + find + "\" in the notes. Read them first." };
      // Inside a line, swap just the words; otherwise the whole line.
      const pos = lines[i].toLowerCase().indexOf(find.toLowerCase());
      if (pos >= 0 && find.trim().length < lines[i].trim().length && !add.includes("\n")) {
        lines[i] = lines[i].slice(0, pos) + add + lines[i].slice(pos + find.length);
        return { text: join(lines), changed: [i], msg: "Changed line " + (i + 1) + "." };
      }
      lines.splice(i, 1, ...addLines);
      return { text: join(lines), changed: range(i, addLines.length), msg: "Replaced line " + (i + 1) + "." };
    }
    case "delete": {
      if (a.line != null) {
        const i = Number(a.line) - 1;
        if (!(i >= 0 && i < lines.length)) return { error: "There is no line " + a.line + "." };
        const gone = lines.splice(i, 1);
        return { text: join(lines), changed: [], msg: "Deleted line " + (i + 1) + ": " + gone[0] };
      }
      const find = String(a.find || "");
      if (!find.trim()) return { error: "delete needs find or line" };
      const gone = [];
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].toLowerCase().includes(find.toLowerCase()) || plainLine(lines[i]) === plainLine(find)) gone.unshift(lines.splice(i, 1)[0]);
      if (!gone.length) return { error: "No line like \"" + find + "\" in the notes." };
      return { text: join(lines), changed: [], msg: "Deleted " + gone.length + " line(s): " + gone.join(" | ") };
    }
    case "check":
    case "uncheck": {
      const i = findLine(lines.map((l) => (/\[[ xX]\]/.test(l) ? l : "")), a.find);
      if (i < 0) return { error: "No checklist item like \"" + (a.find || "") + "\"." };
      lines[i] = lines[i].replace(/\[[ xX]\]/, a.action === "check" ? "[x]" : "[ ]");
      return { text: join(lines), changed: [i], msg: (a.action === "check" ? "Ticked: " : "Unticked: ") + plainLine(lines[i]) };
    }
    default: return { error: "unknown notes action " + a.action };
  }
}

// ---- info: what the dashboard knows, section by section ----------------------
const pct = (v) => (v == null ? null : Math.round(v * 100));
const INFO = {
  async pc() {
    let s = await selfJson("/api/pcstats");
    if (s.warming) { await sleep(2600); s = await selfJson("/api/pcstats"); }
    if (!s || s.ok === false) return { error: (s && s.error) || "no PC stats" };
    return {
      cpu: s.cpu && { pct: s.cpu.pct, tempC: s.cpu.tempC, name: String(s.cpu.name || "").trim(), threads: s.cpu.cores },
      gpu: s.gpu && { name: s.gpu.name, pct: s.gpu.util, tempC: s.gpu.temp, vramUsedMB: s.gpu.memUsed, vramTotalMB: s.gpu.memTotal },
      ram: s.ram,
      net: s.net && { downMbps: +(s.net.downBps * 8 / 1e6).toFixed(2), upMbps: +(s.net.upBps * 8 / 1e6).toFixed(2) },
      uptimeHours: s.uptime ? +(s.uptime / 3600).toFixed(1) : null,
      busiest: (s.busiest || []).slice(0, 5).map((p) => ({ name: p.name, diskAndNetMBps: +(p.ioBps / 1e6).toFixed(2) })),
      online: (s.talkers || []).slice(0, 5).map((p) => ({ name: p.name, connections: p.conns, hosts: p.hosts })),
      game: game.on ? (game.exe || "fullscreen") : null,
    };
  },
  async phone() {
    const s = await selfJson("/api/phone");
    if (!s || s.ok === false) return { error: (s && s.error) || "no phone bridge" };
    return {
      connected: s.connected, device: s.device, battery: s.battery,
      call: s.call ? { from: s.call.from, detail: s.call.detail || undefined, answered: !!s.call.accepted } : null,
      notifications: (s.notifications || []).slice(0, 15).map((n, i) => ({ index: i, app: n.app, title: n.title, message: n.message, at: n.date })),
      note: s.connected ? undefined : "The iPhone isn't connected to the panel's Bluetooth bridge right now.",
    };
  },
  async discord() {
    const s = discord.status();
    if (!s.configured) return { error: "Discord isn't set up in the panel (Discord widget)." };
    if (!s.connected) return { error: "Discord isn't running, or the panel can't reach it." };
    if (!s.authed) return { error: "Discord is running but the panel isn't authorised yet (Discord widget > Authorise)." };
    return {
      me: s.user && s.user.name,
      mute: s.voice && s.voice.mute, deaf: s.voice && s.voice.deaf,
      inputVolume: s.voice && s.voice.inputVolume, outputVolume: s.voice && s.voice.outputVolume,
      channel: s.channel ? {
        name: s.channel.name,
        members: s.channel.members.map((m) => ({ name: m.name, me: m.me || undefined, speaking: m.speaking || undefined, muted: m.mute || undefined, deafened: m.deaf || undefined })),
      } : null,
    };
  },
  async audio() {
    const au = H.sysState() && H.sysState().audio;
    if (!au) { await sleep(1500); }
    const a = H.sysState() && H.sysState().audio;
    if (!a) return { error: "the sound helper isn't ready" };
    const dev = (d) => ({ name: d.name, default: d.isDefault || undefined, volume: pct(d.volume), muted: d.muted || undefined });
    return {
      speakers: (a.outputs || []).map(dev),
      microphones: (a.inputs || []).map(dev),
      programs: (a.sessions || []).map((s) => ({ name: s.name, volume: pct(s.volume), muted: s.muted || undefined, playing: s.active || undefined })),
    };
  },
  async media() {
    const st = H.sysState();
    const m = st && st.media;
    if (!m || !m.title) return { playing: false, note: "Nothing is playing on the PC." };
    return { app: m.app, title: m.title, artist: m.artist, album: m.album, playing: m.playing, positionS: Math.round(m.position / 1000), lengthS: Math.round(m.duration / 1000) };
  },
  async claude_usage() {
    const s = await selfJson("/api/claude-stats");
    if (!s || !s.ok) return { error: (s && s.error) === "no_data" ? "no Claude Code usage recorded on this PC" : (s && s.error) || "no stats" };
    const money = (c) => "$" + (c || 0).toFixed(2);
    return {
      today: { tokens: s.today.tok, cost: money(s.today.cost), messages: s.today.msgs, sessions: s.today.sessions },
      thisMonth: { tokens: s.month.tok, cost: money(s.month.cost) },
      allTime: { tokens: s.allTime.tok, cost: money(s.allTime.cost), messages: s.allTime.msgs },
      last7Days: (s.days || []).map((d) => ({ day: d.label, tokens: d.tok, cost: money(d.cost) })),
      topModel30Days: s.topModel,
    };
  },
  async lights() { return govee.status(); },
  async local_models() {
    await localProbe(true);
    return { serverUp: local.up, loaded: local.loaded, models: localModels(), needsRestart: local.needsRestart, downloads: models.list() };
  },
};
async function info(about) {
  const one = INFO[about];
  if (one) return one();
  // everything: every section at once, each given a few seconds.
  const keys = Object.keys(INFO);
  const out = {};
  await Promise.all(keys.map(async (k) => {
    out[k] = await Promise.race([INFO[k]().catch((e) => ({ error: e.message })), sleep(6000).then(() => ({ error: "took too long" }))]);
  }));
  // Trim the long lists down to what a summary needs.
  if (out.audio && out.audio.speakers) {
    out.audio = {
      speakers: (out.audio.speakers.find((d) => d.default) || {}).name,
      microphone: (out.audio.microphones.find((d) => d.default) || {}).name,
      volume: (out.audio.speakers.find((d) => d.default) || {}).volume,
      playingPrograms: out.audio.programs.filter((p) => p.playing).map((p) => p.name),
    };
  }
  if (out.phone && out.phone.notifications) out.phone.notifications = out.phone.notifications.slice(0, 5);
  if (out.claude_usage && out.claude_usage.last7Days) delete out.claude_usage.last7Days;
  if (out.local_models && out.local_models.models) out.local_models.models = out.local_models.models.map((m) => m.id + (m.loaded ? " (loaded)" : ""));
  return out;
}

// Discord's servers and their channels change rarely; looked up on demand.
let dcCache = { at: 0, guilds: null, channels: new Map() };
async function discordVoiceChannels(server) {
  if (Date.now() - dcCache.at > 10 * 60 * 1000) dcCache = { at: Date.now(), guilds: null, channels: new Map() };
  if (!dcCache.guilds) {
    const g = await discord.action("guilds");
    if (!g.ok) return g;
    dcCache.guilds = g.guilds;
  }
  let guilds = dcCache.guilds;
  if (server) {
    const g = bestMatch(guilds, server, (x) => x.name);
    if (!g) return { ok: false, error: "You aren't in a server called " + server + ". Servers: " + guilds.map((x) => x.name).slice(0, 25).join(", ") };
    guilds = [g];
  } else {
    // The server you are already in first.
    const cur = discord.status().channel;
    if (cur && cur.guild) guilds = guilds.filter((x) => x.id === cur.guild).concat(guilds.filter((x) => x.id !== cur.guild));
  }
  const out = [];
  for (const g of guilds.slice(0, 40)) {
    if (!dcCache.channels.has(g.id)) {
      const c = await discord.action("channels", { guildId: g.id });
      dcCache.channels.set(g.id, c.ok ? c.channels.filter((x) => x.voice) : []);
    }
    for (const c of dcCache.channels.get(g.id)) out.push({ ...c, server: g.name });
  }
  return { ok: true, channels: out };
}
function discordMember(user) {
  const ch = discord.status().channel;
  if (!ch) return { error: "You aren't in a voice channel." };
  const m = bestMatch(ch.members.filter((x) => !x.me), user, (x) => x.name);
  return m ? { member: m } : { error: "Nobody called " + user + " is in " + ch.name + ". In it: " + ch.members.map((x) => x.name).join(", ") };
}

// Runs a server-side tool. Returns [resultForModel, isError]. `emit` puts
// cards on the panel while it works.
async function runServerTool(name, input, emit) {
  const a = input || {};
  switch (name) {
    case "web_search": {
      const r = await web.webSearch(a.query, Math.min(8, a.count || 5));
      if (!r.ok) return [r.error, true];
      emit({ type: "card", card: { kind: "results", query: r.query, items: r.results } });
      return [JSON.stringify(r.results.map((x, i) => ({ n: i + 1, title: x.title, url: x.url, snippet: x.snippet })))];
    }
    case "read_page": {
      const r = await web.readPage(a.url, 9000);
      if (!r.ok) return [r.error, true];
      emit({ type: "card", card: { kind: "page", title: r.title, url: r.url, image: r.image } });
      return [(r.title ? "# " + r.title + "\n" : "") + r.text + (r.truncated ? "\n(truncated)" : "")];
    }
    case "image_search": {
      const r = await web.imageSearch(a.query, Math.min(12, a.count || 6));
      if (!r.ok) return [r.error, true];
      emit({ type: "card", card: { kind: "images", query: r.query, items: r.images } });
      return ["Showing " + r.images.length + " images of " + r.query + " on screen: " +
        r.images.map((x) => x.title).filter(Boolean).slice(0, 6).join(" | ")];
    }
    case "weather": {
      const r = await web.weather(a.place, a.days, settings.home);
      if (!r.ok) return [r.error, true];
      emit({ type: "card", card: { kind: "weather", data: r } });
      return [JSON.stringify(r)];
    }
    case "volume": {
      let st = H.sysState();
      if (!st || !st.audio) { await sleep(1500); st = H.sysState(); }
      const au = st && st.audio;
      if (!au) return ["The sound helper isn't ready yet; try again in a moment.", true];
      // The helper calls it isDefault (reading `default` here always missed,
      // so "up" used to start from a guessed 50).
      const out = (au.outputs || []).find((d) => d.isDefault);
      const names = (list) => (list || []).map((d) => d.name).join(", ");
      if (a.action === "list") return [JSON.stringify((await INFO.audio()))];
      if (a.action === "output" || a.action === "input") {
        const list = a.action === "output" ? au.outputs : au.inputs;
        const what = a.action === "output" ? "speakers" : "microphone";
        const d = bestMatch(list || [], a.device, (x) => x.name);
        if (!d) return ["No " + what + " called \"" + (a.device || "") + "\". There are: " + names(list), true];
        if (d.isDefault) return [d.name + " is already the default " + what + "."];
        const m = await H.sysSend("audio.setDefault", { id: d.id });
        return m.ok ? [(a.action === "output" ? "Sound now plays through " : "The microphone is now ") + d.name + "."] : [m.error || "failed", true];
      }
      if (a.action === "mic_mute" || a.action === "mic_unmute") {
        const m = await H.sysSend("audio.micMute", { mute: a.action === "mic_mute" });
        return m.ok ? ["Microphone " + (a.action === "mic_mute" ? "muted" : "unmuted") + " (Windows-wide)."] : [m.error || "failed", true];
      }
      if (a.action === "app") {
        // The panel's own Spotify, YouTube, TikTok and Jarvis's voice all play
        // inside the dashboard, so they share its one Windows sound session.
        const panelSound = /spotify|youtube|tiktok|shorts|snapchat|panel|dashboard|jarvis|y70/i.test(a.app || "");
        const s = bestMatch(au.sessions || [], a.app, (x) => x.name)
          || (panelSound ? (au.sessions || []).find((x) => /^Y70 Dashboard$/i.test(x.name)) : null);
        if (!s) return ["No program called \"" + (a.app || "") + "\" has sound open. These do: " + names(au.sessions), true];
        const args = { name: s.name };
        if (a.level != null) args.volume = Math.max(0, Math.min(100, Number(a.level))) / 100;
        if (a.mute != null) args.mute = !!a.mute;
        if (args.volume == null && args.mute == null) return ["Give level (0-100) or mute.", true];
        const m = await H.sysSend("audio.session", args);
        if (!m.ok || !(m.data && m.data.matched)) return [(m && m.error) || "Windows didn't change " + s.name + ".", true];
        return [s.name + (args.volume != null ? " volume " + pct(s.volume) + " -> " + Math.round(args.volume * 100) : "") + (args.mute != null ? (args.mute ? " muted" : " unmuted") : "") + "."];
      }
      const cur = out ? Math.round((out.volume || 0) * 100) : 50;
      let level = cur;
      if (a.action === "mute" || a.action === "unmute") {
        const m = await H.sysSend("audio.setMute", { mute: a.action === "mute" });
        return m.ok ? [a.action === "mute" ? "muted" : "unmuted"] : [m.error || "failed", true];
      }
      if (a.action === "set") level = Number(a.level);
      if (a.action === "up") level = cur + (Number(a.amount) || 10);
      if (a.action === "down") level = cur - (Number(a.amount) || 10);
      if (!Number.isFinite(level)) return ["level needed", true];
      level = Math.max(0, Math.min(100, Math.round(level)));
      const m = await H.sysSend("audio.setVolume", { level: level / 100 });
      if (m.ok && out && out.muted && level > 0) await H.sysSend("audio.setMute", { mute: false });
      return m.ok ? ["volume " + cur + " -> " + level] : [m.error || "failed", true];
    }
    case "remember": {
      const r = a.forget ? await forget(a.fact) : await remember(a.fact, a.about, a.type);
      emit({ type: "memory" });
      return [JSON.stringify(r), !r.ok];
    }
    case "recall": {
      const r = recall(a.query);
      return [JSON.stringify(r)];
    }
    case "lights": {
      const r = await govee.control(a);
      emit({ type: "lights" });
      return [JSON.stringify(r), !r.ok];
    }
    case "find_model": {
      const r = await models.find(a.query, a.quant);
      if (!r.ok) return [r.error, true];
      emit({ type: "card", card: { kind: "models", query: r.query, items: r.results } });
      return [JSON.stringify(r.results.map((x) => ({
        repo: x.repo, downloads: x.downloads, updated: x.updated,
        recommended: { file: x.best.path, quant: x.best.quant, sizeGB: x.best.sizeGB, fitsGPU: x.best.fits },
        others: x.others.map((o) => ({ file: o.path, quant: o.quant, sizeGB: o.sizeGB, fitsGPU: o.fits })),
      }))) + "\nThe options are on screen with Download buttons. To fetch one, call download_model with its repo and file."];
    }
    case "discord": {
      const s = await INFO.discord();
      if (s.error) return [s.error, true];
      const map = { mute: ["setMute", true], unmute: ["setMute", false], deafen: ["setDeaf", true], undeafen: ["setDeaf", false] };
      if (map[a.action]) {
        const m = map[a.action];
        const r = await discord.action(m[0], { value: m[1] });
        return r.ok ? ["Done. Now: " + (r.voice.deaf ? "deafened" : r.voice.mute ? "muted" : "mic live") + "."] : [r.error || "Discord didn't answer", true];
      }
      switch (a.action) {
        case "status": return [JSON.stringify(s)];
        case "leave": {
          if (!s.channel) return ["You aren't in a voice channel."];
          const r = await discord.action("leaveVoice");
          return r.ok ? ["Left " + s.channel.name + "."] : [r.error, true];
        }
        case "channels": {
          const r = await discordVoiceChannels(a.server);
          if (!r.ok) return [r.error, true];
          return [JSON.stringify(r.channels.slice(0, 60).map((c) => c.server + " / " + c.name))];
        }
        case "join": {
          if (!a.channel) return ["Which channel?", true];
          const r = await discordVoiceChannels(a.server);
          if (!r.ok) return [r.error, true];
          const c = bestMatch(r.channels, a.channel, (x) => x.name);
          if (!c) return ["No voice channel called " + a.channel + (a.server ? " in " + a.server : "") + ". Some there are: " + r.channels.slice(0, 15).map((x) => x.name + " (" + x.server + ")").join(", "), true];
          const j = await discord.action("joinVoice", { channelId: c.id });
          return j.ok ? ["Joined " + c.name + " in " + c.server + "."] : [j.error, true];
        }
        case "input_volume":
        case "output_volume": {
          if (a.level == null) return ["level needed", true];
          const r = await discord.action("setVolumes", a.action === "input_volume" ? { input: a.level } : { output: a.level });
          return r.ok ? ["Discord " + (a.action === "input_volume" ? "input" : "output") + " volume is " + (a.action === "input_volume" ? r.voice.inputVolume : r.voice.outputVolume) + "."] : [r.error, true];
        }
        case "user_volume":
        case "user_mute": {
          const f = discordMember(a.user);
          if (f.error) return [f.error, true];
          const args = { userId: f.member.id };
          if (a.action === "user_volume") { if (a.level == null) return ["level needed", true]; args.volume = a.level; }
          else args.mute = a.mute !== false;
          const r = await discord.action("setUserVoice", args);
          return r.ok ? [f.member.name + (a.action === "user_volume" ? " is at " + Math.max(0, Math.min(200, a.level)) + "%." : args.mute ? " is muted for you." : " is unmuted.")] : [r.error, true];
        }
        default: return ["unknown action", true];
      }
    }
    case "notes": {
      const file = H.stateFile("notes.txt");
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch (e) {}
      const r = editNotes(text, a);
      if (r.error) return [r.error, true];
      if (r.text !== undefined && r.text !== text) {
        fs.writeFileSync(file, r.text, "utf8");
        text = r.text;
      }
      // The panel opens the Notes widget and lights up what changed.
      emit({ type: "notes", flash: r.changed || [] });
      if (a.action === "read") return [numbered(text) || "(the notes are empty)"];
      return [r.msg + "\nThe notes now:\n" + (numbered(text) || "(empty)")];
    }
    case "info": {
      const r = await info(String(a.about || "everything"));
      return [JSON.stringify(r), !!(r && r.error)];
    }
    case "phone": {
      const s = await selfJson("/api/phone");
      if (!s || s.ok === false) return [(s && s.error) || "The phone bridge isn't running.", true];
      if (a.action === "answer" || a.action === "decline" || a.action === "hang_up") {
        if (!s.call) return ["There's no call right now.", true];
        if (a.action === "answer" && s.call.accepted) return ["The call is already answered."];
        const r = await selfJson("/api/phone", { action: { answer: "accept", decline: "decline", hang_up: "hangup" }[a.action], uid: s.call.uid });
        return r.ok ? [{ answer: "Answered", decline: "Declined", hang_up: "Hung up on" }[a.action] + " the call from " + s.call.from + "."] : [r.error || "failed", true];
      }
      if (a.action === "clear") {
        const r = await selfJson("/api/phone", { action: "clear" });
        return r.ok ? ["Cleared the panel's notification list (the phone keeps its own)."] : [r.error || "failed", true];
      }
      if (a.action === "dismiss") {
        const list = s.notifications || [];
        const n = a.index != null ? list[a.index] : bestMatch(list, a.app, (x) => x.app + " " + (x.title || ""));
        if (!n) return ["No notification like that on the panel.", true];
        const r = await selfJson("/api/phone", { action: "dismiss", uid: n.uid });
        return r.ok ? ["Dismissed " + n.app + (n.title ? ": " + n.title : "") + " from the panel."] : [r.error || "failed", true];
      }
      return ["unknown action", true];
    }
    default:
      return ["unknown tool " + name, true];
  }
}

// ----------------------------------------------------------- system prompt --
function who() { return settings.name || "the user"; }

// `small`: a small local model gets a shorter slice of the memory graph.
// ------------------------------------------------------------ master prompt --
// Jarvis is only as good as his habit of reaching for a tool. Small local
// models especially will happily say "Checking for updates now." and stop, or
// answer "no updates" from nowhere (both seen with the 9B). So the prompt
// leads with the rules for tools, then says which tool answers what — built
// from the tools this model actually has — then shows it done.
const TOOL_GUIDE = {
  info: "anything about the PC (CPU, GPU, temperatures, memory, network, what is running, uptime), the iPhone (battery, notifications, a call), Discord (who is in the channel, who is talking), sound devices and program volumes, what is playing, Claude usage and spend, the lights, the local models",
  panel: "this app itself: check for or install updates, switch forks, a theme, your own settings, reload",
  layout: "what is on the screen and where: open an app, full screen (focus) and back, the Home layout (and saving a new one), show or hide widgets, put an app in a panel beside the widgets, resize, move, collapse, scenes, a sum on the calculator, pinning a window. The bracketed line says what is on screen now",
  youtube: "\"show me a video of...\", \"put on some...\" to watch: plays it, just the video, full screen unless asked otherwise; pause, resume, exit",
  web_search: "news, scores, prices, release dates, facts, anything current or anything you are not certain of",
  read_page: "summarise or read an article or a link (from search results or one the user gave)",
  image_search: "\"show me\", \"what does it look like\"",
  weather: "weather, rain, temperature, \"do I need a jacket\", any forecast",
  music: "play something, pause, resume, skip, go back, \"what is this song\"",
  volume: "louder, quieter, mute, switch speakers or headphones or microphone, one program's volume, the mic",
  timer: "a countdown: \"in ten minutes\", \"timer for the pasta\"",
  alarm: "a time of day: \"wake me at 7\", \"remind me at 3\"",
  show: "lists, steps, recipes, comparisons, anything easier to read than to hear",
  remember: "anything worth keeping: preferences, people, plans, \"remember that...\"",
  recall: "\"what do you know about...\", details about a person or thing that are not already above",
  find_model: "a new AI model for the local server (then download_model)",
  download_model: "fetch the model find_model picked; the user confirms on screen",
  open_web: "open a website on the panel",
  lights: "the lights: on, off, colours, brightness, warm or cool white, scenes",
  discord: "mute, unmute, deafen, join or leave a voice channel, Discord's volumes, someone's volume",
  phone: "answer, decline or hang up a call; dismiss notifications",
  notes: "the Notes widget: write, add to, edit and tick off notes and lists, formatted (# headings, - bullets, - [ ] checkboxes, **bold**). Read first when editing; to add to a list with sections, append with section set to the right heading",
};

const TOOL_EXAMPLES = [
  ["turn it down a bit", "volume {action: down}", "then say the new level it returned"],
  ["is something hogging my GPU?", "info {about: pc}", "then answer from the GPU numbers and the busiest programs"],
  ["any updates?", "panel {action: check_updates}", "then say exactly what it returned"],
  ["lights blue and play some jazz", "lights {action: color, color: blue} and music {action: play, query: jazz}, both in one go", "then \"Blue, and jazz is on.\""],
  ["who's talking?", "discord {action: status}", ""],
  ["what happened with SpaceX today?", "web_search {query: SpaceX news today}", "then two sentences from the results"],
  ["pasta timer, 12 minutes", "timer {action: set, seconds: 720, label: pasta}", ""],
  ["how much have I spent on Claude today?", "info {about: claude_usage}", ""],
  ["what's my phone at?", "info {about: phone}", "then the battery level it returned"],
  ["show me a video of the Webb telescope", "youtube {action: play, query: James Webb telescope}", "then one line about what is playing"],
  ["make YouTube bigger and put the PC stats under it", "layout {action: resize, name: youtube, size: large} and layout {action: move, name: pc, after: youtube}", ""],
  ["go home", "layout {action: home}", ""],
  ["write me a packing list for the weekend", "notes {action: write, text: \"# Weekend packing\\n- [ ] ...\"}", "then say it's in the notes"],
  ["tick off the eggs", "notes {action: check, find: eggs}", ""],
];

function systemPrompt(small) {
  const addr = settings.addressAs ? " Address them as \"" + settings.addressAs + "\"." : "";
  const facts = graphMode() ? [] : loadFacts();
  const graph = graphSummary();
  const have = TOOLS.filter((t) => !small || t.core).map((t) => t.name);
  const guide = have.filter((n) => TOOL_GUIDE[n]).map((n) => "- " + n + ": " + TOOL_GUIDE[n]);
  const examples = TOOL_EXAMPLES
    .filter(([, call]) => have.some((n) => call.startsWith(n + " ")))
    .map(([said, call, then]) => "- \"" + said + "\" -> " + call + (then ? ", " + then : ""));
  const parts = [
    "You are Jarvis, " + who() + "'s personal assistant. You live on the small HYTE Y70 Touch screen beside their main monitor, built into their dashboard, and you can see and do almost everything on their PC through your tools." + addr,
    "",
    "THE RULE: you act through your tools. If a tool can do it or knows it, call the tool, every time, even if you called it a minute ago. You never pretend.",
    "",
    "Tools, always:",
    "1. Do, then speak. Call the tool first and speak after its result. Never say you are doing, checking or have done something (\"I'll...\", \"Let me...\", \"Checking...\", \"Done\", \"Playing...\") unless a tool call in this turn did it.",
    "2. Never answer from memory what a tool can read. The PC, the phone, Discord, sound, what is playing, this app, Claude usage, the lights, the weather, news and anything current all change; earlier results in this conversation are already stale, so read again.",
    "3. Say what the tool returned, not what you expected. If it failed or found nothing, say so in a few words, with the fix if the tool gave one.",
    "4. Several things asked, several tools: call them together in one step when they do not depend on each other.",
    "5. Just do ordinary things; do not ask first. Ask only when a request is genuinely ambiguous. install_update, switch_fork and download_model only when " + who() + " asked for that.",
    "6. Not sure? Read first (info, web_search) rather than guess. One search is usually enough, two at most; then answer from what you found, even if partial.",
    "7. Chat, jokes, opinions and general knowledge (\"what is a GPU?\") need no tool: just answer. Never talk about your tools or what you lack.",
    "8. If something needs doing and no tool can do it, say in a few words that you can't do that yet. Never fake it.",
    "",
    "Which tool:",
    ...guide,
    "",
    "Like this (-> is the tool call):",
    ...examples,
    "",
    "How you talk:",
    "- Your replies are spoken aloud, so keep them short: one to three sentences unless asked for more. No markdown, no lists, no emoji, never read out a URL.",
    "- Dry, warm and quick. A little wit is welcome; waffle is not.",
    "- When something is on screen (search results, pictures, weather, a show card), say one line about it instead of reading it out.",
    "- Fahrenheit, miles, and the 12-hour clock.",
    "",
    "Good to know:",
    "- Requests come through speech recognition and may be misheard (\"place on low fi beads\" means \"play some lo-fi beats\"). Interpret them charitably.",
    "- " + who() + " may be in the middle of a game. Be brief.",
    "- Each request starts with a bracketed line of background (the time, what is playing, timers). Use it when it helps; never remark on it otherwise.",
    "- Your memory is shared with " + who() + "'s other assistant. When they tell you something worth keeping, remember it; to look something up in it, recall.",
  ];
  if (settings.about) parts.push("", "About " + who() + ":", settings.about);
  if (facts.length) parts.push("", "Things you have been asked to remember:", facts.map((f) => "- " + f.text).join("\n"));
  if (graph) parts.push("", "What the shared memory knows:", small ? graph.slice(0, 2500) + (graph.length > 2500 ? "\n(more: use recall)" : "") : graph);
  return parts.join("\n");
}

// What changes every turn goes in the user message, not the system prompt, so
// the cached prefix (tools + system) stays byte-identical between requests.
function contextLine(ctx) {
  const now = new Date();
  const when = now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const bits = ["It is " + when + "."];
  if (ctx && ctx.playing) bits.push("Playing: " + ctx.playing + ".");
  if (game.on) bits.push("A game is in front (" + (game.exe || "fullscreen") + ").");
  if (ctx && ctx.timers) bits.push("Timers: " + ctx.timers + ".");
  if (ctx && ctx.screen) bits.push("On screen: " + String(ctx.screen).slice(0, 300));
  return "[" + bits.join(" ") + "]";
}

// ---------------------------------------------------------------- providers --
let client = null, clientKey = null;
function claudeClient() {
  const key = H.readClaudeKey();
  if (!key) return null;
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key }); clientKey = key; }
  return client;
}

class UserFacing extends Error {}

async function claudeStep(conv, emit, signal, noTools) {
  if (!Anthropic) throw new UserFacing("The Anthropic SDK is missing from this build.");
  const c = claudeClient();
  if (!c) throw new UserFacing("There's no Claude API key yet. Add one in Jarvis settings.");
  const model = settings.claudeModel;
  const params = {
    model,
    max_tokens: 4096,
    system: [{ type: "text", text: systemPrompt(false), cache_control: { type: "ephemeral" } }],
    tools: claudeTools(),
    messages: withNudge(conv.messages, conv.nudge),
  };
  // The history holds tool calls, so the tools must stay declared; "none"
  // just stops new ones.
  if (noTools) params.tool_choice = { type: "none" };
  let stream;
  if (model === "claude-haiku-4-5") {
    stream = c.messages.stream(params, { signal });
  } else {
    // Sonnet 5.5 and Opus 5.5 think by default; low effort keeps a spoken
    // answer quick. A safety decline is re-served by the fallback model.
    stream = c.beta.messages.stream({
      ...params,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    }, { signal });
  }
  stream.on("text", (delta) => emit({ type: "text", delta }));
  try {
    const msg = await stream.finalMessage();
    return { content: msg.content, stop: msg.stop_reason, model: msg.model, usage: msg.usage };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new UserFacing("Claude rejected the API key. Check it in Jarvis settings.");
    if (e instanceof Anthropic.RateLimitError) throw new UserFacing("Claude is rate limiting me. Try again in a moment.");
    if (e instanceof Anthropic.APIConnectionError) throw new UserFacing("I can't reach Claude right now.");
    if (e instanceof Anthropic.APIError) throw new UserFacing("Claude returned an error (" + (e.status || "?") + ").");
    throw e;
  }
}

// Claude content blocks -> OpenAI chat messages for llama-server.
function toOpenAI(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "user") {
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const content = typeof r.content === "string" ? r.content
          : (r.content || []).map((x) => x.text || "").join("\n");
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: (r.is_error ? "ERROR: " : "") + content });
      }
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) out.push({ role: "user", content: text });
    } else {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: "assistant", content: text || "" };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    }
  }
  return out;
}

async function localStep(conv, emit, signal, noTools) {
  const base = settings.localUrl.replace(/\/+$/, "");
  const model = localModelNow();
  const ini = models.readIni(settings).find((m) => m.id === model);
  const big = isBig(model, ini && ini.file);
  if (local.loaded !== model) emit({ type: "status", text: "Waking " + model + "…" });
  let res;
  try {
    res = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 1500,
        messages: toOpenAI(systemPrompt(!big), withNudge(conv.messages, conv.nudge)),
        tools: openaiTools(big),
        tool_choice: noTools ? "none" : "auto",
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    local.up = false;
    throw new UserFacing("The local model isn't running.");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new UserFacing("The local model returned an error (" + res.status + "). " + t.slice(0, 120));
  }
  local.loaded = model;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", finish = null;
  const calls = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      if (j.error) throw new UserFacing("Local model error: " + (j.error.message || "unknown"));
      // llama-server puts its own timings on the last chunk: how much of the
      // prompt it had to read (vs reuse from cache) and how fast it wrote.
      if (j.timings) emit({ type: "timings", prompt: j.timings.prompt_n, cached: j.timings.cache_n, promptMs: Math.round(j.timings.prompt_ms), genMs: Math.round(j.timings.predicted_ms), tokens: j.timings.predicted_n });
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) { text += d.content; emit({ type: "text", delta: d.content }); }
      for (const tc of d.tool_calls || []) {
        const c = calls[tc.index] || (calls[tc.index] = { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function && tc.function.name) c.name += tc.function.name;
        if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls.filter(Boolean)) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch (e) { input = { _unparsed: c.args }; }
    content.push({ type: "tool_use", id: c.id || "call_" + Math.random().toString(36).slice(2, 10), name: c.name, input });
  }
  const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : (finish === "length" ? "max_tokens" : "end_turn");
  return { content, stop, model };
}

async function chooseProvider() {
  const hasKey = !!H.readClaudeKey() && !!Anthropic;
  if (settings.provider === "claude") return "claude";
  if (settings.provider === "local") return "local";
  const up = await localProbe(false);
  if (up) return "local";
  return hasKey ? "claude" : "local";
}

// ------------------------------------------------------------ conversations --
// A conversation ends after a few quiet minutes, the way asking Siri something
// new starts fresh while a follow-up keeps the thread.
const CONV_IDLE_MS = 5 * 60 * 1000;
const convs = new Map();
setInterval(() => {
  for (const [id, c] of convs) if (Date.now() - c.at > CONV_IDLE_MS) convs.delete(id);
}, 60000).unref();

function newConv() {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const c = { id, messages: [], at: Date.now(), pending: null, log: null };
  convs.set(id, c);
  return c;
}

// History of finished exchanges, for the Jarvis panel.
function historyFile() { return H.stateFile("jarvis-history.json"); }
let history = null;
function loadHistory() {
  if (history) return history;
  try { history = JSON.parse(fs.readFileSync(historyFile(), "utf8")); } catch (e) { history = []; }
  if (!Array.isArray(history)) history = [];
  return history;
}
function addHistory(entry) {
  loadHistory().unshift(entry);
  history = history.slice(0, 100);
  try { fs.writeFileSync(historyFile(), JSON.stringify(history)); } catch (e) {}
}

// A small model asked something it cannot find will search again and again
// with the same words (the 4B did eight in a row once). So: two searches per
// question, after which a search answers "use what you have" — and the last
// step runs with tools off, so every turn ends in an answer.
const MAX_STEPS = 6;
const MAX_SEARCHES = 2;

// ---- keeping him honest -------------------------------------------------------
// Before any tool has run in a turn, a reply is not spoken straight away when
// it claims an action ("Checking for updates now.", "Done.") or the request is
// about something only a tool can know. If the step then ends without a tool
// call, its text is dropped and the step runs again, once, with a reminder.
const CLAIM = /^\W*(?:(?:ok(?:ay)?|sure|right|alright|got it|of course|certainly|no problem)\W+)?(?:i'?ll|i will|i'?m (?:going to|now|on it)|let me|on it|(?:checking|setting|turning|playing|opening|installing|restarting|reloading|switching|muting|unmuting|pausing|resuming|skipping|starting|looking|searching|dimming|changing|joining|leaving|answering|declining|updating|downloading)|i'?ve|i have|done|all set|(?:set|turned|muted|unmuted|paused|resumed|skipped|opened|installed|switched|started|joined|answered|declined|dimmed|changed|updated|downloaded|added|removed|saved|remembered))\b/i;
const LIVE = /\b(updates?|version|cpu|gpu|vram|ram|temps?|temperatures?|hot|fps|battery|notifications?|texts?|messages?|calls?|calling|discord|channel|talking|volume|louder|quieter|mute|unmute|deafen|headphones?|headset|speakers?|mic|microphone|lights?|timers?|alarms?|weather|rain|forecast|play|pause|skip|song|playing|news|score|price|spent|usage|widgets?|theme|layout|scene|open|download|remember|weather)\b/i;
// "What is a GPU?" is a question about the world, not about this PC.
const KNOWLEDGE = /^\W*(?:(?:hey |ok |okay )?jarvis\W+)?(?:what(?:'s| is| are) (?:a|an|the difference)\b|what does .+ mean|define\b|explain\b|how (?:does|do) (?:a|an)\b|tell me (?:a joke|about (?:a|an)\b))/i;
const NUDGE = "(Reminder from Jarvis's own system, not from " + "the user: you answered without calling a tool. If this request needs one, and anything about the PC, the phone, Discord, sound, this app, music, the lights, timers, alarms, the weather or anything current does, call the right tool now and answer from its result. Never say you did, are doing or checked something you did not. If it truly needs no tool, give your answer again.)";

// The step's text, held back while it is still undecided whether it stands.
function honestEmit(emit, hold) {
  let buf = "", flushed = false, decided = !hold.claims && !hold.all;
  return {
    emit(ev) {
      if (ev.type !== "text" || decided) return emit(ev);
      buf += ev.delta;
      if (hold.all) return;
      // Only claims are watched: once the first sentence is in and is not one,
      // let it all through.
      const m = buf.match(/^[\s\S]*?[.!?](?:\s|$)/);
      if (!m && buf.length < 140) return;
      if (CLAIM.test((m ? m[0] : buf).trim())) { hold.all = true; return; }
      decided = true; flushed = true;
      emit({ type: "text", delta: buf }); buf = "";
    },
    text: () => buf,
    // The step is over: a short reply never reached a sentence end, so judge
    // what there is.
    settle() { if (!decided && !hold.all && CLAIM.test(buf.trim())) hold.all = true; },
    release() { if (buf) emit({ type: "text", delta: buf }); buf = ""; decided = true; flushed = true; },
    get flushed() { return flushed; },
  };
}

// The nudge rides on the latest user message for one step only; it is never
// kept in the conversation.
function withNudge(messages, nudge) {
  if (!nudge) return messages;
  const out = messages.slice();
  const i = out.length - 1;
  if (i < 0 || out[i].role !== "user") return messages;
  const blocks = typeof out[i].content === "string" ? [{ type: "text", text: out[i].content }] : out[i].content;
  out[i] = { role: "user", content: blocks.concat([{ type: "text", text: nudge }]) };
  return out;
}

async function runLoop(conv, emit, signal) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const provider = conv.provider;
    const last = step === MAX_STEPS - 1;
    emit({ type: "thinking", provider });
    // Watch only before the first tool of the turn, and only once.
    const watch = !last && !conv.nudged && conv.log.tools.length === 0;
    const heard = conv.log.heard || "";
    const hold = { claims: watch, all: watch && LIVE.test(heard) && !KNOWLEDGE.test(heard) };
    const h = honestEmit(emit, hold);
    const r = provider === "claude" ? await claudeStep(conv, h.emit, signal, last) : await localStep(conv, h.emit, signal, last);
    const usedTool = r.content.some((b) => b.type === "tool_use");
    h.settle();
    if (watch && !usedTool && hold.all && !h.flushed && r.stop !== "refusal") {
      // Claimed or answered without a tool: drop it, unheard, and try again.
      conv.nudged = { said: h.text().trim().slice(0, 200) };
      conv.nudge = NUDGE;
      step--;
      continue;
    }
    conv.nudge = null;
    h.release();
    conv.model = r.model;
    // Claude rejects an assistant turn with no content, and a conversation can
    // move to Claude after the local model came back with nothing at all.
    if (!r.content.length) r.content = [{ type: "text", text: "(no answer)" }];
    conv.messages.push({ role: "assistant", content: r.content });
    for (const b of r.content) if (b.type === "text") conv.log.reply += b.text;

    if (r.stop === "refusal") {
      const line = " I can't help with that one.";
      conv.log.reply += line;
      emit({ type: "text", delta: line });
      return "end";
    }
    if (r.stop === "pause_turn") continue;
    const uses = r.content.filter((b) => b.type === "tool_use");
    if (!uses.length) return "end";

    // A tool call cut off by max_tokens may carry a truncated input. Do not
    // run it on a guess.
    if (r.stop === "max_tokens") return "end";

    const serverUses = [], clientUses = [];
    for (const u of uses) {
      const def = toolByName.get(u.name);
      if (def && def.where === "client") clientUses.push(u); else serverUses.push(u);
      conv.log.tools.push(u.name);
    }
    const results = await Promise.all(serverUses.map(async (u) => {
      emit({ type: "tool", id: u.id, name: u.name, input: u.input, status: "running" });
      let out, isErr = false;
      try {
        if (!toolByName.has(u.name)) [out, isErr] = ["There is no tool called " + u.name, true];
        else if (u.name === "web_search" && ++conv.searches > MAX_SEARCHES) {
          [out, isErr] = ["You have already searched " + MAX_SEARCHES + " times for this question. Do not search again: " +
            "answer now from the results you have (read_page one of them if you need detail), or say you could not find it.", true];
        }
        else [out, isErr] = await runServerTool(u.name, u.input, emit);
      } catch (e) { out = "Tool failed: " + e.message; isErr = true; }
      emit({ type: "tool", id: u.id, name: u.name, status: "done", ok: !isErr });
      return { type: "tool_result", tool_use_id: u.id, content: String(out == null ? "" : out), ...(isErr ? { is_error: true } : {}) };
    }));

    if (clientUses.length) {
      conv.pending = { results, ids: clientUses.map((u) => u.id), order: uses.map((u) => u.id) };
      emit({ type: "client", calls: clientUses.map((u) => ({ id: u.id, name: u.name, input: u.input })) });
      return "client";
    }
    // Every result of one step goes back in a single user message.
    conv.messages.push({ role: "user", content: results });
  }
  return "end";
}

function finish(conv, emit) {
  addHistory({
    at: Date.now(), conv: conv.id, heard: conv.log.heard, reply: conv.log.reply.trim(),
    provider: conv.provider, model: conv.model || null, tools: conv.log.tools,
    // What he first said instead of using a tool, when the reminder caught it.
    ...(conv.nudged ? { caught: conv.nudged.said } : {}),
  });
  emit({ type: "done", conv: conv.id });
}

async function handleTurn(req, res) {
  H.readJsonBody(req, res, async (body) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
    const ctl = new AbortController();
    let closed = false;
    res.on("close", () => { closed = true; ctl.abort(); });
    const emit = (ev) => { if (!closed) { try { res.write(JSON.stringify(ev) + "\n"); } catch (e) {} } };

    let conv = body.conv && convs.get(body.conv);
    try {
      if (Array.isArray(body.results)) {
        // The panel finished the client-side tools of a step.
        if (!conv || !conv.pending) throw new UserFacing("That conversation has expired.");
        const byId = new Map(conv.pending.results.map((r) => [r.tool_use_id, r]));
        for (const r of body.results) {
          if (!conv.pending.ids.includes(r.id)) continue;
          byId.set(r.id, {
            type: "tool_result", tool_use_id: r.id, content: String(r.content == null ? "" : r.content).slice(0, 20000),
            ...(r.is_error ? { is_error: true } : {}),
          });
        }
        for (const id of conv.pending.ids) {
          if (!byId.has(id)) byId.set(id, { type: "tool_result", tool_use_id: id, content: "no result", is_error: true });
        }
        conv.messages.push({ role: "user", content: conv.pending.order.map((id) => byId.get(id)).filter(Boolean) });
        conv.pending = null;
      } else {
        const text = String(body.text || "").trim();
        if (!text) throw new UserFacing("I didn't catch that.");
        if (!conv || conv.pending) conv = newConv();
        // A provider switch mid-conversation is fine, but pick once per turn.
        conv.provider = await chooseProvider();
        conv.log = { heard: text, reply: "", tools: [] };
        conv.searches = 0;
        conv.nudged = null; conv.nudge = null;
        conv.messages.push({ role: "user", content: [{ type: "text", text: contextLine(body.context) + "\n" + text }] });
        emit({ type: "start", conv: conv.id, provider: conv.provider, model: conv.provider === "claude" ? settings.claudeModel : localModelNow() });
      }
      conv.at = Date.now();
      const outcome = await runLoop(conv, emit, ctl.signal);
      conv.at = Date.now();
      if (outcome === "end") finish(conv, emit);
    } catch (e) {
      if (e.name === "AbortError" || closed) { /* the panel went away */ }
      else {
        const msg = e instanceof UserFacing ? e.message : "Something went wrong: " + e.message;
        if (!(e instanceof UserFacing)) console.error("Jarvis turn failed:", e);
        emit({ type: "error", message: msg });
        // Drop the unanswered user message so the next attempt starts clean.
        if (conv && conv.messages.length && conv.messages[conv.messages.length - 1].role === "user") conv.messages.pop();
      }
    }
    try { res.end(); } catch (e) {}
  });
}

// ------------------------------------------------------------------- routes --
function publicSettings() {
  return { ...settings };
}

async function handle(req, res, urlPath) {
  const json = H.json;
  const sub = urlPath.slice("/api/jarvis/".length);

  if (sub === "events") return handleEvents(req, res);
  if (sub === "turn" && req.method === "POST") return handleTurn(req, res);

  if (sub === "status") {
    await localProbe(false);
    return json(res, 200, { ok: true, status: status() });
  }

  if (sub === "settings") {
    if (req.method === "GET") return json(res, 200, { ok: true, settings: publicSettings(), status: status() });
    return H.readJsonBody(req, res, (body) => {
      const err = saveSettings(body || {});
      if (err) return json(res, 500, { ok: false, error: err });
      local.checkedAt = 0;
      broadcast({ type: "settings", settings: publicSettings() });
      return json(res, 200, { ok: true, settings: publicSettings(), status: status() });
    });
  }

  if (sub === "key" && req.method === "POST") {
    return H.readJsonBody(req, res, (body) => {
      const key = String(body.key || "").trim();
      if (body.clear) { H.writeClaudeKey(""); client = null; return json(res, 200, { ok: true, status: status() }); }
      if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) return json(res, 400, { ok: false, error: "That doesn't look like an Anthropic API key (sk-ant-...)." });
      H.writeClaudeKey(key);
      client = null;
      broadcast({ type: "status", status: status() });
      // Never echo the key back, only whether there is one.
      return json(res, 200, { ok: true, status: status() });
    });
  }

  if (sub === "listen" && req.method === "POST") {
    return H.readJsonBody(req, res, (body) => {
      if (!voiceStart() || !voice.ready) return json(res, 503, { ok: false, error: voice.err || "The voice helper is starting." });
      const engine = sttEngine();
      voiceSend({ cmd: "listen", online: engine === "online", audio: engine === "whisper", maxSeconds: 20 });
      return json(res, 200, { ok: true, engine });
    });
  }
  // The helper's test hooks (feed it a WAV instead of the mic), for checking
  // recognition and interruptions without anyone speaking.
  if (sub === "voice-test" && req.method === "POST") {
    return H.readJsonBody(req, res, (body) => {
      if (!/^test-/.test(String(body.cmd || ""))) return json(res, 400, { ok: false, error: "test commands only" });
      if (!voiceStart() || !voice.ready) return json(res, 503, { ok: false, error: "voice helper not ready" });
      voiceSend(body);
      return json(res, 200, { ok: true });
    });
  }
  if (sub === "cancel" && req.method === "POST") {
    voiceSend({ cmd: "cancel" });
    return json(res, 200, { ok: true });
  }
  if (sub === "speaking" && req.method === "POST") {
    return H.readJsonBody(req, res, (body) => {
      // The sentence being said goes along, so his own voice coming back
      // through the speakers cannot interrupt him.
      voiceSend({ cmd: "speaking", on: !!body.on, text: String(body.text || "").slice(0, 600) });
      return json(res, 200, { ok: true });
    });
  }

  if (sub === "tts" && req.method === "POST") {
    return H.readJsonBody(req, res, async (body) => {
      const r = await speak(String(body.text || ""));
      if (r.error || !r.data) return json(res, 503, { ok: false, error: r.error || "no audio" });
      const buf = Buffer.from(r.data, "base64");
      res.writeHead(200, { "Content-Type": r.mime || "audio/wav", "Content-Length": buf.length, "Cache-Control": "no-store" });
      return res.end(buf);
    });
  }

  if (sub === "memory") {
    const view = () => (graphMode()
      ? { mode: "graph", file: settings.graphFile, user: userEntity(), server: memoryServer.up, ...readGraph() }
      : { mode: "local", facts: loadFacts() });
    if (req.method === "GET") return json(res, 200, { ok: true, ...view() });
    return H.readJsonBody(req, res, async (body) => {
      const r = body.forget ? await forget(body.forget, body.entity) : await remember(body.fact, body.about, body.type);
      broadcast({ type: "memory" });
      return json(res, r.ok ? 200 : 400, { ...r, ...view() });
    });
  }

  // ---- local models: the list, and fetching new ones ----
  if (sub === "models" && req.method === "GET") {
    await localProbe(false);
    return json(res, 200, { ok: true, models: localModels(), needsRestart: local.needsRestart, downloads: models.list(), dir: models.modelsDir(settings) });
  }
  // ---- YouTube search, for the panel's youtube tool ----
  if (sub === "youtube" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams.get("q") || "";
    return json(res, 200, await web.youtubeSearch(q, 6));
  }
  // ---- Govee lights ----
  if (sub === "lights") {
    if (req.method === "GET") return json(res, 200, { ok: true, ...govee.status() });
    return H.readJsonBody(req, res, async (body) => {
      const r = await govee.control(body || {});
      return json(res, 200, { ...r, lights: govee.status() });
    });
  }
  if (sub === "lights/key" && req.method === "POST") {
    return H.readJsonBody(req, res, async (body) => {
      let count = null;
      if (body.clear) govee.writeKey("");
      else {
        const k = String(body.key || "").trim();
        if (!/^[A-Za-z0-9-]{20,80}$/.test(k)) return json(res, 400, { ok: false, error: "That doesn't look like a Govee API key." });
        const r = await govee.saveKey(k);   // checked with Govee before it is kept
        if (!r.ok) return json(res, 200, { ok: false, error: r.error, lights: govee.status() });
        count = r.count;
      }
      // Never echoed back, only whether there is one.
      return json(res, 200, { ok: true, count, lights: govee.status() });
    });
  }
  if (sub === "models/find" && req.method === "POST") {
    return H.readJsonBody(req, res, async (body) => {
      let r;
      try { r = await models.find(body.query, body.quant); } catch (e) { r = { ok: false, error: e.message }; }
      return json(res, r.ok ? 200 : 400, r);
    });
  }
  if ((sub === "models/plan" || sub === "models/download") && req.method === "POST") {
    return H.readJsonBody(req, res, async (body) => {
      let p;
      try { p = await models.plan(body || {}, settings); } catch (e) { p = { ok: false, error: e.message }; }
      if (!p.ok || sub === "models/plan") return json(res, p.ok ? 200 : 400, p);
      const r = models.start(p, H);
      broadcast({ type: "status", status: status() });
      return json(res, r.ok ? 200 : 400, r);
    });
  }
  if (sub === "models/installed" && req.method === "POST") {
    // Called by the download window when curl is done.
    return H.readJsonBody(req, res, async (body) => {
      const r = models.register(String(body.id || ""), settings);
      await localProbe(true);
      broadcast({ type: "downloaded", result: r, status: status() });
      return json(res, r.ok ? 200 : 400, r);
    });
  }

  if (sub === "history") return json(res, 200, { ok: true, history: loadHistory().slice(0, 50) });

  if (sub === "home" && req.method === "POST") {
    return H.readJsonBody(req, res, async (body) => {
      const place = String(body.place || "").trim();
      if (!place) { saveSettings({ home: null }); return json(res, 200, { ok: true, settings: publicSettings() }); }
      let loc = null;
      try { loc = await web.geocode(place); } catch (e) {}
      if (!loc) return json(res, 400, { ok: false, error: "Couldn't find " + place + "." });
      saveSettings({ home: loc });
      return json(res, 200, { ok: true, settings: publicSettings() });
    });
  }

  if (sub === "local") {
    if (req.method === "GET") { await localProbe(true); return json(res, 200, { ok: true, status: status() }); }
    return H.readJsonBody(req, res, async (body) => {
      let r;
      if (body.action === "start") r = localStart();
      else if (body.action === "stop") r = await localStop();
      else if (body.action === "restart") r = await localRestart();
      else if (body.action === "edit") r = localEdit();
      else r = { ok: false, error: "unknown action" };
      broadcast({ type: "status", status: status() });
      return json(res, r.ok ? 200 : 400, { ...r, status: status() });
    });
  }

  return json(res, 404, { ok: false, error: "unknown jarvis route" });
}

// -------------------------------------------------------------------- init --
function init(host) {
  H = host;
  loadSettings();
  govee.init(H.DATA);
  // The wake word is resident: start the helper with the server when it is on,
  // rather than waiting for the panel to ask.
  if (settings.wake) setTimeout(voiceStart, 1500);
  // whisper-server is a child of this process; Windows does not take children
  // down with their parent, so stop it on the way out.
  process.on("exit", () => { whisperStop(); kokoroStop(); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { whisperStop(); kokoroStop(); process.exit(0); });
  // Load the voice now, so the first answer is not the one that waits for it.
  if (ttsEngine() === "kokoro") setTimeout(kokoroStart, 2500);
  // Keep the local model's status fresh for the panel without a request.
  setInterval(() => { localProbe(true).then(() => broadcast({ type: "status", status: status() })); }, 15000).unref();
  // While anything is downloading, the island shows its progress.
  setInterval(() => {
    const live = models.list().filter((d) => !d.registered && !d.error);
    if (live.length) broadcast({ type: "downloads", downloads: models.list() });
  }, 2000).unref();
  migrateFacts().catch(() => {});
}

module.exports = {
  init, handle,
  STATE_FILES: ["jarvis.json", "jarvis-memory.json", "jarvis-history.json"].concat(govee.STATE_FILES),
  // For test harnesses: run one server-side tool as a model would.
  runServerTool, TOOLS,
};
