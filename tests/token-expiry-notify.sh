#!/usr/bin/env bash
# Regression tests for token-expiry-notify's credential check.
#
# token_state is extracted verbatim from the manifest and driven directly, so the assertions are on
# the shipped classifier.
#
# The action reminds a maintainer before a fine-grained PAT expires. An expired or revoked token
# returns no expiry header, so collapsing the check onto "is the header empty" reported the one
# outcome the job exists to catch as the benign one, and exited 0. A daily run then printed a
# reassuring line forever.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/token-expiry-notify/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

out=$(extract token_state)
if [ -z "$out" ]; then
  echo "::error::could not extract token_state from $ACTION — did its definition move or change indent?"
  exit 1
fi
printf '%s\n' "$out" >"$WORK/lib.sh"

if ! bash -n "$WORK/lib.sh"; then
  echo "::error::the extracted function does not parse — extraction truncated a definition"
  exit 1
fi

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

echo "== the three outcomes an empty expiry header can mean =="

# An expired or revoked PAT: GitHub answers 401 and sends no expiry header. The header is empty for
# the same reason a non-expiring credential's is, which is what made the two indistinguishable.
check "a rejected token" "rejected" "$(token_state 0 401 '')"
check "a token without the access it needs" "rejected" "$(token_state 0 403 '')"
check "a server fault" "rejected" "$(token_state 0 500 '')"

# curl could not complete the request at all: DNS, TLS, a connect timeout.
check "an unreachable API" "unreachable" "$(token_state 6 000 '')"
check "an unreachable API reporting a status too" "unreachable" "$(token_state 28 000 '')"

# The benign case: a classic PAT or an App token authenticates and carries no expiry.
check "a credential with no expiry" "non-expiring" "$(token_state 0 200 '')"

echo "== the reminder path is unchanged =="

check "a fine-grained PAT with an expiry" "expiring" "$(token_state 0 200 'Mon, 01 Jan 2027 00:00:00 UTC')"

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
