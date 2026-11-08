import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const post = step("generic-actions/discord-post/action.yaml", "post");

const webhook = "https://discord.invalid/api/webhooks/1/token";
const defaults = {
  WEBHOOK: webhook,
  TITLE: "master CI failed in a-novel/infra",
  URL: "https://github.com/a-novel/infra/actions/runs/1",
  DESCRIPTION: "",
  COLOR: "failed",
  FOOTER: "",
  MENTION_ROLES: "",
  MENTION_USERS: "",
  DRY_RUN: "false",
  CODES: "204",
};

/** A workspace whose curl answers each call with the next status in CODES and logs the payload and URL. */
function discord(t) {
  const w = workspace(t);
  w.stub(
    "curl",
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('posts', args[args.indexOf('--data') + 1] + '\\n');
    fs.appendFileSync('urls', args.at(-1) + '\\n');
    const calls = fs.readFileSync('posts', 'utf8').trimEnd().split('\\n').length;
    process.stdout.write(process.env.CODES.split(',')[calls - 1]);
  `
  );
  w.stub("sleep", "");
  const run = (env) => w.bash(post, { ...defaults, ...env });
  const posts = () => (existsSync(join(w.cwd, "posts")) ? w.read("posts").trimEnd().split("\n").map(JSON.parse) : []);
  const delivered = () =>
    w
      .read("output")
      .match(/^delivered=(.*)$/gm)
      .at(-1);
  const urls = () => (existsSync(join(w.cwd, "urls")) ? w.read("urls").trimEnd().split("\n") : []);
  return { w, run, posts, urls, delivered };
}

test("discord-post pings exactly the ids it is given and repeats the title for push notifications", (t) => {
  const { run, posts, delivered } = discord(t);
  const mentions = {
    MENTION_ROLES: "11, 22",
    MENTION_USERS: "33",
    DESCRIPTION: "fix by <@&99> @everyone",
    FOOTER: "a-novel/infra",
  };
  succeeds(run(mentions));
  const payload = {
    embeds: [
      {
        title: "master CI failed in a-novel/infra",
        color: 15158332,
        url: "https://github.com/a-novel/infra/actions/runs/1",
        description: "fix by <@&99> @everyone",
        footer: { text: "a-novel/infra" },
      },
    ],
    allowed_mentions: { parse: [], roles: ["11", "22"], users: ["33"] },
    content: "<@&11> <@&22> <@33> master CI failed in a-novel/infra",
  };
  assert.deepEqual(posts(), [payload]);
  assert.equal(delivered(), "delivered=true");
});

test("discord-post keeps an embed's title, description and footer within 6000 characters", (t) => {
  const { run, posts } = discord(t);
  succeeds(run({ TITLE: "t".repeat(300), DESCRIPTION: "d".repeat(5000), FOOTER: "f".repeat(3000) }));
  const [{ embeds }] = posts();
  const { title, description, footer } = embeds[0];
  assert.deepEqual([title.length, footer.text.length], [256, 2048]);
  assert.equal(title.length + description.length + footer.text.length, 6000);
  assert.match(description, /^d+…\n\n\[Read more\]\(https:\/\/github\.com\/a-novel\/infra\/actions\/runs\/1\)$/);
});

test("discord-post cuts a long description by character and links to the full text", (t) => {
  const { run, posts } = discord(t);
  succeeds(run({ DESCRIPTION: "é".repeat(5000), COLOR: "released" }));
  const [{ embeds, content }] = posts();
  const description = embeds[0].description;
  assert.equal([...description].length, 4096);
  assert.match(description, /^é+…\n\n\[Read more\]\(https:\/\/github\.com\/a-novel\/infra\/actions\/runs\/1\)$/);
  assert.equal(embeds[0].color, 10181046);
  assert.equal(content, undefined);
});

test("discord-post retries, then warns without failing the job", (t) => {
  const outcomes = [
    ["500,429,204", 3, "delivered=true"],
    ["500,500,500", 3, "delivered=false"],
  ];
  for (const [codes, calls, outcome] of outcomes) {
    const { run, posts, delivered } = discord(t);
    const result = run({ CODES: codes });
    succeeds(result);
    assert.equal(posts().length, calls, codes);
    assert.equal(delivered(), outcome, codes);
    assert.equal(result.stdout.includes("::warning::"), outcome === "delivered=false", codes);
  }
});

test("discord-post skips without a webhook or on a dry run, and rejects caller mistakes", (t) => {
  const { w, run, posts } = discord(t);
  assert.match(succeeds(run({ WEBHOOK: "" })), /::notice::No Discord webhook configured/);
  succeeds(run({ DRY_RUN: "true", MENTION_ROLES: "11" }));
  assert.match(w.read("summary"), /would post to Discord:[^]*"roles":\["11"\]/);
  assert.deepEqual(posts(), []);
  for (const env of [{ COLOR: "red" }, { MENTION_ROLES: "<@&11>" }, { MENTION_USERS: "kushuh" }]) {
    assert.equal(run(env).status, 1, JSON.stringify(env));
  }
  assert.deepEqual(posts(), []);
});

const targets = step("generic-actions/discord-dispatch/action.yaml", "targets");
const dispatch = step("generic-actions/discord-dispatch/action.yaml", "dispatch");

/** Runs the shipped dispatch over `posts`, with a gh that logs each call and fails for `failing`. */
function dispatchPosts(t, posts, { channel = "issues", dry = "false", failing = "" } = {}) {
  const w = workspace(t);
  w.write("summary", "");
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    require('node:fs').appendFileSync('calls', JSON.stringify(args) + '\\n');
    process.exit(args[args.indexOf('--repo') + 1] === process.env.FAILING ? 1 : 0);`
  );
  const result = w.bash(dispatch, { POSTS: JSON.stringify(posts), CHANNEL: channel, DRY: dry, FAILING: failing });
  const calls = existsSync(join(w.cwd, "calls")) ? w.read("calls").trimEnd().split("\n").map(JSON.parse) : [];
  return { result, calls, summary: w.read("summary") };
}

