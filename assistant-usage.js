// ============================================================================
//  Jarvis's usage: every model request, tool call and turn, counted.
//
//  <data>/jarvis-usage/
//    YYYY-MM.jsonl   one line per event, as it happened (the raw record)
//    totals.json     running totals: all time, each month, each day (with
//                    its 24 hours), each broken down by model, tool and kind
//
//  Kinds: "turn" (answering you), "notes" (the memory guide's note-taker),
//  "think" (the big model). Tokens in are the whole prompt read for a request
//  (cached included), cached is the part the server reused, out is written.
// ============================================================================
const fs = require("fs");
const path = require("path");

let dir = null;
let totals = null;
let saveT = null;
const recent = [];                 // the last events, newest last
const RECENT = 300;

function blank() {
  return {
    requests: 0, turns: 0, in: 0, cached: 0, out: 0,
    ms: 0, promptMs: 0, genMs: 0,
    toolCalls: 0, toolFails: 0, toolMs: 0,
    maxIn: 0, maxOut: 0, failedTurns: 0, turnMs: 0, maxTurnMs: 0,
    first: 0, last: 0,
    models: {}, tools: {}, kinds: {}, providers: {},
  };
}
function blankDay() { return { ...blank(), hours: Array.from({ length: 24 }, () => ({ requests: 0, in: 0, out: 0, toolCalls: 0, turns: 0 })) }; }

function init(dataDir) {
  dir = path.join(dataDir, "jarvis-usage");
  fs.mkdirSync(dir, { recursive: true });
  try { totals = JSON.parse(fs.readFileSync(path.join(dir, "totals.json"), "utf8")); } catch (e) { totals = null; }
  if (!totals || !totals.all) totals = { all: blank(), months: {}, days: {} };
  // The newest events, for the Stats page's "latest requests".
  try {
    const f = path.join(dir, monthKey(Date.now()) + ".jsonl");
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").slice(-RECENT);
    for (const l of lines) { try { recent.push(JSON.parse(l)); } catch (e) {} }
  } catch (e) {}
}

const pad = (n) => String(n).padStart(2, "0");
function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function monthKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }

function buckets(at) {
  const m = monthKey(at), d = dayKey(at);
  if (!totals.months[m]) totals.months[m] = blank();
  if (!totals.days[d]) totals.days[d] = blankDay();
  return [totals.all, totals.months[m], totals.days[d]];
}

function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      const f = path.join(dir, "totals.json");
      fs.writeFileSync(f + ".tmp", JSON.stringify(totals));
      fs.renameSync(f + ".tmp", f);
    } catch (e) {}
  }, 800);
  saveT.unref && saveT.unref();
}
function log(ev) {
  recent.push(ev);
  if (recent.length > RECENT) recent.splice(0, recent.length - RECENT);
  try { fs.appendFileSync(path.join(dir, monthKey(ev.at) + ".jsonl"), JSON.stringify(ev) + "\n"); } catch (e) {}
}
const touch = (b, at) => { if (!b.first || at < b.first) b.first = at; if (at > b.last) b.last = at; };
const sub = (map, key, init) => map[key] || (map[key] = init());

