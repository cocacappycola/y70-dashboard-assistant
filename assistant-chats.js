// ============================================================================
//  Jarvis's data bank: every exchange, filed into chats.
//
//  - Topic chats: real conversations (questions, plans, help, chat). Kept for
//    good, each with a title and a summary the note-taker keeps current.
//  - Basic chats: one per kind of everyday command (lights, sound, music,
//    timers...), so a hundred "lights off" do not bury the conversations.
//    Their exchanges are deleted after 7 days; what is kept of them is the
//    count in the memory guide (how often, and whether it worked).
//
//  Stored in <data>/jarvis-chats/: index.json (one line per chat) and one
//  <id>.json per chat. A search over everything said (BM25 over each
//  exchange, titles and summaries weighted up) finds a past moment, or the
//  chat a new question continues.
// ============================================================================
const fs = require("fs");
const path = require("path");

const BASIC_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Tools whose everyday use is a "basic command", and the chat each files into.
const BASIC_TOOLS = {
  lights: "lights", volume: "sound", music: "music", timer: "timers", alarm: "alarms", weather: "weather",
  discord: "discord", phone: "phone", youtube: "youtube", panel: "panel", layout: "screen", open_app: "apps", info: "pc status",
};
const BASIC_TITLES = {
  lights: "Lights", sound: "Sound & volume", music: "Music", timers: "Timers", alarms: "Alarms", weather: "Weather",
  discord: "Discord", phone: "Phone", youtube: "YouTube", panel: "Panel & settings", screen: "Screen layout", apps: "Opening apps",
  "pc status": "PC status checks",
};
// Before a turn runs (tools unknown yet): does it read like an everyday command?
const BASIC_TEXT = /\b(turn|switch|dim|brighten)\b.*\b(on|off|up|down|lights?|lamp|strip|leds?)\b|\b(lights?|brightness)\b|\b(volume|louder|quieter|softer|mute|unmute|deafen|undeafen)\b|^\W*(play|pause|resume|skip|stop|next( song| track)?|previous|shuffle)\b|\b(timer|alarm|remind me in)\b|\bweather\b|\b(open|close|show|hide)\b.*\b(app|widget|youtube|spotify|tiktok|shorts|snapchat|notes|calculator)\b|\bscreensaver\b|\btheme\b/i;

let dir = null;
let index = [];                 // { id, title, kind, key, created, updated, count, summary, autoTitle }
const cache = new Map();        // id -> chat
let bank = null;                // search index, built on first search

function init(dataDir) {
  dir = path.join(dataDir, "jarvis-chats");
  fs.mkdirSync(dir, { recursive: true });
  try { index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")); } catch (e) { index = []; }
  if (!Array.isArray(index)) index = [];
  const imported = migrate(dataDir);
  prune();
  setInterval(prune, 60 * 60 * 1000).unref();
  return imported;
}

// ---- storage ---------------------------------------------------------------
const fileOf = (id) => path.join(dir, id + ".json");
function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function saveIndex() { try { writeAtomic(path.join(dir, "index.json"), JSON.stringify(index)); } catch (e) {} }
function entryOf(id) { return index.find((e) => e.id === id) || null; }

function get(id) {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const c = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
    cache.set(id, c);
    return c;
  } catch (e) { return null; }
}

function save(chat) {
  cache.set(chat.id, chat);
  try { writeAtomic(fileOf(chat.id), JSON.stringify(chat)); } catch (e) {}
  const e = entryOf(chat.id);
  const meta = { id: chat.id, title: chat.title, kind: chat.kind, key: chat.key || null, created: chat.created, updated: chat.updated, count: chat.turns.length, summary: chat.summary || "", autoTitle: !!chat.autoTitle, usage: chatUsage(chat) };
  if (e) Object.assign(e, meta); else index.push(meta);
  saveIndex();
}

