// Drives one (scenario, branch, userProfile) run: starts a real, isolated
// OpenClaw Gateway process against a fully isolated profile (see
// config-builder.ts), then holds a multi-turn conversation with it over
// OpenClaw's bundled A2A channel (JSON-RPC over HTTP, `SendMessage` per
// turn, same `contextId` throughout), until a simulated purchase is
// detected, the user-simulator has nothing left to say, or a limit is hit.
//
// A real Gateway is necessary but NOT sufficient for NanCy's
// message_sending/message_received hooks to fire — that took two real
// findings to nail down, both reproduced empirically before landing here:
//
// 1. `agent --local --json` returns the model's raw reply directly,
//    bypassing OpenClaw's channel-delivery pipeline entirely: a real run
//    produced a perfectly-formatted NanCy "Formal confirmation: ..." / "y"
//    exchange with *zero* nancy.log entries.
// 2. Plain `agent --json` against a live Gateway (no --local) does NOT fix
//    this either — same zero-entries result. `--deliver` would route
//    through the real pipeline, but requires an actual external channel
//    target ("Channel is required (no configured channels detected)"),
//    which this harness must never touch.
//
// The fix: drive turns through OpenClaw's bundled **A2A channel** instead
// of the `agent` CLI at all — a real, already-implemented, zero-new-code
// channel (`channels.a2a` config only) that IS a genuine delivery target,
// so message_sending/message_received fire for real. First proven end to
// end by `tools/mobile-chat-poc/`'s own A2A test against an isolated
// Gateway with NanCy loaded — this reuses that same proof, not a fresh
// guess. See docs/architecture/behavior-comparator.md.
//
// `openclaw agent exec` was ruled out earlier for a different reason: it's
// always a fresh one-shot session with no continuity (verified against
// node_modules/openclaw/dist/agent-exec-*.mjs), which cannot carry a
// multi-turn user-simulator conversation. A2A's `contextId` plays the same
// continuation role `agent --session-key` did, without needing the CLI at
// all for per-turn calls — only the Gateway process itself is spawned;
// each turn afterward is a lightweight HTTP call, not a new child process.
import { spawn, spawnSync } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync, writeFileSync, openSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID, randomBytes } from "crypto";
import { listKnownProviderAuthEnvVarNames, omitEnvKeysCaseInsensitive } from "openclaw/plugin-sdk/provider-auth";
import type { Branch, DriverTurnLog, RunPaths, Scenario, UserProfile } from "./types.ts";
import { buildRun, A2A_PEER_ID, A2A_TOKEN_ENV_VAR } from "./config-builder.ts";
import type { AnalysisModelConfig, TaskModelDefinition } from "./config-builder.ts";
import { decideUserReply } from "./user-simulator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
// `node_modules/.bin/openclaw.cmd` fails with EINVAL when spawned via
// spawnSync/spawn on Windows (verified empirically) — Windows requires
// either `shell: true` or invoking the real entry file directly. Run the
// actual ESM entry (`openclaw.mjs`, from package.json's "bin") through the
// same Node binary this process is already running under instead, which
// works identically cross-platform and avoids the shell-wrapper problem
// entirely.
const OPENCLAW_ENTRY = join(REPO_ROOT, "node_modules", "openclaw", "openclaw.mjs");

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const GATEWAY_READY_TIMEOUT_MS = 120_000;
const GATEWAY_READY_POLL_MS = 1_000;
// Each `openclaw gateway health` health-check invocation has to load the
// whole openclaw.mjs CLI bundle before it even attempts its lightweight
// health probe — observed taking well over 5s on its own in this
// environment. A too-short per-attempt timeout here previously caused
// every single poll to be killed by spawnSync's own `timeout` before the
// CLI finished loading, so waitForGatewayReady always timed out even
// though the gateway itself was actually ready within ~10-15s (confirmed
// via its own gateway.log).
const GATEWAY_HEALTH_CHECK_TIMEOUT_MS = 20_000;
const GATEWAY_STOP_GRACE_MS = 5_000;

