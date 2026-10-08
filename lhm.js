// ============================================================================
//  LibreHardwareMonitor, for the PC widget and Jarvis.
//
//  LHM (0.9.x) publishes every sensor it reads on its own little web server —
//  Options > Remote Web Server > Run, port 8085 by default — as one JSON tree
//  at /data.json: computer > hardware (> sub-hardware) > sensor groups >
//  sensors, each sensor with SensorId, Type and Value as a display string
//  ("53.0 °C", "16.5 MB/s", "-"). Its WMI namespace, which pcstats.ps1 still
//  probes, came back empty on 0.9.6 (measured), so this is the way in.
//
//  What LHM can read depends on its driver. Since 0.9.5 that is PawnIO, a
//  separate install; without it LHM still runs and still answers, but the CPU
//  temperature, power and clocks read 0 and the motherboard has no sensors at
//  all. That is told apart from "LHM isn't running" (cpuBlocked), because the
//  fix is different.
//
//  Y70_LHM_URL overrides http://127.0.0.1:8085.
// ============================================================================
const http = require("http");

const BASE = (process.env.Y70_LHM_URL || "http://127.0.0.1:8085").replace(/\/+$/, "");
const FRESH_MS = 1500;          // a read younger than this is reused
const RETRY_MS = 10000;         // after a failure, don't knock again before this

const st = { at: 0, tried: 0, inflight: null, hardware: null, summary: null, error: null };

// "1,234.5 MB/s" / "53,0 °C" / "-" -> [number, unit]
function parseValue(s) {
  const m = /^\s*(-?[\d.,]+)\s*(.*)$/.exec(String(s || ""));
  if (!m) return [null, ""];
  let n = m[1];
  if (n.includes(",") && n.includes(".")) n = n.lastIndexOf(",") > n.lastIndexOf(".") ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
  else if (n.includes(",")) n = n.replace(",", ".");
  const v = parseFloat(n);
  return [Number.isFinite(v) ? v : null, m[2].trim()];
}

// Throughput in MB/s, sizes in their own unit's family, so a consumer can
// compare numbers without reading units.
function norm(v, unit) {
  if (v == null) return v;
  if (unit === "KB/s") return v / 1024;
  if (unit === "B/s") return v / 1048576;
  if (unit === "GB/s") return v * 1024;
  return v;
}
const normUnit = (unit) => (/^(B|KB|GB)\/s$/.test(unit) ? "MB/s" : unit);

function kindOf(id) {
  const m = /^\/([a-z]+)(?:-([a-z]+))?/.exec(id || "");
  if (!m) return "other";
  const k = m[1];
  if (k === "amdcpu" || k === "intelcpu") return "cpu";
  if (k === "gpu") return "gpu";
  if (k === "nvme" || k === "hdd" || k === "ssd" || k === "storage") return "drive";
  if (k === "ram") return "memory";
  if (k === "vram") return "virtual-memory";
  if (k === "nic") return "network";
  if (k === "motherboard" || k === "lpc" || k === "ec") return "motherboard";
  if (k === "battery" || k === "psu") return k;
  return "controller";       // coolers, fan hubs, AIOs (NZXT, Corsair, Aquacomputer...)
}