// One model request.
// { at, kind, provider, model, chatId, conv, in, cached, out, ms, promptMs, genMs, window }
function request(e) {
  if (!dir) return;
  const at = e.at || Date.now();
  const ev = { t: "req", at, kind: e.kind || "turn", provider: e.provider || "local", model: e.model || "?", chat: e.chatId || null,
    in: e.in | 0, cached: e.cached | 0, out: e.out | 0, ms: e.ms | 0, promptMs: e.promptMs | 0, genMs: e.genMs | 0, window: e.window | 0 };
  for (const b of buckets(at)) {
    b.requests++; b.in += ev.in; b.cached += ev.cached; b.out += ev.out;
    b.ms += ev.ms; b.promptMs += ev.promptMs; b.genMs += ev.genMs;
    b.maxIn = Math.max(b.maxIn, ev.in); b.maxOut = Math.max(b.maxOut, ev.out);
    touch(b, at);
    const m = sub(b.models, ev.model, () => ({ requests: 0, in: 0, cached: 0, out: 0, ms: 0, genMs: 0, provider: ev.provider }));
    m.requests++; m.in += ev.in; m.cached += ev.cached; m.out += ev.out; m.ms += ev.ms; m.genMs += ev.genMs;
    const k = sub(b.kinds, ev.kind, () => ({ requests: 0, in: 0, out: 0 }));
    k.requests++; k.in += ev.in; k.out += ev.out;
    const p = sub(b.providers, ev.provider, () => ({ requests: 0, in: 0, out: 0 }));
    p.requests++; p.in += ev.in; p.out += ev.out;
  }
  const h = totals.days[dayKey(at)].hours[new Date(at).getHours()];
  h.requests++; h.in += ev.in; h.out += ev.out;
  log(ev);
  save();
}

// One tool call. { at, name, ok, ms, chatId }
function tool(e) {
  if (!dir) return;
  const at = e.at || Date.now();
  const ev = { t: "tool", at, name: e.name, ok: !!e.ok, ms: e.ms | 0, chat: e.chatId || null };
  for (const b of buckets(at)) {
    b.toolCalls++; if (!ev.ok) b.toolFails++; b.toolMs += ev.ms;
    touch(b, at);
    const t = sub(b.tools, ev.name, () => ({ calls: 0, ok: 0, fail: 0, ms: 0, maxMs: 0 }));
    t.calls++; if (ev.ok) t.ok++; else t.fail++; t.ms += ev.ms; t.maxMs = Math.max(t.maxMs, ev.ms);
  }
  totals.days[dayKey(at)].hours[new Date(at).getHours()].toolCalls++;
  log(ev);
  save();
}

// One finished exchange with you. { at, chatId, ms, ok, steps }
function turn(e) {
  if (!dir) return;
  const at = e.at || Date.now();
  const ev = { t: "turn", at, chat: e.chatId || null, ms: e.ms | 0, ok: e.ok !== false, steps: e.steps | 0, in: e.in | 0, out: e.out | 0 };
  for (const b of buckets(at)) {
    b.turns++; if (!ev.ok) b.failedTurns++;
    b.turnMs = (b.turnMs || 0) + ev.ms; b.maxTurnMs = Math.max(b.maxTurnMs || 0, ev.ms);
    touch(b, at);
  }
  totals.days[dayKey(at)].hours[new Date(at).getHours()].turns++;
  log(ev);
  save();
}

// For the Stats page: today, this month and all time in full, plus a line per
// day (last 31) and per month, and the latest raw events.
function summary(opts) {
  const o = opts || {};
  const now = Date.now();
  const day = o.day || dayKey(now), month = o.month || monthKey(now);
  const days = [];
  for (let i = 30; i >= 0; i--) {
    const k = dayKey(now - i * 86400000);
    const d = totals.days[k];
    days.push({ day: k, requests: d ? d.requests : 0, turns: d ? d.turns : 0, in: d ? d.in : 0, cached: d ? d.cached : 0, out: d ? d.out : 0, toolCalls: d ? d.toolCalls : 0, toolFails: d ? d.toolFails : 0 });
  }
  const months = Object.keys(totals.months).sort().map((k) => {
    const m = totals.months[k];
    return { month: k, requests: m.requests, turns: m.turns, in: m.in, cached: m.cached, out: m.out, toolCalls: m.toolCalls, toolFails: m.toolFails };
  });
  return {
    ok: true, now, dayKey: day, monthKey: month,
    day: totals.days[day] || blankDay(),
    month: totals.months[month] || blank(),
    all: totals.all,
    days, months,
    recent: recent.slice(-(o.recent || 60)).reverse(),
  };
}

module.exports = { init, request, tool, turn, summary, dayKey, monthKey };
