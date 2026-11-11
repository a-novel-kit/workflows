# Upgrading to NEXT

A hotfix cut now rehearses itself and writes the patch's release notes to the run summary before
anyone approves it.

## Do I need to act?

**Required** for every repository whose `hotfix.yaml` calls `release-line-run.yaml`. Its new
`notes` job asks for `contents: write`, and a called job cannot exceed what its caller grants, so a
caller that still grants `contents: read` fails every hotfix cut at startup.

## Grant `contents: write` to the hotfix cut

GitHub's release-notes endpoint wants contents write although it stores nothing. Raise the
`contents` permission of the `cut` job in `hotfix.yaml`, which calls the engine:

```yaml
permissions:
  contents: write # was read
  actions: read
```

Merge the grant before the bump. It is safe on any earlier release, whose jobs each declare a
narrower permission. In this release only `notes` uses the write: it checks nothing out and runs one
`gh api` call.

## Notes

When the line has something to cut, `pending` now runs `release-core-hotfix` as a dry run. A cut
that would fail, such as one from a stale baseline, then fails and escalates before the `release`
environment asks anyone to approve it.
