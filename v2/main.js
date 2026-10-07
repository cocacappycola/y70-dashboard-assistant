// ============================================================================
//  Y70 Dashboard — V2 native shell
//
//  V1 ran in a Brave window, which meant every tap on the panel ACTIVATED that
//  window: Windows moved the foreground to it, and whatever game was running
//  lost focus (and with it, mouse capture — which is why the cursor appeared to
//  jump over). No Chromium command-line flag can prevent that, because the
//  browser owns the window.
//
//  So V2 owns the window itself and creates it with `focusable: false`, which on
//  Windows is the WS_EX_NOACTIVATE extended style: "a top-level window created
//  with this style does not become the foreground window when the user clicks
//  it." Taps still arrive as pointer events — they simply never steal focus.
//
//  Everything else is unchanged: this loads the same local server and the same
//  pages V1 used, so there is one copy of the dashboard, not two.
// ============================================================================
const { app, BrowserWindow, WebContentsView, screen, ipcMain, Tray, Menu,
        nativeImage, shell, session } = require("electron");
const path = require("path");
const net = require("net");
const fs = require("fs");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");
const forks = require("./forks");

// Where the dashboard's pages and server live. When packaged they are copied
// in as an extraResource, because __dirname points inside app.asar and the
// parent folder no longer exists on the user's machine.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "dashboard")
  : path.join(__dirname, "..");
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "build", "icon.ico")
  : path.join(__dirname, "build", "icon.ico");
const TRAY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "build", "tray.png")
  : path.join(__dirname, "build", "tray.png");

// Same override the server takes, so a second copy can be run beside the live
// panel without the two fighting over one port.
const PORT = Number(process.env.Y70_PORT) || 8888;
const SHELL_URL = "http://127.0.0.1:" + PORT;

// Without this Windows groups the window under "Electron" and shows Electron's
// icon in the taskbar and notifications instead of ours.
app.setAppUserModelId("com.cappy.y70dashboard");

// Which monitor the panel is. 1 matches the .bat's SCREEN=1; "smallest" is the
// fallback, because the Y70 is by far the smallest display attached.
const TARGET_DISPLAY = process.env.Y70_DISPLAY || "smallest";

let win = null;
let authWin = null;
let tray = null;
let serverProc = null;
let keyboardMode = false;
let showInTaskbar = false;
// While this is on the panel refuses to become focusable at all — for when you
// are in a game and want no possibility of losing focus.
let passiveLock = false;
let kbTimer = null;
let unwantedFocusCount = 0;
const KB_TIMEOUT_MS = 60000;

// Off by default on purpose: a taskbar button is a thing you click, and
// clicking it would activate the window — the one behaviour V2 exists to avoid.
// It is here because being able to find the app matters too.
function setShowInTaskbar(on) {
  showInTaskbar = !!on;
  if (win && !win.isDestroyed()) win.setSkipTaskbar(!showInTaskbar);
  updateTray();
  return showInTaskbar;
}

// ---------------------------------------------------------------- server ---
function portOpen() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port: PORT });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    setTimeout(() => done(false), 1200);
  });
}

async function ensureServer() {
  if (await portOpen()) return "already running";
  serverProc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    windowsHide: true,
    // ELECTRON_RUN_AS_NODE makes the bundled Electron binary behave as plain
    // node, so there is no separate Node install to depend on. Y70_DATA is
    // where notes and credentials go: installed, ROOT is under Program Files
    // and nothing may be written there.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", Y70_DATA: app.getPath("userData") },
    stdio: "ignore",
  });
  serverProc.on("exit", () => { serverProc = null; });
  // Wait for it rather than racing it — V1's bug was opening the page too early.
  for (let i = 0; i < 40; i++) {
    if (await portOpen()) return "started";
    await new Promise((r) => setTimeout(r, 250));
  }
  return "failed to start";
}

// ---------------------------------------------------------------- window ---
function pickDisplay() {
  const all = screen.getAllDisplays();
  // Seen empty in practice, which threw on `d.bounds` and left the app with no
  // window at all. Always hand back something with bounds.
  if (!all || !all.length) return screen.getPrimaryDisplay();
  if (/^\d+$/.test(TARGET_DISPLAY)) {
    const i = Number(TARGET_DISPLAY);
    if (all[i]) return all[i];
  }
  const smallest = all.slice().sort((a, b) =>
    (a.bounds.width * a.bounds.height) - (b.bounds.width * b.bounds.height))[0];
  return smallest || screen.getPrimaryDisplay();
}

