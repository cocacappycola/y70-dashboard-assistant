// ============================================================================
//  Y70 Dashboard shell — apps in a frame, pull-down drawer, bottom widgets.
// ============================================================================

const APPS = {
  spotify: { title: "Spotify", src: "/index.html", ico: "media-ico", glyph: "♫" },
  weather: { title: "Weather", src: "/weather-app.html", ico: "weather-ico", glyph: "☀" },
  youtube: { title: "YouTube", src: "/app-web.html?site=youtube", ico: "web-ico", glyph: "▶" },
  shorts: { title: "Shorts", src: "/app-web.html?site=shorts", ico: "web-ico", glyph: "⬛" },
  tiktok: { title: "TikTok", src: "/app-web.html?site=tiktok", ico: "web-ico", glyph: "♪" },
  snapchat: { title: "Snapchat", src: "/app-web.html?site=snapchat", ico: "web-ico", glyph: "👻" },
  // Any page Jarvis opens for you (a model's Hugging Face page, a link from a
  // search), in the same kind of native view as the apps above.
  web: { title: "Web", src: "/app-web.html?site=web", ico: "web-ico", glyph: "🌐" },
};
const WEB_APPS = /^(youtube|shorts|tiktok|snapchat|web)$/;

const WIDGETS = {
  claude: { title: "Claude", src: "/widget-claude.html", ico: "claude-ico", glyph: "✳" },
  weather: { title: "Weather", src: "/widget-weather.html", ico: "weather-ico", glyph: "☀" },
  pc: { title: "PC stats", src: "/widget-pc.html", ico: "pc-ico", glyph: "▣" },
  calc: { title: "Calculator", src: "/widget-calc.html", ico: "calc-ico", glyph: "÷" },
  media: { title: "Now playing", src: "/widget-media.html", ico: "media-ico", glyph: "▶" },
  lyrics: { title: "Lyrics", src: "/widget-lyrics.html", ico: "media-ico", glyph: "“”" },
  audio: { title: "Audio", src: "/widget-audio.html", ico: "tools-ico", glyph: "♪" },
  timer: { title: "Timer", src: "/widget-timer.html", ico: "tools-ico", glyph: "⏱" },
  notes: { title: "Notes", src: "/widget-notes.html", ico: "tools-ico", glyph: "✎" },
  discord: { title: "Discord", src: "/widget-discord.html", ico: "discord-ico", glyph: "◉" },
  face: { title: "Camera", src: "/widget-face.html", ico: "web-ico", glyph: "☺" },
  pin: { title: "Pinned window", src: "/widget-pin.html", ico: "web-ico", glyph: "⤱" },
};

// ---- Scenes ----------------------------------------------------------------
// A scene is a whole layout: which app is up front and which widgets are open,
// at what heights. These four ship with the app; each can be overwritten with
// whatever you have on screen, and reset back to this again.
const SCENES = [
  // Home is where "Jarvis, go home" and leaving a full-screen video come back
  // to. Packed as the first-run layout; save over it to make it yours.
  {
    id: "home", name: "Home", icon: "\u2302", app: "spotify",
    widgets: { claude: {} },
  },
  {
    id: "working", name: "Working", icon: "\u2328", app: "spotify",
    widgets: { pc: { h: 330 }, notes: { h: 260 }, timer: { h: 190 } },
  },
  {
    id: "gaming", name: "Gaming", icon: "\u{1F3AE}", app: "spotify",
    widgets: { discord: { h: 300 }, audio: { h: 290 }, pc: { h: 240 } },
  },
  {
    id: "music", name: "Music", icon: "\u266b", app: "spotify",
    widgets: { lyrics: { h: 430 }, media: { h: 170 }, audio: { h: 250 } },
  },
  {
    id: "idle", name: "Idle", icon: "\u{1F319}", app: "weather",
    widgets: { weather: { h: 240 }, media: { h: 150 }, claude: { h: 230 } },
  },
];
const sceneById = (id) => SCENES.find((s) => s.id === id);

const $ = (s) => document.querySelector(s);

// ---- One plane for widgets and apps ------------------------------------------
// The dock holds panels. A panel is a widget ("pc") or an app docked beside
// them ("app:youtube"): same bar, same drag-to-resize, same order, same scenes.
const isAppKey = (k) => typeof k === "string" && k.startsWith("app:");
const appOf = (k) => k.slice(4);
const panelDef = (k) => (isAppKey(k) ? APPS[appOf(k)] && { ...APPS[appOf(k)], app: appOf(k) } : WIDGETS[k]);
const panelKeys = () => Object.keys(WIDGETS).concat(Object.keys(APPS).map((a) => "app:" + a));

// ---- persisted state -------------------------------------------------------
const DEFAULT_STATE = {
  app: "spotify",
  widgets: {
    claude: { on: true, h: null, collapsed: false },
    weather: { on: false, h: null, collapsed: false },
    pc: { on: false, h: null, collapsed: false },
    calc: { on: false, h: null, collapsed: false },
    media: { on: false, h: null, collapsed: false },
    lyrics: { on: false, h: null, collapsed: false },
    audio: { on: false, h: null, collapsed: false },
    timer: { on: false, h: null, collapsed: false },
    notes: { on: false, h: null, collapsed: false },
    discord: { on: false, h: null, collapsed: false },
  },
};
DEFAULT_STATE.scene = null;        // which scene was last applied
DEFAULT_STATE.sceneEdits = {};     // per-scene overrides of the packed layout
// Dock order, top to bottom. The drawer list is this same array, so where a row
// sits in that list is literally where its panel sits on screen.
DEFAULT_STATE.order = Object.keys(WIDGETS);
let state = DEFAULT_STATE;
try {
  const saved = JSON.parse(localStorage.getItem("y70shell") || "null");
  if (saved && saved.widgets) {
    state = { ...DEFAULT_STATE, ...saved };
    // Widgets added by a later version won't be in a saved layout.
    state.widgets = { ...DEFAULT_STATE.widgets, ...saved.widgets };
    state.sceneEdits = saved.sceneEdits || {};
    state.order = normalizeOrder(saved.order);
  }
} catch (e) { /* fresh start */ }

function save() { localStorage.setItem("y70shell", JSON.stringify(state)); }

// Keeps a saved order usable across versions: drop panels that no longer
// exist, and append any that were added since it was written.
function normalizeOrder(order) {
  const known = panelKeys();
  const kept = (Array.isArray(order) ? order : []).filter((n) => known.includes(n));
  return kept.concat(known.filter((n) => !kept.includes(n)));
}

// Default panel height: a 16:9 chunk of the screen width, capped at 40% of
// height. An app docked as a panel gets the 16:9 picture plus its bar.
function defaultH(key) {
  const w = window.innerWidth;
  if (isAppKey(key)) return Math.min(Math.round(w * 9 / 16) + 30, Math.round(window.innerHeight * 0.6));
  return Math.min(Math.round(w * 9 / 16), Math.round(window.innerHeight * 0.4));
}
const MIN_H = 80;
const maxH = (key) => Math.round(window.innerHeight * (isAppKey(key) ? 0.85 : 0.55));