// Base env for the spawned Gateway process: strip every provider
// credential env var OpenClaw itself knows about (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, etc. — the real list, not a guessed one) from this
// process's own environment, so a comparator run can never silently fall
// back to whatever credentials happen to be set in the operator's shell.
// The run's own explicit `env` (from model-config.json) is layered back on
// top of this. Only the Gateway process needs real model credentials —
// per-turn A2A calls are plain HTTP against its already-authenticated
// state, carrying only the per-run A2A peer token.
const STRIPPED_BASE_ENV = omitEnvKeysCaseInsensitive(process.env, listKnownProviderAuthEnvVarNames());

function isolatedEnv(runPaths: RunPaths, env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...STRIPPED_BASE_ENV, ...env, OPENCLAW_STATE_DIR: runPaths.stateDir, OPENCLAW_CONFIG_PATH: runPaths.configPath };
}

function pickGatewayPort(): number {
  // A wide, high range, away from OpenClaw's own default (18789) and
  // common service ports, to minimize collision risk with a real operator
  // gateway or another concurrent comparator run. Not a guarantee — see
  // waitForGatewayReady's failure path, which surfaces a clear error
  // rather than hanging silently if the port turns out to be taken.
  return 20000 + Math.floor(Math.random() * 10000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function startGateway(runPaths: RunPaths, env: Record<string, string>, port: number): ChildProcess {
  // stdio MUST resolve to real file descriptors here, not "pipe" left
  // unconsumed — a long-lived, verbose gateway process fills an unread
  // pipe buffer and then blocks on write(), which in turn stops it from
  // ever responding to kill() and hangs stopGateway() indefinitely
  // (reproduced empirically: a real run left the child unkillable for the
  // full test timeout). Logging to a real file avoids that entirely and
  // is useful for debugging a run that didn't behave as expected.
  const logFd = openSync(join(runPaths.runDir, "gateway.log"), "a");
  return spawn(process.execPath, [OPENCLAW_ENTRY, "gateway", "run", "--port", String(port), "--auth", "none", "--bind", "loopback"], {
    env: isolatedEnv(runPaths, env),
    stdio: ["ignore", logFd, logFd],
  });
}

export async function waitForGatewayReady(runPaths: RunPaths, env: Record<string, string>, port: number, timeoutMs = GATEWAY_READY_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = spawnSync(process.execPath, [OPENCLAW_ENTRY, "gateway", "health", "--port", String(port)], {
      env: isolatedEnv(runPaths, env),
      encoding: "utf8",
      timeout: GATEWAY_HEALTH_CHECK_TIMEOUT_MS,
    });
    if (result.status === 0) return;
    await sleep(GATEWAY_READY_POLL_MS);
  }
  throw new Error(`gateway on port ${port} did not become healthy within ${timeoutMs}ms`);
}

// Windows has no real POSIX signals — child.kill() terminates the process
// directly. In practice (reproduced repeatedly), the underlying OS process
// does die promptly, but this ChildProcess handle's own "exit" event does
// not reliably fire in time to be awaited for this specific process tree
// (gateway.mjs, invoked as `node openclaw.mjs gateway run ...`), not a
// sign the process is still alive. So this polls two independent signals
// of death — Node's own exitCode/signalCode, and (on Windows) whether the
// PID still appears in `tasklist` at all — and resolves `stopped: true` as
// soon as either confirms it, rather than trusting only the "exit" event.
export async function stopGateway(proc: ChildProcess): Promise<{ stopped: boolean }> {
  if (proc.exitCode !== null || proc.signalCode !== null) return { stopped: true };
  const pid = proc.pid;
  const isAliveOnWindows = (): boolean => {
    if (process.platform !== "win32" || !pid) return false;
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5_000 });
    return typeof result.stdout === "string" && result.stdout.includes(String(pid));
  };
  const isDead = () => proc.exitCode !== null || proc.signalCode !== null || !isAliveOnWindows();

  proc.kill();
  const graceDeadline = Date.now() + GATEWAY_STOP_GRACE_MS;
  while (Date.now() < graceDeadline) {
    if (isDead()) return { stopped: true };
    await sleep(500);
  }

  proc.kill("SIGKILL");
  const finalDeadline = Date.now() + 15_000;
  while (Date.now() < finalDeadline) {
    if (isDead()) return { stopped: true };
    await sleep(500);
  }
  return { stopped: isDead() };
}

