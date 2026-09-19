'use strict';

// SPIKE (survey preload mode): prove that missing chrome.* namespaces can be supplied from
// a preload, without touching the extension's files, so an allowlist hash pin can cover
// the pristine tree. Registered for extension service workers via
// ses.registerPreloadScript({ type: 'service-worker' }) and set as the webPreferences
// preload of extension popup windows. Everything here is an inert placeholder; real
// behaviour (webNavigation from main-process frame events, and so on) is phase 2.

const { contextBridge } = require('electron');

// Service-worker preloads run for EVERY service worker in the session, including any a
// web origin registers, so the function bails unless it is in an extension. The check has
// to happen in the main world: a service-worker preload runs in a separate preload realm
// that has no `location` at all.
contextBridge.executeInMainWorld({
  func: () => {
    if (globalThis.location?.protocol !== 'chrome-extension:') return;
    const TAG = '__EXT_SURVEY__';
    const chrome = globalThis.chrome;
    const ctx = typeof ServiceWorkerGlobalScope !== 'undefined' ? 'worker' : `page:${location.pathname}`;
    const say = (rec) => console.info(TAG + JSON.stringify({ ext: chrome?.runtime?.id, ctx, type: 'polyfill', ...rec }));
    if (!chrome) return say({ detail: 'no chrome in main world' });

    const manifest = chrome.runtime.getManifest();
    const event = () => {
      const listeners = new Set();
      return {
        addListener: (fn) => { listeners.add(fn); },
        removeListener: (fn) => { listeners.delete(fn); },
        hasListener: (fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0,
      };
    };
    // Chrome APIs return a promise, or call a trailing callback asynchronously.
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
      create: (props, cb) => { if (cb) setTimeout(cb, 0); return props?.id ?? ++menuId; },
      update: api(() => undefined),
      remove: api(() => undefined),
      removeAll: api(() => undefined),
    });
    define(chrome, 'commands', {
      onCommand: event(),
      getAll: api(() => Object.entries(manifest.commands || {}).map(([name, c]) => ({ name, description: c.description || '', shortcut: '' }))),
    });
    const granted = new Set([...(manifest.permissions || []), ...(manifest.host_permissions || [])]);
    define(chrome, 'permissions', {
      onAdded: event(),
      onRemoved: event(),
      contains: api((p = {}) => [...(p.permissions || []), ...(p.origins || [])].every((x) => granted.has(x))),
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
      create: api((id, opts) => (typeof id === 'string' ? id : `n${++noteId}`)),
      clear: api(() => true), getAll: api(() => ({})), update: api(() => false),
    });
    if (chrome.tabs) define(chrome.tabs, 'getCurrent', api(() => undefined));

    // Survey question: does Electron's own webRequest reject Bitwarden's extraInfoSpec
    // even without the survey shim in the way?
    try {
      const probe = () => {};
      chrome.webRequest.onHeadersReceived.addListener(probe, { urls: ['<all_urls>'] }, ['responseHeaders']);
      chrome.webRequest.onHeadersReceived.removeListener(probe);
      say({ detail: 'webRequest.onHeadersReceived with ["responseHeaders"]: accepted' });
    } catch (e) {
      say({ detail: `webRequest.onHeadersReceived with ["responseHeaders"]: ${e.message}` });
    }
    say({ detail: `installed: ${added.join(', ')}` });
  },
});
