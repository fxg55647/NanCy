// Backs docs/architecture/gather-results-format.md's central claim: the
// optional [NANCY_RESULTS]{"items":[...]}[/NANCY_RESULTS] convention the
// target agent may use to report gathered candidates is agent-authored and
// purely presentational — NanCy needs (and has) zero special-casing for it.
// This test proves that claim rather than just asserting it in prose: an
// ordinary outbound message containing such a block passes through
// message_sending completely unmodified, the same as any other content.
import { test } from "node:test";
import assert from "node:assert/strict";
import nancyPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

const analysisCfg = { provider: "openai" as const, model: "test-model", apiKey: "x" };
const allow = "VERDICT: ALLOW\nREASON: matches the confirmed task";

test("an outbound message carrying a [NANCY_RESULTS] block is reviewed and sent exactly as given", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: allow } }] }));
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: analysisCfg } });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nancyPlugin.register(api as any);

    const resultsBlock = `[NANCY_RESULTS]${JSON.stringify({
      items: [
        { name: "ThinkPad X1 Carbon", price: 1499, url: "https://example.com/x1" },
        { name: "MacBook Air M4", price: 1299, specs: "16GB/512GB" },
      ],
    })}[/NANCY_RESULTS]`;
    const content = `Here are the laptops I found:\n${resultsBlock}`;

    const result = await handlers.message_sending({ content, to: "user" }, { sessionKey: "sess-results", channelId: "a2a" });

    // NanCy's ordinary "no change" contract for an ALLOWed outbound message
    // with nothing else to append (no gap note, no confirmation form — this
    // isn't a confirmation request at all) is `undefined`.
    assert.equal(result, undefined, "NanCy must not alter, wrap, or strip a [NANCY_RESULTS] block — it isn't NanCy's content to touch");
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});
