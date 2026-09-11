/**
 * zip.ts — minimal ZIP reader for GitHub Actions artifact archives.
 *
 * No dependency: GH artifact ZIPs are plain (non-zip64) archives using STORE or
 * DEFLATE, and Node's built-in `zlib.inflateRawSync` decodes DEFLATE directly.
 * Reads the End-of-Central-Directory record, walks the central directory, and
 * pulls each entry's bytes from its local file header.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf: Buffer): number {
  const minLen = 22;
  if (buf.length < minLen) throw new Error("not a zip file (too short)");
  const searchStart = Math.max(0, buf.length - minLen - 65535);
  for (let i = buf.length - minLen; i >= searchStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip file (no end-of-central-directory record)");
}

/** Extract every file entry (directories skipped) from a ZIP buffer. */
export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`corrupt central directory entry at offset ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (!name.endsWith("/")) {
      entries.push({ name, data: readLocalEntry(buf, localHeaderOffset, method, compSize) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readLocalEntry(
  buf: Buffer,
  offset: number,
  method: number,
  compSize: number,
): Buffer {
  if (buf.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new Error(`corrupt local file header at offset ${offset}`);
  }
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${method}`);
}
