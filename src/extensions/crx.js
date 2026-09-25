'use strict';

// CRX3 parsing, identity and signature verification (extensions phase 3).
//
// A CRX3 file is:
//   "Cr24" | uint32le version (3) | uint32le header length | header protobuf | zip archive
//
// The header carries one or more key/signature proofs and a signed-data blob naming the
// extension id. What is signed is:
//   "CRX3 SignedData\x00" | uint32le(len(signed_header_data)) | signed_header_data | zip
//
// The signature proves the file is internally consistent — that whoever holds the private
// key for this id produced it. It says nothing about whether that author is trustworthy:
// that is the supported list's job, which names the ids we accept and caps what their
// manifests may ask for (allowlist.js).

const crypto = require('node:crypto');

const MAGIC = 'Cr24';
const MAX_HEADER_BYTES = 1024 * 1024;
const SIGNATURE_CONTEXT = Buffer.concat([Buffer.from('CRX3 SignedData'), Buffer.from([0])]);

// Field numbers in CrxFileHeader / SignedData.
const FIELD_SHA256_RSA = 2;
const FIELD_SHA256_ECDSA = 3;
const FIELD_SIGNED_HEADER_DATA = 10000;
const FIELD_PROOF_PUBLIC_KEY = 1;
const FIELD_PROOF_SIGNATURE = 2;
const FIELD_SIGNED_CRX_ID = 1;

// --- minimal protobuf reader: varints and length-delimited fields are all this needs -----

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, pos };
    shift += 7;
    if (shift > 49) break;
  }
  throw new Error('Malformed CRX header: bad varint');
}

function readMessage(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType === 2) {
      const length = readVarint(buf, pos);
      pos = length.pos;
      const end = pos + length.value;
      if (end > buf.length) throw new Error('Malformed CRX header: field runs past the end');
      if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
      fields.get(fieldNumber).push(buf.subarray(pos, end));
      pos = end;
    } else if (wireType === 0) {
      pos = readVarint(buf, pos).pos;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      throw new Error(`Malformed CRX header: unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

// --- identity ----------------------------------------------------------------------------

/**
 * Chrome's extension id: the first 16 bytes of SHA-256 over the public key (DER
 * SubjectPublicKeyInfo), each nibble mapped from 0-f to a-p.
 */
function idFromPublicKey(publicKeyDer) {
  const digest = crypto.createHash('sha256').update(publicKeyDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

function idFromBytes(crxIdBytes) {
  let id = '';
  for (const byte of crxIdBytes) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

// --- parsing and verification ------------------------------------------------------------

/**
 * Splits a CRX3 file into its header and zip archive.
 * Returns { version, signedHeaderData, proofs, zip, declaredId }.
 */
function parse(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('Not a CRX file');
  const version = buf.readUInt32LE(4);
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}; only CRX3 is accepted`);
  const headerLength = buf.readUInt32LE(8);
  if (headerLength > MAX_HEADER_BYTES || 12 + headerLength > buf.length) {
    throw new Error('Malformed CRX: header length is out of range');
  }

  const header = readMessage(buf.subarray(12, 12 + headerLength));
  const signedHeaderData = header.get(FIELD_SIGNED_HEADER_DATA)?.[0];
  if (!signedHeaderData) throw new Error('Malformed CRX: no signed header data');

  const crxId = readMessage(signedHeaderData).get(FIELD_SIGNED_CRX_ID)?.[0];
  if (!crxId || crxId.length !== 16) throw new Error('Malformed CRX: no extension id in the signed header');

  const proofs = [];
  for (const [field, algorithm] of [[FIELD_SHA256_RSA, 'rsa'], [FIELD_SHA256_ECDSA, 'ecdsa']]) {
    for (const proofBytes of header.get(field) || []) {
      const proof = readMessage(proofBytes);
      const publicKey = proof.get(FIELD_PROOF_PUBLIC_KEY)?.[0];
      const signature = proof.get(FIELD_PROOF_SIGNATURE)?.[0];
      if (publicKey && signature) proofs.push({ algorithm, publicKey, signature });
    }
  }
  if (proofs.length === 0) throw new Error('Malformed CRX: no signatures');

  return {
    version,
    signedHeaderData,
    proofs,
    zip: buf.subarray(12 + headerLength),
    declaredId: idFromBytes(crxId),
  };
}

/**
 * Verifies that a proof whose key derives the declared id signed this exact file.
 * Returns { id, publicKey, algorithm }; throws otherwise.
 */
function verify(buf) {
  const crx = parse(buf);

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(crx.signedHeaderData.length);
  const signedPayload = Buffer.concat([SIGNATURE_CONTEXT, lengthPrefix, crx.signedHeaderData, crx.zip]);

  // Only the proof whose key matches the declared id counts: a file may carry others, and a
  // valid signature from an unrelated key would prove nothing about this extension.
  const matching = crx.proofs.filter(proof => idFromPublicKey(proof.publicKey) === crx.declaredId);
  if (matching.length === 0) {
    throw new Error('CRX signature does not match its declared extension id');
  }

  for (const proof of matching) {
    let keyObject;
    try {
      keyObject = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
    } catch (e) {
      throw new Error(`CRX public key could not be read: ${e.message}`);
    }
    const ok = proof.algorithm === 'rsa'
      ? crypto.verify('sha256', signedPayload, { key: keyObject, padding: crypto.constants.RSA_PKCS1_PADDING }, proof.signature)
      : crypto.verify('sha256', signedPayload, keyObject, proof.signature);
    if (ok) return { id: crx.declaredId, publicKey: proof.publicKey, algorithm: proof.algorithm, zip: crx.zip };
  }
  throw new Error('CRX signature is not valid for this file');
}

module.exports = { parse, verify, idFromPublicKey, idFromBytes };
