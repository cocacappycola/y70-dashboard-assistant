// ============================================================================
//  Tool packages: tools for Jarvis that live outside the dashboard's code.
//
//  A package is a folder with a jarvis-package.json manifest (its tools, each
//  with a JSON schema, and the command that runs it) and the program itself,
//  in any language. Installed packages live in <data>/jarvis-packages/<name>.
//  The guide is docs/PACKAGES.md; packages-examples/ has two to copy.
//
//  - Each package runs as its own process, started on its first call and
//    stopped after ten idle minutes, talking JSON lines over stdin/stdout. A
//    package that crashes or hangs fails its call, never Jarvis.
//  - Nothing runs until you enable it, and enabling records a fingerprint of
//    every file. If any file changes afterwards (Jarvis editing it, an
//    update), the package is off again until you enable it again.
//  - Its tools join Jarvis's own, named as the manifest says; a name that
//    clashes with one of his or another package's is refused.
// ============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const MANIFEST = "jarvis-package.json";
const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const TOOL = /^[a-z][a-z0-9_]{1,40}$/;
const IDLE_MS = 10 * 60 * 1000;
const SKIP = new Set(["data", "node_modules", ".git", "__pycache__", ".venv", "venv"]);

let dir = null, root = null, stateFile = null;
let state = { enabled: {} };          // name -> { fp, at }
let pkgs = new Map();                 // name -> package record
let reserved = () => new Set();       // the built-in tool names
const procs = new Map();              // name -> running process record

function init(o) {
  dir = path.join(o.dataDir, "jarvis-packages");
  root = o.root;
  reserved = o.reserved || reserved;
  fs.mkdirSync(dir, { recursive: true });
  stateFile = path.join(dir, "packages.json");
  try { state = { enabled: {}, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch (e) {}
  scan();
}
function save() { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) {} }

// ---- reading packages ------------------------------------------------------------
function readManifest(pdir) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(pdir, MANIFEST), "utf8")); } catch (e) { return { error: "no readable " + MANIFEST + (e.code === "ENOENT" ? "" : ": " + e.message) }; }
  const problems = [];
  if (!m || typeof m !== "object") return { error: MANIFEST + " is not an object" };
  if (!NAME.test(String(m.name || ""))) problems.push("name must be lowercase letters, digits and dashes (2-40), starting with a letter");
  if (!Array.isArray(m.run) || !m.run.length || !m.run.every((x) => typeof x === "string")) problems.push("run must be a command as a list, e.g. [\"node\", \"index.js\"]");
  if (!Array.isArray(m.tools) || !m.tools.length) problems.push("tools must list at least one tool");
  for (const t of Array.isArray(m.tools) ? m.tools : []) {
    if (!TOOL.test(String(t.name || ""))) problems.push("tool name \"" + t.name + "\" must be lowercase letters, digits and underscores, starting with a letter");
    if (!t.description || String(t.description).length < 10) problems.push("tool " + t.name + " needs a description (it is how Jarvis knows when to use it)");
    if (!t.input_schema || t.input_schema.type !== "object") problems.push("tool " + t.name + " needs an input_schema of type object");
  }
  return { manifest: m, problems };
}

// Every file but the package's data, hashed: what "enabled" approved.
function fingerprint(pdir) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + "/");
      else { h.update(rel + e.name + "\0"); try { h.update(fs.readFileSync(p)); } catch (err) {} }
    }
  };
  walk(pdir, "");
  return h.digest("hex");
}

