// Merges three independent sources into one timeline per run, per
// docs/architecture/behavior-comparator.md's correlation rationale: the
// recorder's own checkpoint captures, NanCy's own nancy.log/
// nancy-analysis.log (authoritative for NanCy's actual verdicts/
// blockReasons — the recorder alone never sees another plugin's hook
// result), and the driver's own record of every user-simulator turn.
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { DriverTurnLog, RunPaths } from "./types.ts";

export type TimelineEvent = {
  ts: string;
  source: "driver" | "recorder" | "nancy-log" | "nancy-analysis";
  type: string;
  data: unknown;
};

function findFilesRecursive(dir: string, pattern: RegExp): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFilesRecursive(full, pattern));
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

export function buildTimeline(runPaths: RunPaths, turnLog: DriverTurnLog): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const t of turnLog.userTurns) events.push({ ts: t.ts, source: "driver", type: "user_turn", data: t });
  for (const t of turnLog.assistantTurns) events.push({ ts: t.ts, source: "driver", type: "assistant_turn", data: t });

  if (existsSync(runPaths.recorderOutputDir)) {
    for (const f of readdirSync(runPaths.recorderOutputDir)) {
      if (!f.endsWith(".json")) continue;
      const full = join(runPaths.recorderOutputDir, f);
      try {
        const cp = JSON.parse(readFileSync(full, "utf8")) as { capturedAt?: string };
        events.push({ ts: cp.capturedAt ?? statSync(full).mtime.toISOString(), source: "recorder", type: "checkpoint", data: cp });
      } catch {
        // Skip a malformed/partial capture rather than aborting the whole run's report.
      }
    }
  }

  // NanCy's own logs — searched recursively under the run directory rather
  // than assumed at one fixed path, since this harness has not empirically
  // confirmed where OpenClaw resolves `api.rootDir` to under an isolated
  // OPENCLAW_STATE_DIR (see config-builder.ts's nancyLogDir comment).
  for (const logPath of findFilesRecursive(runPaths.runDir, /^nancy(-analysis)?\.log$/)) {
    const isAnalysis = /nancy-analysis\.log$/.test(logPath);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts?: string; event?: string };
        events.push({ ts: entry.ts ?? turnLog.startedAt, source: isAnalysis ? "nancy-analysis" : "nancy-log", type: entry.event ?? "unknown", data: entry });
      } catch {
        // Skip a malformed log line rather than aborting the whole run's report.
      }
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}
