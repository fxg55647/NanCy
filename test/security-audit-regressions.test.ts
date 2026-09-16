import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nancy from "../src/index.ts";
import { createFakeApi, confirmationContent, waitFor } from "./helpers.ts";
import { createProtectedPathsResolver } from "../src/policy/protected-paths.ts";
import { checkDomainBorder } from "../src/policy/domain-policy.ts";
import { parseVerdict } from "../src/analysis/verdict.ts";
import { fetchBrowserSnapshot } from "../src/browser/snapshot.ts";
import { telegramAlert } from "../src/notifications/telegram.ts";
import { createOperatorPolicy } from "../src/policy/operator-policy.ts";
import { callLlm } from "../src/analysis/client.ts";

const analysis = { provider: "openai" as const, model: "mock", apiKey: "fake" };
const allow = "VERDICT: ALLOW\nREASON: authorized";
const block = "VERDICT: BLOCK\nREASON: prohibited";
const llmResponse = (content: string, finish_reason = "stop") =>
  new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));

function register(config: Record<string, unknown> = {}, subagent?: Record<string, (...args: any[]) => any>) {
  const fixture = createFakeApi({
    // gapDetection/confirmationForms: false — these tests are about
    // session/task-lifecycle edge cases, not either advisory feature, and
    // several rely on a single-release-cycle fetch mock (see the
    // session-ends-during-review tests below); an extra sequential call
    // would either need its own release() or hang forever.
    pluginConfig: { gapDetection: false, confirmationForms: { enabled: false }, telegramAlerts: false, telegramTaskReports: false, ...config },
    subagent,
  });
  nancy.register(fixture.api as any);
  return fixture;
}

test("confirmation exception is reviewed and cannot bypass cron or test-mode gates", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return llmResponse(block); };
  const h = register({ analysis, testMode: true });
  try {
    h.handlers.llm_input({ provider: "mock", model: "mock" }, { sessionKey: "cron", trigger: "cron" });
    const result = await h.handlers.message_sending(
      { content: confirmationContent("123456", "Private customer secret: SYNTHETIC_SECRET"), to: "outside" },
      { sessionKey: "cron", channelId: "email" },
    );
    assert.equal(result?.cancel, true);
    assert.match(result.cancelReason, /cron-triggered/);
    assert.equal(calls, 0, "deterministic cron rejection must happen before exposing the description");
  } finally { globalThis.fetch = originalFetch; h.cleanup(); }
});

test("confirmation request is canceled if its session ends during review", async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  let entered = false;
  globalThis.fetch = async () => {
    entered = true;
    await new Promise<void>(resolve => { release = resolve; });
    return llmResponse(allow);
  };
  const h = register({ analysis });
  try {
    const pending = h.handlers.message_sending(
      { content: confirmationContent("654321", "Write report.txt"), to: "owner" },
      { sessionKey: "s", channelId: "dm" },
    );
    await waitFor(() => entered);
    h.handlers.session_end({ sessionId: "old" }, { sessionKey: "s" });
    release();
    const result = await pending;
    assert.equal(result?.cancel, true);
    assert.match(result.cancelReason, /session changed during review/);
    await h.handlers.message_received({ content: "yes", from: "owner" }, { sessionKey: "s", channelId: "dm" });
    assert.doesNotMatch(readFileSync(join(h.rootDir, "nancy.log"), "utf8"), /confirmation_granted/);
  } finally { globalThis.fetch = originalFetch; h.cleanup(); }
});

