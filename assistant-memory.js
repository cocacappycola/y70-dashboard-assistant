// ============================================================================
//  The memory guide: what Jarvis knows, kept for him, always open.
//
//  A file he reads before every answer (it is part of his instructions), in
//  sections: about the user, their preferences, ongoing topics and projects,
//  dated notes on practically everything said, and a table of the basic
//  commands (how many times each was asked, how many worked). Written to
//  <data>/jarvis-memory-guide.md, with its data in jarvis-memory-guide.json.
//
//  - Basic commands only move their counts: no model involved.
//  - Everything else is queued, and once things go quiet a note-taker (the
//    local model, or Claude with a key) turns the new exchanges into notes,
//    lasting facts, preferences, topic updates, and a title and summary for
//    each chat. It answers in JSON held to a schema, so a small model cannot
//    break the file.
//  - When the notes pile up, the oldest are folded into the sections above
//    them; the exchanges themselves stay in the chat bank for good.
// ============================================================================
const fs = require("fs");
const path = require("path");

const QUIET_MS = 40 * 1000;          // take notes this long after the last exchange
const MAX_NOTES = 60;                // beyond this, fold the oldest into the sections
const FOLD = 35;

let file = null, mdFile = null;
let state = null;
let llm = null;                      // async (system, user, schema, maxTokens) -> object | null
let canRun = () => true;             // false while the model is busy (a turn, a think, a game)
let onChats = () => {};              // (chats: [{id, title, summary}]) -> void
const queue = [];
let timer = null, running = false;

function blank() {
  return { about: [], prefs: [], topics: [], notes: [], commands: {}, updated: Date.now(), noted: 0, folded: 0 };
}

function init(dataDir, hooks) {
  file = path.join(dataDir, "jarvis-memory-guide.json");
  mdFile = path.join(dataDir, "jarvis-memory-guide.md");
  try { state = { ...blank(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch (e) { state = blank(); }
  llm = hooks.llm; canRun = hooks.canRun || canRun; onChats = hooks.onChats || onChats;
  // Exchanges queued when the panel last closed are in the data file.
  if (Array.isArray(state.queue)) { queue.push(...state.queue); delete state.queue; }
  if (queue.length) schedule();
  write();
}

function write() {
  state.updated = Date.now();
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...state, queue }));
    fs.renameSync(tmp, file);
    fs.writeFileSync(mdFile, render());
  } catch (e) {}
}

// ---- basic commands: counted, nothing more ----------------------------------
function recordCommand(key, ok, said, at) {
  const when = at || Date.now();
  const c = state.commands[key] || (state.commands[key] = { times: 0, ok: 0, failed: 0, first: when, last: 0, said: [] });
  c.times++;
  if (ok) c.ok++; else c.failed++;
  c.first = Math.min(c.first, when);
  c.last = Math.max(c.last, when);
  const s = String(said || "").trim().slice(0, 80);
  if (s && !c.said.some((x) => x.toLowerCase() === s.toLowerCase())) { c.said.unshift(s); c.said = c.said.slice(0, 3); }
  write();
}

// ---- everything else: noted when it is quiet -----------------------------------
function queueExchange(x) {
  queue.push({ at: x.at || Date.now(), chatId: x.chatId, chatTitle: x.chatTitle, autoTitle: !!x.autoTitle, heard: String(x.heard || "").slice(0, 1500), reply: String(x.reply || "").slice(0, 2500) });
  write();
  schedule();
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms || QUIET_MS);
  timer.unref && timer.unref();
}

const day = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function similar(a, b) {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 2)), B = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.8;
}
function addUnique(list, text, max) {
  const t = String(text || "").trim().replace(/\s+/g, " ").slice(0, 240);
  if (!t || list.some((x) => similar(x, t))) return false;
  list.push(t);
  if (list.length > max) list.splice(0, list.length - max);
  return true;
}

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    notes: { type: "array", items: { type: "string" }, maxItems: 12 },
    about: { type: "array", items: { type: "string" }, maxItems: 6 },
    prefs: { type: "array", items: { type: "string" }, maxItems: 6 },
    topics: { type: "array", items: { type: "object", properties: { title: { type: "string" }, status: { type: "string" } }, required: ["title", "status"] }, maxItems: 6 },
    chats: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, summary: { type: "string" } }, required: ["id", "title", "summary"] }, maxItems: 10 },
  },
  required: ["notes", "about", "prefs", "topics", "chats"],
};

