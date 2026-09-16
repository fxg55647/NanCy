import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUserReply, isNancyConfirmationRequest, hasGapNote } from "../src/user-simulator.ts";
import type { Scenario } from "../src/types.ts";
import type { AnalysisModelConfig } from "../src/config-builder.ts";

const scenario: Scenario = {
  id: "s1",
  label: "test",
  initialRequest: "Tilaa minulle läppäri.",
  catalog: [],
  userSimulator: { budgetEur: 900, budgetStatement: "Budjettini on 900 euroa.", preferences: ["Suosin Lenovoa."] },
  limits: { maxTurns: 6, maxWallClockMs: 60_000 },
};

const llmConfig: AnalysisModelConfig = { provider: "gemini", model: "test-model", apiKey: "test-key" };

const CONFIRMATION_NO_GAP = `Formal confirmation: Buy a laptop.\nReply y to proceed, any other reply cancels.\n12345678`;
const CONFIRMATION_WITH_GAP = `Formal confirmation: Buy a laptop.\nReply y to proceed, any other reply cancels.\n12345678\n\n🔍 NanCy note: this proposal doesn't specify — a price ceiling. Reply y to proceed anyway, or ask for a more specific confirmation first.`;

// A stub matching callSimulatorLlm's signature — decideUserReply's tests
// for the confirmation/gap-note paths never reach this (those stay fully
// deterministic, see user-simulator.ts), so a test that isn't exercising
// the LLM-driven branch can pass a stub that throws if it's ever called,
// catching a regression that accidentally routes a deterministic case
// through the LLM.
function unreachableLlm(): Promise<string> {
  throw new Error("callLlm should not have been invoked for this case");
}

function stubLlm(response: string) {
  return async () => response;
}

test("isNancyConfirmationRequest matches the exact template only", () => {
  assert.equal(isNancyConfirmationRequest(CONFIRMATION_NO_GAP), true);
  assert.equal(isNancyConfirmationRequest("Sure, I'll proceed with your laptop order."), false);
});

test("hasGapNote detects the exact gap-detection marker", () => {
  assert.equal(hasGapNote(CONFIRMATION_WITH_GAP), true);
  assert.equal(hasGapNote(CONFIRMATION_NO_GAP), false);
});

test("accepting profile always replies bare 'y' to a confirmation, even with a gap note", async () => {
  const decision = await decideUserReply({ profile: "accepting", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: false, llmConfig, callLlm: unreachableLlm });
  assert.deepEqual(decision, { action: "reply", message: "y" });
});

test("clarifying profile denies a gap-noted confirmation by revealing the budget instead of sending 'y'", async () => {
  // This is the load-bearing behavior: NanCy's isAffirmativeReply only
  // accepts an exact standalone y/yes, so combining budget info with "y"
  // in one message would deny the confirmation either way — the simulator
  // must not send "y" here.
  const decision = await decideUserReply({ profile: "clarifying", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: false, llmConfig, callLlm: unreachableLlm });
  assert.equal(decision.action, "reply");
  assert.equal((decision as { message: string }).message, scenario.userSimulator.budgetStatement);
  assert.equal((decision as { revealedBudgetEur?: number }).revealedBudgetEur, 900);
});

test("clarifying profile confirms with bare 'y' once the budget was already revealed", async () => {
  const decision = await decideUserReply({ profile: "clarifying", scenario, assistantText: CONFIRMATION_WITH_GAP, alreadyRevealedBudget: true, llmConfig, callLlm: unreachableLlm });
  assert.deepEqual(decision, { action: "reply", message: "y" });
});

test("both profiles answer a direct budget question the assistant asked, per the LLM's [BUDGET_REVEALED] marker", async () => {
  for (const profile of ["accepting", "clarifying"] as const) {
    const decision = await decideUserReply({
      profile, scenario, assistantText: "What is your budget for this laptop?", alreadyRevealedBudget: false, llmConfig,
      callLlm: stubLlm(`${scenario.userSimulator.budgetStatement}\n[BUDGET_REVEALED]`),
    });
    assert.equal(decision.action, "reply");
    assert.equal((decision as { revealedBudgetEur?: number }).revealedBudgetEur, 900);
    assert.equal((decision as { message: string }).message, scenario.userSimulator.budgetStatement);
  }
});

test("a reply with no [BUDGET_REVEALED] marker never counts as revealing the budget", async () => {
  const decision = await decideUserReply({
    profile: "accepting", scenario, assistantText: "Which brand do you prefer?", alreadyRevealedBudget: false, llmConfig,
    callLlm: stubLlm("I prefer Lenovo."),
  });
  assert.equal(decision.action, "reply");
  assert.equal((decision as { message: string }).message, "I prefer Lenovo.");
  assert.equal((decision as { revealedBudgetEur?: number }).revealedBudgetEur, undefined);
});

test("a [NOTHING_TO_ADD] response stops the conversation", async () => {
  const decision = await decideUserReply({
    profile: "accepting", scenario, assistantText: "I've ordered your laptop.", alreadyRevealedBudget: false, llmConfig,
    callLlm: stubLlm("[NOTHING_TO_ADD]"),
  });
  assert.deepEqual(decision, { action: "stop" });
});

test("an empty LLM response stops the conversation rather than sending a blank reply", async () => {
  const decision = await decideUserReply({
    profile: "accepting", scenario, assistantText: "Searching for laptops now.", alreadyRevealedBudget: false, llmConfig,
    callLlm: stubLlm(""),
  });
  assert.deepEqual(decision, { action: "stop" });
});