test("confirmation reply is bound to the request recipient and channel when identities are available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => llmResponse(allow);
  const h = register({ analysis });
  try {
    const content = confirmationContent("123456", "Write report.txt");
    await h.handlers.message_sending({ content, to: "owner" }, { sessionKey: "shared", channelId: "dm" });
    await h.handlers.message_received({ content: "yes", from: "other-person" }, { sessionKey: "shared", channelId: "dm" });
    const denied = await h.handlers.before_tool_call(
      { toolName: "write", params: { path: "report.txt", content: "report" } },
      { sessionKey: "shared" },
    );
    assert.equal(denied?.block, true);
    assert.match(denied.blockReason, /no active confirmed task/);
    assert.doesNotMatch(readFileSync(join(h.rootDir, "nancy.log"), "utf8"), /confirmation_granted/);

    await h.handlers.message_received({ content: "yes", from: "owner" }, { sessionKey: "shared", channelId: "other-channel" });
    assert.doesNotMatch(readFileSync(join(h.rootDir, "nancy.log"), "utf8"), /confirmation_granted/);
  } finally { globalThis.fetch = originalFetch; h.cleanup(); }
});

test("a duplicate public task id cannot overwrite an active worker authorization", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => llmResponse(allow);
  const runs: Array<{ sessionKey: string }> = [];
  const h = register({ analysis, workerAgentId: "worker" }, {
    run: async (args: { sessionKey: string }) => { runs.push(args); return { runId: `run-${runs.length}` }; },
    waitForRun: async () => new Promise(() => {}),
    deleteSession: async () => {},
  });
  try {
    for (const [sessionKey, description] of [["chat-a", "FIRST_TASK"], ["chat-b", "SECOND_TASK"]] as const) {
      const content = confirmationContent("123456", description);
      await h.handlers.message_sending({ content, to: "owner" }, { sessionKey, channelId: "dm" });
      await h.handlers.message_received({ content: "yes", from: "owner" }, { sessionKey, channelId: "dm" });
    }
    assert.equal(runs.length, 1);
    assert.match(readFileSync(join(h.rootDir, "nancy.log"), "utf8"), /confirmation_duplicate_id/);
  } finally { globalThis.fetch = originalFetch; h.cleanup(); }
});

for (const kind of ["tool", "message"] as const) {
  test(`${kind} ALLOW is revoked when the session ends during review`, async () => {
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    let entered = false;
    globalThis.fetch = async () => {
      entered = true;
      await new Promise<void>(resolve => { release = resolve; });
      return llmResponse(allow);
    };
    const h = register({ analysis });
    try {
      const pending = kind === "tool"
        ? h.handlers.before_tool_call({ toolName: "web_search", params: { query: "hours" } }, { sessionKey: "s" })
        : h.handlers.message_sending({ content: "message", to: "owner" }, { sessionKey: "s", channelId: "dm" });
      await waitFor(() => entered);
      h.handlers.session_end({ sessionId: "old" }, { sessionKey: "s" });
      release();
      const result = await pending;
      assert.equal(kind === "tool" ? result?.block : result?.cancel, true);
      assert.match(kind === "tool" ? result.blockReason : result.cancelReason, /changed during review/);
    } finally { globalThis.fetch = originalFetch; h.cleanup(); }
  });
}

test("protected-path matching resolves case and filesystem aliases", () => {
  const h = register();
  try {
    const resolver = createProtectedPathsResolver(h.api as any);
    const paths = resolver.getAgentPaths();
    mkdirSync(paths.workspaceDir, { recursive: true });
    writeFileSync(join(paths.workspaceDir, "AGENTS.md"), "protected");
    if (process.platform === "win32") {
      assert.equal(resolver.protectedWriteTarget({ params: { path: "agents.md" } }, paths), "AGENTS.md");
    }
    const alias = join(h.rootDir, "workspace-alias");
    symlinkSync(paths.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolver.protectedWriteTarget({ params: { path: join(alias, "AGENTS.md") } }, paths), "AGENTS.md");
  } finally { h.cleanup(); }
});

test("domain matching canonicalizes trailing dots and IDNs", async () => {
  const cfg = { deny: ["blocked.example", "bücher.example"], reputationCheck: false };
  assert.match(String(await checkDomainBorder("https://blocked.example./", cfg)), /deny-list/);
  assert.match(String(await checkDomainBorder("https://xn--bcher-kva.example./", cfg)), /deny-list/);
});