function createWindow() {
  const d = pickDisplay();
  const b = d.bounds;

  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    // Frameless windows on Windows still get WS_THICKFRAME, an invisible ~8px
    // resize border that extends the window rect past the panel and onto the
    // main monitor — a dead strip that would swallow clicks meant for the game.
    // Turning it off costs only the drop shadow, which a full-bleed panel has
    // no use for anyway.
    thickFrame: false,
    // The whole point of V2. On Windows this is WS_EX_NOACTIVATE.
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // NOT resizable:false here. Electron turns that into min/max size
    // constraints that clamp the window smaller than asked for (682 wide came
    // out 634, and each setBounds only crept closer). It is applied in
    // placeOnPanel() once the real bounds are in place.
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    icon: ICON_PATH,
    title: "Y70 Dashboard",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,

      backgroundThrottling: false,   // the dock keeps updating while unfocused
    },
  });

  // "screen-saver" is the highest ordinary level, so the panel stays visible
  // over a borderless-fullscreen game. (Exclusive-fullscreen games own the
  // whole GPU output and will still cover it — use borderless.)
  win.setAlwaysOnTop(true, "screen-saver");
  win.setMenu(null);

  win.loadURL(SHELL_URL);
  win.once("ready-to-show", () => {
    // showInactive, not show: show() would activate the window once at startup,
    // which is exactly the thing we are here to avoid.
    win.showInactive();
    placeOnPanel();
  });

  // Never let the page navigate away or spawn windows; this is a kiosk.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SHELL_URL)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(SHELL_URL)) return;
    // Never navigate the panel off-site. A sign-in that tries anyway (an older
    // page, or a provider that redirects the top frame) is rerouted into the
    // proper popup rather than silently doing nothing — which is exactly how
    // "Connect Spotify" ended up dead in the first place.
    e.preventDefault();
    if (/^https:\/\/(accounts\.spotify\.com|discord\.com)\//.test(url)) openAuth(url);
  });
  // Last line of defence. WS_EX_NOACTIVATE stops *mouse* activation, but a
  // touchscreen goes through the pointer path, and Chromium itself can call
  // focus() on the window from inside. If the panel is ever focused while
  // keyboard mode is off, hand focus straight back.
  win.on("focus", () => {
    if (keyboardMode) return;
    unwantedFocusCount++;
    setImmediate(() => {
      if (!keyboardMode && win && !win.isDestroyed() && win.isFocused()) win.blur();
    });
  });

  // If the renderer ever dies, come back rather than leaving a black panel.
  win.webContents.on("render-process-gone", () => {
    setTimeout(() => win && !win.isDestroyed() && win.reload(), 1500);
  });
}

