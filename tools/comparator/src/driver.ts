// Drives one (scenario, branch, userProfile) run: repeated `openclaw agent
// --local --session-key ... --message ... --json` child-process calls
// against a fully isolated profile (see config-builder.ts), continuing the
// same disk-backed session turn by turn, until a simulated purchase is
// detected, the user-simulator has nothing left to say, or a limit is hit.
//
// `openclaw agent exec` was deliberately NOT used here — it's always a
// fresh one-shot session with no continuity (verified against
// node_modules/openclaw/dist/agent-exec-*.mjs), which cannot carry a
// multi-turn user-simulator conversation. Plain `agent --session-key`
// resumes a real disk-backed session across separate CLI invocations —
// see docs/architecture/behavior-comparator.md for the verification.
import { spawnSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { listKnownProviderAuthEnvVarNames, omitEnvKeysCaseInsensitive } from "openclaw/plugin-sdk/provider-auth";
import type { Branch, DriverTurnLog, RunPaths, Scenario, UserProfile } from "./types.ts";
import { buildRun } from "./config-builder.ts";
import type { AnalysisModelConfig } from "./config-builder.ts";
import { decideUserReply } from "./user-simulator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
// `node_modules/.bin/openclaw.cmd` fails with EINVAL when spawned via
// spawnSync on Windows (verified empirically) — Windows requires either
// `shell: true` or invoking the real entry file directly. Run the actual
// ESM entry (`openclaw.mjs`, from package.json's "bin") through the same
// Node binary this process is already running under instead, which works
// identically cross-platform and avoids the shell-wrapper problem entirely.
const OPENCLAW_ENTRY = join(REPO_ROOT, "node_modules", "openclaw", "openclaw.mjs");

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

// Base env for every spawned `openclaw` child: strip every provider
// credential env var OpenClaw itself knows about (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, etc. — the real list, not a guessed one) from this
// process's own environment, so a comparator run can never silently fall
// back to whatever credentials happen to be set in the operator's shell.
// The run's own explicit `env` (from model-config.json) is layered back on
// top of this in runOneCliTurn, per call.
const STRIPPED_BASE_ENV = omitEnvKeysCaseInsensitive(process.env, listKnownProviderAuthEnvVarNames());

// Plain `openclaw agent --json`'s error envelope is now empirically
// confirmed (real CLI invocation, invalid model, see
// tools/comparator/test/driver-smoke.test.ts): `{ok: false, error: {type,
// message}}`. Its success envelope is NOT yet independently confirmed —
// `agent exec`'s is known (classifyAgentExecResult in agent-exec-*.mjs:
// {ok, status, final, payloads: [{text,...}], ...}) and this function
// assumes plain `agent` shares that shape, but that assumption needs
// checking on the first real (successful) calibration run. This function
// is the single place to fix if it differs — see
// docs/architecture/behavior-comparator.md's "Known limitations".
export function extractAssistantText(json: unknown): string {
  const obj = (json ?? {}) as Record<string, unknown>;
  if (Array.isArray(obj.payloads)) {
    const texts = (obj.payloads as Array<Record<string, unknown>>)
      .filter((p) => !p.isError && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length > 0) return texts.join("\n\n");
  }
  for (const key of ["final", "reply", "text", "message"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) return obj[key] as string;
  }
  return "";
}

// `{ok: false, error: {...}}` is a genuine CLI/model-level failure (e.g.
// an invalid model id, a provider outage) — distinct from `ok: true` with
// merely empty assistant text. Conflating the two would misreport a real
// failure as "the user-simulator had nothing left to say".
export function envelopeError(json: unknown): string | undefined {
  const obj = (json ?? {}) as Record<string, unknown>;
  if (obj.ok !== false) return undefined;
  const err = obj.error as Record<string, unknown> | undefined;
  return typeof err?.message === "string" ? err.message : "openclaw agent reported ok: false with no error message";
}

export function runOneCliTurn(params: { runPaths: RunPaths; sessionKey: string; message: string; taskModel: string; env: Record<string, string>; timeoutMs: number }): {
  ok: boolean;
  json?: unknown;
  rawStdout: string;
  rawStderr: string;
  spawnError?: string;
} {
  const { runPaths, sessionKey, message, taskModel, env, timeoutMs } = params;
  // --auth-env-only is only a flag on `openclaw agent exec`, not plain
  // `openclaw agent` (which this harness uses for session continuity — see
  // module comment) — passing it here gets rejected as an unknown flag.
  // Credential isolation instead comes from STRIPPED_BASE_ENV above: no
  // ambient provider credential env vars reach the child at all, only
  // whatever this run's own `env` explicitly supplies.
  const result = spawnSync(
    process.execPath,
    [OPENCLAW_ENTRY, "agent", "--local", "--agent", "test-agent", "--session-key", sessionKey, "--message", message, "--model", taskModel, "--json"],
    {
      env: { ...STRIPPED_BASE_ENV, ...env, OPENCLAW_STATE_DIR: runPaths.stateDir, OPENCLAW_CONFIG_PATH: runPaths.configPath },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const rawStdout = result.stdout ?? "";
  const rawStderr = result.stderr ?? "";
  // result.error is set only for a spawn-level failure (wrong executable,
  // EINVAL, ENOENT, timeout-killed) — distinct from the child running and
  // exiting non-zero, which --json output can still explain.
  if (result.error) return { ok: false, rawStdout, rawStderr, spawnError: String(result.error) };
  // In --json mode OpenClaw routes diagnostics to stderr and prints
  // exactly one JSON value on stdout (verified empirically) — parse the
  // whole trimmed stdout directly rather than scanning for a `{`-prefixed
  // line, which breaks on pretty-printed (multi-line) JSON.
  try {
    return { ok: true, json: JSON.parse(rawStdout.trim()), rawStdout, rawStderr };
  } catch {
    return { ok: false, rawStdout, rawStderr };
  }
}

export async function runComparisonRun(params: {
  scenario: Scenario;
  branch: Branch;
  userProfile: UserProfile;
  runId: string;
  runsRoot: string;
  taskModel: string;
  analysis?: AnalysisModelConfig;
  env: Record<string, string>;
  turnTimeoutMs?: number;
}): Promise<{ runPaths: RunPaths; turnLog: DriverTurnLog }> {
  const { scenario, branch, userProfile, runId, runsRoot, taskModel, analysis, env, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS } = params;
  const runPaths = buildRun({ scenario, branch, runId, runsRoot, taskModel, analysis });
  const sessionKey = `agent:test-agent:cmp-${runId}`;

  const turnLog: DriverTurnLog = {
    scenarioId: scenario.id,
    branch,
    userProfile,
    runId,
    sessionKey,
    startedAt: new Date().toISOString(),
    userTurns: [],
    assistantTurns: [],
    stopReason: "user_simulator_exhausted",
  };

  const startedAt = Date.now();
  let pendingMessage = scenario.initialRequest;
  let pendingRevealedBudget: number | undefined;
  let alreadyRevealedBudget = false;
  let turnIndex = 0;
  let stopReason: DriverTurnLog["stopReason"] = "user_simulator_exhausted";

  while (true) {
    if (turnIndex >= scenario.limits.maxTurns) {
      stopReason = "max_turns";
      break;
    }
    if (Date.now() - startedAt >= scenario.limits.maxWallClockMs) {
      stopReason = "max_wall_clock";
      break;
    }

    turnLog.userTurns.push({ turnIndex, ts: new Date().toISOString(), message: pendingMessage, revealedBudgetEur: pendingRevealedBudget });
    if (pendingRevealedBudget !== undefined) alreadyRevealedBudget = true;

    const cliResult = runOneCliTurn({ runPaths, sessionKey, message: pendingMessage, taskModel, env, timeoutMs: turnTimeoutMs });
    if (!cliResult.ok) {
      turnLog.assistantTurns.push({
        turnIndex,
        ts: new Date().toISOString(),
        rawJson: { stdout: cliResult.rawStdout, stderr: cliResult.rawStderr },
        assistantText: "",
      });
      stopReason = "cli_error";
      break;
    }

    const cliError = envelopeError(cliResult.json);
    if (cliError) {
      turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: cliResult.json, assistantText: "" });
      stopReason = "cli_error";
      break;
    }

    const assistantText = extractAssistantText(cliResult.json);
    turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: cliResult.json, assistantText });

    // scenario-shop appends directly to purchaseStateFile — the most
    // reliable "did a simulated purchase happen" signal, independent of
    // parsing the model's own narration of what it did.
    if (existsSync(runPaths.purchaseStateFile)) {
      stopReason = "purchase_detected";
      break;
    }

    const decision = decideUserReply({ profile: userProfile, scenario, assistantText, alreadyRevealedBudget });
    if (decision.action === "stop") {
      stopReason = "user_simulator_exhausted";
      break;
    }
    pendingMessage = decision.message;
    pendingRevealedBudget = decision.revealedBudgetEur;
    turnIndex += 1;
  }

  turnLog.endedAt = new Date().toISOString();
  turnLog.stopReason = stopReason;
  writeFileSync(runPaths.turnLogPath, JSON.stringify(turnLog, null, 2));
  return { runPaths, turnLog };
}
