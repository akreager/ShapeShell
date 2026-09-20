'use strict';

// Main-process implementations of the extension APIs Electron does not provide
// (extensions phase 2). src/extensions/preload.js installs thin wrappers in each extension
// context that call straight through to here.
//
// The model: ShapeShell has no tabs, so each window is a window with exactly one tab — its
// Onshape content view. Tab ids are that view's webContents id; window ids are the
// BaseWindow's id. Both are stable for the life of the window.

const { BrowserWindow, shell } = require('electron');

const WINDOW_ID_CURRENT = -2;
const WINDOW_ID_NONE = -1;

// Registered by main.js as windows come and go. Insertion order is window order.
const windows = new Set();
// Extension pages we opened on an extension's behalf (chrome.windows.create), by window id.
const extensionWindows = new Map();

function registerWindow(shellRef) {
  windows.add(shellRef);
}

function unregisterWindow(shellRef) {
  windows.delete(shellRef);
}

function liveWindows() {
  return [...windows].filter(s => !s.win.isDestroyed() && !s.contentView.webContents.isDestroyed());
}

function focusedWindow() {
  return liveWindows().find(s => s.win.isFocused()) || liveWindows()[0] || null;
}

// Which window is "current" for the caller: the one hosting the popup that called, else the
// focused one. A service worker has no window of its own, so it gets the focused one.
function callerWindow(senderId) {
  if (typeof senderId === 'number') {
    const owner = liveWindows().find(s => s.extPopup?.view?.webContents.id === senderId);
    if (owner) return owner;
  }
  return focusedWindow();
}

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

function tabOf(shellRef) {
  const wc = shellRef.contentView.webContents;
  const bounds = shellRef.contentView.getBounds();
  return {
    id: wc.id,
    index: 0,
    windowId: shellRef.win.id,
    // Every ShapeShell window holds exactly one tab, so it is always the active one.
    active: true,
    highlighted: true,
    selected: true,
    pinned: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    incognito: false,
    url: wc.getURL(),
    pendingUrl: undefined,
    title: wc.getTitle(),
    favIconUrl: undefined,
    status: wc.isLoading() ? 'loading' : 'complete',
    audible: wc.isCurrentlyAudible(),
    mutedInfo: { muted: wc.isAudioMuted() },
    width: bounds.width,
    height: bounds.height,
    groupId: -1,
  };
}

function windowOf(shellRef, populate) {
  const bounds = shellRef.win.getBounds();
  return {
    id: shellRef.win.id,
    focused: shellRef.win.isFocused(),
    incognito: false,
    alwaysOnTop: shellRef.win.isAlwaysOnTop(),
    type: 'normal',
    state: shellRef.win.isMinimized() ? 'minimized'
      : shellRef.win.isFullScreen() ? 'fullscreen'
        : shellRef.win.isMaximized() ? 'maximized' : 'normal',
    ...bounds,
    ...(populate ? { tabs: [tabOf(shellRef)] } : {}),
  };
}

