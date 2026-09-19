'use strict';

// Extension API survey (plan phase 0). Loads instrumented copies of unpacked extensions
// into a throwaway profile, exercises them, and reports which chrome.* APIs they use that
// Electron is missing or only partly implements. Run via scripts/ext-survey.sh.
//
//   electron scripts/ext-survey/survey.js <unpacked-extension-dir>...
//
// EXT_SURVEY_MODE=raw (default) runs the extensions as Electron really would, so the first
// missing API may stop a service worker dead. EXT_SURVEY_MODE=stub replaces missing
// namespaces with inert stubs so execution continues and every gap shows up (see shim.js).
// EXT_SURVEY_MODE=preload leaves the extension code pristine apart from the measuring shim
// and supplies the missing namespaces from polyfill-preload.js instead — the spike for
// whether ShapeShell can fill Electron's gaps without modifying extension files.
//
// Never touches the real profile: userData is redirected to dist/ext-survey/profile, which
// is wiped on every run, and the bridge is not started.

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'dist', 'ext-survey');
const WORK = path.join(ROOT, 'work');
const PROFILE = path.join(ROOT, 'profile');
const SHIM = path.join(__dirname, 'shim.js');
// Chrome refuses to load an extension containing any file whose name starts with '_'.
const SHIM_NAME = 'ext-survey-shim.js';
const PARTITION = 'persist:ext-survey';
const TAG = '__EXT_SURVEY__';
// A real page with a login form, so content scripts and autofill detection have work to do.
const PROBE_PAGE = process.env.EXT_SURVEY_PAGE || 'https://cad.onshape.com/signin';
const SETTLE_MS = Number(process.env.EXT_SURVEY_SETTLE_MS || 8000);
const MODE = ['stub', 'preload'].includes(process.env.EXT_SURVEY_MODE) ? process.env.EXT_SURVEY_MODE : 'raw';
const POLYFILL = path.join(__dirname, 'polyfill-preload.js');
// EXT_SURVEY_NO_SHIM=1 runs the extensions without the measuring shim, to rule out the shim
// itself as the cause of an error. Only Chromium's own stderr report remains.
const NO_SHIM = process.env.EXT_SURVEY_NO_SHIM === '1';
// Names this run's outputs, so a no-shim run does not overwrite the instrumented one.
const TAG_NAME = NO_SHIM ? `${MODE}-noshim` : MODE;

const sources = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (sources.length === 0) {
  console.error('usage: electron scripts/ext-survey/survey.js <unpacked-extension-dir>...');
  process.exit(2);
}

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
app.setPath('userData', PROFILE);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Instrumented copies
// ---------------------------------------------------------------------------------------

function listFiles(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(dir, r));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

