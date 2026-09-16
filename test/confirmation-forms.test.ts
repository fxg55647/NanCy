// Tests for NanCy-generated confirmation forms (src/confirmation/forms.ts,
// docs/architecture/confirmation-forms.md's v1 scope). The module is purely
// presentational — the only thing that ever grants a task is a literal "y"
// reply in message_received, completely unchanged from before this feature
// existed. Complements gap-detection.test.ts (the advisory note this
// feature sits beside) and confirmation-lifecycle.test.ts (the underlying
// y/n grant mechanics, which this feature must never alter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createFakeApi, confirmationContent } from "./helpers.ts";
import { parseFormGenerationResponse, buildFormAndMenuNote, buildFormDataBlock } from "../src/confirmation/forms.ts";
import type { GeneratedForm } from "../src/confirmation/forms.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };
const allow = "VERDICT: ALLOW\nREASON: safe confirmation request";

function mockFetchSequence(contents: Array<string | Error>): () => void {
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => {
    const next = contents.shift();
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => ({ choices: [{ message: { content: next } }] }) };
  };
  return () => { globalThis.fetch = orig; };
}

function auditRecordPath(rootDir: string, id: string): string {
  return join(rootDir, "workspace", "main", "tasks", `${id}.json`);
}

// --- parseFormGenerationResponse (pure) ---

test("parseFormGenerationResponse fixes kind/type from purpose, regardless of anything else the model returns", () => {
  const raw = JSON.stringify({ fields: [{ purpose: "price_range", label: "Price range?", why: "sets a spend limit", required: true, kind: "specification", type: "select" }] });
  const form = parseFormGenerationResponse(raw, "123456");
  assert.equal(form.fields.length, 1);
  assert.equal(form.fields[0].kind, "authorization", "kind must come from the fixed lookup table, not the model's own 'kind' field");
  assert.equal(form.fields[0].type, "range", "type must come from the fixed lookup table, not the model's own 'type' field");
});

test("parseFormGenerationResponse drops unknown purposes and caps the field count", () => {
  const raw = JSON.stringify({
    fields: [
      { purpose: "payment_method", label: "Which card?", why: "x", required: true },
      { purpose: "price_ceiling", label: "Max price?", why: "x", required: true },
      { purpose: "quantity", label: "How many?", why: "x", required: false },
      { purpose: "required_specs", label: "Specs?", why: "x", required: false },
      { purpose: "free_text_detail", label: "Anything else?", why: "x", required: false },
    ],
  });
  const form = parseFormGenerationResponse(raw, "id1", 2);
  assert.equal(form.fields.length, 2, "must cap at maxFields even when more valid fields were proposed");
  const purposes: string[] = form.fields.map((f) => f.purpose);
  assert.ok(!purposes.includes("payment_method"), "an unlisted purpose (e.g. a select-shaped one) must never survive parsing");
});

test("parseFormGenerationResponse degrades to no fields on malformed/empty/null input", () => {
  assert.deepEqual(parseFormGenerationResponse(null, "id1").fields, []);
  assert.deepEqual(parseFormGenerationResponse("not json", "id1").fields, []);
  assert.deepEqual(parseFormGenerationResponse('{"fields": []}', "id1").fields, []);
  assert.deepEqual(parseFormGenerationResponse('{"fields": [{"purpose": "price_ceiling"}]}', "id1").fields, [], "a field missing a label must be dropped");
});

test("parseFormGenerationResponse parses offersGatherFirst independently of fields", () => {
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true}', "id1").offersGatherFirst, true);
  assert.equal(parseFormGenerationResponse('{"fields": []}', "id1").offersGatherFirst, false, "missing offersGatherFirst must default to false, not throw");
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": "yes"}', "id1").offersGatherFirst, false, "only a literal boolean true counts");
});

