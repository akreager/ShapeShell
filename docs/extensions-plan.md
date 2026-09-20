# Extension support: plan

Branch: `feature/extensions`. Status: phases 0 and 1 done — see [Phase 0 results](#phase-0-results) and [Phase 1 results](#phase-1-results). The tray and popups work; there is no install path yet, so extensions load only from `SHAPESHELL_DEV_EXTENSIONS` when running from source. Replaces the design-only handoff from 2026-09-19. Where the two disagree, this file wins; `CLAUDE.md` wins over both.

## Goal

Let the user install Chrome extensions that are on an allowlist shipped with the app. Pinned extensions sit in a toolbar tray and open their popups. Bitwarden is the first target.

## Target extensions

| Extension | Source | Needs | Difficulty |
|---|---|---|---|
| [Onshape Drawing Comfort](https://github.com/SamDomiono/Onshape-Drawing-Comfort-Dark-Mode) (0BSD) | GitHub only, unpacked, no `key` | MV3; `storage` only; content scripts on `https://*.onshape.com/*` in ISOLATED **and MAIN** worlds, `all_frames`; action popup using only `chrome.storage` | Low. Runs as-is in Electron 44. Good first test for the tray and popup host. |
| Bitwarden 2026.8.0 | Web Store CRX (23MB, 80MB unpacked, 191 files), or build from source (GPL-3) | MV3; action popup; `https://*/*` + `http://*/*`; content scripts on every page at `document_start`; 16 permissions including `tabs`, `scripting`, `webRequest`, `webNavigation`, `contextMenus`, `offscreen`, `notifications`, `idle`, `alarms` | Medium. Needs a polyfill layer, which phase 0 proved works without modifying its files. |

### Bitwarden: two routes

- **Standalone extension, signed into its own vault.** This is the realistic route. It syncs with the same vault as the desktop app.
- **Desktop integration (biometric unlock through the desktop app).** This uses `nativeMessaging`, which Electron does not implement. It would also need a host process outside the Flatpak sandbox. Not planned. We revisit only if the standalone route works and unlocking it becomes the pain point.

## Design changes from the handoff

1. **Popup-driven extensions are supported.** We build our own `chrome.action` host with no `electron-chrome-extensions`, since it is GPL-3. It reads `action.default_popup` and `default_icon`, draws the icons in a tray left of the hamburger, and opens the popup in a `WebContentsView` anchored like the existing popover. Badge text and `action.onClicked` get implemented as needed.
2. **The allowlist needs two ways to identify an extension.** A store CRX has a stable ID derived from its key. A GitHub-only unpacked extension has no `key`, so its ID would depend on its path. For those, the allowlist pins a hash of the reviewed file tree, and the install copies the files to a fixed path (`Extensions/<slug>/`) so the ID, and the extension's storage, stay stable across reinstalls.
3. **Host permissions are granted per allowlist entry, not capped at `cad.onshape.com`.** Bitwarden needs `<all_urls>`, and Onshape sign-in and SSO pass through other hosts. Each broad grant is an explicit, reviewed line in the allowlist.
4. **Missing APIs are supplied by preloads, never by editing extension files.** A service-worker preload (`ses.registerPreloadScript({ type: 'service-worker' })`) and a per-view preload on the popup views we create install the missing namespaces into the extension's own `chrome` object via `contextBridge.executeInMainWorld`, backed by the main process over IPC. The extension tree stays byte-identical to what was reviewed, so the hash pin can be checked on every launch. The Onshape content view still gets no preload, since the frame preload is set only on extension views. The service-worker preload is session-wide, so it also runs for any service worker Onshape registers. There its main-world function reaches only a `location.protocol` guard and returns, and its preload realm exposes nothing.
5. **Build from pinned source where the license allows.** This is the same pattern as `fetch-bridge`: open-source extensions like Bitwarden can be built from a pinned commit instead of trusting a store CRX. This is optional; a pinned CRX hash is also acceptable.

## UI

- Hamburger popover, "Install extension…": opens the portal file chooser (`.crx` or a folder).
- Hamburger popover, "Extensions": lists each extension with pin and remove buttons.
- Tray: pinned extension icons left of the hamburger. It must respect `env(titlebar-area-width)` for left-side window-button layouts. Every click returns focus to the content view. No `role:` items.

## Phases

Each phase ends with something runnable. None of them touch `main` until the feature is done.

0. ~~**API survey.**~~ DONE. `npm run ext-survey`; results below. It ran in a throwaway profile rather than `persist:onshape`, so the survey can never disturb a real sign-in.
1. ~~**Tray and popup host.**~~ DONE; results below. Still outstanding from this phase, because it needs a signed-in session: the drawing-editor content scripts and `all_frames` on the `production-drawing-*` iframe.
2. **Bitwarden compatibility.** Turn the phase-0 polyfill spike into real implementations, then test login, unlock, autofill on the Onshape sign-in page, and autofill in a second window. See [what phase 2 must implement](#what-phase-2-must-implement).
3. **Install pipeline and allowlist.** CRX3 parse and signature check, unpacked tree hash, manifest subset checks, safe unpacking (zip-slip, symlinks, size caps), and a re-check on every launch.
4. **Management UI.** List, pin, remove, and a clear message when an install is refused.
5. **Flatpak.** Portal chooser, persistence under `~/.var/app/…`, and no new finish-args.

Regression checks after every phase: SpaceMouse still drives the viewport, the bridge cert is still pinned (rogue-server test), `Seccomp: 2` on the renderers, frame time unchanged, and extension-opened windows go through `createWindow` or are blocked.

## Phase 0 results

Measured 2026-09-19 on Electron 44.4.1 (Chromium 152.0.7977.78) with `npm run ext-survey` (`scripts/ext-survey.sh`). The harness loads instrumented copies of each extension into a throwaway profile under `dist/ext-survey/`, opens each popup, and loads the Onshape sign-in page with a credential field focused. It runs in three modes. **raw** runs the extensions exactly as Electron would. **stub** swaps missing namespaces for inert stubs, so one run finds every gap rather than only the first. **preload** leaves the code pristine and fills gaps from `scripts/ext-survey/polyfill-preload.js`. `EXT_SURVEY_NO_SHIM=1` drops the measuring shim, to rule it out as a cause.

**Verdict: Bitwarden is feasible.** With the polyfill preload filling Electron's gaps, its pristine service worker boots, its popup renders the real login screen, and the run shows zero API failures.

| Finding | Evidence |
|---|---|
| **Drawing Comfort works unmodified.** Its popup renders and saves settings, with zero failures. | raw mode |
| **Bitwarden as shipped does not start.** Its service worker reads `chrome.webNavigation.onCommitted` at top level, Electron has no `webNavigation`, and registration fails with status 15. The popup then shows a spinner forever. | raw mode |
| **Its full startup gap list** is `webNavigation`, `contextMenus`, `commands`, `permissions`, `sidePanel`, `notifications` (absent), and `tabs.getCurrent` (missing from a partial `tabs`). Electron warns at load that `contextMenus`, `sidePanel`, `webNavigation`, `notifications` and `privacy` are unknown permissions. | stub mode |
| **The preload route works.** A service-worker preload runs before the extension's worker script, and `executeInMainWorld` can add namespaces to its `chrome`. The guard has to live inside the main-world function: the preload realm has no `location`. | preload mode |
| **Electron exposes more than it documents.** `action` (complete, including `setBadgeText`, `setIcon`, `openPopup` and `onClicked`), `alarms`, `idle`, `offscreen`, `clipboard`, `dom`, `storage.session`, `runtime.getContexts`, and `tabs.get`, `onUpdated`, `onActivated` and `onRemoved`. It does not expose `windows`, `webNavigation`, `contextMenus`, `commands`, `permissions`, `notifications`, `sidePanel`, `privacy`, or `tabs.create`, `remove`, `getCurrent` and `captureVisibleTab`. | surface dump |
| **Content-script worlds behave like Chrome.** MAIN-world scripts run, and the page can see their globals. The ISOLATED world is separate. `include_globs` is honored: a non-matching script did not run. | `fixtures/content-worlds` |
| **Electron will not load a `.crx`.** The install pipeline must unpack it. Store CRXs also carry no `key` in `manifest.json`, so the unpacked ID is path-derived unless we add one. | Electron docs; Bitwarden manifest |
| **Loading into in-memory sessions throws.** `persist:onshape` is persistent, so this is fine. MV3 service workers run with `sandbox: true`. | Electron docs; every run |

Harness pitfalls, recorded so they are not rediscovered:
- Chrome refuses to load an extension that contains any file whose name starts with `_`.
- A lone `BrowserWindow` being destroyed quits the app mid-run unless `window-all-closed` has a handler.
- Caching wrapped `chrome.*` functions by function alone cross-wires events, because `addListener` is one shared prototype function. That produced three convincing but fake Bitwarden errors (`extraInfoSpec` rejected, `null.url`, `undefined.status`). The cache must be keyed by owner and function. Any error that disappears under `EXT_SURVEY_NO_SHIM=1` is an artifact.

### What phase 2 must implement

These are ordered by what a logged-in Bitwarden will actually exercise. The survey could not sign in, so the autofill items come from reading the code, not from observing them.

- **`tabs.query`, answered by us.** Bitwarden finds "the current site" with `{active: true, currentWindow: true}` and `{active: true, windowId: chrome.windows.WINDOW_ID_CURRENT}`. Electron supports only `url`, `title`, `audible`, `active` and `muted`. And while our popup has focus, the Onshape view is probably not "active". The polyfill should return the Onshape view of the window the popup belongs to.
- **`windows`.** `WINDOW_ID_CURRENT`, `get`, `getAll`, `getCurrent`, `update` and `create` (the pop-out vault window), mapped onto ShapeShell windows.
- **`webNavigation`.** `getFrame` and `getAllFrames` (autofill targets frames by ID), plus `onCommitted`, `onCompleted` and `onErrorOccurred`, all from main-process `webContents` frame events.
- **`tabs.create`.** It opens the web vault and help links, and should go to `shell.openExternal`. `tabs.remove` and `captureVisibleTab` as needed.
- **`notifications`.** Bitwarden falls back to a class that throws "Notification clicked is not supported" when the namespace is absent. These can map onto Electron's `Notification`.
- **`permissions`.** `contains` and `getAll` report the manifest's grants. `request` always refuses, so optional `nativeMessaging` and `privacy` stay off.
- **`commands`.** `getAll` plus `onCommand`. Keyboard shortcuts such as `Ctrl+Shift+L` (autofill) would need a deliberate choice, since every plain shortcut belongs to Onshape.
- **Inert:** `contextMenus` (no right-click menu yet) and `sidePanel`.

## Phase 1 results

Built 2026-09-20. `npm run smoke-extensions` is the regression test: it builds a real ShapeShell window in its own profile, loads unpacked extensions, clicks each tray icon, and screenshots the toolbar and popups into `dist/smoke-extensions/`. With no arguments it runs `scripts/fixtures/action-probe`, a fixture whose whole job is to exercise badge, title and click routing.

What exists now:

- **`src/extensions/manager.js`** loads extensions, holds each one's action state, and turns manifest icons into data URLs for the toolbar. Loading is dev-only (`SHAPESHELL_DEV_EXTENSIONS`, ignored when packaged) until phase 3.
- **`src/extensions/preload.js`** runs inside extension contexts, reports `chrome.action` calls to the manager, and supplies the namespaces Electron lacks. It is the phase-0 spike, now permanent.
- **`src/extensions/popup.js`** is one popup host per window: it sizes to content like Chrome, hangs from the right edge of its tray icon, clamps inside the window, and closes on blur or Escape.
- **The toolbar tray** sits left of the hamburger, drawing each action's icon, title and badge, with a lettered placeholder when an extension has no readable icon.

Verified in one run: both popups open with their real content (Drawing Comfort 400×569, Bitwarden 480×600), Escape closes them, a window resize keeps the popup inside the window, the main menu and an action popup never coexist, and the fixture's badge goes `7` → `OK` when its icon is clicked, proving `chrome.action.onClicked` reaches the background worker.

Measured behaviour worth keeping:

- **Electron defines all of `chrome.action` but draws nothing and never fires `onClicked`.** The preload replaces `onClicked` outright, and the tray is what dispatches it. Calls are still forwarded to Electron's own implementation so `getBadgeText` and friends stay consistent.
- **A service worker's IPC is reachable only per worker**, through `ServiceWorkerMain.ipc` after `running-status-changed`. There is no `ipcMain` route for them.
- **Extension load warnings arrive as Node `process.on('warning')` events** named `ExtensionLoadWarning`, not on any Electron API.
- **`enablePreferredSizeMode` gives Chrome's size-to-content popup** through `preferred-size-changed`.
- **Do not refocus the content view after opening a popup**: the popup closes on blur, so refocusing would shut it instantly.
- **Clicking the icon of an open popup arrives after the popup has already blurred shut**, so a toggle needs a short suppression window or the popup flickers and reopens.
- **`src/main.js` now exports `createShellWindow` and `registerIpc` and only self-starts when it is Electron's entry point**, which is what lets the smoke test drive a real window.

Known gaps, deliberately left for later phases:

- `chrome.action.onClicked` passes no tab argument, because `tabs.query` is not implemented until phase 2.
- `setIcon` accepts a path, not `imageData`.
- Every loaded extension appears in the tray; pin and unpin are phase 4.
- A popup's preferred size includes its scrollbar, so a scrolling popup is a few pixels wider than in Chrome.

## Decisions

- **The allowlist ships with the app; there are no user-added entries (2026-09-19).** Extensions arrive only through ShapeShell releases. We expect few users, and fewer still who need a particular extension, so the friction is acceptable. If demand grows, we can add user entries later behind deliberately discouraging warnings.

## Open questions

- **Does Bitwarden need its store ID at runtime?** Unpacked, its ID is derived from the install path: stable for one install, but different from the store's `nngceckbapebfimnlniiiahkandclblb`. The survey never signed in, so this is untested. Login, SSO, 2FA and passkeys in phase 2 are where a dependency would show up. If one does, the install can write the CRX's own public key into `manifest.json` as `key`. That is a deterministic change, so the integrity check would compare against the pristine hash plus that one field.
- **Drawing Comfort's pin.** It is 0BSD and changes often ("V2 Experimental"). We pin a tree hash at a reviewed commit, or ask the author about a store listing with a stable `key`.
