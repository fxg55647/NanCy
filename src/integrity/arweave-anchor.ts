import Arweave from "arweave";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArweaveAnchoringConfig } from "../config.ts";
import { resolveSecretInputBestEffort } from "../config.ts";
import type { AgentPaths } from "../policy/protected-paths.ts";
import { rotateLogIfLarge } from "../logging/logger.ts";

export const DEFAULT_ANCHOR_INTERVAL_MINUTES = 15;
export const MIN_ANCHOR_INTERVAL_MINUTES = 1;
export const MAX_ANCHOR_INTERVAL_MINUTES = 24 * 60;
const STATE_VERSION = 1;

export type IntegritySource = {
  label: string;
  path: string;
  kind: "file" | "tree";
};

export type IntegrityEntry = {
  label: string;
  status: "present" | "missing" | "unreadable" | "symlink";
  bytes: number;
  sha256: string | null;
};

export type IntegrityManifest = {
  schema: "nancy-integrity-anchor/v1";
  createdAt: string;
  sequence: number;
  previous: { transactionId: string; manifestSha256: string } | null;
  sourceSetSha256: string;
  entries: IntegrityEntry[];
};

type AnchorState = {
  version: 1;
  sequence: number;
  transactionId: string;
  manifestSha256: string;
  sourceSetSha256: string;
  anchoredAt: string;
  confirmationStatus: "submitted" | "confirmed";
  confirmations?: number;
};

type PendingAnchor = {
  version: 1;
  manifestJson: string;
  manifestSha256: string;
  sourceSetSha256: string;
  createdAt: string;
};

type PrivateJwk = {
  kty: string;
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
};

export type PublishResult = { transactionId: string; status: number; walletAddress?: string };
export type IntegrityPublisher = ((manifestJson: string, tags: Record<string, string>) => Promise<PublishResult>) & {
  getStatus?: (transactionId: string) => Promise<{ confirmed: boolean; status: number; confirmations?: number }>;
};

