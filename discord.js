// ============================================================================
//  Discord RPC  —  real mute / deafen state, current voice channel, who is
//  talking. Zero dependencies.
//
//  The Discord desktop client listens on a local named pipe
//  (\\.\pipe\discord-ipc-0 .. -9). Frames are 4-byte little-endian opcode +
//  4-byte little-endian length + JSON:
//
//      op 0 HANDSHAKE   {v:1, client_id}
//      op 1 FRAME       {cmd, args, evt, nonce}
//      op 2 CLOSE       {code, message}
//      op 3 PING  /  op 4 PONG
//
//  Flow: handshake -> AUTHORIZE (Discord shows an approval popup, hands back a
//  one-time code) -> exchange that code for an access token over HTTPS, which
//  is why a client SECRET is required -> AUTHENTICATE -> subscribe to
//  VOICE_SETTINGS_UPDATE and the speaking events.
//
//  Why this works at all: the `rpc` / `rpc.voice.*` scopes are whitelist-only
//  for public apps, BUT the owner of an application may always authorise it
//  against their own account. Since you create the application yourself, you are
//  the owner. It follows that this setup is personal — the same app id will not
//  work for anyone else.
//
//  Files (both refused by the static server):
//      discord-app.json    {"clientId": "...", "clientSecret": "..."}
//      discord-token.json  written by us; the access/refresh token
// ============================================================================
const net = require("net");
const fs = require("fs");
const path = require("path");
const https = require("https");

const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2, OP_PING = 3, OP_PONG = 4;
const SCOPES = ["rpc", "rpc.voice.read", "rpc.voice.write", "identify"];
// Not actually navigated for RPC, but it must be registered on the application
// and match what the token exchange sends.
const REDIRECT_URI = "http://localhost";

// Where the credentials are kept. The server hands over its writable data
// folder, which is not the folder this code was installed into.
let DATA = __dirname;
const appFile = () => path.join(DATA, "discord-app.json");
const tokenFile = () => path.join(DATA, "discord-token.json");

const dc = {
  clientId: "", clientSecret: "",
  sock: null, connected: false, authed: false,
  fatal: false, tearing: false,
  user: null,
  voice: null,                 // { mute, deaf, inputVolume, outputVolume, inputDevice }
  channel: null,               // { id, name, guild, members: [...] }
  speaking: new Set(),
  error: null,
  authorizing: false,
  nonce: 0,
  pending: new Map(),
  retryTimer: null,
  buf: Buffer.alloc(0),
};

// ---------------------------------------------------------------- config ----
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(appFile(), "utf8"));
    dc.clientId = String(raw.clientId || "").trim();
    dc.clientSecret = String(raw.clientSecret || "").trim();
  } catch (e) { dc.clientId = ""; dc.clientSecret = ""; }
  return !!dc.clientId;
}
const readToken = () => {
  try { return JSON.parse(fs.readFileSync(tokenFile(), "utf8")); } catch (e) { return null; }
};
const writeToken = (t) => {
  try { fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2), "utf8"); } catch (e) {}
};

