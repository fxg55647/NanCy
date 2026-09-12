import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { ConfirmedTask, TaskAuthorization } from "../confirmation/tasks.ts";
import type { AgentPaths } from "../policy/protected-paths.ts";
import type { TelegramNotifier } from "../notifications/telegram.ts";
import { truncateForTelegram } from "../notifications/telegram.ts";
import type { NancyConfig } from "../config.ts";

// Minimal shape of the subagent runtime NanCy needs to spawn and clean up
// worker sessions. Cast from api.runtime, which doesn't type this publicly.
export type SubagentRuntime = {
  run: (p: { sessionKey: string; message: string; idempotencyKey?: string }) => Promise<{ runId: string }>;
  waitForRun: (p: { runId: string; timeoutMs?: number }) => Promise<{
    status: "ok" | "error" | "timeout" | "pending";
    error?: string;
    // Present when the worker's own agent turn produced a normal visible
    // reply — its actual final text, not just a status code. Absent (or a
    // non-"visible" disposition) when the run ended silently, empty, or via
    // an error path instead.
    terminalReply?: { disposition: "visible"; text: string } | { disposition: "silent" | "empty" };
  }>;
  deleteSession: (p: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void>;
};

// waitForRun is re-issued up to this many times (each with its own
// timeoutMs budget) before NanCy gives up waiting — see the "timeout"/
// "pending" handling below. Total worst-case wait: WORKER_WAIT_TIMEOUT_MS
// * WORKER_MAX_WAIT_ATTEMPTS.
const WORKER_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const WORKER_MAX_WAIT_ATTEMPTS = 3;

export interface WorkerManagerDeps {
  nancyConfig: NancyConfig;
  logFile: string;
  getAgentPaths: (agentId?: string) => AgentPaths;
  taskAuth: TaskAuthorization;
  notifier: TelegramNotifier;
  getSubagentRuntime: () => SubagentRuntime;
}

export function createWorkerManager(deps: WorkerManagerDeps) {
  const { nancyConfig, logFile, getAgentPaths, taskAuth, notifier, getSubagentRuntime } = deps;

  // Spawns an isolated worker session to execute a freshly confirmed task,
  // then deletes that session once the run finishes so its transcript can't
  // accumulate context across tasks (each task gets a clean session).
  async function spawnWorkerForTask(task: ConfirmedTask): Promise<void> {
    if (!nancyConfig.workerAgentId) return;
    const taskId = task.id;
    const workerSessionKey = `agent:${nancyConfig.workerAgentId}:task-${taskId}`;

    // ${taskId}.json is written purely as an on-disk audit record — it is
    // NOT what grants the worker its authorization (see taskAuth). If even
    // that record can't be written, treat the environment as unreliable
    // enough that the worker must not run at all rather than executing with
    // an authorization NanCy couldn't durably account for.
    try {
      const workerPaths = getAgentPaths(nancyConfig.workerAgentId);
      mkdirSync(workerPaths.TASKS_DIR, { recursive: true });
      writeFileSync(join(workerPaths.TASKS_DIR, `${taskId}.json`), JSON.stringify(task, null, 2));
    } catch (err) {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_task_copy_error", taskId, error: String(err) }) + "\n");
      console.warn(`[nancy] ⚠️  Failed to write task record for ${taskId} — refusing to spawn a worker for it: ${String(err)}`);
      return;
    }

    // Grant authorization to this exact session BEFORE spawning it, so
    // there is no window where the worker session exists but its first
    // before_tool_call would find no confirmed task yet.
    taskAuth.grantTask(workerSessionKey, task);

    try {
      const subagent = getSubagentRuntime();
      const result = await subagent.run({
        sessionKey: workerSessionKey,
        message: `Execute this confirmed task:\n\n${task.description}\n\nTask ID: ${taskId}`,
        idempotencyKey: taskId,
      });
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_spawned", taskId, runId: result.runId, workerSessionKey }) + "\n");
      console.log(`[nancy] ✓ Worker spawned for task ${taskId} → runId ${result.runId}`);

      (async () => {
        // waitForRun returning "timeout" (or "pending") means the wait call
        // itself gave up — it says nothing about whether the worker's run
        // actually finished. Treating it as done and immediately deleting
        // the session would tear down a run that's still genuinely in
        // progress. There's no cancel/stop call on SubagentRuntime, so the
        // only safe options are to keep waiting or to leave the session
        // alone — never to clean up on the strength of a timeout alone.
        let waitResult = await subagent.waitForRun({ runId: result.runId, timeoutMs: WORKER_WAIT_TIMEOUT_MS });
        let attempt = 1;
        while ((waitResult.status === "timeout" || waitResult.status === "pending") && attempt < WORKER_MAX_WAIT_ATTEMPTS) {
          attempt++;
          appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_wait_retry", taskId, runId: result.runId, status: waitResult.status, attempt }) + "\n");
          waitResult = await subagent.waitForRun({ runId: result.runId, timeoutMs: WORKER_WAIT_TIMEOUT_MS });
        }

        appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_done", taskId, runId: result.runId, status: waitResult.status, attempts: attempt }) + "\n");

        if (waitResult.status !== "ok" && waitResult.status !== "error") {
          // Still not finished after WORKER_MAX_WAIT_ATTEMPTS rounds of
          // waiting — leave the worker session in place rather than
          // deleting it out from under a run that may still be executing.
          // Its task authorization stays live too, for the same reason:
          // the worker may still legitimately be mid-task, and revoking it
          // now would make its very next before_tool_call see no confirmed
          // task at all and get blocked outright.
          console.warn(`[nancy] ⚠️  worker for task ${taskId} did not finish after extended waiting (status=${waitResult.status}) — leaving session ${workerSessionKey} in place, skipping cleanup`);
          appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_wait_exhausted", taskId, runId: result.runId, status: waitResult.status, workerSessionKey }) + "\n");
          return;
        }

        if (notifier.taskReportsEnabled) {
          const ok = waitResult.status === "ok";
          const reply = waitResult.terminalReply;
          const replyText = reply && reply.disposition === "visible" ? reply.text : null;
          const lines = [
            `${ok ? "✅" : "❌"} *NanCy: confirmed task ${ok ? "finished" : "failed"}*`,
            `Task: ${truncateForTelegram(task.description, 300)}`,
          ];
          if (!ok && waitResult.error) lines.push(`Error: ${truncateForTelegram(waitResult.error, 300)}`);
          lines.push(replyText ? truncateForTelegram(replyText, 3000) : "(worker produced no visible final reply)");
          notifier.sendAlert(lines.join("\n\n"));
        }

        try {
          await subagent.deleteSession({ sessionKey: workerSessionKey, deleteTranscript: false });
          appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_session_deleted", taskId, workerSessionKey }) + "\n");
          console.log(`[nancy] ✓ Worker session cleaned up for task ${taskId}`);
        } catch (err) {
          appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_cleanup_error", taskId, error: String(err) }) + "\n");
        } finally {
          // The run itself has already concluded (ok/error) by this point
          // regardless of whether deleteSession succeeded — nothing should
          // be able to reuse this task's authorization afterward, whether
          // via a fresh session that happens to reuse workerSessionKey or
          // otherwise (see the "later new session" regression test).
          taskAuth.revokeTask(workerSessionKey);
        }
      })().catch((err: unknown) => {
        appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_cleanup_error", taskId, error: String(err) }) + "\n");
        taskAuth.revokeTask(workerSessionKey);
      });
    } catch (err) {
      // subagent.run() itself threw — the worker session never really
      // started, so nothing should remain authorized under its key.
      taskAuth.revokeTask(workerSessionKey);
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "worker_spawn_error", taskId, error: String(err) }) + "\n");
      console.warn(`[nancy] ⚠️  Failed to spawn worker for task ${taskId}: ${err}`);
    }
  }

  return { spawnWorkerForTask };
}
