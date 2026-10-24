// ============================================================================
//  Ad guard for the web apps (YouTube, Shorts, TikTok, anything opened in the
//  panel). Runs in every frame of their session, before the page's own code.
//
//  The filter lists (adblock.js: EasyList, uBlock Origin...) block ad servers
//  and hide ad slots on every site. YouTube does not serve its ads from ad
//  servers any more: they come inside its own data, as adPlacements / adSlots /
//  playerAds in the player response and as entries marked
//  adClientParams.isAd in the Shorts feed (uBlock Origin's rules, Oct 2026).
//  So on YouTube this strips them out of that data before YouTube reads it:
//  the page object it starts with, JSON.parse, fetch and XHR. And if one still
//  gets through, the player is blacked out and muted, the skip button pressed
//  and the ad run to its end, so it is never seen or heard. TikTok's sponsored
//  posts come the same way, flagged isAd in its feed data.
//
//  What it removes is reported to the main process (y70:adguard) for counting.
// ============================================================================
const { contextBridge, webFrame, ipcRenderer } = require("electron");

const host = location.hostname;
const site = /(^|\.)(youtube|youtube-nocookie|youtubekids)\.com$/i.test(host) ? "youtube"
  : /(^|\.)tiktok\.com$/i.test(host) ? "tiktok" : null;

// Ad slots on YouTube's pages, desktop and mobile, and the anti-ad-blocker
// notice. #player-ads is left alone on purpose (uBlock exempts it too).
const YOUTUBE_CSS = `
ytd-ad-slot-renderer, ytm-ad-slot-renderer, ad-slot-renderer, ytd-in-feed-ad-layout-renderer,
ytm-promoted-sparkles-web-renderer, ytd-promoted-sparkles-web-renderer, ytm-promoted-video-renderer,
ytd-promoted-video-renderer, ytd-compact-promoted-video-renderer, ytm-companion-ad-renderer,
ytm-companion-slot, ytd-companion-slot-renderer, ytd-action-companion-ad-renderer,
ytd-banner-promo-renderer, ytd-statement-banner-renderer, ytm-statement-banner-renderer,
ytd-brand-video-singleton-renderer, ytd-search-pyv-renderer, ytm-search-pyv-renderer,
ytm-mealbar-promo-renderer, ytd-mealbar-promo-renderer, ytd-primetime-promo-renderer,
ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
ytm-rich-item-renderer:has(ytm-ad-slot-renderer, ad-slot-renderer),
ytd-enforcement-message-view-model, tp-yt-paper-dialog:has(ytd-enforcement-message-view-model),
.ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-text-overlay, .ytp-ad-overlay-slot,
ytm-reel-shelf-renderer:has([aria-label="Sponsored"]) { display: none !important; }
/* If an ad still starts, it is never seen: the picture goes black while the
   guard runs it out. */
.html5-video-player.ad-showing video, .html5-video-player.ad-interrupting video { opacity: 0 !important; }
.html5-video-player.ad-showing .ytp-ad-player-overlay, .html5-video-player.ad-showing .ytp-ad-module,
.html5-video-player.ad-interrupting .ytp-ad-player-overlay { opacity: 0 !important; }
`;

// Every site: the containers ads always come in, whoever serves them. Some
// sites (measured: weather.com) re-insert Google's ads through rotating
// domains no list knows yet (pingprove.com/<random>), so blocking servers is
// not enough; what arrives is still Google's ad frame, an AdSense slot, a
// Taboola or Outbrain widget, an AMP ad. Only well-known ad markers here, so
// no ordinary page element is caught by mistake.
const GENERIC_CSS = `
iframe[id^="google_ads_iframe"], div[id^="google_ads_iframe"], [id^="div-gpt-ad"], [id^="gpt-ad-"],
ins.adsbygoogle, .adsbygoogle, iframe[name^="google_ads_iframe"], iframe[id^="aswift_"], iframe[src*="googlesyndication.com"],
iframe[src*="doubleclick.net"], iframe[src*="amazon-adsystem.com"], iframe[src*="adnxs.com"],
amp-ad, amp-embed[type="taboola"], amp-embed[type="outbrain"], amp-sticky-ad,
[id^="taboola-"], .trc_related_container, .trc_rbox_container, div[data-widget-id^="taboola"],
.OUTBRAIN, .ob-widget, div[data-widget-id^="AR_"][data-src*="outbrain"], .ob-smartfeed-wrapper,
[data-google-query-id]:not(html):not(body), div[aria-label="Advertisement" i], div[aria-label="Ads" i] { display: none !important; }
`;

