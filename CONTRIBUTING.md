# Contributing to workflows

The platform taxonomy — repository kinds, where the reusable **composite actions** sit in the tooling layer, and the versioning model — lives in the [libraries, tooling & platform concepts](https://github.com/a-novel-kit/.github/blob/master/CONTRIBUTING.md); this file covers what's specific to `workflows`. Platform setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md).

Everything here is a [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action); GitHub's docs cover the [`runs` / `inputs` / `outputs` syntax](https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions). The rest of this file is the conventions particular to this repo.

## Layout and the catalog

Each action lives at `<group>/<name>/action.yaml`, grouped by the kind of work it does — the [Action catalog](./README.md#action-catalog) in the README is the full list. That catalog is maintained by hand from each action's `name` and `description`, so keep those two fields accurate and update the README whenever they change.

## Versioning

The whole repository is released as a single unit: one `v*` Git tag covers every action at once, with no per-action versions. Releases are cut from the GitHub UI (Actions ▸ release ▸ pick a bump type), which runs `publish-actions/release-core` to compute the next tag, push it, and create the GitHub Release. The protected `release` environment gates who may publish.

Because everything ships together, an action may depend on another in this repo — but reference it by its pinned tag (`a-novel-kit/workflows/<group>/<name>@<tag>`), never a relative path. That keeps a release internally consistent: every action in a release calls that same release's version of its siblings, rather than whatever currently sits on `master`.

Downstream repos pin every `uses:` to a release tag (never `@master`) so their CI is reproducible, and bump them together on upgrade — Renovate groups them into one `a-novel-kit workflows` update so the versions never drift apart.

## Questions?

[Open an issue](https://github.com/a-novel-kit/workflows/issues) — include logs and environment details.
