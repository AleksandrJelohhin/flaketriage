#!/usr/bin/env bash
# Harvest gotestsum + k6 + explicit testng/gradle JUnit reports for the v2 fixture set.
set -u
OUT="${HARVEST_DIR:-harvest}/v2"
mkdir -p "$OUT"
MANIFEST="$OUT/_manifest.tsv"
: > "$MANIFEST"

QUERIES=(
  "gotestsum testsuite failure extension:xml"
  "filename:gotestsum.xml testsuite"
  "\"go test\" testsuite failure --- FAIL extension:xml"
  "filename:unit-tests.xml testsuite go failure"
  "k6 checks testsuite failure extension:xml"
  "filename:k6-junit.xml testsuite"
  "filename:junit.xml k6 thresholds testsuite"
  "xk6 testsuite failure extension:xml"
  "testng testsuite failure org.testng extension:xml"
  "path:build/test-results/test testng failure extension:xml"
  "gradle testsuite skipped failure org.junit.jupiter extension:xml"
)

for q in "${QUERIES[@]}"; do
  echo ">>> $q"
  for page in 1 2; do
    lines=$(gh api -X GET search/code -f q="$q" -f per_page=30 -f page=$page \
      --jq '.items[] | [.repository.full_name, .path, .sha] | @tsv' 2>/dev/null)
    [ -z "$lines" ] && { echo "   (none)"; break; }
    while IFS=$'\t' read -r repo path sha; do
      [ -z "${sha:-}" ] && continue
      safe=$(echo "${repo}__${path}" | tr '/ ' '__' | tr -cd 'A-Za-z0-9_.-')
      fn="$OUT/${safe}"
      [ -f "$fn" ] && continue
      gh api "repos/$repo/git/blobs/$sha" --jq '.content' 2>/dev/null | base64 -d > "$fn" 2>/dev/null
      [ ! -s "$fn" ] && { rm -f "$fn"; continue; }
      if grep -qE "<testsuite" "$fn" && grep -qE "<(failure|error)[ >/]" "$fn"; then
        printf '%s\t%s\t%s\n' "$repo" "$path" "$(wc -c < "$fn")" >> "$MANIFEST"
      else
        rm -f "$fn"
      fi
    done <<< "$lines"
    sleep 1
  done
done
echo "=== harvested: $(wc -l < "$MANIFEST") ==="
