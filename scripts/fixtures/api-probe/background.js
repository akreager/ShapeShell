// Runs the same battery of calls a real extension makes when it asks "what is the user
// looking at?", and records the answers for the popup to display.
const navEvents = [];
for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onErrorOccurred']) {
  chrome.webNavigation[name].addListener((details) => {
    navEvents.push({ event: name, frameId: details.frameId, url: details.url });
    chrome.storage.local.set({ navEvents });
  });
}

// Does Electron fire the tab events extensions rely on to re-evaluate the current page?
// Bitwarden refreshes its icon and autofill state from these.
const tabEvents = [];
const recordTab = (name) => (...args) => {
  tabEvents.push({ event: name, arg: JSON.stringify(args[0] ?? null).slice(0, 80) });
  chrome.storage.local.set({ tabEvents });
};
for (const name of ['onUpdated', 'onActivated', 'onRemoved', 'onCreated', 'onReplaced']) {
  try { chrome.tabs[name].addListener(recordTab(name)); } catch (e) { tabEvents.push({ event: name, arg: `THREW: ${e.message}` }); }
}

async function probe() {
  const out = {};
  const attempt = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { out[name] = `THREW: ${e.message}`; }
  };

  await attempt('activeCurrentWindow', () => chrome.tabs.query({ active: true, currentWindow: true }));
  await attempt('activeWindowIdCurrent', () => chrome.tabs.query({ active: true, windowId: chrome.windows.WINDOW_ID_CURRENT }));
  await attempt('allTabs', () => chrome.tabs.query({}));
  await attempt('windowsGetCurrent', () => chrome.windows.getCurrent({ populate: true }));
  await attempt('windowsGetAll', () => chrome.windows.getAll({ populate: true }));
  await attempt('contexts', () => chrome.runtime.getContexts({}));

  const tabs = Array.isArray(out.activeCurrentWindow) ? out.activeCurrentWindow : [];
  if (tabs[0]) {
    await attempt('allFrames', () => chrome.webNavigation.getAllFrames({ tabId: tabs[0].id }));
    await attempt('mainFrame', () => chrome.webNavigation.getFrame({ tabId: tabs[0].id, frameId: 0 }));
    await attempt('tabsGet', () => chrome.tabs.get(tabs[0].id));

    // Autofill's actual mechanism: run a script inside a named frame of the page. The
    // subframe result is the one that matters — filling a login form in an iframe.
    const frames = Array.isArray(out.allFrames) ? out.allFrames : [];
    const child = frames.find(f => f.frameId !== 0);
    await attempt('injectMainFrame', () => chrome.scripting.executeScript({
      target: { tabId: tabs[0].id, frameIds: [0] },
      func: () => ({ title: document.title, url: location.pathname }),
    }));
    if (child) {
      await attempt('injectSubFrame', () => chrome.scripting.executeScript({
        target: { tabId: tabs[0].id, frameIds: [child.frameId] },
        func: () => ({ title: document.title, url: location.pathname }),
      }));
    }
  }
  await chrome.storage.local.set({ worker: out });
}

probe();
// chrome.storage.session is in-memory state shared by all of an extension's contexts. A
// password manager keeps its unlocked-vault key there, so if the worker cannot see what the
// popup wrote, the background believes the vault is still locked.
chrome.storage.session.set({ fromWorker: 'worker-wrote-this' });

// Does a write in another context notify this one? Bitwarden's background learns that the
// vault was unlocked through exactly this, so if it never fires the icon stays locked.
const storageEvents = [];
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    storageEvents.push({ via: 'storage.onChanged', area, keys: Object.keys(changes || {}) });
  });
} catch (e) { storageEvents.push({ via: 'storage.onChanged', error: e.message }); }
try {
  chrome.storage.local.onChanged.addListener((changes) => {
    storageEvents.push({ via: 'storage.local.onChanged', area: 'local', keys: Object.keys(changes || {}) });
  });
} catch (e) { storageEvents.push({ via: 'storage.local.onChanged', error: e.message }); }
try {
  chrome.storage.session.onChanged.addListener((changes) => {
    storageEvents.push({ via: 'storage.session.onChanged', area: 'session', keys: Object.keys(changes || {}) });
  });
} catch (e) { storageEvents.push({ via: 'storage.session.onChanged', error: e.message }); }

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg === 'probe-again') { probe().then(() => respond('done')); return true; }
  if (msg === 'read-storage-events') { respond(storageEvents); return true; }
  if (msg === 'read-session') {
    chrome.storage.session.get(['fromWorker', 'fromPopup'])
      .then(v => respond(v))
      .catch(e => respond(`THREW: ${e.message}`));
    return true;
  }
  return undefined;
});
