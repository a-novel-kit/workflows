// Bind screenshot-change approval to a human label action and an exact PR head.
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
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

  async approved(pr, before) {
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

  async associated(base, head, merged) {
    const commits = [];
    for (let page = 1; ; page++) {
      if (page > 100) throw new Failure("Comparison history exceeds the approval review limit");
      const data = await this.github.request(`compare/${base}...${head}?per_page=100&page=${page}`);
      commits.push(...data.commits);
      if (data.commits.length < 100) break;
    }
    const commitIds = new Set(commits.map((commit) => commit.sha));
    const pulls = new Map(),
      covered = new Set();
    for (const commit of commits) {
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
    const rerun = ["labeled", "unlabeled"].includes(action);
    let run;
    for (let attempt = 0; attempt < 240; attempt++) {
      const current = await this.github.request(`pulls/${pr.number}`);
      if (current.state !== "open" || current.head.sha !== pr.head.sha) return;
      if (!run) {
        const { workflow_runs: runs } = await this.github.request(
          `actions/workflows/main.yaml/runs?head_sha=${pr.head.sha}&event=push&per_page=100`
        );
        run = runs
          .filter(
            (candidate) =>
              candidate.head_sha === pr.head.sha &&
              candidate.event === "push" &&
              candidate.path === ".github/workflows/main.yaml"
          )
          .sort((a, b) => a.run_number - b.run_number)
          .at(-1);
      } else run = await this.github.request(`actions/runs/${run.id}`);
      if (run?.status === "completed") {
        let artifact;
        if (!approved) {
          const result = await this.github.request(`actions/runs/${run.id}/artifacts?per_page=100`);
          if (result.total_count > 100) throw new Failure("Too many artifacts to locate screenshot review");
          artifact = result.artifacts.find(
            (entry) =>
              entry.name === "playwright-drift.html" &&
              !entry.expired &&
              Date.parse(entry.created_at) >= Date.parse(run.run_started_at)
          );
        }
        if (rerun) await this.post(`actions/runs/${run.id}/rerun`);
        return { run, artifact, approved };
      }
      await setTimeout(5000);
    }
    throw new Failure("Main is still running; rerun visual approval after it finishes to collect screenshot review");
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
    const review = await policy.labelEvent(event);
    if (!review) return;
    const { run, artifact, approved } = review;
    const url = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `## Screenshot review\n\n[Main CI for this commit](${url})\n\n${
        artifact
          ? "Download **playwright-drift.html** from this run’s **Artifacts** section for Old / New / Diff images."
          : approved
            ? "Screenshot changes are approved for this commit."
            : run.conclusion === "success"
              ? "Main CI passed. No screenshot-change approval is needed."
              : "No current drift report is available. Check main CI; if it reports screenshot differences, rerun it to regenerate the review."
      }\n`
    );
    if (artifact) await appendFile(env.GITHUB_OUTPUT, `run_id=${run.id}\nartifact_id=${artifact.id}\n`);
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