// What a chat has used, from its exchanges (each turn carries its own usage;
// ones from before usage was counted have none).
function chatUsage(chat) {
  const u = { in: 0, cached: 0, out: 0, requests: 0, toolCalls: 0, toolFails: 0, ms: 0, counted: 0 };
  for (const t of chat.turns) {
    const x = t.usage;
    if (!x) continue;
    u.counted++;
    for (const k of ["in", "cached", "out", "requests", "toolCalls", "toolFails", "ms"]) u[k] += x[k] | 0;
  }
  return u;
}

const newId = () => "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// A first title until the note-taker gives it a proper one: the opening words.
function roughTitle(text) {
  const t = String(text || "").replace(/^\W*(hey |ok |okay )?jarvis[,\s]+/i, "").replace(/\s+/g, " ").trim();
  const words = t.split(" ").slice(0, 7).join(" ");
  return (words.length < t.length ? words + "…" : words).replace(/^./, (c) => c.toUpperCase()) || "Chat";
}

function create(opts) {
  const now = opts.at || Date.now();
  const chat = {
    id: newId(), kind: opts.kind || "topic", key: opts.key || null,
    title: opts.title || "Chat", autoTitle: opts.autoTitle !== false,
    created: now, updated: now, summary: "", turns: [],
  };
  save(chat);
  bank = null;
  return chat;
}

function basicChat(key) {
  const e = index.find((x) => x.kind === "basic" && x.key === key);
  const c = e && get(e.id);
  if (c) return c;
  return create({ kind: "basic", key, title: BASIC_TITLES[key] || key, autoTitle: false });
}

// One exchange: { at, heard, reply, tools, cards, model, ok, think? }
function addTurn(chatId, turn) {
  const c = get(chatId);
  if (!c) return null;
  c.turns.push(turn);
  c.updated = turn.at || Date.now();
  save(c);
  if (bank) bank.add(c, c.turns.length - 1);
  return c;
}

function rename(id, title, auto) {
  const c = get(id);
  if (!c || !title) return null;
  c.title = String(title).trim().slice(0, 80);
  c.autoTitle = !!auto && c.autoTitle;
  save(c);
  bank = null;
  return c;
}

function setSummary(id, summary) {
  const c = get(id);
  if (!c) return;
  c.summary = String(summary || "").trim().slice(0, 400);
  save(c);
  bank = null;
}

function remove(id) {
  const c = get(id);
  cache.delete(id);
  index = index.filter((e) => e.id !== id);
  saveIndex();
  try { fs.unlinkSync(fileOf(id)); } catch (e) {}
  bank = null;
  return c;
}

// Basic chats keep 7 days; a chat with nothing left goes.
function prune() {
  const cut = Date.now() - BASIC_KEEP_MS;
  for (const e of index.filter((x) => x.kind === "basic")) {
    const c = get(e.id);
    if (!c) continue;
    const kept = c.turns.filter((t) => (t.at || 0) >= cut);
    if (kept.length === c.turns.length) continue;
    if (!kept.length) { remove(c.id); continue; }
    c.turns = kept;
    save(c);
    bank = null;
  }
}

function list(opts) {
  const o = opts || {};
  let out = index.slice();
  if (o.kind) out = out.filter((e) => e.kind === o.kind);
  out.sort((a, b) => b.updated - a.updated);
  return out.slice(0, o.limit || 500).map((e) => ({
    ...e,
    // Basic chats: when their oldest exchange goes.
    expires: e.kind === "basic" ? oldestAt(e.id) + BASIC_KEEP_MS : null,
  }));
}
function oldestAt(id) {
  const c = get(id);
  return c && c.turns.length ? c.turns[0].at : Date.now();
}

// The last exchanges of a chat, newest last, within a character budget.
function recentTurns(id, maxChars) {
  const c = get(id);
  if (!c) return [];
  const out = [];
  let used = 0;
  for (let i = c.turns.length - 1; i >= 0; i--) {
    const t = c.turns[i];
    const size = (t.heard || "").length + (t.reply || "").length;
    if (out.length && used + size > maxChars) break;
    used += size;
    out.unshift(t);
  }
  return out;
}

// Latest exchanges across every chat (for the big model's context).
function latest(n) {
  const recent = list({ limit: 6 }).flatMap((e) => (get(e.id) || { turns: [] }).turns.slice(-n).map((t) => ({ ...t, chatId: e.id, chatTitle: e.title })));
  return recent.sort((a, b) => a.at - b.at).slice(-n);
}

