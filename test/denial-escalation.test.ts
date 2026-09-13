import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createMacroReviewer } from "../src/analysis/macro-review.ts";
import { createSessionState } from "../src/state.ts";
import { createFakeApi, waitFor } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

test("hard denial ceiling terminates one session and closes both outbound paths", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { mainSessionKey: "main", limits: { hardTerminateThreshold: 2 } },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);

    for (let i = 0; i < 2; i++) {
      const denied = await handlers.before_tool_call(
        { toolName: "write", params: { path: `ordinary-${i}.txt`, content: "x" } },
        { sessionKey: "main" },
      );
      assert.equal(denied?.block, true);
      assert.match(denied.blockReason, /main session/i);
    }

    const laterTool = await handlers.before_tool_call(
      { toolName: "read", params: { path: "ordinary.txt" } },
      { sessionKey: "main" },
    );
    assert.equal(laterTool?.block, true);
    assert.match(laterTool.blockReason, /terminated/i);

    const laterMessage = await handlers.message_sending(
      { content: "This must not leave", to: "user" },
      { sessionKey: "main", channelId: "test" },
    );
    assert.equal(laterMessage?.cancel, true);
    assert.match(laterMessage.cancelReason, /terminated/i);

    // A different session must not inherit main's counters or stop state.
    const other = await handlers.before_tool_call(
      { toolName: "read", params: { path: "ordinary.txt" } },
      { sessionKey: "other" },
    );
    assert.equal(other, undefined);

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.equal((log.match(/"event":"hard_terminated"/g) ?? []).length, 1);
    assert.match(log, /"event":"session_blocked_after_stop"/);
  } finally {
    cleanup();
  }
});

test("testMode denials never reach the hard ceiling", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { testMode: true, mainSessionKey: "main", limits: { hardTerminateThreshold: 1 } },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await handlers.before_tool_call(
      { toolName: "write", params: { path: "ordinary.txt", content: "x" } },
      { sessionKey: "main" },
    );
    const message = await handlers.message_sending(
      { content: "dry run", to: "user" },
      { sessionKey: "main", channelId: "test" },
    );
    assert.equal(message?.cancel, true);
    assert.match(message.cancelReason, /TEST MODE/);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.doesNotMatch(log, /"event":"hard_terminated"/);
  } finally {
    cleanup();
  }
});

test("a burst review never resets the total denial ceiling", async () => {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error minimal response stub
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"verdict":"ok","reason":"no sustained pattern"}' } }] }),
  });
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: {
      analysis: analysisCfg,
      mainSessionKey: "main",
      limits: { hardTerminateThreshold: 4 },
      macroReview: { blockBurstThreshold: 3 },
    },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    for (let i = 0; i < 3; i++) {
      await handlers.before_tool_call(
        { toolName: "write", params: { path: `ordinary-${i}.txt`, content: "x" } },
        { sessionKey: "main" },
      );
    }
    await waitFor(() => {
      try { return readFileSync(join(rootDir, "nancy-analysis.log"), "utf8").includes('"event":"macro_review_completed"'); }
      catch { return false; }
    });

    await handlers.before_tool_call(
      { toolName: "write", params: { path: "ordinary-final.txt", content: "x" } },
      { sessionKey: "main" },
    );
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.match(log, /"event":"macro_review_requested_by_denial_burst"/);
    assert.match(log, /"event":"hard_terminated"/);
    assert.match(log, /"count":4/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("concurrent macro-review requests coalesce into one follow-up review", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let fetchCount = 0;
  // @ts-expect-error minimal response stub
  globalThis.fetch = async () => {
    fetchCount++;
    if (fetchCount === 1) await firstGate;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"ok","reason":"clear"}' } }] }) };
  };

  const { api, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  const state = createSessionState();
  const reviewer = createMacroReviewer({
    nancyConfig: api.pluginConfig as never,
    analysisLog: join(rootDir, "nancy-analysis.log"),
    logFile: join(rootDir, "nancy.log"),
    state,
    notifier: {
      alertsEnabled: false,
      taskReportsEnabled: false,
      sendAlert: () => { },
      notifyBlocked: () => { },
      notifyHardTermination: () => { },
      clearSessionBlockAlerts: () => { },
    },
    getPolicyContext: () => "",
  });

  try {
    const first = reviewer.runMacroReview("worker-1");
    await waitFor(() => fetchCount === 1);
    await reviewer.runMacroReview("worker-1");
    await reviewer.runMacroReview("worker-1");
    releaseFirst();
    await first;

    assert.equal(fetchCount, 2, "many concurrent requests should become one follow-up review");
    const log = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.equal((log.match(/"event":"macro_review_started"/g) ?? []).length, 2);
    assert.equal((log.match(/"event":"macro_review_coalesced"/g) ?? []).length, 2);
    assert.equal((log.match(/"event":"macro_review_completed"/g) ?? []).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("a macro-review terminate verdict still sets the session stop flag", async () => {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error minimal response stub
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"verdict":"terminate","reason":"sustained bypass attempts"}' } }] }),
  });
  const { api, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  const state = createSessionState();
  const reviewer = createMacroReviewer({
    nancyConfig: api.pluginConfig as never,
    analysisLog: join(rootDir, "nancy-analysis.log"),
    logFile: join(rootDir, "nancy.log"),
    state,
    notifier: {
      alertsEnabled: false,
      taskReportsEnabled: false,
      sendAlert: () => { },
      notifyBlocked: () => { },
      notifyHardTermination: () => { },
      clearSessionBlockAlerts: () => { },
    },
    getPolicyContext: () => "",
  });
  try {
    await reviewer.runMacroReview("worker-terminate");
    assert.equal(state.terminatedSessions.get("worker-terminate"), true);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.match(log, /"event":"session_terminated"/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});
