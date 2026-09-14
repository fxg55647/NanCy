// Regression test for shouldAnalyze()'s unknown-tool default: a worker
// session's extensions can supply tool names NanCy has never seen before
// (a new mail/cloud/publishing tool). Treating an unrecognized name as
// passive would be a silent bypass — it would execute with zero semantic
// review until this file's allowlists were updated. See the PASSIVE_TOOLS
// comment in src/policy/tool-policy.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAnalyze } from "../src/policy/tool-policy.ts";

test("an unrecognized tool name falls through to full analysis, not a silent skip", () => {
  assert.equal(shouldAnalyze("gmail_send", {}), true);
  assert.equal(shouldAnalyze("publish_to_cms", { anything: "goes" }), true);
  assert.equal(shouldAnalyze("some_future_extension_tool", undefined), true);
});

test("known passive/read-only tools still skip analysis (no regression from the default)", () => {
  for (const toolName of ["read", "ls", "view_image", "get_goal", "session_status"]) {
    assert.equal(shouldAnalyze(toolName, {}), false);
  }
});

test("read requires analysis for common credential-bearing paths", () => {
  for (const path of ["~/.ssh/id_rsa", ".aws/credentials", ".env", ".env.production", "secrets.json", "C:\\Users\\me\\.kube\\config"]) {
    assert.equal(shouldAnalyze("read", { path }), true, path);
  }
  assert.equal(shouldAnalyze("read", { path: "docs/report.md" }), false);
});

test("known always-analyze tools are unaffected by the unknown-tool default", () => {
  for (const toolName of ["web_fetch", "web_search", "write", "edit", "apply_patch", "message"]) {
    assert.equal(shouldAnalyze(toolName, {}), true);
  }
});
