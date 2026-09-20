'use strict';

// Extension tray and popup smoke test (extensions phase 1). Builds a real ShapeShell
// window from src/main.js, loads the given unpacked extensions, clicks each tray icon, and
// screenshots the toolbar and each popup into dist/smoke-extensions/.
//
//   npm run smoke-extensions                       # the action-probe fixture alone
//   npm run smoke-extensions -- <unpacked-dir>...  # real extensions instead
//
// It uses its own userData directory, so it never touches a real Onshape profile, and it
// loads a local page rather than cad.onshape.com: this tests our chrome, not the site. That
// page carries one iframe, so frame enumeration has something real to report.

const { app, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'dist', 'smoke-extensions');
const FIXTURE = path.join(__dirname, 'fixtures', 'action-probe');
const API_FIXTURE = path.join(__dirname, 'fixtures', 'api-probe');
const PAGES = path.join(__dirname, 'fixtures', 'pages');
const dirs = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (dirs.length === 0) dirs.push(FIXTURE, API_FIXTURE);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(OUT, 'profile'));
process.env.SHAPESHELL_DEV_EXTENSIONS = dirs.join(path.delimiter);
// Stops src/main.js starting the app itself; this file builds the window instead.
process.env.SHAPESHELL_TEST_HARNESS = '1';

const { createShellWindow, registerIpc, PARTITION } = require('../src/main');
const extensions = require('../src/extensions/manager');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const step = (msg) => console.log(`[smoke] ${msg}`);
// Nothing here may hang the run: a popup page that never settles is itself a result.
const limit = (promise, ms, fallback) => Promise.race([
  Promise.resolve(promise).catch(e => `failed: ${e.message}`),
  sleep(ms).then(() => fallback),
]);

async function shot(view, name) {
  const image = await limit(view.webContents.capturePage(), 8000, null);
  if (!image || typeof image === 'string') return `capture failed: ${image || 'timed out'}`;
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return path.basename(file);
}

app.on('window-all-closed', () => {});

