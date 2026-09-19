'use strict';

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_HOST = '127.51.68.120';
const BRIDGE_PORT = 8181;

// The bridge deliberately exits when it loses spacenavd — its own comment says losing the
// daemon "is not recoverable in place" and defers to the packaged unit's Restart=always.
// We spawn it ourselves instead of via systemd, so we owe it that restart policy;
// otherwise an unplugged or wedged puck leaves the bridge dead until the app restarts.
const MIN_RESTART_MS = 2000;
const MAX_RESTART_MS = 30000;
const STABLE_RUN_MS = 60000;

// Binding any 127.x.x.x address needs no loopback alias on Linux: the kernel installs a
// `local 127.0.0.0/8 dev lo` route covering the whole range. (macOS does require an
// alias, which is where the original spec's pkexec/systemd step came from.)

function binaryPath() {
  // Packaged builds get resources/ via extraResources; dev runs read it from the repo.
  const packaged = path.join(process.resourcesPath || '', 'bridge', 'spacemouse-bridge');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'resources', 'bridge', 'spacemouse-bridge');
}

// Inside a Flatpak, XDG_CONFIG_HOME is remapped to a per-app directory, so the bridge
// would silently ignore the calibration the user wrote on the host with `-calibrate`.
// Point it at the host's file explicitly; the manifest grants read access to that dir.
// Outside Flatpak, pass nothing and let the bridge honour the user's own XDG setup.
function hostConfigArgs() {
  if (!process.env.FLATPAK_ID) return [];
  const base = process.env.HOST_XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return ['-config', path.join(base, 'spacemouse-bridge', 'config.json')];
}

const certDir = () => path.join(app.getPath('userData'), 'bridge-certs');
const leafPath = () => path.join(certDir(), 'leaf.pem');
const pidPath = () => path.join(app.getPath('userData'), 'bridge.pid');

let child = null;
let logStream = null;
let stopping = false;
let restartTimer = null;
let restartDelayMs = MIN_RESTART_MS;
let startedAt = 0;

// Linux does not kill child processes when their parent dies, so a crash (or SIGKILL)
// leaves the bridge running and holding port 8181. Reap our own leftover before
// spawning. The executable is checked before signalling, because a bare pid from a
// previous boot may since have been reused by an unrelated process.
function reapStale(bin) {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidPath(), 'utf8').trim(), 10);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;

  let exe;
  try {
    exe = fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return; // not running
  }
  if (path.resolve(exe) !== path.resolve(bin)) return;

  console.log(`[bridge] reaping orphaned bridge pid=${pid}`);
  try {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; }
    }
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function start() {
  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    console.error(`[bridge] binary missing at ${bin} — run: npm run fetch-bridge`);
    return;
  }

  reapStale(bin);
  fs.mkdirSync(certDir(), { recursive: true });
  const logPath = path.join(app.getPath('userData'), 'bridge.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });

  // -no-auto-trust: the bridge would otherwise inject its CA into every browser NSS
  // store with certutil. We trust its cert in-process instead (see installCertificateTrust),
  // so it must not touch system-wide browser state.
  child = spawn(bin, [
    '-no-auto-trust',
    '-cert-dir', certDir(),
    '-host', BRIDGE_HOST,
    '-port', String(BRIDGE_PORT),
    ...hostConfigArgs(),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  startedAt = Date.now();
  try { fs.writeFileSync(pidPath(), String(child.pid)); } catch { /* best effort */ }
  console.log(`[bridge] started pid=${child.pid}, logging to ${logPath}`);

  child.on('exit', (code, signal) => {
    console.log(`[bridge] exited code=${code} signal=${signal}`);
    child = null;
    scheduleRestart();
  });
  child.on('error', (err) => {
    console.error('[bridge] failed to start:', err.message);
    child = null;
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (stopping || restartTimer) return;

  // A run that lasted a while was healthy, so start the next backoff from scratch;
  // otherwise keep doubling so a permanently absent device doesn't spin.
  if (startedAt && Date.now() - startedAt >= STABLE_RUN_MS) restartDelayMs = MIN_RESTART_MS;

  const delay = restartDelayMs;
  restartDelayMs = Math.min(restartDelayMs * 2, MAX_RESTART_MS);
  console.log(`[bridge] restarting in ${delay}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!stopping) start();
  }, delay);
  restartTimer.unref?.();
}

function stop() {
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (!child) return;
  const pid = child.pid;
  child.kill('SIGTERM');
  // Nothing should outlive the app; escalate if SIGTERM is ignored.
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 2000).unref?.();
  child = null;
  logStream?.end();
  logStream = null;
  try { fs.unlinkSync(pidPath()); } catch { /* best effort */ }
}

// Trust ONLY the bridge's own leaf certificate, and only for its host. The app loads a
// live remote origin, so a blanket "accept anything from this host" would be a real
// weakness; comparing against the leaf we just generated keeps it to one certificate.
function installCertificateTrust(ses) {
  let cached = { mtimeMs: 0, der: null };

  const bridgeLeafDer = () => {
    try {
      const { mtimeMs } = fs.statSync(leafPath());
      if (mtimeMs !== cached.mtimeMs) {
        const pem = fs.readFileSync(leafPath(), 'utf8');
        const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
        cached = { mtimeMs, der: Buffer.from(body, 'base64') };
      }
      return cached.der;
    } catch {
      return null;
    }
  };

  ses.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== BRIDGE_HOST) {
      callback(-3); // defer to Chromium's own verification
      return;
    }

    const expected = bridgeLeafDer();
    const presented = request.certificate?.data
      ? Buffer.from(
          request.certificate.data
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
            .replace(/\s+/g, ''),
          'base64')
      : null;

    const ok = expected && presented && expected.equals(presented);
    if (!ok) console.error(`[bridge] rejected cert from ${request.hostname}: not our generated leaf`);
    callback(ok ? 0 : -2);
  });
}

module.exports = { start, stop, installCertificateTrust, BRIDGE_HOST, BRIDGE_PORT };
