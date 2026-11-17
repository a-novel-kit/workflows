import assert from "node:assert/strict";
import { test } from "node:test";
import { step, succeeds, workspace } from "./helpers.mjs";

const post = step(".github/workflows/bot-comment-run.yaml", "Post comments");

/** Runs the step against a stubbed gh: listings are empty, and POST answers `posted` or fails. */
function run(t, { posted, locked }) {
  const w = workspace(t);
  w.stub(
    "gh",
    `const args = process.argv.slice(2);
    const path = args.find((arg) => arg.startsWith("repos/"));
    if (args.includes("POST")) {
      if (${JSON.stringify(posted ?? "")}) { console.log(${JSON.stringify(posted ?? "")}); process.exit(0); }
      console.error("gh: Validation Failed (HTTP 422)");
      process.exit(1);
    }
    console.log(path.endsWith("/comments") ? "[]" : ${JSON.stringify(String(locked))});`
  );
  return w.bash(post, {
    OWNER: "a-novel-kit",
    REPO: ".github",
    NONCE: "0a1b",
    NUMBER: "",
    BODY: "",
    REPLY_TO: "",
    COMMENTS: JSON.stringify([{ number: 475, body: "Fixed.", reply_to: 4606091612 }]),
  });
}

test("bot-comment posts a reply and prints its url", (t) => {
  const url = "https://github.com/a-novel-kit/.github/pull/475#discussion_r1";
  assert.match(succeeds(run(t, { posted: url })), new RegExp(`posted: ${url}`));
});

test("bot-comment names the lock when GitHub refuses a reply on a locked conversation", (t) => {
  const result = run(t, { locked: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::a-novel-kit\/\.github#475 is locked, so it takes no comment or reply\./);
});

test("bot-comment fails without a lock error when the conversation is open", (t) => {
  const result = run(t, { locked: false });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /is locked/);
  assert.match(result.stderr, /Validation Failed \(HTTP 422\)/);
});