// One A2A JSON-RPC call — same protocol as tools/mobile-chat-poc/client.mjs's
// callJsonRpc(), reimplemented here rather than imported so this package
// doesn't take a cross-tool-directory runtime dependency on a POC script;
// keep the two in sync if the A2A wire contract changes.
async function callA2A(url: string, token: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  const json = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown }; result?: unknown } | null;
  if (!json) throw new Error(`A2A: non-JSON response (HTTP ${res.status})`);
  if (json.error) throw new Error(`A2A error ${json.error.code ?? "?"}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

type A2ATask = { id?: string; contextId?: string; status?: { state?: string; message?: unknown }; artifacts?: Array<{ parts?: Array<{ text?: string }> }> };

async function pollA2ATaskUntilSettled(url: string, token: string, taskId: string, timeoutMs: number): Promise<A2ATask> {
  const settled = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = (await callA2A(url, token, "GetTask", { id: taskId })) as { task?: A2ATask } | undefined;
    const state = result?.task?.status?.state;
    if (state && settled.has(state)) return result!.task!;
    if (Date.now() > deadline) throw new Error(`A2A task ${taskId} did not settle within ${timeoutMs}ms (last state: ${state})`);
    await sleep(1_000);
  }
}

export function extractTaskText(task: A2ATask | undefined): string {
  const parts = (task?.artifacts ?? []).flatMap((a) => a.parts ?? []);
  return parts
    .filter((p): p is { text: string } => typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text)
    .join("\n");
}

// Known gap (found via test/driver-smoke.test.ts's real run): a provider
// auth/request failure is NOT surfaced as TASK_STATE_FAILED/REJECTED —
// OpenClaw catches it upstream and returns an ordinary TASK_STATE_COMPLETED
// task whose reply text is its own synthesized warning (e.g. "⚠️ ...
// request failed (authentication failed, HTTP 400)..."). This function
// only catches the task-state case; a mid-run provider failure during a
// real calibration run currently reads as odd-looking assistant text, not
// a detected error — evaluate.ts/report.ts have no special handling for
// it yet. Future work: recognize the "⚠️ ... request failed" shape too.
export function taskFailure(task: A2ATask | undefined): string | undefined {
  const state = task?.status?.state;
  if (state === "TASK_STATE_FAILED" || state === "TASK_STATE_REJECTED") {
    return `A2A task ${state}${task?.status?.message ? `: ${JSON.stringify(task.status.message)}` : ""}`;
  }
  return undefined;
}

// Sends one chat turn over A2A and returns once the task settles (blocking
// SendMessage — the default tools/mobile-chat-poc/client.mjs also uses —
// rather than returnImmediately+poll). See that POC's README for the
// "Blocking vs returnImmediately" tradeoff this mirrors.
export async function sendA2ATurn(params: { url: string; token: string; text: string; contextId?: string; timeoutMs: number }): Promise<{ text: string; contextId?: string; taskId?: string; error?: string }> {
  const { url, token, text, contextId, timeoutMs } = params;
  const sendParams: Record<string, unknown> = { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] } };
  if (contextId) sendParams.contextId = contextId;
  const result = (await callA2A(url, token, "SendMessage", sendParams)) as { task?: A2ATask } | undefined;
  let task = result?.task;
  if (!task) throw new Error("A2A SendMessage response had no task");
  if (task.status?.state === "TASK_STATE_WORKING") task = await pollA2ATaskUntilSettled(url, token, task.id!, timeoutMs);
  return { text: extractTaskText(task), contextId: task.contextId ?? contextId, taskId: task.id, error: taskFailure(task) };
}

export async function runComparisonRun(params: {
  scenario: Scenario;
  branch: Branch;
  userProfile: UserProfile;
  runId: string;
  runsRoot: string;
  taskModel: string;
  taskModelDefinition?: TaskModelDefinition;
  analysis?: AnalysisModelConfig;
  env: Record<string, string>;
  turnTimeoutMs?: number;
}): Promise<{ runPaths: RunPaths; turnLog: DriverTurnLog }> {
  const { scenario, branch, userProfile, runId, runsRoot, taskModel, taskModelDefinition, analysis, env, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS } = params;
  const gatewayPort = pickGatewayPort();
  const runPaths = buildRun({ scenario, branch, runId, runsRoot, taskModel, taskModelEnv: env, taskModelDefinition, analysis, gatewayPort });
  // The A2A session's actual sessionKey (what NanCy correlates confirmations
  // against) is Gateway-assigned from the peer/context, not something this
  // driver picks — recorded into the turn log for cross-referencing against
  // nancy.log once a run completes, not used to address anything directly.
  const sessionKeyHint = `agent:test-agent:a2a:${A2A_PEER_ID}`;
  const a2aToken = randomBytes(24).toString("hex");
  const a2aUrl = `http://127.0.0.1:${gatewayPort}/a2a/v1`;

  const turnLog: DriverTurnLog = {
    scenarioId: scenario.id,
    branch,
    userProfile,
    runId,
    sessionKey: sessionKeyHint,
    startedAt: new Date().toISOString(),
    userTurns: [],
    assistantTurns: [],
    stopReason: "user_simulator_exhausted",
  };

  const gatewayProc = startGateway(runPaths, { ...env, [A2A_TOKEN_ENV_VAR]: a2aToken }, gatewayPort);

  const startedAt = Date.now();
  let pendingMessage = scenario.initialRequest;
  let pendingRevealedBudget: number | undefined;
  let alreadyRevealedBudget = false;
  let turnIndex = 0;
  let stopReason: DriverTurnLog["stopReason"] = "user_simulator_exhausted";
  let contextId: string | undefined;

  try {
    await waitForGatewayReady(runPaths, { ...env, [A2A_TOKEN_ENV_VAR]: a2aToken }, gatewayPort);

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

      let turnResult: Awaited<ReturnType<typeof sendA2ATurn>>;
      try {
        turnResult = await sendA2ATurn({ url: a2aUrl, token: a2aToken, text: pendingMessage, contextId, timeoutMs: turnTimeoutMs });
      } catch (err) {
        turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: { a2aError: String(err) }, assistantText: "" });
        stopReason = "cli_error";
        break;
      }
      contextId = turnResult.contextId ?? contextId;

      if (turnResult.error) {
        turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: { taskId: turnResult.taskId, error: turnResult.error }, assistantText: "" });
        stopReason = "cli_error";
        break;
      }

      const assistantText = turnResult.text;
      turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: { taskId: turnResult.taskId, contextId }, assistantText });

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
  } catch (err) {
    turnLog.assistantTurns.push({ turnIndex, ts: new Date().toISOString(), rawJson: { gatewayError: String(err) }, assistantText: "" });
    stopReason = "cli_error";
  } finally {
    const { stopped } = await stopGateway(gatewayProc);
    if (!stopped) console.warn(`[comparator] gateway process (pid ${gatewayProc.pid}) on port ${gatewayPort} may still be running — check it manually.`);
  }

  turnLog.endedAt = new Date().toISOString();
  turnLog.stopReason = stopReason;
  writeFileSync(runPaths.turnLogPath, JSON.stringify(turnLog, null, 2));
  return { runPaths, turnLog };
}
