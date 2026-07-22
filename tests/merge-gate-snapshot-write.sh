#!/usr/bin/env bash
# Regression tests for merge-gate's activation-snapshot write path.
#
# Same approach as tests/detect-partial-landing.sh: the functions under test are EXTRACTED verbatim
# from the action manifest and sourced, so the shipped code is what runs here. Only `gh` is stubbed.
#
# What this covers is the lost-update race. The reconcile sweep runs merge-gate as a matrix over
# every open member pull request with no concurrency bound, and render-epic-status edits the same
# issue body from a job that does not wait for it — so several writers overlap by design, against an
# API with no conditional update. The guard is read-modify-verify, and its failure modes (a writer
# undoing a peer's frozen marker, or reporting success on a write that was reverted) are the kind
# that reasoning alone gets wrong.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/merge-gate/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() { # $1 = function name — lift it out of the run: block and de-indent
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\) \\{" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}
for fn in splice write_marker; do
  out=$(extract "$fn")
  if [ -z "$out" ]; then
    echo "::error::could not extract $fn from $ACTION — did its definition move or change indent?"
    exit 1
  fi
  printf '%s\n' "$out" >> "$WORK/lib.sh"
done
if ! bash -n "$WORK/lib.sh"; then
  echo "::error::extracted functions do not parse — extraction truncated a definition"
  exit 1
fi

export ORG=a-novel-kit PLANNING_REPO=.github EPIC=900
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
START='<!-- epic-membership:snapshot:start -->'
END='<!-- epic-membership:snapshot:end -->'
sleep() { :; }

# ---- the stubbed body store ---------------------------------------------------------------
# BODY_FILE is the "issue body" on the server. FX_STEAL, when set, simulates a concurrent writer
# that lands immediately AFTER our edit, on the given attempt — the case an exit-code check misses.
gh() {
  case "$*" in
    *"issues/${EPIC}"*)
      # File-backed: reads happen inside $( ), so a shell-variable countdown would never reach the
      # parent and every read would keep failing.
      if [ "$(< "$WORK/read_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/read_fails") - 1))" > "$WORK/read_fails"
        return 1
      fi
      cat "$WORK/body"
      ;;
    *"issue edit"*)
      # NOTE: ${*##pattern} strips per-positional-parameter and rejoins — join first, then strip.
      local all="$*" f
      f="${all##*--body-file }"; f="${f%% *}"
      cp "$f" "$WORK/body"
      # A peer write landing after ours, exactly once, on the nominated attempt.
      if [ -n "$FX_STEAL" ]; then
        printf '%s\n' "$FX_STEAL" > "$WORK/body"
        FX_STEAL=""
      fi
      ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}

region() { # status members-json -> a region file, exactly as the action builds it
  local payload note f
  if [ "$1" = frozen ]; then
    payload=$(jq -cn --argjson m "$2" '{status:"frozen", members:$m}')
    note='_Epic membership, FROZEN at activation by the merge-gate. Do not edit._'
  else
    payload=$(jq -cn --arg s "$1" --argjson m "$2" '{status:$s, at:"2026-07-22T10:00:00Z", members:$m}')
    note='_Epic membership, PENDING — stabilizing before it freezes. Do not edit._'
  fi
  f=$(mktemp)
  { echo "$START"; echo "$note"; printf '%s\n' "$payload"; echo "$END"; } > "$f"
  printf '%s' "$f"
}
body_with() { # a server body already carrying a marker
  printf 'Some prose.\n\n%s\n_note_\n%s\n%s\n\nMore prose.\n' "$START" "$1" "$END" > "$WORK/body"
}
marker_now() { # what the marker on the server says
  awk -v s="$START" -v e="$END" '$0==s{f=1;next} $0==e{f=0} f' "$WORK/body" \
    | sed -n '/^[[:space:]]*[{[]/,$p' | jq -c '.' 2>/dev/null
}

M2='[{"repo":"a-novel-kit/repo-a","number":1},{"repo":"a-novel-kit/repo-b","number":2}]'
M1='[{"repo":"a-novel-kit/repo-a","number":1}]'