// ---- app switching ---------------------------------------------------------
// Apps stay mounted once opened and are only hidden — tearing the iframe down
// would kill the Spotify Web Playback SDK and stop the music. So an app frame
// never moves in the DOM: every one lives in #app-layer and is laid over
// whichever slot shows it — the main area, a dock panel, or the whole screen
// in focus (layoutApps). Moving an iframe in the DOM would reload it.
function appFrame(name) {
  let f = document.getElementById("app-" + name);
  if (!f) {
    f = document.createElement("iframe");
    f.id = "app-" + name;
    f.className = "app-frame";
    f.title = APPS[name].title;
    f.src = APPS[name].src;
    f.addEventListener("load", () => { f.dataset.loaded = "1"; });
    $("#app-layer").appendChild(f);
  }
  return f;
}

const isDocked = (name) => !!(state.widgets["app:" + name] && state.widgets["app:" + name].on);

// The main app. null leaves the main area empty and gives the dock the screen.
function setApp(name) {
  if (name !== null && !APPS[name]) return;
  // Asking for an app (a tile, Jarvis) ends any full-screen focus on another.
  if (focus && focus.app !== name) clearFocus(true);
  // Up in the main area an app shows its whole page again.
  if (name && theaterOn.has(name) && !focus) sendTheater(name, false);
  if (name && isDocked(name)) {
    // Opening a docked app brings it back up to the main area.
    state.widgets["app:" + name].on = false;
    renderDock();
  }
  if (state.app && state.app !== name) state.prevApp = state.app;
  state.app = name;
  save();
  if (name) appFrame(name);
  document.body.classList.toggle("no-main", !name && !focus);
  document.querySelectorAll(".app-tile").forEach((t) =>
    t.classList.toggle("active", t.dataset.app === name));
  layoutApps();
  syncWebViews();
  renderMini();
}

// ---- layout: where each app frame sits ------------------------------------------
let focus = null;          // { app, video } while one app has the whole screen

// app -> the element whose box it should cover, for every app on screen.
function appSlots() {
  const slots = new Map();
  if (focus) { slots.set(focus.app, $("#appframe")); return slots; }
  if (state.app && !isDocked(state.app)) slots.set(state.app, $("#appframe"));
  document.querySelectorAll("#dock .panel[data-app]").forEach((p) => {
    if (!p.classList.contains("collapsed")) slots.set(p.dataset.app, p.querySelector(".panel-slot"));
  });
  return slots;
}

function layoutApps() {
  const shell = $("#shell").getBoundingClientRect();
  const main = $("#appframe").getBoundingClientRect();
  const slots = appSlots();
  const place = (f, r) => {
    f.style.left = (r.left - shell.left) + "px";
    f.style.top = (r.top - shell.top) + "px";
    f.style.width = Math.max(0, r.width) + "px";
    f.style.height = Math.max(0, r.height) + "px";
  };
  // A dock taller than its room scrolls; a frame over a panel is clipped to
  // what the dock shows (clip-path for the iframe; the shell clips a native
  // view the same way when it is placed, from data-vis-top/bottom).
  const dockBox = $("#dock").getBoundingClientRect();
  for (const name of Object.keys(APPS)) {
    let slot = slots.get(name);
    const f = slot ? appFrame(name) : document.getElementById("app-" + name);
    if (!f) continue;
    const was = f.classList.contains("active");
    const r = slot ? slot.getBoundingClientRect() : main;
    const inDock = !!(slot && slot.classList.contains("panel-slot"));
    const visTop = inDock ? Math.max(r.top, dockBox.top) : r.top;
    const visBottom = inDock ? Math.min(r.bottom, dockBox.bottom) : r.bottom;
    if (inDock && visBottom - visTop < 24) slot = null;    // scrolled out of sight
    // Off-screen apps keep the main area's size, so they lay themselves out
    // sensibly while hidden (and Spotify keeps playing).
    place(f, slot ? r : main);
    f.style.clipPath = slot && inDock && (visTop > r.top || visBottom < r.bottom)
      ? "inset(" + Math.round(visTop - r.top) + "px 0 " + Math.round(r.bottom - visBottom) + "px 0)" : "";
    if (slot) { f.dataset.visTop = String(Math.round(visTop)); f.dataset.visBottom = String(Math.round(visBottom)); }
    f.classList.toggle("active", !!slot);
    // A web app's native view follows its frame; tell it now, not in 500 ms.
    if (WEB_APPS.test(name) && (slot || was)) {
      try { f.contentWindow.postMessage({ type: "y70:web-reposition" }, "*"); } catch (e) {}
    }
  }
}

// Next frame, or 50 ms if frames aren't being drawn (a hidden window).
let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  const run = () => { if (!layoutQueued) return; layoutQueued = false; layoutApps(); };
  requestAnimationFrame(run);
  setTimeout(run, 50);
}
const slotWatch = new ResizeObserver(scheduleLayout);

// ---- focus: one app, the whole screen ----------------------------------------
// The widgets drop away (the dock hides) and the app takes everything below the
// top bar. video: YouTube shows just its player (theater). Not saved: a focus
// is for now, the layout underneath is untouched.
function setFocus(name, opts) {
  if (!APPS[name]) return false;
  const video = !!(opts && opts.video);
  if (focus && focus.video && focus.app !== name) sendTheater(focus.app, false);
  focus = { app: name, video };
  document.body.classList.add("focus");
  document.body.classList.remove("no-main");
  appFrame(name);
  sendTheater(name, video);
  $("#focus-exit").hidden = false;
  layoutApps();
  syncWebViews();
  renderMini();
  return true;
}
function clearFocus(quiet) {
  if (!focus) return false;
  if (focus.video) sendTheater(focus.app, false);
  focus = null;
  document.body.classList.remove("focus");
  document.body.classList.toggle("no-main", !state.app);
  $("#focus-exit").hidden = true;
  if (!quiet) { layoutApps(); syncWebViews(); renderMini(); }
  return true;
}
// Which web apps are showing just their video, full screen or in a panel.
const theaterOn = new Set();
function sendTheater(name, on) {
  const f = document.getElementById("app-" + name);
  if (!f || !WEB_APPS.test(name)) return;
  if (on) theaterOn.add(name); else theaterOn.delete(name);
  const send = () => { try { f.contentWindow.postMessage({ type: "y70:web-theater", on }, "*"); } catch (e) {} };
  // A frame made just now has to load first.
  if (f.dataset.loaded) send(); else f.addEventListener("load", () => { f.dataset.loaded = "1"; send(); }, { once: true });
}

// ---- docking apps into the panel plane ---------------------------------------
function dockApp(name, opts) {
  if (!APPS[name]) return false;
  opts = opts || {};
  const key = "app:" + name;
  const w = state.widgets[key] || (state.widgets[key] = { on: false, h: null, collapsed: false });
  w.on = true; w.collapsed = false;
  if (focus && focus.app === name) clearFocus(true);
  // The main area can't show what the dock shows: fall back to the app shown
  // before it, or leave the main area to the dock.
  if (state.app === name) {
    const prev = state.prevApp && state.prevApp !== name && !isDocked(state.prevApp) ? state.prevApp : null;
    state.app = prev;
    document.body.classList.toggle("no-main", !prev);
    if (prev) appFrame(prev);
  }
  if (opts.position != null) movePanel(key, opts.position, true);
  // As asked, or 16:9 — either way no more than the dock has room for.
  w.h = Math.max(MIN_H, Math.min(maxH(key), Math.max(MIN_H, dockRoom(key)), Math.round(opts.h || w.h || defaultH(key))));
  appFrame(name);
  save();
  renderDock();
  return true;
}
function undockApp(name) {
  const w = state.widgets["app:" + name];
  if (!w || !w.on) return false;
  w.on = false;
  if (theaterOn.has(name)) sendTheater(name, false);
  save();
  renderDock();
  return true;
}

