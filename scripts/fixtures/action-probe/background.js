// No default_popup, so a tray click must arrive as chrome.action.onClicked.
chrome.action.setBadgeText({ text: '7' });
chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
chrome.action.setTitle({ title: 'Action probe: ready' });

// Differs per worker instance, so the smoke test can tell a click delivered to a restarted
// worker from the title an earlier click left behind.
const instance = Math.random().toString(36).slice(2, 6);

chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: 'OK' });
  chrome.action.setTitle({ title: `Action probe: clicked (${instance})` });
  // The shape Bitwarden uses when the vault locks or unlocks: a per-size path map with a
  // tabId. The tray must follow it.
  chrome.action.setIcon({ path: { 16: 'icon-b.png', 32: 'icon-b.png' }, tabId: undefined });
});
