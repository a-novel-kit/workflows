// Collect the CI warnings an org's default branches raised since the caller's previous successful
// run, merged into one entry per warning. GitHub keeps every `::warning::` as a check-run
// annotation, so the runs' annotations are the whole record.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const day = 86_400_000;
const fields = ["repo", "job", "message"];
// One query reads 50 runs, each job's first 50 annotations, under GitHub's 500,000-node limit.
// GitHub itself keeps at most 10 warnings per step.
const batch = 50;
const query = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on CheckSuite {
  repository { nameWithOwner }
  checkRuns(first: 100, filterBy: {checkType: LATEST}) { nodes {
    name url annotations(first: 50) { nodes { annotationLevel title message } }
  } }
} } }`;

/** Parses the ignore rules, refusing a rule without a reason, without a pattern or with an unknown field. */
export function parseRules(json) {
  const rules = JSON.parse(json);
  const valid =
    Array.isArray(rules) &&
    rules.every(
      (rule) =>
        rule?.constructor === Object &&
        Object.keys(rule).every((key) => key === "reason" || fields.includes(key)) &&
        typeof rule.reason === "string" &&
        rule.reason !== "" &&
        fields.some((field) => field in rule) &&
        fields.every((field) => !(field in rule) || typeof rule[field] === "string")
    );
  if (!valid) throw new Error("ignore must list rules holding a reason and string patterns for repo, job or message.");
  return rules.map((rule) => ({
    reason: rule.reason,
    patterns: fields.filter((field) => field in rule).map((field) => [field, new RegExp(rule[field])]),
  }));
}

/**
 * The check suites of the runs that finished inside the window, on a repository's own default
 * branch. Pull request runs belong to their pull request, and a fork can name its branch after the
 * default one. GitHub timestamps share one ISO 8601 UTC format, so they compare as strings.
 */
export const selectSuites = (runs, since, until) =>
  runs
    .filter(
      (run) =>
        run.event !== "pull_request" &&
        run.head_repository?.full_name === run.repository.full_name &&
        run.updated_at > since &&
        run.updated_at <= until
    )
    .map((run) => run.check_suite_node_id);

/**
 * Merges the suites' warning annotations into one entry per fingerprint: the wording without its
 * numbers and hashes, which change between runs. A warning takes the first rule matching all its
 * patterns, and each rule counts what it hid.
 */
export function digest(suites, rules) {
  const hidden = rules.map(() => 0);
  const entries = new Map();
  for (const suite of suites.filter(Boolean)) {
    for (const run of suite.checkRuns.nodes) {
      for (const { annotationLevel, title, message } of run.annotations.nodes) {
        if (annotationLevel !== "WARNING") continue;
        const hit = {
          repo: suite.repository.nameWithOwner,
          job: run.name,
          message: [title, message].filter(Boolean).join(": "),
        };
        const rule = rules.findIndex(({ patterns }) => patterns.every(([field, pattern]) => pattern.test(hit[field])));
        if (rule >= 0) {
          hidden[rule] += 1;
          continue;
        }
        const key = hit.message.replace(/[0-9a-f]{7,}|[0-9]+/g, "#");
        const entry = entries.get(key) ?? { message: hit.message, hits: 0, jobs: new Set(), repos: new Map() };
        entry.hits += 1;
        entry.jobs.add(hit.job);
        if (!entry.repos.has(hit.repo)) entry.repos.set(hit.repo, run.url);
        entries.set(key, entry);
      }
    }
  }
  const warnings = [...entries.values()]
    .map(({ message, hits, jobs, repos }) => ({
      message,
      hits,
      jobs: [...jobs].sort(),
      repos: [...repos].sort(([a], [b]) => a.localeCompare(b)).map(([repo, url]) => ({ repo, url })),
    }))
    .sort((a, b) => b.repos.length - a.repos.length || b.hits - a.hits);
  return { warnings, rules: rules.map(({ reason }, i) => ({ reason, hidden: hidden[i] })) };
}

const cell = (text) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The step summary: every warning, then what each ignore rule hid. */
export function summary({ warnings, rules }, since, until) {
  const lines = [`Default-branch runs finished between ${since} and ${until}.`, ""];
  if (warnings.length === 0) lines.push("No warnings.", "");
  else {
    lines.push("| Warning | Hits | Jobs | Repositories |", "| --- | --- | --- | --- |");
    for (const { message, hits, jobs, repos } of warnings) {
      const links = repos.map(({ repo, url }) => `[${repo}](${url})`).join(", ");
      lines.push(`| ${cell(message)} | ${hits} | ${jobs.join(", ")} | ${links} |`);
    }
    lines.push("");
  }
  if (rules.length > 0) {
    lines.push("| Ignore rule | Hidden |", "| --- | --- |");
    for (const { reason, hidden } of rules) lines.push(`| ${cell(reason)} | ${hidden || "0, matched nothing"} |`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The Discord post: a title, one bold line per warning with its jobs, hits and repositories. */
export function post({ warnings, rules }) {
  const hidden = rules.reduce((sum, rule) => sum + rule.hidden, 0);
  const line = (message) => {
    const first = message.split("\n")[0];
    return first.length > 200 ? `${first.slice(0, 199)}…` : first;
  };
  return {
    count: warnings.length,
    title: `${plural(warnings.length, "CI warning")} on the default branches`,
    footer: hidden === 0 ? "" : `${hidden} hidden by ignore rules`,
    description: warnings
      .flatMap(({ message, hits, jobs, repos }) => [
        `**${line(message)}**`,
        `-# ${jobs.map((job) => `\`${job}\``).join(", ")} · ${plural(hits, "hit")} · ${repos
          .map(({ repo, url }) => `[${repo.split("/")[1]}](${url})`)
          .join(", ")}`,
      ])
      .join("\n"),
  };
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 }).trim();
}

const iso = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

function main() {
  const {
    CALLER,
    IGNORE,
    GITHUB_REPOSITORY,
    GITHUB_REPOSITORY_OWNER,
    GITHUB_RUN_ID,
    GITHUB_OUTPUT,
    GITHUB_STEP_SUMMARY,
  } = process.env;
  const rules = parseRules(IGNORE);

  // A run counts in the window where it finished, from the previous successful run's creation to
  // this one's, so consecutive digests never overlap. A first run looks back one day.
  const until = gh(["api", `repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`, "--jq", ".created_at"]);
  const workflow = CALLER.split("@")[0].split("/").at(-1);
  const previous = ["run", "list", "--repo", GITHUB_REPOSITORY, "--workflow", workflow, "--status", "success"];
  const since =
    gh([...previous, "--limit", "1", "--json", "createdAt", "--jq", ".[0].createdAt // empty"]) ||
    iso(Date.parse(until) - day);
  // A run finishing in the window started at most a day before it.
  const created = iso(Date.parse(since) - day);

  const repos = JSON.parse(gh(["api", "--paginate", "--slurp", `orgs/${GITHUB_REPOSITORY_OWNER}/repos`])).flat();
  const suites = [];
  for (const { full_name, default_branch, archived } of repos) {
    if (archived) continue;
    const url = `repos/${full_name}/actions/runs?branch=${default_branch}&status=completed&created=>=${created}&per_page=100`;
    const runs = JSON.parse(gh(["api", "--paginate", "--slurp", url])).flatMap((page) => page.workflow_runs);
    suites.push(...selectSuites(runs, since, until));
  }
  const nodes = [];
  for (let i = 0; i < suites.length; i += batch) {
    const body = JSON.stringify({ query, variables: { ids: suites.slice(i, i + batch) } });
    nodes.push(...JSON.parse(gh(["api", "graphql", "--input", "-"], body)).data.nodes);
  }

  const result = digest(nodes, rules);
  appendFileSync(GITHUB_STEP_SUMMARY, summary(result, since, until));
  const { count, title, footer, description } = post(result);
  const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  appendFileSync(
    GITHUB_OUTPUT,
    `count=${count}\ntitle=${title}\nfooter=${footer}\ndescription<<${delimiter}\n${description}\n${delimiter}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
