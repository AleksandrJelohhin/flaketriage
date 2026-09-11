# FlakeTriage GitHub Action

Runs `flaketriage run` on a pull request's JUnit reports and posts one sticky
verdict comment.

## Usage

```yaml
# .github/workflows/flaketriage.yml
name: FlakeTriage
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # to post the sticky comment
  actions: write         # for actions/cache

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # FlakeTriage needs base..head to diff

      # … your build + test steps that produce JUnit XML …
      - run: ./gradlew test || true      # keep going so FlakeTriage can classify

      - uses: AleksandrJelohhin/flaketriage@v1
        with:
          reports: "**/build/test-results/**/*.xml"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional
          fail-on: regression
```

The action does **not** run your tests — point `reports` at the XML your existing
test step already writes, and let that step continue on failure (`|| true`,
`continue-on-error: true`, or `if: always()`).

## Inputs

| input | default | notes |
|---|---|---|
| `reports` | `**/junit*.xml,**/TEST-*.xml` | comma- or newline-separated globs |
| `working-directory` | `.` | repo checkout path |
| `db-path` | `.flaketriage/history.db` | history DB (within `working-directory`) |
| `fail-on` | `regression` | `regression` \| `any` \| `never` |
| `attempt` | `github.run_attempt` | CI retry number — drives `flake_confirmed` |
| `provider` | `auto` | `auto` \| `anthropic` \| `bedrock` \| `vertex` \| `foundry` \| `custom` \| `gemini` \| `openai` \| `local` \| `openai-compatible` \| `none` — non-Anthropic keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`) go in the step's `env:` |
| `llm-model` / `llm-base-url` | — | override the provider default / point at a local server |
| `anthropic-api-key` | — | enables escalation with the default provider |
| `comment` | `true` | post/update the sticky PR comment |
| `github-token` | `${{ github.token }}` | needs `pull-requests: write` |

## Outputs

`regressions`, `needs-attention`, `failed`, `cost-usd`, `report-markdown`, `report-summary`,
`report-json`.

## The sticky comment

FlakeTriage keeps **one** comment per PR, found by the hidden marker
`<!-- flaketriage -->` on its first line, and edits it in place on every push —
it never adds a second comment. The same Markdown is always written to the job
summary.

## ⚠️ History persistence: known limitations

FlakeTriage's verdicts depend on run history (did this test flip on unchanged
code? did the same fingerprint appear across branches?). This action persists the
SQLite history DB between runs with **`actions/cache`**, keyed on
`flaketriage-<repo>-<run_id>-<run_attempt>` and restored with the
`flaketriage-<repo>-` prefix.

This is **lossy by design**:

- `actions/cache` entries are **evicted after 7 days of no reads** and when the
  repo's 10 GB cache budget is exceeded — old history silently disappears.
- Caches are **branch-scoped**: a run on a feature branch can only read caches
  from that branch, its base, or the default branch. History does not flow
  freely between unrelated branches, which is exactly the cross-branch signal
  FlakeTriage wants.
- Concurrent runs race to `save` the same key; the last writer wins and the
  others' results are dropped.

So the deterministic classifier will be **less confident** than it would be with
a real shared history store — more verdicts land as `ambiguous` (and get
escalated to the model, or reported as unclear). A durable, shared history store is planned for a future release.

For a usable local history today, run the CLI (`flaketriage run`) on a machine
that keeps `.flaketriage/history.db` around.

## Build

The bundled entrypoint `action/dist/index.js` is committed. Rebuild after
changing `action/` or `src/`:

```bash
npm run build:action
```
