// Tests for gap detection (src/confirmation/gap-detection.ts): the advisory
// LLM check that flags concrete decision points a proposed confirmation
// left unspecified — a price ceiling, a delivery deadline, compatibility
// requirements, etc. — as a NanCy-authored note appended after the agent's
// own fixed-template message, before the human decides. See
// confirmation-lifecycle.test.ts for the "no analysis configured" fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";
import { parseGapDetectionResponse, appendGapNote } from "../src/confirmation/gap-detection.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function mockFetchOnce(content: string): () => void {
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  return () => { globalThis.fetch = orig; };
}

function auditRecordPath(rootDir: string, id: string): string {
  return join(rootDir, "workspace", "main", "tasks", `${id}.json`);
}

// --- parseGapDetectionResponse (pure) ---

test("parseGapDetectionResponse extracts a well-formed gaps array", () => {
  assert.deepEqual(parseGapDetectionResponse('{"gaps": ["price ceiling", "delivery deadline"]}'), ["price ceiling", "delivery deadline"]);
});

test("parseGapDetectionResponse handles surrounding prose around the JSON", () => {
  assert.deepEqual(parseGapDetectionResponse('Sure, here is my analysis:\n{"gaps": ["quantity"]}\nHope that helps!'), ["quantity"]);
});

test("parseGapDetectionResponse returns [] for an explicit empty-gaps response", () => {
  assert.deepEqual(parseGapDetectionResponse('{"gaps": []}'), []);
});

test("parseGapDetectionResponse fails safe (empty array) on null, malformed JSON, or the wrong shape", () => {
  assert.deepEqual(parseGapDetectionResponse(null), []);
  assert.deepEqual(parseGapDetectionResponse("not json at all"), []);
  assert.deepEqual(parseGapDetectionResponse('{"gaps": "not an array"}'), []);
  assert.deepEqual(parseGapDetectionResponse('{"something_else": true}'), []);
});

test("parseGapDetectionResponse drops non-string / blank entries and caps the list at 5", () => {
  const raw = JSON.stringify({ gaps: ["a", "", "  ", 42, "b", "c", "d", "e", "f"] });
  const result = parseGapDetectionResponse(raw);
  assert.equal(result.length, 5, "must cap at MAX_GAPS even when the model returns more");
  assert.deepEqual(result, ["a", "b", "c", "d", "e"]);
});

// --- appendGapNote (pure) ---

test("appendGapNote leaves content unchanged when there are no gaps", () => {
  assert.equal(appendGapNote("Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n123456", []), "Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n123456");
});

test("appendGapNote appends a clearly separate, NanCy-attributed note after the original content", () => {
  const original = "Formal confirmation: Buy a laptop.\nReply y to proceed, any other reply cancels.\n123456";
  const noted = appendGapNote(original, ["price ceiling", "delivery deadline"]);
  assert.ok(noted.startsWith(original), "the agent's original message must be preserved verbatim, not rewritten");
  assert.match(noted, /NanCy note/);
  assert.match(noted, /price ceiling/);
  assert.match(noted, /delivery deadline/);
});

// --- End-to-end via message_sending ---

test("a vague description gets a gap note appended, and the noted message is still what gets confirmed", async () => {
  const restore = mockFetchOnce('{"gaps": ["price ceiling", "delivery deadline"]}');
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("200001", "Buy a laptop and have it shipped");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-gap", channelId: "test" });

    assert.notEqual(result, undefined, "a detected gap must actually change what gets sent");
    assert.match(result.content, /price ceiling/);
    assert.match(result.content, /delivery deadline/);
    assert.ok(result.content.startsWith(original), "the agent's own message must still be sent verbatim, with the note only appended after it");

    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_requested"'), "the underlying request is still tracked normally");
    const analysisLogContent = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.ok(analysisLogContent.includes('"confirmation_gap_check"'));
    assert.match(analysisLogContent, /price ceiling/);

    // The noted (not the original) content is what must correlate through
    // message_sent/message_received — confirm the whole lifecycle still works.
    handlers.message_sent({ success: true, content: result.content, messageId: "m-gap", to: "user" }, { sessionKey: "sess-gap" });
    handlers.message_received({ content: "y", replyToId: "m-gap" }, { sessionKey: "sess-gap" });
    assert.equal(existsSync(auditRecordPath(rootDir, "200001")), true, "the task must still be confirmable after a gap note was appended");
  } finally {
    restore();
    cleanup();
  }
});

test("a well-specified description with no gaps is sent unmodified", async () => {
  const restore = mockFetchOnce('{"gaps": []}');
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("200002", "Buy exactly one 15-inch ThinkPad X1 for under 1500 EUR, deliver by Friday to the Helsinki office.");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-nogap", channelId: "test" });
    assert.equal(result, undefined, "no gaps found must mean no change to what gets sent");
    const analysisLogContent = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.ok(analysisLogContent.includes('"confirmation_gap_check"'));
    assert.ok(analysisLogContent.includes('"gaps":[]'));
  } finally {
    restore();
    cleanup();
  }
});

test("gapDetection: false skips the check entirely, even with analysis configured", async () => {
  let called = false;
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"gaps": ["x"]}' } }] }) }; };
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("200003", "Buy something vague");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-off", channelId: "test" });
    assert.equal(result, undefined);
    assert.equal(called, false, "gapDetection: false must skip the LLM call entirely, not just discard its result");
  } finally {
    globalThis.fetch = orig;
    cleanup();
  }
});

test("a failed gap-detection call fails open: the confirmation still sends unmodified and still gets granted", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("200004", "Buy a laptop");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-error", channelId: "test" });
    assert.equal(result, undefined, "an advisory check failing must never block or alter the confirmation itself");

    const analysisLogContent = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.ok(analysisLogContent.includes('"confirmation_gap_check_error"'));

    handlers.message_received({ content: "y" }, { sessionKey: "sess-error" });
    assert.equal(existsSync(auditRecordPath(rootDir, "200004")), true, "the confirmation must still be grantable despite the gap check failing");
  } finally {
    globalThis.fetch = orig;
    cleanup();
  }
});
