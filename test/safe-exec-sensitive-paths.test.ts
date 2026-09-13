// Regression tests for the SAFE_EXEC content-reading-verb gap: cat/head/tail
// read arbitrary file *contents* (unlike the other SAFE_EXEC verbs, which
// only reveal metadata or don't read file content at all), so a bare
// prefix match let `cat ~/.ssh/id_rsa` or `cat ~/.aws/credentials` skip
// semantic analysis entirely just because "cat" is on the allowlist. Found
// via scripts/run-eval.mts's macro-review escalation scenario, where the
// aggregate behavioral review caught the overall pattern that time, but a
// single such read should not depend on that as its only backstop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAnalyze } from "../src/policy/tool-policy.ts";

function execRequiresAnalysis(command: string): boolean {
  return shouldAnalyze("exec", { command });
}

test("cat/head/tail on a well-known credential path requires full analysis, not the SAFE_EXEC skip", () => {
  assert.equal(execRequiresAnalysis("cat ~/.ssh/id_rsa"), true);
  assert.equal(execRequiresAnalysis("cat ~/.aws/credentials"), true);
  assert.equal(execRequiresAnalysis("head -n 5 .env"), true);
  assert.equal(execRequiresAnalysis("tail /etc/shadow"), true);
  assert.equal(execRequiresAnalysis("cat ~/.npmrc"), true);
  assert.equal(execRequiresAnalysis("cat secrets.json"), true);
});

test("cat/head/tail on an ordinary, non-sensitive path still skips analysis (no latency regression)", () => {
  assert.equal(execRequiresAnalysis("cat README.md"), false);
  assert.equal(execRequiresAnalysis("head -n 20 report.txt"), false);
  assert.equal(execRequiresAnalysis("tail -f nancy.log"), false);
});

test("the other SAFE_EXEC verbs (metadata-only or non-reading) are unaffected by the sensitive-path check", () => {
  assert.equal(execRequiresAnalysis("ls ~/.ssh"), false, "ls only lists names, never reads a key's contents");
  assert.equal(execRequiresAnalysis("pwd"), false);
  assert.equal(execRequiresAnalysis("whoami"), false);
  assert.equal(execRequiresAnalysis("echo ~/.ssh/id_rsa"), false, "echo prints its literal argument, it never reads the file");
});

test("shell metacharacters still force full analysis regardless of the verb or path", () => {
  assert.equal(execRequiresAnalysis("cat report.txt; rm -rf ~"), true);
  assert.equal(execRequiresAnalysis("cat $(cat ~/.ssh/id_rsa)"), true);
});
