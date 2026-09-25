'use strict';

// Installing and re-verifying extensions.
//
// Install:  identify -> supported list -> signature (CRX) or content pin (folder) ->
//           manifest policy -> unpack into the app's own data directory -> record a marker
// Load:     on every launch, re-check each installed extension against the current list and
//           re-hash its files, so a build the list no longer accepts, or one whose files
//           changed on disk, is not loaded.
//
// Supported extensions are held to their list entry. An extension that is NOT on the list is
// refused unless the caller passes `allowUnsupported`, which the Manage Extensions window
// does only after the user has read and accepted the "here be dragons" warning. Even then
// a signed CRX must verify: a corrupt file is still refused.
//
// Nothing here trusts the package: see crx.js and zip.js for the parsing limits.

const fs = require('node:fs');
const path = require('node:path');

const crx = require('./crx');
const zip = require('./zip');
const allowlistModule = require('./allowlist');

const MARKER = 'shapeshell-install.json';
// New installs live at a FIXED path under their key. Electron derives an unpacked
// extension's id from its path, and chrome.storage is keyed by that id, so a path that
// changed per version (as the first installs used, `<key>/<version>`) would silently wipe
// an extension's data on every update. Those older installs keep their directory name,
// recorded in the marker as `dir`, so their id does not change either.
const INSTALL_DIR = 'current';
// Chromium deletes a top-level `_metadata` folder from every unpacked extension it loads
// (it holds Chrome's own content-verification data, which Electron does not use). Store CRXs
// ship one, so writing it meant the first load changed the tree and every later launch
// refused the install as "changed on disk". It is never written.
const CHROMIUM_OWNED = '_metadata';
const isChromiumOwned = rel => rel === CHROMIUM_OWNED || rel.startsWith(`${CHROMIUM_OWNED}/`);

class RefusedError extends Error {
  constructor(reasons) {
    const list = Array.isArray(reasons) ? reasons : [reasons];
    super(list.join('; '));
    this.name = 'RefusedError';
    this.reasons = list;
  }
}

// --- manifests ---------------------------------------------------------------------------

function parseManifest(text) {
  try {
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object') throw new Error('not an object');
    return manifest;
  } catch (e) {
    throw new RefusedError(`manifest.json could not be read: ${e.message}`);
  }
}

// The least any extension must have, supported or not.
function checkBasics(manifest) {
  const problems = [];
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('The manifest has no name');
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    problems.push(`The manifest version "${manifest.version}" is not a valid extension version`);
  }
  return problems;
}

/**
 * A manifest's human-readable name. Store extensions usually localise it ("__MSG_extName__"),
 * so the default locale's messages are consulted; `readFile(rel)` returns a file's text or null.
 */
function displayName(manifest, readFile) {
  const name = String(manifest?.name || '');
  const match = /^__MSG_(\w+)__$/.exec(name);
  if (!match) return name;
  const locale = manifest.default_locale || 'en';
  try {
    const messages = JSON.parse(readFile(`_locales/${locale}/messages.json`) || '{}');
    const wanted = match[1].toLowerCase();
    const key = Object.keys(messages).find(k => k.toLowerCase() === wanted);
    if (key && typeof messages[key]?.message === 'string') return messages[key].message;
  } catch { /* fall through to the raw name */ }
  return match[1];
}

// Where an unsupported extension's row links to. Only https, since it opens in the user's
// browser.
function homepageOf(manifest) {
  const url = manifest.homepage_url;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}

// An unsupported unpacked folder has no signature and no list entry, so its key comes from
// what it declares: a manifest `key` gives the same id Chrome would use, otherwise its name.
// A later build of the same extension then replaces the earlier one instead of sitting
// beside it.
function unsupportedFolderKey(manifest, name) {
  if (typeof manifest.key === 'string' && manifest.key) {
    try {
      return crx.idFromPublicKey(Buffer.from(manifest.key, 'base64'));
    } catch { /* fall back to the name */ }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `unsupported-${slug || 'extension'}`;
}

// --- writing -----------------------------------------------------------------------------

function writeEntries(files, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const { name, data, isDirectory } of files) {
    if (isChromiumOwned(name.replace(/\/$/, ''))) continue;
    // zip.js has already refused absolute paths, traversal, backslashes and symlinks.
    const target = path.join(destination, name);
    if (!target.startsWith(destination + path.sep)) throw new RefusedError(`Entry escapes the install directory: ${name}`);
    if (isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data(), { mode: 0o644, flag: 'wx' });
  }
}

