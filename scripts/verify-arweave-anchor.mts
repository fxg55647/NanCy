import { verifyIntegrityManifestJson } from "../src/integrity/arweave-anchor.ts";

function usage(): never {
  console.error("Usage: node --experimental-strip-types scripts/verify-arweave-anchor.mts <transaction-id> [--gateway=https://arweave.net] [--chain]");
  process.exit(2);
}

const args = process.argv.slice(2);
const transactionId = args.find(arg => !arg.startsWith("--"));
if (!transactionId) usage();
const gatewayArg = args.find(arg => arg.startsWith("--gateway="));
const gateway = new URL(gatewayArg?.slice("--gateway=".length) ?? "https://arweave.net");
if (gateway.username || gateway.password || gateway.search || gateway.hash) throw new Error("gateway must be a plain origin URL");
const walkChain = args.includes("--chain");

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function fetchAnchor(id: string): Promise<{ json: string; tagHash: string; confirmations?: number }> {
  const [dataResponse, txResponse, statusResponse] = await Promise.all([
    fetch(new URL(`/${encodeURIComponent(id)}`, gateway)),
    fetch(new URL(`/tx/${encodeURIComponent(id)}`, gateway), { headers: { Accept: "application/json" } }),
    fetch(new URL(`/tx/${encodeURIComponent(id)}/status`, gateway), { headers: { Accept: "application/json" } }),
  ]);
  if (!dataResponse.ok) throw new Error(`could not fetch manifest ${id}: HTTP ${dataResponse.status}`);
  if (!txResponse.ok) throw new Error(`could not fetch transaction ${id}: HTTP ${txResponse.status}`);
  if (statusResponse.status !== 200) {
    throw new Error(`${id} is not confirmed on Arweave (status endpoint returned HTTP ${statusResponse.status})`);
  }
  const status = await statusResponse.json() as { number_of_confirmations?: number };
  const transaction = await txResponse.json() as { tags?: Array<{ name?: string; value?: string }> };
  const tags = new Map((transaction.tags ?? []).map(tag => [
    decodeBase64Url(tag.name ?? ""),
    decodeBase64Url(tag.value ?? ""),
  ]));
  if (tags.get("App-Name") !== "NanCy" || tags.get("NanCy-Record") !== "integrity-anchor") {
    throw new Error(`${id} is not tagged as a NanCy integrity anchor`);
  }
  const tagHash = tags.get("NanCy-Manifest-SHA256");
  if (!tagHash) throw new Error(`${id} has no NanCy-Manifest-SHA256 tag`);
  return { json: await dataResponse.text(), tagHash, confirmations: status.number_of_confirmations };
}

let currentId: string | null = transactionId;
let expectedFromChild: string | undefined;
let expectedSequence: number | undefined;
let checked = 0;
while (currentId) {
  if (checked >= 10_000) throw new Error("chain exceeds the 10,000-link verification limit");
  const remote = await fetchAnchor(currentId);
  const verified = verifyIntegrityManifestJson(remote.json, remote.tagHash);
  if (expectedFromChild && verified.manifestSha256 !== expectedFromChild) {
    throw new Error(`chain link to ${currentId} has the wrong manifest SHA-256`);
  }
  if (expectedSequence !== undefined && verified.manifest.sequence !== expectedSequence) {
    throw new Error(`chain sequence is discontinuous at ${currentId}`);
  }
  const confirmationText = remote.confirmations === undefined ? "confirmed" : `${remote.confirmations} confirmations`;
  console.log(`✓ sequence ${verified.manifest.sequence}: ${currentId} (${verified.manifest.entries.length} entries, ${verified.manifest.createdAt}, ${confirmationText})`);
  checked += 1;
  if (!walkChain || !verified.manifest.previous) break;
  currentId = verified.manifest.previous.transactionId;
  expectedFromChild = verified.manifest.previous.manifestSha256;
  expectedSequence = verified.manifest.sequence - 1;
}

console.log(`Verified ${checked} NanCy integrity anchor${checked === 1 ? "" : "s"}.`);
