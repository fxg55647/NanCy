// Minimal fake of the OpenClaw plugin host, just enough surface for
// register(api) in src/index.ts to run against a scratch directory instead
// of the real gateway. Mirrors nancy's own test/helpers.ts pattern.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type FakeApi = {
  rootDir: string;
  pluginConfig: Record<string, unknown>;
  on: (event: string, handler: AnyFn) => void;
};

export function createFakeApi(pluginConfig: Record<string, unknown> = {}): {
  api: FakeApi;
  handlers: Record<string, AnyFn>;
  rootDir: string;
  cleanup: () => void;
} {
  const rootDir = mkdtempSync(join(tmpdir(), "checkpoint-recorder-test-"));
  const handlers: Record<string, AnyFn> = {};
  const api: FakeApi = {
    rootDir,
    pluginConfig,
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  return { api, handlers, rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}
