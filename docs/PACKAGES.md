# Making tool packages for Jarvis

A **tool package** gives Jarvis new tools without touching the dashboard's
code. It is a folder with a manifest, `jarvis-package.json`, that says what
the tools are, and a program, in any language, that does the work. Jarvis
reads the manifest, offers the tools to his model, and when the model calls
one, sends the call to your program and reads the answer back.

You can make one three ways:

- **Ask Jarvis**: "make me a tool package that converts currencies". He reads
  this guide, starts one from the template, writes the code, tests it (after
  your OK) and asks you to switch it on. Jarvis Code is the best place for
  this, since you see every file he writes.
- **Packages app → New package**: a template in Node or Python, ready to
  fill in. *Edit in Jarvis Code* opens it there.
- **By hand**: copy an example from `packages-examples/` (`dice` in Node,
  `text-tools` in Python) and change it.

Installed packages live in `%APPDATA%\y70-dashboard\jarvis-packages\<name>\`.
The Packages app shows the exact folder.

### Built-in packages

Jarvis's own tools come in packages too, listed in the Packages app's
**Built-in** tab. Switching one off means he is never told about its tools.
Some also follow a Jarvis setting (Files, Command line, Think hard). A package
of your own can't use the name of a built-in tool.

| Package | Tools | What for |
|---|---|---|
| web | web_search, read_page, image_search, open_web | the web |
| weather | weather | forecasts |
| music-video | music, youtube | Spotify and YouTube |
| sound | volume | volume and devices |
| timers | timer, alarm | countdowns, alarms, scheduled tools |
| screen | layout, panel, show, look | the panel, the screen |
| memory | remember, recall, history | memory and past chats |
| pc-info | info | sensors, drives, phone, Discord, usage |
| lights / discord / phone / notes | one each | those things |
| models | find_model, download_model, think_hard | local models |
| files | files, repo | files anywhere, repos and git |
| text-tools | grep, lines | grep with regex and context; read and edit by line number, outlines, multi-edits, regex replace, diffs, tails |
| shell | shell | PowerShell and cmd: run, background jobs, which, a project's tests |
| python | python | Pythons, virtual environments, pip, running code and tests |
| programs | programs | installing software with winget, npm and pip (always asks) |
| coder | write_code | Jarvis Code's second model |
| package-manager | packages | this, always on |

A package you write is a separate program and can't call these tools; it uses
its own language's libraries instead. If what you want is "run this command",
the **shell** tool may already do it, with no package needed.

---

## 1. A package, start to finish

```
jarvis-packages\
  dice\
    jarvis-package.json   what it is: name, tools, how to run it
    index.js              the program
    README.md             for people
    data\                 yours to keep files in (made for you)
```

`jarvis-package.json`:

```json
{
  "name": "dice",
  "version": "1.0.0",
  "description": "Rolls dice, flips coins and picks at random.",
  "author": "Cappy",
  "run": ["node", "index.js"],
  "timeout": 10,
  "guide": "dice rolls, coin flips, picking one of several things at random",
  "tools": [
    {
      "name": "roll_dice",
      "description": "Roll dice. sides: faces per die (default 6). count: how many (default 1). Returns each roll and the total.",
      "input_schema": {
        "type": "object",
        "properties": {
          "sides": { "type": "integer", "minimum": 2, "maximum": 1000 },
          "count": { "type": "integer", "minimum": 1, "maximum": 100 }
        }
      }
    }
  ]
}
```

`index.js`:

```js
const readline = require("readline");

