'use strict';

// Extension loading and toolbar-action state (extensions phase 1).
//
// Electron implements chrome.action but nothing draws it, and it forgets loaded extensions
// on every boot. So this module loads them on startup, and our own preload reports every
// action call (badge, title, icon, popup) here, where the toolbar tray can render it.
//
// Phase 1 loads only from SHAPESHELL_DEV_EXTENSIONS, and only when running from source. The
// allowlist and the real install pipeline are phase 3 — see docs/extensions-plan.md.

const { app, ipcMain } = require('electron');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const PRELOAD = path.join(__dirname, 'preload.js');
// Extension contexts report action state on these; nothing else may send them.
const ACTION_CHANNEL = 'shapeshell-ext:action';
const READY_CHANNEL = 'shapeshell-ext:ready';
const CLICK_CHANNEL = 'shapeshell-ext:clicked';

const emitter = new EventEmitter();
const state = new Map(); // extension id -> { extension, action }
let extSession = null;

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
function applyActionPatch(extId, patch) {
  const entry = state.get(extId);
  if (!entry || !patch || typeof patch !== 'object') return;
  const { title, popup, badgeText, badgeColor, enabled, icon } = patch;
  const next = { ...entry.action };
  if (typeof title === 'string') next.title = title;
  if (typeof popup === 'string') next.popup = popup || null;
  if (typeof badgeText === 'string') next.badgeText = badgeText.slice(0, 4);
  if (typeof badgeColor === 'string') next.badgeColor = badgeColor;
  if (typeof enabled === 'boolean') next.enabled = enabled;
  // setIcon paths are relative to the extension root; imageData is not supported yet.
  if (typeof icon === 'string' && icon) {
    try {
      const file = path.join(entry.extension.path, icon);
      if (file.startsWith(entry.extension.path) && fs.existsSync(file)) {
        next.icon = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch (e) {
      log(`setIcon ignored for ${entry.extension.name}: ${e.message}`);
    }
  }
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
  state.set(extension.id, { extension, action: defaultAction(extension) });
  log(`loaded ${extension.name} ${extension.version} (${extension.id}) from ${resolved}`);
  emitter.emit('changed');
  return extension;
}

async function init(ses) {
  extSession = ses;

  // Runs inside every extension service worker before its own script, which is what lets
  // Bitwarden start at all: it reads chrome.webNavigation at the top level, and Electron has
  // no such namespace. It is registered session-wide, so it also runs for a service worker
  // registered by a web origin — there it hits a location check and returns.
  ses.registerPreloadScript({ type: 'service-worker', id: 'shapeshell-extensions', filePath: PRELOAD });

  // Service workers have their own IPC router, reachable only once the worker exists.
  const attached = new Set();
  ses.serviceWorkers.on('running-status-changed', ({ versionId }) => {
    if (attached.has(versionId)) return;
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker) return;
    attached.add(versionId);
    worker.ipc.on(ACTION_CHANNEL, (_event, extId, patch) => applyActionPatch(extId, patch));
    worker.ipc.on(READY_CHANNEL, (_event, extId, detail) => log(`worker ready: ${extId} ${detail || ''}`));
  });

  // Extension pages (popups) use the ordinary renderer IPC.
  ipcMain.on(ACTION_CHANNEL, (event, extId, patch) => {
    if (event.sender.session === extSession) applyActionPatch(extId, patch);
  });
  ipcMain.on(READY_CHANNEL, (event, extId, detail) => {
    if (event.sender.session === extSession) log(`page ready: ${extId} ${detail || ''}`);
  });

  for (const dir of devExtensionPaths()) {
    try {
      await loadUnpacked(dir);
    } catch (e) {
      log(`FAILED to load ${dir}: ${e.message}`);
    }
  }
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
  get,
  preloadPath: PRELOAD,
  onChange: (fn) => { emitter.on('changed', fn); return () => emitter.off('changed', fn); },
};
