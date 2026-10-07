// ============================================================================
//  Jarvis's reach into the web — search, images, reading a page, weather.
//
//  Everything here is key-less, so it costs nothing and works the same for
//  Claude and for the local model:
//    web search  DuckDuckGo's HTML endpoint (lite as a fallback)
//    images      Bing Images' result markup, Wikimedia Commons as a fallback
//                (DuckDuckGo's image API answers scripts with a 403)
//    pages       fetched and boiled down to their readable text
//    weather     Open-Meteo, the same service the weather app uses
// ============================================================================

const path = require("path");
const { execFile } = require("child_process");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

// ---- ddgs (Python), when it is installed -------------------------------------
// Search engines spot scripted requests by their TLS fingerprint and answer
// them with challenges (DuckDuckGo) or junk (Bing returns pages matching only
// the first word). The ddgs library impersonates real browsers and spreads a
// query over several engines, so it is tried first. Everything below it is the
// fallback for a machine without it.
const DDGS_SCRIPT = path.join(__dirname, "search-ddgs.py");
let ddgsMissingUntil = 0;

function runDdgs(kind, q, n) {
  if (Date.now() < ddgsMissingUntil) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("python", [DDGS_SCRIPT, kind, q, String(n)], { windowsHide: true, timeout: 15000, maxBuffer: 4e6 },
      (err, out) => {
        if (err && !out) {
          // No Python, or no ddgs: stop asking for a while.
          ddgsMissingUntil = Date.now() + 10 * 60 * 1000;
          return resolve(null);
        }
        let j;
        try { j = JSON.parse(out); } catch (e) { return resolve(null); }
        if (j && j.error) {
          if (/ModuleNotFoundError|No module named/.test(j.error)) ddgsMissingUntil = Date.now() + 10 * 60 * 1000;
          return resolve(null);
        }
        resolve(Array.isArray(j) ? j : null);
      });
  });
}

// Yahoo results arrive as r.search.yahoo.com/.../RU=<target>/RK=... redirects.
function unwrapYahoo(u) {
  const m = String(u || "").match(/^https?:\/\/r\.search\.yahoo\.com\/.*?\/RU=([^/]+)\//);
  if (!m) return u;
  try { return decodeURIComponent(m[1]); } catch (e) { return u; }
}

async function searchDdgsText(q, n) {
  const rows = await runDdgs("text", q, n);
  return (rows || []).map((r) => {
    const url = unwrapYahoo(r.href || "");
    return { title: r.title || "", url, snippet: r.body || "", site: hostOf(url) };
  }).filter((r) => /^https?:/.test(r.url));
}
async function searchDdgsNews(q, n) {
  const rows = await runDdgs("news", q, n);
  return (rows || []).map((r) => {
    const url = unwrapYahoo(r.url || "");
    // Dates come as ISO stamps or as "6 hours ago"; keep only the former.
    const date = /^\d{4}-\d\d-\d\d/.test(String(r.date || "")) ? String(r.date).slice(0, 10) : undefined;
    return { title: r.title || "", url, snippet: r.body || "", site: hostOf(url), date, image: r.image || undefined, news: true };
  }).filter((r) => /^https?:/.test(r.url));
}

async function get(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 9000);
  try {
    const res = await fetch(url, {
      method: (opts && opts.method) || "GET",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...((opts && opts.headers) || {}) },
      body: opts && opts.body,
      redirect: "follow",
      signal: ctl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---- HTML helpers ----------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
function decode(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m;
  });
}
// A tag ends at the first ">" that is not inside a quoted attribute. The naive
// /<[^>]+>/ stops early on Wikipedia's data-mw='{..."a>b"...}' attributes and
// leaks JSON into the text.
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const stripTags = (s) => decode(String(s || "").replace(TAG, "")).replace(/\s+/g, " ").trim();

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

// DuckDuckGo sometimes wraps result links in a redirect; unwrap it.
function unwrapDdg(href) {
  let u = decode(href);
  if (u.startsWith("//")) u = "https:" + u;
  try {
    const p = new URL(u);
    if (/duckduckgo\.com$/.test(p.hostname) && p.searchParams.get("uddg")) return p.searchParams.get("uddg");
  } catch (e) {}
  return u;
}

// ---- web search ------------------------------------------------------------
// Bing first: DuckDuckGo's HTML endpoint is the obvious key-less choice, but it
// starts answering 202 "anomaly" challenges after a handful of queries from one
// address (measured: five test searches were enough). Each engine is tried in
// turn and the first that returns results wins.

// Bing wraps links in trackers: web results carry the real URL in `u` as "a1"
// plus base64url, news results carry it plainly in `url`.
function unwrapBing(href) {
  const u = decode(href);
  try {
    const p = new URL(u);
    if (!/bing\.com$/.test(p.hostname)) return u;
    const enc = p.searchParams.get("u");
    if (enc && enc.startsWith("a1")) {
      return Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
    if (p.searchParams.get("url")) return p.searchParams.get("url");
  } catch (e) {}
  return u;
}

async function searchBing(q, n) {
  const res = await get("https://www.bing.com/search?setlang=en-US&cc=US&q=" + encodeURIComponent(q),
    { headers: { Accept: "text/html" } });
  const html = await res.text();
  const out = [];
  for (const b of html.split('class="b_algo"').slice(1)) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = unwrapBing(a[1]);
    if (!/^https?:/.test(url)) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: stripTags(a[2]), url, snippet: stripTags(p && p[1]).replace(/^\S+ · /, ""), site: hostOf(url) });
    if (out.length >= n) break;
  }
  return out;
}

