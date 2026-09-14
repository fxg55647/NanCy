// Regression test for a documented-but-since-fixed limitation
// (docs/audits/2026-09-14-security-review.md, "Muut ... jatkotestit" #1):
// log rotation and snapshot pruning must enforce their caps on every write
// of a long-lived gateway, not only once at plugin startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDecision, MAX_LOG_BYTES } from "../src/logging/logger.ts";
import { pruneSnapshots } from "../src/browser/snapshot.ts";

test("logDecision rotates an oversized log file on its own, not only at gateway startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "nancy-retention-"));
  try {
    const file = join(dir, "nancy.log");
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1));
    assert.equal(existsSync(`${file}.1`), false);

    // No restart between the oversized write above and this decision log —
    // rotation must happen as a side effect of the write call itself.
    logDecision(file, new Date().toISOString(), "some_event", {});

    assert.equal(existsSync(`${file}.1`), true, "the oversized generation must be rotated aside during this call");
    const current = readFileSync(file, "utf8");
    assert.ok(current.includes("some_event"));
    assert.ok(current.length < MAX_LOG_BYTES, "the new active file must not still carry the old oversized content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSnapshots enforces the cap immediately when called, not only at startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "nancy-snapshots-"));
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `snap-${i}.txt`), "data");
    assert.equal(readdirSync(dir).length, 5);

    pruneSnapshots(dir, 3);

    assert.equal(readdirSync(dir).length, 3, "pruning must cap the directory the moment it's called, without waiting for a restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
