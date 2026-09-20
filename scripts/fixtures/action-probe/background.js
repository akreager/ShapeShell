// No default_popup, so a tray click must arrive as chrome.action.onClicked.
chrome.action.setBadgeText({ text: '7' });
chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
chrome.action.setTitle({ title: 'Action probe: ready' });

chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: 'OK' });
  chrome.action.setTitle({ title: 'Action probe: clicked' });
});
