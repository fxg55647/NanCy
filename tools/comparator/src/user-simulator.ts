// The two user-simulator profiles (spec: hyväksyvä / täsmentävä). Only ever
// sees the assistant's latest text — never the scenario's hidden fields
// directly — and decides what a human in that role would plausibly type
// next, or that there's nothing left to say.
import type { AnalysisModelConfig } from "./config-builder.ts";
import type { Scenario, UserProfile } from "./types.ts";

export type UserSimulatorDecision = { action: "reply"; message: string; revealedBudgetEur?: number } | { action: "stop" };

// Based on src/confirmation/protocol.ts's parseConfirmationRequest, but
// deliberately NOT end-anchored: NanCy's gap-detection appends its own
// "🔍 NanCy note: ..." text after the id when it fires (see
// gap-detection.ts's appendGapNote), so what actually reaches the user can
// carry trailing content after the id. parseConfirmationRequest itself
// runs inside NanCy against the pre-append content and stays exact; this
// copy recognizes what the *simulated user* (standing in for a human
// reading the delivered message) actually sees. Duplicated rather than
// imported: this package must run standalone in the baseline branch,
// where NanCy's source isn't loaded into the isolated profile at all (see
// docs/architecture/behavior-comparator.md).
const NANCY_CONFIRMATION_RE = /^Formal confirmation:\s*([\s\S]*?)\s*\nReply y to proceed, any other reply cancels\.\s*\n(\d{6,10})/;
// Matches src/confirmation/gap-detection.ts's appendGapNote marker exactly.
export const GAP_NOTE_MARKER = "🔍 NanCy note:";

export function isNancyConfirmationRequest(text: string): boolean {
  return NANCY_CONFIRMATION_RE.test(text.trim());
}

export function hasGapNote(text: string): boolean {
  return text.includes(GAP_NOTE_MARKER);
}

// Real conversation can't be hard-coded against — a keyword regex here
// (the previous approach) is exactly as brittle as one anywhere else: a
// real run showed the SAME question ("what's your budget?") match or miss
// depending only on whether the assistant happened to say "Hinta" (a
// literal regex hit) versus a bare "849 EUR" with no price-labeling word
// at all — the regex was reacting to phrasing/language, not to what was
// actually being asked. Only a real LLM can reliably tell what a message
// — in any phrasing, any language — is actually asking, the way a human
// reading it would. See docs/architecture/behavior-comparator.md.
//
// The two sentinel markers below keep the *decision* (reveal the budget
// or not, answer at all or not) deterministic and auditable even though
// the exact wording is model-generated: evaluate.ts's budgetRespected
// check depends on knowing precisely when the budget was revealed, and
// that must never be inferred from parsing the model's own free-text
// reply after the fact.
const NOTHING_TO_ADD_MARKER = "[NOTHING_TO_ADD]";
const BUDGET_REVEALED_MARKER = "[BUDGET_REVEALED]";

function buildSimulatorSystemPrompt(scenario: Scenario): string {
  return [
    "You are simulating a real customer in a chat with a shopping assistant. You have exactly these facts about what you want, and no others:",
    `- Budget: ${scenario.userSimulator.budgetStatement}`,
    `- Preferences: ${scenario.userSimulator.preferences.join(" ")}`,
    "",
    "Rules:",
    "- Answer ONLY what the assistant's latest message actually asks you. Be as brief as a real person typing on their phone — usually one short sentence, never a list of everything you know.",
    "- Never volunteer a fact the assistant didn't ask about, even if you know it.",
    `- If (and only if) your reply states your budget or price limit, end it on its own new line with exactly: ${BUDGET_REVEALED_MARKER}`,
    `- If the assistant's message is a statement, a recommendation, a completed action, or otherwise doesn't actually ask you anything, reply with exactly: ${NOTHING_TO_ADD_MARKER}`,
    "- Never write anything else — no greeting, no explanation of what you're doing, no markup.",
    "- Reply in the same language the assistant used.",
  ].join("\n");
}

