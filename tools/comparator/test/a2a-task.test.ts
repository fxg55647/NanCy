// Pure unit tests for driver.ts's A2A task-result parsing (extractTaskText/
// taskFailure). Fixtures mirror the real A2A task shape (id, contextId,
// status.state, artifacts[].parts[].text) documented in
// node_modules/openclaw/docs/channels/a2a.md and exercised for real by
// tools/mobile-chat-poc/'s client.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTaskText, taskFailure } from "../src/driver.ts";

test("extracts reply text from a completed task's artifacts", () => {
  const task = {
    id: "t1",
    contextId: "ctx1",
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [{ parts: [{ text: "Formal confirmation: ...\nReply y to proceed, any other reply cancels.\n12345678" }] }],
  };
  assert.equal(extractTaskText(task), "Formal confirmation: ...\nReply y to proceed, any other reply cancels.\n12345678");
  assert.equal(taskFailure(task), undefined);
});

test("joins text across multiple artifact parts", () => {
  const task = { artifacts: [{ parts: [{ text: "part one" }] }, { parts: [{ text: "part two" }] }] };
  assert.equal(extractTaskText(task), "part one\npart two");
});

test("a failed task is recognized as an error, not empty text", () => {
  const task = { status: { state: "TASK_STATE_FAILED", message: "model unavailable" } };
  assert.equal(extractTaskText(task), "");
  assert.match(taskFailure(task)!, /TASK_STATE_FAILED/);
  assert.match(taskFailure(task)!, /model unavailable/);
});

test("a rejected task is also recognized as an error", () => {
  const task = { status: { state: "TASK_STATE_REJECTED" } };
  assert.match(taskFailure(task)!, /TASK_STATE_REJECTED/);
});

test("a completed task with genuinely no text returns empty string, not undefined/throw", () => {
  assert.equal(extractTaskText(undefined), "");
  assert.equal(extractTaskText({ status: { state: "TASK_STATE_COMPLETED" } }), "");
  assert.equal(taskFailure(undefined), undefined);
});
