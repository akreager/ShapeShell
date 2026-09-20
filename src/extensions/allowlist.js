'use strict';

// The allowlist and the policy checks run against it (extensions phase 3).
//
// The list ships inside the app (allowlist.json) and is read-only: extensions arrive only
// through ShapeShell releases, decided 2026-09-19. A user-editable list would defeat the
// check, and we expect few users who need a particular extension.
//
// What each check is for:
//   identity   which extension this is — a signed CRX proves its own id; an unpacked folder
//              has no key, so it is identified by the slug it installs under
//   pin        that these are the exact reviewed bytes. This, not the signature, is what
//              ties an install to something a human looked at
//   policy     that the manifest asks for no more than the entry approves

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWLIST_FILE = path.join(__dirname, 'allowlist.json');

function load(file = ALLOWLIST_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.extensions)) throw new Error('Allowlist has no extensions array');
  return parsed;
}

function findById(allowlist, id) {
  return allowlist.extensions.find(e => e.id === id) || null;
}

function findBySlug(allowlist, slug) {
  return allowlist.extensions.find(e => e.slug === slug) || null;
}

// --- hashing -----------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursively(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    // A symlink inside an extension tree would make the hash meaningless, since it could
    // point anywhere and change underneath us.
    if (entry.isSymbolicLink()) throw new Error(`Symlink in extension tree: ${path.relative(base, full)}`);
    if (entry.isDirectory()) out.push(...listFilesRecursively(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * A stable hash of a directory's contents: every file's path and content, in sorted order.
 * Used both to pin an unpacked extension and to detect installed files changing on disk.
 */
function hashTree(dir) {
  const files = listFilesRecursively(dir).sort();
  const digest = crypto.createHash('sha256');
  for (const rel of files) {
    digest.update(rel.split(path.sep).join('/'));
    digest.update('\0');
    digest.update(sha256(fs.readFileSync(path.join(dir, rel))));
    digest.update('\n');
  }
  return digest.digest('hex');
}

/** The same hash, computed from zip entries rather than a directory on disk. */
function hashEntries(entries) {
  const digest = crypto.createHash('sha256');
  for (const { name, data } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    digest.update(name);
    digest.update('\0');
    digest.update(sha256(data));
    digest.update('\n');
  }
  return digest.digest('hex');
}

// --- policy ------------------------------------------------------------------------------

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Checks a manifest against its allowlist entry. Returns an array of reasons to refuse;
 * empty means it passed.
 */
function checkManifest(manifest, entry) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['The manifest could not be read'];

  if (manifest.manifest_version !== 3) {
    problems.push(`Manifest V${manifest.manifest_version} is not accepted; only V3 is`);
  }
  if (entry.minVersion && compareVersions(manifest.version, entry.minVersion) < 0) {
    problems.push(`Version ${manifest.version} is older than the reviewed ${entry.minVersion}`);
  }

  const extra = (asked, approved, label) => {
    const over = (asked || []).filter(p => !(approved || []).includes(p));
    if (over.length) problems.push(`${label} not approved for this extension: ${over.join(', ')}`);
  };
  extra(manifest.permissions, entry.permissions, 'Permissions');
  extra(manifest.optional_permissions, entry.optionalPermissions, 'Optional permissions');
  extra(manifest.host_permissions, entry.hostPermissions, 'Host permissions');

  const matches = (manifest.content_scripts || []).flatMap(cs => cs.matches || []);
  extra([...new Set(matches)], entry.contentScriptMatches, 'Content script matches');

  return problems;
}

module.exports = {
  ALLOWLIST_FILE,
  load,
  findById,
  findBySlug,
  hashTree,
  hashEntries,
  sha256,
  checkManifest,
  compareVersions,
};
