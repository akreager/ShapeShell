'use strict';

// Unit tests for the CRX and zip readers (extensions phase 3). Plain Node, no Electron:
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

const TMP = path.join(__dirname, '..', 'dist', 'test-extensions');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const testKeyId = crx.idFromPublicKey(key.publicKey.export({ type: 'spki', format: 'der' }));

// An allowlist built around the test key, so installs can be exercised without shipping a
// real extension's bytes into the test.
function allowlistFor(overrides = {}) {
  return {
    version: 1,
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

function crxWith(manifestOverrides, files = []) {
  const body = JSON.stringify({ manifest_version: 3, name: 'Test extension', version: '1.0.0', ...manifestOverrides });
  return buildCrx({ zipBuffer: buildZip([{ name: 'manifest.json', data: body }, ...files]), key });
}

function writeCrx(name, buffer) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, buffer);
  return file;
}

console.log('\nInstalling');

test('an allowlisted, pinned CRX installs and records a marker', () => {
  const buf = crxWith({}, [{ name: 'background.js', data: 'console.log(1)' }]);
  const file = writeCrx('good.crx', buf);
  const dir = path.join(TMP, 'install-good');
  const result = install.install(file, dir, {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
  assert.equal(result.id, testKeyId);
  assert.equal(result.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(result.path, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(result.path, 'background.js')));
  assert.ok(fs.existsSync(path.join(dir, testKeyId, install.MARKER)));

  const { ready, skipped } = install.verifyInstalled(dir, {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
  assert.equal(skipped.length, 0, `unexpectedly skipped: ${JSON.stringify(skipped)}`);
  assert.equal(ready.length, 1);
});

refuses('a CRX whose id is not listed', () => {
  const buf = crxWith({});
  install.install(writeCrx('unlisted.crx', buf), path.join(TMP, 'install-unlisted'), {
    allowlist: allowlistFor({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', crxSha256: [allowlistModule.sha256(buf)] }),
  });
}, /not on the allowlist/i);

refuses('a build whose hash was never reviewed', () => {
  const buf = crxWith({ version: '9.9.9' });
  install.install(writeCrx('unreviewed.crx', buf), path.join(TMP, 'install-unreviewed'), {
    allowlist: allowlistFor({ crxSha256: ['0'.repeat(64)] }),
  });
}, /not a reviewed build/i);

refuses('a Manifest V2 extension', () => {
  const buf = crxWith({ manifest_version: 2 });
  install.install(writeCrx('mv2.crx', buf), path.join(TMP, 'install-mv2'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
}, /only V3/i);

refuses('a permission the entry does not approve', () => {
  const buf = crxWith({ permissions: ['storage', 'debugger'] });
  install.install(writeCrx('perms.crx', buf), path.join(TMP, 'install-perms'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
}, /Permissions not approved.*debugger/i);

refuses('host permissions beyond the entry', () => {
  const buf = crxWith({ host_permissions: ['<all_urls>'] });
  install.install(writeCrx('hosts.crx', buf), path.join(TMP, 'install-hosts'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)], hostPermissions: ['https://cad.onshape.com/*'] }),
  });
}, /Host permissions not approved/i);

refuses('content scripts matching more than the entry approves', () => {
  const buf = crxWith({ content_scripts: [{ matches: ['*://*/*'], js: ['a.js'] }] });
  install.install(writeCrx('scripts.crx', buf), path.join(TMP, 'install-scripts'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)], contentScriptMatches: ['https://*.onshape.com/*'] }),
  });
}, /Content script matches not approved/i);

refuses('a version older than the reviewed one', () => {
  const buf = crxWith({ version: '0.9.0' });
  install.install(writeCrx('old.crx', buf), path.join(TMP, 'install-old'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)], minVersion: '1.0.0' }),
  });
}, /older than the reviewed/i);

refuses('a package that tries to write outside its directory', () => {
  const buf = buildCrx({
    zipBuffer: buildZip([
      { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0' }) },
      { name: '../escape.js', data: 'owned' },
    ]),
    key,
  });
  install.install(writeCrx('slip.crx', buf), path.join(TMP, 'install-slip'), {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
}, /traversal/i);

console.log('\nRe-verifying on every launch');

test('files changed on disk are refused at load', () => {
  const buf = crxWith({}, [{ name: 'background.js', data: 'console.log(1)' }]);
  const dir = path.join(TMP, 'install-tamper');
  const list = allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] });
  const result = install.install(writeCrx('tamper.crx', buf), dir, { allowlist: list });

  fs.writeFileSync(path.join(result.path, 'background.js'), 'console.log("modified after install")');
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: list });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /changed on disk/i);
});