function readMarker(keyDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(keyDir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

// Unpacks into a staging directory beside the target, then swaps it in. `beforeSwap` runs
// after every check has passed and just before the files change, so a caller can unload the
// running copy then — and only then. A refused update never touches what is installed.
function commit({ extensionsDir, key, write, record, beforeSwap }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new RefusedError(`Unusable install key: ${key}`);
  const keyDir = path.join(extensionsDir, key);
  const previous = readMarker(keyDir);
  // Updating keeps the directory, and with it the extension id and its stored data.
  const dirName = previous ? String(previous.dir || previous.version) : INSTALL_DIR;
  const target = path.join(keyDir, dirName);
  const staging = path.join(keyDir, '.incoming');
  const old = path.join(keyDir, '.previous');

  fs.mkdirSync(keyDir, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  let full;
  try {
    write(staging);
    // The tree hash of what actually landed on disk is what every later launch re-checks.
    full = { ...record, key, dir: dirName, installedTreeSha256: allowlistModule.hashTree(staging) };
  } catch (e) {
    // Leave no half-written staging tree, and on a first install no empty directory that
    // would later read as a broken install.
    fs.rmSync(previous ? staging : keyDir, { recursive: true, force: true });
    throw e;
  }

  if (beforeSwap) beforeSwap(key, previous);
  if (fs.existsSync(target)) fs.renameSync(target, old);
  fs.renameSync(staging, target);
  // Written after the swap so a marker never describes a half-written tree. It sits beside
  // the install directory, not inside it, so it cannot disturb the hash it records.
  fs.writeFileSync(path.join(keyDir, MARKER), JSON.stringify(full, null, 2));
  fs.rmSync(old, { recursive: true, force: true });

  return { ...full, path: target, previousVersion: previous?.version || null };
}

// --- installing --------------------------------------------------------------------------

/**
 * Installs CRX bytes. `expectId` refuses a file that is not the extension asked for, which
 * matters for downloads: whatever the store returned has to be the id we requested.
 */
function installCrx(bytes, extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  // Parse and verify before anything else, so a corrupt file says it is corrupt.
  let verified;
  try {
    verified = crx.verify(bytes);
  } catch (e) {
    throw new RefusedError(e.message);
  }
  if (options.expectId && verified.id !== options.expectId) {
    throw new RefusedError(`The download is extension ${verified.id}, not the ${options.expectId} that was requested`);
  }

  const entries = zip.listEntries(verified.zip, options.limits);
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) throw new RefusedError('The package has no manifest.json');
  const manifest = parseManifest(zip.readEntry(verified.zip, manifestEntry).toString('utf8'));
  const readFile = (rel) => {
    const e = entries.find(x => x.name === rel);
    return e ? zip.readEntry(verified.zip, e).toString('utf8') : null;
  };

  const entry = allowlistModule.findById(allowlist, verified.id);
  const problems = checkBasics(manifest);
  // A supported id is always held to its entry, even when it arrives through the
  // unsupported path: that path must not become a way round the permission ceiling.
  if (entry) problems.push(...allowlistModule.checkManifest(manifest, entry));
  else if (!options.allowUnsupported) problems.push(`Extension ${verified.id} is not on the supported list`);
  if (problems.length) throw new RefusedError(problems);

  return commit({
    extensionsDir,
    key: verified.id,
    beforeSwap: options.beforeSwap,
    write: staging => writeEntries(entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory,
      data: () => zip.readEntry(verified.zip, e),
    })), staging),
    record: {
      installedAt: new Date().toISOString(),
      source: options.source || null,
      id: verified.id,
      slug: null,
      name: entry ? entry.name : displayName(manifest, readFile),
      version: manifest.version,
      supported: Boolean(entry),
      homepage: homepageOf(manifest),
      crxSha256: allowlistModule.sha256(bytes),
      sourceTreeSha256: null,
    },
  });
}

/**
 * Installs an unpacked extension from files already in memory — a GitHub archive, with its
 * top-level folder stripped. `files` is [{ name, data: Buffer }], directories omitted.
 */
function installFiles(files, extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  const manifestFile = files.find(f => f.name === 'manifest.json');
  if (!manifestFile) throw new RefusedError('The archive has no manifest.json at its top level');
  const treeHash = allowlistModule.hashEntries(files);
  return installUnpacked({
    allowlist,
    extensionsDir,
    treeHash,
    manifest: parseManifest(manifestFile.data.toString('utf8')),
    readFile: rel => files.find(f => f.name === rel)?.data.toString('utf8') ?? null,
    write: staging => writeEntries(files.map(f => ({ name: f.name, data: () => f.data })), staging),
    options,
  });
}

