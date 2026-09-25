'use strict';

// Unit tests for the CRX and zip readers, the installer and the downloader. Plain Node, no
// Electron:
//   npm run test-extensions
//
// These parse attacker-influenced bytes, so every refusal is tested, not just the happy
// path. The fixtures are built here — a real RSA key, a real signature, a real zip — so a
// tampered file can be tested honestly rather than simulated.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const crx = require('../src/extensions/crx');
const zip = require('../src/extensions/zip');

// --- builders ----------------------------------------------------------------------------

function crc32(buf) {
  return zip.crc32(buf);
}

// Minimal zip writer, stored (uncompressed) entries only.
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data = Buffer.alloc(0), externalAttributes = 0 } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(crc32(body), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(externalAttributes, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function varint(value) {
  const out = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

function field(fieldNumber, payload) {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(payload.length), payload]);
}

function buildCrx({ zipBuffer, key, declaredIdBytes, tamperSignature = false }) {
  const publicKeyDer = key.publicKey.export({ type: 'spki', format: 'der' });
  const idBytes = declaredIdBytes
    || crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = field(1, Buffer.from(idBytes));

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(signedHeaderData.length);
  const payload = Buffer.concat([
    Buffer.from('CRX3 SignedData\0'),
    lengthPrefix,
    signedHeaderData,
    zipBuffer,
  ]);
  const signature = crypto.sign('sha256', payload, {
    key: key.privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  if (tamperSignature) signature[0] ^= 0xff;

  const proof = Buffer.concat([field(1, publicKeyDer), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zipBuffer]);
}

// --- harness -----------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

function refuses(name, fn, expected) {
  test(name, () => {
    assert.throws(fn, (e) => {
      assert.match(e.message, expected, `refused, but for the wrong reason: ${e.message}`);
      return true;
    }, 'expected this to be refused, but it was accepted');
  });
}

// --- fixtures ----------------------------------------------------------------------------

const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const manifest = JSON.stringify({ manifest_version: 3, name: 'test', version: '1.0.0' });
const goodZip = buildZip([
  { name: 'manifest.json', data: manifest },
  { name: 'icons/', data: Buffer.alloc(0) },
  { name: 'icons/icon.png', data: Buffer.from('not really a png') },
]);
const goodCrx = buildCrx({ zipBuffer: goodZip, key });

// --- CRX ---------------------------------------------------------------------------------

console.log('\nCRX3 parsing and signature verification');

test('a well-formed CRX verifies, and its id derives from the signing key', () => {
  const result = crx.verify(goodCrx);
  const expected = crx.idFromPublicKey(key.publicKey.export({ type: 'spki', format: 'der' }));
  assert.equal(result.id, expected);
  assert.match(result.id, /^[a-p]{32}$/);
});

test('the id is the first 16 bytes of the key hash, mapped a-p', () => {
  // 0x00 -> "aa", 0x0f -> "ap", 0xf0 -> "pa", 0xff -> "pp"
  assert.equal(crx.idFromBytes(Buffer.from([0x00, 0x0f, 0xf0, 0xff])), 'aaappapp');
});

refuses('a tampered payload', () => {
  const tampered = Buffer.from(goodCrx);
  tampered[tampered.length - 30] ^= 0xff;
  crx.verify(tampered);
}, /signature is not valid/i);

refuses('a tampered signature', () => {
  crx.verify(buildCrx({ zipBuffer: goodZip, key, tamperSignature: true }));
}, /signature is not valid/i);

refuses('an id that does not match the signing key', () => {
  crx.verify(buildCrx({ zipBuffer: goodZip, key, declaredIdBytes: Buffer.alloc(16, 7) }));
}, /does not match its declared extension id/i);

refuses('a file signed by a different key but claiming this id', () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const declaredIdBytes = crypto.createHash('sha256')
    .update(key.publicKey.export({ type: 'spki', format: 'der' })).digest().subarray(0, 16);
  crx.verify(buildCrx({ zipBuffer: goodZip, key: other, declaredIdBytes }));
}, /does not match its declared extension id/i);

refuses('a CRX2 file', () => {
  const buf = Buffer.from(goodCrx);
  buf.writeUInt32LE(2, 4);
  crx.verify(buf);
}, /only CRX3/i);

refuses('something that is not a CRX at all', () => crx.verify(Buffer.from('PK\u0003\u0004 hello there')), /not a CRX/i);

refuses('a header length past the end of the file', () => {
  const buf = Buffer.from(goodCrx);
  buf.writeUInt32LE(0xfffff, 8);
  crx.verify(buf);
}, /header length is out of range/i);

// --- zip ---------------------------------------------------------------------------------

console.log('\nZip reading');

test('entries are listed and read back intact', () => {
  const entries = zip.listEntries(goodZip);
  assert.equal(entries.length, 3);
  const entry = entries.find(e => e.name === 'manifest.json');
  assert.equal(zip.readEntry(goodZip, entry).toString(), manifest);
  assert.equal(entries.find(e => e.name === 'icons/').isDirectory, true);
});

refuses('path traversal', () => zip.listEntries(buildZip([{ name: '../evil.js', data: 'x' }])), /traversal/i);
refuses('traversal in the middle of a path', () => zip.listEntries(buildZip([{ name: 'a/../../evil.js', data: 'x' }])), /traversal/i);
refuses('an absolute path', () => zip.listEntries(buildZip([{ name: '/etc/passwd', data: 'x' }])), /absolute path/i);
refuses('a Windows drive path', () => zip.listEntries(buildZip([{ name: 'C:/evil.js', data: 'x' }])), /absolute path/i);
refuses('a backslash path', () => zip.listEntries(buildZip([{ name: 'a\\..\\evil.js', data: 'x' }])), /backslash/i);
refuses('a NUL in the name', () => zip.listEntries(buildZip([{ name: 'a\0b.js', data: 'x' }])), /NUL/i);

refuses('a symlink entry', () => {
  // Unix mode S_IFLNK in the high half of the external attributes.
  zip.listEntries(buildZip([{ name: 'link', data: '/etc/passwd', externalAttributes: (0o120777 << 16) >>> 0 }]));
}, /symlink/i);

refuses('too many files', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  zip.listEntries(buildZip(many), { maxFiles: 10 });
}, /too many entries/i);

refuses('a file over the per-file limit', () => {
  zip.listEntries(buildZip([{ name: 'big.bin', data: Buffer.alloc(2048) }]), { maxFileBytes: 1024 });
}, /too large/i);

refuses('contents over the total limit', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(1024) }));
  zip.listEntries(buildZip(files), { maxTotalBytes: 2048 });
}, /size limit/i);

