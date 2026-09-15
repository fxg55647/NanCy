// Dev-only OpenClaw plugin. Captures the full context OpenClaw sends the
// model for a run (llm_input: systemPrompt/prompt/historyMessages/tools),
// every tool call the model then decided on during that run — proposed
// (before_tool_call) and, when it actually ran, its result (after_tool_call)
// — and the model's final output (llm_output). Writes one JSON checkpoint
// file per run — enough to replay "what did the model see, and what did it
// do" outside a live gateway.
//
// Purely a read-only observer: it never returns a hook result, so it can
// never block, alter, or authorize a tool call. Load it alongside NanCy to
// compare behavior with NanCy in the loop against a run with NanCy's plugin
// removed from the gateway's plugin list — no code changes needed to switch.
//
// llm_input fires once per CLI run/attempt, before that attempt's
// before_tool_call events — not once per individual tool call. Recorder
// output mirrors that shape: one context, many toolCalls, one final output.
//
// A toolCall's outcome is "unknown" whenever a before_tool_call has no
// matching after_tool_call by the time the run is flushed — that ambiguity
// is deliberate: another plugin (e.g. NanCy) may have blocked the call
// before it ever executed, but this recorder never sees other plugins'
// hook results (see docs/architecture/behavior-comparator.md), so it never
// guesses "blocked" on its own. Downstream tooling resolves "unknown" by
// cross-referencing NanCy's own nancy.log/nancy-analysis.log.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

type RecorderConfig = {
  outputDir?: string;
  redactPatterns?: string[];
};

// Best-effort secret-shaped scrub over the serialized checkpoint. Not a
// substitute for reviewing captures before sharing them — history messages
// or tool params can carry operator-specific content these patterns don't
// cover.
const BUILTIN_SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /xox[baprs]-[0-9A-Za-z-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped
];

function redact(value: unknown, extraPatterns: RegExp[]): unknown {
  let text = JSON.stringify(value);
  for (const pattern of [...BUILTIN_SECRET_PATTERNS, ...extraPatterns]) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return JSON.parse(text);
}

type ToolCallOutcome = "executed" | "errored" | "unknown";

type ToolCallRecord = {
  toolCallId?: string;
  toolName: string;
  proposedParams: unknown;
  proposedAt: string;
  resultAt?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  outcome: ToolCallOutcome;
};

type RunContext = {
  sessionKey?: string;
  sessionId?: string;
  trigger?: string;
  agentId?: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount?: number;
  tools?: unknown[];
  capturedAt: string;
  toolCalls: ToolCallRecord[];
  pendingByCallId: Map<string, ToolCallRecord>;
};

export default definePluginEntry({
  id: "checkpoint-recorder",
  name: "Checkpoint Recorder",
  description: "Dev-only recorder of full model context + decisions, for offline OpenClaw simulation/replay.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as RecorderConfig;
    const outputDir = config.outputDir ?? join(api.rootDir ?? ".", "captures");
    mkdirSync(outputDir, { recursive: true });
    const extraPatterns = (config.redactPatterns ?? []).map((source) => new RegExp(source, "g"));

    const runs = new Map<string, RunContext>();

    // status: "completed" when llm_output produced a real final model
    // output; "incomplete" when the run was flushed early (session ended or
    // the gateway stopped) without ever reaching llm_output — still written
    // out (never silently dropped) so a truncated/aborted run is visible.
    function flush(runId: string, run: RunContext, status: "completed" | "incomplete", modelOutput: unknown) {
      const checkpoint = redact(
        {
          runId,
          status,
          sessionKey: run.sessionKey,
          sessionId: run.sessionId,
          trigger: run.trigger,
          agentId: run.agentId,
          provider: run.provider,
          model: run.model,
          capturedAt: run.capturedAt,
          systemPrompt: run.systemPrompt,
          prompt: run.prompt,
          historyMessages: run.historyMessages,
          imagesCount: run.imagesCount,
          tools: run.tools,
          toolCalls: run.toolCalls.map(({ toolCallId, toolName, proposedParams, proposedAt, resultAt, result, error, durationMs, outcome }) => ({
            toolCallId,
            toolName,
            proposedParams,
            proposedAt,
            resultAt,
            result,
            error,
            durationMs,
            outcome,
          })),
          modelOutput,
        },
        extraPatterns,
      );
      const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${runId}_${status}.json`;
      writeFileSync(join(outputDir, filename), JSON.stringify(checkpoint, null, 2));
      runs.delete(runId);
    }

    api.on("llm_input", (event, ctx) => {
      const runId = ctx.runId ?? event.runId;
      if (!runId) return;
      runs.set(runId, {
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId ?? event.sessionId,
        trigger: ctx.trigger,
        agentId: ctx.agentId,
        provider: event.provider,
        model: event.model,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages ?? [],
        imagesCount: event.imagesCount,
        tools: event.tools,
        capturedAt: new Date().toISOString(),
        toolCalls: [],
        pendingByCallId: new Map(),
      });
    });

    api.on("before_tool_call", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = runs.get(runId);
      // No matching llm_input (e.g. recorder loaded mid-run) — nothing to attach to.
      if (!run) return;
      const record: ToolCallRecord = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        proposedParams: event.params,
        proposedAt: new Date().toISOString(),
        outcome: "unknown",
      };
      run.toolCalls.push(record);
      if (event.toolCallId) run.pendingByCallId.set(event.toolCallId, record);
    });

    api.on("after_tool_call", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = runs.get(runId);
      if (!run) return;
      let record: ToolCallRecord | undefined;
      if (event.toolCallId && run.pendingByCallId.has(event.toolCallId)) {
        record = run.pendingByCallId.get(event.toolCallId);
        run.pendingByCallId.delete(event.toolCallId);
      } else {
        // Fallback for hosts that don't supply toolCallId consistently:
        // the oldest still-unresolved call with the same tool name (FIFO).
        record = run.toolCalls.find((r) => r.toolName === event.toolName && r.outcome === "unknown");
      }
      // after_tool_call with nothing to attach to (recorder loaded mid-call) — nothing to update.
      if (!record) return;
      record.resultAt = new Date().toISOString();
      record.result = event.result;
      record.error = event.error;
      record.durationMs = event.durationMs;
      record.outcome = event.error ? "errored" : "executed";
    });

    api.on("llm_output", (event, ctx) => {
      const runId = ctx.runId ?? event.runId;
      if (!runId) return;
      const run = runs.get(runId) ?? {
        sessionKey: ctx.sessionKey,
        sessionId: event.sessionId,
        trigger: ctx.trigger,
        agentId: ctx.agentId,
        provider: event.provider,
        model: event.model,
        prompt: event.prompt ?? "",
        historyMessages: [],
        tools: [],
        capturedAt: new Date().toISOString(),
        toolCalls: [],
        pendingByCallId: new Map(),
      };
      flush(runId, run, "completed", {
        assistantTexts: event.assistantTexts,
        lastAssistant: event.lastAssistant,
        usage: event.usage,
      });
    });

    // A session ending (e.g. a round/turn limit cutting a scripted run
    // short) with a run still open means llm_output never fired for it —
    // flush what was captured so far rather than losing it silently.
    api.on("session_end", (_event, ctx) => {
      if (!ctx.sessionKey) return;
      for (const [runId, run] of runs) {
        if (run.sessionKey === ctx.sessionKey) flush(runId, run, "incomplete", null);
      }
    });

    api.on("gateway_stop", async () => {
      for (const [runId, run] of runs) flush(runId, run, "incomplete", null);
    });
  },
});
