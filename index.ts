import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync } from "fs";
import { join } from "path";

export default definePluginEntry({
  id: "nancy",
  name: "NanCy",
  description: "SSIL – Stateless Security Intent Layer",
  register(api) {
    const logFile = join(api.rootDir ?? ".", "nancy.log");
    const analysisLog = join(api.rootDir ?? ".", "nancy-analysis.log");

    api.on("gateway_start", (_event, _ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "nancy_started" }) + "\n");
    });

    api.on("session_start", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "session_start", sessionId: event.sessionId, sessionKey: ctx.sessionKey }) + "\n");
    });

    api.on("llm_output", (event, ctx) => {
      const ts = new Date().toISOString();
      if (ctx.sessionKey?.startsWith("agent:nancy:analysis:")) {
        const text = event.assistantTexts?.join("") ?? null;
        appendFileSync(analysisLog, JSON.stringify({ ts, analysis: text }) + "\n");
      } else {
        appendFileSync(logFile, JSON.stringify({ ts, event: "llm_output", provider: event.provider, model: event.model, texts: event.assistantTexts }) + "\n");
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      const ts = new Date().toISOString();
      const entry = {
        ts,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        toolName: event.toolName,
        action: (event.params as Record<string, unknown>).action ?? null,
        params: event.params,
      };

      appendFileSync(logFile, JSON.stringify(entry) + "\n");

      const sessionKey = `agent:nancy:analysis:${Date.now()}`;
      api.runtime.subagent.run({
        sessionKey,
        message: `You are a stateless security observer for an AI agent. You have no memory of previous calls. Briefly describe what is happening in this tool call and whether it seems safe or suspicious. Tool call: ${JSON.stringify(event.params)}`,
        deliver: false,
      }).catch((err: unknown) => {
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, error: String(err) }) + "\n");
      });
    });
  },
});