const tools = {
  roll_dice({ sides = 6, count = 1 }) {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    return "Rolled " + rolls.join(", ") + (count > 1 ? " (total " + rolls.reduce((a, b) => a + b, 0) + ")" : "") + ".";
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type !== "call") return;
  try {
    const out = await tools[msg.tool](msg.input || {}, msg.context || {});
    send({ type: "result", id: msg.id, content: typeof out === "string" ? out : JSON.stringify(out) });
  } catch (e) {
    send({ type: "result", id: msg.id, content: "Failed: " + e.message, error: true });
  }
});
```

That is a complete package. Install it (Packages app → *Install from
folder*, or drop the folder into `jarvis-packages\`), switch it on, and
"Jarvis, roll two dice" works.

---

## 2. The manifest

| Field | | What it is |
|---|---|---|
| `name` | required | Lowercase letters, digits and dashes, 2–40 characters, starting with a letter. Must match the folder's name. |
| `version` | | Yours to keep, e.g. `1.0.0`. |
| `description` | | One sentence: what the package does. Shown in the Packages app and to Jarvis. |
| `author` | | Who made it. |
| `run` | required | The command that starts your program, as a list. It runs in the package's folder. See [Running](#4-running). |
| `timeout` | | Seconds a call may take before it fails and the program is restarted. 2–600, default 60. |
| `guide` | | One short line for Jarvis's "which tool" list: what to reach for this package for. Without it, the first sentence of each tool's description is used. |
| `permissions` | | What it touches, for people reading it: e.g. `["network"]`, `["files"]`, `["programs"]`. Shown in the Packages app. **Not enforced**: a package runs as you. |
| `tools` | required | One or more tools, below. |

Each tool:

| Field | | What it is |
|---|---|---|
| `name` | required | Lowercase letters, digits and underscores, starting with a letter (`roll_dice`). It must not clash with one of Jarvis's own tools or another enabled package's. |
| `description` | required | **The most important part.** The model decides when to use the tool, and what to pass, from this alone. See [Writing descriptions](#3-writing-descriptions-that-work). |
| `input_schema` | required | A JSON Schema of `type: "object"`: the arguments. |
| `core` | | `false` hides it from the small local models (the 4B and 9B get a short list of tools, and choose from it far better). Default `true`. |
| `guide` | | Like the package's `guide`, for this tool alone. |

### input_schema in brief

```json
{
  "type": "object",
  "properties": {
    "city":  { "type": "string", "description": "a city name, e.g. Bend" },
    "units": { "type": "string", "enum": ["metric", "imperial"] },
    "days":  { "type": "integer", "minimum": 1, "maximum": 7 },
    "tags":  { "type": "array", "items": { "type": "string" } },
    "exact": { "type": "boolean" }
  },
  "required": ["city"]
}
```

Keep it flat and small. Small models fill in a few clear fields well and
nested objects badly. Use `enum` wherever there is a fixed set of choices.

---

## 3. Writing descriptions that work

The model reads only the description and the schema. Say:

1. **What it does**, in the first sentence (that sentence is also what the
   tool list shows).
2. **When to use it**: the kinds of request it answers ("how much is 40 euros
   in dollars", "convert currency").
3. **What each argument means** when it isn't obvious, with an example.
4. **What comes back**, so the model knows what it can say.

Good:

> Convert an amount of money between currencies at today's rate. Use for "how
> much is X in Y" and prices abroad. amount: a number. from, to: currency codes
> (USD, EUR, GBP, JPY...). Returns the converted amount and the rate used.

Weak:

> Currency tool.

Two more rules from experience with small local models:

- One tool per job. `convert_currency` and `list_currencies` beat one tool
  with an `action` field; small models pick the right one of two names more
  reliably than the right value of a field.
- Return words Jarvis can say, not raw data: `"40 EUR is 43.20 USD (rate
  1.08, today)."` beats a JSON dump. If you return JSON, keep it short.

---

## 4. Running

**A package is its own program.** It can't call Jarvis's tools (`files`,
`web_search`, `info`…): those exist only inside Jarvis. It does its work with
its language's own libraries: in Node, `fs`, `path`, `child_process` and
`fetch`; in Python, `os`, `pathlib`, `subprocess` and `urllib`. And since a
package's tool runs on your say-so, keep it to the one job its description
promises.

`run` is the command, as a list:

| `run` | Runs |
|---|---|
| `["node", "index.js"]` | The Node that runs the dashboard (in the installed app, Electron's own, acting as Node: you don't need Node installed). |
| `["python", "tool.py"]` | `python` from your PATH. Use `py` for the Python launcher. Install what it needs with `pip install` yourself. |
| `["powershell", "tool.ps1"]` | Windows PowerShell, with `-NoProfile -ExecutionPolicy Bypass`. `pwsh` for PowerShell 7. |
| `["bin\\mytool.exe", "--serve"]` | A program inside the package folder (nothing outside it). |

The program is started on the first call, kept running between calls, and
stopped after **ten minutes** with no calls, when the package is switched
off, or when a call times out. Keep state you need across restarts in files.

It gets these environment variables:

| Variable | |
|---|---|
| `JARVIS_PACKAGE` | the package's name |
| `JARVIS_PACKAGE_DIR` | its folder (also the working directory) |
| `JARVIS_DATA_DIR` | `<folder>\data`, made for you: keep your files, caches and settings here |

---

## 5. The protocol

One JSON object per line, both ways, over stdin and stdout. Lines are UTF-8;
Jarvis escapes everything past ASCII, so you never see a code page problem.

**A call**, from Jarvis on stdin:

```json
{"type":"call","id":"c7","tool":"roll_dice","input":{"sides":20},"context":{"user":"Cappy","home":"C:\\Users\\Cappy","chat":"kmvz...","time":"2026-11-03T18:04:00.000Z"}}
```

**The result**, on stdout, with the same `id`:

```json
{"type":"result","id":"c7","content":"Rolled 17."}
```

