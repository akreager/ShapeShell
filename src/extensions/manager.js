'use strict';

// Extension loading and toolbar-action state (extensions phase 1).
//
// Electron implements chrome.action but nothing draws it, and it forgets loaded extensions
// on every boot. So this module loads them on startup, and our own preload reports every
// action call (badge, title, icon, popup) here, where the toolbar tray can render it.
//
// Extensions come from two places: those installed from the Manage Extensions window
// (checked again on every launch, since Electron forgets them), and, when running from
// source only, SHAPESHELL_DEV_EXTENSIONS for development. See docs/extensions-plan.md.
//
// This module also owns what that window shows: the supported list merged with what is
// installed, update availability, pins, and any install in progress.

const { app, ipcMain } = require('electron');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const apiHost = require('./api-host');
const installer = require('./install');
const allowlistModule = require('./allowlist');
const updates = require('./updates');

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
const state = new Map(); // extension id -> { extension, action, key }
let extSession = null;
let extensionsDir = null;
let prefsFile = null;

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

// `key` is the install key (store id or slug) of an installed extension; dev extensions
// have none and are always shown in the tray.
async function loadUnpacked(dir, key = null) {
  const resolved = path.resolve(dir);
  const extension = await extSession.extensions.loadExtension(resolved);
  state.set(extension.id, {
    extension,
    key,
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
  prefsFile = path.join(app.getPath('userData'), 'extension-prefs.json');
  prefs = readPrefs();

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
  installedCache = null;
  const installed = installedState();
  for (const { key, reasons } of installed.skipped) {
    log(`NOT loading ${key}: ${reasons.join('; ')}`);
  }
  for (const { key, path: dir, record } of installed.ready) {
    try {
      await loadUnpacked(dir, key);
    } catch (e) {
      log(`FAILED to load ${record.name}: ${e.message}`);
      errors.set(key, `It could not be loaded: ${e.message}`);
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

// ---------------------------------------------------------------------------------------
// Installing, updating, and what the Manage Extensions window shows
// ---------------------------------------------------------------------------------------

let prefs = { pinned: {} };
const latest = new Map(); // install key -> newest store build { version, url, sha256, size }, or null
const ops = new Map(); // install key -> { phase, received, total, controller }
const errors = new Map(); // install key -> the last failure, shown on its row
let installedCache = null;
let lastProgressEmit = 0;

function readPrefs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    return { pinned: parsed && typeof parsed.pinned === 'object' && parsed.pinned ? parsed.pinned : {} };
  } catch {
    return { pinned: {} };
  }
}

function writePrefs() {
  try {
    fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
  } catch (e) {
    log(`could not save extension preferences: ${e.message}`);
  }
}

// Pinned unless the user unpinned it: installing is itself a request to use the thing.
function isPinned(key) {
  return prefs.pinned[key] !== false;
}

function setPinned(key, pinned) {
  if (typeof key !== 'string') return;
  prefs.pinned[key] = Boolean(pinned);
  writePrefs();
  emitter.emit('changed');
}

function readAllowlist() {
  try {
    return allowlistModule.load();
  } catch (e) {
    log(`the supported list could not be read: ${e.message}`);
    return { extensions: [] };
  }
}

const keyOfEntry = entry => entry.id || entry.slug;

// Re-hashing every installed tree is not free (Bitwarden is 80MB unpacked), so the result
// is kept until an install or removal changes it.
function installedState() {
  if (!installedCache) {
    try {
      installedCache = installer.verifyInstalled(extensionsDir);
    } catch (e) {
      installedCache = { ready: [], skipped: [] };
      log(`installed extensions could not be checked: ${e.message}`);
    }
  }
  return installedCache;
}

function installedRecords() {
  const { ready, skipped } = installedState();
  return new Map([
    ...ready.map(r => [r.key, { record: r.record, reasons: [] }]),
    ...skipped.map(s => [s.key, { record: s.record, reasons: s.reasons }]),
  ]);
}

function loadedByKey(key) {
  return [...state.values()].find(e => e.key === key) || null;
}

function unloadKey(key) {
  const entry = loadedByKey(key);
  if (!entry) return;
  extSession.extensions.removeExtension(entry.extension.id);
  state.delete(entry.extension.id);
}

// Progress arrives per network chunk; the window needs a few updates a second, not hundreds.
function setOp(key, op) {
  if (op) ops.set(key, op);
  else ops.delete(key);
  const now = Date.now();
  if (op?.phase === 'downloading' && now - lastProgressEmit < 100) return;
  lastProgressEmit = now;
  emitter.emit('catalog');
}

// install.js calls beforeSwap only once every check has passed, so the running copy is
// unloaded at the last moment and a refused update leaves it running.
async function installAndLoad(installFn) {
  const result = installFn({ beforeSwap: key => unloadKey(key) });
  installedCache = null;
  errors.delete(result.key);
  try {
    await loadUnpacked(result.path, result.key);
  } catch (e) {
    errors.set(result.key, `Installed, but it could not be loaded: ${e.message}`);
    throw e;
  } finally {
    emitter.emit('changed');
  }
  log(`installed ${result.name} ${result.version}${result.previousVersion ? ` (was ${result.previousVersion})` : ''}`);
  return result;
}

/**
 * Installs a .crx file or unpacked folder chosen by the user. Without `allowUnsupported`
 * only a supported build passes; with it, anything that parses does — the Manage window
 * passes it only after the user accepted the unsupported-extension warning.
 * Throws installer.RefusedError with readable reasons when it does not pass.
 */
async function installFromPath(source, { allowUnsupported = false } = {}) {
  return installAndLoad(o => installer.install(source, extensionsDir, { ...o, allowUnsupported }));
}

/**
 * Installs or updates an extension by downloading it: a supported one from its listed
 * source, or an unsupported store extension from the Web Store. Progress and failures are
 * reported through catalog(), not thrown.
 */
async function installSupported(key) {
  if (typeof key !== 'string' || ops.has(key)) return;
  const entry = readAllowlist().extensions.find(e => keyOfEntry(e) === key) || null;
  const record = installedRecords().get(key)?.record || null;
  const controller = new AbortController();
  const onProgress = (received, total) => setOp(key, { phase: 'downloading', received, total, controller });
  errors.delete(key);
  setOp(key, { phase: 'checking', received: 0, total: null, controller });

  try {
    if (entry?.archive) {
      const files = await updates.downloadGithubArchive(entry.archive, { signal: controller.signal, onProgress });
      setOp(key, { phase: 'installing', controller });
      await installAndLoad(o => installer.installFiles(files, extensionsDir, { ...o, source: updates.githubArchiveUrl(entry.archive) }));
    } else {
      const id = entry ? entry.id : record?.id;
      if (!id) throw new Error('There is nowhere to download this extension from');
      const found = (await updates.checkWebstore([id])).get(id) || null;
      latest.set(key, found);
      if (!found) throw new Error('The Chrome Web Store does not offer this extension');
      const bytes = await updates.downloadCrx(found, { signal: controller.signal, onProgress });
      setOp(key, { phase: 'installing', controller });
      await installAndLoad(o => installer.installCrx(bytes, extensionsDir, {
        ...o,
        expectId: id,
        // An unsupported extension was accepted as such when first installed; its updates
        // are held to the same terms, and a supported id is always held to its entry.
        allowUnsupported: !entry,
        source: found.url,
      }));
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      const message = e instanceof installer.RefusedError ? e.reasons.join('; ') : e.message;
      errors.set(key, record ? `The update was not installed; ${record.version} is still in use. ${message}` : message);
      log(`install of ${key} failed: ${message}`);
    }
  } finally {
    setOp(key, null);
  }
}

function cancelInstall(key) {
  ops.get(key)?.controller.abort();
}

// Asks the Web Store about every installed store extension, supported or not, in one
// request. Only the ids of installed extensions leave the machine. GitHub builds need no
// check: their newest reviewed build ships in the list itself.
let checking = null;
function checkForUpdates() {
  if (checking) return checking;
  checking = (async () => {
    const ids = [...installedRecords().values()].map(({ record }) => record?.id).filter(Boolean);
    if (ids.length === 0) return;
    try {
      const found = await updates.checkWebstore(ids);
      for (const id of ids) latest.set(id, found.get(id) ?? null);
      log(`update check: ${ids.map(id => `${id.slice(0, 8)}=${found.get(id)?.version ?? 'not in store'}`).join(' ')}`);
    } catch (e) {
      log(`update check failed: ${e.message}`);
    }
    emitter.emit('catalog');
  })().finally(() => { checking = null; });
  return checking;
}

function catalogRow(key, entry, installed) {
  const record = installed?.record || null;
  const loaded = loadedByKey(key);
  const store = latest.get(key);
  let latestVersion = null;
  let updateAvailable = false;
  if (entry?.archive) {
    latestVersion = entry.archive.version;
    updateAvailable = Boolean(record) && record.sourceTreeSha256 !== entry.archive.treeSha256;
  } else if (store) {
    latestVersion = store.version;
    updateAvailable = Boolean(record) && allowlistModule.compareVersions(store.version, record.version) > 0;
  }
  const op = ops.get(key);
  let sourceUrl = entry?.source || null;
  if (!sourceUrl && record?.id && store) sourceUrl = `https://chromewebstore.google.com/detail/${record.id}`;
  if (!sourceUrl) sourceUrl = record?.homepage || null;
  return {
    key,
    name: entry?.name || record?.name || key,
    supported: Boolean(entry),
    hasSource: Boolean(sourceUrl),
    sourceLabel: entry?.archive ? 'GitHub' : sourceUrl?.startsWith('https://chromewebstore.google.com/') ? 'Chrome Web Store' : 'Homepage',
    installedVersion: record?.version || null,
    latestVersion,
    updateAvailable,
    // Something to download from: a supported entry, or an unsupported store extension.
    downloadable: Boolean(entry) || Boolean(record?.id && store),
    problem: installed?.reasons.length ? installed.reasons.join('; ') : null,
    loaded: Boolean(loaded),
    canPin: Boolean(loaded?.action.hasAction),
    pinned: isPinned(key),
    icon: loaded?.action.icon || null,
    op: op ? { phase: op.phase, received: op.received || 0, total: op.total || null } : null,
    error: errors.get(key) || null,
  };
}

/** Every row the Manage Extensions window shows: the supported list, then anything else installed. */
function catalog() {
  const installed = installedRecords();
  const rows = readAllowlist().extensions.map(entry => catalogRow(keyOfEntry(entry), entry, installed.get(keyOfEntry(entry))));
  for (const [key, info] of installed) {
    if (!rows.some(r => r.key === key)) rows.push(catalogRow(key, null, info));
  }
  return rows;
}

function updatesAvailable() {
  return catalog().some(r => r.updateAvailable);
}

/** The page a row links to, looked up by key so the window never supplies a URL itself. */
function sourceUrl(key) {
  const row = catalog().find(r => r.key === key);
  if (!row?.hasSource) return null;
  const entry = readAllowlist().extensions.find(e => keyOfEntry(e) === key);
  const record = installedRecords().get(key)?.record;
  return entry?.source
    || (record?.id && latest.get(key) ? `https://chromewebstore.google.com/detail/${record.id}` : null)
    || record?.homepage
    || null;
}

function listInstalled() {
  const { ready, skipped } = installedState();
  return {
    ready: ready.map(({ key, record }) => ({ key, name: record.name, version: record.version, supported: record.supported !== false })),
    skipped: skipped.map(({ key, reasons }) => ({ key, reasons })),
  };
}

function uninstall(key) {
  if (typeof key !== 'string' || ops.has(key)) return;
  unloadKey(key);
  installer.uninstall(extensionsDir, key);
  installedCache = null;
  delete prefs.pinned[key];
  writePrefs();
  errors.delete(key);
  latest.delete(key);
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
      // While a popup navigates within itself (Bitwarden reloads its page after unlocking),
      // the old frame is disposed before the new one commits. webContents.send() then logs a
      // stack trace per event, "Render frame was disposed". Nothing is lost by skipping it:
      // the incoming page reads its state fresh when it loads.
      const frame = view.webContents.mainFrame;
      if (frame && !frame.isDestroyed() && !frame.detached) frame.send(EVENT_CHANNEL, name, args);
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

// What the toolbar tray draws: pinned extensions that have an action. Content-script-only
// extensions have nothing to click, so they never appear.
function listActions() {
  return [...state.values()]
    .filter(e => e.action.hasAction && (e.key === null || isPinned(e.key)))
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
  installSupported,
  cancelInstall,
  checkForUpdates,
  catalog,
  updatesAvailable,
  setPinned,
  sourceUrl,
  listInstalled,
  uninstall,
  RefusedError: installer.RefusedError,
  get,
  preloadPath: PRELOAD,
  onChange: (fn) => { emitter.on('changed', fn); return () => emitter.off('changed', fn); },
  // The Manage window's rows: every tray change, plus progress and update checks.
  onCatalogChange: (fn) => {
    emitter.on('changed', fn);
    emitter.on('catalog', fn);
    return () => { emitter.off('changed', fn); emitter.off('catalog', fn); };
  },
};
