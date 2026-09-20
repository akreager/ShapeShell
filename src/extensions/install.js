'use strict';

// Installing and re-verifying allowlisted extensions (extensions phase 3).
//
// Install:  identify -> allowlist -> pinned hash -> signature (CRX) -> manifest policy ->
//           unpack into the app's own data directory -> record a marker
// Load:     on every launch, re-check each installed extension against the current allowlist
//           and re-hash its files, so an extension dropped from the allowlist in an update,
//           or one whose files changed on disk, is not loaded.
//
// Nothing here trusts the package: see crx.js and zip.js for the parsing limits.

const fs = require('node:fs');
const path = require('node:path');

const crx = require('./crx');
const zip = require('./zip');
const allowlistModule = require('./allowlist');

const MARKER = 'shapeshell-install.json';

class RefusedError extends Error {
  constructor(reasons) {
    const list = Array.isArray(reasons) ? reasons : [reasons];
    super(list.join('; '));
    this.name = 'RefusedError';
    this.reasons = list;
  }
}

function readManifestFrom(entries, archive) {
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) throw new RefusedError('The package has no manifest.json');
  try {
    return JSON.parse(zip.readEntry(archive, manifestEntry).toString('utf8'));
  } catch (e) {
    throw new RefusedError(`manifest.json could not be read: ${e.message}`);
  }
}

function writeTree(entries, archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    // zip.js has already refused absolute paths, traversal, backslashes and symlinks.
    const target = path.join(destination, entry.name);
    if (!target.startsWith(destination + path.sep)) throw new RefusedError(`Entry escapes the install directory: ${entry.name}`);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zip.readEntry(archive, entry), { mode: 0o644, flag: 'wx' });
  }
}

/**
 * Installs a .crx file or an unpacked directory into `extensionsDir`.
 * Throws RefusedError with readable reasons when it does not pass.
 */
function install(source, extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  const stats = fs.statSync(source);
  const record = { installedAt: new Date().toISOString(), source: path.resolve(source) };

  let entry;
  let manifest;
  let install;

  if (stats.isDirectory()) {
    // An unpacked tree carries no key, so there is no id to check and the folder name proves
    // nothing — a clone can be called anything. Its contents are its identity: the hash has
    // to match a reviewed build, and the entry it matches supplies the name it installs
    // under.
    const treeHash = allowlistModule.hashTree(source);
    entry = allowlist.extensions.find(e => (e.treeSha256 || []).includes(treeHash)) || null;
    if (!entry) {
      throw new RefusedError(`These files are not a reviewed build of any allowlisted extension (sha256 ${treeHash})`);
    }
    const slug = entry.slug;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
    } catch (e) {
      throw new RefusedError(`manifest.json could not be read: ${e.message}`);
    }
    const problems = allowlistModule.checkManifest(manifest, entry);
    if (problems.length) throw new RefusedError(problems);

    install = { slug, treeHash, copyFrom: source };
  } else {
    const bytes = fs.readFileSync(source);
    const fileHash = allowlistModule.sha256(bytes);

    // Parse before checking the pin so a corrupt file says so, rather than "not reviewed".
    const verified = crx.verify(bytes);
    entry = allowlistModule.findById(allowlist, verified.id);
    if (!entry) throw new RefusedError(`Extension ${verified.id} is not on the allowlist`);
    if (!(entry.crxSha256 || []).includes(fileHash)) {
      throw new RefusedError(`This is not a reviewed build of "${entry.name}" (sha256 ${fileHash})`);
    }

    const entries = zip.listEntries(verified.zip, options.limits);
    manifest = readManifestFrom(entries, verified.zip);
    const problems = allowlistModule.checkManifest(manifest, entry);
    if (problems.length) throw new RefusedError(problems);

    install = { id: verified.id, fileHash, entries, archive: verified.zip };
  }

  const key = install.id || install.slug;
  const versionDir = path.join(extensionsDir, key, String(manifest.version));
  const staging = `${versionDir}.incoming`;
  fs.rmSync(staging, { recursive: true, force: true });

  if (install.copyFrom) {
    fs.cpSync(install.copyFrom, staging, { recursive: true, dereference: false, filter: s => path.basename(s) !== '.git' });
  } else {
    writeTree(install.entries, install.archive, staging);
  }

  // The tree hash of what actually landed on disk is what every later launch re-checks.
  const installedTreeHash = allowlistModule.hashTree(staging);
  Object.assign(record, {
    id: install.id || null,
    slug: install.slug || null,
    name: entry.name,
    version: manifest.version,
    crxSha256: install.fileHash || null,
    sourceTreeSha256: install.treeHash || null,
    installedTreeSha256: installedTreeHash,
  });

  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(versionDir), { recursive: true });
  fs.renameSync(staging, versionDir);
  // Written after the rename so a marker never describes a half-written tree. It sits beside
  // the version directory, not inside it, so it cannot disturb the hash it records.
  fs.writeFileSync(path.join(extensionsDir, key, MARKER), JSON.stringify(record, null, 2));

  return { ...record, path: versionDir, entry };
}

/**
 * Every installed extension that still passes its checks, plus why any were skipped.
 * Returns { ready: [{ path, record, entry }], skipped: [{ key, reasons }] }
 */
function verifyInstalled(extensionsDir, options = {}) {
  const allowlist = options.allowlist || allowlistModule.load();
  const ready = [];
  const skipped = [];
  if (!fs.existsSync(extensionsDir)) return { ready, skipped };

  for (const key of fs.readdirSync(extensionsDir)) {
    const markerPath = path.join(extensionsDir, key, MARKER);
    const reasons = [];
    let record;
    try {
      record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch (e) {
      skipped.push({ key, reasons: [`No readable install marker: ${e.message}`] });
      continue;
    }

    const entry = record.id
      ? allowlistModule.findById(allowlist, record.id)
      : allowlistModule.findBySlug(allowlist, record.slug);
    // An app update can drop an entry; that must unload the extension, not keep it.
    if (!entry) reasons.push(`No longer on the allowlist (${record.name || key})`);

    const versionDir = path.join(extensionsDir, key, String(record.version));
    if (!fs.existsSync(versionDir)) reasons.push('The installed files are missing');
    else {
      try {
        const hash = allowlistModule.hashTree(versionDir);
        if (hash !== record.installedTreeSha256) reasons.push('The installed files have changed on disk');
      } catch (e) {
        reasons.push(`The installed files could not be hashed: ${e.message}`);
      }
    }

    if (entry && reasons.length === 0) {
      const pinnedStill = record.crxSha256
        ? (entry.crxSha256 || []).includes(record.crxSha256)
        : (entry.treeSha256 || []).includes(record.sourceTreeSha256);
      if (!pinnedStill) reasons.push('This build is no longer a reviewed one');
    }

    if (reasons.length) skipped.push({ key, reasons });
    else ready.push({ path: versionDir, record, entry });
  }
  return { ready, skipped };
}

function uninstall(extensionsDir, key) {
  const target = path.join(extensionsDir, key);
  if (!target.startsWith(extensionsDir + path.sep)) throw new Error('Refusing to remove a path outside the extensions directory');
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { install, verifyInstalled, uninstall, RefusedError, MARKER };