function installFolder(source, extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  // Checked before hashing: a folder with no manifest.json is almost always the PARENT of
  // the extension rather than a build we have not reviewed, and saying so is more use than
  // a hash of whatever else was in there. It also keeps hashTree from reading every file
  // under a home directory chosen by mistake.
  if (!fs.existsSync(path.join(source, 'manifest.json'))) {
    throw new RefusedError(`"${path.basename(source)}" is not an extension: it contains no manifest.json. Choose the folder that has manifest.json directly inside it.`);
  }
  const treeHash = allowlistModule.hashTree(source);
  return installUnpacked({
    allowlist,
    extensionsDir,
    treeHash,
    manifest: parseManifest(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')),
    readFile: (rel) => {
      try { return fs.readFileSync(path.join(source, rel), 'utf8'); } catch { return null; }
    },
    write: staging => fs.cpSync(source, staging, {
      recursive: true,
      dereference: false,
      filter: (s) => {
        const rel = path.relative(source, s).split(path.sep).join('/');
        return path.basename(s) !== '.git' && !isChromiumOwned(rel);
      },
    }),
    options: { ...options, source: options.source || path.resolve(source) },
  });
}

// An unpacked tree carries no key, so the folder name proves nothing — a clone can be
// called anything. Its contents are its identity: a supported build is one whose hash is on
// the list, and the entry it matches supplies the key it installs under.
function installUnpacked({ allowlist, extensionsDir, treeHash, manifest, readFile, write, options }) {
  const entry = allowlist.extensions.find(e => (e.treeSha256 || []).includes(treeHash)) || null;
  const problems = checkBasics(manifest);
  if (entry) problems.push(...allowlistModule.checkManifest(manifest, entry));
  else if (!options.allowUnsupported) {
    problems.push(`These files are not a reviewed build of any supported extension (sha256 ${treeHash})`);
  }
  if (problems.length) throw new RefusedError(problems);

  const name = entry ? entry.name : displayName(manifest, readFile);
  return commit({
    extensionsDir,
    key: entry ? entry.slug : unsupportedFolderKey(manifest, name),
    beforeSwap: options.beforeSwap,
    write,
    record: {
      installedAt: new Date().toISOString(),
      source: options.source || null,
      id: null,
      slug: entry ? entry.slug : null,
      name,
      version: manifest.version,
      supported: Boolean(entry),
      homepage: homepageOf(manifest),
      crxSha256: null,
      sourceTreeSha256: treeHash,
    },
  });
}

/**
 * Installs a .crx file or an unpacked directory from disk into `extensionsDir`.
 * Throws RefusedError with readable reasons when it does not pass.
 */
function install(source, extensionsDir, options = {}) {
  if (fs.statSync(source).isDirectory()) return installFolder(source, extensionsDir, options);
  return installCrx(fs.readFileSync(source), extensionsDir, { ...options, source: options.source || path.resolve(source) });
}

// --- verifying on load -------------------------------------------------------------------

/**
 * Every installed extension that still passes its checks, plus why any were skipped.
 * Returns { ready: [{ key, path, record, entry }], skipped: [{ key, record, reasons }] }
 */
function verifyInstalled(extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  const ready = [];
  const skipped = [];
  if (!fs.existsSync(extensionsDir)) return { ready, skipped };

  for (const key of fs.readdirSync(extensionsDir)) {
    if (key.startsWith('.')) continue; // download scratch space
    const keyDir = path.join(extensionsDir, key);
    if (!fs.statSync(keyDir).isDirectory()) continue;
    const record = readMarker(keyDir);
    if (!record) {
      skipped.push({ key, record: null, reasons: ['No readable install marker'] });
      continue;
    }

    const reasons = [];
    const entry = record.id
      ? allowlistModule.findById(allowlist, record.id)
      : allowlistModule.findBySlug(allowlist, record.slug);
    // Markers written before unsupported installs existed have no `supported` field; every
    // one of them came through the list.
    const supported = record.supported !== false;

    const installDir = path.join(keyDir, String(record.dir || record.version));
    if (!fs.existsSync(installDir)) reasons.push('The installed files are missing');
    else {
      try {
        const hash = allowlistModule.hashTree(installDir);
        if (hash !== record.installedTreeSha256) reasons.push('The installed files have changed on disk');
      } catch (e) {
        reasons.push(`The installed files could not be hashed: ${e.message}`);
      }
    }

    if (reasons.length === 0) {
      if (supported && !entry) {
        // An app update can drop an entry. The user never accepted the unsupported warning
        // for this one, so it is not quietly kept as an unsupported extension.
        reasons.push('No longer on the supported list');
      } else if (entry && record.slug && !(entry.treeSha256 || []).includes(record.sourceTreeSha256)) {
        reasons.push('This build is no longer a reviewed one');
      } else if (entry) {
        // Re-checked on every launch, since an app update can tighten an entry's ceiling.
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf8'));
          reasons.push(...allowlistModule.checkManifest(manifest, entry));
        } catch (e) {
          reasons.push(`manifest.json could not be read: ${e.message}`);
        }
      }
    }

    if (reasons.length) skipped.push({ key, record, reasons });
    else ready.push({ key, path: installDir, record, entry });
  }
  return { ready, skipped };
}

function uninstall(extensionsDir, key) {
  const target = path.join(extensionsDir, key);
  if (!key || !target.startsWith(extensionsDir + path.sep)) throw new Error('Refusing to remove a path outside the extensions directory');
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  install,
  installCrx,
  installFiles,
  installFolder,
  verifyInstalled,
  uninstall,
  displayName,
  RefusedError,
  MARKER,
  INSTALL_DIR,
};
