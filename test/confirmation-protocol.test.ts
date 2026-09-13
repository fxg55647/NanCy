// Pure unit tests for src/confirmation/protocol.ts — how NanCy reads the
// fixed confirmation-request template and how strictly it requires an
// affirmative reply. No plugin registration needed; these are pure
// functions over strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfirmationRequest, isAffirmativeReply } from "../src/confirmation/protocol.ts";

test("parses the exact required template", () => {
  const parsed = parseConfirmationRequest("Formal confirmation: Send the weekly report to finance@example.com.\nReply y to proceed, any other reply cancels.\n123456");
  assert.deepEqual(parsed, { id: "123456", description: "Send the weekly report to finance@example.com." });
});

test("accepts CRLF line endings and surrounding whitespace", () => {
  const parsed = parseConfirmationRequest("  \r\nFormal confirmation: Do the thing.\r\nReply y to proceed, any other reply cancels.\r\n654321\r\n  ");
  assert.deepEqual(parsed, { id: "654321", description: "Do the thing." });
});

test("accepts a multi-line description", () => {
  const parsed = parseConfirmationRequest("Formal confirmation: Step one.\nStep two.\nReply y to proceed, any other reply cancels.\n111111");
  assert.equal(parsed?.description, "Step one.\nStep two.");
});

test("accepts id lengths at both boundaries (6 and 10 digits)", () => {
  assert.ok(parseConfirmationRequest("Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n123456"));
  assert.ok(parseConfirmationRequest("Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n1234567890"));
});

test("rejects an id one digit short of the minimum (5 digits)", () => {
  assert.equal(parseConfirmationRequest("Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n12345"), null);
});

test("rejects an id one digit past the maximum (11 digits)", () => {
  assert.equal(parseConfirmationRequest("Formal confirmation: x.\nReply y to proceed, any other reply cancels.\n12345678901"), null);
});

test("rejects a completely empty description (blank line between the prefix and the closing line)", () => {
  // parseConfirmationRequest itself still matches this — the empty-description
  // rejection happens one layer up, in before_tool_call/message_sending
  // (see confirmation-lifecycle.test.ts) — but the parser must still report
  // it accurately as an empty string, not silently swallow or reject it.
  const parsed = parseConfirmationRequest("Formal confirmation: \nReply y to proceed, any other reply cancels.\n123456");
  assert.deepEqual(parsed, { id: "123456", description: "" });
});

test("rejects a subtly altered closing line", () => {
  assert.equal(
    parseConfirmationRequest("Formal confirmation: Do it.\nReply Y to proceed, any other reply cancels.\n123456"),
    null,
    "the closing line's case/wording is part of the fixed template, not a stylistic choice",
  );
  assert.equal(
    parseConfirmationRequest("Formal confirmation: Do it.\nReply y to proceed, any other response cancels.\n123456"),
    null,
  );
});

test("rejects content that never had the fixed prefix at all", () => {
  assert.equal(parseConfirmationRequest("Hey, can I go ahead and do the thing?\n123456"), null);
});

test("isAffirmativeReply accepts only y/yes, case-insensitively, with surrounding whitespace", () => {
  for (const reply of ["y", "Y", "yes", "Yes", "YES", "  y  ", "\ty\n"]) {
    assert.equal(isAffirmativeReply(reply), true, `expected ${JSON.stringify(reply)} to be affirmative`);
  }
});

test("isAffirmativeReply rejects every plausible near-miss (fail closed, per AGENTS.md §3)", () => {
  for (const reply of ["yeah", "yep", "sure", "ok", "y.", "y!", "yes please", "no", "n", "", "  ", "1", "👍"]) {
    assert.equal(isAffirmativeReply(reply), false, `expected ${JSON.stringify(reply)} to be denied, not affirmative`);
  }
});
