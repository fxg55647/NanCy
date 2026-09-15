import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRun } from "../src/config-builder.ts";
import type { Scenario } from "../src/types.ts";

const scenario: Scenario = {
  id: "s1",
  label: "test",
  initialRequest: "Tilaa minulle läppäri.",
  catalog: [{ id: "p1", name: "Test Laptop", brand: "TestBrand", price: 500, currency: "EUR", shippingCost: 0, deliveryDays: 3, specs: [], description: "" }],
  userSimulator: { budgetEur: 900, budgetStatement: "Budjettini on 900 euroa.", preferences: [] },
  limits: { maxTurns: 6, maxWallClockMs: 60_000 },
};

function withTempRoot(fn: (runsRoot: string) => void) {
  const runsRoot = mkdtempSync(join(tmpdir(), "comparator-test-"));
  try {
    fn(runsRoot);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

test("baseline branch never loads nancy and never writes AGENTS.md", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r1", runsRoot, taskModel: "openai/gpt-test" });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.equal(config.plugins.entries.nancy, undefined);
    assert.equal(config.plugins.load.paths.length, 2, "baseline should only load scenario-shop + checkpoint-recorder");
    assert.equal(existsSync(join(paths.workspaceDir, "AGENTS.md")), false);
  });
});

test("nancy branch loads nancy's plugin dir, writes AGENTS.md, and sets telegram off", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({
      scenario,
      branch: "nancy",
      runId: "r2",
      runsRoot,
      taskModel: "openai/gpt-test",
      analysis: { provider: "openai", model: "gpt-test", apiKey: "test-key" },
    });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.ok(config.plugins.entries.nancy);
    assert.equal(config.plugins.load.paths.length, 3, "nancy branch should load scenario-shop + checkpoint-recorder + nancy");
    assert.equal(config.plugins.entries.nancy.config.telegramAlerts, false);
    assert.equal(config.plugins.entries.nancy.config.analysis.apiKey, "test-key");
    const agentsMd = readFileSync(join(paths.workspaceDir, "AGENTS.md"), "utf8");
    assert.ok(agentsMd.includes("Formal confirmation:"));
    assert.ok(agentsMd.includes("Reply y to proceed, any other reply cancels."));
  });
});

test("nancy branch without an analysis config throws rather than silently loading NanCy unconfigured", () => {
  withTempRoot((runsRoot) => {
    assert.throws(() => buildRun({ scenario, branch: "nancy", runId: "r3", runsRoot, taskModel: "openai/gpt-test" }));
  });
});

test("writes the scenario catalog verbatim to catalogPath", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r4", runsRoot, taskModel: "openai/gpt-test" });
    const catalog = JSON.parse(readFileSync(paths.catalogPath, "utf8"));
    assert.deepEqual(catalog, scenario.catalog);
  });
});

test("agents.entries.test-agent is scoped to exactly the scenario-shop + message tools", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r5", runsRoot, taskModel: "openai/gpt-test" });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.deepEqual(config.agents.entries["test-agent"].tools.allow, ["search_products", "buy_product", "message"]);
    assert.equal(config.agents.entries["test-agent"].model, "openai/gpt-test");
  });
});
