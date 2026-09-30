// Shared GitHub provenance checks for screenshot publication and approval.
import { pathToFileURL } from "node:url";

/** A safe operator-facing error that contains no credential or API payload. */
export class Failure extends Error {}

/** Run a script entry point while keeping private API errors out of public logs. */
export function runCli(url, main, message) {
  if (process.argv[1] && url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
      console.error(`::error::${error instanceof Failure ? error.message : message}`);
      process.exitCode = 1;
    });
  }
}

/** Verify run and branch provenance using the caller's repository token. */
export class GitHub {
  constructor(repository, token) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Failure("Invalid repository coordinate");
    this.repository = repository;
    this.token = token;
  }

  async request(path, { missing = false, method = "GET", body } = {}) {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Failure(`GitHub request failed (HTTP ${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async pages(path) {
    const values = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new Failure("Unexpected GitHub list response");
      values.push(...result);
      if (result.length < 100) return values;
    }
    throw new Failure("GitHub pagination limit exceeded");
  }

  async current(sha, runId, attempt) {
    const ref = await this.request("git/ref/heads/master");
    const run = await this.request(`actions/runs/${runId}`);
    return (
      ref.object.sha === sha &&
      run.head_sha === sha &&
      run.head_branch === "master" &&
      run.event === "push" &&
      run.path === ".github/workflows/main.yaml" &&
      run.run_attempt === Number(attempt)
    );
  }

  async successfulJob(runId, attempt, name) {
    const jobs = await this.request(`actions/runs/${Number(runId)}/attempts/${Number(attempt)}/jobs?per_page=100`);
    if (jobs.total_count > 100) throw new Failure("Too many jobs to verify test completion");
    const selected = jobs.jobs.filter((job) => job.name === name);
    return selected.length === 1 && selected[0].status === "completed" && selected[0].conclusion === "success";
  }

  async successfulBrowserRun(batch) {
    const props = batch.properties;
    const run = await this.request(`actions/runs/${Number(props.run_id)}/attempts/${Number(props.attempt)}`);
    return run.status === "completed" && this.successfulJob(props.run_id, props.attempt, "test-browser");
  }

  async branch(batch) {
    const props = batch.properties;
    const run = await this.request(`actions/runs/${Number(props.run_id)}/attempts/${Number(props.attempt)}`, {
      missing: true,
    });
    if (!run) return [null, true];
    if (
      run.path !== ".github/workflows/main.yaml" ||
      run.head_repository.full_name !== this.repository ||
      run.head_sha !== props.sha ||
      run.run_number !== Number(props.run_number) ||
      !["push", "merge_group"].includes(run.event)
    ) {
      throw new Failure("Batch provenance does not match its GitHub run");
    }
    const branch = run.head_branch;
    const ref = await this.request(`git/ref/heads/${encodeURIComponent(branch)}`, { missing: true });
    if (!ref) return [null, true];
    if (run.event === "merge_group") return run.status === "completed" ? [null, true] : [branch, false];
    const pulls = await this.pages(
      `pulls?state=closed&head=${this.repository.split("/")[0]}:${encodeURIComponent(branch)}`
    );
    if (pulls.some((pr) => pr.merged_at && pr.head.sha === run.head_sha)) return [null, true];
    return [branch, run.status === "completed"];
  }
}
