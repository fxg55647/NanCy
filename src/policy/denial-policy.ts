import type { NancyConfig } from "../config.ts";
import type { LogIds } from "../logging/logger.ts";
import { logDecision } from "../logging/logger.ts";
import type { TelegramNotifier } from "../notifications/telegram.ts";
import type { SessionState } from "../state.ts";

export interface DenialRecord {
  reasonCode: string;
  securitySignal: boolean;
  ts: string;
  ids: LogIds;
}

export interface DenialRecorderDeps {
  nancyConfig: NancyConfig;
  logFile: string;
  state: SessionState;
  notifier: TelegramNotifier;
  requestMacroReview: (sessionKey: string) => void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.max(1, Math.round(value!)) : fallback;
}

// Normalizes all block/cancel paths into stable reason codes and maintains
// the deterministic per-session counters. Existing detailed decision events
// remain in index.ts; this adds one common audit shape across those paths.
export function createDenialRecorder(deps: DenialRecorderDeps) {
  const { nancyConfig, logFile, state, notifier, requestMacroReview } = deps;

  function recordDenial(sessionKey: string, denial: DenialRecord): void {
    state.pushRecentDenial(sessionKey, { ts: denial.ts, reasonCode: denial.reasonCode });
    // Concurrent hooks may have passed their initial stop check before a
    // sibling denial crossed the threshold. Never increment or alert twice.
    if (state.terminatedSessions.get(sessionKey)) {
      logDecision(logFile, denial.ts, "session_blocked_after_stop", denial.ids, {
        reasonCode: denial.reasonCode,
        stopKind: "security_terminated",
      });
      return;
    }

    // testMode deliberately turns every action into a dry-run denial. Even a
    // real reviewer BLOCK there is test evidence, not a reason to terminate
    // the harness session and distort later scenarios.
    if (!denial.securitySignal || nancyConfig.testMode) {
      logDecision(logFile, denial.ts, "denial_recorded", denial.ids, {
        reasonCode: denial.reasonCode,
        securitySignal: false,
        testMode: nancyConfig.testMode || undefined,
      });
      return;
    }

    const total = (state.securityDenialsTotal.get(sessionKey) ?? 0) + 1;
    const burst = (state.securityDenialsBurst.get(sessionKey) ?? 0) + 1;
    state.securityDenialsTotal.set(sessionKey, total);
    state.securityDenialsBurst.set(sessionKey, burst);
    logDecision(logFile, denial.ts, "denial_recorded", denial.ids, {
      reasonCode: denial.reasonCode,
      securitySignal: true,
      total,
      burst,
    });

    const hardLimit = positiveInteger(nancyConfig.limits?.hardTerminateThreshold, 20);
    if (total >= hardLimit) {
      state.terminatedSessions.set(sessionKey, true);
      logDecision(logFile, denial.ts, "hard_terminated", denial.ids, {
        reasonCode: denial.reasonCode,
        count: total,
        threshold: hardLimit,
      });
      notifier.notifyHardTermination(`Session: \`${sessionKey}\`\nCount: ${total}/${hardLimit}\nLast reason: ${denial.reasonCode}`);
      return;
    }

    const burstLimit = positiveInteger(nancyConfig.macroReview?.blockBurstThreshold, 3);
    if (burst >= burstLimit) {
      state.securityDenialsBurst.set(sessionKey, 0);
      state.callCounters.set(sessionKey, 0);
      state.macroReviewThresholds.delete(sessionKey);
      logDecision(logFile, denial.ts, "macro_review_requested_by_denial_burst", denial.ids, {
        reasonCode: denial.reasonCode,
        burst,
        threshold: burstLimit,
      });
      requestMacroReview(sessionKey);
    }
  }

  return { recordDenial };
}

export type DenialRecorder = ReturnType<typeof createDenialRecorder>;
