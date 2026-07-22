#!/usr/bin/env bash
# Regression tests for derive-status' closing-issue resolution.
#
# The jq programs are extracted verbatim from the manifest and run against fixture refs, so the
# assertions are on the shipped selectors. There is nothing to stub — they are pure functions of the
# GraphQL result.
#
# The defect: a PR closing several issues derived exactly one of them, on the stated grounds that
# "the reconcile sweep covers the rest". The sweep re-derives an issue from ITS OWN pull request, and
# an issue closed by a sibling's PR has none — so the others were reached by nothing. Not a race that
# resolves next pass, a state nothing arrives at. It read as handled because the run that stranded
# them succeeded.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/derive-status/action.yaml}"

IDS_FILTER=$(sed -n "s/^        issue_ids=.*jq -r '\(.*\)')\$/\1/p" "$ACTION")
LABELLED_FILTER=$(sed -n "s/^        labelled=.*jq -c '\(.*\)')\$/\1/p" "$ACTION")

for name in IDS_FILTER LABELLED_FILTER; do
  if [ -z "${!name}" ]; then
    echo "::error::could not extract $name from $ACTION — did the assignment move or change shape?"
    exit 1
  fi
done

fails=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected [$2], got [$3]"
    fails=$((fails + 1))
  fi
}

# A PR closing two issues, the shape of the live instance: service-authentication#1140 closes both
# #1111 and #1112, and #1112 sat in Triage while its fix was in review.
TWO=$(
  cat <<'EOF'
[ { "number": 1112, "id": "I_kw1112", "labels": {"nodes": []} },
  { "number": 1111, "id": "I_kw1111", "labels": {"nodes": []} } ]
EOF
)

ONE='[ { "number": 1111, "id": "I_kw1111", "labels": {"nodes": []} } ]'
NONE='[]'

MIXED=$(
  cat <<'EOF'
[ { "number": 10, "id": "I_kw10", "labels": {"nodes": [{"name": "hotfix-reconcile"}]} },
  { "number": 11, "id": "I_kw11", "labels": {"nodes": []} } ]
EOF
)

ALL_HOTFIX='[ { "number": 10, "id": "I_kw10", "labels": {"nodes": [{"name": "hotfix-reconcile"}]} } ]'

ids() { printf '%s' "$1" | jq -r "$IDS_FILTER" | tr '\n' ' ' | sed 's/ $//'; }
hotfix_count() { printf '%s' "$1" | jq -c "$LABELLED_FILTER" | jq '[.[] | select(.)] | length'; }

echo "== every closing issue is derived, not just one =="

check "a PR closing two issues yields both, lowest first" "I_kw1111 I_kw1112" "$(ids "$TWO")"
check "a PR closing one issue is unchanged" "I_kw1111" "$(ids "$ONE")"
check "a PR closing none yields nothing" "" "$(ids "$NONE")"

# The previous behaviour, kept here so the defect stays on the record rather than living only in a
# commit message: it took the lowest-numbered ref and left the other untouched.
OLD_FILTER='sort_by(.number) | .[0].id // empty'
check "the previous filter returned only the lowest-numbered" "I_kw1111" \
  "$(printf '%s' "$TWO" | jq -r "$OLD_FILTER")"

echo "== the hotfix-reconcile branch is decided across all of them =="

check "no closing issue is a hotfix cleanup" "0" "$(hotfix_count "$TWO")"
check "every closing issue is a hotfix cleanup" "1" "$(hotfix_count "$ALL_HOTFIX")"

# Mixed is the case with no single right answer: one status is written to every closing issue, and
# these two want different terminal ones. The action errors rather than picking, which is the whole
# point — sampling one issue's labels is what the old code did.
mixed=$(hotfix_count "$MIXED")
total=$(printf '%s' "$MIXED" | jq 'length')
if [ "$mixed" != "0" ] && [ "$mixed" != "$total" ]; then
  echo "  ok   a mixed set is detectable as neither all nor none ($mixed of $total)"
else
  echo "  FAIL a mixed set was not detectable"
  fails=$((fails + 1))
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "::error::$fails assertion(s) failed"
  exit 1
fi
echo "all assertions passed"
