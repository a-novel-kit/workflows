# Auto-assign PR Author

This job automatically assigns sets the assignee of a pull request.

```yaml
name: auto-assign author
on:
  pull_request:
    types: [opened, reopened]

jobs:
  assign-author:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: a-novel-kit/workflows/generic-actions/auto-assign-author@master
        with:
          pull_request: ${{ github.event.pull_request.number }}
          author: ${{ github.event.pull_request.user.login }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

# Options

| option         | Required | Default | Description                                  |
| :------------- | :------- | :------ | :------------------------------------------- |
| `pull_request` | Yes      |         | The number of the pull request to be merged. |
| `author`       | Yes      |         | The author to assign to the pull request.    |
| `github_token` | Yes      |         | The GitHub token to use for the action.      |
