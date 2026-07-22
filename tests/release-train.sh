#!/usr/bin/env bash
# Regression tests for release-train's fail-closed reads.
#
# Same discipline as detect-partial-landing.sh: the functions under test are extracted verbatim from
# the manifest and sourced. Only `gh` is stubbed, and it can fail on demand, since the point is that
# a read failure must not read as a benign outcome.
#
# Two paths share that shape. derive_bump distinguishes a failed commit-range read from an empty
# range: mapping both onto "none" skips a repo, records it as nochange, and leaves the run green,
# and with nothing marking a failure a re-dispatch recomputes the same skip. splice_body is the other
# end — fed the empty body a failed read produces, it returns a body holding only the receipt block,
# which the PATCH would write over the Epic's prose and its frozen activation snapshot.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/release-train/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

for fn in commit_messages derive_bump splice_body; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done
# Extraction stops at the first 8-space `}`; if that lands mid-function the result is invalid bash.
if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted functions do not parse — extraction truncated a definition"
  exit 1
fi

sleep() { :; } # the retry loop's wall-clock delay is not useful here

# ---- stubbed leaf -----------------------------------------------------------------------
# GH_FAIL=1 makes every read fail, the condition both paths turn on.
# GH_SUBJECTS holds the commit messages a successful read returns.
GH_FAIL=0
GH_SUBJECTS=""
gh() {
  if [ "$GH_FAIL" = "1" ]; then
    return 22 # gh's exit status for a failed API call
  fi
  printf '%s' "$GH_SUBJECTS"
}

# shellcheck source=/dev/null
. "$WORK/lib.sh"

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

echo "== derive_bump: a failed read is not an empty range =="

GH_FAIL=1
check "read failure yields __ERR__, not none" "__ERR__" "$(derive_bump a/b v1.0.0 master)"
check "read failure on a first release yields __ERR__, not minor" "__ERR__" "$(derive_bump a/b '' master)"

GH_FAIL=0
GH_SUBJECTS=""
check "a genuinely empty range still yields none" "none" "$(derive_bump a/b v1.0.0 master)"
check "a quiet first release still yields minor" "minor" "$(derive_bump a/b '' master)"

GH_SUBJECTS="fix(dao): tighten a predicate"
check "fix yields patch" "patch" "$(derive_bump a/b v1.0.0 master)"

GH_SUBJECTS="feat(core): add an endpoint"
check "feat yields minor" "minor" "$(derive_bump a/b v1.0.0 master)"

GH_SUBJECTS="feat(proto)!: drop a field"
check "bang yields major" "major" "$(derive_bump a/b v1.0.0 master)"

GH_SUBJECTS="fix(x): y
BREAKING CHANGE: z"
check "BREAKING footer yields major" "major" "$(derive_bump a/b v1.0.0 master)"

echo "== commit_messages: retries, then reports failure rather than an empty result =="

GH_FAIL=1
commit_messages "repos/a/b/commits" '.[]' false
check "returns non-zero when every attempt fails" "1" "$?"

echo "== splice_body: an empty body is a body-shaped hole =="

BLOCK='<!-- release-train:receipts:start -->
### receipts
<!-- release-train:receipts:end -->'

# Given an empty body, splice_body can only return a block-only body. The assertion pins that result
# as destructive, which is why the caller refuses to reach it.
spliced=$(splice_body "" "$BLOCK")
case "$spliced" in
  *"human prose"*) check "empty input keeps prose" "impossible" "kept" ;;
  *) echo "  ok   an empty body yields a block-only body (the destructive case the caller must avoid)" ;;
esac

# The healthy paths: prose survives, and an existing region is replaced in place.
BODY='Some human prose.

<!-- release-train:receipts:start -->
### old receipts
<!-- release-train:receipts:end -->'
spliced=$(splice_body "$BODY" "$BLOCK")
case "$spliced" in
  *"Some human prose."*) echo "  ok   prose survives a replace" ;;
  *) echo "  FAIL prose was dropped on replace"; fails=$((fails + 1)) ;;
esac
case "$spliced" in
  *"old receipts"*) echo "  FAIL stale receipts accumulated"; fails=$((fails + 1)) ;;
  *) echo "  ok   the stale region was replaced, not appended" ;;
esac

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