refuses('a corrupt checksum', () => {
  const buf = buildZip([{ name: 'a.txt', data: 'hello' }]);
  const entry = zip.listEntries(buf)[0];
  buf[buf.indexOf(Buffer.from('hello'))] = 0x58; // flip a byte of the data, not the header
  zip.readEntry(buf, entry);
}, /checksum mismatch/i);

refuses('not a zip at all', () => zip.listEntries(Buffer.from('just some bytes, definitely not a zip archive')), /not a zip/i);

// --- the real thing ----------------------------------------------------------------------

const bitwarden = path.join(__dirname, '..', 'dist', 'ext-survey', 'downloads', 'bitwarden.crx');
console.log('\nA real Chrome Web Store package');
if (fs.existsSync(bitwarden)) {
  test('the Bitwarden CRX verifies and derives its Web Store id', () => {
    const result = crx.verify(fs.readFileSync(bitwarden));
    assert.equal(result.id, 'nngceckbapebfimnlniiiahkandclblb');
  });
  test('its zip lists the manifest and a few hundred files', () => {
    const { zip: archive } = crx.verify(fs.readFileSync(bitwarden));
    const entries = zip.listEntries(archive);
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    assert.ok(manifestEntry, 'no manifest.json in the archive');
    const parsed = JSON.parse(zip.readEntry(archive, manifestEntry).toString());
    assert.equal(parsed.manifest_version, 3);
    assert.ok(entries.length > 100, `expected a few hundred entries, got ${entries.length}`);
  });
} else {
  console.log('  skipped (run npm run ext-survey first to download it)');
}

// --- installing ---------------------------------------------------------------------------

const install = require('../src/extensions/install');
const allowlistModule = require('../src/extensions/allowlist');
const updates = require('../src/extensions/updates');

const TMP = path.join(__dirname, '..', 'dist', 'test-extensions');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const testKeyId = crx.idFromPublicKey(key.publicKey.export({ type: 'spki', format: 'der' }));

