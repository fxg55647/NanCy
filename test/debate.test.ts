import { test } from "node:test";
import assert from "node:assert/strict";
import { directDebate, reviewAction, type ReviewTrace } from "../src/analysis/debate.ts";
import type { AnalysisConfig } from "../src/config.ts";
import nancy from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

const cfg: AnalysisConfig = { provider: "openai", model: "test", apiKey: "x", debateMode: "always" };
const allow = "VERDICT: ALLOW\nREASON: Authorized.";
const clarify = "VERDICT: CLARIFY\nREASON: Missing authority.";
const evidence = JSON.stringify({ analysis: "No supported case found." });

test("hybrid routes opaque and unknown tools conservatively", () => {
  for (const toolName of ["exec", "shell", "browser", "extension_foo", "write", "WEB_FETCH"]) {
    assert.equal(directDebate({ ...cfg, debateMode: "hybrid" }, { kind: "tool", toolName }), true);
  }
  for (const toolName of ["web_search", "web_fetch"]) assert.equal(directDebate({ ...cfg, debateMode: "hybrid" }, { kind: "tool", toolName }), false);
  assert.equal(directDebate({ ...cfg, debateMode: "hybrid" }, { kind: "message" }), true);
});

test("advocates start independently and judge gets original action plus both outputs", async () => {
  const prompts: string[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const result = await reviewAction(cfg, "POLICY; TASK; ACTION secret-marker", { kind: "message" }, undefined, async (_cfg, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 2) release();
    if (prompt.startsWith("Analyze")) { await bothStarted; return evidence; }
    return allow;
  });
  assert.equal(result, allow);
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every(p => p.includes("ACTION secret-marker")));
  assert.ok(!prompts[1].includes("No supported case found."));
  assert.match(prompts[2], /UNTRUSTED ANALYSES/);
});

test("clarify escalates once; BLOCK and ALLOW do not escalate", async () => {
  for (const initial of [allow, clarify, "VERDICT: BLOCK\nREASON: Policy violation."]) {
    let calls = 0;
    let trace: ReviewTrace | undefined;
    const result = await reviewAction({ ...cfg, debateMode: "clarify" }, "snapshot", { kind: "message" }, t => { trace = t; }, async (_cfg, prompt) => {
      calls++;
      if (calls === 1) return initial;
      return prompt.startsWith("Analyze") ? evidence : clarify;
    });
    assert.equal(calls, initial === clarify ? 4 : 1);
    assert.equal(result, initial);
    assert.equal(trace?.calls, calls);
  }
});

for (const failed of ["for", "against", "judge"]) {
  for (const bad of [null, "bad response", "", "x".repeat(6001)]) {
    test(`fails closed for ${failed} malformed response (${bad?.length ?? "null"})`, async () => {
      let trace: ReviewTrace | undefined;
      await assert.rejects(reviewAction(cfg, "snapshot", { kind: "message" }, t => { trace = t; }, async (_cfg, prompt) => {
        const stage = prompt.startsWith("Judge") ? "judge" : prompt.includes("as the FOR analyst") ? "for" : "against";
        return stage === failed ? bad : stage === "judge" ? allow : evidence;
      }));
      assert.equal(trace?.failedStage, failed);
    });
  }
}

test("shared deadline aborts pending advocates and never starts judge", async () => {
  const signals: AbortSignal[] = [];
  await assert.rejects(reviewAction(cfg, "snapshot", { kind: "message" }, undefined, async (_cfg, _prompt, signal) => {
    signals.push(signal!);
    return new Promise(() => {});
  }, 20));
  assert.equal(signals.length, 2);
  assert.ok(signals.every(s => s.aborted));
});

test("outbound integration cancels debate errors and preserves test-mode cancellation", async () => {
  const original = globalThis.fetch;
  try {
    for (const fail of [true, false]) {
      const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: cfg, testMode: !fail } });
      try {
        globalThis.fetch = async (_url, init) => {
          if (fail) throw new Error("provider unavailable");
          const body = JSON.parse(String(init?.body));
          const prompt = body.messages[1].content as string;
          return new Response(JSON.stringify({ choices: [{ message: { content: prompt.startsWith("Analyze") ? evidence : allow } }] }));
        };
        // @ts-expect-error narrowed fake host
        nancy.register(api);
        const result = await handlers.message_sending({ content: "hello", to: "user" }, { sessionKey: "s1", channelId: "test" });
        assert.equal(result?.cancel, true);
        assert.match(result.cancelReason, fail ? /review failed/ : /TEST MODE/);
      } finally { cleanup(); }
    }
  } finally { globalThis.fetch = original; }
});

test("deterministic gates precede debate without provider calls", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: cfg } });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected provider call"); };
  try {
    // @ts-expect-error narrowed fake host
    nancy.register(api);
    const result = await handlers.before_tool_call({ toolName: "exec", params: { command: "rm data.txt" } }, { sessionKey: "unconfirmed" });
    assert.equal(result?.block, true);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; cleanup(); }
});

test("tool full review uses debate and test mode still prevents execution", async () => {
  const { api, handlers, cleanup } = createFakeApi({ pluginConfig: { analysis: cfg, testMode: true } });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(String(init?.body)).messages[1].content as string;
    return new Response(JSON.stringify({ choices: [{ message: { content: prompt.startsWith("Analyze") ? evidence : allow } }] }));
  };
  try {
    // @ts-expect-error narrowed fake host
    nancy.register(api);
    const result = await handlers.before_tool_call({ toolName: "web_search", params: { query: "library hours" } }, { sessionKey: "lookup" });
    assert.equal(calls, 3);
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /TEST MODE/);
  } finally { globalThis.fetch = original; cleanup(); }
});

test("off mode retains legacy response handling and one call", async () => {
  let calls = 0;
  const result = await reviewAction({ ...cfg, debateMode: "off" }, "snapshot", { kind: "message" }, undefined, async () => { calls++; return null; });
  assert.equal(result, null);
  assert.equal(calls, 1);
});
