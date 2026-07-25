#!/usr/bin/env bash

# Keep pull-request tagging consistent across the Docker build actions.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

for action in docker docker-job; do
  manifest="$ROOT/build-actions/$action/action.yaml"
  count=$(grep -c "type=ref,event=pr,enable=" "$manifest" || true)
  if [ "$count" -ne 1 ]; then
    printf "FAIL %s: expected one pull-request tag rule, found %s\n" "$action" "$count" >&2
    exit 1
  fi
  printf "ok %s\n" "$action"
done
