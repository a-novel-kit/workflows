// Bind screenshot-change approval to a human label action and an exact PR head.
import { appendFile, readFile } from "node:fs/promises";
import { Failure, GitHub, HEAD_EVENTS, runCli, testedHead } from "./common.mjs";

export const LABEL = "allow-screenshot-change";
export const APPROVAL = "visual-change-approval";
export const COMPARISON = "visual-comparison";

/** Whether a workflow run is a run of main that tested the given pull request head. */
function testsHead(run, sha) {
  return run.head_sha === sha && HEAD_EVENTS.includes(run.event) && run.path === ".github/workflows/main.yaml";
}

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

  /** Whether the user holds write access or more on this repository. */
  async canWrite(login) {
    const { permission } = await this.github.request(`collaborators/${encodeURIComponent(login)}/permission`);
    return ["admin", "maintain", "write"].includes(permission);
  }

  /** Whether a pull request targets master from a branch of this repository. */
  ownPullRequest(pr) {
    return pr.base.ref === "master" && pr.head.repo?.full_name === this.github.repository;
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
    if (!(await this.canWrite(latest.actor.login))) return false;
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
    const repository = RegExp.escape(this.github.repository);
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
      run.head_repository?.full_name !== this.github.repository ||
      run.path !== ".github/workflows/main.yaml" ||
      !HEAD_EVENTS.includes(run.event) ||
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
        if (!this.ownPullRequest(pr)) continue;
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
    if (!HEAD_EVENTS.includes(eventName)) return false;
    // The live PR must still point at the tested head; a push since then needs its own approval.
    const pulls =
      eventName === "pull_request"
        ? [await this.github.request(`pulls/${Number(event.pull_request.number)}`)]
        : await this.github.pages(
            `pulls?state=open&head=${this.github.repository.split("/")[0]}:${encodeURIComponent(ref.replace(/^refs\/heads\//, ""))}`
          );
    for (const pr of pulls) {
      if (pr.state === "open" && pr.head.sha === sha && this.ownPullRequest(pr) && (await this.approved(pr)))
        return true;
    }
    return false;
  }

  async labelEvent(event) {
    const action = event.action;
    if (!["labeled", "unlabeled", "synchronize", "opened", "reopened"].includes(action)) return;
    if (["labeled", "unlabeled"].includes(action) && event.label?.name !== LABEL) return;
    const pr = await this.github.request(`pulls/${Number(event.number)}`);
    if (pr.head.repo?.full_name !== this.github.repository || pr.head.sha !== event.pull_request.head.sha) return;
    const approved = action === "labeled" && event.sender.type === "User" && (await this.canWrite(event.sender.login));
    // Browser comparisons block unapproved changes; this receipt only records approval state.
    const receipt = await this.status(
      pr.head.sha,
      APPROVAL,
      "success",
      approved ? "Approved current PR head" : "No approval recorded; screenshot changes remain blocked",
      this.target()
    );
    if (!["labeled", "unlabeled"].includes(action)) {
      // The label approved an earlier head, so a push drops it; adding it again approves this one.
      if (action !== "synchronize" || !pr.labels?.some((label) => label.name === LABEL)) return { approved };
      await this.github.request(`issues/${pr.number}/labels/${encodeURIComponent(LABEL)}`, {
        method: "DELETE",
        missing: true,
      });
      return { approved, revoked: true };
    }
    // The rerun checks this receipt only after its setup, by which time this job has succeeded.
    return { approved, rerun: await this.refresh(pr, receipt.created_at) };
  }

  /** Refresh the open PR whose head a completed run of main tested. */
  async completed(run) {
    if (!HEAD_EVENTS.includes(run.event)) return null;
    const owner = this.github.repository.split("/")[0];
    const pulls = await this.github.pages(`pulls?state=open&head=${owner}:${encodeURIComponent(run.head_branch)}`);
    const pr = pulls.find((candidate) => candidate.head.sha === run.head_sha && this.ownPullRequest(candidate));
    if (!pr) return null;
    const label = await this.latestLabel(pr);
    const receipt = await this.latestStatus(pr.head.sha, APPROVAL);
    // Until a receipt follows the label change, its own approval run is pending and refreshes instead.
    return label && receipt?.created_at >= label.created_at ? this.refresh(pr, receipt.created_at) : null;
  }

  /** Rerun the head's browser job when its latest main attempt finished but the job began before the receipt. */
  async refresh(pr, receiptAt) {
    const { workflow_runs: runs } = await this.github.request(
      `actions/workflows/main.yaml/runs?head_sha=${pr.head.sha}&per_page=100`
    );
    const run = runs
      .filter((candidate) => testsHead(candidate, pr.head.sha))
      .sort((a, b) => a.run_number - b.run_number)
      .at(-1);
    // A run still in progress is refreshed by its completion event.
    if (run?.status !== "completed") return null;
    const { jobs } = await this.github.request(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const job = jobs.find((entry) => entry.name === "test-browser");
    // A label change also starts a pull request run, whose browser job may check before the receipt exists.
    if (!job || job.conclusion === "skipped" || job.started_at > receiptAt) return null;
    await this.post(`actions/jobs/${job.id}/rerun`);
    return run;
  }

  target() {
    return `https://github.com/${this.github.repository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
  }
}

/** Record a label change, or refresh after a completed run, and summarize the head's approval. */
async function summarizeApproval(env, policy, event) {
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
  if (review?.revoked)
    lines.push(
      `Removed the \`${LABEL}\` label, which approved an earlier commit. Add it again once this commit's screenshots are reviewed.`
    );
  if (review?.rerun)
    lines.push(
      `[Main CI](https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${review.rerun.id}) reruns its browser check for the label change.`
    );
  if (lines.length) await appendFile(env.GITHUB_STEP_SUMMARY, `## Screenshot approval\n\n${lines.join("\n\n")}\n`);
}

