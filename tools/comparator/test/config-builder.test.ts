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

// "google" is the only provider config-builder.ts currently knows how to
// declaratively register (see its PROVIDER_REGISTRATION) — an arbitrary
// string like "openai/gpt-test" now correctly throws (see the dedicated
// test below), so every other fixture here uses a supported provider.
const TASK_MODEL = "google/gemini-test";
const TASK_MODEL_ENV = { GEMINI_API_KEY: "test-key" };
// buildRun requires a port to write into gateway.port config — these tests
// only inspect the generated config, they never actually start a gateway,
// so a fixed dummy value is fine.
const TEST_GATEWAY_PORT = 19999;

function withTempRoot(fn: (runsRoot: string) => void) {
  const runsRoot = mkdtempSync(join(tmpdir(), "comparator-test-"));
  try {
    fn(runsRoot);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

test("baseline branch never loads nancy, but does get the branch-neutral shopping-agent AGENTS.md (no confirmation section)", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r1", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: TEST_GATEWAY_PORT });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.equal(config.plugins.entries.nancy, undefined);
    assert.equal(config.plugins.load.paths.length, 2, "baseline should only load scenario-shop + checkpoint-recorder");
    assert.deepEqual(config.plugins.allow, ["scenario-shop", "checkpoint-recorder"]);
    const agentsMd = readFileSync(join(paths.workspaceDir, "AGENTS.md"), "utf8");
    assert.ok(agentsMd.includes("search_products"), "baseline must still get the shopping-agent framing, or the model has no reason to use these tools");
    assert.ok(!agentsMd.includes("Formal confirmation:"), "baseline must NOT get NanCy's confirmation-protocol instructions");
  });
});

test("nancy branch loads nancy's plugin dir, writes AGENTS.md with both the shopping-agent framing and the confirmation section, and sets telegram off", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({
      scenario,
      branch: "nancy",
      runId: "r2",
      runsRoot,
      taskModel: TASK_MODEL,
      taskModelEnv: TASK_MODEL_ENV,
      analysis: { provider: "gemini", model: "gemini-test", apiKey: "test-key" },
      gatewayPort: TEST_GATEWAY_PORT,
    });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.ok(config.plugins.entries.nancy);
    assert.equal(config.plugins.load.paths.length, 3, "nancy branch should load scenario-shop + checkpoint-recorder + nancy");
    assert.deepEqual(config.plugins.allow, ["scenario-shop", "checkpoint-recorder", "nancy"]);
    assert.equal(config.plugins.entries.nancy.config.telegramAlerts, false);
    assert.equal(config.plugins.entries.nancy.config.analysis.apiKey, "test-key");
    const agentsMd = readFileSync(join(paths.workspaceDir, "AGENTS.md"), "utf8");
    assert.ok(agentsMd.includes("search_products"), "nancy branch must also get the shopping-agent framing, not just the confirmation section");
    assert.ok(agentsMd.includes("Formal confirmation:"));
    assert.ok(agentsMd.includes("Reply y to proceed, any other reply cancels."));
    // The nancy plugin dir loaded is a fresh per-run copy nested under
    // runDir, not the shared repo root — see copyNancyPluginForRun's
    // comment in config-builder.ts for why.
    const nancyPluginPath = config.plugins.load.paths[2] as string;
    assert.ok(nancyPluginPath.startsWith(paths.runDir), `expected the nancy plugin path to be a per-run copy under ${paths.runDir}, got ${nancyPluginPath}`);
    assert.ok(existsSync(join(nancyPluginPath, "src", "index.ts")));
  });
});

test("nancy branch without an analysis config throws rather than silently loading NanCy unconfigured", () => {
  withTempRoot((runsRoot) => {
    assert.throws(() => buildRun({ scenario, branch: "nancy", runId: "r3", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: TEST_GATEWAY_PORT }));
  });
});

test("writes the scenario catalog verbatim to catalogPath", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r4", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: TEST_GATEWAY_PORT });
    const catalog = JSON.parse(readFileSync(paths.catalogPath, "utf8"));
    assert.deepEqual(catalog, scenario.catalog);
  });
});

test("agents.entries.test-agent is scoped to exactly the scenario-shop + message tools", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r5", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: TEST_GATEWAY_PORT });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.deepEqual(config.agents.entries["test-agent"].tools.allow, ["search_products", "buy_product", "message"]);
    assert.equal(config.agents.entries["test-agent"].model, TASK_MODEL);
  });
});

test("declares gateway.mode=local, the given port, loopback bind, and auth mode none", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r9", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: 24681 });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.deepEqual(config.gateway, { mode: "local", port: 24681, bind: "loopback", auth: { mode: "none" } });
  });
});

test("declares the A2A channel with an env-interpolated peer token (never the SecretRef object form — A2A's schema rejects it)", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({ scenario, branch: "baseline", runId: "r10", runsRoot, taskModel: TASK_MODEL, taskModelEnv: TASK_MODEL_ENV, gatewayPort: TEST_GATEWAY_PORT });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    assert.equal(config.channels.a2a.enabled, true);
    const peer = Object.values(config.channels.a2a.peers)[0] as { token: unknown };
    assert.equal(typeof peer.token, "string");
    assert.match(peer.token as string, /^\$\{[A-Z0-9_]+\}$/, "must be \"${ENV_VAR}\" interpolation, not a {source:\"env\",...} SecretRef object");
    assert.equal(config.channels.a2a.rateLimitPerMinute, 0, "the default 30/min throttle hit a real run's GetTask poll loop mid-turn — disabled for this private single-peer test Gateway");
  });
});

test("declares the task model under top-level models.providers (required — see PROVIDER_REGISTRATION's comment: a headless run can't discover an undeclared model on its own)", () => {
  withTempRoot((runsRoot) => {
    const paths = buildRun({
      scenario,
      branch: "baseline",
      runId: "r6",
      runsRoot,
      taskModel: TASK_MODEL,
      taskModelEnv: TASK_MODEL_ENV,
      taskModelDefinition: { name: "Gemini Test", contextWindow: 1_000_000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      gatewayPort: TEST_GATEWAY_PORT,
    });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    const provider = config.models.providers.google;
    assert.equal(provider.apiKey, "test-key");
    assert.equal(provider.api, "google-generative-ai");
    assert.equal(provider.models.length, 1);
    assert.equal(provider.models[0].id, "gemini-test");
    assert.equal(provider.models[0].name, "Gemini Test");
    assert.equal(provider.models[0].contextWindow, 1_000_000);
  });
});

test("an unsupported taskModel provider throws with a clear message instead of producing a config that will fail at CLI time", () => {
  withTempRoot((runsRoot) => {
    assert.throws(
      () => buildRun({ scenario, branch: "baseline", runId: "r7", runsRoot, taskModel: "openai/gpt-test", taskModelEnv: {}, gatewayPort: TEST_GATEWAY_PORT }),
      /no declarative models\.providers registration for provider "openai"/,
    );
  });
});

test("a supported provider with no matching env key throws instead of writing a config with no usable apiKey", () => {
  withTempRoot((runsRoot) => {
    assert.throws(
      () => buildRun({ scenario, branch: "baseline", runId: "r8", runsRoot, taskModel: TASK_MODEL, taskModelEnv: {}, gatewayPort: TEST_GATEWAY_PORT }),
      /needs one of GEMINI_API_KEY\/GOOGLE_API_KEY/,
    );
  });
});
