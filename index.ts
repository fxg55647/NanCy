import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileSync, readFileSync, readdirSync, statSync, accessSync, constants, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

function isWritable(filePath: string): boolean {
  try { accessSync(filePath, constants.W_OK); return true; }
  catch { return false; }
}

async function telegramAlert(botToken: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

interface AnalysisConfig {
  provider: "gemini" | "openai" | "openai-compat" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

interface NancyConfig {
  analysis?: AnalysisConfig;
  browser?: {
    port?: number;
    token?: string;
  };
}

async function fetchBrowserSnapshot(port: number, token?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}/snapshot?format=ai`, { headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function snapshotFilename(params: unknown): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const datePart = `${dd}-${mm}-${yyyy}`;
  const timePart = `${HH}-${MM}-${SS}-${ms}`;
  let identifier = "browser";
  try {
    const url = String((params as Record<string, unknown>)?.url ?? "");
    if (url) {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/[^a-z0-9.-]/gi, "-");
      const path = parsed.pathname.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
      identifier = path ? `${hostname}_${path}` : hostname;
    }
  } catch { }
  return `${datePart}_${timePart}_${identifier}.txt`;
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
    const snapshotsDir = join(api.rootDir ?? ".", "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    // api.pluginConfig holds plugins.entries.nancy.config — distinct from api.config (full openclaw config)
    const nancyConfig = api.pluginConfig as NancyConfig;

    api.on("gateway_start", (_event, _ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "nancy_started" }) + "\n");

      const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
      const PROTECTED_FILES = [
        { label: "AGENTS.md", path: join(workspaceDir, "AGENTS.md") },
        { label: "IDENTITY.md", path: join(workspaceDir, "IDENTITY.md") },
        { label: "MEMORY.md", path: join(workspaceDir, "MEMORY.md") },
        { label: "nancy/index.ts", path: join(api.rootDir ?? ".", "index.ts") },
        { label: "nancy/openclaw.plugin.json", path: join(api.rootDir ?? ".", "openclaw.plugin.json") },
      ];

      const writable = PROTECTED_FILES.filter(f => isWritable(f.path));
      if (writable.length > 0) {
        const names = writable.map(f => f.label).join(", ");
        console.warn(`[nancy] ⚠️  SECURITY WARNING: these files are writable and unprotected: ${names}`);
        appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "security_warning", writableFiles: writable.map(f => f.label) }) + "\n");
      } else {
        console.log("[nancy] ✓ Protected files are read-only");
      }

      if (!nancyConfig.analysis) {
        console.warn("[nancy] ⚠️  analysis is not configured — security analysis disabled");
      }

      const cfg = api.config as Record<string, unknown>;
      const telegram = (cfg?.channels as Record<string, unknown>)?.telegram as Record<string, unknown> | undefined;
      const botToken = telegram?.botToken as string | undefined;
      const chatId = (telegram?.allowFrom as string[] | undefined)?.[0];

      if (botToken && chatId) {
        const statusLine = writable.length > 0
          ? `⚠️ *SECURITY WARNING*: unprotected files: ${writable.map(f => f.label).join(", ")}`
          : `✅ Protected files are read-only`;
        const analysisStatus = nancyConfig.analysis
          ? `✅ Analysis: ${nancyConfig.analysis.provider}/${nancyConfig.analysis.model}`
          : `⚠️ Analysis: not configured`;
        telegramAlert(botToken, chatId, `🛡 *NanCy online*\n${statusLine}\n${analysisStatus}`).catch(() => {});
      }
    });

    api.on("session_start", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "session_start", sessionId: event.sessionId, sessionKey: ctx.sessionKey }) + "\n");
    });

    api.on("llm_output", (event, ctx) => {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event: "llm_output", sessionKey: ctx.sessionKey, provider: event.provider, model: event.model, texts: event.assistantTexts }) + "\n");
    });

    api.on("message_sending", (event, ctx) => {
      const ts = new Date().toISOString();
      const text = String((event as Record<string, unknown>).text ?? "");
      if (!text) return;
      if (text.startsWith("Reasoning:")) {
        const reasoningText = text.slice("Reasoning:".length).trim();
        console.log(`[nancy] reasoning: ${reasoningText.slice(0, 120).trim()}…`);
        recentReasoning.push({ ts, text: reasoningText });
        if (recentReasoning.length > 3) recentReasoning.shift();
        appendFileSync(analysisLog, JSON.stringify({ ts, event: "reasoning", text }) + "\n");
      } else {
        console.log(`[nancy] outbound: ${text.slice(0, 100).trim()}${text.length > 100 ? "…" : ""}`);
      }
      appendFileSync(logFile, JSON.stringify({ ts, event: "message_sending", channel: ctx.channel ?? "unknown", text }) + "\n");
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

    // Rolling buffer of all tool calls this session — gives Gemini sequential context
    const recentCalls: Array<{ ts: string; toolName: string; params: unknown }> = [];

    // Rolling buffer of recent agent reasoning (Claude thinking blocks via message_sending)
    const recentReasoning: Array<{ ts: string; text: string }> = [];

    const ALWAYS_ANALYZE = new Set([
      "web_fetch", "web_form_submit", "web_search", "write", "write_file",
    ]);
    const ANALYZE_IF_RISKY = new Set(["exec", "shell", "bash", "run_command"]);
    // Skip read-only and harmless shell commands to avoid adding Gemini latency with no security value
    const SAFE_EXEC = /^(ls|pwd|mkdir|echo|cat|head|tail|whoami|date|cd|cp|mv)\b/;
    // Browser commands that interact with the page — snapshot taken before each
    const BROWSER_INTERACT = new Set(["act", "navigate", "click", "fill", "type", "submit", "press", "drag", "select"]);

    function shouldAnalyze(toolName: string, params: unknown): boolean {
      if (toolName === "browser") {
        const cmd = String((params as Record<string, unknown>)?.command ?? "");
        return BROWSER_INTERACT.has(cmd);
      }
      if (ALWAYS_ANALYZE.has(toolName)) {
        // Writes to tasks/ are part of the confirmation bookkeeping protocol — skip analysis
        if (toolName === "write" || toolName === "write_file") {
          const p = String((params as Record<string, unknown>)?.path ?? "");
          if (p.replace(/\\/g, "/").includes("/tasks/") || p === "tasks/current.json") return false;
        }
        return true;
      }
      if (ANALYZE_IF_RISKY.has(toolName)) {
        const cmd = String((params as Record<string, unknown>)?.command ?? "");
        return !SAFE_EXEC.test(cmd.trim());
      }
      return false;
    }

    api.on("before_tool_call", async (event, ctx) => {
      const ts = new Date().toISOString();
      appendFileSync(logFile, JSON.stringify({ ts, event: "before_tool_call", sessionKey: ctx.sessionKey, runId: ctx.runId, toolName: event.toolName, params: event.params }) + "\n");

      recentCalls.push({ ts, toolName: event.toolName, params: event.params });
      if (recentCalls.length > 20) recentCalls.shift();

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

      let snapshotContext = "";
      if (event.toolName === "browser") {
        const port = nancyConfig.browser?.port ?? 18791;
        const snapshot = await fetchBrowserSnapshot(port, nancyConfig.browser?.token);
        if (snapshot) {
          snapshotContext = `Current browser state (what the agent sees before this action): ${snapshot.slice(0, 4000)}. `;
          const fname = snapshotFilename(event.params);
          writeFileSync(join(snapshotsDir, fname), snapshot);
          appendFileSync(analysisLog, JSON.stringify({ ts, event: "browser_snapshot", file: fname, chars: snapshot.length }) + "\n");
        }
      }

      const taskContext = currentTask ? `Current confirmed task: ${JSON.stringify(currentTask)}. ` : "";
      const historyContext = recentCalls.length > 1
        ? `Recent tool call history (oldest first): ${JSON.stringify(recentCalls.slice(0, -1))}. `
        : "";
      const reasoningContext = recentReasoning.length > 0
        ? `Recent agent reasoning/thinking (Claude thinking blocks, newest last): ${JSON.stringify(recentReasoning)}. `
        : "";
      const prompt = `You are a stateless security observer for an AI agent. You have no memory of previous calls. ${taskContext}${historyContext}${reasoningContext}${snapshotContext}Briefly describe what is happening in this tool call, whether the sequence of actions seems safe or suspicious, and whether it matches the confirmed task. Tool call being evaluated: ${JSON.stringify(event.params)}`;

      // Awaiting here is intentional — before_tool_call blocks until analysis completes
      try {
        const analysis = await callLlm(analysisCfg, prompt);
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, analysis }) + "\n");
      } catch (err) {
        appendFileSync(analysisLog, JSON.stringify({ ts, toolName: event.toolName, error: String(err) }) + "\n");
      }
    });

    const WEB_SNAPSHOT_TOOLS = new Set(["web_fetch", "web_form_submit"]);

    api.on("after_tool_call", (event, _ctx) => {
      if (!WEB_SNAPSHOT_TOOLS.has(event.toolName)) return;
      const ts = new Date().toISOString();
      const fname = snapshotFilename(event.params);
      const content = JSON.stringify({ ts, toolName: event.toolName, params: event.params, result: (event as Record<string, unknown>).result ?? null }, null, 2);
      writeFileSync(join(snapshotsDir, fname), content);
      appendFileSync(analysisLog, JSON.stringify({ ts, event: "web_snapshot", file: fname }) + "\n");
    });
  },
});
