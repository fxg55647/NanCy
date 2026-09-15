import { test } from "node:test";
import assert from "node:assert/strict";
import { callLlm } from "../src/analysis/client.ts";
import type { AnalysisConfig } from "../src/config.ts";

// Regression test for a real production bug (found via tools/mobile-chat-poc/'s
// A2A end-to-end test): Gemini's "thinking" models draw internal reasoning
// tokens from the same maxOutputTokens budget as the visible reply, so the
// previous 300-token cap left no room for the actual verdict once thinking
// consumed it — every real review against a thinking-capable model
// (NanCy's own live configured reviewer, gemini-3.8-flash, among them) could
// hit MAX_TOKENS and fail closed. See src/analysis/client.ts's
// ANALYSIS_MAX_OUTPUT_TOKENS comment for the full story.
test("Gemini requests disable thinking and use a real output budget, not the old 300-token cap", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  try {
    // @ts-expect-error minimal fetch stub
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ALLOW\nfine" }] } }] }) };
    };
    const cfg: AnalysisConfig = { provider: "gemini", model: "gemini-3.8-flash", apiKey: "x" };
    await callLlm(cfg, "review this");

    const generationConfig = body?.generationConfig as Record<string, unknown>;
    assert.ok((generationConfig.maxOutputTokens as number) > 300, "must be raised well past the old 300-token cap that left no room once thinking consumed part of it");
    assert.deepEqual(generationConfig.thinkingConfig, { thinkingBudget: 0 }, "thinking must be explicitly disabled for this fast one-shot reviewer call");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI and Anthropic requests also use the raised shared output budget", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  try {
    // @ts-expect-error minimal fetch stub
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const href = String(url);
      if (href.includes("anthropic")) return { ok: true, json: async () => ({ content: [{ text: "ok" }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    await callLlm({ provider: "openai", model: "test", apiKey: "x" }, "review");
    await callLlm({ provider: "anthropic", model: "test", apiKey: "x" }, "review");

    assert.ok((bodies[0].max_tokens as number) > 300);
    assert.ok((bodies[1].max_tokens as number) > 300);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