type TimerHandle = ReturnType<typeof setInterval>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJournal(path: string, event: string, extra: Record<string, unknown> = {}): void {
  try {
    rotateLogIfLarge(path);
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...extra })}\n`);
  } catch (err) {
    console.warn(`[nancy] Arweave integrity journal write failed: ${String(err)}`);
  }
}

async function fileEntry(label: string, path: string): Promise<IntegrityEntry> {
  if (!existsSync(path)) return { label, status: "missing", bytes: 0, sha256: null };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Keep one file descriptor open across stat + read so a rename/replacement
    // race cannot switch the bytes underneath the manifest. Logs may append;
    // the end offset fixes the exact prefix being committed.
    handle = await open(path, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) return { label, status: "unreadable", bytes: 0, sha256: null };
    const hash = createHash("sha256");
    let bytesRead = 0;
    if (stats.size > 0) {
      await new Promise<void>((resolvePromise, reject) => {
        const stream = handle!.createReadStream({ start: 0, end: stats.size - 1, autoClose: false });
        stream.on("data", chunk => { bytesRead += chunk.length; hash.update(chunk); });
        stream.on("error", reject);
        stream.on("end", resolvePromise);
      });
    }
    if (bytesRead !== stats.size) throw new Error("file changed length while its prefix was being hashed");
    return { label, status: "present", bytes: stats.size, sha256: hash.digest("hex") };
  } catch {
    return { label, status: "unreadable", bytes: 0, sha256: null };
  } finally {
    await handle?.close().catch(() => { });
  }
}

function treeLeaves(root: string): Array<{ relativePath: string; path: string; symlinkTarget?: string }> {
  if (!existsSync(root)) return [];
  const leaves: Array<{ relativePath: string; path: string; symlinkTarget?: string }> = [];
  const visit = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (item.isSymbolicLink()) {
        let symlinkTarget = "unreadable";
        try { symlinkTarget = readlinkSync(path); } catch { /* represented below */ }
        leaves.push({ relativePath, path, symlinkTarget });
      } else if (item.isDirectory()) {
        visit(path);
      } else if (item.isFile()) {
        leaves.push({ relativePath, path });
      }
    }
  };
  visit(root);
  return leaves;
}

export async function collectIntegrityEntries(sources: IntegritySource[]): Promise<IntegrityEntry[]> {
  const entries: IntegrityEntry[] = [];
  for (const source of [...sources].sort((a, b) => a.label.localeCompare(b.label))) {
    if (source.kind === "file") {
      entries.push(await fileEntry(source.label, source.path));
      continue;
    }
    if (!existsSync(source.path)) {
      entries.push({ label: source.label, status: "missing", bytes: 0, sha256: null });
      continue;
    }
    let leaves: ReturnType<typeof treeLeaves>;
    try { leaves = treeLeaves(source.path); }
    catch {
      entries.push({ label: source.label, status: "unreadable", bytes: 0, sha256: null });
      continue;
    }
    if (leaves.length === 0) {
      // The digest of an empty tree is meaningful and differs from a missing tree.
      entries.push({ label: `${source.label}/`, status: "present", bytes: 0, sha256: sha256("") });
    }
    for (const leaf of leaves) {
      const label = `${source.label}/${leaf.relativePath}`;
      if (leaf.symlinkTarget !== undefined) {
        entries.push({ label, status: "symlink", bytes: Buffer.byteLength(leaf.symlinkTarget), sha256: sha256(leaf.symlinkTarget) });
      } else {
        entries.push(await fileEntry(label, leaf.path));
      }
    }
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

export function sourceSetDigest(entries: IntegrityEntry[]): string {
  return sha256(JSON.stringify(entries));
}

export function buildIntegrityManifest(
  entries: IntegrityEntry[],
  createdAt: string,
  prior: AnchorState | null,
): { manifest: IntegrityManifest; json: string; manifestSha256: string } {
  const manifest: IntegrityManifest = {
    schema: "nancy-integrity-anchor/v1",
    createdAt,
    sequence: (prior?.sequence ?? 0) + 1,
    previous: prior ? { transactionId: prior.transactionId, manifestSha256: prior.manifestSha256 } : null,
    sourceSetSha256: sourceSetDigest(entries),
    entries,
  };
  const json = JSON.stringify(manifest);
  return { manifest, json, manifestSha256: sha256(json) };
}

export function verifyIntegrityManifestJson(
  json: string,
  expectedManifestSha256?: string,
): { manifest: IntegrityManifest; manifestSha256: string } {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error("integrity manifest is not valid JSON"); }
  const manifest = value as Partial<IntegrityManifest>;
  const manifestSha256 = sha256(json);
  if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
    throw new Error("integrity manifest SHA-256 does not match its transaction tag or child link");
  }
  if (manifest.schema !== "nancy-integrity-anchor/v1"
    || typeof manifest.createdAt !== "string"
    || !Number.isSafeInteger(manifest.sequence) || (manifest.sequence ?? 0) < 1
    || typeof manifest.sourceSetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceSetSha256)
    || !Array.isArray(manifest.entries)) {
    throw new Error("integrity manifest has an invalid schema");
  }
  const entries = manifest.entries as IntegrityEntry[];
  const labels = entries.map(entry => entry?.label);
  if (labels.some(label => typeof label !== "string")
    || new Set(labels).size !== labels.length
    || labels.some((label, index) => index > 0 && String(labels[index - 1]).localeCompare(String(label)) >= 0)
    || entries.some(entry => !["present", "missing", "unreadable", "symlink"].includes(entry?.status)
      || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0
      || (entry.sha256 !== null && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)))
      || (["missing", "unreadable"].includes(entry.status) && (entry.bytes !== 0 || entry.sha256 !== null))
      || (["present", "symlink"].includes(entry.status) && entry.sha256 === null))) {
    throw new Error("integrity manifest entries are invalid, duplicated, or unsorted");
  }
  if (sourceSetDigest(entries) !== manifest.sourceSetSha256) {
    throw new Error("integrity manifest source-set digest does not match its entries");
  }
  if (manifest.previous !== null) {
    const previous = manifest.previous as { transactionId?: unknown; manifestSha256?: unknown } | undefined;
    if (!previous || typeof previous.transactionId !== "string" || !previous.transactionId
      || typeof previous.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(previous.manifestSha256)) {
      throw new Error("integrity manifest has an invalid previous-anchor link");
    }
  }
  if ((manifest.sequence === 1) !== (manifest.previous === null)) {
    throw new Error("integrity manifest sequence and previous-anchor link are inconsistent");
  }
  return { manifest: manifest as IntegrityManifest, manifestSha256 };
}

function readState(path: string): AnchorState | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("integrity anchor state exists but is not valid JSON; refusing to start an unlinked chain"); }
  const state = value as Partial<AnchorState>;
  if (state.version !== STATE_VERSION
    || !Number.isSafeInteger(state.sequence) || (state.sequence ?? 0) < 1
    || typeof state.transactionId !== "string" || !state.transactionId
    || typeof state.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(state.manifestSha256)
    || typeof state.sourceSetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(state.sourceSetSha256)
    || typeof state.anchoredAt !== "string"
    || (state.confirmationStatus !== "submitted" && state.confirmationStatus !== "confirmed")) {
    throw new Error("integrity anchor state has an invalid schema; refusing to start an unlinked chain");
  }
  return state as AnchorState;
}

function writeState(path: string, state: AnchorState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function readPending(path: string): PendingAnchor | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("pending integrity anchor is not valid JSON; refusing to discard an uncertain submission"); }
  const pending = value as Partial<PendingAnchor>;
  if (pending.version !== STATE_VERSION
    || typeof pending.manifestJson !== "string"
    || typeof pending.manifestSha256 !== "string"
    || typeof pending.sourceSetSha256 !== "string"
    || typeof pending.createdAt !== "string") {
    throw new Error("pending integrity anchor has an invalid schema; refusing to discard an uncertain submission");
  }
  const verified = verifyIntegrityManifestJson(pending.manifestJson, pending.manifestSha256);
  if (verified.manifest.sourceSetSha256 !== pending.sourceSetSha256
    || verified.manifest.createdAt !== pending.createdAt) {
    throw new Error("pending integrity anchor metadata does not match its manifest");
  }
  return pending as PendingAnchor;
}

function writePending(path: string, pending: PendingAnchor): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(pending, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

function parseWallet(raw: string): PrivateJwk {
  let wallet: unknown;
  try { wallet = JSON.parse(raw); }
  catch { throw new Error("Arweave wallet JWK is not valid JSON"); }
  if (!wallet || typeof wallet !== "object") throw new Error("Arweave wallet JWK is not an object");
  const jwk = wallet as Record<string, unknown>;
  for (const field of ["kty", "n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
    if (typeof jwk[field] !== "string" || !jwk[field]) throw new Error(`Arweave wallet JWK is missing private-key field ${field}`);
  }
  return jwk as PrivateJwk;
}

function loadWallet(config: ArweaveAnchoringConfig): PrivateJwk {
  if (config.walletJwkPath) {
    if (!isAbsolute(config.walletJwkPath)) throw new Error("arweaveAnchoring.walletJwkPath must be absolute");
    return parseWallet(readFileSync(config.walletJwkPath, "utf8"));
  }
  const raw = resolveSecretInputBestEffort(config.walletJwk);
  if (!raw) throw new Error("Arweave anchoring is enabled but no walletJwk or walletJwkPath is configured");
  return parseWallet(raw);
}

function gatewayConfig(value: string | undefined): { host: string; protocol: string; port: number } {
  const url = new URL(value ?? "https://arweave.net");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("arweaveAnchoring.gatewayUrl must contain only scheme, host, and optional port");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("arweaveAnchoring.gatewayUrl must use HTTPS (HTTP is allowed only for a loopback localnet)");
  }
  return {
    host: url.hostname,
    protocol: url.protocol.slice(0, -1),
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  };
}

export async function createArweavePublisher(config: ArweaveAnchoringConfig): Promise<IntegrityPublisher> {
  const wallet = loadWallet(config);
  const gateway = gatewayConfig(config.gatewayUrl);
  const arweave = Arweave.init({ ...gateway, timeout: 30_000, logging: false });
  const walletAddress = await arweave.wallets.jwkToAddress(wallet);
  const publish: IntegrityPublisher = async (manifestJson, tags) => {
    const transaction = await arweave.createTransaction({ data: manifestJson }, wallet);
    for (const [name, value] of Object.entries(tags)) transaction.addTag(name, value);
    await arweave.transactions.sign(transaction, wallet);
    const response = await arweave.transactions.post(transaction);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Arweave gateway rejected integrity transaction (${response.status} ${response.statusText})`);
    }
    return { transactionId: transaction.id, status: response.status, walletAddress };
  };
  publish.getStatus = async (transactionId) => {
    const status = await arweave.transactions.getStatus(transactionId);
    return {
      confirmed: status.status === 200 && status.confirmed !== null,
      status: status.status,
      confirmations: status.confirmed?.number_of_confirmations,
    };
  };
  return publish;
}

