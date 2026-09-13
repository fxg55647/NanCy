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
  // Deterministic runtime-scoped backstop for repeated security denials.
  // These deliberately do not depend on an LLM verdict beyond the stable
  // classification made at each denial site in index.ts.
  const securityDenialsTotal = new Map<string, number>();
  const securityDenialsBurst = new Map<string, number>();
  // Calls since the last macro-review for this session; reset to 0 each time
  // a review fires (see macroReviewThresholds below).
  const callCounters = new Map<string, number>();
  // The callCounters value that triggers the next macro-review, drawn fresh
  // (via pickNextMacroReviewInterval) whenever it's unset or just consumed —
  // fixed mode always redraws the same number, random mode doesn't.
  const macroReviewThresholds = new Map<string, number>();
  // Serialize macro-reviews per session. A request arriving while one is in
  // flight is coalesced into one follow-up review over the latest history.
  const macroReviewInFlight = new Set<string>();
  const macroReviewPending = new Set<string>();
  const lastActivityMs = new Map<string, number>();
  // Deterministic backstop for allowUnconfirmedInfoLookups (see config.ts),
  // independent of the reviewer's own judgment — fixed rolling window per
  // session, reset once the window elapses rather than a true sliding window
  // (simpler, and the exact boundary doesn't matter for a soft cap like this).
  const infoLookupWindowBySession = new Map<string, { windowStart: number; count: number }>();

  function touchActivity(sessionKey: string): void {
    lastActivityMs.set(sessionKey, Date.now());
  }

  function consumeInfoLookupQuota(sessionKey: string | undefined, limit: number, windowMs: number): boolean {
    const key = sessionKey ?? UNKNOWN_SESSION_KEY;
    const now = Date.now();
    let entry = infoLookupWindowBySession.get(key);
    // A fresh/expired window used to be seeded with count:1 and an
    // unconditional `return true`, so limit:0 never actually took effect on
    // the very first call of a new window — only a *second* call in the
    // same window would see count (1) >= limit (0) and get refused. Seed at
    // count:0 and let the single check below decide every call, including
    // the first one in a brand-new window.
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      infoLookupWindowBySession.set(key, entry);
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
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
    macroReviewThresholds.delete(key);
    terminatedSessions.delete(key);
    securityDenialsTotal.delete(key);
    securityDenialsBurst.delete(key);
    macroReviewInFlight.delete(key);
    macroReviewPending.delete(key);
    lastActivityMs.delete(key);
    sessionTriggerByKey.delete(key);
    infoLookupWindowBySession.delete(key);
  }

  return {
    sessionTriggerByKey,
    terminatedSessions,
    securityDenialsTotal,
    securityDenialsBurst,
    callCounters,
    macroReviewThresholds,
    macroReviewInFlight,
    macroReviewPending,
    lastActivityMs,
    touchActivity,
    isCronTrigger,
    pushRecentCall,
    pushRecentReasoning,
    getRecentCalls,
    getRecentReasoning,
    consumeInfoLookupQuota,
    clearSession,
  };
}

export type SessionState = ReturnType<typeof createSessionState>;
