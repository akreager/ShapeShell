'use strict';

const { app, BaseWindow, WebContentsView, Menu, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const windowState = require('./window-state');
const bridge = require('./bridge');
const extensions = require('./extensions/manager');
const { ExtensionPopup } = require('./extensions/popup');

// ---------------------------------------------------------------------------
// Chromium switches: deliberately NONE.
//
// Measured on the target machine (Ubuntu 26.04 Wayland, GTX 1660, NVIDIA 595.84,
// Electron 44.4.1): with zero switches Electron selects native Wayland and reports
// webgl=enabled, gpu_compositing=enabled, renderer "ANGLE (NVIDIA Corporation,
// NVIDIA GeForce GTX 1660/PCIe/SSE2, OpenGL ES 3.2)", 59.9 fps median.
//
// Do NOT add any of these — each was measured here:
//   --use-gl=desktop | --use-gl=egl | --use-angle=gles  -> kill WebGL outright
//                                                          (getContext returns null)
//   --ignore-gpu-blocklist | --disable-software-rasterizer -> exact no-ops
//   --enable-features=UseOzonePlatform,WaylandWindowDecorations -> long since default
//   --disable-gpu-sandbox | --in-process-gpu -> work, but drop a security boundary
//                                               and GPU crash isolation respectively
//   --no-sandbox -> never
//
// app.commandLine.appendSwitch() CANNOT set ozone-platform: the platform is chosen
// before this script is evaluated. Pass it on argv (see scripts/run.sh) or set
// XDG_SESSION_TYPE. ELECTRON_OZONE_PLATFORM_HINT was removed in Electron 38.
// ---------------------------------------------------------------------------

// The ONLY thing that sets the Wayland app_id (app.setName and --class are ignored under
// Ozone/Wayland). Must match the .desktop filename and StartupWMClass; it is also what
// window-matching tools (e.g. Stream Deck profile switchers) key on.
app.setDesktopName('io.github.akreager.ShapeShell.desktop');

const START_URL = 'https://cad.onshape.com';
const DOCUMENTS_URL = 'https://cad.onshape.com/documents';
const PARTITION = 'persist:onshape';
const TOOLBAR_HEIGHT = 32;
const WINDOW_BG = '#1e1e1e';
const TOOLBAR_BG = '#252526';

// GNOME/libadwaita rounds windows at 15px, but Chromium declares an opaque region that
// carves out exactly 8x8 at each corner and Mutter paints declared-opaque areas with
// blending disabled — a larger arc renders as black wedges. 8px is also plain GTK4's
// own window.csd radius, so it reads as native.
const CORNER_RADIUS = 8;

// Onshape's client classifier reads Electron's default UA as Chrome, which is supported.
// So no userAgentFallback override. Constraint: productName must never contain the
// substrings 'edge', 'chromium' or 'opr'.

// keyboardLock is deliberately NOT granted: Mutter supports shortcut inhibition, so it
// would let the page swallow compositor shortcuts like Alt+F4.
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
]);

// Keyed by the toolbar's webContents.id so an IPC message can only ever act on the
// window it actually came from.
const shells = new Map();

function isOnshapeOrigin(urlString) {
  try {
    const { protocol, hostname } = new URL(urlString);
    return protocol === 'https:' && (hostname === 'onshape.com' || hostname.endsWith('.onshape.com'));
  } catch {
    return false;
  }
}

function applyPermissionPolicy(ses) {
  const decide = (permission, origin) =>
    ALLOWED_PERMISSIONS.has(permission) && isOnshapeOrigin(origin);

  // Permission *checks* are passive queries the page and Chromium poll continuously, so
  // logging each one floods the console and buries real events. Log each distinct
  // permission+origin+outcome once. Requests are rare and user-visible, so log them all.
  const seenChecks = new Set();

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details?.requestingUrl || contents.getURL();
    const allowed = decide(permission, origin);
    console.log(`[permission request] ${allowed ? 'allow' : 'deny'} ${permission} <- ${origin}`);
    callback(allowed);
  });

  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const origin = requestingOrigin || contents?.getURL() || '(pre-navigation)';
    const allowed = decide(permission, origin);
    const key = `${permission}|${origin}|${allowed}`;
    if (!seenChecks.has(key)) {
      seenChecks.add(key);
      console.log(`[permission check] ${allowed ? 'allow' : 'deny'} ${permission} <- ${origin}`);
    }
    return allowed;
  });
}

