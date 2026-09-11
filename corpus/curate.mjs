// Curate harvested XML into repo test fixtures with provenance.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { createHash } from "node:crypto";

// HARVEST_DIR = where corpus/harvest_gh.sh wrote its output (default ./harvest).
const HARVEST = (process.env.HARVEST_DIR ?? "harvest").replace(/\\/g, "/");
const GH = HARVEST + "/gh_code";
const DEST = new URL("../test/fixtures/real", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// provenance for gh_code files
const ghProv = new Map(); // safeFilename -> {repo, path}
for (const line of readFileSync(GH + "/_manifest.tsv", "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [repo, path] = line.split("\t");
  const safe = (repo + "__" + path).replace(/[\/ ]/g, "_").replace(/[^A-Za-z0-9_.-]/g, "");
  ghProv.set(safe, { repo, path });
}

const CLONE_REPO = {
  "EnricoMi_publish-unit-test-result-action": "EnricoMi/publish-unit-test-result-action",
  "mikepenz_action-junit-report": "mikepenz/action-junit-report",
  "dorny_test-reporter": "dorny/test-reporter",
  "weiwei_junitparser": "weiwei/junitparser",
  "jest-community_jest-junit": "jest-community/jest-junit",
  "michaelleeallen_mocha-junit-reporter": "michaelleeallen/mocha-junit-reporter",
};

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === ".git") continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, acc);
    else if (extname(p).toLowerCase() === ".xml") acc.push(p);
  }
  return acc;
}

function detectFw(s, path) {
  const p = path.toLowerCase();
  const has = (re) => re.test(s);
  // strongest signals first
  if (has(/\bplaywright\b/i) || has(/projectName="(chromium|firefox|webkit)"/)) return "playwright";
  if (has(/PHPUnit|phpunit/) || has(/\bvendor\/(phpunit|bin)\b/) || has(/\.php:\d+/) && has(/AssertionFailedError|PHPUnit/)) return "phpunit";
  if (has(/<testcase[^>]*classname="[^"]*"[^>]*file="[^"]*\.py"/) || has(/_pytest|conftest\.py/) || (has(/\.py:\d+:/) && has(/E\s+(assert|[A-Za-z]*Error)/))) return "pytest";
  if (has(/org\.junit\.|org\.testng\.|at [\w.$]+\([\w$]+\.java:\d+\)/) || /surefire|junitreports|test-results[\/_]test/.test(p)) return "surefire-java";
  if (has(/rspec|\bRSpec\b/) || has(/\.rb:\d+:in /)) return "rspec";
  if (has(/vitest/i) || /vitest/.test(p)) return "vitest";
  if (has(/\bcypress\b/i) || /cypress/.test(p)) return "cypress";
  if (has(/\bmocha\b/i) || /mocha/.test(p)) return "mocha";
  if (has(/jest/i) || /jest/.test(p) || has(/at Object\.<anonymous> \([^)]*\.test\.[jt]sx?:/)) return "jest";
  if (has(/newman|postman/i) || /newman/.test(p)) return "newman";
  if (has(/<test-run|nunit/i)) return "nunit";
  if (has(/catch2|Catch2/) || /catch2/.test(p)) return "catch2";
  if (has(/CUnit/i) || /cunit/.test(p)) return "cunit";
  if (has(/go test|_test\.go|--- FAIL/) || /gotest|go-junit|go-surefire/.test(p)) return "go";
  if (has(/scalatest|ScalaTest/) || /scalatest/.test(p)) return "scalatest";
  return "other";
}

const files = [...walk(HARVEST)];
const seen = new Set();
const kept = [];
const rejected = { dup: 0, nofail: 0, notjunit: 0, tooBig: 0, tiny: 0, junkRepo: 0, capped: 0 };
const JUNK = /autoGpt|Afrobeats|Ryzomatic|division_auto|_autoGpt|GPT.?Engineer/i;
const perFwCap = { newman: 4, "surefire-java": 60, pytest: 60, playwright: 60, phpunit: 20, cypress: 18, jest: 22, rspec: 18 };
const fwCount = {};

