#!/usr/bin/env bash
# Regression tests for merge-gate's activation-snapshot write path.
#
# Same approach as tests/detect-partial-landing.sh: the functions under test are extracted verbatim
# from the action manifest and sourced, and only `gh` is stubbed. It drives `write_marker` and its
# helpers plus the decision and payload the step builds before calling it — all lifted from the
# manifest rather than restated, so a fixture cannot encode a belief about the format.
#
# What it covers is the lost-update race: the reconcile sweep runs merge-gate as an unbounded matrix
# over every open member pull request while render-epic-status edits the same issue body, against an
# API with no conditional update. The write also acts on a decision made earlier — `$do` and
# `$payload` come from a body read before the loop — so a writer that re-reads without re-deriving
# freezes a set the world has moved past, and a retry loop makes it win.
set -euo pipefail

TOP_PID=$$
die() { echo "::error::$1" >&2; kill -s TERM "$TOP_PID"; exit 1; }

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
for fn in splice current_marker since_of same_marker marker_settled write_marker; do
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
# The re-derive guard re-checks age, so the harness supplies the same clock the step does.
export STABILIZE_SECONDS=120
now=2026-07-22T10:00:00Z
export GITHUB_STEP_SUMMARY="$WORK/summary.md"
# Fences and region layout are read out of the manifest. The fence literal is shared by merge-gate,
# epic-membership and detect-partial-landing, so a copy restated here could not catch the writer
# drifting away from both readers. The order inside the region matters: put the payload above the
# note and `current_marker` reads every marker as absent.
START=$(sed -n "s/^ *START='\(.*\)'\$/\1/p" "$ACTION" | head -1)
END=$(sed -n "s/^ *END='\(.*\)'\$/\1/p" "$ACTION" | head -1)
if [ -z "$START" ] || [ -z "$END" ]; then die "could not read the fence literals from $ACTION"; fi
# Matched without regard to indentation, so wrapping the block in a conditional does not silently
# stop the anchor from matching.
REGION_BLOCK=$(awk '
  /^[[:space:]]*\{$/ { buf=""; inb=1; next }
  inb && /^[[:space:]]*\} > "\$regionf"$/ { printf "%s", buf; exit }
  inb { buf = buf $0 "\n" }
' "$ACTION")
[ -n "$REGION_BLOCK" ] || die "could not read the region block from $ACTION"
sleep() { :; }

# ---- the stubbed body store ---------------------------------------------------------------
# $WORK/body is the issue body on the server. $WORK/steal, when non-empty, is a peer write that lands
# immediately after ours, once — the case an exit-code check calls a win. It models what render-epic-
# status does: keep what it found and add its own section outside our region, so a lost update shows
# up as that section disappearing.
gh() {
  case "$*" in
    *"issues/${EPIC}"*)
      # File-backed: reads run inside $( ), so a shell-variable countdown would never reach the parent.
      printf 'r' >> "$WORK/reads"
      if [ "$(< "$WORK/read_fails")" -gt 0 ]; then
        printf '%s' "$(($(< "$WORK/read_fails") - 1))" > "$WORK/read_fails"
        return 1
      fi
      # Fail every read from the Nth onward, so a read failure can follow an edit failure — the only
      # order in which the per-attempt `err` reset is observable.
      if [ -s "$WORK/read_fail_from" ] && [ "$(wc -c < "$WORK/reads")" -ge "$(< "$WORK/read_fail_from")" ]; then
        return 1
      fi
      # GitHub stores bodies with CRLF, so the stub serves them that way and the action's
      # `tr -d '\r'` is exercised.
      sed 's/$/\r/' "$WORK/body"
      ;;
    *"issue edit"*)
      [ -s "$WORK/edit_fails" ] && { printf 'x' >> "$WORK/writes"; echo "gh: HTTP 422" >&2; return 1; }
      # ${*##pattern} strips per positional parameter and rejoins, so join first and strip after.
      local all="$*" f
      f="${all##*--body-file }"; f="${f%% *}"
      printf 'x' >> "$WORK/writes"
      # A write that silently does not land — the API returned success but the body is unchanged.
      [ -s "$WORK/noop" ] || cp "$f" "$WORK/body"
      # Real `gh issue edit` prints the issue URL on success, so a run that captures its stdout into
      # the error variable is visible here.
      echo "https://github.com/${ORG}/${PLANNING_REPO}/issues/${EPIC}"
      # File-backed for the same reason as read_fails: the write runs inside $( ), so clearing a
      # shell variable here would never reach the parent and the peer would strike on every attempt.
      if [ -s "$WORK/steal" ]; then cp "$WORK/steal" "$WORK/body"; : > "$WORK/steal"; fi
      ;;
    *) echo "unexpected gh call: $*" >&2; return 1 ;;
  esac
}

# repo-a carries the higher number, so sorting by repo and sorting by number give different answers
# and a guard using the wrong key is observable.
M1='[{"repo":"a-novel-kit/repo-a","number":5}]'
M2='[{"repo":"a-novel-kit/repo-a","number":5},{"repo":"a-novel-kit/repo-b","number":2}]'
# Same size as M2, different members, so comparing lengths is distinguishable from comparing sets.
M2B='[{"repo":"a-novel-kit/repo-a","number":5},{"repo":"a-novel-kit/repo-c","number":3}]'
# Two members in one repo, numbers out of input order: sorting by repo alone is stable and leaves
# them as given, so the canonical order needs the composite (repo, number) key.
M2S='[{"repo":"a-novel-kit/repo-a","number":2},{"repo":"a-novel-kit/repo-a","number":9}]'

