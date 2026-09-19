# ShapeShell

An unofficial Linux desktop app for [Onshape](https://cad.onshape.com), distributed as a Flatpak, with 6-DOF SpaceMouse support built in — no manual bridge process, no cert import, no Tampermonkey, and no privileged setup.

> Not affiliated with, endorsed by, or supported by Onshape or PTC. "Onshape" is a trademark of PTC Inc. This project wraps the public Onshape web app; you need your own Onshape account.

## Features

- Onshape in its own window, with a slim toolbar (page title, a hamburger menu with back / forward / reload, Documents, New Window, Quit) and native GNOME window buttons that follow your system button layout
- Hardware-accelerated WebGL inside the Flatpak sandbox — Onshape's own compatibility check passes every row
- **SpaceMouse support built in** — the bridge starts and stops with the app and restarts itself if it drops. Its self-signed certificate is trusted only for its own address, never installed system-wide
- Chromium's sandbox stays on, and the app has no access to your home folder
- Rounded corners matching GNOME, squaring off when maximized
- Window size and position remembered; new windows match the main window
- Links that would open browser tabs open as separate windows; off-site links go to your system browser

Known behavior:

- **You sign in on each launch.** Onshape's auth cookies are session-scoped with no "remember me", so nothing is persisted to disk. A browser only appears to remember you because its process keeps running. This is a deliberate decision — see [CLAUDE.md](CLAUDE.md).
- **An aging SpaceMouse can drop off USB mid-motion**, leaving the model orbiting on its own. Click away from the window to stop it, then replug the device.

## Install

Download `ShapeShell-<version>-x86_64.flatpak` from the [latest release](https://github.com/akreager/ShapeShell/releases/latest), then:

```bash
flatpak install --user --bundle ShapeShell-0.1.0-x86_64.flatpak
```

A `.flatpak` file is an installer package, not a program — running it directly (`./ShapeShell-….flatpak`) fails with "permission denied". Install it with the command above, or open it in GNOME Software / KDE Discover, then launch ShapeShell from your app menu.

For hardware WebGL on **NVIDIA**, Flatpak needs the GL extension matching your *exact* driver version, e.g. `org.freedesktop.Platform.GL.nvidia-595-84` for driver 595.84. `flatpak update` normally installs it; reinstall it after driver updates. AMD and Intel need nothing extra.

Uninstall with `flatpak uninstall --user io.github.akreager.ShapeShell`.

## SpaceMouse

Needs [`spacenavd`](https://github.com/FreeSpacenav/spacenavd) running on the host.

Calibrate once — an interactive walkthrough that measures your device:

```bash
flatpak run --command=/app/lib/io.github.akreager.ShapeShell/resources/bridge/spacemouse-bridge \
  io.github.akreager.ShapeShell -calibrate -config ~/.config/spacemouse-bridge/config.json
```

Settings live in `~/.config/spacemouse-bridge/config.json` and apply on the next launch. To make the puck feel livelier, raise `rotateSpeed` / `panSpeed`, or lower `curve` toward 1.0 for more response near centre.

## Building from source

Requirements: Linux with a hardware-OpenGL driver, Node.js 22.12+, Go 1.24+ (for the bridge), and `flatpak` + `flatpak-builder` with the Flathub remote.

```bash
npm install
npx install-electron
npm run fetch-bridge     # builds the SpaceMouse bridge
npm run pack             # builds the Flatpak into dist/
```

The build pulls `org.freedesktop.Platform//25.08`, the matching SDK, and `org.electronjs.Electron2.BaseApp//25.08` from Flathub.

### Other formats

Flatpak is the only supported format. electron-builder can produce others from the same source — `npm run pack -- --linux deb` (or `rpm`, `pacman`, `AppImage`, `snap`) — given the right host tools. They are **unsupported**, and they behave differently rather than just packaging differently. Measured on Ubuntu 26.04:

| Format | Chromium sandbox | Icon & app-grid launcher |
|---|---|---|
| Flatpak | on | yes |
| `.deb` | on — installs an AppArmor profile, as Chrome's own `.deb` does | yes |
| AppImage | **off** — Ubuntu 24.04+ blocks what the sandbox needs, and AppImages silently fall back to `--no-sandbox` | no — installs no desktop entry |

Building a `.deb` requires replacing the placeholder `author.email` and `homepage` in `package.json`; they use the reserved `.invalid` domain because the target refuses to build without them.

### Running from source

```bash
npm run fix-sandbox      # one-time; needs sudo
npm start
```

`fix-sandbox` makes Chromium's setuid sandbox helper root-owned and mode 4755, because Ubuntu 24.04+ denies `CAP_SYS_ADMIN` inside unprivileged user namespaces. Re-run it after any `npm install` or `npx install-electron`. Never work around it with `--no-sandbox` — this app loads a live remote origin.

## Scripts

| Command | What it does |
|---|---|
| `npm run pack` | Build the Flatpak into `dist/` |
| `npm run pack:dir` | Unpacked build, for quick testing |
| `npm start` | Run from source |
| `npm run start:xwayland` | Run from source under XWayland |
| `npm run fetch-bridge` | Build the SpaceMouse bridge into `resources/bridge/` |
| `npm run calibrate` | SpaceMouse calibration, from a source checkout |
| `npm run bridge-config` | Print the bridge's effective settings |
| `npm run gpu-check` | Assert hardware WebGL, with a `--disable-gpu` negative control |
| `npm run fix-sandbox` | Fix `chrome-sandbox` ownership, for running from source |

## Credits

SpaceMouse support comes from [spacemouse_linux_ws](https://github.com/kchellappan/spacemouse_linux_ws) by kchellappan (MIT), built from a pinned commit and bundled with its license.

## Docs

- [CLAUDE.md](CLAUDE.md) — architecture, decisions, measured findings, and the things that will bite you
- [onshapeAppliance.md](onshapeAppliance.md) — the original handoff spec; several of its decisions were later dropped, so read CLAUDE.md first
