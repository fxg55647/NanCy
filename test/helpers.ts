// Minimal fake of the OpenClaw plugin host, just enough surface for
// register(api) in src/index.ts to run against a scratch directory instead
// of the real gateway. Not a full OpenClawPluginApi — cast at the call site.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type FakeApi = {
  rootDir: string;
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  runtime: {
    agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string };
    subagent: Record<string, AnyFn>;
  };
  on: (event: string, handler: AnyFn, opts?: { timeoutMs?: number }) => void;
};

export function createFakeApi(opts: {
  pluginConfig?: Record<string, unknown>;
  subagent?: Record<string, AnyFn>;
} = {}): { api: FakeApi; handlers: Record<string, AnyFn>; hookOptions: Record<string, { timeoutMs?: number } | undefined>; rootDir: string; cleanup: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), "nancy-test-"));
  const handlers: Record<string, AnyFn> = {};
  const hookOptions: Record<string, { timeoutMs?: number } | undefined> = {};
  const api: FakeApi = {
    rootDir,
    pluginConfig: opts.pluginConfig ?? {},
    config: {},
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: (_config: unknown, agentId: string) => join(rootDir, "workspace", agentId || "main"),
      },
      subagent: opts.subagent ?? {
        run: async () => ({ runId: "run-1" }),
        waitForRun: async () => ({ status: "ok" }),
        deleteSession: async () => { },
        complete: async () => ({ text: "" }),
        getSessionMessages: async () => ({ messages: [] }),
      },
    },
    on(event, handler, hookOpts) {
      handlers[event] = handler;
      hookOptions[event] = hookOpts;
    },
  };
  return { api, handlers, hookOptions, rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

// Polls a real timer (mocks here resolve immediately, so this settles fast)
// rather than pretending to know how many microtask ticks the fix takes.
export function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: timed out waiting for condition"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function confirmationContent(id: string, description: string): string {
  return `Formal confirmation: ${description}\nReply y to proceed, any other reply cancels.\n${id}`;
}
