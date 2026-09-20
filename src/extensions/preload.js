'use strict';

// Runs inside extension contexts: registered session-wide for service workers
// (ses.registerPreloadScript) and set as the preload of the extension views we create. It is
// never attached to the Onshape content view.
//
// Three jobs:
//   1. Report chrome.action calls to the main process, since Electron implements the API but
//      nothing draws it — the toolbar tray does.
//   2. Supply the namespaces Electron does not implement, backed by src/extensions/api-host.js:
//      windows, webNavigation, and the parts of tabs and runtime that Electron gets wrong for
//      a one-tab-per-window app.
//   3. Keep the remaining namespaces inert so extensions that read them at startup can run.
//
// Measured against Electron 44.4.1; see docs/extensions-plan.md.

const { contextBridge, ipcRenderer } = require('electron');

const ACTION_CHANNEL = 'shapeshell-ext:action';
const READY_CHANNEL = 'shapeshell-ext:ready';
const CLICK_CHANNEL = 'shapeshell-ext:clicked';
const INVOKE_CHANNEL = 'shapeshell-ext:invoke';
const EVENT_CHANNEL = 'shapeshell-ext:event';
const LISTEN_CHANNEL = 'shapeshell-ext:listens';
const STORAGE_CHANGED_CHANNEL = 'shapeshell-ext:storage-changed';

