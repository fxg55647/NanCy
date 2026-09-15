// Regression tests for allowUnconfirmedChatReplies (see config.ts /
// buildUnconfirmedChatReplyTask in confirmation/tasks.ts). An ordinary
// outbound chat reply (message_sending's general review, not a tool call)
// may now go through the normal semantic reviewer, judged against a fixed
// generic "harmless small talk only" baseline, even when no task has been
// confirmed for the session — on by default. Before this, NanCy's design
// meant literally no outbound reply of any kind (except NanCy's own fixed
// confirmation-request template) could ever be sent without a confirmed
// task — found via tools/mobile-chat-poc/'s real end-to-end A2A test. A
// deterministic per-session hourly cap (state.ts's consumeChatReplyQuota)
// must still withhold the fallback once exhausted, independent of what the
// reviewer itself would decide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function mockFetch(impl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>): { restore: () => void; callCount: () => number; lastPrompt: () => string } {
  const orig = globalThis.fetch;
  let calls = 0;
  let lastBody = "";
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async (_url: string, opts: { body?: string }) => {
    calls++;
    lastBody = opts?.body ?? "";
    return impl();
  };
  return { restore: () => { globalThis.fetch = orig; }, callCount: () => calls, lastPrompt: () => lastBody };
}

function verdictResponse(verdict: "ALLOW" | "BLOCK" | "CLARIFY", reason: string) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: `VERDICT: ${verdict}\nREASON: ${reason}` } }] }),
  });
}

test("an outbound chat reply with no confirmed task goes through the fallback baseline instead of always clarifying (default on)", async () => {
  const { restore } = mockFetch(verdictResponse("ALLOW", "plain harmless greeting"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Hi there, how can I help?", to: "user" }, { sessionKey: "sess-1", channelId: "test" });
    assert.equal(result, undefined, "a genuine ALLOW (outside testMode) must fall through, not block");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"unconfirmed_chat_reply_fallback"'), "the fallback grant must be logged");
  } finally {
    restore();
    cleanup();
  }
});

test("the fallback baseline text reaches the reviewer prompt; disabling the feature keeps the old empty-task context", async () => {
  const onCfg = mockFetch(verdictResponse("ALLOW", "plain harmless greeting"));
  const { api: onApi, handlers: onHandlers, cleanup: onCleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(onApi as any);
    await onHandlers.message_sending({ content: "Hi there!", to: "user" }, { sessionKey: "sess-2", channelId: "test" });
    assert.match(onCfg.lastPrompt(), /harmless conversational small talk/, "the fallback description must be in the prompt sent to the reviewer");
  } finally {
    onCfg.restore();
    onCleanup();
  }

  const offCfg = mockFetch(verdictResponse("CLARIFY", "no task context"));
  const { api: offApi, handlers: offHandlers, cleanup: offCleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, allowUnconfirmedChatReplies: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(offApi as any);
    await offHandlers.message_sending({ content: "Hi there!", to: "user" }, { sessionKey: "sess-3", channelId: "test" });
    assert.ok(!offCfg.lastPrompt().includes("harmless conversational small talk"), "disabling the feature must not include the fallback baseline in the prompt");
  } finally {
    offCfg.restore();
    offCleanup();
  }
});

test("allowUnconfirmedChatReplies: false restores the old strict behavior (no fallback grant logged)", async () => {
  const { restore } = mockFetch(verdictResponse("CLARIFY", "cannot verify authorization"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, allowUnconfirmedChatReplies: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Hi there!", to: "user" }, { sessionKey: "sess-4", channelId: "test" });
    assert.equal(result?.cancel, true, "with no task and the fallback off, an uncertain verdict still cancels the send");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(!log.includes('"unconfirmed_chat_reply_fallback"'), "the fallback grant must never be logged when the feature is off");
  } finally {
    restore();
    cleanup();
  }
});

test("a real confirmed task is unaffected: the fallback is never applied when one already exists", async () => {
  const { restore, lastPrompt } = mockFetch(verdictResponse("ALLOW", "matches the confirmed task"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const sessionKey = "sess-5";
    const confirmation = confirmationContent("424242", "Reply to the user with a status update");
    await handlers.message_sending({ content: confirmation, to: "user" }, { sessionKey, channelId: "test" });
    await handlers.message_received({ content: "y" }, { sessionKey, channelId: "test" });

    const result = await handlers.message_sending({ content: "Here is your status update.", to: "user" }, { sessionKey, channelId: "test" });
    assert.equal(result, undefined, "a genuine ALLOW against the real confirmed task must fall through");
    assert.ok(!lastPrompt().includes("harmless conversational small talk"), "a real confirmed task must never be replaced by the synthetic fallback");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(!log.includes('"unconfirmed_chat_reply_fallback"'), "the fallback must not fire once a real task is confirmed");
  } finally {
    restore();
    cleanup();
  }
});

test("unconfirmedChatReplyLimitPerHour: 0 withholds the fallback even for the very first reply of a session", async () => {
  const { restore } = mockFetch(verdictResponse("CLARIFY", "no task context"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { analysis: analysisCfg, unconfirmedChatReplyLimitPerHour: 0 },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await handlers.message_sending({ content: "Hi there!", to: "user" }, { sessionKey: "sess-zero-limit", channelId: "test" });
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"unconfirmed_chat_reply_rate_limit"'), "a limit of 0 must refuse the fallback on the first call in a brand-new window");
    assert.ok(!log.includes('"unconfirmed_chat_reply_fallback"'));
  } finally {
    restore();
    cleanup();
  }
});

test("the per-session hourly cap withholds the fallback once exhausted, independent of the reviewer's own verdict", async () => {
  const { restore } = mockFetch(verdictResponse("ALLOW", "plain harmless greeting"));
  const { api, handlers, rootDir, cleanup } = createFakeApi({
    pluginConfig: { analysis: analysisCfg, unconfirmedChatReplyLimitPerHour: 2 },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const send = (n: number) => handlers.message_sending({ content: `Hi there, message ${n}!`, to: "user" }, { sessionKey: "sess-6", channelId: "test" });

    await send(1);
    await send(2);
    await send(3);

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    const fallbackGrants = log.split("\n").filter((l) => l.includes('"unconfirmed_chat_reply_fallback"')).length;
    assert.equal(fallbackGrants, 2, "only the first two calls within the cap should get the fallback grant");
    assert.ok(log.includes('"unconfirmed_chat_reply_rate_limit"'), "the third call must be logged as rate-limited");
  } finally {
    restore();
    cleanup();
  }
});
