'use strict';

// Milestone 1 acceptance test: prove hardware-accelerated WebGL, not a software fallback.
// Run via scripts/gpu-check.sh (which supplies the env repair and the negative control).
// Exits 0 on PASS, 1 on FAIL.

const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Known software rasterisers. Deliberately vendor-neutral: the gate asserts *hardware*
// rendering, not any particular GPU.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|lavapipe|softpipe|basic render/i;
// Gitignored: running the check must not dirty the tree. docs/evidence/ holds the
// original milestone-1 results as a record.
const OUT_DIR = path.join(__dirname, '..', 'dist', 'gpu-check');

// Two separate promises on purpose. __info is the acceptance criterion and resolves
// immediately. __fps depends on requestAnimationFrame, which Chromium throttles to a halt
// when the window is occluded (e.g. behind an editor) — so it is supporting evidence only
// and must never be able to hang the gate.
const PROBE_HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111">
<canvas id="c" width="640" height="480"></canvas><script>
const canvas = document.getElementById('c');
let contextType = 'webgl2';
let gl = canvas.getContext('webgl2');
if (!gl) { contextType = 'webgl'; gl = canvas.getContext('webgl'); }

window.__info = (() => {
  if (!gl) return { ok: false, reason: 'getContext returned null', contextType: null };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  // Force real GPU work so a broken driver surfaces here rather than later.
  gl.clearColor(0.2, 0.4, 0.6, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();
  return {
    ok: true,
    contextType,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    maskedRenderer: gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    contextLost: gl.isContextLost(),
  };
})();

// Sample for a fixed wall-clock duration rather than a fixed frame count: an occluded
// window throttles rAF, and a frame-count loop would simply never finish. This always
// returns — a low sampledFps is itself the diagnosis.
window.__fps = (async () => {
  if (!gl) return null;
  const DURATION_MS = 3000;
  const frames = [];
  await new Promise(resolve => {
    const start = performance.now();
    let last = start;
    let n = 0;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      gl.clearColor((n++ % 60) / 60, 0.2, 0.4, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (now - start >= DURATION_MS) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(resolve, DURATION_MS + 500);
  });
  const samples = frames.slice(1).sort((a, b) => a - b);
  if (samples.length < 2) {
    return { frameCount: frames.length, throttled: true, note: 'rAF did not run — window occluded or unmapped' };
  }
  const pct = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  return {
    frameCount: frames.length,
    sampledFps: +(frames.length / (DURATION_MS / 1000)).toFixed(1),
    medianFrameMs: +pct(0.5).toFixed(2),
    p95FrameMs: +pct(0.95).toFixed(2),
    medianFps: +(1000 / pct(0.5)).toFixed(1),
    contextLostAfter: gl.isContextLost(),
  };
})();
</script></body>`;

function withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(onTimeout), ms)),
  ]);
}

// getGPUFeatureStatus() is only meaningful once the GPU info has settled.
function awaitGpuInfoSettled(timeoutMs = 8000, quietMs = 1500) {
  return new Promise(resolve => {
    let timer = null;
    const done = () => {
      app.off('gpu-info-update', onUpdate);
      clearTimeout(timer);
      resolve();
    };
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };
    app.on('gpu-info-update', onUpdate);
    timer = setTimeout(done, timeoutMs);
  });
}

const gpuCrashes = [];
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') gpuCrashes.push(details);
  console.error('[child-process-gone]', JSON.stringify(details));
});

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG: gpu-check exceeded 90s, exiting FAIL');
    app.exit(1);
  }, 90000);
  watchdog.unref?.();

  // show:true is mandatory — a hidden or occluded window throttles requestAnimationFrame
  // and the frame loop never completes.
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    // Short-lived diagnostic window: it must stay unoccluded or Chromium throttles
    // requestAnimationFrame and the frame-pacing sample never completes.
    alwaysOnTop: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let verdict = { pass: false, reason: 'probe did not complete' };
  let probe = null;
  let fps = null;
  let featureStatus = null;

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PROBE_HTML));
    win.moveTop();
    win.focus();
    await awaitGpuInfoSettled();
    featureStatus = app.getGPUFeatureStatus();
    probe = await withTimeout(
      win.webContents.executeJavaScript('window.__info'),
      15000,
      { ok: false, reason: 'timed out reading WebGL info' }
    );
    // Occluded windows throttle rAF, so this is allowed to time out without failing.
    fps = await withTimeout(
      win.webContents.executeJavaScript('window.__fps'),
      20000,
      { note: 'fps sampling timed out (window likely occluded); not a gate failure' }
    );

    const renderer = probe.renderer || probe.maskedRenderer || '';
    const checks = {
      webglEnabled: featureStatus.webgl === 'enabled',
      gpuCompositing: featureStatus.gpu_compositing === 'enabled',
      // Chromium 152 does not emit a webgl2 key; absence is not a failure.
      webgl2: 'webgl2' in featureStatus ? featureStatus.webgl2 === 'enabled' : true,
      rendererNotSoftware: !SOFTWARE_RENDERER.test(renderer),
      contextAlive: probe.ok === true && probe.contextLost === false,
      noGpuCrash: gpuCrashes.length === 0,
    };

    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    verdict = { pass: failed.length === 0, failed, checks };
  } catch (err) {
    verdict = { pass: false, reason: String(err && err.stack ? err.stack : err) };
  }

  const evidence = {
    verdict,
    probe,
    fps,
    featureStatus,
    gpuCrashes,
    env: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      xdgSessionType: process.env.XDG_SESSION_TYPE || null,
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
      argv: process.argv.slice(1),
      displays: screen.getAllDisplays().map(d => ({
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
      })),
    },
    // Recorded for reference only — never gated on. On Linux this reports glRenderer
    // empty and glImplementationParts "(gl=none,angle=none)" even when fully working.
    gpuInfo: await withTimeout(
      app.getGPUInfo('complete').catch(e => ({ error: String(e) })),
      10000,
      { error: 'getGPUInfo timed out' }
    ),
  };

  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\nVERDICT: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  if (!verdict.pass) console.log(`FAILED CHECKS: ${(verdict.failed || []).join(', ') || verdict.reason}`);

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const tag = process.env.GPU_CHECK_TAG || 'run';
    fs.writeFileSync(path.join(OUT_DIR, `gpu-check-${tag}.json`), JSON.stringify(evidence, null, 2));
  } catch (err) {
    console.error('[evidence write failed]', err);
  }

  clearTimeout(watchdog);
  win.destroy();
  app.exit(verdict.pass ? 0 : 1);
});
