# Build Docker Job

- Builds the provided docker image
- Ensure the image can run and responds to ping requests
- Publish the image to the GitHub Container Registry

The action will attempt to run the image, and ping it. The api MUST expose a `/ping` endpoint, that can return a
success response without any requirements. By default, it uses the `/v1/ping` endpoint. Look in thw options below
to change the endpoint.

```yaml
name: build

on: [push]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-rest-api@master
        with:
          # Will make the image available as [repository_name]/job:[ref_name]
          # The image name MUST start with the full repository name (org/repo)
          # to be properly published as a repository package.
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

# Options

| option             | Required | Default      | Description                                                          |
| :----------------- | :------- | :----------- | :------------------------------------------------------------------- |
| `image_name`       | Yes      |              | The name of the image to build.                                      |
| `image_tags`       | Yes      |              | The tags of the image to build, as a list of comma-separated values. |
| `github_token`     | Yes      |              | The GitHub token to use for publication.                             |
| `file`             |          | `Dockerfile` | Path of the dockerfile, relative to repository root.                 |
| `run_args`         |          |              | Args to use for the test run of the image.                           |
| `timeout`          |          | `300`        | Timeout (in deciseconds) for the container healthcheck.              |
| `tcp_timeout`      |          | `600`        | Timeout (in deciseconds) for the tcp healthcheck.                    |
| `skip_healthcheck` |          |              | Skip the test run of the image.                                      |
| `ping`             |          | `/v1/ping`   | The ping endpoint.                                                   |

```yaml
name: main

on: [push]

jobs:
  build-job:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      attestations: write
      id-token: write
    steps:
      - uses: a-novel-kit/workflows/build/docker-job@master
        with:
          image_name: ${{ github.repository }}/job
          image_tags: ${{ github.head_ref || github.ref_name }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          file: builds/custom.Dockerfile
          run_args: -e DSN="${DSN}"
          timeout: 100
          tcp_timeout: 100
          ping: /ping
          # skip_healthcheck: true
```
