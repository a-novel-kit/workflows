#!/usr/bin/env bash
# Regression tests for derive-status' closing-issue resolution.
#
# The jq programs are extracted verbatim from the manifest and run against fixture refs, so the
# assertions are on the shipped selectors. There is nothing to stub — they are pure functions of the
# GraphQL result.
#
# The central case is a PR that closes several issues. The reconcile sweep reaches an issue through
# its own pull request, so an issue closed by a sibling's PR is reachable only from the deriver here.
# A Task left behind sits at whatever status it held while its fix is in review, and the run that
# left it there succeeds.
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

# The lowest-numbered-ref selector, kept as a contrast: it resolves one issue where the shipped
# filter resolves every closing issue.
OLD_FILTER='sort_by(.number) | .[0].id // empty'
check "the previous filter returned only the lowest-numbered" "I_kw1111" \
  "$(printf '%s' "$TWO" | jq -r "$OLD_FILTER")"

echo "== the hotfix-reconcile branch is decided across all of them =="

check "no closing issue is a hotfix cleanup" "0" "$(hotfix_count "$TWO")"
check "every closing issue is a hotfix cleanup" "1" "$(hotfix_count "$ALL_HOTFIX")"

# A mixed set has no single right answer: one status covers every closing issue, and these two carry
# different terminal ones. The action stops there, which is why the classifier reports the count
# instead of sampling one issue's labels.
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
