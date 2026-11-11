// ============================================================================
//  The small things that break an agent, handled in one place.
//
//  Local models get tool calls slightly wrong all the time. Rather than fail
//  the step, Jarvis repairs what he safely can and explains what he can't:
//
//  - repairJson: arguments that are almost JSON (code fences, trailing
//    commas, single quotes, unquoted keys, Python True/None, a missing
//    closing brace, a stringified object).
//  - textCalls: a tool call written into the reply as text (<tool_call>…,
//    ```json {"name":…, "arguments":…}```, name({...})) instead of as a call.
//  - normalizeCall: a tool name that is close to a real one (read_file ->
//    files, run_command -> shell, a typo), and arguments checked against the
//    tool's schema: types coerced ("5" -> 5, "true" -> true, "a" -> ["a"]),
//    enum values matched loosely, required ones named when missing.
//  - capOutput: a tool result too big for the context, cut to head and tail.
//  - callKey: the same call again and again (a loop) can be spotted.
// ============================================================================

// ---- JSON that is almost JSON ---------------------------------------------------------
function repairJson(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  let s = String(raw).trim();
  if (!s) return {};
  const tryParse = (x) => { try { const v = JSON.parse(x); return v; } catch (e) { return undefined; } };
  let v = tryParse(s);
  if (v !== undefined) return typeof v === "string" ? repairJson(v) : v;
  // ```json ... ```
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // Text around the object.
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a > 0 && b > a) s = s.slice(a, b + 1);
  else if (a > 0) s = s.slice(a);
  v = tryParse(s);
  if (v !== undefined) return v;
  let t = s
    .replace(/,\s*([}\]])/g, "$1")                                   // trailing commas
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')            // unquoted keys
    .replace(/:\s*True\b/g, ": true").replace(/:\s*False\b/g, ": false").replace(/:\s*None\b/g, ": null");
  // Single-quoted strings -> JSON strings (a ' inside a "..." string is left alone).
  t = singleToDouble(t);
  v = tryParse(t);
  if (v !== undefined) return v;
  // Unclosed: close strings, arrays and objects in order.
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if ((ch === "}" || ch === "]") && stack.length) stack.pop();
  }
  let closed = t + (inStr ? '"' : "") + stack.reverse().join("");
  closed = closed.replace(/,\s*([}\]])/g, "$1").replace(/:\s*([}\]])/g, ": null$1");
  v = tryParse(closed);
  if (v !== undefined) return v;
  return null;
}

