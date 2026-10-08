// ============================================================================
//  Jarvis's local models: what is installed, and fetching new ones.
//
//  "Jarvis, download Qwen 3.5 27B" goes:
//    find      Hugging Face's API: GGUF repos for the words, and every .gguf
//              file in the best few with its size (split files counted as one)
//    choose    the quant that fits the card — a 4-bit one under ~14.8 GB on a
//              16 GB GPU — with the rest listed in case you want another
//    confirm   the panel shows the file, its size and where it comes from, and
//              opens the model's page; nothing downloads until you tap
//    download  a visible cmd window running curl.exe (resumable: -C -) into
//              the models folder, as <file>.part until it is complete
//    install   the script tells the server when it is done; the server checks
//              the size and the GGUF magic and adds a section to
//              jarvis-models.ini, so the model is one restart away
//
//  Only .gguf files, only over https, only into the models folder, and they are
//  weights, never run. A gated repo (Llama, Gemma) needs a Hugging Face login
//  this does not have; curl then fails with 401/403 and the window says so.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis/3.1 (Y70 dashboard)";
const GB = 1024 * 1024 * 1024;
// What fits the RTX 4080 SUPER's 16 GB with room for the KV cache.
const FIT_BYTES = 14.8 * GB;
// Preferred quants, best first: good quality per byte at 4 bits, then smaller.
const QUANT_RANK = ["UD-Q4_K_XL", "Q4_K_M", "IQ4_XS", "Q4_K_S", "IQ4_NL", "Q4_0", "UD-Q3_K_XL", "Q3_K_M", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0"];

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- the models folder and its preset --------------------------------------
function modelsDir(settings) {
  if (settings.localBat) return path.dirname(settings.localBat);
  return "E:\\OLLAMAMODEL2026\\gguf";
}
function iniPath(settings) { return path.join(modelsDir(settings), "jarvis-models.ini"); }

// [id] sections and their model= lines, and mmproj= (the vision add-on: a
// model with one can look at the screen).
function readIni(settings) {
  let text = "";
  try { text = fs.readFileSync(iniPath(settings), "utf8"); } catch (e) { return []; }
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { cur = { id: sec[1].trim(), file: null, mmproj: null }; out.push(cur); continue; }
    const kv = line.match(/^model\s*=\s*(.+)$/);
    if (kv && cur) cur.file = kv[1].trim();
    const mp = line.match(/^mmproj\s*=\s*(.+)$/);
    if (mp && cur) cur.mmproj = mp[1].trim();
  }
  return out;
}

// ---- finding ---------------------------------------------------------------
const PART = /-(\d{5})-of-(\d{5})\.gguf$/i;

// The quant tag, wherever the name puts it: "...-UD-Q4_K_XL.gguf" at the end,
// "gemma-4-E4B_q4_0-it.gguf" in the middle.
function quantOf(file) {
  const base = path.basename(file).replace(PART, ".gguf").replace(/\.gguf$/i, "");
  for (const q of QUANT_RANK) if (new RegExp("(^|[-_.])" + q.replace(/_/g, "[_-]") + "($|[-_.])", "i").test(base)) return q;
  const m = base.match(/(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|Q\d_[A-Z]+|BF16|F16|F32))(?=$|[-_.])/i);
  return m ? m[1].toUpperCase() : base.slice(-24);
}

// Not a model: vision/audio projectors, multi-token-prediction draft heads,
// and anything too small to be weights a person would ask for.
const HELPER = /(^|[-_.\/])(mmproj|mtp|projector|vision|audio|clip|encoder)([-_.]|$)/i;
const MIN_MODEL_BYTES = 150 * 1024 * 1024;

// All .gguf weights in a repo, split files folded into one entry.
async function repoFiles(repo) {
  const list = await getJson("https://huggingface.co/api/models/" + repo + "/tree/main?recursive=true");
  const groups = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (f.type !== "file" || !/\.gguf$/i.test(f.path) || HELPER.test(path.basename(f.path))) continue;
    const size = (f.lfs && f.lfs.size) || f.size || 0;
    const m = f.path.match(PART);
    const key = m ? f.path.replace(PART, "") : f.path;
    let g = groups.get(key);
    if (!g) { g = { path: m ? null : f.path, parts: [], size: 0 }; groups.set(key, g); }
    g.parts.push(f.path);
    g.size += size;
    if (m && m[1] === "00001") g.path = f.path;
  }
  return [...groups.values()].filter((g) => g.path && g.size >= MIN_MODEL_BYTES).map((g) => ({
    path: g.path, parts: g.parts.sort(), size: g.size,
    sizeGB: +(g.size / GB).toFixed(2), quant: quantOf(g.path), fits: g.size <= FIT_BYTES,
  }));
}

function rankFiles(files, quant) {
  const want = quant ? String(quant).toUpperCase().replace(/\s+/g, "") : "";
  const rank = (f) => {
    if (want && f.quant.replace(/_/g, "") === want.replace(/_/g, "")) return -1;
    const i = QUANT_RANK.indexOf(f.quant);
    return i < 0 ? 99 : i;
  };
  return files.slice().sort((a, b) => (b.fits - a.fits) || (rank(a) - rank(b)) || (b.size - a.size));
}