// position: "top", "bottom", an index, or { before: key } / { after: key }.
function movePanel(key, position, quiet) {
  const order = normalizeOrder(state.order).filter((k) => k !== key);
  const onKeys = order.filter((k) => state.widgets[k] && state.widgets[k].on);
  let at = order.length;
  if (position === "top" || position === 0) at = onKeys.length ? order.indexOf(onKeys[0]) : 0;
  else if (position === "bottom") at = onKeys.length ? order.indexOf(onKeys[onKeys.length - 1]) + 1 : order.length;
  else if (typeof position === "number") {
    // Index among the panels that are on screen.
    const ref = onKeys[Math.max(0, Math.min(onKeys.length, position))];
    at = ref ? order.indexOf(ref) : order.length;
  } else if (position && (position.before || position.after)) {
    const ref = position.before || position.after;
    const i = order.indexOf(ref);
    if (i >= 0) at = position.before ? i : i + 1;
  }
  order.splice(at, 0, key);
  state.order = order;
  if (!quiet) { save(); renderDock(); }
  return true;
}

// Room the dock can give one panel without pushing anything off screen: the
// screen, less the top bar, less a fifth for the main app when there is one,
// less every other panel on screen.
const MAIN_MIN = 0.2;
function dockRoom(exceptKey) {
  const top = $("#topbar").getBoundingClientRect().height;
  let room = window.innerHeight - top - (state.app && !isDocked(state.app) ? Math.round(window.innerHeight * MAIN_MIN) : 0);
  for (const k of normalizeOrder(state.order)) {
    const w = state.widgets[k];
    if (k === exceptKey || !w || !w.on || !panelDef(k)) continue;
    room -= w.collapsed ? 30 : (w.h || defaultH(k));
  }
  return room;
}
// Returns the height it got: no more than fits.
function resizePanel(key, h) {
  const w = state.widgets[key];
  if (!w) return null;
  const fit = Math.max(MIN_H, dockRoom(key));
  w.h = Math.max(MIN_H, Math.min(maxH(key), fit, Math.round(h)));
  w.collapsed = false;
  save();
  renderDock();
  return w.h;
}

// What is on screen, for Jarvis (and anyone else asking).
function layoutSnapshot() {
  const H = window.innerHeight, W = window.innerWidth;
  const panels = [];
  for (const key of normalizeOrder(state.order)) {
    const w = state.widgets[key];
    const def = panelDef(key);
    if (!def || !w || !w.on) continue;
    const el = document.querySelector('#dock .panel[data-key="' + key + '"]');
    panels.push({
      key, kind: isAppKey(key) ? "app" : "widget", title: def.title,
      height: el ? Math.round(el.getBoundingClientRect().height) : w.h || defaultH(key),
      collapsed: !!w.collapsed,
    });
  }
  const mainEl = $("#appframe").getBoundingClientRect();
  return {
    screen: { width: W, height: H },
    focus: focus ? { app: focus.app, justVideo: focus.video } : null,
    main: state.app && !focus ? { app: state.app, height: Math.round(mainEl.height) } : null,
    panels,
    scene: state.scene,
    hiddenWidgets: Object.keys(WIDGETS).filter((k) => !(state.widgets[k] && state.widgets[k].on)),
  };
}
// One line of it, for each request Jarvis hears.
function describeScreen() {
  if (focus) return (focus.video ? "Just a video, full screen, in " : "Full screen: ") + APPS[focus.app].title + " (widgets hidden).";
  const s = layoutSnapshot();
  const parts = [];
  if (s.main) parts.push(APPS[s.main.app].title + " (main)");
  if (s.panels.length) parts.push("panels top to bottom: " + s.panels.map((p) => p.title + (p.kind === "app" ? " app" : "") + (p.collapsed ? " (collapsed)" : "")).join(", "));
  return parts.join("; ") + ".";
}

// ---- widget dock -----------------------------------------------------------
// Panels are made once and kept: a re-render only adds, removes, re-sizes and
// re-orders them (with CSS order, since moving an element reloads its iframe),
// so a resize or a collapse no longer reloads every widget.
function makePanel(key) {
  const def = panelDef(key);
  const app = isAppKey(key) ? appOf(key) : null;
  const panel = document.createElement("div");
  panel.className = "panel" + (app ? " app-panel" : "");
  panel.dataset.key = key;
  if (app) panel.dataset.app = app; else panel.dataset.widget = key;

  const bar = document.createElement("div");
  bar.className = "panel-bar";
  bar.innerHTML =
    `<span class="grip"></span><span class="panel-title"></span>` +
    `<span class="panel-spacer"></span>` +
    (app
      ? `<button class="panel-btn" data-act="focus" title="Full screen">⤢</button>` +
        `<button class="panel-btn" data-act="main" title="Back to the main area">⤒</button>` +
        `<button class="panel-btn" data-act="close" title="Close the panel">✕</button>`
      : "") +
    `<button class="panel-collapse">▼</button>`;
  bar.querySelector(".panel-title").textContent = def.title;
  panel.appendChild(bar);

  if (app) {
    // The app's own frame is laid over this box (layoutApps).
    const slot = document.createElement("div");
    slot.className = "panel-slot";
    panel.appendChild(slot);
    slotWatch.observe(slot);
  } else {
    const iframe = document.createElement("iframe");
    iframe.src = def.src;
    iframe.title = def.title;
    panel.appendChild(iframe);
  }

  wirePanelDrag(panel, bar, key);
  bar.querySelector(".panel-collapse").addEventListener("pointerup", (e) => {
    e.stopPropagation();
    toggleCollapse(key);
  });
  bar.querySelectorAll(".panel-btn").forEach((b) => {
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      if (b.dataset.act === "focus") setFocus(app);
      if (b.dataset.act === "main") setApp(app);
      if (b.dataset.act === "close") undockApp(app);
    });
  });
  return panel;
}

function renderDock() {
  const dock = $("#dock");
  const want = normalizeOrder(state.order).filter((k) => panelDef(k) && state.widgets[k] && state.widgets[k].on);
  dock.querySelectorAll(".panel[data-key]").forEach((p) => {
    if (want.includes(p.dataset.key)) return;
    const slot = p.querySelector(".panel-slot");
    if (slot) slotWatch.unobserve(slot);
    p.remove();
  });
  want.forEach((key, i) => {
    let panel = dock.querySelector('.panel[data-key="' + key + '"]');
    if (!panel) { panel = makePanel(key); dock.appendChild(panel); }
    const w = state.widgets[key];
    panel.classList.toggle("collapsed", !!w.collapsed);
    panel.querySelector(".panel-collapse").textContent = w.collapsed ? "▲" : "▼";
    panel.style.height = w.collapsed ? "auto" : (w.h || defaultH(key)) + "px";
    panel.style.order = String(i + 1);
  });
  // Switching the widget off takes its iframe away mid-sentence; without this
  // a borrowed window would be left hanging over the panel.
  if (native && native.pinPlace && !pinFrame()) native.pinPlace({ visible: false });
  renderWidgetList();
  scheduleLayout();
  syncWebViews();
}

