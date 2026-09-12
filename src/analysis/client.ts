import { LLM_FETCH_TIMEOUT_MS } from "../constants.ts";
import type { AnalysisConfig } from "../config.ts";

export async function callLlm(cfg: AnalysisConfig, prompt: string): Promise<string | null> {
  if (cfg.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
    });
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    if (!res.ok) throw new Error(`${cfg.provider} API error ${res.status}: ${JSON.stringify(data)}`);
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
      signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(data)}`);
    return data?.content?.[0]?.text ?? null;
  }

  return null;
}
