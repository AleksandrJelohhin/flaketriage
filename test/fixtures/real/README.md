# Real JUnit XML corpus

343 JUnit/xUnit XML reports from **243 distinct public repositories**, each
containing at least one real `<failure>` / `<error>` / `<flakyFailure>` / `<rerunFailure>`
from an actual test run. Collected before implementing `normalize.ts` / `fingerprint.ts`
so that normalization is designed against messy real-world input, not synthetic examples.

## Layout

```
real/
  MANIFEST.tsv        file · framework · source_repo · source_path · testcases · failures · errors · bytes · sha256
  <framework>/*.xml   one file per source report; filename encodes source repo + path
```

Totals: ~14,700 testcases · ~2,000 failures/errors. Every supported framework
has real fixtures (asserted by `test/corpus.test.ts`).

| framework      | files | notes |
|----------------|------:|-------|
| surefire-java  | 65 | Maven Surefire; `<flakyFailure>`/`<rerunFailure>` reruns, Apache Pulsar 808-test report, TestNG stacks |
| playwright     | 60 | `spec.ts:line:col` messages, `@tag` annotations, retry attempts, box-drawing banners |
| pytest         | 52 | `file.py:NN:` inline locations, `E   AssertionError` blocks, `_ _ _` separators, container hostnames |
| other          | 48 | junit4 raw, disabled/quarantined tests, XML-entity/unicode edge cases, TAP→junit, Serenity, ctest/gtest, marathon Android, cucumber |
| phpunit        | 20 | `AssertionFailedError`, `.php:NN` frames |
| cypress        | 18 | mocha-style suites, screenshots in `system-out` |
| gradle         | 14 | `build/test-results/test/TEST-*.xml`, JUnit 5 Jupiter, `Gradle Test Executor` suite names |
| testng         | 12 | `TestNG Suite`, `org.testng.*` stacks, opencart/selenium automation projects |
| rspec / jest   | 12 each | Ruby `.rb:NN:in` frames; Jest `Object.<anonymous>` frames, ANSI in messages |
| vitest         | 9 | |
| go             | 7 | gotestsum / go-junit-report: `go1.25.0` property, package classnames, `=== RUN`/`--- FAIL`, `<error type="build">` |
| k6             | 6 | threshold failures (`✗ http_req_duration…`, `✗ errors…: 50%`), no stack traces |
| newman         | 4 | Postman/newman JUnit output (capped) |
| mocha/catch2/cunit | 1–2 each | a few kept for parser robustness |

## Provenance

`MANIFEST.tsv` records `source_repo` and `source_path` for every file. Sources:

- **Fixture libraries** (deliberately-curated diverse cases, kept in full):
  `EnricoMi/publish-unit-test-result-action`, `mikepenz/action-junit-report`,
  `dorny/test-reporter`, `weiwei/junitparser`.
- **GitHub code search** — real reports committed into ~200 live application repos,
  fetched via the GitHub API. Harvest script: [`corpus/harvest_gh.sh`](../../../corpus/harvest_gh.sh);
  raw unfiltered pull retained under [`corpus/gh_code_raw/`](../../../corpus/gh_code_raw/).

Curation ([`corpus/curate.mjs`](../../../corpus/curate.mjs)): require `<testsuite>` +
≥1 failure/error, drop exact-duplicate content, drop LLM-slop repos, cap wild-harvest
files per framework to keep the mix balanced, skip files > 500 KB.

These files are third-party test output reproduced verbatim for use as test input only.
Each remains under the license of its source repository (see `source_repo`).
