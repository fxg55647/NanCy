export interface AnalysisConfig {
  provider: "gemini" | "openai" | "openai-compat" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
  debateMode?: "off" | "always" | "clarify" | "hybrid";
}

export interface MacroReviewConfig {
  // "fixed": review every `interval` calls, exactly (default). "random": draw
  // a new interval from a triangular distribution (randomMin..randomMax,
  // peaking at randomMode) after every review, so the cadence can't be timed
  // around by whatever is driving the agent.
  mode?: "fixed" | "random";
  interval?: number;
  randomMin?: number;
  randomMax?: number;
  randomMode?: number;
  // Consecutive counted security denials that request an early behavioral
  // review. Default 3.
  blockBurstThreshold?: number;
}

export interface LimitsConfig {
  // Counted security denials in one session during this gateway runtime
  // before trusted code terminates that session. Default 20.
  hardTerminateThreshold?: number;
}

export interface DomainConfig {
  allow?: string[];
  deny?: string[];
  reputationCheck?: boolean;
  minAgeDays?: number;
  urlhausAuthKey?: string;
}

export interface ArweaveAnchoringConfig {
  // Explicit opt-in. No wallet is read and no network call is made otherwise.
  enabled?: boolean;
  // Publish at most one changed manifest this often. Default 15 minutes.
  intervalMinutes?: number;
  // Standard gateway by default. HTTP is accepted only for loopback localnets.
  gatewayUrl?: string;
  // Prefer an env SecretInput, for example
  // { source: "env", id: "NANCY_ARWEAVE_WALLET_JWK" }. The resolved value
  // must be the complete private JWK JSON string.
  walletJwk?: unknown;
  // Alternative absolute path to a private JWK file. Keep it outside every
  // agent workspace and protect it with OS permissions.
  walletJwkPath?: string;
  // Include NanCy-owned tasks/*.json confirmation audit records. Default true.
  includeTaskRecords?: boolean;
  // Request an anchor after gateway startup / before shutdown. Both default true.
  anchorOnStartup?: boolean;
  anchorOnShutdown?: boolean;
  // Do not extend the chain until the gateway reports the previous
  // transaction mined. Default true.
  requirePreviousConfirmation?: boolean;
}