// A supported list built around the test key, so installs can be exercised without shipping
// a real extension's bytes into the test.
function allowlistFor(overrides = {}) {
  return {
    version: 2,
    extensions: [{
      id: testKeyId,
      slug: 'test-extension',
      name: 'Test extension',
      permissions: ['storage'],
      optionalPermissions: [],
      hostPermissions: [],
      contentScriptMatches: [],
      ...overrides,
    }],
  };
}
const EMPTY_LIST = { version: 2, extensions: [] };

function crxWith(manifestOverrides, files = []) {
  const body = JSON.stringify({ manifest_version: 3, name: 'Test extension', version: '1.0.0', ...manifestOverrides });
  return buildCrx({ zipBuffer: buildZip([{ name: 'manifest.json', data: body }, ...files]), key });
}

function writeCrx(name, buffer) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, buffer);
  return file;
}

// An unpacked extension folder on disk.
function folderWith(name, manifestOverrides = {}, files = {}) {
  const dir = path.join(TMP, 'src', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Folder extension', version: '1.0.0', ...manifestOverrides }));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}

console.log('\nInstalling a supported store extension');

test('a signed CRX on the list installs with no byte pin, at a fixed path', () => {
  const dir = path.join(TMP, 'install-good');
  const result = install.install(writeCrx('good.crx', crxWith({}, [{ name: 'background.js', data: 'console.log(1)' }])), dir, { allowlist: allowlistFor() });
  assert.equal(result.id, testKeyId);
  assert.equal(result.version, '1.0.0');
  assert.equal(result.supported, true);
  assert.equal(result.path, path.join(dir, testKeyId, install.INSTALL_DIR));
  assert.ok(fs.existsSync(path.join(result.path, 'background.js')));
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: allowlistFor() });
  assert.equal(skipped.length, 0, `unexpectedly skipped: ${JSON.stringify(skipped)}`);
  assert.equal(ready.length, 1);
});

// The point of the fixed path: Electron derives an unpacked extension's id from its path,
// and chrome.storage is keyed by the id. A per-version directory wiped an extension's data
// on every update.
test('an update replaces the files in place, keeping the path and so the extension id', () => {
  const dir = path.join(TMP, 'install-update');
  const first = install.install(writeCrx('v1.crx', crxWith({ version: '1.0.0' })), dir, { allowlist: allowlistFor() });
  const swapped = [];
  const second = install.install(writeCrx('v2.crx', crxWith({ version: '1.1.0' }, [{ name: 'new.js', data: 'x' }])), dir, {
    allowlist: allowlistFor(),
    beforeSwap: (k) => swapped.push(k),
  });
  assert.equal(second.path, first.path);
  assert.equal(second.previousVersion, '1.0.0');
  assert.deepEqual(swapped, [testKeyId]);
  assert.ok(fs.existsSync(path.join(second.path, 'new.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.path, 'manifest.json'))).version, '1.1.0');
  assert.deepEqual(fs.readdirSync(path.join(dir, testKeyId)).sort(), [install.MARKER, install.INSTALL_DIR].sort());
});

test('a refused update leaves the installed version untouched, and never unloads it', () => {
  const dir = path.join(TMP, 'install-refused-update');
  const list = allowlistFor();
  const first = install.install(writeCrx('keep.crx', crxWith({ version: '1.0.0' })), dir, { allowlist: list });
  let swapped = false;
  assert.throws(() => install.install(writeCrx('greedy.crx', crxWith({ version: '2.0.0', permissions: ['storage', 'debugger'] })), dir, {
    allowlist: list,
    beforeSwap: () => { swapped = true; },
  }), /Permissions not approved.*debugger/);
  assert.equal(swapped, false, 'the running copy was unloaded for an update that was then refused');
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.path, 'manifest.json'))).version, '1.0.0');
  assert.equal(install.verifyInstalled(dir, { allowlist: list }).ready.length, 1);
  assert.equal(fs.existsSync(path.join(dir, testKeyId, '.incoming')), false);
});

