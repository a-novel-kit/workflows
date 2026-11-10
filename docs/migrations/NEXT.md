# Upgrading to NEXT

`release-core` sizes each release from its commits and drops `release_type`, a major ships from a
`v<N>` branch, and guides are written as `NEXT.md`.

## Do I need to act?

**Required** for every repository that calls `release-core`. The action ignores `release_type` with
a warning, so a release keeps working until you migrate, but the release train cannot dispatch a
`release.yaml` that still requires the input.

## Remove `release_type` from `release.yaml`

The commits since the last release size a default-branch cut. Any `feat`, `!` or `BREAKING CHANGE:`
footer makes it a minor, and anything else a patch.

Delete `release_type` from the `workflow_dispatch` and `workflow_call` inputs and from both
`release-core` steps, then name the branch in the run name:

```yaml
# before
run-name: "🚀 release ${{ inputs.release_type }}${{ inputs.dry_run && ' (dry-run)' || '' }}"

# after
run-name: "🚀 release ${{ github.ref_name }}${{ inputs.dry_run && ' (dry-run)' || '' }}"
```

A repository that publishes on a tag keeps the `format('📦 publish {0}', github.ref_name)` half of
that expression.

## Cut a major from its `v<N>` branch

Dispatch `release.yaml` on a branch named `v<N>`, where `N` is exactly the default branch's major
plus one. Any other `N` is refused. One atomic push then makes that branch the default branch, keeps
the old one as `v<N-1>`, removes the `v<N>` name and cuts `vN.0.0`.

The branch may share no history with the default branch, so anything missing from it leaves the
default branch and stays on `v<N-1>`. Land or close the pull requests into `v<N>` first, since
removing the branch closes them. From major 2 on, every `go.mod` must declare a module path ending
in `/v<N>`, or the cut is refused.

## Write guides as `NEXT.md`

A branch cannot know the version it ships in. Add consumer actions to `docs/migrations/NEXT.md`,
creating it when absent and extending it when another branch already started it. The paragraph under
the title becomes the index entry:

```markdown
# Upgrading to NEXT

One-line summary of what changed and why it matters to a consumer.

## Do I need to act?
```

The release renames the file after its version, replaces the word `NEXT` inside it, and adds a line
to `docs/migrations/README.md`. Convert that index from a table to a list, since a release adding a
table row would misalign it for prettier:

```markdown
- [v1.2.0](./v1.2.0.md): One-line summary.
```

## Migrate an Epic's repositories before its train

The train no longer derives a size and dispatches `release.yaml` with `dry_run` alone. Run a train
only once its repository and every repository of the Epic use this release and have dropped
`release_type`, since GitHub refuses a dispatch whose inputs do not match the workflow's.
