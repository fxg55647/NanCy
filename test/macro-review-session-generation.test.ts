// Regression test for a documented-but-since-fixed limitation
// (docs/audits/2026-09-14-security-review.md, "Muut ... jatkotestit" #2):
// clearSession() (fired on session_end/idle reset) must invalidate any
// macro-review already in flight for that session key, so a stale
// terminate verdict that resolves afterward can never land on a *new*
// session that has reused the same key. src/state.ts's getSessionToken/
// isSessionTokenCurrent pair is the mechanism; this proves the wiring in
// src/analysis/macro-review.ts actually uses it end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacroReviewer } from "../src/analysis/macro-review.ts";
import { createSessionState } from "../src/state.ts";
import type { AnalysisConfig } from "../src/config.ts";

const analysisCfg: AnalysisConfig = { provider: "openai", model: "test-model", apiKey: "x" };
const noopNotifier = {
  alertsEnabled: false,
  taskReportsEnabled: false,
  sendAlert: () => { },
  notifyBlocked: () => { },
  notifyHardTermination: () => { },
  clearSessionBlockAlerts: () => { },
};

test("clearSession invalidates an in-flight macro-review before a stale terminate verdict arrives", async () => {
  const originalFetch = globalThis.fetch;
  let releaseLlm!: () => void;
  const gate = new Promise<void>(resolve => { releaseLlm = resolve; });
  // @ts-expect-error minimal response stub
  globalThis.fetch = async () => {
    await gate;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"terminate","reason":"sustained bypass attempts"}' } }] }) };
  };

  const dir = mkdtempSync(join(tmpdir(), "nancy-macro-gen-"));
  const analysisLog = join(dir, "nancy-analysis.log");
  const logFile = join(dir, "nancy.log");
  const state = createSessionState();
  const reviewer = createMacroReviewer({
    nancyConfig: { analysis: analysisCfg },
    analysisLog,
    logFile,
    state,
    notifier: noopNotifier,
    getPolicyContext: () => "",
  });

  try {
    const reviewPromise = reviewer.runMacroReview("worker-reused");

    // Simulate session_end reusing the same session key while the reviewer
    // call above is still in flight, waiting on the mocked LLM response.
    state.clearSession("worker-reused");

    releaseLlm();
    await reviewPromise;

    assert.equal(state.terminatedSessions.has("worker-reused"), false,
      "a terminate verdict resolved for the OLD generation must not mark the reused session key as terminated");
    if (existsSync(logFile)) {
      assert.doesNotMatch(readFileSync(logFile, "utf8"), /"event":"session_terminated"/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