// --- runs in the page itself (main world): must be self-contained -----------
function guard(site) {
  if (window.__y70adguard) return;
  window.__y70adguard = true;
  const report = (kind, n) => { try { window.postMessage({ __y70adguard: kind, n: n || 1 }, "*"); } catch (e) {} };

  // ---------- YouTube: the ad data ----------
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds", "adBreakHeartbeatParams"];
  // Feed / search / watch-next renderers that are ads.
  const AD_RENDERERS = new Set(["adSlotRenderer", "promotedSparklesWebRenderer", "promotedSparklesTextSearchRenderer",
    "compactPromotedVideoRenderer", "promotedVideoRenderer", "searchPyvRenderer", "bannerPromoRenderer",
    "statementBannerRenderer", "brandVideoSingletonRenderer", "inFeedAdLayoutRenderer", "adSlotAndLayoutRenderer",
    "displayAdRenderer", "mealbarPromoRenderer", "primetimePromoRenderer", "companionAdRenderer", "actionCompanionAdRenderer"]);
  const MARKERS = /"(adPlacements|adSlots|playerAds|adClientParams|adSlotRenderer|promotedSparklesWebRenderer|compactPromotedVideoRenderer|promotedVideoRenderer|searchPyvRenderer|inFeedAdLayoutRenderer|isAd)"/;

  function isAdItem(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    for (const k of Object.keys(x)) {
      if (AD_RENDERERS.has(k)) return true;
      // richItemRenderer / itemSectionRenderer wrappers around an ad
      const v = x[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const c = v.content || v.renderer;
        if (c && typeof c === "object") for (const ck of Object.keys(c)) if (AD_RENDERERS.has(ck)) return true;
      }
    }
    // A Shorts entry that is an ad
    const r = x.command && x.command.reelWatchEndpoint;
    if (r && r.adClientParams && r.adClientParams.isAd) return true;
    return false;
  }

  // Walks a YouTube payload removing ad data in place. Returns how much it took out.
  function prune(o, depth) {
    if (!o || typeof o !== "object" || depth > 60) return 0;
    let n = 0;
    if (Array.isArray(o)) {
      for (let i = o.length - 1; i >= 0; i--) {
        if (isAdItem(o[i])) { o.splice(i, 1); n++; } else n += prune(o[i], depth + 1);
      }
      return n;
    }
    for (const k of AD_KEYS) if (k in o) { if (Array.isArray(o[k]) ? o[k].length : o[k]) n++; delete o[k]; }
    for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object") n += prune(v, depth + 1); }
    return n;
  }

  // ---------- TikTok: sponsored posts in the feed ----------
  function pruneTikTok(o, depth) {
    if (!o || typeof o !== "object" || depth > 12) return 0;
    let n = 0;
    if (Array.isArray(o)) {
      for (let i = o.length - 1; i >= 0; i--) {
        const x = o[i];
        if (x && typeof x === "object" && (x.isAd === true || x.is_ad === true || x.is_ads === true || (x.adInfo && typeof x.adInfo === "object") || (x.ad_info && typeof x.ad_info === "object"))) { o.splice(i, 1); n++; }
        else n += pruneTikTok(x, depth + 1);
      }
      return n;
    }
    for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object") n += pruneTikTok(v, depth + 1); }
    return n;
  }

  const clean = site === "youtube" ? prune : pruneTikTok;
  const kindOf = site === "youtube" ? "youtube-data" : "tiktok-feed";
  const looksAd = site === "youtube" ? (s) => MARKERS.test(s) : (s) => /"(isAd|is_ad|is_ads|adInfo|ad_info)"\s*:/.test(s);
  const cleanObj = (o) => { try { const n = clean(o, 0); if (n) report(kindOf, n); } catch (e) {} return o; };

  // The objects the page starts with, inline in its HTML.
  if (site === "youtube") {
    for (const name of ["ytInitialPlayerResponse", "playerResponse", "ytInitialData", "ytInitialReelWatchSequenceResponse"]) {
      let val;
      try {
        Object.defineProperty(window, name, {
          configurable: true, enumerable: true,
          get() { return val; },
          set(v) { val = v && typeof v === "object" ? cleanObj(v) : v; },
        });
      } catch (e) {}
    }
  }

  // JSON.parse: every payload read from text.
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const out = parse.call(this, text, reviver);
    if (typeof text === "string" && text.length > 40 && out && typeof out === "object" && looksAd(text)) cleanObj(out);
    return out;
  };
  try { Object.defineProperty(JSON.parse, "toString", { value: () => "function parse() { [native code] }" }); } catch (e) {}

  // fetch: responses read with .json() never pass through JSON.parse.
  const rjson = Response.prototype.json;
  Response.prototype.json = async function () {
    const out = await rjson.call(this);
    if (out && typeof out === "object") cleanObj(out);
    return out;
  };
  const rtext = Response.prototype.text;
  Response.prototype.text = async function () {
    const t = await rtext.call(this);
    if (typeof t !== "string" || t.length < 40 || !looksAd(t)) return t;
    try {
      const lead = t.match(/^\)\]\}'\s*/);          // YouTube's anti-JSON-hijacking prefix
      const body = lead ? t.slice(lead[0].length) : t;
      const o = parse(body);
      const n = clean(o, 0);
      if (!n) return t;
      report(kindOf, n);
      return (lead ? lead[0] : "") + JSON.stringify(o);
    } catch (e) { return t; }
  };

  // XHR: the same, for code that still uses it.
  const desc = (p) => Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, p);
  const dText = desc("responseText"), dResp = desc("response");
  const cleanedText = new WeakMap();
  function xhrText(xhr, raw) {
    if (typeof raw !== "string" || raw.length < 40 || !looksAd(raw)) return raw;
    if (cleanedText.has(xhr)) return cleanedText.get(xhr);
    let out = raw;
    try {
      const lead = raw.match(/^\)\]\}'\s*/);
      const o = parse(lead ? raw.slice(lead[0].length) : raw);
      const n = clean(o, 0);
      if (n) { report(kindOf, n); out = (lead ? lead[0] : "") + JSON.stringify(o); }
    } catch (e) {}
    cleanedText.set(xhr, out);
    return out;
  }
  if (dText && dText.get) Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
    configurable: true, get() { const raw = dText.get.call(this); return this.readyState === 4 ? xhrText(this, raw) : raw; },
  });
  if (dResp && dResp.get) Object.defineProperty(XMLHttpRequest.prototype, "response", {
    configurable: true,
    get() {
      const raw = dResp.get.call(this);
      if (this.readyState !== 4) return raw;
      if (typeof raw === "string") return xhrText(this, raw);
      if (raw && typeof raw === "object" && !(raw instanceof ArrayBuffer) && !(raw instanceof Blob)) cleanObj(raw);
      return raw;
    },
  });

  if (site !== "youtube") return;

  // ---------- YouTube: the safety net ----------
  // An ad that got through anyway: muted, skipped, run to its end; its picture
  // is already hidden by the stylesheet. Checked four times a second.
  let mutedByUs = false, lastAd = 0;
  const SKIP = ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button, button[id^='skip-button'], .ytp-ad-skip-button-container button";
  setInterval(() => {
    const player = document.querySelector(".html5-video-player");
    const v = player && player.querySelector("video");
    const ad = player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"));
    if (ad && v) {
      if (Date.now() - lastAd > 3000) report("youtube-skipped");
      lastAd = Date.now();
      if (!v.muted) { v.muted = true; mutedByUs = true; }
      try { v.playbackRate = 16; } catch (e) {}
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.3) { try { v.currentTime = v.duration - 0.1; } catch (e) {} }
      document.querySelectorAll(SKIP).forEach((b) => { try { b.click(); } catch (e) {} });
    } else if (v && mutedByUs && Date.now() - lastAd > 400) {
      mutedByUs = false;
      v.muted = false;
      if (v.playbackRate > 2) v.playbackRate = 1;
    }
    // The "ad blockers are not allowed" dialog pauses the video behind it.
    const nag = document.querySelector("ytd-enforcement-message-view-model");
    if (nag) {
      const dlg = nag.closest("tp-yt-paper-dialog");
      if (dlg) dlg.remove(); else nag.remove();
      document.querySelectorAll("tp-yt-iron-overlay-backdrop").forEach((b) => b.remove());
      if (v && v.paused) v.play().catch(() => {});
      report("youtube-nag");
    }
  }, 250);
}

{
  const sheet = GENERIC_CSS + (site === "youtube" ? YOUTUBE_CSS : "");
  const css = () => { try { webFrame.insertCSS(sheet, { cssOrigin: "user" }); return true; } catch (e) { return false; } };
  if (!css()) window.addEventListener("DOMContentLoaded", css, { once: true });
}

if (site) {
  // In the page, before its own scripts run.
  try { contextBridge.executeInMainWorld({ func: guard, args: [site] }); } catch (e) {}
  // Counts back to the main process.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source === window && d && typeof d.__y70adguard === "string") ipcRenderer.send("y70:adguard", d.__y70adguard, Number(d.n) || 1);
  });
}