test('an extension dropped from the allowlist is not loaded', () => {
  const buf = crxWith({});
  const dir = path.join(TMP, 'install-dropped');
  install.install(writeCrx('dropped.crx', buf), dir, {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
  const { ready, skipped } = install.verifyInstalled(dir, { version: 1, extensions: [] });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /no longer on the allowlist/i);
});

test('a build that stops being a reviewed one is not loaded', () => {
  const buf = crxWith({});
  const dir = path.join(TMP, 'install-unpinned');
  install.install(writeCrx('unpinned.crx', buf), dir, {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
  const { ready, skipped } = install.verifyInstalled(dir, { allowlist: allowlistFor({ crxSha256: ['0'.repeat(64)] }) });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].reasons.join(' '), /no longer a reviewed one/i);
});

test('uninstall removes the files', () => {
  const buf = crxWith({});
  const dir = path.join(TMP, 'install-remove');
  install.install(writeCrx('remove.crx', buf), dir, {
    allowlist: allowlistFor({ crxSha256: [allowlistModule.sha256(buf)] }),
  });
  install.uninstall(dir, testKeyId);
  assert.equal(install.verifyInstalled(dir, { allowlist: allowlistFor() }).ready.length, 0);
  assert.equal(fs.existsSync(path.join(dir, testKeyId)), false);
});

console.log('\nThe shipped allowlist');

test('it parses, and every entry has an identity and a pin', () => {
  const shipped = allowlistModule.load();
  assert.ok(shipped.extensions.length > 0);
  for (const entry of shipped.extensions) {
    assert.ok(entry.name && entry.slug, `entry without a name or slug: ${JSON.stringify(entry)}`);
    const pins = [...(entry.crxSha256 || []), ...(entry.treeSha256 || [])];
    assert.ok(pins.length > 0, `${entry.name} has no pinned build`);
    for (const pin of pins) assert.match(pin, /^[0-9a-f]{64}$/, `${entry.name} has a malformed hash`);
    if (entry.id) assert.match(entry.id, /^[a-p]{32}$/, `${entry.name} has a malformed id`);
  }
});

const drawingComfort = path.join(__dirname, '..', 'dist', 'ext-survey', 'downloads', 'drawing-comfort');
if (fs.existsSync(bitwarden) && fs.existsSync(drawingComfort)) {
  test('the real Bitwarden CRX installs against the shipped allowlist', () => {
    const dir = path.join(TMP, 'install-bitwarden');
    const result = install.install(bitwarden, dir, {});
    assert.equal(result.id, 'nngceckbapebfimnlniiiahkandclblb');
    assert.ok(fs.existsSync(path.join(result.path, 'manifest.json')));
    assert.equal(install.verifyInstalled(dir, {}).ready.length, 1);
  });

  test('the real Drawing Comfort folder installs, identified by its contents', () => {
    const dir = path.join(TMP, 'install-drawing');
    const result = install.install(drawingComfort, dir, {});
    assert.equal(result.slug, 'onshape-drawing-comfort');
    assert.ok(fs.existsSync(path.join(result.path, 'manifest.json')));
    assert.equal(install.verifyInstalled(dir, {}).ready.length, 1);
  });

  refuses('an unpacked folder whose contents were modified', () => {
    const copy = path.join(TMP, 'drawing-modified');
    fs.cpSync(drawingComfort, copy, { recursive: true, filter: s => path.basename(s) !== '.git' });
    fs.appendFileSync(path.join(copy, 'theme.js'), '\n// added after review\n');
    install.install(copy, path.join(TMP, 'install-drawing-modified'), {});
  }, /not a reviewed build/i);
} else {
  console.log('  skipped the real packages (run npm run ext-survey first)');
}

// --- result ------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const { name, error } of failures) console.error(`\n${name}\n${error.stack}`);
  process.exit(1);
}
