# Contributing to workflows

The platform taxonomy — repository kinds, where the reusable **composite actions** sit in the tooling layer, and the versioning model — lives in the [libraries, tooling & platform concepts](https://github.com/a-novel-kit/.github/blob/master/CONTRIBUTING.md); this file covers what's specific to `workflows`. Platform setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md).

Everything here is a [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action); GitHub's docs cover the [`runs` / `inputs` / `outputs` syntax](https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions). The rest of this file is the conventions particular to this repo.

## Layout and the catalog

Each action lives at `<group>/<name>/action.yaml`, grouped by the kind of work it does — the [Action catalog](./README.md#action-catalog) in the README is the full list. That catalog is maintained by hand from each action's `name` and `description`, so keep those two fields accurate and update the README whenever they change.

## Versioning

The whole repository is released as a single unit: one `v*` Git tag covers every action at once, with no per-action versions. Releases are cut from the GitHub UI (Actions ▸ release ▸ pick a bump type), which runs `publish-actions/release-core` to compute the next tag, push it, and create the GitHub Release. The protected `release` environment gates who may publish.

Because everything ships together, an action may depend on another in this repo — but reference it by its pinned tag (`a-novel-kit/workflows/<group>/<name>@<tag>`), never a relative path. That keeps a release internally consistent: every action in a release calls that same release's version of its siblings, rather than whatever currently sits on `master`.

Downstream repos pin every `uses:` to a release tag (never `@master`) so their CI is reproducible, and bump them together on upgrade — Renovate groups them into one `a-novel-kit workflows` update so the versions never drift apart.

## Scripts and tests

Write scripts outside YAML as JavaScript ES modules (`.mjs`) for Node.js 24. Action run blocks may use Bash. Pass action inputs through environment variables so callers' values remain data.

Tests use Node's built-in runner and assertions. After `pnpm install` and `npm ci --prefix node-actions/test-playwright/drive`, install Chromium with `pnpm exec playwright install chromium` and run `a-novel test --type=pnpm -y`. `pnpm lint` checks formatting and composite manifest contexts.

The shared test helpers read run blocks from parsed YAML and provide isolated workspaces and command stubs. Prefer complete-step behavior tests; extract a function only when the full step would add unrelated setup. Keep cases for distinct failures and security boundaries. Avoid assertions that merely restate configuration or duplicate another test's outcome. The shell lint job extracts and checks the Bash actually shipped in YAML.

## Questions?

[Open an issue](https://github.com/a-novel-kit/workflows/issues) — include logs and environment details.
