// Rolling buffers of tool calls and reasoning, keyed by sessionKey so one
// session's history never leaks into another session's Intent Anchoring
// prompt (they used to be flat, session-unaware arrays — a real bug when
// more than one session is active against the same gateway). Events with
// no sessionKey (message_sending/message_received never carry one) share
// a single "unknown" bucket, matching the pre-existing single-session
// assumption for those hooks only.
export const UNKNOWN_SESSION_KEY = "unknown";

export type RecentCall = { ts: string; toolName: string; params: unknown };
export type RecentReasoning = { ts: string; text: string };

export function createSessionState() {
  const recentCallsBySession = new Map<string, RecentCall[]>();
  const recentReasoningBySession = new Map<string, RecentReasoning[]>();

  // Cron-run correlation, keyed by sessionKey. before_tool_call's ctx
  // (PluginHookToolContext) and message_sending's ctx (PluginHookMessageContext)
  // never carry a `trigger` field — verified against openclaw@2026.9.4's
  // compiled hook-context builders (buildToolContext in
  // agent-tools.before-tool-call, toPluginMessageContext in
  // message-hook-mappers): both allowlist their fields explicitly and neither
  // copies `trigger` through, even though the richer internal HookContext has
  // it. `llm_output`'s ctx (PluginHookAgentContext), by contrast, is built via
  // buildAgentHookContext, which does forward `trigger` — so it's captured
  // there and looked up here by sessionKey when gating tool calls.
  const sessionTriggerByKey = new Map<string, string>();

  // Per-session state for the main/worker split and behavioral review.
  const terminatedSessions = new Map<string, boolean>();
  const callCounters = new Map<string, number>();
  const lastActivityMs = new Map<string, number>();

  function touchActivity(sessionKey: string): void {
    lastActivityMs.set(sessionKey, Date.now());
  }

  function isCronTrigger(sessionKey: string | undefined): boolean {
    if (!sessionKey) return false;
    return sessionTriggerByKey.get(sessionKey) === "cron";
  }

  function pushRecentCall(sessionKey: string | undefined, entry: RecentCall): void {
    const key = sessionKey ?? UNKNOWN_SESSION_KEY;
    const arr = recentCallsBySession.get(key) ?? [];
    arr.push(entry);
    if (arr.length > 20) arr.shift();
    recentCallsBySession.set(key, arr);
  }

  function pushRecentReasoning(sessionKey: string | undefined, entry: RecentReasoning): void {
    const key = sessionKey ?? UNKNOWN_SESSION_KEY;
    const arr = recentReasoningBySession.get(key) ?? [];
    arr.push(entry);
    if (arr.length > 3) arr.shift();
    recentReasoningBySession.set(key, arr);
  }

  function getRecentCalls(sessionKey: string | undefined): RecentCall[] {
    return recentCallsBySession.get(sessionKey ?? UNKNOWN_SESSION_KEY) ?? [];
  }

  function getRecentReasoning(sessionKey: string | undefined): RecentReasoning[] {
    return recentReasoningBySession.get(sessionKey ?? UNKNOWN_SESSION_KEY) ?? [];
  }

  // Without this, recentCallsBySession/recentReasoningBySession would grow
  // one entry per sessionKey forever on a long-running gateway that sees
  // many short-lived sessions — a real (if slow) memory leak. Also clears
  // this session's macro-review/termination/idle-activity state for the
  // same reason.
  function clearSession(sessionKey: string | undefined): void {
    const key = sessionKey ?? UNKNOWN_SESSION_KEY;
    recentCallsBySession.delete(key);
    recentReasoningBySession.delete(key);
    callCounters.delete(key);
    terminatedSessions.delete(key);
    lastActivityMs.delete(key);
    sessionTriggerByKey.delete(key);
  }

  return {
    sessionTriggerByKey,
    terminatedSessions,
    callCounters,
    lastActivityMs,
    touchActivity,
    isCronTrigger,
    pushRecentCall,
    pushRecentReasoning,
    getRecentCalls,
    getRecentReasoning,
    clearSession,
  };
}

export type SessionState = ReturnType<typeof createSessionState>;
