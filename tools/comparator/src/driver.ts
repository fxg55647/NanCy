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
import type { Branch, DriverTurnLog, RunPaths, Scenario, UserProfile } from "./types.ts";
import { buildRun } from "./config-builder.ts";
import type { AnalysisModelConfig } from "./config-builder.ts";
import { decideUserReply } from "./user-simulator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const OPENCLAW_BIN = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "openclaw.cmd" : "openclaw");

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

// The exact `--json` envelope for `agent exec` is confirmed
// (classifyAgentExecResult in agent-exec-*.mjs: {ok, status, final,
// payloads: [{text,...}], ...}). Plain `agent --json` (used here, for
// session continuity — see module comment) was NOT independently
// confirmed to share that shape. This function is the single place to
// fix if a real run's actual envelope differs — see verification notes in
// the plan / docs/architecture/behavior-comparator.md.
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

function runOneCliTurn(params: { runPaths: RunPaths; sessionKey: string; message: string; taskModel: string; env: Record<string, string>; timeoutMs: number }): {
  ok: boolean;
  json?: unknown;
  rawStdout: string;
  rawStderr: string;
} {
  const { runPaths, sessionKey, message, taskModel, env, timeoutMs } = params;
  const result = spawnSync(
    OPENCLAW_BIN,
    ["agent", "--local", "--agent", "test-agent", "--session-key", sessionKey, "--message", message, "--model", taskModel, "--auth-env-only", "--json"],
    {
      env: { ...process.env, ...env, OPENCLAW_STATE_DIR: runPaths.stateDir, OPENCLAW_CONFIG_PATH: runPaths.configPath },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const rawStdout = result.stdout ?? "";
  const rawStderr = result.stderr ?? "";
  if (result.error || (result.status !== null && result.status !== 0)) return { ok: false, rawStdout, rawStderr };
  // --json output may share stdout with other log lines on some hosts —
  // take the last line that looks like a JSON object.
  const jsonLine = rawStdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!jsonLine) return { ok: false, rawStdout, rawStderr };
  try {
    return { ok: true, json: JSON.parse(jsonLine), rawStdout, rawStderr };
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
