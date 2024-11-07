# Auto-merge PR (Dependabot)

Automatically approves and merge a Pull Request from the
[dependabot](https://docs.github.com/en/code-security/getting-started/dependabot-quickstart-guide), once all
requirements have been met.

> The Personal Access Token used MUST have at least the `repo` scope.

```yaml
name: generic job
on: pull_request

jobs:
  dependabot:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: do something
        run: |
          # Do anything on previous steps.
      - uses: a-novel-kit/workflows/generic-actions/auto-merge-dependabot@master
        with:
          pull_request: ${{ github.event.pull_request.html_url }}
          pat: ${{ secrets.PAT }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

# Options

| option         | Required | Default | Description                                      |
| :------------- | :------- | :------ | :----------------------------------------------- |
| `pull_request` | Yes      |         | The URL of the pull request to be merged.        |
| `pat`          | Yes      |         | The personal access token to use for the action. |
| `github_token` | Yes      |         | The GitHub token to use for the action.          |