/** Tell the runner whether this tested head may regenerate its screenshots. */
async function allowRegeneration(env, policy, event) {
  const { baseline } = JSON.parse(await readFile(".visual/context.json", "utf8"));
  const allowed =
    Boolean(baseline) &&
    (await policy.allows(event, env.GITHUB_EVENT_NAME, testedHead(env), env.GITHUB_REF, baseline).catch((error) => {
      // An unverified head counts as unapproved, which never grants more: matching screenshots still pass.
      console.warn(`::warning::Could not verify screenshot approval, so changes stay blocked: ${error.message}`);
      return false;
    }));
  await appendFile(env.GITHUB_ENV, `VISUAL_APPROVED=${allowed}\n`);
}

/** Post the visual-comparison status: the proof a merge reads, or what the head still needs. */
async function recordComparison(env, policy) {
  const success = env.VISUAL_OUTCOME === "success";
  const pending = !success && env.APPROVAL === "required";
  const { baseline } = JSON.parse(await readFile(".visual/context.json", "utf8"));
  let description = "Visual tests or evidence upload failed";
  if (success) {
    const { changed } = JSON.parse(await readFile(".visual/verdict.json", "utf8"));
    description = changed ? "approved" : `matched:${baseline}`;
  } else if (pending) description = `Screenshots changed: review the drift, then add the ${LABEL} label`;
  // Only a successful comparison's run link serves as proof, so a pending one links its review.
  const target = pending && env.DRIFT_URL ? env.DRIFT_URL : policy.target();
  await policy.status(testedHead(env), COMPARISON, success ? "success" : "failure", description, target);
}

async function main() {
  const env = process.env;
  const policy = new Policy(new GitHub(env.GITHUB_REPOSITORY, env.GH_TOKEN));
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const mode = process.argv[2];
  if (mode === "label") await summarizeApproval(env, policy, event);
  else if (mode === "allow") await allowRegeneration(env, policy, event);
  else if (mode === "record") await recordComparison(env, policy);
  else throw new Failure("Unknown approval operation");
}

runCli(import.meta.url, main, "Screenshot approval verification failed");