export function buildDefaultIntegritySources(
  rootDir: string,
  workspaces: Array<{ name: string; paths: AgentPaths }>,
  includeTaskRecords = true,
): IntegritySource[] {
  const sources: IntegritySource[] = [
    { label: "logs/nancy.log", path: join(rootDir, "nancy.log"), kind: "file" },
    { label: "logs/nancy.log.1", path: join(rootDir, "nancy.log.1"), kind: "file" },
    { label: "logs/nancy-analysis.log", path: join(rootDir, "nancy-analysis.log"), kind: "file" },
    { label: "logs/nancy-analysis.log.1", path: join(rootDir, "nancy-analysis.log.1"), kind: "file" },
    { label: "protected/nancy/src", path: join(rootDir, "src"), kind: "tree" },
    { label: "protected/nancy/openclaw.plugin.json", path: join(rootDir, "openclaw.plugin.json"), kind: "file" },
    { label: "protected/nancy/NANCY-POLICY.md", path: join(rootDir, "NANCY-POLICY.md"), kind: "file" },
    { label: "runtime/package.json", path: join(rootDir, "package.json"), kind: "file" },
    { label: "runtime/package-lock.json", path: join(rootDir, "package-lock.json"), kind: "file" },
  ];
  for (const workspace of workspaces) {
    for (const name of ["AGENTS.md", "IDENTITY.md", "MEMORY.md"]) {
      sources.push({ label: `protected/workspace-${workspace.name}/${name}`, path: join(workspace.paths.workspaceDir, name), kind: "file" });
    }
    if (includeTaskRecords) {
      sources.push({ label: `task-records/workspace-${workspace.name}`, path: workspace.paths.TASKS_DIR, kind: "tree" });
    }
  }
  return sources;
}

