#!/usr/bin/env bash

# Keep release tags and signed provenance consistent across the Docker build
# actions. These assertions exercise the composite manifests without publishing
# a package from an untrusted pull-request workflow.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

for action in docker docker-job; do
  manifest="$ROOT/build-actions/$action/action.yaml"
  count=$(grep -c "type=ref,event=pr,enable=" "$manifest" || true)
  if [ "$count" -ne 1 ]; then
    printf "FAIL %s: expected one pull-request tag rule, found %s\n" "$action" "$count" >&2
    exit 1
  fi

  attest_count=$(grep -c 'uses: actions/attest@' "$manifest" || true)
  if [ "$attest_count" -ne 1 ]; then
    printf "FAIL %s: expected one provenance action, found %s\n" \
      "$action" "$attest_count" >&2
    exit 1
  fi
  push_line=$(grep -n 'id: build' "$manifest" | cut -d: -f1)
  attest_line=$(grep -n 'uses: actions/attest@' "$manifest" | cut -d: -f1)
  if [ -z "$push_line" ] || [ -z "$attest_line" ] || [ "$attest_line" -le "$push_line" ]; then
    printf "FAIL %s: attestation must follow the successful image push\n" "$action" >&2
    exit 1
  fi
  if ! grep -Eq 'uses: actions/attest@[a-f0-9]{40} # v[0-9]+\.[0-9]+\.[0-9]+$' "$manifest"; then
    printf "FAIL %s: actions/attest must use a documented full commit pin\n" "$action" >&2
    exit 1
  fi
  # These are literal GitHub-expression contracts from the action manifests;
  # expanding them in this shell test would change what the test is asserting.
  # shellcheck disable=SC2016
  for contract in \
    'subject-name: ghcr.io/${{ inputs.image_name }}' \
    'subject-digest: ${{ steps.build.outputs.digest }}' \
    'push-to-registry: true' \
    'create-storage-record: false'; do
    if [ "$(grep -Fc "$contract" "$manifest")" -ne 1 ]; then
      printf "FAIL %s: expected provenance contract %s exactly once\n" \
        "$action" "$contract" >&2
      exit 1
    fi
  done
  printf "ok %s\n" "$action"
done