// ---------------------------------------------------------------- sign-in ---
// The panel is non-focusable by design, so it can never accept a password.
// Sign-in therefore happens in an ordinary window: framed, focusable, centred on
// the main monitor where the keyboard is. It shares the default session, so the
// tokens it stores land in the same localStorage the panel reads.
function openAuth(url) {
  if (authWin && !authWin.isDestroyed()) {
    authWin.show();
    authWin.focus();
    return { ok: true, reused: true };
  }
  const area = screen.getPrimaryDisplay().workArea;
  const w = 520, h = 780;
  authWin = new BrowserWindow({
    width: w, height: Math.min(h, area.height - 40),
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + Math.max(0, (area.height - h) / 2)),
    title: "Sign in",
    autoHideMenuBar: true,
    alwaysOnTop: true,
    icon: ICON_PATH,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  authWin.setMenu(null);
  authWin.loadURL(url);

  // The dashboard's callback page exchanges the code and then sends itself to
  // the site root. That hop is the signal that sign-in worked.
  const finishOn = (target) => target === SHELL_URL || target === SHELL_URL + "/";
  authWin.webContents.on("will-navigate", (e, target) => {
    if (!finishOn(target)) return;
    e.preventDefault();
    finishAuth();
  });
  authWin.webContents.on("did-navigate", (_e, target) => {
    if (finishOn(target)) finishAuth();
  });
  authWin.on("closed", () => { authWin = null; });
  return { ok: true };
}

function finishAuth() {
  if (authWin && !authWin.isDestroyed()) { authWin.destroy(); }
  authWin = null;
  // Reload so the panel picks up the tokens that were just written.
  if (win && !win.isDestroyed()) win.reload();
}

// ---------------------------------------------------------------- keyboard --
// A non-focusable window cannot receive keystrokes — that is the trade for not
// stealing focus. Notes and the calculator still want a keyboard sometimes, so
// the page can ask for it explicitly and give it back.
function setKeyboardMode(on) {
  if (!win || win.isDestroyed()) return keyboardMode;
  // Passive lock wins over everything: while it is on, nothing can make the
  // panel focusable, however it asks.
  if (on && passiveLock) return keyboardMode;

  keyboardMode = !!on;
  win.setFocusable(keyboardMode);
  if (keyboardMode) win.focus();
  else win.blur();
  win.webContents.send("y70:keyboard-mode", keyboardMode);
  updateTray();

  // Auto-release, so a field that grabbed the keyboard and never gave it back
  // cannot leave the panel focusable forever.
  clearTimeout(kbTimer);
  if (keyboardMode) kbTimer = setTimeout(() => setKeyboardMode(false), KB_TIMEOUT_MS);
  return keyboardMode;
}

// Any keystroke while typing pushes the auto-release back.
function touchKeyboardMode() {
  if (!keyboardMode) return;
  clearTimeout(kbTimer);
  kbTimer = setTimeout(() => setKeyboardMode(false), KB_TIMEOUT_MS);
}

function setPassiveLock(on) {
  passiveLock = !!on;
  if (passiveLock && keyboardMode) setKeyboardMode(false);
  updateTray();
  return passiveLock;
}

// ---------------------------------------------------------------- web apps --
// YouTube and TikTok refuse to be framed (X-Frame-Options / frame-ancestors),
// and <webview> is only available in a top-level frame — the shell mounts apps
// in iframes, so neither works. Instead each site gets a WebContentsView: a real
// browser view parented to the window, which the page positions by reporting
// where its content area is. The toolbar stays as ordinary HTML above it.
const webViews = new Map();          // site key -> WebContentsView

// A phone user agent by default: the panel is 682x2560, so these sites' mobile
// layouts fit it far better than their desktop ones.
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Mobile Safari/537.36";
// Electron's own user agent carries an "Electron/41.x" token, and Snapchat for
// Web reads that and answers "Browser not supported". Everything here is
// Chromium, so say so plainly.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

const WEB_PARTITION = "persist:y70web";

// Snapchat's web client needs the camera and microphone to place a call. With
// no handler at all Electron grants every permission to every page in the
// partition, so this narrows it: media goes to Snapchat and nowhere else, a
// video can still go fullscreen, and a feed gets no say about your location.
const MEDIA_HOSTS = /(^|\.)snapchat\.com$/i;
const ALWAYS_OK = new Set(["fullscreen", "clipboard-sanitized-write"]);
// Picking which speakers a call comes out of belongs with the camera and mic.
const CALL_PERMS = new Set(["media", "speaker-selection"]);

function hostOf(u) {
  try { return new URL(String(u)).hostname; } catch (e) { return ""; }
}
// The handlers name the asking page differently depending on which one fires
// and how early: a request carries securityOrigin and requestingUrl, while the
// first checks of a page arrive with both of those empty and only
// embeddingOrigin filled in. Collect every candidate and let any of them
// match, rather than picking one field and being wrong a quarter of the time.
function askingHosts(wc, details) {
  const d = details || {};
  return [d.requestingUrl, d.securityOrigin, d.embeddingOrigin, d.requestingOrigin,
          wc && wc.getURL()].map(hostOf).filter(Boolean);
}
function webPermission(permission, hosts) {
  if (ALWAYS_OK.has(permission)) return true;
  if (CALL_PERMS.has(permission)) return hosts.some((h) => MEDIA_HOSTS.test(h));
  return false;
}
function guardWebPartition() {
  const sess = session.fromPartition(WEB_PARTITION);
  sess.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(webPermission(permission, askingHosts(wc, details)));
  });
  // getUserMedia consults this before it ever raises a request, so a "no" here
  // fails the call outright with NotAllowedError.
  sess.setPermissionCheckHandler((wc, permission, origin, details) => {
    const hosts = askingHosts(wc, details);
    if (origin) hosts.push(hostOf(origin));
    return webPermission(permission, hosts);
  });
}

// "Open in the app" interstitials and custom-scheme handoffs.
function isAppLink(u) {
  const url = String(u || "");
  if (!/^https?:/i.test(url)) return true;                 // snssdk1233://, tiktok://
  return /(^|\.)onelink\.me\/|snssdk|\/download\/app|app\.link\//i.test(url);
}

function getWebView(site) { return webViews.get(site) || null; }