// Served over http, not file://, so host permissions and script injection behave as they do
// on a real site.
function servePages() {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://127.0.0.1').pathname) || 'host.html';
    const file = path.join(PAGES, name);
    if (!file.startsWith(PAGES) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  await extensions.init(ses);
  registerIpc();

  step('building the window');
  const server = await servePages();
  const hostPage = `http://127.0.0.1:${server.address().port}/host.html`;
  step(`serving the probe page at ${hostPage}`);
  const shell = createShellWindow({ url: hostPage });
  shell.win.show();
  await sleep(4000);
  step('window up');

  const actions = extensions.listActions();
  results.push({ check: 'extensions with a toolbar action', value: actions.map(a => `${a.name} (icon: ${a.icon ? 'yes' : 'NONE'}, popup: ${a.hasPopup})`) });

  // The tray is drawn by the toolbar page, so read it back from the DOM rather than trusting
  // what we sent it.
  const trayDom = await limit(shell.chromeView.webContents.executeJavaScript(`
    [...document.querySelectorAll('#tray button')].map(b => ({
      title: b.title,
      icon: b.querySelector('img') ? 'img' : b.querySelector('.letter') ? 'letter' : 'none',
      badge: b.querySelector('.badge')?.textContent || '',
    }))`), 8000, 'timed out reading the tray');
  results.push({ check: 'tray buttons in the toolbar DOM', value: trayDom });
  results.push({ check: 'toolbar screenshot', value: await shot(shell.chromeView, 'toolbar') });

  for (const [index, action] of actions.entries()) {
    // Popup-less actions are covered by the action-probe checks below, which need a tray
    // that has not been clicked yet.
    if (!action.hasPopup) continue;
    step(`clicking ${action.name}`);
    await limit(shell.chromeView.webContents.executeJavaScript(
      `document.querySelectorAll('#tray button')[${index}].click()`), 5000, 'click timed out');
    await sleep(3500);
    step(`clicked ${action.name}: popup ${shell.extPopup.isOpen ? 'open' : 'closed'}`);
    const open = shell.extPopup.isOpen;
    const entry = { check: `click ${action.name}`, value: { popupOpened: open } };
    if (open) {
      const wc = shell.extPopup.view.webContents;
      entry.value.url = wc.getURL();
      entry.value.bounds = shell.extPopup.view.getBounds();
      entry.value.text = await limit(wc.executeJavaScript(
        'document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 120) : ""'), 8000, 'reading the popup timed out');
      step('popup text read');
      entry.value.screenshot = await shot(shell.extPopup.view, `popup-${index}`);
      step(`popup screenshot: ${entry.value.screenshot}`);
      // Escape is one of the two ways Chrome dismisses a popup.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await sleep(600);
      entry.value.closedByEscape = !shell.extPopup.isOpen;
      shell.extPopup.close();
    }
    results.push(entry);
  }

  // chrome.action state has to reach the tray: Electron implements the API but draws
  // nothing, so our preload reports each call to the manager.
  const probe = extensions.listActions().find(a => a.name === 'ShapeShell action probe');
  if (probe) {
    // The icon's data URL comes along too: Bitwarden swaps its icon when the vault locks or
    // unlocks, and the tray has to follow.
    const readProbe = `
      (() => { const b = [...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('Action probe'));
        return b ? { title: b.title, badge: b.querySelector('.badge')?.textContent || '',
          icon: (b.querySelector('img')?.src || 'none').slice(-24) } : null; })()`;
    const beforeClick = await limit(shell.chromeView.webContents.executeJavaScript(readProbe), 5000, 'timed out');
    results.push({ check: 'badge and title set from the background worker', value: beforeClick });

    step('clicking the popup-less action (expects chrome.action.onClicked)');
    await limit(shell.chromeView.webContents.executeJavaScript(`
      [...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('Action probe')).click()`), 5000, 'timed out');
    await sleep(2000);
    const afterClick = await limit(shell.chromeView.webContents.executeJavaScript(readProbe), 5000, 'timed out');
    results.push({ check: 'onClicked reached the worker (badge should read OK)', value: afterClick });
    results.push({
      check: 'setIcon({path: {...}}) changed the tray icon',
      value: beforeClick?.icon && afterClick?.icon
        ? (beforeClick.icon !== afterClick.icon ? 'icon changed' : `icon unchanged (${afterClick.icon})`)
        : 'no icon to compare',
    });
    results.push({ check: 'tray screenshot after the click', value: await shot(shell.chromeView, 'toolbar-after-click') });
    results.push({ check: 'no popup opened for a popup-less action', value: !shell.extPopup.isOpen });
  }

  // The window and tab model extensions see: one window, one tab, real frames.
  const apiProbe = extensions.listActions().find(a => a.name === 'ShapeShell API probe');
  if (apiProbe) {
    step('reloading the content view to generate webNavigation events');
    shell.contentView.webContents.reload();
    await sleep(2500);

    // By title, not by index: listActions() builds fresh objects every call, so indexOf on
    // a second call is always -1 and the click lands nowhere.
    await limit(shell.chromeView.webContents.executeJavaScript(
      `[...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('API probe')).click()`), 5000, 'click timed out');
    await sleep(3500);
    step(`api probe popup ${shell.extPopup.isOpen ? 'open' : 'NOT OPEN'}`);
    const raw = shell.extPopup.isOpen
      ? await limit(shell.extPopup.view.webContents.executeJavaScript(
        'document.getElementById("out").textContent'), 8000, 'read timed out')
      : 'popup did not open';
    let probe = {};
    try { probe = JSON.parse(raw); } catch { probe = { parseError: String(raw).slice(0, 200) }; }
    fs.writeFileSync(path.join(OUT, 'api-probe.json'), JSON.stringify(probe, null, 2));

    const worker = probe.worker || {};
    const popup = probe.popup || {};
    const tab = Array.isArray(worker.activeCurrentWindow) ? worker.activeCurrentWindow[0] : null;
    const frames = Array.isArray(worker.allFrames) ? worker.allFrames : [];
    const navEvents = Array.isArray(probe.navEvents) ? probe.navEvents : [];
    const contexts = Array.isArray(popup.contexts) ? popup.contexts : [];

    results.push({ check: 'worker: tabs.query({active, currentWindow}) returns the Onshape tab', value: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status } : worker.activeCurrentWindow });
    results.push({ check: 'worker: windowId:WINDOW_ID_CURRENT agrees', value: tab ? JSON.stringify(worker.activeWindowIdCurrent) === JSON.stringify(worker.activeCurrentWindow) : 'no tab, so nothing to agree about' });
    results.push({ check: 'worker: windows.getCurrent({populate}) holds that one tab', value: worker.windowsGetCurrent?.tabs?.length === 1 && worker.windowsGetCurrent.tabs[0].id === tab?.id ? `window ${worker.windowsGetCurrent.id}` : worker.windowsGetCurrent });
    results.push({ check: 'worker: tabs.get round-trips', value: tab && worker.tabsGet?.id === tab.id ? `tab ${tab.id}` : worker.tabsGet ?? 'no tab to get' });
    results.push({ check: 'worker: webNavigation.getAllFrames sees the page and its iframe', value: frames.map(f => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: String(f.url).split('/').pop() })) });
    results.push({ check: 'worker: webNavigation.getFrame(0) is the main frame', value: worker.mainFrame?.frameId === 0 ? String(worker.mainFrame.url).split('/').pop() : worker.mainFrame });
    results.push({ check: 'worker: webNavigation events fired on reload', value: [...new Set(navEvents.map(e => e.event))] });
    const tabEvents = Array.isArray(probe.tabEvents) ? probe.tabEvents : [];
    results.push({ check: 'worker: chrome.tabs events fired on reload', value: tabEvents.length ? [...new Set(tabEvents.map(e => e.event))] : 'none fired' });
    results.push({ check: 'popup: sees itself in runtime.getContexts', value: contexts.map(c => c.contextType) });
    results.push({ check: 'popup: tabs.getCurrent() is undefined, as a popup is not a tab', value: popup.getCurrentTab === undefined ? 'undefined' : popup.getCurrentTab });
    results.push({ check: 'popup: its window matches the worker\'s', value: popup.windowsGetCurrent?.id ? popup.windowsGetCurrent.id === worker.windowsGetCurrent?.id : 'popup reported no window' });
    // How autofill actually reaches a login form, including one inside an iframe.
    results.push({ check: 'worker: scripting.executeScript into the main frame', value: worker.injectMainFrame });
    results.push({ check: 'worker: scripting.executeScript into the iframe', value: worker.injectSubFrame ?? 'no subframe was found to inject into' });
    shell.extPopup.close();
    await sleep(500);
  }

  const withPopup = actions.find(a => a.hasPopup);
  if (withPopup) {
    const clickIt = () => shell.chromeView.webContents.executeJavaScript(
      `[...document.querySelectorAll('#tray button')][${actions.indexOf(withPopup)}].click()`);

    // The window must survive a resize with the popup open, and the popup must stay inside it.
    step('resize check');
    await clickIt();
    await sleep(2500);
    shell.win.setBounds({ ...shell.win.getBounds(), width: 900, height: 700 });
    await sleep(1200);
    results.push({
      check: 'popup bounds after resizing the window to 900x700',
      value: shell.extPopup.isOpen ? shell.extPopup.view.getBounds() : 'popup closed on resize',
    });

    // A page finishing a load takes focus on its own. The popup must not vanish for that:
    // only a real click elsewhere dismisses it.
    step('popup survives a content-view reload');
    if (!shell.extPopup.isOpen) { await clickIt(); await sleep(2000); }
    shell.contentView.webContents.reload();
    await sleep(3000);
    results.push({ check: 'action popup survives a page load in the content view', value: shell.extPopup.isOpen });
    shell.extPopup.close();
    await sleep(400);

    // The hamburger popover and an action popup must never be on screen together.
    step('menu vs popup check');
    if (!shell.extPopup.isOpen) { await clickIt(); await sleep(2000); }
    await shell.chromeView.webContents.executeJavaScript(`document.getElementById('menu').click()`);
    await sleep(800);
    results.push({ check: 'opening the main menu closes the action popup', value: !shell.extPopup.isOpen });
    await clickIt();
    await sleep(2000);
    results.push({
      check: 'opening an action popup hides the main menu',
      value: { popupOpen: shell.extPopup.isOpen, menuVisible: shell.popoverView.getVisible() },
    });
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  for (const r of results) console.log(`- ${r.check}: ${JSON.stringify(r.value)}`);

  // An open popup view keeps the window alive, and app.quit() then never finishes.
  shell.extPopup.destroy();
  shell.win.destroy();
  server.close();
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  app.quit();
  // Last resort, so a wedged renderer cannot hang a test run.
  setTimeout(() => app.exit(process.exitCode || 0), 5000).unref();
});
