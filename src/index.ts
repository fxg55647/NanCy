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
  }).catch(() => {});
}

interface AnalysisConfig {
  provider: "gemini" | "openai" | "openai-compat" | "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

interface NancyConfig {
  analysis?: AnalysisConfig;
  browser?: { port?: number; token?: string; };
  mainSessionKey?: string;
  domainCheck?: { safeBrowsingApiKey: string; };
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
  const datePart = `${dd}-${mm}-${yyyy}`;
  const timePart = `${HH}-${MM}-${SS}`;
  let identifier = "browser";
  let suffix = "_fetch";
  try {
    const url = String((params as Record<string, unknown>)?.url ?? "");
    if (url) {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/[^a-z0-9.-]/gi, "-");
      const path = parsed.pathname.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
      identifier = path ? `${hostname}_${path}` : hostname;
      if ([...parsed.searchParams].length >= 3) suffix = "_submit";
    }
  } catch { }
  return `${timePart}_${datePart}_${identifier}${suffix}.txt`;
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
      headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data?.content?.[0]?.text ?? null;
  }
  return null;
}

// Domain reputation via Google Safe Browsing — cache by hostname, TTL 1h
const domainCache = new Map<string, { safe: boolean; threats: string[]; ts: number }>();
const DOMAIN_CACHE_TTL_MS = 60 * 60 * 1000;

async function checkDomain(url: string, apiKey: string): Promise<{ safe: boolean; threats: string[] }> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return { safe: true, threats: [] }; }
  const cached = domainCache.get(hostname);
  if (cached && Date.now() - cached.ts < DOMAIN_CACHE_TTL_MS) return { safe: cached.safe, threats: cached.threats };
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "nancy-ssil", clientVersion: "0.1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url: `https://${hostname}` }],
        },
      }),
    });
    const data = await res.json() as { matches?: Array<{ threatType: string }> };
    const threats = (data.matches ?? []).map(m => m.threatType);
    const result = { safe: threats.length === 0, threats, ts: Date.now() };
    domainCache.set(hostname, result);
    return result;
  } catch {
    return { safe: true, threats: [] };
  }
}

type Verdict = "go" | "block" | "terminate";

function parseVerdict(text: string | null, allowTerminate: boolean): { verdict: Verdict; reason: string } {
  if (!text) return { verdict: "block", reason: "No analysis response" };
  try {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("no JSON");
    const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    const valid = allowTerminate ? ["go", "block", "terminate"] : ["go", "block"];
    const verdict = valid.includes(parsed.verdict ?? "") ? parsed.verdict as Verdict : "block";
    return { verdict, reason: parsed.reason ?? "No reason provided" };
  } catch {
    return { verdict: "block", reason: "Could not parse security analysis" };
  }
}

// Main session: state-changing tools are always blocked, reads always allowed
const MAIN_ALWAYS_BLOCK = new Set([
  "write", "write_file", "exec", "shell", "bash", "run_command", "web_form_submit",
]);
const MAIN_BROWSER_BLOCK_CMDS = new Set(["act", "click", "fill", "type", "submit", "press", "drag", "select"]);

// Worker session: these always get LLM analysis
const WORKER_ALWAYS_ANALYZE = new Set([
  "web_fetch", "web_form_submit", "web_search", "write", "write_file", "read", "read_file",
]);
const WORKER_ANALYZE_IF_RISKY = new Set(["exec", "shell", "bash", "run_command"]);
const SAFE_EXEC = /^(ls|pwd|mkdir|echo|cat|head|tail|whoami|date|cd|cp|mv)\b/;
const WORKER_BROWSER_INTERACT = new Set(["act", "navigate", "click", "fill", "type", "submit", "press", "drag", "select"]);

