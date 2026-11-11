// ============================================================================
//  Jarvis's binary tool: looking inside files that aren't text. Read-only.
//
//  info:    what a file is (from its first bytes, not its name), size,
//           SHA-256, and the details of known kinds: Windows programs and
//           DLLs (PE: machine, 32/64-bit, .NET or native, sections, entry
//           point, version info), zip-family archives (zip, jar, nupkg,
//           docx/xlsx, apk), Unity bundles, images, GGUF models and more.
//  pe:      a Windows EXE/DLL in depth: headers, sections, imports, exports,
//           version strings, .NET runtime.
//  hex:     a hex dump of any part (offset, length).
//  strings: the readable text inside (ASCII and UTF-16), with offsets, a
//           filter, and a range.
//  search:  find text (ASCII and UTF-16) or a byte pattern ("4D 5A ?? 00")
//           and get every offset, with the bytes around it.
//  zip:     the files inside a zip-family archive.
//  compare: two files: same or not, and where they differ.
//
//  Big files are read in pieces, never whole. Nothing is ever written.
// ============================================================================
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const F = require("./assistant-files");

const CHUNK = 4 * 1024 * 1024;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(Math.max(0, len));
  const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
  return buf.subarray(0, bytesRead);
}
function num(v, dflt) {
  if (v == null || v === "") return dflt;
  if (typeof v === "number") return Math.max(0, Math.floor(v));
  const s = String(v).trim().toLowerCase();
  const n = /^0x[0-9a-f]+$/.test(s) ? parseInt(s, 16) : /^[0-9a-f]+h$/.test(s) ? parseInt(s, 16) : Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
const hex = (n, w) => "0x" + Number(n).toString(16).toUpperCase().padStart(w || 0, "0");

// ---- what is it ---------------------------------------------------------------------
const MAGIC = [
  [[0x4d, 0x5a], "Windows program or DLL (PE/MZ)", "pe"],
  [[0x7f, 0x45, 0x4c, 0x46], "Linux/ELF executable"],
  [[0xcf, 0xfa, 0xed, 0xfe], "macOS Mach-O executable (64-bit)"],
  [[0xca, 0xfe, 0xba, 0xbe], "Java class file or macOS universal binary"],
  [[0x50, 0x4b, 0x03, 0x04], "Zip archive (also jar, apk, nupkg, docx/xlsx/pptx, vsix)", "zip"],
  [[0x50, 0x4b, 0x05, 0x06], "Zip archive (empty)", "zip"],
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "7-Zip archive"],
  [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], "RAR archive"],
  [[0x1f, 0x8b], "gzip compressed"],
  [[0x42, 0x5a, 0x68], "bzip2 compressed"],
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], "xz compressed"],
  [[0x28, 0xb5, 0x2f, 0xfd], "zstd compressed"],
  [[0x25, 0x50, 0x44, 0x46], "PDF document"],
  [[0x89, 0x50, 0x4e, 0x47], "PNG image"],
  [[0xff, 0xd8, 0xff], "JPEG image"],
  [[0x47, 0x49, 0x46, 0x38], "GIF image"],
  [[0x42, 0x4d], "BMP image (or something starting with BM)"],
  [[0x00, 0x00, 0x01, 0x00], "Windows icon (.ico)"],
  [[0x49, 0x44, 0x33], "MP3 audio (ID3 tag)"],
  [[0x4f, 0x67, 0x67, 0x53], "Ogg audio/video"],
  [[0x66, 0x4c, 0x61, 0x43], "FLAC audio"],
  [[0x1a, 0x45, 0xdf, 0xa3], "Matroska/WebM video"],
  [[0x00, 0x61, 0x73, 0x6d], "WebAssembly module"],
  [[0x47, 0x47, 0x55, 0x46], "GGUF model (llama.cpp)", "gguf"],
  [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], "SQLite database"],
  [[0x55, 0x6e, 0x69, 0x74, 0x79, 0x46, 0x53], "Unity asset bundle (UnityFS)", "unityfs"],
  [[0x55, 0x6e, 0x69, 0x74, 0x79, 0x57, 0x65, 0x62], "Unity web bundle"],
  [[0x4d, 0x53, 0x43, 0x46], "Windows cabinet (.cab)"],
  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "Old Office / MSI (OLE compound file)"],
  [[0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], "Windows shortcut (.lnk)"],
  [[0xef, 0xbb, 0xbf], "Text (UTF-8 with BOM)"],
  [[0xff, 0xfe], "Text (UTF-16 LE) or something starting FF FE"],
];
function sniff(head) {
  for (const [sig, what, kind] of MAGIC) if (head.length >= sig.length && sig.every((b, i) => head[i] === b)) return { what, kind: kind || null };
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF") return { what: "RIFF " + head.toString("latin1", 8, 12).trim() + " (WAV/AVI/WebP)", kind: null };
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") return { what: "MP4/MOV/HEIC (" + head.toString("latin1", 8, 12) + ")", kind: null };
  // Unity serialized .assets: big-endian header, version 9-22 at offset 8.
  if (head.length >= 20 && head.readUInt32BE(8) >= 9 && head.readUInt32BE(8) <= 30 && head.readUInt32BE(0) === 0 && head.readUInt32BE(4) === 0) return { what: "Probably Unity serialized assets (.assets, version " + head.readUInt32BE(8) + ")", kind: null };
  let printable = 0;
  const n = Math.min(head.length, 4096);
  for (let i = 0; i < n; i++) { const c = head[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc0) printable++; }
  if (n && printable / n > 0.97 && !head.subarray(0, n).includes(0)) return { what: "Text (looks like plain text: read it with files/lines)", kind: "text" };
  return { what: "Unknown binary data", kind: null };
}

