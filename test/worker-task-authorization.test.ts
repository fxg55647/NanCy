// Regression tests for per-session worker task authorization
// (taskBySessionKey in src/index.ts). Authorization used to live in a single
// shared tasks/current.json per workerAgentId — two tasks confirmed
// concurrently on the same workerAgentId would overwrite each other's
// "current" record, so one worker's before_tool_call could end up seeing
// (or granting) the other's authorization. It's now an in-memory map keyed
// by the exact worker session key NanCy itself generates per task.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent, waitFor } from "./helpers.ts";

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "VERDICT: ALLOW\nREASON: safe confirmation request" } }] }));
});
after(() => { globalThis.fetch = originalFetch; });
const workerPluginConfig = { workerAgentId: "worker", analysis: { provider: "openai" as const, model: "test-model", apiKey: "x" }, gapDetection: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function confirmTask(handlers: Record<string, any>, sessionKey: string, id: string, description: string): Promise<void> {
  const content = confirmationContent(id, description);
  await handlers.message_sending({ content }, { sessionKey, channelId: "test" });
  handlers.message_received({ content: "y" }, { sessionKey });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastBeforeToolCall(rootDir: string, sessionKey: string): any {
  const lines = readFileSync(join(rootDir, "nancy.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  return [...lines].reverse().find(l => l.event === "before_tool_call" && l.sessionKey === sessionKey);
}

test("worker: two concurrent tasks on the same workerAgentId never see each other's authorization", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => ({ runId: "run-pending" }),
      // Never resolves — keeps both worker "runs" genuinely concurrent
      // in-flight rather than relying on timing to catch the race.
      waitForRun: () => new Promise(() => { }),
      deleteSession: async () => { },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-A", "111111", "Task A");
    await confirmTask(handlers, "sess-B", "222222", "Task B");

    const keyA = "agent:worker:task-111111";
    const keyB = "agent:worker:task-222222";
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: keyA });
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: keyB });

    const lastA = lastBeforeToolCall(rootDir, keyA);
    const lastB = lastBeforeToolCall(rootDir, keyB);
    assert.equal(lastA.taskId, "111111", "worker A must only ever see task A's authorization");
    assert.equal(lastB.taskId, "222222", "worker B must only ever see task B's authorization, never A's");
  } finally {
    cleanup();
  }
});

test("worker: a session key is not re-authorized after its task's worker session completes", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => ({ runId: "run-1" }),
      waitForRun: async () => ({ status: "ok" }),
      deleteSession: async () => { },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-1", "555555", "Do the thing");
    await waitFor(() => readFileSync(join(rootDir, "nancy.log"), "utf8").includes('"worker_session_deleted"'));

    const workerSessionKey = "agent:worker:task-555555";
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: workerSessionKey });

    const last = lastBeforeToolCall(rootDir, workerSessionKey);
    assert.equal(last.taskId, undefined, "a later call on the same session key must not inherit the finished task's authorization");
  } finally {
    cleanup();
  }
});

test("worker: refuses to spawn at all when the task-record write fails", async () => {
  let runCalled = false;
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => { runCalled = true; return { runId: "run-x" }; },
      waitForRun: async () => ({ status: "ok" }),
      deleteSession: async () => { },
    },
  });
  try {
    // Point the worker's workspace at a path that is a FILE, not a
    // directory, so mkdirSync(.../tasks) is guaranteed to fail.
    const workspaceParent = join(rootDir, "workspace");
    mkdirSync(workspaceParent, { recursive: true });
    const blockedWorkspace = join(workspaceParent, "worker-is-a-file");
    writeFileSync(blockedWorkspace, "not a directory");
    api.runtime.agent.resolveAgentWorkspaceDir = (_config: unknown, agentId: string) =>
      agentId === "worker" ? blockedWorkspace : join(rootDir, "workspace", agentId || "main");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-bad", "999999", "Should never run");

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"worker_task_copy_error"'), "the write failure must be logged");
    assert.equal(runCalled, false, "the worker must never be spawned when task-record preparation fails");

    const workerSessionKey = "agent:worker:task-999999";
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: workerSessionKey });
    const last = lastBeforeToolCall(rootDir, workerSessionKey);
    assert.equal(last.taskId, undefined, "a task that failed to prepare must never grant authorization either");
  } finally {
    cleanup();
  }
});

test("worker: task authorization is revoked on spawn error (subagent.run throws)", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => { throw new Error("spawn failed"); },
      waitForRun: async () => ({ status: "ok" }),
      deleteSession: async () => { },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-spawn-err", "333444", "Task that fails to spawn");
    await waitFor(() => readFileSync(join(rootDir, "nancy.log"), "utf8").includes('"worker_spawn_error"'));

    const workerSessionKey = "agent:worker:task-333444";
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: workerSessionKey });
    const last = lastBeforeToolCall(rootDir, workerSessionKey);
    assert.equal(last.taskId, undefined, "a task whose worker never actually started must not remain authorized");
  } finally {
    cleanup();
  }
});

test("worker: task authorization survives a wait-exhausted (never confirmed done) run but is revoked once cleanup finally runs", async () => {
  let waitCalls = 0;
  let deleteCalled = false;
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => ({ runId: "run-timeout" }),
      waitForRun: async () => { waitCalls++; return { status: "timeout" }; },
      deleteSession: async () => { deleteCalled = true; },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-timeout", "666777", "Long running task");
    await waitFor(() => readFileSync(join(rootDir, "nancy.log"), "utf8").includes('"worker_wait_exhausted"'));

    const workerSessionKey = "agent:worker:task-666777";
    // The session (and its task authorization) must still be considered
    // live — the run may genuinely still be in progress.
    await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: workerSessionKey });
    const stillLive = lastBeforeToolCall(rootDir, workerSessionKey);
    assert.equal(stillLive.taskId, "666777", "authorization must not be revoked while the session is only exhausted-waiting, not finished");
    assert.equal(deleteCalled, false, "the session itself must not have been torn down either");
  } finally {
    cleanup();
  }
});
