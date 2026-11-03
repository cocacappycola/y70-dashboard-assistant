// ============================================================================
//  Jarvis's hands on the file system: the files and repo tools.
//
//  files: list, tree, read, find (by name and/or text), info, write, append,
//         edit (exact find and replace), mkdir, move, copy, delete (to the
//         Recycle Bin, never for good), open (in Explorer or its app).
//  repo:  overview (what a repo is at a glance), git (a safe set of git
//         commands), create (a new repo), publish (a new GitHub repo via gh).
//
//  Every action goes through ctx.ask(request) first, which says yes or no by
//  the user's setting: "ask" (changes wait for a tap on the panel), "askall"
//  (reading too), "bypass" (nothing waits). Some places are never touched,
//  whatever the setting: Windows and Program Files, and the panel's own keys.
// ============================================================================
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

let dataDir = null;
function init(dir) { dataDir = dir; }

// ---- where ------------------------------------------------------------------
const HOME = os.homedir();
function expand(p) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  s = s.replace(/%([A-Za-z_]+)%/g, (m, k) => process.env[k] || m);
  if (/^~([\\/]|$)/.test(s)) s = HOME + s.slice(1);
  return s;
}
function resolve(p, ctx) {
  const s = expand(p);
  if (!s) return ctx && ctx.cwd ? ctx.cwd : HOME;
  return path.resolve(path.isAbsolute(s) ? s : path.join((ctx && ctx.cwd) || HOME, s));
}
const norm = (p) => path.resolve(p).toLowerCase();
const under = (p, root) => { const a = norm(p), b = norm(root); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

// Never written to, whatever the setting.
function systemRoots() {
  const env = process.env;
  return [env.SystemRoot || "C:\\Windows", env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    path.join(env.ProgramData || "C:\\ProgramData", "Microsoft")].filter(Boolean);
}
// Never read or written: the keys the panel keeps.
const SECRET = /^(claude-key\.txt|govee-key\.txt|discord-token\.json|discord-app\.json)$/i;
function guard(p, write) {
  const base = path.basename(p);
  if (SECRET.test(base) && (!dataDir || under(p, dataDir) || /y70/i.test(p))) return "That file holds one of the panel's keys; I don't open it.";
  if (/[\\/](\$Recycle\.Bin|System Volume Information)([\\/]|$)/i.test(p)) return "That's a Windows system folder.";
  if (!write) return null;
  for (const r of systemRoots()) if (under(p, r)) return "I don't change anything under " + r + ".";
  if (/^[a-z]:\\?$/i.test(p)) return "Not a whole drive.";
  if (norm(p) === norm(HOME) || norm(p) === norm(path.dirname(HOME))) return "Not your whole user folder.";
  return null;
}

// ---- small helpers -------------------------------------------------------------
const SKIP_NAMES = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv", "venv", ".cache", "target", "bin", "obj", ".idea", ".vs", "win-unpacked"]);
// Dependencies and build output: not what anyone means by "search my project".
const SKIP_DIRS = { has: (n) => SKIP_NAMES.has(n) || /^dist\d+$/i.test(n) };
function size(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}
const when = (t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
async function stat(p) { try { return await fsp.stat(p); } catch (e) { return null; } }
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
function clip(text, limit) {
  const s = String(text);
  return s.length > limit ? s.slice(0, limit) + "\n… (cut at " + limit + " characters; ask for less, or a later part)" : s;
}
function globRe(g) {
  const s = String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + s + "$", "i");
}
// A first look at a change, for the approval card.
function preview(text, lines) {
  const l = String(text || "").split(/\r?\n/);
  return l.slice(0, lines || 14).join("\n") + (l.length > (lines || 14) ? "\n… " + (l.length - (lines || 14)) + " more lines" : "");
}

async function walk(root, visit, opts) {
  const o = opts || {};
  const deadline = Date.now() + (o.ms || 8000);
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline || seen > (o.max || 20000)) return false;
    const d = stack.pop();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      seen++;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
        if (await visit(p, e) === "stop") return true;
        stack.push(p);
      } else if (await visit(p, e) === "stop") return true;
    }
  }
  return true;
}

function run(cmd, args, cwd, ms) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd, timeout: ms || 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, out: String(stdout || ""), err: String(stderr || "") + (err && !stderr ? String(err.message || "") : "") });
    });
  });
}

