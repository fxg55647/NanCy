import { accessSync, constants, existsSync, realpathSync } from "fs";
import { dirname, basename, join, resolve, sep } from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function isWritable(filePath: string): boolean {
  try { accessSync(filePath, constants.W_OK); return true; }
  catch { return false; }
}

// resolveAgentWorkspaceDir requires an explicit agentId (falls back to the
// "main" agent if omitted, which is only correct for single-agent setups) —
// so workspace/protected-path resolution is done per agentId and cached,
// not computed once globally at startup.
export const DEFAULT_AGENT_ID = "main";

function buildAgentPaths(api: OpenClawPluginApi, agentId: string) {
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
  const PROTECTED_FILES = [
    { label: "AGENTS.md", path: join(workspaceDir, "AGENTS.md") },
    { label: "IDENTITY.md", path: join(workspaceDir, "IDENTITY.md") },
    { label: "MEMORY.md", path: join(workspaceDir, "MEMORY.md") },
    // Representative sentinel for the OS-writability boot audit (see
    // gateway_start) and for the LLM prompt's protected-files listing — the
    // actual write block below covers the whole nancy/src/ directory, not
    // just this one file, since NanCy's logic is split across many modules
    // under src/ (see NANCY_SRC_DIR).
    { label: "nancy/src/ (all NanCy source files)", path: join(api.rootDir ?? ".", "src", "index.ts") },
    { label: "nancy/openclaw.plugin.json", path: join(api.rootDir ?? ".", "openclaw.plugin.json") },
    { label: "nancy/NANCY-POLICY.md", path: join(api.rootDir ?? ".", "NANCY-POLICY.md") },
  ];
  const PROTECTED_PATHS = new Map(PROTECTED_FILES.map(f => [canonicalPath(f.path), f.label]));
  // tasks/ is now written exclusively by NanCy's own confirmation-reply
  // handling — the agent must not be able to write its own "confirmed"
  // record, or it could fabricate user consent that was never given.
  const TASKS_DIR = canonicalPath(resolve(workspaceDir, "tasks"));
  // NanCy's own logic lives under src/ as multiple modules (see CLAUDE.md) —
  // the whole directory must be protected, not just index.ts, or the agent
  // could defang NanCy by rewriting e.g. policy/tool-policy.ts instead.
  const NANCY_SRC_DIR = canonicalPath(resolve(api.rootDir ?? ".", "src"));
  return { workspaceDir, PROTECTED_FILES, PROTECTED_PATHS, TASKS_DIR, NANCY_SRC_DIR };
}

function platformPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

// Resolve filesystem aliases for an existing target. For a new target,
// resolve the nearest existing parent and append the missing suffix. This is
// still complemented by OS permissions; no user-space precheck can eliminate
// every symlink race between decision and write.
function canonicalPath(input: string): string {
  let current = resolve(input);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  try { current = realpathSync.native(current); } catch { /* retain resolved form */ }
  return platformPath(resolve(current, ...missing));
}

export type AgentPaths = ReturnType<typeof buildAgentPaths>;

export function createProtectedPathsResolver(api: OpenClawPluginApi) {
  const agentPathsCache = new Map<string, AgentPaths>();
  function getAgentPaths(agentId?: string): AgentPaths {
    const id = agentId || DEFAULT_AGENT_ID;
    let cached = agentPathsCache.get(id);
    if (!cached) {
      cached = buildAgentPaths(api, id);
      agentPathsCache.set(id, cached);
    }
    return cached;
  }

  // Only tools that actually write/modify a path can trigger the protected-file
  // block below. Without this gate, a plain read of e.g. AGENTS.md was refused
  // too, since protectedWriteTarget only ever looked at the path, never at
  // whether the call was a write — a real functional bug, not just an
  // over-strict security posture.
  function protectedWriteTarget(event: { params: unknown; derivedPaths?: readonly string[] }, paths: AgentPaths): string | null {
    const candidates: string[] = [];
    const p = (event.params as Record<string, unknown>)?.path;
    if (typeof p === "string") candidates.push(p);
    if (Array.isArray(event.derivedPaths)) candidates.push(...event.derivedPaths);
    for (const c of candidates) {
      const resolved = canonicalPath(resolve(paths.workspaceDir, c));
      const label = paths.PROTECTED_PATHS.get(resolved);
      if (label) return label;
      if (resolved === paths.TASKS_DIR || resolved.startsWith(paths.TASKS_DIR + sep)) {
        return "tasks/ (owned by NanCy's confirmation protocol)";
      }
      if (resolved === paths.NANCY_SRC_DIR || resolved.startsWith(paths.NANCY_SRC_DIR + sep)) {
        return "nancy/src/ (NanCy's own source code, protected)";
      }
    }
    return null;
  }

  return { getAgentPaths, protectedWriteTarget };
}
