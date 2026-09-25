# Extension support: plan

Branch: `feature/extensions`. Status: phases 0-4 and 6 done — see [Phase 0 results](#phase-0-results), [Phase 1 results](#phase-1-results), [Phase 2 results](#phase-2-results), [Phase 3 results](#phase-3-results) and [Phase 4 results](#phase-4-results-manage-extensions). Bitwarden works end to end (login, 2FA, unlock, autofill), verified against a real vault. Extensions are installed, updated, pinned and removed from the **Manage Extensions** window, which downloads supported extensions itself; `SHAPESHELL_DEV_EXTENSIONS` still side-loads from source for development. Replaces the design-only handoff from 2026-09-19. Where the two disagree, this file wins; `CLAUDE.md` wins over both.

## Goal

Let the user install Chrome extensions from a supported list shipped with the app, and, behind an explicit warning, anything else. Pinned extensions sit in a toolbar tray and open their popups. Bitwarden is the first target.

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
5. **Build from pinned source where the license allows.** This is the same pattern as `fetch-bridge`: open-source extensions like Bitwarden can be built from a pinned commit instead of trusting a store CRX. This is optional; a pinned CRX hash is also acceptable. *Superseded 2026-09-24: store extensions now track their newest release, verified by signature and a permission ceiling, with no byte pin. See [Decisions](#decisions).*

## UI

- ~~Hamburger popover, "Install extension…"~~ and ~~"Extensions"~~: replaced 2026-09-24 by a single **Manage Extensions…** item, which opens its own window. See [Phase 4 results](#phase-4-results-manage-extensions).
- Tray: pinned extension icons left of the hamburger. It must respect `env(titlebar-area-width)` for left-side window-button layouts. Every click returns focus to the content view. No `role:` items.

## Phases

Each phase ends with something runnable. None of them touch `main` until the feature is done.

0. ~~**API survey.**~~ DONE. `npm run ext-survey`; results below. It ran in a throwaway profile rather than `persist:onshape`, so the survey can never disturb a real sign-in.
1. ~~**Tray and popup host.**~~ DONE; results below. Still outstanding from this phase, because it needs a signed-in session: the drawing-editor content scripts and `all_frames` on the `production-drawing-*` iframe.
2. ~~**Bitwarden compatibility.**~~ DONE; login, 2FA, unlock and autofill verified against a real vault. See [Phase 2 results](#phase-2-results).
3. ~~**Install pipeline and allowlist.**~~ DONE; results below. The menu can install; the management UI is phase 4.
4. ~~**Management UI.**~~ DONE; results below. Redesigned 2026-09-24 as the Manage Extensions window.
5. **Flatpak.** Portal chooser, persistence under `~/.var/app/…`, and no new finish-args.
6. ~~**Getting the package in the first place.**~~ DONE with phase 4: supported extensions are downloaded by the app. See [Installing without a browser](#installing-without-a-browser).

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
- **`require.main === module` is always false in Electron's main process.** `require.main` is Electron's own internal module, never the entry file. Guarding startup with it meant `npm start` ran, opened no window, and printed no error. `src/main.js` exports `createShellWindow` and `registerIpc` for the smoke test and starts unless `SHAPESHELL_TEST_HARNESS=1` says a harness is driving it.
- **`npm run smoke-launch` covers the entry path** that the extension smoke test cannot: it starts the app the way `npm start` does and asks Chromium over its debugger port what it is rendering, expecting the toolbar, the popover and Onshape. It has a negative control (`SHAPESHELL_TEST_HARNESS=1`), it picks a fresh port per run so a leftover instance cannot answer for it, and it launches the Electron binary directly, since killing `npx electron` orphans the real process.

Known gaps, deliberately left for later phases:

- `chrome.action.onClicked` passes no tab argument, because `tabs.query` is not implemented until phase 2.
- `setIcon` accepts a path, not `imageData`.
- Every loaded extension appears in the tray; pin and unpin are phase 4.
- A popup's preferred size includes its scrollbar, so a scrolling popup is a few pixels wider than in Chrome.

## Phase 2 results

Built 2026-09-20, after a real sign-in attempt showed Bitwarden getting through login and 2FA and then failing to load the vault, with three distinct errors:

| Symptom in the log | Cause | Fix |
|---|---|---|
| `Cannot read properties of undefined (reading 'WINDOW_ID_CURRENT')` | No `chrome.windows` at all | A real window and tab model |
| `NOTREACHED hit. Unexpected view type found: 0` every 10s | Bitwarden polls `chrome.runtime.getContexts`; Chromium does not recognise a `WebContentsView` as an extension view | `getContexts` answered by us, so that code path is never entered |
| `Error: Null or undefined account` | Expected downstream of the above | To be confirmed with a real login |

**The model:** ShapeShell has no tabs, so each window is a window holding exactly one tab — its Onshape content view. Tab ids are that view's `webContents` id, window ids are the `BaseWindow` id, and both last as long as the window. `src/extensions/api-host.js` owns it; the preload installs thin wrappers that call through.

Implemented: `tabs.query` (including `currentWindow` and `WINDOW_ID_CURRENT`, which Electron ignores), `tabs.get`, `tabs.update`, `tabs.getCurrent`, `tabs.create`, all of `windows`, `runtime.getContexts`, and `webNavigation` — `getFrame` and `getAllFrames` plus live `onBeforeNavigate`, `onCommitted`, `onDOMContentLoaded`, `onCompleted`, `onErrorOccurred` and `onHistoryStateUpdated` fed from the content view.

Deliberate policy choices:

- **An extension cannot navigate the Onshape view.** `tabs.create` and `tabs.update` with an `http(s)` url hand it to the system browser instead, which is where Bitwarden's web vault and help links belong.
- **`windows.create` gives an extension's own page a real window** (Bitwarden's popped-out vault); anything on the web goes to the browser. `windows.remove` only closes windows we opened for an extension.
- **`permissions.request` still refuses**, so optional `nativeMessaging` and `privacy` stay off.

Verified by `npm run smoke-extensions` through a new fixture (`scripts/fixtures/api-probe`) that asks the same questions a password manager asks, from both the worker and a popup, against a local page served over HTTP with one iframe:

- `tabs.query({active: true, currentWindow: true})` returns the Onshape tab with its real url and status, and `windowId: WINDOW_ID_CURRENT` agrees with it
- `windows.getCurrent({populate: true})` holds exactly that tab, and the popup's window matches the worker's
- `webNavigation.getAllFrames` returns the page and its iframe with the right parent relationship, and events fire on reload
- `runtime.getContexts` reports `BACKGROUND` and, while it is open, `POPUP`
- **`scripting.executeScript` reaches a subframe by `frameId`** — the mechanism autofill needs — as well as the main frame

Measured behaviour worth keeping:

- **Popups must not be dismissed on focus loss.** A page finishing a load takes focus by itself, which closed the popup while it was being read. Dismissal now watches for a real `mouseDown` in the content view or toolbar, or the window losing focus, which is both closer to Chrome and stable. A smoke check covers it.
- **`listActions()` builds fresh objects on every call**, so `indexOf` against a later call is always `-1`. The smoke test finds tray buttons by title.
- **A service worker's startup probe runs before the window has finished loading**, so anything asking "what is the user looking at?" at that moment sees an empty url and no frames. Real extensions re-query on events; the fixture re-probes on demand.

Confirmed against a real vault on 2026-09-20: **login, 2FA, vault unlock and autofill on the Onshape sign-in page all work.** Onshape's sign-in reveals its password field only after the email step, so the extension has to be clicked a second time to fill it.

Found while following that up:

- **Electron defines `chrome.tabs.onUpdated`, `onActivated`, `onCreated`, `onRemoved` and `onReplaced` but never fires them.** An extension therefore never learns the page changed, which is how Bitwarden decides to refresh its icon and autofill state. Ours replace them and are fed from the window: load and navigation state, title changes and audio for `onUpdated`, window focus for `onActivated` (one tab per window means focusing a window is activating its tab), and window open/close for the rest. `windows.onCreated`, `onRemoved` and `onFocusChanged` come from the same place.
- **`setIcon({path: {...}})` does reach the tray**, verified by a fixture that swaps icons on click — this is the call Bitwarden makes when the vault locks or unlocks. It ignores `tabId`, which is harmless when a window holds one tab.
- **`Error: The account switch process did not complete in a reasonable amount of time.`** appears once at startup. It is Bitwarden's own 1-second timeout waiting for its account state to settle, not a missing API, and the vault works regardless. Watch it; do not chase it unless something actually misbehaves.

**Bug found in the field and fixed (2026-09-20): autofill died after an idle period.** Every extension API call started failing with `No handler registered for 'shapeshell-ext:invoke'`, and Bitwarden reported `Autofill dispatch stopped: live-tab set could not be established`. An MV3 service worker is stopped when idle and restarted on demand, and **the restart produces a new `ServiceWorkerMain` instance under the same version id**. The IPC handlers were attached once per version id, so the restarted worker had no route to the main process. They are now keyed by a `WeakSet` of worker instances, calls retry briefly on a missing handler to cover the startup race, and a stopped worker is woken (`startWorkerForScope`) when an event needs delivering, which is what Chrome does.

The smoke test reproduces it: it waits for that extension's own worker to go idle and stop, then uses the extension again. Waiting for *any* worker to stop was not enough — the other fixture's worker went idle first and the check passed against the broken code. Verified to fail on the old keying (the popup hangs at "running…", the same symptom seen in use) and to pass on the fix.

**Waking a sleeping worker has to be selective (2026-09-20).** Waking one for every event flooded the log with `Failed to start service worker` for Drawing Comfort, which is content-script-only and has no worker at all. Now an extension is only woken if its manifest declares a service worker, only for events one of its contexts has actually registered a listener for (the preload reports each event name on first `addListener`), and a wake failure is logged once per extension rather than per event. This mirrors Chrome, which only wakes a worker for events the extension listens to.

**Every `chrome.action` update is now logged** (`[extensions] action <name>: {...}`), because a tray icon that fails to change is otherwise undiagnosable. `setIcon` via `imageData` is reported as unsupported instead of being dropped silently, and an unreadable or out-of-tree path is logged too.

**`chrome.storage.onChanged` never fires in Electron — found 2026-09-20, and it was the reason Bitwarden's tray icon never showed "unlocked".** With the action log in place, Bitwarden was seen calling `setIcon` with `/images/icon38_locked.png` and nothing else, ever. Our tray was fine: driving Bitwarden's own call shapes through it (absolute path, relative path, size map) changed the icon every time. The extension simply believed the vault was still locked.

Two candidates, tested in order:

- **`chrome.storage.session` shared between contexts?** Yes, in both directions. Ruled out.
- **`chrome.storage.onChanged` delivered across contexts?** No — a worker listening on `storage.onChanged`, `storage.local.onChanged` and `storage.session.onChanged` received **nothing** from writes made in the popup, or from its own. Extensions learn about shared state changes this way; Bitwarden's background finds out the vault was unlocked exactly here, which also explains the recurring `The account switch process did not complete in a reasonable amount of time`.

Implemented: the preload wraps `set`, `remove` and `clear` on every storage area, reads the old values, performs the write, and reports the change to the main process, which broadcasts it to all of that extension's contexts — including the writer, as Chrome does. Both the global `storage.onChanged` and the per-area `storage.<area>.onChanged` are replaced, since Electron fires neither.

Two known limits: content scripts get no preload, so writes made there notify nobody; and every write now costs an extra read to compute `oldValue`.

**Confirmed fixed (2026-09-20): the tray icon now follows Bitwarden's lock state**, including the logged-out grey icon and the badge count. `chrome.storage.onChanged` was the whole story.

**Crash on closing a window with a popup open (2026-09-20).** `ExtensionPopup.close()` also runs from the window's own `closed` handler, where the window and its child views are already gone; removing the view then threw `Object has been destroyed` out of an event handler, which Electron shows as a main-process crash dialog. It now skips the teardown when the window is already destroyed, and `layout` and the dismissal watchers guard the same way. The smoke test opens a second window with a popup showing and closes it, verified to throw on the old code.

`SMOKE_SKIP_IDLE=1` skips the 120-second idle-worker wait while iterating; the full run keeps it.

Still open: the inline autofill menu (the small icon Chrome shows inside a login field) does not appear. Bitwarden injects it as iframes from `web_accessible_resources` declared with `use_dynamic_url: true`, which is the first thing to check. Not required — the toolbar button fills correctly — so it is worth a diagnostic probe before any work.

## Phase 3 results

Built 2026-09-20. `npm run test-extensions` is the test suite: plain Node, no Electron, 41 checks. It builds its own fixtures — a real RSA key, real signatures, real zips — so tampering and malicious archives are tested honestly rather than simulated, and every refusal has its own test.

Four modules, no new dependencies:

- **`crx.js`** parses CRX3, derives the extension id from the signing key, and verifies the signature. It accepts only a proof whose key derives the id the file declares, so a valid signature from an unrelated key proves nothing. It carries a small protobuf reader, since the header is a protobuf.
- **`zip.js`** is a deliberately strict archive reader: stored and deflated entries only, no zip64, no encryption, and refusals for absolute paths, traversal, backslashes, NUL bytes, symlinks, oversized files and CRC mismatches. Written rather than pulled in, because it parses attacker-influenced bytes and a dependency here would be a far larger surface than the allowlist is meant to permit.
- **`allowlist.js`** loads the shipped list, hashes trees (path plus content, sorted, so it is stable), and checks a manifest against its entry: MV3 only, a minimum version, and permissions, optional permissions, host permissions and content-script matches all subsets of what the entry approves.
- **`install.js`** runs identify → allowlist → pinned hash → signature → manifest policy → unpack into staging → rename into place → write a marker. `verifyInstalled` re-runs the checks on every launch.

Decisions made while building it:

- **An unpacked folder is identified by its contents, not its folder name.** A clone can be called anything, so the tree hash decides which entry it is, and that entry supplies the name it installs under.
- **The marker records the tree hash of what actually landed on disk**, because a CRX's file hash cannot be rechecked once unpacked. Every launch re-hashes the installed files, so a modified install does not load.
- **The marker sits beside the version directory, not inside it**, so it cannot disturb the hash it records, and it is written after the rename so it never describes a half-written tree.
- **Signature before pin:** a corrupt file should say it is corrupt, not that it was never reviewed.

Verified beyond the unit tests: the real Bitwarden CRX installs against the shipped allowlist and derives its true Web Store id (`nngceckbapebfimnlniiiahkandclblb`), the real Drawing Comfort folder installs identified purely by its contents, and changing one byte of either makes it refuse. The smoke test covers the whole path in a running window — an unlisted extension refused, an allowlisted one installed, loaded and drawn in the tray.

*(Superseded by phase 4: these moved into the Manage Extensions window as the unsupported-install buttons.)* The hamburger menu has **Install Extension…** for a `.crx` and **Install Unpacked Folder…** for a folder, each opening a file chooser (the xdg-desktop-portal one under Flatpak, so no home access is needed) and reporting refusals with their reasons.

These are two menu items because they have to be. A single dialog asking for both `openFile`
and `openDirectory` becomes a **folder-only** chooser on Linux and Windows, which is how it
shipped in phase 3: the `.crx` could not be selected, and "Open" returned whichever folder the
chooser was showing. The refusal then named the hash of that folder, so a correct pipeline
refusing a bad path read exactly like the allowlist rejecting a good build. `npm run
smoke-extensions` now asserts neither dialog asks for both.

## Phase 4 results: Manage Extensions

Built 2026-09-24 from the approved mockup. The hamburger menu's two install items are replaced by **Manage Extensions…**, which opens a window of its own (as browsers do, so it appears in the desktop's overview and window switcher; one at a time, and it closes with the last main window).

- **`src/chrome/manage.html`** + **`manage-preload.js`**: one row per supported extension, then one per installed unsupported one. Each row has a source link (opened in the default browser; the page sends a key and main looks the URL up), install/update, pin and remove. Download progress, an update-refused message and a "Not loaded" reason show on the row. Remove asks through a native dialog.
- **Unsupported installs** go through the footer buttons, after the "here be dragons" dialog: Cancel is focused, and the confirm button stays disabled until "I understand" is ticked. Once installed they behave like any other extension, with an "Unsupported" badge. A store-signed unsupported extension can also be updated from the store.
- **`src/extensions/updates.js`**: the Web Store update check (one request for every installed store id, `v=0.0.0.0` so it returns the newest build with its URL, sha256 and size), CRX download, and GitHub archive download. All through the default session, with size ceilings. The download's sha256 is transport integrity only; install.js still verifies the signature.
- **Update checks**: once at launch in the background, and when the window opens. An available update lights a dot on the Manage Extensions menu item. Nothing is installed automatically.
- **Pins** live in `extension-prefs.json` in userData. A new install is pinned; unpinning hides it from the tray.
- **Look**: system font, light/dark from the system (the page via `prefers-color-scheme`, the title strip via `nativeTheme`, so the native window buttons sit on a matching strip), neutral greys and a fixed accent, since Chromium on Linux does not map CSS `AccentColor` to the desktop theme reliably.

**Trust model.** A store extension on the list installs its newest release if the CRX signature proves the listed id and the manifest stays under the entry's floor and permission ceiling. There is no byte pin. A build that asks for more is refused, and an update refused this way leaves the installed version running: `install.js` only calls back to unload it after every check has passed. A supported id arriving through the unsupported path is still held to its entry. Drawing Comfort installs from GitHub's archive of the reviewed commit, which hashes identically to a clone (verified), and stays pinned. An unsupported install must still parse, and a CRX must still verify.

Found and fixed along the way:

- **Installed extensions now update in place at a fixed path** (`Extensions/<key>/current`). Electron derives an unpacked extension's id from its path, and `chrome.storage` is keyed by the id, so the phase 3 layout (`<key>/<version>`) would have wiped an extension's data on every update. Existing installs keep their version-named directory, recorded as `dir` in the marker, so their id never changes.
- **Chromium deletes `_metadata/` from every unpacked extension it loads.** Store CRXs ship `_metadata/verified_contents.json`, so under phase 3 the first launch changed the installed tree and **every later launch refused Bitwarden as "changed on disk"**, reporting it only in the log. The installer now never writes `_metadata/`. An install already in that state shows "Not loaded" with a **Reinstall** button, which rewrites it in place and keeps its id and data.
- **`hashEntries` sorted differently from `hashTree`** (`localeCompare` against code-unit order), so an archive could never match its folder's pin. It had no caller until now.

Verified: `npm run test-extensions` 66 passed (`TEST_NETWORK=1` adds a live store download and a live GitHub archive install, both passing). `npm run smoke-extensions` covers the menu entry, the rows, light and dark screenshots, the warning's gating, an unsupported install, pin and unpin reaching the tray, and removal; `SMOKE_NETWORK=1` adds a one-click Bitwarden install from the store, which goes through checking, downloading and installing and still passes its checks after Chromium has loaded it. `npm run smoke-launch` passes.

Not yet verified: the native window buttons' strip colour against a light GNOME theme, and the window on KDE or another desktop. A screen capture does not include the natively drawn buttons.

## Installing without a browser

**Resolved 2026-09-24**, as recommended below: signed store builds track the newest release,
unpacked builds stay pinned. Implemented in phase 4; the reasoning is kept as the record.

Originally deferred to a later release; raised 2026-09-20 when the owner found they had no way to obtain
a `.crx` at all, having no Chrome installed. Today the only route is `curl` against Google's
update endpoint, which is what `scripts/ext-survey.sh` does — a developer step, not a feature.
Requiring users to install Chrome in order to de-Chrome their Onshape session is absurd.

**The app does not need a URL from the user.** The allowlist already names every installable
extension and pins its bytes, so ShapeShell knows the ids. The menu can simply offer what is
on the list and fetch it:

```
https://clients2.google.com/service/update2/crx?response=redirect
  &prodversion=<chromium version>&acceptformat=crx3&x=id%3D<id>%26uc
```

A pasted Web Store URL would be a second way in (take the 32-character id out of the path),
but it is the weaker entry point: it invites users to paste a URL for something not on the
list, only to be refused.

**The download needs no trust of its own.** It feeds the existing pipeline unchanged, and the
allowlist check is the gate: a wrong, tampered or substituted file fails before anything is
unpacked. Fetching over the network is therefore a convenience, not a new trust decision.
Implementation notes: fetch with `net.request` in the **default** session, never
`persist:onshape`, so no Onshape cookies are attached; Bitwarden is 23MB, so it needs a size
ceiling and some progress feedback; Flatpak already has network access, so no new finish-args.

**The open problem is version skew**, and it is the reason this is not simply phase 4 work.
The store serves the *newest* build, while `crxSha256` pins one reviewed build, so the moment
Bitwarden ships an update the download stops matching and every user is stuck until ShapeShell
cuts a release. Keeping a hard pin and a live download together is not workable.

The way out is to treat signed and unsigned extensions differently, because they offer
different evidence:

- **A store CRX is signed.** Verifying the signature against the allowlisted id proves the
  publisher who owns that id produced this file — the same guarantee Chrome itself gives. Pair
  that with `minVersion` and the manifest policy check, and a fresh build can be accepted
  without a byte pin. What is lost is "a human looked at these exact bytes"; what is kept is
  authorship, a version floor, and a permission ceiling that a surprising update would trip.
- **An unpacked folder is not signed.** Drawing Comfort has no key and no id, so its tree hash
  is the only evidence there is. It stays pinned, with no live-download path.

That split is the recommendation, but it is a real loosening of the current model and should
be decided deliberately rather than slipped in with the download button.

## Decisions

- **An extension's id is left path-derived; the store key is not injected (2026-09-20).** Bitwarden's login, 2FA, unlock and autofill all work with an id derived from its install path, so nothing depends on the Web Store id at runtime. The installed path is fixed under the app's data directory, so the id is stable across launches and updates.
- **The supported list is the extension experience; anything else installs behind a warning (2026-09-24).** Supersedes the allowlist-only decision below. The two install menu items are replaced by **Manage Extensions…**, a separate window (as browsers do) listing supported extensions. Each row has a source link (Web Store or GitHub, opened in the default browser), install/update, pin and remove. Footer buttons install an unsupported `.crx` or unpacked folder after a "here be dragons" dialog: Cancel is the default, and confirm stays disabled until an "I understand" box is ticked. Once installed, an unsupported extension behaves like any other (pin, remove), with an "Unsupported" badge.
  - **Store extensions track the latest release.** This resolves the version skew in [Installing without a browser](#installing-without-a-browser): a store CRX is accepted on a valid signature for the listed id, a version floor, and a permission ceiling. A build that asks for more than the ceiling is refused and the installed version kept. There is no byte pin. Unpacked extensions (Drawing Comfort) stay pinned.
  - **Updates are manual.** Nothing installs automatically. ShapeShell checks once at launch (one cookieless request per store extension in the default session) and again when the window opens; an available update shows as a dot on the Manage Extensions menu item and in the window, nothing else.
  - **The first release lists only Bitwarden and Drawing Comfort.** Extending support should mostly mean editing the list, not the app.
  - **Look:** system font, light/dark from the system, native window buttons, neutral greys and a fixed accent, so it fits GNOME without imposing Adwaita elsewhere. Approved mockup: https://claude.ai/artifact/58J2Jax1YdB8T3DJEjJFrT
- ~~**The allowlist ships with the app; there are no user-added entries (2026-09-19).**~~ Superseded 2026-09-24, above.
  Original text: Extensions arrive only through ShapeShell releases. We expect few users, and fewer still who need a particular extension, so the friction is acceptable. If demand grows, we can add user entries later behind deliberately discouraging warnings.

## Open questions

- **Drawing Comfort's pin.** It is 0BSD and changes often ("V2 Experimental"). We pin a tree hash at a reviewed commit, or ask the author about a store listing with a stable `key`.
