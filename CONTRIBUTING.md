# Contributing to FlakeTriage

Thanks for helping! Bug reports, real-world JUnit samples and small focused PRs are
all very welcome.

## Getting started

```bash
npm install
npm test            # vitest, ~300 tests incl. the real-world corpus
npm run typecheck
```

Requires Node 20+. If you change anything the GitHub Action uses, rebuild the bundle
and commit it: `npm run build:action` (writes `action/dist/index.js`).

## Where things live

| Area | File |
|---|---|
| JUnit XML parsing | `src/ingest/junit.ts` |
| Message / stack-trace normalization | `src/core/normalize.ts` |
| Infrastructure-failure signatures | `INFRA_SIGNATURES` in `src/core/classify.ts` |
| Verdict decision tree | `src/core/classify.ts` |
| Diff blame | `src/core/blame.ts` |
| Reports (text / markdown / json) | `src/report/` |

## Good first contributions

Look for issues labelled
[`good first issue`](https://github.com/AleksandrJelohhin/flaketriage/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
Typical ones: a new infra signature, a normalization rule for another CI provider,
or stack-frame support for another language. Each is a few lines of code plus a test.

## Pull request checklist

- Add or update a test for the behaviour you changed (`test/*.test.ts`).
- `npm test` and `npm run typecheck` pass.
- Keep PRs small and focused, one idea per PR.
- New JUnit fixtures must come from public repositories or be written by you, with
  secrets, internal hostnames and personal data removed. Add real-world samples under
  `test/fixtures/real/` with a row in `MANIFEST.tsv`.

## Reporting a wrong verdict

Open a [bug report](https://github.com/AleksandrJelohhin/flaketriage/issues/new?template=bug_report.yml)
with the smallest JUnit XML that reproduces it. Samples of real failures are the
most valuable thing you can contribute.

## License

FlakeTriage is under the [Business Source License 1.1](LICENSE). By submitting a
contribution you agree it is licensed under the same terms.
