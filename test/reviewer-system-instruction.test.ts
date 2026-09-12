import { test } from "node:test";
import assert from "node:assert/strict";
import { callLlm, REVIEWER_SYSTEM_INSTRUCTION } from "../src/analysis/client.ts";
import type { AnalysisConfig } from "../src/config.ts";

test("every supported provider places the reviewer boundary above untrusted content", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  try {
    // @ts-expect-error minimal multi-provider response stub
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const href = String(url);
      if (href.includes("generativelanguage")) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
      }
      if (href.includes("anthropic")) {
        return { ok: true, json: async () => ({ content: [{ text: "ok" }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };

    const configs: AnalysisConfig[] = [
      { provider: "gemini", model: "test", apiKey: "x" },
      { provider: "openai", model: "test", apiKey: "x" },
      { provider: "openai-compat", model: "test", apiKey: "x", baseUrl: "https://compat.invalid" },
      { provider: "anthropic", model: "test", apiKey: "x" },
    ];
    for (const config of configs) await callLlm(config, "UNTRUSTED-PAYLOAD");

    const geminiSystem = (((bodies[0].system_instruction as Record<string, unknown>).parts as Array<Record<string, unknown>>)[0].text);
    assert.equal(geminiSystem, REVIEWER_SYSTEM_INSTRUCTION);

    for (const body of [bodies[1], bodies[2]]) {
      const messages = body.messages as Array<Record<string, unknown>>;
      assert.equal(messages[0].role, "system");
      assert.equal(messages[0].content, REVIEWER_SYSTEM_INSTRUCTION);
      assert.equal(messages[1].role, "user");
      assert.equal(messages[1].content, "UNTRUSTED-PAYLOAD");
    }

    assert.equal(bodies[3].system, REVIEWER_SYSTEM_INSTRUCTION);
    const anthropicMessages = bodies[3].messages as Array<Record<string, unknown>>;
    assert.equal(anthropicMessages[0].content, "UNTRUSTED-PAYLOAD");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