function toggleCollapse(name) {
  const w = state.widgets[name];
  w.collapsed = !w.collapsed;
  save();
  renderDock();
}

// Drag the panel bar to resize; drag it down to the bottom to collapse.
function wirePanelDrag(panel, bar, name) {
  let startY = 0, startH = 0, dragging = false, moved = false;

  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".panel-collapse")) return;
    dragging = true; moved = false;
    startY = e.clientY;
    const w = state.widgets[name];
    startH = w.collapsed ? 0 : panel.getBoundingClientRect().height;
    bar.setPointerCapture(e.pointerId);
    document.getElementById("shell").classList.add("shielded");
  });

  bar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // drag up = positive = taller
    if (Math.abs(dy) > 4) moved = true;
    const w = state.widgets[name];
    let h = Math.max(0, Math.min(startH + dy, maxH(name)));
    if (h > MIN_H && w.collapsed) {
      w.collapsed = false;
      panel.classList.remove("collapsed");
      bar.querySelector(".panel-collapse").textContent = "▼";
    }
    if (!w.collapsed) panel.style.height = h + "px";
  });

  bar.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    document.getElementById("shell").classList.remove("shielded");
    const w = state.widgets[name];
    const h = panel.getBoundingClientRect().height;

    if (!moved) {
      // Plain tap on the bar: expand if collapsed.
      if (w.collapsed) toggleCollapse(name);
      return;
    }
    if (h <= MIN_H) {
      // Dragged down to the bottom -> collapse.
      w.collapsed = true;
      save();
      renderDock();
    } else {
      w.h = Math.round(h);
      w.collapsed = false;
      save();
    }
  });
}

// ---- drawer ----------------------------------------------------------------
const drawer = $("#drawer");
const backdrop = $("#drawer-backdrop");

function openDrawer(open) {
  drawer.classList.toggle("open", open);
  backdrop.classList.toggle("hidden", !open);
  syncWebViews();
  // Always reopen on the main view, never mid-settings.
  if (!open) showSettings(false);
}

function wireDrawer() {
  const topbar = $("#topbar");
  let startY = 0, dragging = false, moved = false;

  topbar.addEventListener("pointerdown", (e) => {
    dragging = true; moved = false; startY = e.clientY;
    drawer.classList.add("dragging");
    topbar.setPointerCapture(e.pointerId);
    document.getElementById("shell").classList.add("shielded");
  });
  topbar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (dy > 6) moved = true;
    const h = drawer.getBoundingClientRect().height;
    const t = Math.min(0, -h + Math.max(0, dy));
    drawer.style.transform = `translateY(${t}px)`;
    if (dy > 10) { backdrop.classList.remove("hidden"); syncWebViews(); }
  });
  topbar.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    drawer.classList.remove("dragging");
    drawer.style.transform = "";
    document.getElementById("shell").classList.remove("shielded");
    const dy = e.clientY - startY;
    openDrawer(moved ? dy > 70 : !drawer.classList.contains("open"));
  });

  backdrop.addEventListener("pointerup", () => openDrawer(false));
  $("#drawer-close").addEventListener("pointerup", () => openDrawer(false));

  // Tiles
  document.querySelectorAll(".app-tile").forEach((t) => {
    t.addEventListener("pointerup", () => { setApp(t.dataset.app); openDrawer(false); });
  });
}

// ---- Widget list: toggle + drag to reorder ---------------------------------
// The rows ARE the dock, in order. The grip drags; anywhere else toggles.
function renderWidgetList() {
  const box = $("#widget-list");
  if (!box) return;
  box.innerHTML = "";
  for (const name of normalizeOrder(state.order)) {
    const def = panelDef(name);
    if (!def) continue;
    const app = isAppKey(name) ? appOf(name) : null;
    const w = state.widgets[name] || (state.widgets[name] = { on: false, h: null, collapsed: false });
    const row = document.createElement("div");
    row.className = "wrow" + (w.on ? " on" : "") + (app ? " app-row" : "");
    row.dataset.widget = name;
    row.innerHTML =
      '<span class="wgrip" aria-label="Reorder"></span>' +
      '<span class="tile-ico ' + (def.ico || "") + '"></span>' +
      '<span class="wname"></span>' +
      '<span class="wcheck"></span>';
    row.querySelector(".wgrip").textContent = "\u2630";
    row.querySelector(".tile-ico").textContent = def.glyph || "";
    row.querySelector(".wname").textContent = def.title + (app ? " \u00b7 app panel" : "");
    row.addEventListener("pointerup", (e) => {
      if (justDragged || e.target.closest(".wgrip")) return;
      // An app goes through dockApp, which also sorts out the main area.
      if (app) { if (w.on) undockApp(app); else dockApp(app); return; }
      w.on = !w.on;
      save();
      renderDock();
    });
    box.appendChild(row);
  }
  wireReorder(box);
}

let dragRow = null, justDragged = false;

function wireReorder(box) {
  for (const grip of box.querySelectorAll(".wgrip")) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragRow = grip.closest(".wrow");
      dragRow.classList.add("dragging");
      grip.setPointerCapture(e.pointerId);
      $("#shell").classList.add("shielded");
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragRow) return;
      justDragged = true;
      // Swap against row midpoints so the list settles as you cross a boundary
      // instead of flickering back and forth on it.
      for (const other of box.querySelectorAll(".wrow")) {
        if (other === dragRow) continue;
        const r = other.getBoundingClientRect();
        if (e.clientY > r.top && e.clientY < r.bottom) {
          if (e.clientY < r.top + r.height / 2) box.insertBefore(dragRow, other);
          else box.insertBefore(dragRow, other.nextSibling);
          break;
        }
      }
    });
    const end = () => {
      if (!dragRow) return;
      dragRow.classList.remove("dragging");
      dragRow = null;
      $("#shell").classList.remove("shielded");
      // Once the drag ends the DOM is the source of truth.
      state.order = [...box.querySelectorAll(".wrow")].map((r) => r.dataset.widget);
      save();
      renderDock();
      // Stops the pointerup that ended the drag from also toggling the row.
      setTimeout(() => { justDragged = false; }, 0);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }
}

// ---- Scenes: apply, save, reset ---------------------------------------------
// The packed layout is the fallback; an edit saved on top of it wins. Applying
// a scene is deliberately total — widgets it doesn't mention are turned OFF, so
// switching to Gaming can't leave yesterday's notes panel hanging around.
function sceneLayout(id) {
  const base = sceneById(id);
  if (!base) return null;
  const edit = state.sceneEdits && state.sceneEdits[id];
  // A packed scene's order is simply the order its widgets are written in.
  // A saved scene may have no main app at all (null): everything in panels.
  return edit
    ? { app: edit.app !== undefined ? edit.app : base.app, widgets: edit.widgets || base.widgets, order: edit.order }
    : { app: base.app, widgets: base.widgets, order: Object.keys(base.widgets) };
}

function applyScene(id) {
  const layout = sceneLayout(id);
  if (!layout) return;
  clearFocus(true);
  // Widgets and docked apps alike.
  for (const name of panelKeys()) {
    const want = layout.widgets[name];
    const w = state.widgets[name] || (state.widgets[name] = { on: false, h: null, collapsed: false });
    w.on = !!want && !(isAppKey(name) && appOf(name) === layout.app);
    if (want) {
      if (want.h) w.h = want.h;
      w.collapsed = !!want.collapsed;
    }
  }
  if (layout.order) state.order = normalizeOrder(layout.order);
  state.scene = id;
  save();
  setApp(layout.app);
  renderDock();
  renderScenes();
}