export default definePluginEntry({
  id: "nancy",
  name: "NanCy",
  description: "SSIL – Stateless Security Intent Layer",
  register(api) {
    const logFile = join(api.rootDir ?? ".", "nancy.log");
    const analysisLog = join(api.rootDir ?? ".", "nancy-analysis.log");
    const snapshotsDir = join(api.rootDir ?? ".", "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const nancyConfig = api.pluginConfig as NancyConfig;

    // Per-session state
    const terminatedSessions = new Map<string, boolean>();
    const callCounters = new Map<string, number>();
    const recentCallsPerSession = new Map<string, Array<{ ts: string; toolName: string; params: unknown }>>();

    // Global rolling buffer of recent reasoning blocks (from any session)
    const recentReasoning: Array<{ ts: string; text: string }> = [];

    function log(data: Record<string, unknown>): void {
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n");
    }

    function logAnalysis(data: Record<string, unknown>): void {
      appendFileSync(analysisLog, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n");
    }

    function getTelegram(): { botToken?: string; chatId?: string } {
      const cfg = api.config as Record<string, unknown>;
      const telegram = (cfg?.channels as Record<string, unknown>)?.telegram as Record<string, unknown> | undefined;
      return {
        botToken: telegram?.botToken as string | undefined,
        chatId: (telegram?.allowFrom as string[] | undefined)?.[0],
      };
    }

    function isMainSession(sessionKey: string | undefined): boolean {
      return !!nancyConfig.mainSessionKey && sessionKey === nancyConfig.mainSessionKey;
    }

    async function runMacroReview(sessionKey: string, calls: Array<{ ts: string; toolName: string; params: unknown }>): Promise<void> {
      const analysisCfg = nancyConfig.analysis;
      if (!analysisCfg) return;
      const prompt = `You are NanCy SSIL performing a periodic behavioral review of an AI agent session.
Look for concerning patterns: agent stuck in a loop, slow privilege escalation, repeated blocked attempts, unusual tool sequences.

Session: ${sessionKey}
Recent tool calls (${calls.length} entries, oldest first):
${JSON.stringify(calls, null, 2)}

Reply ONLY with valid JSON:
{"verdict":"ok","reason":"<one sentence>"}
{"verdict":"suspicious","reason":"<one sentence>"}`;
      try {
        const response = await callLlm(analysisCfg, prompt);
        if (!response) return;
        const match = response.match(/\{[\s\S]*?\}/);
        if (!match) return;
        const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
        logAnalysis({ event: "macro_review", sessionKey, verdict: parsed.verdict, reason: parsed.reason });
        if (parsed.verdict === "suspicious") {
          const { botToken, chatId } = getTelegram();
          if (botToken && chatId) {
            telegramAlert(botToken, chatId, `⚠️ *NanCy: suspicious pattern detected*\nSession: \`${sessionKey}\`\nReason: ${parsed.reason}`);
          }
        }
      } catch { }
    }

    async function loadCurrentTask(): Promise<unknown> {
      try {
        const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
        const tasksDir = join(workspaceDir, "tasks");
        let taskFile: string | null = null;
        try {
          readFileSync(join(tasksDir, "current.json"));
          taskFile = join(tasksDir, "current.json");
        } catch {
          const latest = readdirSync(tasksDir)
            .filter(f => f.endsWith(".json"))
            .map(f => ({ f, mtime: statSync(join(tasksDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0];
          if (latest) taskFile = join(tasksDir, latest.f);
        }
        if (taskFile) return JSON.parse(readFileSync(taskFile, "utf8"));
      } catch { }
      return null;
    }

    // --- Event handlers ---

    api.on("gateway_start", (_event, _ctx) => {
      log({ event: "nancy_started" });
      const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
      const PROTECTED_FILES = [
        { label: "AGENTS.md", path: join(workspaceDir, "AGENTS.md") },
        { label: "IDENTITY.md", path: join(workspaceDir, "IDENTITY.md") },
        { label: "MEMORY.md", path: join(workspaceDir, "MEMORY.md") },
        { label: "nancy/src/index.ts", path: join(api.rootDir ?? ".", "src", "index.ts") },
        { label: "nancy/openclaw.plugin.json", path: join(api.rootDir ?? ".", "openclaw.plugin.json") },
      ];
      const writable = PROTECTED_FILES.filter(f => isWritable(f.path));
      if (writable.length > 0) {
        const names = writable.map(f => f.label).join(", ");
        console.warn(`[nancy] ⚠️  SECURITY WARNING: writable unprotected files: ${names}`);
        log({ event: "security_warning", writableFiles: writable.map(f => f.label) });
      } else {
        console.log("[nancy] ✓ Protected files are read-only");
      }
      if (!nancyConfig.analysis) console.warn("[nancy] ⚠️  analysis not configured — worker gate disabled");
      if (!nancyConfig.mainSessionKey) console.warn("[nancy] ⚠️  mainSessionKey not set — all sessions treated as worker");
      if (!nancyConfig.domainCheck) console.warn("[nancy] ⚠️  domainCheck not configured — domain reputation disabled");

      const { botToken, chatId } = getTelegram();
      if (botToken && chatId) {
        const statusLine = writable.length > 0
          ? `⚠️ *SECURITY WARNING*: unprotected files: ${writable.map(f => f.label).join(", ")}`
          : `✅ Protected files are read-only`;
        const analysisStatus = nancyConfig.analysis
          ? `✅ Analysis: ${nancyConfig.analysis.provider}/${nancyConfig.analysis.model}`
          : `⚠️ Analysis: not configured`;
        const domainStatus = nancyConfig.domainCheck ? `✅ Domain check: enabled` : `⚠️ Domain check: disabled`;
        telegramAlert(botToken, chatId, `🛡 *NanCy online*\n${statusLine}\n${analysisStatus}\n${domainStatus}`);
      }
    });

    api.on("session_start", (event, ctx) => {
      log({ event: "session_start", sessionId: event.sessionId, sessionKey: ctx.sessionKey });
    });

    api.on("llm_output", (event, ctx) => {
      log({ event: "llm_output", sessionKey: ctx.sessionKey, provider: event.provider, model: event.model, texts: event.assistantTexts });
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
        logAnalysis({ event: "reasoning", text });
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

    api.on("before_tool_call", async (event, ctx) => {
      const ts = new Date().toISOString();
      const sessionKey = ctx.sessionKey ?? "unknown";
      const { toolName, params } = event;

      log({ event: "before_tool_call", sessionKey, runId: ctx.runId, toolName, params });

      // 1. Terminated session — block everything
      if (terminatedSessions.get(sessionKey)) {
        return { block: true, blockReason: "[NanCy SSIL] This session has been terminated due to a security violation. No further actions are permitted." };
      }

      // 2. Update per-session call history
      const recentCalls = recentCallsPerSession.get(sessionKey) ?? [];
      recentCalls.push({ ts, toolName, params });
      if (recentCalls.length > 20) recentCalls.shift();
      recentCallsPerSession.set(sessionKey, recentCalls);

      // 3. Macro-review every 10 calls (non-blocking)
      const callCount = (callCounters.get(sessionKey) ?? 0) + 1;
      callCounters.set(sessionKey, callCount);
      if (callCount % 10 === 0) {
        runMacroReview(sessionKey, [...recentCalls]).catch(() => {});
      }

      // 4. Domain check for URL-based tools (both sessions)
      const urlParam = String((params as Record<string, unknown>)?.url ?? "");
      if (urlParam && nancyConfig.domainCheck) {
        const { safe, threats } = await checkDomain(urlParam, nancyConfig.domainCheck.safeBrowsingApiKey);
        if (!safe) {
          logAnalysis({ event: "domain_block", sessionKey, url: urlParam, threats });
          return { block: true, blockReason: `[NanCy SSIL] Domain flagged by Google Safe Browsing (${threats.join(", ")}). Do not retry this request.` };
        }
      }

      // 5. Route by session type
      if (isMainSession(sessionKey)) {
        // State-changing tools: always block without analysis
        if (MAIN_ALWAYS_BLOCK.has(toolName)) {
          return { block: true, blockReason: `[NanCy SSIL] '${toolName}' is not permitted in the main session. Create a confirmed task first.` };
        }
        if (toolName === "browser") {
          const cmd = String((params as Record<string, unknown>)?.command ?? "");
          if (MAIN_BROWSER_BLOCK_CMDS.has(cmd)) {
            return { block: true, blockReason: `[NanCy SSIL] Browser '${cmd}' is not permitted in the main session. Create a confirmed task first.` };
          }
        }

        // Pure local reads: always go
        if (toolName === "read" || toolName === "read_file" || toolName === "web_search") {
          logAnalysis({ event: "main_go", sessionKey, toolName });
          return;
        }

        // web_fetch and browser navigate: analyze — GET requests can trigger purchases,
        // unsubscribes, or other state changes depending on the URL
        const analysisCfg = nancyConfig.analysis;
        if (!analysisCfg) {
          logAnalysis({ event: "main_no_config", sessionKey, toolName });
          return;
        }

        const fetchUrl = String((params as Record<string, unknown>)?.url ?? (params as Record<string, unknown>)?.command ?? "");
        const mainPrompt = `You are NanCy SSIL observing the MAIN (chat/research) session of an AI agent.
The main session may only retrieve information passively. It must not trigger purchases, sign-ups, account changes, unsubscribes, or any state-changing actions.

Tool call: ${toolName}
URL or target: ${fetchUrl}
Full params: ${JSON.stringify(params)}

Could fetching or navigating to this URL trigger any real-world action (purchase, form submission, account change, unsubscribe, etc.)?
Or is this purely passive information retrieval?

Reply ONLY with valid JSON — no other text:
{"verdict":"go","reason":"<one sentence>"}    — safe passive retrieval
{"verdict":"block","reason":"<one sentence>"}  — could trigger action; requires confirmed task`;

        try {
          const response = await callLlm(analysisCfg, mainPrompt);
          const { verdict, reason } = parseVerdict(response, false);
          logAnalysis({ event: "main_verdict", sessionKey, toolName, verdict, reason });
          if (verdict === "block") {
            return { block: true, blockReason: `[NanCy SSIL] ${reason} Create a confirmed task first.` };
          }
        } catch (err) {
          logAnalysis({ event: "main_analysis_error", sessionKey, toolName, error: String(err) });
          return { block: true, blockReason: "[NanCy SSIL] Security analysis failed. Blocking as precaution." };
        }
        return;
      }

      // Worker session: LLM analysis with structured verdict
      const shouldAnalyze = (() => {
        if (toolName === "browser") {
          const cmd = String((params as Record<string, unknown>)?.command ?? "");
          return WORKER_BROWSER_INTERACT.has(cmd);
        }
        if (WORKER_ALWAYS_ANALYZE.has(toolName)) {
          if (toolName === "write" || toolName === "write_file") {
            const p = String((params as Record<string, unknown>)?.path ?? "");
            if (p.replace(/\\/g, "/").includes("/tasks/") || p === "tasks/current.json") return false;
          }
          return true;
        }
        if (WORKER_ANALYZE_IF_RISKY.has(toolName)) {
          const cmd = String((params as Record<string, unknown>)?.command ?? "");
          return !SAFE_EXEC.test(cmd.trim());
        }
        return false;
      })();

      if (!shouldAnalyze) return;

      const analysisCfg = nancyConfig.analysis;
      if (!analysisCfg) {
        logAnalysis({ event: "worker_no_config", sessionKey, toolName });
        return;
      }

      const currentTask = await loadCurrentTask();

      // Browser snapshot before interaction
      let snapshotContext = "";
      if (toolName === "browser") {
        const port = nancyConfig.browser?.port ?? 18791;
        const snapshot = await fetchBrowserSnapshot(port, nancyConfig.browser?.token);
        if (snapshot) {
          snapshotContext = `\nCurrent browser state (before this action):\n${snapshot.slice(0, 4000)}`;
          writeFileSync(join(snapshotsDir, snapshotFilename(params)), snapshot);
          logAnalysis({ event: "browser_snapshot", sessionKey, chars: snapshot.length });
        }
      }

      const taskContext = currentTask ? `Confirmed task: ${JSON.stringify(currentTask)}\n` : "No confirmed task on file.\n";
      const historyContext = recentCalls.length > 1
        ? `Recent tool calls (oldest first): ${JSON.stringify(recentCalls.slice(0, -1))}\n`
        : "";
      const reasoningContext = recentReasoning.length > 0
        ? `Recent agent reasoning: ${JSON.stringify(recentReasoning)}\n`
        : "";

      const prompt = `You are NanCy SSIL, a stateless security observer for an AI agent's TASK WORKER session.
You have no memory of prior calls — evaluate this action fresh.

${taskContext}${historyContext}${reasoningContext}${snapshotContext}

Tool call to evaluate:
${JSON.stringify({ tool: toolName, params })}

Reply ONLY with valid JSON — no other text, no markdown:
{"verdict":"go","reason":"<one sentence>"}      — aligns with task, safe
{"verdict":"block","reason":"<one sentence>"}   — suspicious or off-task; agent should try another approach
{"verdict":"terminate","reason":"<one sentence>"} — clearly dangerous, malicious, or persistent bypass attempt`;

      try {
        const response = await callLlm(analysisCfg, prompt);
        const { verdict, reason } = parseVerdict(response, true);
        logAnalysis({ event: "worker_verdict", sessionKey, toolName, verdict, reason });

        if (verdict === "block") {
          return { block: true, blockReason: `[NanCy SSIL] ${reason}` };
        }

        if (verdict === "terminate") {
          terminatedSessions.set(sessionKey, true);
          log({ event: "session_terminated", sessionKey, toolName, reason });
          const { botToken, chatId } = getTelegram();
          if (botToken && chatId) {
            telegramAlert(botToken, chatId, `⛔ *NanCy: session TERMINATED*\nSession: \`${sessionKey}\`\nTool: \`${toolName}\`\nReason: ${reason}`);
          }
          return { block: true, blockReason: `[NanCy SSIL] Session terminated. Reason: ${reason}` };
        }
      } catch (err) {
        logAnalysis({ event: "worker_analysis_error", sessionKey, toolName, error: String(err) });
        // Fail closed — analysis failure blocks the action
        return { block: true, blockReason: "[NanCy SSIL] Security analysis failed. Blocking as precaution." };
      }
    });

    const WEB_SNAPSHOT_TOOLS = new Set(["web_fetch", "web_form_submit"]);

    api.on("after_tool_call", (event, _ctx) => {
      if (!WEB_SNAPSHOT_TOOLS.has(event.toolName)) return;
      const ts = new Date().toISOString();
      const fname = snapshotFilename(event.params);
      const content = JSON.stringify({ ts, toolName: event.toolName, params: event.params, result: (event as Record<string, unknown>).result ?? null }, null, 2);
      writeFileSync(join(snapshotsDir, fname), content);
      logAnalysis({ event: "web_snapshot", file: fname });
    });
  },
});
