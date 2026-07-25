#!/usr/bin/env bash
# shellcheck disable=SC2016
# ^ this suite extracts a manifest containing literal GitHub expressions.
#
# Regression tests for generate-go's retry loop. The action must retry transient generator failures
# twice, retain the bounded backoff, and still fail after the final attempt.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/go-actions/generate-go/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() {
  awk '
    /^    - name: Generate Go code$/ {step=1; next}
    step && /^      run: \|$/ {run=1; next}
    run && /^        generate$/ {exit}
    run && /^    - / {exit}
    run {sub(/^        /, ""); print}
  ' "$ACTION"
}

generated=$(extract)
if [ -z "$generated" ]; then
  echo "::error::could not extract the generation script from $ACTION"
  exit 1
fi

printf '%s\n' "$generated" >"$WORK/generate.sh"
if ! bash -n "$WORK/generate.sh"; then
  echo "::error::extracted generation script does not parse"
  exit 1
fi

# shellcheck source=/dev/null
. "$WORK/generate.sh"

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

run_case() { # $1=label $2=failures-before-success
  local label=$1 failures=$2 case_dir status attempts delays

  case_dir="$WORK/$label"
  mkdir -p "$case_dir"
  : >"$case_dir/delays"

  if (
    ATTEMPTS=0
    # shellcheck disable=SC2329 # invoked indirectly by generate
    go() {
      ATTEMPTS=$((ATTEMPTS + 1))
      printf '%s\n' "$ATTEMPTS" >>"$case_dir/attempts"
      [ "$ATTEMPTS" -gt "$failures" ]
    }
    # shellcheck disable=SC2329 # invoked indirectly by generate
    sleep() {
      printf '%s\n' "$1" >>"$case_dir/delays"
    }
    generate
  ); then
    status=0
  else
    status=1
  fi

  attempts=$(wc -l <"$case_dir/attempts")
  delays=$(tr '\n' ' ' <"$case_dir/delays" | sed 's/ $//')
  printf '%s|%s|%s\n' "$status" "$attempts" "$delays"
}

echo "== retry behavior =="

result=$(run_case first-attempt 0)
check "success on first attempt" "0|1|" "$result"

result=$(run_case second-attempt 1)
check "retry then success" "0|2|5" "$result"

result=$(run_case final-failure 3)
check "failure after final attempt" "1|3|5 10" "$result"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