// The tree, flattened to hardware with their sensors.
function flatten(root) {
  const out = [];
  const walk = (n, hw) => {
    if (n.HardwareId) {
      hw = { name: String(n.Text || "").trim(), id: n.HardwareId, kind: kindOf(n.HardwareId), sensors: [] };
      out.push(hw);
    }
    if (n.SensorId && hw) {
      const [v, u] = parseValue(n.Value);
      const [lo] = parseValue(n.Min);
      const [hi] = parseValue(n.Max);
      hw.sensors.push({
        name: String(n.Text || "").trim(), type: n.Type, id: n.SensorId,
        value: norm(v, u), min: norm(lo, u), max: norm(hi, u), unit: normUnit(u),
      });
    }
    for (const c of n.Children || []) walk(c, hw);
  };
  walk(root, null);
  return out;
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const find = (hw, type, re) => hw && hw.sensors.find((s) => s.type === type && re.test(s.name));
const val = (s) => (s && s.value != null ? s.value : null);
const pos = (s) => (s && s.value > 0 ? s.value : null);

// The readings worth having without asking for the whole tree.
function summarize(hws) {
  const out = {};

  const cpu = hws.find((h) => h.kind === "cpu");
  if (cpu) {
    const temps = cpu.sensors.filter((s) => s.type === "Temperature" && s.value > 0 && s.value < 125);
    const pick = [/Tctl|Tdie/i, /Package/i, /Core.*Average|Average/i, /CCD/i]
      .map((re) => temps.find((s) => re.test(s.name))).find(Boolean) ||
      temps.sort((a, b) => b.value - a.value)[0];
    const power = pos(find(cpu, "Power", /Package/i));
    const clock = pos(find(cpu, "Clock", /^Cores \(Average\)$/i)) ||
      avg(cpu.sensors.filter((s) => s.type === "Clock" && /^Core #\d+$/.test(s.name) && s.value > 0).map((s) => s.value));
    const ccds = temps.filter((s) => /CCD/i.test(s.name)).map((s) => ({ name: s.name, tempC: r1(s.value) }));
    out.cpu = {
      name: cpu.name,
      tempC: pick ? r1(pick.value) : null, tempSensor: pick ? pick.name : null,
      maxTempC: pick ? r1(pick.max) : null,
      powerW: r1(power), clockMHz: clock ? Math.round(clock) : null,
      loadPct: r1(val(find(cpu, "Load", /^CPU Total$/i))),
      ccds: ccds.length ? ccds : undefined,
      // LHM is up and sees the CPU, but its driver isn't loaded: every
      // temperature and power figure on the CPU reads 0.
      blocked: !temps.length && !power,
    };
  }

  // The graphics card that matters: a discrete one over the CPU's own.
  const gpus = hws.filter((h) => h.kind === "gpu");
  const mem = (h) => val(find(h, "SmallData", /^GPU Memory Total$/i)) || 0;
  const gpu = gpus.find((h) => /nvidia/.test(h.id)) || gpus.sort((a, b) => mem(b) - mem(a))[0];
  if (gpu) {
    const fans = gpu.sensors.filter((s) => s.type === "Fan").map((s) => ({ name: s.name, rpm: Math.round(s.value || 0) }));
    const fanPct = gpu.sensors.filter((s) => s.type === "Control").map((s) => s.value || 0);
    out.gpu = {
      name: gpu.name,
      tempC: r1(val(find(gpu, "Temperature", /^GPU Core$/i))),
      hotspotC: r1(val(find(gpu, "Temperature", /Hot ?Spot/i))),
      memoryC: r1(val(find(gpu, "Temperature", /Memory/i))),
      powerW: r1(val(find(gpu, "Power", /Package|^GPU Power$|Board/i)) ?? val(gpu.sensors.find((s) => s.type === "Power"))),
      loadPct: r1(val(find(gpu, "Load", /^GPU Core$/i))),
      coreMHz: pos(find(gpu, "Clock", /^GPU Core$/i)),
      memMHz: pos(find(gpu, "Clock", /^GPU Memory$/i)),
      vramUsedMB: val(find(gpu, "SmallData", /^GPU Memory Used$/i)),
      vramTotalMB: val(find(gpu, "SmallData", /^GPU Memory Total$/i)),
      fans: fans.length ? fans : undefined,
      fanPct: fanPct.length ? Math.round(Math.max(...fanPct)) : undefined,
    };
  }

  out.drives = hws.filter((h) => h.kind === "drive").map((d) => {
    const temp = d.sensors.find((s) => s.type === "Temperature" && !/Warning|Critical/i.test(s.name) && s.value > 0);
    const free = val(find(d, "Data", /^Free Space$/i)), total = val(find(d, "Data", /^Total Space$/i));
    const written = val(find(d, "Data", /^Data Written$/i));
    const warnC = val(find(d, "Temperature", /^Warning/i)) || undefined;
    const type = d.id.split("/")[1];
    // Hard drives report no limit of their own; most are rated to 55-60 °C.
    const hot = temp && (warnC ? temp.value >= warnC - 5 : type === "hdd" ? temp.value >= 55 : temp.value >= 70);
    return {
      name: d.name, type,
      tempC: temp ? r1(temp.value) : null,
      warnC,
      hot: hot || undefined,
      freeGB: free != null ? r1(free) : null, totalGB: total != null ? Math.round(total) : null,
      usedPct: total ? r1(100 - (free / total) * 100) : r1(val(find(d, "Load", /^Used Space$/i))),
      lifePct: val(find(d, "Level", /^(Remaining )?Life$/i)) ?? undefined,
      powerOnHours: val(find(d, "Factor", /^Power On Hours$/i)) ?? undefined,
      writtenTB: written != null ? r1(written / 1000) : undefined,
      readMBps: r1(val(find(d, "Throughput", /^Read Rate$/i))),
      writeMBps: r1(val(find(d, "Throughput", /^Write Rate$/i))),
    };
  });

  // Case and pump fans, and board / coolant temperatures, wherever they hang.
  const boardish = hws.filter((h) => h.kind === "motherboard" || h.kind === "controller");
  out.fans = boardish.flatMap((h) => h.sensors.filter((s) => s.type === "Fan").map((s) => ({ name: s.name, rpm: Math.round(s.value || 0), on: h.name })));
  out.temps = boardish.flatMap((h) => h.sensors.filter((s) => s.type === "Temperature" && s.value > 0 && s.value < 150).map((s) => ({ name: s.name, tempC: r1(s.value), on: h.name })));

  const ram = hws.find((h) => h.kind === "memory");
  if (ram) {
    const used = val(find(ram, "Data", /Used/i)), avail = val(find(ram, "Data", /Available/i));
    out.memory = { usedGB: r1(used), totalGB: used != null && avail != null ? r1(used + avail) : null, loadPct: r1(val(find(ram, "Load", /Memory/i))) };
  }
  return out;
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

function fetchJson() {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + "/data.json", { timeout: 2500 }, (res) => {
      if (res.statusCode === 401) { res.resume(); return reject(new Error("LibreHardwareMonitor's web server asks for a password. Turn off its authentication (Options > Remote Web Server)")); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(BASE + "/data.json answered HTTP " + res.statusCode + "; that isn't LibreHardwareMonitor's web server")); }
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { b += c; if (b.length > 8e6) req.destroy(new Error("answer too large")); });
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("Something on " + BASE + " answered, but not with LibreHardwareMonitor's sensor data")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("LibreHardwareMonitor didn't answer in time")));
    req.on("error", reject);
  });
}

