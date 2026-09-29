#!/usr/bin/env bash
# Exercise the shipped scripts without starting browsers or removing real services.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for step in component-tests journeys service-logs cleanup; do
  awk -v id="$step" '
    $1 == "id:" && $2 == id { selected = 1 }
    selected && /^      run: \|/ { running = 1; next }
    running && /^        / { sub(/^        /, ""); print; next }
    running { exit }
  ' "$ROOT/node-actions/test-playwright/action.yaml" > "$WORK/$step.sh"
  [ -s "$WORK/$step.sh" ] || { printf 'Missing script: %s\n' "$step" >&2; exit 1; }
  bash -n "$WORK/$step.sh"
done

cd "$WORK"
export CALLS="$WORK/calls"
pnpm() { printf '<%s>\n' "$@" > "$CALLS"; return "${PNPM_EXIT:-0}"; }
docker() { printf '<%s>\n' "$@" > "$CALLS"; printf 'service output\n'; return "${DOCKER_EXIT:-0}"; }
export -f pnpm docker

# A package script name stays one argument, even with shell syntax in it.
# shellcheck disable=SC2016
export TEST_ACTION='test:browser $(touch injected)'
for step in component-tests journeys; do
  bash "$WORK/$step.sh"
  printf '<run>\n<%s>\n' "$TEST_ACTION" > expected
  [ "$(cat expected)" = "$(cat "$CALLS")" ]
  [ ! -e injected ]
  status=0
  PNPM_EXIT=17 bash "$WORK/$step.sh" || status=$?
  [ "$status" -eq 17 ] || { printf 'Test failure was masked\n' >&2; exit 1; }
done

export COMPOSE_FILE='builds/test services.yaml'
bash "$WORK/service-logs.sh"
printf 'service output\n' > expected
[ "$(cat expected)" = "$(cat integration-services.log)" ]
printf '<compose>\n<--file>\n<%s>\n<logs>\n<--no-color>\n' "$COMPOSE_FILE" > expected
[ "$(cat expected)" = "$(cat "$CALLS")" ]

printf 'runner-collected logs\n' > integration-services.log
rm "$CALLS"
bash "$WORK/service-logs.sh"
[ ! -e "$CALLS" ]
printf 'runner-collected logs\n' > expected
[ "$(cat expected)" = "$(cat integration-services.log)" ]

bash "$WORK/cleanup.sh" > /dev/null
printf '<compose>\n<--file>\n<%s>\n<down>\n<--volumes>\n<--remove-orphans>\n' "$COMPOSE_FILE" > expected
[ "$(cat expected)" = "$(cat "$CALLS")" ]
status=0
DOCKER_EXIT=23 bash "$WORK/cleanup.sh" > /dev/null || status=$?
[ "$status" -eq 23 ] || { printf 'Cleanup failure was masked\n' >&2; exit 1; }
printf 'Playwright action scripts passed\n'