function scan() {
  const next = new Map();
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) {}
  const builtin = reserved();
  const taken = new Map();               // tool -> package, among enabled ones
  for (const n of names.sort()) {
    const pdir = path.join(dir, n);
    const r = readManifest(pdir);
    const rec = { name: n, dir: pdir, manifest: r.manifest || null, problems: r.error ? [r.error] : r.problems, tools: [] };
    if (rec.manifest && rec.manifest.name !== n) rec.problems.push("its folder must be named like it (" + rec.manifest.name + ")");
    const on = state.enabled[n];
    rec.fp = rec.manifest ? fingerprint(pdir) : null;
    rec.changed = !!(on && rec.fp !== on.fp);
    rec.enabled = !!on && !rec.changed && !rec.problems.length;
    for (const t of (rec.manifest && rec.manifest.tools) || []) {
      if (builtin.has(t.name)) { rec.problems.push("tool " + t.name + " has the name of one of Jarvis's own"); rec.enabled = false; continue; }
      if (rec.enabled && taken.has(t.name)) { rec.problems.push("tool " + t.name + " is already package " + taken.get(t.name) + "'s"); rec.enabled = false; continue; }
      rec.tools.push(t);
    }
    if (rec.enabled) for (const t of rec.tools) taken.set(t.name, n);
    next.set(n, rec);
  }
  // A package that went away or changed stops.
  for (const [n] of procs) if (!next.has(n) || !next.get(n).enabled) stop(n);
  pkgs = next;
  return pkgs;
}

function publicPkg(p) {
  const m = p.manifest || {};
  const proc = procs.get(p.name);
  return {
    name: p.name, version: m.version || "", description: m.description || "", author: m.author || "", guide: m.guide || "",
    run: m.run || [], permissions: m.permissions || [], dir: p.dir,
    enabled: p.enabled, changed: p.changed, problems: p.problems,
    tools: p.tools.map((t) => ({ name: t.name, description: t.description })),
    running: !!(proc && proc.child), calls: proc ? proc.calls : 0, lastError: proc ? proc.lastError : null,
  };
}
function list() { return [...pkgs.values()].map(publicPkg); }