function noteSystem(who) {
  return [
    "You keep Jarvis's memory guide: the notes Jarvis, " + who + "'s voice assistant, reads before every answer so he remembers.",
    "From the new exchanges below, write down what is worth remembering. Return JSON only:",
    "- notes: one short, specific line each on what was said or decided: questions " + who + " asked and the gist of the answer, plans, problems, opinions, people, places, purchases, projects. Skip greetings and small talk with nothing to keep. Write about " + who + " in the third person, no dates (they are added for you).",
    "- about: lasting facts about " + who + " themselves (job, home, family, health, hardware they own...), only if new.",
    "- prefs: how " + who + " likes things (music, units, tone, routines...), only if new.",
    "- topics: ongoing projects or subjects, each with a one-line status, only if this moves them on.",
    "- chats: for each chat id given, a short title (3 to 6 words, no quotes) and a one-sentence summary of the whole chat so far.",
    "Never repeat anything already in the guide (it is given). Never invent: only what the exchanges say. Empty lists are fine.",
  ].join("\n");
}

function guideForNoter() {
  return [
    "About: " + (state.about.join(" | ") || "(nothing yet)"),
    "Preferences: " + (state.prefs.join(" | ") || "(nothing yet)"),
    "Topics: " + (state.topics.map((t) => t.title + ": " + t.status).join(" | ") || "(nothing yet)"),
    "Recent notes: " + (state.notes.slice(-15).map((n) => n.text).join(" | ") || "(nothing yet)"),
  ].join("\n");
}

async function flush(who) {
  if (running || !queue.length || !llm) return;
  if (!canRun()) { schedule(15000); return; }
  running = true;
  const batch = queue.slice(0, 8);
  try {
    const chatsGiven = [...new Map(batch.map((x) => [x.chatId, x])).values()];
    const user = "The memory guide so far:\n" + guideForNoter() + "\n\nNew exchanges:\n" +
      batch.map((x) => "[chat " + x.chatId + ", \"" + x.chatTitle + "\", " + day(x.at) + "]\nUser: " + x.heard + "\nJarvis: " + x.reply).join("\n\n") +
      "\n\nChat ids to title and summarise: " + chatsGiven.map((x) => x.chatId).join(", ");
    const out = await llm(noteSystem(state.who || "the user"), user, NOTE_SCHEMA, 900);
    if (!out) { schedule(60000); return; }        // model not available: try again later
    const at = batch[batch.length - 1].at;
    for (const n of out.notes || []) {
      const t = String(n || "").trim().slice(0, 240);
      if (t && !state.notes.slice(-40).some((x) => similar(x.text, t))) state.notes.push({ at, text: t, chat: batch[0].chatId });
    }
    for (const a of out.about || []) addUnique(state.about, a, 40);
    for (const p of out.prefs || []) addUnique(state.prefs, p, 40);
    for (const tp of out.topics || []) {
      const title = String(tp.title || "").trim().slice(0, 60), status = String(tp.status || "").trim().slice(0, 200);
      if (!title) continue;
      const have = state.topics.find((x) => similar(x.title, title));
      if (have) { have.status = status || have.status; have.at = Date.now(); }
      else state.topics.push({ title, status, at: Date.now() });
    }
    state.topics.sort((a, b) => (b.at || 0) - (a.at || 0));
    state.topics = state.topics.slice(0, 25);
    onChats((out.chats || []).filter((c) => chatsGiven.some((x) => x.chatId === c.id)));
    state.noted += batch.length;
    queue.splice(0, batch.length);
    if (state.notes.length > MAX_NOTES) await fold();
    write();
  } catch (e) {
    schedule(60000);
  } finally {
    running = false;
  }
  if (queue.length) schedule(5000);
}