for (const f of files.sort()) {
  let s; try { s = readFileSync(f, "utf8"); } catch { continue; }
  if (!/<testsuite/.test(s)) { rejected.notjunit++; continue; }
  const nFail = (s.match(/<(failure|flakyFailure|rerunFailure)[ >]/g) || []).length;
  const nErr = (s.match(/<(error|flakyError|rerunError)[ >]/g) || []).length;
  const nCase = (s.match(/<testcase[ >]/g) || []).length;
  if (nFail + nErr === 0) { rejected.nofail++; continue; }
  if (s.length < 200) { rejected.tiny++; continue; }
  if (s.length > 500_000) { rejected.tooBig++; continue; }
  const norm = s.replace(/\s+/g, " ").replace(/time="[\d.]+"/g, "").trim();
  const h = createHash("sha256").update(norm).digest("hex");
  if (seen.has(h)) { rejected.dup++; continue; }

  const base = f.replace(/\\/g, "/").split("/").pop();
  let prov = ghProv.get(base);
  if (!prov) {
    const rel = relative(HARVEST, f).replace(/\\/g, "/");
    const top = rel.split("/")[0];
    prov = { repo: CLONE_REPO[top] || top, path: rel.split("/").slice(1).join("/") };
  }
  if (JUNK.test(prov.repo)) { rejected.junkRepo++; continue; }

  const fw = detectFw(s, prov.path || base);
  fwCount[fw] = (fwCount[fw] || 0) + 1;
  // The four fixture-library repos are deliberately-curated diverse cases: never cap them.
  const isFixtureLib = /^(EnricoMi\/publish-unit-test-result-action|mikepenz\/action-junit-report|dorny\/test-reporter|weiwei\/junitparser)$/.test(prov.repo);
  const cap = perFwCap[fw] ?? 30;
  if (!isFixtureLib && fwCount[fw] > cap) { rejected.capped++; continue; }

  seen.add(h);
  kept.push({ f, fw, prov, nCase, nFail, nErr, bytes: s.length, sha256: createHash("sha256").update(s).digest("hex").slice(0, 16), content: s });
}

// write
rmSync(DEST, { recursive: true, force: true });
const manifest = ["file\tframework\tsource_repo\tsource_path\ttestcases\tfailures\terrors\tbytes\tsha256"];
const byFw = {};
for (const k of kept) {
  byFw[k.fw] = (byFw[k.fw] || 0) + 1;
  const dir = join(DEST, k.fw);
  mkdirSync(dir, { recursive: true });
  let name = (k.prov.repo.replace(/[\/]/g, "_") + "__" + (k.prov.path || "").replace(/[\/]/g, "_"))
    .replace(/[^A-Za-z0-9_.-]/g, "").replace(/(\.xml)?$/i, "").slice(0, 120) + ".xml";
  const out = join(dir, name);
  writeFileSync(out, k.content);
  manifest.push([relative(DEST, out).replace(/\\/g, "/"), k.fw, k.prov.repo, k.prov.path, k.nCase, k.nFail, k.nErr, k.bytes, k.sha256].join("\t"));
}
mkdirSync(DEST, { recursive: true });
writeFileSync(join(DEST, "MANIFEST.tsv"), manifest.join("\n") + "\n");

console.log("scanned:", files.length, "  kept:", kept.length);
console.log("rejected:", JSON.stringify(rejected));
console.log("\nkept by framework:");
for (const [k, v] of Object.entries(byFw).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(15)} ${v}`);
console.log("\ndistinct source repos:", new Set(kept.map(k => k.prov.repo)).size);
console.log("total corpus bytes:", kept.reduce((a, k) => a + k.bytes, 0));
