// Quick smoke: parse every real fixture, print stats + any parse failures.
// Run: node --experimental-strip-types scripts/smoke.mjs   (node 22)  — or via tsx.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const { parseJUnitXml } = await import("../src/ingest/junit.ts");
const { fingerprintFailure } = await import("../src/core/fingerprint.ts");
const { normalizeFailure } = await import("../src/core/normalize.ts");

const ROOT = "test/fixtures/real";
const files = [];
for (const fw of readdirSync(ROOT)) {
  const d = join(ROOT, fw);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d)) if (f.endsWith(".xml")) files.push(join(d, f));
}

let ok = 0, failed = 0, totalCases = 0, totalFail = 0;
const errs = [];
const fpSamples = [];
for (const f of files) {
  try {
    const res = parseJUnitXml(readFileSync(f, "utf8"), f);
    ok++;
    totalCases += res.length;
    for (const r of res) {
      if (r.status === "failed" || r.status === "error") {
        totalFail++;
        if (r.failure) {
          const fp = fingerprintFailure(r.failure);
          if (fpSamples.length < 8) {
            const n = normalizeFailure(r.failure);
            fpSamples.push({ f: f.split(/[\\/]/).pop(), test: r.name.slice(0, 50), fp, msg: n.message.split("\n")[0].slice(0, 80), frames: n.frames.slice(0, 2) });
          }
        }
      }
    }
  } catch (e) {
    failed++;
    errs.push(`${f}\n    ${e?.code ?? ""} ${e?.message ?? e}`);
  }
}

console.log(`files: ${files.length}  parsed_ok: ${ok}  parse_failed: ${failed}`);
console.log(`testcases: ${totalCases}  failed/error: ${totalFail}`);
if (errs.length) {
  console.log(`\n--- parse failures (${errs.length}) ---`);
  for (const e of errs.slice(0, 40)) console.log(e);
}
console.log("\n--- fingerprint samples ---");
for (const s of fpSamples) console.log(JSON.stringify(s, null, 1));