function examples() {
  const ex = path.join(root, "packages-examples");
  let names = [];
  try { names = fs.readdirSync(ex, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) {}
  return names.map((n) => {
    const r = readManifest(path.join(ex, n));
    const m = r.manifest || {};
    return { name: n, description: m.description || "", tools: (m.tools || []).map((t) => t.name), installed: pkgs.has(n), run: m.run || [] };
  });
}

// What the model is offered: the enabled packages' tools.
function tools() {
  const out = [];
  for (const p of pkgs.values()) {
    if (!p.enabled) continue;
    for (const t of p.tools) out.push({ name: t.name, description: t.description, input_schema: t.input_schema, where: "server", core: t.core !== false, pkg: p.name, guide: t.guide || (p.manifest && p.manifest.guide) || "" });
  }
  return out;
}
function owner(toolName) {
  for (const p of pkgs.values()) if (p.enabled && p.tools.some((t) => t.name === toolName)) return p;
  return null;
}
const has = (toolName) => !!owner(toolName);

// ---- running them -------------------------------------------------------------------
// run[0] "node" is this very Node (Electron's, in the app); "python" and
// "powershell" are the system's; anything else must be a program inside the
// package.
function command(p) {
  const run = p.manifest.run;
  const env = { ...process.env, JARVIS_PACKAGE: p.name, JARVIS_PACKAGE_DIR: p.dir, JARVIS_DATA_DIR: path.join(p.dir, "data"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  const [head, ...rest] = run;
  if (head === "node") return { cmd: process.execPath, args: rest, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  if (head === "python" || head === "py") return { cmd: head, args: rest, env };
  if (head === "powershell" || head === "pwsh") return { cmd: head === "pwsh" ? "pwsh.exe" : "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...rest], env };
  const exe = path.resolve(p.dir, head);
  if (!exe.toLowerCase().startsWith(p.dir.toLowerCase() + path.sep)) throw new Error("run must start with node, python, powershell, or a program inside the package");
  return { cmd: exe, args: rest, env };
}

function log(rec, line) {
  rec.logs.push(new Date().toTimeString().slice(0, 8) + " " + String(line).slice(0, 500));
  if (rec.logs.length > 300) rec.logs.splice(0, rec.logs.length - 300);
}

function start(p) {
  let rec = procs.get(p.name);
  if (rec && rec.child) return rec;
  rec = rec || { logs: [], calls: 0, lastError: null, seq: 0, waiters: new Map(), child: null, buf: "", idle: null };
  procs.set(p.name, rec);
  const c = command(p);
  fs.mkdirSync(path.join(p.dir, "data"), { recursive: true });
  const child = spawn(c.cmd, c.args, { cwd: p.dir, env: c.env, windowsHide: true });
  rec.child = child;
  log(rec, "started: " + [c.cmd === process.execPath ? "node" : c.cmd, ...c.args].join(" "));
  child.stdout.on("data", (d) => {
    if (rec.child !== child) return;
    rec.buf += d.toString();
    let i;
    while ((i = rec.buf.indexOf("\n")) >= 0) {
      const line = rec.buf.slice(0, i).trim();
      rec.buf = rec.buf.slice(i + 1);
      if (!line) continue;
      let m = null;
      if (line[0] === "{") { try { m = JSON.parse(line); } catch (e) {} }
      if (!m) { log(rec, "out: " + line); continue; }
      if (m.type === "log") { log(rec, String(m.text || "")); continue; }
      if (m.type === "result" && rec.waiters.has(m.id)) { const w = rec.waiters.get(m.id); rec.waiters.delete(m.id); w(m); }
    }
    if (rec.buf.length > 4e6) rec.buf = "";
  });
  child.stderr.on("data", (d) => { for (const l of d.toString().split(/\r?\n/)) if (l.trim()) log(rec, "err: " + l); });
  // Calls belong to the process they were sent to: a stopped one exiting late
  // must not fail (or forget) the calls of the one that replaced it.
  const waiters = rec.waiters = new Map();
  child.on("error", (e) => { rec.lastError = e.message; log(rec, "could not start: " + e.message); });
  child.on("exit", (code) => {
    log(rec, "exited" + (code != null ? " (" + code + ")" : ""));
    if (rec.child === child) { rec.child = null; rec.buf = ""; }
    for (const [, w] of waiters) w({ error: "the package stopped" + (code ? " (exit " + code + ")" : "") + "; see its log" });
    waiters.clear();
  });
  return rec;
}

function stop(name) {
  const rec = procs.get(name);
  if (rec && rec.child) { try { rec.child.kill(); } catch (e) {} }
  if (rec) rec.child = null;
}
function stopAll() { for (const [n] of procs) stop(n); }

// One call: [text for the model, isError, card?]
function callPkg(p, toolName, input, ctx) {
  return new Promise((resolve) => {
    let rec;
    try { rec = start(p); } catch (e) { return resolve(["Package " + p.name + " can't start: " + e.message, true]); }
    rec.calls++;
    clearTimeout(rec.idle);
    rec.idle = setTimeout(() => stop(p.name), IDLE_MS);
    rec.idle.unref && rec.idle.unref();
    const id = "c" + (++rec.seq);
    const secs = Math.max(2, Math.min(600, Number(p.manifest.timeout) || 60));
    const timer = setTimeout(() => {
      rec.waiters.delete(id);
      rec.lastError = toolName + " took longer than " + secs + " s";
      log(rec, rec.lastError + ": stopped it");
      stop(p.name);
      resolve(["The " + p.name + " package didn't answer within " + secs + " s.", true]);
    }, secs * 1000);
    rec.waiters.set(id, (m) => {
      clearTimeout(timer);
      if (m.error && m.content == null) { rec.lastError = String(m.error); return resolve([String(m.error), true]); }
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content == null ? "" : m.content);
      if (m.error) rec.lastError = content.slice(0, 200);
      resolve([content.slice(0, 20000), !!m.error, m.card && typeof m.card === "object" ? m.card : null]);
    });
    try {
      const line = JSON.stringify({ type: "call", id, tool: toolName, input: input || {}, context: ctx || {} })
        .replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
      rec.child.stdin.write(line + "\n");
    } catch (e) { rec.waiters.delete(id); clearTimeout(timer); resolve(["Couldn't reach the package: " + e.message, true]); }
  });
}

function call(toolName, input, ctx) {
  const p = owner(toolName);
  if (!p) return Promise.resolve(["No enabled package has a tool called " + toolName + ".", true]);
  return callPkg(p, toolName, input, ctx);
}
// A tool of a package that isn't enabled (yet): only after a yes.
function test(name, toolName, input, ctx) {
  scan();
  const p = pkgs.get(name);
  if (!p || !p.manifest) return Promise.resolve(["No package called " + name + ".", true]);
  if (p.problems.length) return Promise.resolve(["Package " + name + " has problems: " + p.problems.join("; "), true]);
  if (!p.tools.some((t) => t.name === toolName)) return Promise.resolve([name + " has no tool called " + toolName + " (it has " + p.tools.map((t) => t.name).join(", ") + ").", true]);
  stop(name);                      // the code may have just changed: a fresh process
  return callPkg(p, toolName, input, ctx);
}

// ---- managing ---------------------------------------------------------------------------
function enable(name) {
  scan();
  const p = pkgs.get(name);
  if (!p || !p.manifest) return { ok: false, error: "No package called " + name + "." };
  if (p.problems.length) return { ok: false, error: "Fix these first: " + p.problems.join("; ") };
  state.enabled[name] = { fp: p.fp, at: Date.now() };
  save();
  stop(name);
  scan();
  return { ok: true, package: publicPkg(pkgs.get(name)) };
}
function disable(name) {
  delete state.enabled[name];
  save();
  stop(name);
  scan();
  return { ok: true };
}

// To the Recycle Bin, so a mistake can be undone.
function remove(name) {
  const p = pkgs.get(name);
  if (!p) return Promise.resolve({ ok: false, error: "No package called " + name + "." });
  disable(name);
  return new Promise((resolve) => {
    const lit = "'" + p.dir.replace(/'/g, "''") + "'";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(" + lit + ", 'OnlyErrorDialogs', 'SendToRecycleBin')"],
    { windowsHide: true, timeout: 60000 }, (err) => {
      scan();
      resolve(err || fs.existsSync(p.dir) ? { ok: false, error: "Couldn't remove it: " + (err ? err.message : "still there") } : { ok: true });
    });
  });
}

// From a folder (copied in), an example (by name), or a git URL (cloned).
function install(source) {
  return new Promise((resolve) => {
    const s = String(source || "").trim();
    if (!s) return resolve({ ok: false, error: "Give a folder, an example's name, or a git URL." });
    const finish = (from, cleanup) => {
      const r = readManifest(from);
      if (r.error || r.problems.length) { if (cleanup) cleanup(); return resolve({ ok: false, error: "Not a package: " + (r.error || r.problems.join("; ")) }); }
      const dest = path.join(dir, r.manifest.name);
      if (fs.existsSync(dest)) { if (cleanup) cleanup(); return resolve({ ok: false, error: "A package called " + r.manifest.name + " is installed already." }); }
      try {
        if (cleanup) fs.renameSync(from, dest);
        else fs.cpSync(from, dest, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || src === from });
      } catch (e) { if (cleanup) cleanup(); return resolve({ ok: false, error: e.message }); }
      scan();
      resolve({ ok: true, name: r.manifest.name, package: publicPkg(pkgs.get(r.manifest.name)) });
    };
    if (/^(https?:\/\/|git@)/.test(s)) {
      const tmp = path.join(dir, ".clone-" + Date.now().toString(36));
      execFile("git", ["clone", "--depth", "1", s, tmp], { windowsHide: true, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out, errOut) => {
        if (err) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} return resolve({ ok: false, error: "git clone failed: " + String(errOut || err.message).trim().slice(0, 300) }); }
        try { fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true }); } catch (e) {}
        finish(tmp, () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });
      });
      return;
    }
    const ex = path.join(root, "packages-examples", s);
    if (NAME.test(s) && fs.existsSync(path.join(ex, MANIFEST))) return finish(ex);
    if (!path.isAbsolute(s) || !fs.existsSync(path.join(s, MANIFEST))) return resolve({ ok: false, error: "No " + MANIFEST + " in " + s + "." });
    finish(path.resolve(s));
  });
}

