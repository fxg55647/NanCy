// Only tools that actually write/modify a path can trigger the protected-file
// block. Without this gate, a plain read of e.g. AGENTS.md was refused too,
// since protectedWriteTarget only ever looked at the path, never at whether
// the call was a write — a real functional bug, not just an over-strict
// security posture.
export const PATH_WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

// Tool names verified against the actual installed openclaw@2026.9.4
// package's own tool registry (core-tool-factory-descriptors.ts's
// CORE_TOOL_FACTORY_DESCRIPTORS) and the browser/computer extension
// schemas — not guessed. "shell" and "bash" (from an earlier version of
// this list) are not real openclaw tool names; the actual shell-family
// tools are "exec" and "process" (process controls an already-running
// exec session — write/send-keys/paste/kill/etc — so it can drive an
// interactive shell one keypress at a time without ever passing through
// a "command" string, and needs its own check, not exec's).
const ALWAYS_ANALYZE = new Set([
  "web_fetch", "web_search", "write", "edit",
  // Real tool (family "shell", same as write/edit) that was previously
  // missing here entirely: it wasn't hard-blocked anywhere AND wasn't
  // analyzed, so it executed with zero check of any kind, in every
  // session type including main/cron.
  "apply_patch",
  // The generic outbound-send tool carries the same exfiltration risk
  // as an outbound channel message, so it gets the same LLM review
  // before it runs (message_sending separately reviews the actual
  // channel delivery once this tool call is allowed to proceed).
  "message",
]);
// Skip read-only and harmless shell commands to avoid adding Gemini latency
// with no security value. cp/mv were removed from this list — both can
// overwrite or relocate arbitrary files and are not safe to exempt.
const SAFE_EXEC = /^(ls|pwd|mkdir|echo|cat|head|tail|whoami|date|cd)\b/;
// Shell metacharacters that chain, redirect, substitute, or pipe commands.
// A prefix match on SAFE_EXEC alone is not enough: "echo hi > AGENTS.md" or
// "ls; rm -rf ~" both start with a safe verb but do something else entirely.
// Any of these anywhere in the command forces full analysis, regardless of
// which verb the command starts with.
const SHELL_METACHARACTERS = /[;&|`$(){}<>]|\n/;

function isSafeExecCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return SAFE_EXEC.test(trimmed) && !SHELL_METACHARACTERS.test(trimmed);
}
// process's "list"/"poll"/"log" actions only read state (running
// processes, output so far); everything else (write/send-keys/paste/
// submit/kill/clear/remove) drives or tears down a live process.
const SAFE_PROCESS_ACTIONS = new Set(["list", "poll", "log"]);
const SAFE_COMPUTER_ACTIONS = new Set(["screenshot", "wait"]);

// Worker sessions may have tools supplied by extensions that NanCy has never
// seen before. Treating an unknown name as safe creates an automatic bypass:
// a new mail, cloud, or publishing tool would execute without any semantic
// review until NanCy's source was updated. Only this deliberately small set
// of passive local/metadata reads skips the reviewer; unknown tools default
// to analysis.
const PASSIVE_TOOLS = new Set([
  "read", "ls", "view_image", "get_goal", "session_status",
  "sessions_list", "sessions_history", "sessions_search", "agents_list",
  "conversations_list", "github_identity_status", "transcripts",
]);

// The browser tool's actual dispatch field is `action` (top-level), with
// interactive act-kinds nested under a separate `kind` field only when
// action:"act" — NOT a `command` field. An earlier version of this file
// read a nonexistent `command` field for browser calls, which silently
// made every single browser call — in every session type, main/cron
// included — look like a no-op to both this analysis gate and the old
// MAIN_BROWSER_BLOCK_CMDS check: browser was never analyzed and never
// blocked, regardless of what it actually did.
export function browserAction(params: unknown): string {
  return String((params as Record<string, unknown>)?.action ?? "");
}
export function browserActKind(params: unknown): string {
  return String((params as Record<string, unknown>)?.kind ?? "");
}
// Non-"act" browser actions that themselves navigate, transfer files,
// change browser/profile state, or otherwise reach beyond a passive read.
const BROWSER_INTERACTIVE_ACTIONS = new Set([
  "start", "stop", "importprofile", "open", "navigate", "focus", "close",
  "download", "waitfordownload", "upload", "dialog", "emulate", "pdf",
]);
// action:"act" kinds that interact with or mutate the page. "batch" is
// included since it can itself nest any of these.
const BROWSER_INTERACTIVE_ACT_KINDS = new Set([
  "batch", "click", "clickCoords", "type", "press", "hover",
  "scrollIntoView", "drag", "select", "fill", "resize", "evaluate", "close",
]);
// act-kinds whose params carry the actual value being written into the
// page (a form field's contents, typed text, a selected option). These
// get a context-only pre-check first — see before_tool_call in index.ts.
export const BROWSER_VALUE_ACT_KINDS = new Set(["fill", "type", "select"]);

function shouldAnalyzeBrowser(params: unknown): boolean {
  const action = browserAction(params);
  if (action === "act") return BROWSER_INTERACTIVE_ACT_KINDS.has(browserActKind(params));
  return BROWSER_INTERACTIVE_ACTIONS.has(action);
}

export function shouldAnalyze(toolName: string, params: unknown): boolean {
  if (toolName === "browser") return shouldAnalyzeBrowser(params);
  if (toolName === "computer") {
    const action = String((params as Record<string, unknown>)?.action ?? "");
    return !SAFE_COMPUTER_ACTIONS.has(action);
  }
  if (toolName === "exec") {
    const cmd = String((params as Record<string, unknown>)?.command ?? "");
    return !isSafeExecCommand(cmd);
  }
  if (toolName === "process") {
    const action = String((params as Record<string, unknown>)?.action ?? "");
    return !SAFE_PROCESS_ACTIONS.has(action);
  }
  if (ALWAYS_ANALYZE.has(toolName)) return true;
  return !PASSIVE_TOOLS.has(toolName);
}

// Main/cron hard gate: default-deny. The main (chat) session and any
// cron-triggered run must never execute real work directly — only pure,
// side-effect-free reads. This used to be a *blocklist*
// (MAIN_ALWAYS_BLOCK/MAIN_BROWSER_BLOCK_CMDS): any tool NOT named in it fell
// through completely unchecked, so a tool simply missing from the list —
// apply_patch among them — got free execution by default, and stayed that
// way even once the analysis gate above covered it, since main/cron
// sessions never reach that gate at all for a tool this one doesn't name.
//
// Flipped to an allowlist: only the tool names / sub-actions enumerated
// below may run at all in the main/cron gate; every other tool — every
// known dangerous one (write, edit, apply_patch, exec, process, secrets,
// gateway, subagents, sessions_spawn/_send/_yield, conversations_send,
// message, automations, github_publish, nodes, mobile_ui, terminal, ...)
// and any tool NanCy has never heard of — is blocked outright,
// independent of LLM analysis. Real work always goes through a confirmed
// task, executed in an isolated worker session instead.
//
// Enumerated against openclaw@2026.9.4's actual tool registry
// (core-tool-factory-descriptors.ts) and the browser/computer extension
// schemas, not guessed. web_fetch/web_search are deliberately NOT on
// this list even though they only "read": they reach the open network
// under agent-chosen URLs, which is exactly the exfiltration/SSRF shape
// Domain Border Control and full LLM analysis exist to catch — main/cron
// sessions get neither of those, so those two tools go through a
// confirmed task like any other real action.
const MAIN_ALLOWED_TOOLS = new Set([
  "read", "ls",                  // local file/dir reads
  "view_image",                  // view an already-produced image
  "get_goal", "session_status",  // read own configured goal / session state
  "sessions_list", "sessions_history", "sessions_search", // read session metadata
  "agents_list",                 // read configured agents
  "conversations_list",          // read channel/conversation metadata
  "github_identity_status",      // read auth status
  "transcripts",                 // read a transcript
]);
// "browser" and "computer" are single tools whose action space mixes
// read-only observation with real interaction, so they're gated by
// sub-action instead of by tool name.
const MAIN_ALLOWED_BROWSER_ACTIONS = new Set([
  "snapshot", "screenshot", "text", "tabs", "console", "requests", "errors", "status", "doctor",
]);
// Exactly openclaw@2026.9.4's own LOCAL_ACTIONS constant for the computer
// tool (src/agents/tools/computer-tool.ts) — its own designation for the
// only actions that don't target or mutate a window, browser, or element.
const MAIN_ALLOWED_COMPUTER_ACTIONS = new Set(["screenshot", "wait"]);

export function isMainGateAllowed(toolName: string, params: unknown): boolean {
  if (MAIN_ALLOWED_TOOLS.has(toolName)) return true;
  if (toolName === "browser") return MAIN_ALLOWED_BROWSER_ACTIONS.has(browserAction(params));
  if (toolName === "computer") {
    const action = String((params as Record<string, unknown>)?.action ?? "");
    return MAIN_ALLOWED_COMPUTER_ACTIONS.has(action);
  }
  return false;
}

export const WEB_SNAPSHOT_TOOLS = new Set(["web_fetch"]);

// Tools eligible for the generic "no confirmed task, but this still looks
// like a plain info lookup" fallback baseline (see
// allowUnconfirmedInfoLookups in config.ts / index.ts). Deliberately narrow:
// every state-changing or destination-carrying tool (write, edit,
// apply_patch, message, exec, process, interactive browser actions) is
// excluded on purpose and still hard-blocks outright with no confirmed
// task, even when this fallback is enabled — only these two read-only,
// destination-free tools get it.
export const UNCONFIRMED_INFO_LOOKUP_TOOLS = new Set(["web_search", "web_fetch"]);
