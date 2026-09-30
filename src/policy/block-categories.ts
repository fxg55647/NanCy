// User-facing block categories. Every denial site in index.ts already records
// a stable reasonCode (see denial-policy.ts); this maps each one to a small,
// fixed set of categories so the person reading the block — the agent's own
// reply, a Telegram alert, or the log — can tell "unsafe" apart from
// "ambiguous", "reviewer failed", and "policy forbids".
//
// The mapping is deterministic and lives in trusted code. It never depends on
// reviewer output, so a category can't be steered by the content under review.
// test/block-categories.test.ts fails if a reasonCode used in src/ is missing
// from this table.

export type BlockCategory =
  | "review_blocked"
  | "no_task"
  | "destination"
  | "policy"
  | "clarify"
  | "reviewer_unavailable"
  | "rate_limit"
  | "session_terminated"
  | "session_changed"
  | "invalid_request"
  | "test_mode";

export const BLOCK_CATEGORY_LABELS: Record<BlockCategory, string> = {
  review_blocked: "BLOCKED — security review: outside confirmed task or policy",
  no_task: "BLOCKED — no confirmed task",
  destination: "BLOCKED — destination not authorized",
  policy: "BLOCKED — standing policy violation",
  clarify: "BLOCKED — clarification required",
  reviewer_unavailable: "BLOCKED — reviewer unavailable (not a security finding)",
  rate_limit: "BLOCKED — rate limit reached",
  session_terminated: "BLOCKED — session terminated",
  session_changed: "BLOCKED — session changed during review",
  invalid_request: "BLOCKED — invalid confirmation request",
  // Test-mode reasons already start with their own "[TEST MODE]" marker.
  test_mode: "",
};

export const REASON_CODE_CATEGORIES: Record<string, BlockCategory> = {
  // Reviewer BLOCK verdicts. Phase 1 cannot yet tell "outside the task" from
  // "policy violation" here — the reviewer's single verdict covers both.
  blocked: "review_blocked",
  message_blocked: "review_blocked",
  blocked_context: "review_blocked",
  confirmation_message_blocked: "review_blocked",

  blocked_no_confirmed_task: "no_task",
  worker_no_task_reject: "no_task",
  blocked_main_session: "no_task",
  blocked_cron_session: "no_task",
  message_blocked_cron: "no_task",
  message_blocked_no_confirmed_task: "no_task",

  blocked_destination: "destination",
  message_blocked_destination: "destination",
  domain_blocked: "destination",

  blocked_protected_write: "policy",
  blocked_secret_file_access: "policy",

  blocked_clarify: "clarify",
  message_blocked_clarify: "clarify",
  blocked_context_clarify: "clarify",

  blocked_analysis_error: "reviewer_unavailable",
  blocked_no_analysis: "reviewer_unavailable",
  blocked_context_error: "reviewer_unavailable",
  message_analysis_error: "reviewer_unavailable",
  message_blocked_no_analysis: "reviewer_unavailable",
  confirmation_review_error: "reviewer_unavailable",
  confirmation_blocked_no_analysis: "reviewer_unavailable",
  reviewer_malformed: "reviewer_unavailable",

  blocked_info_lookup_rate_limit: "rate_limit",

  blocked_terminated: "session_terminated",
  message_blocked_terminated: "session_terminated",

  blocked_stale_authorization: "session_changed",
  message_blocked_stale_authorization: "session_changed",
  confirmation_blocked_stale_session: "session_changed",
  confirmation_blocked_no_session: "session_changed",

  malformed_confirmation_attempt: "invalid_request",
  confirmation_description_empty: "invalid_request",
  confirmation_duplicate_id: "invalid_request",

  test_mode_would_allow: "test_mode",
  test_mode_would_send_message: "test_mode",
};

export function blockCategory(reasonCode: string): BlockCategory {
  // An unmapped code is a bug caught by the test suite; at runtime it still
  // gets the most neutral security label rather than none.
  return REASON_CODE_CATEGORIES[reasonCode] ?? "review_blocked";
}

// First line: the fixed category label. Second line: the site-specific
// detail (for reviewer verdicts, the reviewer's own one-sentence reason).
export function formatBlockReason(reasonCode: string, detail: string): string {
  const label = BLOCK_CATEGORY_LABELS[blockCategory(reasonCode)];
  if (!label) return detail;
  return `${label}\n${detail}\n(Agent: relay the first line above to the user verbatim.)`;
}

// Short prefix for Telegram alerts and console lines.
export function blockLabel(reasonCode: string): string {
  return BLOCK_CATEGORY_LABELS[blockCategory(reasonCode)] || "TEST MODE";
}