// A new package from the template, ready to fill in.
function create(o) {
  const name = String(o.name || "").trim().toLowerCase();
  if (!NAME.test(name)) return { ok: false, error: "Name it with lowercase letters, digits and dashes, starting with a letter (like my-tool)." };
  const pdir = path.join(dir, name);
  if (fs.existsSync(pdir)) return { ok: false, error: "There is a package called " + name + " already, in " + pdir + "." };
  const lang = o.language === "python" ? "python" : "node";
  const tools = (Array.isArray(o.tools) && o.tools.length ? o.tools : [{ name: name.replace(/-/g, "_"), description: "Say what this does and when to use it.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }])
    .map((t) => ({ name: String(t.name || "").toLowerCase(), description: String(t.description || ""), input_schema: t.input_schema || t.parameters || { type: "object", properties: {} } }));
  const manifest = {
    name, version: "0.1.0", description: String(o.description || "What this package does, in a sentence."), author: String(o.author || ""),
    run: lang === "python" ? ["python", "tool.py"] : ["node", "index.js"], timeout: 30, permissions: [],
    tools,
  };
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  const cases = tools.map((t) => t.name);
  if (lang === "python") fs.writeFileSync(path.join(pdir, "tool.py"), PY_TEMPLATE(cases));
  else fs.writeFileSync(path.join(pdir, "index.js"), JS_TEMPLATE(cases));
  fs.writeFileSync(path.join(pdir, "README.md"), "# " + name + "\n\n" + manifest.description + "\n\nA Jarvis tool package. See the guide (docs/PACKAGES.md in the dashboard).\n");
  scan();
  return { ok: true, name, dir: pdir, files: [MANIFEST, lang === "python" ? "tool.py" : "index.js", "README.md"] };
}

const JS_TEMPLATE = (names) => `// A Jarvis tool package. Jarvis sends one JSON line per call on stdin:
//   {"type":"call","id":"c1","tool":"<name>","input":{...},"context":{...}}
// and reads one JSON line back on stdout:
//   {"type":"result","id":"c1","content":"what Jarvis should know","error":false}
// Anything else you print goes to the package's log (use console.error for
// debugging). Files you keep go in process.env.JARVIS_DATA_DIR.
const readline = require("readline");

const tools = {
${names.map((n) => `  async ${n}(input, context) {
    // TODO: do the work, return text (or an object) for Jarvis.
    return "Not built yet: ${n} got " + JSON.stringify(input);
  },`).join("\n")}
};

const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type !== "call") return;
  try {
    const fn = tools[msg.tool];
    if (!fn) throw new Error("no tool called " + msg.tool);
    const out = await fn(msg.input || {}, msg.context || {});
    send({ type: "result", id: msg.id, content: typeof out === "string" ? out : JSON.stringify(out) });
  } catch (e) {
    send({ type: "result", id: msg.id, content: "Failed: " + e.message, error: true });
  }
});
`;

const PY_TEMPLATE = (names) => `# A Jarvis tool package. Jarvis sends one JSON line per call on stdin:
#   {"type":"call","id":"c1","tool":"<name>","input":{...},"context":{...}}
# and reads one JSON line back on stdout:
#   {"type":"result","id":"c1","content":"what Jarvis should know","error":false}
# Anything else you print goes to the package's log (print to stderr for
# debugging). Files you keep go in os.environ["JARVIS_DATA_DIR"].
import json
import os
import sys

${names.map((n) => `def ${n}(inp, context):
    # TODO: do the work, return text (or a dict) for Jarvis.
    return "Not built yet: ${n} got " + json.dumps(inp)
`).join("\n\n")}

TOOLS = {${names.map((n) => `"${n}": ${n}`).join(", ")}}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("type") != "call":
            continue
        try:
            fn = TOOLS.get(msg.get("tool"))
            if fn is None:
                raise ValueError("no tool called " + str(msg.get("tool")))
            out = fn(msg.get("input") or {}, msg.get("context") or {})
            send({"type": "result", "id": msg.get("id"), "content": out if isinstance(out, str) else json.dumps(out)})
        except Exception as e:  # noqa: BLE001 - reported to Jarvis
            send({"type": "result", "id": msg.get("id"), "content": "Failed: " + str(e), "error": True})


if __name__ == "__main__":
    main()
`;

function logs(name) {
  const rec = procs.get(name);
  return rec ? rec.logs.slice() : [];
}
function docs() {
  try { return fs.readFileSync(path.join(root, "docs", "PACKAGES.md"), "utf8"); } catch (e) { return "(The guide, docs/PACKAGES.md, is missing from this install.)"; }
}

module.exports = { init, scan, list, examples, tools, has, owner, call, test, enable, disable, remove, install, create, logs, docs, stop, stopAll, get dir() { return dir; } };