function instrumentCopy(src) {
  const name = path.basename(path.resolve(src));
  const dst = path.join(WORK, name);
  fs.cpSync(src, dst, { recursive: true, filter: s => path.basename(s) !== '.git' });
  const manifestPath = path.join(dst, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const shim = `globalThis.__extSurveyStub = ${MODE === 'stub'};\n${fs.readFileSync(SHIM, 'utf8')}`;
  if (NO_SHIM) return { name, src: path.resolve(src), dir: dst, manifest };
  fs.writeFileSync(path.join(dst, SHIM_NAME), shim);

  const worker = manifest.background?.service_worker;
  if (worker) {
    const p = path.join(dst, worker);
    fs.writeFileSync(p, `${shim}\n;${fs.readFileSync(p, 'utf8')}`);
  }

  // Sandboxed pages have no chrome.* at all, so instrumenting them is only noise.
  const sandboxed = new Set((manifest.sandbox?.pages || []).map(p => path.normalize(p)));
  for (const rel of listFiles(dst).filter(f => f.endsWith('.html') && !sandboxed.has(path.normalize(f)))) {
    const p = path.join(dst, rel);
    const html = fs.readFileSync(p, 'utf8');
    const tag = `<script src="/${SHIM_NAME}"></script>`;
    fs.writeFileSync(p, /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html);
  }

  // The MAIN world shares `chrome` with the web page itself; leave it alone.
  for (const cs of manifest.content_scripts || []) {
    if (cs.world === 'MAIN' || !cs.js?.length) continue;
    cs.js = [SHIM_NAME, ...cs.js];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { name, src: path.resolve(src), dir: dst, manifest };
}

// Every chrome.* path the extension's code mentions. An upper bound: minified bundles keep
// dead branches for other browsers, so an absent API here is a lead, not a verdict.
function staticReferences(dir) {
  const refs = {};
  const re = /(?<![\w$./-])(?:chrome|browser)\.([a-zA-Z_$][\w$]*)(?:\.([a-zA-Z_$][\w$]*))?(?:\.([a-zA-Z_$][\w$]*))?/g;
  for (const rel of listFiles(dir).filter(f => f.endsWith('.js') && path.basename(f) !== SHIM_NAME)) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    for (const m of text.matchAll(re)) {
      const p = ['chrome', ...m.slice(1).filter(Boolean)].join('.');
      refs[p] = (refs[p] || 0) + 1;
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------

const records = [];      // parsed shim records
const consoleLines = []; // everything else at warning/error level
const opened = [];       // webContents the extensions caused to exist
const loadWarnings = []; // Electron's ExtensionLoadWarning, per extension path

process.on('warning', (w) => {
  if (w.name !== 'ExtensionLoadWarning') return;
  const m = /Warnings loading extension at (.*?):\n([\s\S]*)/.exec(w.message);
  loadWarnings.push({
    path: m ? m[1] : null,
    warnings: (m ? m[2] : w.message).split('\n').map(l => l.trim()).filter(Boolean),
  });
});

// Chromium prints extension errors (manifest problems, uncaught service-worker errors
// before any console could catch them) as multi-line blocks on stderr.
function parseExtensionErrors(stderr) {
  const errors = [];
  for (const block of stderr.split(/\n(?=\[[^\]\n]*\] Extension Error:)/)) {
    if (!block.includes('Extension Error:')) continue;
    const field = (name) => (new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(block) || [])[1] || null;
    errors.push({
      id: field('ID'),
      type: field('Type'),
      source: field('Source'),
      message: field('Message'),
      line: (/Line:\s*(\d+)/.exec(block) || [])[1] || null,
    });
  }
  return errors;
}

function onConsole(origin, message, level, source, line) {
  if (message.startsWith(TAG)) {
    try { records.push(JSON.parse(message.slice(TAG.length))); } catch { /* truncated */ }
    return;
  }
  if (level === 'warning' || level === 'error' || level === 2 || level === 3) {
    consoleLines.push({ origin, level: typeof level === 'number' ? ['verbose', 'info', 'warning', 'error'][level] : level, message: message.slice(0, 400), source, line });
  }
}

function watchContents(wc, origin) {
  wc.on('console-message', (e) => onConsole(origin, e.message, e.level, e.sourceId, e.lineNumber));
}

async function capture(win, file) {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return path.relative(ROOT, file);
  } catch (e) {
    return `capture failed: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------

async function run() {
  const ses = session.fromPartition(PARTITION);
  const results = [];
  const knownContents = new Set();

  if (MODE === 'preload') {
    ses.registerPreloadScript({ type: 'service-worker', id: 'ext-survey-polyfill', filePath: POLYFILL });
  }

  ses.serviceWorkers.on('console-message', (_e, d) =>
    onConsole(`worker:${d.sourceUrl}`, d.message, d.level, d.sourceUrl, d.lineNumber));

  app.on('web-contents-created', (_e, wc) => {
    setImmediate(() => {
      if (knownContents.has(wc.id)) return;
      opened.push({ type: wc.getType(), url: wc.getURL() });
      watchContents(wc, `created:${wc.getType()}`);
      wc.on('did-start-navigation', (d) => opened.push({ type: wc.getType(), navigated: d.url }));
    });
  });

  for (const src of sources) {
    const copy = instrumentCopy(src);
    const result = { ...copy, staticRefs: staticReferences(copy.dir) };
    delete result.manifest;
    result.manifestVersion = copy.manifest.manifest_version;
    result.popup = copy.manifest.action?.default_popup || null;
    try {
      const ext = await ses.extensions.loadExtension(copy.dir);
      Object.assign(result, { loaded: true, id: ext.id, version: ext.version, extName: ext.name, url: ext.url });
    } catch (e) {
      Object.assign(result, { loaded: false, loadError: e.message });
    }
    results.push(result);
  }

  // Let service workers boot (Bitwarden loads a WASM SDK on startup).
  await sleep(SETTLE_MS);

  const makeWindow = ({ extensionPage = false } = {}) => {
    const win = new BrowserWindow({
      show: false,
      width: 380,
      height: 600,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Per-window, not a session frame preload: web pages in the session get none.
        ...(MODE === 'preload' && extensionPage ? { preload: POLYFILL } : {}),
      },
    });
    knownContents.add(win.webContents.id);
    return win;
  };

  for (const r of results.filter(r => r.loaded && r.popup)) {
    const win = makeWindow({ extensionPage: true });
    watchContents(win.webContents, `popup:${r.name}`);
    try {
      await win.loadURL(new URL(r.popup, r.url).href);
    } catch (e) {
      r.popupLoadError = e.message;
    }
    await sleep(SETTLE_MS);
    r.popupText = await win.webContents
      .executeJavaScript('document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 300) : ""')
      .catch(e => `executeJavaScript failed: ${e.message}`);
    r.popupShot = await capture(win, path.join(ROOT, `popup-${r.name}-${TAG_NAME}.png`));
    win.destroy();
  }

  const page = makeWindow();
  page.setSize(1200, 800);
  watchContents(page.webContents, 'probe-page');
  let pageLoad = 'ok';
  try {
    await page.loadURL(PROBE_PAGE);
  } catch (e) {
    pageLoad = e.message;
  }
  await sleep(SETTLE_MS);
  // Focusing a credential field is what kicks off Bitwarden's autofill detection.
  const focused = await page.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('input[type=email], input[type=password], input[name*=user i], input[type=text]');
    if (!el) return null;
    el.focus(); el.click();
    return el.outerHTML.slice(0, 200);
  })()`).catch(e => `failed: ${e.message}`);
  await sleep(SETTLE_MS);
  // What content scripts left on the page: data-ext-survey-* markers (fixtures/content-worlds)
  // and whether a MAIN-world global is visible to the page itself.
  const markers = await page.webContents.executeJavaScript(`({
    dataset: Object.fromEntries(Object.entries(document.documentElement.dataset).filter(([k]) => k.startsWith('extSurvey'))),
    mainGlobalVisibleToPage: window.__extSurveyMainGlobal === true,
  })`).catch(e => ({ error: e.message }));
  const probeShot = await capture(page, path.join(ROOT, `probe-page-${TAG_NAME}.png`));
  page.destroy();

  const stderrFile = process.env.EXT_SURVEY_STDERR;
  const stderr = stderrFile && fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
  const extensionErrors = parseExtensionErrors(stderr);

  const report = {
    mode: MODE,
    noShim: NO_SHIM,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    when: new Date().toISOString(),
    probePage: { url: PROBE_PAGE, load: pageLoad, focused, markers, screenshot: probeShot },
    extensions: results,
    records,
    consoleLines,
    opened,
    loadWarnings,
    extensionErrors,
  };
  fs.writeFileSync(path.join(ROOT, `report-${TAG_NAME}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ROOT, `report-${TAG_NAME}.md`), require('./render').render(report));
  console.log(`wrote ${path.join(ROOT, `report-${TAG_NAME}.md`)}`);
}

// Without this, destroying the popup window (the only window) quits the app mid-run.
app.on('window-all-closed', () => {});

app.whenReady()
  .then(run)
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => app.quit());
