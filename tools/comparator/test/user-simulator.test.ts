import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUserReply, isNancyConfirmationRequest, hasGapNote } from "../src/user-simulator.ts";
import type { Scenario } from "../src/types.ts";

const scenario: Scenario = {
  id: "s1",
  label: "test",
  initialRequest: "Tilaa minulle läppäri.",
  catalog: [],
  userSimulator: { budgetEur: 900, budgetStatement: "Budjettini on 900 euroa.", preferences: ["Suosin Lenovoa."] },
  limits: { maxTurns: 6, maxWallClockMs: 60_000 },
};

const CONFIRMATION_NO_GAP = `Formal confirmation: Buy a laptop.\nReply y to proceed, any other reply cancels.\n12345678`;
const CONFIRMATION_WITH_GAP = `Formal confirmation: Buy a laptop.\nReply y to proceed, any other reply cancels.\n12345678\n\n🔍 NanCy note: this proposal doesn't specify — a price ceiling. Reply y to proceed anyway, or ask for a more specific confirmation first.`;

test("isNancyConfirmationRequest matches the exact template only", () => {
  assert.equal(isNancyConfirmationRequest(CONFIRMATION_NO_GAP), true);
  assert.equal(isNancyConfirmationRequest("Sure, I'll proceed with your laptop order."), false);
});

test("hasGapNote detects the exact gap-detection marker", () => {
  assert.equal(hasGapNote(CONFIRMATION_WITH_GAP), true);
  assert.equal(hasGapNote(CONFIRMATION_NO_GAP), false);
});

test("accepting profile always replies bare 'y' to a confirmation, even with a gap note", () => {
  const decision = decideUserReply({ profile: "accepting", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: false });
  assert.deepEqual(decision, { action: "reply", message: "y" });
});

test("clarifying profile denies a gap-noted confirmation by revealing the budget instead of sending 'y'", () => {
  // This is the load-bearing behavior: NanCy's isAffirmativeReply only
  // accepts an exact standalone y/yes, so combining budget info with "y"
  // in one message would deny the confirmation either way — the simulator
  // must not send "y" here.
  const decision = decideUserReply({ profile: "clarifying", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: false });
  assert.equal(decision.action, "reply");
  assert.equal((decision as { message: string }).message, scenario.userSimulator.budgetStatement);
  assert.equal((decision as { revealedBudgetEur?: number }).revealedBudgetEur, 900);
});

test("clarifying profile confirms with bare 'y' once the budget was already revealed", () => {
  const decision = decideUserReply({ profile: "clarifying", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: true });
  assert.deepEqual(decision, { action: "reply", message: "y" });
});

test("both profiles answer a direct budget question the assistant asked", () => {
  for (const profile of ["accepting", "clarifying"] as const) {
    const decision = decideUserReply({ profile, scenario, assistantText: "What is your budget for this laptop?", alreadyRevealedBudget: false });
    assert.equal(decision.action, "reply");
    assert.equal((decision as { revealedBudgetEur?: number }).revealedBudgetEur, 900);
  }
});

test("a non-question, non-confirmation reply with nothing new to add stops the conversation", () => {
  const decision = decideUserReply({ profile: "accepting", scenario, assistantText: "I've ordered your laptop.", alreadyRevealedBudget: false });
  assert.deepEqual(decision, { action: "stop" });
});

test("accepting profile never volunteers the budget unprompted", () => {
  const decision = decideUserReply({ profile: "accepting", scenario, assistantText: "Searching for laptops now.", alreadyRevealedBudget: false });
  assert.deepEqual(decision, { action: "stop" });
});
