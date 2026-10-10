// Bind screenshot-change approval to a human label action and an exact PR head.
import { appendFile, readFile } from "node:fs/promises";
import { Failure, GitHub, runCli } from "./common.mjs";

export const LABEL = "allow-screenshot-change";
export const APPROVAL = "visual-change-approval";
export const COMPARISON = "visual-comparison";

/** Verify human approval and the trusted workflow receipt for each compared head. */
export class Policy {
  constructor(github) {
    this.github = github;
  }

  post(path, body = {}) {
    return this.github.request(path, { method: "POST", body });
  }

  status(sha, context, state, description, target) {
    return this.post(`statuses/${sha}`, { context, state, description, target_url: target });
  }

  async latestStatus(sha, context, before) {
    for (const status of await this.github.pages(`commits/${sha}/statuses`)) {
      if (status.context === context && (!before || status.created_at <= before)) {
        return status.creator.login === "github-actions[bot]" ? status : null;
      }
    }
    return null;
  }

  async latestLabel(pr, before) {
    let latest;
    for (const event of await this.github.pages(`issues/${pr.number}/events`)) {
      if (
        ["labeled", "unlabeled"].includes(event.event) &&
        event.label?.name === LABEL &&
        (!before || event.created_at <= before)
      ) {
        if (
          !latest ||
          event.created_at > latest.created_at ||
          (event.created_at === latest.created_at && event.id > latest.id)
        )
          latest = event;
      }
    }
    return latest;
  }

  async approved(pr, before) {
    const latest = await this.latestLabel(pr, before);
    if (!latest || latest.event !== "labeled" || latest.actor?.type !== "User" || latest.performed_via_github_app)
      return false;
    const permission = await this.github.request(`collaborators/${encodeURIComponent(latest.actor.login)}/permission`);
    if (!["admin", "maintain", "write"].includes(permission.permission)) return false;
    const receipt = await this.latestStatus(pr.head.sha, APPROVAL, before);
    if (
      !receipt ||
      receipt.state !== "success" ||
      receipt.description !== "Approved current PR head" ||
      receipt.created_at < latest.created_at
    )
      return false;
    const match = this.runTarget(receipt);
    if (!match) return false;
    const run = await this.github.request(`actions/runs/${match[1]}/attempts/${match[2]}`);
    return (
      run.event === "pull_request_target" &&
      run.path === ".github/workflows/visual-tests.yaml" &&
      run.display_title === `Visual approval ${pr.number} ${pr.head.sha} master labeled` &&
      this.github.successfulJob(match[1], match[2], "approval")
    );
  }

  runTarget(status) {
    const repository = this.github.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return status.target_url?.match(
      new RegExp(`^https://github\\.com/${repository}/actions/runs/(\\d+)/attempts/(\\d+)$`)
    );
  }

  async proof(pr, baseline, before) {
    const status = await this.latestStatus(pr.head.sha, COMPARISON, before);
    if (!status || status.state !== "success") return null;
    const match = this.runTarget(status);
    if (!match) return null;
    const run = await this.github.request(`actions/runs/${match[1]}/attempts/${match[2]}`);
    if (
      run.head_sha !== pr.head.sha ||
      run.path !== ".github/workflows/main.yaml" ||
      run.event !== "push" ||
      !(await this.github.successfulBrowserRun({ properties: { run_id: match[1], attempt: match[2] } }))
    )
      return null;
    if (status.description === "approved" && (await this.approved(pr, before))) return "approved";
    return status.description === `matched:${baseline}` ? "matched" : null;
  }

