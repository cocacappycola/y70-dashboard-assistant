// ============================================================================
//  Jarvis fork — the status bar, the island, alarms and timers, and Jarvis.
//
//  Loaded after shell.js and shares its globals ($, APPS, setApp, appFrame,
//  native, relayKeyboardRequest, syncWebViews, lastState).
//
//  The island is the one place all of this lives, the way Apple's Dynamic
//  Island does: a black pill in the top bar that shows what is going on (a
//  timer counting down, Jarvis listening) and grows into a card when tapped,
//  when an alarm rings, or when Jarvis has something to say.
// ============================================================================
(() => {
  "use strict";

  const API = "/api/jarvis/";
  const body = document.body;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const post = (p, data) => fetch(API + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));

  // ---------------------------------------------------------------- time ----
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function fmtLeft(ms) {
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
  }
  function human(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const parts = [];
    if (h) parts.push(h + (h === 1 ? " hour" : " hours"));
    if (m) parts.push(m + (m === 1 ? " minute" : " minutes"));
    if (s && !h) parts.push(s + (s === 1 ? " second" : " seconds"));
    return parts.join(" ") || "0 seconds";
  }
  // Same short names the Timer widget gives its presets.
  const shortDur = (s) => (s >= 3600 && s % 3600 === 0 ? s / 3600 + "h" : s >= 60 && s % 60 === 0 ? s / 60 + "m" : human(s));

  // -------------------------------------------------------------- timers ----
  // Stored exactly as the Timer widget stores them, so a timer set by voice
  // shows up in the widget and one set in the widget counts down here.
  const TKEY = "y70_timers";
  const Timers = {
    all() { try { return JSON.parse(localStorage.getItem(TKEY) || "[]"); } catch (e) { return []; } },
    save(list) { try { localStorage.setItem(TKEY, JSON.stringify(list)); } catch (e) {} },
    left(t) { return t.pausedLeft != null ? t.pausedLeft : Math.max(0, t.endsAt - Date.now()); },
    // extra: { actions: [{tool, input}], prompt, ring } — things to do when it ends.
    add(seconds, label, extra) {
      const list = Timers.all();
      const t = {
        id: "t" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: (label && String(label).trim()) || shortDur(seconds),
        total: seconds * 1000, endsAt: Date.now() + seconds * 1000, pausedLeft: null, fired: false,
        ...schedExtra(extra),
      };
      list.push(t);
      Timers.save(list);
      return t;
    },
    update(id, fn) {
      const list = Timers.all();
      const t = list.find((x) => x.id === id);
      if (t) { fn(t); Timers.save(list); }
    },
    remove(id) { Timers.save(Timers.all().filter((t) => t.id !== id)); },
    togglePause(id) {
      Timers.update(id, (t) => {
        if (t.pausedLeft == null) t.pausedLeft = Math.max(0, t.endsAt - Date.now());
        else { t.endsAt = Date.now() + t.pausedLeft; t.pausedLeft = null; }
      });
    },
    addTime(id, ms) {
      Timers.update(id, (t) => {
        if (t.pausedLeft != null) t.pausedLeft += ms;
        else t.endsAt = Math.max(Date.now(), t.endsAt) + ms;
        t.total += ms; t.fired = false;
      });
    },
  };

  // -------------------------------------------------------------- alarms ----
  //  { id, time: "07:30", label, days: [0..6] (0 = Sunday, empty = once),
  //    on, armedAt, lastFired: "YYYY-MM-DD", snoozeUntil }
  // A one-off alarm rings at its next occurrence after being set, then turns
  // itself off. armedAt stops an alarm set for 7:30 at 7:31 ringing at once.
  const AKEY = "y70_alarms";
  const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const Alarms = {
    all() { try { return JSON.parse(localStorage.getItem(AKEY) || "[]"); } catch (e) { return []; } },
    save(list) { try { localStorage.setItem(AKEY, JSON.stringify(list)); } catch (e) {} },
    add(time, label, days, extra) {
      const list = Alarms.all();
      const a = { id: "a" + Date.now().toString(36), time, label: label || "", days: days || [], on: true, armedAt: Date.now(), lastFired: null, snoozeUntil: null, ...schedExtra(extra) };
      list.push(a);
      Alarms.save(list.sort((x, y) => x.time.localeCompare(y.time)));
      return a;
    },
    update(id, fn) {
      const list = Alarms.all();
      const a = list.find((x) => x.id === id);
      if (a) { fn(a); Alarms.save(list); }
    },
    remove(id) { Alarms.save(Alarms.all().filter((a) => a.id !== id)); },
    // When it will next ring, as a timestamp.
    next(a, from) {
      if (!a.on) return null;
      if (a.snoozeUntil) return a.snoozeUntil;
      const [h, m] = a.time.split(":").map(Number);
      const base = new Date(from || Date.now());
      for (let i = 0; i < 8; i++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
        if (d.getTime() <= (from || Date.now())) continue;
        if (a.days.length && !a.days.includes(d.getDay())) continue;
        return d.getTime();
      }
      return null;
    },
  };
  // ------------------------------------------------------------ schedules ---
  // An alarm or a timer can carry work: actions (tool calls, run as they are)
  // and/or a prompt (asked of Jarvis then, answered out loud). ring: false
  // makes it silent — just the work, no bell.
  function schedExtra(x) {
    x = x || {};
    const out = {};
    const acts = (Array.isArray(x.actions) ? x.actions : []).map((a) => ({ tool: String(a.tool || a.name || ""), input: a.input || a.args || {} })).filter((a) => a.tool);
    if (acts.length) out.actions = acts.slice(0, 8);
    if (x.prompt && String(x.prompt).trim()) out.prompt = String(x.prompt).trim().slice(0, 500);
    if (x.ring === false) out.ring = false;
    return out;
  }
  const hasWork = (x) => !!((x.actions && x.actions.length) || x.prompt);
  const CLIENT_TOOLS = new Set(["timer", "alarm", "music", "show", "panel", "layout", "youtube", "open_web", "download_model", "open_app"]);
  async function runScheduled(item, what) {
    const done = [];
    for (const act of item.actions || []) {
      try {
        if (CLIENT_TOOLS.has(act.tool)) done.push(act.tool + ": " + (await runClientTool({ name: act.tool, input: act.input })));
        else {
          const r = await post("run", { name: act.tool, input: act.input });
          done.push(act.tool + ": " + (r.ok ? r.result : "failed — " + (r.error || "?")));
          if (act.tool === "notes" && r.ok) showNotes(r.flash);
        }
      } catch (e) { done.push(act.tool + ": failed — " + (e.message || e)); }
    }
    if (item.prompt) { ask(item.prompt); return; }
    if (done.length) {
      J.note = "⏰ " + (item.label || item.name || what) + " — " + done.map((s) => s.slice(0, 80)).join(" · ");
      openCard(); renderJarvis(); scheduleClose(15000);
    }
  }
  const workTag = (x) => (hasWork(x) ? " (then: " + [...(x.actions || []).map((a) => a.tool), x.prompt ? "\"" + x.prompt.slice(0, 40) + "\"" : null].filter(Boolean).join(", ") + (x.ring === false ? ", silent" : "") + ")" : "");

  function parseDays(days) {
    const out = new Set();
    for (const raw of [].concat(days || [])) {
      const d = String(raw).toLowerCase().trim();
      if (/^(daily|every ?day|everyday|all)$/.test(d)) [0, 1, 2, 3, 4, 5, 6].forEach((x) => out.add(x));
      else if (/^weekdays?$/.test(d)) [1, 2, 3, 4, 5].forEach((x) => out.add(x));
      else if (/^weekends?$/.test(d)) [0, 6].forEach((x) => out.add(x));
      else {
        const i = DAY.indexOf(d.slice(0, 3));
        if (i >= 0) out.add(i);
      }
    }
    return [...out].sort();
  }
  function describeDays(days) {
    if (!days || !days.length) return "once";
    const k = days.join(",");
    if (k === "0,1,2,3,4,5,6") return "every day";
    if (k === "1,2,3,4,5") return "weekdays";
    if (k === "0,6") return "weekends";
    return days.map((d) => DAY[d][0].toUpperCase() + DAY[d].slice(1)).join(" ");
  }
  const fmtAlarm = (t) => {
    const [h, m] = t.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  // --------------------------------------------------------------- sound ----
  let actx = null;
  function audio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch (e) { actx = null; }
    return actx;
  }
  function tone(freq, start, dur, vol, type) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + start;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const chime = {
    listen() { tone(660, 0, 0.16, 0.12); tone(990, 0.09, 0.22, 0.12); },
    done() { tone(990, 0, 0.14, 0.08); tone(740, 0.08, 0.22, 0.08); },
    error() { tone(220, 0, 0.25, 0.1, "triangle"); },
  };

  // ------------------------------------------------------------- ringing ----
  //  ring = { kind: "timer" | "alarm", id, label, title }
  let ring = null, ringLoop = null, ringStarted = 0;
  const RING_MAX_MS = 10 * 60 * 1000;

  function ringPattern() {
    // A bright three-note figure, every 1.6s.
    tone(1047, 0, 0.18, 0.2, "triangle"); tone(1319, 0.2, 0.18, 0.2, "triangle"); tone(1568, 0.4, 0.32, 0.2, "triangle");
  }
  function startRing(r) {
    if (ring && ring.id === r.id) return;
    ring = r;
    ringStarted = Date.now();
    clearInterval(ringLoop);
    ringPattern();
    ringLoop = setInterval(() => {
      if (!ring || Date.now() - ringStarted > RING_MAX_MS) return stopRing(false);
      ringPattern();
    }, 1600);
    openCard("ring");
    renderAll();
  }
  function stopRing(snooze) {
    clearInterval(ringLoop);
    ringLoop = null;
    const r = ring;
    ring = null;
    if (r && r.kind === "timer") Timers.remove(r.id);
    if (r && r.kind === "alarm" && snooze) Alarms.update(r.id, (a) => { a.snoozeUntil = Date.now() + 9 * 60 * 1000; });
    renderAll();
    if (!J.mode || J.mode === "idle") scheduleClose(1200);
  }

  // The Timer widget defers to this rather than beeping on its own as well.
  window.y70Island = {
    ringing: () => !!ring,
    stop: () => { if (ring) stopRing(false); },
  };
  // Ask Jarvis something from anywhere on the page, or run one of his
  // on-screen tools directly (what a test does).
  window.y70Jarvis = {
    ask: (text) => ask(String(text || "")),
    runTool: (name, input) => runClientTool({ name, input: input || {} }),
  };

  // ---------------------------------------------------------------- tick ----
  function tick() {
    const now = Date.now();
    // Timers: ring the first one that reaches zero.
    for (const t of Timers.all()) {
      if (Timers.left(t) <= 0 && t.pausedLeft == null && !t.fired) {
        Timers.update(t.id, (x) => { x.fired = true; });
        if (hasWork(t)) runScheduled(t, "Timer");
        // A silent one is just its work; it goes once that has started.
        if (t.ring === false) Timers.remove(t.id);
        else startRing({ kind: "timer", id: t.id, label: t.name, title: "Timer done" });
        break;
      }
    }
    // If the ringing timer was cleared elsewhere (the widget's Silence), stop.
    if (ring && ring.kind === "timer" && !Timers.all().some((t) => t.id === ring.id)) stopRing(false);

    // Alarms.
    const d = new Date(now);
    for (const a of Alarms.all()) {
      if (!a.on) continue;
      if (a.snoozeUntil) {
        if (now >= a.snoozeUntil) {
          Alarms.update(a.id, (x) => { x.snoozeUntil = null; });
          startRing({ kind: "alarm", id: a.id, label: a.label, title: fmtAlarm(a.time) });
        }
        continue;
      }
      const [h, m] = a.time.split(":").map(Number);
      const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      const due = now >= target && now - target < 120000 && target >= (a.armedAt || 0) - 1000;
      const dayOk = !a.days.length || a.days.includes(d.getDay());
      if (due && dayOk && a.lastFired !== dayKey(d)) {
        Alarms.update(a.id, (x) => { x.lastFired = dayKey(d); if (!x.days.length) x.on = false; });
        // Its work runs once, at the time (not again on a snooze).
        if (hasWork(a)) runScheduled(a, fmtAlarm(a.time));
        if (a.ring !== false) startRing({ kind: "alarm", id: a.id, label: a.label, title: fmtAlarm(a.time) });
      }
    }
    renderIsland();
    tickCard();
  }

  // ---------------------------------------------------------- status bar ----
  function renderClock() {
    $("#sb-clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
    const next = Alarms.all().map((a) => Alarms.next(a)).filter(Boolean).sort((x, y) => x - y)[0];
    const sa = $("#sb-alarm");
    // Like a phone: show the next alarm only when it is within a day.
    if (next && next - Date.now() < 24 * 3600 * 1000) { sa.hidden = false; sa.textContent = clock(next); }
    else sa.hidden = true;
  }

  // -------------------------------------------------------------- island ----
  function islandSegments() {
    const segs = [];
    if (ring) segs.push({ cls: "ring", ico: ring.kind === "alarm" ? "⏰" : "⏱", label: (ring.label || ring.title) });
    if (J.mode !== "idle") {
      const label = J.mode === "listening" ? "Listening…" : J.mode === "thinking" ? (J.status || "Thinking…") : "";
      segs.push({ jarvis: true, label });
    }
    // A model downloading: its progress, read off the disk by the server.
    const dl = (J.downloads || []).filter((d) => !d.done && !d.registered && !d.error);
    if (dl.length) {
      const d = dl[0];
      segs.push({ ico: "⬇", label: (d.percent != null ? d.percent + "%" : d.haveGB + " GB") + (dl.length > 1 ? "  +" + (dl.length - 1) : ""), download: true });
    }
    const running = Timers.all().filter((t) => Timers.left(t) > 0 && !(ring && ring.id === t.id))
      .sort((a, b) => Timers.left(a) - Timers.left(b));
    if (running.length) {
      const t = running[0];
      segs.push({ ico: t.pausedLeft != null ? "⏸" : "⏱", label: fmtLeft(Timers.left(t)) + (running.length > 1 ? "  +" + (running.length - 1) : ""), timer: true });
    }
    return segs;
  }

  let islandSig = "";
  function renderIsland() {
    const segs = islandSegments();
    const isl = $("#island");
    body.classList.toggle("island-on", segs.length > 0);
    const sig = JSON.stringify(segs.map((s) => [s.cls, s.ico, s.jarvis, s.jarvis ? J.mode : 0]));
    if (sig !== islandSig) {
      islandSig = sig;
      isl.innerHTML = "";
      for (const s of segs) {
        const seg = el("div", "seg" + (s.cls ? " " + s.cls : ""));
        if (s.jarvis) {
          seg.appendChild(el("span", "jv-orb"));
          if (J.mode === "speaking") {
            const bars = el("span", "jv-bars");
            for (let i = 0; i < 4; i++) bars.appendChild(el("i"));
            seg.appendChild(bars);
          }
        } else seg.appendChild(el("span", "seg-ico", s.ico));
        seg.appendChild(el("span", "seg-label", s.label));
        isl.appendChild(seg);
      }
    } else {
      // Only the words change from second to second.
      [...isl.children].forEach((n, i) => { const l = n.querySelector(".seg-label"); if (l && segs[i]) l.textContent = segs[i].label; });
    }
  }

  // ---------------------------------------------------------------- card ----
  let cardOpen = false, closeTimer = null;
  function openCard() {
    clearTimeout(closeTimer);
    if (cardOpen) return;
    cardOpen = true;
    renderAll();
    $("#island-card").classList.add("in");
    $("#island-backdrop").classList.remove("hidden");
    body.classList.add("overlay-open");
    syncWebViews();
  }
  function closeCard() {
    clearTimeout(closeTimer);
    if (!cardOpen) return;
    cardOpen = false;
    $("#island-card").classList.remove("in");
    $("#island-backdrop").classList.add("hidden");
    body.classList.remove("overlay-open");
    if (typing) setTyping(false);
    alarmDraft = null;
    syncWebViews();
  }
  function scheduleClose(ms) {
    clearTimeout(closeTimer);
    if (ring || typing || alarmDraft) return;
    closeTimer = setTimeout(() => { if (!ring && J.mode === "idle" && !typing) closeCard(); }, ms);
  }

  // The card's sections are rebuilt only when what they show changes; the
  // countdowns are updated in place every tick, so an input keeps its focus.
  function renderAll() {
    renderIsland();
    if (!cardOpen) return;
    const card = $("#island-card");
    if (!card.firstChild) {
      for (const id of ["ic-ring", "ic-jarvis", "ic-timers", "ic-alarms"]) card.appendChild(el("div", "ic-sec")).id = id;
    }
    renderRing();
    renderJarvis();
    renderTimers();
    renderAlarms();
  }

  function renderRing() {
    const box = $("#ic-ring");
    box.hidden = !ring;
    box.innerHTML = "";
    if (!ring) return;
    const w = el("div", "ic-ring");
    w.appendChild(el("div", "r-time", ring.kind === "alarm" ? ring.title : "0:00"));
    w.appendChild(el("div", "r-label", ring.label || (ring.kind === "alarm" ? "Alarm" : "Timer")));
    const btns = el("div", "r-btns");
    if (ring.kind === "alarm") {
      const sn = el("button", "r-snooze", "Snooze 9 min");
      sn.addEventListener("pointerup", () => stopRing(true));
      btns.appendChild(sn);
    } else {
      const more = el("button", "r-snooze", "+1 minute");
      more.addEventListener("pointerup", () => { const id = ring.id; stopRingKeep(); Timers.addTime(id, 60000); renderAll(); });
      btns.appendChild(more);
    }
    const stop = el("button", "r-stop", "Stop");
    stop.addEventListener("pointerup", () => stopRing(false));
    btns.appendChild(stop);
    w.appendChild(btns);
    box.appendChild(w);
  }
  // Stop the sound but keep the timer (for +1 minute).
  function stopRingKeep() {
    clearInterval(ringLoop);
    ringLoop = null;
    ring = null;
  }

  // -------------------------------------------------------- timers section --
  // Which timers exist and which are paused: the rows are rebuilt only when
  // that changes, never just because a second went by.
  let timersSig = "";
  const timerSig = (list) => list.map((t) => t.id + ":" + (t.pausedLeft != null ? 1 : 0)).join("|");
  function renderTimers() {
    const box = $("#ic-timers");
    const list = Timers.all();
    const sig = timerSig(list);
    if (sig === timersSig && box.firstChild) return tickCard();
    timersSig = sig;
    box.innerHTML = "";
    const head = el("div", "ic-head");
    head.appendChild(el("span", null, "Timers"));
    head.appendChild(el("span", "spacer"));
    box.appendChild(head);
    for (const t of list) {
      const row = el("div", "tm-row" + (t.pausedLeft != null ? " paused" : ""));
      row.dataset.timer = t.id;
      row.appendChild(el("span", "big", fmtLeft(Timers.left(t))));
      row.appendChild(el("span", "lbl", t.name));
      const plus = el("button", "btn btn--ghost btn--sm", "+1m");
      plus.addEventListener("pointerup", () => { Timers.addTime(t.id, 60000); timersSig = ""; renderTimers(); });
      const pause = el("button", "btn btn--ghost btn--sm btn--icon", t.pausedLeft != null ? "▶" : "⏸");
      pause.addEventListener("pointerup", () => { Timers.togglePause(t.id); timersSig = ""; renderTimers(); });
      const del = el("button", "btn btn--ghost btn--sm btn--icon", "✕");
      del.addEventListener("pointerup", () => { Timers.remove(t.id); timersSig = ""; renderTimers(); });
      row.append(plus, pause, del);
      box.appendChild(row);
    }
    const quick = el("div", "ic-quick");
    for (const [s, label] of [[60, "1m"], [180, "3m"], [300, "5m"], [600, "10m"], [900, "15m"], [1800, "30m"], [3600, "1h"]]) {
      const b = el("button", "btn btn--ghost btn--chip", "⏱ " + label);
      b.addEventListener("pointerup", () => { audio(); Timers.add(s); timersSig = ""; renderTimers(); });
      quick.appendChild(b);
    }
    box.appendChild(quick);
  }
  function tickCard() {
    if (!cardOpen) return;
    const list = Timers.all();
    if (timerSig(list) !== timersSig) { timersSig = ""; renderTimers(); return; }
    for (const row of document.querySelectorAll("#ic-timers .tm-row")) {
      const t = list.find((x) => x.id === row.dataset.timer);
      if (t) row.querySelector(".big").textContent = fmtLeft(Timers.left(t));
    }
  }

  // -------------------------------------------------------- alarms section --
  let alarmDraft = null;       // { h, m, days: Set } while adding one
  function renderAlarms() {
    const box = $("#ic-alarms");
    box.innerHTML = "";
    const head = el("div", "ic-head");
    head.appendChild(el("span", null, "Alarms"));
    head.appendChild(el("span", "spacer"));
    const add = el("button", "btn btn--ghost btn--sm", alarmDraft ? "Cancel" : "+ Alarm");
    add.addEventListener("pointerup", () => {
      if (alarmDraft) alarmDraft = null;
      else {
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        alarmDraft = { h: d.getHours(), m: Math.round(d.getMinutes() / 5) * 5 % 60, days: new Set() };
      }
      renderAlarms();
    });
    head.appendChild(add);
    box.appendChild(head);

    for (const a of Alarms.all()) {
      const row = el("div", "tm-row" + (a.on ? "" : " off"));
      row.appendChild(el("span", "big", fmtAlarm(a.time)));
      const lbl = el("span", "lbl", a.label || "Alarm");
      const nx = Alarms.next(a);
      lbl.appendChild(el("span", "days", describeDays(a.days) + (a.snoozeUntil ? " · snoozed to " + clock(a.snoozeUntil) : nx ? " · " + relDay(nx) : "")));
      row.appendChild(lbl);
      const tog = el("button", "btn btn--ghost btn--sm" + (a.on ? " is-on" : ""), a.on ? "On" : "Off");
      tog.addEventListener("pointerup", () => { Alarms.update(a.id, (x) => { x.on = !x.on; x.armedAt = Date.now(); x.snoozeUntil = null; }); renderAlarms(); renderClock(); });
      const del = el("button", "btn btn--ghost btn--sm btn--icon", "✕");
      del.addEventListener("pointerup", () => { Alarms.remove(a.id); renderAlarms(); renderClock(); });
      row.append(tog, del);
      box.appendChild(row);
    }
    if (!Alarms.all().length && !alarmDraft) box.appendChild(el("div", "jv-state", "No alarms. Say “Jarvis, wake me at 7.”"));

    if (alarmDraft) {
      const d = alarmDraft;
      const wrap = el("div", "al-new");
      const step = (txt, fn) => { const b = el("button", "btn btn--ghost btn--sm btn--icon", txt); b.addEventListener("pointerup", () => { fn(); renderAlarms(); }); return b; };
      const t = el("span", "al-time", fmtAlarm(String(d.h).padStart(2, "0") + ":" + String(d.m).padStart(2, "0")));
      wrap.append(step("−h", () => { d.h = (d.h + 23) % 24; }), step("+h", () => { d.h = (d.h + 1) % 24; }), t,
        step("−5", () => { d.m = (d.m + 55) % 60; }), step("+5", () => { d.m = (d.m + 5) % 60; }));
      const days = el("div", "al-days");
      DAY.forEach((n, i) => {
        const b = el("button", "btn btn--ghost btn--sm" + (d.days.has(i) ? " is-on" : ""), n[0].toUpperCase() + n.slice(1, 2));
        b.addEventListener("pointerup", () => { d.days.has(i) ? d.days.delete(i) : d.days.add(i); renderAlarms(); });
        days.appendChild(b);
      });
      const save = el("button", "btn btn--primary btn--sm", "Set alarm");
      save.addEventListener("pointerup", () => {
        audio();
        Alarms.add(String(d.h).padStart(2, "0") + ":" + String(d.m).padStart(2, "0"), "", [...d.days].sort());
        alarmDraft = null;
        renderAlarms(); renderClock();
      });
      days.appendChild(save);
      wrap.appendChild(days);
      box.appendChild(wrap);
    }
  }
  function relDay(ts) {
    const d = new Date(ts), now = new Date();
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    return diff === 0 ? "today" : diff === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" });
  }

  // ============================================================== JARVIS ====
  const J = {
    mode: "idle",            // idle | listening | thinking | speaking
    heard: "", reply: "", status: "", note: "",
    cards: [], conv: null, convAt: 0, ctl: null, provider: null,
  };
  let JS = null;              // settings, from the server
  let JST = null;             // status, from the server
  let typing = false;

  function setMode(m) {
    J.mode = m;
    body.classList.toggle("jv-active", m !== "idle");
    body.classList.toggle("jv-listening", m === "listening");
    body.classList.toggle("jv-speaking", m === "speaking");
    if (m !== "speaking") document.documentElement.style.setProperty("--jv-level", 1);
    renderIsland();
    renderJarvis();
  }

  // ----------------------------------------------------------- the card -----
  let replyEl = null, heardEl = null, statusEl = null, cardsEl = null, noteEl = null, stateEl = null;
  function renderJarvis() {
    if (!cardOpen) return;
    const box = $("#ic-jarvis");
    const show = J.mode !== "idle" || J.reply || J.heard || J.cards.length || typing || J.status || J.note;
    box.hidden = !show;
    if (!show) return;
    if (!box.firstChild) {
      const top = el("div", "jv-top");
      top.appendChild(el("span", "jv-orb"));
      stateEl = el("div", "jv-state");
      top.appendChild(stateEl);
      top.appendChild(el("span", "spacer")).style.flex = "1";
      const kb = el("button", "btn btn--ghost btn--sm btn--icon", "⌨");
      kb.title = "Type instead";
      kb.addEventListener("pointerup", () => setTyping(!typing));
      // The orb again: it is what "Jarvis, listen" looks like everywhere.
      const mic = el("button", "btn btn--ghost btn--sm btn--icon jv-again");
      mic.appendChild(el("span", "jv-orb"));
      mic.title = "Ask again";
      mic.addEventListener("pointerup", () => startListening());
      top.append(kb, mic);
      box.appendChild(top);
      heardEl = box.appendChild(el("div", "jv-heard"));
      replyEl = box.appendChild(el("div", "jv-reply"));
      statusEl = box.appendChild(el("div", "jv-status"));
      noteEl = box.appendChild(el("div", "jv-note"));
      box.appendChild(el("div", "jv-type")).id = "jv-type";
      cardsEl = box.appendChild(el("div", "jv-cards"));
    }
    stateEl.textContent = {
      idle: J.provider ? "Jarvis · " + (J.provider === "claude" ? "Claude" : "local model") : "Jarvis",
      listening: "Listening…", thinking: "Thinking…", speaking: "Speaking",
    }[J.mode];
    heardEl.textContent = J.heard ? "“" + J.heard + "”" : "";
    replyEl.textContent = J.reply.trim();
    statusEl.innerHTML = "";
    if (J.status) {
      if (J.mode === "thinking") statusEl.appendChild(el("span", "spin"));
      statusEl.appendChild(el("span", null, J.status));
    }
    noteEl.textContent = J.note;
    renderTyping();
    renderCards();
  }

  function renderTyping() {
    const box = document.getElementById("jv-type");
    if (!box) return;
    if (!typing) { box.innerHTML = ""; return; }
    if (box.firstChild) return;
    const inp = el("input", "ui-input");
    inp.placeholder = "Ask Jarvis…";
    inp.addEventListener("focus", () => relayKeyboardRequest(true));
    inp.addEventListener("blur", () => relayKeyboardRequest(false));
    inp.addEventListener("keydown", (e) => {
      if (native && native.keyboardTouch) native.keyboardTouch();
      if (e.key === "Enter" && inp.value.trim()) { const q = inp.value.trim(); inp.value = ""; ask(q); }
    });
    const send = el("button", "btn btn--primary btn--sm", "Ask");
    send.addEventListener("pointerup", () => { if (inp.value.trim()) { const q = inp.value.trim(); inp.value = ""; ask(q); } });
    box.append(inp, send);
    setTimeout(() => inp.focus(), 50);
  }
  function setTyping(on) {
    typing = !!on;
    if (!typing) relayKeyboardRequest(false);
    if (typing) openCard();
    renderJarvis();
  }

  // -------------------------------------------------------------- cards -----
  let cardsSig = "";
  function renderCards() {
    if (!cardsEl) return;
    const sig = JSON.stringify(J.cards).length + ":" + J.cards.length;
    if (sig === cardsSig && cardsEl.childElementCount === J.cards.length) return;
    cardsSig = sig;
    cardsEl.innerHTML = "";
    for (const c of J.cards.slice(-4)) {
      const node = cardNode(c);
      if (node) cardsEl.appendChild(node);
    }
  }
  function openUrl(url) {
    // In the panel there is no browser to hand a link to, so it goes to the
    // native shell's handler (your default browser on the main monitor).
    if (!url) return;
    try { window.open(url, "_blank"); } catch (e) {}
  }
  function imgEl(src, alt) {
    const i = el("img");
    i.loading = "lazy"; i.referrerPolicy = "no-referrer"; i.alt = alt || "";
    i.src = src;
    i.addEventListener("error", () => i.remove());
    return i;
  }
  function cardNode(c) {
    const box = el("div", "jc");
    if (c.kind === "results") {
      box.appendChild(el("div", "jc-title", "Results · " + c.query));
      for (const r of (c.items || []).slice(0, 5)) {
        const row = el("div", "jc-row");
        const col = el("div");
        col.appendChild(el("div", "t", r.title));
        if (r.snippet) col.appendChild(el("div", "s", r.snippet));
        col.appendChild(el("div", "m", (r.date ? r.date + " · " : "") + r.site));
        row.appendChild(col);
        row.addEventListener("pointerup", () => openUrl(r.url));
        box.appendChild(row);
      }
      return box;
    }
    if (c.kind === "images") {
      box.appendChild(el("div", "jc-title", "Images · " + c.query));
      const grid = el("div", "jc-imgs");
      for (const im of (c.items || []).slice(0, 9)) {
        const i = imgEl(im.thumb, im.title);
        i.addEventListener("pointerup", () => {
          // Tap a thumbnail to see it big, in place.
          const big = box.querySelector(".jc-big");
          if (big) big.remove();
          const b = imgEl(im.image, im.title);
          b.className = "jc-big";
          b.addEventListener("pointerup", () => b.remove());
          box.appendChild(b);
        });
        grid.appendChild(i);
      }
      box.appendChild(grid);
      return box;
    }
    if (c.kind === "page") {
      box.appendChild(el("div", "jc-title", "Reading"));
      const row = el("div", "jc-row");
      if (c.image) row.appendChild(imgEl(c.image));
      const col = el("div");
      col.appendChild(el("div", "t", c.title || c.url));
      col.appendChild(el("div", "m", (c.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0]));
      row.appendChild(col);
      row.addEventListener("pointerup", () => openUrl(c.url));
      box.appendChild(row);
      return box;
    }
    if (c.kind === "weather" && c.data) {
      const w = c.data;
      box.appendChild(el("div", "jc-title", "Weather · " + w.place));
      const now = el("div", "jc-wx-now");
      now.appendChild(el("div", "temp", w.now.temp + "°"));
      const col = el("div");
      col.appendChild(el("div", "sky", w.now.sky));
      col.appendChild(el("div", "more", "Feels " + w.now.feels + "° · wind " + w.now.wind + " mph · " + w.now.humidity + "% humidity"));
      now.appendChild(col);
      box.appendChild(now);
      const days = el("div", "jc-wx-days");
      for (const d of w.days) {
        const cell = el("div");
        cell.appendChild(el("b", null, d.day || d.date));
        cell.appendChild(document.createTextNode(d.high + "° / " + d.low + "°"));
        cell.appendChild(el("div", "more", d.sky + (d.rain ? " · " + d.rain + "%" : "")));
        days.appendChild(cell);
      }
      box.appendChild(days);
      return box;
    }
    if (c.kind === "models") {
      box.appendChild(el("div", "jc-title", "Models · " + c.query));
      for (const r of (c.items || []).slice(0, 3)) {
        const wrap = el("div", "jc-model");
        wrap.appendChild(el("div", "t", r.repo));
        wrap.appendChild(el("div", "m", (r.downloads ? r.downloads.toLocaleString() + " downloads" : "") + (r.updated ? " · updated " + r.updated : "")));
        const b = r.best;
        wrap.appendChild(el("div", "s", "Recommended: " + b.quant + " · " + b.sizeGB + " GB · " + (b.fits ? "fits the GPU" : "bigger than the GPU")));
        const btns = el("div", "jv-actions");
        const dl = el("button", "btn btn--primary btn--sm", "Download " + b.quant + " · " + b.sizeGB + " GB");
        dl.addEventListener("pointerup", () => startDownload(r.repo, b.path, dl));
        const page = el("button", "btn btn--ghost btn--sm", "Page");
        page.addEventListener("pointerup", () => openWeb(r.page));
        btns.append(dl, page);
        for (const o of (r.others || []).slice(0, 4)) {
          const ob = el("button", "btn btn--ghost btn--sm" + (o.fits ? "" : " is-danger"), o.quant + " · " + o.sizeGB);
          ob.title = "Download " + o.path;
          ob.addEventListener("pointerup", () => startDownload(r.repo, o.path, ob));
          btns.appendChild(ob);
        }
        wrap.appendChild(btns);
        box.appendChild(wrap);
      }
      return box;
    }
    if (c.kind === "show") {
      box.appendChild(el("div", "jc-title", c.title || ""));
      for (const it of (c.items || []).slice(0, 12)) {
        const row = el("div", "jc-row");
        if (it.image) row.appendChild(imgEl(it.image));
        const col = el("div");
        if (it.title) col.appendChild(el("div", "t", it.title));
        if (it.text) col.appendChild(el("div", "s", it.text));
        row.appendChild(col);
        if (it.url) row.addEventListener("pointerup", () => openUrl(it.url));
        box.appendChild(row);
      }
      return box;
    }
    return null;
  }

  // -------------------------------------------------------------- speech ----
  // Replies stream in; each sentence is voiced as soon as it is complete, so
  // Jarvis starts talking long before the answer has finished arriving.
  const speech = {
    q: [], buf: "", playing: false, ended: false, gen: 0, audio: null, analyser: null, raf: 0,
    reset() {
      this.gen++;
      this.q = []; this.buf = ""; this.ended = false;
      if (this.audio) { try { this.audio.pause(); } catch (e) {} }
      this.audio = null;
      if (this.playing) post("speaking", { on: false });
      this.playing = false;
      cancelAnimationFrame(this.raf);
    },
    feed(delta) {
      if (!JS || !JS.speak) return;
      this.buf += delta;
      // Cut at the last sentence end that leaves at least ~30 characters, so
      // short fragments are not voiced one at a time.
      const re = /[.!?…]["')\]]*\s+/g;
      let cut = -1, m;
      while ((m = re.exec(this.buf))) if (m.index + m[0].length >= 30) cut = m.index + m[0].length;
      if (cut > 0) { this.enqueue(this.buf.slice(0, cut)); this.buf = this.buf.slice(cut); }
    },
    end() {
      this.ended = true;
      if (this.buf.trim()) this.enqueue(this.buf);
      this.buf = "";
      if (!this.playing && !this.q.length) this.finished();
    },
    enqueue(text) {
      const clean = text.replace(/https?:\/\/\S+/g, "").replace(/[*_#`>~|]/g, "").replace(/\s+/g, " ").trim();
      if (!clean) return;
      const gen = this.gen;
      const p = fetch(API + "tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clean }) })
        .then((r) => (r.ok ? r.blob() : null)).then((b) => (b && gen === this.gen ? URL.createObjectURL(b) : null)).catch(() => null);
      this.q.push({ p, text: clean });
      this.pump();
    },
    async pump() {
      if (this.playing || !this.q.length) return;
      const gen = this.gen;
      this.playing = true;
      const item = this.q.shift();
      // The helper keeps listening while he talks (so "Jarvis..." and "stop"
      // can cut him off) and is told the sentence, so his own voice cannot.
      post("speaking", { on: true, text: item.text });
      const url = await item.p;
      if (gen !== this.gen) return;
      if (!url) { this.playing = false; return this.q.length ? this.pump() : this.ended && this.finished(); }
      setMode("speaking");
      const a = new Audio(url);
      this.audio = a;
      this.meter(a);
      a.onended = a.onerror = () => {
        URL.revokeObjectURL(url);
        if (gen !== this.gen) return;
        this.playing = false;
        if (this.q.length) this.pump();
        else if (this.ended) this.finished();
      };
      a.play().catch(() => a.onended());
    },
    // The orb breathes with the voice.
    meter(a) {
      try {
        const ac = audio();
        if (!ac) return;
        const src = ac.createMediaElementSource(a);
        const an = ac.createAnalyser();
        an.fftSize = 256;
        src.connect(an); an.connect(ac.destination);
        const data = new Uint8Array(an.frequencyBinCount);
        const loop = () => {
          if (this.audio !== a) return;
          an.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          document.documentElement.style.setProperty("--jv-level", (1 + Math.min(0.5, peak / 128)).toFixed(3));
          this.raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) { /* fine without it */ }
    },
    finished() {
      if (this.playing) return;
      post("speaking", { on: false });
      cancelAnimationFrame(this.raf);
      afterAnswer();
    },
    stop() { this.reset(); afterAnswer(true); },
  };

  // After an answer: a question back ("Which one?") keeps the conversation
  // going by listening again; anything else lets the card fold away.
  function afterAnswer(interrupted) {
    if (J.ctl) return;               // the turn is still running
    // A restart or reload the reply promised waits until it has been heard.
    if (J.afterReply) {
      const run = J.afterReply;
      J.afterReply = null;
      setTimeout(() => { try { run(); } catch (e) {} }, 400);
    }
    setMode("idle");
    if (!interrupted && /\?\s*$/.test(J.reply.trim()) && JS && JS.speak) {
      setTimeout(() => { if (J.mode === "idle") startListening(true); }, 350);
      return;
    }
    scheduleClose(J.cards.length ? 45000 : 7000);
  }

  // --------------------------------------------------------- listening ------
  // The rest of a request whose start was heard with the wake word. If nothing
  // more comes within the pause setting, the start alone is the request.
  async function continueListening(start) {
    speech.reset();
    if (J.ctl) { J.ctl.abort(); J.ctl = null; }
    J.reply = ""; J.cards = []; cardsSig = "";
    J.heard = start; J.prefix = start; J.status = ""; J.note = "";
    openCard();
    setMode("listening");
    const r = await post("listen", { prefix: start });
    if (!r.ok) { J.prefix = null; ask(start); }
  }

  async function startListening(followUp) {
    J.prefix = null;
    speech.reset();
    if (J.ctl) { J.ctl.abort(); J.ctl = null; }
    if (!followUp) { J.reply = ""; J.cards = []; cardsSig = ""; }
    J.heard = ""; J.status = ""; J.note = "";
    openCard();
    setMode("listening");
    chime.listen();
    const r = await post("listen", {});
    if (!r.ok) {
      J.status = r.error || "Can't listen right now.";
      chime.error();
      setMode("idle");
      scheduleClose(6000);
    }
  }

  function context() {
    const c = {};
    if (typeof lastState !== "undefined" && lastState && lastState.hasTrack) {
      c.playing = lastState.title + " by " + lastState.artist + (lastState.playing ? "" : " (paused)") + " on Spotify";
    }
    const ts = Timers.all().filter((t) => Timers.left(t) > 0);
    if (ts.length) c.timers = ts.map((t) => t.name + " with " + human(Timers.left(t) / 1000) + " left").join(", ");
    // What is on the panel right now, so "make it bigger" has an "it".
    try { c.screen = describeScreen(); } catch (e) {}
    return c;
  }

  function ask(text) {
    speech.reset();
    J.heard = text; J.reply = ""; J.status = ""; J.cards = []; cardsSig = "";
    openCard();
    setMode("thinking");
    // A follow-up within a few minutes continues the conversation.
    const conv = Date.now() - J.convAt < 4.5 * 60 * 1000 ? J.conv : null;
    runTurn({ conv, text, context: context() });
  }

  const TOOL_WORDS = {
    web_search: "Searching the web", read_page: "Reading", image_search: "Finding pictures",
    weather: "Checking the weather", volume: "Adjusting the volume", remember: "Remembering",
    discord: "Talking to Discord", notes: "Opening your notes", phone: "Talking to your phone", info: "Checking",
    lights: "Changing the lights", recall: "Remembering", find_model: "Looking for models",
  };

  async function runTurn(payload) {
    if (J.ctl) J.ctl.abort();
    const ctl = new AbortController();
    J.ctl = ctl;
    let clientCalls = null;
    try {
      const res = await fetch(API + "turn", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", pending = false;
      const flush = () => { pending = false; renderJarvis(); };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (e) { continue; }
          switch (ev.type) {
            case "start": J.conv = ev.conv; J.provider = ev.provider; break;
            case "status": J.status = ev.text; break;
            case "thinking": if (J.mode !== "speaking") setMode("thinking"); break;
            case "text":
              J.reply += ev.delta;
              speech.feed(ev.delta);
              if (J.status && !/…$/.test(J.status)) J.status = "";
              break;
            case "tool":
              J.status = ev.status === "running" ? (TOOL_WORDS[ev.name] || ev.name) + "…" : "";
              break;
            case "card": J.cards.push(ev.card); break;
            case "client": clientCalls = ev.calls; break;
            case "memory": if (jarvisViewOpen()) loadFacts(); break;
            case "notes": showNotes(ev.flash); break;
            case "done": J.convAt = Date.now(); break;
            case "error":
              J.reply += (J.reply ? " " : "") + ev.message;
              speech.feed(" " + ev.message);
              chime.error();
              break;
            default: break;
          }
          if (!pending) { pending = true; requestAnimationFrame(flush); }
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      J.status = "Lost the connection to Jarvis.";
    }
    if (J.ctl !== ctl) return;
    J.ctl = null;
    if (clientCalls) {
      const results = [];
      for (const c of clientCalls) {
        try { results.push({ id: c.id, content: String(await runClientTool(c)) }); }
        catch (e) { results.push({ id: c.id, content: "Failed: " + (e.message || e), is_error: true }); }
      }
      renderAll();
      return runTurn({ conv: J.conv, results });
    }
    J.status = "";
    J.convAt = Date.now();
    renderJarvis();
    // Silent replies get a small chime so you know the answer is there.
    if ((!JS || !JS.speak) && J.reply.trim()) chime.done();
    speech.end();
  }

  // ------------------------------------------------------- client tools -----
  async function runClientTool(c) {
    const a = c.input || {};
    switch (c.name) {
      case "timer": {
        if (a.action === "set") {
          const s = Math.round(Number(a.seconds));
          if (!(s > 0)) return "How long? seconds is required.";
          audio();
          const t = Timers.add(s, a.label, a);
          renderAll();
          return "Timer \"" + t.name + "\" set for " + human(s) + "; it ends at " + clock(t.endsAt) + workTag(t) + ".";
        }
        if (a.action === "cancel") {
          const list = Timers.all();
          const q = String(a.label || "").toLowerCase().trim();
          const gone = q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
          Timers.save(list.filter((t) => !gone.includes(t)));
          if (ring && ring.kind === "timer" && gone.some((t) => t.id === ring.id)) stopRing(false);
          renderAll();
          return gone.length ? "Cancelled " + gone.length + " timer" + (gone.length > 1 ? "s" : "") + "." : "No timer matched.";
        }
        const list = Timers.all().filter((t) => Timers.left(t) > 0);
        return list.length ? JSON.stringify(list.map((t) => ({ label: t.name, left: human(Timers.left(t) / 1000), paused: t.pausedLeft != null, then: workTag(t) || undefined }))) : "No timers running.";
      }
      case "alarm": {
        if (a.action === "set") {
          const m = String(a.time || "").match(/^(\d{1,2}):(\d{2})/);
          if (!m || +m[1] > 23 || +m[2] > 59) return "time must be HH:MM, 24-hour.";
          const time = m[1].padStart(2, "0") + ":" + m[2];
          const days = parseDays(a.days);
          audio();
          const al = Alarms.add(time, a.label, days, a);
          renderAll(); renderClock();
          const nx = Alarms.next(al);
          const verb = al.ring === false ? "Scheduled for " : "Alarm set for ";
          return verb + fmtAlarm(time) + " (" + describeDays(days) + ")" + (nx ? ", next " + relDay(nx) + " at " + clock(nx) : "") + workTag(al) + ".";
        }
        if (a.action === "attach") {
          // Work added to an alarm that already exists ("when my 7 o'clock goes off...").
          const tm = String(a.time || "").match(/^(\d{1,2}):(\d{2})/);
          const t = tm ? tm[1].padStart(2, "0") + ":" + tm[2] : null;
          const q = String(a.label || "").toLowerCase().trim();
          const al = Alarms.all().find((x) => (t && x.time === t) || (q && x.label.toLowerCase().includes(q)));
          if (!al) return "No alarm like that. Alarms: " + (Alarms.all().map((x) => fmtAlarm(x.time) + (x.label ? " " + x.label : "")).join(", ") || "none") + ".";
          const add = schedExtra(a);
          if (!hasWork(add)) return "Attach what? Give actions or a prompt.";
          Alarms.update(al.id, (x) => {
            if (add.actions) x.actions = (x.actions || []).concat(add.actions).slice(0, 8);
            if (add.prompt) x.prompt = add.prompt;
            if (a.ring === false) x.ring = false;
          });
          const now = Alarms.all().find((x) => x.id === al.id);
          renderAll();
          return "The " + fmtAlarm(now.time) + " alarm will also do this" + workTag(now) + ".";
        }
        if (a.action === "cancel") {
          const list = Alarms.all();
          const q = String(a.label || "").toLowerCase().trim();
          const tm = String(a.time || "").match(/^(\d{1,2}):(\d{2})/);
          const t = tm ? tm[1].padStart(2, "0") + ":" + tm[2] : null;
          const gone = list.filter((x) => (!q && !t) || (t && x.time === t) || (q && x.label.toLowerCase().includes(q)));
          Alarms.save(list.filter((x) => !gone.includes(x)));
          renderAll(); renderClock();
          return gone.length ? "Removed " + gone.length + " alarm" + (gone.length > 1 ? "s" : "") + "." : "No alarm matched.";
        }
        const list = Alarms.all();
        return list.length ? JSON.stringify(list.map((x) => ({ time: fmtAlarm(x.time), label: x.label, repeats: describeDays(x.days), on: x.on, then: workTag(x) || undefined }))) : "No alarms set.";
      }
      case "music": return musicTool(a);
      case "show":
        J.cards.push({ kind: "show", title: a.title, items: Array.isArray(a.items) ? a.items : [] });
        renderJarvis();
        return "It's on the screen.";
      case "panel": return panelTool(a);
      case "layout": return layoutTool(a);
      case "youtube": return youtubeTool(a);
      case "open_app":
        if (!APPS[a.app]) return "There's no app called " + a.app + ".";
        setApp(a.app);
        return "Opened " + APPS[a.app].title + ".";
      case "open_web":
        return openWeb(a.url) ? "Opened " + a.url + " on the panel." : "That isn't a web address.";
      case "download_model":
        return downloadTool(a);
      default:
        return "Unknown tool " + c.name;
    }
  }

  // ------------------------------------------------------------- the app -----
  // Jarvis drives the dashboard the way the drawer does: shell.js's own
  // functions, and window.y70native (shell.js's `native`) for the parts only
  // the installed app has — updates, forks, start-up, focus.
  const pick = (list, q) => {
    const n = String(q || "").toLowerCase().trim();
    return n ? (list.find((x) => x.toLowerCase() === n) || list.find((x) => x.toLowerCase().startsWith(n)) || list.find((x) => x.toLowerCase().includes(n))) : null;
  };
  const updateWords = (u) => !u ? "unknown" : ({
    idle: "not checked yet", checking: "checking", current: "up to date",
    downloading: "downloading v" + (u.version || "?") + (u.percent ? " (" + u.percent + "%)" : ""),
    ready: "v" + (u.version || "?") + " downloaded, waiting for a restart",
    dev: "updates are off (this copy runs from source)", error: "the last check failed: " + (u.error || "unknown"),
  }[u.status] || u.status);

  async function panelTool(a) {
    const nat = typeof native !== "undefined" ? native : null;
    const NO_NATIVE = "That part only works in the installed app, not in a browser.";
    const onOff = (v) => (v ? "on" : "off");
    switch (a.action) {
      case "status": {
        const s = {
          app: state.app, widgetsOpen: Object.keys(WIDGETS).filter((n) => state.widgets[n] && state.widgets[n].on),
          scene: state.scene, theme: theme.name,
          apps: Object.keys(APPS), widgets: Object.keys(WIDGETS), scenes: SCENES.map((x) => x.id), themes: Y70Theme.PRESETS.map((p) => p.name),
        };
        if (!nat) return JSON.stringify({ ...s, note: "running in a browser: no updates or native settings here" });
        const q = (f) => Promise.resolve().then(f).catch(() => null);
        const [v, u, f, kb, lock, auto, tb] = await Promise.all([
          q(() => nat.version()), q(() => nat.updateState()), q(() => nat.forks && nat.forks()),
          q(() => nat.getKeyboardMode()), q(() => nat.getPassiveLock()), q(() => nat.getAutoStart()), q(() => nat.getShowInTaskbar()),
        ]);
        return JSON.stringify({
          ...s, version: v, update: updateWords(u),
          fork: f ? { current: f.current, switchingTo: f.switchingTo || null, available: f.forks.map((x) => x.id + " (" + x.name + ")") } : null,
          keyboardMode: kb, neverTakeFocus: lock, startWithWindows: auto, taskbarIcon: tb,
        });
      }
      case "check_updates": {
        if (!nat) return NO_NATIVE;
        let u = await nat.checkUpdate();
        paintUpdate(u);
        // The check runs in the background; give it up to 20 s to say something.
        for (let i = 0; i < 40 && u && (u.status === "checking" || u.status === "idle"); i++) {
          await new Promise((r) => setTimeout(r, 500));
          u = await nat.updateState();
        }
        paintUpdate(u);
        const v = await nat.version().catch(() => "?");
        return "This is v" + v + ". Update: " + updateWords(u) + "." + (u && u.status === "ready" ? " Say the word and I'll restart into it." : "");
      }
      case "install_update": {
        if (!nat) return NO_NATIVE;
        const u = await nat.updateState();
        if (!u || u.status !== "ready") return "There's no downloaded update to install (" + updateWords(u) + ").";
        // Restart once the reply has been spoken, not in the middle of it.
        J.afterReply = () => nat.installUpdate();
        return "Restarting into v" + (u.version || "?") + " as soon as you've heard this.";
      }
      case "switch_fork": {
        if (!nat || !nat.forks) return NO_NATIVE;
        const f = await nat.forks();
        const target = f.forks.find((x) => x.id === a.fork || x.name.toLowerCase().includes(String(a.fork || a.name || "").toLowerCase()) && (a.fork || a.name));
        if (!target) return "Forks: " + f.forks.map((x) => x.id + " = " + x.name).join(", ") + ". Which one?";
        if (target.id === f.current) return "This already is " + target.name + ".";
        if (!f.packaged) return "Forks only switch in the installed app.";
        const r = await nat.switchFork(target.id);
        if (r && r.ok === false) return "Couldn't switch: " + (r.error || "unknown");
        if (r && r.forks) { forkInfo = r; paintForks(); }
        return "Downloading " + target.name + "'s latest build. When it's ready, install_update restarts into it; settings and sign-ins carry over.";
      }
      case "cancel_fork_switch": {
        if (!nat || !nat.cancelForkSwitch) return NO_NATIVE;
        const r = await nat.cancelForkSwitch();
        if (r && r.forks) { forkInfo = r; paintForks(); }
        return "Fork switch cancelled.";
      }
      case "open": {
        const name = pick(Object.keys(APPS), a.app || a.name);
        if (!name) return "Apps: " + Object.keys(APPS).join(", ") + ".";
        closeCard();
        setApp(name);
        return "Opened " + APPS[name].title + ".";
      }
      case "widget": {
        const name = pick(Object.keys(WIDGETS), a.name) || Object.keys(WIDGETS).find((k) => WIDGETS[k].title.toLowerCase().includes(String(a.name || "").toLowerCase()) && a.name);
        if (!name) return "Widgets: " + Object.keys(WIDGETS).join(", ") + ".";
        const w = state.widgets[name] || (state.widgets[name] = { on: false, h: null, collapsed: false });
        w.on = a.on == null ? !w.on : !!a.on;
        if (w.on) w.collapsed = false;
        save(); renderDock(); renderWidgetList();
        return WIDGETS[name].title + " widget " + (w.on ? "shown" : "hidden") + ".";
      }
      case "scene": {
        const sc = SCENES.find((x) => x.id === String(a.name || "").toLowerCase()) || SCENES.find((x) => x.name.toLowerCase().includes(String(a.name || "").toLowerCase()) && a.name);
        if (!sc) return "Scenes: " + SCENES.map((x) => x.name).join(", ") + ".";
        applyScene(sc.id);
        return sc.name + " layout on.";
      }
      case "theme": {
        const p = Y70Theme.PRESETS.find((x) => x.name.toLowerCase() === String(a.name || "").toLowerCase())
          || Y70Theme.PRESETS.find((x) => x.name.toLowerCase().includes(String(a.name || "").toLowerCase()) && a.name);
        if (!p) return "Themes: " + Y70Theme.PRESETS.map((x) => x.name).join(", ") + ".";
        applyTheme({ ...Y70Theme.preset(p.id) });
        return "Theme set to " + p.name + ".";
      }
      case "settings": {
        const page = String(a.name || "drawer").toLowerCase();
        closeCard();
        if (/close|shut|hide/.test(page)) { openDrawer(false); return "Closed."; }
        openDrawer(true);
        if (/jarvis|assistant|voice/.test(page)) showJarvisView(true);
        else if (/appear|theme|colou?r|look/.test(page)) showSettings(true);
        return "Opened " + (/jarvis|assistant|voice/.test(page) ? "Jarvis's settings" : /appear|theme|colou?r|look/.test(page) ? "the appearance settings" : "the drawer") + ".";
      }
      case "reload": {
        if (!nat) { J.afterReply = () => location.reload(); return "Reloading the panel."; }
        J.afterReply = () => nat.reload();
        return "Reloading the panel as soon as you've heard this.";
      }
      case "keyboard": {
        if (!nat) return NO_NATIVE;
        const on = await nat.setKeyboardMode(a.on !== false);
        return "Keyboard mode " + onOff(on) + ".";
      }
      case "never_take_focus": {
        if (!nat) return NO_NATIVE;
        const on = await nat.setPassiveLock(a.on !== false);
        const el = $("#passive-lock");
        if (el) { el.textContent = "Never take focus: " + (on ? "ON" : "off"); el.classList.toggle("is-on", !!on); }
        return "Never take focus is " + onOff(on) + ".";
      }
      case "screensaver": {
        if (!nat || !nat.screensaver) return NO_NATIVE;
        // After the reply has been heard, or the screensaver would cut it off.
        J.afterReply = async () => { await nat.screensaver("start"); };
        return "Starting the screensaver on both screens as soon as you've heard this. Say \"Jarvis\" and the panel comes back over it while the main monitor stays in screensaver; moving the mouse ends it everywhere.";
      }
      case "screensaver_off": {
        if (!nat || !nat.screensaver) return NO_NATIVE;
        const r = await nat.screensaver("stop");
        return r && r.note ? "There was no screensaver of mine running (moving the mouse ends one Windows started)." : "Screensaver off.";
      }
      case "wallpaper": {
        const r = await fetch(API + "wallpaper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: a.name }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
        return r.ok ? r.text : "Wallpaper Engine: " + r.error;
      }
      case "start_with_windows":
      case "taskbar_icon": {
        if (!nat) return NO_NATIVE;
        const auto = a.action === "start_with_windows";
        const on = auto ? await nat.setAutoStart(a.on !== false) : await nat.setShowInTaskbar(a.on !== false);
        const el = $(auto ? "#native-autostart" : "#native-taskbar");
        const label = auto ? "Start with Windows" : "Taskbar icon";
        if (el) { el.textContent = label + ": " + onOff(on); el.classList.toggle("is-on", !!on); }
        return label + " is " + onOff(on) + ".";
      }
      default: return "Unknown panel action " + a.action + ".";
    }
  }

  // ------------------------------------------------------------ the screen ---
  // What every panel is for, so "put something useful under the video" has
  // an answer.
  const CAPS = {
    claude: "Claude Code usage: tokens and cost today, this month, a 7-day chart",
    weather: "weather at home now, with a clock",
    pc: "live CPU, GPU, memory and network graphs, the busiest programs",
    calc: "a calculator (layout calculator puts a sum on it)",
    media: "what is playing on the PC, any app, with play/pause/skip",
    lyrics: "synced lyrics of the song playing; tap a line to jump there",
    audio: "speakers, microphone and per-program volume sliders",
    timer: "timers and alarms (Jarvis's timers show here)",
    notes: "notes and lists, formatted (the notes tool writes and edits them)",
    discord: "Discord voice: the channel, who is talking, mute and deafen",
    face: "the webcam",
    pin: "holds another program's window on the panel, e.g. a Discord or Snapchat call (layout pin)",
    "app:spotify": "Spotify: library, search, playlists, queue",
    "app:weather": "the full weather app with a radar map",
    "app:youtube": "YouTube (the youtube tool plays videos, just the video if asked)",
    "app:shorts": "YouTube Shorts, a feed with auto-scroll",
    "app:tiktok": "TikTok, a feed with auto-scroll",
    "app:snapchat": "Snapchat for web",
    "app:web": "any web page (open_web)",
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // "youtube", "the PC stats", "weather app" -> a panel key. "weather" is both a
  // widget and an app: the one on screen wins, the app if the words say app.
  function panelKeyFor(name) {
    const raw = String(name || "").toLowerCase();
    const n = raw.replace(/\b(the|my|widget|panel|app)\b/g, "").replace(/\s+/g, " ").trim();
    if (!n) return null;
    const wantsApp = /\bapp\b/.test(raw);
    const widgets = Object.keys(WIDGETS), apps = Object.keys(APPS);
    const w = widgets.find((k) => k === n) || widgets.find((k) => WIDGETS[k].title.toLowerCase() === n) ||
      widgets.find((k) => WIDGETS[k].title.toLowerCase().includes(n) || n.includes(k));
    const ap = apps.find((k) => k === n) || apps.find((k) => APPS[k].title.toLowerCase() === n);
    if (w && ap) {
      const wOn = state.widgets[w] && state.widgets[w].on;
      return wantsApp || (isDocked(ap) && !wOn) || (state.app === ap && !wOn) ? "app:" + ap : w;
    }
    return ap ? "app:" + ap : w || null;
  }
  const keyTitle = (k) => (panelDef(k) ? panelDef(k).title + (isAppKey(k) ? " app" : "") : k);
  function heightFor(a, key) {
    const H = window.innerHeight;
    if (a.height) return Number(a.height);
    const f = { small: 0.2, medium: 0.33, large: 0.55, half: 0.5 }[a.size];
    return f ? Math.round(H * f) : null;
  }
  function positionFor(a) {
    if (a.before) { const k = panelKeyFor(a.before); if (k) return { before: k }; }
    if (a.after) { const k = panelKeyFor(a.after); if (k) return { after: k }; }
    if (a.position == null || a.position === "") return null;
    return /^\d+$/.test(String(a.position)) ? Number(a.position) : String(a.position).toLowerCase();
  }
  // A widget's frame, made and loaded if it has to be.
  async function widgetFrame(key) {
    const w = state.widgets[key] || (state.widgets[key] = { on: false, h: null, collapsed: false });
    const fresh = !w.on;
    w.on = true; w.collapsed = false;
    // Into the room that is left, not off the bottom of the screen.
    if (fresh) w.h = Math.max(MIN_H, Math.min(w.h || defaultH(key), dockRoom(key)));
    save(); renderDock();
    const panel = document.querySelector('#dock .panel[data-key="' + key + '"]');
    if (panel) panel.scrollIntoView({ block: "nearest" });
    const f = panel && panel.querySelector("iframe");
    if (f && fresh) await new Promise((r) => { f.addEventListener("load", r, { once: true }); setTimeout(r, 4000); });
    return f;
  }
  function frameAsk(f, msg, replyType, ms) {
    return new Promise((resolve) => {
      const id = "l" + Date.now() + Math.random().toString(36).slice(2, 5);
      const onMsg = (e) => { if (e.data && e.data.type === replyType && e.data.id === id) { removeEventListener("message", onMsg); resolve(e.data); } };
      addEventListener("message", onMsg);
      try { f.contentWindow.postMessage({ ...msg, id }, "*"); } catch (e) {}
      setTimeout(() => { removeEventListener("message", onMsg); resolve(null); }, ms || 8000);
    });
  }

  // The Notes widget, open and showing what Jarvis just changed.
  async function showNotes(flash) {
    const f = await widgetFrame("notes");
    try { f && f.contentWindow.postMessage({ type: "y70:notes-reload", flash: flash || [] }, "*"); } catch (e) {}
  }

  async function layoutTool(a) {
    const app = (x) => { const n = String(x || "").toLowerCase().replace(/\b(the|app)\b/g, "").trim(); return Object.keys(APPS).find((k) => k === n || APPS[k].title.toLowerCase() === n) || null; };
    switch (a.action) {
      case "status": {
        const s = layoutSnapshot();
        return JSON.stringify({
          ...s,
          panels: s.panels.map((p) => ({ ...p, does: CAPS[p.key] })),
          hiddenWidgets: s.hiddenWidgets.map((k) => k + ": " + CAPS[k]),
          apps: Object.keys(APPS).map((k) => k + (k === (s.main && s.main.app) ? " (main)" : isDocked(k) ? " (in a panel)" : "") + ": " + CAPS["app:" + k]),
          scenes: SCENES.map((x) => x.id + (state.sceneEdits[x.id] ? " (saved by the user)" : "")),
        });
      }
      case "open": {
        const n = app(a.app || a.name);
        if (!n) return "Apps: " + Object.keys(APPS).join(", ") + ".";
        closeCard(); setApp(n);
        return "Opened " + APPS[n].title + " in the main area.";
      }
      case "focus": {
        const n = app(a.app || a.name) || (focus && focus.app) || state.app;
        if (!n) return "Which app?";
        closeCard(); setFocus(n);
        return APPS[n].title + " has the whole screen; the widgets are hidden until exit_focus (or the Exit chip in the top bar).";
      }
      case "exit_focus":
        return clearFocus() ? "Back to the layout: " + describeScreen() : "Nothing was full screen.";
      case "home":
        clearFocus(true); applyScene("home");
        return "Home layout: " + describeScreen();
      case "save_home":
        saveScene("home");
        return "Saved what is on screen as Home: " + describeScreen();
      case "widget": {
        const key = panelKeyFor(a.name);
        if (!key || isAppKey(key)) return "Widgets: " + Object.keys(WIDGETS).join(", ") + ".";
        const w = state.widgets[key] || (state.widgets[key] = { on: false, h: null, collapsed: false });
        w.on = a.on == null ? !w.on : !!a.on;
        if (w.on) w.collapsed = false;
        save(); renderDock();
        return WIDGETS[key].title + " widget " + (w.on ? "shown" : "hidden") + ". Now: " + describeScreen();
      }
      case "dock": {
        const n = app(a.app || a.name);
        if (!n) return "Apps: " + Object.keys(APPS).join(", ") + ".";
        dockApp(n, { h: heightFor(a, "app:" + n), position: positionFor(a) });
        return APPS[n].title + " is in a panel now. " + describeScreen();
      }
      case "undock": {
        const n = app(a.app || a.name);
        if (!n || !undockApp(n)) return (n ? APPS[n].title : "That") + " isn't in a panel.";
        return APPS[n].title + "'s panel is closed. " + describeScreen();
      }
      case "resize": {
        const key = panelKeyFor(a.name || a.app);
        if (!key) return "Which panel? " + describeScreen();
        if (isAppKey(key) && state.app === appOf(key) && !isDocked(appOf(key))) {
          return APPS[appOf(key)].title + " is the main app: it takes whatever the panels leave. Make the panels smaller, focus it, or dock it to size it.";
        }
        const h = heightFor(a, key);
        if (!h) return "How big? Give height in pixels or size small/medium/large/half.";
        if (!(state.widgets[key] && state.widgets[key].on)) {
          if (isAppKey(key)) dockApp(appOf(key)); else { state.widgets[key] = { ...(state.widgets[key] || {}), on: true, collapsed: false }; }
        }
        const got = resizePanel(key, h);
        return keyTitle(key) + " is " + got + " px tall now (the screen is " + window.innerHeight + ").";
      }
      case "move": {
        const key = panelKeyFor(a.name || a.app);
        const pos = positionFor(a);
        if (!key || pos == null) return "Which panel, and where (top, bottom, a number, or before/after another)?";
        if (!(state.widgets[key] && state.widgets[key].on)) return keyTitle(key) + " isn't on screen. Show or dock it first.";
        movePanel(key, pos);
        return "Moved. " + describeScreen();
      }
      case "collapse":
      case "expand": {
        const key = panelKeyFor(a.name || a.app);
        const w = key && state.widgets[key];
        if (!w || !w.on) return "That panel isn't on screen. " + describeScreen();
        w.collapsed = a.action === "collapse";
        save(); renderDock();
        return keyTitle(key) + (w.collapsed ? " collapsed to its bar." : " expanded.");
      }
      case "scene": {
        const q = String(a.name || "").toLowerCase();
        const sc = SCENES.find((x) => x.id === q) || SCENES.find((x) => q && x.name.toLowerCase().includes(q));
        if (!sc) return "Scenes: " + SCENES.map((x) => x.name).join(", ") + ".";
        closeCard(); applyScene(sc.id);
        return sc.name + " layout: " + describeScreen();
      }
      case "save_scene": {
        const q = String(a.name || "").toLowerCase();
        const sc = SCENES.find((x) => x.id === q) || SCENES.find((x) => q && x.name.toLowerCase().includes(q));
        if (!sc) return "Scenes: " + SCENES.map((x) => x.name).join(", ") + ".";
        saveScene(sc.id);
        return "Saved what is on screen as " + sc.name + ".";
      }
      case "calculator": {
        if (!a.expression) return "What should it work out?";
        const f = await widgetFrame("calc");
        if (!f) return "Couldn't open the calculator.";
        try { f.contentWindow.postMessage({ type: "y70:calc", expr: String(a.expression) }, "*"); } catch (e) {}
        return "It's on the calculator.";
      }
      case "pin":
      case "unpin": {
        const f = await widgetFrame("pin");
        if (!f) return "Couldn't open the pin widget.";
        const r = await frameAsk(f, a.action === "pin" ? { type: "y70:pin-use", match: a.window || a.name || a.app } : { type: "y70:pin-release" }, "y70:pin-done");
        if (!r) return "The pin widget didn't answer.";
        if (!r.ok) return r.error;
        return a.action === "pin" ? "Holding " + (r.process || "") + " (" + r.title + ") in the pin widget." : "Let it go.";
      }
      default: return "Unknown layout action " + a.action + ".";
    }
  }

  // ------------------------------------------------------------- YouTube ----
  function ytId(s) {
    const t = String(s || "").trim();
    const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || t.match(/^([\w-]{11})$/);
    return m ? m[1] : null;
  }
  // Loads a page into the YouTube app's own view (made now if need be).
  function ytLoad(url) {
    const existed = !!document.getElementById("app-youtube");
    if (!existed) {
      const src = APPS.youtube.src;
      APPS.youtube.src = src + "&url=" + encodeURIComponent(url);
      appFrame("youtube");
      APPS.youtube.src = src;
      return;
    }
    try { document.getElementById("app-youtube").contentWindow.postMessage({ type: "y70:web-open", url }, "*"); } catch (e) {}
  }
  async function youtubeTool(a) {
    const yt = () => document.getElementById("app-youtube");
    switch (a.action) {
      case "play": {
        let id = ytId(a.url) || ytId(a.query), title = null, info = "";
        if (!id) {
          if (!a.query) return "What should I play?";
          const r = await fetch(API + "youtube?q=" + encodeURIComponent(a.query)).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
          if (!r.ok) return "Couldn't search YouTube: " + r.error;
          const v = r.results[0];
          id = v.id; title = v.title;
          info = " by " + v.channel + (v.length ? " (" + v.length + ")" : "");
          J.cards.push({ kind: "results", query: a.query, items: r.results.slice(0, 4).map((x) => ({ title: x.title, url: x.url, snippet: [x.channel, x.length, x.views].filter(Boolean).join(" · "), image: x.image })) });
        }
        const view = a.view || "full";
        closeCard();
        ytLoad("https://m.youtube.com/watch?v=" + id);
        if (view === "full") setFocus("youtube", { video: true });
        else if (view === "app") setFocus("youtube");
        else if (view === "panel") { dockApp("youtube", { h: Math.round(window.innerWidth * 9 / 16) + 30 }); sendTheater("youtube", true); }
        else setApp("youtube");
        const where = { full: "just the video, full screen (Exit in the top bar, or ask)", app: "the YouTube page, full screen", panel: "just the video, in a panel", normal: "in the main area" }[view] || view;
        return "Playing " + (title ? "\"" + title + "\"" + info : "that video") + ": " + where + "." + (native ? "" : " (Videos only play in the installed app, not a browser.)");
      }
      case "search": {
        if (!a.query) return "Search for what?";
        closeCard();
        ytLoad("https://m.youtube.com/results?search_query=" + encodeURIComponent(a.query));
        if (!(focus && focus.app === "youtube")) setApp("youtube");
        return "YouTube's results for " + a.query + " are on the panel.";
      }
      case "pause":
      case "resume": {
        if (!yt()) return "YouTube isn't open.";
        try { yt().contentWindow.postMessage({ type: "y70:web-media", what: a.action === "pause" ? "pause" : "play" }, "*"); } catch (e) {}
        return a.action === "pause" ? "Paused." : "Playing.";
      }
      case "exit":
        return clearFocus() ? "Out of full screen. " + describeScreen() : "Nothing was full screen.";
      default: return "Unknown youtube action " + a.action + ".";
    }
  }

  async function musicTool(a) {
    const media = (action) => fetch("/api/system", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "media.command", args: { action } }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    switch (a.action) {
      case "play": {
        if (!a.query) { const r = await media("play"); return r.ok ? "Resumed." : "Couldn't resume: " + r.error; }
        const r = await spotifyCmd({ action: "search_play", query: a.query, kind: a.kind || "" });
        return r.text || (r.ok ? "Playing." : "Couldn't play that.");
      }
      case "resume": { const r = await media("play"); return r.ok ? "Resumed." : "Nothing to resume (" + r.error + ")."; }
      case "pause": { const r = await media("pause"); return r.ok ? "Paused." : "Nothing is playing (" + r.error + ")."; }
      case "next": { const r = await media("next"); return r.ok ? "Skipped." : "Couldn't skip (" + r.error + ")."; }
      case "previous": { const r = await media("prev"); return r.ok ? "Went back." : "Couldn't go back (" + r.error + ")."; }
      case "now_playing": {
        const s = await fetch("/api/system").then((r) => r.json()).catch(() => ({}));
        const m = s.media;
        if (!m || !m.title) return "Nothing is playing.";
        return JSON.stringify({ title: m.title, artist: m.artist, album: m.album, playing: m.playing, app: m.app || m.source });
      }
      default: return "Unknown music action.";
    }
  }

  // ---------------------------------------------------------- web window ---
  // Pages open in the panel's Web app: a native view, like YouTube's. The
  // island card closes so the page is not hidden behind it.
  const GB = 1024 * 1024 * 1024;
  function webFrame(url) {
    const existed = !!document.getElementById("app-web");
    if (!existed) {
      // A new frame starts on the page itself.
      const src = APPS.web.src;
      APPS.web.src = src + "&url=" + encodeURIComponent(url);
      appFrame("web");
      APPS.web.src = src;
    }
    const f = document.getElementById("app-web");
    closeCard();
    setApp("web");
    if (existed) { try { f.contentWindow.postMessage({ type: "y70:web-open", url }, "*"); } catch (e) {} }
    return { frame: f, fresh: !existed };
  }
  function openWeb(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) return false;
    webFrame(url);
    return true;
  }

  // Shows a page with a question above it ("Download this?") and resolves with
  // the answer: true, false, or null when nobody answers in time.
  let pendingOffer = null;
  function webOffer(url, info, timeoutMs) {
    if (pendingOffer) pendingOffer.cancel();
    return new Promise((resolve) => {
      const { frame, fresh } = webFrame(url);
      const id = "o" + Date.now();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        pendingOffer = null;
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        try { frame.contentWindow.postMessage({ type: "y70:web-offer-clear", id }, "*"); } catch (e) {}
        resolve(v);
      };
      const onMsg = (e) => { const d = e.data; if (d && d.type === "y70:web-offer-reply" && d.id === id) finish(!!d.accepted); };
      window.addEventListener("message", onMsg);
      const send = () => { try { frame.contentWindow.postMessage({ type: "y70:web-offer", id, ...info }, "*"); } catch (e) {} };
      if (fresh) frame.addEventListener("load", () => setTimeout(send, 300), { once: true }); else send();
      const timer = setTimeout(() => finish(null), timeoutMs || 180000);
      pendingOffer = { cancel: () => finish(false) };
    });
  }

  // "Jarvis, download …": shows the model's page with the file, its size and
  // where it goes, and starts nothing until the Download button is tapped.
  async function downloadTool(a) {
    const req = { repo: a.repo, file: a.file, url: a.url };
    const p = await post("models/plan", req);
    if (!p.ok) return "Can't download that: " + (p.error || "unknown error") + ".";
    const gb = (p.total / GB).toFixed(2);
    const fits = p.total && p.total <= 14.8 * GB;
    J.status = "Waiting for you to confirm the download";
    renderIsland();
    const yes = await webOffer(p.page, {
      title: "Download " + p.name + "?",
      detail: (p.total ? gb + " GB" : "Unknown size") + " from " + p.source +
        (p.files.length > 1 ? ", in " + p.files.length + " parts" : "") + ", into " + p.dir + ". " +
        (!p.total ? "" : fits ? "It fits the GPU." : "It is bigger than the GPU's 16 GB, so part of it would run on the CPU, slowly."),
      accept: "Download" + (p.total ? " " + gb + " GB" : ""),
      decline: "Not now",
    });
    J.status = "";
    if (yes === null) return "Nothing was downloaded: the user did not answer.";
    if (!yes) return "Nothing was downloaded: the user said not now.";
    const r = await post("models/download", req);
    if (!r.ok) return "The download did not start: " + r.error;
    if (r.already) return p.name + " is already in the models folder.";
    J.downloads = (J.downloads || []).filter((d) => d.id !== r.id).concat([r]);
    renderIsland();
    return "Downloading " + p.name + " (" + gb + " GB) in a window on the main screen. When it finishes it is added to the local model list; the local server needs a restart to load it.";
  }

  // A Download button on a card is the tap itself, so it starts straight away.
  async function startDownload(repo, file, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    const r = await post("models/download", { repo, file });
    if (btn) btn.textContent = r.ok ? (r.already ? "Already have it" : "Downloading…") : "Failed";
    if (!r.ok) { J.note = "Couldn't start the download: " + r.error; renderJarvis(); return; }
    J.downloads = (J.downloads || []).filter((d) => d.id !== r.id).concat([r]);
    renderIsland();
  }

  // Asks the Spotify app (which holds the sign-in) to search and play.
  function spotifyCmd(msg) {
    return new Promise((resolve) => {
      const id = "j" + Date.now() + Math.random().toString(36).slice(2, 6);
      const existed = !!document.getElementById("app-spotify");
      const f = appFrame("spotify");
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(r);
      };
      const onMsg = (e) => { if (e.data && e.data.type === "y70:cmd-reply" && e.data.id === id) finish(e.data); };
      window.addEventListener("message", onMsg);
      const send = () => { try { f.contentWindow.postMessage({ type: "y70:cmd", id, ...msg }, "*"); } catch (e) {} };
      // A frame made just now has to load and sign in before it can answer.
      if (existed) send(); else f.addEventListener("load", () => setTimeout(send, 2500), { once: true });
      setTimeout(() => finish({ ok: false, text: "Spotify didn't answer. Is it signed in?" }), existed ? 9000 : 16000);
    });
  }

  // -------------------------------------------------------------- events ----
  let es = null;
  function connect() {
    try { es && es.close(); } catch (e) {}
    es = new EventSource(API + "events");
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      onEvent(ev);
    };
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "hello":
      case "status":
        JST = ev.status;
        if (JST && JST.downloads) { J.downloads = JST.downloads; renderIsland(); }
        renderJarvisSub();
        if (jarvisViewOpen()) renderForm();
        return;
      case "settings":
        JS = ev.settings;
        return;
      case "wake":
        audio();
        // A screensaver (ours or Windows') may be over the panel: come back
        // above it, without waking the main monitor.
        if (native && native.raise) native.raise().catch(() => {});
        if (ring) { stopRing(ring.kind === "alarm"); return; }      // "Jarvis" silences a ringing alarm (snoozes it)
        if (J.mode === "speaking") speech.reset();
        // "Jarvis, what's the weather" in one breath: keep listening for the
        // pause setting, so "...and set a timer" joins it rather than being lost.
        if (ev.tail && ev.tail.split(/\s+/).length >= 2) { chime.listen(); continueListening(ev.tail); }
        else startListening();
        return;
      case "listening":
        if (J.mode !== "listening") setMode("listening");
        // Only worth saying when it is not the recognizer that was asked for.
        J.status = ev.engine === "offline" && JST && JST.voice && JST.voice.stt === "online" ? "Offline recognition" : "";
        renderJarvis();
        return;
      case "partial":
        if (J.mode !== "listening") return;
        J.heard = J.prefix ? J.prefix + " " + ev.text : ev.text;
        renderJarvis();
        return;
      case "level":
        if (J.mode === "listening") document.documentElement.style.setProperty("--jv-level", (1 + Math.min(0.6, ev.v / 120)).toFixed(3));
        return;
      case "final":
        if (J.mode !== "listening") return;
        J.prefix = null;
        if (ev.text && ev.text.trim()) ask(ev.text.trim());
        else {
          J.heard = "";
          J.status = ev.reason === "cancelled" ? "" : "I didn’t catch that.";
          setMode("idle");
          scheduleClose(3000);
        }
        return;
      // "Stop" / "that's enough" while he talks.
      case "stop":
        if (J.mode === "speaking") speech.stop();
        else if (J.mode === "thinking") { if (J.ctl) J.ctl.abort(); J.ctl = null; setMode("idle"); scheduleClose(1500); }
        return;
      // Talking over him (talk-over on): he stops and listens.
      case "barge":
        if (J.mode !== "speaking") return;
        speech.reset();
        startListening(true);
        return;
      case "transcribing":
        if (J.mode === "listening") { J.status = "Transcribing…"; renderJarvis(); }
        return;
      case "online-unavailable":
        J.note = "Windows has online speech recognition switched off (Settings › Privacy & security › Speech), so this used the offline recognizer.";
        renderJarvis();
        return;
      case "game":
        if (JST) JST.game = { on: ev.on, exe: ev.exe };
        if (jarvisViewOpen()) renderForm();
        return;
      case "memory":
        if (jarvisViewOpen()) loadFacts();
        return;
      case "downloads":
        J.downloads = ev.downloads || [];
        renderIsland();
        renderDownloadsBox();
        return;
      case "downloaded": {
        if (ev.status) { JST = ev.status; J.downloads = ev.status.downloads || J.downloads; }
        const r = ev.result || {};
        J.note = r.ok
          ? "A new model is ready: " + r.id + ". Restart the local server (Jarvis settings) to load it."
          : "A download finished but could not be added: " + (r.error || "unknown error") + ".";
        chime.done();
        openCard();
        renderAll();
        scheduleClose(15000);
        if (jarvisViewOpen()) renderForm();
        return;
      }
      default: return;
    }
  }

  // ----------------------------------------------------------- the button ---
  function wireButton() {
    const btn = $("#jv-btn");
    let pressT = 0, longTimer = null, long = false;
    // Kept off the top bar's own drag/tap handling.
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      pressT = Date.now(); long = false;
      longTimer = setTimeout(() => { long = true; setTyping(true); }, 550);
    });
    btn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      clearTimeout(longTimer);
      if (long) return;
      audio();
      if (J.mode === "listening") { post("cancel"); setMode("idle"); scheduleClose(800); return; }
      if (J.mode === "speaking") { speech.stop(); return; }
      if (J.mode === "thinking") { if (J.ctl) J.ctl.abort(); J.ctl = null; setMode("idle"); return; }
      startListening();
    });
    const isl = $("#island");
    isl.addEventListener("pointerdown", (e) => e.stopPropagation());
    isl.addEventListener("pointerup", (e) => { e.stopPropagation(); cardOpen ? closeCard() : openCard(); });
    $("#island-backdrop").addEventListener("pointerup", () => {
      if (ring) return;                        // a ringing alarm needs an answer
      if (J.mode === "listening") post("cancel");
      closeCard();
    });
    // Touching the card holds it open.
    $("#island-card").addEventListener("pointerdown", () => clearTimeout(closeTimer));
  }

  // Long-press on the status bar's clock opens the island too: a second way in
  // when nothing is running and the pill is hidden.
  function wireClock() {
    const c = $("#sb-clock");
    c.addEventListener("pointerdown", (e) => e.stopPropagation());
    c.addEventListener("pointerup", (e) => { e.stopPropagation(); cardOpen ? closeCard() : openCard(); });
  }

  // ========================================================= SETTINGS ======
  const jarvisViewOpen = () => !$("#jarvis-view").classList.contains("hidden");
  function showJarvisView(on) {
    $("#jarvis-view").classList.toggle("hidden", !on);
    $(".drawer-inner").classList.toggle("hidden", on);
    if (on) { refreshSettings(); loadFacts(); }
    micPolling(on);
  }
  // The memory as the server reports it: the shared graph (entities with their
  // observations) or, without one, Jarvis's own list of facts.
  let memo = { mode: "local", facts: [] };
  async function loadFacts() {
    const r = await fetch(API + "memory").then((x) => x.json()).catch(() => null);
    if (r && r.ok) memo = r;
    if (jarvisViewOpen()) renderForm();
  }
  async function refreshSettings() {
    const r = await fetch(API + "settings").then((x) => x.json()).catch(() => null);
    if (r && r.ok) { JS = r.settings; JST = r.status; }
    renderJarvisSub();
    if (jarvisViewOpen()) renderForm();
  }
  let saveHintT = 0;
  async function saveSetting(patch) {
    const r = await post("settings", patch);
    if (r.ok) { JS = r.settings; JST = r.status; }
    const hint = $("#jarvis-saved");
    hint.textContent = r.ok ? "saved" : (r.error || "couldn't save");
    clearTimeout(saveHintT);
    saveHintT = setTimeout(() => { hint.textContent = ""; }, 1800);
    renderForm();
    renderJarvisSub();
  }
  function renderJarvisSub() {
    const sub = $("#jarvis-sub");
    if (!sub || !JS) return;
    const brain = JS.provider === "auto" ? "auto" : JS.provider === "claude" ? "Claude" : "local";
    sub.textContent = brain + (JS.wake ? " · “" + JS.wakePhrase + "”" : "");
  }

  // Inputs on the panel need the keyboard borrowed while they are focused.
  function kbInput(inp) {
    inp.addEventListener("focus", () => relayKeyboardRequest(true));
    inp.addEventListener("blur", () => relayKeyboardRequest(false));
    inp.addEventListener("keydown", () => { if (native && native.keyboardTouch) native.keyboardTouch(); });
    return inp;
  }
  function chips(options, current, onPick) {
    const row = el("div", "jf-row");
    for (const [value, label] of options) {
      const b = el("button", "btn btn--ghost btn--chip" + (value === current ? " is-on" : ""), label);
      b.addEventListener("pointerup", () => onPick(value));
      row.appendChild(b);
    }
    return row;
  }
  function toggle(label, hint, on, onChange) {
    const l = el("label", "set-toggle");
    const s = el("span", null, label);
    if (hint) s.appendChild(el("span", "set-hint", hint));
    const c = el("input");
    c.type = "checkbox"; c.checked = !!on;
    c.addEventListener("change", () => onChange(c.checked));
    l.append(s, c);
    return l;
  }
  function label(text, hint) {
    const d = el("div", "set-label", text);
    if (hint) d.appendChild(el("span", "set-hint", hint));
    return d;
  }
  function status(text, cls) { return el("div", "jf-status" + (cls ? " " + cls : ""), text); }
  function textRow(value, placeholder, buttonText, onSave, type) {
    const row = el("div", "jf-row");
    const inp = kbInput(el("input", "ui-input"));
    inp.value = value || ""; inp.placeholder = placeholder || ""; if (type) inp.type = type;
    const b = el("button", "btn btn--ghost btn--sm", buttonText || "Save");
    b.addEventListener("pointerup", () => onSave(inp.value.trim(), inp));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") onSave(inp.value.trim(), inp); });
    row.append(inp, b);
    return row;
  }

  let formFocusGuard = false;
  function renderForm() {
    const f = $("#jarvis-form");
    if (!f || !JS) return;
    // Never rebuild under a field being typed in.
    if (f.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) { formFocusGuard = true; return; }
    formFocusGuard = false;
    const scroll = f.scrollTop;
    f.innerHTML = "";
    const st = JST || {};
    const local = st.local || {};
    const vo = st.voice || {};

    // ---- Brain
    f.appendChild(label("Brain", "who answers"));
    f.appendChild(chips([["auto", "Auto"], ["claude", "Claude"], ["local", "Local"]], JS.provider, (v) => saveSetting({ provider: v })));
    const brainNote = JS.provider === "auto"
      ? "Auto uses the local model when it is running, and Claude when it is not."
      : JS.provider === "claude" ? "Every question goes to Claude." : "Every question goes to the local model.";
    f.appendChild(status(brainNote));

    // ---- Claude
    f.appendChild(label("Claude"));
    f.appendChild(chips([["claude-haiku-4-5", "Haiku 4.5 · fast"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-opus-5-5", "Opus 5.5"]],
      JS.claudeModel, (v) => saveSetting({ claudeModel: v })));
    if (!st.sdk) f.appendChild(status("The Anthropic SDK is missing from this build.", "bad"));
    if (st.hasKey) {
      const row = el("div", "jf-row");
      row.appendChild(status("API key saved. It is never shown again.", "good"));
      const rm = el("button", "btn btn--ghost btn--sm", "Remove key");
      rm.addEventListener("pointerup", async () => { const r = await post("key", { clear: true }); if (r.status) JST = r.status; renderForm(); });
      row.appendChild(rm);
      f.appendChild(row);
    } else {
      f.appendChild(textRow("", "Paste an Anthropic API key (sk-ant-…)", "Save key", async (v, inp) => {
        const r = await post("key", { key: v });
        if (r.ok) { inp.value = ""; inp.blur(); JST = r.status; renderForm(); }
        else { f.querySelector(".jf-keyerr") && f.querySelector(".jf-keyerr").remove(); const s = status(r.error, "bad jf-keyerr"); inp.parentNode.after(s); }
      }, "password"));
      f.appendChild(status("Get one at console.anthropic.com. It is stored in this PC's data folder and never sent anywhere but Anthropic."));
    }

    // ---- Local model
    // Every model in jarvis-models.ini: the 27B, 9B and 4B, and whatever
    // Jarvis has downloaded since.
    f.appendChild(label("Local model", "llama.cpp, jarvis-llm.bat"));
    const lm = local.models && local.models.length ? local.models
      : [{ id: "jarvis-27b" }, { id: "jarvis-9b" }, { id: "jarvis-4b" }];
    const NICE = { "jarvis-27b": "Qwen3.8 27B · smartest", "jarvis-9b": "Qwen3.5 9B · smarter", "jarvis-4b": "Qwen3.5 4B · lighter" };
    f.appendChild(chips(lm.map((m) => [m.id, (NICE[m.id] || m.id) + (m.loaded ? " · loaded" : "") + (local.up && m.served === false ? " · restart to load" : "")]),
      JS.localModel, (v) => saveSetting({ localModel: v })));
    if (local.up && local.needsRestart) {
      const rr = el("div", "jf-row");
      rr.appendChild(status("New models were added since the local server started. Restart it to load them.", "warn"));
      const rb = el("button", "btn btn--primary btn--sm", "Restart local server");
      rb.addEventListener("pointerup", async () => { rb.disabled = true; const r = await post("local", { action: "restart" }); if (r.status) JST = r.status; setTimeout(refreshSettings, 5000); });
      rr.appendChild(rb);
      f.appendChild(rr);
    }
    f.appendChild(toggle("Use the 4B while gaming", "a game in front swaps to the 4B and frees the 9B's VRAM", JS.autoGameModel, (v) => saveSetting({ autoGameModel: v })));
    if (JS.autoGameModel && st.game) f.appendChild(status(st.game.on ? "Game in front now (" + (st.game.exe || "fullscreen") + ") — using the 4B." : "No game in front.", st.game.on ? "warn" : ""));
    f.appendChild(status(local.up
      ? "Running" + (local.loaded ? " · " + local.loaded + " loaded" : " · no model loaded yet (loads on the first question)") + " · next answer uses " + local.model
      : "Not running.", local.up ? "good" : "warn"));
    const lr = el("div", "jf-row");
    for (const [act, text] of [["start", "Start"], ["stop", "Stop"], ["edit", "Edit bat"]]) {
      const b = el("button", "btn btn--ghost btn--sm", text);
      b.addEventListener("pointerup", async () => {
        b.disabled = true;
        const r = await post("local", { action: act });
        if (r.status) JST = r.status;
        if (!r.ok) { const s = status(r.error, "bad"); lr.after(s); setTimeout(() => s.remove(), 6000); }
        b.disabled = false;
        if (act === "start") setTimeout(refreshSettings, 4000);
        renderForm();
      });
      lr.appendChild(b);
    }
    f.appendChild(lr);
    f.appendChild(textRow(JS.localBat, "Path to jarvis-llm.bat", "Save", (v) => saveSetting({ localBat: v })));

    // ---- Getting more models
    f.appendChild(label("Get a model", "Hugging Face, or say “Jarvis, download…”"));
    f.appendChild(textRow("", "Search, e.g. qwen 3.5 27b, or paste a link", "Find", async (v, inp) => {
      if (!v) return;
      const box = document.getElementById("jf-found");
      box.textContent = "Searching…";
      const r = await post("models/find", { query: v });
      box.innerHTML = "";
      if (!r.ok) { box.appendChild(status(r.error || "nothing found", "bad")); return; }
      box.appendChild(cardNode({ kind: "models", query: r.query, items: r.results }));
      inp.blur();
    }));
    const found = el("div", "jf-found");
    found.id = "jf-found";
    f.appendChild(found);
    const dlb = el("div", "jf-downloads");
    dlb.id = "jf-downloads";
    f.appendChild(dlb);
    renderDownloadsBox();

    // ---- Listening
    f.appendChild(label("Listening"));
    f.appendChild(toggle("Wake word “" + JS.wakePhrase + "”", "listens offline for the name; nothing leaves the PC until you ask something", JS.wake, (v) => saveSetting({ wake: v })));
    const sens = el("div", "jf-slider");
    sens.appendChild(el("span", null, "Fewer false wakes"));
    const r1 = el("input", "ui-range");
    r1.type = "range"; r1.min = "0.1"; r1.max = "0.9"; r1.step = "0.05"; r1.value = JS.sensitivity;
    r1.addEventListener("change", () => saveSetting({ sensitivity: Number(r1.value) }));
    sens.appendChild(r1);
    sens.appendChild(el("span", null, "Hears it more easily"));
    f.appendChild(sens);
    // How long a pause means "finished". Short answers faster; long lets you
    // ask several things, sentence after sentence.
    const es = Number(JS.endSilence) || 1.5;
    const esHint = el("div", "set-hint", "");
    const paintEs = (v) => { esHint.textContent = "Wait before answering: " + v.toFixed(2).replace(/0$/, "") + " s of quiet after you stop talking" + (v >= 2 ? " · room for several sentences" : v <= 0.75 ? " · snappy, one sentence" : ""); };
    paintEs(es);
    f.appendChild(esHint);
    const wait = el("div", "jf-slider");
    wait.appendChild(el("span", null, "Answer sooner"));
    const esRange = el("input", "ui-range");
    esRange.type = "range"; esRange.min = "0.5"; esRange.max = "4"; esRange.step = "0.25"; esRange.value = es;
    esRange.addEventListener("input", () => paintEs(Number(esRange.value)));
    esRange.addEventListener("change", () => saveSetting({ endSilence: Number(esRange.value) }));
    wait.appendChild(esRange);
    wait.appendChild(el("span", null, "Let me keep talking"));
    f.appendChild(wait);
    // Who turns your words into text. The wake word is always Windows', offline.
    const wh = st.whisper || {};
    const curStt = JS.stt || (JS.onlineSpeech ? "online" : "offline");
    f.appendChild(el("div", "set-hint", "Recognising requests"));
    f.appendChild(chips([
      ["whisper", "Whisper · local, best"], ["online", "Windows online"], ["offline", "Windows offline"],
    ], curStt, (v) => saveSetting({ stt: v })));
    if (curStt === "whisper") {
      f.appendChild(status(!wh.installed
        ? "Whisper isn't installed: set the folder holding Release\\whisper-server.exe and a ggml model."
        : (wh.running ? "Running" : "Starts with the first request") + " · " + wh.model + (JS.whisperGpu ? " on the GPU" : " on the CPU") + (wh.error ? " · " + wh.error : ""),
        !wh.installed || wh.error ? "warn" : "good"));
      f.appendChild(toggle("Whisper on the GPU", "about 0.1 s a request and ~600 MB of VRAM; off = CPU, slower, no VRAM", JS.whisperGpu !== false, (v) => saveSetting({ whisperGpu: v })));
      f.appendChild(textRow(JS.whisperDir, "Folder with whisper.cpp (Release\\whisper-server.exe)", "Save", (v) => saveSetting({ whisperDir: v })));
    } else if (curStt === "online") {
      f.appendChild(status("Windows' online recognizer (the one Win+H uses) needs Settings › Privacy & security › Speech › Online speech recognition on.", vo.onlineBlocked ? "warn" : ""));
    } else {
      f.appendChild(status("Everything stays on this PC, but it mishears a lot. Whisper is far better and also local."));
    }

    // Cutting him off.
    f.appendChild(el("div", "set-hint", "Interrupting"));
    f.appendChild(toggle("Interrupt by voice", "while he talks, “" + JS.wakePhrase + "…” starts a new request and “stop” or “that's enough” ends the answer", JS.stopWords !== false, (v) => saveSetting({ stopWords: v })));
    f.appendChild(toggle("Interrupt by just talking", "any speech that isn't him stops him and he listens; best with headphones, since his own voice through speakers can trip it", !!JS.bargeIn, (v) => saveSetting({ bargeIn: v })));
    f.appendChild(status("Tapping the orb always stops him too."));
    if (vo.error) f.appendChild(status("Voice helper: " + vo.error, "bad"));

    // ---- Microphone
    // Windows' online recognizer can only use the default recording device, so
    // that is what Jarvis hears. Show which one it is, whether anything is
    // coming in, and make switching one tap. (Seen on this PC: the default was
    // a Voicemeeter bus while Voicemeeter was closed — silence.)
    f.appendChild(label("Microphone", "Jarvis hears Windows' default input"));
    const mics = el("div", "jf-mics");
    mics.id = "jf-mics";
    f.appendChild(mics);
    f.appendChild(status("Changing it changes Windows' default input, which other apps on “Default” (Discord) follow too."));
    renderMics();

    // ---- Voice
    f.appendChild(label("Voice"));
    f.appendChild(toggle("Speak replies", null, JS.speak, (v) => saveSetting({ speak: v })));
    const tts = st.tts || {};
    const curTts = JS.tts || (tts.installed ? "kokoro" : "windows");
    f.appendChild(chips([["kokoro", "Kokoro · natural"], ["windows", "Windows voices"]], curTts, (v) => saveSetting({ tts: v })));
    if (curTts === "kokoro") {
      if (!tts.installed) {
        f.appendChild(status("Kokoro isn't installed: set the folder with kokoro-v1.0.onnx and voices-v1.0.bin (and pip install kokoro-onnx).", "warn"));
      } else if (tts.error) {
        f.appendChild(status("Kokoro: " + tts.error + " — using a Windows voice meanwhile.", "warn"));
      }
      // English voices, British first. a = American, b = British; f/m.
      const KIND = { bm: "British man", bf: "British woman", am: "American man", af: "American woman" };
      const kv = (tts.voices || []).filter((v) => /^[ab][fm]_/.test(v))
        .sort((x, y) => "bm bf am af".indexOf(x.slice(0, 2)) - "bm bf am af".indexOf(y.slice(0, 2)) || x.localeCompare(y));
      if (kv.length) {
        f.appendChild(chips(kv.map((v) => [v, v.slice(3).charAt(0).toUpperCase() + v.slice(4) + " · " + KIND[v.slice(0, 2)]]),
          JS.kokoroVoice, (v) => saveSetting({ kokoroVoice: v })));
      } else if (tts.installed) {
        f.appendChild(status(tts.running ? "Loading voices…" : "Kokoro loads with the first answer (about 3 s).", ""));
      }
      f.appendChild(textRow(JS.kokoroDir, "Kokoro folder (kokoro-v1.0.onnx, voices-v1.0.bin)", "Save", (v) => saveSetting({ kokoroDir: v })));
    } else {
      const voices = (vo.voices || []).filter((v) => /^en/i.test(v.lang));
      if (voices.length) f.appendChild(chips(voices.map((v) => [v.name, v.name.replace(/^Microsoft /, "") + " · " + v.lang]), JS.voice, (v) => saveSetting({ voice: v })));
    }
    const rate = el("div", "jf-slider");
    rate.appendChild(el("span", null, "Slower"));
    const r2 = el("input", "ui-range");
    r2.type = "range"; r2.min = "0.7"; r2.max = "1.6"; r2.step = "0.05"; r2.value = JS.rate;
    r2.addEventListener("change", () => saveSetting({ rate: Number(r2.value) }));
    rate.appendChild(r2);
    rate.appendChild(el("span", null, "Faster"));
    f.appendChild(rate);
    const test = el("button", "btn btn--ghost btn--sm", "Test voice");
    test.addEventListener("pointerup", () => {
      speech.reset();
      const saved = J.reply;
      J.reply = "";
      speech.feed("Good evening" + (JS.addressAs ? ", " + JS.addressAs : JS.name ? ", " + JS.name : "") + ". All systems are online.");
      speech.end();
      J.reply = saved;
    });
    f.appendChild(el("div", "jf-row")).appendChild(test);
    f.appendChild(status(curTts === "kokoro"
      ? "Kokoro runs on the CPU, so it takes no VRAM from games or the local models. George, Lewis, Daniel and Fable suit a Jarvis."
      : "More voices: Windows Settings › Time & language › Speech › Add voices (an en-GB voice suits a Jarvis)."));

    // ---- Lights (Govee: LAN API straight to the light, or Govee's cloud)
    const li = st.lights || { devices: [] };
    f.appendChild(label("Lights", "Govee · say “Jarvis, lights purple”"));
    if (!li.devices.length) {
      f.appendChild(status(li.desktop ? "Govee Desktop lists no lights." : "No Govee lights found. Govee Desktop's device list is where Jarvis learns their names.", "warn"));
    }
    const route = (d) => d.lan === "yes" ? "LAN · " + d.ip
      : li.hasKey && d.cloud ? "Govee cloud" + (d.lan === "no" ? " (no LAN)" : "")
      : d.lan === "no" ? "Wi-Fi only · needs the key below"
      : d.ip ? "found at " + d.ip : "not found yet";
    for (const d of li.devices) {
      const row = el("div", "jf-mic");
      row.appendChild(el("span", "nm", d.name + " · " + d.sku));
      row.appendChild(el("span", "badge", route(d)));
      for (const [act, txt] of [["on", "On"], ["off", "Off"]]) {
        const b = el("button", "btn btn--ghost btn--sm", txt);
        b.addEventListener("pointerup", async () => {
          b.disabled = true;
          const r = await post("lights", { action: act, device: d.name });
          b.disabled = false;
          const first = (r.results || [])[0];
          const s = status(first ? (first.ok ? txt + " ✓ (" + first.via + ")" : first.error) : (r.error || "?"), first && first.ok ? "good" : "bad");
          row.after(s);
          setTimeout(() => s.remove(), 5000);
          if (r.lights && JST) { JST.lights = r.lights; }
        });
        row.appendChild(b);
      }
      f.appendChild(row);
    }
    const lr2 = el("div", "jf-row");
    const scanB = el("button", "btn btn--ghost btn--sm", "Look for lights");
    scanB.addEventListener("pointerup", async () => {
      scanB.disabled = true; scanB.textContent = "Looking…";
      const r = await post("lights", { action: "scan" });
      if (r.lights && JST) JST.lights = r.lights;
      renderForm();
    });
    lr2.appendChild(scanB);
    f.appendChild(lr2);
    f.appendChild(status("Lights with LAN Control get commands straight over your network. Wi-Fi-only lights (no LAN Control) go through Govee's cloud, which needs a Govee API key. Govee Desktop keeps working alongside."));
    if (li.hasKey) {
      const kr = el("div", "jf-row");
      kr.appendChild(status("Govee API key saved: Wi-Fi-only lights and scenes work.", "good"));
      const rm = el("button", "btn btn--ghost btn--sm", "Remove key");
      rm.addEventListener("pointerup", async () => { const r = await post("lights/key", { clear: true }); if (r.lights && JST) JST.lights = r.lights; renderForm(); });
      kr.appendChild(rm);
      f.appendChild(kr);
    } else {
      const needs = li.devices.some((d) => d.lan !== "yes");
      f.appendChild(textRow("", needs ? "Govee API key" : "Optional: Govee API key, for scenes", "Save key", async (v, inp) => {
        const r = await post("lights/key", { key: v });   // the server checks it with Govee first
        if (r.ok) { inp.value = ""; inp.blur(); if (JST) JST.lights = r.lights; renderForm(); }
        else { const s = status(r.error, "bad"); inp.parentNode.after(s); setTimeout(() => s.remove(), 8000); }
      }, "password"));
      f.appendChild(status("Get one free in the Govee Home app: Profile › Settings (gear) › Apply for API Key. Govee emails it within minutes."
        + (needs ? "" : " Your lights all answer on LAN, so without it everything but scenes works.")));
    }

    // ---- About you
    f.appendChild(label("About you", "goes in every request"));
    f.appendChild(textRow(JS.name, "Your name", "Save", (v) => saveSetting({ name: v })));
    f.appendChild(textRow(JS.addressAs, "What Jarvis calls you (optional, e.g. sir)", "Save", (v) => saveSetting({ addressAs: v })));
    const ta = kbInput(el("textarea", "ui-input jf-area"));
    ta.value = JS.about || "";
    ta.placeholder = "Anything Jarvis should always know: your routine, your setup, how you like answers…";
    const taRow = el("div", "jf-row");
    const taSave = el("button", "btn btn--ghost btn--sm", "Save");
    taSave.addEventListener("pointerup", () => saveSetting({ about: ta.value }));
    f.appendChild(ta);
    taRow.appendChild(taSave);
    f.appendChild(taRow);
    f.appendChild(textRow(JS.home ? JS.home.name : "", "Home, for the weather (city, state)", "Set", async (v) => {
      const r = await post("home", { place: v });
      if (r.ok) { JS = r.settings; renderForm(); }
      else { const s = status(r.error, "bad"); f.appendChild(s); setTimeout(() => s.remove(), 5000); }
    }));

    // ---- Memory
    // One memory, shared with the web UI through the MCP memory server.
    if (memo.mode === "graph") {
      const n = (memo.entities || []).reduce((s, e) => s + e.observations.length, 0);
      f.appendChild(label("Memory", "shared · " + n + " facts about " + (memo.entities || []).length + " things"));
      f.appendChild(status(memo.server
        ? "Shared with your other assistant through the memory server (memory-server.bat)."
        : "The memory server isn't running, so Jarvis writes memory.json directly; the web UI sees it next time it reads.", memo.server ? "good" : "warn"));
      f.appendChild(textRow("", "Tell Jarvis something to remember", "Remember", async (v, inp) => {
        if (!v) return;
        await post("memory", { fact: v });
        inp.value = ""; inp.blur();
        loadFacts();
      }));
      const list = el("div", "jf-facts");
      const me = (memo.user || "").toLowerCase();
      const ents = (memo.entities || []).slice().sort((a, b) => (b.name.toLowerCase() === me) - (a.name.toLowerCase() === me));
      for (const e of ents) {
        list.appendChild(el("div", "jf-entity", e.name + (e.entityType ? " · " + e.entityType : "")));
        for (const o of e.observations) {
          const row = el("div", "jf-fact");
          row.appendChild(el("span", null, o));
          const x = el("button", "btn btn--quiet btn--sm btn--icon", "✕");
          x.addEventListener("pointerup", async () => { x.disabled = true; await post("memory", { forget: o, entity: e.name }); loadFacts(); });
          row.appendChild(x);
          list.appendChild(row);
        }
      }
      f.appendChild(list);
    } else {
      const facts = memo.facts || [];
      f.appendChild(label("Memory", facts.length ? facts.length + " remembered" : "say “remember that…”"));
      const list = el("div", "jf-facts");
      for (const fct of facts) {
        const row = el("div", "jf-fact");
        row.appendChild(el("span", null, fct.text));
        const x = el("button", "btn btn--quiet btn--sm btn--icon", "✕");
        x.addEventListener("pointerup", async () => { await post("memory", { forget: fct.id }); loadFacts(); });
        row.appendChild(x);
        list.appendChild(row);
      }
      f.appendChild(list);
    }
    f.appendChild(toggle("Share memory with the web UI", "uses the MCP memory server's memory.json", JS.useGraph, (v) => saveSetting({ useGraph: v })));
    if (JS.useGraph) f.appendChild(textRow(JS.graphFile, "Path to memory.json", "Save", (v) => saveSetting({ graphFile: v })));

    f.scrollTop = scroll;
  }

  // Model downloads in progress, updated in place from the "downloads" event.
  function renderDownloadsBox() {
    const box = document.getElementById("jf-downloads");
    if (!box) return;
    box.innerHTML = "";
    for (const d of J.downloads || []) {
      const row = el("div", "jf-fact");
      const pct = d.percent != null ? d.percent + "%" : d.haveGB + " GB";
      const what = d.error ? "failed: " + d.error : d.registered ? "installed" : d.done ? "checking…" : pct + " of " + d.totalGB + " GB";
      row.appendChild(el("span", null, "⬇ " + d.name + " · " + what));
      box.appendChild(row);
    }
  }

  // Input list with live meters. Rows are rebuilt only when the devices or the
  // default change; the meters update in place. The list element is looked up
  // AFTER the fetch, and remembers what it was built from itself: the form is
  // rebuilt while requests are in flight, and rows built into the element that
  // existed before the await went into a detached node (an empty list, found
  // the hard way).
  let micPoll = null, silentFor = 0, allMics = false;
  // Mixer buses and virtual cables, hidden unless one is the default (the same
  // filter the Audio widget uses).
  const VIRTUAL = /Voicemeeter|CABLE|Steam Streaming/i;
  async function renderMics() {
    if (!document.getElementById("jf-mics")) return;
    const s = await fetch("/api/system").then((r) => r.json()).catch(() => null);
    const box = document.getElementById("jf-mics");
    if (!box) return;
    const every = ((s && s.audio && s.audio.inputs) || []).slice().sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    const ins = allMics ? every : every.filter((d) => d.isDefault || !VIRTUAL.test(d.name));
    if (!ins.length) { box.textContent = s && s.warming ? "Reading devices…" : "No input devices found."; return; }
    const sig = (allMics ? "all:" : "") + ins.map((d) => d.id + (d.isDefault ? "*" : "")).join("|");
    if (sig !== box.dataset.sig) {
      box.dataset.sig = sig;
      silentFor = 0;
      box.innerHTML = "";
      for (const d of ins) {
        const row = el("div", "jf-mic" + (d.isDefault ? " is-default" : ""));
        row.dataset.id = d.id;
        row.appendChild(el("span", "nm", d.name.replace(/\s*\(VB-Audio[^)]*\)/, "")));
        const m = el("span", "jf-meter");
        m.appendChild(el("i"));
        row.appendChild(m);
        if (d.isDefault) row.appendChild(el("span", "badge", "Jarvis hears this"));
        else {
          const b = el("button", "btn btn--ghost btn--sm", "Use this");
          b.addEventListener("pointerup", async () => {
            b.disabled = true;
            await fetch("/api/system", { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cmd: "audio.setInput", args: { id: d.id } }) }).catch(() => {});
            setTimeout(renderMics, 600);
          });
          row.appendChild(b);
        }
        box.appendChild(row);
      }
      const hidden = every.length - ins.length;
      if (hidden > 0 || allMics) {
        const more = el("button", "btn btn--quiet btn--sm", allMics ? "Hide mixer buses and cables" : "Show all inputs (" + hidden + " more)");
        more.addEventListener("pointerup", () => { allMics = !allMics; renderMics(); });
        box.appendChild(more);
      }
      box.appendChild(el("div", "jf-status warn jf-silent")).hidden = true;
    }
    for (const d of ins) {
      const row = box.querySelector('.jf-mic[data-id="' + CSS.escape(d.id) + '"]');
      // Peak is linear; a square root makes speech-level input fill the bar.
      if (row) row.querySelector(".jf-meter i").style.width = Math.min(100, Math.sqrt(d.peak || 0) * 160).toFixed(0) + "%";
    }
    const def = ins.find((d) => d.isDefault);
    silentFor = def && !(def.peak > 0) ? silentFor + 1 : 0;
    const warn = box.querySelector(".jf-silent");
    if (warn) {
      warn.hidden = silentFor < 4;
      warn.textContent = def ? "Nothing is coming in on " + def.name + ". If that isn't your mic (or it is a mixer bus that isn't running), pick the one that moves when you talk." : "";
    }
  }
  function micPolling(on) {
    clearInterval(micPoll);
    micPoll = on ? setInterval(() => { if (jarvisViewOpen()) renderMics(); else micPolling(false); }, 800) : null;
  }

  function wireSettingsView() {
    $("#open-jarvis").addEventListener("pointerup", () => showJarvisView(true));
    $("#jarvis-back").addEventListener("pointerup", () => showJarvisView(false));
    $("#jarvis-close").addEventListener("pointerup", () => openDrawer(false));
    // The drawer closing always lands back on its main view.
    new MutationObserver(() => {
      if (!$("#drawer").classList.contains("open") && jarvisViewOpen()) showJarvisView(false);
    }).observe($("#drawer"), { attributes: true, attributeFilter: ["class"] });
    // A field that blocked a rebuild gets it once it lets go.
    $("#jarvis-form").addEventListener("focusout", () => setTimeout(() => { if (formFocusGuard) renderForm(); }, 50));
  }

  // ---------------------------------------------------------------- boot ----
  function boot() {
    wireButton();
    wireClock();
    wireSettingsView();
    renderClock();
    setInterval(renderClock, 15000);
    setInterval(tick, 1000);
    tick();
    refreshSettings();
    connect();
    // Timers set in the widget appear here at once.
    window.addEventListener("storage", (e) => {
      if (e.key === TKEY) { timersSig = ""; renderAll(); }
      if (e.key === AKEY) { renderAll(); renderClock(); }
    });
  }
  boot();
})();