// ---- classification ----------------------------------------------------------
// After a turn: every tool it used is an everyday one and the request is short.
function classify(heard, tools) {
  const used = [...new Set(tools || [])];
  if (!used.length) return null;
  if (!used.every((t) => BASIC_TOOLS[t])) return null;
  if (String(heard || "").split(/\s+/).length > 16) return null;
  return BASIC_TOOLS[used[0]];
}
const looksBasic = (text) => String(text || "").split(/\s+/).length <= 12 && BASIC_TEXT.test(text);

// ---- search --------------------------------------------------------------------
const STOP = new Set("the a an and or but if of to in on at for with about from by is are was were be been being it its this that these those i me my you your we our they them their he she his her what which who whom whose when where why how can could would should will shall do does did done have has had not no yes just so than then too very really please jarvis hey okay ok also there here into out up down over again more most some any all each other such only own same few both".split(" "));
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
function tokens(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) || [])
    .map((w) => w.replace(/['.+-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

// BM25 over documents: one per exchange, plus one per chat for its title and
// summary (counted three times, so a title match ranks). An exchange that was
// only about finding another chat ("pull up our chat about the bike") stays
// out: it would outrank the very chat it was looking for.
const findsChats = (t) => (t.tools || []).includes("history");
function buildBank() {
  const docs = [];
  const df = new Map();
  const add = (chat, turnIndex, text, weight) => {
    const tf = new Map();
    const toks = tokens(text);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + weight);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ chatId: chat.id, turnIndex, tf, len: toks.length * weight });
  };
  const b = {
    docs, df,
    add(chat, i) {
      const t = chat.turns[i];
      if (findsChats(t)) return;
      add(chat, i, (t.heard || "") + " " + (t.reply || ""), 1);
      b.avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
    },
  };
  for (const e of index) {
    const c = get(e.id);
    if (!c) continue;
    add(c, -1, c.title + " " + (c.summary || ""), 3);
    c.turns.forEach((t, i) => { if (!findsChats(t)) add(c, i, (t.heard || "") + " " + (t.reply || ""), 1); });
  }
  b.avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return b;
}

function scoreDocs(query) {
  if (!bank) bank = buildBank();
  const q = [...new Set(tokens(query))];
  const N = bank.docs.length;
  const idf = (t) => { const n = bank.df.get(t) || 0; return n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0; };
  const qIdf = q.map(idf);
  const total = qIdf.reduce((s, x) => s + x, 0) || 1;
  const k1 = 1.2, b = 0.75;
  const scored = [];
  for (const d of bank.docs) {
    let s = 0, covered = 0;
    q.forEach((t, k) => {
      const f = d.tf.get(t);
      if (!f) return;
      covered += qIdf[k];
      s += qIdf[k] * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (bank.avg || 1)));
    });
    // coverage: how much of the question (by rarity) this document has.
    if (s > 0) scored.push({ d, s, coverage: covered / total });
  }
  return scored.sort((x, y) => y.s - x.s);
}

// Past moments matching a query: { chatId, title, kind, at, heard, reply, score }
function search(query, opts) {
  const o = opts || {};
  const out = [];
  const seen = new Set();
  for (const { d, s } of scoreDocs(query)) {
    const e = entryOf(d.chatId);
    if (!e || (o.kind && e.kind !== o.kind)) continue;
    const c = get(d.chatId);
    const key = d.chatId + ":" + d.turnIndex;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.turnIndex < 0) {
      out.push({ chatId: e.id, title: e.title, kind: e.kind, at: e.updated, heard: null, reply: e.summary, score: +s.toFixed(2) });
    } else {
      const t = c.turns[d.turnIndex];
      out.push({ chatId: e.id, title: e.title, kind: e.kind, at: t.at, heard: t.heard, reply: t.reply, score: +s.toFixed(2) });
    }
    if (out.length >= (o.limit || 8)) break;
  }
  return out;
}

