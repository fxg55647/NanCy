import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNextMacroReviewInterval } from "../src/analysis/macro-review.ts";

test("fixed mode (default, and explicit) always returns the configured interval", () => {
  assert.equal(pickNextMacroReviewInterval(undefined), 10);
  assert.equal(pickNextMacroReviewInterval({}), 10);
  assert.equal(pickNextMacroReviewInterval({ mode: "fixed" }), 10);
  assert.equal(pickNextMacroReviewInterval({ mode: "fixed", interval: 5 }), 5);
});

test("random mode stays within [randomMin, randomMax] and can hit both ends", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const n = pickNextMacroReviewInterval({ mode: "random", randomMin: 1, randomMax: 20, randomMode: 10 });
    assert.ok(Number.isInteger(n));
    assert.ok(n >= 1 && n <= 20, `interval ${n} out of range`);
    seen.add(n);
  }
  // Over enough draws the full range should be reachable, including the edges.
  assert.ok(seen.has(1) || seen.has(2), "should occasionally draw near the low edge");
  assert.ok(seen.has(20) || seen.has(19), "should occasionally draw near the high edge");
});

test("random mode draws the configured mode value most often (triangular peak)", () => {
  const counts = new Map<number, number>();
  const trials = 5000;
  for (let i = 0; i < trials; i++) {
    const n = pickNextMacroReviewInterval({ mode: "random", randomMin: 1, randomMax: 20, randomMode: 10 });
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const modeCount = counts.get(10) ?? 0;
  const edgeLowCount = counts.get(1) ?? 0;
  const edgeHighCount = counts.get(20) ?? 0;
  assert.ok(modeCount > edgeLowCount, "10 should be drawn more often than the low edge");
  assert.ok(modeCount > edgeHighCount, "10 should be drawn more often than the high edge");
});

test("random mode degenerates safely when min === max", () => {
  assert.equal(pickNextMacroReviewInterval({ mode: "random", randomMin: 7, randomMax: 7, randomMode: 7 }), 7);
});

test("random mode clamps a mode value outside [min, max]", () => {
  const n = pickNextMacroReviewInterval({ mode: "random", randomMin: 1, randomMax: 20, randomMode: 999 });
  assert.ok(n >= 1 && n <= 20);
});
