// The popup asks the same questions the worker did. Its answers should differ in one way:
// the popup itself shows up in runtime.getContexts.
(async () => {
  const out = { popup: {} };
  const attempt = async (name, fn) => {
    try { out.popup[name] = await fn(); } catch (e) { out.popup[name] = `THREW: ${e.message}`; }
  };
  await attempt('activeCurrentWindow', () => chrome.tabs.query({ active: true, currentWindow: true }));
  await attempt('windowsGetCurrent', () => chrome.windows.getCurrent({ populate: true }));
  await attempt('contexts', () => chrome.runtime.getContexts({}));
  await attempt('getCurrentTab', () => chrome.tabs.getCurrent());

  // Can the popup and the worker see each other's chrome.storage.session?
  await attempt('sessionWrite', async () => {
    await chrome.storage.session.set({ fromPopup: 'popup-wrote-this' });
    return 'wrote';
  });
  await attempt('sessionReadInPopup', () => chrome.storage.session.get(['fromWorker', 'fromPopup']));
  await attempt('sessionReadInWorker', () => chrome.runtime.sendMessage('read-session'));

  // Write from this context, then ask the worker whether it was notified.
  await attempt('storageNotify', async () => {
    await chrome.storage.local.set({ popupPing: Date.now() });
    await chrome.storage.session.set({ popupSessionPing: Date.now() });
    await new Promise(r => setTimeout(r, 800));
    return chrome.runtime.sendMessage('read-storage-events');
  });

  // Ask the worker to probe again now: its startup run happened while the page was still
  // loading, so it saw no iframe and a url of "".
  try { await chrome.runtime.sendMessage('probe-again'); } catch (e) { out.probeAgain = `failed: ${e.message}`; }
  const stored = await chrome.storage.local.get(['worker', 'navEvents', 'tabEvents']);
  document.getElementById('out').textContent = JSON.stringify({ ...out, ...stored });
})();
