// dice: an example Jarvis tool package in Node. See docs/PACKAGES.md.
//
// Jarvis sends one JSON line per call on stdin and reads one JSON line back
// on stdout with the same id. Nothing else goes to stdout; console.error
// lines land in the package's log.
const readline = require("readline");
const crypto = require("crypto");

// A fair random integer in [1, n].
const die = (n) => crypto.randomInt(1, n + 1);

const tools = {
  roll_dice({ notation = "1d6" }) {
    const m = String(notation).replace(/\s+/g, "").toLowerCase().match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (!m) throw new Error("I read dice like 2d6, d20 or 4d8+3, not \"" + notation + "\"");
    const count = Math.min(100, Number(m[1] || 1)), sides = Number(m[2]), add = Number(m[3] || 0);
    if (sides < 2 || sides > 1000) throw new Error("a die needs 2 to 1000 sides");
    const rolls = Array.from({ length: count }, () => die(sides));
    const total = rolls.reduce((a, b) => a + b, 0) + add;
    const shown = count + "d" + sides + (add ? (add > 0 ? "+" : "") + add : "");
    return count === 1 && !add
      ? "Rolled a d" + sides + ": " + total + "."
      : "Rolled " + shown + ": " + rolls.join(", ") + (add ? " " + (add > 0 ? "+" : "-") + " " + Math.abs(add) : "") + " = " + total + ".";
  },

  flip_coin({ count = 1 }) {
    const n = Math.max(1, Math.min(100, Number(count) || 1));
    const flips = Array.from({ length: n }, () => (die(2) === 1 ? "heads" : "tails"));
    if (n === 1) return "It's " + flips[0] + ".";
    const heads = flips.filter((f) => f === "heads").length;
    return flips.join(", ") + " (" + heads + " heads, " + (n - heads) + " tails).";
  },

  pick_one({ options = [], count = 1 }) {
    const list = options.map(String).filter((s) => s.trim());
    if (!list.length) throw new Error("give me some options to pick from");
    const n = Math.max(1, Math.min(list.length, Number(count) || 1));
    // Fisher-Yates, then take the first n.
    for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return n === 1 ? "I pick: " + list[0] + "." : "I pick: " + list.slice(0, n).join(", ") + ".";
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type !== "call") return;
  try {
    const fn = tools[msg.tool];
    if (!fn) throw new Error("no tool called " + msg.tool);
    const out = await fn(msg.input || {}, msg.context || {});
    send({ type: "result", id: msg.id, content: typeof out === "string" ? out : JSON.stringify(out) });
  } catch (e) {
    send({ type: "result", id: msg.id, content: "Failed: " + e.message, error: true });
  }
});
