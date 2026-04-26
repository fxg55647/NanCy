import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync } from "fs";
import { join } from "path";

export default definePluginEntry({
  id: "nancy",
  name: "NanCy",
  description: "SSIL – Stateless Security Intent Layer",
  register(api) {
    const logFile = join(api.rootDir ?? ".", "nancy.log");

    api.on("gateway_start", (_event, _ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "nancy_started" }) + "\n");
    });

    api.on("session_start", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "session_start", sessionId: event.sessionId, sessionKey: ctx.sessionKey }) + "\n");
    });

    api.on("before_tool_call", async (event, ctx) => {
      const entry = {
        ts: new Date().toISOString(),
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        toolName: event.toolName,
        action: (event.params as Record<string, unknown>).action ?? null,
        params: event.params,
      };

      appendFileSync(logFile, JSON.stringify(entry) + "\n");
    });
  },
});
