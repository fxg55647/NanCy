// Regression tests for the main/cron hard gate's default-deny redesign.
// It used to be a blocklist (MAIN_ALWAYS_BLOCK/MAIN_BROWSER_BLOCK_CMDS): any
// tool not named in it fell through completely unchecked. apply_patch is the
// concrete example that motivated the fix (a real openclaw@2026.9.4 tool that
// was in neither the blocklist nor the analysis allowlist, so it executed
// with zero check at all), but the fix itself is structural — only an
// enumerated allowlist of genuinely passive tools/sub-actions may run in the
// main/cron gate, everything else (apply_patch, message, computer/browser
// interaction, and any tool NanCy has never heard of) is blocked by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import nancyPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setup(pluginConfig: Record<string, unknown> = {}): { handlers: Record<string, any>; cleanup: () => void } {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nancyPlugin.register(api as any);
  return { handlers, cleanup };
}

test("main session: apply_patch is blocked by default (default-deny)", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" });
  try {
    const result = await handlers.before_tool_call({ toolName: "apply_patch", params: { patch: "*** Begin Patch" } }, { sessionKey: "main-1" });
    assert.equal(result?.block, true, "apply_patch must never be allowed to fall through unchecked in the main session");
    assert.match(result.blockReason, /allow-list/);
  } finally { cleanup(); }
});

test("main session: the generic message tool is blocked by default", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" });
  try {
    const result = await handlers.before_tool_call({ toolName: "message", params: { to: "someone", text: "hi" } }, { sessionKey: "main-1" });
    assert.equal(result?.block, true, "the main session must not be able to send arbitrary outbound messages via a tool call");
  } finally { cleanup(); }
});

test("main session: computer interaction is blocked, but screenshot/wait are allowed", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" });
  try {
    const click = await handlers.before_tool_call({ toolName: "computer", params: { action: "left_click", x: 1, y: 1 } }, { sessionKey: "main-1" });
    assert.equal(click?.block, true, "computer clicks/keystrokes must be blocked in the main session");

    const shot = await handlers.before_tool_call({ toolName: "computer", params: { action: "screenshot" } }, { sessionKey: "main-1" });
    assert.equal(shot, undefined, "screenshot is a genuinely local, non-mutating action and should pass through");

    const wait = await handlers.before_tool_call({ toolName: "computer", params: { action: "wait" } }, { sessionKey: "main-1" });
    assert.equal(wait, undefined, "wait is the other action openclaw itself classifies as local/non-mutating");
  } finally { cleanup(); }
});

test("main session: browser navigation/interaction is blocked, snapshot/screenshot are allowed", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" });
  try {
    const nav = await handlers.before_tool_call({ toolName: "browser", params: { action: "navigate", url: "https://example.com" } }, { sessionKey: "main-1" });
    assert.equal(nav?.block, true, "navigate must be blocked — this also regression-tests the action/kind field fix (not the nonexistent `command` field)");

    const click = await handlers.before_tool_call({ toolName: "browser", params: { action: "act", kind: "click", ref: "e1" } }, { sessionKey: "main-1" });
    assert.equal(click?.block, true, "an interactive act:click must be blocked, not silently allowed");

    const snap = await handlers.before_tool_call({ toolName: "browser", params: { action: "snapshot" } }, { sessionKey: "main-1" });
    assert.equal(snap, undefined, "a passive snapshot should pass through without analysis");
  } finally { cleanup(); }
});

test("main session: a passive read tool is allowed with no analysis required", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" });
  try {
    const result = await handlers.before_tool_call({ toolName: "read", params: { path: "foo.txt" } }, { sessionKey: "main-1" });
    assert.equal(result, undefined, "a pure local read must not be blocked");
  } finally { cleanup(); }
});

test("cron-triggered run: gets the identical default-deny gate as the main session", async () => {
  const { handlers, cleanup } = setup({}); // gating here is by trigger, not by mainSessionKey
  try {
    handlers.llm_input({ provider: "x", model: "y" }, { sessionKey: "cron-1", trigger: "cron" });

    const patch = await handlers.before_tool_call({ toolName: "apply_patch", params: {} }, { sessionKey: "cron-1" });
    assert.equal(patch?.block, true);
    assert.match(patch.blockReason, /cron-triggered run/);

    const msg = await handlers.before_tool_call({ toolName: "message", params: {} }, { sessionKey: "cron-1" });
    assert.equal(msg?.block, true);

    const computerClick = await handlers.before_tool_call({ toolName: "computer", params: { action: "double_click" } }, { sessionKey: "cron-1" });
    assert.equal(computerClick?.block, true);

    const read = await handlers.before_tool_call({ toolName: "read", params: {} }, { sessionKey: "cron-1" });
    assert.equal(read, undefined);
  } finally { cleanup(); }
});

test("cron-triggered run: outbound messages are blocked too, not just tool calls", async () => {
  const { handlers, cleanup } = setup({});
  try {
    handlers.llm_input({ provider: "x", model: "y" }, { sessionKey: "cron-1", trigger: "cron" });
    const result = await handlers.message_sending(
      { content: "Here is the report you asked for.", to: "user" },
      { sessionKey: "cron-1", channelId: "test" },
    );
    assert.equal(result?.cancel, true, "a cron-triggered run must not have a message-only escape hatch from the tool-call gate");
    assert.match(result.cancelReason, /cron-triggered run/i);
  } finally { cleanup(); }
});

test("a worker (non-main, non-cron) session is not subject to the main/cron allow-list", async () => {
  const { handlers, cleanup } = setup({ mainSessionKey: "main-1" }); // "agent:worker:task-1" is neither main nor cron
  try {
    const result = await handlers.before_tool_call({ toolName: "apply_patch", params: {} }, { sessionKey: "agent:worker:task-1" });
    // Still blocked overall in this test (no analysis configured), but for a
    // different reason than the main/cron allow-list — proving the two gates
    // are independent and worker sessions go through full analysis instead.
    assert.equal(result?.block, true);
    assert.doesNotMatch(result.blockReason, /allow-list/);
  } finally { cleanup(); }
});
