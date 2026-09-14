import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import nancyPlugin from "../src/index.ts";
import {
  buildIntegrityManifest,
  collectIntegrityEntries,
  createIntegrityAnchorService,
  sourceSetDigest,
  type IntegrityManifest,
  type IntegrityPublisher,
  verifyIntegrityManifestJson,
} from "../src/integrity/arweave-anchor.ts";
import { createFakeApi } from "./helpers.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("integrity manifest contains deterministic hashes and metadata, never source contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "nancy-integrity-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "nancy.log"), "PRIVATE LOG CONTENT\n");
    writeFileSync(join(root, "src", "index.ts"), "PRIVATE SOURCE CONTENT\n");
    const entries = await collectIntegrityEntries([
      { label: "logs/nancy.log", path: join(root, "nancy.log"), kind: "file" },
      { label: "protected/src", path: join(root, "src"), kind: "tree" },
      { label: "protected/missing", path: join(root, "missing"), kind: "file" },
    ]);
    assert.deepEqual(entries.map(entry => entry.label), [
      "logs/nancy.log",
      "protected/missing",
      "protected/src/index.ts",
    ]);
    assert.equal(entries[0]?.sha256, sha256("PRIVATE LOG CONTENT\n"));
    assert.equal(entries[1]?.status, "missing");
    assert.equal(entries[2]?.sha256, sha256("PRIVATE SOURCE CONTENT\n"));

    const built = buildIntegrityManifest(entries, "2026-09-14T12:00:00.000Z", null);
    assert.equal(built.manifest.sequence, 1);
    assert.equal(built.manifest.previous, null);
    assert.equal(built.manifest.sourceSetSha256, sourceSetDigest(entries));
    assert.equal(built.manifestSha256, sha256(built.json));
    assert.equal(built.json.includes("PRIVATE LOG CONTENT"), false);
    assert.equal(built.json.includes("PRIVATE SOURCE CONTENT"), false);
    assert.equal(verifyIntegrityManifestJson(built.json, built.manifestSha256).manifest.sequence, 1);
    assert.throws(
      () => verifyIntegrityManifestJson(built.json.replace("logs/nancy.log", "logs/forged.log"), built.manifestSha256),
      /does not match/,
    );

    const disconnected = { ...built.manifest, sequence: 2 };
    assert.throws(
      () => verifyIntegrityManifestJson(JSON.stringify(disconnected)),
      /sequence and previous-anchor link are inconsistent/,
    );
    const impossibleEntry = {
      ...built.manifest,
      entries: built.manifest.entries.map((entry, index) => index === 1
        ? { ...entry, status: "missing" as const, bytes: 4, sha256: sha256("fake") }
        : entry),
    };
    impossibleEntry.sourceSetSha256 = sourceSetDigest(impossibleEntry.entries);
    assert.throws(
      () => verifyIntegrityManifestJson(JSON.stringify(impossibleEntry)),
      /entries are invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed source waits until the previous transaction is confirmed", async () => {
  const root = mkdtempSync(join(tmpdir(), "nancy-integrity-confirmation-"));
  const log = join(root, "nancy.log");
  writeFileSync(log, "one\n");
  let publishes = 0;
  const publisher = Object.assign(
    async () => {
      publishes += 1;
      return { transactionId: `pending-${publishes}`, status: 200 };
    },
    { getStatus: async () => ({ confirmed: false, status: 202 }) },
  ) satisfies IntegrityPublisher;
  const service = createIntegrityAnchorService({
    config: { enabled: true, anchorOnStartup: false, anchorOnShutdown: false },
    rootDir: root,
    sources: () => [{ label: "logs/nancy.log", path: log, kind: "file" }],
    publisher,
  });
  try {
    await service.anchorNow("first");
    writeFileSync(log, "one\ntwo\n");
    await service.anchorNow("second");
    assert.equal(publishes, 1);
    assert.match(readFileSync(service.journalPath, "utf8"), /arweave_anchor_waiting_for_confirmation/);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("anchor service skips unchanged sources and chains the next changed manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "nancy-integrity-service-"));
  const log = join(root, "nancy.log");
  writeFileSync(log, "one\n");
  const published: Array<{ manifest: IntegrityManifest; tags: Record<string, string> }> = [];
  let transaction = 0;
  const publisher = Object.assign(
    async (json: string, tags: Record<string, string>) => {
      published.push({ manifest: JSON.parse(json) as IntegrityManifest, tags });
      transaction += 1;
      return { transactionId: `tx-${transaction}`, status: 200, walletAddress: "wallet" };
    },
    { getStatus: async () => ({ confirmed: true, status: 200, confirmations: 1 }) },
  ) satisfies IntegrityPublisher;
  const service = createIntegrityAnchorService({
    config: { enabled: true, anchorOnStartup: false, anchorOnShutdown: false },
    rootDir: root,
    sources: () => [{ label: "logs/nancy.log", path: log, kind: "file" }],
    publisher,
    now: () => new Date(`2026-09-14T12:0${transaction}:00.000Z`),
  });
  try {
    await service.anchorNow("test-first");
    await service.anchorNow("test-unchanged");
    assert.equal(published.length, 1);

    writeFileSync(log, "one\ntwo\n");
    await service.anchorNow("test-second");
    assert.equal(published.length, 2);
    assert.equal(published[1]?.manifest.sequence, 2);
    assert.deepEqual(published[1]?.manifest.previous, {
      transactionId: "tx-1",
      manifestSha256: published[0]?.tags["NanCy-Manifest-SHA256"],
    });

    const state = JSON.parse(readFileSync(service.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.transactionId, "tx-2");
    assert.equal(state.sequence, 2);
    const journal = readFileSync(service.journalPath, "utf8");
    assert.match(journal, /arweave_anchor_skipped_unchanged/);
    assert.match(journal, /arweave_anchor_submitted/);
    assert.equal(journal.includes("one\\ntwo"), false);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt local chain state never silently starts a new chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "nancy-integrity-state-"));
  mkdirSync(join(root, ".nancy-integrity"));
  writeFileSync(join(root, ".nancy-integrity", "anchor-state.json"), "not-json");
  writeFileSync(join(root, "nancy.log"), "event\n");
  let publishes = 0;
  const service = createIntegrityAnchorService({
    config: { enabled: true, anchorOnStartup: false, anchorOnShutdown: false },
    rootDir: root,
    sources: () => [{ label: "logs/nancy.log", path: join(root, "nancy.log"), kind: "file" }],
    publisher: async () => {
      publishes += 1;
      return { transactionId: "should-not-exist", status: 200 };
    },
  });
  try {
    await service.anchorNow("test");
    assert.equal(publishes, 0);
    assert.match(readFileSync(service.journalPath, "utf8"), /refusing to start an unlinked chain/);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed submission retains and retries the exact pending manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "nancy-integrity-outbox-"));
  writeFileSync(join(root, "nancy.log"), "evidence\n");
  const attempted: string[] = [];
  const publisher: IntegrityPublisher = async (json) => {
    attempted.push(json);
    if (attempted.length === 1) throw new Error("uncertain network failure");
    return { transactionId: "recovered-tx", status: 200 };
  };
  const service = createIntegrityAnchorService({
    config: { enabled: true, anchorOnStartup: false, anchorOnShutdown: false },
    rootDir: root,
    sources: () => [{ label: "logs/nancy.log", path: join(root, "nancy.log"), kind: "file" }],
    publisher,
  });
  try {
    await service.anchorNow("first");
    assert.equal(existsSync(service.pendingPath), true);
    assert.equal(existsSync(service.statePath), false);
    await service.anchorNow("retry");
    assert.equal(attempted.length, 2);
    assert.equal(attempted[1], attempted[0]);
    assert.equal(existsSync(service.pendingPath), false);
    assert.equal((JSON.parse(readFileSync(service.statePath, "utf8")) as { transactionId: string }).transactionId, "recovered-tx");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents cannot directly overwrite logs or integrity-chain state", async () => {
  const fixture = createFakeApi();
  try {
    nancyPlugin.register(fixture.api as any);
    for (const path of [join(fixture.rootDir, "nancy.log"), join(fixture.rootDir, ".nancy-integrity", "anchor-state.json")]) {
      const result = await fixture.handlers.before_tool_call(
        { toolName: "write", params: { path, content: "forged" } },
        { sessionKey: "worker", agentId: "main", toolCallId: `write-${path}` },
      );
      assert.equal(result?.block, true);
      assert.match(result?.blockReason ?? "", /protected file/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("the configured wallet JWK file is unreadable to agent tools", async () => {
  const fixture = createFakeApi();
  const walletPath = join(fixture.rootDir, "private-wallet.json");
  writeFileSync(walletPath, "synthetic-key");
  fixture.api.pluginConfig = { arweaveAnchoring: { walletJwkPath: walletPath } };
  try {
    nancyPlugin.register(fixture.api as any);
    const directRead = await fixture.handlers.before_tool_call(
      { toolName: "read", params: { path: walletPath } },
      { sessionKey: "worker", agentId: "main", toolCallId: "wallet-read" },
    );
    assert.equal(directRead?.block, true);
    assert.match(directRead?.blockReason ?? "", /secret file/);

    const shellRead = await fixture.handlers.before_tool_call(
      { toolName: "exec", params: { command: "cat redacted" }, derivedPaths: [walletPath] },
      { sessionKey: "worker", agentId: "main", toolCallId: "wallet-exec" },
    );
    assert.equal(shellRead?.block, true);
    assert.match(shellRead?.blockReason ?? "", /secret file/);
  } finally {
    fixture.cleanup();
  }
});
