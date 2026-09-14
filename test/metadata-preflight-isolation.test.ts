// Regression test for metadata-preflight content isolation (src/analysis/
// preflight.ts's own doc comment): the destination-only preflight run before
// the mandatory full review must never expose the outbound message body or a
// write/edit's file content to the LLM — only bounded destination metadata,
// until the destination itself has been found plausible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outboundDestinationMetadata, toolDestinationMetadata, metadataPreflightPrompt } from "../src/analysis/preflight.ts";

const SECRET = "SECRET-PAYLOAD-MARKER-should-never-reach-the-preflight-prompt";

test("outbound message metadata carries only channel/recipient, never the message body", () => {
  const metadata = outboundDestinationMetadata({ to: "user@example.com", content: SECRET } as never, "email");
  assert.deepEqual(metadata, { channel: "email", recipient: "user@example.com" });
});

test("write/edit/message destination metadata never carries the payload fields", () => {
  assert.deepEqual(toolDestinationMetadata("write", { path: "notes.txt", content: SECRET }), { path: "notes.txt" });
  assert.deepEqual(toolDestinationMetadata("edit", { path: "notes.txt", old_str: SECRET, new_str: SECRET }), { path: "notes.txt" });
  assert.deepEqual(toolDestinationMetadata("message", { to: "user@example.com", text: SECRET }), { to: "user@example.com" });
});

test("a destination-preflight tool with no destination fields at all yields no metadata", () => {
  // apply_patch's payload has no separate path field — nothing safe to
  // report, so it must fall straight through to full content review rather
  // than fabricate metadata from the payload.
  assert.equal(toolDestinationMetadata("apply_patch", { patch: `*** Begin Patch\n${SECRET}` }), null);
});

test("the built preflight prompt reflects only the bounded metadata, never the raw payload", () => {
  const metadata = outboundDestinationMetadata({ to: "user@example.com" } as never, "email");
  const prompt = metadataPreflightPrompt({
    policyContext: "",
    task: { description: "Reply to the customer" },
    actionKind: "outbound-message destination",
    metadata,
  });
  assert.ok(!prompt.includes(SECRET));
  assert.match(prompt, /payload deliberately omitted/);
  assert.match(prompt, /user@example\.com/);
});
