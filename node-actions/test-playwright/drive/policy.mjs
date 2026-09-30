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
    if (!receipt || receipt.state !== "success" || receipt.created_at < latest.created_at) return false;
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
    await this.status(
      pr.head.sha,
      APPROVAL,
      approved ? "success" : "failure",
      approved ? "Approved current PR head" : "Apply the label after reviewing this head",
      this.target()
    );
    if (!["labeled", "unlabeled"].includes(action)) return;
    const runs = (
      await this.github.request(`actions/workflows/main.yaml/runs?head_sha=${pr.head.sha}&event=push&per_page=100`)
    ).workflow_runs;
    if (!runs.length) throw new Failure("No main run exists for the labeled PR head");
    let run = runs.sort((a, b) => a.run_number - b.run_number).at(-1);
    for (let attempt = 0; attempt < 240; attempt++) {
      const current = await this.github.request(`pulls/${pr.number}`);
      if (current.state !== "open" || current.head.sha !== pr.head.sha) return;
      run = await this.github.request(`actions/runs/${run.id}`);
      if (run.status === "completed") {
        await this.post(`actions/runs/${run.id}/rerun`);
        return;
      }
      await setTimeout(5000);
    }
    throw new Failure("Label approval recorded; main is still running and needs a rerun");
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
  if (mode === "label") await policy.labelEvent(event);
  else if (mode === "allow") {
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