// Installs made before the fixed path keep their version-named directory for good.
test('a pre-existing <key>/<version> install is updated in its own directory', () => {
  const dir = path.join(TMP, 'install-legacy');
  const legacy = path.join(dir, testKeyId, '1.0.0');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Test extension', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, testKeyId, install.MARKER), JSON.stringify({
    id: testKeyId, slug: null, name: 'Test extension', version: '1.0.0',
    crxSha256: 'f'.repeat(64), sourceTreeSha256: null, installedTreeSha256: allowlistModule.hashTree(legacy),
  }));
  const list = allowlistFor();
  assert.equal(install.verifyInstalled(dir, { allowlist: list }).ready[0].path, legacy);
  const updated = install.install(writeCrx('legacy-v2.crx', crxWith({ version: '1.2.0' })), dir, { allowlist: list });
  assert.equal(updated.path, legacy);
  assert.equal(updated.version, '1.2.0');
  assert.equal(install.verifyInstalled(dir, { allowlist: list }).ready.length, 1);
});

// Chromium deletes _metadata from an unpacked extension on load; if we wrote it, the first
// launch changed the tree and every later one refused the install as "changed on disk".
test('a CRX\'s _metadata folder is not installed, so loading cannot change the tree', () => {
  const dir = path.join(TMP, 'install-metadata');
  const result = install.install(writeCrx('meta.crx', crxWith({}, [
    { name: '_metadata/', data: Buffer.alloc(0) },
    { name: '_metadata/verified_contents.json', data: '[]' },
  ])), dir, { allowlist: allowlistFor() });
  assert.equal(fs.existsSync(path.join(result.path, '_metadata')), false);
  fs.rmSync(path.join(result.path, '_metadata'), { recursive: true, force: true }); // what Chromium does
  assert.equal(install.verifyInstalled(dir, { allowlist: allowlistFor() }).ready.length, 1);
});

test('reinstalling over an install that fails its checks repairs it in place', () => {
  const dir = path.join(TMP, 'install-repair');
  const first = install.install(writeCrx('repair.crx', crxWith({}, [{ name: 'a.js', data: 'a' }])), dir, { allowlist: allowlistFor() });
  fs.rmSync(path.join(first.path, 'a.js'));
  assert.equal(install.verifyInstalled(dir, { allowlist: allowlistFor() }).ready.length, 0);
  const again = install.install(writeCrx('repair.crx', crxWith({}, [{ name: 'a.js', data: 'a' }])), dir, { allowlist: allowlistFor() });
  assert.equal(again.path, first.path);
  assert.equal(install.verifyInstalled(dir, { allowlist: allowlistFor() }).ready.length, 1);
});

refuses('a download that is not the extension that was requested', () => {
  install.installCrx(crxWith({}), path.join(TMP, 'install-wrong-id'), { allowlist: allowlistFor(), expectId: 'a'.repeat(32) });
}, /not the a+ that was requested/i);

refuses('a CRX whose id is not listed, without the unsupported warning accepted', () => {
  install.install(writeCrx('unlisted.crx', crxWith({})), path.join(TMP, 'install-unlisted'), { allowlist: EMPTY_LIST });
}, /not on the supported list/i);

refuses('a Manifest V2 build of a supported extension', () => {
  install.install(writeCrx('mv2.crx', crxWith({ manifest_version: 2 })), path.join(TMP, 'install-mv2'), { allowlist: allowlistFor() });
}, /only V3/i);

refuses('a permission the entry does not approve', () => {
  install.install(writeCrx('perms.crx', crxWith({ permissions: ['storage', 'debugger'] })), path.join(TMP, 'install-perms'), { allowlist: allowlistFor() });
}, /Permissions not approved.*debugger/i);

refuses('host permissions beyond the entry', () => {
  install.install(writeCrx('hosts.crx', crxWith({ host_permissions: ['<all_urls>'] })), path.join(TMP, 'install-hosts'), {
    allowlist: allowlistFor({ hostPermissions: ['https://cad.onshape.com/*'] }),
  });
}, /Host permissions not approved/i);

refuses('content scripts matching more than the entry approves', () => {
  install.install(writeCrx('scripts.crx', crxWith({ content_scripts: [{ matches: ['*://*/*'], js: ['a.js'] }] })), path.join(TMP, 'install-scripts'), {
    allowlist: allowlistFor({ contentScriptMatches: ['https://*.onshape.com/*'] }),
  });
}, /Content script matches not approved/i);

refuses('a version older than the floor', () => {
  install.install(writeCrx('old.crx', crxWith({ version: '0.9.0' })), path.join(TMP, 'install-old'), { allowlist: allowlistFor({ minVersion: '1.0.0' }) });
}, /older than the reviewed/i);