async function sha256(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p, { highWaterMark: CHUNK }).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

// Shannon entropy of a sample: ~8 = compressed or encrypted, low = sparse/text.
function entropy(buf) {
  if (!buf.length) return 0;
  const c = new Array(256).fill(0);
  for (const b of buf) c[b]++;
  let e = 0;
  for (const x of c) if (x) { const p = x / buf.length; e -= p * Math.log2(p); }
  return Math.round(e * 100) / 100;
}

// ---- PE (Windows EXE/DLL) ---------------------------------------------------------------
const MACHINE = { 0x14c: "x86 (32-bit)", 0x8664: "x64 (64-bit)", 0xaa64: "ARM64", 0x1c0: "ARM", 0x1c4: "ARMv7 Thumb-2", 0x200: "Itanium" };
const SUBSYS = { 1: "native (driver)", 2: "Windows GUI", 3: "console", 9: "Windows CE", 10: "EFI application", 14: "Xbox", 16: "boot application" };
async function parsePE(fh, size, opts) {
  const o = opts || {};
  const head = await readAt(fh, 0, 4096);
  if (head.length < 64 || head[0] !== 0x4d || head[1] !== 0x5a) return { error: "Not a PE file (no MZ header)." };
  const peOff = head.readUInt32LE(0x3c);
  if (peOff + 24 > size) return { error: "MZ header points past the end: a DOS program or a damaged file." };
  const nt = await readAt(fh, peOff, 24 + 240);
  if (nt.toString("latin1", 0, 4) !== "PE\0\0") return { error: "MZ file without a PE header (16-bit DOS program?)." };
  const machine = nt.readUInt16LE(4), nSec = nt.readUInt16LE(6), stamp = nt.readUInt32LE(8), optSize = nt.readUInt16LE(20), chars = nt.readUInt16LE(22);
  const opt = nt.subarray(24);
  const magic = opt.readUInt16LE(0);
  const is64 = magic === 0x20b;
  const r = {
    machine: MACHINE[machine] || hex(machine), bits: is64 ? 64 : 32, dll: !!(chars & 0x2000),
    built: stamp > 315532800 && stamp < 4102444800 ? new Date(stamp * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "timestamp " + hex(stamp) + " (reproducible build hash, not a date)",
    entry: hex(opt.readUInt32LE(16)), imageBase: is64 ? "0x" + opt.readBigUInt64LE(24).toString(16).toUpperCase() : hex(opt.readUInt32LE(28)),
    subsystem: SUBSYS[opt.readUInt16LE(68)] || String(opt.readUInt16LE(68)),
    linker: opt[2] + "." + opt[3], osVersion: opt.readUInt16LE(40) + "." + opt.readUInt16LE(42),
    dllChars: [],
  };
  const dc = opt.readUInt16LE(70);
  for (const [bit, n] of [[0x40, "ASLR"], [0x100, "DEP/NX"], [0x4000, "Control Flow Guard"], [0x20, "high-entropy ASLR"], [0x400, "no SEH"]]) if (dc & bit) r.dllChars.push(n);
  const ddOff = is64 ? 112 : 96;
  const nDirs = Math.min(16, opt.readUInt32LE(ddOff - 4));
  const dir = (i) => (i < nDirs && ddOff + i * 8 + 8 <= opt.length ? { rva: opt.readUInt32LE(ddOff + i * 8), size: opt.readUInt32LE(ddOff + i * 8 + 4) } : { rva: 0, size: 0 });
  // Sections.
  const secBuf = await readAt(fh, peOff + 24 + optSize, nSec * 40);
  r.sections = [];
  for (let i = 0; i < nSec && (i + 1) * 40 <= secBuf.length; i++) {
    const s = secBuf.subarray(i * 40, i * 40 + 40);
    const c = s.readUInt32LE(36);
    r.sections.push({ name: s.toString("latin1", 0, 8).replace(/\0+$/, ""), vaddr: s.readUInt32LE(12), vsize: s.readUInt32LE(8), raw: s.readUInt32LE(20), rawSize: s.readUInt32LE(16), flags: (c & 0x20000000 ? "x" : "-") + (c & 0x40000000 ? "r" : "-") + (c & 0x80000000 ? "w" : "-") });
  }
  const off = (rva) => { for (const s of r.sections) if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return rva - s.vaddr + s.raw; return rva < 4096 ? rva : -1; };
  const cstr = async (rva, max) => { const p = off(rva); if (p < 0 || p >= size) return ""; const b = await readAt(fh, p, max || 256); const z = b.indexOf(0); return b.toString("latin1", 0, z < 0 ? b.length : z); };
  const end = r.sections.reduce((m, s) => Math.max(m, s.raw + s.rawSize), 0);
  if (end && end < size - 512) r.overlay = (size - end) + " bytes after the last section (an installer payload, signature or appended data)";
  const sec = dir(4);
  r.signed = sec.size > 0 ? "has an Authenticode signature block (" + sec.size + " bytes; not verified here)" : "not signed";
  // .NET?
  const clr = dir(14);
  if (clr.rva && clr.size) {
    r.dotnet = { managed: true };
    const ch = await readAt(fh, off(clr.rva), 72);
    if (ch.length >= 16) {
      const mdRva = ch.readUInt32LE(8), flags = ch.readUInt32LE(16);
      r.dotnet.ilOnly = !!(flags & 1); r.dotnet.requires32 = !!(flags & 2);
      const md = await readAt(fh, off(mdRva), 64);
      if (md.length > 16 && md.readUInt32LE(0) === 0x424a5342) { const vl = md.readUInt32LE(12); r.dotnet.runtime = md.toString("latin1", 16, 16 + Math.min(vl, 40)).replace(/\0+$/, ""); }
    }
  }
  // Imports.
  const imp = dir(1);
  r.imports = [];
  if (imp.rva && off(imp.rva) >= 0) {
    const desc = await readAt(fh, off(imp.rva), 20 * 400);
    for (let i = 0; i + 20 <= desc.length && r.imports.length < 400; i += 20) {
      const oft = desc.readUInt32LE(i), nameRva = desc.readUInt32LE(i + 12), ft = desc.readUInt32LE(i + 16);
      if (!nameRva && !oft && !ft) break;
      const dll = await cstr(nameRva, 128);
      const fns = [];
      const thunk = oft || ft;
      if (o.functions && thunk && off(thunk) >= 0) {
        const tb = await readAt(fh, off(thunk), (is64 ? 8 : 4) * 2000);
        for (let k = 0; k + (is64 ? 8 : 4) <= tb.length && fns.length < 2000; k += is64 ? 8 : 4) {
          const v = is64 ? tb.readBigUInt64LE(k) : BigInt(tb.readUInt32LE(k));
          if (v === 0n) break;
          const byOrd = is64 ? (v & 0x8000000000000000n) !== 0n : (v & 0x80000000n) !== 0n;
          if (byOrd) fns.push("#" + Number(v & 0xffffn));
          else { const nm = await cstr(Number(v & 0x7fffffffn) + 2, 128); fns.push(nm); }
        }
      }
      r.imports.push({ dll, fns });
    }
  }
  // Exports.
  const exp = dir(0);
  if (exp.rva && off(exp.rva) >= 0) {
    const e = await readAt(fh, off(exp.rva), 40);
    if (e.length >= 40) {
      const nNames = e.readUInt32LE(24), namesRva = e.readUInt32LE(32);
      r.exports = { name: await cstr(e.readUInt32LE(12), 128), count: e.readUInt32LE(20), names: [] };
      if (off(namesRva) >= 0) {
        const nb = await readAt(fh, off(namesRva), Math.min(nNames, 5000) * 4);
        for (let k = 0; k + 4 <= nb.length; k += 4) r.exports.names.push(await cstr(nb.readUInt32LE(k), 160));
      }
    }
  }
  // Version strings (from the resource section, by their UTF-16 names).
  const rsrc = r.sections.find((s) => s.name === ".rsrc");
  if (rsrc && rsrc.rawSize) {
    const rb = await readAt(fh, rsrc.raw, Math.min(rsrc.rawSize, 8 * 1024 * 1024));
    const at = rb.indexOf(Buffer.from("StringFileInfo", "utf16le"));
    if (at >= 0) {
      const region = rb.subarray(at, Math.min(rb.length, at + 6000));
      r.version = {};
      for (const key of ["CompanyName", "FileDescription", "FileVersion", "ProductName", "ProductVersion", "OriginalFilename", "InternalName", "LegalCopyright", "Comments", "Assembly Version"]) {
        const k = region.indexOf(Buffer.from(key + "\0", "utf16le"));
        if (k < 0) continue;
        let p = k + (key.length + 1) * 2;
        while (p + 1 < region.length && region.readUInt16LE(p) === 0) p += 2;
        let s = "";
        for (; p + 1 < region.length; p += 2) { const ch = region.readUInt16LE(p); if (!ch) break; s += String.fromCharCode(ch); if (s.length > 200) break; }
        if (s) r.version[key] = s;
      }
    }
  }
  return r;
}
function peText(r, full) {
  if (r.error) return r.error;
  const L = [];
  L.push(r.machine + ", " + (r.dll ? "DLL" : "program") + ", " + r.subsystem + (r.dotnet ? ", .NET (managed" + (r.dotnet.runtime ? ", runtime " + r.dotnet.runtime : "") + (r.dotnet.ilOnly ? ", IL only" : ", mixed native") + ")" : ", native code"));
  if (r.version && Object.keys(r.version).length) L.push("Version info: " + Object.entries(r.version).map(([k, v]) => k + " = " + v).join(" · "));
  L.push("Built: " + r.built + " · linker " + r.linker + " · min Windows " + r.osVersion + " · entry " + r.entry + " · image base " + r.imageBase);
  L.push("Security: " + (r.dllChars.join(", ") || "none of ASLR/DEP/CFG") + " · " + r.signed);
  if (r.overlay) L.push("Overlay: " + r.overlay);
  L.push("Sections: " + r.sections.map((s) => s.name + " " + s.flags + " " + F.size(s.rawSize)).join(", "));
  if (r.dotnet) L.push(".NET: it can be read back as C#. ILSpy's command line does it: shell run \"dotnet tool install -g ilspycmd\" (needs the .NET SDK; programs install Microsoft.DotNet.SDK.8 if missing), then \"ilspycmd <file> -p -o <folder>\" and read the folder.");
  if (r.imports.length) {
    if (full) L.push("Imports (" + r.imports.length + " DLLs):\n" + r.imports.map((i) => "  " + i.dll + (i.fns.length ? " (" + i.fns.length + "): " + i.fns.slice(0, 200).join(", ") + (i.fns.length > 200 ? ", …" : "") : "")).join("\n"));
    else L.push("Imports from: " + r.imports.map((i) => i.dll).join(", "));
  }
  if (r.exports) {
    L.push("Exports" + (r.exports.name ? " (as " + r.exports.name + ")" : "") + ": " + r.exports.count + " functions" + (r.exports.names.length ? (full ? ":\n  " + r.exports.names.join("\n  ") : ": " + r.exports.names.slice(0, 40).join(", ") + (r.exports.names.length > 40 ? ", … (pe shows them all)" : "")) : ""));
  }
  return L.join("\n");
}

// ---- zip -------------------------------------------------------------------------------
async function zipList(fh, size, max) {
  const tailLen = Math.min(size, 65536 + 22);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return { error: "No zip directory found (not a zip, or damaged)." };
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // Zip64: the locator sits just before the end record.
    const loc = e - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const z64 = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z64.readUInt32LE(0) === 0x06064b50) { count = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdOff = Number(z64.readBigUInt64LE(48)); }
    }
  }
  const cd = await readAt(fh, cdOff, Math.min(cdSize, 64 * 1024 * 1024));
  const out = [];
  let p = 0, total = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const comp = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), method = cd.readUInt16LE(p + 10);
    const utf8 = cd.readUInt16LE(p + 8) & 0x800;
    const name = cd.toString(utf8 ? "utf8" : "latin1", p + 46, p + 46 + nl);
    total += usize;
    if (out.length < max) out.push({ name, size: usize, comp, method: method === 0 ? "stored" : method === 8 ? "deflate" : String(method) });
    p += 46 + nl + xl + cl;
  }
  return { count, total, entries: out };
}

