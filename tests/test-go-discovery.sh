#!/usr/bin/env bash
# shellcheck disable=SC2016
# ^ the suite matches literal `${{ … }}` GitHub template strings, which must not expand.
#
# Regression tests for test-go's package discovery: discover_modules is extracted from the manifest
# and sourced with `go` stubbed. Guards that discovery can never come back empty yet report success
# (gotestsum with no packages falls back to `.` and exits 0 — every empty read must fail loudly).
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/go-actions/test-go/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

out=$(extract discover_modules)
if [ -z "$out" ]; then
  echo "::error::could not extract discover_modules from $ACTION — did its definition move or change indent?"
  exit 1
fi

# Resolve the two `${{ }}` inputs to their manifest defaults; both must bite (a renamed input would
# leave a `${{ … }}` behind), so the substitution is asserted below.
filters="| grep -v /mocks | grep -v /test | grep -v /proto"
resolved=${out//'${{ inputs.filter_patterns }}'/$filters}
resolved=${resolved//'${{ inputs.filter_extra_patterns }}'/}

if [ "$resolved" = "$out" ] || [[ "$resolved" == *'${{'* ]]; then
  echo "::error::filter expressions did not resolve — the input names in the manifest changed"
  exit 1
fi

printf '%s\n' "$resolved" >"$WORK/lib.sh"

if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted function does not parse — extraction truncated the definition"
  exit 1
fi

# ---- stubbed leaf -----------------------------------------------------------------------
# The three reads discover_modules makes, each failable on demand.
GO_ROOT="github.com/a-novel/svc"
GO_MODULES="github.com/a-novel/svc"
GO_PACKAGES=""
GO_ROOT_FAIL=0
GO_M_FAIL=0
GO_PKG_FAIL=0

go() {
  [ "${1:-}" = "list" ] || return 0
  shift

  case "${1:-}" in
    .)
      [ "$GO_ROOT_FAIL" = "1" ] && return 1
      printf '%s\n' "$GO_ROOT"
      ;;
    -m)
      [ "$GO_M_FAIL" = "1" ] && return 1
      printf '%s\n' "$GO_MODULES"
      ;;
    *)
      [ "$GO_PKG_FAIL" = "1" ] && return 1
      [ -n "$GO_PACKAGES" ] && printf '%s\n' "$GO_PACKAGES"
      ;;
  esac

  return 0
}

# shellcheck source=/dev/null
. "$WORK/lib.sh"

cd "$WORK" || exit 1

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

run() { # runs discovery quietly and echoes its status
  discover_modules >/dev/null 2>&1
  echo "$?"
}

echo "== a failed read is not an empty package set =="

GO_PACKAGES="github.com/a-novel/svc/internal/dao"

GO_ROOT_FAIL=1
check "go list . failure fails the step" "1" "$(run)"
GO_ROOT_FAIL=0

GO_M_FAIL=1
check "go list -m failure fails the step" "1" "$(run)"
GO_M_FAIL=0

GO_PKG_FAIL=1
check "a per-module go list failure fails the step" "1" "$(run)"
GO_PKG_FAIL=0

echo "== an empty package set is a failure however it arises =="

GO_PACKAGES=""
check "a module listing no packages fails the step" "1" "$(run)"

# The shape that slips past a size check: a blank line survives every grep, making modules.txt
# non-empty while naming no package.
check "the blank line a no-package module would emit does not count as content" \
  "" "$(tr -d '[:space:]' <modules.txt)"

GO_PACKAGES="github.com/a-novel/svc/internal/mocks
github.com/a-novel/svc/internal/test
github.com/a-novel/svc/internal/models/proto"
check "a set the filters empty out fails the step" "1" "$(run)"

echo "== the healthy path still discovers, and still filters =="

GO_PACKAGES="github.com/a-novel/svc
github.com/a-novel/svc/internal/dao
github.com/a-novel/svc/internal/mocks
github.com/a-novel/svc/internal/test
github.com/a-novel/svc/internal/models/proto"

check "a populated set succeeds" "0" "$(run)"
check "the surviving packages are recorded" "yes" "$(grep -q '/internal/dao$' modules.txt && echo yes || echo no)"
check "mocks are filtered out" "no" "$(grep -q /mocks modules.txt && echo yes || echo no)"
check "test helpers are filtered out" "no" "$(grep -q /test modules.txt && echo yes || echo no)"
check "generated proto is filtered out" "no" "$(grep -q /proto modules.txt && echo yes || echo no)"

GO_MODULES="github.com/a-novel/svc
github.com/a-novel/svc/pkg/go"
check "several modules all contribute" "0" "$(run)"
check "each module appended its packages" "4" "$(wc -l <modules.txt)"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
