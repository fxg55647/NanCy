# Arweave Integrity Anchoring

Status: **implemented, optional, and disabled by default.** This feature provides tamper evidence for NanCy's local audit material. It does not prevent a compromised machine from changing files, and it does not place raw logs, source code, task descriptions, or secrets on a public network.

## What problem it addresses

Local logs are useful only while an investigator can trust that they were not rewritten after an incident. Read-only permissions make alteration harder, but an administrator, compromised host process, stolen credential, or offline disk edit may still change both a protected file and the local record of what happened.

NanCy periodically computes SHA-256 hashes of its audit logs and control-plane files. It publishes a small JSON manifest containing those hashes to Arweave. A later investigator can hash the retained local files and compare the result with a timestamped, independently stored record. Changing even one byte produces a different hash.

Arweave transactions are signed data transactions. The network accepts them through `POST /tx`; the transaction ID is derived from the signature, and a successful submission response means the node received the transaction rather than proving it has already been mined. NanCy therefore records `submitted` separately from `confirmed` and, by default, does not extend its application-level chain until the gateway reports the previous transaction mined. See the [Arweave HTTP API](https://docs.arweave.org/developers/arweave-node-server/http-api) and the official [arweave-js client](https://github.com/ArweaveTeam/arweave-js).

## Default source set

One manifest covers the following material when it exists:

- `nancy.log`, `nancy-analysis.log`, and their single rotated generations;
- all files under NanCy's `src/` directory;
- `openclaw.plugin.json` and `NANCY-POLICY.md`;
- `package.json` and `package-lock.json`;
- the main workspace's `AGENTS.md`, `IDENTITY.md`, and `MEMORY.md`;
- the configured worker workspace's corresponding files; and
- NanCy-owned `tasks/*.json` confirmation audit records, unless `includeTaskRecords` is false.

The private wallet JWK is explicitly excluded. Browser snapshots are also excluded: they may contain sensitive page data, change frequently, and are short-lived diagnostic artifacts rather than the durable authorization record.

For an ordinary file, NanCy records a logical label, status, byte count, and SHA-256. For a log that is still growing, it reads the size first and hashes exactly that many bytes. The result therefore proves a precise prefix even if another log line is appended during hashing. Missing and unreadable files are represented explicitly. Directory symlinks are not followed; a symlink leaf is represented by a hash of its link target so that it cannot silently pull an unrelated tree into the public manifest.

## Manifest and chain

The uploaded data is compact JSON with this shape:

```json
{
  "schema": "nancy-integrity-anchor/v1",
  "createdAt": "2026-09-14T12:00:00.000Z",
  "sequence": 42,
  "previous": {
    "transactionId": "...",
    "manifestSha256": "..."
  },
  "sourceSetSha256": "...",
  "entries": [
    {
      "label": "logs/nancy.log",
      "status": "present",
      "bytes": 18420,
      "sha256": "..."
    }
  ]
}
```

Entries are sorted by logical label. `sourceSetSha256` commits to the exact ordered entry list. The SHA-256 of the complete JSON is stored in the transaction tag `NanCy-Manifest-SHA256`. Each manifest names the preceding transaction and its complete-manifest hash, producing an application-level chain independent of Arweave's own transaction anchors.

Local chain state is kept in `.nancy-integrity/anchor-state.json`. Before network submission, the exact manifest is atomically placed in `.nancy-integrity/pending-anchor.json`. If the process loses an uncertain submission response or crashes before advancing the chain head, the next attempt retries that exact manifest. This may produce an orphaned duplicate transaction, but it cannot silently skip the prepared evidence or create a disconnected canonical chain. A malformed state or pending file stops publication instead of silently discarding uncertainty.

NanCy blocks direct `write`, `edit`, and `apply_patch` calls to the integrity directory, the audit logs, and the separate `nancy-integrity.log` journal. It also deterministically blocks direct agent access to a configured `walletJwkPath`, including host-derived paths from shell commands. OS permissions remain necessary because plugin checks cannot constrain programs, environment-variable exposure, aliases, or shell indirection outside the paths OpenClaw reports to its hooks.

## Cadence

The default interval is **15 minutes**. At each interval NanCy recomputes the source-set hash and skips publication if nothing changed. It also requests an anchor after gateway startup and before a clean shutdown. These requests still skip unchanged data.

Fifteen minutes is a practical default for small manifests: it limits the normal unauthenticated activity window without publishing continuously. An active gateway can produce up to 96 transactions per day, and actual fees are dynamic. Operators should choose a longer interval when that volume, wallet operations, or network traffic is undesirable. The allowed range is one minute to 24 hours.

The default `requirePreviousConfirmation: true` prevents the next manifest from extending a link that the gateway still reports as pending. This can delay later anchors during network congestion, which is preferable to presenting a chain of merely accepted submissions as a confirmed permanent record. Submission and confirmation transitions are written to `nancy-integrity.log`.

## Configuration and key handling

```json
"arweaveAnchoring": {
  "enabled": true,
  "intervalMinutes": 15,
  "gatewayUrl": "https://arweave.net",
  "walletJwk": {
    "source": "env",
    "id": "NANCY_ARWEAVE_WALLET_JWK"
  },
  "includeTaskRecords": true,
  "anchorOnStartup": true,
  "anchorOnShutdown": true,
  "requirePreviousConfirmation": true
}
```

`NANCY_ARWEAVE_WALLET_JWK` must contain the complete private RSA JWK JSON. An absolute `walletJwkPath` may be used instead, but it should be outside all agent workspaces, readable only by the gateway account, and backed up securely. The configured key signs transactions and can spend that wallet's AR balance. Use a dedicated, minimally funded wallet; never reuse a high-value wallet or place its JWK in the repository.

HTTP gateways are rejected except on loopback for localnet testing. The standard gateway defaults to `https://arweave.net`. The gateway response, public wallet address, transaction ID, sequence, and manifest hash are journaled; the private key is never logged.

## Verification

Verify one transaction:

```bash
npm run verify:arweave -- <transaction-id>
```

Walk and verify the complete linked history ending at that transaction:

```bash
npm run verify:arweave -- <transaction-id> --chain
```

The verifier first requires the gateway's status endpoint to report every inspected transaction as confirmed. It then downloads the transaction tags and manifest, confirms the complete JSON hash, validates the source-set hash and entry schema, and checks every previous transaction ID, manifest hash, and sequence number. Use `--gateway=https://gateway.example` to select another gateway.

This proves that the retrieved manifests form the published chain. To test a retained file, hash exactly the recorded number of bytes and compare it with the corresponding entry. A full operational verifier that automatically maps remote labels onto an archived host filesystem is future work.

## Privacy and limitations

Hashes are not encryption. The manifest permanently reveals its publication time, wallet, source labels, file sizes, task-record filenames, and the frequency with which the protected source set changed. A hash of predictable low-entropy content can also confirm a guess about that content. Disable task-record inclusion or the entire feature when this metadata is unacceptable.

An anchor proves only that somebody controlling the signing wallet published a particular set of hashes. It does not prove that the logs were complete, that their events were truthful, that the host was uncompromised before hashing, or that NanCy intercepted every consequential action. An attacker who controls the machine and wallet before an anchor can publish hashes of altered evidence. Keep the wallet outside agent reach and combine this feature with remote log shipping, least privilege, host monitoring, and backups.

Anchoring failures do not stop normal NanCy operation. Making network availability or wallet balance a prerequisite for every agent action would turn an optional audit mechanism into a broad availability failure. Errors are instead made visible in the dedicated journal and retried at the next trigger.

## Test coverage

`test/integrity-anchor.test.ts` covers deterministic hashing, content exclusion, manifest verification, changed-only publication, confirmation gating, chain links, exact-manifest outbox recovery, corrupt-state refusal, hard blocking of direct writes to audit logs/local chain state, and denial of agent reads from a configured wallet file. Network calls and wallet signing are not exercised by the normal test suite.