test("parseFormGenerationResponse clamps gatherFirstDefaultCount into [2, 10] and defaults to 5", () => {
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true, "gatherFirstDefaultCount": 4}', "id1").gatherFirstDefaultCount, 4);
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true, "gatherFirstDefaultCount": 500}', "id1").gatherFirstDefaultCount, 10, "must clamp an absurdly large model-suggested count");
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true, "gatherFirstDefaultCount": 0}', "id1").gatherFirstDefaultCount, 2, "must clamp a too-small count up to the floor");
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true, "gatherFirstDefaultCount": "many"}', "id1").gatherFirstDefaultCount, 5, "a non-numeric count must fall back to the default, not throw");
  assert.equal(parseFormGenerationResponse('{"fields": [], "offersGatherFirst": true}', "id1").gatherFirstDefaultCount, 5, "a missing count must fall back to the default");
});

test("parseFormGenerationResponse never sets gatherFirstDefaultCount when offersGatherFirst is false", () => {
  const form = parseFormGenerationResponse('{"fields": [], "offersGatherFirst": false, "gatherFirstDefaultCount": 7}', "id1");
  assert.equal(form.gatherFirstDefaultCount, undefined, "a count is meaningless without offersGatherFirst, and must not leak through");
});

// --- buildFormAndMenuNote / buildFormDataBlock (pure) ---

const sampleForm: GeneratedForm = {
  confirmationId: "654321",
  fields: [{ id: "price_range", purpose: "price_range", kind: "authorization", type: "range", label: "Price range", why: "sets a spend limit", required: true }],
  offersGatherFirst: false,
};

test("buildFormAndMenuNote is plain text only — safe for every channel", () => {
  const note = buildFormAndMenuNote(sampleForm);
  assert.doesNotMatch(note, /NANCY_FORM/);
  assert.match(note, /Price range/);
  assert.match(note, /"y" to proceed/);
});

test("buildFormAndMenuNote states plainly that anything but 'y' is not consent", () => {
  const note = buildFormAndMenuNote(sampleForm);
  assert.match(note, /is not itself consent/);
});

test("buildFormAndMenuNote mentions gathering options only when offersGatherFirst is true", () => {
  const withGather: GeneratedForm = { ...sampleForm, offersGatherFirst: true };
  assert.doesNotMatch(buildFormAndMenuNote(sampleForm), /gather/);
  assert.match(buildFormAndMenuNote(withGather), /gather/);
});

test("buildFormAndMenuNote still says something sensible with zero fields but offersGatherFirst true", () => {
  const gatherOnly: GeneratedForm = { confirmationId: "1", fields: [], offersGatherFirst: true };
  const note = buildFormAndMenuNote(gatherOnly);
  assert.match(note, /"y" to proceed/);
  assert.match(note, /gather/);
});

test("buildFormDataBlock carries the machine-readable form for a rendering client, including offersGatherFirst", () => {
  const block = buildFormDataBlock({ ...sampleForm, offersGatherFirst: true });
  assert.match(block, /\[NANCY_FORM\]/);
  assert.match(block, /"confirmationId":"654321"/);
  assert.match(block, /"offersGatherFirst":true/);
});

// --- End-to-end via message_sending / message_received ---

test("a purchase-shaped confirmation gets a form and menu appended, but only a literal 'y' ever grants it", async () => {
  const formJson = JSON.stringify({ fields: [{ purpose: "price_range", label: "Price range?", why: "sets a spend limit", required: true }], offersGatherFirst: false });
  const restore = mockFetchSequence([allow, formJson]);
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300001", "Buy a laptop for the office");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-form", channelId: "test" });

    assert.notEqual(result, undefined, "a generated form must actually change what gets sent");
    assert.match(result.content, /Price range\?/);
    assert.doesNotMatch(result.content, /\[NANCY_FORM\]/, "channelId 'test' is not in the default renderChannels, so no structured block is sent");

    const analysisLogContent = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.ok(analysisLogContent.includes('"confirmation_form_generated"'));

    handlers.message_sent({ success: true, content: result.content, messageId: "m-form", to: "user" }, { sessionKey: "sess-form" });

    // Text that names the form's own field is NOT consent — it must still
    // be denied, exactly like any other non-"y" reply, and flow to the
    // agent as ordinary conversation instead of silently granting anything.
    handlers.message_received({ content: "Price range: 500-800", replyToId: "m-form" }, { sessionKey: "sess-form" });
    assert.equal(existsSync(auditRecordPath(rootDir, "300001")), false, "naming a field in plain text must never itself grant the task");
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.ok(log.includes('"confirmation_denied"'));
  } finally {
    restore();
    cleanup();
  }
});

