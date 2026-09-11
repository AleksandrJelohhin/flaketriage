#!/usr/bin/env bash
# Harvest real JUnit/xUnit XML reports (with real failures) from public GitHub repos.
set -u
OUT="${HARVEST_DIR:-harvest}/gh_code"
mkdir -p "$OUT"
MANIFEST="$OUT/_manifest.tsv"
: > "$MANIFEST"

QUERIES=(
  "filename:pytest extension:xml testsuite failure"
  "filename:junit extension:xml testsuite failure pytest"
  "filename:results.xml playwright testsuite failure"
  "playwright testsuite failure spec.ts extension:xml"
  "filename:junit.xml jest testsuite failure"
  "filename:test-results.xml testsuite failure"
  "path:surefire-reports extension:xml testcase failure"
  "filename:TEST- extension:xml testsuite failure org.junit"
  "path:build/test-results extension:xml testcase failure"
  "filename:report.xml testsuite failure golang"
  "filename:vitest extension:xml testsuite failure"
  "filename:mocha.xml testsuite failure"
  "filename:rspec extension:xml testsuite failure"
  "extension:xml testsuite failure phpunit assertion"
  "filename:e2e-junit.xml testsuite failure"
  "filename:cypress extension:xml testsuite failure"
  "AssertionError extension:xml testcase failure timeout"
  "ECONNREFUSED extension:xml testsuite failure"
)

fetch_count=0
for q in "${QUERIES[@]}"; do
  echo ">>> QUERY: $q"
  for page in 1 2; do
    lines=$(gh api -X GET search/code -f q="$q" -f per_page=30 -f page=$page \
      --jq '.items[] | [.repository.full_name, .path, .sha] | @tsv' 2>/dev/null)
    [ -z "$lines" ] && { echo "   (no results / rate-limited page $page)"; break; }
    while IFS=$'\t' read -r repo path sha; do
      [ -z "${sha:-}" ] && continue
      safe=$(echo "${repo}__${path}" | tr '/ ' '__' | tr -cd 'A-Za-z0-9_.-')
      fn="$OUT/${safe}"
      [ -f "$fn" ] && continue
      gh api "repos/$repo/git/blobs/$sha" --jq '.content' 2>/dev/null | base64 -d > "$fn" 2>/dev/null
      if [ ! -s "$fn" ]; then rm -f "$fn"; continue; fi
      if grep -qE "<testsuite" "$fn" && grep -qE "<(failure|error)[ >/]" "$fn"; then
        bytes=$(wc -c < "$fn")
        printf '%s\t%s\t%s\n' "$repo" "$path" "$bytes" >> "$MANIFEST"
        fetch_count=$((fetch_count+1))
      else
        rm -f "$fn"
      fi
    done <<< "$lines"
    sleep 1
  done
done

echo "=== harvested files: $fetch_count ==="
wc -l < "$MANIFEST"
