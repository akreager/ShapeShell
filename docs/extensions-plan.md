# Extension support: plan

Branch: `feature/extensions`. Status: planning, nothing built. Replaces the design-only handoff from 2026-09-19. Where the two disagree, this file wins; `CLAUDE.md` wins over both.

## Goal

Let the user install Chrome extensions that are on an allowlist shipped with the app. Pinned extensions sit in a toolbar tray and open their popups. Bitwarden is the first target.

## Target extensions

| Extension | Source | Needs | Difficulty |
|---|---|---|---|
| [Onshape Drawing Comfort](https://github.com/SamDomiono/Onshape-Drawing-Comfort-Dark-Mode) | GitHub only, unpacked, no `key` | MV3; `storage` only; content scripts on `https://*.onshape.com/*` in ISOLATED **and MAIN** worlds, `all_frames`; action popup using only `chrome.storage` | Low. Good first test for the tray and popup host. |
| Bitwarden | Web Store CRX, or build from source (GPL-3) | MV3; action popup; `<all_urls>`; `tabs`, `contextMenus`, `scripting`, `alarms`, `idle`, `webRequest`, offscreen documents, and more (confirm against the pinned manifest) | High. Electron is missing or only partly supports several of these. |

### Bitwarden: two routes

- **Standalone extension, signed into its own vault.** This is the realistic route. It syncs with the same vault as the desktop app.
- **Desktop integration (biometric unlock through the desktop app).** This uses `nativeMessaging`, which Electron does not implement. It would also need a host process outside the Flatpak sandbox. Not planned. We revisit only if the standalone route works and unlocking it becomes the pain point.

## Design changes from the handoff

1. **Popup-driven extensions are supported.** We build our own `chrome.action` host with no `electron-chrome-extensions`, since it is GPL-3. It reads `action.default_popup` and `default_icon`, draws the icons in a tray left of the hamburger, and opens the popup in a `WebContentsView` anchored like the existing popover. Badge text and `action.onClicked` get implemented as needed.
2. **The allowlist needs two ways to identify an extension.** A store CRX has a stable ID derived from its key. A GitHub-only unpacked extension has no `key`, so its ID would depend on its path. For those, the allowlist pins a hash of the reviewed file tree, and the install copies the files to a fixed path (`Extensions/<slug>/`) so the ID, and the extension's storage, stay stable across reinstalls.
3. **Host permissions are granted per allowlist entry, not capped at `cad.onshape.com`.** Bitwarden needs `<all_urls>`, and Onshape sign-in and SSO pass through other hosts. Each broad grant is an explicit, reviewed line in the allowlist.
4. **Build from pinned source where the license allows.** This is the same pattern as `fetch-bridge`: open-source extensions like Bitwarden can be built from a pinned commit instead of trusting a store CRX. This is optional; a pinned CRX hash is also acceptable.

## UI

- Hamburger popover, "Install extension…": opens the portal file chooser (`.crx` or a folder).
- Hamburger popover, "Extensions": lists each extension with pin and remove buttons.
- Tray: pinned extension icons left of the hamburger. It must respect `env(titlebar-area-width)` for left-side window-button layouts. Every click returns focus to the content view. No `role:` items.

## Phases

Each phase ends with something runnable. None of them touch `main` until the feature is done.

0. **API survey.** In a dev build, load both extensions unpacked from a hard-coded path into `persist:onshape`. Log every `chrome.*` call that is undefined or throws. This gives the real gap list for Electron 44.4.1 and decides whether Bitwarden is feasible before anything else is built.
1. **Tray and popup host**, tested with Drawing Comfort. Check the MAIN-world content script and `all_frames` on the `production-drawing-*` iframe.
2. **Bitwarden compatibility.** Shim or implement the missing APIs from phase 0, most likely `contextMenus`, parts of `tabs`, offscreen documents and `idle`. Then test unlock, autofill on the Onshape sign-in page, and autofill in a second window.
3. **Install pipeline and allowlist.** CRX3 parse and signature check, unpacked tree hash, manifest subset checks, safe unpacking (zip-slip, symlinks, size caps), and a re-check on every launch.
4. **Management UI.** List, pin, remove, and a clear message when an install is refused.
5. **Flatpak.** Portal chooser, persistence under `~/.var/app/…`, and no new finish-args.

Regression checks after every phase: SpaceMouse still drives the viewport, the bridge cert is still pinned (rogue-server test), `Seccomp: 2` on the renderers, frame time unchanged, and extension-opened windows go through `createWindow` or are blocked.

## Open questions

## Decisions

- **The allowlist ships with the app; there are no user-added entries (2026-09-19).** Extensions arrive only through ShapeShell releases. We expect few users, and fewer still who need a particular extension, so the friction is acceptable. If demand grows, we can add user entries later behind deliberately discouraging warnings.

## Open questions
- Drawing Comfort's license and how often it changes decide whether we pin its tree hash or ask the author for a store listing with a stable `key`.
