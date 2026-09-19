'use strict';

// Renders dist/ext-survey/report.json as Markdown. Also runnable on its own with plain
// Node, to re-render a saved report: node scripts/ext-survey/render.js [report.json]

const FAILURE_KINDS = ['missing', 'threw', 'rejected', 'lastError', 'stub-call'];

const uniq = a => [...new Set(a)];
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ctxKind = c => (c.startsWith('page:') ? 'page' : c);

// Is `p` (e.g. chrome.tabs.onUpdated.addListener) present in a surface map? A prefix that
// is a function, event or unwalked object counts: the walk stops there by design.
function present(surface, p) {
  // Chrome defines lastError only while a callback runs, so no surface dump ever sees it.
  if (p.startsWith('chrome.runtime.lastError')) return true;
  const parts = p.split('.');
  for (let i = parts.length; i >= 2; i--) {
    const prefix = parts.slice(0, i).join('.');
    const type = surface[prefix];
    if (!type) continue;
    if (i === parts.length) return true;
    return ['event', 'function', 'object-unwalked'].includes(type);
  }
  return false;
}

function render(report) {
  const out = [];
  const w = s => out.push(s);

  w(`# Extension API survey — ${report.mode} mode${report.noShim ? ', no shim' : ''}`);
  w('');
  w(`Electron ${report.electron} (Chromium ${report.chrome}), ${report.when}.`);
  w('');
  w({
    stub: 'Stub mode: missing namespaces were replaced with inert stubs so execution could continue. Errors downstream of a stub are artefacts.',
    preload: 'Preload mode: extension code pristine apart from the measuring shim; missing namespaces supplied by scripts/ext-survey/polyfill-preload.js.',
  }[report.mode] || 'Raw mode: the extensions ran exactly as Electron would run them.');
  if (report.noShim) {
    w('');
    w('No shim: the measuring shim was left out, so only Chromium\'s own stderr report and the polyfill preload\'s records remain. Errors that vanish here were caused by the shim.');
  }
  w('');
  w(`Probe page: ${report.probePage.url} (load: ${report.probePage.load}; focused: \`${cell(report.probePage.focused) || 'nothing'}\`; screenshot: ${report.probePage.screenshot}).`);
  if (report.probePage.markers) w(`Content-script markers on the probe page: \`${JSON.stringify(report.probePage.markers)}\``);

  for (const ext of report.extensions) {
    const mine = report.records.filter(r => r.ext && r.ext === ext.id);
    const events = mine.filter(r => r.type === 'event');
    const surfaces = mine.filter(r => r.type === 'surface');
    const union = Object.assign({}, ...surfaces.map(s => s.surface));

    w('');
    w(`## ${ext.extName || ext.name}`);
    w('');
    if (!ext.loaded) {
      w(`**Failed to load:** ${ext.loadError}`);
      continue;
    }
    w(`- Version ${ext.version}, MV${ext.manifestVersion}, id \`${ext.id}\` (path-derived, survey copy)`);
    w(`- Contexts that reported: ${uniq(mine.map(r => r.ctx)).map(c => `\`${c}\``).join(', ') || '**none**'}`);
    const noChrome = mine.filter(r => r.type === 'no-chrome' || r.type === 'install-failed');
    if (noChrome.length) w(`- Instrumentation problems: ${noChrome.map(r => `${r.ctx}: ${r.type} ${r.detail || ''}`).join('; ')}`);
    const warnings = report.loadWarnings.filter(l => l.path === ext.dir).flatMap(l => l.warnings);
    if (warnings.length) w(`- Load warnings: ${warnings.map(cell).join('; ')}`);
    const errors = report.extensionErrors.filter(e => e.id === ext.id);
    for (const e of errors) w(`- Chromium extension error (${e.type}): ${cell(e.message)} — ${cell(e.source)}${e.line ? `:${e.line}` : ''}`);
    for (const r of mine.filter(r => r.type === 'polyfill')) w(`- Polyfill preload (\`${r.ctx}\`): ${cell(r.detail)}`);
    if (ext.popup) {
      w(`- Popup \`${ext.popup}\`: ${ext.popupLoadError ? `load error ${ext.popupLoadError}` : 'loaded'}; screenshot ${ext.popupShot}`);
      w(`  - Rendered text: “${cell(ext.popupText) || '(empty)'}”`);
    }

    const failures = new Map();
    for (const r of events.filter(r => FAILURE_KINDS.includes(r.kind))) {
      const f = failures.get(r.path) || { kinds: new Set(), ctx: new Set(), detail: new Set() };
      f.kinds.add(r.kind);
      f.ctx.add(ctxKind(r.ctx));
      if (r.detail) f.detail.add(r.detail);
      failures.set(r.path, f);
    }
    w('');
    w(`### Runtime failures (${failures.size})`);
    w('');
    if (failures.size) {
      w('| API | Failure | Context | Detail |');
      w('|---|---|---|---|');
      for (const [p, f] of [...failures].sort((a, b) => a[0].localeCompare(b[0]))) {
        w(`| \`${p}\` | ${[...f.kinds].join(', ')} | ${[...f.ctx].join(', ')} | ${cell([...f.detail].join(' / '))} |`);
      }
    } else {
      w('None observed.');
    }

    const uncaught = events.filter(r => r.kind === 'uncaught');
    w('');
    w(`### Uncaught errors (${uncaught.length})`);
    w('');
    for (const r of uncaught) w(`- \`${ctxKind(r.ctx)}\` ${cell(r.detail)}`);
    if (!uncaught.length) w('None observed.');

    const stubbed = uniq(events.filter(r => r.kind === 'stub-get' || r.kind === 'missing').map(r => r.path)).sort();
    if (report.mode === 'stub') {
      w('');
      w(`### Missing API members touched at runtime (${stubbed.length})`);
      w('');
      w(stubbed.length ? stubbed.map(p => `\`${p}\``).join(', ') : 'None.');
    }

    const probes = uniq(events.filter(r => r.kind === 'probe-absent').map(r => r.path)).sort();
    w('');
    w(`### Feature probes that came back absent (${probes.length})`);
    w('');
    w(probes.length ? probes.map(p => `\`${p}\``).join(', ') : 'None.');

    const calls = uniq(events.filter(r => r.kind === 'call').map(r => r.path)).sort();
    w('');
    w(`### Calls that ran without a synchronous error (${calls.length})`);
    w('');
    w(calls.length ? calls.map(p => `\`${p}\``).join(', ') : 'None.');

    if (Object.keys(union).length) {
      const absent = Object.entries(ext.staticRefs)
        .filter(([p]) => !present(union, p))
        .sort((a, b) => a[0].localeCompare(b[0]));
      w('');
      w(`### Referenced in code but absent from every observed context (${absent.length})`);
      w('');
      w('Static upper bound: bundles keep dead branches for other browsers.');
      w('');
      w(absent.length ? absent.map(([p, n]) => `\`${p}\` (${n})`).join(', ') : 'None.');
    }

    const lines = report.consoleLines.filter(l => (l.source || '').includes(ext.id) || (l.origin || '').includes(ext.id));
    w('');
    w(`### Console warnings and errors from its own code (${lines.length})`);
    w('');
    for (const l of uniq(lines.map(l => `${l.level}: ${cell(l.message)}`)).slice(0, 40)) w(`- ${l}`);
    if (!lines.length) w('None.');
  }

  const surfaces = report.records.filter(r => r.type === 'surface');
  w('');
  w('## API surface Electron exposes, by context');
  w('');
  const byCtx = new Map();
  for (const s of surfaces) {
    const k = ctxKind(s.ctx);
    const namespaces = Object.keys(s.surface).filter(p => p.split('.').length === 2);
    byCtx.set(k, uniq([...(byCtx.get(k) || []), ...namespaces]).sort());
  }
  for (const [k, ns] of byCtx) w(`- **${k}**: ${ns.map(p => `\`${p.slice(7)}\``).join(', ')}`);
  if (!byCtx.size) w('No context reported a surface.');

  w('');
  w('## Web contents created during the run');
  w('');
  for (const o of report.opened) w(`- ${o.type} ${o.url ?? ''}${o.navigated ? `→ ${o.navigated}` : ''}`);
  if (!report.opened.length) w('None.');

  const strayErrors = report.extensionErrors.filter(e => !report.extensions.some(x => x.id === e.id));
  if (strayErrors.length) {
    w('');
    w('## Other Chromium extension errors');
    w('');
    for (const e of strayErrors) w(`- ${e.id} (${e.type}): ${cell(e.message)}`);
  }

  const other = report.consoleLines.filter(l => !report.extensions.some(e => e.id && ((l.source || '').includes(e.id) || (l.origin || '').includes(e.id))));
  w('');
  w(`## Other console warnings and errors (${other.length})`);
  w('');
  for (const l of uniq(other.map(l => `${l.origin} ${l.level}: ${cell(l.message)}`)).slice(0, 30)) w(`- ${l}`);
  if (!other.length) w('None.');

  return `${out.join('\n')}\n`;
}

module.exports = { render };

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'ext-survey', 'report.json');
  process.stdout.write(render(JSON.parse(fs.readFileSync(file, 'utf8'))));
}