const posted = (number, repo = "a-novel/infra") => ({
  repo,
  title: `${repo}#${number} · Wire the feed`,
  url: `https://github.com/${repo}/issues/${number}`,
  description: "Moved to Ready\nwith a \\ backslash",
  color: "started",
  ping: true,
  user_ids: "1",
});
const bare = ({ repo, ...post }) => post;

test("discord-dispatch hands each repository its posts in one dispatch, in order", (t) => {
  const posts = [posted(1), posted(2, "a-novel/service-genai"), posted(3)];
  const { result, calls } = dispatchPosts(t, posts);
  succeeds(result);
  const sent = Object.fromEntries(
    calls.map((args) => {
      assert.deepEqual(args.slice(0, 3), ["workflow", "run", "notify-post.yaml"]);
      assert.equal(args[args.indexOf("channel=issues") - 1], "-f");
      const inputs = args.filter((arg) => arg.startsWith("posts="));
      return [args[args.indexOf("--repo") + 1], JSON.parse(inputs[0].slice("posts=".length))];
    })
  );
  assert.deepEqual(sent, {
    "a-novel/infra": [bare(posts[0]), bare(posts[2])],
    "a-novel/service-genai": [bare(posts[1])],
  });
});

test("discord-dispatch warns for a failed dispatch, writes a dry run to the summary, and rejects caller mistakes", (t) => {
  const posts = [posted(1), posted(2, "a-novel/service-genai")];
  const failed = dispatchPosts(t, posts, { channel: "reviews", failing: "a-novel/service-genai" });
  assert.match(
    succeeds(failed.result),
    /::warning::Could not dispatch notify-post.yaml in a-novel\/service-genai; its 1 reviews post\(s\) are lost\./
  );
  assert.equal(failed.calls.length, 2);
  assert.match(failed.summary, /Dispatched 1 reviews post\(s\) to a-novel\/infra\./);

  const dry = dispatchPosts(t, posts, { dry: "true" });
  succeeds(dry.result);
  assert.deepEqual(dry.calls, []);
  assert.match(dry.summary, /\[dry-run\] would dispatch 1 issues post\(s\) to a-novel\/infra/);

  const unknown = dispatchPosts(t, posts, { channel: "ci" });
  assert.equal(unknown.result.status, 1);
  assert.deepEqual(unknown.calls, []);
});

test("discord-dispatch scopes its token to its org's target repositories and posts only on a false dry run", (t) => {
  const other = posted(4, "a-novel-kit/.github");
  const cases = [
    [[posted(1), posted(2, "a-novel/service-genai"), posted(3)], "false", "infra,service-genai", "false"],
    [[posted(1)], " FALSE ", "infra", "false"],
    [[posted(1)], "yes", "infra", "true"],
    [[], "false", "", "false"],
    // The App's token reaches its own org alone, so another org's post goes to the caller.
    [[posted(1), other], "false", ".github,infra", "false"],
  ];
  for (const [posts, dryRun, repositories, dry] of cases) {
    const w = workspace(t);
    const env = { POSTS: JSON.stringify(posts), DRY_RUN: dryRun };
    succeeds(w.bash(targets, { ...env, GITHUB_REPOSITORY_OWNER: "a-novel", GITHUB_REPOSITORY: "a-novel/.github" }));
    const output = (name) => w.read("output").match(new RegExp(`^${name}=(.*)$`, "m"))[1];
    assert.equal(output("dry"), dry);
    assert.equal(output("repositories"), repositories);
    const routed = posts.map((post) => (post === other ? { ...post, repo: "a-novel/.github" } : post));
    assert.deepEqual(JSON.parse(output("posts")), routed);
  }
});
