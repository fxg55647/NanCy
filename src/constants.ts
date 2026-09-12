// Applied to every outbound fetch below so a hung/slow third-party response
// can't stall before_tool_call (and therefore the agent) indefinitely.
export const FETCH_TIMEOUT_MS = 15_000;
export const LLM_FETCH_TIMEOUT_MS = 30_000;
