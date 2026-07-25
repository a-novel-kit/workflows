#!/usr/bin/env bash
# Exercises the functions shipped in check-append-only against real Git histories.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTION="${1:-$ROOT/generic-actions/check-append-only/action.yaml}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

extract() {
  awk -v n="$1" '
    $0 ~ "^        "n"\\(\\)" {f=1}
    f {print}
    f && /^        \}$/ {exit}
  ' "$ACTION" | sed 's/^        //'
}

for function_name in has_override collect_changes classify_changes; do
  body=$(extract "$function_name")
  if [ -z "$body" ]; then
    printf '::error::could not extract %s from %s\n' "$function_name" "$ACTION"
    exit 1
  fi
  printf '%s\n' "$body" >> "$WORK/lib.sh"
done

bash -n "$WORK/lib.sh"
# shellcheck source=/dev/null
. "$WORK/lib.sh"

REPO="$WORK/repo"
mkdir -p "$REPO/frozen" "$REPO/outside"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name test
printf 'locked\n' > "$REPO/frozen/locked.txt"
printf 'outside\n' > "$REPO/outside/file.txt"
git -C "$REPO" add frozen/locked.txt outside/file.txt
git -C "$REPO" commit -qm base
BASE=$(git -C "$REPO" rev-parse HEAD)
export PATH_TO_CHECK=frozen

fails=0
check_case() { # $1=label $2=expected(pass|fail)
  local label=$1 expected=$2 got changes
  changes="$WORK/changes"
  if (cd "$REPO" && collect_changes "$changes") && classify_changes "$changes"; then
    got=pass
  else
    got=fail
  fi
  if [ "$got" = "$expected" ]; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s: expected %s, got %s\n' "$label" "$expected" "$got"
    fails=$((fails + 1))
  fi
}

reset_case() {
  git -C "$REPO" reset --hard -q "$BASE"
  git -C "$REPO" clean -fdq
}

commit_case() {
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm case
}

printf '== path changes ==\n'

printf 'new\n' > "$REPO/frozen/new.txt"
commit_case
check_case "added file passes" pass

reset_case
printf 'changed\n' > "$REPO/frozen/locked.txt"
commit_case
check_case "modified file fails" fail

reset_case
rm "$REPO/frozen/locked.txt"
commit_case
check_case "deleted file fails" fail

reset_case
printf 'changed\n' > "$REPO/outside/file.txt"
commit_case
check_case "change outside path passes" pass

reset_case
mv "$REPO/frozen/locked.txt" "$REPO/frozen/renamed.txt"
commit_case
check_case "renamed file fails" fail

printf '== override label ==\n'

export OVERRIDE_LABEL=append-only-override
export EVENT_LABELS='["bug","append-only-override"]'
if has_override; then
  printf '  ok   configured label passes\n'
else
  printf '  FAIL configured label was not detected\n'
  fails=$((fails + 1))
fi

EVENT_LABELS='["bug"]'
if has_override; then
  printf '  FAIL unrelated label bypassed the check\n'
  fails=$((fails + 1))
else
  printf '  ok   unrelated label does not bypass\n'
fi

EVENT_LABELS=null
if has_override; then
  printf '  FAIL non-PR event bypassed the check\n'
  fails=$((fails + 1))
else
  printf '  ok   non-PR event does not bypass\n'
fi

printf '\n'
if [ "$fails" -ne 0 ]; then
  printf '::error::%s assertion(s) failed\n' "$fails"
  exit 1
fi
printf 'all assertions passed\n'
