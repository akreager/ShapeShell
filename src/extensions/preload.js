'use strict';

// Runs inside extension contexts: registered session-wide for service workers
// (ses.registerPreloadScript) and set as the preload of the popup views we create. It is
// never attached to the Onshape content view.
//
// Two jobs:
//   1. Report chrome.action calls to the main process, since Electron implements the API
//      but nothing draws it — the toolbar tray does.
//   2. Supply namespaces Electron does not implement, so extensions that read them at
//      startup can run at all. Measured against Electron 44.4.1 in phase 0; see
//      docs/extensions-plan.md. Everything here is inert: phase 2 gives webNavigation,
//      tabs.query, windows and notifications real behaviour.

const { contextBridge, ipcRenderer } = require('electron');

const ACTION_CHANNEL = 'shapeshell-ext:action';
const READY_CHANNEL = 'shapeshell-ext:ready';
const CLICK_CHANNEL = 'shapeshell-ext:clicked';

// The main world gets these functions, not ipcRenderer itself, so an extension can only
// ever reach these three verbs.
const bridge = {
  action: (extId, patch) => ipcRenderer.send(ACTION_CHANNEL, extId, patch),
  ready: (extId, detail) => ipcRenderer.send(READY_CHANNEL, extId, detail),
  onClicked: (cb) => ipcRenderer.on(CLICK_CHANNEL, (_event, extId) => cb(extId)),
};

contextBridge.executeInMainWorld({
  args: [bridge],
  func: (host) => {
    // A service-worker preload runs in its own realm, which has no `location`; the check
    // belongs here, in the context this function is executing against.
    if (globalThis.location?.protocol !== 'chrome-extension:') return;
    const chrome = globalThis.chrome;
    if (!chrome?.runtime?.id) return;
    const extId = chrome.runtime.id;
    const manifest = chrome.runtime.getManifest();
    const isWorker = typeof ServiceWorkerGlobalScope !== 'undefined';

    // ---- chrome.action -> the toolbar tray ---------------------------------------------
    const action = chrome.action || chrome.browserAction;
    if (action) {
      const report = (patch) => { try { host.action(extId, patch); } catch { /* shutting down */ } };
      const forward = (name, toPatch) => {
        const original = action[name];
        action[name] = function (details, callback) {
          report(toPatch(details || {}));
          // Electron's own implementation keeps chrome.action.getX consistent; it draws
          // nothing, and must never be allowed to break the call.
          try {
            if (typeof original === 'function') return original.call(action, details, callback);
          } catch { /* fall through to the callback below */ }
          if (typeof callback === 'function') callback();
          return undefined;
        };
      };
      forward('setBadgeText', d => ({ badgeText: String(d.text ?? '') }));
      forward('setBadgeBackgroundColor', d => ({ badgeColor: typeof d.color === 'string' ? d.color : undefined }));
      forward('setTitle', d => ({ title: String(d.title ?? '') }));
      forward('setPopup', d => ({ popup: String(d.popup ?? '') }));
      forward('setIcon', d => ({ icon: typeof d.path === 'string' ? d.path : Object.values(d.path || {}).pop() }));
      forward('enable', () => ({ enabled: true }));
      forward('disable', () => ({ enabled: false }));

      // Electron defines action.onClicked but never fires it, so replace it outright: the
      // tray is what clicks the action, and only in the background context.
      if (isWorker) {
        const listeners = new Set();
        Object.defineProperty(action, 'onClicked', {
          configurable: true,
          value: {
            addListener: (fn) => { listeners.add(fn); },
            removeListener: (fn) => { listeners.delete(fn); },
            hasListener: (fn) => listeners.has(fn),
            hasListeners: () => listeners.size > 0,
          },
        });
        host.onClicked((clicked) => {
          if (clicked !== extId) return;
          for (const fn of listeners) {
            // A tab argument would be a lie until phase 2 implements tabs.query.
            try { fn(undefined); } catch (e) { console.error('[shapeshell] action.onClicked listener failed', e); }
          }
        });
      }
    }

    // ---- namespaces Electron does not implement ----------------------------------------
    const event = () => {
      const listeners = new Set();
      return {
        addListener: (fn) => { listeners.add(fn); },
        removeListener: (fn) => { listeners.delete(fn); },
        hasListener: (fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0,
      };
    };
    // Chrome APIs either return a promise or call a trailing callback asynchronously.
    const api = (impl) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const result = Promise.resolve().then(() => impl(...args));
      if (!cb) return result;
      result.then((v) => cb(v));
      return undefined;
    };
    const added = [];
    const define = (obj, key, value) => {
      if (key in obj) return;
      Object.defineProperty(obj, key, { value, configurable: true, enumerable: true, writable: true });
      added.push(key);
    };

    define(chrome, 'webNavigation', {
      onBeforeNavigate: event(), onCommitted: event(), onDOMContentLoaded: event(),
      onCompleted: event(), onErrorOccurred: event(), onCreatedNavigationTarget: event(),
      onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onTabReplaced: event(),
      getFrame: api(() => null),
      getAllFrames: api(() => []),
    });
    let menuId = 0;
    define(chrome, 'contextMenus', {
      onClicked: event(),
      create: (props, cb) => { if (typeof cb === 'function') setTimeout(cb, 0); return props?.id ?? ++menuId; },
      update: api(() => undefined),
      remove: api(() => undefined),
      removeAll: api(() => undefined),
    });
    define(chrome, 'commands', {
      onCommand: event(),
      getAll: api(() => Object.entries(manifest.commands || {})
        .map(([name, c]) => ({ name, description: c.description || '', shortcut: '' }))),
    });
    // Only what the manifest declares is granted, and requests are refused — that is what
    // keeps optional permissions such as nativeMessaging and privacy off.
    const granted = new Set([...(manifest.permissions || []), ...(manifest.host_permissions || [])]);
    define(chrome, 'permissions', {
      onAdded: event(),
      onRemoved: event(),
      contains: api((p = {}) => [...(p.permissions || []), ...(p.origins || [])].every(x => granted.has(x))),
      getAll: api(() => ({ permissions: manifest.permissions || [], origins: manifest.host_permissions || [] })),
      request: api(() => false),
      remove: api(() => false),
    });
    define(chrome, 'sidePanel', {
      setOptions: api(() => undefined), getOptions: api(() => ({})), open: api(() => undefined),
      setPanelBehavior: api(() => undefined), getPanelBehavior: api(() => ({})),
    });
    let noteId = 0;
    define(chrome, 'notifications', {
      onClicked: event(), onButtonClicked: event(), onClosed: event(), onShowSettings: event(),
      create: api((id) => (typeof id === 'string' ? id : `n${++noteId}`)),
      clear: api(() => true), getAll: api(() => ({})), update: api(() => false),
    });
    if (chrome.tabs) define(chrome.tabs, 'getCurrent', api(() => undefined));

    try { host.ready(extId, `${isWorker ? 'worker' : location.pathname}: added ${added.join(', ') || 'nothing'}`); } catch { /* ignore */ }
  },
});
