// Integration smoke test for the actual `openclaw` Gateway + A2A channel
// pipeline (driver.ts) — the one part of this harness that can't be
// exercised by pure unit tests. Uses a real, known-working model id
// ("google/gemini-2.5-flash") but a fake API key, so the real Google API
// rejects it fast on auth (no successful generation, effectively free)
// rather than reaching a real billed call. The point is only to prove:
// the Gateway process spawns and becomes healthy (no Windows EINVAL from
// spawning a .cmd shim — see driver.ts's OPENCLAW_ENTRY comment), the
// A2A channel this run's config declares actually accepts a real
// JSON-RPC SendMessage call and reports back a real error state (not
// silence), and the Gateway process actually stops afterward. This does
// NOT prove a real, successful model call or NanCy's confirmation dance
// works end to end — that's what tools/mobile-chat-poc/'s own A2A test
// (and a real calibration run) are for; see
// docs/architecture/behavior-comparator.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildRun, A2A_TOKEN_ENV_VAR } from "../src/config-builder.ts";
import { startGateway, waitForGatewayReady, stopGateway, sendA2ATurn } from "../src/driver.ts";
import type { Scenario } from "../src/types.ts";

const scenario: Scenario = {
  id: "smoke",
  label: "smoke test",
  initialRequest: "hello",
  catalog: [],
  userSimulator: { budgetEur: 100, budgetStatement: "test", preferences: [] },
  limits: { maxTurns: 1, maxWallClockMs: 30_000 },
};

test(
  "the Gateway spawns and becomes healthy, a real A2A SendMessage against it reports a real error (not silence), and it stops cleanly afterward",
  { timeout: 180_000 },
  async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "driver-smoke-"));
    const taskModel = "google/gemini-2.5-flash";
    const taskModelDefinition = { contextWindow: 1_000_000, maxTokens: 8192, cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 } };
    const env = { GEMINI_API_KEY: "definitely-invalid-key" };
    const gatewayPort = 29123;
    const a2aToken = randomBytes(24).toString("hex");
    const runPaths = buildRun({ scenario, branch: "baseline", runId: "smoke-1", runsRoot, taskModel, taskModelEnv: env, taskModelDefinition, gatewayPort });
    const gatewayProc = startGateway(runPaths, { ...env, [A2A_TOKEN_ENV_VAR]: a2aToken }, gatewayPort);
    try {
      await waitForGatewayReady(runPaths, { ...env, [A2A_TOKEN_ENV_VAR]: a2aToken }, gatewayPort);

      const url = `http://127.0.0.1:${gatewayPort}/a2a/v1`;
      let result: Awaited<ReturnType<typeof sendA2ATurn>> | undefined;
      let thrown: unknown;
      try {
        result = await sendA2ATurn({ url, token: a2aToken, text: scenario.initialRequest, timeoutMs: 60_000 });
      } catch (err) {
        thrown = err;
      }

      // A provider auth failure is, empirically, NOT surfaced as an A2A
      // task-level error state (TASK_STATE_FAILED/REJECTED) — OpenClaw
      // catches it upstream and returns a normal TASK_STATE_COMPLETED
      // task whose reply text is its own synthesized warning (observed:
      // "⚠️ google/gemini-2.5-flash request failed (authentication
      // failed, HTTP 400). Re-authenticate the provider and try again.").
      // sendA2ATurn()/taskFailure() only check task state, so this real
      // failure mode currently reads as ordinary (if odd-looking)
      // assistant text — a known gap for the driver's own error handling
      // during a real run, not something this test can paper over. So the
      // acceptance here is: either the JSON-RPC call itself failed
      // (thrown), or the task settled with a real error state
      // (result.error), or the reply text itself is recognizably an
      // error/warning — never a genuinely silent, error-shaped-nowhere
      // "success".
      if (thrown) {
        assert.match(String(thrown), /error|key|auth|invalid|unauthorized|model/i, `expected a recognizable auth/model error, got: ${String(thrown)}`);
      } else {
        assert.ok(result, "expected either a thrown error or a result");
        const looksLikeError = result!.error || /error|fail|invalid|auth|re-authenticate/i.test(result!.text);
        assert.ok(looksLikeError, `expected a fake API key to produce a recognizable error somewhere (task state or reply text), got: ${JSON.stringify(result)}`);
      }
    } finally {
      const { stopped } = await stopGateway(gatewayProc);
      assert.equal(stopped, true, "gateway process should have actually exited, not been left running");
      rmSync(runsRoot, { recursive: true, force: true });
    }
  },
);
