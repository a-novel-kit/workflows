#!/usr/bin/env bash
# Regression tests for merge-gate's activation-snapshot write path.
#
# Same approach as tests/detect-partial-landing.sh: the functions under test are extracted verbatim
# from the action manifest and sourced. Only `gh` is stubbed.
#
# What this covers is the lost-update race. The reconcile sweep runs merge-gate as a matrix over
# every open member pull request with no concurrency bound, and render-epic-status edits the same
# issue body from a job that does not wait for it, so writers overlap by design against an API with
# no conditional update.
#
# The write acts on a decision made earlier: `$do` and `$payload` are computed from a body read
# before the loop, so a writer that re-reads without re-deriving freezes a member set the world has
# already moved past, and a retry loop makes it win. Several cases below exist to pin that.
#
# Scope: this drives `write_marker` and its helpers. The decision step that produces `$do`/`$payload`
# (the `do=` jq, and the member normalization above it) is not extracted; the fixtures set those as
# inputs.
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
for fn in splice current_marker same_marker marker_settled write_marker; do
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
[ -n "$START" ] && [ -n "$END" ] || die "could not read the fence literals from $ACTION"
REGION_BLOCK=$(awk '
  /^        \{$/ { buf=""; inb=1; next }
  inb && /^        \} > "\$regionf"$/ { printf "%s", buf; exit }
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

pending_json() { jq -cn --arg at "${2:-2026-07-22T10:00:00Z}" --argjson m "$1" '{status:"pending", at:$at, members:$m}'; }
frozen_json() { jq -cn --argjson m "$1" '{status:"frozen", members:$m}'; }

# The note the action writes, read out of the manifest: a note beginning with `[` or `{` would make
# current_marker latch onto it and read every marker as absent, which a restated copy could not show.
note_of() { # frozen|pending
  local key=FROZEN
  [ "$1" = frozen ] || key=PENDING
  sed -n "s/^ *note=\"\(_Epic membership, $key.*\)\"$/\1/p" "$ACTION" | head -1
}
region_file() { # $1 = payload json, $2 = frozen|pending -> the region the action itself would build
  local f note payload regionf
  note=$(note_of "${2:-pending}")
  [ -n "$note" ] || die "could not read the note text from $ACTION"
  payload="$1"
  f=$(mktemp -p "$WORK"); regionf="$f"
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
eq() { [ "$2" = "$3" ] && ok "$1" || ko "$1 (got '$2', want '$3')"; }

reset() {
  printf 0 > "$WORK/read_fails"; : > "$WORK/writes"; : > "$WORK/steal"; : > "$WORK/noop"
  : > "$WORK/edit_fails"; : > "$WORK/read_fail_from"; : > "$WORK/reads"
  : > "$GITHUB_STEP_SUMMARY"; server_body ""
}
# Capture the function's output so it cannot be mistaken for the exit code, and so tee'd and plain
# log lines are asserted from one place.
run() { write_marker "$(region_file "$payload" "$do")" > "$WORK/out" 2>&1 && echo 0 || echo $?; }
said() { grep -q "$1" "$WORK/out"; }

# The member normalization, lifted from the manifest. It decides what `$cur` is, so the
# members-moved branch and both re-derive guards rest on it.
NORMALIZE_JQ=$(awk '/^ *cur=\$\(printf/{f=1;next} f{print} f&&/\)$/{exit}' "$ACTION" \
  | sed "s/^[[:space:]]*'//; s/')$//")
[ -n "$NORMALIZE_JQ" ] || die "could not read the member normalization from $ACTION"
normalize() { printf '%s' "$1" | jq -c "$NORMALIZE_JQ" 2>/dev/null || echo '[]'; }

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
grep -q 'Some prose' "$WORK/body" && ok "human prose either side survives" || ko "prose was dropped"

echo
echo "a peer that writes after us"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
# The peer reverts the body, discarding our write. A pending decision survives that, so the pass
# notices and retries instead of trusting the edit's exit code.
{ cat "$WORK/body"; printf '\n<!-- rendered by the peer -->\n'; } > "$WORK/steal"
eq "we retry until our write survives" "$(run)" 0
eq "and our marker is what finally stands" "$(marker_now | jq -r '.members | length')" 2
eq "which took two writes, not one" "$(writes)" 2
grep -q 'rendered by the peer' "$WORK/body" \
  && ok "and the peer's own edit outside our region survives" \
  || ko "LOST UPDATE: we overwrote the peer's edit"

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
said 'already frozen' && ok "and it says so in the run log" || ko "the yield is silent"

echo
echo "a stale freeze must not become permanent"
# Our pass decided `frozen` against members=M2, and a peer has since seen the set change to M1 and
# reset the clock. Freezing M2 now would make a superseded set terminal, and the gate would hold the
# member it drops forever.
reset
server_body "$(pending_json "$M1" 2026-07-22T10:05:00Z)"
do=frozen; cur="$M2"; payload=$(frozen_json "$M2")
eq "the writer abandons instead of freezing a superseded set" "$(run)" 2
eq "the peer's pending marker stands" "$(marker_now | jq -r .status)" pending
eq "with the peer's member set" "$(marker_now | jq -r '.members | length')" 1
eq "and nothing was written" "$(writes)" 0
said 'member set moved' && ok "and the abandonment is explained" || ko "abandoning is silent"

echo
echo "equivalent writers agree instead of fighting"
# Two writers with the same member set differ only in `at`. Under byte-equality neither could satisfy
# the other, and both would ping-pong to exhaustion reporting a failure that never happened.
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
# ages, so the marker would sit pending forever while every sweep logged success.
for bad in '"not-a-date"' 'null'; do
  reset
  server_body "$(jq -cn --argjson m "$M2" --argjson at "$bad" '{status:"pending", at:$at, members:$m}')"
  do=pending; cur="$M2"; payload=$(pending_json "$M2")
  eq "an unreadable at ($bad) is rewritten" "$(run)" 0
  eq "which takes exactly one write" "$(writes)" 1
  marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null \
    && ok "and the marker can age again" || ko "the marker still cannot age"
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
one_region "$out" && ok "leaving exactly one region" || ko "region count wrong"
grep -q '^top$' <<< "$out" && grep -q '^bottom$' <<< "$out" \
  && ok "with the prose either side intact" || ko "prose was dropped by the in-place branch"
# The replaced payload leaves the body entirely: a stale copy left loose in it is what lets a
# whole-body match report a marker that is not there.
grep -qF -- "$(pending_json "$M1")" <<< "$out" \
  && ko "the replaced payload is still in the body" \
  || ok "and the payload it replaced is gone entirely"

out=$(sp "$(printf 'only prose\n')" "$P")
eq "a body with no region gains one" "$(inner "$out" | jq -r .status)" frozen
grep -q '^only prose$' <<< "$out" && ok "and keeps the prose" || ko "prose lost on append"

out=$(sp "$(printf 'HUMAN-A\n%s\nA\n%s\ntext\n%s\nB\n%s\nHUMAN-B\n' "$START" "$END" "$START" "$END")" "$P")
one_region "$out" && ok "duplicate fences are healed to one region" || ko "duplicate fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "without dropping the prose around them" || ko "prose was destroyed healing duplicate fences"

# Prose between a stray fence and the end discriminates the two branches: an in-place replace spans
# from the first START to the END and discards everything inside, while the recovery path strips the
# fence lines and keeps it. A malformed region takes the recovery path.
out=$(sp "$(printf '%s\nHUMAN-A\n%s\nHUMAN-B\n%s\n' "$START" "$START" "$END")" "$P")
one_region "$out" && ok "an unbalanced fence pair is healed to one region" || ko "unbalanced fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "keeping prose that was trapped inside it" || ko "prose between stray fences was destroyed"
out=$(sp "$(printf 'HUMAN-A\n%s\nstray end first\n%s\nHUMAN-B\n' "$END" "$START")" "$P")
one_region "$out" && ok "inverted fences are healed to one region" || ko "inverted fences survived"
grep -q '^HUMAN-A$' <<< "$out" && grep -q '^HUMAN-B$' <<< "$out" \
  && ok "keeping the prose around those too" || ko "prose was destroyed healing inverted fences"

echo
echo "same status, different members of the same size"
# Every other members-differ case also differs in count, so comparing lengths would pass for
# comparing sets in both the equivalence check and the re-derive guard.
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
marker_now | jq -e '.at | try (fromdateiso8601 | true) catch false' >/dev/null \
  && ok "and the marker can age at the end of it" || ko "the marker still cannot age"

echo
echo "a give-up message carries the error, not the success output"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/noop"          # every edit returns success but changes nothing
eq "an unlandable write gives up" "$(run)" 1
said 'https://' && ko "the edit's success output was captured as an error" \
  || ok "the success URL is not mistaken for an error"

echo
echo "a failing edit"
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
eq "an edit that errors is retried, then given up on" "$(run)" 1
eq "after three attempts" "$(writes)" 3
said 'HTTP 422' && ok "and the API's own error text is surfaced, not swallowed" || ko "the edit error was discarded"

echo
echo "a give-up after mixed failures names a real cause"
# `err` is cleared each attempt so a give-up cannot quote an earlier attempt's error. The reset is
# only observable when the last attempts fail somewhere that sets no error of its own.
reset
do=pending; cur="$M2"; payload=$(pending_json "$M2")
printf 'x' > "$WORK/edit_fails"
printf 2 > "$WORK/read_fail_from"   # attempt 1 reads, edits, fails; every later read fails too
eq "the pass gives up" "$(run)" 1
said 'could not read' && ok "and names the failure that actually ended it" \
  || ko "the give-up quotes a stale error from an earlier attempt"

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
grep -q 'A hand-written plan' "$WORK/body" \
  && ok "leaving the Epic body untouched" || ko "the body was written blind after a failed read"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
ran=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail assertion(s) failed"
  exit 1
fi
if [ "$ran" -ne 76 ]; then
  echo "::error::$ran assertion(s) ran, expected exactly 76 — the suite did not execute fully (or an assertion was added without raising this)"
  exit 1
fi
