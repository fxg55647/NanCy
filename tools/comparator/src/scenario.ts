import { readFileSync } from "fs";
import type { Scenario } from "./types.ts";

export function loadScenario(path: string): Scenario {
  const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
  if (!scenario.id || !scenario.initialRequest || !Array.isArray(scenario.catalog)) {
    throw new Error(`${path}: scenario file must have id, initialRequest, and a catalog array`);
  }
  return scenario;
}
