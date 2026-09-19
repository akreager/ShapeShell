Onshape Appliance — Build Handoff
Fresh, minimal Electron shell for Onshape with the SpaceMouse bridge baked in, packaged as AppImage + Flatpak, with a Stream Deck profile that switches in when the app is focused. This doc is the spec to hand to a build session (Claude Code or otherwise) — it locks in the decisions from earlier research so nothing needs re-litigating.

Goal
A single launchable "appliance": a chrome-less window running cad.onshape.com with live 6-DOF SpaceMouse input working out of the box (no manual bridge process, no manual cert import, no Tampermonkey), packaged so it installs cleanly on a clean machine, plus a Stream Deck profile that auto-activates for CAD shortcuts when that window has focus.

Decisions locked in (don't re-litigate these)
Question	Decision	Why
Engine	Electron, not Tauri, not a Chromium fork	Tauri's Linux WebKitGTK backend has documented WebGL/three.js instability (context loss, CPU spikes) — disqualifying for Onshape's viewport. A Chromium fork needs 100GB+ disk, 16GB+ RAM, and perpetual security-patch ownership for zero benefit here.
Bridge	kchellappan/spacemouse_linux_ws (Go), vendored as a static binary	Single static binary bundles cleanly into an Electron extraResources dir with no runtime dependency. Fallback: RmStorm/spacenav-ws (Python) if the Go bridge proves flaky — heavier to bundle (needs a Python runtime), so only fall back if needed.
navigator.platform spoof	CDP via webContents.debugger, using Page.addScriptToEvaluateOnNewDocument to inject Object.defineProperty(Navigator.prototype,'platform',{get:()=>'Win32'})	Survives navigations, runs in the main world (unlike a contextIsolated preload, which can't reach the page's real navigator object). No Tampermonkey needed.
Cert trust	session.setCertificateVerifyProc scoped to 127.51.68.120:8181 only	Avoids importing the bridge's self-signed CA into the OS/browser-wide trust store — trust is scoped to this one app, this one origin.
Loopback alias	Bundled systemd unit, installed on first run via a pkexec helper	ip addr add 127.51.68.120/8 dev lo alone doesn't survive reboot; a systemd unit (same pattern as YatinJC/onshape-spacemouse-launcher) does. One-time privileged step, everything else runs unprivileged after.
Packaging	electron-builder, targets AppImage and flatpak	Both targets are natively supported by electron-builder; no separate packaging toolchain needed.
Stream Deck	Separate daemon, not bundled into the Electron app	python-elgato-streamdeck (HIDAPI-based, actively maintained) → ydotool (Wayland-safe; xdotool is X11-only) to fire Onshape keyboard shortcuts. Runs as its own systemd --user service, independent lifecycle from the browser shell.
Architecture
onshape-appliance/
├── src/
│   ├── main.js              # Electron main process
│   ├── preload.js           # minimal — spoof happens via CDP, not preload
│   └── first-run-setup.js   # detects first launch, invokes pkexec helper
├── resources/
│   ├── bridge/spacemouse_linux_ws   # vendored static Go binary
│   └── setup/
│       ├── spacenav-loopback.service   # systemd unit: adds 127.51.68.120/8 to lo
│       └── install-setup.sh            # pkexec target: installs the unit, enables+starts it
├── build/                    # icons, AppImage/flatpak metadata
├── package.json              # electron-builder config (AppImage + flatpak targets)
└── flatpak/
    └── com.allen.OnshapeAppliance.yml   # flatpak manifest, finish-args below
main.js responsibilities:

On app.ready: check first-run marker in userData; if absent, invoke pkexec resources/setup/install-setup.sh, then write the marker.
Spawn the bundled bridge binary (child_process.spawn) from resources/bridge/; pipe stdout/stderr to a log file; kill on before-quit.
Create BrowserWindow with a persistent session partition (session.fromPartition('persist:onshape')), contextIsolation: true, nodeIntegration: false.
session.setCertificateVerifyProc — accept only request.hostname === '127.51.68.120' (bridge's own port), reject/default-verify everything else.
win.webContents.debugger.attach('1.3') before loadURL; send Page.enable then Page.addScriptToEvaluateOnNewDocument with the platform-spoof script; then loadURL('https://cad.onshape.com').
Disable/remap the DevTools shortcut in production builds (opening DevTools on the same webContents detaches the debugger and breaks the spoof).
Single-instance lock (app.requestSingleInstanceLock()), custom app icon, StartupWMClass set in the .desktop file so window-manager / Stream Deck focus-detection can match it reliably.
Stream Deck integration (separate component)
Daemon: python-elgato-streamdeck reads button presses → maps to Onshape keyboard shortcuts → emits via ydotool (works under Wayland; falls back to xdotool if you're still on X11).
Needs a udev rule for non-root HID access: SUBSYSTEMS=="usb", ATTRS{idVendor}=="0fd9", GROUP="users", TAG+="uaccess" in /etc/udev/rules.d/10-streamdeck.rules — the first-run setup script is a natural place to install this alongside the loopback unit.
v1 scope: a single dedicated "Onshape" profile/page, manually selected. Auto-switch-on-window-focus (matching the appliance's StartupWMClass) is a stretch goal for v2, not a blocker for first working build.
Pull icon assets from your existing Stream Deck icon library for the shortcut buttons.
Build plan / milestones
Scaffold — minimal Electron app, no bridge/spoof yet, just loadURL('https://cad.onshape.com') in a chrome-less BrowserWindow. Confirm chrome://gpu shows hardware-accelerated WebGL and Onshape's viewport is smooth. (This is the highest-risk item — validate first before building anything else on top.)
Bridge spawn — vendor the Go binary, spawn/kill it around app lifecycle, confirm it's listening on 127.51.68.120:8181 (curl -k https://127.51.68.120:8181/version... will fail without the loopback alias, so this depends on step 3 being done manually first during dev).
Loopback + cert automation — write the systemd unit + pkexec install script, wire up first-run detection, implement setCertificateVerifyProc.
Platform spoof — implement the CDP injection, confirm Onshape actually opens the WebSocket to the bridge (check bridge logs) and that a SpaceMouse nudge moves the viewport.
Stream Deck daemon — separate repo/service; get manual profile-switch shortcuts working against the real Onshape shortcut map.
Packaging — electron-builder config for AppImage first (simpler, no sandbox surprises), test on a clean VM; then flatpak, paying attention to finish-args (--socket=wayland, --socket=fallback-x11, --device=dri for GPU, --share=network — verify the host's 127.51.68.120 loopback alias is actually visible inside the flatpak sandbox, since this is new/unverified).
Polish — custom icon, .desktop file with correct StartupWMClass, Stream Deck auto-focus-switching if you want to chase the stretch goal.
Testing checklist
 chrome://gpu inside the packaged app shows hardware WebGL (not software fallback)
 Bridge binary starts/stops cleanly with the app, no orphaned processes on crash
 spnavcfg-style live axis test works inside the Onshape window (not just the daemon)
 Cert trust doesn't silently fall back to accepting arbitrary certs — verify it's scoped
 Loopback alias survives a reboot (systemd unit enabled, not just started once)
 AppImage runs on a clean VM with no dev toolchain installed
 Flatpak sandbox: bridge can bind 127.51.68.120:8181 and Onshape can reach it
 Stream Deck udev rule grants access without root
 DevTools shortcut disabled or confirmed not to break the CDP-attached spoof
Open questions / risks
Onshape could change its client detection at any point — this whole thing rides on an undocumented integration. If Onshape starts checking navigator.userAgentData in addition to platform, the spoof needs extending.
Flatpak network sandboxing of the loopback alias is unverified — --share=network typically shares the host network namespace, but confirm empirically before assuming it "just works."
Go bridge maturity — spacemouse_linux_ws is new and largely self-verified by its author; budget time to debug it or swap to the Python bridge if it doesn't hold up.