test("a2a channel gets the structured [NANCY_FORM] block, and a plain 'y' still grants the original description unchanged", async () => {
  const formJson = JSON.stringify({ fields: [{ purpose: "price_range", label: "Price range?", why: "sets a spend limit", required: true }], offersGatherFirst: true });
  const restore = mockFetchSequence([allow, formJson]);
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300002", "Buy a laptop for the office");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-a2a", channelId: "a2a" });
    assert.match(result.content, /\[NANCY_FORM\]/, "a2a is in the default renderChannels");
    assert.match(result.content, /"offersGatherFirst":true/);

    handlers.message_received({ content: "y" }, { sessionKey: "sess-a2a" });

    assert.equal(existsSync(auditRecordPath(rootDir, "300002")), true);
    const record = JSON.parse(readFileSync(auditRecordPath(rootDir, "300002"), "utf8"));
    assert.equal(record.description, "Buy a laptop for the office", "the form must never silently change what gets authorized — only the agent's own fresh confirmation can");
  } finally {
    restore();
    cleanup();
  }
});

test("offersGatherFirst alone (no fields) still triggers the note and the structured block", async () => {
  const formJson = JSON.stringify({ fields: [], offersGatherFirst: true });
  const restore = mockFetchSequence([allow, formJson]);
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300003", "Find me a good nearby restaurant and book a table");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-gather", channelId: "a2a" });
    assert.notEqual(result, undefined, "offersGatherFirst alone must still change what gets sent, even with zero typed fields");
    assert.match(result.content, /gather/);
    assert.match(result.content, /\[NANCY_FORM\]/);
  } finally {
    restore();
    cleanup();
  }
});

test("no fields and offersGatherFirst false leaves the confirmation completely unmodified", async () => {
  const formJson = JSON.stringify({ fields: [], offersGatherFirst: false });
  const restore = mockFetchSequence([allow, formJson]);
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300004", "Send the report to the printer");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-none", channelId: "a2a" });
    assert.equal(result, undefined);
  } finally {
    restore();
    cleanup();
  }
});

test("confirmationForms.enabled: false reproduces the pre-existing gap-detection-only behavior exactly", async () => {
  const restore = mockFetchSequence([allow, '{"gaps": ["price ceiling"]}']);
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, confirmationForms: { enabled: false } } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300005", "Buy a laptop for the office");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-disabled", channelId: "a2a" });
    assert.match(result.content, /NanCy note/, "gap detection must still run");
    assert.doesNotMatch(result.content, /📝 NanCy:/, "no form/menu must be appended when confirmationForms is disabled");
    assert.doesNotMatch(result.content, /\[NANCY_FORM\]/);
  } finally {
    restore();
    cleanup();
  }
});

test("a failed form-generation call leaves an already safety-reviewed confirmation unchanged", async () => {
  const restore = mockFetchSequence([allow, new Error("network down")]);
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg, gapDetection: false } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const original = confirmationContent("300006", "Buy a laptop for the office");
    const result = await handlers.message_sending({ content: original, to: "user" }, { sessionKey: "sess-form-error", channelId: "test" });
    assert.equal(result, undefined, "a failed form-generation call must never block or alter the confirmation itself");

    const analysisLogContent = readFileSync(join(rootDir, "nancy-analysis.log"), "utf8");
    assert.ok(analysisLogContent.includes('"confirmation_form_error"'));

    handlers.message_received({ content: "y" }, { sessionKey: "sess-form-error" });
    assert.equal(existsSync(auditRecordPath(rootDir, "300006")), true);
  } finally {
    restore();
    cleanup();
  }
});
