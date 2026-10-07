// ============================================================================
//  Bridge between the dashboard pages and the native shell.
//
//  The pages are the same ones V1 served to a browser, so everything here is
//  additive: `window.y70native` simply does not exist when the dashboard is
//  opened in a normal browser, and the shell hides the native-only controls.
// ============================================================================
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("y70native", {
  version: 2,

  // The window is created non-focusable so taps never pull focus off a game.
  // That also means no keystrokes reach it — call this to borrow the keyboard
  // for a moment, and call it again with false to go back to passive.
  setKeyboardMode: (on) => ipcRenderer.invoke("y70:keyboard", !!on),
  getKeyboardMode: () => ipcRenderer.invoke("y70:keyboard-state"),
  onKeyboardMode: (fn) => {
    ipcRenderer.on("y70:keyboard-mode", (_e, on) => fn(!!on));
  },

  // Opens a normal, focusable window for an OAuth sign-in and closes it again
  // once the dashboard has the token.
  openAuth: (url) => ipcRenderer.invoke("y70:auth", url),

  // True only in the installed build. Start-at-login is only reliable there.
  isPackaged: () => ipcRenderer.invoke("y70:packaged"),

  // Windows start-at-login, written natively to the Run key.
  getAutoStart: () => ipcRenderer.invoke("y70:autostart"),
  setAutoStart: (on) => ipcRenderer.invoke("y70:autostart", !!on),
  getShowInTaskbar: () => ipcRenderer.invoke("y70:taskbar"),
  setShowInTaskbar: (on) => ipcRenderer.invoke("y70:taskbar", !!on),

  // Auto-update, from the project's public GitHub Releases.
  version: () => ipcRenderer.invoke("y70:version"),
  updateState: () => ipcRenderer.invoke("y70:update-state"),
  checkUpdate: () => ipcRenderer.invoke("y70:update-check"),
  installUpdate: () => ipcRenderer.invoke("y70:update-install"),
  onUpdate: (fn) => { ipcRenderer.on("y70:update", (_e, s) => fn(s)); },

  // Forks: other lines of this app, each with its own releases. Switching
  // downloads the other fork's latest build; restarting installs it.
  forks: () => ipcRenderer.invoke("y70:forks"),
  switchFork: (id) => ipcRenderer.invoke("y70:fork-switch", id),
  cancelForkSwitch: () => ipcRenderer.invoke("y70:fork-cancel"),
  onForks: (fn) => { ipcRenderer.on("y70:forks", (_e, s) => fn(s)); },

  // Web apps (YouTube / TikTok) run in a native view the main process parks
  // over the rectangle the page reports, because neither site can be framed.
  webPlace: (site, opts) => ipcRenderer.invoke("y70:web-place", site, opts),
  webHideAll: () => ipcRenderer.invoke("y70:web-hide-all"),
  webAction: (site, action, arg) => ipcRenderer.invoke("y70:web-action", site, action, arg),
  webState: (site) => ipcRenderer.invoke("y70:web-state", site),

  // Refuses keyboard mode entirely while on.
  getPassiveLock: () => ipcRenderer.invoke("y70:passive-lock"),
  setPassiveLock: (on) => ipcRenderer.invoke("y70:passive-lock", !!on),
  keyboardTouch: () => ipcRenderer.invoke("y70:keyboard-touch"),
  focusReport: () => ipcRenderer.invoke("y70:focus-report"),

  // Parks another program's window on the panel (a Snapchat or Discord call)
  // and holds it in the slot the widget reports.
  pinList: () => ipcRenderer.invoke("y70:pin-list"),
  pinState: () => ipcRenderer.invoke("y70:pin-state"),
  pinSet: (hwnd, title, proc) => ipcRenderer.invoke("y70:pin-set", hwnd, title, proc),
  pinClear: () => ipcRenderer.invoke("y70:pin-clear"),
  pinPlace: (opts) => ipcRenderer.invoke("y70:pin-place", opts),
  onPin: (fn) => { ipcRenderer.on("y70:pin", (_e, s) => fn(s)); },

  // The PC's screensaver (Wallpaper Engine's when installed), and putting this
  // panel back on top of it without waking the main monitor.
  screensaver: (action) => ipcRenderer.invoke("y70:screensaver", String(action || "state")),
  raise: () => ipcRenderer.invoke("y70:raise"),

  reload: () => ipcRenderer.invoke("y70:reload"),
  quit: () => ipcRenderer.invoke("y70:quit"),
  displays: () => ipcRenderer.invoke("y70:displays"),
});
