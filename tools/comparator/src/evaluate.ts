// Computes the structured, directly-measured facts for one run — no LLM
// involved. See report.ts for how these feed the human-readable summary.
import { existsSync, readFileSync } from "fs";
import type { DriverTurnLog, RunPaths, Scenario } from "./types.ts";
import type { TimelineEvent } from "./correlate.ts";
import { hasGapNote, GAP_NOTE_MARKER } from "./user-simulator.ts";

// Mirrors tools/scenario-shop/src/catalog.ts's PurchaseRecord (duplicated
// rather than imported — see docs/architecture/behavior-comparator.md on
// keeping tools/* packages independently runnable).
type PurchaseRecord = {
  productId: string;
  name: string;
  brand: string;
  quantity: number;
  unitPrice: number;
  shippingCost: number;
  totalPrice: number;
  currency: string;
  purchasedAt: string;
};

export type NancyBlockEvent = { ts: string; event: string; toolName?: string; reason?: string };

export type RunEvaluation = {
  scenarioId: string;
  branch: DriverTurnLog["branch"];
  userProfile: DriverTurnLog["userProfile"];
  runId: string;
  purchased: boolean;
  purchase?: PurchaseRecord;
  turnCount: number;
  clarifyingQuestionsAsked: number;
  nancyBlocks: NancyBlockEvent[];
  nancyNotes: string[];
  budgetRevealed?: number;
  budgetRespected?: boolean;
  stopReason: DriverTurnLog["stopReason"];
  durationMs: number;
};

export function evaluateRun(params: { scenario: Scenario; runPaths: RunPaths; turnLog: DriverTurnLog; timeline: TimelineEvent[] }): RunEvaluation {
  const { runPaths, turnLog, timeline } = params;

  const purchase: PurchaseRecord | undefined = existsSync(runPaths.purchaseStateFile)
    ? (JSON.parse(readFileSync(runPaths.purchaseStateFile, "utf8")) as PurchaseRecord[])[0]
    : undefined;

  const nancyBlocks: NancyBlockEvent[] = timeline
    .filter((e) => e.source === "nancy-log" && e.type.startsWith("blocked"))
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      const inner = (d.data as Record<string, unknown>) ?? {};
      return { ts: e.ts, event: e.type, toolName: (inner.toolName as string) ?? undefined, reason: (inner.reason as string) ?? undefined };
    });

  const nancyNotes = turnLog.assistantTurns
    .map((t) => t.assistantText)
    .filter((text) => hasGapNote(text))
    .map((text) => text.split(GAP_NOTE_MARKER)[1]?.trim() ?? text);

  const revealedTurn = turnLog.userTurns.find((t) => t.revealedBudgetEur !== undefined);
  const budgetRevealed = revealedTurn?.revealedBudgetEur;
  const budgetRespected = budgetRevealed !== undefined && purchase ? purchase.totalPrice <= budgetRevealed : undefined;

  const clarifyingQuestionsAsked = turnLog.assistantTurns.filter((t) => /\?\s*$/m.test(t.assistantText.trim())).length;

  const startedAt = new Date(turnLog.startedAt).getTime();
  const endedAt = turnLog.endedAt ? new Date(turnLog.endedAt).getTime() : startedAt;

  return {
    scenarioId: turnLog.scenarioId,
    branch: turnLog.branch,
    userProfile: turnLog.userProfile,
    runId: turnLog.runId,
    purchased: turnLog.stopReason === "purchase_detected" && !!purchase,
    purchase,
    turnCount: turnLog.userTurns.length,
    clarifyingQuestionsAsked,
    nancyBlocks,
    nancyNotes,
    budgetRevealed,
    budgetRespected,
    stopReason: turnLog.stopReason,
    durationMs: endedAt - startedAt,
  };
}