refuses('a package that tries to write outside its directory', () => {
  const buf = buildCrx({
    zipBuffer: buildZip([
      { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0' }) },
      { name: '../escape.js', data: 'owned' },
    ]),
    key,
  });
  install.install(writeCrx('slip.crx', buf), path.join(TMP, 'install-slip'), { allowlist: allowlistFor() });
}, /traversal/i);

test('a refused first install leaves nothing behind', () => {
  const dir = path.join(TMP, 'install-nothing-left');
  assert.throws(() => install.install(writeCrx('bad-first.crx', crxWith({ permissions: ['debugger'] })), dir, { allowlist: allowlistFor() }));
  assert.equal(fs.existsSync(path.join(dir, testKeyId)), false);
});

console.log('\nInstalling an unsupported extension (after the warning)');

test('an unlisted CRX installs as unsupported, named from its localised manifest', () => {
  const dir = path.join(TMP, 'install-unsupported-crx');
  const buf = crxWith({ name: '__MSG_appName__', default_locale: 'en', manifest_version: 2 }, [
    { name: '_locales/en/messages.json', data: JSON.stringify({ appName: { message: 'Localised Name' } }) },
  ]);
  const result = install.install(writeCrx('unsupported.crx', buf), dir, { allowlist: EMPTY_LIST, allowUnsupported: true });
  assert.equal(result.supported, false);
  assert.equal(result.name, 'Localised Name');
  const { ready } = install.verifyInstalled(dir, { allowlist: EMPTY_LIST });
  assert.equal(ready.length, 1, 'an unsupported extension should keep loading with no list entry');
});

// The unsupported path must not be a way round a supported extension's ceiling.
refuses('a supported id arriving through the unsupported path is still held to its entry', () => {
  install.install(writeCrx('sneaky.crx', crxWith({ permissions: ['debugger'] })), path.join(TMP, 'install-sneaky'), {
    allowlist: allowlistFor(), allowUnsupported: true,
  });
}, /Permissions not approved/i);

refuses('a corrupt CRX, even with the warning accepted', () => {
  const tampered = Buffer.from(crxWith({}));
  tampered[tampered.length - 30] ^= 0xff;
  install.install(writeCrx('corrupt.crx', tampered), path.join(TMP, 'install-corrupt'), { allowlist: EMPTY_LIST, allowUnsupported: true });
}, /signature is not valid/i);

refuses('a manifest with no usable version, even with the warning accepted', () => {
  install.install(writeCrx('nover.crx', crxWith({ version: 'latest' })), path.join(TMP, 'install-nover'), { allowlist: EMPTY_LIST, allowUnsupported: true });
}, /not a valid extension version/i);

test('an unsupported folder installs under a key from its name, and a newer build replaces it', () => {
  const dir = path.join(TMP, 'install-unsupported-folder');
  const v1 = install.install(folderWith('uf1', { name: 'My Tool!', version: '1.0' }), dir, { allowlist: EMPTY_LIST, allowUnsupported: true });
  assert.equal(v1.key, 'unsupported-my-tool');
  const v2 = install.install(folderWith('uf2', { name: 'My Tool!', version: '1.1' }), dir, { allowlist: EMPTY_LIST, allowUnsupported: true });
  assert.equal(v2.path, v1.path);
  assert.equal(install.verifyInstalled(dir, { allowlist: EMPTY_LIST }).ready.length, 1);
});

test('an unsupported folder with a manifest key installs under the id Chrome would give it', () => {
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const result = install.install(folderWith('keyed', { key: publicKey }), path.join(TMP, 'install-keyed'), { allowlist: EMPTY_LIST, allowUnsupported: true });
  assert.equal(result.key, testKeyId);
});

console.log('\nInstalling a supported unpacked extension (pinned by content)');

test('a folder whose contents match a pin installs under its entry', () => {
  const src = folderWith('pinned', { name: 'Pinned' }, { 'a.js': 'a', '_locales/en/messages.json': '{}', 'B.js': 'b' });
  const list = { version: 2, extensions: [{ id: null, slug: 'pinned', name: 'Pinned extension', treeSha256: [allowlistModule.hashTree(src)], permissions: [], optionalPermissions: [], hostPermissions: [], contentScriptMatches: [] }] };
  const result = install.install(src, path.join(TMP, 'install-pinned'), { allowlist: list });
  assert.equal(result.key, 'pinned');
  assert.equal(result.supported, true);
});

// hashEntries once sorted with localeCompare, which orders "_locales" and capitals
// differently from hashTree, so an archive could never match its own folder's pin.
test('files from an archive hash exactly as the same folder on disk', () => {
  const src = folderWith('archive-src', {}, { 'a.js': 'a', '_locales/en/messages.json': '{}', 'B.js': 'b', 'Z/y.txt': 'y' });
  const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? walk(path.join(d, e.name), base)
    : [{ name: path.relative(base, path.join(d, e.name)).split(path.sep).join('/'), data: fs.readFileSync(path.join(d, e.name)) }]));
  const files = walk(src);
  assert.equal(allowlistModule.hashEntries(files), allowlistModule.hashTree(src));
  const list = { version: 2, extensions: [{ id: null, slug: 'from-archive', name: 'From archive', treeSha256: [allowlistModule.hashTree(src)], permissions: [], optionalPermissions: [], hostPermissions: [], contentScriptMatches: [] }] };
  const result = install.installFiles(files, path.join(TMP, 'install-archive'), { allowlist: list });
  assert.equal(result.key, 'from-archive');
  assert.equal(result.installedTreeSha256, allowlistModule.hashTree(src));
});

