// ============================================================================
//  Jarvis's precise file tools, for code and any text: grep and lines.
//
//  grep:  search inside files: literal or regex, case, whole words, include
//         and exclude globs, lines of context, files-only or counts.
//  lines: work by line number: read a range (or around a line), read several
//         files at once, an outline of a file's definitions, replace / insert /
//         delete lines, several exact edits in one go (all or nothing), a regex
//         replace, a diff of two files, counts, the tail of a log.
//
//  Same rules as the files tool (assistant-files.js): the same never-touch
//  places, and every action goes through ctx.ask first. Edits keep the file's
//  own line endings (CRLF stays CRLF).
// ============================================================================
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const F = require("./assistant-files");

const MAX_FILE = 4 * 1024 * 1024;

async function loadText(p) {
  const st = await F.stat(p);
  if (!st) return { error: "Nothing at " + p + "." };
  if (st.isDirectory()) return { error: p + " is a folder." };
  if (st.size > 50 * 1024 * 1024) return { error: p + " is " + F.size(st.size) + ", too big." };
  const buf = await fsp.readFile(p);
  if (F.isBinary(buf)) return { error: p + " is a binary file, not text. Use the binary tool (info, strings, search, hex, pe, zip)." };
  let text = buf.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const endsNl = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (endsNl) lines.pop();
  return { st, lines, eol, endsNl, bom };
}
function joinText(f, lines) {
  return (f.bom ? "﻿" : "") + lines.join(f.eol) + (f.endsNl && lines.length ? f.eol : "");
}
const numbered = (lines, from) => lines.map((l, i) => String(from + i).padStart(5) + "  " + l).join("\n");
// The changed lines with two around them, after an edit (long ones shortened).
function around(lines, start, count) {
  const a = Math.max(1, start - 2), b = Math.min(lines.length, start + Math.max(0, count - 1) + 2);
  if (b - a > 40) return numbered(lines.slice(a - 1, a + 17), a) + "\n  …\n" + numbered(lines.slice(b - 18, b), b - 17);
  return b >= a ? numbered(lines.slice(a - 1, b), a) : "(the file is empty)";
}
const splitLines = (s) => String(s == null ? "" : s).replace(/\r?\n$/, "").split(/\r?\n/);

// A short diff for the approval card.
function hunk(oldL, newL, at) {
  const out = ["@@ line " + at + " @@"];
  for (const l of oldL.slice(0, 12)) out.push("- " + l);
  if (oldL.length > 12) out.push("- … " + (oldL.length - 12) + " more");
  for (const l of newL.slice(0, 12)) out.push("+ " + l);
  if (newL.length > 12) out.push("+ … " + (newL.length - 12) + " more");
  return out.join("\n");
}

function globList(s) {
  return String(s || "").split(/[,;]\s*|\s+/).filter(Boolean).map((g) => F.globRe(/[*?]/.test(g) ? g : (g.startsWith(".") ? "*" + g : g)));
}