async function find(query, quant) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "what model?" };
  // A repo id or a Hugging Face link goes straight to that repo.
  const direct = q.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/i) || q.match(/^([\w.-]+\/[\w.-]+)$/);
  let repos;
  if (direct) repos = [{ id: direct[1] }];
  else {
    repos = await getJson("https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=8&search=" +
      encodeURIComponent(q.replace(/\bgguf\b/ig, "").trim()));
  }
  const out = [];
  for (const r of (repos || []).slice(0, 4)) {
    let files = [];
    try { files = rankFiles(await repoFiles(r.id), quant); } catch (e) { continue; }
    if (!files.length) continue;
    out.push({
      repo: r.id, page: "https://huggingface.co/" + r.id,
      downloads: r.downloads || 0, likes: r.likes || 0, updated: (r.lastModified || "").slice(0, 10),
      best: files[0], others: files.slice(1, 6),
    });
  }
  if (!out.length) return { ok: false, error: "no GGUF builds found for " + q };
  return { ok: true, query: q, results: out };
}

// ---- downloading ------------------------------------------------------------
const downloads = new Map();          // id -> { id, name, dir, files: [{url, name, size}], total, repo, page, startedAt, done, registered, error }

const safeName = (s) => /^[A-Za-z0-9._-]+\.gguf$/.test(s);
// Only characters a URL needs; the % is doubled when it goes into the .cmd.
const safeUrl = (u) => /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*$/.test(u) && !/["^<>|`]/.test(u);

function idFor(name) {
  return name.replace(PART, ".gguf").replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function headSize(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return Number(r.headers.get("content-length")) || 0;
  } finally { clearTimeout(t); }
}

// What would be downloaded, before anything is: from a Hugging Face repo and
// file, or from any https link ending in .gguf.
async function plan(req, settings) {
  const dir = modelsDir(settings);
  if (req.repo) {
    const repo = String(req.repo).trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "bad repo id" };
    const files = await repoFiles(repo);
    let pick = null;
    if (req.file) {
      const want = String(req.file).trim();
      pick = files.find((f) => f.path === want || path.basename(f.path) === want || f.parts.includes(want) ||
        f.quant.toUpperCase() === want.toUpperCase());
    } else pick = rankFiles(files, req.quant)[0];
    if (!pick) return { ok: false, error: "that file is not in " + repo };
    const parts = pick.parts.map((p) => ({
      url: "https://huggingface.co/" + repo + "/resolve/main/" + p.split("/").map(encodeURIComponent).join("/"),
      name: path.basename(p),
      size: 0,
    }));
    // Sizes per part, from the listing.
    const list = await getJson("https://huggingface.co/api/models/" + repo + "/tree/main?recursive=true");
    for (const p of parts) {
      const f = list.find((x) => path.basename(x.path) === p.name);
      p.size = (f && ((f.lfs && f.lfs.size) || f.size)) || 0;
    }
    if (!parts.every((p) => safeName(p.name))) return { ok: false, error: "unexpected file name" };
    return {
      ok: true, id: idFor(parts[0].name), name: parts[0].name, dir, files: parts,
      total: parts.reduce((s, p) => s + p.size, 0), source: "huggingface.co/" + repo,
      page: "https://huggingface.co/" + repo, repo, quant: pick.quant,
    };
  }
  if (req.url) {
    const url = String(req.url).trim();
    if (!safeUrl(url)) return { ok: false, error: "only plain https links can be downloaded" };
    let name = "";
    try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch (e) {}
    if (!safeName(name)) return { ok: false, error: "the link must point straight at a .gguf file" };
    const size = await headSize(url).catch(() => 0);
    return {
      ok: true, id: idFor(name), name, dir, files: [{ url, name, size }], total: size,
      source: new URL(url).hostname, page: url, repo: null, quant: quantOf(name),
    };
  }
  return { ok: false, error: "give a repo and file, or a link" };
}

