'use strict';

// A deliberately small, strict ZIP reader for extension packages (extensions phase 3).
//
// Written rather than pulled in, because this parses attacker-influenced bytes and the whole
// point of the allowlist is to keep that surface small and reviewable. It reads only what a
// CRX contains: stored and deflated entries, no encryption, no zip64.
//
// Everything a malicious archive would try is refused here: absolute paths, traversal out of
// the destination, symlinks, absurd file counts and sizes, and CRC mismatches.

const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65557; // 22-byte record plus the largest possible comment
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

// Unix mode bits live in the high half of external attributes.
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const DEFAULTS = {
  maxFiles: 5000,
  maxTotalBytes: 400 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxNameLength: 255,
};

function findEndOfCentralDirectory(buf) {
  const start = Math.max(0, buf.length - MAX_EOCD_SEARCH);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record');
}

// Refuses anything that could write outside the destination directory.
function checkName(name, limits) {
  if (!name) throw new Error('Zip entry with an empty name');
  if (name.length > limits.maxNameLength) throw new Error(`Zip entry name too long: ${name.slice(0, 40)}…`);
  if (name.includes('\0')) throw new Error('Zip entry name contains a NUL byte');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`Absolute path in zip entry: ${name}`);
  if (name.includes('\\')) throw new Error(`Backslash in zip entry name: ${name}`);
  if (name.split('/').some(part => part === '..')) throw new Error(`Path traversal in zip entry: ${name}`);
}

/**
 * Lists every entry in the archive without decompressing it.
 * Returns [{ name, isDirectory, compressedSize, uncompressedSize, method, crc32, offset, mode }]
 */
function listEntries(buf, options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);

  if (entryCount === ZIP64_MARKER_16 || directoryOffset === ZIP64_MARKER_32 || directorySize === ZIP64_MARKER_32) {
    throw new Error('zip64 archives are not supported');
  }
  if (entryCount > limits.maxFiles) throw new Error(`Zip has too many entries: ${entryCount} > ${limits.maxFiles}`);
  if (directoryOffset + directorySize > buf.length) throw new Error('Zip central directory runs past the end of the file');

  const entries = [];
  let cursor = directoryOffset;
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(cursor + 10);
    const crc32 = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const externalAttributes = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (compressedSize === ZIP64_MARKER_32 || uncompressedSize === ZIP64_MARKER_32 || localOffset === ZIP64_MARKER_32) {
      throw new Error('zip64 entries are not supported');
    }
    checkName(name, limits);

    const mode = (externalAttributes >>> 16) & 0xffff;
    if ((mode & S_IFMT) === S_IFLNK) throw new Error(`Symlink in zip entry: ${name}`);
    if (uncompressedSize > limits.maxFileBytes) {
      throw new Error(`Zip entry too large: ${name} is ${uncompressedSize} bytes`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) throw new Error('Zip contents exceed the size limit');

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      offset: localOffset,
      mode,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decompresses one entry and verifies its size and checksum. */
function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) throw new Error(`Corrupt local header for ${entry.name}`);
  const nameLength = buf.readUInt16LE(entry.offset + 26);
  const extraLength = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`Zip entry data runs past the end of the file: ${entry.name}`);
  const raw = buf.subarray(start, end);

  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize + 1 });
  else throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`Zip entry size mismatch for ${entry.name}: ${data.length} != ${entry.uncompressedSize}`);
  }
  if (crc32(data) !== entry.crc32) throw new Error(`Zip entry checksum mismatch for ${entry.name}`);
  return data;
}

module.exports = { listEntries, readEntry, crc32, DEFAULTS };