refuses('an archive that is not the reviewed build', () => {
  install.installFiles([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0' })) }],
    path.join(TMP, 'install-archive-bad'), { allowlist: EMPTY_LIST });
}, /not a reviewed build/i);

console.log('\nRe-verifying on every launch');

test('files changed on disk are refused at load', () => {
  const dir = path.join(TMP, 'install-tamper');
  const list = allowlistFor();
  const result = install.install(writeCrx('tamper.crx', crxWith({}, [{ name: 'background.js', data: 'console.log(1)' }])), dir, { allowlist: list });
  fs.writeFileSync(path.join(result.path, 'background.js'), 'console.log("modified after install")');
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: list });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /changed on disk/i);
});

// The user never accepted the unsupported warning for it, so it is not quietly kept.
test('a supported extension dropped from the list is not loaded', () => {
  const dir = path.join(TMP, 'install-dropped');
  install.install(writeCrx('dropped.crx', crxWith({})), dir, { allowlist: allowlistFor() });
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: EMPTY_LIST });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /no longer on the supported list/i);
});

test('an installed build over a ceiling tightened by an app update is not loaded', () => {
  const dir = path.join(TMP, 'install-tightened');
  install.install(writeCrx('wide.crx', crxWith({ permissions: ['storage', 'tabs'] })), dir, { allowlist: allowlistFor({ permissions: ['storage', 'tabs'] }) });
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: allowlistFor({ permissions: ['storage'] }) });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /Permissions not approved.*tabs/);
});

test('an unpacked build whose pin was withdrawn is not loaded', () => {
  const src = folderWith('withdrawn');
  const entry = { id: null, slug: 'withdrawn', name: 'W', permissions: [], optionalPermissions: [], hostPermissions: [], contentScriptMatches: [] };
  const dir = path.join(TMP, 'install-withdrawn');
  install.install(src, dir, { allowlist: { version: 2, extensions: [{ ...entry, treeSha256: [allowlistModule.hashTree(src)] }] } });
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: { version: 2, extensions: [{ ...entry, treeSha256: ['0'.repeat(64)] }] } });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /no longer a reviewed one/i);
});

test('uninstall removes the files', () => {
  const dir = path.join(TMP, 'install-remove');
  install.install(writeCrx('remove.crx', crxWith({})), dir, { allowlist: allowlistFor() });
  install.uninstall(dir, testKeyId);
  assert.equal(install.verifyInstalled(dir, { allowlist: allowlistFor() }).ready.length, 0);
  assert.equal(fs.existsSync(path.join(dir, testKeyId)), false);
});

// --- updates and downloads ----------------------------------------------------------------

console.log('\nUpdate checks and downloads');

// Trimmed from real responses (2026-09-24).
const UPDATE_XML = '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">'
  + '<app appid="nngceckbapebfimnlniiiahkandclblb" cohort="1::" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/abc/NNG_2026_9_1_0.crx" fp="1.d1a5" hash_sha256="d1a5942d9c234d03382da99279932055064caae7a32cc9b157940c863165d59f" protected="0" size="23144528" status="ok" version="2026.9.1"/></app>'
  + '<app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"><updatecheck status="noupdate"/></app></gupdate>';