test("browser snapshot is bound to the requested tab and profile", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url) => { requested = String(url); return new Response("snapshot"); };
  try {
    assert.equal(await fetchBrowserSnapshot(18791, undefined, { targetId: "tab 1", profile: "work" }), "snapshot");
    const url = new URL(requested);
    assert.equal(url.searchParams.get("targetId"), "tab 1");
    assert.equal(url.searchParams.get("profile"), "work");
  } finally { globalThis.fetch = originalFetch; }
});

test("early denials are included in bounded macro-review evidence", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).messages[1].content);
    return llmResponse('{"verdict":"ok","reason":"handled"}');
  };
  const h = register({ analysis, macroReview: { blockBurstThreshold: 3 } });
  try {
    for (let i = 0; i < 3; i++) {
      await h.handlers.before_tool_call({ toolName: "write", params: { path: "AGENTS.md", content: "ignored" } }, { sessionKey: "s" });
    }
    await waitFor(() => prompts.length === 1);
    assert.match(prompts[0], /Recent NanCy denials \(3 entries/);
    assert.equal((prompts[0].match(/blocked_protected_write/g) ?? []).length, 3);
    assert.doesNotMatch(prompts[0], /ignored/);
  } finally { globalThis.fetch = originalFetch; h.cleanup(); }
});

test("verdict parser rejects prefixes, prose, duplicate verdicts, and missing reasons", () => {
  for (const malformed of [
    "VERDICT: ALLOWANCE\nREASON: no",
    "Quoted VERDICT: ALLOW\nActual VERDICT: BLOCK\nREASON: prohibited",
    "VERDICT: ALLOW",
    "VERDICT: ALLOW\nREASON: ok\nextra",
  ]) assert.equal(parseVerdict(malformed).verdict, "clarify", malformed);
  assert.equal(parseVerdict(allow).verdict, "allow");
});

test("Telegram API errors reject and outbound alerts use plain text", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = async (_url, init) => {
    body = String(init?.body);
    return new Response('{"ok":false,"description":"bad request"}', { status: 400 });
  };
  try {
    await assert.rejects(() => telegramAlert("fake", "fake", "unbalanced _markdown"), /Telegram API error 400/);
    assert.equal("parse_mode" in JSON.parse(body), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("overlong operator policy is rejected instead of truncating trailing rules", () => {
  const h = register();
  try {
    const policy = createOperatorPolicy(h.rootDir);
    writeFileSync(policy.policyPath, "a".repeat(16_001) + "\nNever send confidential invoices.");
    assert.throws(() => policy.getPolicyContext(), /exceeds the 16000-character safety limit/);
  } finally { h.cleanup(); }
});

test("URLhaus sends Auth-Key and does not treat unknown statuses as a cached clean result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("Auth-Key"), "secret-key");
    return new Response('{"query_status":"unexpected"}');
  };
  try {
    const cfg = { reputationCheck: true, urlhausAuthKey: "secret-key" };
    assert.equal(await checkDomainBorder("https://unknown-status-audit.example/", cfg), null);
    assert.equal(await checkDomainBorder("https://unknown-status-audit.example/", cfg), null);
    assert.equal(calls, 2, "unknown status must not be cached as a clean reputation result");
  } finally { globalThis.fetch = originalFetch; }
});

test("provider truncation cannot become an ALLOW verdict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => llmResponse(allow, "length");
  try {
    await assert.rejects(() => callLlm(analysis, "review"), /did not finish normally \(length\)/);
  } finally { globalThis.fetch = originalFetch; }
});

test("host hook timeouts exceed NanCy's bounded internal review paths", () => {
  const h = register({ analysis });
  try {
    assert.ok((h.hookOptions.message_sending?.timeoutMs ?? 0) >= 95_000);
    assert.ok((h.hookOptions.before_tool_call?.timeoutMs ?? 0) >= 180_000);
  } finally { h.cleanup(); }
});
