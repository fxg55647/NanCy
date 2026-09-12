// Regression test for the fix described in CLAUDE.md-adjacent review notes:
// a pending confirmation is recorded (message_sending) before delivery is
// known to have succeeded. If delivery then fails, that pending confirmation
// must be invalidated — otherwise an unrelated later "y" reply in the same
// session could confirm a request the user never actually saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";

test("confirmation: a failed delivery invalidates the pending confirmation", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);

    const content = confirmationContent("333333", "Delete the archive");
    await handlers.message_sending({ content }, { sessionKey: "sess-fail", channelId: "test" });
    handlers.message_sent({ success: false, content, error: "network error", to: "user" }, { sessionKey: "sess-fail" });

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_delivery_failed"'), "delivery failure must be logged");
    assert.ok(log.includes('"id":"333333"'), "the log must identify which confirmation failed");

    handlers.message_received({ content: "y" }, { sessionKey: "sess-fail" });

    const currentTaskPath = join(rootDir, "workspace", "main", "tasks", "current.json");
    assert.equal(existsSync(currentTaskPath), false, "a stray 'y' must not confirm a request the user never received");
    const logAfter = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(!logAfter.includes('"confirmation_granted"'), "no confirmation should have been granted");
  } finally {
    cleanup();
  }
});

test("confirmation: a successful delivery can still be confirmed normally", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);

    const content = confirmationContent("444444", "Send the report");
    await handlers.message_sending({ content }, { sessionKey: "sess-ok", channelId: "test" });
    handlers.message_sent({ success: true, content, messageId: "m-1", to: "user" }, { sessionKey: "sess-ok" });
    handlers.message_received({ content: "y" }, { sessionKey: "sess-ok" });

    const currentTaskPath = join(rootDir, "workspace", "main", "tasks", "current.json");
    assert.equal(existsSync(currentTaskPath), true, "a genuinely delivered confirmation must still work");
  } finally {
    cleanup();
  }
});