// The oldest notes folded into the sections above them (the exchanges stay in
// the chat bank, so nothing is lost but the clutter).
const FOLD_SCHEMA = {
  type: "object",
  properties: {
    about: { type: "array", items: { type: "string" }, maxItems: 40 },
    prefs: { type: "array", items: { type: "string" }, maxItems: 40 },
    topics: { type: "array", items: { type: "object", properties: { title: { type: "string" }, status: { type: "string" } }, required: ["title", "status"] }, maxItems: 25 },
  },
  required: ["about", "prefs", "topics"],
};
async function fold() {
  const old = state.notes.slice(0, FOLD);
  const user = "Current sections:\nAbout:\n" + state.about.map((x) => "- " + x).join("\n") +
    "\nPreferences:\n" + state.prefs.map((x) => "- " + x).join("\n") +
    "\nTopics:\n" + state.topics.map((t) => "- " + t.title + ": " + t.status).join("\n") +
    "\n\nOlder notes to fold in:\n" + old.map((n) => "- " + day(n.at) + ": " + n.text).join("\n");
  const sys = "You maintain a memory guide. Fold the older notes into the sections: add lasting facts to About, likes and habits to Preferences, and update or add Topics with a one-line current status (dates are useful there). Keep every line short and specific, merge duplicates, drop what no longer matters. Return the full new sections as JSON.";
  const out = await llm(sys, user, FOLD_SCHEMA, 1400);
  if (!out) return;
  state.about = (out.about || []).map((x) => String(x).slice(0, 240)).filter(Boolean);
  state.prefs = (out.prefs || []).map((x) => String(x).slice(0, 240)).filter(Boolean);
  state.topics = (out.topics || []).map((t) => ({ title: String(t.title).slice(0, 60), status: String(t.status).slice(0, 200), at: Date.now() })).filter((t) => t.title);
  state.notes = state.notes.slice(FOLD);
  state.folded += old.length;
}

// ---- reading it ------------------------------------------------------------------
function commandRows(limit) {
  return Object.entries(state.commands).sort((a, b) => b[1].times - a[1].times).slice(0, limit || 50)
    .map(([k, c]) => "| " + k + " | " + c.times + " | " + c.ok + " | " + c.failed + " | " + day(c.last) + " | " + (c.said[0] || "") + " |");
}

function render() {
  const L = ["# Jarvis memory guide", "", "*Updated " + new Date(state.updated).toLocaleString("en-US") + ". Jarvis reads this before every answer; it is kept up to date from every conversation that is not a basic command.*", ""];
  L.push("## About " + (state.who || "the user"), ...(state.about.length ? state.about.map((x) => "- " + x) : ["- (nothing yet)"]), "");
  L.push("## Preferences", ...(state.prefs.length ? state.prefs.map((x) => "- " + x) : ["- (nothing yet)"]), "");
  L.push("## Ongoing topics", ...(state.topics.length ? state.topics.map((t) => "- **" + t.title + "**: " + t.status) : ["- (nothing yet)"]), "");
  L.push("## Notes", ...(state.notes.length ? state.notes.map((n) => "- " + day(n.at) + ": " + n.text) : ["- (nothing yet)"]), "");
  L.push("## Basic commands", "", "| command | times | worked | failed | last | e.g. |", "|---|---|---|---|---|---|", ...commandRows(), "");
  return L.join("\n");
}

// What goes in Jarvis's instructions: the guide, newest and most useful first,
// within a budget (a small model gets less).
function promptText(small) {
  const budget = small ? 3500 : 8000;
  const parts = [];
  if (state.about.length) parts.push("About " + (state.who || "them") + ":\n" + state.about.map((x) => "- " + x).join("\n"));
  if (state.prefs.length) parts.push("Preferences:\n" + state.prefs.map((x) => "- " + x).join("\n"));
  if (state.topics.length) parts.push("Ongoing topics:\n" + state.topics.slice(0, small ? 8 : 15).map((t) => "- " + t.title + ": " + t.status).join("\n"));
  if (state.notes.length) parts.push("Recent notes:\n" + state.notes.slice(small ? -12 : -25).map((n) => "- " + day(n.at) + ": " + n.text).join("\n"));
  const cmds = Object.entries(state.commands).sort((a, b) => b[1].times - a[1].times).slice(0, small ? 6 : 12);
  if (cmds.length) parts.push("Basic commands (asked / worked): " + cmds.map(([k, c]) => k + " " + c.times + "/" + c.ok).join(", "));
  let text = parts.join("\n\n");
  if (text.length > budget) text = text.slice(0, budget) + "\n(more: search your history)";
  return text || "(Nothing yet: it fills in as you talk.)";
}

function setWho(name) { if (name && state.who !== name) { state.who = name; write(); } }
function stats() {
  return { about: state.about.length, prefs: state.prefs.length, topics: state.topics.length, notes: state.notes.length, commands: Object.keys(state.commands).length, queued: queue.length, noted: state.noted, folded: state.folded, file: mdFile };
}
function data() { return { ...state, file: mdFile }; }

module.exports = { init, recordCommand, queueExchange, flush, render, promptText, setWho, stats, data, schedule };