async function searchDdg(q, n) {
  const res = await get("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q, kl: "us-en" }).toString(),
  });
  if (res.status !== 200) return [];                      // 202 = challenge page
  const html = await res.text();
  const out = [];
  for (const b of html.split(/class="result results_links/).slice(1)) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const url = unwrapDdg(a[1]);
    if (/duckduckgo\.com\/y\.js|ad_provider/.test(url)) continue;     // ads
    out.push({ title: stripTags(a[2]), url, snippet: stripTags(sn && sn[1]), site: hostOf(url) });
    if (out.length >= n) break;
  }
  return out;
}

async function searchDdgLite(q, n) {
  const res = await get("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q }).toString(),
  });
  if (res.status !== 200) return [];
  const html = await res.text();
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snips = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
  return links.slice(0, n).map((m, i) => {
    const url = unwrapDdg(m[1]);
    return { title: stripTags(m[2]), url, snippet: stripTags(snips[i] && snips[i][1]), site: hostOf(url) };
  });
}

// Bing's news feed is RSS meant for feed readers, and unlike its web results it
// is not quietly degraded for scripted requests.
async function searchBingNews(q, n) {
  const res = await get("https://www.bing.com/news/search?format=rss&setlang=en-US&q=" + encodeURIComponent(q));
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => decode(((m[1].match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">")) || [])[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
    const url = unwrapBing(pick("link"));
    const date = pick("pubDate");
    out.push({
      title: stripTags(pick("title")), url, snippet: stripTags(pick("description")), site: hostOf(url),
      date: date ? new Date(date).toISOString().slice(0, 10) : undefined, news: true,
    });
    if (out.length >= n) break;
  }
  return out;
}

async function searchWikipedia(q, n) {
  const j = await (await get("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=" + n +
    "&srsearch=" + encodeURIComponent(q))).json();
  return ((j.query && j.query.search) || []).map((s) => ({
    title: s.title, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(s.title.replace(/ /g, "_")),
    snippet: stripTags(s.snippet), site: "en.wikipedia.org",
  }));
}

// Search engines answer scripts with whatever they like — Bing has returned
// Bible verses for "James Webb Space Telescope latest discovery". So no engine
// is trusted on its own: every result is scored by how many of the query's
// key words it mentions, the ones that miss are dropped, and engines are
// tried in turn until there are enough that hit.
// Words that shape a question but that a good result need not contain.
const STOP = new Set(("the a an and or of in on at to for from with by about is are was were be been what who whom " +
  "when where how why which latest new newest recent recently most did does do me my tell find search show give get any " +
  "some this that these those it its has have had can could would should will just like than then there their " +
  "today tonight yesterday tomorrow week weekend month year now current currently last next won win wins winner " +
  "happened happening update updates news").split(" "));
// Ways a page may spell a word the question used.
const ALIASES = { mount: ["mt"], saint: ["st"], street: ["st"], doctor: ["dr"], formula: ["f1"], f1: ["formula"],
  versus: ["vs"], vs: ["versus"], percent: ["%"], television: ["tv"], tv: ["television"] };
function keyTerms(q) {
  // Two characters are enough when one is a digit: f1, 5g, ps5.
  return [...new Set(String(q).toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w));
}
function relevance(r, terms) {
  if (!terms.length) return 1;
  const hay = (r.title + " " + r.snippet + " " + r.url).toLowerCase();
  const has = (t) => hay.includes(t) || (ALIASES[t] || []).some((a) => new RegExp("\\b" + a.replace(/[^a-z0-9%]/g, "") + "\\b").test(hay));
  return terms.filter(has).length / terms.length;
}
const NEWSY = /\b(latest|news|recent|recently|today|tonight|yesterday|this week|current|currently|score|scores|won|wins|update|announced|released|20\d\d)\b/i;
// The news feed matches every word it is given, and no headline says
// "yesterday", so the time words come out of what it is asked.
const TIMEWORDS = /\b(latest|recent|recently|today|tonight|yesterday|this week|last night|currently|current|news)\b/gi;

