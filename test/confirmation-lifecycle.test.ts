// Integration tests for how NanCy interprets and writes the task-confirmation
// proposal end to end (message_sending -> message_received -> the audit
// record NanCy itself writes under tasks/). Complements
// confirmation-protocol.test.ts (pure parser unit tests) and
// confirmation-send-failure.test.ts (delivery-failure invalidation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";

function auditRecordPath(rootDir: string, id: string): string {
  return join(rootDir, "workspace", "main", "tasks", `${id}.json`);
}

test("confirmation: denied reply grants nothing and is logged with the actual reply text", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const content = confirmationContent("100001", "Delete the archive");
    await handlers.message_sending({ content }, { sessionKey: "sess-deny", channelId: "test" });
    handlers.message_received({ content: "no thanks" }, { sessionKey: "sess-deny" });

    assert.equal(existsSync(auditRecordPath(rootDir, "100001")), false, "a denied confirmation must never be written");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_denied"'));
    assert.ok(log.includes('"reply":"no thanks"'), "the actual reply text should be captured for audit, not just 'denied'");
    assert.ok(!log.includes('"confirmation_granted"'));
  } finally {
    cleanup();
  }
});

test("confirmation: an expired reply (past the TTL) is not granted even though it says 'y'", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  const realNow = Date.now;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const content = confirmationContent("100002", "Send the report");
    await handlers.message_sending({ content }, { sessionKey: "sess-expire", channelId: "test" });

    // createPendingConfirmations() hardcodes a 15-minute TTL — jump the
    // clock forward instead of actually sleeping in a test.
    Date.now = () => realNow() + 16 * 60 * 1000;
    handlers.message_received({ content: "y" }, { sessionKey: "sess-expire" });

    assert.equal(existsSync(auditRecordPath(rootDir, "100002")), false, "an expired confirmation must not be granted just because the reply is affirmative");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_expired"'));
    assert.ok(!log.includes('"confirmation_granted"'));
  } finally {
    Date.now = realNow;
    cleanup();
  }
});

test("confirmation: a second request before the first is answered supersedes it — only the newest can be confirmed", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await handlers.message_sending({ content: confirmationContent("100003", "Plan A") }, { sessionKey: "sess-supersede", channelId: "test" });
    await handlers.message_sending({ content: confirmationContent("100004", "Plan B") }, { sessionKey: "sess-supersede", channelId: "test" });
    handlers.message_received({ content: "y" }, { sessionKey: "sess-supersede" });

    assert.equal(existsSync(auditRecordPath(rootDir, "100003")), false, "the superseded request must never be grantable");
    assert.equal(existsSync(auditRecordPath(rootDir, "100004")), true, "the newest request is the one a 'y' actually answers");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_superseded"'));
    assert.ok(log.includes('"previousId":"100003"') && log.includes('"newId":"100004"'));
  } finally {
    cleanup();
  }
});

test("confirmation: a reply threaded to a different message does not consume the pending confirmation", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const content = confirmationContent("100005", "Send the invoice");
    await handlers.message_sending({ content }, { sessionKey: "sess-thread", channelId: "test" });
    handlers.message_sent({ success: true, content, messageId: "msg-real", to: "user" }, { sessionKey: "sess-thread" });

    // A reply explicitly threaded to some other message is not an answer to
    // this confirmation, even though its text is a bare "y".
    handlers.message_received({ content: "y", replyToId: "msg-unrelated" }, { sessionKey: "sess-thread" });
    assert.equal(existsSync(auditRecordPath(rootDir, "100005")), false, "a reply to a different message must not confirm this request");

    // The correctly-threaded reply still works afterward.
    handlers.message_received({ content: "y", replyToId: "msg-real" }, { sessionKey: "sess-thread" });
    assert.equal(existsSync(auditRecordPath(rootDir, "100005")), true);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_granted"'));
  } finally {
    cleanup();
  }
});

test("confirmation: a malformed near-miss of the fixed template is rejected outright, not silently sent unrecorded", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    // A 4-digit id — one common way a model gets the template subtly wrong.
    const malformed = "Formal confirmation: Delete the archive.\nReply y to proceed, any other reply cancels.\n1234";
    const result = await handlers.message_sending({ content: malformed }, { sessionKey: "sess-malformed", channelId: "test" });

    assert.equal(result?.cancel, true, "a near-miss must be rejected, not fall through as an ordinary message that might still be sent");
    assert.match(result.cancelReason, /could not parse/i);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"malformed_confirmation_attempt"'));

    // Nothing was ever recorded as pending, so a later "y" in the same
    // session has nothing to answer — it must not confirm anything.
    handlers.message_received({ content: "y" }, { sessionKey: "sess-malformed" });
    const logAfter = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(!logAfter.includes('"confirmation_granted"'));
  } finally {
    cleanup();
  }
});

test("confirmation: an empty description is rejected outright, not accepted as an authorization anchor", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const content = confirmationContent("100006", "");
    const result = await handlers.message_sending({ content }, { sessionKey: "sess-empty-desc", channelId: "test" });

    assert.equal(result?.cancel, true);
    assert.match(result.cancelReason, /description is empty/i);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_description_empty"'));

    handlers.message_received({ content: "y" }, { sessionKey: "sess-empty-desc" });
    assert.equal(existsSync(auditRecordPath(rootDir, "100006")), false);
  } finally {
    cleanup();
  }
});

// Documents a known, intentional limitation rather than a fix: README
// feature #2 marks gap-detection as not implemented (🧭) — NanCy checks
// *who* confirmed (feature #2's implemented half) but never checks whether
// the proposed description itself is vague, ambiguous, or contains
// unfilled placeholders. This test exists so a future change to that
// status is caught here (the assertion would start failing) rather than
// silently drifting out of sync with what the docs claim.
test("confirmation: a vague description full of unfilled placeholders is still granted as-is (documented gap, not a bug)", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const vague = "Buy tickets to <DESTINATION> for <NUMBER> people using [PAYMENT METHOD], then let them know somehow.";
    const content = confirmationContent("100007", vague);
    const result = await handlers.message_sending({ content }, { sessionKey: "sess-vague", channelId: "test" });
    assert.equal(result, undefined, "no analysis is configured to judge this, and none would be consulted about vagueness even if it were");

    handlers.message_received({ content: "y" }, { sessionKey: "sess-vague" });
    assert.equal(existsSync(auditRecordPath(rootDir, "100007")), true, "NanCy currently grants this exactly as written — see README feature #2's gap-detection status");
    const record = JSON.parse(readFileSync(auditRecordPath(rootDir, "100007"), "utf8"));
    assert.equal(record.description, vague);
  } finally {
    cleanup();
  }
});
