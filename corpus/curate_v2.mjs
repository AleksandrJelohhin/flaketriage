// Curate the v2 harvest batch into test/fixtures/real/{go,k6,testng,gradle,...}
import { readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// HARVEST_DIR = where corpus/harvest_v2.sh wrote its output (default ./harvest).
const V = ((process.env.HARVEST_DIR ?? "harvest") + "/v2").replace(/\\/g, "/");
const DEST = new URL("../test/fixtures/real", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MAN = join(DEST, "MANIFEST.tsv");

const prov = new Map();
for (const line of readFileSync(join(V, "_manifest.tsv"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [repo, path] = line.split("\t");
  const safe = (repo + "__" + path).replace(/[\/ ]/g, "_").replace(/[^A-Za-z0-9_.-]/g, "");
  prov.set(safe, { repo, path });
}

// existing content hashes so we don't add dups already in the corpus
const existing = new Set();
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else if (e.name.endsWith(".xml"))
      existing.add(hash(readFileSync(join(d, e.name), "utf8")));
  }
}
walk(DEST);
function hash(s) {
  return createHash("sha256").update(s.replace(/\s+/g, " ").replace(/time="[\d.]+"/g, "").trim()).digest("hex");
}

function fw(s, path) {
  const p = path.toLowerCase();
  if (/\bk6\b|checks\.\.\.|http_req_duration|thresholds|xk6/i.test(s) || /k6/.test(p)) return "k6";
  if (/gotestsum|=== RUN |--- FAIL:|--- PASS:|\bgo1\.\d+|_test\.go/i.test(s) || /gotest|gotestsum/.test(p)) return "go";
  if (/org\.testng\.|testng/i.test(s) || /testng/.test(p)) return "testng";
  if (/Gradle Test Executor|Gradle#20Test|org\.junit\.jupiter|org\.gradle/i.test(s) || /gradle|build\/test-results/.test(p)) return "gradle";
  if (/org\.junit\.|\.java:\d+\)/.test(s)) return "surefire-java";
  return "other";
}

const caps = { k6: 6, go: 12, testng: 12, gradle: 14, "surefire-java": 3, other: 3 };
const counts = {};
const added = [];
const manLines = [];

for (const f of readdirSync(V).sort()) {
  if (f.startsWith("_")) continue;
  const s = readFileSync(join(V, f), "utf8");
  if (!/<testsuite/.test(s)) continue;
  const nFail = (s.match(/<(failure|error|flakyFailure|rerunFailure)[ >]/g) || []).length;
  if (nFail === 0) continue;
  if (s.length > 500_000 || s.length < 200) continue;
  const h = hash(s);
  if (existing.has(h)) continue;
  const pr = prov.get(f) ?? { repo: f, path: f };
  const framework = fw(s, pr.path);
  counts[framework] = (counts[framework] || 0) + 1;
  if (counts[framework] > (caps[framework] ?? 3)) continue;
  existing.add(h);

  const dir = join(DEST, framework);
  mkdirSync(dir, { recursive: true });
  const name =
    (pr.repo.replace(/\//g, "_") + "__" + pr.path.replace(/\//g, "_"))
      .replace(/[^A-Za-z0-9_.-]/g, "").replace(/(\.xml)?$/i, "").slice(0, 120) + ".xml";
  writeFileSync(join(dir, name), s);
  const cases = (s.match(/<testcase[ >]/g) || []).length;
  const errs = (s.match(/<error[ >]/g) || []).length;
  const fails = (s.match(/<failure[ >]/g) || []).length;
  manLines.push([`${framework}/${name}`, framework, pr.repo, pr.path, cases, fails, errs, s.length, createHash("sha256").update(s).digest("hex").slice(0, 16)].join("\t"));
  added.push(`${framework}/${name}`);
}

appendFileSync(MAN, manLines.join("\n") + "\n");
console.log("added", added.length, "files");
console.log(counts);
for (const a of added) console.log("  " + a);