// ---- grep ---------------------------------------------------------------------------
async function grep(a, ctx) {
  const p = F.resolve(a.path, ctx);
  const g = F.guard(p, false);
  if (g) return [g, true];
  const pat = String(a.pattern || a.text || "");
  if (!pat) return ["grep needs a pattern.", true];
  let re;
  try {
    const src = a.regex ? pat : pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(a.whole_word ? "\\b(?:" + src + ")\\b" : src, a.case_sensitive ? "" : "i");
  } catch (e) { return ["That pattern isn't a valid regular expression: " + e.message, true]; }
  const st = await F.stat(p);
  if (!st) return ["Nothing at " + p + ".", true];
  if (!(await ctx.ask({ tool: "grep", action: "search", write: false, title: "Search " + path.basename(p) + " for \"" + pat.slice(0, 60) + "\"", path: p }))) return ["The user said no.", true];
  const inc = globList(a.include), exc = globList(a.exclude);
  const context = Math.max(0, Math.min(6, a.context | 0));
  const max = Math.max(1, Math.min(400, a.max | 0 || 80));
  const filesOnly = !!a.files_only, count = !!a.count;
  const out = [];
  let hits = 0, filesHit = 0, scanned = 0;
  const base = st.isDirectory() ? p : path.dirname(p);
  const searchFile = async (fp) => {
    const name = path.basename(fp);
    if (inc.length && !inc.some((r) => r.test(name))) return;
    if (exc.some((r) => r.test(name))) return;
    const s = await F.stat(fp);
    if (!s || s.size > MAX_FILE) return;
    const buf = await fsp.readFile(fp).catch(() => null);
    if (!buf || F.isBinary(buf)) return;
    scanned++;
    const lines = buf.toString("utf8").split(/\r?\n/);
    const rel = path.relative(base, fp) || name;
    const found = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push(i);
    if (!found.length) return;
    filesHit++;
    if (filesOnly) { out.push(rel + " (" + found.length + ")"); hits++; return; }
    if (count) { out.push(rel + ": " + found.length); hits += found.length; return; }
    let last = -1;
    for (const i of found) {
      if (hits >= max) return "stop";
      const from = Math.max(0, i - context), to = Math.min(lines.length - 1, i + context);
      if (context && last >= 0 && from > last + 1) out.push("--");
      for (let k = Math.max(from, last + 1); k <= to; k++) out.push(rel + (k === i ? ":" : "-") + (k + 1) + (k === i ? ": " : "- ") + lines[k].slice(0, 300));
      last = to;
      hits++;
    }
    if (hits >= max) return "stop";
  };
  let complete = true;
  if (st.isDirectory()) {
    complete = await F.walk(p, async (fp, e) => (e.isDirectory() ? null : searchFile(fp)), { ms: 20000, max: 60000 });
  } else await searchFile(p);
  ctx.cwd = base;
  if (!out.length) return ["No match for \"" + pat + "\" in " + scanned + " file" + (scanned === 1 ? "" : "s") + (complete ? "" : " (stopped early: a big folder; narrow the path or use include)") + "."];
  const head = (count ? "Matches per file" : filesOnly ? "Files with matches" : hits + " match" + (hits === 1 ? "" : "es") + " in " + filesHit + " file" + (filesHit === 1 ? "" : "s")) + " under " + base + ":";
  return [F.clip(head + "\n" + out.join("\n") + (hits >= max ? "\n(stopped at " + max + "; raise max or narrow it)" : "") + (complete ? "" : "\n(stopped early: a big folder)"), ctx.limit || 12000)];
}

