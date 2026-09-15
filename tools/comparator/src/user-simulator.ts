// The two user-simulator profiles (spec: hyväksyvä / täsmentävä). Only ever
// sees the assistant's latest text — never the scenario's hidden fields
// directly — and decides what a human in that role would plausibly type
// next, or that there's nothing left to say.
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

function looksLikeQuestion(text: string): boolean {
  return /\?\s*$/m.test(text.trim());
}

function mentionsBudgetOrPrice(text: string): boolean {
  return /budjet|hint(a|araja|aluokk)|hintakatto|price|budget|cost|euro/i.test(text);
}

export function decideUserReply(params: {
  profile: UserProfile;
  scenario: Scenario;
  assistantText: string;
  alreadyRevealedBudget: boolean;
}): UserSimulatorDecision {
  const { profile, scenario, assistantText, alreadyRevealedBudget } = params;
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
    // not something to paper over.
    if (profile === "clarifying" && !alreadyRevealedBudget && hasGapNote(text)) {
      return { action: "reply", message: scenario.userSimulator.budgetStatement, revealedBudgetEur: scenario.userSimulator.budgetEur };
    }
    return { action: "reply", message: "y" };
  }

  if (looksLikeQuestion(text)) {
    if (mentionsBudgetOrPrice(text)) {
      return { action: "reply", message: scenario.userSimulator.budgetStatement, revealedBudgetEur: scenario.userSimulator.budgetEur };
    }
    // A direct non-budget question: both profiles answer from the
    // scenario's stated preferences rather than staying silent — this
    // never counts as revealing the budget.
    return { action: "reply", message: scenario.userSimulator.preferences.join(" ") };
  }

  if (profile === "clarifying" && !alreadyRevealedBudget && hasGapNote(text)) {
    // Defensive fallback: a gap note outside the fixed confirmation
    // template shouldn't normally happen (gap notes are only ever
    // appended to confirmations — see gap-detection.ts), but handle it.
    return { action: "reply", message: scenario.userSimulator.budgetStatement, revealedBudgetEur: scenario.userSimulator.budgetEur };
  }

  // No question, no confirmation, nothing new to add — natural end of the
  // conversation from the user's side. The accepting profile in particular
  // never volunteers unprompted information (spec §4).
  return { action: "stop" };
}