export function createIntegrityAnchorService(options: {
  config: ArweaveAnchoringConfig | undefined;
  rootDir: string;
  sources: () => IntegritySource[];
  publisher?: IntegrityPublisher;
  now?: () => Date;
  setIntervalFn?: (callback: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
}) {
  const config = options.config;
  const enabled = config?.enabled === true;
  const integrityDir = join(options.rootDir, ".nancy-integrity");
  const statePath = join(integrityDir, "anchor-state.json");
  const pendingPath = join(integrityDir, "pending-anchor.json");
  const journalPath = join(options.rootDir, "nancy-integrity.log");
  const now = options.now ?? (() => new Date());
  const intervalMinutes = config?.intervalMinutes ?? DEFAULT_ANCHOR_INTERVAL_MINUTES;
  if (enabled && (!Number.isFinite(intervalMinutes)
    || intervalMinutes < MIN_ANCHOR_INTERVAL_MINUTES
    || intervalMinutes > MAX_ANCHOR_INTERVAL_MINUTES)) {
    throw new Error(`arweaveAnchoring.intervalMinutes must be between ${MIN_ANCHOR_INTERVAL_MINUTES} and ${MAX_ANCHOR_INTERVAL_MINUTES}`);
  }

  let timer: TimerHandle | undefined;
  let active: Promise<void> | null = null;
  let pendingReason: string | null = null;
  let publisherPromise: Promise<IntegrityPublisher> | null = null;

  const getPublisher = async (): Promise<IntegrityPublisher> => {
    if (options.publisher) return options.publisher;
    publisherPromise ??= createArweavePublisher(config ?? {});
    return publisherPromise;
  };

  const performAnchor = async (reason: string): Promise<void> => {
    try {
      let prior = readState(statePath);
      const publisher = await getPublisher();

      // The outbox is written before network submission. If the gateway
      // process crashes after POST but before anchor-state.json is replaced,
      // startup retries the exact manifest rather than silently starting a
      // disconnected chain. A duplicate accepted transaction is preferable
      // to losing the durable chain head.
      const pending = readPending(pendingPath);
      if (pending) {
        if (prior?.manifestSha256 === pending.manifestSha256) {
          unlinkSync(pendingPath);
        } else {
          const verified = verifyIntegrityManifestJson(pending.manifestJson, pending.manifestSha256);
          const expectedPrevious = prior
            ? { transactionId: prior.transactionId, manifestSha256: prior.manifestSha256 }
            : null;
          if (JSON.stringify(verified.manifest.previous) !== JSON.stringify(expectedPrevious)) {
            throw new Error("pending integrity anchor no longer extends the recorded chain head");
          }
          const result = await publisher(pending.manifestJson, {
            "App-Name": "NanCy",
            "App-Version": "0.1.0",
            "Content-Type": "application/json",
            "NanCy-Record": "integrity-anchor",
            "NanCy-Schema": verified.manifest.schema,
            "NanCy-Sequence": String(verified.manifest.sequence),
            "NanCy-Manifest-SHA256": pending.manifestSha256,
          });
          const recoveredState: AnchorState = {
            version: STATE_VERSION,
            sequence: verified.manifest.sequence,
            transactionId: result.transactionId,
            manifestSha256: pending.manifestSha256,
            sourceSetSha256: pending.sourceSetSha256,
            anchoredAt: pending.createdAt,
            confirmationStatus: "submitted",
          };
          writeState(statePath, recoveredState);
          unlinkSync(pendingPath);
          safeJournal(journalPath, "arweave_anchor_recovered_submission", {
            reason,
            sequence: recoveredState.sequence,
            transactionId: recoveredState.transactionId,
            manifestSha256: recoveredState.manifestSha256,
            gatewayStatus: result.status,
          });
          return;
        }
      }

      if (prior?.confirmationStatus === "submitted" && publisher.getStatus) {
        const status = await publisher.getStatus(prior.transactionId);
        if (status.confirmed) {
          prior = { ...prior, confirmationStatus: "confirmed", confirmations: status.confirmations };
          writeState(statePath, prior);
          safeJournal(journalPath, "arweave_anchor_confirmed", {
            sequence: prior.sequence,
            transactionId: prior.transactionId,
            confirmations: status.confirmations,
          });
        } else if (config?.requirePreviousConfirmation !== false) {
          safeJournal(journalPath, "arweave_anchor_waiting_for_confirmation", {
            reason,
            sequence: prior.sequence,
            transactionId: prior.transactionId,
            gatewayStatus: status.status,
          });
          return;
        }
      } else if (prior?.confirmationStatus === "submitted"
        && config?.requirePreviousConfirmation !== false
        && !publisher.getStatus) {
        throw new Error("publisher cannot verify the previous Arweave transaction confirmation");
      }
      const entries = await collectIntegrityEntries(options.sources());
      const sourceSetSha256 = sourceSetDigest(entries);
      if (prior?.sourceSetSha256 === sourceSetSha256) {
        safeJournal(journalPath, "arweave_anchor_skipped_unchanged", { reason, sequence: prior.sequence });
        return;
      }
      const createdAt = now().toISOString();
      const built = buildIntegrityManifest(entries, createdAt, prior);
      writePending(pendingPath, {
        version: STATE_VERSION,
        manifestJson: built.json,
        manifestSha256: built.manifestSha256,
        sourceSetSha256,
        createdAt,
      });
      const result = await publisher(built.json, {
        "App-Name": "NanCy",
        "App-Version": "0.1.0",
        "Content-Type": "application/json",
        "NanCy-Record": "integrity-anchor",
        "NanCy-Schema": built.manifest.schema,
        "NanCy-Sequence": String(built.manifest.sequence),
        "NanCy-Manifest-SHA256": built.manifestSha256,
      });
      const state: AnchorState = {
        version: STATE_VERSION,
        sequence: built.manifest.sequence,
        transactionId: result.transactionId,
        manifestSha256: built.manifestSha256,
        sourceSetSha256,
        anchoredAt: createdAt,
        confirmationStatus: "submitted",
      };
      writeState(statePath, state);
      unlinkSync(pendingPath);
      safeJournal(journalPath, "arweave_anchor_submitted", {
        reason,
        sequence: state.sequence,
        transactionId: state.transactionId,
        manifestSha256: state.manifestSha256,
        entryCount: entries.length,
        gatewayStatus: result.status,
        walletAddress: result.walletAddress,
      });
      console.log(`[nancy] ✓ Arweave integrity anchor ${state.sequence} submitted (${state.transactionId})`);
    } catch (err) {
      safeJournal(journalPath, "arweave_anchor_error", { reason, error: String(err) });
      console.warn(`[nancy] ⚠️  Arweave integrity anchor failed: ${String(err)}`);
    }
  };

  const launch = (reason: string): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (active) {
      pendingReason = reason;
      return active;
    }
    active = performAnchor(reason).finally(() => {
      active = null;
      const next = pendingReason;
      pendingReason = null;
      if (next) void launch(next);
    });
    return active;
  };

  function start(): void {
    if (!enabled || timer) return;
    mkdirSync(integrityDir, { recursive: true, mode: 0o700 });
    const intervalMs = intervalMinutes * 60_000;
    const setTimer = options.setIntervalFn ?? setInterval;
    timer = setTimer(() => { void launch("interval"); }, intervalMs);
    timer.unref?.();
    safeJournal(journalPath, "arweave_anchoring_started", { intervalMinutes });
    if (config?.anchorOnStartup !== false) void launch("startup");
  }

  async function stop(): Promise<void> {
    if (!enabled) return;
    if (timer) {
      (options.clearIntervalFn ?? clearInterval)(timer);
      timer = undefined;
    }
    if (config?.anchorOnShutdown !== false) await launch("shutdown");
    // A shutdown request made during an active publication is coalesced. Wait
    // for that follow-up as well, without permitting an unbounded queue.
    if (active) await active;
    if (pendingReason) await launch(pendingReason);
  }

  return { enabled, start, stop, anchorNow: launch, statePath, pendingPath, journalPath };
}