// `adoptedContents` is set when Chromium hands us a child window's webContents via the
// setWindowOpenHandler 'createWindow' path — it must be adopted exactly, not recreated.
function createShellWindow({ adoptedContents = null, url = START_URL, persistBounds = false } = {}) {
  // Child windows take the remembered main-window size (but not its position, so the
  // compositor cascades them) rather than Chromium's small window.open defaults.
  const remembered = windowState.load();
  const saved = persistBounds
    ? remembered
    : { width: remembered.width, height: remembered.height, maximized: false };

  const win = new BaseWindow({
    width: saved.width,
    height: saved.height,
    ...(Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: WINDOW_BG,
    show: false,
    // Native GNOME-themed window buttons drawn by the browser process, over our toolbar
    // strip. Verified on this machine: the overlay follows the user's
    // org.gnome.desktop.wm.preferences button-layout, including left-side layouts.
    // hasShadow stays at its default true — the shadow's input region is a ~10px ring
    // outside the window geometry, and that ring is the frameless resize grab area.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: TOOLBAR_BG, symbolColor: '#d4d4d4', height: TOOLBAR_HEIGHT },
  });
  // A transparent ROOT view is what actually lets the child views' rounded corners show
  // through to the desktop. `transparent: true` on the window would also work but costs
  // the drop shadow, the resize grab ring, and the native window buttons.
  win.contentView.setBackgroundColor('#00000000');

  const chromeUi = {
    preload: path.join(__dirname, 'chrome', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };

  const chromeView = new WebContentsView({ webPreferences: chromeUi });
  chromeView.setBackgroundColor(TOOLBAR_BG);

  const contentView = adoptedContents
    ? new WebContentsView({ webContents: adoptedContents })
    : new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          // No preload: the remote page gets no bridge into the app. Onshape no longer
          // sniffs navigator.platform, so no spoof is needed either.
        },
      });
  contentView.setBackgroundColor(WINDOW_BG);

  // The action popup creates and destroys its own view on top of everything else.
  const extPopup = new ExtensionPopup({
    win,
    contentView,
    chromeView,
    partition: PARTITION,
    toolbarHeight: TOOLBAR_HEIGHT,
    cornerRadius: CORNER_RADIUS,
    onClosed: () => { if (!contentView.webContents.isDestroyed()) contentView.webContents.focus(); },
  });

  const popoverView = new WebContentsView({ webPreferences: chromeUi });
  popoverView.setBackgroundColor('#00000000');
  popoverView.setVisible(false);

  // Z-order is load-bearing. The toolbar sits BELOW the content view and extends
  // 2*radius past the seam, so the content view's (unavoidably uniform) rounded TOP
  // corners reveal toolbar colour rather than see-through notches. The popover is on
  // top of both because it must overlay Onshape.
  win.contentView.addChildView(chromeView);
  win.contentView.addChildView(contentView);
  win.contentView.addChildView(popoverView);

  // WebContentsView does not auto-resize; bounds must be set on every layout change.
  // 'bounds-changed' fires after the view tree is laid out and always carries fresh
  // values, whereas win.on('resize') can fire stale on Wayland — keep it as a backstop.
  let lastW = -1;
  let lastH = -1;
  const layout = () => {
    const { width: w, height: h } = win.contentView.getBounds();
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    chromeView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT + 2 * CORNER_RADIUS });
    contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) });
    popoverView.setBounds({ x: 0, y: 0, width: w, height: h });
    extPopup.layout();
  };
  win.contentView.on('bounds-changed', layout);
  win.on('resize', layout);

  // Native windows square their corners when maximized or tiled; mirror that.
  const applyCorners = () => {
    const r = win.isMaximized() || win.isFullScreen() ? 0 : CORNER_RADIUS;
    chromeView.setBorderRadius(r);
    contentView.setBorderRadius(r);
  };
  applyCorners();
  for (const e of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(e, applyCorners);
  }

  const contents = contentView.webContents;

  const pushState = () => {
    if (chromeView.webContents.isDestroyed() || contents.isDestroyed()) return;
    chromeView.webContents.send('shell:state', {
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
  };

  contents.on('page-title-updated', pushState);
  contents.on('did-navigate', pushState);
  contents.on('did-navigate-in-page', pushState);
  contents.on('did-fail-load', (_e, code, desc, url) => console.error(`[did-fail-load] ${code} ${desc} ${url}`));
  contents.on('render-process-gone', (_e, details) => console.error('[render-process-gone]', details));
  contents.on('unresponsive', () => console.error('[unresponsive]'));

  contents.setWindowOpenHandler(({ url: target, disposition }) => {
    if (isOnshapeOrigin(target) || disposition === 'new-window' || disposition === 'other') {
      return { action: 'allow', outlivesOpener: false, createWindow: (options) => {
        // Middle-click / Ctrl-click arrive as disposition 'background-tab', for which
        // Chromium defers tab creation and passes NO webContents. Without `url: target`
        // the fresh view would fall back to START_URL and land on the documents page
        // instead of the link that was clicked.
        const child = createShellWindow({
          adoptedContents: options.webContents ?? null,
          url: target,
        });
        child.win.show();
        return child.contentView.webContents;
      } };
    }
    console.log(`[open-external] ${target}`);
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // Log-only: Onshape SSO is top-level navigation, so blocking here would break sign-in.
  contents.on('will-navigate', (_event, target) => {
    if (!isOnshapeOrigin(target)) console.log(`[navigate offsite] ${target}`);
  });

  // Deliberately awkward chords, so every plain shortcut stays with Onshape.
  contents.on('before-input-event', (event, input) => {
    if (!input.control || !input.shift || !input.alt || input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r') {
      event.preventDefault();
      contents.reload();
    } else if (key === 'i') {
      event.preventDefault();
      contents.toggleDevTools();
    } else if (key === 'q') {
      event.preventDefault();
      app.quit();
    }
  });

  const pushExtensions = () => {
    if (chromeView.webContents.isDestroyed()) return;
    chromeView.webContents.send('shell:extensions', extensions.listActions());
  };
  const stopWatchingExtensions = extensions.onChange(pushExtensions);

  const shellRef = { win, chromeView, contentView, popoverView, extPopup };
  // Extensions see this window as one window holding one tab: the Onshape content view.
  extensions.attachWindow(shellRef);
  shells.set(chromeView.webContents.id, shellRef);
  shells.set(popoverView.webContents.id, shellRef);

  if (persistBounds) {
    if (saved.maximized) win.maximize();
    windowState.track(win);
  }

  win.on('closed', () => {
    stopWatchingExtensions();
    extensions.detachWindow(shellRef);
    extPopup.destroy();
    shells.delete(chromeView.webContents.id);
    shells.delete(popoverView.webContents.id);
  });

  // BaseWindow has no 'ready-to-show' — that event exists only on BrowserWindow.
  chromeView.webContents.once('did-finish-load', () => {
    layout();
    pushState();
    pushExtensions();
  });

  chromeView.webContents.loadFile(path.join(__dirname, 'chrome', 'toolbar.html'));
  popoverView.webContents.loadFile(path.join(__dirname, 'chrome', 'popover.html'));
  if (!adoptedContents) contents.loadURL(url);

  return shellRef;
}

// Resolves the shell an IPC message belongs to, and rejects anything not sent by that
// window's own toolbar frame.
function shellFor(event) {
  const shellRef = shells.get(event.sender.id);
  if (!shellRef) return null;
  const allowed = [shellRef.chromeView, shellRef.popoverView]
    .map(v => v.webContents.mainFrame);
  if (!allowed.includes(event.senderFrame)) return null;
  return shellRef;
}

// Clicking the toolbar takes keyboard focus away from the content view, and it is not
// returned automatically — without this, Onshape stops receiving keys after the first
// toolbar interaction.
function refocusContent(shellRef) {
  if (shellRef && !shellRef.contentView.webContents.isDestroyed()) {
    shellRef.contentView.webContents.focus();
  }
}

function closeMenu(shellRef) {
  shellRef.popoverView.setVisible(false);
  refocusContent(shellRef);
}

// An HTML popover rather than a native Menu: native menus on Linux are strictly vertical
// lists — `header`/`palette` row types are macOS-only — so the back/reload/forward icon
// row is not expressible natively. It also sidesteps native popup positioning entirely,
// which is where the cropped-in-fullscreen behaviour lives.
function registerIpc() {
  ipcMain.on('shell:open-menu', (event, { x, y }) => {
    const shellRef = shellFor(event);
    if (!shellRef) return;
    const contents = shellRef.contentView.webContents;

    shellRef.extPopup.close();
    shellRef.popoverView.setVisible(true);
    shellRef.popoverView.webContents.focus();
    shellRef.popoverView.webContents.send('menu:open', {
      x: Math.round(Number.isFinite(x) ? x : 0),
      y: Math.round(Number.isFinite(y) ? y : TOOLBAR_HEIGHT),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
  });

  // Tray click: open the extension's popup, or fire chrome.action.onClicked when it has
  // none. `x` is the right edge of the clicked icon, so the popup hangs from it.
  ipcMain.on('shell:open-extension', (event, { id, x }) => {
    const shellRef = shellFor(event);
    if (!shellRef || typeof id !== 'string') return;
    shellRef.popoverView.setVisible(false);
    if (extensions.popupUrl(id)) {
      // No refocus here: the popup takes key focus, and its own blur handler closes it.
      // Focus returns to the content view when the popup closes.
      shellRef.extPopup.toggle(id, Number.isFinite(x) ? x : 0);
      return;
    }
    extensions.click(id);
    refocusContent(shellRef);
  });

  ipcMain.on('menu:close', (event) => {
    const shellRef = shellFor(event);
    if (shellRef) closeMenu(shellRef);
  });

  ipcMain.on('menu:action', (event, verb) => {
    const shellRef = shellFor(event);
    if (!shellRef) return;
    const contents = shellRef.contentView.webContents;

    switch (verb) {
      case 'back': contents.navigationHistory.goBack(); break;
      case 'forward': contents.navigationHistory.goForward(); break;
      case 'reload': contents.reload(); break;
      case 'home': contents.loadURL(DOCUMENTS_URL); break;
      case 'newWindow': createShellWindow().win.show(); break;
      case 'quit': app.quit(); return;
      default: return;
    }
    closeMenu(shellRef);
  });
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);

  app.on('second-instance', () => {
    const first = shells.values().next().value;
    if (!first) return;
    if (first.win.isMinimized()) first.win.restore();
    first.win.focus();
  });

  app.on('child-process-gone', (_e, details) => console.error('[child-process-gone]', details));

  app.on('before-quit', bridge.stop);
  app.on('will-quit', bridge.stop);

  app.whenReady().then(async () => {
    const ses = session.fromPartition(PARTITION);
    applyPermissionPolicy(ses);
    bridge.installCertificateTrust(ses);
    bridge.start();
    registerIpc();
    // Before any window exists: extensions must be loaded before the first navigation, and
    // Electron does not remember them across launches.
    await extensions.init(ses);

    createShellWindow({ persistBounds: true }).win.show();

    app.on('activate', () => {
      if (shells.size === 0) createShellWindow().win.show();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Start unless a test harness is driving this module itself (scripts/smoke-extensions.js),
// which builds its own window from the exports below.
//
// Do NOT write this as `require.main === module`: in Electron's main process require.main is
// Electron's own internal module, never the entry file, so that check is always false and
// the app would start with no window and no error.
if (process.env.SHAPESHELL_TEST_HARNESS !== '1') main();

module.exports = { createShellWindow, registerIpc, PARTITION, TOOLBAR_HEIGHT, START_URL };
