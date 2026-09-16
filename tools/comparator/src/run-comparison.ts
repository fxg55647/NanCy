// CLI entry point: runs one scenario through both branches (baseline,
// nancy) and both user-simulator profiles (accepting, clarifying) — 4 real
// OpenClaw agent runs in total — and writes the comparison report.
//
// Usage:
//   node --experimental-strip-types tools/comparator/src/run-comparison.ts \
//     --scenario=tools/comparator/scenarios/laptop-vague-request.json \
//     --model-config=<path to a local, gitignored JSON credentials file>
//
// model-config.json shape:
//   { "taskModel": "provider/model", "env": {"OPENAI_API_KEY": "..."},
//     "analysis": {"provider": "openai", "model": "...", "apiKey": "..."} }
// `env` is injected into the child `openclaw` process on top of this
// process's own environment with every known provider credential env var
// stripped first (see driver.ts's STRIPPED_BASE_ENV), so no ambient stored
// credentials are used unless this file explicitly supplies them.
// `analysis` is NanCy's own reviewer model config, used only for the
// nancy branch.
//
// This makes real, billed model API calls. Round/time limits come from the
// scenario file's own `limits` — see scenarios/laptop-vague-request.json.
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadScenario } from "./scenario.ts";
import { runComparisonRun } from "./driver.ts";
import { buildTimeline } from "./correlate.ts";
import { evaluateRun } from "./evaluate.ts";
import { writeReport } from "./report.ts";
import type { ProfileComparison } from "./report.ts";
import type { Branch, UserProfile } from "./types.ts";
import type { AnalysisModelConfig, TaskModelDefinition } from "./config-builder.ts";
import type { RunEvaluation } from "./evaluate.ts";
import type { TimelineEvent } from "./correlate.ts";

type ModelConfig = { taskModel: string; taskModelDefinition?: TaskModelDefinition; env?: Record<string, string>; analysis: AnalysisModelConfig };

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const scenarioPath = arg("scenario");
  const modelConfigPath = arg("model-config");
  if (!scenarioPath || !modelConfigPath) {
    console.error("Usage: run-comparison.ts --scenario=<path> --model-config=<path> [--out=<dir>]");
    process.exitCode = 1;
    return;
  }

  const scenario = loadScenario(scenarioPath);
  const modelConfig = JSON.parse(readFileSync(modelConfigPath, "utf8")) as ModelConfig;
  if (!modelConfig.taskModel || !modelConfig.analysis) {
    console.error(`${modelConfigPath} must define both "taskModel" and "analysis" — see this file's header comment.`);
    process.exitCode = 1;
    return;
  }

  const outDir = arg("out") ?? join(process.cwd(), "tools", "comparator", "runs", `run-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  const profiles: UserProfile[] = ["accepting", "clarifying"];
  const comparisons: ProfileComparison[] = [];

  async function runBranch(branch: Branch, profile: UserProfile): Promise<{ evaluation: RunEvaluation; timeline: TimelineEvent[] }> {
    const runId = `${scenario.id}-${branch}-${profile}`;
    console.log(`\n=== ${scenario.id} / ${profile} / ${branch} ===`);
    const result = await runComparisonRun({
      scenario,
      branch,
      userProfile: profile,
      runId,
      runsRoot: outDir,
      taskModel: modelConfig.taskModel,
      taskModelDefinition: modelConfig.taskModelDefinition,
      analysis: branch === "nancy" ? modelConfig.analysis : undefined,
      // The user-simulator needs its own LLM in both branches — reuses the
      // same (cheap) model config as NanCy's reviewer rather than
      // requiring a third credential set. See user-simulator.ts.
      userSimulatorModel: modelConfig.analysis,
      env: modelConfig.env ?? {},
    });
    console.log(`  stopReason=${result.turnLog.stopReason} turns=${result.turnLog.userTurns.length}`);
    const timeline = buildTimeline(result.runPaths, result.turnLog);
    const evaluation = evaluateRun({ scenario, runPaths: result.runPaths, turnLog: result.turnLog, timeline });
    return { evaluation, timeline };
  }

  for (const profile of profiles) {
    // Branch order is randomized per profile rather than always
    // baseline-then-nancy, so that when this is later run repeatedly
    // (spec's multi-run mode — see docs/architecture/behavior-comparator.md's
    // "Explicitly deferred"), ordering effects (e.g. provider warm-up,
    // time-of-day) can't systematically favor one branch. The report
    // itself is order-independent — only which branch produced which
    // facts matters, never which ran first.
    const branchOrder: Branch[] = Math.random() < 0.5 ? ["baseline", "nancy"] : ["nancy", "baseline"];
    const results: Partial<Record<Branch, { evaluation: RunEvaluation; timeline: TimelineEvent[] }>> = {};
    for (const branch of branchOrder) {
      results[branch] = await runBranch(branch, profile);
    }
    const baseline = results.baseline!;
    const nancy = results.nancy!;

    comparisons.push({ scenario, userProfile: profile, baseline: baseline.evaluation, nancy: nancy.evaluation, baselineTimeline: baseline.timeline, nancyTimeline: nancy.timeline });
  }

  writeReport({ outDir, comparisons });
  console.log(`\nReport written to ${outDir}:`);
  console.log(`  - ${join(outDir, "results.json")}`);
  console.log(`  - ${join(outDir, "SUMMARY.md")}`);
  console.log(`  - ${join(outDir, "report.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
