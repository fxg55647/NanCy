import { FETCH_TIMEOUT_MS } from "../constants.ts";
import { resolveSecretInputBestEffort } from "../config.ts";
import type { NancyConfig } from "../config.ts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export async function telegramAlert(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Plain text cannot be rejected because an untrusted model-generated
    // reason happens to contain malformed Telegram Markdown.
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!res.ok || data?.ok === false) throw new Error(`Telegram API error ${res.status}: ${data?.description ?? "unknown response"}`);
}

// Telegram's message text cap is 4096 chars; leave headroom for the
// surrounding status/labels built around this text.
export function truncateForTelegram(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Resolved once and reused everywhere a live block/status/report push is
// sent, so those all share the same enabled/token/chatId resolution.
export function createTelegramNotifier(api: OpenClawPluginApi, nancyConfig: NancyConfig) {
  const telegramCfg = (api.config as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  const telegram = (telegramCfg?.telegram as Record<string, unknown>) ?? undefined;
  const botToken = resolveSecretInputBestEffort(telegram?.botToken);
  const chatId = (telegram?.allowFrom as string[] | undefined)?.[0];
  if (telegram?.botToken && !botToken) {
    console.warn("[nancy] ⚠️  telegram.botToken is a secret reference NanCy could not resolve (only source:\"env\" refs are supported) — Telegram alerts disabled");
  }
  // Everything (blocks, termination, boot status) is always fully written
  // to nancy.log/nancy-analysis.log regardless of this — it only gates the
  // live phone push. Explicit opt-out: telegramAlerts: false.
  const alertsEnabled = nancyConfig.telegramAlerts !== false && !!botToken && !!chatId;
  // Separate opt-out from telegramAlerts: an operator may want blocks/status
  // pushes off (noisy) while still wanting to know how each confirmed task
  // actually turned out.
  const taskReportsEnabled = nancyConfig.telegramTaskReports !== false && !!botToken && !!chatId;

  function sendAlert(text: string): void {
    if (!botToken || !chatId) return;
    telegramAlert(botToken, chatId, text).catch((err) => {
      console.warn(`[nancy] ⚠️  Telegram alert delivery failed: ${String(err)}`);
    });
  }

  // Live notification for every block, including CLARIFY (which also fails
  // closed — see before_tool_call for why it doesn't pause for approval).
  //
  // A model that doesn't stop after a block will often retry the same
  // blocked action many times in a row (the LLM verdict's reason text
  // varies call to call, so it can't be deduped on the message itself).
  // Every retry still hits the block and gets logged, but only the first
  // Telegram push per (session, block kind) within the window goes out —
  // otherwise a benign retry loop reads as an alarming flood on the user's
  // phone even though nothing was ever actually let through.
  const recentBlockAlerts = new Map<string, number>();
  const BLOCK_ALERT_DEBOUNCE_MS = 2 * 60 * 1000;
  function notifyBlocked(text: string, dedupeKey: string): void {
    if (!alertsEnabled) return;
    const now = Date.now();
    const last = recentBlockAlerts.get(dedupeKey);
    if (last && now - last < BLOCK_ALERT_DEBOUNCE_MS) return;
    recentBlockAlerts.set(dedupeKey, now);
    sendAlert(`🛑 *NanCy blocked an action*\n${text}`);
  }

  // Hard termination is rare and must not disappear behind the ordinary
  // per-block debounce window. The denial recorder ensures this is called
  // only on the transition into the terminated state.
  function notifyHardTermination(text: string): void {
    if (!alertsEnabled) return;
    sendAlert(`⛔ *NanCy terminated a session*\n${text}`);
  }

  function clearSessionBlockAlerts(sessionKey: string): void {
    const prefix = `${sessionKey}:`;
    for (const alertKey of recentBlockAlerts.keys()) {
      if (alertKey.startsWith(prefix)) recentBlockAlerts.delete(alertKey);
    }
  }

  return { alertsEnabled, taskReportsEnabled, sendAlert, notifyBlocked, notifyHardTermination, clearSessionBlockAlerts };
}

export type TelegramNotifier = ReturnType<typeof createTelegramNotifier>;
