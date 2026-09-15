// Minimal fake of the OpenClaw plugin host: just enough of registerTool()
// to exercise defineToolPlugin's real wiring (see
// node_modules/openclaw/dist/tool-plugin-*.mjs) against real scenario-shop
// tool logic, without needing a live gateway.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type RegisteredTool = { name: string; execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: AnyFn) => Promise<{ content: unknown; details: unknown }> };

export function createFakeApi(pluginConfig: Record<string, unknown>): {
  registerTool: (tool: RegisteredTool) => void;
  pluginConfig: Record<string, unknown>;
  rootDir: string;
  tools: Record<string, RegisteredTool>;
  cleanup: () => void;
} {
  const rootDir = mkdtempSync(join(tmpdir(), "scenario-shop-test-"));
  const tools: Record<string, RegisteredTool> = {};
  return {
    rootDir,
    pluginConfig,
    tools,
    registerTool(tool) {
      tools[tool.name] = tool;
    },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}
