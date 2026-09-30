// User-facing block categories (src/policy/block-categories.ts) and the
// reviewer-failure split in parseVerdict: an empty or unparseable reviewer
// response must still fail closed, but as "reviewer unavailable" — never as
// a counted security denial that can drive burst review or termination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { parseVerdict } from "../src/analysis/verdict.ts";
import { BLOCK_CATEGORY_LABELS, REASON_CODE_CATEGORIES, formatBlockReason } from "../src/policy/block-categories.ts";
import { REVIEWER_MALFORMED_ALERT_THRESHOLD } from "../src/policy/denial-policy.ts";
import { createFakeApi } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listTsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function mockReviewer(content: string): () => void {
  const orig = globalThis.fetch;
  // @ts-expect-error minimal test stub, not a full fetch implementation
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  return () => { globalThis.fetch = orig; };
}

test("every reasonCode recorded in src/ has a user-facing category", () => {
  const srcDir = join(import.meta.dirname, "..", "src");
  const used = new Set<string>();
  for (const file of listTsFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    // Literal codes passed to recordDenial, including both arms of a ternary
    // (but not the `verdict === "..."` comparison that selects between them)
    // and codes assigned to a local `reasonCode` first.
    for (const line of text.split("\n")) {
      if (!/recordDenial\(|const reasonCode =/.test(line)) continue;
      for (const m of line.matchAll(/(?<!=== )"([a-z][a-z_]+)"/g)) used.add(m[1]);
    }
  }
  assert.ok(used.size > 20, `expected to find the denial codes in src/, found ${used.size}`);
  const missing = [...used].filter((code) => !(code in REASON_CODE_CATEGORIES));
  assert.deepEqual(missing, [], `reasonCodes without a block category: ${missing.join(", ")}`);
});

test("formatBlockReason puts the fixed category label on the first line", () => {
  const text = formatBlockReason("blocked_destination", "send_email: recipient is not the task's requester.");
  const [first, second] = text.split("\n");
  assert.equal(first, BLOCK_CATEGORY_LABELS.destination);
  assert.equal(second, "send_email: recipient is not the task's requester.");
  // Test-mode reasons keep their own "[TEST MODE]" marker, unprefixed.
  assert.equal(formatBlockReason("test_mode_would_allow", "[TEST MODE] x"), "[TEST MODE] x");
});

test("parseVerdict flags empty and unparseable responses as malformed, still failing closed", () => {
  assert.deepEqual(parseVerdict(null), { verdict: "clarify", reason: "No analysis response received.", malformed: true });
  const garbage = parseVerdict("Sure! I think this is fine.");
  assert.equal(garbage.verdict, "clarify");
  assert.equal(garbage.malformed, true);
  assert.deepEqual(parseVerdict("VERDICT: CLARIFY\nREASON: task does not cover this"), { verdict: "clarify", reason: "task does not cover this", malformed: false });
});

test("malformed reviewer responses block as 'reviewer unavailable' without driving burst review", async () => {
  const restore = mockReviewer("I cannot answer in the requested format.");
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    for (let i = 0; i < REVIEWER_MALFORMED_ALERT_THRESHOLD; i++) {
      const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: `q${i}` } }, { sessionKey: "sess-malformed" });
      assert.equal(result?.block, true, "a malformed response must still fail closed");
      assert.equal(result.blockReason.split("\n")[0], BLOCK_CATEGORY_LABELS.reviewer_unavailable);
    }
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.doesNotMatch(log, /"macro_review_requested_by_denial_burst"/, "reviewer failures are not security denials");
    assert.doesNotMatch(log, /"reasonCode":"reviewer_malformed","securitySignal":true/);
    assert.equal((log.match(/"event":"reviewer_malformed_threshold"/g) ?? []).length, 1, "the operator threshold fires exactly once");
  } finally {
    restore();
    cleanup();
  }
});

test("a genuine CLARIFY keeps its own category and still counts as a security signal", async () => {
  const restore = mockReviewer("VERDICT: CLARIFY\nREASON: unclear whether this lookup is harmless");
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "q" } }, { sessionKey: "sess-clarify" });
    assert.equal(result?.block, true);
    assert.equal(result.blockReason.split("\n")[0], BLOCK_CATEGORY_LABELS.clarify);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.match(log, /"reasonCode":"blocked_clarify","securitySignal":true/);
  } finally {
    restore();
    cleanup();
  }
});

test("a malformed review of an outbound message cancels it as 'reviewer unavailable'", async () => {
  const restore = mockReviewer("");
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.message_sending({ content: "hello there", to: "user" }, { sessionKey: "sess-msg", channelId: "test" });
    assert.equal(result?.cancel, true);
    assert.equal(result.cancelReason.split("\n")[0], BLOCK_CATEGORY_LABELS.reviewer_unavailable);
    const log = readFileSync(join(rootDir, "nancy.log"), "utf8");
    assert.match(log, /"reasonCode":"reviewer_malformed","securitySignal":false/);
  } finally {
    restore();
    cleanup();
  }
});
