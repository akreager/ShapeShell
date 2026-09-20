'use strict';

// Extension tray and popup smoke test (extensions phase 1). Builds a real ShapeShell
// window from src/main.js, loads the given unpacked extensions, clicks each tray icon, and
// screenshots the toolbar and each popup into dist/smoke-extensions/.
//
//   npm run smoke-extensions                       # the action-probe fixture alone
//   npm run smoke-extensions -- <unpacked-dir>...  # real extensions instead
//
// It uses its own userData directory, so it never touches a real Onshape profile, and it
// loads about:blank rather than cad.onshape.com: this tests our chrome, not the site.

const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'dist', 'smoke-extensions');
const FIXTURE = path.join(__dirname, 'fixtures', 'action-probe');
const dirs = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (dirs.length === 0) dirs.push(FIXTURE);

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

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  await extensions.init(ses);
  registerIpc();

  step('building the window');
  const shell = createShellWindow({ url: 'about:blank' });
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
    const beforeClick = await limit(shell.chromeView.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('Action probe'));
        return b ? { title: b.title, badge: b.querySelector('.badge')?.textContent || '' } : null; })()`), 5000, 'timed out');
    results.push({ check: 'badge and title set from the background worker', value: beforeClick });

    step('clicking the popup-less action (expects chrome.action.onClicked)');
    await limit(shell.chromeView.webContents.executeJavaScript(`
      [...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('Action probe')).click()`), 5000, 'timed out');
    await sleep(2000);
    const afterClick = await limit(shell.chromeView.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('#tray button')].find(b => b.title.startsWith('Action probe'));
        return b ? { title: b.title, badge: b.querySelector('.badge')?.textContent || '' } : null; })()`), 5000, 'timed out');
    results.push({ check: 'onClicked reached the worker (badge should read OK)', value: afterClick });
    results.push({ check: 'tray screenshot after the click', value: await shot(shell.chromeView, 'toolbar-after-click') });
    results.push({ check: 'no popup opened for a popup-less action', value: !shell.extPopup.isOpen });
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
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  app.quit();
  // Last resort, so a wedged renderer cannot hang a test run.
  setTimeout(() => app.exit(process.exitCode || 0), 5000).unref();
});