function makeWebView(site, url, mobile, zoom) {
  const view = new WebContentsView({
    webPreferences: {
      // One persistent partition for all the web apps, so a sign-in sticks and
      // stays separate from the dashboard's own origin.
      partition: WEB_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  view.webContents.setUserAgent(mobile ? MOBILE_UA : DESKTOP_UA);
  // The panel is 682px wide, and Snapchat serves the "download the app" page to
  // anything under 768 CSS pixels. Zooming out widens the CSS viewport without
  // making the view itself any bigger: at 0.8 a 682px panel reports 852px.
  if (zoom && zoom !== 1) {
    const apply = () => { try { view.webContents.setZoomFactor(zoom); } catch (e) {} };
    view.webContents.on("did-finish-load", apply);
    apply();
  }
  view.setBorderRadius && view.setBorderRadius(0);
  view.setVisible(false);
  win.contentView.addChildView(view);
  view.webContents.loadURL(url);
  // Keep target=_blank inside the panel rather than firing up a browser.
  view.webContents.setWindowOpenHandler(({ url: u }) => {
    if (isAppLink(u)) return { action: "deny" };
    view.webContents.loadURL(u);
    return { action: "deny" };
  });
  // TikTok's mobile site answers a swipe or a Down key by trying to bounce you
  // into the phone app: it navigates to snssdk.../onelink.me, which would take
  // the feed away entirely. Cancel those and stay on the page.
  view.webContents.on("will-navigate", (e, u) => { if (isAppLink(u)) e.preventDefault(); });
  view.webContents.on("will-redirect", (e, u) => { if (isAppLink(u)) e.preventDefault(); });
  webViews.set(site, view);
  return view;
}

function placeWebView(site, opts) {
  if (!win || win.isDestroyed()) return { ok: false };
  let view = getWebView(site);
  if (!view) view = makeWebView(site, opts.url, opts.mobile, opts.zoom);
  if (!opts.visible || !opts.rect) {
    view.setVisible(false);
    return { ok: true, visible: false };
  }
  const r = opts.rect;
  view.setBounds({
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)),
  });
  view.setVisible(true);
  return { ok: true, visible: true };
}

function hideAllWebViews() {
  for (const v of webViews.values()) { try { v.setVisible(false); } catch (e) {} }
}

function webAction(site, action, arg) {
  const view = getWebView(site);
  if (!view) return { ok: false, error: "not created" };
  const wc = view.webContents;
  try {
    switch (action) {
      case "back": if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case "forward": if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case "reload": wc.reload(); break;
      case "load": wc.loadURL(String(arg)); break;
      case "scroll":
        wc.executeJavaScript("window.scrollBy({top:" + Number(arg) + ",behavior:'smooth'})").catch(() => {});
        break;
      case "next":
        // Down advances one clip on a virtualised feed (Shorts, TikTok), where
        // scrolling by pixels does nothing.
        wc.focus();
        wc.sendInputEvent({ type: "keyDown", keyCode: "Down" });
        wc.sendInputEvent({ type: "char", keyCode: "Down" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Down" });
        break;
      case "useragent":
        wc.setUserAgent(arg ? MOBILE_UA : DESKTOP_UA);
        wc.reload();
        break;
      case "zoom":
        wc.setZoomFactor(Math.max(0.4, Math.min(1.5, Number(arg) || 1)));
        break;
      case "theater": setTheater(view, !!arg); break;
      case "media": {
        // The page's own <video>: play, pause, toggle, mute, unmute.
        const what = JSON.stringify(String(arg || "toggle"));
        wc.executeJavaScript("(" + MEDIA_JS + ")(" + what + ")").catch(() => {});
        break;
      }
      default: return { ok: false, error: "unknown action" };
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

// ---- Theater: just the video ------------------------------------------------
// Mobile YouTube's player, pinned over the whole view with the page hidden
// behind it, the picture letterboxed (contain) on black. Measured in an
// offscreen window with the panel's phone user agent: the <video> goes from
// 667x375 under the header to the full 682x1100 view.
// removeInsertedCSS does not undo a stylesheet in this Electron (measured, both
// origins: the player stayed 1100 tall), so the rules only apply while <html>
// carries data-y70-theater, and on/off flips that attribute. insertCSS lasts
// for one document: it goes back in after each full load.
const TH = "html[data-y70-theater] ";
const THEATER_CSS = `
${TH}, ${TH}body { background: #000 !important; overflow: hidden !important; }
${TH}#player-container-id, ${TH}.player-container, ${TH}#player, ${TH}#movie_player, ${TH}.html5-video-player {
  position: fixed !important; inset: 0 !important; top: 0 !important; left: 0 !important;
  width: 100vw !important; height: 100vh !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; transform: none !important;
  z-index: 2147483000 !important; background: #000 !important;
}
${TH}.html5-video-container { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; }
${TH}video.html5-main-video, ${TH}#movie_player video {
  position: absolute !important; left: 0 !important; top: 0 !important;
  width: 100% !important; height: 100% !important; object-fit: contain !important;
}`;
// Mobile YouTube starts an autoplayed video muted; a video asked for out loud
// should be heard.
const MEDIA_JS = `function (what) {
  const v = document.querySelector("video");
  const p = document.getElementById("movie_player");
  if (!v) return false;
  if (what === "unmute" || what === "play") { try { p && p.unMute && p.unMute(); } catch (e) {} v.muted = false; }
  if (what === "mute") v.muted = true;
  if (what === "play" || (what === "toggle" && v.paused)) v.play().catch(() => {});
  else if (what === "pause" || what === "toggle") v.pause();
  return true;
}`;
function setTheater(view, on) {
  const wc = view.webContents;
  view.__theater = on;
  const sync = () => {
    if (view.__theater && !view.__theaterCss) {
      view.__theaterCss = true;
      wc.insertCSS(THEATER_CSS, { cssOrigin: "user" }).catch(() => { view.__theaterCss = false; });
    }
    // Off: the player sized itself to the theater; let it measure the page again.
    wc.executeJavaScript("document.documentElement.toggleAttribute('data-y70-theater', " + !!view.__theater + ");" +
      (view.__theater ? "(" + MEDIA_JS + ")('play');" : "setTimeout(() => window.dispatchEvent(new Event('resize')), 50);")).catch(() => {});
  };
  if (!view.__theaterHooked) {
    view.__theaterHooked = true;
    // A full page load drops inserted CSS (and the attribute with it).
    wc.on("did-start-navigation", (_e, _url, inPage, isMain) => { if (isMain && !inPage) view.__theaterCss = false; });
    wc.on("dom-ready", () => { if (view.__theater) sync(); });
  }
  sync();
}

function webState(site) {
  const view = getWebView(site);
  if (!view) return { exists: false };
  const wc = view.webContents;
  return {
    exists: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    zoom: wc.getZoomFactor(),
  };
}

// ------------------------------------------------------------------ pin ----
//  Parks another program's window on the panel and holds it there: Snapchat's
//  call window, a Discord call, anything that has a window of its own. The
//  Win32 work happens in winpin.ps1; this decides where the window goes.
//
//  Every move it makes is SWP_NOACTIVATE. Moving a window the ordinary way
//  activates it, which is exactly the focus theft this whole panel exists to
//  avoid.
const WINPIN_SCRIPT = path.join(ROOT, "winpin.ps1");
const HOLD_MS = 1500;

const pin = {
  proc: null, buf: "", error: null,
  hwnd: null, title: "", process: "",
  rect: null,                 // where the widget wants it, in screen pixels
  shown: false,
  listWaiters: [],
};

function pinSend(obj) {
  if (!pin.proc) return false;
  try { pin.proc.stdin.write(JSON.stringify(obj) + "\n"); return true; }
  catch (e) { return false; }
}

function pinStart() {
  if (pin.proc) return true;
  if (process.platform !== "win32") { pin.error = "Windows only."; return false; }
  if (!fs.existsSync(WINPIN_SCRIPT)) { pin.error = "winpin.ps1 is missing."; return false; }
  pin.error = null;
  const child = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINPIN_SCRIPT,
    "-ParentPid", String(process.pid),
  ], { cwd: ROOT, windowsHide: true });
  pin.proc = child;

  child.stdout.on("data", (d) => {
    pin.buf += d.toString();
    let i;
    while ((i = pin.buf.indexOf("\n")) >= 0) {
      const line = pin.buf.slice(0, i).trim();
      pin.buf = pin.buf.slice(i + 1);
      if (!line) continue;
      try { onPinMessage(JSON.parse(line)); } catch (e) { /* partial or noise */ }
    }
    if (pin.buf.length > 1e6) pin.buf = "";
  });
  child.stderr.on("data", (d) => { pin.error = String(d).slice(0, 300).trim() || pin.error; });
  child.on("error", (e) => { pin.error = e.message; pin.proc = null; });
  child.on("exit", () => { pin.proc = null; pin.buf = ""; });
  return true;
}

function onPinMessage(m) {
  switch (m.type) {
    case "list": {
      const ws = Array.isArray(m.windows) ? m.windows : [];
      for (const fn of pin.listWaiters.splice(0)) fn(ws);
      break;
    }
    case "pinned":
      if (m.ok) { pin.title = m.title || ""; pin.error = null; }
      else { pin.hwnd = null; pin.error = m.error || "could not pin that window"; }
      pinReport();
      break;
    case "gone":
      // The program was closed while pinned. Forget it rather than going on
      // shoving a handle that no longer belongs to anything.
      if (pin.hwnd === m.hwnd) { pin.hwnd = null; pin.title = ""; pinReport(); }
      break;
    case "error": pin.error = m.error; pinReport(); break;
    default: break;
  }
}

function pinState() {
  return {
    running: !!pin.proc,
    hwnd: pin.hwnd,
    title: pin.title,
    process: pin.process,
    error: pin.error,
  };
}
function pinReport() {
  if (win && !win.isDestroyed()) win.webContents.send("y70:pin", pinState());
}

function pinList() {
  if (!pinStart()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const done = (ws) => resolve(ws);
    pin.listWaiters.push(done);
    if (!pinSend({ cmd: "list" })) { pin.listWaiters = pin.listWaiters.filter((f) => f !== done); resolve([]); }
    setTimeout(() => {
      if (pin.listWaiters.includes(done)) {
        pin.listWaiters = pin.listWaiters.filter((f) => f !== done);
        resolve([]);
      }
    }, 5000);
  });
}

function pinSet(hwnd, title, proc) {
  if (!pinStart()) return pinState();
  if (pin.hwnd && pin.hwnd !== hwnd) pinSend({ cmd: "unpin", hwnd: pin.hwnd });
  pin.hwnd = String(hwnd);
  pin.title = title || "";
  pin.process = proc || "";
  pin.shown = false;
  pinSend({ cmd: "pin", hwnd: pin.hwnd });
  return pinState();
}

function pinClear() {
  if (pin.hwnd) pinSend({ cmd: "unpin", hwnd: pin.hwnd });
  pin.hwnd = null; pin.title = ""; pin.process = ""; pin.rect = null; pin.shown = false;
  pinReport();
  return pinState();
}

// The widget reports where its slot is, in the window's own coordinates; only
// this side knows where the window itself is on the desktop.
function pinPlace(opts) {
  if (!pin.hwnd) return { ok: false };
  const visible = !!(opts && opts.visible) && !!(opts && opts.rect);
  if (!visible) {
    if (pin.shown) { pinSend({ cmd: "hide", hwnd: pin.hwnd }); pin.shown = false; }
    return { ok: true, visible: false };
  }
  const b = win.getBounds();
  const r = opts.rect;
  const scr = screen.dipToScreenRect(win, {
    x: Math.round(b.x + r.x), y: Math.round(b.y + r.y),
    width: Math.max(80, Math.round(r.width)), height: Math.max(60, Math.round(r.height)),
  });
  pin.rect = scr;
  if (!pin.shown) { pinSend({ cmd: "show", hwnd: pin.hwnd }); pin.shown = true; }
  pinSend({ cmd: "move", hwnd: pin.hwnd, x: scr.x, y: scr.y, w: scr.width, h: scr.height, topmost: true });
  return { ok: true, visible: true };
}

// Windows lets anything move a window, including the program that owns it, so
// keep putting it back.
setInterval(() => {
  if (pin.hwnd && pin.rect && pin.shown) {
    pinSend({ cmd: "move", hwnd: pin.hwnd, x: pin.rect.x, y: pin.rect.y,
              w: pin.rect.width, h: pin.rect.height, topmost: true });
  }
}, HOLD_MS).unref();

// ---------------------------------------------------------------- update ----
// Reads GitHub Releases. The repo is public, so no token is needed anywhere and
// nothing sensitive ships in the installer.
//
// `fork` is the fork the pending download belongs to: this build's own fork for
// an ordinary update, the other one while a switch is under way.
let updateState = { status: "idle", version: null, percent: 0, error: null, notes: null, fork: null };

function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send("y70:update", updateState);
  updateTray();
}

// ------------------------------------------------------------ fork switch ---
// Switching forks is an update from a different feed. Two things make that
// work in both directions:
//
//  - electron-updater only installs a release NEWER than the running build, and
//    two forks' version numbers have nothing to do with each other (Jarvis is
//    3.x, Main is 2.x). So while switching, the updater is told this build is
//    0.0.0 and whatever the other fork's latest release is counts as newer.
//    It has to be a SemVer object from electron-updater's own copy of semver —
//    a plain string throws "format is not a function".
//  - Its differential download reuses blocks of the installed build, located by
//    this build's version on the target feed. That file does not exist on the
//    other fork's releases, so download the whole installer.
//
// Install-on-quit is turned off for the rest of the session the moment a switch
// starts: a switch happens because you pressed the button, never because the
// app happened to restart, and a cancelled one must not come back later.
const OWN_FORK = forks.currentFork();
let switchingTo = null;

// Resolved from electron-updater's own folder, exactly as it resolves it.
function updaterSemver() {
  return require(require.resolve("semver", { paths: [path.dirname(require.resolve("electron-updater"))] }));
}
function realVersion() {
  return updaterSemver().parse(getAppVersion());
}

function forkState() {
  return { ...forks.describe(), switchingTo, packaged: app.isPackaged };
}
function reportForks() {
  if (win && !win.isDestroyed()) win.webContents.send("y70:forks", forkState());
}

function switchFork(id) {
  const target = forks.forkById(String(id));
  if (!target) return { ok: false, error: "unknown fork" };
  if (!app.isPackaged) return { ok: false, error: "Run from source there is nothing to replace." };
  if (OWN_FORK && target.id === OWN_FORK.id) return cancelSwitch();
  if (updateState.status === "downloading" || updateState.status === "checking") {
    return { ok: false, error: "An update is already downloading." };
  }

  switchingTo = target.id;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL(forks.feedFor(target));
  autoUpdater.currentVersion = updaterSemver().parse("0.0.0");
  setUpdate({ status: "checking", error: null, version: null, percent: 0, fork: target.id });
  reportForks();
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true, ...forkState() };
}

function cancelSwitch() {
  if (!switchingTo) return { ok: true, ...forkState() };
  switchingTo = null;
  if (OWN_FORK) autoUpdater.setFeedURL(forks.feedFor(OWN_FORK));
  autoUpdater.currentVersion = realVersion();
  autoUpdater.disableDifferentialDownload = false;
  // A downloaded installer from the other fork may still be on disk; with
  // install-on-quit left off for this session it can only ever run if you
  // press Restart, which the drawer no longer offers for it.
  setUpdate({ status: "idle", error: null, version: null, percent: 0, fork: OWN_FORK ? OWN_FORK.id : null });
  reportForks();
  return { ok: true, ...forkState() };
}

function initUpdater() {
  // Unpackaged there is nothing to replace, and electron-updater throws.
  if (!app.isPackaged) { setUpdate({ status: "dev" }); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  setUpdate({ fork: OWN_FORK ? OWN_FORK.id : null });

  autoUpdater.on("checking-for-update", () => setUpdate({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => setUpdate({
    status: switchingTo ? "error" : "current",
    error: switchingTo ? "That fork has no releases yet." : null,
  }));
  autoUpdater.on("update-available", (i) => setUpdate({ status: "downloading", version: i.version, notes: i.releaseName || null }));
  autoUpdater.on("download-progress", (p) => setUpdate({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => setUpdate({ status: "ready", version: i.version, percent: 100 }));
  autoUpdater.on("error", (e) => setUpdate({ status: "error", error: String(e && e.message || e) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  // A moment after boot so it never competes with the panel coming up, then
  // every six hours. The panel runs for weeks at a time.
  setTimeout(check, 20000);
  const iv = setInterval(check, 6 * 60 * 60 * 1000);
  if (iv.unref) iv.unref();
}

function installUpdate() {
  if (updateState.status !== "ready") return false;
  app.isQuiting = true;
  // false, true = don't force-close other instances, do restart afterwards.
  autoUpdater.quitAndInstall(false, true);
  return true;
}

// ---------------------------------------------------------------- tray -----
// With no frame and no taskbar button, the tray is the only way to quit.

// Native start-at-login: this writes the Run key itself, so V2 needs none of
// V1's Startup-folder shortcut plus VBScript plus batch-file chain.
//
// Unpackaged, Electron writes the entry under the generic name
// "electron.app.Electron" while getLoginItemSettings() looks for the product
// name — so it always reads back false even though the key really was written.
// Packaged, both agree. Trust our own intent while developing, and Windows
// once installed.
let autoStartWanted = false;
function getAutoStart() {
  try {
    const s = app.getLoginItemSettings();
    return app.isPackaged ? !!s.openAtLogin : autoStartWanted;
  } catch (e) { return false; }
}
function setAutoStart(on) {
  autoStartWanted = !!on;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      // Start minimised to the tray; the panel shows itself without activating.
      args: ["--autostart"],
    });
  } catch (e) { /* nothing we can do about a locked-down policy */ }
  updateTray();
  return getAutoStart();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip("Y70 Dashboard" +
    (keyboardMode ? " — keyboard mode (has focus)"
                  : passiveLock ? " — passive, locked" : " — passive (never takes focus)"));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: keyboardMode ? "Keyboard mode: ON (panel has focus)" : "Keyboard mode: off",
      type: "checkbox", checked: keyboardMode, enabled: !passiveLock,
      click: () => setKeyboardMode(!keyboardMode) },
    { label: "Never take focus (lock)", type: "checkbox", checked: passiveLock,
      click: () => setPassiveLock(!passiveLock) },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: getAutoStart(),
      click: () => setAutoStart(!getAutoStart()) },
    { label: "Show in taskbar", type: "checkbox", checked: !!showInTaskbar,
      click: () => setShowInTaskbar(!showInTaskbar) },
    { type: "separator" },
    ...(updateState.status === "ready"
      ? [{ label: switchingTo
             ? "Restart to switch to " + ((forks.forkById(switchingTo) || {}).name || switchingTo)
             : "Restart to update to " + updateState.version,
           click: () => installUpdate() },
         { type: "separator" }]
      : []),
    { label: "Reload", click: () => win && win.reload() },
    { label: "Move to this display",
      click: () => {
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
        win.setResizable(true);
        win.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height });
        win.setResizable(false);
      } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuiting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(TRAY_PATH);
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON_PATH) : img);
  updateTray();
  // Show the menu. This used to toggle keyboard mode, which meant one click on
  // the tray icon quietly made the panel focusable — and from then on every tap
  // stole focus, with nothing but a banner to explain why. Enabling the one
  // mode that defeats the app's whole purpose should never be a stray click.
  tray.on("click", () => tray.popUpContextMenu());
}

// ---------------------------------------------------------------- boot -----
ipcMain.handle("y70:auth", (_e, url) => openAuth(String(url)));
ipcMain.handle("y70:autostart", (_e, on) => (on === undefined ? getAutoStart() : setAutoStart(on)));
ipcMain.handle("y70:taskbar", (_e, on) => (on === undefined ? showInTaskbar : setShowInTaskbar(on)));
ipcMain.handle("y70:keyboard", (_e, on) => setKeyboardMode(on));
ipcMain.handle("y70:keyboard-state", () => keyboardMode);
ipcMain.handle("y70:keyboard-touch", () => { touchKeyboardMode(); return true; });
ipcMain.handle("y70:passive-lock", (_e, on) =>
  (on === undefined ? passiveLock : setPassiveLock(on)));
ipcMain.handle("y70:focus-report", () => ({
  keyboardMode, passiveLock, unwantedFocusCount,
  focusable: win && !win.isDestroyed() ? win.isFocusable() : null,
  focused: win && !win.isDestroyed() ? win.isFocused() : null,
}));
ipcMain.handle("y70:quit", () => { app.isQuiting = true; app.quit(); });
ipcMain.handle("y70:reload", () => { if (win) win.reload(); });
ipcMain.handle("y70:web-place", (_e, site, opts) => placeWebView(String(site), opts || {}));
ipcMain.handle("y70:web-hide-all", () => { hideAllWebViews(); return true; });
ipcMain.handle("y70:web-action", (_e, site, action, arg) => webAction(String(site), String(action), arg));
ipcMain.handle("y70:web-state", (_e, site) => webState(String(site)));
ipcMain.handle("y70:packaged", () => app.isPackaged);
ipcMain.handle("y70:update-state", () => updateState);
ipcMain.handle("y70:update-check", () => {
  if (!app.isPackaged) return { ...updateState, status: "dev" };
  autoUpdater.checkForUpdates().catch(() => {});
  return updateState;
});
ipcMain.handle("y70:update-install", () => installUpdate());
ipcMain.handle("y70:forks", () => forkState());
ipcMain.handle("y70:fork-switch", (_e, id) => switchFork(id));
ipcMain.handle("y70:fork-cancel", () => cancelSwitch());
// app.getVersion() reads our package.json only when Electron loaded this
// folder as the app; from a test harness it hands back Electron's own version
// instead. Read the manifest directly so the drawer never lies about the build.
let appVersion = null;
function getAppVersion() {
  if (appVersion) return appVersion;
  try { appVersion = require(path.join(__dirname, "package.json")).version; }
  catch (e) { appVersion = app.getVersion(); }
  return appVersion;
}
ipcMain.handle("y70:version", () => getAppVersion());
ipcMain.handle("y70:pin-list", () => pinList());
ipcMain.handle("y70:pin-state", () => pinState());
ipcMain.handle("y70:pin-set", (_e, hwnd, title, proc) => pinSet(String(hwnd), title, proc));
ipcMain.handle("y70:pin-clear", () => pinClear());
ipcMain.handle("y70:pin-place", (_e, opts) => pinPlace(opts || {}));
// ---- Screensaver, and the panel over it ------------------------------------------
// Wallpaper Engine's screensaver is an ordinary .scr; "/s" runs it now. It
// opens ONE topmost window across the whole desktop (measured: 4522x2560 over
// both screens), so it covers this panel too. Raising this window
// (setAlwaysOnTop again + moveTop, never activating) puts the panel back above
// it while the main monitor keeps the screensaver — measured with a stand-in
// window: z6 -> z5 over the screensaver, which kept running. Raising on every
// "Jarvis" also covers a screensaver Windows started by itself.
let saver = null;
function screensaverFile() {
  const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const tries = [path.join(sys, "wpxscreensaver64.scr")];
  try {
    // The one chosen in Windows' settings, if any.
    const out = require("child_process").execFileSync("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", "SCRNSAVE.EXE"], { encoding: "utf8", windowsHide: true });
    const m = out.match(/SCRNSAVE\.EXE\s+REG_SZ\s+(.+)/i);
    if (m && m[1].trim()) tries.push(m[1].trim());
  } catch (e) {}
  tries.push(path.join(sys, "scrnsave.scr"));      // Windows' blank screen
  return tries.find((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }) || null;
}
function screensaverStart() {
  if (saver && saver.exitCode === null) return { ok: true, running: true, already: true };
  const file = screensaverFile();
  if (!file) return { ok: false, error: "no screensaver found" };
  saver = spawn(file, ["/s"], { stdio: "ignore", windowsHide: false });
  const me = saver;
  saver.on("exit", () => { if (saver === me) saver = null; });
  saver.on("error", () => { if (saver === me) saver = null; });
  return { ok: true, running: true, file: path.basename(file) };
}
function screensaverStop() {
  if (saver) { try { saver.kill(); } catch (e) {} saver = null; return { ok: true, running: false }; }
  return { ok: true, running: false, note: "none of ours was running" };
}
function raisePanel() {
  if (!win || win.isDestroyed()) return false;
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop();
  return true;
}
ipcMain.handle("y70:screensaver", (_e, action) =>
  action === "start" ? screensaverStart() : action === "stop" ? screensaverStop() : { ok: true, running: !!(saver && saver.exitCode === null) });