// ---- outline: the definitions in a file, with line numbers -----------------------------
const OUTLINE = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/,            // JS function
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,                 // class (JS/TS/Py-less)
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|[\w$]+\s*=>)/, // arrow fn
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)/,                              // TS
  /^\s*(?:async\s+)?def\s+(\w+)/,                                                     // Python def
  /^\s*class\s+(\w+)/,                                                                // Python class
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,                                           // Rust
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/,                                                // Go
  /^\s*(?:public|private|protected|internal|static|override|virtual|async|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\([^;]*$/, // C#/Java method
  /^\s*(?:function|filter)\s+([\w-]+)/i,                                              // PowerShell
  /^\s{2,4}(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, // JS method
  /^(#{1,4})\s+(.+)/,                                                                 // Markdown heading
];
function outline(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 400) continue;
    if (/^\s*(?:if|for|while|switch|catch|return|else)\b/.test(l)) continue;
    for (const re of OUTLINE) {
      const m = l.match(re);
      if (m) { out.push(String(i + 1).padStart(5) + "  " + l.trim().slice(0, 140)); break; }
    }
  }
  return out;
}

// ---- lines --------------------------------------------------------------------------
const LINE_READS = new Set(["read", "read_many", "outline", "count", "tail", "diff"]);

async function lines(a, ctx) {
  const act = String(a.action || "read");
  const p = F.resolve(a.path, ctx);
  const write = !LINE_READS.has(act);
  const g = F.guard(p, write);
  if (g) return [g, true];
  const limit = ctx.limit || 12000;
  const ask = (title, detail) => ctx.ask({ tool: "lines", action: act, write, title, path: p, detail: detail || "" });
  const no = ["The user said no.", true];

  if (act === "read_many") {
    const reads = Array.isArray(a.reads) ? a.reads.slice(0, 12) : [];
    if (!reads.length) return ["read_many needs reads: [{path, from, to}].", true];
    if (!(await ctx.ask({ tool: "lines", action: act, write: false, title: "Read " + reads.length + " files", path: reads.map((r) => r.path).join(", ") }))) return no;
    const parts = [];
    for (const r of reads) {
      const fp = F.resolve(r.path, ctx);
      const gg = F.guard(fp, false);
      if (gg) { parts.push(fp + ": " + gg); continue; }
      const f = await loadText(fp);
      if (f.error) { parts.push(f.error); continue; }
      const from = Math.max(1, r.from | 0 || 1);
      const to = Math.min(f.lines.length, r.to | 0 || from + 299);
      parts.push("== " + fp + " (lines " + from + "-" + to + " of " + f.lines.length + ")\n" + numbered(f.lines.slice(from - 1, to), from));
    }
    return [F.clip(parts.join("\n\n"), limit)];
  }

  if (act === "diff") {
    if (!a.other) return ["diff needs other: the file to compare with.", true];
    const q = F.resolve(a.other, ctx);
    const g2 = F.guard(q, false);
    if (g2) return [g2, true];
    if (!(await ask("Compare " + path.basename(p) + " with " + path.basename(q)))) return no;
    const r = await F.run("git", ["diff", "--no-index", "--no-color", "-U" + Math.max(0, Math.min(10, a.context == null ? 3 : a.context | 0)), "--", p, q], undefined, 30000);
    // Exit code 1 just means "they differ".
    if (r.err.trim() && !r.out) return ["Couldn't compare: " + r.err.trim(), true];
    return [F.clip(r.out.trim() || "The two files are the same.", limit)];
  }

  const f = await loadText(p);
  if (f.error) return [f.error, true];
  const n = f.lines.length;
  ctx.cwd = path.dirname(p);

  if (act === "read") {
    if (!(await ask("Read " + path.basename(p)))) return no;
    let from, to;
    if (a.line) { const c = Math.max(0, Math.min(200, a.context == null ? 15 : a.context | 0)); from = Math.max(1, (a.line | 0) - c); to = Math.min(n, (a.line | 0) + c); }
    else { from = Math.max(1, a.from | 0 || 1); to = Math.min(n, a.to | 0 || from + 399); }
    if (from > n) return [p + " has only " + n + " lines.", true];
    return [F.clip(p + " (lines " + from + "-" + to + " of " + n + (f.eol === "\r\n" ? ", CRLF" : "") + "):\n" + numbered(f.lines.slice(from - 1, to), from), limit)];
  }
  if (act === "tail") {
    if (!(await ask("Read the end of " + path.basename(p)))) return no;
    const k = Math.max(1, Math.min(1000, a.lines | 0 || 50));
    return [F.clip(p + " (last " + Math.min(k, n) + " of " + n + " lines):\n" + numbered(f.lines.slice(-k), Math.max(1, n - k + 1)), limit)];
  }
  if (act === "outline") {
    if (!(await ask("Outline " + path.basename(p)))) return no;
    const o = outline(f.lines);
    return [F.clip(p + " (" + n + " lines): " + (o.length ? o.length + " definitions\n" + o.join("\n") : "no definitions found; read it instead"), limit)];
  }
  if (act === "count") {
    if (!(await ask("Count " + path.basename(p)))) return no;
    const text = f.lines.join("\n");
    return [p + ": " + n + " lines, " + (text.match(/\S+/g) || []).length + " words, " + text.length + " characters, " + F.size(f.st.size) + ", " + (f.eol === "\r\n" ? "CRLF" : "LF") + " line endings" + (f.bom ? ", UTF-8 BOM" : "") + ", " + (f.endsNl ? "ends with a newline" : "no final newline") + "."];
  }

  // ---- changes ----
  const save = async (next, title, detail) => {
    if (!(await ask(title, detail))) return false;
    await fsp.writeFile(p, joinText(f, next));
    return true;
  };
  // A guard against stale line numbers: the text the first line should contain.
  const checkExpect = (from) => {
    if (a.expect == null || a.expect === "") return null;
    const got = f.lines[from - 1] || "";
    return got.includes(String(a.expect)) ? null : "Line " + from + " no longer says \"" + a.expect + "\" (it is: " + got.trim().slice(0, 120) + "). Read the part again before changing it.";
  };

  if (act === "replace" || act === "delete") {
    const from = a.from | 0, to = a.to | 0 || from;
    if (from < 1 || to < from || to > n) return ["Give from and to between 1 and " + n + " (from ≤ to).", true];
    const bad = checkExpect(from);
    if (bad) return [bad, true];
    const old = f.lines.slice(from - 1, to);
    const neu = act === "delete" ? [] : splitLines(a.content);
    const next = f.lines.slice(0, from - 1).concat(neu, f.lines.slice(to));
    if (!(await save(next, (act === "delete" ? "Delete" : "Replace") + " lines " + from + "-" + to + " of " + path.basename(p), hunk(old, neu, from)))) return no;
    return [(act === "delete" ? "Deleted" : "Replaced") + " lines " + from + "-" + to + " (" + old.length + " → " + neu.length + " lines). The file has " + next.length + " lines now; numbers after line " + to + " moved by " + (neu.length - old.length) + ".\nIt reads now:\n" + around(next, from, neu.length)];
  }
  if (act === "insert") {
    const at = a.at == null || (a.at | 0) <= 0 || (a.at | 0) > n ? n + 1 : a.at | 0;
    const neu = splitLines(a.content);
    if (!a.content && a.content !== "") return ["insert needs content.", true];
    const next = f.lines.slice(0, at - 1).concat(neu, f.lines.slice(at - 1));
    if (!(await save(next, "Insert " + neu.length + " line" + (neu.length === 1 ? "" : "s") + " at line " + at + " of " + path.basename(p), hunk([], neu, at)))) return no;
    return ["Inserted " + neu.length + " lines " + (at > n ? "at the end" : "before what was line " + at) + ". The file has " + next.length + " lines now.\nIt reads now:\n" + around(next, at, neu.length)];
  }
  if (act === "multi_edit") {
    const edits = Array.isArray(a.edits) ? a.edits.slice(0, 40) : [];
    if (!edits.length) return ["multi_edit needs edits: [{find, replace, all}].", true];
    let text = f.lines.join("\n");
    const cards = [];
    for (const [i, e] of edits.entries()) {
      const find = String(e.find || "").replace(/\r\n/g, "\n");
      if (!find) return ["Edit " + (i + 1) + " has no find text. Nothing was changed.", true];
      const c = text.split(find).length - 1;
      if (!c) return ["Edit " + (i + 1) + ": that text isn't in the file (after the edits before it). Nothing was changed. Read the file and copy the lines exactly.", true];
      if (c > 1 && !e.all) return ["Edit " + (i + 1) + ": that text is there " + c + " times. Give more lines so it's unique, or set all. Nothing was changed.", true];
      const rep = String(e.replace == null ? "" : e.replace).replace(/\r\n/g, "\n");
      text = e.all ? text.split(find).join(rep) : text.replace(find, () => rep);
      cards.push(hunk(find.split("\n"), rep.split("\n"), "edit " + (i + 1)));
    }
    if (!(await save(text.split("\n"), edits.length + " edits to " + path.basename(p), cards.join("\n")))) return no;
    return ["Made all " + edits.length + " edits to " + p + "."];
  }
  if (act === "regex_replace") {
    let re;
    try { re = new RegExp(String(a.pattern || ""), "g" + (a.case_sensitive ? "" : "i") + (a.multiline ? "m" : "")); } catch (e) { return ["Bad regular expression: " + e.message, true]; }
    if (!a.pattern) return ["regex_replace needs a pattern.", true];
    const text = f.lines.join("\n");
    const hits = text.match(re) || [];
    if (!hits.length) return ["No match for /" + a.pattern + "/ in " + path.basename(p) + ". Nothing changed."];
    const next = text.replace(re, String(a.replace == null ? "" : a.replace));
    const sample = hits.slice(0, 6).map((h) => "- " + h.slice(0, 100) + "\n+ " + h.replace(new RegExp(re.source, re.flags.replace("g", "")), String(a.replace || "")).slice(0, 100)).join("\n");
    if (!(await save(next.split("\n"), "Replace " + hits.length + " match" + (hits.length === 1 ? "" : "es") + " in " + path.basename(p), sample))) return no;
    return ["Replaced " + hits.length + " match" + (hits.length === 1 ? "" : "es") + " of /" + a.pattern + "/ in " + p + "."];
  }
  return ["Unknown lines action \"" + act + "\".", true];
}

const TOOL_DEFS = [
  {
    name: "grep", where: "server", core: false,
    description: "Search inside files, like ripgrep: every matching line with its file and line number. path: a folder (searched through, skipping node_modules, .git and build folders) or one file. pattern: the text (literal unless regex: true). case_sensitive, whole_word. include / exclude: file globs, comma-separated (\"*.js,*.ts\", \"*.min.js\"). context: lines around each match (0-6). files_only: just the files that match. count: matches per file. max: stop after this many (default 80).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }, pattern: { type: "string" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" }, whole_word: { type: "boolean" },
        include: { type: "string" }, exclude: { type: "string" }, context: { type: "integer" }, files_only: { type: "boolean" }, count: { type: "boolean" }, max: { type: "integer" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "lines", where: "server", core: false,
    description: "Read and change text files by line number. read (path, from, to; or line + context for the lines around one). read_many (reads: [{path, from, to}]) several files or parts at once. outline (path): its functions, classes and headings with line numbers. tail (path, lines): the end, for logs. count (path): lines, words, line endings. diff (path, other): what differs between two files. replace (path, from, to, content): those lines become content. insert (path, at, content): before line at (leave at out for the end). delete (path, from, to). expect (with replace/delete): text line from must still contain, a check that the numbers are current. multi_edit (path, edits: [{find, replace, all}]): several exact edits at once, all or none. regex_replace (path, pattern, replace, case_sensitive, multiline): replace every match ($1 for groups). Line endings are kept. Changes wait for the user's OK unless they turned that off.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "read_many", "outline", "tail", "count", "diff", "replace", "insert", "delete", "multi_edit", "regex_replace"] },
        path: { type: "string" }, other: { type: "string" }, to: { type: "integer" }, from: { type: "integer" }, line: { type: "integer" }, context: { type: "integer" }, lines: { type: "integer" },
        at: { type: "integer" }, content: { type: "string" }, expect: { type: "string" },
        reads: { type: "array", items: { type: "object", properties: { path: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["path"] } },
        edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, required: ["find"] } },
        pattern: { type: "string" }, replace: { type: "string" }, case_sensitive: { type: "boolean" }, multiline: { type: "boolean" },
      },
      required: ["action"],
    },
  },
];

module.exports = { grep, lines, outline, TOOL_DEFS };
