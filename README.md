# HYTE Y70 · Dashboard

> **V2 — the native app.** Tapping the panel no longer takes focus off whatever
> you are doing. Run **[`launch-v2.bat`](launch-v2.bat)**; quit from the tray icon.
> V1 (the browser build) is still here and still works — it is tagged `v1` in git.

> **This is the Jarvis fork** (`y70-dashboard-assistant`, 3.x): Main plus a
> voice assistant and a Dynamic-Island-style status bar. Switch between this and
> Main from **Drawer → Panel** — see [Forks](#forks).

## Jarvis

Say **"Jarvis"** (or tap the orb at the right of the top bar) and ask. He
answers out loud, puts anything worth seeing on the panel, and can do things:

| Ask | What happens |
|---|---|
| "Jarvis, set a timer for ten minutes for the pasta" | A timer in the island; it rings there |
| "Wake me at 7 on weekdays" | A repeating alarm; the next one shows in the top bar |
| "Play Radiohead" / "play my gym playlist" / "pause" / "next" | Spotify search-and-play; transport goes to whatever is playing |
| "What's the weather tomorrow?" | Spoken answer plus a forecast card |
| "Who won the F1 race?" / "summarise that article" | Web search (and page reading), answered from sources |
| "Show me a western fence lizard" | Pictures on the panel; tap one to see it big |
| "Turn it down a bit" / "switch to my XM5s" / "turn Discord down to 60" / "mute my mic" | Speakers, default devices, per-program volume, the microphone |
| "Who's in my channel?" / "join Gaming 2" / "leave" / "turn Riley up" / "deafen me" | Discord: the channel, who's talking, joining and leaving, everyone's volume |
| "How's my PC doing?" / "how much have I spent on Claude today?" / "what's my phone battery?" | Reads the dashboard's own data: CPU, GPU, temperatures, network, busiest programs; Claude usage; the iPhone's battery, notifications and calls |
| "Answer it" / "decline the call" | The iPhone, over the panel's Bluetooth bridge |
| "Any updates?" / "install it" / "switch to the main fork" | The app itself: checks for and installs updates (restarting after he's said so), switches forks |
| "Open YouTube" / "gaming layout" / "show the PC widget" / "Ember theme" / "open your settings" | Drives the panel: apps, scenes, widgets, themes, its settings and start-up options |
| "Remember that…" / "add milk to my notes" | Shared memory / the Notes widget |
| "Lights purple" / "lights off" / "dim the lights to 30" | Your Govee strip: over the LAN when it has LAN control, Govee's cloud when it is Wi-Fi only |
| "Download Qwen 3.5 27B" / "find me a coding model" | Finds GGUF builds on Hugging Face, opens the page, downloads after you tap |

"Jarvis, set a timer for five minutes" works in one breath: the name and the
request are heard together. If his answer ends in a question, he listens again
for your reply. Tapping the orb while he talks stops him; holding it opens a
box to type into instead.

### Setting it up

1. **Brain.** Drawer → Settings → **Jarvis**. Paste an Anthropic API key
   (console.anthropic.com) for Claude — Haiku 4.5 by default, the fast and cheap
   one; Sonnet 5.5 and Opus 5.5 are a tap away. The key is written to the data
   folder and is never shown or served back. **Auto** uses the local model when
   it is running and Claude when it is not.
2. **Local model.** `E:\OLLAMAMODEL2026\gguf\jarvis-llm.bat` runs llama-server in
   router mode on port 8081 with all three: **Qwen3.8 27B** (your chat model,
   with exactly the settings from `qwen27b-iq4.bat`), **Qwen3.5 9B** and
   **Qwen3.5 4B**. One is loaded at a time, unloaded after 10 idle minutes so
   games get the VRAM back. It also starts the MCP memory server and serves the
   web UI (with the MCP proxy) at http://127.0.0.1:8081, so it replaces
   `qwen27b-iq4.bat` — run one or the other, never both (the 27B would be in
   VRAM twice). Start / Stop / Restart / Edit it from Jarvis's settings.
   Per-model settings, **including GPU layers**, live in `jarvis-models.ini`:
   a `-ngl` on the bat's command line overrides every model's own value
   (measured — it turned the 27B's 56 into 99). With *Use the 4B while gaming*
   on, a game in front switches to the 4B and unloads whatever else is loaded.
   Big models (14B and up) get every tool and the whole memory; small ones
   every tool but the notes, and a shorter slice of the memory.
3. **More models.** "Jarvis, download …" (or Settings → Jarvis → *Get a model*)
   searches Hugging Face for GGUF builds and picks the quant that fits the 16 GB
   card. Jarvis opens the model's page in the panel's **Web** app with a
   *Download?* bar above it — nothing downloads until you tap. The download runs
   in its own cmd window (curl, resumable — run the script again to continue),
   is checked (size, GGUF header) and added to `jarvis-models.ini` with GPU
   layers left to llama.cpp's `--fit`. Restart the local server to load it.
   Only `.gguf` files, only https; a direct link from any site works too.
   Gated repos (Llama, Gemma's originals) need a Hugging Face login it doesn't
   have.
4. **Hearing.** The wake word is recognised offline by Windows' own engine and
   nothing leaves the PC until you ask something. The request itself goes to
   **Whisper** (whisper.cpp, `ggml-large-v3-turbo-q5_0`, on the GPU, in
   `E:\OLLAMAMODEL2026\whisper`): Windows' engine still listens — it knows when
   you have finished and shows the words as you speak — and the audio it heard
   goes to `whisper-server` (port 8082, resident, ~600 MB of VRAM) for the words
   themselves. Measured on the same audio: Windows offline heard "place on low
   Fi beads on spot if I", Whisper "play some lo-fi beats on Spotify", in 65–80 ms
   (0.4 s for the first after loading). It is biased toward your vocabulary
   (Jarvis, Spotify, Govee…) with an initial prompt, and Whisper's known
   inventions on near-silence ("Thank you.", "[BLANK_AUDIO]") are dropped.
   The alternatives are Windows' online recognizer (needs **Settings › Privacy &
   security › Speech › Online speech recognition**) and its offline one.
   Jarvis listens on Windows' **default recording device**; Settings → Jarvis →
   Microphone shows which one that is, with a live meter.
   
   **Interrupting.** While he talks the mic keeps listening: "Jarvis…" starts a
   new request and "stop" / "that's enough" / "never mind" ends the answer. The
   helper is told the sentence he is saying, so his own voice through speakers
   cannot trip either (a "stop" inside his own sentence is ignored, as is him
   saying his name). *Interrupt by just talking* (off by default; for
   headphones) stops him on any speech that is not an echo of his sentence.
   Tapping the orb always stops him.
5. **Voice.** **Kokoro-82M** (`tts-kokoro.py`, kokoro-onnx, in
   `E:\OLLAMAMODEL2026\tts`), resident and on the CPU so it takes no VRAM: about
   0.5 s a sentence, and the panel asks for the next sentence while the current
   one plays. 28 English voices; the British men (George — the default —
   Lewis, Daniel, Fable) suit a Jarvis, and British voices get British
   pronunciation. Needs `pip install kokoro-onnx` plus `kokoro-v1.0.onnx` and
   `voices-v1.0.bin`. The Windows voices are the fallback whenever Kokoro is
   missing or fails.
6. **About you / memory.** Name, what to call you, free text, home for the
   weather. Memory is **one memory shared with the web UI**: the MCP memory
   server's knowledge graph (`E:\OLLAMAMODEL2026\memory.json`). Jarvis writes
   through that server when it is running (it is the one writer, as for the web
   UI) and edits the file in the same format when it is not — the server
   re-reads the file on every request, so nothing is lost. Reads go straight to
   the file; the server takes ~1.4 s a call. "Remember Jake plays bass" files it
   under Jake; the settings list every entity and fact, each deletable. All of it
   goes into each request to whichever brain answers.
7. **Lights.** Two routes. Lights with *LAN Control* get Govee's **LAN API**
   (UDP straight to the light, no account, no key — what Home Assistant uses).
   **Wi-Fi-only lights** — like the H619E strip here, which is on Wi-Fi at its
   own address but never answers LAN — only go through **Govee's cloud API**,
   which needs a Govee API key (Govee Home → Profile → Settings → Apply for API
   Key; it is emailed), pasted into Settings → Jarvis → Lights. The key is
   checked with Govee before it is kept, and adds scenes too. Jarvis asks a light
   over LAN once, remembers the silence for 30 minutes, and goes straight to the
   cloud meanwhile (which, unlike UDP, says whether the command landed).
   Govee Desktop *does* have an API for other programs (`GoveeAPI.dll`, JSON over
   `\\.\pipe\GoveeDesktopPipe` after a GUID from its Settings → API), but it is a
   wrapper around the same LAN packets and refuses lights that aren't on LAN, so
   Jarvis doesn't use it. Names come from Govee Desktop's device list; a light's
   address from a LAN scan or its MAC in the ARP table.

### How it works

- `voice/` — **y70-voice.exe** (C#, .NET 8): SAPI listens for the name all day
  (grammar: the name, optionally followed by dictation, against a full dictation
  "garbage" grammar so ordinary speech does not match); the WinRT recognizer
  hears requests online, SAPI dictation offline; WinRT synthesises speech; and a
  foreground-fullscreen probe reports games. Rebuild with
  `cd voice && dotnet publish -c Release -o bin/out`.
- `assistant.js` — the loop. Conversations are stored as Claude content blocks
  and translated for llama-server's OpenAI endpoint, so either brain can pick a
  conversation up. Tools that touch the PC run on the server (search, weather,
  sound, Discord, the phone, notes, memory, and `info` — one read of anything
  the dashboard knows: PC stats, phone, Discord, audio, media, Claude usage,
  lights, local models); tools that touch the panel (timers, alarms, music,
  showing cards, and `panel` — the app itself: updates, forks, apps, widgets,
  scenes, themes, settings) are handed to the panel, which runs them with the
  shell's own functions and `window.y70native`, and posts the results back. A
  restart or reload he promises waits until the reply has been heard. Small
  local models get every tool but the notes, each a single tool with an
  `action`, so the list stays short enough to choose from well. Two web searches per
  question at most, and the last step runs with tools off, so every turn ends
  in an answer.
- `assistant-web.js` + `search-ddgs.py` — key-less search. The `ddgs` Python
  library goes first when it is installed: it impersonates a real browser, and
  every plain scripted request gets challenged (DuckDuckGo) or fed junk (Bing
  matched only the first word of "how tall is mount bachelor"). Fallbacks: Bing
  News RSS for current events, Bing, DuckDuckGo, Wikipedia — and every result
  must mention most of the question's key words to be kept.
- `jarvis.js` / `jarvis.css` — the status bar, the island, alarms and timers,
  Jarvis's card and settings. Timers are stored exactly as the Timer widget
  stores them, so the two stay in step; the island does the ringing.

## V2: a window that doesn't steal focus

In V1 the dashboard was a Brave window. Every tap **activated** that window:
Windows moved the foreground to it, the game lost focus, and with it lost mouse
capture — which is why the cursor appeared to jump across. No Chromium flag can
prevent this, because the browser owns the window and always activates on click.

V2 owns its own window and creates it with **`focusable: false`**, which on
Windows is the `WS_EX_NOACTIVATE` extended style — *"a top-level window created
with this style does not become the foreground window when the user clicks it."*
Taps still arrive as ordinary pointer events. They simply never take focus.

Measured on this machine, launching V2 while another window was in front:

```
foreground before : 'Claude'
foreground after  : 'Claude'      <- focus kept
window rect       : 3840,0  682x2560   <- exactly the panel, no overlap
WS_EX_NOACTIVATE  : True
WS_EX_TOPMOST     : True
```

It also:

- **starts the server itself** and waits for the port properly — no launcher
  chain, no browser, no PowerShell window placement,
- sits **always-on-top at `screen-saver` level**, so it stays visible over a
  borderless-fullscreen game,
- **skips the taskbar** and has no frame, so it is a panel rather than a window,
- re-places itself when displays come and go (the Y70 sleeps with the PC),
- reloads itself if the renderer ever dies.

### Web apps (YouTube / Shorts / TikTok)

These are ordinary sites, but neither will render in a frame — both send
`X-Frame-Options` / `frame-ancestors`. Electron's `<webview>` gets around that,
except it **only works in a top-level frame**, and the shell mounts every app in
an iframe. Verified both facts before designing around them.

So the page draws just its toolbar and reports where its content belongs, and
the main process parks a real **`WebContentsView`** over that rectangle. The
toolbar stays as HTML above it. Native views sit above all HTML, so the view is
hidden whenever the drawer opens or another app is in front.

- **Auto-scroll** has two behaviours, because the sites are two shapes. YouTube
  is a scrolling page, so it nudges the page down. Shorts and TikTok are
  virtualised feeds where scrolling by pixels does nothing, so it sends **Down**,
  which advances one clip. The slider sets the pace — for feeds, 1 is about
  16 seconds a clip and 10 is about 1.6.
- **Phone layout by default.** The panel is 682x2560; these sites' mobile
  layouts fit it far better than their desktop ones. The 📱 button switches.
- Sign-ins persist in their own `persist:y70web` partition, kept apart from the
  dashboard's own origin.

> TikTok answers a Down key by trying to bounce you into the phone app — it
> navigates to a `onelink.me` deep link, which would take the feed away
> entirely. Those are cancelled, so the feed stays put. Verified for Shorts that
> auto-scroll really does move to a different video; on TikTok the URL doesn't
> change between clips, so give that one an eyeball.

### iPhone (notifications, calls, battery)

Your iPhone's notifications appear on the panel, an incoming call drops down a
card you can answer or decline from the touchscreen, and the phone's battery
shows in the drawer.

This is **ANCS** — Apple's Notification Center Service, the sanctioned route for
getting iPhone notifications onto a non-Apple device. The phone acts as the
Bluetooth LE GATT server and the dashboard is the client.

- **Banners** slide down from the top bar, iOS style, and clear themselves after
  a few seconds — or on a tap.
- **The notification list** sits at the top of the drawer, under Phone. Tap one
  to clear it from the panel (your phone keeps its own copy).
- **Calls** drop a card over everything with **Decline** / **Accept**. Answer and
  it becomes a single **End call** with a running timer; it slides away when the
  call ends. Accept and decline are real ANCS actions, so they act on the phone.
- **Battery** is read from the standard Battery Service and updates itself.

#### Setting it up

Pair the iPhone to Windows in **Settings → Bluetooth & devices** as normal. iOS
then exposes ANCS over the LE link on its own; there is nothing to install on the
phone and no app to approve. If iOS asks whether to share notifications, say yes.

The bridge is a small compiled helper, `ancs/y70-ancs.exe`, built by:

```bash
cd ancs
dotnet publish -c Release -o bin/out
```

It ships inside the installer, so this is only needed when working from source.
It needs the **.NET 8 runtime**, which is already present on most machines.

> **Why this one is C# when every other helper is PowerShell:** Windows
> PowerShell 5.1 cannot subscribe to WinRT events at all ("Windows PowerShell
> cannot subscribe to Windows RT events") and cannot project `IBuffer`. ANCS is
> entirely event-driven over GATT notifications, so PowerShell simply cannot
> host it. Verified both limits before switching languages.

> **One honest limit.** iOS removes the incoming-call notification the moment the
> call is answered, so the identifier the hang-up action needs is often already
> gone. **End call** asks anyway and always clears the card locally, but whether
> the phone actually hangs up is not guaranteed. Answering and declining are
> reliable; ending a call may need the phone.

### Auto-update

The app checks its own GitHub Releases 20 seconds after launch and every six
hours, downloads in the background, and offers **Restart to update** in the tray.
The repo is public, so no token is needed anywhere and nothing sensitive ships
in the installer.

Cut a release with:

```bash
cd v2
npm version patch          # bumps package.json AND creates the git tag
git push --follow-tags
npm run release
```

Push the tag **before** publishing: GitHub refuses to create a non-draft
release for a tag that does not exist yet ("Published releases must have a
valid tag"), and `npm run release` publishes non-draft on purpose, because a
draft is invisible to the updater.

Auto-update only runs in the installed build — there is nothing to replace when
running from source, and the app reports its status as `dev` there instead.

### Forks

There is more than one line of this app, each in its own repo with its own
Releases:

| Fork | Repo | What it is |
|---|---|---|
| **Main** | `cocacappycola/y70-dashboard` | The dashboard on its own. |
| **Jarvis** | `cocacappycola/y70-dashboard-assistant` | Main plus Jarvis, a voice assistant, and alarms and timers in the top bar. |

**Drawer → Panel** shows both. Tap the other one and confirm: it downloads that
fork's latest build, and **Restart to switch** installs it over this one. Every
fork has the same app id and product name, so the installer lands in the same
folder and keeps the same user data — settings, sign-ins and notes carry over,
and switching back is the same move in reverse.

The list lives in `v2/forks.js` and every fork carries the same copy. Which
fork a build *is* comes from its own `build.publish` in `v2/package.json`, so
the two can never disagree about which feed it updates from.

A switch is an update from another feed, with two adjustments. electron-updater
only installs a release *newer* than the running one, and two forks' version
numbers are unrelated (Jarvis is 3.x, Main 2.x), so while switching the updater
is told this build is 0.0.0. And its differential download needs the installed
build's blockmap on the target feed, which the other fork does not have, so a
switch always downloads the full installer. Install-on-quit is switched off the
moment a switch starts: it happens when you press the button, never because the
app happened to restart.

### Signing in to Spotify

This needed fixing for V2 and is worth knowing about. The panel window blocks
navigation off `127.0.0.1:8888` (it is a kiosk) **and** takes no keyboard input,
so the Spotify login could neither open nor be typed into — "Connect Spotify"
did nothing at all.

Sign-in now opens in an **ordinary window**: framed, focusable, centred on your
main monitor where the keyboard is. It shares the same session as the panel, so
the token it stores is the same one the panel reads; when the callback lands, the
window closes itself and the panel reloads already signed in. The panel never
becomes focusable during any of it.

### The keyboard trade-off

A window that never takes focus also never receives keystrokes. That is the
deal, and it is the right default for a screen you tap while playing something.

When you do need to type — the Notes widget, the calculator — the panel borrows
the keyboard and gives it straight back:

- **Tapping into Notes turns keyboard mode on automatically**, and tapping away
  turns it off. You never think about it.
- A **band across the top bar** says *keyboard mode — this window has focus*, so
  the one state where the panel does hold focus is never a surprise.
- The drawer's **Panel** row and the **tray menu** toggle it manually. It also
  **releases itself after 60 seconds** of no typing, so it can never get stuck on.
- **Never take focus** is a hard lock, in the same two places: while it is on
  nothing can make the panel focusable, whatever asks. Use it while gaming.

> A left-click on the tray icon used to toggle keyboard mode. Clicking a new
> app's tray icon is the obvious thing to do, so the panel would quietly become
> focusable and steal focus on every tap from then on — with only a banner to
> explain it. The tray click now just opens the menu.

Verified against Windows itself:

```
passive (focusable:false) : noactivate=True   foreground=Claude
keyboard mode ON          : noactivate=False  foreground=<panel>
back to passive           : noactivate=True
```

### Install it as a real app

```bash
cd v2
npm install
npm run dist
```

That produces two things in `v2/dist`:

| File | What it is |
|---|---|
| **Y70 Dashboard Setup 2.0.0.exe** | Installer — Start-menu and desktop shortcuts, proper uninstall entry |
| **Y70-Dashboard-portable-2.0.0.exe** | Single file, no install |

Installed, it is an ordinary Windows application: its own icon, its own process
name (**Y70 Dashboard.exe**, not "electron"), its own uninstaller. It installs
per-user under `%LOCALAPPDATA%\Programs`, which matters — the dashboard writes
`notes.txt` and `discord-token.json` next to itself, and Program Files would be
read-only.

**Start with Windows** is a toggle in the tray menu and in the drawer's *Panel*
row. It writes the Run key natively — no Startup shortcut, no VBScript, none of
V1's launcher chain.

> That toggle only works in the **installed** build. Run from source, Electron
> writes the Run entry under its own generic name, which would start bare
> Electron rather than the dashboard. The button says as much on hover, and V1's
> [`install-autostart.bat`](install-autostart.bat) still exists for the browser
> build (it prefers V2 when `v2/node_modules` is present; force one with `/v1`
> or `/v2`).

**Taskbar icon** is a second toggle, off by default. A taskbar button is
something you click, and clicking it would activate the window — the one thing
V2 exists to prevent. It is there because being able to find the app matters too.

[`launch-v2.bat`](launch-v2.bat) finds the app wherever it is: the installed
copy first, then the newest `v2/dist*` build, then Electron from source.

> Windows sometimes keeps a handle on `dist/win-unpacked/resources/app.asar`
> after the app exits, which makes the next `npm run dist` fail with `EBUSY`.
> Building to a fresh directory works, which is why the launcher picks the most
> recent `dist*` rather than a fixed one. Stale folders delete after a reboot.
>
> Keep `.bat` and `.vbs` files **pure ASCII** — cmd.exe reads them in the OEM
> codepage, so a UTF-8 em dash inside a `REM` corrupts the line and cmd starts
> executing the comment.

~350 MB of Electron lives in `v2/node_modules`; that and every `v2/dist*` are
git-ignored.

**Known limit:** a game running in *exclusive* fullscreen owns the whole GPU
output and will cover even a topmost window. Borderless windowed is fine — which
is what you want anyway for a second screen.

---

The app is now a **dashboard shell** (`shell.html`) served at `http://127.0.0.1:8888`:

- **Apps** run in the main frame — Spotify (default) and Weather. Switch apps from
  the pull-down drawer: **drag down (or tap) the bar at the very top** of the screen.
  Apps stay **mounted in the background** once opened, so leaving Spotify does not
  stop the music.
- **Mini player** — leave Spotify while something is loaded and a slim 60px now-playing
  strip appears at the top of the dock (art, title/artist, prev/play/next, seekable
  progress). It disappears when you return to Spotify or playback ends. Fully automatic;
  it is not a drawer toggle.
- **Hardware controls** — the Spotify app registers the **Media Session API**, so
  headphone play/pause/skip buttons, keyboard media keys, and any Nexus macro that
  emits a media key drive playback (play, pause, next, previous, seek), and the track
  shows up in the OS media popup with album art.
- **Pull-up widgets** dock at the bottom as 16:9 panels — **Claude** (your local
  Claude Code usage stats — free, nothing leaves the machine), **Weather**
  (Open-Meteo, no key needed, with a clock + date and a live sky behind it),
  **PC stats** (RAM, CPU, GPU, live network throughput and what is talking to the
  internet right now), **Calculator**, **Now playing**, **Lyrics**, **Audio**,
  **Timer**, **Notes** and **Discord**.
  In the drawer they are a **list**: tap a row to turn it on or off, and **drag its
  ☰ grip to reorder** — where a row sits in that list is exactly where its panel
  sits on screen, top to bottom. **Drag a panel's title bar** up/down to resize it;
  drag it to the bottom (or tap ▼) to collapse it to a slim bar; tap the bar to reopen.
- **Web apps** — **YouTube**, **Shorts** and **TikTok** run as apps beside Spotify
  and Weather, with back/forward/home/reload, a phone-or-desktop layout toggle
  and an **auto-scroll** button (speed slider next to it). V2 only; see below.
- **Scenes** — whole layouts (which app is up front, which widgets are open, at
  what height) in one tap, at the top of the drawer. Four ship with the app;
  each can be overwritten with your own arrangement and reset back again.
- **Appearance** — pull down the drawer → **Settings → Appearance** to recolour the
  dashboard. See below.

### Appearance / themes

The drawer's **Settings → Appearance** page recolours the whole dashboard. Four
things are adjustable, each with a swatch row plus a full colour picker:

| Slot | What it paints |
|------|----------------|
| **Trim** | shell chrome — grips, drawer, dock title bars, panel hairlines, mini player |
| **Weather palette** | the weather app *and* the weather widget |
| **Claude palette** | the Claude usage widget |
| **PC stats palette** | the PC stats widget |
| **Calculator palette** | the calculator widget |
| **Media palette** | now playing + lyrics |
| **Tools palette** | audio hub, timer, notes |
| **Discord palette** | the Discord widget |
| **Background** | the base colour everything is derived from |

**Presets** set all four at once. **Main Purple** is the default: black background
with `#A85CD6` as the accent throughout. Also included: Default (the original
green/blue/orange look), Midnight Ice and Ember. Editing any slot switches the
theme to *Custom*; edit it back and it re-labels itself as the matching preset
again. **Reset** returns to Main Purple.

**Tint weather backdrop** re-hues the weather app's animated sky onto the weather
accent. Each condition keeps its own lightness, so a storm still reads darker than
a clear day — only the hue family changes. Turn it off to get the real
meteorological blues and greys back.

Colours live in [`theme.js`](theme.js), which derives a full set of CSS custom
properties (surfaces, borders, text tiers, contrast-correct ink on accents) from
those four values. Everything is served from one origin, so every frame reads the
saved theme itself on load — no flash of the wrong colour — and edits are also
broadcast live to frames that are already open. Every stylesheet keeps its
original colour as the `var()` fallback, so the dashboard still renders correctly
if that script ever fails to load.

The Spotify app deliberately keeps Spotify's own green — it's styled to look like
Spotify, so it doesn't follow the trim.

> The Claude widget shows **local Claude Code usage** read off this machine's
> transcripts (`GET /api/claude-stats`). It costs nothing and needs no API key;
> `claude-key.txt` is only used by the old, unused fun-facts proxy.

### Scenes

At the top of the drawer. A scene sets the front app *and* the whole dock at once:

| Scene | What it opens |
|---|---|
| **Working** | PC stats · Notes · Timer |
| **Gaming** | Discord · Audio · PC stats |
| **Music** | Lyrics · Now playing · Audio |
| **Idle** | Weather app · Weather · Now playing · Claude usage |

Applying a scene is deliberately **total** — widgets it doesn't list get closed,
so switching to Gaming can't leave yesterday's notes panel hanging around.

Rearrange the dock however you like — including the **order**, by dragging grips in
the widget list — then **Save layout → ‹scene›** and that scene
is yours from then on (it shows a *yours* tag). **Reset to packed** puts the
original back. Everything is stored per-scene, so customising Gaming never
touches Music.

### Discord

Real Discord state on the panel: **mute and deafen that actually are Discord's**,
which voice channel you are in, who is in it, and a green ring around whoever is
talking — synced both ways, so muting in Discord lights up here within a second.

This talks to the Discord desktop client over its local named pipe
(`\\.\pipe\discord-ipc-0`). Nothing is sent to Discord's servers except the
one-time token exchange.

#### Setup (about three minutes, once)

1. Go to **discord.com/developers/applications** → **New Application**. Name it
   anything, e.g. *Y70 Dashboard*.
   Creating it makes you its **owner**, which is the part that matters — see the
   note below.
2. Open the **OAuth2** tab. Copy the **Client ID**. Hit **Reset Secret** and copy
   the **Client Secret**.
3. Still on OAuth2, under **Redirects**, add exactly `http://localhost` and
   **Save Changes**. It is never actually opened; it only has to be registered and
   to match what the token exchange sends.
4. Open the **Discord** widget and paste both values into its **Client ID** and
   **Client Secret** boxes, then **Save & connect**. The dashboard writes
   `discord-app.json` for you — there is no file to create and no restart. (The
   secret box is masked, with a **show** button, and **Change credentials** gets
   you back to the form later.)
5. Make sure the **Discord desktop app** is running and signed in. The browser
   version has no local socket, so there is nothing to connect to.
6. Tap **Link Discord** → **approve the popup that appears inside Discord**. That
   is the only prompt; it does not open a browser.

> On the V2 panel the credential boxes borrow the keyboard while they are
> focused, the same way Notes does, so you can type or paste into them even
> though the panel normally takes no keyboard input.
>
> A mistyped Client ID is reported as Discord's own **"Invalid Client ID"**
> rather than a vague failure, and the dashboard stops retrying until you fix it.

#### What it asks for, and what it doesn't

| Scope | Why |
|---|---|
| `rpc` | permission to talk to your local Discord client at all |
| `rpc.voice.read` | read your voice settings and current channel |
| `rpc.voice.write` | change mute / deafen |
| `identify` | know which account approved it, to mark *you* in the member list |

**No bot, no server invite, no guild permissions.** This is a user-level
authorisation to your own running client — it cannot post messages, join servers,
read chat, or do anything outside your voice settings.

> **Why this works without Discord whitelisting you:** the `rpc.*` scopes are
> normally restricted to approved applications. The exception is that an
> application's **owner** may always authorise it against their own account.
> You created the app, so you are the owner. The corollary is that this is
> strictly personal — the same client id will not work for anyone else, and there
> is no point sharing it.

**Where the secrets live.** The client secret is posted once to the local server,
written to disk, and never sent back to the page — the status the widget reads
only ever says *whether* a secret exists. `discord-app.json` (your client secret) and
`discord-token.json` (the access + refresh token, written automatically) both sit
in the dashboard folder, and the web server **refuses to serve either** — they
never reach the browser. To revoke: **Forget token** in the widget, or Discord →
*User Settings → Authorized Apps*.

**If it won't connect:** the widget says which step failed. A wrong client id gets
`Invalid Client ID` from Discord and the dashboard then stops retrying rather than
hammering the pipe — fix the id and tap **Try again**.

> Muting yourself is available two ways and they are different things. The
> **Discord** widget mutes you *in Discord* (the real self-mute, and Discord knows
> about it). The **Audio** widget's Mic button mutes the microphone at the Windows
> level — broader, works everywhere, but Discord still shows you as unmuted.

### Audio hub

The thing a case screen is best in the world at: changing audio without leaving
the game.

- **One-tap output switching.** Tap any output to move Windows onto it — Console,
  Multimedia *and* Communications roles together, so chat follows the music
  instead of being left behind on the old device.
- **Per-app mixer** with live level bars — Spotify, Discord, the game, each with
  its own volume and mute. Muting an app hits *every* session it owns (Discord
  keeps several), so it actually goes quiet.
- **Mic mute** as an unmissable red state. It mutes the default *capture* device,
  which is system-wide — that is what mutes you in Discord, in a call, everywhere.
- **Discord** gets its own button: that one mutes what you *hear* from Discord.
- Master volume, and a live meter on the active output so you can see sound
  flowing even when you can't hear it.

Virtual endpoints are filtered out of the list (numbered Voicemeeter strips, VB
CABLE, Steam Streaming) unless one is somehow the active device — in which case it
has to stay visible or you could never switch off it.

> **On Discord:** this widget's buttons are the Windows-level ones — the Mic
> button mutes the microphone for everything, and the Discord button mutes what
> you *hear* from Discord. For Discord's own mute/deafen state, use the
> **Discord** widget above.

### Now playing (universal)

Reads **GSMTC**, the same Windows media bus that powers the Win+G overlay, so the
panel shows and controls **whatever is playing** — Spotify, a YouTube tab in
Brave, VLC, a game's own player. Title, artist, album, source app, transport, and
a seek bar when the source supports seeking. Position is interpolated between
polls, because Windows reports it only when it feels like it.

> Album art is the one thing GSMTC won't give up here: opening its thumbnail
> stream returns a bare COM object that Windows PowerShell 5.1 refuses to project
> onto the WinRT interface. When the source is Spotify the widget borrows the
> artwork the Spotify app already publishes; otherwise it shows a themed
> placeholder.

### Lyrics

Time-synced, from **LRCLIB** — free, no key, no account. The current line is
highlighted and the view scrolls itself; **tap any line to seek the real player
to it**, whatever app that is. Falls back to unsynced lyrics, then says plainly
that it found none. Scrolling by hand pauses the auto-follow for six seconds so
you can read ahead. Lookups are proxied and cached by the server, so a repeated
track costs nothing.

### Timer

Presets from 1 minute to an hour, plus a 25-minute Pomodoro. Several can run at
once, each with its own name and a progress fill that runs underneath the row.

Timers are stored as **absolute end times**, never as a countdown that has to be
ticked — so they stay correct across a reload, a collapsed panel, or a browser
that throttled its timers while the window was hidden. When one finishes the row
pulses and it beeps every few seconds until you tap **Silence**.

### Notes

A scratchpad that saves itself to **`notes.txt`** in the dashboard folder — a real
file, so it survives clearing site data and you can open it in an editor. Writes
are debounced, flushed on blur, and flushed again with `sendBeacon` if the panel
is torn down mid-sentence. **＋ date** stamps the cursor position.

### Calculator widget

A touch keypad with a real expression display, so you can see the whole sum
rather than one number at a time.

- **Correct precedence** — `2+3×4` is `14`, not `20`. It tokenises what you typed
  and evaluates with a shunting-yard pass; it never calls `eval()`.
- **Unary minus** — `±` negates the number you are typing, and `2×−3` is `−6`.
- **`%`** is postfix and always means "divide this number by 100", so `200×50%`
  is `100`. (It is deliberately not the "50% *of* the previous number" behaviour
  some calculators use, which changes meaning depending on the operator before it.)
- **`=` then an operator** keeps calculating from the answer; **`=` then a digit**
  starts fresh.
- **Keyboard works too** — digits, `+ - * /`, `%`, `.`, Enter, Backspace, Esc.
- Divide-by-zero and half-finished sums say so instead of showing `NaN`.

### PC stats widget

Live machine telemetry, refreshed every 2 seconds:

- **History** — every tile carries a sparkline of the same series its number came
  from, so the value on screen is always the right-hand end of the line. Six
  minutes at 2-second resolution, sampled on the server's own timer so the shape
  is right whether or not the widget was on screen.
- **Per-core strip** — one bar per logical processor (16 on a 7800X3D), with a
  count of how many are working hard.
- **RAM** — percent used plus the actual GB in use / installed
- **CPU** — load percent (from `os.cpus()` deltas) and die temperature *if a
  source exists* — see the note below
- **GPU** — temperature, utilisation and VRAM in use, via `nvidia-smi`
- **Network** — real down/up throughput summed across adapters, from
  `Get-NetAdapterStatistics` byte counters
- **Network activity** — every process holding an established connection to
  another machine, with its connection count, distinct remote hosts, a sample
  remote endpoint, and its I/O rate. The list is rebuilt from scratch each tick,
  so it shows what is happening *now* — which is how you catch the things that
  chatter while you are doing nothing at all.

> **On the rate column:** Windows publishes no per-process *network* byte counter
> (there is no such performance counter; only an ETW trace session can attribute
> bytes to a process). The rate shown is that process's total I/O, which is why
> it is labelled "per-process I/O". The connection count and remote endpoint
> beside it *are* network-specific and exact, and the down/up figures at the top
> are true adapter throughput.

**CPU temperature needs a helper.** Windows exposes no CPU die temperature on
most desktops — on AMD in particular `MSAcpi_ThermalZoneTemperature` answers
"Not supported", because reading it requires a kernel driver. Install
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
(free) and leave it running **as administrator**; it publishes sensors over WMI
and the widget picks them up on its own within a minute — no restart, no config.
OpenHardwareMonitor and an ACPI thermal zone are also tried, in that order.
Everything else on the widget works with nothing installed.

**How it works.** Spawning PowerShell per request would cost ~1s (module load +
WMI connect), so [`server.js`](server.js) starts **one** long-lived sampler
([`pcstats.ps1`](pcstats.ps1)) that streams raw cumulative counters as JSON lines;
`GET /api/pcstats` answers instantly from the newest sample and differentiates it
against the previous one. The sampler shuts down after 60s with no requests — so
it costs nothing while the widget is off — and it watches the server's PID, so it
can never survive as an orphan `powershell.exe` even if node is force-killed.

### Weather

Two surfaces, both free and key-less (Open-Meteo + RainViewer + Esri/OSM tiles):

- **Widget** ([`widget-weather.html`](widget-weather.html)) — compact current + 5-day strip
  for the dock, with a **clock and date** filling the gap on the right, over the same
  **live reactive sky** the full app uses: rain and snow, drifting cloud, stars at night,
  a sun/moon glow on clear skies and lightning in a storm. Both surfaces share one
  engine ([`weather-bg.js`](weather-bg.js)) so they always agree; the widget just runs it
  at a lower particle density, since the app's counts read as a blizzard in a dock panel. The clock re-aligns
  itself to the top of each minute rather than free-running on a 60s timer, so it never
  drifts a beat behind. The date line drops out automatically if you squash the panel.
- **App** ([`weather-app.html`](weather-app.html)) — the full thing:
  - Current conditions + 8 detail tiles (wind, humidity, UV, pressure, visibility, dew point, sunrise/sunset)
  - 24-hour scroller and 7-day forecast with temperature-range bars
  - **Air quality**: US AQI with category, colored scale, and 6 pollutant bars (PM2.5, PM10, O₃, NO₂, SO₂, CO)
  - **Map** (hand-rolled slippy map, no map library), zoom **3–17**.
    Drag to pan, **pinch or wheel to zoom** (anchored at the pointer/pinch midpoint), ◎ recenters.
    The button in the map header cycles the **basemap**: **Esri Dark** (default),
    **Satellite**, **OpenStreetMap** — all key-less. If a source starts failing
    outright the map switches to the next one by itself and remembers the change.

    > **CARTO is no longer the default.** Its dark basemap now stamps
    > "API KEY REQUIRED" diagonally across every tile unless you register one.
    > Note that the request still returns **HTTP 200 with a valid PNG** — nothing
    > errors and no failover can detect it; the watermark is baked into the image.
    > If you get a free key at carto.com, put it in `WEATHER.CARTO_KEY` in
    > [`config.js`](config.js) and "Carto Dark" reappears in the picker.
    Three togglable overlays:
    - **Rain** — two stacked radar sources: **NEXRAD 1 km** (IEM's NOAA mosaic, sharp at every zoom,
      US coverage) layered over **RainViewer** (global, but its public tiles only render to z7, so it is
      upscaled client-side and drops out past z11). Wherever NEXRAD has no data the global layer shows
      through, so border regions aren't silently blank. Both use the same dBZ colour scale.
      Radar fades as you zoom in so the streets underneath stay readable.
    - **Wind** — animated particle streaks advected through a live wind grid
    - **AQI** — blended heat layer from a live AQI grid
  - **Reactive background** — gradient, cloud drift, rain/snow particles, stars at night,
    lightning flashes in storms, plus an AQI haze tint when air quality is poor.

Set `WEATHER: { LAT, LON, LABEL }` in [`config.js`](config.js) — otherwise it uses
browser geolocation (and reverse-geocodes a place name), falling back to New York.

---

# Spotify Controller

A touch-optimized Spotify **playlist + queue** controller made to run fullscreen
on the **HYTE Y70 Touch** built-in display. Browse your playlists, tap to play,
add tracks to the queue, and control playback — all from the case screen.

> **Note on "Nexus plugins":** HYTE Nexus has **no public plugin SDK**, so there's
> no way to install a native third-party plugin *inside* Nexus. Instead this is a
> small local web app you run fullscreen on the Y70 screen (which Windows sees as
> a second display). If your Nexus build has a web/URL widget you can point it at
> `http://127.0.0.1:8888`.

Requires **Spotify Premium** (needed for playback control via the Web Playback SDK)
and **Node.js** installed.

---

## 1. Create a Spotify app (one time, ~2 min)

1. Go to **https://developer.spotify.com/dashboard** → **Create app**
2. Name/description: anything (e.g. "Y70 Spotify")
3. **Redirect URI** — add exactly:
   ```
   http://127.0.0.1:8888/callback
   ```
4. Under "Which API/SDKs are you planning to use", check **Web API** and **Web Playback SDK**
5. Save. Open the app → **Settings** → copy the **Client ID**

## 2. Add your Client ID

Open [`config.js`](config.js) and paste the Client ID:

```js
CLIENT_ID: "paste-your-client-id-here",
```

## 3. Run it

From this folder:

```bash
node server.js
```

Then open **http://127.0.0.1:8888** in a browser and click **Connect Spotify**.

## 4. Launching it

Run **[`launch-dashboard.bat`](launch-dashboard.bat)** (double-click it, or point a Nexus
**Macro Touchpad** button at it). It:

1. finds `node` (even when PATH isn't inherited, e.g. from Task Scheduler or a Nexus macro),
2. starts `server.js` if nothing is listening on 8888,
3. **waits until the port actually accepts connections** — this is what prevents
   "127.0.0.1 refused to connect",
4. opens the dashboard **fullscreen on the small screen** (Windows display 1) in **Brave**,
   using your normal profile so it's already signed in to Spotify.

Screen placement is handled by [`open-dashboard.ps1`](open-dashboard.ps1), which moves the
window onto the target monitor with `SetWindowPos` and then sends F11. Browser
`--window-position` flags alone are unreliable — once the profile has saved window state,
Chromium restores the old placement and ignores them.

Change the monitor by editing `set "SCREEN=1"` at the top of the .bat (it falls back to the
physically smallest screen if that display doesn't exist). Press **F11** to leave fullscreen.

### Auto-start at logon

```
install-autostart.bat            install
install-autostart.bat /remove    uninstall
```

Adds a Startup-folder shortcut to [`autostart-hidden.vbs`](autostart-hidden.vbs), which waits
**30 seconds** for Windows to settle and then launches everything with no console window.
No administrator rights needed (a Scheduled Task would have required elevation).

Test the unattended path without waiting:

```
wscript "autostart-hidden.vbs" 0
```

> **Reality check on "Nexus plugins":** Nexus 2.0 has a *fixed* set of built-in widgets and
> **no web/URL widget and no plugin SDK**, so this can't be embedded inside the Nexus canvas.
> A Macro Touchpad button that launches the .bat is the closest supported integration.

---

## What works

- OAuth login (PKCE — no client secret stored)
- This app registers itself as a Spotify device named **"HYTE Y70"**

- **It behaves like a Spotify Connect remote, not a thief.** Opening this screen
  while the desktop app is playing leaves playback exactly where it is — the
  panel just follows along and controls it. Play/pause, skip, previous, seek,
  volume, shuffle, repeat, playing a playlist and every queue edit are sent to
  **whichever device is actually playing**. When the sound *is* coming from
  somewhere else, its name appears next to the devices button so you always know
  where you are pointing.

  > This used to be broken in both directions: the app sent
  > `PUT /me/player {device_ids:[this screen], play:false}` the moment the web
  > player registered, which yanked playback off the desktop app **and paused
  > it** — and every transport button called the Web Playback SDK object, which
  > can only ever drive its own device, so pressing play here did nothing at all
  > while the desktop app held playback.

  To deliberately move the music onto the panel, use the **devices button** and
  pick the one tagged *this screen*. Transfers keep the current play/pause state,
  so moving a paused track no longer starts it playing.

  If the device you last used has gone away (desktop app closed), the command is
  retried on this screen's player rather than failing silently.
- Playlist grid → open → tap a track to play, or **＋** to queue
- **Reorderable queue** — the Queue tab's **Up next** list has a ☰ grip after each
  track length: drag it to reorder, tap a row to jump to it, **×** to remove.

  > Spotify's public Web API **cannot reorder, remove from, or clear the queue** —
  > `POST /me/player/queue` only appends, and the `set_queue` call their own apps use
  > is private. So the app keeps its own ordered list and pushes it to Spotify with
  > `PUT /me/player/play {uris:[…]}`, the one order-aware endpoint. Applying an edit
  > therefore replays the current track from its current position — a sub-second gap,
  > debounced so a burst of edits costs one sync.

- **Captured playlist list** — since playlist track listings are 403'd for new apps,
  hitting play on a playlist and reading the queue is the only way to see what's inside
  it. The app **snapshots that reconstruction** into a saved list shown under
  **From &lt;playlist&gt;**, so it survives taking over the queue (and survives reloads).
  Tap **＋** on any row to add it to Up next — rows are never removed, they just show
  a ✓ / ×N badge, so nothing shifts while you tap down the list and you can **add the
  same song more than once**. **Add all** queues the lot.

- **Playing a playlist auto-fills Up next** with everything captured — the same result
  as tapping ＋ on every row — so you can reorder immediately. This costs nothing:
  the playlist context already plays that order, so no sync is needed.

- **No stutter on adding.** Rewriting the context is what makes playback hiccup, so
  adds don't sync at all — they're flushed at the next **track change**, where a replay
  from position 0 is inaudible. Only reorders and removals sync right away, since
  that's when you expect to hear the change.
- **Play all** for a whole playlist
- Live **Now Playing** with album art, progress (tap to seek), volume
- **Queue** tab showing what's up next
- Prev / play-pause / next

## Troubleshooting

- **"Premium required"** — playback control needs a Premium account.
- **Redirect/login error** — the Redirect URI in your Spotify app must be
  `http://127.0.0.1:8888/callback` *exactly* (use `127.0.0.1`, not `localhost`).
- **Controls do nothing** — check the device name shown beside the devices
  button: commands go to whatever Spotify says is active. If that device is
  asleep or offline, pick another one from the devices list.
- **I want the sound to come out of the Y70 panel** — tap the devices button and
  choose the entry tagged *this screen*. The app never takes playback on its own.
- **Nothing loads** — open the browser dev console (F12) for the error.

## Files

| File | Purpose |
|------|---------|
| `config.js`  | Your Client ID + settings |
| `server.js`  | Static server + APIs on `127.0.0.1:8888` (the Jarvis fork adds the Anthropic SDK: `npm install` at the root) |
| `assistant.js` | Jarvis: settings, the voice helper, both brains, tools, conversations |
| `assistant-web.js` | Jarvis's key-less search, images, page reading, weather |
| `search-ddgs.py` | Search through the `ddgs` Python library when it is installed |
| `assistant-models.js` | Local models: Hugging Face search, confirmed downloads, adding to the preset |
| `govee.js` | Govee lights over the LAN API (and the cloud API, with a key) |
| `tts-kokoro.py` | Jarvis's voice: Kokoro-82M, resident, one WAV per sentence |
| `jarvis.js` / `jarvis.css` | Status bar, the island, alarms + timers, Jarvis's card and settings |
| `voice/Program.cs` | Voice helper — wake word, online/offline dictation, voices, game probe |
| `index.html` | UI layout |
| `styles.css` | Touch/dark styling tuned for the tall Y70 display |
| `app.js`     | Auth, Web Playback SDK, API calls, rendering |
| `theme.js`   | Shared palette — presets, colour maths, CSS variables for every frame |
| `pcstats.ps1` | Long-lived telemetry sampler feeding `/api/pcstats` |
| `weather-bg.js` | Reactive sky canvas, shared by the weather app and widget |
| `syscontrol.ps1` | Resident helper: Core Audio + Windows media session |
| `discord.js` | Discord RPC over the local named pipe |
| `ancs/Program.cs` | iPhone bridge — ANCS notifications, calls and battery over BLE |
| `discord-app.json` | Your Discord client id + secret (never served) |
| `v2/main.js` | V2 native shell — the non-activating window |
| `v2/preload.js` | Bridge exposing keyboard mode to the pages |
| `v2/forks.js` | The forks the drawer can switch between |
| `launch-v2.bat` | Starts V2 (prefers the built app) |
| `v2/build/icon.ico` | App icon, generated by a script rather than shipped as a blob |
| `notes.txt` | The notes widget's store (never served over HTTP) |
