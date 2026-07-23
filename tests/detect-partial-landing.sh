#!/usr/bin/env bash
# Regression tests for detect-partial-landing's membership sourcing.
#
# These actions are bash inside a composite manifest, so there is nothing to import: the harness
# extracts the functions under test verbatim from the manifest and sources them, which keeps the
# shipped code the code that runs here. Only the network leaves are stubbed (gh, and the three read
# helpers evaluate_epic calls), so every decision below is the real predicate running on fixture truth.
# Offline and deterministic.
#
# The central case is a member de-labeled and closed mid-landing. Live label truth has forgotten it —
# GitHub indexes no "ever carried label X" — so the detector reads the survivors as a clean landing
# and clears. The frozen activation snapshot is what keeps it a member.
#
# The fixtures model the real capture shape. merge-gate captures the set from open pull requests and
# freezes it once the set holds still, while auto-merge is armed earlier, so a real frozen set omits
# the members that already merged. The snapshot is added to the live set: `A` merged is visible only
# live, `B` abandoned only in the snapshot, and the freeze depends on both.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/detect-partial-landing/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

for fn in extract_marker epic_issue epic_paused build_claim_index snapshot_buckets union_buckets evaluate_epic; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done
# Extraction stops at the first 8-space `}`. Landing mid-function yields invalid bash, and this check
# names the truncation at its source.
if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted functions do not parse — extraction truncated a definition"
  exit 1
fi

export ORG=a-novel-kit PLANNING_REPO=.github GRACE_MINUTES=30
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
now_epoch=$(date -u +%s)
# The action computes these outside any extracted function, so the harness reimplements them. A change
# to the action's own arithmetic escapes this suite; keep the two in sync by hand.
grace_seconds=$((GRACE_MINUTES * 60))
sleep() { :; } # retries are driven by the rehydrate_fails countdown; wall-clock delay is not useful here

# ---- stubbed leaves ---------------------------------------------------------------------
# Every stub can fail on demand: the action's central promise is that it fails closed, and only a
# failing stub tests that promise.
gh() {
  # Record every call so the assertions can read the query itself. The document this action builds is
  # the part no fixture exercises, and a wrong field or alias in it is a total feature outage.
  printf '%s\n' "$*" >> "$WORK/gh_calls"
  case "$*" in
    *graphql*)
      # The stub runs inside $( ), a subshell, so the countdown lives in a file: that is what makes
      # "fail twice, then succeed" observable from the parent.
      if [ "$(< "$WORK/rehydrate_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/rehydrate_fails") - 1))" > "$WORK/rehydrate_fails"
        echo "gh: API rate limit exceeded" >&2
        return 1
      fi
      [ "$FX_REHYDRATE" = "FAIL" ] && { echo "gh: Bad credentials" >&2; return 1; }
      printf '%s' "$FX_REHYDRATE" ;;
    *"issues?state=open"*)
      # The claim-index list. FX_ISSUE_LIST is a JSON array of issue objects the endpoint would return
      # (each {number, body, labels?} plus {pull_request:{}} on a PR row). Ordered before the
      # single-issue branch below, which its glob would otherwise also match.
      [ "$FX_ISSUE_LIST" = FAIL ] && { echo "gh: HTTP 502" >&2; return 1; }
      printf '%s' "${FX_ISSUE_LIST:-[]}" ;;
    *issues*)
      case "$FX_BODY" in
        FAIL404) echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;
        FAIL500) echo "gh: HTTP 502" >&2; return 1 ;;
        NOISE) echo "gh: a deprecation notice" >&2; jq -cn --arg b "$FX_MARKER_BODY" --argjson l "$FX_LABELS" '{body: $b, labels: $l}' ;;
        *) jq -cn --arg b "$FX_BODY" --argjson l "$FX_LABELS" '{body: $b, labels: $l}' ;;
      esac ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}
search_prs() {
  # Record the query. The stub dispatches on the `is:` token alone, so the assertions below are what
  # cover the rest of the grammar: the label qualifier and the org scope bound membership, and losing
  # either makes every open pull request in the org a member of every Epic.
  printf '%s\n' "$1" >> "$WORK/searches"
  [ "$FX_SEARCH_FAIL" = true ] && return 1
  # Fail exactly one of the three searches, so each fail-closed guard is pinned separately.
  case "$FX_SEARCH_FAIL_ON" in
    merged) case "$1" in *is:merged*) return 1 ;; esac ;;
    closed) case "$1" in *is:unmerged*) return 1 ;; esac ;;
    open) case "$1" in *is:open*) return 1 ;; esac ;;
  esac
  local bucket floor
  case "$1" in
    *is:merged*) bucket="$FX_LIVE_MERGED" ;;
    *is:unmerged*) bucket="$FX_LIVE_CLOSED" ;;
    *is:open*) bucket="$FX_LIVE_OPEN" ;;
    *) echo "unexpected search: $1" >&2; return 1 ;;
  esac
  # Apply the time qualifier the way GitHub does. A bad qualifier silently returns zero rows, so
  # filtering here is what lets the wave-boundary assertions below run the real predicate against real
  # truth.
  # ISO-8601 UTC sorts chronologically, so a string compare is the date compare; the action's own grace
  # clock leans on the same property. A node with no terminal timestamp is kept: GitHub always has one,
  # so an undated fixture means "not what this assertion is about".
  floor=$(printf '%s' "$1" | sed -n 's/.*\(merged\|closed\):>=\([^ ]*\).*/\2/p')
  [ -n "$floor" ] && bucket=$(printf '%s' "$bucket" | jq -c --arg f "$floor" \
    '[.[] | select((.mergedAt // .closedAt // "9999") >= $f)]')
  printf '%s' "$bucket"
}
merge_queue_entries() { # $1=owner $2=repo $3=base
  [ "$FX_QUEUE_FAIL" = true ] && return 1
  # Honor all three arguments the real helper takes, so the assertions catch an owner/repo split
  # swapped the wrong way round or a hard-coded base; either reads the wrong queue for every member.
  printf '%s' "$FX_QUEUE" | jq -c --arg repo "$1/$2" --arg base "$3" \
    '[.[] | select((.repo // $repo) == $repo and (.base // $base) == $base)]'
}
rest_pr_state() {
  [ "$FX_REST_FAIL" = true ] && return 1
  [ "$FX_REST_FAIL_ON" = "$1#$2" ] && return 1
  printf '%s' "$FX_REST" | jq -er --arg k "$1#$2" '.[$k]' 2>/dev/null || {
    echo "harness gap: no REST fixture for $1#$2" >&2
    return 1
  }
}