// The window the download runs in. Pure ASCII, % doubled: cmd reads .cmd
// files in the OEM code page and expands %... even inside quotes.
function script(p, port) {
  const L = [];
  L.push("@echo off");
  L.push("title Jarvis is downloading " + p.name);
  L.push("cd /d \"" + p.dir + "\"");
  L.push("echo Downloading " + p.name + " (" + (p.total / GB).toFixed(2) + " GB)");
  L.push("echo from " + p.source);
  L.push("echo into " + p.dir);
  L.push("echo It resumes where it left off if you run this again.");
  L.push("echo.");
  for (const f of p.files) {
    L.push("if exist \"" + f.name + "\" goto skip_" + f.name.replace(/[^A-Za-z0-9]/g, "_"));
    L.push("curl.exe -L --fail --retry 5 --retry-delay 3 -C - -o \"" + f.name + ".part\" \"" + f.url.replace(/%/g, "%%") + "\"");
    L.push("if errorlevel 1 goto failed");
    L.push("move /y \"" + f.name + ".part\" \"" + f.name + "\" >nul");
    L.push(":skip_" + f.name.replace(/[^A-Za-z0-9]/g, "_"));
  }
  L.push("echo.");
  L.push("echo Download finished. Telling Jarvis...");
  L.push("curl.exe -s -m 15 -X POST -H \"Content-Type: application/json\" --data \"{\\\"id\\\":\\\"" + p.id + "\\\"}\" http://127.0.0.1:" + port + "/api/jarvis/models/installed");
  L.push("echo.");
  L.push("echo All done. This window closes in 20 seconds.");
  L.push("timeout /t 20 >nul");
  L.push("exit /b 0");
  L.push(":failed");
  L.push("echo.");
  L.push("echo The download failed. A 401 or 403 means the repo needs a Hugging Face login.");
  L.push("echo Run this file again to resume: %~f0");
  L.push("pause");
  return L.join("\r\n") + "\r\n";
}

function start(p, H) {
  if (!fs.existsSync(p.dir)) return { ok: false, error: "the models folder " + p.dir + " does not exist" };
  if (p.files.every((f) => fs.existsSync(path.join(p.dir, f.name)))) {
    downloads.set(p.id, { ...p, startedAt: Date.now(), done: true });
    return { ok: true, already: true, ...summary(p.id) };
  }
  const dir = path.join(H.DATA, "downloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, p.id + ".cmd");
  fs.writeFileSync(file, script(p, H.PORT), "ascii");
  // Its own console window, like your model bats, so you can watch it and
  // close it to stop.
  const child = spawn("cmd.exe", ["/c", "start", "\"Jarvis download\"", "cmd", "/c", "\"" + file + "\""], {
    detached: true, stdio: "ignore", windowsVerbatimArguments: true,
  });
  child.unref();
  downloads.set(p.id, { ...p, startedAt: Date.now(), done: false, registered: false, error: null, script: file });
  return { ok: true, ...summary(p.id) };
}

// Progress is read off the disk: the finished parts plus the growing .part.
function summary(id) {
  const d = downloads.get(id);
  if (!d) return null;
  let have = 0, complete = true;
  for (const f of d.files) {
    const full = path.join(d.dir, f.name);
    try { have += fs.statSync(full).size; continue; } catch (e) {}
    complete = false;
    try { have += fs.statSync(full + ".part").size; } catch (e) {}
  }
  if (complete && d.files.length) d.done = true;
  return {
    id: d.id, name: d.name, source: d.source, page: d.page, quant: d.quant,
    totalGB: +(d.total / GB).toFixed(2), haveGB: +(have / GB).toFixed(2),
    percent: d.total ? Math.min(100, Math.round((have / d.total) * 100)) : null,
    done: d.done, registered: !!d.registered, error: d.error || null,
  };
}
function list() { return [...downloads.keys()].map(summary).filter(Boolean); }

// Checks the finished file and adds it to jarvis-models.ini. GPU layers are
// left unset on purpose: llama.cpp's --fit (on by default) sizes them to the
// card, which a guess here could not.
function register(id, settings) {
  const d = downloads.get(id);
  if (!d) return { ok: false, error: "unknown download" };
  const first = path.join(d.dir, d.files[0].name);
  for (const f of d.files) {
    const full = path.join(d.dir, f.name);
    let st;
    try { st = fs.statSync(full); } catch (e) { d.error = "missing " + f.name; return { ok: false, error: d.error }; }
    if (f.size && st.size !== f.size) { d.error = f.name + " is " + st.size + " bytes, expected " + f.size; return { ok: false, error: d.error }; }
  }
  const fd = fs.openSync(first, "r");
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (magic.toString("ascii") !== "GGUF") { d.error = "not a GGUF file"; return { ok: false, error: d.error }; }

  const ini = iniPath(settings);
  const known = readIni(settings);
  if (known.some((m) => m.file && path.resolve(m.file) === path.resolve(first))) {
    d.registered = true;
    return { ok: true, id: known.find((m) => path.resolve(m.file) === path.resolve(first)).id, already: true };
  }
  let sec = d.id;
  for (let n = 2; known.some((m) => m.id === sec); n++) sec = d.id + "-" + n;
  const block = [
    "",
    "[" + sec + "]",
    "; Added by Jarvis on " + new Date().toISOString().slice(0, 10) + " from " + d.source + ".",
    "; GPU layers are left to llama.cpp's --fit. Set n-gpu-layers to override.",
    "model = " + first,
    "ctx-size = 16384",
    "flash-attn = on",
    "cache-type-k = q8_0",
    "cache-type-v = q8_0",
    "parallel = 1",
    "",
  ].join("\r\n");
  fs.appendFileSync(ini, block, "utf8");
  d.registered = true;
  return { ok: true, id: sec, ini };
}

module.exports = { find, plan, start, list, summary, register, readIni, modelsDir, iniPath, GB };
