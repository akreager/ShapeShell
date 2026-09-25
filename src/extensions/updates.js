'use strict';

// Finding and downloading supported extensions, so no user needs Chrome to get a .crx.
//
// Nothing downloaded here is trusted for having been downloaded: every byte still goes
// through install.js, where the CRX signature (store) or the content pin (GitHub) is the
// real gate. Fetching is a convenience, not a trust decision.
//
// Requests go through the DEFAULT session, never persist:onshape, so no Onshape cookie is
// ever attached. The update check sends only the ids of extensions already installed.

const zip = require('./zip');

const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
// Bitwarden is 23MB. Generous ceilings, but a ceiling: a download is attacker-influenced
// until verified, and must not be able to fill the disk or memory.
const MAX_CRX_BYTES = 150 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

function defaultFetch() {
  // Required lazily so this module can be unit-tested under plain Node.
  return require('electron').net.fetch;
}

/** The store's update-check URL for these ids. `v=0.0.0.0` asks for the newest build. */
function updateCheckUrl(ids, chromeVersion) {
  const params = ids.map(id => `&x=${encodeURIComponent(`id=${id}&v=0.0.0.0&uc`)}`).join('');
  return `${UPDATE_URL}?prodversion=${encodeURIComponent(chromeVersion)}&acceptformat=crx3${params}`;
}

function attributes(tag) {
  const out = {};
  for (const [, name, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[name] = value.replace(/&amp;/g, '&');
  return out;
}

/**
 * Parses the store's gupdate XML into Map<id, { version, url, sha256, size } | null>.
 * null means the store answered but offers nothing for that id (not a store extension).
 * The response is a fixed, flat schema, so a strict pattern read is enough; anything that
 * does not match is simply absent.
 */
function parseUpdateResponse(xml) {
  const result = new Map();
  for (const [, appTag, body] of String(xml).matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const app = attributes(appTag);
    if (!/^[a-p]{32}$/.test(app.appid || '')) continue;
    const check = /<updatecheck\b([^>]*)\/?>/.exec(body);
    const u = check ? attributes(check[1]) : {};
    if (u.status === 'ok' && u.codebase && u.version) {
      result.set(app.appid, {
        version: u.version,
        url: u.codebase,
        sha256: /^[0-9a-f]{64}$/.test(u.hash_sha256 || '') ? u.hash_sha256 : null,
        size: Number(u.size) || null,
      });
    } else {
      result.set(app.appid, null);
    }
  }
  return result;
}

async function checkWebstore(ids, { fetch = defaultFetch(), chromeVersion = process.versions.chrome } = {}) {
  if (ids.length === 0) return new Map();
  const response = await fetch(updateCheckUrl(ids, chromeVersion), { credentials: 'omit' });
  if (!response.ok) throw new Error(`The update check failed: HTTP ${response.status}`);
  return parseUpdateResponse(await response.text());
}

/**
 * Downloads to memory with a hard size ceiling and progress reports.
 * `onProgress(received, total)`; `signal` cancels.
 */
async function download(url, { fetch = defaultFetch(), maxBytes, expectedSize = null, onProgress, signal } = {}) {
  if (!/^https:\/\//.test(url)) throw new Error('Refusing to download over plain http');
  const response = await fetch(url, { credentials: 'omit', signal });
  if (!response.ok) throw new Error(`The download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length')) || expectedSize || null;
  if (declared && declared > maxBytes) throw new Error(`The download is too large (${declared} bytes)`);

  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error('The download is too large');
    }
    chunks.push(Buffer.from(value));
    if (onProgress) onProgress(received, declared);
  }
  return Buffer.concat(chunks);
}

async function downloadCrx(info, options = {}) {
  const bytes = await download(info.url, { ...options, maxBytes: MAX_CRX_BYTES, expectedSize: info.size });
  // Transport integrity only. The signature check in install.js is what proves authorship.
  if (info.sha256) {
    const actual = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    if (actual !== info.sha256) throw new Error('The download was corrupted in transit (sha256 mismatch)');
  }
  return bytes;
}

function githubArchiveUrl({ repo, commit }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('The list entry has a malformed GitHub archive reference');
  }
  return `https://codeload.github.com/${repo}/zip/${commit}`;
}

/**
 * Downloads a GitHub archive and returns its files with the top-level folder GitHub adds
 * ("repo-commit/") stripped: [{ name, data }], directories omitted.
 */
async function downloadGithubArchive(archive, options = {}) {
  const bytes = await download(githubArchiveUrl(archive), { ...options, maxBytes: MAX_ARCHIVE_BYTES });
  const entries = zip.listEntries(bytes);
  const roots = new Set(entries.map(e => e.name.split('/')[0]));
  if (roots.size !== 1) throw new Error('The archive does not have the single top-level folder GitHub adds');
  const prefix = `${[...roots][0]}/`;
  return entries
    .filter(e => !e.isDirectory && e.name.startsWith(prefix) && e.name.length > prefix.length)
    .map(e => ({ name: e.name.slice(prefix.length), data: zip.readEntry(bytes, e) }));
}

module.exports = {
  checkWebstore,
  parseUpdateResponse,
  updateCheckUrl,
  downloadCrx,
  downloadGithubArchive,
  githubArchiveUrl,
  MAX_CRX_BYTES,
  MAX_ARCHIVE_BYTES,
};
