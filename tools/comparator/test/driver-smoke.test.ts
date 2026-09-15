// Integration smoke test for the actual `openclaw` CLI child-process
// invocation (driver.ts's runOneCliTurn) — the one part of this harness
// that can't be exercised by pure unit tests. Deliberately uses an
// invalid provider/model so it fails fast during local resolution and
// never reaches a real network call or spends any API budget; the point
// is only to prove the process spawns correctly (no Windows EINVAL from
// spawning a .cmd shim — see driver.ts's OPENCLAW_ENTRY comment) and that
// --json output, when produced, is parseable as a whole (not scanned
// line-by-line — see driver.ts's runOneCliTurn comment). This does NOT
// prove a real model call succeeds; that's what the first real
// calibration run is for (see docs/architecture/behavior-comparator.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRun } from "../src/config-builder.ts";
import { runOneCliTurn, envelopeError } from "../src/driver.ts";
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
  "the openclaw CLI actually spawns (no Windows EINVAL) and stdout is parseable as whole-output JSON, not scanned line-by-line",
  { timeout: 60_000 },
  () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "driver-smoke-"));
    try {
      const runPaths = buildRun({ scenario, branch: "baseline", runId: "smoke-1", runsRoot, taskModel: "definitely-invalid-provider/definitely-invalid-model" });
      const result = runOneCliTurn({
        runPaths,
        sessionKey: "agent:test-agent:smoke-1",
        message: scenario.initialRequest,
        taskModel: "definitely-invalid-provider/definitely-invalid-model",
        env: {},
        timeoutMs: 45_000,
      });

      // The load-bearing assertion: no spawn-level failure (wrong
      // executable, EINVAL, ENOENT). A rejected/invalid model is a normal
      // CLI-level outcome, not a spawn failure.
      assert.equal(result.spawnError, undefined, `spawn-level failure (not a CLI/model error): ${result.spawnError}`);
      assert.ok(result.rawStdout.length > 0 || result.rawStderr.length > 0, "expected some CLI output on stdout or stderr; got neither — the process may not have run at all");

      // If stdout parsed as JSON, it should be a real object (whole-output
      // parsing worked), not have silently picked up a stray brace from a
      // log line.
      if (result.ok) {
        assert.equal(typeof result.json, "object");
        assert.notEqual(result.json, null);
        // An invalid model id is expected to produce a real CLI-level
        // error envelope ({ok:false, error:{...}}) — confirms
        // envelopeError() actually recognizes it as an error rather than
        // silently reading it as empty assistant text.
        const err = envelopeError(result.json);
        assert.ok(err, `expected an error envelope for an invalid model, got: ${JSON.stringify(result.json)}`);
        assert.match(err!, /model/i);
      }
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  },
);
