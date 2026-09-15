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
// `env` is injected verbatim into the child `openclaw` process (with
// --auth-env-only, so no ambient stored credentials are used — see
// docs/architecture/behavior-comparator.md). `analysis` is NanCy's own
// reviewer model config, used only for the nancy branch.
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
import type { UserProfile } from "./types.ts";
import type { AnalysisModelConfig } from "./config-builder.ts";

type ModelConfig = { taskModel: string; env?: Record<string, string>; analysis: AnalysisModelConfig };

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

  for (const profile of profiles) {
    const baselineRunId = `${scenario.id}-baseline-${profile}`;
    const nancyRunId = `${scenario.id}-nancy-${profile}`;

    console.log(`\n=== ${scenario.id} / ${profile} / baseline ===`);
    const baselineResult = await runComparisonRun({
      scenario,
      branch: "baseline",
      userProfile: profile,
      runId: baselineRunId,
      runsRoot: outDir,
      taskModel: modelConfig.taskModel,
      env: modelConfig.env ?? {},
    });
    console.log(`  stopReason=${baselineResult.turnLog.stopReason} turns=${baselineResult.turnLog.userTurns.length}`);

    console.log(`=== ${scenario.id} / ${profile} / nancy ===`);
    const nancyResult = await runComparisonRun({
      scenario,
      branch: "nancy",
      userProfile: profile,
      runId: nancyRunId,
      runsRoot: outDir,
      taskModel: modelConfig.taskModel,
      analysis: modelConfig.analysis,
      env: modelConfig.env ?? {},
    });
    console.log(`  stopReason=${nancyResult.turnLog.stopReason} turns=${nancyResult.turnLog.userTurns.length}`);

    const baselineTimeline = buildTimeline(baselineResult.runPaths, baselineResult.turnLog);
    const nancyTimeline = buildTimeline(nancyResult.runPaths, nancyResult.turnLog);
    const baselineEval = evaluateRun({ scenario, runPaths: baselineResult.runPaths, turnLog: baselineResult.turnLog, timeline: baselineTimeline });
    const nancyEval = evaluateRun({ scenario, runPaths: nancyResult.runPaths, turnLog: nancyResult.turnLog, timeline: nancyTimeline });

    comparisons.push({ scenario, userProfile: profile, baseline: baselineEval, nancy: nancyEval, baselineTimeline, nancyTimeline });
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
