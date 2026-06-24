# Contributing to workflows

For platform-wide setup (Go, Node, Podman, the `a-novel` CLI) and the day-to-day commands, see the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md). This file documents what is specific to `workflows`.

## How an action is structured

Every action lives at `<group>/<name>/action.yaml` and is a [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action): a `runs: { using: "composite" }` block that chains other actions and `shell: bash` steps. The top-level group encodes the kind of work the action does — `build-actions`, `generic-actions`, `github-pages-actions`, `go-actions`, `node-actions`, `publish-actions`.

When adding or changing an action:

- Keep its `name` and `description` accurate — the root `README.md` catalog is generated from them by hand, and operators trust it as a reference.
- Declare every parameter under `inputs:` with a `description` and a sensible `default` where one exists; surface anything a caller needs back as an `output`.
- Several actions compose others in this repo (`setup-node`, `pull-bot`, …). Reference them by their pinned tag (`a-novel-kit/workflows/<group>/<name>@v1.0.3`), not by a relative path, so a given release is internally consistent.

## How versions are tagged and consumed

The actions are released **as a single unit**: one `v*` tag covers the whole repo. Consumers pin every `uses:` reference to that tag (e.g. `@v1.0.3`) rather than to `@master`, and bump them all together on upgrade — Renovate groups them under `a-novel-kit workflows` for exactly that reason. A release is cut by tagging the repo; the `publish-actions/auto-release` action turns the pushed tag into a GitHub release with generated notes.

## Questions?

- Open an issue at https://github.com/a-novel-kit/workflows/issues
- Check existing issues for similar problems
- Include relevant logs and environment details