// A minimal, one-shot Gemini call standing in for a human's reading
// comprehension of the assistant's message — not NanCy's own analysis
// pipeline (src/analysis/client.ts), which this package must never import:
// it has to run standalone in the baseline branch, where NanCy's source
// isn't loaded into the isolated profile at all. Narrow on purpose
// (gemini/google only, no retries) to match config-builder.ts's own
// PROVIDER_REGISTRATION — extend only once another provider is verified
// the same way.
export async function callSimulatorLlm(config: AnalysisModelConfig, systemPrompt: string, assistantText: string): Promise<string> {
  if (config.provider !== "gemini" && config.provider !== "google") {
    throw new Error(`user-simulator: no LLM call implemented for provider "${config.provider}" — only gemini/google is supported so far.`);
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: assistantText }] }],
      generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!res.ok) throw new Error(`user-simulator LLM call failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return text.trim();
}

export async function decideUserReply(params: {
  profile: UserProfile;
  scenario: Scenario;
  assistantText: string;
  alreadyRevealedBudget: boolean;
  llmConfig: AnalysisModelConfig;
  // Injectable for tests — defaults to the real call.
  callLlm?: typeof callSimulatorLlm;
}): Promise<UserSimulatorDecision> {
  const { profile, scenario, assistantText, alreadyRevealedBudget, llmConfig, callLlm = callSimulatorLlm } = params;
  const text = assistantText.trim();
  if (!text) return { action: "stop" };

  if (isNancyConfirmationRequest(text)) {
    // NanCy accepts ONLY an exact standalone "y"/"yes" as consent — any
    // other reply denies the pending confirmation outright (see
    // src/confirmation/protocol.ts's isAffirmativeReply and
    // src/index.ts's message_received handler, which deletes the pending
    // confirmation before even checking whether the reply is affirmative).
    // So a clarifying-profile user can't smuggle extra info into the same
    // reply as "y" — doing so would just deny this confirmation. Instead,
    // when the confirmation carries NanCy's gap-detection note and the
    // budget hasn't been revealed yet, the reply here deliberately denies
    // this confirmation by revealing the budget instead, on the
    // expectation that a reasonable agent re-proposes a more specific
    // confirmation next turn. This is a real, observable friction point —
    // not something to paper over. Deliberately kept deterministic, not
    // routed through the LLM: NanCy's own reply-matching is exact-string,
    // so what the simulator sends here must be too.
    if (profile === "clarifying" && !alreadyRevealedBudget && hasGapNote(text)) {
      return { action: "reply", message: scenario.userSimulator.budgetStatement, revealedBudgetEur: scenario.userSimulator.budgetEur };
    }
    return { action: "reply", message: "y" };
  }

  if (profile === "clarifying" && !alreadyRevealedBudget && hasGapNote(text)) {
    // Defensive fallback: a gap note outside the fixed confirmation
    // template shouldn't normally happen (gap notes are only ever
    // appended to confirmations — see gap-detection.ts), but handle it
    // deterministically too, for the same reason as above.
    return { action: "reply", message: scenario.userSimulator.budgetStatement, revealedBudgetEur: scenario.userSimulator.budgetEur };
  }

  const raw = await callLlm(llmConfig, buildSimulatorSystemPrompt(scenario), text);
  if (!raw || raw.includes(NOTHING_TO_ADD_MARKER)) {
    // No question, no confirmation, nothing new to add — natural end of
    // the conversation from the user's side. The accepting profile in
    // particular never volunteers unprompted information (spec §4).
    return { action: "stop" };
  }
  const revealedBudget = raw.includes(BUDGET_REVEALED_MARKER);
  const message = raw.replaceAll(BUDGET_REVEALED_MARKER, "").trim();
  if (!message) return { action: "stop" };
  return { action: "reply", message, revealedBudgetEur: revealedBudget ? scenario.userSimulator.budgetEur : undefined };
}