export interface NancyConfig {
  analysis?: AnalysisConfig;
  browser?: {
    port?: number;
    token?: string;
  };
  domains?: DomainConfig;
  // Optional permanent integrity anchors for logs, protected control files,
  // source code and task audit records. Only hashes and bounded metadata are
  // published; never the file contents or wallet key.
  arweaveAnchoring?: ArweaveAnchoringConfig;
  // Cadence of the periodic behavioral review (macro-review, feature #9).
  // Unset = fixed every 10 calls.
  macroReview?: MacroReviewConfig;
  // Deterministic limits enforced without asking the reviewer model.
  limits?: LimitsConfig;
  // Session key of the main/chat session. When set, that session is locked to
  // passive reads only (see the MAIN_ALLOWED_TOOLS/isMainGateAllowed default-deny
  // gate below) — real work must go through a confirmed task, which NanCy
  // spawns as an isolated worker session.
  mainSessionKey?: string;
  // Minutes of main-session inactivity after which it's automatically reset.
  mainSessionIdleMinutes?: number;
  // Agent id used to spawn an isolated worker session per confirmed task.
  workerAgentId?: string;
  // Live Telegram push for blocked actions, session termination, and the
  // startup status message. Everything is always fully written to nancy.log
  // / nancy-analysis.log regardless of this setting — it only controls the
  // live phone notification. Default true.
  telegramAlerts?: boolean;
  // Live Telegram push reporting the outcome of every confirmed task once its
  // worker session finishes — success or failure — including the worker's
  // own final reply text when it produced one. Independent of telegramAlerts
  // (which covers blocks/termination/boot status only). Default true.
  telegramTaskReports?: boolean;
  // Test/dry-run mode: every analysis (before_tool_call's context-check and
  // full-verdict, and message_sending's outbound-intent check) still runs and
  // is fully logged exactly as normal, but no tool call ever actually
  // executes and no outbound message is ever actually delivered — a call or
  // message that would have been ALLOWED, or that never needed analysis at
  // all, is hard-blocked/canceled at the last moment instead, with the real
  // verdict/reason recorded in the block message and in
  // nancy.log/nancy-analysis.log. NanCy's fixed-format confirmation request
  // is sent for real so the confirm/deny flow can be exercised, but its
  // description and destination first pass the configured security review.
  // Every other outbound send, including missing/failed analysis, is blocked.
  // Lets a task be run against NanCy end-to-end to see exactly what it would
  // decide. Default false.
  testMode?: boolean;
  // Lets web_search/web_fetch through to the normal semantic reviewer even
  // when no task has been confirmed for the session, judged against a fixed
  // generic "this must be a harmless, read-only information lookup" baseline
  // instead of a real confirmed task (see buildUnconfirmedInfoLookupTask).
  // Deliberately narrower than turning off the confirmed-task requirement in
  // general: every other tool that requires semantic review (write, edit,
  // apply_patch, message, exec, process, interactive browser actions) still
  // hard-blocks outright with no confirmed task, exactly as before — only
  // these two read-only, destination-free tools get this fallback. Domain
  // Border Control and the real reviewer still run on every call either way;
  // this only changes what happens when there is no confirmed task to check
  // against. See unconfirmedInfoLookupLimitPerHour for the deterministic
  // backstop. Default true.
  allowUnconfirmedInfoLookups?: boolean;
  // Deterministic per-session cap on allowUnconfirmedInfoLookups grants per
  // fixed one-hour window, independent of the reviewer's own judgment — a backstop in
  // case the probabilistic reviewer is wrong repeatedly, per
  // SECURITY-PHILOSOPHY.md's "limit how many X can be performed within a
  // given period." Default 10.
  unconfirmedInfoLookupLimitPerHour?: number;
  // Advisory-only (never blocks/delays sending): a one-shot LLM check run
  // against a proposed confirmation's description, looking for concrete
  // decision points plausibly relevant to the task that were left
  // unspecified (a price ceiling, a delivery deadline, compatibility
  // requirements, etc. — see confirmation/gap-detection.ts). Detected gaps
  // are appended as a clearly separate NanCy-authored note after the
  // agent's own fixed-template message, before the human decides whether to
  // approve it. An error in this advisory call sends the already
  // security-reviewed confirmation unmodified. Missing/failed required
  // confirmation analysis still blocks. Default true.
  gapDetection?: boolean;
}

// Best-effort SecretInput resolution: config fields like telegram.botToken can be
// a plain string or a { source, provider, id } reference. Only the "env" source
// is resolvable from a plugin without the platform's own secret-provider machinery
// (confirmed against openclaw's config-cli validation: for source "env", `id` is
// literally the environment variable name) — anything else is left unresolved.
export function resolveSecretInputBestEffort(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const ref = value as { source?: string; id?: string };
    if (ref.source === "env" && typeof ref.id === "string") return process.env[ref.id] ?? null;
  }
  return null;
}

// Best-effort check that the analysis ("trusted monitor") model isn't the same
// as the main agent's own model. AI-control research on trusted monitoring
// (e.g. Redwood Research's work) treats an independent reviewer model as
// important for avoiding correlated blind spots / monitor-agent collusion —
// this can only warn, since model-ref naming isn't standardized across configs.
function normalizeModelRef(raw: unknown): string | null {
  if (typeof raw === "string") return raw.toLowerCase();
  if (raw && typeof raw === "object") {
    const primary = (raw as Record<string, unknown>).primary;
    if (typeof primary === "string") return primary.toLowerCase();
  }
  return null;
}

export function resolveMainAgentModelRef(cfg: Record<string, unknown>, agentId: string): string | null {
  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const entries = agents?.entries as Record<string, unknown> | undefined;
  const entry = entries?.[agentId] as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  return normalizeModelRef(entry?.model) ?? normalizeModelRef(defaults?.model);
}