  /** Same-repository PRs queued for master, by the merge-queue commit GitHub built for each. */
  async queued() {
    const [owner, name] = this.github.repository.split("/");
    try {
      const data = await this.github.graphql(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
          mergeQueue(branch: "master") { entries(first: 100) { nodes {
            headCommit { oid } pullRequest { number isCrossRepository baseRefName headRefOid } } } } } }`,
        { owner, name }
      );
      const entries = new Map();
      for (const { headCommit, pullRequest: pr } of data.repository?.mergeQueue?.entries.nodes ?? [])
        if (headCommit && pr && !pr.isCrossRepository && pr.baseRefName === "master")
          entries.set(headCommit.oid, { number: pr.number, head: { sha: pr.headRefOid } });
      return entries;
    } catch (error) {
      // Without the queue, attribution falls back to commit ancestry, which never grants more.
      console.warn(`::warning::Could not read the merge queue: ${error.message}`);
      return new Map();
    }
  }

  async associated(base, head, merged) {
    const commits = [];
    for (let page = 1; ; page++) {
      if (page > 100) throw new Failure("Comparison history exceeds the approval review limit");
      const data = await this.github.request(`compare/${base}...${head}?per_page=100&page=${page}`);
      commits.push(...data.commits);
      if (data.commits.length < 100) break;
    }
    const commitIds = new Set(commits.map((commit) => commit.sha));
    const queued = merged ? new Map() : await this.queued();
    const pulls = new Map(),
      covered = new Set();
    for (const commit of commits) {
      // A squash queue builds a fresh commit for each entry, so only the queue knows its PR.
      const entry = queued.get(commit.sha);
      if (entry) {
        pulls.set(entry.number, entry);
        covered.add(commit.sha);
        continue;
      }
      for (const pr of await this.github.pages(`commits/${commit.sha}/pulls`)) {
        if (pr.base.ref !== "master" || pr.head.repo?.full_name !== this.github.repository) continue;
        if (
          (merged && pr.merged_at && commitIds.has(pr.merge_commit_sha)) ||
          (!merged && pr.state === "open" && commitIds.has(pr.head.sha))
        ) {
          pulls.set(pr.number, pr);
          covered.add(commit.sha);
        }
      }
    }
    for (const commit of commits) {
      if (!covered.has(commit.sha)) {
        const parents = new Set((commit.parents ?? []).map((parent) => parent.sha));
        if (parents.size < 2 || [...parents].some((parent) => parent !== base && !covered.has(parent))) return [];
        covered.add(commit.sha);
      }
    }
    return [...pulls.values()];
  }

  async allows(event, eventName, sha, ref, baseline) {
    if (eventName === "merge_group" || (eventName === "push" && ref === "refs/heads/master")) {
      const merged = eventName === "push";
      if (!merged && event.merge_group.head_sha !== sha) return false;
      const pulls = await this.associated(merged ? baseline : event.merge_group.base_sha, sha, merged);
      const proofs = [];
      for (const pr of pulls) proofs.push(await this.proof(pr, baseline, merged ? pr.merged_at : undefined));
      return proofs.length > 0 && proofs.every(Boolean) && proofs.includes("approved");
    }
    if (eventName !== "push") return false;
    const branch = ref.replace(/^refs\/heads\//, "");
    const pulls = await this.github.pages(
      `pulls?state=open&head=${this.github.repository.split("/")[0]}:${encodeURIComponent(branch)}`
    );
    for (const pr of pulls)
      if (pr.head.sha === sha && pr.base.ref === "master" && (await this.approved(pr))) return true;
    return false;
  }

  async labelEvent(event) {
    const action = event.action;
    if (!["labeled", "unlabeled", "synchronize", "opened", "reopened"].includes(action)) return;
    if (["labeled", "unlabeled"].includes(action) && event.label?.name !== LABEL) return;
    const pr = await this.github.request(`pulls/${Number(event.number)}`);
    if (pr.head.repo?.full_name !== this.github.repository || pr.head.sha !== event.pull_request.head.sha) return;
    let approved = false;
    if (action === "labeled" && event.sender.type === "User") {
      const permission = await this.github.request(
        `collaborators/${encodeURIComponent(event.sender.login)}/permission`
      );
      approved = ["admin", "maintain", "write"].includes(permission.permission);
    }
    // Browser comparisons block unapproved changes; this receipt only records approval state.
    await this.status(
      pr.head.sha,
      APPROVAL,
      "success",
      approved ? "Approved current PR head" : "No approval recorded; screenshot changes remain blocked",
      this.target()
    );
    if (!["labeled", "unlabeled"].includes(action)) return { approved };
    // The rerun checks this receipt only after its setup, by which time this job has succeeded.
    return { approved, rerun: await this.refresh(pr, await this.latestLabel(pr)) };
  }

  /** Refresh the open PR whose head a completed push run of main tested. */
  async completed(run) {
    if (run.event !== "push") return null;
    const owner = this.github.repository.split("/")[0];
    const pr = (await this.github.pages(`pulls?state=open&head=${owner}:${encodeURIComponent(run.head_branch)}`)).find(
      (candidate) =>
        candidate.head.sha === run.head_sha &&
        candidate.base.ref === "master" &&
        candidate.head.repo?.full_name === this.github.repository
    );
    if (!pr) return null;
    const label = await this.latestLabel(pr);
    const receipt = await this.latestStatus(pr.head.sha, APPROVAL);
    // Until a receipt follows the label change, its own approval run is pending and refreshes instead.
    return label && receipt?.created_at >= label.created_at ? this.refresh(pr, label) : null;
  }

  /** Rerun the head's browser job when its latest main attempt finished but began before the label change. */
  async refresh(pr, label) {
    if (!label) return null;
    const { workflow_runs: runs } = await this.github.request(
      `actions/workflows/main.yaml/runs?head_sha=${pr.head.sha}&event=push&per_page=100`
    );
    const run = runs
      .filter(
        (candidate) =>
          candidate.head_sha === pr.head.sha &&
          candidate.event === "push" &&
          candidate.path === ".github/workflows/main.yaml"
      )
      .sort((a, b) => a.run_number - b.run_number)
      .at(-1);
    // A run still in progress is refreshed by its completion event.
    if (run?.status !== "completed" || run.run_started_at > label.created_at) return null;
    const { jobs } = await this.github.request(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const job = jobs.find((entry) => entry.name === "test-browser");
    if (!job || job.conclusion === "skipped") return null;
    await this.post(`actions/jobs/${job.id}/rerun`);
    return run;
  }

  target() {
    return `https://github.com/${this.github.repository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
  }
}

