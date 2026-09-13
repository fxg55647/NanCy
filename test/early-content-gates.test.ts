import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";
import { toolHistoryMetadata } from "../src/analysis/preflight.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

test("rolling reviewer history omits prior payload bodies", () => {
  const writeHistory = JSON.stringify(toolHistoryMetadata("write", { path: "report.txt", content: "HOSTILE-WRITE-BODY" }));
  const messageHistory = JSON.stringify(toolHistoryMetadata("message", { to: "alice@example.com", text: "HOSTILE-MESSAGE-BODY" }));
  assert.match(writeHistory, /report\.txt/);
  assert.doesNotMatch(writeHistory, /HOSTILE-WRITE-BODY/);
  assert.match(messageHistory, /alice@example\.com/);
  assert.doesNotMatch(messageHistory, /HOSTILE-MESSAGE-BODY/);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function confirmDirectTask(handlers: Record<string, any>, sessionKey: string, description: string): Promise<void> {
  const content = confirmationContent("12345678", description);
  await handlers.message_sending({ content, to: "user" }, { sessionKey, channelId: "test" });
  handlers.message_received({ content: "y" }, { sessionKey });
}

test("unconfirmed consequential calls are blocked before reviewer or browser content access", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call(
      { toolName: "browser", params: { action: "act", kind: "fill", ref: "e1", text: "HOSTILE-PAGE-PAYLOAD" } },
      { sessionKey: "unconfirmed" },
    );
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /no active confirmed task/i);
    assert.equal(fetchCalls, 0, "neither browser snapshot nor reviewer may be fetched");
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("unknown extension tools default to review instead of bypassing NanCy", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call(
      { toolName: "new_cloud_publish_tool", params: { content: "publish this" } },
      { sessionKey: "unconfirmed" },
    );
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /no active confirmed task/i);
  } finally { cleanup(); }
});

test("main-session hard gate runs before domain reputation network access", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { mainSessionKey: "main", analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call(
      { toolName: "browser", params: { action: "navigate", url: "https://wrong.example/path" } },
      { sessionKey: "main" },
    );
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /main session/i);
    assert.equal(fetchCalls, 0, "a session-type rejection must precede URLhaus/RDAP access");
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("cron outbound messages are blocked before reviewer content exposure", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    handlers.llm_input({ provider: "x", model: "y" }, { sessionKey: "cron", trigger: "cron" });
    const result = await handlers.message_sending(
      { content: "HOSTILE-CRON-CONTENT", to: "outside@example.net" },
      { sessionKey: "cron", channelId: "email" },
    );
    assert.equal(result?.cancel, true);
    assert.match(result.cancelReason, /cron-triggered/i);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("an unauthorized worker message is blocked before reviewer content exposure", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
  const { api, handlers, cleanup } = createFakeApi({
    pluginConfig: { workerAgentId: "worker", analysis: analysisCfg },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending(
      { content: "HOSTILE-EXPIRED-WORKER-CONTENT", to: "outside@example.net" },
      { sessionKey: "agent:worker:task-expired", channelId: "email" },
    );
    assert.equal(result?.cancel, true);
    assert.match(result.cancelReason, /no active confirmed task/i);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("wrong write destination is rejected before payload reaches the reviewer", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];
  // @ts-expect-error deliberate minimal response stub
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(String(init?.body ?? ""));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "VERDICT: BLOCK\nREASON: destination is outside the task" } }] }) };
  };
  // gapDetection: false — this test counts fetch calls to prove the
  // destination preflight skips the full review; gap detection during the
  // confirmDirectTask setup step would otherwise add an unrelated call.
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmDirectTask(handlers, "direct", "Write only reports/final.txt");
    const result = await handlers.before_tool_call(
      { toolName: "write", params: { path: join(rootDir, "elsewhere.txt"), content: "SECRET-INJECTED-PAYLOAD" } },
      { sessionKey: "direct" },
    );
    assert.equal(result?.block, true);
    assert.equal(requestBodies.length, 1, "a metadata BLOCK must skip the full review");
    assert.doesNotMatch(requestBodies[0], /SECRET-INJECTED-PAYLOAD/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("wrong outbound recipient is rejected before message content reaches the reviewer", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];
  // @ts-expect-error deliberate minimal response stub
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(String(init?.body ?? ""));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "VERDICT: BLOCK\nREASON: recipient is outside the task" } }] }) };
  };
  // gapDetection: false — see the write-destination test above for why.
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await confirmDirectTask(handlers, "direct", "Email the report only to alice@example.com");
    const result = await handlers.message_sending(
      { content: "SECRET-COPIED-EMAIL-CONTENT", to: "mallory@example.net" },
      { sessionKey: "direct", channelId: "email" },
    );
    assert.equal(result?.cancel, true);
    assert.equal(requestBodies.length, 1, "a metadata BLOCK must skip the full message review");
    assert.doesNotMatch(requestBodies[0], /SECRET-COPIED-EMAIL-CONTENT/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});
