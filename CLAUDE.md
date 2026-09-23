# ShapeShell

Chrome-less Electron shell for cad.onshape.com with a live 6-DOF SpaceMouse bridge baked in (no manual bridge process, no manual cert import, no Tampermonkey), distributed as a Flatpak, with Stream Deck page switching via StreamController.

Full spec/handoff: [onshapeAppliance.md](onshapeAppliance.md). This file is the condensed working reference — read the handoff for the "why" behind anything below.

**Status: all seven milestones complete. Flatpak is the only supported format.** Hardware WebGL verified, custom window chrome, and live 6-DOF SpaceMouse navigation driving the Onshape viewport — see [Milestone 1 results](#milestone-1-results) and [Bridge integration](#bridge-integration). Two of the seven needed no work at all: Onshape dropped its platform sniff (4), and StreamController already does the Stream Deck job against ShapeShell's `wm_class` (7) — see [docs/streamdeck.md](docs/streamdeck.md).

**Naming (2026-09-19).** Renamed from "Onshape Appliance" to **ShapeShell**, app ID `io.github.akreager.ShapeShell`, ahead of a public release on GitHub (`akreager/ShapeShell`). The old name and Onshape's own logo as the icon were trademark risks and would be rejected by Flathub; `com.allen.*` also implied a domain the owner doesn't control. The app ID determines where user data lives (`~/.var/app/<id>/` in Flatpak, `~/.config/ShapeShell/` from source), so it must not change again after people install it. The icon is an original isometric cube with RGB faces (`build/icon.svg`, rasterised by `npm run icons`); it replaced Onshape's logo, which remains in this repo's earlier git history — one reason the public GitHub repo starts from a fresh single commit. The SVG carries an Anthropic-signed C2PA provenance manifest (no personal data); editing the SVG invalidates that signature.

## Locked decisions — do not re-litigate

| Area | Decision | Reason |
|---|---|---|
| Engine | Electron | Tauri's WebKitGTK backend has WebGL/three.js instability on Linux — breaks Onshape's viewport. A Chromium fork is disproportionate (100GB+ disk, 16GB+ RAM, patch burden). |
| Bridge | `kchellappan/spacemouse_linux_ws` (Go), built into `resources/bridge/` by `npm run fetch-bridge` | Still the single static binary that bundles into `extraResources` with zero runtime deps; built from a pinned commit rather than committed, since it is 7.7MB and Go is already a build-time dependency. |
| ~~`navigator.platform` spoof~~ | **DROPPED — no longer needed.** | Onshape no longer gates the SpaceMouse path on `navigator.platform`. Verified 2026-09-17 against the live bundle `woolsthorpe.1b7f617f1ff70058bc61.js`: `navigator.platform` appears exactly once, in a generic OS classifier; `Win32` appears zero times; and `_3Dconnexion.prototype.connect` fires its XHR unconditionally. No CDP injection, no Tampermonkey. |
| Cert trust | `session.setCertificateVerifyProc` scoped to `127.51.68.120:8181` only | Never import the bridge's self-signed CA into the OS/browser trust store. |
| ~~Loopback alias~~ | **DROPPED — not needed on Linux.** | The kernel installs a `local 127.0.0.0/8 dev lo` route, so *every* `127.x.x.x` address is bindable and routable with no configuration. Measured: bound `127.51.68.120:8181` and completed a round-trip with no alias present, and the bridge serves there unprivileged. The original assumption came from macOS, where only `127.0.0.1` is routed to `lo0`. This deletes the `pkexec` helper, the systemd unit and the whole privileged first-run step, and makes the app portable to any Linux machine. |
| Packaging | **Flatpak only** (decided 2026-09-19); other formats are user-built and unsupported | Flatpak is the only format that keeps Chromium's sandbox, integrates the icon and launcher, and installs without sudo. `.deb` also works but needs sudo; AppImage runs unsandboxed on Ubuntu 24.04+. See [Packaging](#packaging-milestone-5). |
| Stream Deck | **StreamController**, configured to match ShapeShell's `wm_class`. No daemon in this repo. | It already does HID access, key dispatch and focus-driven page switching on Wayland, and it is packaged. The superseded plan — a systemd `--user` daemon on `python-elgato-streamdeck` → `ydotool` — would have rebuilt all of that, worse. See [docs/streamdeck.md](docs/streamdeck.md). |

## Architecture

```
ShapeShell/
├── src/
│   ├── main.js              # Electron main process
│   ├── chrome/              # toolbar.html, popover.html, preload.js
│   ├── bridge.js            # spawns/stops the bridge, pins its TLS cert
│   └── window-state.js      # window bounds persistence
├── resources/
│   └── bridge/               # gitignored; built by scripts/fetch-bridge.sh:
│                             #   spacemouse-bridge, LICENSE, LICENSE.gorilla-websocket, PINNED_COMMIT
├── scripts/                  # env-repair, run, package, fetch-bridge, gpu-check, fix-sandbox
├── build/                    # icon.svg, icon.png, icons/NxN.png
├── docs/                     # streamdeck.md (Stream Deck setup);
│   └── evidence/             #   milestone 1 GPU results, kept as a record
└── package.json              # electron-builder config; the Flatpak manifest is generated from its `build.flatpak` block
```

### `main.js` responsibilities
- On `app.ready`: install the cert trust proc, then spawn the bridge. No privileged first-run step exists.
- Spawn the bundled bridge binary (`child_process.spawn`); pipe stdout/stderr to a log file; kill on `before-quit`.
- `BaseWindow` hosting two `WebContentsView`s — see [Window chrome](#window-chrome) — with `session.fromPartition('persist:onshape')`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- `session.setCertificateVerifyProc` on the `persist:onshape` session — accept only the bridge's own generated leaf certificate, and only for host `127.51.68.120`; everything else returns -3 to defer to Chromium.
- No CDP debugger, and no platform spoof — Onshape dropped its `navigator.platform` gate. Kept for reference if CDP is ever needed: `Page.enable` **hangs forever** if sent to a webContents that has never loaded a document, so attach only after something has loaded; and opening DevTools on a webContents detaches any debugger attached to it.
- Single-instance lock, custom app icon, `StartupWMClass` set in the `.desktop` file (needed for WM / Stream Deck focus-detection).

### Window chrome

A `BaseWindow` (`frame` implicitly false via `titleBarStyle: 'hidden'`) holds two `WebContentsView`s: a 32px toolbar at `y=0` loading `src/chrome/toolbar.html`, and the Onshape content below it. Window buttons come from `titleBarOverlay` — drawn natively by the browser process, themed by GNOME, and they follow the user's `org.gnome.desktop.wm.preferences button-layout` (including left-side layouts) with no work on our part. The toolbar reserves that strip in CSS via `env(titlebar-area-width)`.

A third `WebContentsView` sits on top holding the hamburger popover (`src/chrome/popover.html`), normally `setVisible(false)`. It is an HTML popover rather than a native `Menu` because native menus on Linux are strictly vertical lists — the `header`/`palette` horizontal row types are macOS-only — so the back/reload/forward icon row cannot be expressed natively. It also avoids native popup positioning entirely.

**Rounded corners.** `win.contentView.setBackgroundColor('#00000000')` on the ROOT view is the load-bearing setting — with an opaque root, corners stay square no matter what else is set. Child views then get `setBorderRadius(8)`. Do **not** use `transparent: true`: it works, but it deletes Chromium's client frame, taking the drop shadow, the ~10px resize grab ring, and the native window buttons (`windowControlsOverlay.visible` flips to false) with it. `roundedCorners` is an exact no-op on Linux, and `win.setShape()` does nothing.

Radius must be **8, not GNOME's 15**: Chromium declares an opaque region that carves out exactly 8×8 per corner, and Mutter paints declared-opaque areas with blending disabled, so a larger arc renders as black wedges. 8px is plain GTK4's own `window.csd` radius. Corners must drop to 0 when maximized or fullscreen, mirroring libadwaita's `.maximized/.fullscreen` rule. `setBorderRadius` is uniform-only in Electron 44 (the per-corner object throws), which is why the toolbar view is `TOOLBAR_HEIGHT + 2*radius` tall and sits *below* the content view — it backs the content view's unavoidably-rounded top corners so the seam shows toolbar colour instead of see-through notches.

Measured facts that the implementation depends on:

- **Middle-click and Ctrl-click arrive as disposition `background-tab`, and Chromium passes NO `webContents`** (tab creation is deferred via `OpenURLFromTab`). The handler must therefore pass `url: target` through, or the fresh view falls back to `START_URL` and lands on the documents page — which was exactly the reported bug.
- **Mutter auto-maximizes** a window whose requested size is near the work area. 1600×1000 on a 1920×1080 display always opened maximized; 1440×900 does not.

- **GNOME 50 Mutter advertises no decoration protocol at all** (no `zxdg_decoration_manager_v1`), so every window is client-decorated. `frame: false` means literally nobody draws a titlebar — that was the original "no way to minimize or close" bug.
- **Child windows do not inherit `frame`/`titleBarStyle`/`webPreferences`** — a plain `{action:'allow'}` gets Chromium defaults and a 66px GTK headerbar. Hence the `createWindow` path, which must adopt `options.webContents` *exactly* (`new WebContentsView({ webContents: options.webContents })`) or Electron throws.
- **`WebContentsView` does not auto-resize.** Lay out on `win.contentView.on('bounds-changed')`, which always carries fresh bounds; `win.on('resize')` can fire stale on Wayland and is only a backstop.
- **`BaseWindow` has no `ready-to-show`** — that is BrowserWindow-only. Show on the toolbar's `did-finish-load`.
- **Clicking the toolbar steals key focus from the content view and does not return it.** Every toolbar action must call `contentView.webContents.focus()` or Onshape stops receiving keystrokes.
- **Never use `role:` menu items.** They carry baked-in accelerators (`Ctrl+R`, `F11`, `Ctrl+Q`, `Ctrl+Shift+I`) — exactly the keys deliberately left to Onshape — and they silently no-op under a `BaseWindow` host. A popped-up menu registers no accelerators; `registerAccelerator: false` makes that explicit.
- **`app.setDesktopName()` is the only thing that sets the Wayland `app_id`.** `app.setName()` and `--class` are ignored under Ozone/Wayland. Mutter copies `app_id` into `wm_class`, so this line is also what StreamController matches on — changing it breaks both `StartupWMClass` and Stream Deck page switching. See [docs/streamdeck.md](docs/streamdeck.md).
- **Switch views with `setVisible()`, never `removeChildView()` + `addChildView()`** — a removed-then-readded view stays `hidden` at 0fps. Relevant if tabs ever land.
- `hasShadow` stays default true, but not for the reason previously recorded: the shadow's *input region* extends ~10px beyond the window geometry, and that ring is the frameless resize grab area.
- `titleBarStyle: 'hiddenInset'`, `transparent: true`, and `minimizable`/`maximizable`/`closable` are all no-ops or broken on Linux — don't reach for them.

### Bridge integration

`npm run fetch-bridge` builds `kchellappan/spacemouse_linux_ws` from a pinned commit into `resources/bridge/` (gitignored). `src/bridge.js` spawns it on `app.ready` and kills it on quit, logging to `bridge.log` in userData.

Spawn flags: **`-no-auto-trust`** is essential — without it the bridge injects its CA into every browser NSS store it can find via `certutil`, which is exactly the system-wide trust change the spec rules out. We pass `-cert-dir <userData>/bridge-certs` so the cert lifecycle belongs to the app (and to avoid the snap-leaked `XDG_DATA_HOME`, which otherwise puts certs under `~/snap/code/...`).

Trust is **pinned to the bridge's own leaf certificate**, not merely scoped to the host: the handler reads `leaf.pem` (re-reading on mtime change) and byte-compares the presented DER. Host-only scoping would accept *any* certificate presented on that address, which is weaker than it needs to be in an app that also loads a live remote origin.

Verified end to end on 2026-09-17, from the real `https://cad.onshape.com` origin:

| Step | Result |
|---|---|
| Bridge binds `127.51.68.120:8181` with no loopback alias | listening |
| `spacenavd` connection | connected, device `usb-3Dconnexion_SpaceNavigator-event-if00` |
| XHR `https://127.51.68.120:8181/3dconnexion/nlproxy` (what Onshape actually calls) | **200** `{"port":8181,"version":"1.4.8.21486"}` |
| `wss://127.51.68.120:8181/3dconnexion` handshake | **open** — so `setCertificateVerifyProc` does cover WebSockets |
| Bridge lifecycle | dies with the app, no orphan, port released |

Note the failure mode the bridge's own docs warn about: **an XHR to an untrusted certificate fails silently with no prompt**, indistinguishable from the old platform sniff blocking the connection. If the SpaceMouse ever stops working, check the cert path before anything else.

### SpaceMouse sensitivity

Tuning lives in the bridge's own config at `~/.config/spacemouse-bridge/config.json`, **not** in this app and not in spacenavd. The app deliberately spawns the bridge with no motion flags (only `-no-auto-trust`, `-cert-dir`, `-host`, `-port`), and the bridge's precedence is *explicit flag > config file > built-in default* — so whatever is in that file wins, and takes effect on the next app launch. `npm run bridge-config` prints the effective settings.

**Calibration is done** (2026-09-17) and it did *not* change the speed: this SpaceNavigator measures `fullScale` 332 sliding / 350 tipping, i.e. essentially the built-in 350 default, with a resting noise floor of 0 and all six axes clean. So the earlier theory that slowness came from an underestimated full scale was wrong. The levers that actually matter are `panSpeed` (model diagonals/sec), `rotateSpeed` (rad/sec), `zoomSpeed` (e-foldings/sec), and `curve` — `curve` is 1.6, where higher means finer control near centre, so lowering it toward 1.0 makes small deflections noticeably faster. `deadzone` (0.06) sets ignored travel.

### The puck wedges, and the bridge exits on purpose when it does

This SpaceNavigator is old and periodically drops off the USB bus mid-session — on Windows too, so it is hardware, not us. The kernel signature is in the spacenavd journal:

```
read error: No such device
removing device: 3Dconnexion SpaceNavigator (id: 1 path: /dev/input/event3)
adding device (id: 2)            <- after a physical replug
```

**spacenavd survives this** (same pid throughout) and re-attaches on replug, so the bridge never loses its socket and never exits. Recovery is a replug plus a nudge of the puck; no app restart is needed.

The cost is the runaway: `repeat-interval` in `/etc/spnavrc` defaults to `-1`, so spacenavd emits only when the reading *changes*. Holding the puck steady sends one event and then silence, so the bridge must keep applying the last motion — correct for a sustained orbit, and indistinguishable from the device vanishing mid-motion. The model then orbits away until the window loses focus (the page drives the frame clock) or the device returns.

**The bridge's restart supervision in `src/bridge.js` does NOT address this** — it covers the different case where the bridge exits because spacenavd itself died, which its own comment calls "not recoverable in place" (the packaged unit uses `Restart=always`/`RestartSec=10`; we spawn it directly, so we supply that policy: 2s→30s backoff, reset after a 60s stable run, suppressed on intentional shutdown).

A real fix for the runaway needs two changes together: `repeat-interval = 250` in `/etc/spnavrc` so a held puck keeps refreshing, plus a staleness timeout in the bridge that zeroes motion after ~1s of silence. Neither works alone — a timeout without repeats would break sustained orbits, and repeats without a timeout change nothing. That is an upstream change to the bridge, not something this app can do.

### Packaging (milestone 5)

`npm run pack` builds the Flatpak into `dist/` (`npm run pack:dir` for a fast unpacked build). `scripts/package.sh` builds the bridge first if `resources/bridge/` is missing, since it is gitignored and a clean checkout would otherwise silently ship a package with no SpaceMouse support.

Verified on built packages: the bundled bridge is used, not the repo copy (`readlink /proc/<pid>/exe` resolved inside the package), it binds 8181, the `.desktop` file is named `io.github.akreager.ShapeShell.desktop` with a matching `StartupWMClass`, and the icon ships. The AppImage and `.deb` findings below come from before the Flatpak-only decision and are kept as the reason for it.

`desktopName` is a **root-level** package.json field, not a `linux` option — `linux.syncDesktopName: true` reads it from there and names the `.desktop` file to match `app.setDesktopName()` in main.js, which is what links running windows to the entry and its icon. Without it electron-builder warns and window association breaks.

**Format comparison on Ubuntu 26.04 — measured, not assumed.** The formats differ in behaviour, not just packaging:

| | Chromium sandbox | Dock icon / app-grid launcher | Install |
|---|---|---|---|
| **AppImage** | **OFF** | no — not integrated | none (needs libfuse2) |
| **.deb** | on | yes | `sudo apt install ./…deb` |
| **Flatpak** | on (via zypak) | yes | user-level, no sudo |

*AppImage sandbox:* electron-builder's `AppRun` probes `unshare -Ur true` and silently adds `--no-sandbox` if it fails, and on Ubuntu 24.04+ it always fails — the kernel audit log for a real launch shows the probe denied `sys_admin` by the `unprivileged_userns` profile. The desktop entry additionally hardcodes `Exec=AppRun --no-sandbox`. So an AppImage runs unsandboxed **however** it is launched, and nothing in its output says so. The squashfs is `nosuid`, so the setuid helper can't rescue it either.

*.deb sandbox:* its postinst installs an AppArmor profile (`/etc/apparmor.d/shapeshell`) that grants the binary `userns`, so creating a namespace no longer transitions into the restrictive `unprivileged_userns` profile — the same fix Chrome's own `.deb` uses on 24.04+. Its desktop entry has no `--no-sandbox`.

*Dock icon:* on GNOME Wayland the icon comes **only** from an installed `.desktop` file whose name matches the window's app_id. Mutter offers no per-window icon protocol (no `xdg_toplevel_icon_manager_v1` in the registry) and Electron sends none, so setting `icon` on the window does nothing here. A directly-run AppImage installs no desktop file, hence the generic gear. `.deb` and Flatpak both install one.

*Icon sizes:* the hicolor theme indexes 16–512 but **not 1024×1024**, so a lone 1024px icon installs somewhere GNOME never looks. `linux.icon` points at `build/icons/` (16, 24, 32, 48, 64, 128, 256, 512), rendered from `build/icon.svg`.

*AppImage also needs libfuse2*, which Ubuntu 26.04 does not ship (`sudo apt install libfuse2t64`, or `--appimage-extract-and-run`).

*.deb metadata:* `author.email` and `homepage` are **placeholders on the reserved `.invalid` TLD** — the `.deb` target refuses to build without them. Replace before distributing.

**Flatpak specifics.** electron-builder's defaults are unusable as-is: runtime `20.08` (2020, EOL) and `finishArgs` granting `--filesystem=home` and `pulseaudio` while omitting the spacenavd socket. The config pins runtime/base `25.08` and a minimal permission set: wayland + fallback-x11, ipc, `--device=dri`, network, `/run/spnav.sock`, and read-write `xdg-config/spacemouse-bridge` (`:create`, so it exists even for a user who has never calibrated). It was read-only at first, which left Flatpak-only users no way to save a calibration; the bundled bridge can calibrate from inside the sandbox via `flatpak run --command=/app/lib/<id>/resources/bridge/spacemouse-bridge <id> -calibrate -config ~/.config/spacemouse-bridge/config.json`, verified to reach spacenavd and write the file. Hardware GL inside the sandbox needs the NVIDIA extension matching the **exact** host driver — `org.freedesktop.Platform.GL.nvidia-595-84//1.4` — which must be reinstalled whenever the driver updates. Inside the sandbox `XDG_CONFIG_HOME` is remapped per-app, so `src/bridge.js` passes `-config` pointing at the host's file when `FLATPAK_ID` is set; otherwise calibration would be silently ignored.

**Flatpak — verified end to end (2026-09-18)**, installed with `flatpak install --user --bundle`:

| Check | Result |
|---|---|
| Hardware WebGL inside the sandbox | `ANGLE (NVIDIA … GTX 1660, OpenGL ES 3.2)`, maxTex 32768 — milestone 1's criterion holds |
| Chromium sandbox | **on**: every renderer/GPU/utility/zygote/broker runs with `seccomp=2` (seccomp-bpf filter active) and no `--no-sandbox`; zypak supplies `bwrap` zygotes |
| X11 exposure | none under Wayland — `DISPLAY` unset, no `/tmp/.X11-unix` in the sandbox. Flatpak lists `x11` in metadata whenever `fallback-x11` is declared, then withholds it at runtime; that entry is not a hole |
| Bridge | bundled binary runs from `/app/lib/…/resources/bridge`, binds 8181, and receives `-config ~/.config/spacemouse-bridge/config.json`, so host calibration applies |
| Cert pinning from the page | `200 OK` |
| Home directory access | none |
| Desktop integration | `.desktop` and all eight icon sizes exported to `~/.local/share/flatpak/exports` |

To check sandbox status, read `Seccomp:` from `/proc/<pid>/status` for the renderer processes (2 = active) — don't grep command lines for `--no-sandbox`, which self-matches the shell doing the grepping.

**Not yet verified in Flatpak:** saving an export. With no `--filesystem=home`, saves must go through the xdg-desktop-portal FileChooser. The Flatpak also has its own profile under `~/.var/app/io.github.akreager.ShapeShell/`, so it needs its own sign-in.

**Build gotchas, both VS Code-snap specific:**
- Any `flatpak` command run *without* `env-repair` uses the snap-leaked `XDG_DATA_HOME` and installs into `~/snap/code/<rev>/.local/share/flatpak` — invisible to the desktop, and deleted when snap garbage-collects that revision. This happened once (3GB of runtimes, moved into place afterwards). Always source `scripts/env-repair.sh` first; note the snap revision changes when VS Code auto-updates.
- `flatpak-builder`'s `rofiles-fuse` step fails with "Failure spawning rofiles-fuse": AppArmor's `fusermount3` profile refuses to pass the FUSE fd to a peer confined as `snap.code.code`. `scripts/package.sh` adds `--disable-rofiles-fuse` only when running under that profile, via a temporary PATH shim, since electron-builder exposes no way to pass builder args. A normal terminal needs no workaround.

**Install one format, not several.** The `.deb` and the Flatpak both export `io.github.akreager.ShapeShell.desktop`, so installing both yields duplicate or shadowed app-grid entries.

### Portability of the scripts

The scripts were first written against one machine and have been de-specialised for other users:

- `scripts/env-repair.sh` only touches XDG state when the VS Code snap leak is actually present (`XDG_DATA_DIRS_VSCODE_SNAP_ORIG` set, or `GSETTINGS_SCHEMA_DIR` under `/snap/`), and restores the snap's own recorded originals. It once hardcoded Ubuntu paths into `XDG_DATA_DIRS` unconditionally, which on any other distro would have discarded a correct value — including `/var/lib/flatpak/exports/share`. It also no longer refuses to start when `gsettings` or the GNOME schema is absent (e.g. KDE). Elsewhere it only unsets `ELECTRON_RUN_AS_NODE`.
- `npm run gpu-check` asserts *hardware* rendering, not a vendor: it used to require an NVIDIA renderer and a 16384 max texture size, which would have failed every working AMD or Intel GPU. It now writes to the gitignored `dist/gpu-check/`, so running it no longer dirties the tree; `docs/evidence/` keeps the original milestone 1 results.
- The bridge's MIT license and gorilla/websocket's BSD-2 license ship next to the binary, since both require their notice to accompany redistributed binaries.

### Onshape sign-in does not persist across restarts — diagnosed, not a bug in our code

Onshape's authenticated cookies (`on`, `onapp`, `XSRF-TOKEN`, `on-session-id`, `_u`) are **session-scoped** — no `Expires`/`Max-Age` — so Chromium never writes them to disk. The 2FA device-trust cookie `tt` (host `cad.onshape.com`, path `/api/v14/users/session`) *is* persistent with a 30-day expiry, which is exactly why 2FA is remembered while sign-in is not.

Our configuration is exonerated: `persist:onshape` is correct, nothing clears storage, and `learn.onshape.com`'s year-long `authToken` persists fine in the same partition. There is **no "keep me signed in" checkbox** — the only persistence control in the whole flow is `rememberTotp` ("Remember this computer for the next 30 days") inside the 2FA step, which is the `tt` cookie. Onshape also enforces a ~4-hour server-side idle timeout. `--persist-session-cookies` is a measured no-op; Electron hardcodes `persist_session_cookies=false`.

This also explains the browser's behavior: a browser keeps you signed in because its process stays alive holding the cookies in RAM, and drops you after a few hours idle because of the server timeout — not because it persisted anything.

**Decision (2026-09-17): accepted as-is, not a bug to fix.** The only possible fix is to mirror the session cookies in memory and rewrite them with an explicit expiry on quit. It was declined deliberately: it would mean writing live auth cookies to disk, it only ever buys restarts inside the ~4-hour idle window, the first server response resets the cookie back to session scope, and Electron stores this cookie DB in **plaintext** (`value` populated, `encrypted_value` empty). Do not re-open this without a new reason.

### Stream Deck — StreamController, not a component of this repo

Focus ShapeShell, the deck switches pages. StreamController does it by matching `wm_class` `io.github.akreager.ShapeShell`; verified end to end 2026-09-22. Nothing is built, shipped or spawned here — no daemon, no udev rule, no first-run step.

Setup, the two silent failure modes that make it look broken, and the verification commands: **[docs/streamdeck.md](docs/streamdeck.md)**.

The one fact that constrains this repo: **the window title is the constant `ShapeShell`** — Electron sets a `BaseWindow` title once from the app name, and unlike a `BrowserWindow` it never syncs the page title, because the content is a `WebContentsView`. So a title regex matches nothing useful, and every Onshape context looks identical to the matcher. Giving `pushState` a `win.setTitle()` is what per-element pages (Part Studio / Assembly / Drawing) would need.

## Build plan / milestones (in order)

Reordered 2026-09-17: packaging moved ahead of the Stream Deck work, which was a nice-to-have with its own lifecycle, whereas packaging is what makes the app installable and is the last hard requirement.

1. ~~**Scaffold**~~ — DONE. Bare Electron app on cad.onshape.com with hardware WebGL confirmed. See [Milestone 1 results](#milestone-1-results).
2. ~~**Bridge spawn**~~ — DONE. Built into `resources/bridge/` by `npm run fetch-bridge`, spawned and killed around the app lifecycle, supervised on unexpected exit. No loopback alias was needed.
3. ~~**Loopback + cert automation**~~ — DONE, reduced to just `setCertificateVerifyProc` pinned to the bridge's own leaf; no loopback work was needed at all.
4. ~~**Platform spoof**~~ — DONE by deletion. Onshape dropped its `navigator.platform` gate, so no CDP injection exists. Live 6-DOF motion confirmed driving the Onshape viewport.
5. ~~**Packaging**~~ — DONE. Flatpak only; released as v0.1.0 on GitHub (2026-09-19). See [Packaging](#packaging-milestone-5).
6. ~~**Polish**~~ — DONE. Original icon, `.desktop` entry whose `StartupWMClass` matches `app.setDesktopName`.
7. ~~**Stream Deck daemon**~~ — DONE by deletion (2026-09-22). StreamController does the whole job, including the auto-switch-on-focus that was only a stretch goal here, so no daemon, udev rule or shortcut map was written. Configured against ShapeShell's `wm_class` and verified on the Stream Deck MK.2 (`0fd9:0080`). See [docs/streamdeck.md](docs/streamdeck.md).

## Milestone 1 results

Verified 2026-09-15 on Electron 44.4.1 (Chromium 152.0.7977.78, Node 24.21.0), native Wayland, **zero Chromium switches**:

| Check | Result |
|---|---|
| WebGL renderer (synthetic + real cad.onshape.com) | `ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660/PCIe/SSE2, OpenGL ES 3.2)` |
| `getGPUFeatureStatus()` | `webgl: enabled`, `gpu_compositing: enabled`, `rasterization: enabled`, `opengl: enabled_on` |
| Context / max texture size | WebGL2, 32768 |
| Frame pacing | `medianFrameMs` 16.7 (= 59.9 fps, vsync-locked) |
| Onshape browser detection | Accepts the default Electron UA — no unsupported-browser warning, sign-in page renders |
| Negative control (`--disable-gpu`) | Correctly FAILS the gate |

Evidence JSON lives in `docs/evidence/`. Run the gate with `npm run gpu-check`.

**Confirmed in real use (2026-09-16):** sign-in including 2FA works; Onshape's own compatibility check at `/check` passes every row — Browser classified as *Chrome*, Core WebGL + float textures + float buffer blending + float framebuffer rendering + anisotropic filtering + 32-bit indices + high-precision fragment shaders all ✓, GL renderer `ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660/PCIe/SSE2, OpenGL ES 3.2)`, 834.7M triangles/sec, 621.5M lines/sec, **WebSocket connection ✓** (the transport milestone 4's SpaceMouse bridge needs). Documents load at browser speed. Export works, and prompts for a save location — arguably better than the browser.

The UA carries the productName (`ShapeShell/<version>`; it was `OnshapeAppliance/0.1.0` when this was measured) and Onshape still classifies it as Chrome, confirming the naming constraint: productName must never contain `edge`, `chromium` or `opr`.

`vulkan: disabled_off` is expected and fine — the Wayland ozone backend refuses Vulkan and falls back to GL.

### chrome-sandbox must be setuid-root — run `npm run fix-sandbox`

After every `npm install` / `npx install-electron`, run `npm run fix-sandbox` (needs sudo). Without it, `npm start` from a normal terminal aborts with *"The SUID sandbox helper binary was found, but is not configured correctly."*

Chromium's namespace sandbox needs `CAP_SYS_ADMIN` inside a fresh user namespace. With `kernel.apparmor_restrict_unprivileged_userns=1` (default on Ubuntu 24.04+), an unconfined process that calls `userns_create` is transitioned into the `unprivileged_userns` AppArmor profile, which **denies `CAP_SYS_ADMIN`** — the `allow userns,` line in that profile permits *creating* the namespace, not the capability needed *inside* it. Chromium then falls back to the setuid helper, which aborts unless root-owned and mode 4755.

Never use `--no-sandbox` to dodge this: the app loads a live remote origin.

**Caveat on the milestone 1 evidence below:** it was captured from a shell confined by `snap.code.code` in *complain* mode, which permits `userns_create` and so never transitions into `unprivileged_userns`. The GPU findings are unaffected, but that environment masked this sandbox requirement — verify sandbox-related behavior from an ordinary unconfined terminal, not a VS Code one.

### Two environment landmines (both VS Code snap leaks)

`scripts/env-repair.sh` fixes both; `npm start` and `npm run gpu-check` source it. Launching Electron without it from a VS Code terminal fails in ways that look like something else entirely:

1. **`ELECTRON_RUN_AS_NODE=1`** (from the extension host) → the electron binary runs as plain Node, `require('electron')` returns a path string, and `app` is undefined. Symptom: `TypeError: Cannot read properties of undefined (reading 'on')`.
2. **`GSETTINGS_SCHEMA_DIR` / `XDG_DATA_HOME` / `XDG_DATA_DIRS`** point at a snap-private gschema cache missing `org.gnome.desktop.interface font-antialiasing` → Chromium's GTK code SIGSEGVs before any window appears. It still crashes with `--disable-gpu`, so it masquerades as an NVIDIA/Wayland GPU failure. All three must be repaired; fixing two still crashes.

### Do not add these Chromium switches

Each was measured on this machine. `--use-gl=desktop`, `--use-gl=egl`, `--use-angle=gles` each **kill** hardware WebGL (`getContext` returns null). `--ignore-gpu-blocklist` and `--disable-software-rasterizer` are exact no-ops. `--disable-gpu-sandbox` and `--in-process-gpu` work but drop a security boundary / GPU crash isolation. `app.commandLine.appendSwitch()` **cannot** set `ozone-platform` — the platform is chosen before the main script is evaluated; use argv (`npm run start:xwayland`) or `XDG_SESSION_TYPE`.

### Deviations from the spec's architecture tree

- **No `src/preload.js`** — nothing to expose in M1, and an empty preload is exactly where a future session would wrongly put the CDP-locked platform spoof.
- **No GPU/ozone switches** in `main.js`, per the measurements above.
- Added `scripts/` (env repair, launcher, GPU gate) and `docs/evidence/`, which the spec tree didn't anticipate.

## Testing checklist

- [x] Hardware WebGL confirmed via `getGPUFeatureStatus().webgl === 'enabled'` + `UNMASKED_RENDERER_WEBGL` regex, with a `--disable-gpu` negative control (replaces the spec's original `chrome://gpu` line — that needs a rendered window and a human, and was never verified to load on Electron 44)
- [x] Bridge starts/stops cleanly with the app, and a crash-orphaned bridge is reaped on next launch (Linux does not kill children with their parent, so this needed an explicit pidfile + `/proc/<pid>/exe` identity check)
- [x] Live 6-DOF motion drives the Onshape viewport — confirmed by `navigation active client=Onshape` plus puck-button `fit` events in bridge.log
- [x] Cert trust is pinned, not merely scoped — a rogue TLS server on the same IP with a *valid* SAN for it is rejected, while the bridge is accepted and public HTTPS still verifies normally
- [x] ~~Loopback alias survives a reboot~~ — moot; no alias is needed on Linux
- [x] ~~AppImage runs on a clean VM~~ — moot; AppImage is unsupported
- [x] Flatpak sandbox: bridge binds `127.51.68.120:8181` and Onshape reaches it (200 from the page)
- [ ] Flatpak on a non-NVIDIA GPU, a non-GNOME desktop, and a non-Ubuntu distro — untested
- [x] Stream Deck page switches on focus — `Auto changing page` in StreamController's log the moment ShapeShell takes focus. HID access is StreamController's concern, not ours
- [x] ~~DevTools shortcut vs the CDP-attached spoof~~ — moot; there is no CDP debugger and no spoof

## Open risks

- Onshape could change its client at any time (undocumented integration): its UA classifier, or the `_3Dconnexion` connect path the bridge relies on.
- `spacemouse_linux_ws` is young and largely verified by its own author; its behaviour is pinned to one commit by `scripts/fetch-bridge.sh`.
- Only one machine has run it so far (Ubuntu 26.04, GNOME 50 Wayland, NVIDIA). Other GPUs, desktops and distros are the main unknown.
- The NVIDIA Flatpak GL extension must match the host driver exactly; a driver update without the matching extension silently drops WebGL to software.