function saveScene(id) {
  const widgets = {};
  for (const name of normalizeOrder(state.order)) {
    const w = state.widgets[name];
    if (w && w.on) widgets[name] = { h: w.h || undefined, collapsed: !!w.collapsed };
  }
  state.sceneEdits[id] = {
    app: state.app,
    widgets,
    order: normalizeOrder(state.order).filter((n) => widgets[n]),
  };
  state.scene = id;
  save();
  renderScenes();
}

function resetScene(id) {
  delete state.sceneEdits[id];
  save();
  applyScene(id);
}

function renderScenes() {
  const row = $("#scene-row");
  if (!row) return;
  row.innerHTML = "";
  for (const sc of SCENES) {
    const b = document.createElement("button");
    const edited = !!(state.sceneEdits && state.sceneEdits[sc.id]);
    b.className = "tile scene-tile" + (state.scene === sc.id ? " active" : "");
    b.innerHTML =
      '<span class="tile-ico scene-ico">' + sc.icon + "</span>" +
      "<span>" + sc.name + "</span>" +
      (edited ? '<span class="tile-sub">yours</span>' : "");
    b.addEventListener("pointerup", () => { applyScene(sc.id); openDrawer(false); });
    row.appendChild(b);
  }
  const cur = state.scene ? sceneById(state.scene) : null;
  $("#scene-save").textContent = cur ? "Save layout \u2192 " + cur.name : "Save layout";
  $("#scene-save").disabled = !cur;
  $("#scene-reset").disabled = !cur || !(state.sceneEdits && state.sceneEdits[state.scene]);
}

function wireScenes() {
  $("#scene-save").addEventListener("pointerup", () => { if (state.scene) saveScene(state.scene); });
  $("#scene-reset").addEventListener("pointerup", () => { if (state.scene) resetScene(state.scene); });
  renderScenes();
}

// ---- iPhone: banners, call card, notification list ---------------------------
// Fed by /api/phone, which is backed by a Bluetooth LE bridge speaking Apple's
// ANCS. Notifications arrive as they do on the phone; an incoming call is just
// a notification in the IncomingCall category that can be acted on.
let phoneSeen = 0;            // highest notification seq already shown as a banner
let phoneCall = null;
let callTimer = null;
let phoneFirstLoad = true;

async function phonePoll() {
  let d;
  try { d = await (await fetch("/api/phone")).json(); }
  catch (e) { setPhoneStatus("server unreachable"); return; }
  if (!d.ok) return;

  setPhoneStatus(
    d.connected ? (d.device || "connected")
      : d.error ? d.error
      : d.running ? "looking for the phone\u2026" : "off");

  const batt = $("#phone-batt");
  if (batt) {
    batt.textContent = d.battery == null ? "" : d.battery + "%";
    batt.classList.toggle("low", d.battery != null && d.battery <= 20);
  }

  renderPhoneList(d.notifications || []);
  renderCall(d.call);

  // Banner anything new. On the very first poll everything is "new", and
  // nobody wants a wall of banners for notifications that arrived yesterday.
  const fresh = (d.notifications || []).filter((n) => n.seq > phoneSeen && !n.preExisting);
  for (const n of (d.notifications || [])) phoneSeen = Math.max(phoneSeen, n.seq);
  if (!phoneFirstLoad) {
    // Oldest first, so the newest ends up nearest the top.
    for (const n of fresh.slice().reverse()) {
      if (n.category === "IncomingCall") continue;   // the call card covers this
      showBanner(n);
    }
  }
  phoneFirstLoad = false;
}

function setPhoneStatus(text) {
  const el = $("#phone-status");
  if (el) el.textContent = text;
}

const APP_GLYPHS = {
  MobileSMS: "\u{1F4AC}", Messages: "\u{1F4AC}", mobilephone: "\u260e", Phone: "\u260e",
  mobilemail: "\u2709", Mail: "\u2709", MobileCal: "\u{1F4C5}", Calendar: "\u{1F4C5}",
};
const glyphFor = (n) =>
  n.category === "IncomingCall" || n.category === "MissedCall" ? "\u260e"
    : APP_GLYPHS[n.appName] || APP_GLYPHS[(n.app || "").split(".").pop()] || "\u{1F514}";

function showBanner(n) {
  const stack = $("#banners");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "banner";
  el.innerHTML =
    '<span class="b-ico"></span><div class="b-body">' +
    '<div class="b-app"></div><div class="b-title"></div><div class="b-msg"></div></div>';
  el.querySelector(".b-ico").textContent = glyphFor(n);
  el.querySelector(".b-app").textContent = n.appName || n.app || "Notification";
  el.querySelector(".b-title").textContent = n.title || n.appName || "";
  el.querySelector(".b-msg").textContent = n.message || n.subtitle || "";
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));

  const drop = () => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 400);
  };
  el.addEventListener("pointerup", drop);
  setTimeout(drop, n.important ? 9000 : 6000);
  // Never let a burst of notifications fill the screen.
  while (stack.children.length > 4) stack.firstElementChild.remove();
}

function renderCall(call) {
  const card = $("#call-card");
  if (!card) return;
  phoneCall = call || null;

  if (!call || call.ended) {
    card.classList.remove("in", "active");
    clearInterval(callTimer);
    callTimer = null;
    return;
  }
  $("#call-from").textContent = call.from || "Unknown";
  $("#call-detail").textContent = call.accepted ? "on the call" : (call.detail || "incoming call");
  card.classList.toggle("active", !!call.accepted);
  card.classList.add("in");

  clearInterval(callTimer);
  if (call.accepted) {
    const started = call.answeredAt || Date.now();
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
      $("#call-timer").textContent =
        Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    };
    tick();
    callTimer = setInterval(tick, 500);
  }
}

async function phoneAction(action, uid) {
  try {
    await fetch("/api/phone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, uid }),
    });
  } catch (e) { /* the next poll re-syncs */ }
  phonePoll();
}

function renderPhoneList(list) {
  const box = $("#phone-list");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div id="phone-empty">Nothing from your phone right now.</div>';
    return;
  }
  const sig = list.map((n) => n.uid + ":" + n.seq).join("|");
  if (box.dataset.sig === sig) { paintPhoneTimes(box, list); return; }
  box.dataset.sig = sig;
  box.innerHTML = "";
  for (const n of list) {
    const el = document.createElement("div");
    el.className = "pn" + (n.category === "IncomingCall" || n.category === "MissedCall" ? " call" : "");
    el.dataset.uid = n.uid;
    el.innerHTML =
      '<span class="p-ico"></span><div class="p-body">' +
      '<div class="p-app"></div><div class="p-title"></div><div class="p-msg"></div>' +
      '</div><span class="p-time"></span>';
    el.querySelector(".p-ico").textContent = glyphFor(n);
    el.querySelector(".p-app").textContent = n.appName || n.app || "";
    el.querySelector(".p-title").textContent = n.title || "";
    el.querySelector(".p-msg").textContent = n.message || n.subtitle || "";
    // Tapping clears it from the panel only; the phone keeps its own copy.
    el.addEventListener("pointerup", () => phoneAction("dismiss", n.uid));
    box.appendChild(el);
  }
  paintPhoneTimes(box, list);
}