async function webSearch(query, count) {
  const n = Math.max(1, Math.min(10, Number(count) || 6));
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "empty query" };
  const terms = keyTerms(q);
  // With few key words each one matters more; with many, half is plenty.
  const bar = terms.length >= 4 ? 0.5 : 0.6;
  // ddgs is flaky about one query in a few ("No results found", then fine on
  // the next try), so it gets a second go before the fallbacks.
  const engines = [["ddgs", searchDdgsText], ["ddgs", searchDdgsText],
    ["bing", searchBing], ["duckduckgo", searchDdg], ["wikipedia", searchWikipedia]];
  if (NEWSY.test(q)) {
    const nq = q.replace(TIMEWORDS, " ").replace(/\s+/g, " ").trim() || q;
    // Bing's feed first: for "who won the F1 race" it had the result itself,
    // where ddgs's news gave loosely related F1 stories.
    engines.unshift(["bing-news", (_q, k) => searchBingNews(nq, k)], ["ddgs-news", (_q, k) => searchDdgsNews(nq, k)]);
  }

  const kept = [], seen = new Set(), used = [], tried = [];
  for (const [name, engine] of engines) {
    if (kept.length >= n) break;
    if (used.includes(name)) continue;            // the retry is only for a miss
    try {
      const got = (await engine(q, n + 4)).filter((r) => !seen.has(r.url) && relevance(r, terms) >= bar);
      if (!got.length) { tried.push(name + ": nothing relevant"); continue; }
      used.push(name);
      for (const r of got) { seen.add(r.url); kept.push(r); }
    } catch (e) { tried.push(name + ": " + e.message); }
  }
  if (!kept.length) return { ok: false, error: "no relevant results (" + tried.join("; ") + ")" };
  return { ok: true, query: q, engine: used.join("+"), results: kept.slice(0, n) };
}

// ---- image search ----------------------------------------------------------
async function imageSearch(query, count) {
  const n = Math.max(1, Math.min(12, Number(count) || 6));
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "empty query" };
  const images = [];
  for (const r of (await runDdgs("images", q, n)) || []) {
    if (!r.thumbnail || !r.image) continue;
    images.push({ title: r.title || "", thumb: r.thumbnail, image: r.image, page: r.url || "", site: hostOf(r.url || r.image) });
  }
  if (images.length) return { ok: true, query: q, images: images.slice(0, n) };
  try {
    const res = await get("https://www.bing.com/images/search?form=HDRSC2&first=1&q=" + encodeURIComponent(q));
    const html = await res.text();
    for (const m of html.matchAll(/\sm="(\{[^"]+\})"/g)) {
      let j;
      try { j = JSON.parse(decode(m[1])); } catch (e) { continue; }
      if (!j.turl || !j.murl) continue;
      images.push({ title: decode(j.t || ""), thumb: decode(j.turl), image: decode(j.murl), page: decode(j.purl || ""), site: hostOf(j.purl || j.murl) });
      if (images.length >= n) break;
    }
  } catch (e) { /* fall back */ }

  if (!images.length) {
    try {
      const api = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
        "&gsrnamespace=6&gsrlimit=" + n + "&prop=imageinfo&iiprop=url&iiurlwidth=480&gsrsearch=" + encodeURIComponent(q);
      const j = await (await get(api)).json();
      for (const p of Object.values((j.query && j.query.pages) || {})) {
        const ii = p.imageinfo && p.imageinfo[0];
        if (!ii) continue;
        images.push({ title: p.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""), thumb: ii.thumburl || ii.url, image: ii.url, page: ii.descriptionurl || "", site: "commons.wikimedia.org" });
      }
    } catch (e) {
      return { ok: false, error: "image search failed: " + e.message };
    }
  }
  if (!images.length) return { ok: false, error: "no images" };
  return { ok: true, query: q, images };
}

