import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { unzip } from "../../src/ingest/zip.js";

/** Minimal ZIP writer (STORE or DEFLATE) — just enough to round-trip through `unzip`. */
function buildZip(files: { name: string; content: string; deflate?: boolean }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.content, "utf8");
    const method = f.deflate ? 8 : 0;
    const data = f.deflate ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(0, 14); // crc32 (unused by our reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localHeaderOffset = offset;
    localParts.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(central, nameBuf);
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

describe("unzip", () => {
  it("reads a STORE (uncompressed) entry", () => {
    const zip = buildZip([{ name: "junit.xml", content: "<testsuite/>" }]);
    const entries = unzip(zip);
    expect(entries).toEqual([{ name: "junit.xml", data: Buffer.from("<testsuite/>") }]);
  });

  it("reads a DEFLATE-compressed entry", () => {
    const xml = "<testsuite>".repeat(200) + "</testsuite>";
    const zip = buildZip([{ name: "big.xml", content: xml, deflate: true }]);
    const entries = unzip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.toString("utf8")).toBe(xml);
  });

  it("reads multiple entries in order", () => {
    const zip = buildZip([
      { name: "a.xml", content: "A" },
      { name: "b.xml", content: "B", deflate: true },
      { name: "c.xml", content: "C" },
    ]);
    expect(unzip(zip).map((e) => e.name)).toEqual(["a.xml", "b.xml", "c.xml"]);
  });

  it("skips directory entries (names ending in /)", () => {
    const zip = buildZip([{ name: "dir/", content: "" }, { name: "dir/f.xml", content: "x" }]);
    expect(unzip(zip).map((e) => e.name)).toEqual(["dir/f.xml"]);
  });

  it("throws a clear error for a non-zip buffer", () => {
    expect(() => unzip(Buffer.from("not a zip"))).toThrow(/not a zip/);
  });

  it("throws for an unsupported compression method", () => {
    const zip = buildZip([{ name: "a.xml", content: "x" }]);
    // the reader takes `method` from the CENTRAL directory record — find it
    // (0x02014b50) and overwrite its method field with something bogus (12 = BZIP2)
    const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThan(0);
    zip.writeUInt16LE(12, centralOffset + 10);
    expect(() => unzip(zip)).toThrow(/compression method/);
  });
});
