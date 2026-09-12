// Regression tests for testMode's outbound-message dry-run behavior.
// testMode used to only gate before_tool_call — message_sending had no
// awareness of it at all, so an outbound send that the analysis verdict
// would ALLOW (or that hit the "analysis not configured"/"analysis failed"
// fail-open paths) went out for real even with testMode enabled, breaking
// the "no real side effects" promise. The one deliberate exception is
// NanCy's own fixed-format confirmation-request prompt, which is still sent
// for real in test mode too (see the testMode doc comment on NancyConfig).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function mockFetchOnce(impl: () => Promise<unknown> | never): () => void {
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => impl();
  return () => { globalThis.fetch = orig; };
}

function allowResponse(): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
  return Promise.resolve({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "VERDICT: ALLOW\nREASON: matches the confirmed task" } }] }),
  });
}

test("testMode: an ALLOW verdict still cancels the send instead of delivering it", async () => {
  const restore = mockFetchOnce(allowResponse as () => Promise<unknown>);
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { testMode: true, analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Here is the report", to: "user" }, { sessionKey: "sess-allow", channelId: "test" });
    assert.equal(result?.cancel, true, "an ALLOW verdict must still be a dry-run cancel in test mode");
    assert.match(result.cancelReason, /TEST MODE/);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"test_mode_would_send_message"'), "the would-have-sent decision must be logged");
  } finally {
    restore();
    cleanup();
  }
});

test("testMode: an analysis error blocks the send instead of failing open", async () => {
  const restore = mockFetchOnce(async () => { throw new Error("network down"); });
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { testMode: true, analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Here is the report", to: "user" }, { sessionKey: "sess-error", channelId: "test" });
    assert.equal(result?.cancel, true, "an analysis error must not fail open in test mode");
    assert.match(result.cancelReason, /TEST MODE/);
  } finally {
    restore();
    cleanup();
  }
});

test("testMode: missing analysis config blocks the send instead of failing open", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { testMode: true } }); // no analysis configured
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Here is the report", to: "user" }, { sessionKey: "sess-noanalysis", channelId: "test" });
    assert.equal(result?.cancel, true, "missing analysis config must not fail open in test mode");
    assert.match(result.cancelReason, /TEST MODE/);
  } finally {
    cleanup();
  }
});

test("testMode: NanCy's own confirmation-request prompt is still sent for real", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { testMode: true, analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const content = confirmationContent("777777", "Do the thing");
    const result = await handlers.message_sending({ content, to: "user" }, { sessionKey: "sess-confirm", channelId: "test" });
    assert.equal(result, undefined, "the fixed confirmation-request format must not be canceled even in test mode");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"test_mode_confirmation_sent_for_real"'), "the exemption should be audit-logged");
  } finally {
    cleanup();
  }
});

test("without testMode, an analysis error still fails open (unchanged production behavior)", async () => {
  const restore = mockFetchOnce(async () => { throw new Error("network down"); });
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "Here is the report", to: "user" }, { sessionKey: "sess-prod", channelId: "test" });
    assert.equal(result, undefined, "outside test mode, message_sending still has no approval path, so it must fail open");
  } finally {
    restore();
    cleanup();
  }
});
