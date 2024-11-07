# Build Docker API

- Builds the provided docker imaghe
- Ensure the image can run and can be reached at the specified port
- Publish the image to the GitHub Container Registry

> This job requires your API to expose an endpoint used to check the API health. It can be a simple ping.
> The default value uses `/v1/ping`. You can customize that below.
> 
> If you wish to disable the healthcheck, you can do so by setting `skip_healthcheck` to `true`.

```yaml
name: main

on: [ push ]

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
          # Will make the image available as [repository_name]/api:[ref_name]
          image_name: ${{ github.repository }}/api
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

# Options

Custom Dockerfile path.

```yaml
name: main

on: [ push ]

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
          # Build the Dockerfile specified.
          file: path/to/Dockerfile
          # Will make the image available as [repository_name]/api:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

Pass custom arguments when running the image for testing.

```yaml
name: main

on: [ push ]

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
          # Pass an environment variable to the image when running.
          run_args: -e DSN="${DSN}"
          # Will make the image available as [repository_name]/api:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

Disable healthcheck (just build and publish).

```yaml
name: main

on: [ push ]

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
          # 'true' is the only recognized value. Any other value will result in
          # the healthcheck being enabled.
          skip_healthcheck: true
          # Will make the image available as [repository_name]/api:[ref_name]
          image_name: ${{ github.repository }}/job
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```

Customize the endpoint used to reach your api.

```yaml
name: main

on: [ push ]

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
          # Customize the endpoint used to reach your api.
          ping: /v1/ping
          # Will make the image available as [repository_name]/api:[ref_name]
          image_name: ${{ github.repository }}/api
          # Get the branch name or tag. Works for pull requests events.
          image_tags: ${{ github.head_ref || github.ref_name }}
```
