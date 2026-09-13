// Regression tests for allowUnconfirmedInfoLookups (see config.ts /
// buildUnconfirmedInfoLookupTask in confirmation/tasks.ts). web_search and
// web_fetch may now go through the normal semantic reviewer, judged against
// a fixed generic "must be a harmless info lookup" baseline, even when no
// task has been confirmed for the session — on by default. Every other tool
// requiring semantic review must still hard-block outright with no
// confirmed task, exactly as before, and a deterministic per-session hourly
// cap (state.ts's consumeInfoLookupQuota) must still refuse the fallback
// once exhausted, independent of what the reviewer itself would decide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function mockFetch(impl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>): { restore: () => void; callCount: () => number } {
  const orig = globalThis.fetch;
  let calls = 0;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => { calls++; return impl(); };
  return { restore: () => { globalThis.fetch = orig; }, callCount: () => calls };
}

function verdictResponse(verdict: "ALLOW" | "BLOCK", reason: string) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: `VERDICT: ${verdict}\nREASON: ${reason}` } }] }),
  });
}

test("web_search with no confirmed task goes through the fallback baseline instead of hard-blocking (default on)", async () => {
  const { restore } = mockFetch(verdictResponse("ALLOW", "plain informational search"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "saa Kotkassa" } }, { sessionKey: "sess-1" });
    assert.equal(result, undefined, "a genuine ALLOW (outside testMode) must fall through, not block");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"unconfirmed_info_lookup_fallback"'), "the fallback grant must be logged");
  } finally {
    restore();
    cleanup();
  }
});

test("web_fetch with no confirmed task also gets the fallback, not just web_search", async () => {
  const { restore } = mockFetch(verdictResponse("ALLOW", "plain page fetch"));
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_fetch", params: { url: "https://example.com" } }, { sessionKey: "sess-2" });
    assert.equal(result, undefined, "web_fetch must also be eligible for the fallback");
  } finally {
    restore();
    cleanup();
  }
});

test("exec with no confirmed task is still hard-blocked outright — the fallback is not a blanket bypass", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "exec", params: { command: "curl https://example.com" } }, { sessionKey: "sess-3" });
    assert.equal(result?.block, true, "exec must not be eligible for the info-lookup fallback");
    assert.match(result.blockReason, /no active confirmed task/);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"blocked_no_confirmed_task"'), "must use the same hard-block path as before, unaffected by the fallback");
  } finally {
    cleanup();
  }
});

test("allowUnconfirmedInfoLookups: false restores the old strict behavior for web_search too", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, allowUnconfirmedInfoLookups: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "saa Kotkassa" } }, { sessionKey: "sess-4" });
    assert.equal(result?.block, true, "the operator must be able to opt back out of the fallback entirely");
    assert.match(result.blockReason, /no active confirmed task/);
  } finally {
    cleanup();
  }
});

test("web_search from the main chat session reaches the fallback instead of being hard-blocked by the main-session gate", async () => {
  // Regression test: isMainGateAllowed() never listed web_search/web_fetch
  // as allowed for the main session (deliberately — they normally require a
  // confirmed task), so before the fix, the main-session gate hard-blocked
  // them with "Create a confirmed task first" before the fallback logic
  // further down in before_tool_call was ever reached — defeating the whole
  // point of the fallback, whose motivating use case (README feature #10)
  // is exactly a casual "what's the weather" question in the main chat.
  const { restore } = mockFetch(verdictResponse("ALLOW", "plain informational search"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { analysis: analysisCfg, mainSessionKey: "main" },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "weather in Kotka" } }, { sessionKey: "main" });
    assert.equal(result, undefined, "the main session must reach the info-lookup fallback, not the main-gate hard block");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(!log.includes('"blocked_main_session"'), "must not have taken the main-gate hard-block path at all");
    assert.ok(log.includes('"unconfirmed_info_lookup_fallback"'), "must have gone through the fallback grant");
  } finally {
    restore();
    cleanup();
  }
});

test("the main-session gate still hard-blocks every other tool, even with the info-lookup fallback enabled", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, mainSessionKey: "main" } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "apply_patch", params: { patch: "x" } }, { sessionKey: "main" });
    assert.equal(result?.block, true, "apply_patch must remain hard-blocked in the main session");
    assert.match(result.blockReason, /allow-list for the main session/);
  } finally {
    cleanup();
  }
});

test("unconfirmedInfoLookupLimitPerHour: 0 blocks even the very first lookup of a session (regression: used to always allow call #1)", async () => {
  const { restore, callCount } = mockFetch(verdictResponse("ALLOW", "plain informational search"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { analysis: analysisCfg, unconfirmedInfoLookupLimitPerHour: 0 },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "q" } }, { sessionKey: "sess-zero-limit" });
    assert.equal(result?.block, true, "a limit of 0 must refuse even the first call in a brand-new window");
    assert.match(result.blockReason, /hourly limit/);
    assert.equal(callCount(), 0, "the reviewer must never be called when the limit is 0");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"blocked_info_lookup_rate_limit"'));
  } finally {
    restore();
    cleanup();
  }
});

test("the per-session hourly cap refuses the fallback once exhausted, independent of the reviewer's own verdict", async () => {
  const { restore, callCount } = mockFetch(verdictResponse("ALLOW", "plain informational search"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { analysis: analysisCfg, unconfirmedInfoLookupLimitPerHour: 2 },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const call = (n: number) => handlers.before_tool_call({ toolName: "web_search", params: { query: `q${n}` } }, { sessionKey: "sess-5" });

    const first = await call(1);
    const second = await call(2);
    const third = await call(3);

    assert.equal(first, undefined, "call #1 must be within quota and genuinely allowed");
    assert.equal(second, undefined, "call #2 must be within quota and genuinely allowed");
    assert.equal(third?.block, true, "call #3 must be refused by the deterministic cap, not the reviewer");
    assert.match(third.blockReason, /hourly limit/);
    assert.equal(callCount(), 2, "the reviewer must never even be called once the cap is exhausted");

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"blocked_info_lookup_rate_limit"'), "the cap rejection must be logged distinctly from a reviewer block");
  } finally {
    restore();
    cleanup();
  }
});