async function refresh() {
  st.tried = Date.now();
  try {
    const root = await fetchJson();
    if (!root || !Array.isArray(root.Children)) throw new Error("Something on " + BASE + " answered, but not with LibreHardwareMonitor's sensor data");
    st.hardware = flatten(root);
    st.summary = summarize(st.hardware);
    st.at = Date.now();
    st.error = null;
  } catch (e) {
    st.error = e.code === "ECONNREFUSED"
      ? "LibreHardwareMonitor isn't running, or its web server is off (Options > Remote Web Server > Run, port 8085)"
      : e.message;
    // Stale readings are worse than none: a temperature from five minutes ago
    // shown as live is a lie.
    if (Date.now() - st.at > 30000) { st.hardware = null; st.summary = null; }
  }
}

// Start a read if the last one is old; never more than one at a time, and a
// failing LHM is knocked on only every RETRY_MS.
function poke() {
  if (st.inflight) return st.inflight;
  const wait = st.error ? RETRY_MS : FRESH_MS;
  if (Date.now() - st.tried < wait) return Promise.resolve();
  st.inflight = refresh().finally(() => { st.inflight = null; });
  return st.inflight;
}

// Fresh readings, waiting for them if need be.
async function read() {
  await poke();
  return state();
}

function state() {
  return {
    ok: !!st.summary, at: st.at || null, url: BASE, error: st.error,
    summary: st.summary, hardware: st.hardware,
  };
}

module.exports = { poke, read, state, parseValue, flatten, summarize };
