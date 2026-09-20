// Runs the same battery of calls a real extension makes when it asks "what is the user
// looking at?", and records the answers for the popup to display.
const navEvents = [];
for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onErrorOccurred']) {
  chrome.webNavigation[name].addListener((details) => {
    navEvents.push({ event: name, frameId: details.frameId, url: details.url });
    chrome.storage.local.set({ navEvents });
  });
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
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg === 'probe-again') { probe().then(() => respond('done')); return true; }
  return undefined;
});