function paintPhoneTimes(box, list) {
  for (const n of list) {
    const el = box.querySelector('.pn[data-uid="' + n.uid + '"] .p-time');
    if (!el) continue;
    const mins = Math.floor((Date.now() - n.at) / 60000);
    el.textContent = mins < 1 ? "now" : mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h";
  }
}

function wirePhone() {
  $("#call-accept").addEventListener("pointerup", () => phoneCall && phoneAction("accept", phoneCall.uid));
  $("#call-decline").addEventListener("pointerup", () => phoneCall && phoneAction("decline", phoneCall.uid));
  $("#call-hangup").addEventListener("pointerup", () => phoneCall && phoneAction("hangup", phoneCall.uid));
  phonePoll();
  setInterval(phonePoll, 2000);
}

// ---- Settings: theme / appearance ------------------------------------------
// theme.js owns the colour maths and persistence; this is just the UI. Every
// frame reads the saved theme itself on load, so new iframes come up correct;
// the broadcast below is what updates frames that are *already* open.
const ACCENT_SWATCHES = [
  "#A85CD6", "#7C5CFF", "#5AA9FF", "#42D6C3", "#1ED760",
  "#E8D44D", "#FFB03D", "#FF5F56", "#FF5CA8", "#F2F2F7",
];
const BG_SWATCHES = ["#000000", "#07070a", "#0a0a0c", "#0d0812", "#080d14", "#0d0906", "#050d0a"];

let theme = Y70Theme.get();
const sameColor = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function broadcastTheme(t) {
  document.querySelectorAll("iframe").forEach((f) => {
    try { f.contentWindow.postMessage({ type: "y70:theme", theme: t }, "*"); } catch (e) { /* ignore */ }
  });
}

// If an edited theme happens to match a preset again, show it as that preset
// rather than leaving it stuck on "Custom".
function retag(t) {
  const m = Y70Theme.PRESETS.find((p) =>
    sameColor(p.bg, t.bg) && sameColor(p.trim, t.trim) &&
    sameColor(p.weather, t.weather) && sameColor(p.claude, t.claude) &&
    sameColor(p.pc, t.pc) && sameColor(p.calc, t.calc) &&
    sameColor(p.media, t.media) && sameColor(p.tools, t.tools) &&
    sameColor(p.discord, t.discord) && sameColor(p.web, t.web) && p.tintBg === t.tintBg);
  return { ...t, id: m ? m.id : "custom", name: m ? m.name : "Custom" };
}

function applyTheme(next, rerender) {
  theme = Y70Theme.set(next);
  broadcastTheme(theme);
  const nameEl = $("#theme-name");
  if (nameEl) nameEl.textContent = theme.name;
  if (rerender !== false) renderSettings();
}

const setSlot = (slot, color) => applyTheme(retag({ ...theme, [slot]: color }));

function renderSettings() {
  const pr = $("#preset-row");
  if (!pr) return;
  pr.innerHTML = "";
  for (const p of Y70Theme.PRESETS) {
    const b = document.createElement("button");
    b.className = "preset" + (p.id === theme.id ? " on" : "");
    b.innerHTML =
      '<span class="preset-dots">' +
        '<i style="background:' + p.trim + '"></i>' +
        '<i style="background:' + p.weather + '"></i>' +
        '<i style="background:' + p.claude + '"></i>' +
      '<i style="background:' + p.pc + '"></i>' +
      '<i style="background:' + p.calc + '"></i>' +
      "</span>" +
      '<span class="preset-name">' + p.name + "</span>";
    b.addEventListener("pointerup", () => applyTheme({ ...Y70Theme.preset(p.id) }));
    pr.appendChild(b);
  }

  document.querySelectorAll(".swatches").forEach((row) => {
    const slot = row.dataset.slot;
    row.innerHTML = "";
    for (const c of (slot === "bg" ? BG_SWATCHES : ACCENT_SWATCHES)) {
      const b = document.createElement("button");
      b.className = "sw" + (sameColor(c, theme[slot]) ? " on" : "");
      b.style.background = c;
      b.style.setProperty("--sw-ink", Y70Theme.ink(c));
      b.addEventListener("pointerup", () => setSlot(slot, c));
      row.appendChild(b);
    }
    // Native picker for anything not in the row. It fires `input` continuously
    // while the user drags, so preview live but only re-render on `change` —
    // re-rendering mid-drag would delete the input being interacted with.
    const wrap = document.createElement("label");
    wrap.className = "sw-custom";
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = theme[slot];
    inp.addEventListener("input", () => applyTheme(retag({ ...theme, [slot]: inp.value }), false));
    inp.addEventListener("change", () => renderSettings());
    wrap.appendChild(inp);
    row.appendChild(wrap);
  });

  $("#tint-bg").checked = !!theme.tintBg;
}

function showSettings(on) {
  $("#settings-view").classList.toggle("hidden", !on);
  $(".drawer-inner").classList.toggle("hidden", on);
  if (on) renderSettings();
}

function wireSettings() {
  $("#theme-name").textContent = theme.name;
  $("#open-settings").addEventListener("pointerup", () => showSettings(true));
  $("#settings-back").addEventListener("pointerup", () => showSettings(false));
  $("#settings-close").addEventListener("pointerup", () => openDrawer(false));
  $("#settings-reset").addEventListener("pointerup", () =>
    applyTheme({ ...Y70Theme.PRESETS[0] }));
  $("#tint-bg").addEventListener("change", (e) =>
    applyTheme(retag({ ...theme, tintBg: e.target.checked })));
}

// ---- Native shell (V2) -----------------------------------------------------
// window.y70native only exists when the dashboard is running inside the V2
// Electron shell. In a plain browser every one of these is a no-op and the
// native-only controls stay hidden, so one set of pages serves both.
const native = window.y70native || null;
let keyboardMode = false;

