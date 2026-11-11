// ============================================================================
//  Jarvis's command line: shell, python and programs.
//
//  shell:    PowerShell or cmd. run (wait for it), start (in the background,
//            read its output later), output, stop, jobs, which (is a program
//            installed, and what version), test (find a project's test runner
//            and run it).
//  python:   the Pythons on the PC and virtual environments: find, envs,
//            create, install / uninstall packages, packages, run code or a
//            script, test (pytest or unittest), freeze, remove.
//  programs: installing software: winget (Windows programs), npm (global
//            Node tools) and pip (Python tools for the user). search, info,
//            install, upgrade, uninstall, installed, check.
//
//  Every command waits for ctx.ask (the panel's OK) by the user's "shell"
//  setting; installing or removing a program always asks, whatever it is.
//  A short list of commands that wreck a PC is refused outright. Each command
//  has a timeout, and stopping kills its whole process tree.
// ============================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const F = require("./assistant-files");

const IS_WIN = process.platform === "win32";

// ---- things never run ------------------------------------------------------------------
const NEVER = [
  [/\bformat(\.com)?\s+[a-z]:/i, "formatting a drive"],
  [/\bdiskpart\b/i, "diskpart"],
  [/\bbcdedit\b/i, "changing the boot configuration"],
  [/\bcipher\s+\/w/i, "wiping free space"],
  [/\bvssadmin\b.*\bdelete\b/i, "deleting shadow copies"],
  [/\bwmic\b.*shadowcopy.*delete/i, "deleting shadow copies"],
  [/\b(?:Clear-Disk|Initialize-Disk|Format-Volume|Remove-Partition)\b/i, "wiping a disk"],
  [/\breg(?:\.exe)?\s+delete\s+HKLM/i, "deleting machine registry keys"],
  [/Remove-Item\b[^|;&]*\s(?:HKLM|Registry::HKEY_LOCAL_MACHINE)/i, "deleting machine registry keys"],
  [/(?:\brd|\brmdir|\bdel|\berase|Remove-Item|\brm)\b[^|;&]*\s["']?(?:[a-z]:\\?|\\|\/|%SystemRoot%|\$env:SystemRoot|C:\\Windows|%USERPROFILE%|\$env:USERPROFILE|~)["']?\s*(?:$|[|;&]|\s-)/i, "deleting a whole drive, Windows or your user folder"],
  [/\bSet-MpPreference\b.*-Disable/i, "switching off Windows Defender"],
  [/\bnetsh\s+advfirewall\s+set\b.*\boff\b/i, "switching off the firewall"],
  [/\b(?:shutdown|Stop-Computer|Restart-Computer)\b/i, "shutting down or restarting the PC (ask the user to)"],
  [/\bSet-ExecutionPolicy\b[^|;&]*\bLocalMachine\b/i, "changing the machine's script policy"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "a fork bomb"],
];
function refused(cmd) {
  for (const [re, what] of NEVER) if (re.test(cmd)) return "I don't run that (" + what + "): it can break the PC or lose data for good.";
  return null;
}

// ---- running ----------------------------------------------------------------------------
// The program's text, readable: colour codes out, progress bars collapsed to
// their last state.
function tidy(s) {
  return String(s || "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .split("\n").map((l) => { const parts = l.split("\r"); let last = parts.pop(); while (!last.trim() && parts.length) last = parts.pop(); return last; })
    .filter((l, i, arr) => !(l.trim() === "" && arr[i - 1] !== undefined && arr[i - 1].trim() === ""))
    .join("\n");
}
// Head and tail of a long output: the end is usually where the answer is.
function squeeze(s, limit) {
  const t = tidy(s);
  if (t.length <= limit) return t;
  const head = Math.floor(limit * 0.3), tail = limit - head;
  return t.slice(0, head) + "\n… (" + (t.length - limit) + " characters cut from the middle) …\n" + t.slice(-tail);
}

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { process.kill(-pid, "SIGKILL"); } catch (e) { try { process.kill(pid, "SIGKILL"); } catch (e2) {} }
}

function shellArgs(kind, command) {
  // /s: cmd strips the outer quotes and runs the rest exactly as written.
  if (kind === "cmd") return ["cmd.exe", ["/d", "/s", "/c", "\"chcp 65001>nul & " + command + "\""], { windowsVerbatimArguments: true }];
  const exe = kind === "pwsh" ? "pwsh.exe" : "powershell.exe";
  const pre = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ";
  return [exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", pre + command], {}];
}

// Runs a program, collecting stdout and stderr in the order they came.
function exec(file, args, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = "", timedOut = false, done = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: !!opts.verbatim,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", GIT_TERMINAL_PROMPT: "0", npm_config_yes: "true", ...(opts.env || {}) },
      });
    } catch (e) { return resolve({ ok: false, code: -1, out: "Couldn't start " + file + ": " + e.message, ms: 0 }); }
    const cap = opts.cap || 2 * 1024 * 1024;
    const add = (d) => { if (out.length < cap) out += d.toString("utf8"); if (opts.onData) opts.onData(d.toString("utf8")); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    if (opts.input != null) { try { child.stdin.end(String(opts.input)); } catch (e) {} } else { try { child.stdin.end(); } catch (e) {} }
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.ms || 120000);
    const onAbort = () => { killTree(child.pid); };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (code, err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (err) out += (out ? "\n" : "") + (err.code === "ENOENT" ? file + " isn't installed or isn't on the PATH." : err.message);
      resolve({ ok: !err && code === 0 && !timedOut, code: err ? -1 : code, out, timedOut, ms: Date.now() - t0 });
    };
    child.on("error", (e) => finish(-1, e));
    child.on("close", (code) => finish(code));
  });
}

