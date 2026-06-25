# Contributing to workflows

Platform setup and day-to-day commands are in the [developer onboarding guide](https://github.com/a-novel-kit/.github/blob/master/README.md). This file covers what's specific to `workflows`.

## How an action is structured

Each action is a [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action): a small, reusable building block that bundles several steps behind a single `uses:` reference, so a caller runs the whole thing in one line. Its definition lives at `<group>/<name>/action.yaml`, and the `<group>` says what kind of work it does — `build-actions` build container images, `go-actions` and `node-actions` drive the Go and Node toolchains, `generic-actions` are language-agnostic helpers (bots, Renovate, Codecov), and `publish-actions` / `github-pages-actions` ship releases and docs.

Inside an `action.yaml`, the `runs:` block is the list of steps the action performs. A step either calls another action (`uses:`) or runs a shell script (`run:`, with `shell: bash`). A caller passes values _in_ through the action's `inputs:` and reads results _out_ through its `outputs:`.

When you add or change an action, keep it self-describing:

- **`name` and `description`** are the first thing a reader sees, and the action catalog in the [README](./README.md) is written by hand from them. Keep both accurate, and update the README whenever they change.
- **Give every input a `description`**, plus a `default` when there's a sensible one — that way a caller only has to pass the values it actually wants to override. Reserve `required: true` for inputs the action genuinely cannot run without.
- **Surface anything a caller might need back** — a token, an artifact ID, a computed flag — as an `output` wired to the step that produces it. A useful result left unexposed is effectively lost.

## How versions are released and consumed

The whole repository is versioned as one unit: a single `v*` Git tag (for example `v1.0.3`) covers every action at once. There are no per-action version numbers.

**Releasing.** Pushing a `v*` tag is what creates a release — the `publish-actions/auto-release` action turns that tag into a GitHub Release with auto-generated notes. Because everything ships together, one action may depend on another in this repo, but it must reference it by its **pinned tag** (`a-novel-kit/workflows/<group>/<name>@<tag>`), never a relative path. That keeps a release internally consistent: every action in `v1.0.3` calls the `v1.0.3` version of its siblings, rather than silently picking up whatever currently sits on `master`.

**Consuming.** Downstream repos pin every `uses:` to a release tag (never `@master`) so their CI is reproducible. When they upgrade, they bump all of those references at once — Renovate groups them into a single `a-novel-kit workflows` update so the versions never drift apart.

## Questions?

[Open an issue](https://github.com/a-novel-kit/workflows/issues) — include logs and environment details.