function singleToDouble(t) {
  let out = "", i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '"') {
      // Copy a double-quoted string as it is.
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === "'") {
      let j = i + 1, s = "";
      while (j < t.length && t[j] !== "'") { if (t[j] === "\\" && j + 1 < t.length) { s += t[j + 1] === "'" || t[j + 1] === "\\" ? t[j + 1] : t[j] + t[j + 1]; j += 2; } else s += t[j++]; }
      out += JSON.stringify(s); i = j + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ---- tool calls written as text ---------------------------------------------------------
// Returns { calls: [{name, input}], rest } when the reply holds calls to tools
// that exist; otherwise null.
function textCalls(text, names) {
  const t = String(text || "");
  if (!t || !names || !names.size) return null;
  const calls = [];
  let rest = t;
  const take = (whole, obj) => {
    if (!obj || typeof obj !== "object") return false;
    const name = obj.name || obj.tool || obj.function || (obj.function_call && obj.function_call.name);
    let input = obj.arguments != null ? obj.arguments : obj.parameters != null ? obj.parameters : obj.input != null ? obj.input : obj.args;
    if (typeof name !== "string" || !names.has(name)) return false;
    if (typeof input === "string") input = repairJson(input) || {};
    calls.push({ name, input: input && typeof input === "object" ? input : {} });
    rest = rest.replace(whole, "");
    return true;
  };
  // <tool_call>{...}</tool_call> (Qwen, Hermes), <function_call>, [TOOL_CALLS] [...]
  for (const m of t.matchAll(/<(tool_call|function_call|tool_use)>\s*([\s\S]*?)\s*<\/\1>/g)) take(m[0], repairJson(m[2]));
  if (!calls.length) {
    const m = t.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/);
    if (m) { const arr = repairJson(m[1]); if (Array.isArray(arr)) { for (const x of arr) take("", x); if (calls.length) rest = rest.replace(m[0], ""); } }
  }
  // ```json {"name": "...", "arguments": {...}} ```
  if (!calls.length) for (const m of t.matchAll(/```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g)) take(m[0], repairJson(m[1]));
  // A bare object that is the whole reply.
  if (!calls.length && /^\s*\{[\s\S]*\}\s*$/.test(t)) take(t, repairJson(t));
  // name({...}) or name {...} at the start of a line.
  if (!calls.length) {
    for (const m of t.matchAll(/(?:^|\n)\s*`?([a-z_][a-z0-9_]{1,40})`?\s*\(?\s*(\{[\s\S]*?\})\s*\)?\s*(?=\n|$)/g)) {
      if (!names.has(m[1])) continue;
      const input = repairJson(m[2]);
      if (input && typeof input === "object") { calls.push({ name: m[1], input }); rest = rest.replace(m[0], ""); }
    }
  }
  return calls.length ? { calls, rest: rest.trim() } : null;
}

// ---- names and arguments ---------------------------------------------------------------
// What models reach for, mapped to Jarvis's tools (and, where the name says
// it, the action).
const ALIASES = {
  read_file: ["files", { action: "read" }], readfile: ["files", { action: "read" }], open_file: ["files", { action: "read" }], cat: ["files", { action: "read" }], view_file: ["files", { action: "read" }],
  write_file: ["files", { action: "write" }], create_file: ["files", { action: "write" }], save_file: ["files", { action: "write" }],
  edit_file: ["files", { action: "edit" }], str_replace: ["files", { action: "edit" }], replace_in_file: ["files", { action: "edit" }], apply_edit: ["files", { action: "edit" }],
  list_files: ["files", { action: "list" }], list_dir: ["files", { action: "list" }], list_directory: ["files", { action: "list" }], ls: ["files", { action: "list" }], dir: ["files", { action: "list" }],
  find_files: ["files", { action: "find" }], glob: ["files", { action: "find" }], file_search: ["files", { action: "find" }],
  delete_file: ["files", { action: "delete" }], move_file: ["files", { action: "move" }], copy_file: ["files", { action: "copy" }], mkdir: ["files", { action: "mkdir" }],
  search: ["grep", null], search_files: ["grep", null], grep_search: ["grep", null], ripgrep: ["grep", null], rg: ["grep", null], codebase_search: ["grep", null], search_code: ["grep", null],
  run_command: ["shell", { action: "run" }], run_terminal_cmd: ["shell", { action: "run" }], execute_command: ["shell", { action: "run" }], terminal: ["shell", { action: "run" }], bash: ["shell", { action: "run" }], powershell: ["shell", { action: "run" }], cmd: ["shell", { action: "run", shell: "cmd" }], exec: ["shell", { action: "run" }], run_shell: ["shell", { action: "run" }],
  run_python: ["python", { action: "run" }], python_exec: ["python", { action: "run" }], execute_python: ["python", { action: "run" }], pip_install: ["python", { action: "install" }],
  install: ["programs", { action: "install" }], install_program: ["programs", { action: "install" }], winget: ["programs", null],
  git: ["repo", { action: "git" }], git_command: ["repo", { action: "git" }],
  search_web: ["web_search", null], google: ["web_search", null], websearch: ["web_search", null], browse: ["read_page", null], fetch_url: ["read_page", null], open_url: ["read_page", null], fetch: ["read_page", null],
  todo_write: ["todo", { action: "set" }], update_plan: ["todo", { action: "set" }], plan: ["todo", null],
  hexdump: ["binary", { action: "hex" }], strings: ["binary", { action: "strings" }],
};
// Edit distance where swapping two neighbouring letters counts as one slip.
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}
function fixName(name, offered) {
  const raw = String(name || "");
  if (offered.has(raw)) return { name: raw };
  const n = raw.toLowerCase().replace(/^functions?[.:]/, "").replace(/^tools?[.:]/, "").replace(/[\s-]+/g, "_");
  if (offered.has(n)) return { name: n, note: "\"" + raw + "\" taken as " + n };
  const al = ALIASES[n];
  if (al && offered.has(al[0])) return { name: al[0], preset: al[1], note: "\"" + raw + "\" taken as " + al[0] + (al[1] && al[1].action ? " " + al[1].action : "") };
  let best = null, bd = 99;
  for (const o of offered) { const d = lev(n, o); if (d < bd) { bd = d; best = o; } }
  if (best && bd <= Math.max(1, Math.floor(best.length / 4))) return { name: best, note: "\"" + raw + "\" taken as " + best };
  return { error: "There is no tool called \"" + raw + "\". Your tools: " + [...offered].join(", ") + (best && bd <= 4 ? ". Did you mean " + best + "?" : "") + "." };
}

function coerce(v, sch) {
  if (!sch || v == null) return v;
  const type = Array.isArray(sch.type) ? sch.type[0] : sch.type;
  if (type === "integer" || type === "number") {
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return type === "integer" ? parseInt(v, 10) : Number(v);
    if (typeof v === "number" && type === "integer") return Math.round(v);
  }
  if (type === "boolean" && typeof v === "string") { if (/^(true|yes|1)$/i.test(v)) return true; if (/^(false|no|0)$/i.test(v)) return false; }
  if (type === "string" && (typeof v === "number" || typeof v === "boolean")) return String(v);
  if (type === "string" && Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(sch.description && /comma/.test(sch.description) ? "," : " ");
  if (type === "array") {
    if (typeof v === "string") { const p = repairJson(v); if (Array.isArray(p)) v = p; else v = sch.items && sch.items.type === "string" ? v.split(/\s*,\s*/).filter(Boolean) : [v]; }
    else if (!Array.isArray(v)) v = [v];
    if (sch.items && sch.items.type === "object") v = v.map((x) => (typeof x === "string" ? repairJson(x) || x : x));
    return v.map((x) => coerce(x, sch.items));
  }
  if (type === "object" && typeof v === "string") { const p = repairJson(v); if (p && typeof p === "object") return p; }
  if (type === "object" && v && typeof v === "object" && !Array.isArray(v) && sch.properties) {
    const o = { ...v };
    for (const [k, s] of Object.entries(sch.properties)) if (k in o) o[k] = coerce(o[k], s);
    return o;
  }
  return v;
}

// Checks and fixes a call against its tool's schema. Returns { input, notes }
// or { error }.
function fixArgs(input, schema, preset) {
  let a = input;
  if (a && a._unparsed != null) { const r = repairJson(a._unparsed); if (r && typeof r === "object") a = r; else return { error: "Your arguments weren't valid JSON and couldn't be repaired: " + String(a._unparsed).slice(0, 200) + ". Send them again as a JSON object." }; }
  if (a == null || typeof a !== "object" || Array.isArray(a)) a = {};
  // A whole call nested inside the arguments ({"name": "files", "arguments": {...}}).
  if (a.arguments && typeof a.arguments === "object" && Object.keys(a).every((k) => ["name", "arguments", "tool"].includes(k))) a = a.arguments;
  const notes = [];
  if (preset) for (const [k, v] of Object.entries(preset)) if (a[k] == null) a[k] = v;
  if (!schema || !schema.properties) return { input: a, notes };
  const props = schema.properties;
  // Common synonyms for argument names.
  const SYN = { file: "path", filepath: "path", file_path: "path", filename: "path", dir: "path", directory: "path", folder: "path", target_file: "path", cmd: "command", query_text: "query", q: "query", search: "query", old_str: "find", old_string: "find", old: "find", new_str: "replace", new_string: "replace", new: "replace", text_to_find: "find", contents: "content", data: "content", body: "content", start_line: "from", end_line: "to", line_start: "from", line_end: "to", regex_pattern: "pattern", search_term: "pattern" };
  for (const [k, v] of Object.entries(a)) {
    if (props[k]) continue;
    const t = SYN[k.toLowerCase()];
    if (t && props[t] && a[t] == null) { a[t] = v; delete a[k]; notes.push(k + " → " + t); }
  }
  for (const [k, s] of Object.entries(props)) {
    if (a[k] == null) continue;
    a[k] = coerce(a[k], s);
    if (s.enum && typeof a[k] === "string" && !s.enum.includes(a[k])) {
      const low = a[k].toLowerCase().trim().replace(/[\s-]+/g, "_");
      const hit = s.enum.find((e) => e.toLowerCase() === low) || s.enum.find((e) => e.toLowerCase().startsWith(low) || low.startsWith(e.toLowerCase()));
      if (hit) { notes.push(k + " \"" + a[k] + "\" → " + hit); a[k] = hit; }
      else return { error: k + " must be one of: " + s.enum.join(", ") + " (got \"" + a[k] + "\")." };
    }
  }
  const missing = (schema.required || []).filter((k) => a[k] == null || a[k] === "");
  if (missing.length) return { error: "Missing " + missing.join(", ") + ". This tool takes: " + Object.keys(props).join(", ") + " (required: " + (schema.required || []).join(", ") + ")." };
  return { input: a, notes };
}

// ---- repeats and sizes ---------------------------------------------------------------------
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const callKey = (name, input) => name + " " + stable(input || {});

function capOutput(text, limit) {
  const s = String(text == null ? "" : text);
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.6), tail = limit - head - 200;
  return s.slice(0, head) + "\n\n… [" + (s.length - head - tail) + " characters cut here to fit your context: ask for a smaller part if you need the middle] …\n\n" + s.slice(-tail);
}

module.exports = { repairJson, textCalls, fixName, fixArgs, coerce, callKey, capOutput, ALIASES, lev };