# shellcheck disable=SC1091
. "$WORK/lib.sh"

# Where epic_issue keeps one Epic-issue response per pass.
EPIC_CACHE="$WORK/epic-cache"
mkdir -p "$EPIC_CACHE"
epic_cache_clear() { rm -f "$EPIC_CACHE"/*; }

# A pass reads an Epic issue once and both readers share it, so the cache survives for the life of
# the step. Each case below is its own pass with its own fixture body, so it is cleared per call —
# otherwise the first case's response would answer every later one. The read-once behavior is
# asserted directly further down, against an uncleared cache.
eval "uncached_evaluate_epic() $(declare -f evaluate_epic | tail -n +2)"
evaluate_epic() { epic_cache_clear; uncached_evaluate_epic "$@"; }

# ---- fixtures ---------------------------------------------------------------------------
# A member node as the re-read returns it. `prov` is how the node proves it belongs to the Epic:
#   timeline = de-labeled now, but its timeline records having been labeled (the regression case)
#   label    = still carries the label
#   none     = neither — a pull request named by the marker that was never a member
node() { # repo number state [terminalAt] [prov: timeline|label|none]
  # `terminalAt` is when the pull request reached its terminal state: it fills `mergedAt` for a MERGED
  # one and `closedAt` otherwise, which is how GitHub reports them (a merged PR carries both, equal).
  # `closedAt` sits outside the action's search-node shape and the action never reads it; it is there
  # so the stub above can apply a `closed:>=` floor, which the real search applies server-side.
  jq -cn --arg r "$1" --argjson n "$2" --arg s "$3" --arg m "${4:-}" --arg p "${5:-timeline}" --arg e "epic:900" \
    '{number:$n, headRefOid:("sha"+($n|tostring)),
      mergedAt:(if $m=="" or $s!="MERGED" then null else $m end),
      closedAt:(if $m=="" or $s=="OPEN" then null else $m end),
      baseRefName:"master", isDraft:false, state:$s, repository:{nameWithOwner:$r},
      labels:{nodes:(if $p=="label" then [{name:$e}] else [] end)},
      timelineItems:{nodes:(if $p=="timeline" then [{label:{name:$e}}] else [] end)}}'
}
rehydrate() { # the aliased re-read response, one alias per member
  jq -s -c '{data: ([.[] | {pullRequest: .}] | to_entries
    | map({key:("m"+(.key|tostring)), value:.value}) | from_entries)}' <<<"$*"
}
# Builds the region exactly as merge-gate writes it: fence, a human-readable note line, the compact
# payload, fence. The note is the part that matters. It lives inside the fence, so a reader that parses
# the whole region as JSON chokes on it, and only a fixture carrying the note catches that. Frozen
# payloads carry no `at`; only pending does.
marker() { # status members-json [since]
  # `since` is the wave boundary, optional on every status, because that is the shape the reader has to
  # survive: absent on a first wave, present on a tombstone, and carried forward onto the pending or
  # frozen markers that replace one.
  local payload note
  if [ "$1" = retired ]; then
    payload=$(jq -cn --arg since "${3:-}" '{status:"retired"} + (if $since=="" then {} else {since:$since} end)')
    note='_Epic membership, RETIRED — this wave has landed; the next ready set freezes its own. Do not edit._'
  elif [ "$1" = frozen ]; then
    payload=$(jq -cn --argjson m "$2" --arg since "${3:-}" \
      '{status:"frozen", members:$m} + (if $since=="" then {} else {since:$since} end)')
    note='_Epic membership, FROZEN at activation by the merge-gate. The authoritative set for this landing — a later de-label, close, or relabel does not change it. Do not edit._'
  else
    payload=$(jq -cn --arg s "$1" --argjson m "$2" --arg since "${3:-}" \
      '{status:$s, at:"2026-07-20T10:00:00Z", members:$m} + (if $since=="" then {} else {since:$since} end)')
    note='_Epic membership, PENDING — stabilizing before it freezes (the label index is eventually consistent). Do not edit._'
  fi
  printf '<!-- epic-membership:snapshot:start -->\n%s\n%s\n<!-- epic-membership:snapshot:end -->\n' "$note" "$payload"
}

AGO40=$(date -u -d '-40 minutes' +%Y-%m-%dT%H:%M:%SZ)
AGO20=$(date -u -d '-20 minutes' +%Y-%m-%dT%H:%M:%SZ) # a wave boundary: after AGO40, before AGO5
AGO5=$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)
AHEAD=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
A=$(node a-novel-kit/repo-a 1 MERGED "$AGO40")
B=$(node a-novel-kit/repo-b 2 CLOSED) # the abandoned member: closed unmerged, label removed
C=$(node a-novel-kit/repo-c 3 OPEN)
BC='[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]'

reset_fixtures() {
  # Every fixture the assertions read lives here, so one section's edit is restored before the next
  # section reads it.
  FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
  FX_LIVE_MERGED="[$A]" # A merged and still labeled: visible to the live search
  FX_LIVE_CLOSED='[]'   # B is de-labeled, so live truth has forgotten it entirely
  FX_LIVE_OPEN="[$C]"
  FX_BODY=""
  # One response carries both the pause marker and the snapshot, so the fixture carries both.
  FX_LABELS='[]'
  # The planning repo's open-issue list the claim index reads. Default empty so the per-Epic
  # assertions, which drive evaluate_epic directly, see no claim additions.
  FX_ISSUE_LIST='[]'
  FX_REHYDRATE=""
  printf 0 > "$WORK/rehydrate_fails"
  : > "$WORK/gh_calls"
  : > "$WORK/searches"
  FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]' # repo-c is queued → not a stray
  FX_SEARCH_FAIL=false
  FX_SEARCH_FAIL_ON=none
  FX_REST_FAIL=false
  FX_REST_FAIL_ON=none
  FX_QUEUE_FAIL=false
}
reset_fixtures

# ---- assertions -------------------------------------------------------------------------
pass=0
fail=0
note() { printf '  %s %s\n' "$1" "$2"; }
ok() { note ✓ "$1"; pass=$((pass + 1)); }
ko() { note ✗ "$1"; fail=$((fail + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || ko "$1 (got '$2', want '$3')"; }

check() { # name expected-decision [expected-membership] [expected merged/closed/open counts]
  local name="$1" want="$2" wantsrc="${3:-}" wantcounts="${4:-}" src counts detail=""
  evaluate_epic 900 >/dev/null 2>&1
  src=$(grep -o 'membership=[a-z+]*' "$GITHUB_STEP_SUMMARY" | tail -1 | cut -d= -f2)
  counts="$EV_MERGED_COUNT/$EV_CLOSED_COUNT/$EV_OPEN_COUNT"
  : > "$GITHUB_STEP_SUMMARY"
  [ "$EV_DECISION" = "$want" ] || detail="decision=$EV_DECISION (want $want)"
  { [ -z "$wantsrc" ] || [ "$src" = "$wantsrc" ]; } || detail="$detail membership=${src:-n/a} (want $wantsrc)"
  { [ -z "$wantcounts" ] || [ "$counts" = "$wantcounts" ]; } || detail="$detail counts=$counts (want $wantcounts)"
  if [ -z "$detail" ]; then
    printf '  ✓ %-54s %-7s %-14s %s\n' "$name" "$EV_DECISION" "${src:-n/a}" "$counts"
    pass=$((pass + 1))
  else
    printf '  ✗ %-54s %s\n' "$name" "$detail"
    fail=$((fail + 1))
  fi
}

echo "the regression: a member de-labeled and closed mid-landing"
check "on the live set alone, the abandonment is invisible" clear live 1/0/1
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "the snapshot supplies it, and the Epic freezes" frozen live+snapshot 1/1/1
[ "$EV_REASON" = "a member was closed without merging" ] \
  && ok "and for the right reason" || ko "wrong reason: $EV_REASON"

echo
echo "the snapshot is ADDED to the live set, never swapped for it"
# The real capture shape: merge-gate freezes from open PRs, so an already-merged member is absent from
# the snapshot, and the merged bucket that gates every decision comes from the live set.
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 MERGED "$AGO5")" "$C")
check "a member merged after the freeze is not double-counted" clear live+snapshot 2/0/1

echo
echo "the frozen member reaches the payload the freeze is posted on"
# EV_OPEN is what sweep_post_freeze targets, so the head a decision names has to be in it.
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 OPEN)" "$C")
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-b" and .number == 2)' >/dev/null \
  && ok "a de-labeled open member is in EV_OPEN, so it gets a check" \
  || ko "the de-labeled open member is missing from EV_OPEN"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-b" and (.liveMember | not))' >/dev/null \
  && ok "and is tagged as no longer live-labeled" || ko "liveMember tag missing or wrong"
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/repo-c" and .liveMember)' >/dev/null \
  && ok "while a still-labeled member is tagged live" || ko "a live member was mis-tagged"
# The roll-forward reads exactly this filter; a de-labeled member must not be re-armed.
printf '%s' "$EV_OPEN" | jq -e '[.[] | select((.isDraft | not) and .liveMember)] | length == 1' >/dev/null \
  && ok "EV_OPEN offers exactly one roll-forward candidate" || ko "EV_OPEN would offer a de-labeled member to roll-forward"
reset_fixtures

echo
echo "the marker only widens membership to pull requests that were really members"
# The marker lives in an issue body, so its author is whoever can edit that issue, and every member it
# names becomes a freeze target posted with an org-wide checks:write token. Membership has to be
# corroborated against the permission-gated label, or one issue edit blocks merges across the org.
# The intruder is in-org, so it clears the owner check and reaches corroboration.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/VICTIM","number":4242}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/VICTIM 4242 OPEN '' none)")
# `error`: the live floor posts success and lifts a standing freeze, so an untrustworthy marker decides
# nothing.
check "a named pull request that was never a member decides nothing" error
# A labeled intruder: corroboration matches this Epic's own label exactly.
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson v "$(node a-novel-kit/VICTIM 4242 OPEN '' none)" \
  '$v | .labels.nodes = [{name:"bug"}]')")
check "an intruder carrying an unrelated label is still rejected" error
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson v "$(node a-novel-kit/VICTIM 4242 OPEN '' none)" \
  '$v | .timelineItems.nodes = [{label:{name:"epic:901"}}]')")
check "an intruder labeled for a DIFFERENT Epic is rejected" error
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/VICTIM")' >/dev/null \
  && ko "the planted pull request reached the freeze target set" \
  || ok "and it never reaches the freeze target set"
# A repository outside the org can never be a member: the live label search is org-scoped, and naming
# one lets the marker's author corroborate in a repository they control.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"attacker/anything","number":1}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node attacker/anything 1 OPEN)")
check "a member outside the org is rejected outright" clear live 1/0/1
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/repo-c 3 OPEN '' label)")
check "a member still carrying the label is corroborated" frozen live+snapshot 1/1/1
FX_REHYDRATE=$(rehydrate "$B" "$C") # B is de-labeled: only its timeline proves membership
check "a de-labeled member is corroborated by its timeline" frozen live+snapshot 1/1/1
# GraphQL follows a rename and answers with the new name, while a frozen marker is never rewritten, so
# identity is matched on the alias index and the number.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-b-renamed#2":"closed false"}')
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b-renamed 2 CLOSED)" "$C")
check "a member whose repository was renamed still resolves" frozen live+snapshot 1/1/1
reset_fixtures

echo
echo "the roll-forward target set, on BOTH membership paths"
# Every node must carry liveMember whichever path built it. jq reads a missing key as null, so an
# untagged node drops out of the roll-forward filter and into its skip-warning, disabling recovery for
# the Epics that have no snapshot yet.
reset_fixtures
FX_QUEUE='[]' # repo-c left its queue: a stray, still labeled, within grace
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO5")]"
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(printf '%s' "$EV_STRAYS" | jq '[.[] | select((.isDraft | not) and .liveMember)] | length')" = 1 ] \
  && ok "no snapshot: EV_STRAYS still offers a roll-forward candidate" \
  || ko "no snapshot: the roll-forward selected nothing (untagged nodes)"
[ "$(printf '%s' "$EV_STRAYS" | jq '[.[] | select((.isDraft | not) and (.liveMember | not))] | length')" = 0 ] \
  && ok "no snapshot: EV_STRAYS reports nothing as de-labeled" \
  || ko "no snapshot: a labeled stray was warned about as de-labeled"
reset_fixtures

echo
echo "the GraphQL document it builds"
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
q=$(cat "$WORK/gh_calls")
for want in 'owner:"a-novel-kit", name:"repo-b"' 'number:2' 'owner:"a-novel-kit", name:"repo-c"' 'number:3' \
            'm0:' 'm1:' 'state' 'headRefOid' 'mergedAt' 'baseRefName' 'isDraft' 'nameWithOwner' \
            'labels(first:100)' 'LABELED_EVENT'; do
  case "$q" in
    *"$want"*) ok "queries $want" ;;
    *) ko "the re-read query is missing: $want" ;;
  esac
done
# `2.0` passes the guard (it equals its own floor) but jq preserves the literal a body was written
# with, and `number:2.0` is an Int! violation that rejects the whole document. No retry clears it, so
# the number has to render canonically.
reset_fixtures
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2.0}]')
FX_REHYDRATE=$(rehydrate "$B")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
q=$(cat "$WORK/gh_calls")
case "$q" in
  *"number:2.0"*) ko "a float-valued member number reaches the query verbatim" ;;
  *"number:2"*) ok "a float-valued member number renders as a canonical integer" ;;
  *) ko "the re-read query never rendered the member number" ;;
esac
reset_fixtures

echo
echo "unchanged behaviour"
reset_fixtures
check "a healthy live set clears" clear live 1/0/1
FX_LIVE_CLOSED="[$B]"
check "a closed member still labeled trips without any snapshot" frozen live 1/1/1
reset_fixtures
FX_LIVE_MERGED='[]'
check "nothing merged yet, so nothing can be partial" clear live 0/0/1
FX_LIVE_CLOSED="[$B]" # a closed member, but nothing has landed: there is no partial landing to protect
check "a closed member with nothing merged is not a partial landing" clear live 0/1/1

echo
echo "the stray + grace path, under a snapshot"
reset_fixtures
FX_QUEUE='[]' # repo-c left its queue
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 OPEN)" "$C")
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
check "a stray past grace freezes" frozen live+snapshot 1/0/2
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO5")]"
check "the same stray within grace does not" clear live+snapshot 1/0/2
reset_fixtures

echo
echo "the snapshot is the fresher read, so it wins a collision"
# Both sources describe repo-c#3. The freeze is posted on headRefOid, and the live search index lags a
# direct read, so a stale head here is the "stranded on Expected" failure the action exists to avoid.
reset_fixtures
FX_LIVE_OPEN="[$(node a-novel-kit/repo-c 3 OPEN)]" # index still reports the old head
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson c "$C" '$c | .headRefOid = "sha3-FRESH"')")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
printf '%s' "$EV_OPEN" | jq -e 'any(.number == 3 and .headRefOid == "sha3-FRESH")' >/dev/null \
  && ok "EV_OPEN carries the snapshot's head, not the index's" \
  || ko "the freeze would be posted on the stale head"
[ "$(printf '%s' "$EV_OPEN" | jq '[.[] | select(.number == 3)] | length')" = 1 ] \
  && ok "and the member appears exactly once" || ko "the member was double-counted across sources"

echo
echo "membership is bounded by the label and the org"
reset_fixtures
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
for want in 'label:"epic:900"' 'org:a-novel-kit'; do
  # All three searches: a grep over the whole file passes while two of them run unscoped.
  [ "$(grep -cF -- "$want" "$WORK/searches")" = 3 ] \
    && ok "all three member searches are scoped by $want" \
    || ko "a member search is missing $want — the set would be every open pull request"
done
: > "$WORK/searches"
evaluate_epic 901 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(grep -cF 'label:"epic:901"' "$WORK/searches")" = 3 ] \
  && ok "and the label follows the Epic being evaluated" || ko "the Epic label is not interpolated"

echo
echo "the merge queue is read per (repo, base), and only members are dequeued"
reset_fixtures
# An unrelated pull request sits in the same queue: it must not become an Epic member.
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"},{"number":999,"state":"QUEUED","headOid":"sha999"}]'
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(printf '%s' "$EV_QUEUE" | jq 'length')" = 1 ] \
  && ok "an unrelated queue entry is not treated as a member" \
  || ko "a non-member queue entry leaked into EV_QUEUE (it would be dequeued)"
reset_fixtures
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3","repo":"a-novel-kit/repo-c","base":"master"}]'
check "the queue is read with the member's own repo and base" clear live 1/0/1
reset_fixtures

echo
echo "a freeze is confirmed against REST before it blocks anyone"
# Each guard gets its own fixture: a single failure that trips all three at once proves only that at
# least one survives, and any one of them could then be deleted unnoticed.
FX_LIVE_CLOSED="[$B]"
FX_REST='{"a-novel-kit/repo-a#1":"open false","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
check "a 'merged' member REST says is open blocks the freeze" error live 1/1/1
FX_REST='{"a-novel-kit/repo-a#1":"closed false","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"open false"}'
check "a 'merged' member REST says is closed-unmerged blocks it too" error live 1/1/1
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"open false","a-novel-kit/repo-c#3":"open false"}'
check "a 'closed' member REST says is open blocks the freeze" error live 1/1/1
reset_fixtures
FX_QUEUE='[]' # repo-c looks like a stray to the index...
FX_REST='{"a-novel-kit/repo-a#1":"closed true","a-novel-kit/repo-b#2":"closed false","a-novel-kit/repo-c#3":"closed true"}'
check "a candidate stray REST says is merged is not a stray" clear live 1/0/1
reset_fixtures

echo
echo "the grace clock"
FX_QUEUE='[]'
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40"),$(node a-novel-kit/repo-d 4 MERGED "$AGO5")]"
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-d#4":"closed true"}')
check "grace runs from the FIRST merge, not the most recent" frozen live 2/0/1
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED 'not-a-date')]"
check "an unparseable merge time never elapses grace" clear live 1/0/1
reset_fixtures

echo
echo "the wave boundary: history is scoped to the wave, membership is not"
# The regression that makes a second wave impossible. A merged pull request keeps its epic:<N> label, so
# an unbounded is:merged search reports the previous wave forever: merged>=1 stays true, grace runs from
# the first merge ever, and the first sibling of the next wave is a stray past grace on the pass it
# appears — frozen by a required check, re-frozen every sweep.
FX_QUEUE='[]'                                                   # the new sibling is labeled and out of the queue
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40")]" # the previous wave: landed, past grace
check "without a boundary, a new sibling is frozen on the last wave" frozen live 1/0/1
FX_BODY=$(marker retired '[]' "$AGO20")
check "the tombstone ends that history, and it is gated normally" clear live 0/0/1
reset_fixtures

echo
echo "a partial landing INSIDE the wave still freezes"
FX_BODY=$(marker retired '[]' "$AGO20")
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO5")]"
FX_LIVE_CLOSED="[$(node a-novel-kit/repo-b 2 CLOSED "$AGO5")]"
check "a member closed after the boundary is this wave's abandonment" frozen live 1/1/1
[ "$EV_REASON" = "a member was closed without merging" ] \
  && ok "and for the right reason" || ko "wrong reason: $EV_REASON"
# The closed bucket carries the same hazard and is scoped identically: an abandonment a human has
# already dealt with must not re-freeze every wave that follows it.
FX_LIVE_CLOSED="[$(node a-novel-kit/repo-b 2 CLOSED "$AGO40")]"
check "the same member closed before it belongs to the retired wave" clear live 1/0/1
reset_fixtures

echo
echo "grace runs from THIS wave's first merge"
FX_QUEUE='[]'
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-d#4":"closed true"}')
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40"),$(node a-novel-kit/repo-d 4 MERGED "$AGO5")]"
check "unbounded, the oldest merge of all elapses grace" frozen live 2/0/1
FX_BODY=$(marker retired '[]' "$AGO20")
check "bounded, the clock starts at the merge inside the wave" clear live 1/0/1
reset_fixtures

echo
echo "the boundary is read from every marker status, not only the tombstone"
# merge-gate splices the whole region, so the tombstone is destroyed the moment the next wave captures a
# marker of its own. A boundary that is not carried forward onto that marker dies with it and the
# permanent freeze returns one pass later, so the reader takes it from any status.
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "a frozen marker with no boundary reads the whole history" frozen live+snapshot 1/1/1
FX_BODY=$(marker frozen "$BC" "$AGO20")
check "the same marker carrying one drops the retired wave" clear live+snapshot 0/1/1
reset_fixtures
FX_BODY=$(marker pending "$BC" "$AGO20")
check "a pending marker carries it too, membership still live" clear live 0/0/1
reset_fixtures

echo
echo "the boundary bounds HISTORY, never the frozen set"
# The frozen set is the current wave: retirement is what writes a boundary, and it removes the set it
# retires. The boundary bounds history alone, so it never shrinks membership or drops the abandoned
# member the snapshot is kept for.
FX_LIVE_MERGED='[]'
FX_BODY=$(marker frozen "$BC" "$AGO20")
FX_REHYDRATE=$(rehydrate "$(node a-novel-kit/repo-b 2 MERGED "$AGO40")" "$C")
check "a frozen member that merged before the boundary still counts" clear live+snapshot 1/0/1
reset_fixtures

echo
echo "which searches the boundary reaches"
FX_BODY=$(marker retired '[]' "$AGO20")
: > "$WORK/searches"
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ "$(grep -cF "merged:>=$AGO20" "$WORK/searches")" = 1 ] \
  && ok "the merged search is bounded" || ko "the merged search is not bounded by the boundary"
[ "$(grep -cF "closed:>=$AGO20" "$WORK/searches")" = 1 ] \
  && ok "the closed-unmerged search is bounded" || ko "the closed-unmerged search is not bounded"
grep 'is:open' "$WORK/searches" | grep -q ':>=' \
  && ko "the open search is bounded — but an open pull request is not history" \
  || ok "and the open search is left unbounded"
reset_fixtures

echo
echo "an unusable boundary is ignored, and never reaches a query"
# GitHub answers a malformed time qualifier — and a well-shaped impossible date — with zero rows and no
# errors array, indistinguishable from a genuinely empty bucket. That bucket gates every decision, and
# an empty one reads as "nothing has landed" → `clear`, which posts success and lifts a standing freeze.
# Falling back to unbounded history errs toward freezing. fd 6 keeps this loop's input clear of
# evaluate_epic's own.
FX_QUEUE='[]'
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40")]"
while IFS='|' read -r why bad <&6; do
  [ -n "$why" ] || continue
  FX_BODY=$(marker retired '[]' "$bad")
  : > "$WORK/searches"
  check "$why" frozen live 1/0/1
  grep -q ':>=' "$WORK/searches" \
    && ko "  …but it reached a query anyway" || ok "  …with no floor in any query"
done 6<<EOF
not a timestamp at all|garbage
a relative date the calendar happily accepts|yesterday
a well-formed shape that is not a real date|2026-13-45T99:00:00Z
a date with no time (one canonical form only)|2026-07-01
an instant in the future|$AHEAD
a trailing search qualifier|2026-07-01T00:00:00Z org:attacker
a quote that would close the qualifier|2026-07-01T00:00:00Z"
EOF
# The injected text must be nowhere in the grammar. `org:` is the scope that bounds membership to this
# org, and a second one widens the member set to a repository the marker's author controls.
FX_BODY=$(marker retired '[]' '2026-07-01T00:00:00Z org:attacker')
: > "$WORK/searches"
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
grep -q 'attacker' "$WORK/searches" \
  && ko "an injected qualifier reached the search grammar" \
  || ok "an injected qualifier never reaches the search grammar"
# Reporting a rejected value is itself a vector. The marker lives in an issue body, jq -r turns an
# embedded \n into a real newline, and GitHub reads workflow commands line by line, so an unsanitized
# warning lets the boundary forge a command on the path that rejects it.
# Captured in `$( )`, so EV_* never reach this shell: only the log is under test here.
FX_BODY=$(marker retired '[]' "$(printf '2026-07-01T00:00:00Z\n::error::forged')")
check "a boundary carrying a newline is rejected" frozen live 1/0/1
out=$(evaluate_epic 900 2>&1)
: > "$GITHUB_STEP_SUMMARY"
printf '%s\n' "$out" | grep -q '^::error::forged' \
  && ko "a newline in the boundary forged a workflow command" \
  || ok "and reporting it cannot forge a workflow command"
reset_fixtures

echo
echo "the boundary is compared against a clock that is already minutes old"
# now_epoch is read when the step starts, and a sweep is often minutes into it by the time it reaches
# an Epic, so the skew allowance keeps a tombstone merge-gate wrote moments ago from reading as "the
# future". The guard catches a boundary far enough ahead to hide real history.
FX_QUEUE='[]'
FX_LIVE_MERGED="[$(node a-novel-kit/repo-a 1 MERGED "$AGO40")]"
FX_BODY=$(marker retired '[]' "$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)")
check "a boundary inside the skew allowance is honoured" clear live 0/0/1
FX_BODY=$(marker retired '[]' "$AHEAD")
check "one an hour ahead is still refused" frozen live 1/0/1
reset_fixtures

echo
echo "the boundary does not leak between Epics in one sweep process"
FX_BODY=$(marker retired '[]' "$AGO20")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
FX_BODY="" # the next Epic in the same sweep has no marker at all
: > "$WORK/searches"
evaluate_epic 901 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
[ -z "$SNAP_SINCE" ] && ok "the next Epic starts with no boundary" || ko "SNAP_SINCE leaked: $SNAP_SINCE"
grep -q ':>=' "$WORK/searches" \
  && ko "the previous Epic's boundary bounded this one's searches" \
  || ok "and its searches are unbounded"
reset_fixtures

echo
echo "a degraded marker falls back to the live floor — never a crash, never a freeze on garbage"
FX_BODY=$(marker pending "$BC")
check "a pending marker (the set has not settled)" clear live 1/0/1
# A tombstone exists to carry the boundary; carrying none it says nothing, and saying nothing means the
# Epic's whole history.
FX_BODY=$(marker retired '[]')
check "a tombstone carrying no boundary" clear live 1/0/1
FX_BODY='<!-- epic-membership:snapshot:start -->
[{"since":"2026-07-01T00:00:00Z"}]
<!-- epic-membership:snapshot:end -->'
check "a boundary on a marker that is an array, not an object" clear live 1/0/1
FX_BODY='<!-- epic-membership:snapshot:start -->
{"status":"frozen","members":"nope"}
<!-- epic-membership:snapshot:end -->'
check "members of the wrong type" clear live 1/0/1
FX_BODY='<!-- epic-membership:snapshot:start -->
{{{ not json
<!-- epic-membership:snapshot:end -->'
check "hand-edited garbage" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"noslash","number":2}]')
check "a member repo with no owner" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":"2"}]')
check "a member number that is a string" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":1.5}]')
check "a non-integer member number (a whole-document error)" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":0}]')
check "member number zero" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2147483648}]')
check "a member number past Int range" clear live 1/0/1
FX_BODY=$(marker frozen "$(jq -cn '[range(51) | {repo:"a-novel-kit/repo-b", number:(.+1)}]')")
check "a frozen set over the member cap" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/x\"){pullRequest(number:1){number}}} evil: rateLimit{cost","number":1}]')
check "a member repo carrying a GraphQL injection" clear live 1/0/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo\nEVIL: rateLimit{cost}","number":1}]')
check "a member repo carrying a newline" clear live 1/0/1
# The case the whole-string anchors exist for: jq's `$` matches before a final newline, so a bare
# trailing one passes `^…$`. It emits a raw line break inside a GraphQL string literal, a
# document-level error that no retry clears, wedging the Epic forever.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b\n","number":2}]')
check "a member repo with a bare trailing newline" clear live 1/0/1
# One bad member poisons the whole set, so an injection cannot ride in alongside a legitimate member.
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/x\"){evil","number":1}]')
check "one evil member among valid ones" clear live 1/0/1
# The repo pattern is anchored at both ends: a payload in the prefix still ends in a valid name.
FX_BODY=$(marker frozen '[{"repo":"evil\"){x} a-novel-kit/repo-b","number":2}]')
check "a member repo with an injected prefix" clear live 1/0/1
FX_BODY=$(marker frozen '[]')
check "an empty frozen set" clear live 1/0/1
FX_BODY=FAIL404
check "the Epic issue is absent" clear live 1/0/1
# An unreadable body leaves it unknown whether a snapshot exists, and a `clear` posts success and lifts
# a freeze an earlier pass set. Only a 404 is an answer.
FX_BODY=FAIL500
check "the body read fails outright — decide nothing" error
# A benign notice on stderr must not corrupt the payload: an unreadable body does not fall back to the
# live floor, so it costs a whole pass.
FX_MARKER_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
FX_BODY=NOISE
check "a gh notice on stderr does not corrupt the body" frozen live+snapshot 1/1/1
FX_REHYDRATE=""

echo
echo "a pseudo-fence cannot shadow the real marker"
# merge-gate's splice matches the fence as a whole line, so every reader does too. A substring match
# reads a decoy fence inside an HTML comment as the marker while the writer stays blind to it, and the
# tamper survives every self-heal pass.
FX_BODY=$(printf '%s\n%s\n%s\n\n%s' \
  '<!--- <!-- epic-membership:snapshot:start --> --->' \
  '{"status":"frozen","members":[{"repo":"a-novel-kit/DECOY","number":4242}]}' \
  '<!--- <!-- epic-membership:snapshot:end --> --->' \
  "$(marker frozen "$BC")")
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "a decoy fence in an HTML comment is ignored" frozen live+snapshot 1/1/1
printf '%s' "$EV_OPEN" | jq -e 'any(.repository.nameWithOwner == "a-novel-kit/DECOY")' >/dev/null \
  && ko "the decoy marker was used" || ok "and the real marker is the one that was read"
reset_fixtures

echo
echo "the marker is parsed as JSON, not as a single line of text"
FX_BODY=$(printf '<!-- epic-membership:snapshot:start -->\n%s\n<!-- epic-membership:snapshot:end -->\n' \
  "$(jq -n --argjson m "$BC" '{status:"frozen", members:$m}')") # pretty-printed
FX_REHYDRATE=$(rehydrate "$B" "$C")
check "a pretty-printed marker still freezes" frozen live+snapshot 1/1/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]')
check "a duplicated member is de-duplicated, not double-counted" frozen live+snapshot 1/1/1
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-B","number":2},{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-c","number":3}]')
check "a case-variant duplicate is one member, not two" frozen live+snapshot 1/1/1
# Two distinct members in one repository: cross-repo Epics reuse numbers, so the dedup key is the pair.
# Keyed on repo alone these collapse and the set loses a member.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/repo-b#4":"open false"}')
FX_BODY=$(marker frozen '[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-b","number":4}]')
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/repo-b 4 OPEN)")
check "two members in one repository stay two" frozen live+snapshot 1/1/2
reset_fixtures

echo
echo "a frozen set that cannot be resolved fails closed — it never decides on the live floor alone"
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=FAIL
check "re-hydration fails outright" error
# evaluate_epic returns before it logs anything on this path, so stderr is the only diagnosis.
evaluate_epic 900 2>&1 >/dev/null | grep -q 'could not re-read all 2 frozen member' \
  && ok "the reason reaches the run log" || ko "the fail-closed pass is silent"
: > "$GITHUB_STEP_SUMMARY"
FX_REHYDRATE=$(jq -cn '{data:{m0:null,m1:null}, errors:[{message:"NOT_FOUND"}]}')
check "every alias nulled (data has keys, but no members)" error
# GitHub answers a pullRequest(number:) that does not exist with a null and no errors array, so the
# member count is what stands between a short answer and a silent clear.
FX_REHYDRATE=$(jq -cn --argjson b "$B" '{data:{m0:{pullRequest:$b}, m1:{pullRequest:null}}}')
check "a short answer carrying no errors array" error
FX_REHYDRATE=$(jq -cn --argjson b "$B" '{data:{m0:{pullRequest:$b}, m1:{pullRequest:null}}, errors:[{message:"timeout"}]}')
check "one alias nulled — a short answer is not a clean set" error
FX_REHYDRATE=$(rehydrate "$B" "$C" | jq -c '. + {errors:[{message:"something went wrong"}]}')
check "a complete answer that still reports errors is not trusted" error
FX_REHYDRATE=$(rehydrate "$B" "$(node a-novel-kit/UNRELATED 4242 OPEN)")
# Give the intruder full REST + queue backing, so `error` comes from the identity check rejecting it
# and not from the harness running out of fixtures for a PR it never expected.
FX_REST=$(printf '%s' "$FX_REST" | jq -c '. + {"a-novel-kit/UNRELATED#4242":"open false"}')
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"},{"number":4242,"state":"QUEUED","headOid":"sha4242"}]'
check "a node for a pull request nobody asked about" error
FX_QUEUE='[{"number":3,"state":"QUEUED","headOid":"sha3"}]'
FX_REHYDRATE=$(rehydrate "$B" "$(jq -cn --argjson c "$C" '$c | del(.state)')")
check "a member whose state is missing" error

echo
echo "transient failures retry, then the floor's own failures fail closed"
FX_REHYDRATE=$(rehydrate "$B" "$C")
printf 2 > "$WORK/rehydrate_fails"
check "re-hydration recovers on the third attempt" frozen live+snapshot 1/1/1
reset_fixtures
for which in merged closed open; do
  reset_fixtures
  FX_SEARCH_FAIL_ON="$which"
  check "a failed '$which' member search fails closed" error
done
FX_SEARCH_FAIL=true
check "all searches failing fails closed" error
reset_fixtures
FX_LIVE_CLOSED="[$B]"
FX_REST_FAIL_ON='a-novel-kit/repo-a#1'
check "a failed REST read of the merged member fails closed" error
reset_fixtures
FX_LIVE_CLOSED="[$B]"
FX_REST_FAIL_ON='a-novel-kit/repo-b#2'
check "a failed REST read of the closed member fails closed" error
reset_fixtures
FX_QUEUE='[]'
FX_REST_FAIL_ON='a-novel-kit/repo-c#3'
check "a failed REST read of a candidate stray fails closed" error
reset_fixtures
FX_REST_FAIL=true
FX_LIVE_CLOSED="[$B]"
check "every REST read failing fails closed" error
reset_fixtures
FX_QUEUE_FAIL=true
check "a failed merge-queue read" error

echo
echo "state does not leak between Epics in one sweep process"
reset_fixtures
FX_BODY=$(marker frozen "$BC")
FX_REHYDRATE=$(rehydrate "$B" "$C")
evaluate_epic 900 >/dev/null 2>&1
: > "$GITHUB_STEP_SUMMARY"
FX_BODY="" # the next Epic has no snapshot at all
check "an Epic with no snapshot sees none of the previous one's" clear live 1/0/1

echo
echo
echo "one read of the Epic issue per pass"
# The pause check wants .labels and the snapshot reader wants .body, and one response carries both.
# Two reads cost a request per Epic per sweep and leave a window in which the Epic is paused between
# them, so a pass would act on two views of one issue. Driven against an uncleared cache, which is
# how a real pass runs.
reset_fixtures
FX_BODY=$(marker frozen "$BC")
epic_cache_clear; : > "$WORK/gh_calls"
epic_paused 900 && true
uncached_evaluate_epic 900 >/dev/null 2>&1
reads=$(grep -c 'issues/900' "$WORK/gh_calls" || true)
eq "the pause check and the snapshot share one read" "$reads" 1

echo
echo "the two readers keep their own failure policies"
# They disagree on purpose. A pause that cannot be read must fail OPEN, or a blip on the label read
# stops the sweep and a real partial landing goes uncaught. A snapshot that cannot be read must fail
# CLOSED, because a false clear posts success and lifts a standing freeze. Caching a shared verdict
# would put one of them on the other's policy.
reset_fixtures
FX_BODY=FAIL500
epic_cache_clear
epic_paused 900 && rc=0 || rc=$?
eq "an unreadable issue leaves the pause unknown" "$rc" 2
snapshot_buckets 900 >/dev/null 2>&1 && rc=0 || rc=$?
eq "and the same response decides no snapshot" "$rc" 1

reset_fixtures
FX_BODY=FAIL404
epic_cache_clear
epic_paused 900 && rc=0 || rc=$?
eq "a missing Epic issue is not paused, rather than unknown" "$rc" 1
snapshot_buckets 900 >/dev/null 2>&1 && rc=0 || rc=$?
eq "and carries no snapshot" "$rc" 2

echo
echo "the pause marker is read from the shared response"
reset_fixtures
FX_LABELS='[{"name":"automation:paused"}]'
epic_cache_clear
epic_paused 900 && rc=0 || rc=$?
eq "automation:paused is seen" "$rc" 0
reset_fixtures
FX_LABELS='[{"name":"automation:paused-not-really"},{"name":"bug"}]'
epic_cache_clear
epic_paused 900 && rc=0 || rc=$?
eq "a label merely containing it is not a pause" "$rc" 1

echo
echo "the claim index reaches Epics through their own frozen snapshot"
# The sweep otherwise finds active Epics only through epic:<N> labels on open pull requests, so an
# Epic whose last labeled open pull request was de-labeled would vanish from enumeration. The claim
# index lists the planning repo's open issues directly and returns the ones carrying a frozen marker.
issue_obj() { jq -cn --argjson n "$1" --arg b "$2" '{number:$n, body:$b, labels:[]}'; }
pr_obj() { jq -cn --argjson n "$1" '{number:$n, body:"", pull_request:{url:"x"}}'; }
claim_of() { CLAIM_EPICS=''; epic_cache_clear; build_claim_index >/dev/null 2>&1; printf '%s' "$CLAIM_EPICS" | grep -c '^[0-9]' | tr -d ' '; }
claims() { printf '%s' "$CLAIM_EPICS" | grep -E '^[0-9]+$' | sort -n | paste -sd, -; }

# A PR row carrying a frozen-marker body would be claimed if the pull-request filter were dropped, so
# the fixture makes the skip observable rather than incidental to an empty body.
reset_fixtures
FX_ISSUE_LIST=$(jq -cs '.' <<EOF
$(issue_obj 700 "$(marker frozen "$BC")")
$(issue_obj 701 "$(marker pending "$BC")")
$(issue_obj 702 "$(marker retired '[]' "$AGO20")")
$(issue_obj 703 "No marker here at all.")
$(issue_obj 705 "$(marker frozen '[]')")
$(jq -cn --argjson n 704 --arg b "$(marker frozen "$BC")" '{number:$n, body:$b, pull_request:{url:"x"}}')
EOF
)
epic_cache_clear; build_claim_index >/dev/null 2>&1
eq "a frozen snapshot is claimed" "$(claims)" 700
grep -qx 701 <<< "$CLAIM_EPICS" && ko "a pending marker was claimed" || ok "a pending marker is not claimed (not authoritative yet)"
grep -qx 702 <<< "$CLAIM_EPICS" && ko "a retired tombstone was claimed" || ok "a retired tombstone is not claimed (names no members)"
grep -qx 703 <<< "$CLAIM_EPICS" && ko "an unmarked issue was claimed" || ok "an unmarked issue is not claimed"
grep -qx 705 <<< "$CLAIM_EPICS" && ko "a frozen marker with no members was claimed" || ok "a frozen marker with an empty member set is not claimed"
grep -qx 704 <<< "$CLAIM_EPICS" && ko "a pull request row was claimed" || ok "a pull request row is skipped even carrying a frozen body"

echo
echo "the claim index primes the per-issue cache"
# It reads every open issue once; a later snapshot read of the same number must resolve from that
# primed body, not spend a second request. The single-issue stub is armed with a DIFFERENT body, so a
# read that reached the network would resolve the wrong set and the assertion would catch it.
reset_fixtures
FX_ISSUE_LIST=$(jq -cs '.' <<EOF
$(issue_obj 700 "$(marker frozen "$BC")")
EOF
)
# The single-issue stub is armed with a MARKERLESS body, so a read that reached the network would
# find no frozen set and return 2 without ever attempting the member re-read. The primed body carries
# a frozen marker, so snapshot_buckets attempts that re-read (a graphql call) — which is how the two
# sources are told apart without arming the full rehydrate fixture.
FX_BODY="No marker — this is the network answer, which priming must make unreachable."
epic_cache_clear; build_claim_index >/dev/null 2>&1
: > "$WORK/gh_calls"
snapshot_buckets 700 >/dev/null 2>&1
eq "no issue read was made after priming" "$(grep -c 'issues/700' "$WORK/gh_calls" | tr -d ' ')" 0
[ "$(grep -c graphql "$WORK/gh_calls")" -gt 0 ] \
  && ok "and the primed frozen marker drove a member re-read (the markerless network body would not)" \
  || ko "no member re-read attempted — the markerless network body was used, not the primed one"
grep -qx 700 <<< "$CLAIM_EPICS" && ok "and the primed frozen Epic is claimed" || ko "the frozen Epic was not claimed"

echo
echo "the claim index fails soft"
# The claim set is unioned with the label set and only ever widens it, so a list failure must cost the
# de-label rescue for one pass and never abort the sweep or narrow what labels already reach.
reset_fixtures
FX_ISSUE_LIST=FAIL
CLAIM_EPICS='sentinel'
build_claim_index >/dev/null 2>&1 && rc=0 || rc=$?
eq "a list failure returns success (soft)" "$rc" 0
eq "and claims nothing" "$(printf '%s' "$CLAIM_EPICS" | grep -c '^[0-9]' | tr -d ' ')" 0

echo
echo "extract_marker reads a marker, or nothing"
# The one reader both the claim index and snapshot_buckets ask "is there a marker" through. A body
# with no fences must yield empty, not a placeholder that later parses as present.
eq "a frozen body yields its marker object" \
  "$(extract_marker "$(marker frozen "$BC")" | jq -r '.status')" frozen
eq "a body with no fences yields nothing" "$(extract_marker "just prose, no fences")" ""

echo
echo "enumeration is the union of labels and claims"
# The exact line sweep_main runs, lifted from the manifest rather than restated, so a claim-derived and
# a label-derived Epic both appear once and dropping the union is observable here.
UNION_LINE=$(awk '/epics=\$\(printf .* "\$label_epics" "\$CLAIM_EPICS"/{sub(/^[[:space:]]*/,""); print; exit}' "$ACTION")
[ -n "$UNION_LINE" ] || { echo "::error::could not read the enumeration union from $ACTION"; exit 1; }
union() { local label_epics="$1" CLAIM_EPICS="$2" epics; eval "$UNION_LINE"; printf '%s' "$epics" | paste -sd, -; }
eq "a claim-only Epic joins the label set" "$(union "$(printf '810\n')" "$(printf '700\n')")" 700,810
eq "an Epic reached both ways appears once" "$(union "$(printf '700\n')" "$(printf '700\n')")" 700
eq "a non-numeric token is dropped" "$(union "$(printf '700\nfoo\n')" "")" 700

printf '%d passed, %d failed\n' "$pass" "$fail"
# A floor on the count as well as on failures: a suite that runs no assertions exits 0 and reads as
# green. Raise this when assertions are added; never lower it to make a run pass.
# Failures are reported first, since they are the useful diagnosis. The floor covers assertions that
# never ran, so it counts executions (pass + fail); counting passes alone turns an ordinary failure
# into a truncated-suite report.
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -lt 155 ]; then
  echo "::error::only $ran assertion(s) ran (expected at least 155) — the suite did not execute fully"
  exit 1
fi
