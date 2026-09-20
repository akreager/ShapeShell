'use strict';

// Extension loading and toolbar-action state (extensions phase 1).
//
// Electron implements chrome.action but nothing draws it, and it forgets loaded extensions
// on every boot. So this module loads them on startup, and our own preload reports every
// action call (badge, title, icon, popup) here, where the toolbar tray can render it.
//
// Extensions come from two places: those installed through the allowlist (checked again on
// every launch, since Electron forgets them), and, when running from source only,
// SHAPESHELL_DEV_EXTENSIONS for development. See docs/extensions-plan.md.

const { app, ipcMain } = require('electron');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const apiHost = require('./api-host');
const installer = require('./install');

const PRELOAD = path.join(__dirname, 'preload.js');
// Extension contexts report action state on these; nothing else may send them.
const ACTION_CHANNEL = 'shapeshell-ext:action';
const READY_CHANNEL = 'shapeshell-ext:ready';
const CLICK_CHANNEL = 'shapeshell-ext:clicked';
// Extension contexts call the APIs Electron lacks over this; main pushes their events back
// over EVENT_CHANNEL. See src/extensions/api-host.js.
const INVOKE_CHANNEL = 'shapeshell-ext:invoke';
const EVENT_CHANNEL = 'shapeshell-ext:event';
// Extension contexts announce which events they actually listen to, so an event nobody
// wants never wakes a sleeping worker.
const LISTEN_CHANNEL = 'shapeshell-ext:listens';
const STORAGE_CHANGED_CHANNEL = 'shapeshell-ext:storage-changed';

const emitter = new EventEmitter();
const state = new Map(); // extension id -> { extension, action }
let extSession = null;
let extensionsDir = null;

function log(...args) {
  console.log('[extensions]', ...args);
}

// ---------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------