// To the Recycle Bin, so a mistake can be undone from there.
function recycle(p, isDir) {
  const lit = "'" + p.replace(/'/g, "''") + "'";
  const ps = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::" +
    (isDir ? "DeleteDirectory" : "DeleteFile") + "(" + lit + ", 'OnlyErrorDialogs', 'SendToRecycleBin')";
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], undefined, 60000);
}

// ---- the files tool -----------------------------------------------------------------
const READS = new Set(["list", "tree", "read", "find", "info"]);

async function files(a, ctx) {
  const act = String(a.action || "");
  const p = resolve(a.path, ctx);
  const limit = ctx.limit || 12000;
  const write = !READS.has(act) && act !== "open";
  const g = guard(p, write);
  if (g) return [g, true];
  const ask = (title, detail, extra) => ctx.ask({ tool: "files", action: act, write: write || !!(extra && extra.write), title, path: p, detail: detail || "", ...(extra || {}) });

  if (act === "list") {
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + ".", true];
    if (!st.isDirectory()) return [p + " is a file (" + size(st.size) + ", changed " + when(st.mtimeMs) + "). read it to see inside."];
    if (!(await ask("Look in " + (path.basename(p) || p)))) return ["The user said no.", true];
    let ents = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
    if (!a.all) ents = ents.filter((e) => !e.name.startsWith("."));
    const rows = [];
    for (const e of ents.slice(0, 400)) {
      const s = await stat(path.join(p, e.name));
      rows.push({ name: e.name, dir: e.isDirectory(), size: s ? s.size : 0, at: s ? s.mtimeMs : 0 });
    }
    rows.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
    const shown = rows.slice(0, 150);
    ctx.cwd = p;
    return [p + " (" + rows.filter((r) => r.dir).length + " folders, " + rows.filter((r) => !r.dir).length + " files" + (ents.length > 400 ? ", first 400 looked at" : "") + "):\n" +
      shown.map((r) => (r.dir ? "[dir] " + r.name + "\\" : r.name + "  " + size(r.size)) + "  " + when(r.at)).join("\n") +
      (rows.length > shown.length ? "\n… " + (rows.length - shown.length) + " more" : "")];
  }

  if (act === "tree") {
    const st = await stat(p);
    if (!st || !st.isDirectory()) return ["No folder at " + p + ".", true];
    if (!(await ask("Look through " + path.basename(p)))) return ["The user said no.", true];
    const depth = Math.max(1, Math.min(5, a.depth | 0 || 2));
    const lines = [];
    async function go(d, lvl) {
      if (lines.length > 400) return;
      let ents = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      ents = ents.filter((e) => !e.name.startsWith(".") || e.name === ".github" || e.name === ".gitignore");
      ents.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of ents) {
        if (lines.length > 400) { lines.push("  ".repeat(lvl) + "…"); return; }
        if (e.isDirectory()) {
          const skip = SKIP_DIRS.has(e.name);
          lines.push("  ".repeat(lvl) + e.name + "/" + (skip ? " (skipped)" : ""));
          if (!skip && lvl + 1 < depth) await go(path.join(d, e.name), lvl + 1);
        } else lines.push("  ".repeat(lvl) + e.name);
      }
    }
    await go(p, 0);
    ctx.cwd = p;
    return [clip(p + "\n" + lines.join("\n"), limit)];
  }

  if (act === "read") {
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + ".", true];
    if (st.isDirectory()) return [p + " is a folder; list it.", true];
    if (st.size > 50 * 1024 * 1024) return [p + " is " + size(st.size) + ", too big to read here.", true];
    if (!(await ask("Read " + path.basename(p), size(st.size)))) return ["The user said no.", true];
    const buf = await fsp.readFile(p);
    if (isBinary(buf)) return [p + " is a binary file (" + size(st.size) + "), not text.", true];
    const all = buf.toString("utf8").split(/\r?\n/);
    const from = Math.max(1, a.from | 0 || 1);
    const want = Math.max(1, Math.min(2000, a.lines | 0 || 400));
    const part = all.slice(from - 1, from - 1 + want);
    const body = part.map((l, i) => String(from + i).padStart(4) + "  " + l).join("\n");
    ctx.cwd = path.dirname(p);
    return [clip(p + " (lines " + from + "-" + (from + part.length - 1) + " of " + all.length + ", " + size(st.size) + "):\n" + body, limit)];
  }

  if (act === "find") {
    const st = await stat(p);
    if (!st || !st.isDirectory()) return ["No folder at " + p + " to search.", true];
    if (!a.name && !a.text) return ["find needs a name pattern (like *.js or *report*) and/or text to look for.", true];
    if (!(await ask("Search " + path.basename(p) + (a.text ? " for \"" + a.text + "\"" : "")))) return ["The user said no.", true];
    const nameRe = a.name ? globRe(/[*?]/.test(a.name) ? a.name : "*" + a.name + "*") : null;
    const text = a.text ? String(a.text).toLowerCase() : null;
    const max = Math.max(1, Math.min(200, a.max | 0 || 40));
    const hits = [];
    const complete = await walk(p, async (fp, e) => {
      if (e.isDirectory()) { if (nameRe && !text && nameRe.test(e.name)) hits.push(fp + "\\"); return hits.length >= max ? "stop" : null; }
      if (nameRe && !nameRe.test(e.name)) return null;
      if (!text) { hits.push(fp); return hits.length >= max ? "stop" : null; }
      const s = await stat(fp);
      if (!s || s.size > 2 * 1024 * 1024) return null;
      const buf = await fsp.readFile(fp).catch(() => null);
      if (!buf || isBinary(buf)) return null;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(text)) {
          hits.push(path.relative(p, fp) + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 200));
          if (hits.length >= max) return "stop";
        }
      }
      return null;
    }, { ms: 10000 });
    ctx.cwd = p;
    if (!hits.length) return ["Nothing matching" + (complete ? "" : " (the search stopped early: a big folder; narrow the path)") + "."];
    return [clip((text ? "Lines" : "Matches") + " under " + p + ":\n" + hits.join("\n") + (hits.length >= max ? "\n(first " + max + ")" : "") + (complete ? "" : "\n(stopped early: a big folder)"), limit)];
  }

  if (act === "info") {
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + "."];
    if (!(await ask("Look at " + path.basename(p)))) return ["The user said no.", true];
    let extra = "";
    if (st.isDirectory()) {
      const n = await fsp.readdir(p).then((x) => x.length).catch(() => "?");
      extra = ", " + n + " entries";
    }
    return [p + ": " + (st.isDirectory() ? "folder" : "file, " + size(st.size)) + extra + ", created " + when(st.birthtimeMs) + ", changed " + when(st.mtimeMs) + (st.mode & 0o200 ? "" : ", read-only")];
  }

  if (act === "write" || act === "append") {
    const content = String(a.content == null ? "" : a.content);
    const st = await stat(p);
    if (st && st.isDirectory()) return [p + " is a folder.", true];
    if (act === "write" && st && !a.overwrite) return [p + " already exists (" + size(st.size) + "). To replace it, write again with overwrite: true; to change part of it, use edit.", true];
    const title = act === "append" ? "Add to " + path.basename(p) : (st ? "Replace " : "Create ") + path.basename(p);
    if (!(await ask(title, preview(content), { bytes: Buffer.byteLength(content) }))) return ["The user said no.", true];
    await fsp.mkdir(path.dirname(p), { recursive: true });
    if (act === "append") await fsp.appendFile(p, content);
    else await fsp.writeFile(p, content);
    ctx.cwd = path.dirname(p);
    return [(act === "append" ? "Added to " : st ? "Replaced " : "Created ") + p + " (" + size(Buffer.byteLength(content)) + ")."];
  }

  if (act === "edit") {
    const st = await stat(p);
    if (!st || st.isDirectory()) return ["No file at " + p + ".", true];
    const find = String(a.find || "");
    if (!find) return ["edit needs find (the exact text to change) and replace.", true];
    const text = await fsp.readFile(p, "utf8");
    const count = text.split(find).length - 1;
    if (!count) return ["That text isn't in " + path.basename(p) + ". Read the file and copy the exact lines.", true];
    if (count > 1 && !a.all) return ["That text is in " + path.basename(p) + " " + count + " times. Give more of the surrounding lines so it is unique, or set all: true.", true];
    const replace = String(a.replace == null ? "" : a.replace);
    const diff = "- " + preview(find, 8).replace(/\n/g, "\n- ") + "\n+ " + preview(replace, 8).replace(/\n/g, "\n+ ");
    if (!(await ask("Edit " + path.basename(p) + (count > 1 ? " (" + count + " places)" : ""), diff))) return ["The user said no.", true];
    const next = a.all ? text.split(find).join(replace) : text.replace(find, () => replace);
    await fsp.writeFile(p, next);
    ctx.cwd = path.dirname(p);
    return ["Changed " + (a.all ? count + " places" : "it") + " in " + p + "."];
  }

  if (act === "mkdir") {
    if (await stat(p)) return [p + " already exists."];
    if (!(await ask("New folder " + path.basename(p)))) return ["The user said no.", true];
    await fsp.mkdir(p, { recursive: true });
    ctx.cwd = p;
    return ["Made " + p + "."];
  }

  if (act === "move" || act === "copy") {
    const to = resolve(a.to, ctx);
    const g2 = guard(to, true);
    if (g2) return [g2, true];
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + ".", true];
    let dest = to;
    const tst = await stat(to);
    // Into a folder: one that exists, or a path written ending in a slash.
    if ((tst && tst.isDirectory()) || /[\\/]$/.test(String(a.to || ""))) dest = path.join(to, path.basename(p));
    if (await stat(dest)) return [dest + " already exists.", true];
    if (!(await ask((act === "move" ? "Move " : "Copy ") + path.basename(p), p + "\n→ " + dest))) return ["The user said no.", true];
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (act === "move") {
      try { await fsp.rename(p, dest); }
      catch (e) { if (e.code !== "EXDEV") throw e; await fsp.cp(p, dest, { recursive: true }); await fsp.rm(p, { recursive: true }); }
    } else await fsp.cp(p, dest, { recursive: true, errorOnExist: true });
    return [(act === "move" ? "Moved" : "Copied") + " to " + dest + "."];
  }

  if (act === "delete") {
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + "."];
    if (!(await ask("Delete " + path.basename(p) + " (to the Recycle Bin)", st.isDirectory() ? "a folder" : size(st.size)))) return ["The user said no.", true];
    const r = await recycle(p, st.isDirectory());
    if (!r.ok || (await stat(p))) return ["Couldn't delete it: " + (r.err.trim().split("\n")[0] || "unknown error"), true];
    return ["Deleted " + p + " (it's in the Recycle Bin)."];
  }

  if (act === "open") {
    const st = await stat(p);
    if (!st) return ["Nothing at " + p + ".", true];
    // A program opened is a program run: that always counts as a change.
    const runs = !st.isDirectory() && /\.(exe|bat|cmd|ps1|vbs|js|msi|lnk|com|scr|jar|py|reg)$/i.test(p);
    if (!(await ask("Open " + path.basename(p) + (runs ? " (runs it)" : ""), "", { write: runs }))) return ["The user said no.", true];
    run("explorer.exe", [p]);
    return ["Opened " + p + " on the main screen."];
  }

  return ["Unknown files action \"" + act + "\".", true];
}

