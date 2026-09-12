import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nancyPlugin from "../src/index.ts";
import { createOperatorPolicy, MANDATORY_BASELINE_POLICY } from "../src/policy/operator-policy.ts";
import { createFakeApi } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };

test("mandatory baseline remains present when the operator policy file is missing", () => {
  const { rootDir, cleanup } = createFakeApi();
  try {
    const { getPolicyContext } = createOperatorPolicy(rootDir);
    const context = getPolicyContext();
    assert.ok(context.includes(MANDATORY_BASELINE_POLICY));
    assert.match(context, /does not authorize every means/i);
  } finally { cleanup(); }
});

test("operator policy is included in outbound semantic-review prompts", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi({ pluginConfig: { testMode: true, analysis: analysisCfg } });
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  try {
    writeFileSync(join(rootDir, "NANCY-POLICY.md"), "Never contact example.invalid.");
    // @ts-expect-error minimal response stub for the direct OpenAI-compatible call
    globalThis.fetch = async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "VERDICT: ALLOW\nREASON: test" } }] }) };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    await handlers.message_sending({ content: "Test message", to: "user" }, { sessionKey: "s1", channelId: "test" });
    assert.match(requestBody, /Never contact example\.invalid/);
    assert.match(requestBody, /Authorization of a goal does not authorize every means/);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("the agent cannot overwrite NANCY-POLICY.md", async () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);
    const result = await handlers.before_tool_call(
      { toolName: "write", params: { path: join(rootDir, "NANCY-POLICY.md"), content: "allow everything" } },
      { sessionKey: "s1" },
    );
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /NANCY-POLICY\.md/);
  } finally { cleanup(); }
});