function wireNative() {
  document.body.classList.toggle("is-native", !!native);
  if (!native) return;
  // Tolerate a shell that has not registered its handlers yet.
  native.getKeyboardMode().then(setKeyboardIndicator).catch(() => {});
  native.onKeyboardMode(setKeyboardIndicator);
  $("#kb-toggle").addEventListener("pointerup", () => native.setKeyboardMode(!keyboardMode));

  // Hard lock: while this is on nothing can make the panel focusable, so a
  // stray tap in a text field cannot cost you focus mid-game.
  const lock = $("#passive-lock");
  const paintLock = (on) => {
    lock.textContent = "Never take focus: " + (on ? "ON" : "off");
    lock.classList.toggle("is-on", !!on);
  };
  native.getPassiveLock().then(paintLock).catch(() => {});
  lock.addEventListener("pointerup", async () => {
    paintLock(await native.setPassiveLock(!lock.classList.contains("is-on")));
  });

  // Version + updates.
  native.version().then((v) => { $("#app-version").textContent = "v" + v; }).catch(() => {});
  native.onUpdate(paintUpdate);
  native.updateState().then(paintUpdate).catch(() => {});
  $("#update-check").addEventListener("pointerup", async () => {
    $("#update-status").textContent = "checking\u2026";
    paintUpdate(await native.checkUpdate());
  });
  $("#update-install").addEventListener("pointerup", () => native.installUpdate());
  wireForks();

  // Start with Windows / taskbar presence, read back from the OS rather than
  // remembered here, so the buttons always show the truth.
  const paint = (el, on, label) => { el.textContent = label + (on ? ": on" : ": off"); el.classList.toggle("is-on", !!on); };
  const auto = $("#native-autostart"), tb = $("#native-taskbar");
  native.getAutoStart().then((v) => paint(auto, v, "Start with Windows")).catch(() => {});
  // Say so rather than quietly misbehaving: run from source, the Run key is
  // written under Electron's own name and does not start the dashboard.
  native.isPackaged().then((packaged) => {
    if (!packaged) auto.title = "Only takes effect in the installed build";
  }).catch(() => {});
  native.getShowInTaskbar().then((v) => paint(tb, v, "Taskbar icon")).catch(() => {});
  auto.addEventListener("pointerup", async () => {
    const on = await native.setAutoStart(!auto.classList.contains("is-on"));
    paint(auto, on, "Start with Windows");
  });
  tb.addEventListener("pointerup", async () => {
    const on = await native.setShowInTaskbar(!tb.classList.contains("is-on"));
    paint(tb, on, "Taskbar icon");
  });
  $("#native-reload").addEventListener("pointerup", () => native.reload());
  $("#native-quit").addEventListener("pointerup", () => native.quit());
}

// ---- Forks -------------------------------------------------------------------
// Other lines of this app, each with its own releases. Picking one downloads
// its latest build through the updater; Restart installs it over this one, in
// the same folder with the same settings, so switching back is the same move.
let forkInfo = null;      // { current, forks: [{id, name, about}], switchingTo, packaged }
let forkAsk = null;       // the fork a confirm line is showing for
let lastUpdate = null;

function wireForks() {
  if (!native.forks) { $("#fork-wrap").remove(); return; }
  native.onForks((f) => { forkInfo = f; paintForks(); });
  native.forks().then((f) => { forkInfo = f; paintForks(); }).catch(() => {});
}

const forkName = (id) => ((forkInfo && forkInfo.forks.find((f) => f.id === id)) || { name: id }).name;

function paintForks() {
  const row = $("#fork-row"), ask = $("#fork-ask");
  if (!row || !forkInfo) return;
  row.innerHTML = "";
  for (const f of forkInfo.forks) {
    const here = f.id === forkInfo.current;
    const going = f.id === forkInfo.switchingTo;
    const b = document.createElement("button");
    b.className = "tile-btn" + (here ? " is-on" : "");
    b.innerHTML = '<span class="t-top"><span class="dot' + (here || going ? "" : " dot--off") +
      '"></span><span class="t-name"></span></span><span class="t-sub"></span>';
    b.querySelector(".t-name").textContent = f.name;
    b.querySelector(".t-sub").textContent =
      here ? "this build" : going ? "switching to this…" : f.about;
    b.title = f.about;
    b.addEventListener("pointerup", () => {
      if (here) { forkAsk = null; if (forkInfo.switchingTo) cancelSwitch(); else paintForks(); return; }
      if (going) return;
      forkAsk = f.id;
      paintForks();
    });
    row.appendChild(b);
  }

  ask.innerHTML = "";
  if (forkInfo.switchingTo) {
    ask.innerHTML = '<span class="fork-q"></span><button class="btn btn--ghost btn--chip" data-act="cancel">Cancel switch</button>';
    ask.querySelector(".fork-q").textContent = lastUpdate && lastUpdate.status === "ready"
      ? forkName(forkInfo.switchingTo) + " is downloaded. Restart to switch — settings, sign-ins and notes carry over."
      : "Fetching " + forkName(forkInfo.switchingTo) + "’s latest build…";
  } else if (forkAsk) {
    if (!forkInfo.packaged) {
      ask.innerHTML = '<span class="fork-q">Run from source there is nothing to replace — forks switch in the installed build.</span>';
    } else {
      ask.innerHTML = '<span class="fork-q"></span>' +
        '<button class="btn btn--primary btn--chip" data-act="go">Switch</button>' +
        '<button class="btn btn--ghost btn--chip" data-act="no">Not now</button>';
      ask.querySelector(".fork-q").textContent = "Switch to " + forkName(forkAsk) +
        "? This downloads its latest build; Restart installs it. Settings, sign-ins and notes carry over, and you can switch back the same way.";
    }
  }
  ask.querySelectorAll("button").forEach((btn) => btn.addEventListener("pointerup", async () => {
    const act = btn.dataset.act;
    if (act === "no") { forkAsk = null; paintForks(); return; }
    if (act === "cancel") { cancelSwitch(); return; }
    if (act === "go") {
      const r = await native.switchFork(forkAsk);
      forkAsk = null;
      if (r && r.ok === false) $("#update-status").textContent = r.error || "could not switch";
      if (r && r.forks) forkInfo = r;
      paintForks();
    }
  }));
}

async function cancelSwitch() {
  const r = await native.cancelForkSwitch();
  if (r && r.forks) forkInfo = r;
  paintForks();
}

// The updater's own words, in plain ones.
function paintUpdate(u) {
  if (!u) return;
  lastUpdate = u;
  const status = $("#update-status");
  const install = $("#update-install");
  if (!status) return;
  const text = {
    idle: "",
    checking: "checking\u2026",
    current: "up to date",
    downloading: u.percent ? "downloading " + u.percent + "%" : "downloading\u2026",
    ready: "v" + (u.version || "?") + " ready",
    // Run from source there is nothing to replace, so say that rather than
    // pretending it is up to date.
    dev: "dev build \u2014 updates off",
    error: "update failed",
  }[u.status] || "";
  status.textContent = text;
  status.title = u.error || "";
  install.style.display = u.status === "ready" ? "" : "none";
  const switching = forkInfo && forkInfo.switchingTo;
  install.textContent = switching ? "Restart to switch to " + forkName(switching) : "Restart to update";
  if (switching && u.status === "ready") status.textContent = forkName(switching) + " v" + (u.version || "?") + " ready";
  const check = $("#update-check");
  if (check) check.disabled = u.status === "checking" || u.status === "downloading" || !!switching;
  paintForks();
}

function setKeyboardIndicator(on) {
  keyboardMode = !!on;
  document.body.classList.toggle("keyboard-mode", keyboardMode);
  const t = $("#kb-toggle");
  if (t) t.textContent = keyboardMode ? "Keyboard mode: ON" : "Keyboard mode: off";
  // The web apps draw their own keyboard button, and the mode releases itself
  // after a minute, so they have to hear about it rather than remember.
  document.querySelectorAll("iframe").forEach((f) => {
    try { f.contentWindow.postMessage({ type: "y70:keyboard-state", on: keyboardMode }, "*"); } catch (e) {}
  });
}

// A widget that needs typing (Notes) asks through the shell, since preload is
// only injected into this top-level frame.
function relayKeyboardRequest(on) {
  if (!native) return;
  native.setKeyboardMode(!!on);
}