// ---- the repo tool --------------------------------------------------------------------
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "blame", "rev-parse", "describe", "tag", "shortlog", "grep", "stash-list"]);
const GIT_WRITE = new Set(["init", "add", "commit", "checkout", "switch", "restore", "mv", "rm", "stash", "merge", "pull", "fetch", "clone", "push", "tag", "branch", "rebase", "cherry-pick", "revert", "apply"]);
const GIT_NEVER = [/--force\b|(^|\s)-f\b|--force-with-lease/, /^reset\s.*--hard|^clean\b|^filter-branch|^gc\b.*--prune|^update-ref|^reflog\s+expire|^config\s+--global|^config\s+--system/];

function splitArgs(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || "")))) out.push(m[1] != null ? m[1].replace(/\\"/g, "\"") : m[2] != null ? m[2] : m[3]);
  return out;
}
// Read-only: listing branches/tags/stashes without making one.
function gitIsRead(args) {
  const [cmd, ...rest] = args;
  if (cmd === "branch") return !rest.some((x) => !x.startsWith("-")) || rest.includes("--list") || rest.includes("-a") && rest.length === 1;
  if (cmd === "tag") return !rest.length || rest.includes("-l") || rest.includes("--list");
  if (cmd === "stash") return rest[0] === "list" || rest[0] === "show";
  if (cmd === "remote") return !rest.length || rest.join(" ") === "-v";
  return GIT_READ.has(cmd);
}