# shellcheck disable=SC1091
. "$WORK/lib.sh"

pass=0
fail=0
ok() { printf '  ✓ %s\n' "$1"; pass=$((pass + 1)); }
ko() { printf '  ✗ %s\n' "$1"; fail=$((fail + 1)); }

reset() { printf 0 > "$WORK/read_fails"; FX_STEAL=""; printf 'Some prose.\n\nMore prose.\n' > "$WORK/body"; : > "$GITHUB_STEP_SUMMARY"; }

echo "the ordinary write"
reset
do=pending; payload=$(jq -cn --arg at "2026-07-22T10:00:00Z" --argjson m "$M2" '{status:"pending", at:$at, members:$m}')
write_marker "$(region pending "$M2")" && ok "a pending marker is written" || ko "the write failed"
[ "$(marker_now | jq -r .status)" = pending ] && ok "and the server carries it" || ko "server body has no pending marker"
grep -q 'Some prose' "$WORK/body" && ok "human prose either side is preserved" || ko "prose was dropped"

echo
echo "a peer that writes after us"
# The edit succeeds, then a concurrent writer overwrites it. An exit-code check would call this a win.
reset
body_with "$(jq -cn --argjson m "$M2" '{status:"pending", at:"2026-07-22T09:00:00Z", members:$m}')"
do=frozen; payload=$(jq -cn --argjson m "$M2" '{status:"frozen", members:$m}')
FX_STEAL=$(printf 'Some prose.\n\n%s\n_note_\n%s\n%s\n' "$START" "$(jq -cn --argjson m "$M1" '{status:"pending", at:"2026-07-22T09:30:00Z", members:$m}')" "$END")
write_marker "$(region frozen "$M2")" && ok "the write is retried until it survives" || ko "gave up despite a retry being available"
[ "$(marker_now | jq -r .status)" = frozen ] && ok "and frozen is what finally stands" || ko "the peer's write won"

echo
echo "frozen is terminal — a pending writer must not undo it"
reset
body_with "$(jq -cn --argjson m "$M2" '{status:"frozen", members:$m}')"
do=pending; payload=$(jq -cn --arg at "2026-07-22T10:00:00Z" --argjson m "$M1" '{status:"pending", at:$at, members:$m}')
write_marker "$(region pending "$M1")" && ok "the pending writer reports success" || ko "it failed instead of yielding"
[ "$(marker_now | jq -r .status)" = frozen ] && ok "and the frozen marker is left intact" || ko "a pending write clobbered frozen"
[ "$(marker_now | jq -r '.members | length')" = 2 ] && ok "with its member set untouched" || ko "the frozen member set changed"
grep -q 'another writer froze the snapshot first' "$GITHUB_STEP_SUMMARY" \
  && ok "and it says so in the run log" || ko "the yield is silent"

echo
echo "a frozen writer may still write frozen"
reset
body_with "$(jq -cn --argjson m "$M2" '{status:"frozen", members:$m}')"
do=frozen; payload=$(jq -cn --argjson m "$M2" '{status:"frozen", members:$m}')
write_marker "$(region frozen "$M2")" && ok "an idempotent re-write succeeds" || ko "it refused its own value"

echo
echo "read failures"
reset
do=pending; payload=$(jq -cn --arg at "2026-07-22T10:00:00Z" --argjson m "$M2" '{status:"pending", at:$at, members:$m}')
printf 2 > "$WORK/read_fails"
write_marker "$(region pending "$M2")" && ok "two failed reads still converge on the third attempt" || ko "gave up too early"
reset
printf 99 > "$WORK/read_fails"
do=pending; payload=$(jq -cn --arg at "2026-07-22T10:00:00Z" --argjson m "$M2" '{status:"pending", at:$at, members:$m}')
write_marker "$(region pending "$M2")" && ko "reported success with every read failing" || ok "a total read failure gives up rather than claiming success"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -lt 12 ]; then
  echo "::error::only $ran assertion(s) ran (expected at least 12) — the suite did not execute fully"
  exit 1
fi