// ---- reading a page ----------------------------------------------------------
// A small readability pass: drop the chrome, keep headings, paragraphs and list
// items, and cap the length so a summary request does not ship a novel.
async function readPage(url, maxChars) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return { ok: false, error: "bad url" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "only http(s) pages" };
  // Never let a page the model chose reach into this machine.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$|0\.)/.test(u.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) {
    return { ok: false, error: "local addresses are off limits" };
  }
  const cap = Math.max(1000, Math.min(20000, Number(maxChars) || 8000));
  let res;
  try { res = await get(u.href, { timeout: 12000 }); } catch (e) { return { ok: false, error: "fetch failed: " + e.message }; }
  if (!res.ok) return { ok: false, error: "HTTP " + res.status };
  const type = res.headers.get("content-type") || "";
  if (!/html|text\/plain/.test(type)) return { ok: false, error: "not a readable page (" + type.split(";")[0] + ")" };
  let html = await res.text();
  if (/text\/plain/.test(type)) return { ok: true, url: res.url, title: hostOf(res.url), text: html.slice(0, cap), truncated: html.length > cap };

  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const ogImage = decode((html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "");
  html = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template|table|figure)\b[\s\S]*?<\/\1>/gi, " ");
  const main = (html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || html;
  const parts = [];
  for (const m of main.matchAll(/<(h[1-4]|p|li|blockquote|pre)\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/\1>/gi)) {
    const t = stripTags(m[2]);
    if (t.length < 2) continue;
    parts.push(/^h/i.test(m[1]) ? "\n## " + t : (m[1].toLowerCase() === "li" ? "- " + t : t));
  }
  let text = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 200) text = stripTags(main);
  return { ok: true, url: res.url, title, image: ogImage || null, text: text.slice(0, cap), truncated: text.length > cap };
}

// ---- weather ---------------------------------------------------------------
const WMO = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers", 81: "rain showers",
  82: "violent rain showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
  96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

async function geocode(place) {
  const j = await (await get("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
    encodeURIComponent(place))).json();
  const r = j.results && j.results[0];
  if (!r) return null;
  return { name: [r.name, r.admin1, r.country_code].filter(Boolean).join(", "), lat: r.latitude, lon: r.longitude };
}

async function weather(place, days, home) {
  let loc = null;
  if (place && String(place).trim()) loc = await geocode(String(place).trim());
  if (!loc && home && home.lat != null) loc = home;
  if (!loc) return { ok: false, error: place ? "couldn't find " + place : "no home location set" };
  // Never fewer than three: asked about "tomorrow", a model will happily request
  // one day — which is today — and read today's forecast out as tomorrow's.
  const d = Math.max(3, Math.min(7, Number(days) || 3));
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=" + d;
  const j = await (await get(url)).json();
  if (!j.current) return { ok: false, error: "no forecast" };
  const c = j.current;
  return {
    ok: true,
    place: loc.name,
    units: { temp: "°F", wind: "mph" },
    now: {
      temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m),
      sky: WMO[c.weather_code] || "unknown", code: c.weather_code, day: !!c.is_day,
    },
    days: (j.daily.time || []).map((t, i) => ({
      day: i === 0 ? "today" : i === 1 ? "tomorrow" : new Date(t + "T12:00").toLocaleDateString("en-US", { weekday: "long" }),
      date: t,
      sky: WMO[j.daily.weather_code[i]] || "unknown",
      code: j.daily.weather_code[i],
      high: Math.round(j.daily.temperature_2m_max[i]),
      low: Math.round(j.daily.temperature_2m_min[i]),
      rain: j.daily.precipitation_probability_max[i],
      sunrise: (j.daily.sunrise[i] || "").slice(11), sunset: (j.daily.sunset[i] || "").slice(11),
    })),
  };
}

// ---- YouTube ---------------------------------------------------------------------
// YouTube's own results page, key-less: the list is in the page as
// `var ytInitialData = {...}` (measured: ~1.4 MB, 0.8 s, videoRenderer entries
// with id, title, channel, length, views, age).
async function youtubeSearch(query, count) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "nothing to search for" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch("https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&hl=en&gl=US", {
      signal: ctl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    const html = await r.text();
    const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
    if (!m) return { ok: false, error: "YouTube didn't return results (HTTP " + r.status + ")" };
    const data = JSON.parse(m[1]);
    const txt = (x) => x && (x.simpleText || (x.runs || []).map((y) => y.text).join(""));
    const out = [];
    (function walk(o) {
      if (!o || typeof o !== "object" || out.length >= (count || 6)) return;
      if (o.videoRenderer && o.videoRenderer.videoId) {
        const v = o.videoRenderer;
        const live = (v.badges || []).some((b) => /LIVE/i.test(JSON.stringify(b))) || !v.lengthText;
        out.push({
          id: v.videoId, title: txt(v.title), channel: txt(v.ownerText), length: txt(v.lengthText) || (live ? "live" : null),
          views: txt(v.viewCountText) || txt(v.shortViewCountText) || null, age: txt(v.publishedTimeText) || null,
          url: "https://www.youtube.com/watch?v=" + v.videoId,
          image: "https://i.ytimg.com/vi/" + v.videoId + "/hqdefault.jpg",
        });
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(data);
    return out.length ? { ok: true, query: q, results: out } : { ok: false, error: "no videos for " + q };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "YouTube took too long" : e.message };
  } finally { clearTimeout(t); }
}

module.exports = { webSearch, imageSearch, readPage, weather, geocode, hostOf, youtubeSearch };