// ---- Web apps ---------------------------------------------------------------
// Neither YouTube nor TikTok can be framed, and <webview> only works in a
// top-level frame, so their content is a native view owned by the main process.
// The page draws its toolbar and says where the content belongs; this relays.
async function handleWebMessage(source, d) {
  const reply = (result) => {
    try { source.postMessage({ type: "y70:web-reply", id: d.id, result }, "*"); } catch (e) {}
  };
  if (!native) return reply({ ok: false, error: "not the native shell" });

  if (d.action === "place") {
    const frame = document.getElementById("app-" + d.site);
    const isActive = frame && frame.classList.contains("active");
    // Anything drawn over the app area — the drawer and its backdrop — would be
    // covered by a native view, which sits above all HTML. Hide it instead.
    const covered = isCovered();
    if (!frame || !isActive || covered || !d.visible) {
      return reply(await native.webPlace(d.site, { visible: false }));
    }
    const fr = frame.getBoundingClientRect();
    const rect = {
      x: fr.left + d.rect.x,
      y: fr.top + d.rect.y,
      width: d.rect.width,
      height: d.rect.height,
    };
    // In a dock that has scrolled, only the part the dock shows: a native view
    // sits above all HTML and would otherwise spill over the bar or the app.
    const vt = Number(frame.dataset.visTop), vb = Number(frame.dataset.visBottom);
    if (Number.isFinite(vt) && Number.isFinite(vb)) {
      const y0 = Math.max(rect.y, vt), y1 = Math.min(rect.y + rect.height, vb);
      if (y1 - y0 < 24) return reply(await native.webPlace(d.site, { visible: false }));
      rect.y = y0; rect.height = y1 - y0;
    }
    return reply(await native.webPlace(d.site, {
      visible: true, rect, url: d.url, mobile: d.mobile,
    }));
  }
  if (d.action === "state") return reply(await native.webState(d.site));
  return reply(await native.webAction(d.site, d.action, d.arg));
}

// ---- Pinned window ---------------------------------------------------------
// The widget says where its slot is; only the shell knows where that iframe
// sits in the window, and only the main process knows where the window sits on
// the desktop.
const pinFrame = () => document.querySelector('#dock iframe[src="/widget-pin.html"]');

async function handlePinMessage(source, d) {
  const reply = (result) => {
    try { source.postMessage({ type: "y70:pin-reply", id: d.id, result }, "*"); } catch (e) {}
  };
  if (!native || !native.pinList) return reply({ ok: false, error: "not the native shell" });

  if (d.action === "place") {
    // The drawer is HTML and a real window would sit on top of it, so the
    // borrowed window steps aside whenever the drawer is down.
    const covered = isCovered();
    const frame = pinFrame();
    if (covered || !d.visible || !frame) return reply(await native.pinPlace({ visible: false }));
    const fr = frame.getBoundingClientRect();
    return reply(await native.pinPlace({
      visible: true,
      rect: { x: fr.left + d.rect.x, y: fr.top + d.rect.y, width: d.rect.width, height: d.rect.height },
    }));
  }
  if (d.action === "list") return reply(await native.pinList());
  if (d.action === "state") return reply(await native.pinState());
  if (d.action === "set") return reply(await native.pinSet(d.hwnd, d.title, d.process));
  if (d.action === "clear") return reply(await native.pinClear());
  return reply({ ok: false, error: "unknown action" });
}

// Anything drawn over the app area. Native views sit above all HTML, so while
// any of these is up they are hidden rather than left covering it. Overlays
// outside the drawer (the island card) mark themselves with body.overlay-open.
function isCovered() {
  return drawer.classList.contains("open") || !backdrop.classList.contains("hidden") ||
    document.body.classList.contains("overlay-open");
}

// Switching apps or opening the drawer must take the native view down with it,
// otherwise it hangs over whatever is now on top. Several web apps can be on
// screen at once now (main + panels), so each is hidden on its own.
function syncWebViews() {
  if (!native) return;
  if (isCovered()) { native.webHideAll(); return; }
  const shown = appSlots();
  for (const name of Object.keys(APPS)) {
    if (!WEB_APPS.test(name) || shown.has(name)) continue;
    if (document.getElementById("app-" + name)) native.webPlace(name, { visible: false });
  }
  // The ones that should be visible re-place themselves (layoutApps nudges them).
}

// ---- Mini player -----------------------------------------------------------
// A slim now-playing strip that appears automatically whenever you leave the
// Spotify app while something is loaded, and disappears when you go back.
let playback = { hasTrack: false, playing: false };
let lastState = null;

function renderMini() {
  const dock = $("#dock");
  const want = state.app !== "spotify" && playback.hasTrack;
  let panel = document.getElementById("mini-panel");

  if (!want) { if (panel) panel.remove(); return; }
  if (panel) return;

  panel = document.createElement("div");
  panel.id = "mini-panel";
  const f = document.createElement("iframe");
  f.src = "/widget-miniplayer.html";
  f.title = "Now playing";
  f.addEventListener("load", () => {
    if (lastState) { try { f.contentWindow.postMessage(lastState, "*"); } catch (e) {} }
  });
  panel.appendChild(f);
  dock.insertBefore(panel, dock.firstChild);
}

// ---- message relay ---------------------------------------------------------
//   app  -> widgets   (playback state)
//   widget -> app     (transport commands)
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d.type !== "string" || !d.type.startsWith("y70:")) return;

  // A widget asking to borrow the keyboard (see the Notes widget).
  if (d.type === "y70:keyboard") { relayKeyboardRequest(d.on); return; }

  // A web app (YouTube / TikTok) talking to its native view. The page reports
  // rectangles in its own coordinates; the offset of its iframe within the
  // window is added here, because only the shell knows that.
  if (d.type === "y70:web") { handleWebMessage(e.source, d); return; }

  // The pinned-window widget, which borrows a real window from Windows.
  if (d.type === "y70:pin") { handlePinMessage(e.source, d); return; }

  // Spotify sign-in. In a browser this is just a top-level navigation; in the
  // native panel it has to be a separate focusable window, because this one
  // deliberately never takes focus and so can never accept a password.
  if (d.type === "y70:auth" && d.url) {
    if (native) native.openAuth(d.url);
    else window.location = d.url;
    return;
  }

  if (d.type === "y70:open-app" && APPS[d.app]) { setApp(d.app); return; }

  if (d.type === "y70:cmd") {
    const sp = document.getElementById("app-spotify");
    if (sp) { try { sp.contentWindow.postMessage(d, "*"); } catch (err) {} }
    return;
  }

  if (d.type === "y70:state") {
    lastState = d;
    const was = playback.hasTrack;
    playback = { hasTrack: !!d.hasTrack, playing: !!d.playing };
    if (was !== playback.hasTrack) renderMini();
  }

  document.querySelectorAll("#dock iframe").forEach((f) => {
    try { f.contentWindow.postMessage(d, "*"); } catch (err) { /* ignore */ }
  });
});

// ---- boot ------------------------------------------------------------------
wireDrawer();
wireSettings();
wireScenes();
wireNative();
wirePhone();
// Leaving full screen: a chip in the top bar, the one strip a native view can
// never cover.
(() => {
  const x = $("#focus-exit");
  x.addEventListener("pointerdown", (e) => e.stopPropagation());
  x.addEventListener("pointerup", (e) => { e.stopPropagation(); clearFocus(); });
})();
slotWatch.observe($("#appframe"));
$("#dock").addEventListener("scroll", scheduleLayout, { passive: true });
setApp(state.app);
renderDock();
window.addEventListener("resize", () => { renderDock(); scheduleLayout(); });
