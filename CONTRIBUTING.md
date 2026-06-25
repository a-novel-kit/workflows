# Contributing to workflows

Platform setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md). This file covers what's specific to `workflows`.

## How an action is structured

Every action lives at `<group>/<name>/action.yaml` — a [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action) chaining other actions and `shell: bash` steps. The group names the kind of work it does (`build-actions`, `go-actions`, `node-actions`, …).

When adding or changing an action:

- Keep `name` and `description` accurate — the README catalog is hand-copied from them.
- Give every `inputs:` entry a `description` and a `default` where sensible; expose results as `outputs`.
- When one action calls another here, reference it by pinned tag (`…@v1.0.3`), never a relative path, so each release is self-consistent.

## How versions are tagged

One `v*` tag covers the whole repo. Consumers pin every `uses:` to that tag (not `@master`) and bump them together — Renovate groups them under `a-novel-kit workflows`. Tagging the repo cuts a release: `publish-actions/auto-release` turns the tag into a GitHub release with generated notes.

## Questions?

[Open an issue](https://github.com/a-novel-kit/workflows/issues) — include logs and environment details.
