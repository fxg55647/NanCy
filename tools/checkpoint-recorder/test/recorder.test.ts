import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import recorderPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

function readCaptures(dir: string): Array<Record<string, unknown>> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

test("records a completed run with an executed tool call", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input(
    { provider: "test", model: "test-model", systemPrompt: "sys", prompt: "buy a laptop", historyMessages: [], imagesCount: 0, tools: [{ name: "buy_product" }] },
    { runId: "run-1", sessionKey: "sess-1" },
  );
  handlers.before_tool_call({ toolName: "buy_product", params: { productId: "p1" }, toolCallId: "call-1", runId: "run-1" }, { runId: "run-1" });
  handlers.after_tool_call({ toolName: "buy_product", result: { ok: true }, toolCallId: "call-1", runId: "run-1", durationMs: 5 }, { runId: "run-1" });
  handlers.llm_output({ provider: "test", model: "test-model", assistantTexts: ["Bought it."], usage: { total: 42 } }, { runId: "run-1", sessionKey: "sess-1" });

  const captures = readCaptures(join(rootDir, "captures"));
  assert.equal(captures.length, 1);
  const cp = captures[0];
  assert.equal(cp.status, "completed");
  assert.equal(cp.sessionKey, "sess-1");
  const toolCalls = cp.toolCalls as Array<Record<string, unknown>>;
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].outcome, "executed");
  assert.deepEqual(toolCalls[0].result, { ok: true });
  cleanup();
});

test("a proposed call with no matching after_tool_call stays 'unknown', never guessed as blocked", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input({ provider: "test", model: "m", prompt: "p", historyMessages: [] }, { runId: "run-2", sessionKey: "sess-2" });
  handlers.before_tool_call({ toolName: "buy_product", params: { productId: "p1" }, toolCallId: "call-2", runId: "run-2" }, { runId: "run-2" });
  // No after_tool_call — e.g. another plugin blocked it before execution.
  handlers.llm_output({ provider: "test", model: "m", assistantTexts: [] }, { runId: "run-2", sessionKey: "sess-2" });

  const [cp] = readCaptures(join(rootDir, "captures"));
  const toolCalls = cp.toolCalls as Array<Record<string, unknown>>;
  assert.equal(toolCalls[0].outcome, "unknown");
  assert.equal(toolCalls[0].result, undefined);
  cleanup();
});

test("toolCallId correlates the right after_tool_call among concurrent same-named calls", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input({ provider: "test", model: "m", prompt: "p", historyMessages: [] }, { runId: "run-3", sessionKey: "sess-3" });
  handlers.before_tool_call({ toolName: "search_products", params: { query: "a" }, toolCallId: "call-a", runId: "run-3" }, { runId: "run-3" });
  handlers.before_tool_call({ toolName: "search_products", params: { query: "b" }, toolCallId: "call-b", runId: "run-3" }, { runId: "run-3" });
  // Results arrive out of order — id-based correlation must not mix them up.
  handlers.after_tool_call({ toolName: "search_products", result: { for: "b" }, toolCallId: "call-b", runId: "run-3" }, { runId: "run-3" });
  handlers.after_tool_call({ toolName: "search_products", result: { for: "a" }, toolCallId: "call-a", runId: "run-3" }, { runId: "run-3" });
  handlers.llm_output({ provider: "test", model: "m", assistantTexts: [] }, { runId: "run-3", sessionKey: "sess-3" });

  const [cp] = readCaptures(join(rootDir, "captures"));
  const toolCalls = cp.toolCalls as Array<Record<string, unknown>>;
  const byQuery = (id: string) => toolCalls.find((t) => t.toolCallId === id);
  assert.deepEqual(byQuery("call-a")?.result, { for: "a" });
  assert.deepEqual(byQuery("call-b")?.result, { for: "b" });
  cleanup();
});

test("session_end flushes an incomplete run that never reached llm_output", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input({ provider: "test", model: "m", prompt: "cut short", historyMessages: [] }, { runId: "run-4", sessionKey: "sess-4" });
  handlers.before_tool_call({ toolName: "search_products", params: {}, toolCallId: "call-x", runId: "run-4" }, { runId: "run-4" });
  handlers.session_end({}, { sessionKey: "sess-4" });

  const [cp] = readCaptures(join(rootDir, "captures"));
  assert.equal(cp.status, "incomplete");
  assert.equal((cp.toolCalls as unknown[]).length, 1);
  cleanup();
});

test("gateway_stop flushes every still-open run as incomplete", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input({ provider: "test", model: "m", prompt: "a", historyMessages: [] }, { runId: "run-5", sessionKey: "sess-5" });
  handlers.llm_input({ provider: "test", model: "m", prompt: "b", historyMessages: [] }, { runId: "run-6", sessionKey: "sess-6" });
  handlers.gateway_stop();

  const captures = readCaptures(join(rootDir, "captures"));
  assert.equal(captures.length, 2);
  assert.ok(captures.every((c) => c.status === "incomplete"));
  cleanup();
});

test("redacts secret-shaped strings before writing to disk", () => {
  const { api, handlers, rootDir, cleanup } = createFakeApi();
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  recorderPlugin.register(api);

  handlers.llm_input(
    { provider: "test", model: "m", systemPrompt: "Bearer sk-abcdefghijklmnopqrstuvwx", prompt: "p", historyMessages: [] },
    { runId: "run-7", sessionKey: "sess-7" },
  );
  handlers.llm_output({ provider: "test", model: "m", assistantTexts: [] }, { runId: "run-7", sessionKey: "sess-7" });

  const [cp] = readCaptures(join(rootDir, "captures"));
  assert.ok(!String(cp.systemPrompt).includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(String(cp.systemPrompt).includes("[REDACTED]"));
  cleanup();
});
