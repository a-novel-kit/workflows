# Migration guides

One immutable guide per release that asks consumers to change something. Newest first.

| Version                 | Summary                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [v1.43.0](./v1.43.0.md) | Hotfixes become backport pull requests into `release/vX.Y` lines; merging one cuts the patch.                             |
| [v1.40.0](./v1.40.0.md) | Shared translation gate for platforms with translation catalogs.                                                          |
| [v1.38.0](./v1.38.0.md) | Protobuf regeneration becomes an opt-in Renovate preset for `buf.mod` repositories.                                       |
| [v1.37.0](./v1.37.0.md) | Removes four uncalled actions; per-action caches seed once after adopting.                                                |
| [v1.33.0](./v1.33.0.md) | Optional private Drive storage, native screenshot comparisons and reviewed visual updates.                                |
| [v1.32.0](./v1.32.0.md) | Shared Playwright pipeline for platform browser tests, coverage and failure diagnostics.                                  |
| [v1.31.0](./v1.31.0.md) | Composable Renovate presets by repository class and JSON runner configuration.                                            |
| [v1.30.1](./v1.30.1.md) | Centralizes Renovate defaults and lockfile-sensitive groups; consumers remove duplicated local policy.                    |
| [v1.30.0](./v1.30.0.md) | Docker build actions publish signed GitHub provenance and require four narrow job permissions.                            |
| [v1.24.0](./v1.24.0.md) | Removes the `go-actions/go-report-card` action (dead service); activation-snapshot membership resolves without the label. |
| [v1.21.0](./v1.21.0.md) | Activation-snapshot wave boundary — converge every repo, planning repos included.                                         |
| [v1.1.0](./v1.1.0.md)   | `client_id` bot-token input (deprecates `app_id`); UI-dispatched releases added.                                          |
