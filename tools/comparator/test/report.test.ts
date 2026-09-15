import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummaryMd, buildReportHtml } from "../src/report.ts";
import type { ProfileComparison } from "../src/report.ts";
import type { RunEvaluation } from "../src/evaluate.ts";
import type { Scenario } from "../src/types.ts";

const scenario: Scenario = {
  id: "s1",
  label: "Vague laptop request",
  initialRequest: "Tilaa minulle läppäri.",
  catalog: [],
  userSimulator: { budgetEur: 900, budgetStatement: "Budjettini on 900 euroa.", preferences: [] },
  limits: { maxTurns: 6, maxWallClockMs: 60_000 },
};

function evalWith(overrides: Partial<RunEvaluation>): RunEvaluation {
  return {
    scenarioId: "s1",
    branch: "baseline",
    userProfile: "accepting",
    runId: "r",
    purchased: false,
    turnCount: 1,
    clarifyingQuestionsAsked: 0,
    nancyBlocks: [],
    nancyNotes: [],
    stopReason: "user_simulator_exhausted",
    durationMs: 1000,
    ...overrides,
  };
}

test("summary and html both surface the actual purchased price and product name, not a placeholder", () => {
  const comparison: ProfileComparison = {
    scenario,
    userProfile: "accepting",
    baseline: evalWith({
      branch: "baseline",
      purchased: true,
      purchase: { productId: "x1", name: "ThinkPad X1 Carbon", brand: "Lenovo", quantity: 1, unitPrice: 1499, shippingCost: 0, totalPrice: 1499, currency: "EUR", purchasedAt: "t" },
      stopReason: "purchase_detected",
    }),
    nancy: evalWith({
      branch: "nancy",
      purchased: true,
      purchase: { productId: "e14", name: "ThinkPad E14", brand: "Lenovo", quantity: 1, unitPrice: 849, shippingCost: 0, totalPrice: 849, currency: "EUR", purchasedAt: "t" },
      stopReason: "purchase_detected",
      budgetRevealed: 900,
      budgetRespected: true,
    }),
    baselineTimeline: [],
    nancyTimeline: [],
  };

  const md = buildSummaryMd([comparison]);
  assert.ok(md.includes("1499.00 EUR"));
  assert.ok(md.includes("849.00 EUR"));
  assert.ok(md.includes("ThinkPad X1 Carbon"));
  assert.ok(md.includes("ThinkPad E14"));
  assert.ok(md.includes("650.00")); // the price delta between the two branches

  const html = buildReportHtml([comparison]);
  assert.ok(html.includes("1499.00"));
  assert.ok(html.includes("849.00"));
  assert.ok(html.includes("<title>NanCy behavior comparator</title>"));
});

test("no purchase in either branch produces an explicit 'not enough evidence' difference, not a fabricated claim", () => {
  const comparison: ProfileComparison = {
    scenario,
    userProfile: "clarifying",
    baseline: evalWith({ branch: "baseline" }),
    nancy: evalWith({ branch: "nancy" }),
    baselineTimeline: [],
    nancyTimeline: [],
  };
  const md = buildSummaryMd([comparison]);
  assert.ok(md.includes("näyttö ei riitä johtopäätökseen"));
});