// ---------------------------------------------------------------- pipe ------
function encode(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function send(op, obj) {
  if (!dc.sock || dc.sock.destroyed) return false;
  try { dc.sock.write(encode(op, obj)); return true; } catch (e) { return false; }
}

// Every command carries a nonce; the reply comes back with the same one.
function cmd(name, args, evt) {
  return new Promise((resolve) => {
    const nonce = String(++dc.nonce);
    const timer = setTimeout(() => {
      dc.pending.delete(nonce);
      resolve({ ok: false, error: "timed out" });
    }, name === "AUTHORIZE" ? 120000 : 8000);   // AUTHORIZE waits on a human
    dc.pending.set(nonce, (msg) => {
      clearTimeout(timer);
      if (msg.evt === "ERROR") resolve({ ok: false, error: (msg.data && msg.data.message) || "error" });
      else resolve({ ok: true, data: msg.data });
    });
    const frame = { cmd: name, args: args || {}, nonce };
    if (evt) frame.evt = evt;
    if (!send(OP_FRAME, frame)) {
      clearTimeout(timer);
      dc.pending.delete(nonce);
      resolve({ ok: false, error: "not connected" });
    }
  });
}

function findPipe(n, cb) {
  if (n > 9) return cb(new Error("Discord is not running (no IPC pipe found)"));
  const sock = net.createConnection("\\\\.\\pipe\\discord-ipc-" + n);
  const fail = () => { sock.removeAllListeners(); sock.destroy(); findPipe(n + 1, cb); };
  sock.once("error", fail);
  sock.once("connect", () => { sock.removeListener("error", fail); cb(null, sock); });
}

function connect() {
  if (dc.sock || !loadConfig()) return;
  dc.error = null;
  findPipe(0, (err, sock) => {
    if (err) { dc.error = err.message; scheduleRetry(); return; }
    dc.sock = sock;
    dc.buf = Buffer.alloc(0);

    sock.on("data", (d) => {
      dc.buf = Buffer.concat([dc.buf, d]);
      while (dc.buf.length >= 8) {
        const op = dc.buf.readInt32LE(0), len = dc.buf.readInt32LE(4);
        if (dc.buf.length < 8 + len) break;
        const body = dc.buf.slice(8, 8 + len).toString("utf8");
        dc.buf = dc.buf.slice(8 + len);
        let msg; try { msg = JSON.parse(body); } catch (e) { continue; }
        handleFrame(op, msg);
      }
    });
    sock.on("close", () => teardown("Discord closed the connection"));
    sock.on("error", (e) => teardown(e.message));

    send(OP_HANDSHAKE, { v: 1, client_id: dc.clientId });
  });
}

// `fatal` marks a configuration problem (bad client id, revoked token) where
// reconnecting on a timer would just spam Discord forever.
function teardown(reason, fatal) {
  const wasTearing = dc.tearing;
  dc.tearing = true;
  if (dc.sock) {
    // Drop the listeners BEFORE destroying. destroy() emits 'close' on a later
    // tick, by which time the re-entrancy guard has already been cleared, and
    // that second pass was overwriting Discord's own message ("Invalid Client
    // ID") with a useless generic one.
    try { dc.sock.removeAllListeners(); } catch (e) {}
    try { dc.sock.destroy(); } catch (e) {}
  }
  dc.sock = null; dc.connected = false; dc.authed = false;
  dc.voice = null; dc.channel = null; dc.speaking.clear();
  dc.pending.forEach((fn) => fn({ evt: "ERROR", data: { message: reason } }));
  dc.pending.clear();
  // Destroying the socket fires its own 'close', which lands back here with a
  // generic message; keep whatever Discord actually told us.
  if (reason && !wasTearing) dc.error = reason;
  if (fatal) dc.fatal = true;
  dc.tearing = false;
  if (!dc.fatal) scheduleRetry();
}

function scheduleRetry() {
  if (dc.retryTimer || dc.fatal) return;
  dc.retryTimer = setTimeout(() => { dc.retryTimer = null; connect(); }, 10000);
  if (dc.retryTimer.unref) dc.retryTimer.unref();
}

function handleFrame(op, msg) {
  if (op === OP_PING) return send(OP_PONG, msg);
  if (op === OP_CLOSE) {
    // 4000 = bad client id, 4009 = invalid token. Both mean the config is wrong,
    // so stop rather than reconnecting every 10s forever.
    const code = msg && msg.code;
    const fatal = code === 4000 || code === 4009;
    return teardown((msg && msg.message) || "closed", fatal);
  }
  if (msg.nonce && dc.pending.has(msg.nonce)) {
    const fn = dc.pending.get(msg.nonce);
    dc.pending.delete(msg.nonce);
    return fn(msg);
  }
  if (msg.cmd === "DISPATCH") return dispatch(msg.evt, msg.data);
}

function dispatch(evt, data) {
  switch (evt) {
    case "READY":
      dc.connected = true;
      dc.error = null;
      resumeAuth();
      break;
    case "VOICE_SETTINGS_UPDATE":
      dc.voice = shapeVoice(data);
      break;
    case "SPEAKING_START":
      if (data && data.user_id) dc.speaking.add(data.user_id);
      break;
    case "SPEAKING_STOP":
      if (data && data.user_id) dc.speaking.delete(data.user_id);
      break;
    case "VOICE_CHANNEL_SELECT":
      // Moved channels (or left). Re-read and re-subscribe.
      refreshChannel();
      break;
    default: break;
  }
}

const shapeVoice = (v) => (!v ? null : {
  mute: !!v.mute,
  deaf: !!v.deaf,
  inputVolume: v.input ? Math.round(v.input.volume) : null,
  outputVolume: v.output ? Math.round(v.output.volume) : null,
  inputDevice: v.input ? v.input.device_id : null,
  mode: v.mode ? v.mode.type : null,
});

// ---------------------------------------------------------------- OAuth -----
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 12000,
    }, (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => {
        let j; try { j = JSON.parse(d); } catch (e) { return reject(new Error("bad token response")); }
        if (r.statusCode !== 200) {
          return reject(new Error(j.error_description || j.error || ("HTTP " + r.statusCode)));
        }
        resolve(j);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const storeToken = (t) => {
  writeToken({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in || 604800) * 1000,
  });
};

// On READY, try to pick up where we left off: authenticate with a stored token,
// refreshing it first if it has expired. Never pops anything up on its own —
// a fresh AUTHORIZE only happens when the user asks for it.
async function resumeAuth() {
  let tok = readToken();
  if (!tok) return;
  if (tok.expires_at && Date.now() > tok.expires_at - 60000 && tok.refresh_token) {
    try {
      const fresh = await postForm("https://discord.com/api/oauth2/token", {
        client_id: dc.clientId, client_secret: dc.clientSecret,
        grant_type: "refresh_token", refresh_token: tok.refresh_token,
      });
      storeToken(fresh);
      tok = readToken();
    } catch (e) { dc.error = "token refresh failed: " + e.message; return; }
  }
  await authenticate(tok.access_token);
}

async function authenticate(accessToken) {
  const r = await cmd("AUTHENTICATE", { access_token: accessToken });
  if (!r.ok) { dc.authed = false; dc.error = r.error; return false; }
  dc.authed = true;
  dc.error = null;
  dc.user = r.data && r.data.user ? { id: r.data.user.id, name: r.data.user.username } : null;
  const vs = await cmd("GET_VOICE_SETTINGS", {});
  if (vs.ok) dc.voice = shapeVoice(vs.data);
  await cmd("SUBSCRIBE", {}, "VOICE_SETTINGS_UPDATE");
  await cmd("SUBSCRIBE", {}, "VOICE_CHANNEL_SELECT");
  await refreshChannel();
  return true;
}

// Full authorise: shows a popup inside Discord that the user must accept.
async function authorize() {
  if (!loadConfig()) return { ok: false, error: "discord-app.json is missing or has no clientId" };
  if (!dc.clientSecret) return { ok: false, error: "clientSecret is required to exchange the code" };
  if (!dc.connected) return { ok: false, error: dc.error || "not connected to Discord" };
  if (dc.authorizing) return { ok: false, error: "already waiting for you to approve it in Discord" };

  dc.authorizing = true;
  try {
    const r = await cmd("AUTHORIZE", { client_id: dc.clientId, scopes: SCOPES });
    if (!r.ok) return { ok: false, error: r.error };
    const code = r.data && r.data.code;
    if (!code) return { ok: false, error: "no code returned" };
    const tok = await postForm("https://discord.com/api/oauth2/token", {
      client_id: dc.clientId, client_secret: dc.clientSecret,
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
    });
    storeToken(tok);
    const ok = await authenticate(tok.access_token);
    return ok ? { ok: true } : { ok: false, error: dc.error || "authenticate failed" };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    dc.authorizing = false;
  }
}

async function refreshChannel() {
  if (!dc.authed) return;
  const r = await cmd("GET_SELECTED_VOICE_CHANNEL", {});
  if (!r.ok || !r.data) { dc.channel = null; dc.speaking.clear(); return; }
  const d = r.data;
  dc.channel = {
    id: d.id,
    name: d.name,
    guild: d.guild_id || null,
    members: (d.voice_states || []).map((v) => ({
      id: v.user && v.user.id,
      name: (v.nick || (v.user && (v.user.global_name || v.user.username)) || "?"),
      mute: !!(v.voice_state && (v.voice_state.mute || v.voice_state.self_mute)),
      deaf: !!(v.voice_state && (v.voice_state.deaf || v.voice_state.self_deaf)),
      me: !!(dc.user && v.user && v.user.id === dc.user.id),
    })),
  };
  // Speaking events are per-channel, so they have to be re-subscribed on a move.
  dc.speaking.clear();
  await cmd("SUBSCRIBE", { channel_id: d.id }, "SPEAKING_START");
  await cmd("SUBSCRIBE", { channel_id: d.id }, "SPEAKING_STOP");
}

// ---------------------------------------------------------------- API ------
function status() {
  const configured = !!dc.clientId;
  return {
    ok: true,
    configured,
    hasSecret: !!dc.clientSecret,
    connected: dc.connected,
    authed: dc.authed,
    authorizing: dc.authorizing,
    user: dc.user,
    voice: dc.voice,
    channel: dc.channel ? {
      ...dc.channel,
      members: dc.channel.members.map((m) => ({ ...m, speaking: dc.speaking.has(m.id) })),
    } : null,
    error: dc.error,
    fatal: dc.fatal,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
  };
}

async function action(name, args) {
  args = args || {};
  switch (name) {
    case "saveConfig": {
      // Written here rather than by hand. The secret goes straight to a file
      // the static server refuses to serve, and is never echoed back to the
      // page — status() only ever reports whether one exists.
      const id = String(args.clientId || "").trim();
      const secret = String(args.clientSecret || "").trim();
      if (!/^\d{17,20}$/.test(id)) {
        return { ok: false, error: "That does not look like a Client ID (17-20 digits)." };
      }
      if (secret.length < 16) {
        return { ok: false, error: "That does not look like a Client Secret." };
      }
      try {
        fs.writeFileSync(appFile(), JSON.stringify({ clientId: id, clientSecret: secret }, null, 2), "utf8");
      } catch (e) {
        return { ok: false, error: "Couldn't write discord-app.json: " + e.message };
      }
      // New credentials deserve a fresh attempt even if the last id was rejected.
      dc.fatal = false;
      dc.error = null;
      teardown(null);
      loadConfig();
      connect();
      return { ok: true };
    }
    case "clearConfig": {
      try { fs.unlinkSync(appFile()); } catch (e) {}
      try { fs.unlinkSync(tokenFile()); } catch (e) {}
      dc.clientId = ""; dc.clientSecret = "";
      dc.fatal = false; dc.error = null;
      teardown(null);
      return { ok: true };
    }
    case "authorize": return authorize();
    case "reconnect":
      dc.fatal = false; dc.error = null;
      teardown(null); connect();
      return { ok: true };
    case "forget":
      try { fs.unlinkSync(tokenFile()); } catch (e) {}
      dc.authed = false; dc.user = null; dc.voice = null; dc.channel = null;
      return { ok: true };
    case "setMute":
    case "setDeaf":
    case "toggleMute":
    case "toggleDeaf": {
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const cur = dc.voice || { mute: false, deaf: false };
      const payload = {};
      if (name === "setMute") payload.mute = !!args.value;
      if (name === "setDeaf") payload.deaf = !!args.value;
      if (name === "toggleMute") payload.mute = !cur.mute;
      if (name === "toggleDeaf") payload.deaf = !cur.deaf;
      // Discord clears mute when you undeafen, and sets it when you deafen;
      // mirror that locally so the buttons don't flicker before the update event.
      const r = await cmd("SET_VOICE_SETTINGS", payload);
      if (!r.ok) return { ok: false, error: r.error };
      dc.voice = shapeVoice(r.data) || dc.voice;
      return { ok: true, voice: dc.voice };
    }
    case "refresh": await refreshChannel(); return { ok: true };

    // ---- for Jarvis: servers, channels, joining and leaving, volumes ----
    // All of these sit under the `rpc` scope the app is already authorised for.
    case "guilds": {
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const r = await cmd("GET_GUILDS", {});
      if (!r.ok) return r;
      return { ok: true, guilds: ((r.data && r.data.guilds) || []).map((g) => ({ id: g.id, name: g.name })) };
    }
    case "channels": {
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const r = await cmd("GET_CHANNELS", { guild_id: String(args.guildId || "") });
      if (!r.ok) return r;
      // type 2 = voice, 13 = stage; the rest are text, categories, forums.
      return {
        ok: true,
        channels: ((r.data && r.data.channels) || []).map((c) => ({ id: c.id, name: c.name, voice: c.type === 2 || c.type === 13 })),
      };
    }
    case "joinVoice":
    case "leaveVoice": {
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const r = await cmd("SELECT_VOICE_CHANNEL", name === "joinVoice"
        ? { channel_id: String(args.channelId || ""), force: true }
        : { channel_id: null });
      if (!r.ok) return r;
      await refreshChannel();
      return { ok: true, channel: dc.channel ? dc.channel.name : null };
    }
    case "setVolumes": {
      // Discord's own sliders: input 0-100, output 0-200.
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const payload = {};
      if (args.input != null) payload.input = { volume: Math.max(0, Math.min(100, Number(args.input))) };
      if (args.output != null) payload.output = { volume: Math.max(0, Math.min(200, Number(args.output))) };
      const r = await cmd("SET_VOICE_SETTINGS", payload);
      if (!r.ok) return r;
      dc.voice = shapeVoice(r.data) || dc.voice;
      return { ok: true, voice: dc.voice };
    }
    case "setUserVoice": {
      // One person's volume (0-200, 100 = normal) or a local mute.
      if (!dc.authed) return { ok: false, error: "not authorised yet" };
      const payload = { user_id: String(args.userId || "") };
      if (args.volume != null) payload.volume = Math.max(0, Math.min(200, Number(args.volume)));
      if (args.mute != null) payload.mute = !!args.mute;
      const r = await cmd("SET_USER_VOICE_SETTINGS", payload);
      return r.ok ? { ok: true } : r;
    }
    default: return { ok: false, error: "unknown action: " + name };
  }
}

function init(dataDir) {
  DATA = dataDir || DATA;
  loadConfig();
  if (dc.clientId) connect();
}

module.exports = {
  init, status, action,
  APP_FILE: appFile, TOKEN_FILE: tokenFile,
  stop() { if (dc.retryTimer) clearTimeout(dc.retryTimer); teardown(null); if (dc.retryTimer) clearTimeout(dc.retryTimer); dc.retryTimer = null; },
};
