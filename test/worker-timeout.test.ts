// Regression test: waitForRun returning "timeout" means the *wait call* gave
// up, not that the worker's run actually finished. spawnWorkerForTask must
// not treat a timeout as completion and delete the worker session out from
// under a run that may still be executing — it should keep waiting (up to
// WORKER_MAX_WAIT_ATTEMPTS) and only skip cleanup if it truly never settles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, waitFor, confirmationContent } from "./helpers.ts";

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

test("worker: retries through timeouts and only cleans up once waitForRun reports ok", async () => {
  let waitCalls = 0;
  const results = [{ status: "timeout" }, { status: "timeout" }, { status: "ok" }];
  let deleted = false;
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => ({ runId: "run-1" }),
      waitForRun: async () => results[Math.min(waitCalls++, results.length - 1)],
      deleteSession: async () => { deleted = true; },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-1", "111111", "Do the thing");
    await waitFor(() => deleted);

    assert.equal(waitCalls, 3, "should have retried waitForRun through both timeouts");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"worker_wait_retry"'), "each timeout retry should be logged");
    assert.ok(log.includes('"worker_session_deleted"'), "cleanup should run once the run actually finished");
  } finally {
    cleanup();
  }
});

test("worker: never deletes the session if the run never stops timing out", async () => {
  let waitCalls = 0;
  let deleted = false;
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: workerPluginConfig,
    subagent: {
      run: async () => ({ runId: "run-2" }),
      waitForRun: async () => { waitCalls++; return { status: "timeout" }; },
      deleteSession: async () => { deleted = true; },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmTask(handlers, "sess-2", "222222", "Do another thing");

    const logPath = join(rootDir, "nancy.log");
    await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes('"worker_wait_exhausted"'));

    assert.equal(waitCalls, 3, "should give up only after WORKER_MAX_WAIT_ATTEMPTS");
    assert.equal(deleted, false, "must not delete a session that may still be running");
  } finally {
    cleanup();
  }
});