async function main() {
  const env = process.env;
  const policy = new Policy(new GitHub(env.GITHUB_REPOSITORY, env.GH_TOKEN));
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const mode = process.argv[2];
  if (mode === "label") {
    const review =
      env.GITHUB_EVENT_NAME === "workflow_run"
        ? { rerun: await policy.completed(event.workflow_run) }
        : await policy.labelEvent(event);
    const lines = [];
    if (review?.approved !== undefined)
      lines.push(
        review.approved
          ? "Screenshot changes are approved for this commit."
          : "No screenshot approval is recorded for this commit. The `visual-comparison` check links any drift review."
      );
    if (review?.rerun)
      lines.push(
        `[Main CI](https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${review.rerun.id}) reruns its browser check for the label change.`
      );
    if (lines.length) await appendFile(env.GITHUB_STEP_SUMMARY, `## Screenshot approval\n\n${lines.join("\n\n")}\n`);
  } else if (mode === "allow") {
    const { baseline } = JSON.parse(await readFile(".visual/context.json", "utf8"));
    const allowed =
      Boolean(baseline) &&
      (await policy.allows(event, env.GITHUB_EVENT_NAME, env.GITHUB_SHA, env.GITHUB_REF, baseline));
    await appendFile(env.GITHUB_ENV, `VISUAL_APPROVED=${allowed}\n`);
  } else if (mode === "record") {
    const success = env.VISUAL_OUTCOME === "success";
    const { baseline } = JSON.parse(await readFile(".visual/context.json", "utf8"));
    const verdict = success ? JSON.parse(await readFile(".visual/verdict.json", "utf8")) : {};
    const description = success
      ? verdict.changed
        ? "approved"
        : `matched:${baseline}`
      : "Visual tests or evidence upload failed";
    await policy.status(env.GITHUB_SHA, COMPARISON, success ? "success" : "failure", description, policy.target());
  } else throw new Failure("Unknown approval operation");
}

runCli(import.meta.url, main, "Screenshot approval verification failed");
