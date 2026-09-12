import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { FETCH_TIMEOUT_MS } from "../constants.ts";

export async function fetchBrowserSnapshot(port: number, token?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}/snapshot?format=ai`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function snapshotFilename(params: unknown): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");
  const datePart = `${dd}-${mm}-${yyyy}`;
  const timePart = `${HH}-${MM}-${SS}`;
  let identifier = "browser";
  let suffix = "_fetch";
  try {
    const url = String((params as Record<string, unknown>)?.url ?? "");
    if (url) {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/[^a-z0-9.-]/gi, "-");
      const path = parsed.pathname.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
      identifier = path ? `${hostname}_${path}` : hostname;
      if ([...parsed.searchParams].length >= 3) suffix = "_submit";
    }
  } catch { }
  return `${timePart}_${datePart}_${identifier}${suffix}.txt`;
}

// snapshotFilename's timestamp is second-granularity (kept deliberately short
// for readability), so two snapshots for the same host in the same second
// would otherwise silently overwrite each other. This appends -2, -3, ... on
// collision instead.
export function uniqueSnapshotPath(dir: string, baseName: string): string {
  let candidate = join(dir, baseName);
  if (!existsSync(candidate)) return candidate;
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  for (let i = 2; i < 1000; i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

// Snapshots have no natural expiry, so cap the count and drop the oldest.
export const MAX_SNAPSHOTS = 1000;
export function pruneSnapshots(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(join(dir, f)); } catch { }
    }
  } catch { }
}