// ---- strings and search, streamed -----------------------------------------------------
async function scan(fh, size, from, to, onChunk, ms) {
  const deadline = Date.now() + (ms || 25000);
  for (let pos = from; pos < to; pos += CHUNK) {
    if (Date.now() > deadline) return false;
    const b = await readAt(fh, pos, Math.min(CHUNK + 4096, to - pos));
    if (onChunk(b, pos, Math.min(CHUNK, to - pos)) === "stop") return true;
  }
  return true;
}

function parsePattern(s) {
  const toks = String(s).trim().split(/[\s,]+/).filter(Boolean);
  if (!toks.length || !toks.every((t) => /^([0-9a-f]{2}|\?\?|\?)$/i.test(t))) return null;
  return toks.map((t) => (t.startsWith("?") ? -1 : parseInt(t, 16)));
}

async function binary(a, ctx) {
  const act = String(a.action || "info");
  const p = F.resolve(a.path, ctx);
  const g = F.guard(p, false);
  if (g) return [g, true];
  const limit = ctx.limit || 12000;
  const st = await F.stat(p);
  if (!st) return ["Nothing at " + p + ".", true];
  if (st.isDirectory()) return [p + " is a folder.", true];
  const title = { info: "Look at", pe: "Look inside", hex: "Hex dump of", strings: "Read the text inside", search: "Search inside", zip: "List what's in", compare: "Compare" }[act] || "Look at";
  if (!(await ctx.ask({ tool: "binary", action: act, write: false, title: title + " " + path.basename(p), path: p, detail: F.size(st.size) }))) return ["The user said no.", true];
  const size = st.size;
  const fh = await fsp.open(p, "r");
  ctx.cwd = path.dirname(p);
  try {
    if (act === "info") {
      const head = await readAt(fh, 0, 8192);
      const t = sniff(head);
      const L = [p, "Size: " + F.size(size) + " (" + size + " bytes) · changed " + new Date(st.mtimeMs).toLocaleString("en-US"), "Kind: " + t.what + (path.extname(p) ? " · extension " + path.extname(p) : "")];
      L.push("Entropy of the first 64 KB: " + entropy(await readAt(fh, 0, 65536)) + " bits/byte (near 8 = compressed or encrypted)");
      if (size <= 2 * 1024 * 1024 * 1024) L.push("SHA-256: " + (await sha256(p)));
      if (t.kind === "pe") L.push("", peText(await parsePE(fh, size, {}), false));
      if (t.kind === "zip") { const z = await zipList(fh, size, 25); if (!z.error) L.push("", z.count + " files inside (" + F.size(z.total) + " unpacked), first: " + z.entries.map((e) => e.name).join(", ")); }
      if (t.kind === "gguf" && head.length >= 24) L.push("", "GGUF version " + head.readUInt32LE(4) + ", " + Number(head.readBigUInt64LE(8)) + " tensors, " + Number(head.readBigUInt64LE(16)) + " metadata keys");
      if (t.kind === "unityfs") { const z = head.indexOf(0, 8); const ver = head.toString("latin1", 12, Math.min(head.length, 120)).split("\0").filter(Boolean); L.push("", "UnityFS format " + head.readUInt32BE(z + 1) + (ver.length ? ", Unity " + ver.slice(0, 2).join(" / ") : "")); }
      if (t.kind === "text") L.push("", "It's text: lines read shows it.");
      else L.push("", "Next: strings (the readable text in it), hex (offset, length), search (text or bytes)" + (t.kind === "pe" ? ", pe (imports, exports, everything)" : "") + (t.kind === "zip" ? ", zip (every file inside)" : "") + ".");
      return [F.clip(L.join("\n"), limit)];
    }

    if (act === "pe") {
      const r = await parsePE(fh, size, { functions: a.functions !== false });
      return [F.clip(p + "\n" + peText(r, true), Math.max(limit, 20000)), !!r.error];
    }

    if (act === "zip") {
      const z = await zipList(fh, size, Math.min(5000, num(a.max, 400)));
      if (z.error) return [z.error, true];
      const filt = a.filter ? String(a.filter).toLowerCase() : null;
      const rows = z.entries.filter((e) => !filt || e.name.toLowerCase().includes(filt)).map((e) => e.name + (e.name.endsWith("/") ? "" : "  " + F.size(e.size) + (e.method !== "stored" ? " (" + F.size(e.comp) + " packed)" : "")));
      return [F.clip(p + ": " + z.count + " entries, " + F.size(z.total) + " unpacked" + (filt ? ", matching \"" + a.filter + "\": " + rows.length : "") + "\n" + rows.join("\n") + (z.count > z.entries.length ? "\n… (" + (z.count - z.entries.length) + " more; raise max)" : "") + "\nTo unpack: shell run Expand-Archive (or tar -xf) into a folder.", limit)];
    }

    if (act === "hex") {
      let at = num(a.offset, 0);
      if (a.offset != null && String(a.offset).startsWith("-")) at = Math.max(0, size - Number(String(a.offset).slice(1)));
      const len = Math.min(4096, num(a.length, 256));
      if (at >= size) return ["Offset " + hex(at) + " is past the end (the file is " + size + " bytes, last offset " + hex(size - 1) + ").", true];
      const b = await readAt(fh, at, len);
      const rows = [];
      for (let i = 0; i < b.length; i += 16) {
        const row = b.subarray(i, i + 16);
        const hx = [...row].map((x) => x.toString(16).padStart(2, "0")).join(" ");
        rows.push((at + i).toString(16).toUpperCase().padStart(8, "0") + "  " + hx.padEnd(47) + "  " + [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join(""));
      }
      return [p + " (" + size + " bytes), " + hex(at) + "-" + hex(at + b.length - 1) + ":\n" + rows.join("\n")];
    }

    if (act === "strings") {
      const min = Math.max(3, Math.min(64, num(a.min, 5)));
      const enc = ["ascii", "utf16", "both"].includes(a.encoding) ? a.encoding : "both";
      const max = Math.max(1, Math.min(2000, num(a.max, 200)));
      const from = Math.min(size, num(a.offset, 0)), to = Math.min(size, a.length != null ? from + num(a.length, size) : size);
      let filter = null;
      if (a.filter) { try { filter = new RegExp(a.filter, "i"); } catch (e) { filter = { test: (s) => s.toLowerCase().includes(String(a.filter).toLowerCase()) }; } }
      const hits = [];
      const seen = new Set();
      let total = 0;
      const push = (o, s, u) => { if (filter && !filter.test(s)) return; total++; const k = o + ":" + s; if (seen.has(k) || hits.length >= max) return; seen.add(k); hits.push([o, (u ? "u16 " : "") + s.slice(0, 300)]); };
      const done = await scan(fh, size, from, to, (b, pos, own) => {
        if (enc !== "utf16") {
          let s = -1;
          for (let i = 0; i <= b.length; i++) {
            const c = i < b.length ? b[i] : 0;
            const ok = c >= 32 && c < 127 || c === 9;
            if (ok && s < 0) s = i;
            if (!ok && s >= 0) { if (i - s >= min && s < own) push(pos + s, b.toString("latin1", s, i), false); s = -1; }
          }
        }
        if (enc !== "ascii") {
          for (const par of [0, 1]) {
            let s = -1;
            for (let i = par; i + 1 <= b.length; i += 2) {
              const lo = i + 1 < b.length ? b[i] : 0, hi = i + 1 < b.length ? b[i + 1] : 1;
              const ok = hi === 0 && (lo >= 32 && lo < 127 || lo === 9);
              if (ok && s < 0) s = i;
              if (!ok && s >= 0) { if ((i - s) / 2 >= min && s < own) push(pos + s, b.toString("utf16le", s, i), true); s = -1; }
            }
          }
        }
        return hits.length >= max && !filter ? "stop" : null;
      });
      hits.sort((x, y) => x[0] - y[0]);
      const head = p + ": " + (filter ? total + " strings matching " + a.filter : "strings") + " (min " + min + " chars, " + enc + ")" + (from || to < size ? " in " + hex(from) + "-" + hex(to) : "") + (done ? "" : " — stopped early (time); give offset/length") + ":";
      return [F.clip(head + "\n" + hits.map(([o, s]) => hex(o, 8) + "  " + s).join("\n") + (hits.length >= max ? "\n(first " + max + "; narrow with filter, offset/length, or raise max)" : ""), limit)];
    }

    if (act === "search") {
      const max = Math.max(1, Math.min(500, num(a.max, 50)));
      const pat = a.bytes ? parsePattern(a.bytes) : null;
      if (a.bytes && !pat) return ["bytes must be hex pairs separated by spaces, ?? for any byte, e.g. \"4D 5A ?? 00\".", true];
      const text = a.text != null ? String(a.text) : null;
      if (!pat && !text) return ["search needs text or bytes.", true];
      const needles = pat ? [{ pat, label: "bytes" }] : [
        { buf: Buffer.from(text, "utf8"), label: "ascii" },
        ...(a.case_sensitive ? [] : [{ buf: Buffer.from(text.toLowerCase(), "utf8"), label: "ascii", lower: true }, { buf: Buffer.from(text.toUpperCase(), "utf8"), label: "ascii", upper: true }]),
        { buf: Buffer.from(text, "utf16le"), label: "utf16" },
      ];
      const found = new Map();
      const done = await scan(fh, size, 0, size, (b, pos, own) => {
        for (const n of needles) {
          if (n.pat) {
            const P = n.pat;
            for (let i = 0; i + P.length <= b.length && i < own; i++) {
              let ok = true;
              for (let k = 0; k < P.length; k++) if (P[k] >= 0 && b[i + k] !== P[k]) { ok = false; break; }
              if (ok) { found.set(pos + i, "bytes"); if (found.size >= max) return "stop"; }
            }
          } else {
            let i = b.indexOf(n.buf);
            while (i >= 0 && i < own) { if (!found.has(pos + i)) found.set(pos + i, n.label); if (found.size >= max) return "stop"; i = b.indexOf(n.buf, i + 1); }
          }
        }
        // Case-insensitive ASCII beyond all-lower/all-upper: a lowered copy.
        if (text && !a.case_sensitive && !pat) {
          const low = Buffer.from(b.toString("latin1").toLowerCase(), "latin1");
          const nb = Buffer.from(text.toLowerCase(), "latin1");
          let i = low.indexOf(nb);
          while (i >= 0 && i < own) { if (!found.has(pos + i)) found.set(pos + i, "ascii"); if (found.size >= max) return "stop"; i = low.indexOf(nb, i + 1); }
        }
        return null;
      });
      if (!found.size) return ["Not found in " + p + (done ? "" : " (stopped early: a big file)") + "."];
      const offs = [...found.keys()].sort((x, y) => x - y);
      const ctxLen = Math.min(48, num(a.context, 16));
      const rows = [];
      for (const o of offs.slice(0, max)) {
        const s = Math.max(0, o - ctxLen);
        const b = await readAt(fh, s, ctxLen * 2 + 16);
        rows.push(hex(o, 8) + " (" + found.get(o) + ")  " + [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join(""));
      }
      return [F.clip(offs.length + " match" + (offs.length === 1 ? "" : "es") + " in " + p + (offs.length >= max ? " (stopped at " + max + ")" : "") + (done ? "" : " (stopped early: time)") + ":\n" + rows.join("\n") + "\nhex {offset} shows the bytes at one.", limit)];
    }

    if (act === "compare") {
      if (!a.other) return ["compare needs other: the second file.", true];
      const q = F.resolve(a.other, ctx);
      const g2 = F.guard(q, false);
      if (g2) return [g2, true];
      const st2 = await F.stat(q);
      if (!st2 || st2.isDirectory()) return ["No file at " + q + ".", true];
      const fh2 = await fsp.open(q, "r");
      try {
        const ranges = [];
        let diffBytes = 0, cur = null;
        const n = Math.min(size, st2.size);
        const deadline = Date.now() + 25000;
        for (let pos = 0; pos < n; pos += CHUNK) {
          if (Date.now() > deadline) break;
          const x = await readAt(fh, pos, Math.min(CHUNK, n - pos)), y = await readAt(fh2, pos, Math.min(CHUNK, n - pos));
          if (x.equals(y)) { if (cur) { ranges.push(cur); cur = null; } continue; }
          for (let i = 0; i < x.length; i++) {
            if (x[i] !== y[i]) { diffBytes++; if (cur && pos + i <= cur[1] + 16) cur[1] = pos + i; else { if (cur) ranges.push(cur); cur = [pos + i, pos + i]; } }
          }
        }
        if (cur) ranges.push(cur);
        const same = !diffBytes && size === st2.size;
        if (same) return ["The two files are identical (" + size + " bytes)."];
        return [F.clip(path.basename(p) + " " + size + " bytes vs " + path.basename(q) + " " + st2.size + " bytes" + (size !== st2.size ? " (sizes differ by " + Math.abs(size - st2.size) + ")" : "") + ". " + diffBytes + " differing bytes in the shared part, in " + ranges.length + " places:\n" + ranges.slice(0, 100).map(([s, e]) => hex(s, 8) + (e > s ? "-" + hex(e, 8) + " (" + (e - s + 1) + " bytes)" : "")).join("\n") + (ranges.length > 100 ? "\n…" : "") + "\nhex {offset} on each file shows the bytes.", limit)];
      } finally { await fh2.close(); }
    }
    return ["Unknown binary action \"" + act + "\". info, pe, hex, strings, search, zip, compare.", true];
  } finally {
    await fh.close();
  }
}

const TOOL_DEFS = [
  {
    name: "binary", where: "server", core: false,
    description: "Look inside files that aren't text (programs, DLLs, games' data, archives, images, models). Read-only. info (path): what it really is from its bytes, size, SHA-256, entropy, and for Windows EXE/DLL its architecture, .NET or native, version info, sections, imported DLLs; for zips the files inside. pe (path, functions): a Windows EXE/DLL in depth: every import and export, security flags, version strings. strings (path, min, encoding: ascii|utf16|both, filter: text or regex, offset, length, max): the readable text inside, with offsets. search (path, text, case_sensitive; or bytes: \"4D 5A ?? 00\"; max, context): every offset where it appears. hex (path, offset: number, 0x.. or -N from the end; length up to 4096): a hex dump. zip (path, filter, max): the files inside a zip/jar/apk/nupkg/docx. compare (path, other): identical or where they differ. Use it when files or lines says a file is binary.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info", "pe", "strings", "search", "hex", "zip", "compare"] },
        path: { type: "string" }, other: { type: "string" },
        offset: { type: "string", description: "a number, 0x hex, or -N for N bytes from the end" }, length: { type: "integer" },
        min: { type: "integer" }, encoding: { type: "string", enum: ["ascii", "utf16", "both"] }, filter: { type: "string" },
        text: { type: "string" }, bytes: { type: "string" }, case_sensitive: { type: "boolean" }, context: { type: "integer" },
        max: { type: "integer" }, functions: { type: "boolean" },
      },
      required: ["action", "path"],
    },
  },
];

module.exports = { binary, sniff, parsePE, TOOL_DEFS };