ipcMain.handle("y70:raise", () => raisePanel());

ipcMain.handle("y70:displays", () => screen.getAllDisplays().map((d, i) => ({
  index: i, bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id,
})));

// One instance only — a second launch should just wake the existing panel.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) win.showInactive(); });

  app.whenReady().then(async () => {
    try { autoStartWanted = !!app.getLoginItemSettings().openAtLogin; } catch (e) {}
    await ensureServer();
    guardWebPartition();
    createWindow();
    createTray();
    initUpdater();
    // Displays come and go (the Y70 sleeps with the PC); re-place the window.
    screen.on("display-added", reposition);
    screen.on("display-removed", reposition);
    screen.on("display-metrics-changed", reposition);
  });
}

// Fills the panel exactly. The resizable dance is required: a window that is
// already non-resizable refuses to grow to the size we want.
function placeOnPanel() {
  if (!win || win.isDestroyed()) return;
  const b = pickDisplay().bounds;
  win.setResizable(true);
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  win.setResizable(false);
}

const reposition = () => placeOnPanel();

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  // Give back any window we borrowed before letting go of the helper, or it
  // would be left hidden or stranded on the panel.
  try { if (pin.hwnd) pinSend({ cmd: "unpin", hwnd: pin.hwnd }); } catch (e) {}
  try { if (pin.proc) setTimeout(() => { try { pin.proc.kill(); } catch (e) {} }, 300); } catch (e) {}
  // Only stop the server if we were the ones who started it.
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
});
