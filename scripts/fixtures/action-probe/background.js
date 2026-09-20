// No default_popup, so a tray click must arrive as chrome.action.onClicked.
chrome.action.setBadgeText({ text: '7' });
chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
chrome.action.setTitle({ title: 'Action probe: ready' });

chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: 'OK' });
  chrome.action.setTitle({ title: 'Action probe: clicked' });
  // The shape Bitwarden uses when the vault locks or unlocks: a per-size path map with a
  // tabId. The tray must follow it.
  chrome.action.setIcon({ path: { 16: 'icon-b.png', 32: 'icon-b.png' }, tabId: undefined });
});