test('the store response is read into version, url, hash and size', () => {
  const found = updates.parseUpdateResponse(UPDATE_XML);
  assert.deepEqual(found.get('nngceckbapebfimnlniiiahkandclblb'), {
    version: '2026.9.1',
    url: 'https://clients2.googleusercontent.com/crx/blobs/abc/NNG_2026_9_1_0.crx',
    sha256: 'd1a5942d9c234d03382da99279932055064caae7a32cc9b157940c863165d59f',
    size: 23144528,
  });
  assert.equal(found.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null);
});

test('the update check asks for the newest build of each id', () => {
  const url = updates.updateCheckUrl(['nngceckbapebfimnlniiiahkandclblb'], '152.0.7977.78');
  assert.match(url, /prodversion=152\.0\.7977\.78/);
  assert.match(url, /x=id%3Dnngceckbapebfimnlniiiahkandclblb%26v%3D0\.0\.0\.0%26uc/);
});

refuses('a malformed GitHub reference', () => updates.githubArchiveUrl({ repo: 'a/b', commit: 'main' }), /malformed/i);

// A fake fetch serving bytes in chunks, as net.fetch does.
function fakeFetch(bytes, { status = 200, contentLength = bytes.length } = {}) {
  return async () => ({
    ok: status === 200,
    status,
    headers: { get: h => (h === 'content-length' && contentLength !== null ? String(contentLength) : null) },
    text: async () => bytes.toString(),
    body: {
      getReader() {
        let offset = 0;
        return {
          read: async () => {
            if (offset >= bytes.length) return { done: true };
            const chunk = bytes.subarray(offset, offset + 1000);
            offset += chunk.length;
            return { done: false, value: new Uint8Array(chunk) };
          },
          cancel: async () => {},
        };
      },
    },
  });
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

const asyncTests = [];
asyncTests.push(() => asyncTest('a CRX download reports progress and checks the store hash', async () => {
  // Several chunks' worth, so progress is reported more than once.
  const bytes = crxWith({}, [{ name: 'padding.bin', data: crypto.randomBytes(5000) }]);
  const seen = [];
  const got = await updates.downloadCrx(
    { url: 'https://example.invalid/x.crx', sha256: allowlistModule.sha256(bytes), size: bytes.length },
    { fetch: fakeFetch(bytes), onProgress: (r, t) => seen.push([r, t]) },
  );
  assert.ok(got.equals(bytes));
  assert.ok(seen.length > 1 && seen.at(-1)[0] === bytes.length && seen.at(-1)[1] === bytes.length);
}));
asyncTests.push(() => asyncTest('a download that does not match the store hash is refused', async () => {
  await assert.rejects(updates.downloadCrx({ url: 'https://example.invalid/x.crx', sha256: '0'.repeat(64) }, { fetch: fakeFetch(crxWith({})) }), /corrupted in transit/);
}));
asyncTests.push(() => asyncTest('a download over the ceiling is refused, whatever it claims', async () => {
  const big = Buffer.alloc(updates.MAX_ARCHIVE_BYTES + 10);
  await assert.rejects(updates.downloadGithubArchive({ repo: 'a/b', commit: 'c'.repeat(40) }, { fetch: fakeFetch(big, { contentLength: null }) }), /too large/);
}));
asyncTests.push(() => asyncTest('plain http is refused', async () => {
  await assert.rejects(updates.downloadCrx({ url: 'http://example.invalid/x.crx' }, { fetch: fakeFetch(Buffer.from('x')) }), /plain http/);
}));
asyncTests.push(() => asyncTest('a GitHub archive has its top-level folder stripped', async () => {
  const archive = buildZip([
    { name: 'repo-abc/', data: Buffer.alloc(0) },
    { name: 'repo-abc/manifest.json', data: '{}' },
    { name: 'repo-abc/js/a.js', data: 'a' },
  ]);
  const files = await updates.downloadGithubArchive({ repo: 'o/repo', commit: 'a'.repeat(40) }, { fetch: fakeFetch(archive) });
  assert.deepEqual(files.map(f => f.name).sort(), ['js/a.js', 'manifest.json']);
}));

// --- the shipped list and the real packages -------------------------------------------------

console.log('\nThe shipped list');

test('it parses, and every entry has an identity and a source', () => {
  const shipped = allowlistModule.load();
  assert.ok(shipped.extensions.length > 0);
  for (const entry of shipped.extensions) {
    assert.ok(entry.name && entry.slug, `entry without a name or slug: ${JSON.stringify(entry)}`);
    assert.match(entry.source || '', /^https:\/\//, `${entry.name} has no https source page`);
    if (entry.id) {
      assert.match(entry.id, /^[a-p]{32}$/, `${entry.name} has a malformed id`);
    } else {
      assert.ok(entry.archive, `${entry.name} has neither a store id nor an archive`);
      updates.githubArchiveUrl(entry.archive);
      assert.ok((entry.treeSha256 || []).includes(entry.archive.treeSha256),
        `${entry.name}: the build offered for install must also be accepted at load`);
    }
    for (const pin of entry.treeSha256 || []) assert.match(pin, /^[0-9a-f]{64}$/, `${entry.name} has a malformed hash`);
  }
});

const drawingComfort = path.join(__dirname, '..', 'dist', 'ext-survey', 'downloads', 'drawing-comfort');
if (fs.existsSync(bitwarden) && fs.existsSync(drawingComfort)) {
  test('the real Bitwarden CRX installs against the shipped list', () => {
    const dir = path.join(TMP, 'install-bitwarden');
    const result = install.install(bitwarden, dir, {});
    assert.equal(result.id, 'nngceckbapebfimnlniiiahkandclblb');
    assert.equal(result.name, 'Bitwarden Password Manager');
    assert.equal(install.verifyInstalled(dir, {}).ready.length, 1);
  });

  test('the real Drawing Comfort folder installs, identified by its contents', () => {
    const dir = path.join(TMP, 'install-drawing');
    const result = install.install(drawingComfort, dir, {});
    assert.equal(result.slug, 'onshape-drawing-comfort');
    assert.equal(install.verifyInstalled(dir, {}).ready.length, 1);
  });

  // What a user actually hits: they point at the folder HOLDING the extensions rather than
  // at one of them.
  refuses('a folder containing extensions, rather than an extension', () => {
    install.install(path.dirname(drawingComfort), path.join(TMP, 'install-parent'), { allowUnsupported: true });
  }, /no manifest\.json/i);

  refuses('a modified Drawing Comfort folder, without the unsupported warning accepted', () => {
    const copy = path.join(TMP, 'drawing-modified');
    fs.cpSync(drawingComfort, copy, { recursive: true, filter: s => path.basename(s) !== '.git' });
    fs.appendFileSync(path.join(copy, 'theme.js'), '\n// added after review\n');
    install.install(copy, path.join(TMP, 'install-drawing-modified'), {});
  }, /not a reviewed build/i);
} else {
  console.log('  skipped the real packages (run npm run ext-survey first)');
}

// Live network checks are opt-in, so the suite never depends on Google or GitHub being up.
if (process.env.TEST_NETWORK === '1') {
  asyncTests.push(() => asyncTest('LIVE: the store offers Bitwarden, and its newest build installs under the shipped list', async () => {
    const id = 'nngceckbapebfimnlniiiahkandclblb';
    const found = (await updates.checkWebstore([id], { fetch: globalThis.fetch, chromeVersion: '152.0.7977.78' })).get(id);
    assert.ok(found, 'the store did not offer Bitwarden');
    const bytes = await updates.downloadCrx(found, { fetch: globalThis.fetch });
    const result = install.installCrx(bytes, path.join(TMP, 'live-bitwarden'), { expectId: id });
    assert.equal(result.version, found.version);
  }));
  asyncTests.push(() => asyncTest('LIVE: GitHub\'s archive of the pinned Drawing Comfort commit installs', async () => {
    const entry = allowlistModule.load().extensions.find(e => e.archive);
    const files = await updates.downloadGithubArchive(entry.archive, { fetch: globalThis.fetch });
    const result = install.installFiles(files, path.join(TMP, 'live-drawing'), {});
    assert.equal(result.key, entry.slug);
  }));
} else {
  console.log('  (live download checks skipped; TEST_NETWORK=1 runs them)');
}

// --- result ------------------------------------------------------------------------------

(async () => {
  for (const run of asyncTests) await run();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`);
    process.exit(1);
  }
})();
