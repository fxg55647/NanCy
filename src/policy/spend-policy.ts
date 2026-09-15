// DRAFT — sketch only, not wired into index.ts yet. See chat discussion
// 2026-09-15 for the rationale: this is deliberately a narrow, deterministic
// pre-LLM gate for money-shaped tool calls, NOT a generalization of the
// CLARIFY verdict (see docs/architecture/denial-escalation-and-clarification.md's
// Part C — that stays out of scope: this gate never suspends a worker or
// issues a continuation ticket, it only pauses ONE call for a yes/no).
//
// Open questions before this could ship (do not treat as done):
//  - Re-verify session/task freshness (mirrors index.ts's stale-authorization
//    check around the "verdict === allow" branch) once the approval actually
//    resolves, not just before requireApproval is returned — a human can take
//    minutes to answer, during which the session could end or the task could
//    change. requireApproval's onResolution callback cannot itself flip the
//    Gateway's already-made decision, so this may need to happen via a
//    denial-recording side effect (e.g. logging + hard-block a *following*
//    call) rather than reversing this one.
//  - Whether a deny here should count as a securitySignal denial via
//    recordDenial (probably not by default — the user actively said no to a
//    legitimate-looking gate, not to something NanCy judged hostile) or stay
//    a separate, non-punitive reason code.
//  - Real tool/param coverage: MONEY_SHAPED_TOOLS below only knows about
//    tools/scenario-shop's buy_product (expectedTotal/currency) as a concrete
//    example. A real deployment needs one entry per payment-capable tool the
//    operator actually has configured (a checkout tool, an invoicing MCP
//    server, etc.) — there's no generic way to detect "this call spends
//    money" across arbitrary third-party tool schemas.
//  - allowedDecisions deliberately omits "allow-always": NanCy has no
//    existing mechanism to persist per-user/per-payee trust, and a payment
//    gate is exactly the kind of decision that should default to asking
//    every time rather than silently escalating to a standing grant.

export interface SpendIntent {
  amount: string; // exact decimal string, never a float — see plugin-permission-requests.md
  currency: string;
  target: string; // payee / payment system, e.g. "Stripe checkout", the shop name
}

// One entry per tool whose params carry a money amount NanCy should gate.
// Field names are tool-specific by nature (see open questions above).
const MONEY_SHAPED_TOOLS: Record<string, (params: Record<string, unknown>) => SpendIntent | null> = {
  // tools/scenario-shop's buy_product — see tools/scenario-shop/src/index.ts.
  buy_product: (params) => {
    const amount = params.expectedTotal;
    const currency = params.currency;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    if (typeof currency !== "string" || !currency) return null;
    return { amount: amount.toFixed(2), currency, target: "buy_product order" };
  },
};

// Deliberately conservative fallback for tools this file doesn't know about
// yet: a generic "amount"/"price"/"total" + "currency" pair in the params.
// False negatives (an unrecognized payment tool slipping through ungated)
// are expected and acceptable here — this gate is additive on top of the
// existing LLM review, never a replacement for it.
function genericMoneyGuess(params: Record<string, unknown>): SpendIntent | null {
  const amountKey = ["amount", "price", "total", "expectedTotal"].find(
    k => typeof params[k] === "number" && Number.isFinite(params[k] as number),
  );
  const currencyKey = ["currency", "currencyCode"].find(k => typeof params[k] === "string" && params[k]);
  if (!amountKey || !currencyKey) return null;
  return {
    amount: (params[amountKey] as number).toFixed(2),
    currency: params[currencyKey] as string,
    target: "unrecognized payment-shaped tool call",
  };
}

export function detectSpendIntent(toolName: string, params: unknown): SpendIntent | null {
  const p = (params as Record<string, unknown>) ?? {};
  const known = MONEY_SHAPED_TOOLS[toolName];
  if (known) return known(p);
  return genericMoneyGuess(p);
}

// Shape matches OpenClaw's PluginHookBeforeToolCallResult["requireApproval"]
// (node_modules/openclaw/dist/hook-runner-global-*.d.ts) — kept as a plain
// object here rather than importing that type, since this file is a
// standalone sketch and hasn't been checked against the plugin SDK's actual
// exported type path yet.
export function buildSpendApproval(intent: SpendIntent, toolName: string) {
  return {
    title: `Pay via ${toolName}`,
    description: `${toolName} would spend ${intent.amount} ${intent.currency} (${intent.target}). Approve only if you intended this exact purchase.`,
    scope: { kind: "payment" as const, amount: intent.amount, currency: intent.currency, target: intent.target },
    severity: "warning" as const,
    // No "allow-always" — see open questions above.
    allowedDecisions: ["allow-once", "deny"] as const,
    timeoutMs: 120_000,
  };
}
