# Service dependency presets

Opt in from a repository's `renovate.json`. Replace `vX.Y.Z` with a published workflows
release containing these presets and use the same version as the repository's workflow actions:

```json
{
  "extends": [
    "github>a-novel-kit/workflows//renovate/service#vX.Y.Z",
    "github>a-novel-kit/workflows//renovate/database#vX.Y.Z"
  ],
  "packageRules": [
    {
      "matchFileNames": ["builds/database.apko.yaml"],
      "matchDatasources": ["apk"],
      "registryUrls": ["https://packages.wolfi.dev/os?arch=x86_64"]
    }
  ]
}
```

Choose the APK repository and architecture that match the image; use `aarch64` for ARM64.
The database preset supplies no registry default. Keep the repository's existing post-upgrade
commands, command allowlist and compatibility exceptions when adding these entries.

## Ownership

`service` extends native file detection to Podman Compose and isolated Go tool modules.
Renovate's normal `go.mod` and Docker Compose detection remain active.

`database` updates the apko build tool and pinned APK packages in the database build files.
It groups PostgreSQL runtime packages without choosing their major version. The pgBackRest manager
updates the source version and SHA-256 together, using the matching stable GitHub release asset.
Releases without a valid asset checksum are excluded. This uses Renovate's experimental custom
datasource support; investigate an extraction or lookup error before merging an update.

Concrete versions, package selection, image architecture and regeneration commands belong to
the consuming repository. Neither preset grants command permissions or changes automerge policy.

Renovate's [native config manager](https://docs.renovatebot.com/modules/manager/renovate-config/)
updates the pinned preset versions. The shared Renovate action's `a-novel-kit workflows` group
keeps these updates with action-ref updates in the same PR.

## Adoption

Release workflows before changing consumers. Update their workflow refs on master, merge master
into the service branches, then add the released preset references and remove the corresponding
local detection, datasource and PostgreSQL grouping rules. Retain the APK registry rule and
service-specific post-upgrade tasks. Inspect a Renovate extraction pass for duplicate dependencies
before merging the consumer changes.