| Field | |
|---|---|
| `content` | What Jarvis should know: text he will put in his own words. An object or list is turned into JSON for him. Up to 20,000 characters. |
| `error` | `true` if it failed. Put why in `content` ("No such city: Bnd"), and Jarvis says so. |
| `card` | Optional, something to show on the panel: `{"title": "...", "items": [{"title": "...", "text": "...", "image": "https://...", "url": "https://..."}]}`. Up to 12 items. |

**A log line**, any time: `{"type":"log","text":"fetched 3 rates"}`. Anything on
stdout that isn't JSON, and everything on stderr, goes to the log too. The
log is in the Packages app.

Rules:

- **Flush every line** (Python: `sys.stdout.flush()`, or run with `-u`;
  Node's `process.stdout.write` is fine).
- Answer every call exactly once, with its `id`. Calls can arrive before an
  earlier one is answered; answer in any order.
- Don't print anything to stdout except protocol lines and plain log text.
- `context.test` is `true` when the call is a test from the Packages app or
  from Jarvis testing it.
- Exit when stdin closes. Jarvis is gone.

---

## 6. Python

```python
import json, os, sys

def count_words(inp, context):
    text = inp.get("text", "")
    words = len(text.split())
    return f"{words} words, {len(text)} characters, about {max(1, round(words / 230))} min to read."

TOOLS = {"count_words": count_words}

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

sys.stdin.reconfigure(encoding="utf-8")
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("type") != "call":
        continue
    try:
        out = TOOLS[msg["tool"]](msg.get("input") or {}, msg.get("context") or {})
        send({"type": "result", "id": msg["id"], "content": out if isinstance(out, str) else json.dumps(out)})
    except Exception as e:
        send({"type": "result", "id": msg["id"], "content": f"Failed: {e}", "error": True})
```

The `text-tools` example is a fuller one.

---

## 7. Testing

- **Packages app → Test**: pick a tool, type its input as JSON, run it. You
  see the result and the log. It works before the package is switched on.
- **From a terminal**, without Jarvis at all:

  ```
  cd %APPDATA%\y70-dashboard\jarvis-packages\dice
  echo {"type":"call","id":"1","tool":"roll_dice","input":{"sides":20}} | node index.js
  ```

  One line in, one line out.
- **Ask Jarvis**: "test the dice package's roll_dice with 20 sides". He asks
  first, since it runs the code.
- The Packages app shows a package's **problems** (a bad manifest, a tool name
  that clashes) and its **log** (start, exit, errors, your log lines).

---

## 8. Switching on, and staying safe

A package's code runs **as you**, with everything you can do on this PC. So:

- **Nothing runs until you switch it on**, in the Packages app or when Jarvis
  asks (*Switch on tool package …*). Jarvis can never switch one on by
  himself, whatever the Files setting, even *Bypass*.
- **Switching on approves exactly what is there.** It records a fingerprint of
  every file (except `data\`). If anything changes afterwards (you edit it,
  Jarvis edits it, a new version is copied in), the package turns itself
  off and shows *changed since you enabled it* until you switch it on again.
- **Testing** a package that is off also asks first, every time.
- Read the code of a package you didn't write before switching it on. A git
  URL install only copies it; nothing runs.
- Keep API keys out of the manifest and the code: put them in a file in
  `data\` (it is not part of what gets shared if you publish the package's
  folder without `data\`).

---

## 9. Sharing

A package is just its folder. To share one, put it in a git repo with
`jarvis-package.json` at the top (leave out `data\`). Anyone can install it
from the Packages app (*Install*, paste the URL) or by asking Jarvis, then
switch it on after reading it.

---

## 10. When it doesn't work

| What you see | What to check |
|---|---|
| "can't start" / *exited (1)* in the log | The `run` command: does `node index.js` or `python tool.py` work from that folder in a terminal? For Python, is the module installed? |
| *The code doesn't compile* | A test checks the code first (`node --check`, `python -m py_compile`) and shows the error with its line. A tool name with a dash in a method name (`async view-all-files()`) is the classic one. |
| `files is not defined` (or any of Jarvis's tool names) | The package called one of Jarvis's tools. It can't: do the work with the language's own libraries (see [Running](#4-running)). |
| The call times out | Did you flush stdout? Did you answer with the same `id`? Is the work slower than `timeout`? |
| Jarvis never uses the tool | Its description: say plainly what it is for and when. Check the package is on. Small local models only get `core` tools. |
| Jarvis passes the wrong arguments | Simplify the schema, use `enum`, describe each field with an example. |
| *changed since you enabled it* | Something in the folder changed. Look at what, then switch it on again. |
| A name clash | Rename the tool: it can't share a name with Jarvis's own tools or another enabled package's. |