# $3, where present, is the wave boundary the marker carries forward.
pending_json() { jq -cn --arg at "${2:-2026-07-22T10:00:00Z}" --arg s "${3:-}" --argjson m "$1" \
  '{status:"pending", at:$at, members:$m} + (if $s == "" then {} else {since:$s} end)'; }
frozen_json() { jq -cn --arg at "${2:-2026-07-22T10:00:00Z}" --arg s "${3:-}" --argjson m "$1" \
  '{status:"frozen", at:$at, members:$m} + (if $s == "" then {} else {since:$s} end)'; }
retired_json() { jq -cn --arg s "$1" '{status:"retired", since:$s}'; }

# The note the action writes, read out of the manifest: a note beginning with `[` or `{` makes
# current_marker latch onto it and read every marker as absent, which a restated copy cannot show.
note_of() { # frozen|pending|retire
  local key
  case "$1" in frozen) key=FROZEN ;; retire) key=RETIRED ;; *) key=PENDING ;; esac
  sed -n "s/^ *note=\"\(_Epic membership, $key.*\)\"$/\1/p" "$ACTION" | head -1
}
region_file() { # $1 = payload json, $2 = frozen|pending -> the region the action itself would build
  local f note payload
  note=$(note_of "${2:-pending}")
  [ -n "$note" ] || die "could not read the note text from $ACTION"
  payload="$1"
  f=$(mktemp -p "$WORK")
  # shellcheck disable=SC2034  # REGION_BLOCK, lifted from the manifest, redirects into regionf.
  local regionf="$f"
  # Run the manifest's own assembly. `$( )` strips the trailing newline, so the closing brace needs
  # its own separator or bash reads it as an argument to the last command.
  eval "{ $REGION_BLOCK
} > \"\$regionf\""
  printf '%s' "$f"
}
server_body() { # $1 = marker json, or empty for a body with no marker
  if [ -z "${1:-}" ]; then
    printf 'Some prose.\n\nMore prose.\n' > "$WORK/body"
  else
    printf 'Some prose.\n\n%s\n%s\n%s\n%s\n\nMore prose.\n' "$START" "$(note_of pending)" "$1" "$END" > "$WORK/body"
  fi
}
marker_now() { current_marker "$(cat "$WORK/body")"; }
writes() { wc -c < "$WORK/writes" | tr -d ' '; }

# shellcheck disable=SC1091
. "$WORK/lib.sh"