async function findRepoRoot(p) {
  let d = p;
  for (let i = 0; i < 40; i++) {
    if (await stat(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

async function repo(a, ctx) {
  const act = String(a.action || "overview");
  const p = resolve(a.path, ctx);
  const limit = ctx.limit || 12000;
  const ask = (title, detail, write) => ctx.ask({ tool: "repo", action: act, write: !!write, title, path: p, detail: detail || "" });

  if (act === "overview") {
    const st = await stat(p);
    if (!st || !st.isDirectory()) return ["No folder at " + p + ".", true];
    if (!(await ask("Look over " + path.basename(p)))) return ["The user said no.", true];
    const root = (await findRepoRoot(p)) || p;
    const out = [root];
    const git = await stat(path.join(root, ".git"));
    if (git) {
      const br = await run("git", ["branch", "--show-current"], root, 15000);
      const rem = await run("git", ["remote", "-v"], root, 15000);
      const stt = await run("git", ["status", "--short", "--branch"], root, 20000);
      const lg = await run("git", ["log", "--oneline", "-n", "10", "--date=short", "--format=%h %ad %s"], root, 20000);
      out.push("Git: branch " + (br.out.trim() || "(none)") + (rem.out.trim() ? "; remotes: " + [...new Set(rem.out.trim().split("\n").map((l) => l.replace(/\s+\((fetch|push)\)$/, "")))].join(", ") : "; no remote"));
      const changes = stt.out.trim().split("\n").slice(1);
      out.push(changes.length ? "Uncommitted (" + changes.length + "):\n" + changes.slice(0, 25).join("\n") + (changes.length > 25 ? "\n…" : "") : "Working tree clean.");
      if (lg.out.trim()) out.push("Latest commits:\n" + lg.out.trim());
    } else out.push("Not a git repo (repo create makes it one).");
    // What it is made of.
    const exts = new Map();
    let filesN = 0;
    await walk(root, async (fp, e) => { if (!e.isDirectory()) { filesN++; const x = path.extname(e.name).toLowerCase() || e.name; exts.set(x, (exts.get(x) || 0) + 1); } }, { ms: 4000, max: 30000 });
    out.push(filesN + " files: " + [...exts].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([x, n]) => x + " " + n).join(", "));
    const top = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    out.push("Top level: " + top.filter((e) => e.name !== ".git").sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name)).map((e) => e.name + (e.isDirectory() ? "/" : "")).slice(0, 60).join("  "));
    const pkg = await fsp.readFile(path.join(root, "package.json"), "utf8").then(JSON.parse).catch(() => null);
    if (pkg) out.push("package.json: " + (pkg.name || "") + (pkg.version ? " " + pkg.version : "") + (pkg.scripts ? "; scripts: " + Object.keys(pkg.scripts).join(", ") : "") + (pkg.dependencies ? "; deps: " + Object.keys(pkg.dependencies).slice(0, 15).join(", ") : ""));
    const readme = top.find((e) => /^readme(\.md|\.txt)?$/i.test(e.name));
    if (readme) {
      const t = await fsp.readFile(path.join(root, readme.name), "utf8").catch(() => "");
      out.push(readme.name + " (start):\n" + t.split(/\r?\n/).slice(0, 30).join("\n"));
    }
    ctx.cwd = root;
    return [clip(out.join("\n\n"), limit)];
  }

  if (act === "git") {
    const args = Array.isArray(a.args) ? a.args.map(String) : splitArgs(a.args || a.command || "");
    if (args[0] === "git") args.shift();
    if (!args.length) return ["git needs args, like \"status\" or \"log -n 5\".", true];
    const line = args.join(" ");
    if (GIT_NEVER.some((re) => re.test(line))) return ["I don't run that one (it can throw away work or rewrite history): git " + line, true];
    if (!GIT_READ.has(args[0]) && !GIT_WRITE.has(args[0])) return ["git " + args[0] + " isn't one I run. I can: " + [...GIT_READ, ...GIT_WRITE].join(", ") + ".", true];
    const read = gitIsRead(args);
    const cwd = args[0] === "clone" ? p : ((await findRepoRoot(p)) || p);
    if (!(await stat(cwd))) return ["No folder at " + cwd + ".", true];
    if (!read) { const g = guard(cwd, true); if (g) return [g, true]; }
    if (!(await ask("git " + line, "in " + cwd, !read))) return ["The user said no.", true];
    const r = await run("git", args[0] === "log" && !args.some((x) => /^-n|^--max-count|^-\d/.test(x)) ? [...args, "-n", "30"] : args, cwd, args[0] === "clone" || args[0] === "push" || args[0] === "pull" || args[0] === "fetch" ? 180000 : 60000);
    ctx.cwd = cwd;
    const text = (r.out + (r.err.trim() ? "\n" + r.err.trim() : "")).trim() || (r.ok ? "(done, no output)" : "");
    return [clip("git " + line + (r.ok ? "" : " (failed)") + ":\n" + text, limit), !r.ok];
  }

  if (act === "create") {
    if (guard(p, true)) return [guard(p, true), true];
    const st = await stat(p);
    if (st && (await stat(path.join(p, ".git")))) return [p + " is already a git repo.", true];
    const name = a.name || path.basename(p);
    if (!(await ask("New repo " + name, p + (st ? " (existing folder)" : " (new folder)") + "\nwith a README" + (a.gitignore ? " and a " + a.gitignore + " .gitignore" : ""), true))) return ["The user said no.", true];
    await fsp.mkdir(p, { recursive: true });
    const init = await run("git", ["init", "-b", "main"], p, 20000);
    if (!init.ok) return ["git init failed: " + init.err.trim(), true];
    if (!(await stat(path.join(p, "README.md")))) await fsp.writeFile(path.join(p, "README.md"), "# " + name + "\n\n" + (a.description ? a.description + "\n" : ""));
    const IGN = { node: "node_modules/\ndist/\n.env\n", python: "__pycache__/\n*.pyc\n.venv/\n.env\n" };
    if (a.gitignore && IGN[a.gitignore] && !(await stat(path.join(p, ".gitignore")))) await fsp.writeFile(path.join(p, ".gitignore"), IGN[a.gitignore]);
    ctx.cwd = p;
    return ["Made a git repo at " + p + " (branch main, with a README" + (a.gitignore ? " and .gitignore" : "") + "). Nothing is committed yet."];
  }

  if (act === "publish") {
    const root = await findRepoRoot(p);
    if (!root) return [p + " isn't a git repo yet (repo create first).", true];
    const gh = await run("gh", ["--version"], root, 10000);
    if (!gh.ok) return ["The GitHub CLI (gh) isn't installed or signed in, so I can't make a GitHub repo.", true];
    const name = String(a.name || path.basename(root)).replace(/[^\w.\-]/g, "-");
    const vis = a.public ? "--public" : "--private";
    if (!(await ask("Make GitHub repo " + name + " (" + (a.public ? "public" : "private") + ") and push", root, true))) return ["The user said no.", true];
    const r = await run("gh", ["repo", "create", name, vis, "--source", root, "--push"], root, 180000);
    return [(r.ok ? "Done: " : "gh failed: ") + (r.out + "\n" + r.err).trim().slice(0, 1500), !r.ok];
  }

  return ["Unknown repo action \"" + act + "\".", true];
}

const TOOL_DEFS = [
  {
    name: "files", where: "server", core: true,
    description: "The user's files, anywhere on their PC. Paths are full Windows paths (C:\\Users\\...) or relative to the folder you used last (~ = their home folder). list (path): a folder's contents. tree (path, depth): the folder structure. read (path, from, lines): a text file with line numbers; read big files a part at a time. find (path, name like *.py, and/or text): search a folder by file name and/or contents. info (path). write (path, content, overwrite): create a file (overwrite: true to replace one). append (path, content). edit (path, find, replace, all): change exact text in a file (read it first and copy the lines exactly). mkdir, move (path, to), copy (path, to), delete (to the Recycle Bin), open (in Explorer or its app). Changes wait for the user's OK on the panel unless they turned that off; if they say no, accept it.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "tree", "read", "find", "info", "write", "append", "edit", "mkdir", "move", "copy", "delete", "open"] },
        path: { type: "string" }, to: { type: "string" }, content: { type: "string" },
        find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" }, overwrite: { type: "boolean" },
        name: { type: "string" }, text: { type: "string" }, from: { type: "integer" }, lines: { type: "integer" }, depth: { type: "integer" },
      },
      required: ["action"],
    },
  },
  {
    name: "repo", where: "server", core: true,
    description: "Code projects and git. overview (path): what a repo is at a glance (branch, uncommitted changes, latest commits, what it's made of, README); start here, then read files with the files tool. git (path, args): run git in that repo, e.g. \"status\", \"log -n 10\", \"diff\", \"add -A\", \"commit -m \\\"message\\\"\", \"switch -c new-branch\", \"push\", \"clone <url>\" (clone runs in path). create (path, name, gitignore: node|python, description): a new local repo with a README. publish (path, name, public): a new GitHub repo from it, pushed (private unless asked). Never force-push or throw work away.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["overview", "git", "create", "publish"] },
        path: { type: "string" }, args: { type: "string" }, name: { type: "string" },
        gitignore: { type: "string", enum: ["node", "python"] }, description: { type: "string" }, public: { type: "boolean" },
      },
      required: ["action"],
    },
  },
];

