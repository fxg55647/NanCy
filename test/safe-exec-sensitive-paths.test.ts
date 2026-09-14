// Regression tests for the removed SAFE_EXEC shell exemption. Command names,
// aliases, executable prefixes and options are not a dependable read-only
// boundary, so every exec call now reaches semantic review.
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

test("cat/head/tail on ordinary paths still require analysis because shell resolution is not a safety boundary", () => {
  assert.equal(execRequiresAnalysis("cat README.md"), true);
  assert.equal(execRequiresAnalysis("head -n 20 report.txt"), true);
  assert.equal(execRequiresAnalysis("tail -f nancy.log"), true);
});

test("formerly exempt exec verbs all require analysis, including mutating options and executable-name prefixes", () => {
  assert.equal(execRequiresAnalysis("ls ~/.ssh"), true);
  assert.equal(execRequiresAnalysis("pwd"), true);
  assert.equal(execRequiresAnalysis("date -s 2030-01-01"), true);
  assert.equal(execRequiresAnalysis("mkdir unauthorized-dir"), true);
  assert.equal(execRequiresAnalysis("echo-malicious"), true);
  assert.equal(execRequiresAnalysis("ls/custom-program"), true);
});

test("shell metacharacters still force full analysis regardless of the verb or path", () => {
  assert.equal(execRequiresAnalysis("cat report.txt; rm -rf ~"), true);
  assert.equal(execRequiresAnalysis("cat $(cat ~/.ssh/id_rsa)"), true);
});
