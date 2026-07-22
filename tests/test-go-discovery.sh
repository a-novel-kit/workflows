#!/usr/bin/env bash
# Regression tests for test-go's package discovery.
#
# Same discipline as release-train.sh: discover_modules is extracted verbatim from the manifest and
# sourced, with only `go` stubbed. The caller-supplied filter expressions are the one thing that
# cannot survive extraction — they are `${{ }}` expressions GitHub resolves at load time — so they
# are substituted with their declared defaults, and the substitution is asserted rather than assumed.
#
# What is under test is that discovery cannot come back empty and still report success. gotestsum
# reads MODULES as its package arguments; with none it falls back to `.`, prints `DONE 0 tests` and
# exits 0, and the coverage step reports 0.0% off a `mode: set` header and exits 0 too. Every read
# here has to fail loudly instead, because this action is the only place these tests run.
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

# Resolve the two caller expressions to the defaults the manifest declares. Both substitutions have
# to bite: a renamed input would otherwise leave a `${{ … }}` in the sourced text, and the suite
# would then cover something the action no longer contains.
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

# Without the emptiness guard this is the shape that slips through: printf on an empty capture writes
# a blank line, which survives every grep and makes modules.txt non-empty by size while naming no
# package at all.
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
