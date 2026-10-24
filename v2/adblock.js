// ============================================================================
//  Ad blocking for the web apps' session (YouTube, Shorts, TikTok, Snapchat,
//  whatever Jarvis opens), the way Brave does it: filter lists, matched on
//  every request and applied to every page.
//
//  - The engine is Ghostery's (@ghostery/adblocker-electron) with its
//    "ads and tracking" lists: EasyList, EasyPrivacy, Peter Lowe's, and uBlock
//    Origin's filters / quick fixes / privacy lists. That blocks ad and tracker
//    requests, hides ad slots, and runs uBlock's scriptlets on the page.
//  - adguard-preload.js goes in front of every frame as well: on YouTube the
//    ads come inside its own data, so it strips them before YouTube reads them
//    and runs out anything that still starts. See that file.
//
//  The engine is built from the lists once and kept, compiled, in userData;
//  it is rebuilt in the background when it is a few days old, so a start never
//  waits on the network (the very first one does, ~5 MB of lists).
// ============================================================================
const path = require("path");
const fs = require("fs");
const { app, net, ipcMain } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");

const REFRESH_MS = 3 * 24 * 60 * 60 * 1000;
const stats = { since: Date.now(), requests: 0, redirected: 0, styles: 0, scripts: 0, youtube: 0, youtubeSkipped: 0, youtubeNags: 0, tiktok: 0, lists: null, error: null };
let blocker = null;
let sess = null;
let enginePath = null;

function track(b) {
  // Some of uBlock's scriptlets stop an ad script by throwing on purpose
  // (abort-on-property-read and kin); the engine does not catch the rejected
  // executeJavaScript, which floods the log with unhandled rejections.
  const inject = b.onInjectCosmeticFilters;
  b.onInjectCosmeticFilters = (event, url, msg) => {
    const wc = event.sender;
    if (wc && !wc.__y70quiet) {
      const run = wc.executeJavaScript.bind(wc);
      wc.executeJavaScript = (code, gesture) => run(code, gesture).catch(() => undefined);
      wc.__y70quiet = true;
    }
    return inject(event, url, msg);
  };
  b.on("request-blocked", () => { stats.requests++; });
  b.on("request-redirected", () => { stats.redirected++; });
  b.on("style-injected", () => { stats.styles++; });
  b.on("script-injected", () => { stats.scripts++; });
}

async function build() {
  const t0 = Date.now();
  const b = await ElectronBlocker.fromPrebuiltAdsAndTracking(net.fetch.bind(net));
  await fs.promises.writeFile(enginePath, b.serialize());
  stats.lists = { builtAt: Date.now(), buildMs: Date.now() - t0 };
  return b;
}

function swap(b) {
  if (blocker) { try { blocker.disableBlockingInSession(sess); } catch (e) {} }
  blocker = b;
  track(b);
  b.enableBlockingInSession(sess);
}

// Called once, before any web view is made.
async function start(session) {
  sess = session;
  enginePath = path.join(app.getPath("userData"), "adblock-engine.bin");

  // The guard first and synchronously, so YouTube is covered from the very
  // first page even while the lists are still loading.
  session.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "adguard-preload.js") });
  ipcMain.on("y70:adguard", (_e, kind, n) => {
    const k = { "youtube-data": "youtube", "youtube-skipped": "youtubeSkipped", "youtube-nag": "youtubeNags", "tiktok-feed": "tiktok" }[kind];
    if (k) stats[k] += Math.max(1, Math.min(1000, Number(n) || 1));
  });

  let age = Infinity;
  try {
    const buf = await fs.promises.readFile(enginePath);
    swap(ElectronBlocker.deserialize(buf));
    age = Date.now() - (await fs.promises.stat(enginePath)).mtimeMs;
    stats.lists = { builtAt: Date.now() - age, cached: true };
  } catch (e) { /* no engine yet (or from another version): build one */ }

  if (!blocker) {
    try { swap(await build()); } catch (e) { stats.error = "couldn't load the filter lists: " + e.message; }
  } else if (age > REFRESH_MS) {
    // Out of date: rebuild a minute after start, off the startup path.
    setTimeout(() => build().then(swap).catch((e) => { stats.error = "list refresh failed: " + e.message; }), 60 * 1000);
  }
  setInterval(() => {
    build().then(swap).catch((e) => { stats.error = "list refresh failed: " + e.message; });
  }, REFRESH_MS).unref();
}

function getStats() {
  return { ...stats, active: !!blocker };
}

module.exports = { start, getStats };
