import { appendFileSync, renameSync, statSync } from "fs";

// Single-generation rotation: renames the file aside once it crosses the size
// cap. Called at gateway_start rather than per-write, so it doesn't add a
// stat() call to every single log line on a busy gateway.
const MAX_LOG_BYTES = 20 * 1024 * 1024;
export function rotateLogIfLarge(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch { /* file doesn't exist yet — nothing to rotate */ }
}

// Every decision/log line below is tagged with these four correlation ids —
// without them, a busy gateway running multiple sessions/workers concurrently
// makes it impossible to tell which call a given block or verdict belonged to.
// sessionKey/runId/toolCallId come from the hook's own ctx/event (undefined
// where the hook type doesn't carry one, e.g. runId on message_sending);
// taskId is the currently-confirmed task, if any (see getCurrentTask).
export type LogIds = { sessionKey?: string; runId?: string; toolCallId?: string; taskId?: string };
export function logDecision(file: string, ts: string, event: string, ids: LogIds, extra: Record<string, unknown> = {}): void {
  appendFileSync(file, JSON.stringify({ ts, event, ...ids, ...extra }) + "\n");
}
