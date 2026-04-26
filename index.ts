import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface AnalysisConfig {
  provider: "gemini" | "openai" | "openai-compat" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

interface NancyConfig {
  analysis?: AnalysisConfig;
}

async function callLlm(cfg: AnalysisConfig, prompt: string): Promise<string | null> {
  if (cfg.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(data)}`);
    const candidates = data?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }

  if (cfg.provider === "openai" || cfg.provider === "openai-compat") {
    const base = cfg.baseUrl ?? "https://api.openai.com";
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: prompt }], max_tokens: 300 }),
    });
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data?.choices?.[0]?.message?.content ?? null;
  }

  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: cfg.model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data?.content?.[0]?.text ?? null;
  }

  return null;
}

export default definePluginEntry({
  id: "nancy",
  name: "NanCy",
  description: "SSIL – Stateless Security Intent Layer",
  register(api) {
    const logFile = join(api.rootDir ?? ".", "nancy.log");
    const analysisLog = join(api.rootDir ?? ".", "nancy-analysis.log");
    // api.pluginConfig holds plugins.entries.nancy.config — distinct from api.config (full openclaw config)
    const nancyConfig = api.pluginConfig as NancyConfig;

    api.on("gateway_start", (_event, _ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "nancy_started" }) + "\n");
    });

    api.on("session_start", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "session_start", sessionId: event.sessionId, sessionKey: ctx.sessionKey }) + "\n");
    });

    api.on("llm_output", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "llm_output", sessionKey: ctx.sessionKey, provider: event.provider, model: event.model, texts: event.assistantTexts }) + "\n");
    });

    api.on("message_received", (event, ctx) => {
      const ts = new Date().toISOString();
      const channel = ctx.channel ?? "unknown";
      const from = (event as Record<string, unknown>).senderId ?? "unknown";
      const body = String((event as Record<string, unknown>).body ?? "");
      const isGroup = (event as Record<string, unknown>).isGroup ? "group" : "direct";
      console.log(`[nancy] inbound ${channel} ${from} (${isGroup}, ${body.length} chars)`);
      appendFileSync(logFile, JSON.stringify({ ts, event: "message_received", channel, from, isGroup: !!(event as Record<string, unknown>).isGroup, bodyLen: body.length }) + "\n");
    });

    const ALWAYS_ANALYZE = new Set([
      "web_fetch", "web_form_submit", "web_search", "write", "write_file",
    ]);
    const ANALYZE_IF_RISKY = new Set(["exec", "shell", "bash", "run_command"]);
    // Skip read-only and harmless shell commands to avoid adding Gemini latency with no security value
    const SAFE_EXEC = /^(ls|pwd|mkdir|echo|cat|head|tail|whoami|date|cd|cp|mv)\b/;

    function shouldAnalyze(toolName: string, params: unknown): boolean {
      if (ALWAYS_ANALYZE.has(toolName)) return true;
      if (ANALYZE_IF_RISKY.has(toolName)) {
        const cmd = String((params as Record<string, unknown>)?.command ?? "");
        return !SAFE_EXEC.test(cmd.trim());
      }
      return false;
    }

    api.on("before_tool_call", async (event, ctx) => {
      const ts = new Date().toISOString();
      appendFileSync(logFile, JSON.stringify({ ts, event: "before_tool_call", sessionKey: ctx.sessionKey, runId: ctx.runId, toolName: event.toolName, params: event.params }) + "\n");

      if (!shouldAnalyze(event.toolName, event.params)) return;

      const analysisCfg = nancyConfig.analysis;
      if (!analysisCfg) {
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, error: "analysis not configured" }) + "\n");
        return;
      }

      let currentTask: unknown = null;
      try {
        const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
        const tasksDir = join(workspaceDir, "tasks");
        let taskFile: string | null = null;
        try {
          // AGENTS.md requires the agent to write current.json (step 3), but it sometimes skips it —
          // fall back to the newest ID file in that case
          readFileSync(join(tasksDir, "current.json"));
          taskFile = join(tasksDir, "current.json");
        } catch {
          const latest = readdirSync(tasksDir)
            .filter(f => f.endsWith(".json"))
            .map(f => ({ f, mtime: statSync(join(tasksDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0];
          if (latest) taskFile = join(tasksDir, latest.f);
        }
        if (taskFile) currentTask = JSON.parse(readFileSync(taskFile, "utf8"));
      } catch { }

      const taskContext = currentTask ? `Current confirmed task: ${JSON.stringify(currentTask)}. ` : "";
      const prompt = `You are a stateless security observer for an AI agent. You have no memory of previous calls. ${taskContext}Briefly describe what is happening in this tool call and whether it seems safe or suspicious. Tool call: ${JSON.stringify(event.params)}`;

      // Awaiting here is intentional — before_tool_call blocks until analysis completes
      try {
        const analysis = await callLlm(analysisCfg, prompt);
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, analysis }) + "\n");
      } catch (err) {
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, error: String(err) }) + "\n");
      }
    });
  },
});