// The topic chat a new request most likely continues, if any:
// { chat, score, coverage } of the best, aggregated over its documents.
function bestChat(query) {
  const per = new Map();
  for (const { d, s, coverage } of scoreDocs(query)) {
    const e = entryOf(d.chatId);
    if (!e || e.kind !== "topic") continue;
    const p = per.get(d.chatId) || { score: 0, coverage: 0 };
    p.score = Math.max(p.score, s);
    p.coverage = Math.max(p.coverage, coverage);
    per.set(d.chatId, p);
  }
  let best = null;
  for (const [id, p] of per) if (!best || p.score > best.score) best = { id, ...p };
  return best ? { chat: get(best.id), score: best.score, coverage: best.coverage } : null;
}

// Find a chat by id or by words of its title.
function find(ref) {
  const r = String(ref || "").trim();
  if (!r) return null;
  if (entryOf(r)) return get(r);
  const words = tokens(r);
  let best = null;
  for (const e of index) {
    const t = tokens(e.title + " " + (e.summary || ""));
    const hit = words.filter((w) => t.includes(w)).length;
    if (hit && (!best || hit > best.hit || (hit === best.hit && e.updated > best.e.updated))) best = { e, hit };
  }
  if (best) return get(best.e.id);
  const m = bestChat(r);
  return m && m.coverage > 0.5 ? m.chat : null;
}

// ---- moving the old single log in, once -----------------------------------------
// jarvis-chat.json (the Chat app's log before chats existed): each conversation
// becomes a chat, basic ones go to their command's chat (if under 7 days old).
// Returns what came in, for the memory guide: { topic: [...], basic: [...] }.
function migrate(dataDir) {
  const old = path.join(dataDir, "jarvis-chat.json");
  if (!fs.existsSync(old)) return null;
  const out = { topic: [], basic: [] };
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(old, "utf8")); } catch (e) { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  // The spoken-turn history (the last 100) goes back further than the chat log:
  // everything in it that the log doesn't have joins the bank too.
  let said = [];
  try { said = JSON.parse(fs.readFileSync(path.join(dataDir, "jarvis-history.json"), "utf8")); } catch (e) {}
  const seen = new Set(entries.map((e) => (e.conv || "") + "|" + e.heard));
  for (const h of Array.isArray(said) ? said : []) {
    if (!h || !h.heard || !h.reply || !h.at || seen.has((h.conv || "") + "|" + h.heard)) continue;
    entries.push({ at: h.at, conv: h.conv, heard: h.heard, reply: h.reply, tools: h.tools || [], model: h.model || null });
  }
  entries.sort((a, b) => (a.at || 0) - (b.at || 0));
  const groups = new Map();
  for (const e of entries) {
    const key = e.conv === "think" ? "think-" + e.id : e.conv || e.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const cut = Date.now() - BASIC_KEEP_MS;
  for (const g of groups.values()) {
    for (const e of g) {
      const turn = { at: e.at, heard: e.heard, reply: e.reply, tools: e.tools || [], cards: e.cards || [], model: e.model || null, ok: true, ...(e.think ? { think: e.think } : {}) };
      const key = classify(e.heard, e.tools);
      if (key) {
        if (e.at >= cut) addTurn(basicChat(key).id, turn);
        out.basic.push({ key, heard: e.heard, at: e.at });
      } else {
        if (!g.chatId) g.chatId = create({ kind: "topic", title: roughTitle(e.heard), at: e.at }).id;
        const c = addTurn(g.chatId, turn);
        if (c) out.topic.push({ chatId: c.id, chatTitle: c.title, autoTitle: c.autoTitle, heard: e.heard, reply: e.reply, at: e.at });
      }
    }
  }
  try { fs.renameSync(old, path.join(dataDir, "jarvis-chat.imported.json")); } catch (e) {}
  return out;
}

module.exports = {
  init, get, create, basicChat, addTurn, rename, setSummary, remove, list, recentTurns, latest,
  classify, looksBasic, search, bestChat, find, roughTitle, BASIC_TOOLS, BASIC_KEEP_MS,
};