// The tray draws at 16px on a 32px bar, so a 32px source covers 2x displays. Fall back to
// the largest available, then the extension's own icons if the action declares none.
function iconDataUrl(extension) {
  const manifest = extension.manifest || {};
  const sources = { ...(manifest.icons || {}), ...(manifest.action?.default_icon || {}) };
  if (typeof manifest.action?.default_icon === 'string') sources['0'] = manifest.action.default_icon;
  const sizes = Object.keys(sources).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const pick = sizes.find(s => s >= 32) ?? sizes[sizes.length - 1];
  const rel = sources[String(pick)];
  if (!rel) return null;
  try {
    const file = path.join(extension.path, rel);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (e) {
    log(`icon unreadable for ${extension.name}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Action state
// ---------------------------------------------------------------------------------------

function defaultAction(extension) {
  const action = extension.manifest?.action || extension.manifest?.browser_action || null;
  return {
    hasAction: Boolean(action),
    title: action?.default_title || extension.name,
    popup: action?.default_popup || null,
    icon: iconDataUrl(extension),
    badgeText: '',
    badgeColor: '#666',
    enabled: true,
  };
}

// chrome.action calls arrive from the extension's own contexts via our preload. Anything
// referring to an extension we did not load is ignored.
// A write in one context has to reach every other context of the same extension, which is
// what Electron's missing storage.onChanged would have done.
function broadcastStorageChange(extId, area, changes) {
  if (!state.has(extId) || !changes || typeof changes !== 'object') return;
  emitToExtension(extId, 'storage.onChanged', [changes, area]);
  emitToExtension(extId, `storage.${area}.onChanged`, [changes]);
}

function noteListener(extId, name) {
  const entry = state.get(extId);
  if (entry && typeof name === 'string') entry.listeners.add(name);
}

function applyActionPatch(extId, patch) {
  const entry = state.get(extId);
  if (!entry || !patch || typeof patch !== 'object') return;
  // Extensions re-send the same action state constantly (Bitwarden does it several times a
  // second while syncing), so only a real change is logged or redrawn.
  const { title, popup, badgeText, badgeColor, enabled, icon } = patch;
  const next = { ...entry.action };
  if (typeof title === 'string') next.title = title;
  if (typeof popup === 'string') next.popup = popup || null;
  if (typeof badgeText === 'string') next.badgeText = badgeText.slice(0, 4);
  if (typeof badgeColor === 'string') next.badgeColor = badgeColor;
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (patch.iconUnsupported) {
    log(`setIcon via ${patch.iconUnsupported} is not supported yet (${entry.extension.name}); the tray keeps its current icon`);
  }
  // setIcon paths are relative to the extension root, and may start with a slash.
  if (typeof icon === 'string' && icon) {
    try {
      const file = path.join(entry.extension.path, icon);
      if (!file.startsWith(entry.extension.path)) {
        log(`setIcon path escapes the extension directory, ignored: ${icon}`);
      } else if (!fs.existsSync(file)) {
        log(`setIcon path not found, ignored: ${icon}`);
      } else {
        next.icon = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch (e) {
      log(`setIcon ignored for ${entry.extension.name}: ${e.message}`);
    }
  }
  const changed = ['title', 'popup', 'badgeText', 'badgeColor', 'enabled', 'icon']
    .filter(key => next[key] !== entry.action[key]);
  if (changed.length === 0) return;
  log(`action ${entry.extension.name}: ${changed.map(k => (k === 'icon' ? `icon=${icon}` : `${k}=${JSON.stringify(next[k])}`)).join(' ')}`);
  entry.action = next;
  emitter.emit('changed');
}

// ---------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------

function devExtensionPaths() {
  // Deliberately dev-only: a packaged build must never load an unreviewed extension from an
  // environment variable.
  if (app.isPackaged) return [];
  return (process.env.SHAPESHELL_DEV_EXTENSIONS || '')
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean);
}

async function loadUnpacked(dir) {
  const resolved = path.resolve(dir);
  const extension = await extSession.extensions.loadExtension(resolved);
  state.set(extension.id, {
    extension,
    action: defaultAction(extension),
    listeners: new Set(),
    // A content-script-only extension has no worker to wake, and asking for one fails.
    hasWorker: Boolean(extension.manifest?.background?.service_worker),
    wakeFailed: false,
  });
  log(`loaded ${extension.name} ${extension.version} (${extension.id}) from ${resolved}`);
  emitter.emit('changed');
  return extension;
}

async function init(ses) {
  extSession = ses;
  extensionsDir = path.join(app.getPath('userData'), 'Extensions');

  // Runs inside every extension service worker before its own script, which is what lets
  // Bitwarden start at all: it reads chrome.webNavigation at the top level, and Electron has
  // no such namespace. It is registered session-wide, so it also runs for a service worker
  // registered by a web origin — there it hits a location check and returns.
  ses.registerPreloadScript({ type: 'service-worker', id: 'shapeshell-extensions', filePath: PRELOAD });

  // Service workers have their own IPC router, reachable only once the worker exists, and
  // each router belongs to one ServiceWorkerMain instance.
  //
  // An MV3 worker stops when idle and restarts on demand, and the restart produces a NEW
  // instance with no handlers — under the SAME version id. Keying this off the version id
  // meant the restarted worker had no route to the main process, and every extension API
  // call failed with "No handler registered". A WeakSet of instances is the correct key.
  const attachedWorkers = new WeakSet();
  const attachWorker = (versionId) => {
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || worker.isDestroyed() || attachedWorkers.has(worker)) return;
    attachedWorkers.add(worker);
    worker.ipc.on(ACTION_CHANNEL, (_event, extId, patch) => applyActionPatch(extId, patch));
    worker.ipc.handle(INVOKE_CHANNEL, (_event, extId, method, args) => dispatch(null, extId, method, args));
    worker.ipc.on(READY_CHANNEL, (_event, extId, detail) => log(`worker ready: ${extId} ${detail || ''}`));
    worker.ipc.on(LISTEN_CHANNEL, (_event, extId, name) => noteListener(extId, name));
    worker.ipc.on(STORAGE_CHANGED_CHANNEL, (_event, extId, area, changes) => broadcastStorageChange(extId, area, changes));
  };
  ses.serviceWorkers.on('running-status-changed', ({ versionId }) => attachWorker(versionId));
  // Covers a worker that is already running when an extension loads or reloads.
  for (const versionId of Object.keys(ses.serviceWorkers.getAllRunning())) attachWorker(Number(versionId));

  // Extension pages (popups) use the ordinary renderer IPC.
  ipcMain.on(ACTION_CHANNEL, (event, extId, patch) => {
    if (event.sender.session === extSession) applyActionPatch(extId, patch);
  });
  ipcMain.handle(INVOKE_CHANNEL, (event, extId, method, args) => {
    if (event.sender.session !== extSession) throw new Error('Not an extension context');
    return dispatch(event.sender.id, extId, method, args);
  });
  ipcMain.on(READY_CHANNEL, (event, extId, detail) => {
    if (event.sender.session === extSession) log(`page ready: ${extId} ${detail || ''}`);
  });
  ipcMain.on(LISTEN_CHANNEL, (event, extId, name) => {
    if (event.sender.session === extSession) noteListener(extId, name);
  });
  ipcMain.on(STORAGE_CHANGED_CHANNEL, (event, extId, area, changes) => {
    if (event.sender.session === extSession) broadcastStorageChange(extId, area, changes);
  });

  // Installed extensions are re-checked here, not just at install time: an app update can
  // drop an entry from the allowlist, and files can change on disk.
  let installed = { ready: [], skipped: [] };
  try {
    installed = installer.verifyInstalled(extensionsDir);
  } catch (e) {
    log(`the allowlist could not be read, so no installed extension will load: ${e.message}`);
  }
  for (const { key, reasons } of installed.skipped) {
    log(`NOT loading ${key}: ${reasons.join('; ')}`);
  }
  for (const { path: dir, record } of installed.ready) {
    try {
      await loadUnpacked(dir);
    } catch (e) {
      log(`FAILED to load ${record.name}: ${e.message}`);
    }
  }

  for (const dir of devExtensionPaths()) {
    try {
      await loadUnpacked(dir);
    } catch (e) {
      log(`FAILED to load ${dir}: ${e.message}`);
    }
  }
}

// Checks a .crx file or unpacked folder against the allowlist and, if it passes, installs and
// loads it. Throws installer.RefusedError with readable reasons when it does not.
async function installFromPath(source) {
  const result = installer.install(source, extensionsDir);
  const extension = await loadUnpacked(result.path);
  log(`installed ${result.name} ${result.version}`);
  return { ...result, extension };
}

function listInstalled() {
  try {
    const { ready, skipped } = installer.verifyInstalled(extensionsDir);
    return {
      ready: ready.map(({ record }) => ({ key: record.id || record.slug, name: record.name, version: record.version })),
      skipped,
    };
  } catch (e) {
    return { ready: [], skipped: [{ key: 'allowlist', reasons: [e.message] }] };
  }
}

function uninstall(key) {
  const entry = [...state.values()].find(e => e.extension.path.startsWith(path.join(extensionsDir, key) + path.sep));
  if (entry) {
    extSession.extensions.removeExtension(entry.extension.id);
    state.delete(entry.extension.id);
  }
  installer.uninstall(extensionsDir, key);
  emitter.emit('changed');
  log(`uninstalled ${key}`);
}

// ---------------------------------------------------------------------------------------
// API host plumbing
// ---------------------------------------------------------------------------------------

// A call is honoured only for an extension we actually loaded.
async function dispatch(senderId, extId, method, args) {
  const entry = state.get(extId);
  if (!entry) throw new Error('Unknown extension');
  const handler = apiHost.handlers[method];
  if (!handler) throw new Error(`Unsupported method: ${method}`);
  return handler({
    senderId,
    extId,
    extensionUrl: entry.extension.url,
    session: extSession,
    preloadPath: PRELOAD,
  }, ...(Array.isArray(args) ? args : []));
}

function runningWorkers() {
  const out = [];
  for (const [versionId, info] of Object.entries(extSession.serviceWorkers.getAllRunning())) {
    const worker = extSession.serviceWorkers.getWorkerFromVersionID(Number(versionId));
    if (worker && !worker.isDestroyed()) out.push({ worker, scope: info.scope });
  }
  return out;
}

// Events go to every context of the extension: its worker, and any popup or window of ours
// showing one of its pages.
//
// An idle MV3 worker is stopped, and Chrome wakes it for events the extension listens to.
// Ours does the same: without it, an extension that slept through a navigation would never
// hear about it.
function emitToExtension(extId, name, args) {
  const entry = state.get(extId);
  // Nothing in this extension has asked for this event, so there is nothing to deliver and
  // no reason to start a worker for it.
  if (!entry || !entry.listeners.has(name)) return;
  const workers = runningWorkers().filter(w => w.scope && w.scope.startsWith(entry.extension.url));
  if (workers.length === 0 && entry.hasWorker) {
    extSession.serviceWorkers.startWorkerForScope(entry.extension.url)
      .then(worker => worker.send(EVENT_CHANNEL, name, args))
      .catch((e) => {
        // Once per extension: this used to log on every event of every navigation.
        if (entry.wakeFailed) return;
        entry.wakeFailed = true;
        log(`could not wake the worker for ${entry.extension.name}: ${e.message}`);
      });
  }
  for (const { worker } of workers) worker.send(EVENT_CHANNEL, name, args);
  for (const shellRef of apiHost.liveWindows()) {
    const view = shellRef.extPopup?.view;
    if (view && shellRef.extPopup.extId === extId && !view.webContents.isDestroyed()) {
      view.webContents.send(EVENT_CHANNEL, name, args);
    }
  }
}

function emitToAll(name, args) {
  for (const extId of state.keys()) emitToExtension(extId, name, args);
}

// Hooks a ShapeShell window up as the one tab extensions can see, and turns its navigation
// into chrome.webNavigation and chrome.tabs events.
//
// Electron defines chrome.tabs.onUpdated and friends but never fires them (measured), so an
// extension would never learn the page changed — Bitwarden refreshes its icon and autofill
// state from exactly these.
function attachWindow(shellRef) {
  apiHost.registerWindow(shellRef);
  const wc = shellRef.contentView.webContents;

  const tabUpdate = (changeInfo) => {
    if (wc.isDestroyed()) return;
    emitToAll('tabs.onUpdated', [wc.id, changeInfo, apiHost.tabOf(shellRef)]);
  };
  wc.on('did-start-loading', () => tabUpdate({ status: 'loading' }));
  wc.on('did-stop-loading', () => tabUpdate({ status: 'complete', url: wc.getURL(), title: wc.getTitle() }));
  wc.on('did-navigate', (_event, url) => tabUpdate({ url, status: 'loading' }));
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) tabUpdate({ url }); });
  wc.on('page-title-updated', (_event, title) => tabUpdate({ title }));
  wc.on('media-started-playing', () => tabUpdate({ audible: true }));
  wc.on('media-paused', () => tabUpdate({ audible: false }));

  // One tab per window, so focusing a window is what "activating a tab" means here.
  shellRef.win.on('focus', () => {
    emitToAll('tabs.onActivated', [{ tabId: wc.id, windowId: shellRef.win.id }]);
    emitToAll('windows.onFocusChanged', [shellRef.win.id]);
  });
  shellRef.win.on('blur', () => {
    if (!apiHost.focusedWindowExists()) emitToAll('windows.onFocusChanged', [apiHost.WINDOW_ID_NONE]);
  });

  emitToAll('tabs.onCreated', [apiHost.tabOf(shellRef)]);
  emitToAll('windows.onCreated', [apiHost.windowOf(shellRef, false)]);

  const base = () => ({ tabId: wc.id, timeStamp: Date.now() });
  const frameDetails = (frame, url) => {
    const main = wc.mainFrame;
    return {
      ...base(),
      url: url ?? frame?.url ?? wc.getURL(),
      frameId: frame ? apiHost.frameIdOf(frame, main) : 0,
      parentFrameId: frame?.parent ? apiHost.frameIdOf(frame.parent, main) : -1,
      processId: frame?.processId ?? wc.mainFrame.processId,
      frameType: frame?.parent ? 'sub_frame' : 'outermost_frame',
      documentLifecycle: 'active',
    };
  };

  wc.on('did-start-navigation', (details) => {
    emitToAll('webNavigation.onBeforeNavigate', [frameDetails(details.frame, details.url)]);
  });
  wc.on('did-frame-navigate', (_event, url, httpResponseCode, _method, _isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = require('electron').webFrameMain.fromId(frameProcessId, frameRoutingId);
    emitToAll('webNavigation.onCommitted', [{
      ...frameDetails(frame, url),
      transitionType: 'link',
      transitionQualifiers: [],
    }]);
    if (httpResponseCode >= 400) {
      emitToAll('webNavigation.onErrorOccurred', [{ ...frameDetails(frame, url), error: `HTTP ${httpResponseCode}` }]);
    }
  });
  wc.on('dom-ready', () => emitToAll('webNavigation.onDOMContentLoaded', [frameDetails(wc.mainFrame)]));
  wc.on('did-finish-load', () => emitToAll('webNavigation.onCompleted', [frameDetails(wc.mainFrame)]));
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = require('electron').webFrameMain.fromId(frameProcessId, frameRoutingId);
    emitToAll('webNavigation.onErrorOccurred', [{ ...frameDetails(frame, url), error: description || `net error ${code}` }]);
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = require('electron').webFrameMain.fromId(frameProcessId, frameRoutingId);
    emitToAll('webNavigation.onHistoryStateUpdated', [{
      ...frameDetails(frame, url),
      transitionType: 'link',
      transitionQualifiers: [],
    }]);
  });
}

function detachWindow(shellRef) {
  // Read the ids before unregistering: the window is already on its way out.
  const tabId = shellRef.contentView.webContents.isDestroyed() ? null : shellRef.contentView.webContents.id;
  const windowId = shellRef.win.isDestroyed() ? null : shellRef.win.id;
  apiHost.unregisterWindow(shellRef);
  if (tabId !== null) emitToAll('tabs.onRemoved', [tabId, { windowId, isWindowClosing: true }]);
  if (windowId !== null) emitToAll('windows.onRemoved', [windowId]);
}

// What the toolbar tray draws. Extensions with no action (content-script only) are omitted.
function listActions() {
  return [...state.values()]
    .filter(e => e.action.hasAction)
    .map(({ extension, action }) => ({
      id: extension.id,
      name: extension.name,
      title: action.title,
      icon: action.icon,
      badgeText: action.badgeText,
      badgeColor: action.badgeColor,
      enabled: action.enabled,
      hasPopup: Boolean(action.popup),
    }));
}

function popupUrl(extId) {
  const entry = state.get(extId);
  if (!entry || !entry.action.popup) return null;
  return new URL(entry.action.popup, entry.extension.url).href;
}

// Clicking the tray icon of an extension with no popup is chrome.action.onClicked, which
// only means anything in the background context.
function click(extId) {
  const entry = state.get(extId);
  if (!entry) return false;
  const running = extSession.serviceWorkers.getAllRunning();
  for (const [versionId, info] of Object.entries(running)) {
    if (!info.scope || !info.scope.startsWith(entry.extension.url)) continue;
    const worker = extSession.serviceWorkers.getWorkerFromVersionID(Number(versionId));
    if (worker && !worker.isDestroyed()) {
      worker.send(CLICK_CHANNEL, extId);
      return true;
    }
  }
  log(`no running worker to receive a click for ${entry.extension.name}`);
  return false;
}

function get(extId) {
  return state.get(extId) || null;
}

module.exports = {
  init,
  loadUnpacked,
  listActions,
  popupUrl,
  click,
  attachWindow,
  detachWindow,
  emitToExtension,
  installFromPath,
  listInstalled,
  uninstall,
  RefusedError: installer.RefusedError,
  get,
  preloadPath: PRELOAD,
  onChange: (fn) => { emitter.on('changed', fn); return () => emitter.off('changed', fn); },
};