// The main world gets these functions, not ipcRenderer itself, so an extension can only ever
// reach these verbs.
const bridge = {
  action: (extId, patch) => ipcRenderer.send(ACTION_CHANNEL, extId, patch),
  ready: (extId, detail) => ipcRenderer.send(READY_CHANNEL, extId, detail),
  invoke: (extId, method, args) => ipcRenderer.invoke(INVOKE_CHANNEL, extId, method, args),
  onClicked: (cb) => ipcRenderer.on(CLICK_CHANNEL, (_event, extId) => cb(extId)),
  onEvent: (cb) => ipcRenderer.on(EVENT_CHANNEL, (_event, name, args) => cb(name, args)),
  listens: (extId, name) => ipcRenderer.send(LISTEN_CHANNEL, extId, name),
  storageChanged: (extId, area, changes) => ipcRenderer.send(STORAGE_CHANGED_CHANNEL, extId, area, changes),
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

    // ---- helpers -----------------------------------------------------------------------
    const events = new Map();
    const event = (name) => {
      const listeners = new Set();
      const api = {
        addListener: (fn) => {
          // Telling the main process which events matter keeps it from starting a sleeping
          // worker to deliver something nothing is listening for.
          if (name && listeners.size === 0) { try { host.listens(extId, name); } catch { /* ignore */ } }
          listeners.add(fn);
        },
        removeListener: (fn) => { listeners.delete(fn); },
        hasListener: (fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0,
      };
      if (name) {
        events.set(name, (args) => {
          for (const fn of [...listeners]) {
            try { fn(...args); } catch (e) { console.error(`[shapeshell] ${name} listener failed`, e); }
          }
        });
      }
      return api;
    };
    host.onEvent((name, args) => events.get(name)?.(args));

    // Chrome APIs either return a promise or call a trailing callback asynchronously.
    const api = (impl) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const result = Promise.resolve().then(() => impl(...args));
      if (!cb) return result;
      result.then((v) => cb(v), (e) => { console.error('[shapeshell]', e); cb(undefined); });
      return undefined;
    };
    // A call into the main process, which owns the window and tab model.
    //
    // A worker's first calls can land in the gap before the main process has attached its
    // IPC handler to this (possibly just-restarted) worker, so a missing handler is retried
    // briefly rather than failed outright. Anything else is a real error and propagates.
    const invoke = async (method, args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await host.invoke(extId, method, args);
        } catch (e) {
          if (attempt >= 4 || !String(e?.message || e).includes('No handler registered')) throw e;
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    };
    const call = (method) => api((...args) => invoke(method, args));

    const added = [];
    const define = (obj, key, value) => {
      if (key in obj) return;
      Object.defineProperty(obj, key, { value, configurable: true, enumerable: true, writable: true });
      added.push(key);
    };
    const replaced = [];
    const replace = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { value, configurable: true, enumerable: true, writable: true });
        replaced.push(key);
      } catch (e) {
        console.error(`[shapeshell] could not replace chrome.${key}`, e);
      }
    };

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
      // path may be a single string or a size map (Bitwarden sends {19: ..., 38: ...}).
      // imageData is the other form Chrome accepts and we do not support yet, so it is
      // reported rather than silently dropped.
      forward('setIcon', (d) => {
        if (!d.path && d.imageData) return { iconUnsupported: 'imageData' };
        const icon = typeof d.path === 'string' ? d.path : Object.values(d.path || {}).pop();
        return { icon };
      });
      forward('enable', () => ({ enabled: true }));
      forward('disable', () => ({ enabled: false }));

      // Electron defines action.onClicked but never fires it, so replace it outright: the
      // tray is what clicks the action, and only in the background context.
      if (isWorker) {
        const clicked = event();
        const listeners = [];
        replace(action, 'onClicked', {
          addListener: (fn) => { listeners.push(fn); clicked.addListener(fn); },
          removeListener: (fn) => clicked.removeListener(fn),
          hasListener: (fn) => clicked.hasListener(fn),
          hasListeners: () => clicked.hasListeners(),
        });
        host.onClicked(async (clickedId) => {
          if (clickedId !== extId) return;
          // Chrome passes the active tab; ours comes from the main process.
          let tab;
          try { tab = (await host.invoke(extId, 'tabs.query', [{ active: true, currentWindow: true }]))?.[0]; } catch { /* no window */ }
          for (const fn of listeners) {
            try { fn(tab); } catch (e) { console.error('[shapeshell] action.onClicked listener failed', e); }
          }
        });
      }
    }

    // ---- chrome.tabs: the parts Electron gets wrong for one tab per window -------------
    if (chrome.tabs) {
      replace(chrome.tabs, 'query', call('tabs.query'));
      replace(chrome.tabs, 'get', call('tabs.get'));
      replace(chrome.tabs, 'update', call('tabs.update'));
      define(chrome.tabs, 'getCurrent', call('tabs.getCurrent'));
      define(chrome.tabs, 'create', call('tabs.create'));
      // Electron defines these events but never fires them, so ours replace them outright.
      for (const name of ['onUpdated', 'onActivated', 'onCreated', 'onRemoved', 'onReplaced']) {
        replace(chrome.tabs, name, event(`tabs.${name}`));
      }
      define(chrome.tabs, 'TAB_ID_NONE', -1);
      define(chrome.tabs, 'TAB_INDEX_NONE', -1);
    }

    // Chromium's own getContexts hits a NOTREACHED on our popup views ("Unexpected view
    // type found: 0"), so this never calls into it.
    if (chrome.runtime) replace(chrome.runtime, 'getContexts', call('runtime.getContexts'));

    // ---- chrome.storage change notifications -------------------------------------------
    // Measured: Electron never fires storage.onChanged, in any context. Extensions use it to
    // learn that another context changed shared state — Bitwarden's background finds out the
    // vault was unlocked this way, and without it the toolbar icon stays locked forever and
    // its account state times out.
    //
    // So every write is wrapped: read the old values, perform the write, then tell the main
    // process, which broadcasts to all of this extension's contexts (including this one,
    // as Chrome does).
    //
    // Limitation: content scripts get no preload, so writes made there notify nobody.
    if (chrome.storage) {
      replace(chrome.storage, 'onChanged', event('storage.onChanged'));
      for (const areaName of ['local', 'session', 'sync', 'managed']) {
        const area = chrome.storage[areaName];
        if (!area) continue;
        replace(area, 'onChanged', event(`storage.${areaName}.onChanged`));

        for (const method of ['set', 'remove', 'clear']) {
          const original = typeof area[method] === 'function' ? area[method].bind(area) : null;
          if (!original) continue;
          area[method] = function (arg, callback) {
            const hasCallback = typeof callback === 'function' || (method === 'clear' && typeof arg === 'function');
            const cb = typeof callback === 'function' ? callback : (method === 'clear' && typeof arg === 'function' ? arg : null);
            const payload = method === 'clear' && typeof arg === 'function' ? undefined : arg;

            const keys = method === 'set' ? Object.keys(payload || {})
              : method === 'remove' ? (Array.isArray(payload) ? payload : [payload])
                : null;

            const run = (async () => {
              let before = {};
              try { before = await area.get(keys); } catch { /* best effort */ }
              await original(...(method === 'clear' ? [] : [payload]));

              const changes = {};
              if (method === 'clear') {
                for (const [k, v] of Object.entries(before || {})) changes[k] = { oldValue: v };
              } else if (method === 'remove') {
                for (const k of keys) if (before && k in before) changes[k] = { oldValue: before[k] };
              } else {
                for (const k of keys) {
                  changes[k] = before && k in before
                    ? { oldValue: before[k], newValue: payload[k] }
                    : { newValue: payload[k] };
                }
              }
              if (Object.keys(changes).length) {
                try { host.storageChanged(extId, areaName, changes); } catch { /* shutting down */ }
              }
            })();

            if (!cb) return run;
            run.then(() => cb(), (e) => { console.error('[shapeshell] storage write failed', e); cb(); });
            return undefined;
          };
        }
      }
    }

    // ---- namespaces Electron does not implement ----------------------------------------
    define(chrome, 'windows', {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      onCreated: event('windows.onCreated'),
      onRemoved: event('windows.onRemoved'),
      onFocusChanged: event('windows.onFocusChanged'),
      onBoundsChanged: event('windows.onBoundsChanged'),
      get: call('windows.get'),
      getCurrent: call('windows.getCurrent'),
      getLastFocused: call('windows.getLastFocused'),
      getAll: call('windows.getAll'),
      create: call('windows.create'),
      update: call('windows.update'),
      remove: call('windows.remove'),
    });

    define(chrome, 'webNavigation', {
      onBeforeNavigate: event('webNavigation.onBeforeNavigate'),
      onCommitted: event('webNavigation.onCommitted'),
      onDOMContentLoaded: event('webNavigation.onDOMContentLoaded'),
      onCompleted: event('webNavigation.onCompleted'),
      onErrorOccurred: event('webNavigation.onErrorOccurred'),
      onCreatedNavigationTarget: event('webNavigation.onCreatedNavigationTarget'),
      onHistoryStateUpdated: event('webNavigation.onHistoryStateUpdated'),
      onReferenceFragmentUpdated: event('webNavigation.onReferenceFragmentUpdated'),
      onTabReplaced: event('webNavigation.onTabReplaced'),
      getFrame: call('webNavigation.getFrame'),
      getAllFrames: call('webNavigation.getAllFrames'),
    });

    // ---- inert: nothing in ShapeShell provides these -----------------------------------
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

    try {
      const unique = (list) => [...new Set(list)].join(', ') || 'nothing';
      host.ready(extId, `${isWorker ? 'worker' : location.pathname}: added ${unique(added)}; replaced ${unique(replaced)}`);
    } catch { /* ignore */ }
  },
});