// ---- for the Jarvis Code app (you browsing, not the model) --------------------------
async function listDir(p) {
  const g = guard(p, false);
  if (g) return { ok: false, error: g };
  const st = await stat(p);
  if (!st || !st.isDirectory()) return { ok: false, error: "No folder at " + p };
  const ents = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of ents.slice(0, 2000)) {
    if (e.name === ".git") continue;
    const s = e.isDirectory() ? null : await stat(path.join(p, e.name));
    out.push({ name: e.name, dir: e.isDirectory(), size: s ? s.size : 0, at: s ? s.mtimeMs : 0, skip: e.isDirectory() && SKIP_DIRS.has(e.name) });
  }
  out.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" }));
  return { ok: true, path: p, parent: path.dirname(p) !== p ? path.dirname(p) : null, entries: out };
}
async function readText(p, max) {
  const g = guard(p, false);
  if (g) return { ok: false, error: g };
  const st = await stat(p);
  if (!st || st.isDirectory()) return { ok: false, error: "No file at " + p };
  if (st.size > (max || 2 * 1024 * 1024)) return { ok: true, path: p, size: st.size, tooBig: true, text: "" };
  const buf = await fsp.readFile(p);
  if (isBinary(buf)) return { ok: true, path: p, size: st.size, binary: true, text: "" };
  return { ok: true, path: p, size: st.size, at: st.mtimeMs, text: buf.toString("utf8") };
}
async function gitStatus(root) {
  if (!(await stat(path.join(root, ".git")))) return { ok: true, git: false };
  const [br, stt, lg, rem] = await Promise.all([
    run("git", ["branch", "--show-current"], root, 15000),
    run("git", ["status", "--porcelain=v1", "--branch", "--untracked-files=all"], root, 20000),
    run("git", ["log", "-n", "15", "--date=iso-strict", "--format=%h%x09%ad%x09%an%x09%s"], root, 20000),
    run("git", ["remote", "-v"], root, 15000),
  ]);
  const lines = stt.out.split(/\r?\n/).filter(Boolean);
  const head = lines[0] && lines[0].startsWith("##") ? lines.shift() : "";
  const ab = head.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
  return {
    ok: true, git: true, branch: br.out.trim(),
    upstream: (head.match(/\.\.\.(\S+)/) || [])[1] || null,
    ahead: ab && ab[1] ? Number(ab[1]) : 0, behind: ab && ab[2] ? Number(ab[2]) : 0,
    changes: lines.map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, "") })),
    log: lg.out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [h, at, who, msg] = l.split("\t"); return { hash: h, at, who, msg }; }),
    remotes: [...new Set(rem.out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/).slice(0, 2).join(" ")))],
  };
}
async function gitDiff(root, file) {
  const args = ["diff", "HEAD", "--no-color", "--"];
  if (file) args.push(file);
  let r = await run("git", args, root, 30000);
  // A repo with no commits yet has no HEAD: show what is staged and not.
  if (!r.ok && /ambiguous argument 'HEAD'|bad revision/.test(r.err)) r = await run("git", ["diff", "--no-color", "--"].concat(file ? [file] : []), root, 30000);
  return { ok: r.ok, text: r.out, error: r.ok ? null : r.err.trim() };
}

module.exports = { init, files, repo, TOOL_DEFS, resolve, guard, listDir, readText, gitStatus, gitDiff, run, findRepoRoot, SKIP_DIRS };
