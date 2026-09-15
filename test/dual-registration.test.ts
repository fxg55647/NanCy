// Regression test for the dual-plugin-instance finding documented in
// docs/architecture/behavior-comparator.md's "Known limitations": OpenClaw
// can invoke a plugin's register(api) more than once for the same loaded
// module (confirmed directly via real-gateway instrumentation — a task
// granted by message_received in one registration was invisible to
// before_tool_call in another). src/index.ts now keys its shared state
// (taskAuth, session state, pending confirmations, notifier, integrity
// anchoring) by api.rootDir instead of creating it fresh inside register()
// each time, so two register() calls sharing the same rootDir share state,
// while two calls with different rootDirs (e.g. two separate tests) do not.
//
// This simulates "two registries, one plugin install" the only way it's
// observable from outside src/index.ts: two separate FakeApi/handlers pairs
// (so neither's api.on(...) registrations overwrite the other's, unlike
// calling register() twice on one shared FakeApi) pointed at the SAME
// rootDir, each via its own register(api) call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nancyPlugin, { __clearSharedStateForTests } from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function mockFetch(impl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>): () => void {
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => impl();
  return () => { globalThis.fetch = orig; };
}

function allowResponse(reason: string) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: `VERDICT: ALLOW\nREASON: ${reason}` } }] }),
  });
}

test("a task granted through one register() call is visible to before_tool_call in a SEPARATE register() call sharing the same rootDir", async () => {
  const restore = mockFetch(allowResponse("matches the confirmed task"));
  const sharedRootDir = mkdtempSync(join(tmpdir(), "nancy-test-dual-"));
  try {
    const { api: apiA, handlers: handlersA } = createFakeApi({ rootDir: sharedRootDir, pluginConfig: { analysis: analysisCfg } });
    const { api: apiB, handlers: handlersB } = createFakeApi({ rootDir: sharedRootDir, pluginConfig: { analysis: analysisCfg } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(apiA as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(apiB as any);

    const sessionKey = "sess-dual-shared";
    const content = confirmationContent("818181", "Send the report");
    await handlersA.message_sending({ content, to: "user" }, { sessionKey, channelId: "test" });
    handlersA.message_received({ content: "y" }, { sessionKey });

    // The confirmation was granted through registration A's handlers. If A
    // and B share state (the fix), B's before_tool_call sees the task and
    // reaches real analysis instead of the deterministic no-task hard block.
    const result = await handlersB.before_tool_call({ toolName: "exec", params: { command: "echo hi" } }, { sessionKey });
    assert.ok(
      !(result?.block === true && typeof result.blockReason === "string" && result.blockReason.includes("no active confirmed task")),
      `expected before_tool_call in the second registration to see the task granted via the first, but got a no-confirmed-task hard block: ${JSON.stringify(result)}`,
    );
  } finally {
    restore();
    __clearSharedStateForTests(sharedRootDir);
    rmSync(sharedRootDir, { recursive: true, force: true });
  }
});

test("two register() calls with DIFFERENT rootDirs stay isolated (no cross-test leakage)", async () => {
  const restore = mockFetch(allowResponse("matches the confirmed task"));
  const { api: apiA, handlers: handlersA, cleanup: cleanupA } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  const { api: apiC, handlers: handlersC, cleanup: cleanupC } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(apiA as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(apiC as any);

    const sessionKey = "sess-dual-isolated";
    const content = confirmationContent("828282", "Send the report");
    await handlersA.message_sending({ content, to: "user" }, { sessionKey, channelId: "test" });
    handlersA.message_received({ content: "y" }, { sessionKey });

    // Different rootDir (different simulated plugin install / different
    // test fixture) must NOT see A's granted task.
    const result = await handlersC.before_tool_call({ toolName: "exec", params: { command: "echo hi" } }, { sessionKey });
    assert.equal(result?.block, true, "a genuinely different rootDir must not share the other one's granted task");
    assert.match(result.blockReason, /no active confirmed task/);
  } finally {
    restore();
    cleanupA();
    cleanupC();
  }
});