// ---- background jobs ----------------------------------------------------------------------
const jobs = new Map();       // id -> { id, command, kind, cwd, child, out, read, started, code, ended }
let jobN = 0;
const JOB_CAP = 400 * 1024;
function startJob(kind, command, cwd) {
  const [file, args, extra] = shellArgs(kind, command);
  const child = spawn(file, args, { cwd, windowsHide: true, windowsVerbatimArguments: !!extra.windowsVerbatimArguments, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" } });
  const id = "job" + (++jobN);
  const j = { id, command, kind, cwd, child, out: "", read: 0, started: Date.now(), code: null, ended: 0, dropped: 0 };
  const add = (d) => {
    j.out += d.toString("utf8");
    if (j.out.length > JOB_CAP) { const cut = j.out.length - JOB_CAP; j.out = j.out.slice(cut); j.read = Math.max(0, j.read - cut); j.dropped += cut; }
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  try { child.stdin.end(); } catch (e) {}
  child.on("error", (e) => { j.out += "\n" + e.message; j.code = -1; j.ended = Date.now(); });
  child.on("close", (code) => { j.code = code; j.ended = Date.now(); j.child = null; });
  jobs.set(id, j);
  // Finished jobs are forgotten after an hour.
  for (const [k, x] of jobs) if (x.ended && Date.now() - x.ended > 3600000) jobs.delete(k);
  return j;
}
function jobLine(j) {
  const age = Math.round(((j.ended || Date.now()) - j.started) / 1000);
  return j.id + ": " + (j.ended ? "finished (exit " + j.code + ")" : "running") + " for " + age + " s · " + j.kind + " · " + j.command.slice(0, 120) + " · in " + j.cwd;
}
function stopAll() { for (const j of jobs.values()) if (j.child) killTree(j.child.pid); }

// ---- test runners ----------------------------------------------------------------------
async function detectTests(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch (e) {}
  if (pkg && pkg.scripts && pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) return ["npm test", "npm test (" + pkg.scripts.test + ")"];
  if (has("Cargo.toml")) return ["cargo test", "cargo test"];
  if (has("go.mod")) return ["go test ./...", "go test"];
  if (fs.readdirSync(dir).some((f) => /\.(sln|csproj|fsproj)$/i.test(f))) return ["dotnet test", "dotnet test"];
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tox.ini") || has("tests") || has("test")) {
    const py = findVenvPython(dir);
    return ["& '" + (py || "python") + "' -m pytest -q", "pytest" + (py ? " (in " + path.relative(dir, path.dirname(path.dirname(py))) + ")" : "")];
  }
  if (has("Makefile")) return ["make test", "make test"];
  return null;
}
function findVenvPython(dir) {
  for (const v of [".venv", "venv", "env", ".env"]) {
    const p = path.join(dir, v, IS_WIN ? "Scripts\\python.exe" : "bin/python");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- the shell tool -----------------------------------------------------------------------
async function shell(a, ctx) {
  const act = String(a.action || "run");
  const kind = ["cmd", "pwsh"].includes(a.shell) ? a.shell : "powershell";
  const cwd = F.resolve(a.cwd || a.path, ctx);
  const limit = ctx.limit || 12000;
  const no = ["The user said no.", true];

  if (act === "jobs") return [jobs.size ? [...jobs.values()].map(jobLine).join("\n") : "No background jobs."];
  if (act === "output" || act === "stop") {
    const j = jobs.get(String(a.id || ""));
    if (!j) return ["No job " + a.id + ". jobs lists them.", true];
    if (act === "stop") {
      if (j.child) killTree(j.child.pid);
      return ["Stopped " + j.id + ". Its last output:\n" + squeeze(j.out.slice(-3000), 3000)];
    }
    const fresh = a.all ? j.out : j.out.slice(j.read);
    j.read = j.out.length;
    return [jobLine(j) + (j.dropped ? " (oldest output dropped)" : "") + "\n" + (squeeze(fresh, limit) || "(no new output)")];
  }
  if (act === "which") {
    const name = String(a.name || a.command || "").trim().split(/\s+/)[0];
    if (!/^[\w.\-+]{1,60}$/.test(name)) return ["which needs a program name, like python, node or git.", true];
    const w = await exec("where.exe", [name], { ms: 15000 });
    if (!w.ok) return [name + " isn't on the PATH (not installed, or installed somewhere the PATH doesn't reach)."];
    const first = tidy(w.out).trim().split(/\r?\n/)[0];
    const v = await exec(first, [name === "java" ? "-version" : "--version"], { ms: 15000 });
    return [name + ":\n" + tidy(w.out).trim() + "\nVersion: " + (tidy(v.out).trim().split(/\r?\n/).slice(0, 3).join(" ") || "(it didn't say)")];
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return ["No folder at " + cwd + " to run in.", true];

  if (act === "test") {
    const t = await detectTests(cwd);
    const command = a.command || (t && t[0]);
    if (!command) return ["I couldn't tell how this project runs its tests (no package.json test script, Cargo.toml, go.mod, .sln, pytest config or Makefile). Give command.", true];
    const bad = refused(command);
    if (bad) return [bad, true];
    if (!(await ctx.ask({ tool: "shell", action: "test", shell: true, title: "Run the tests: " + (a.command ? command : t[1]), path: cwd, detail: command }))) return no;
    const r = await exec(...shellCall(kind, command, cwd, a, ctx));
    ctx.cwd = cwd;
    return [(r.ok ? "Tests passed" : r.timedOut ? "Tests timed out" : "Tests failed (exit " + r.code + ")") + " in " + (r.ms / 1000).toFixed(1) + " s: " + command + "\n" + squeeze(r.out, limit), !r.ok];
  }

  const command = String(a.command || "").trim();
  if (!command) return ["shell needs a command.", true];
  const bad = refused(command);
  if (bad) return [bad, true];
  const label = { powershell: "PowerShell", pwsh: "PowerShell 7", cmd: "Command Prompt" }[kind];

  if (act === "start") {
    if (!(await ctx.ask({ tool: "shell", action: "start", shell: true, title: "Start in the background (" + label + ")", path: cwd, detail: command }))) return no;
    const j = startJob(kind, command, cwd);
    await new Promise((r) => setTimeout(r, Math.max(500, Math.min(15000, (a.wait | 0 || 3) * 1000))));
    j.read = j.out.length;
    ctx.cwd = cwd;
    return ["Started " + j.id + (j.ended ? " — it already finished (exit " + j.code + ")" : ", still running") + ". First output:\n" + (squeeze(j.out, Math.min(limit, 4000)) || "(nothing yet)") + "\nRead more with shell output {id: " + j.id + "}, stop it with shell stop."];
  }
  if (act !== "run") return ["Unknown shell action \"" + act + "\". run, start, output, stop, jobs, which, test.", true];
  if (!(await ctx.ask({ tool: "shell", action: "run", shell: true, title: "Run in " + label, path: cwd, detail: command }))) return no;
  const r = await exec(...shellCall(kind, command, cwd, a, ctx));
  ctx.cwd = cwd;
  const head = (r.timedOut ? "Timed out after " + (r.ms / 1000).toFixed(0) + " s (stopped; for long jobs use start)" : "Exit code " + r.code) + " · " + (r.ms / 1000).toFixed(1) + " s";
  return [head + "\n" + (squeeze(r.out, limit).trim() || "(no output)"), !r.ok];
}
function shellCall(kind, command, cwd, a, ctx) {
  const [file, args, extra] = shellArgs(kind, command);
  const ms = Math.max(5, Math.min(1800, a.timeout | 0 || 120)) * 1000;
  return [file, args, { cwd, ms, input: a.input, verbatim: !!extra.windowsVerbatimArguments, signal: ctx.signal, env: a.env && typeof a.env === "object" ? Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) : undefined }];
}

// ---- the python tool ----------------------------------------------------------------------
function envPython(env, ctx) {
  if (!env || env === "system") return null;
  const p = F.resolve(env, ctx);
  if (/python(3(\.\d+)?)?\.exe$/i.test(p) && fs.existsSync(p)) return p;
  const exe = path.join(p, IS_WIN ? "Scripts\\python.exe" : "bin/python");
  return fs.existsSync(exe) ? exe : null;
}
async function systemPython(version) {
  // The py launcher picks a version; otherwise whatever python is on the PATH.
  const py = await exec("py", ["-" + (version || "3"), "-c", "import sys; print(sys.executable)"], { ms: 20000 });
  if (py.ok) return tidy(py.out).trim().split(/\r?\n/).pop();
  if (version) return null;
  const p = await exec("python", ["-c", "import sys; print(sys.executable)"], { ms: 20000 });
  return p.ok && !/WindowsApps/i.test(p.out) ? tidy(p.out).trim().split(/\r?\n/).pop() : null;
}

async function python(a, ctx) {
  const act = String(a.action || "find");
  const limit = ctx.limit || 12000;
  const no = ["The user said no.", true];
  const ms = Math.max(10, Math.min(3600, a.timeout | 0 || 600)) * 1000;

  if (act === "find") {
    const lines = [];
    const py = await exec("py", ["-0p"], { ms: 20000 });
    if (py.ok) lines.push("Pythons (py launcher):\n" + tidy(py.out).trim());
    const w = await exec("where.exe", ["python"], { ms: 15000 });
    if (w.ok) lines.push("python on the PATH:\n" + tidy(w.out).trim() + (/WindowsApps/i.test(w.out) ? "\n(the WindowsApps one is only the Microsoft Store shortcut)" : ""));
    const c = await exec("conda", ["env", "list"], { ms: 20000 });
    if (c.ok) lines.push("Conda environments:\n" + tidy(c.out).trim());
    const uv = await exec("uv", ["--version"], { ms: 10000 });
    if (uv.ok) lines.push("uv is installed: " + tidy(uv.out).trim());
    return [lines.join("\n\n") || "No Python found. programs install {id: Python.Python.3.12} would install it."];
  }
  if (act === "envs") {
    const root = F.resolve(a.path, ctx);
    if (!(await ctx.ask({ tool: "python", action: "envs", write: false, title: "Look for Python environments in " + path.basename(root), path: root }))) return no;
    const found = [];
    const look = async (d, depth) => {
      if (depth > (a.depth | 0 || 4) || found.length > 60) return;
      let ents = [];
      try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      if (ents.some((e) => e.name === "pyvenv.cfg")) {
        let ver = "";
        try { ver = (fs.readFileSync(path.join(d, "pyvenv.cfg"), "utf8").match(/^version(?:_info)?\s*=\s*(.+)$/m) || [])[1] || ""; } catch (e) {}
        found.push(d + (ver ? " (Python " + ver.trim() + ")" : ""));
        return;
      }
      for (const e of ents) if (e.isDirectory() && !["node_modules", ".git", "__pycache__", "site-packages"].includes(e.name)) await look(path.join(d, e.name), depth + 1);
    };
    await look(root, 0);
    return [found.length ? "Environments under " + root + ":\n" + found.join("\n") : "No virtual environments under " + root + "."];
  }

  const env = a.env || a.path;
  if (act === "create") {
    if (!env) return ["create needs env: the folder for the new environment (like .venv inside the project).", true];
    const dest = F.resolve(env, ctx);
    const g = F.guard(dest, true);
    if (g) return [g, true];
    if (fs.existsSync(path.join(dest, "pyvenv.cfg"))) return ["There's already an environment at " + dest + ".", true];
    const base = await systemPython(a.version);
    if (!base) return ["No Python " + (a.version || "") + " found to make it from. python find lists them; programs install {id: Python.Python." + (a.version || "3.12") + "} installs one.", true];
    if (!(await ctx.ask({ tool: "python", action: "create", shell: true, title: "New Python environment " + path.basename(dest), path: dest, detail: base + " -m venv " + dest + (a.packages && a.packages.length ? "\nthen install: " + a.packages.join(" ") : "") }))) return no;
    const r = await exec(base, ["-m", "venv", dest], { ms: 180000, signal: ctx.signal });
    if (!r.ok) return ["Making the environment failed:\n" + squeeze(r.out, 3000), true];
    const exe = envPython(dest, ctx);
    let extra = "";
    if (Array.isArray(a.packages) && a.packages.length) {
      const pi = await exec(exe, ["-m", "pip", "install", "--disable-pip-version-check", ...a.packages.map(String)], { ms, signal: ctx.signal });
      extra = "\nInstalled " + a.packages.join(", ") + (pi.ok ? "." : " — FAILED:\n" + squeeze(pi.out, 3000));
    }
    const v = await exec(exe, ["--version"], { ms: 15000 });
    ctx.cwd = path.dirname(dest);
    return ["Made " + dest + " (" + tidy(v.out).trim() + ", from " + base + "). Its python: " + exe + extra];
  }

  const exe = envPython(env, ctx) || (env && env !== "system" ? null : await systemPython(a.version));
  if (!exe) return [env && env !== "system" ? "No Python environment at " + F.resolve(env, ctx) + " (create makes one)." : "No Python found on the PC.", true];
  const where = env && env !== "system" ? F.resolve(env, ctx) : "the system Python";

  if (act === "packages" || act === "freeze" || act === "info") {
    const args = act === "freeze" ? ["-m", "pip", "freeze"] : act === "info" ? ["-c", "import sys,platform;print(sys.version);print(sys.executable);print(sys.prefix);print(platform.platform())"] : ["-m", "pip", "list", "--disable-pip-version-check"];
    const r = await exec(exe, args, { ms: 60000 });
    return [squeeze(r.out, limit).trim() || "(nothing)", !r.ok];
  }
  if (act === "install" || act === "uninstall") {
    const pk = (Array.isArray(a.packages) ? a.packages : String(a.packages || "").split(/[\s,]+/)).map(String).filter(Boolean);
    const req = a.requirements ? F.resolve(a.requirements, ctx) : null;
    if (!pk.length && !req) return [act + " needs packages (a list) or requirements (a requirements.txt).", true];
    if (pk.some((x) => /^-/.test(x) && !/^-(e|U|-upgrade|-pre)$/.test(x))) return ["Give package names only (and -e / --upgrade / --pre).", true];
    const args = act === "install"
      ? ["-m", "pip", "install", "--disable-pip-version-check", ...(a.upgrade ? ["--upgrade"] : []), ...(req ? ["-r", req] : []), ...pk]
      : ["-m", "pip", "uninstall", "-y", "--disable-pip-version-check", ...pk];
    if (!(await ctx.ask({ tool: "python", action: act, shell: true, title: (act === "install" ? "Install " : "Remove ") + (pk.join(", ") || path.basename(req)) + " in " + path.basename(where), path: where, detail: exe + " " + args.join(" ") }))) return no;
    const r = await exec(exe, args, { ms, signal: ctx.signal });
    const tail = tidy(r.out).trim().split(/\r?\n/).filter((l) => /Successfully|ERROR|error:|Requirement already|not installed|WARNING: Skipping/i.test(l)).slice(-12).join("\n");
    return [(r.ok ? "Done" : r.timedOut ? "Timed out" : "Failed (exit " + r.code + ")") + " in " + (r.ms / 1000).toFixed(0) + " s.\n" + (r.ok ? tail || squeeze(r.out, 2000) : squeeze(r.out, limit)), !r.ok];
  }
  if (act === "run" || act === "test") {
    const cwd = F.resolve(a.cwd || (env && env !== "system" ? path.dirname(F.resolve(env, ctx)) : ""), ctx);
    let args;
    if (act === "test") args = a.unittest ? ["-m", "unittest", ...(a.target ? [String(a.target)] : ["discover"]), "-v"] : ["-m", "pytest", "-q", ...(a.target ? [String(a.target)] : []), ...(Array.isArray(a.args) ? a.args.map(String) : [])];
    else if (a.file) args = [F.resolve(a.file, { cwd }), ...(Array.isArray(a.args) ? a.args.map(String) : [])];
    else if (a.module) args = ["-m", String(a.module), ...(Array.isArray(a.args) ? a.args.map(String) : [])];
    else if (a.code) args = ["-c", String(a.code)];
    else return ["run needs code, file or module.", true];
    const shown = act === "test" ? args.join(" ") : a.code ? "python -c (" + String(a.code).split("\n").length + " lines)" : args.join(" ");
    if (!(await ctx.ask({ tool: "python", action: act, shell: true, title: (act === "test" ? "Run Python tests" : "Run Python") + " (" + path.basename(where) + ")", path: cwd, detail: a.code ? String(a.code).slice(0, 1400) : exe + " " + shown }))) return no;
    const r = await exec(exe, args, { cwd, ms: Math.max(5, Math.min(3600, a.timeout | 0 || (act === "test" ? 600 : 120))) * 1000, input: a.input, signal: ctx.signal });
    ctx.cwd = cwd;
    if (act === "test" && !a.unittest && /No module named pytest/.test(r.out)) return ["pytest isn't installed in " + where + ". python install {packages: [pytest]} first, or test with unittest: true.", true];
    return [(r.ok ? "Exit 0" : r.timedOut ? "Timed out" : "Exit " + r.code) + " · " + (r.ms / 1000).toFixed(1) + " s\n" + (squeeze(r.out, limit).trim() || "(no output)"), !r.ok];
  }
  if (act === "remove") {
    if (!env || env === "system") return ["remove needs env: the environment's folder.", true];
    const dest = F.resolve(env, ctx);
    if (!fs.existsSync(path.join(dest, "pyvenv.cfg"))) return [dest + " isn't a Python environment; I only remove those.", true];
    return ["Delete it with files delete {path: " + dest + "} (it goes to the Recycle Bin)."];
  }
  return ["Unknown python action \"" + act + "\". find, envs, create, install, uninstall, packages, freeze, info, run, test, remove.", true];
}

// ---- the programs tool --------------------------------------------------------------------
const ID = /^[\w.\-+@\/]{1,120}$/;
async function programs(a, ctx) {
  const act = String(a.action || "search");
  const mgr = ["npm", "pip"].includes(a.manager) ? a.manager : "winget";
  const limit = ctx.limit || 12000;
  const no = ["The user said no.", true];
  const W = ["--disable-interactivity"];

  if (act === "check") {
    const name = String(a.name || a.id || "");
    return shell({ action: "which", name }, ctx);
  }
  if (act === "search" || act === "info" || act === "installed") {
    const q = String(a.query || a.id || a.name || "").trim();
    if (act !== "installed" && !q) return [act + " needs a query or id.", true];
    let r;
    if (mgr === "npm") r = act === "search" ? await exec("npm.cmd", ["search", "--parseable", "--searchlimit", "15", q], { ms: 60000 }) : act === "info" ? await exec("npm.cmd", ["view", q, "name", "version", "description", "homepage"], { ms: 60000 }) : await exec("npm.cmd", ["ls", "-g", "--depth=0"], { ms: 60000 });
    else if (mgr === "pip") {
      const py = await systemPython();
      if (!py) return ["No Python on the PC for pip.", true];
      r = act === "info" ? await exec(py, ["-m", "pip", "show", q], { ms: 60000 }) : act === "installed" ? await exec(py, ["-m", "pip", "list", "--user", "--disable-pip-version-check"], { ms: 60000 }) : { ok: false, out: "pip has no search; look the package up on pypi.org (read_page https://pypi.org/project/" + q + "/), then install it." };
    } else {
      const args = act === "search" ? ["search", q, "--source", "winget", "--count", "15"] : act === "info" ? ["show", "--id", q, "--exact", "--source", "winget"] : ["list", ...(q ? [q] : [])];
      r = await exec("winget", [...args, ...W, "--accept-source-agreements"], { ms: 90000 });
      if (act === "info" && !r.ok && /No package found/i.test(r.out)) r = await exec("winget", ["show", q, "--source", "winget", ...W, "--accept-source-agreements"], { ms: 90000 });
    }
    return [squeeze(r.out, limit).trim() || "(nothing)", !r.ok];
  }
  if (act === "install" || act === "upgrade" || act === "uninstall") {
    const id = String(a.id || a.name || "").trim();
    if (!ID.test(id)) return [act + " needs id: the exact package id (from search; for winget like Python.Python.3.12 or Git.Git).", true];
    let file, args, what;
    if (mgr === "npm") {
      file = "npm.cmd";
      args = act === "uninstall" ? ["uninstall", "-g", id] : ["install", "-g", id + (a.version ? "@" + a.version : act === "upgrade" ? "@latest" : "")];
      what = "npm (global)";
    } else if (mgr === "pip") {
      file = await systemPython();
      if (!file) return ["No Python on the PC for pip.", true];
      args = act === "uninstall" ? ["-m", "pip", "uninstall", "-y", id] : ["-m", "pip", "install", "--user", ...(act === "upgrade" ? ["--upgrade"] : []), id + (a.version ? "==" + a.version : "")];
      what = "pip (for your user)";
    } else {
      file = "winget";
      args = act === "uninstall" ? ["uninstall", "--id", id, "--exact", ...W]
        : [act, "--id", id, "--exact", "--source", "winget", "--silent", ...(a.version ? ["--version", String(a.version)] : []), ...(a.scope === "machine" ? ["--scope", "machine"] : a.scope === "user" ? ["--scope", "user"] : []), "--accept-package-agreements", "--accept-source-agreements", ...W];
      what = "winget";
    }
    const verb = { install: "Install", upgrade: "Update", uninstall: "Uninstall" }[act];
    // Always asked: a program changes the PC for everything, not just a folder.
    if (!(await ctx.ask({ tool: "programs", action: act, always: true, title: verb + " " + id + (a.version ? " " + a.version : "") + " with " + what, path: "", detail: [file, ...args].join(" ") + (mgr === "winget" && act !== "uninstall" ? "\n(this accepts the program's licence for you; an installer may still show a Windows admin prompt on the PC)" : "") }))) return no;
    const r = await exec(file, args, { ms: Math.max(60, Math.min(3600, a.timeout | 0 || 1800)) * 1000, signal: ctx.signal });
    const out = squeeze(r.out, limit).trim();
    // winget's own "nothing to do" codes are not failures.
    const nothing = /No applicable upgrade|No newer package versions|already installed/i.test(r.out);
    return [(r.ok || nothing ? (nothing ? "Nothing to do" : "Done") : r.timedOut ? "Timed out" : "Failed (exit " + r.code + ")") + " · " + (r.ms / 1000).toFixed(0) + " s\n" + out + (r.ok && mgr === "winget" && act !== "uninstall" ? "\nA program just installed may not be on this session's PATH until the panel restarts; shell which tells." : ""), !(r.ok || nothing)];
  }
  return ["Unknown programs action \"" + act + "\". search, info, installed, check, install, upgrade, uninstall.", true];
}

const TOOL_DEFS = [
  {
    name: "shell", where: "server", core: false,
    description: "Run commands on the PC. shell: powershell (default), cmd, or pwsh (PowerShell 7). run (command, cwd, timeout in seconds, default 120, input for stdin): waits and returns the exit code and output. start (command, cwd, wait): runs in the background (servers, watchers, long builds) and returns a job id; output (id, all) gives what it printed since you last looked; stop (id); jobs lists them. which (name): whether a program is installed, where, and its version. test (cwd, command): runs the project's tests (finds npm test, pytest, cargo, go, dotnet or make itself when command is left out). Every command waits for the user's OK unless they turned that off. Never run anything destructive; prefer the files and lines tools for reading and editing files.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "start", "output", "stop", "jobs", "which", "test"] },
        command: { type: "string" }, shell: { type: "string", enum: ["powershell", "cmd", "pwsh"] }, cwd: { type: "string" },
        timeout: { type: "integer" }, input: { type: "string" }, id: { type: "string" }, all: { type: "boolean" }, wait: { type: "integer" }, name: { type: "string" },
        env: { type: "object" },
      },
      required: ["action"],
    },
  },
  {
    name: "python", where: "server", core: false,
    description: "Python and its environments. find: every Python on the PC (and conda, uv). envs (path): the virtual environments in a folder. create (env: the new folder, e.g. C:\\proj\\.venv; version like \"3.12\"; packages to install). install / uninstall (env, packages: [names, \"pkg==1.2\"], requirements: a requirements.txt, upgrade). packages (env): what is installed. freeze (env). info (env). run (env, code / file / module, args, cwd, input, timeout): run Python in that environment. test (env, target, unittest): pytest (or unittest) there. env left out (or \"system\") = the system Python. Anything that installs or runs waits for the user's OK unless they turned that off.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["find", "envs", "create", "install", "uninstall", "packages", "freeze", "info", "run", "test", "remove"] },
        env: { type: "string" }, path: { type: "string" }, version: { type: "string" },
        packages: { type: "array", items: { type: "string" } }, requirements: { type: "string" }, upgrade: { type: "boolean" },
        code: { type: "string" }, file: { type: "string" }, module: { type: "string" }, args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" }, input: { type: "string" }, timeout: { type: "integer" }, target: { type: "string" }, unittest: { type: "boolean" }, depth: { type: "integer" },
      },
      required: ["action"],
    },
  },
  {
    name: "programs", where: "server", core: false,
    description: "Install software. manager: winget (default: Windows programs, e.g. Git.Git, Python.Python.3.12, OpenJS.NodeJS.LTS, Microsoft.VisualStudioCode, 7zip.7zip), npm (global Node command-line tools) or pip (Python tools for the user). search (query): find the exact id. info (id). installed (query): what is installed. check (name): is a command available, and its version. install (id, version, scope: user|machine), upgrade (id), uninstall (id). Install, upgrade and uninstall ALWAYS wait for the user's OK; search first and install the exact id.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "info", "installed", "check", "install", "upgrade", "uninstall"] },
        manager: { type: "string", enum: ["winget", "npm", "pip"] },
        query: { type: "string" }, id: { type: "string" }, name: { type: "string" }, version: { type: "string" },
        scope: { type: "string", enum: ["user", "machine"] }, timeout: { type: "integer" },
      },
      required: ["action"],
    },
  },
];

module.exports = { shell, python, programs, TOOL_DEFS, stopAll, refused, tidy, exec };