// Chrome match patterns, enough for the filters extensions actually pass.
function matches(pattern, value) {
  if (!value) return false;
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

// ---------------------------------------------------------------------------------------
// chrome.tabs
// ---------------------------------------------------------------------------------------

function tabsQuery(senderId, filter = {}) {
  const current = callerWindow(senderId);
  let list = liveWindows();

  if (filter.currentWindow === true || filter.windowId === WINDOW_ID_CURRENT) {
    list = current ? [current] : [];
  } else if (filter.currentWindow === false) {
    list = list.filter(s => s !== current);
  }
  if (typeof filter.windowId === 'number' && filter.windowId >= 0) {
    list = list.filter(s => s.win.id === filter.windowId);
  }
  if (filter.lastFocusedWindow === true) {
    const focused = focusedWindow();
    list = focused ? [focused] : [];
  }
  if (filter.active === false) list = [];
  if (filter.windowType && filter.windowType !== 'normal') list = [];

  let tabs = list.map(tabOf);
  if (filter.url) {
    const patterns = Array.isArray(filter.url) ? filter.url : [filter.url];
    tabs = tabs.filter(t => patterns.some(p => matches(p, t.url)));
  }
  if (filter.title) tabs = tabs.filter(t => matches(filter.title, t.title));
  if (typeof filter.status === 'string') tabs = tabs.filter(t => t.status === filter.status);
  if (typeof filter.audible === 'boolean') tabs = tabs.filter(t => t.audible === filter.audible);
  if (typeof filter.muted === 'boolean') tabs = tabs.filter(t => t.mutedInfo.muted === filter.muted);
  return tabs;
}

function tabsGet(tabId) {
  const found = liveWindows().find(s => s.contentView.webContents.id === tabId);
  if (!found) throw new Error(`No tab with id: ${tabId}.`);
  return tabOf(found);
}

function tabsGetCurrent(senderId) {
  // A popup is not a tab, which is exactly what Chrome reports here.
  return undefined;
}

// Extensions open their own web pages (Bitwarden's web vault and help links). ShapeShell is
// an Onshape window, so those belong in the user's browser.
function tabsCreate(senderId, props = {}) {
  const url = String(props.url || '');
  if (/^https?:/i.test(url)) {
    shell.openExternal(url);
    return { ...(liveWindows()[0] ? tabOf(liveWindows()[0]) : {}), id: -1, url, openedExternally: true };
  }
  return { id: -1, url, openedExternally: false };
}

function tabsUpdate(senderId, tabId, props = {}) {
  const target = typeof tabId === 'number'
    ? liveWindows().find(s => s.contentView.webContents.id === tabId)
    : callerWindow(senderId);
  if (!target) throw new Error(`No tab with id: ${tabId}.`);
  const wc = target.contentView.webContents;
  if (typeof props.url === 'string' && /^https?:/i.test(props.url)) {
    // Navigating the Onshape view away on an extension's say-so is not something we do.
    shell.openExternal(props.url);
  }
  if (typeof props.muted === 'boolean') wc.setAudioMuted(props.muted);
  if (props.active === true) target.win.focus();
  return tabOf(target);
}

// ---------------------------------------------------------------------------------------
// chrome.windows
// ---------------------------------------------------------------------------------------

function windowsGetCurrent(senderId, getInfo = {}) {
  const current = callerWindow(senderId);
  if (!current) throw new Error('No current window.');
  return windowOf(current, getInfo.populate);
}

function windowsGet(windowId, getInfo = {}) {
  const found = liveWindows().find(s => s.win.id === windowId);
  if (!found) throw new Error(`No window with id: ${windowId}.`);
  return windowOf(found, getInfo.populate);
}

function windowsGetAll(getInfo = {}) {
  return liveWindows().map(s => windowOf(s, getInfo.populate));
}

function windowsGetLastFocused(getInfo = {}) {
  const focused = focusedWindow();
  if (!focused) throw new Error('No window.');
  return windowOf(focused, getInfo.populate);
}

// An extension asking for its own page in a window — Bitwarden's popped-out vault. Its own
// pages get a real window; anything on the web goes to the browser.
function windowsCreate(extSession, preloadPath, props = {}) {
  const url = String(props.url || '');
  if (/^https?:/i.test(url)) {
    shell.openExternal(url);
    return { id: WINDOW_ID_NONE, focused: false, incognito: false, type: 'popup', tabs: [] };
  }
  if (!url.startsWith('chrome-extension://')) throw new Error('Unsupported window url.');

  const win = new BrowserWindow({
    width: Math.min(Math.max(Number(props.width) || 380, 320), 1200),
    height: Math.min(Math.max(Number(props.height) || 620, 320), 1200),
    title: 'Extension',
    backgroundColor: '#ffffff',
    webPreferences: {
      session: extSession,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  extensionWindows.set(win.id, win);
  win.on('closed', () => extensionWindows.delete(win.id));
  win.loadURL(url);
  return {
    id: win.id,
    focused: true,
    incognito: false,
    type: 'popup',
    ...win.getBounds(),
    tabs: [],
  };
}

function windowsUpdate(windowId, props = {}) {
  const found = liveWindows().find(s => s.win.id === windowId);
  const win = found ? found.win : extensionWindows.get(windowId);
  if (!win) throw new Error(`No window with id: ${windowId}.`);
  if (props.focused === true) win.focus();
  if (props.state === 'minimized') win.minimize();
  if (props.state === 'maximized') win.maximize();
  if (props.state === 'normal') win.restore();
  if (['left', 'top', 'width', 'height'].some(k => typeof props[k] === 'number')) {
    const b = win.getBounds();
    win.setBounds({
      x: props.left ?? b.x,
      y: props.top ?? b.y,
      width: props.width ?? b.width,
      height: props.height ?? b.height,
    });
  }
  return found ? windowOf(found, false) : { id: windowId, focused: win.isFocused(), type: 'popup' };
}

function windowsRemove(windowId) {
  // Only windows opened for an extension: an extension may not close the Onshape window.
  const win = extensionWindows.get(windowId);
  if (win && !win.isDestroyed()) win.close();
}

// ---------------------------------------------------------------------------------------
// chrome.runtime.getContexts
// ---------------------------------------------------------------------------------------

// Chromium's own implementation hits a NOTREACHED on our popup views ("Unexpected view type
// found: 0"), because a WebContentsView is not one of its known extension view types. This
// replaces it rather than letting extensions call into that path.
function getContexts(extId, extensionUrl, filter = {}) {
  const contexts = [];
  const add = (c) => {
    const types = filter.contextTypes;
    if (Array.isArray(types) && !types.includes(c.contextType)) return;
    if (Array.isArray(filter.documentUrls) && !filter.documentUrls.includes(c.documentUrl)) return;
    if (Array.isArray(filter.windowIds) && !filter.windowIds.includes(c.windowId)) return;
    if (Array.isArray(filter.tabIds) && !filter.tabIds.includes(c.tabId)) return;
    if (typeof filter.incognito === 'boolean' && filter.incognito !== c.incognito) return;
    contexts.push(c);
  };

  add({
    contextId: `${extId}-background`,
    contextType: 'BACKGROUND',
    documentId: undefined,
    documentOrigin: undefined,
    documentUrl: undefined,
    frameId: -1,
    incognito: false,
    tabId: -1,
    windowId: WINDOW_ID_NONE,
  });

  for (const shellRef of liveWindows()) {
    const view = shellRef.extPopup?.view;
    if (!view || shellRef.extPopup.extId !== extId || view.webContents.isDestroyed()) continue;
    add({
      contextId: `${extId}-popup-${view.webContents.id}`,
      contextType: 'POPUP',
      documentId: undefined,
      documentOrigin: extensionUrl,
      documentUrl: view.webContents.getURL(),
      frameId: 0,
      incognito: false,
      tabId: -1,
      windowId: shellRef.win.id,
    });
  }

  for (const [winId, win] of extensionWindows) {
    if (win.isDestroyed()) continue;
    const url = win.webContents.getURL();
    if (!url.startsWith(extensionUrl)) continue;
    add({
      contextId: `${extId}-window-${winId}`,
      contextType: 'TAB',
      documentId: undefined,
      documentOrigin: extensionUrl,
      documentUrl: url,
      frameId: 0,
      incognito: false,
      tabId: win.webContents.id,
      windowId: winId,
    });
  }

  return contexts;
}

// ---------------------------------------------------------------------------------------
// chrome.webNavigation
// ---------------------------------------------------------------------------------------

// Chrome's frameId is the frame tree node id, with 0 meaning the main frame.
function frameIdOf(frame, mainFrame) {
  return frame === mainFrame || frame.frameTreeNodeId === mainFrame.frameTreeNodeId
    ? 0
    : frame.frameTreeNodeId;
}

function framesOf(shellRef) {
  const wc = shellRef.contentView.webContents;
  const main = wc.mainFrame;
  const all = [main, ...main.framesInSubtree.filter(f => f !== main)];
  return all.map(frame => ({
    frameId: frameIdOf(frame, main),
    parentFrameId: frame.parent ? frameIdOf(frame.parent, main) : -1,
    url: frame.url,
    documentId: undefined,
    documentLifecycle: 'active',
    frameType: frame.parent ? 'sub_frame' : 'outermost_frame',
    errorOccurred: false,
    processId: frame.processId,
  }));
}

function webNavigationGetAllFrames(details = {}) {
  const target = liveWindows().find(s => s.contentView.webContents.id === details.tabId);
  if (!target) return null;
  return framesOf(target);
}

function webNavigationGetFrame(details = {}) {
  const frames = webNavigationGetAllFrames(details);
  if (!frames) return null;
  return frames.find(f => f.frameId === (details.frameId ?? 0)) || null;
}

module.exports = {
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  registerWindow,
  unregisterWindow,
  liveWindows,
  focusedWindow,
  callerWindow,
  tabOf,
  framesOf,
  frameIdOf,
  handlers: {
    'tabs.query': (ctx, filter) => tabsQuery(ctx.senderId, filter),
    'tabs.get': (ctx, tabId) => tabsGet(tabId),
    'tabs.getCurrent': (ctx) => tabsGetCurrent(ctx.senderId),
    'tabs.create': (ctx, props) => tabsCreate(ctx.senderId, props),
    'tabs.update': (ctx, tabId, props) => tabsUpdate(ctx.senderId, tabId, props),
    'windows.getCurrent': (ctx, getInfo) => windowsGetCurrent(ctx.senderId, getInfo),
    'windows.get': (ctx, windowId, getInfo) => windowsGet(windowId, getInfo),
    'windows.getAll': (ctx, getInfo) => windowsGetAll(getInfo),
    'windows.getLastFocused': (ctx, getInfo) => windowsGetLastFocused(getInfo),
    'windows.create': (ctx, props) => windowsCreate(ctx.session, ctx.preloadPath, props),
    'windows.update': (ctx, windowId, props) => windowsUpdate(windowId, props),
    'windows.remove': (ctx, windowId) => windowsRemove(windowId),
    'runtime.getContexts': (ctx, filter) => getContexts(ctx.extId, ctx.extensionUrl, filter),
    'webNavigation.getAllFrames': (ctx, details) => webNavigationGetAllFrames(details),
    'webNavigation.getFrame': (ctx, details) => webNavigationGetFrame(details),
  },
};