pass=0
fail=0
ok() { printf '  ✓ %s\n' "$1"; pass=$((pass + 1)); }
ko() { printf '  ✗ %s\n' "$1"; fail=$((fail + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (got '$2', want '$3')"; fi; }

reset() {
  printf 0 > "$WORK/read_fails"; : > "$WORK/writes"; : > "$WORK/steal"; : > "$WORK/noop"
  : > "$WORK/edit_fails"; : > "$WORK/read_fail_from"; : > "$WORK/reads"
  : > "$GITHUB_STEP_SUMMARY"; server_body ""
}
# Capture the function's output so it cannot be mistaken for the exit code, and so tee'd and plain
# log lines are asserted from one place. write_marker re-derives against `cur` out of the
# environment, so name it here — a case that forgets it then fails by name, not inside the extraction.
run() { : "${cur:?}"; write_marker "$(region_file "$payload" "$do")" > "$WORK/out" 2>&1 && echo 0 || echo $?; }
said() { grep -q "$1" "$WORK/out"; }

# The member normalization, lifted from the manifest. It decides what `$cur` is, so the
# members-moved branch and both re-derive guards rest on it.
NORMALIZE_JQ=$(awk '/^ *cur=\$\(printf/{f=1;next} f{print} f&&/\)$/{exit}' "$ACTION" \
  | sed "s/^[[:space:]]*'//; s/')$//")
[ -n "$NORMALIZE_JQ" ] || die "could not read the member normalization from $ACTION"
normalize() { printf '%s' "$1" | jq -c "$NORMALIZE_JQ" 2>/dev/null || echo '[]'; }

# The decision program, lifted whole, so the suite watches the step decide instead of being handed
# `do` as an input.
DECIDE_JQ=$(awk "
  /do=\\\$\\(jq -rn/ { f=1 }
  f && !st && /'\$/ { st=1; next }
  st && /' 2>\\/dev\\/null \\|\\| echo skip\\)\$/ { sub(/'.*\$/, \"\"); print; exit }
  st { print }
" "$ACTION")
[ -n "$DECIDE_JQ" ] || die "could not read the decision program from $ACTION"
decide() { # $1 = marker json (or null), $2 = all_landed, $3 = cur members
  jq -rn --argjson cur "${3:-$M2}" --argjson mk "$1" --arg now "$now" \
    --argjson landed "$2" --argjson thr "$STABILIZE_SECONDS" "$DECIDE_JQ" 2>/dev/null || echo skip
}

# The landed test, also lifted. It decides a wave is over, and it sits in bash beside the decision
# program rather than inside it, so it needs its own anchor.
LANDED_JQ=$(awk '/all_landed=/{f=1;next} f{ sub(/^[[:space:]]*'"'"'/, ""); sub(/'"'"'.*$/, ""); print; exit }' "$ACTION")
[ -n "$LANDED_JQ" ] || die "could not read the landed test from $ACTION"
landed_of() { printf '%s' "$1" | jq -c "$LANDED_JQ" 2>/dev/null || echo false; }

# The payload and note assembly, lifted whole, so a payload losing its timestamp or its boundary is
# observable here.
PAYLOAD_BLOCK=$(awk '/if \[ "\$do" = "retire" \]; then/{f=1} f{print} f&&/^[[:space:]]*fi$/{exit}' "$ACTION")
[ -n "$PAYLOAD_BLOCK" ] || die "could not read the payload assembly from $ACTION"
# The retire-only bail, lifted the same way. It is inline step logic rather than a function, and it
# bounds what a held pull request may do once it reaches the capture step.
BAIL_BLOCK=$(awk '/RETIRE_ONLY:-/{f=1} f{print} f&&/^[[:space:]]*fi$/{exit}' "$ACTION")
[ -n "$BAIL_BLOCK" ] || die "could not read the retire-only bail from $ACTION"
bails() { # $1 = RETIRE_ONLY, $2 = do -> "bailed" (the step returned) or "went-on"
  # shellcheck disable=SC2034  # BAIL_BLOCK, lifted from the manifest, reads both out of the scope.
  local out RETIRE_ONLY="$1" "do"="$2"
  out=$( eval "$BAIL_BLOCK" >/dev/null 2>&1; printf 'went-on' )
  [ -n "$out" ] && echo went-on || echo bailed
}

# The rehearsal branch, lifted the same way. It stands between the assembled payload and the write,
# so what it reports is what would have been written rather than a second rendering of it.
DRY_BLOCK=$(awk '/SNAPSHOT_DRY_RUN:-/{f=1} f{print} f&&/^[[:space:]]*fi$/{exit}' "$ACTION")
[ -n "$DRY_BLOCK" ] || die "could not read the rehearsal branch from $ACTION"
rehearses() { # $1 = SNAPSHOT_DRY_RUN, $2 = do, $3 = cur, $4 = payload -> the log, or "went-on"
  # Local, so a rehearsal cannot disturb the case in progress; DRY_BLOCK reads all four by name.
  # shellcheck disable=SC2034
  local out SNAPSHOT_DRY_RUN="$1" "do"="$2" cur="$3" payload="$4"
  out=$( eval "$DRY_BLOCK" 2>/dev/null; printf 'went-on' )
  printf '%s' "$out"
}

payload_for() { # $1 = do, $2 = cur, $3 = inherited since -> echoes the payload, sets NOTE_OUT
  local "do" cur inherited_since payload note
  do="$1"; cur="$2"; inherited_since="${3:-}"
  eval "$PAYLOAD_BLOCK"
  NOTE_OUT="$note"
  printf '%s' "$payload"
}

echo "the member set is canonical, whatever casing GitHub answers with"
# GitHub resolves repository names case-insensitively and may answer with either spelling. If the
# normalized set differs between passes the decision reads "members moved", resets the stabilization
# clock, and the Epic never freezes.
mixed='[{"repo":"A-Novel-Kit/repo-b","number":2},{"repo":"a-novel-kit/repo-a","number":1}]'
lower='[{"repo":"a-novel-kit/repo-b","number":2},{"repo":"a-novel-kit/repo-a","number":1}]'
eq "two casings of one set normalize identically" "$(normalize "$mixed")" "$(normalize "$lower")"
eq "and the stored names are canonical" \
  "$(normalize "$mixed" | jq -r '[.[].repo] | join(",")')" "a-novel-kit/repo-a,a-novel-kit/repo-b"
eq "input order does not change the set" \
  "$(normalize "$lower")" "$(normalize "$(printf '%s' "$lower" | jq -c 'reverse')")"
eq "a case-variant duplicate is one member" \
  "$(normalize '[{"repo":"a-novel-kit/R","number":1},{"repo":"a-novel-kit/r","number":1}]' | jq 'length')" 1

echo "the marker contract is shared by three actions"
# A fixture derived from the manifest follows merge-gate's fences wherever they move, so the writer
# drifting away from its two readers is asserted separately.
for d in epic-membership detect-partial-landing; do
  f="$ROOT/generic-actions/$d/action.yaml"
  if [ ! -f "$f" ]; then ko "$d/action.yaml is missing"; continue; fi
  if grep -qF -- "$START" "$f" && grep -qF -- "$END" "$f"; then
    ok "$d uses the same fences as the writer"
  else
    ko "$d has drifted from merge-gate's fences — the snapshot would be invisible to it"
  fi
done

echo "the ordinary write"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "a fresh pending marker is written" "$(run)" 0
eq "and the server carries it" "$(marker_now | jq -r .status)" pending
if grep -q 'Some prose' "$WORK/body"; then ok "human prose either side survives"; else ko "prose was dropped"; fi

echo
echo "a peer that writes after us"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
# The peer reverts the body, discarding our write. A pending decision survives that, so the pass
# notices the loss and retries; the edit's exit code says nothing about it.
{ cat "$WORK/body"; printf '\n<!-- rendered by the peer -->\n'; } > "$WORK/steal"
eq "we retry until our write survives" "$(run)" 0
eq "and our marker is what finally stands" "$(marker_now | jq -r '.members | length')" 2
eq "which took two writes, not one" "$(writes)" 2
if grep -q 'rendered by the peer' "$WORK/body"; then
  ok "and the peer's own edit outside our region survives"
else
  ko "LOST UPDATE: we overwrote the peer's edit"
fi

echo
echo "a wiped marker invalidates a freeze in flight"
# A freeze means "the set held still since this pending marker". If the marker is gone, that premise
# cannot be re-established, so the pass abandons.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:00:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
printf 'Some prose.\n\nMore prose.\n' > "$WORK/steal"   # a peer that removes the marker outright
eq "the freeze is abandoned once its pending basis disappears" "$(run)" 2

echo
echo "frozen is terminal"
reset
server_body "$(frozen_json "$M2")"
do=pending; cur="$M1"; payload=$(pending_json "$M1")
eq "a pending writer yields rather than resetting it" "$(run)" 2
eq "the frozen marker is left intact" "$(marker_now | jq -r .status)" frozen
eq "with its member set untouched" "$(marker_now | jq -r '.members | length')" 2
eq "and nothing was written" "$(writes)" 0
if said 'already frozen'; then ok "and it says so in the run log"; else ko "the yield is silent"; fi

echo
echo "a stale freeze must not become permanent"
# Our pass decided `frozen` against members=M2, and a peer has since seen the set change to M1 and
# reset the clock. Freezing M2 now makes a superseded set terminal, and the gate then holds the member
# it drops forever.
reset
server_body "$(pending_json "$M1" 2026-07-22T10:05:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "the writer abandons instead of freezing a superseded set" "$(run)" 2
eq "the peer's pending marker stands" "$(marker_now | jq -r .status)" pending
eq "with the peer's member set" "$(marker_now | jq -r '.members | length')" 1
eq "and nothing was written" "$(writes)" 0
if said 'member set moved'; then ok "and the abandonment is explained"; else ko "abandoning is silent"; fi

echo
echo "equivalent writers agree instead of fighting"
# Two writers with the same member set differ only in `at`. Under byte equality neither satisfies the
# other, and both ping-pong to exhaustion reporting a failure that never happened.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:59:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2" 2026-07-22T10:00:00Z)
eq "an equivalent marker already present counts as done" "$(run)" 0
eq "and no redundant write is issued" "$(writes)" 0

echo
echo "an orphaned payload line does not satisfy the verify"
# splice's recovery path strips fence lines but leaves old JSON behind as prose. A whole-body grep
# would match that orphan and report success while the region says something else.
reset
orphan=$(frozen_json "$M2")
# The body carries our exact payload as loose prose plus a region saying something else, and the
# write does not land.
printf 'Some prose.\n%s\n\n%s\n%s\n%s\n%s\n' "$orphan" "$START" "$(note_of pending)" \
  "$(pending_json "$M2" 2026-07-22T09:00:00Z)" "$END" > "$WORK/body"
printf 'x' > "$WORK/noop"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a write that never landed is not masked by the orphan" "$(run)" 1
eq "and the region still says what it did" "$(marker_now | jq -r .status)" pending

echo "a marker that cannot age must be repaired, not accepted"
# The decision step routes a corrupt or missing `at` here: a timestamp that cannot be read never
# ages, leaving the marker pending forever while every sweep logs success.
for bad in '"not-a-date"' 'null'; do
  reset
  server_body "$(jq -cn --argjson m "$M2" --argjson at "$bad" '{status:"pending", at:$at, members:$m}')"
  do=pending; cur="$M2"; payload=$(pending_json "$M2")
  eq "an unreadable at ($bad) is rewritten" "$(run)" 0
  eq "which takes exactly one write" "$(writes)" 1
  if marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null; then
    ok "and the marker can age again"
  else
    ko "the marker still cannot age"
  fi
done

echo
echo "the sort key is the pair, not either half"
reset
server_body "$(jq -cn --argjson m "$M2S" '{status:"pending", at:"2026-07-22T09:00:00Z", members:($m | reverse)}')"
do=frozen; cur="$M2S"; payload=$(frozen_json "$M2S")
eq "two members in one repo, reordered, still freeze" "$(run)" 0
eq "and the marker is frozen" "$(marker_now | jq -r .status)" frozen

echo
echo "a freeze must not skip the stabilization window"
# The decision step says `frozen` only once the marker has held still past STABILIZE_SECONDS. Without
# an age re-check in the guard, a peer's clock reset is overtaken seconds later and the freeze lands
# before the lagging label index can surface a missing member.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:59:30Z)"   # 30s old, threshold is 120s
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a freeze against a freshly reset clock abandons" "$(run)" 2
eq "writing nothing" "$(writes)" 0
eq "and the marker stays pending" "$(marker_now | jq -r .status)" pending

echo
echo "member order is not a reason to abandon"
# The decision step compares members sorted, and so does the re-derive guard; otherwise a marker the
# decision calls stable is judged moved and the freeze is refused on every sweep.
reset
server_body "$(jq -cn --argjson m "$M2" '{status:"pending", at:"2026-07-22T09:00:00Z", members:($m | reverse)}')"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "a reordered member array still freezes" "$(run)" 0
eq "and the marker is frozen" "$(marker_now | jq -r .status)" frozen

# ---- the wave boundary ---------------------------------------------------------------------
# A frozen set stays the set until something retires it, so a pull request labeled after the freeze
# is held by the gate until the wave it is waiting on ends.

W=2026-07-20T08:00:00Z

echo
echo "a landed wave is retired so the next one can freeze"
reset
server_body "$(frozen_json "$M2")"
do=retire; cur="$M2"; inherited_since=""; payload=$(retired_json "$now")
eq "the tombstone is written" "$(run)" 0
eq "leaving a retired marker" "$(marker_now | jq -r .status)" retired
eq "carrying the boundary it drew" "$(marker_now | jq -r .since)" "$now"
eq "and naming no members" "$(marker_now | jq -r '.members // "none"')" none
if grep -q 'Some prose' "$WORK/body"; then
  ok "with the human prose untouched"
else
  ko "prose was dropped retiring"
fi
if grep -qF -- "$START" "$WORK/body"; then
  ok "and the region still standing"
else
  ko "the fences went with it, so the boundary has nowhere to live"
fi

echo
echo "retirement re-derives like every other write"
# Only the frozen set this pass judged landed may be ended. A peer that has opened the next wave
# loses it to a tombstone written now, which also redraws the boundary at the wrong instant.
reset
server_body "$(pending_json "$M2" 2026-07-22T09:59:00Z)"
do=retire; cur="$M2"; inherited_since=""; payload=$(retired_json "$now")
eq "a marker that is no longer frozen is left alone" "$(run)" 2
eq "and it still stands" "$(marker_now | jq -r .status)" pending
eq "with nothing written" "$(writes)" 0
reset
server_body "$(frozen_json "$M2B")"
do=retire; cur="$M2"; inherited_since=""; payload=$(retired_json "$now")
eq "a frozen set this pass did not judge is left alone" "$(run)" 2
eq "and nothing is written" "$(writes)" 0

echo
echo "a retirement a peer undoes is retried"
reset
server_body "$(frozen_json "$M2")"
printf 'Some prose.\n\n%s\n%s\n%s\n%s\n\nMore prose.\n' "$START" "$(note_of frozen)" \
  "$(frozen_json "$M2")" "$END" > "$WORK/steal"
do=retire; cur="$M2"; inherited_since=""; payload=$(retired_json "$now")
eq "the retirement is retried until it sticks" "$(run)" 0
eq "which takes two writes" "$(writes)" 2
eq "and the tombstone is what stands" "$(marker_now | jq -r .status)" retired

echo
echo "the boundary is carried forward, not written once"
# splice replaces the whole region, so a boundary survives only by being written again. The capture
# after a retirement carries the tombstone's instant forward, which keeps the retired wave's merges
# out of the new wave's history.
reset
server_body "$(retired_json "$W")"
inherited_since=$(since_of "$(retired_json "$W")")
do=pending; cur="$M1"; payload=$(payload_for pending "$M1" "$inherited_since")
eq "it is inherited from the tombstone being replaced" "$inherited_since" "$W"
eq "a fresh pending is written over it" "$(run)" 0
eq "and keeps the boundary" "$(marker_now | jq -r .since)" "$W"
reset
server_body "$(pending_json "$M1" 2026-07-22T09:00:00Z "$W")"
inherited_since=$(since_of "$(pending_json "$M1" 2026-07-22T09:00:00Z "$W")")
do=frozen; cur="$M1"; payload=$(payload_for frozen "$M1" "$inherited_since")
eq "the promotion to frozen goes through" "$(run)" 0
eq "and keeps it too" "$(marker_now | jq -r .since)" "$W"

echo
echo "only an instant is a boundary"
# detect-partial-landing appends this to a search qualifier, and GitHub answers a malformed one with
# zero rows and no error — indistinguishable from "nothing landed", which clears a standing freeze.
for bad in '"garbage"' '"2026-07-20"' '"2026-07-20T08:00:00+02:00"' '1234' 'null'; do
  eq "since=$bad is not one" \
    "$(since_of "$(jq -cn --argjson s "$bad" '{status:"retired", since:$s}')")" ""
done
eq "the form this step emits is" "$(since_of "$(retired_json "$W")")" "$W"

echo
echo "a boundary a peer redrew is not overwritten"
reset
server_body "$(pending_json "$M2" 2026-07-22T09:00:00Z 2026-07-21T00:00:00Z)"
do=pending; cur="$M2"; inherited_since="$W"
payload=$(payload_for pending "$M2" "$inherited_since")
eq "the pass yields rather than un-scoping the next wave" "$(run)" 2
eq "and the peer's boundary stands" "$(marker_now | jq -r .since)" 2026-07-21T00:00:00Z
eq "with nothing written" "$(writes)" 0

echo
echo "a corrupt boundary is repaired, not deadlocked on"
# The guard reads both sides through since_of. A second reading that skipped validation would never
# match, and the pass would yield on every attempt while the log called it a deliberate yield.
reset
server_body "$(jq -cn --argjson m "$M2" \
  '{status:"pending", at:"2026-07-22T09:00:00Z", since:"garbage", members:$m}')"
do=frozen; cur="$M2"; inherited_since=""
payload=$(payload_for frozen "$M2" "$inherited_since")
eq "the write goes through" "$(run)" 0
eq "and the unusable boundary is dropped" "$(marker_now | jq -r '.since // "none"')" none

echo
echo "a terminal marker is settled by equality alone"
# frozen and retired carry no aging clock, so equality settles them. A tombstone asked for a
# parseable `at` is never settled, and the retirement retries to exhaustion.
if marker_settled "$(retired_json "$W")" "$(retired_json "$W")"; then
  ok "a tombstone matching our payload counts as settled"
else
  ko "a tombstone can never settle, so retirement never converges"
fi
if marker_settled "$(frozen_json "$M2")" "$(frozen_json "$M2")"; then
  ok "and so does a frozen marker"
else
  ko "a frozen marker cannot settle"
fi
if marker_settled "$(retired_json "$W")" "$(retired_json 2026-07-01T00:00:00Z)"; then
  ko "two different boundaries read as one marker"
else
  ok "but two boundaries apart do not"
fi

echo
echo "what counts as a landed wave"
# Only a merged member counts. A member de-labeled and closed unmerged is what the snapshot exists
# to remember, so retiring on it destroys the only record that the wave failed and flips the
# partial-landing detector from `frozen` to `clear`, which posts success.
st() { jq -cn --argjson s "$1" '[$s[] | {repo:"o/r", number:1, state:.}]'; }
eq "every member merged is landed"     "$(landed_of "$(st '["MERGED","MERGED"]')")" true
eq "one closed unmerged is NOT"        "$(landed_of "$(st '["MERGED","CLOSED"]')")" false
eq "one still open is not"             "$(landed_of "$(st '["MERGED","OPEN"]')")" false
eq "an empty set is not a wave at all" "$(landed_of '[]')" false
eq "and a set carrying no state is not" "$(landed_of '[{"repo":"o/r","number":1}]')" false

echo
echo "the decision the step actually computes"
# Driven through the manifest's own jq, so the retire rule is pinned where it is written.
eq "no marker at all -> pending"       "$(decide null false)" pending
eq "pending, aged -> frozen"           "$(decide "$(pending_json "$M2" 2026-07-22T09:00:00Z)" false)" frozen
eq "pending, fresh -> skip"            "$(decide "$(pending_json "$M2" 2026-07-22T09:59:30Z)" false)" skip
eq "pending, members moved -> pending" "$(decide "$(pending_json "$M2B" 2026-07-22T09:00:00Z)" false)" pending
eq "frozen, wave not landed -> skip"   "$(decide "$(frozen_json "$M2")" false)" skip
eq "frozen, wave landed -> retire"     "$(decide "$(frozen_json "$M2")" true)" retire
eq "a tombstone -> pending"            "$(decide "$(retired_json "$W")" false)" pending
eq "garbage marker -> pending"         "$(decide '"nonsense"' false)" pending

echo
echo "a held pull request may end the previous wave and nothing else"
# Retirement is reachable only because the not-in-set hold enables this step: a wave with every
# member merged has no open member left to run the gate, so the pull request waiting on the next wave
# is the only trigger there is. That pass read a set it is not part of, and letting it capture would
# freeze a wave on the authority of a pull request that wave excludes.
eq "a held pass may retire"                 "$(bails true retire)" went-on
eq "but may not capture a fresh pending"    "$(bails true pending)" bailed
eq "nor promote one to frozen"              "$(bails true frozen)" bailed
eq "while an ordinary pass is unaffected"   "$(bails "" pending)" went-on

echo
echo "and it is reachable from that hold"
# The wiring is a step output plus two Actions expressions, so the harness cannot drive it. It is the
# only path by which a completed wave is retired, so assert it structurally, as the fence agreement
# above is.
hold_block=$(awk '/is not in the member set/{f=1} f{print} f&&/^[[:space:]]*fi$/{exit}' "$ACTION")
if grep -q 'retire_only=true' <<< "$hold_block"; then
  ok "the not-in-set hold enables the capture step before it returns"
else
  ko "the hold returns without enabling retirement — a pull request held there is held forever"
fi
for step in "Mint snapshot-write token" "Capture activation snapshot"; do
  if awk -v s="$step" '$0 ~ "name: " s {f=1;next} f && /^ *if:/ {print; exit}' "$ACTION" \
    | grep -q 'retire_only'; then
    ok "\"$step\" runs for a retire-only pass"
  else
    ko "\"$step\" is gated on capture alone, so a retire-only pass never reaches it"
  fi
done

echo
echo "the capture can be rehearsed"
# The one write in the saga that cannot be taken back is the only one that had no rehearsal, so a
# capture bug was found by discovering a wrong marker on a real Epic.
P=$(payload_for frozen "$M2")
out=$(rehearses true frozen "$M2" "$P")
if grep -q 'went-on' <<< "$out"; then
  ko "a rehearsal fell through to the write"
else
  ok "a rehearsal stops before the write"
fi
if grep -q 'dry run' <<< "$out"; then ok "and says so"; else ko "the rehearsal is silent about being one"; fi
if grep -q 'frozen' <<< "$out"; then
  ok "naming the transition it would make"
else
  ko "the transition is not reported"
fi
if grep -qF -- "$P" <<< "$out"; then
  ok "and the exact payload it would splice"
else
  ko "the payload is not reported"
fi
for m in 'a-novel-kit/repo-a#5' 'a-novel-kit/repo-b#2'; do
  if grep -qF -- "$m" <<< "$out"; then
    ok "listing member $m"
  else
    ko "member $m is not named, so the set cannot be eyeballed"
  fi
done
eq "an off switch writes as before" "$(rehearses false frozen "$M2" "$P")" went-on
eq "and so does an unset one" "$(rehearses "" frozen "$M2" "$P")" went-on
if grep -q 'retired' <<< "$(rehearses TRUE retire "$M2" "$(payload_for retire "$M2")")"; then
  ok "a retirement rehearses too, whatever the casing"
else
  ko "retirement cannot be rehearsed"
fi

echo
echo "a rehearsal cannot write even if the branch fails"
# The token is minted read-only for a dry run, so the capability is withheld rather than the write
# merely skipped. GitHub compares strings case-insensitively, so any casing of "true" reaches it.
perm=$(awk '/name: Mint snapshot-write token/{f=1} f&&/permission-issues:/{print; exit}' "$ACTION")
if grep -q 'snapshot_dry_run' <<< "$perm"; then
  ok "the snapshot-write token is scoped by the rehearsal flag"
else
  ko "a rehearsal still mints an issues:write token"
fi
if grep -qE "'read'" <<< "$perm"; then ok "down to read"; else ko "the dry branch does not drop to read"; fi

echo
echo "the payload the step builds"
eq "a frozen payload records when it froze" "$(payload_for frozen "$M2" | jq -r 'has("at")')" true
eq "and the members it froze"               "$(payload_for frozen "$M2" | jq -c .members)" "$M2"
eq "a pending payload records its clock"    "$(payload_for pending "$M2" | jq -r 'has("at")')" true
eq "neither invents a boundary"             "$(payload_for pending "$M2" | jq -r 'has("since")')" false
eq "both carry one they inherited"          "$(payload_for frozen "$M2" "$W" | jq -r .since)" "$W"
eq "a retirement names no members"          "$(payload_for retire "$M2" | jq -r 'has("members")')" false
eq "drawing the boundary at now"            "$(payload_for retire "$M2" | jq -r .since)" "$now"
eq "not the one it inherited"               "$(payload_for retire "$M2" "$W" | jq -r .since)" "$now"
eq "and it carries a note of its own"       "$(payload_for retire "$M2" >/dev/null; [ -n "$NOTE_OUT" ] && echo yes)" yes

echo
echo "splice, on its own"
# Driven directly, because the retry loop hides it: a broken splice writes a body with no fences, the
# next attempt takes the fallback branch, appends a correct region, and the verify passes.
sp() { # $1 = body text, $2 = payload -> the spliced result
  local b r
  b=$(mktemp -p "$WORK"); r=$(region_file "$2" frozen)
  printf '%s\n' "$1" > "$b"
  splice "$b" "$r"
}
one_region() { [ "$(grep -cxF -- "$START" <<< "$1")" = 1 ] && [ "$(grep -cxF -- "$END" <<< "$1")" = 1 ]; }
inner() { awk -v s="$START" -v e="$END" '$0==s{f=1;next} $0==e{f=0} f' <<< "$1" | sed -n '/^[[:space:]]*[{[]/,$p'; }

P=$(frozen_json "$M2")
out=$(sp "$(printf 'top\n\n%s\n_note_\n%s\n%s\n\nbottom\n' "$START" "$(pending_json "$M1")" "$END")" "$P")
eq "an existing region is replaced in place" "$(inner "$out" | jq -r .status)" frozen
if one_region "$out"; then ok "leaving exactly one region"; else ko "region count wrong"; fi
if grep -q '^top$' <<< "$out" && grep -q '^bottom$' <<< "$out"; then
  ok "with the prose either side intact"
else
  ko "prose was dropped by the in-place branch"
fi
# The replaced payload leaves the body entirely: a stale copy left loose in it is what lets a
# whole-body match report a marker that is not there.
if grep -qF -- "$(pending_json "$M1")" <<< "$out"; then
  ko "the replaced payload is still in the body"
else
  ok "and the payload it replaced is gone entirely"
fi

out=$(sp "$(printf 'only prose\n')" "$P")
eq "a body with no region gains one" "$(inner "$out" | jq -r .status)" frozen
if grep -q '^only prose$' <<< "$out"; then ok "and keeps the prose"; else ko "prose lost on append"; fi

out=$(sp "$(printf 'HUMAN-A\n%s\nA\n%s\ntext\n%s\nB\n%s\nHUMAN-B\n' "$START" "$END" "$START" "$END")" "$P")
if one_region "$out"; then ok "duplicate fences are healed to one region"; else ko "duplicate fences survived"; fi
if grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out"; then
  ok "without dropping the prose around them"
else
  ko "prose was destroyed healing duplicate fences"
fi

# Prose between a stray fence and the end discriminates the two branches: an in-place replace spans
# from the first START to the END and discards everything inside, while the recovery path strips the
# fence lines and keeps it. A malformed region takes the recovery path.
out=$(sp "$(printf '%s\nHUMAN-A\n%s\nHUMAN-B\n%s\n' "$START" "$START" "$END")" "$P")
if one_region "$out"; then
  ok "an unbalanced fence pair is healed to one region"
else
  ko "unbalanced fences survived"
fi
if grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out"; then
  ok "keeping prose that was trapped inside it"
else
  ko "prose between stray fences was destroyed"
fi
out=$(sp "$(printf 'HUMAN-A\n%s\nstray end first\n%s\nHUMAN-B\n' "$END" "$START")" "$P")
if one_region "$out"; then ok "inverted fences are healed to one region"; else ko "inverted fences survived"; fi
if grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out"; then
  ok "keeping the prose around those too"
else
  ko "prose was destroyed healing inverted fences"
fi

echo
echo "same status, different members of the same size"
# Every other members-differ case also differs in count, so a length compare passes for a set compare
# in both the equivalence check and the re-derive guard. This case tells the two apart.
reset
server_body "$(pending_json "$M2B" 2026-07-22T09:00:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "an equal-size but different set is corrected" "$(run)" 0
eq "which takes a write" "$(writes)" 1
eq "and our members are what stand" "$(marker_now | jq -c '.members')" "$M2"
reset
server_body "$(pending_json "$M2B" 2026-07-22T09:00:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "and a freeze against an equal-size peer set abandons" "$(run)" 2
eq "writing nothing" "$(writes)" 0

echo
echo "a shorter peer set is a difference, not a match"
# The index-lag shape: a peer wrote a strict subset. Under a subset test no writer ever corrects it.
reset
server_body "$(pending_json "$M1" 2026-07-22T09:00:00Z)"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "a subset marker is corrected, not accepted" "$(run)" 0
eq "and our full set is what stands" "$(marker_now | jq -r '.members | length')" 2

echo
echo "a region holding more than one value"
# jq -s '.[0]' takes the first. If a hand-edit leaves two, the first wins — including an empty frozen
# set, which would pin the Epic to no members at all.
reset
# Both values sit inside the fences, which is what makes "first" meaningful.
printf 'prose\n%s\n%s\n%s\n%s\n%s\n' "$START" "$(note_of pending)" \
  "$(pending_json "$M1")" "$(jq -cn '{status:"frozen",members:[]}')" "$END" > "$WORK/body"
eq "the first value in the region is the one read" "$(marker_now | jq -r '.status')" pending
eq "not the last" "$(marker_now | jq -r '.members | length')" 1

echo

echo "a clobbered repair is retried, not reported as done"
# The verify applies the same unreadable-`at` test as the entry check. Under a plain equivalence test
# a repair a peer immediately undid reads as landed, the marker never ages, and the log says success.
reset
bad=$(jq -cn --argjson m "$M2" '{status:"pending", at:"not-a-date", members:$m}')
server_body "$bad"
printf 'Some prose.\n\n%s\n%s\n%s\n%s\n\nMore prose.\n' "$START" "$(note_of pending)" "$bad" "$END" > "$WORK/steal"
do=pending; cur="$M2"; payload=$(pending_json "$M2")
eq "the repair is retried until it sticks" "$(run)" 0
eq "which takes two writes" "$(writes)" 2
if marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null; then
  ok "and the marker can age at the end of it"
else
  ko "the marker still cannot age"
fi

echo
echo "a give-up message carries the error, not the success output"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/noop"          # every edit returns success but changes nothing
eq "an unlandable write gives up" "$(run)" 1
if said 'https://'; then
  ko "the edit's success output was captured as an error"
else
  ok "the success URL is not mistaken for an error"
fi

echo
echo "a failing edit"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
eq "an edit that errors is retried, then given up on" "$(run)" 1
eq "after three attempts" "$(writes)" 3
if said 'HTTP 422'; then
  ok "and the API's own error text is surfaced, not swallowed"
else
  ko "the edit error was discarded"
fi

echo
echo "a give-up after mixed failures names a real cause"
# `err` is cleared each attempt so a give-up cannot quote an earlier attempt's error. The reset is
# only observable when the last attempts fail somewhere that sets no error of its own.
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
printf 2 > "$WORK/read_fail_from"   # attempt 1 reads, edits, fails; every later read fails too
eq "the pass gives up" "$(run)" 1
if said 'could not read'; then
  ok "and names the failure that actually ended it"
else
  ko "the give-up quotes a stale error from an earlier attempt"
fi

echo
echo "read failures"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 2 > "$WORK/read_fails"
eq "two failed reads still converge on the third attempt" "$(run)" 0
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'Important human prose.\n\nA hand-written plan.\n' > "$WORK/body"
printf 99 > "$WORK/read_fails"
eq "a total read failure gives up rather than claiming success" "$(run)" 1
eq "and writes nothing at all" "$(writes)" 0
if grep -q 'A hand-written plan' "$WORK/body"; then
  ok "leaving the Epic body untouched"
else
  ko "the body was written blind after a failed read"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -ne 149 ]; then
  echo "::error::$ran assertion(s) ran, expected exactly 149 — the suite did not execute fully (or an assertion was added without raising this)"
  exit 1
fi
