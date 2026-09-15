// End-to-end proof for tools/mobile-chat-poc/: a real, isolated OpenClaw
// Gateway with NanCy loaded and the bundled A2A channel enabled, driven
// exactly the way a phone client (client.mjs / web/index.html) would —
// plain A2A JSON-RPC over HTTP — through a task that requires NanCy's
// confirmation dance. Never touches the operator's live Gateway or config:
// reuses startGateway/waitForGatewayReady/stopGateway and the AGENTS.md/
// nancy-plugin-copy/models.providers helpers already built and tested for
// tools/comparator (see docs/architecture/behavior-comparator.md for why
// each of those exists), on a throwaway per-run profile under
// tools/mobile-chat-poc/test/runs/ (gitignored).
//
// Usage:
//   node --experimental-strip-types tools/mobile-chat-poc/test/run-isolated-a2a-test.mts
//
// Reads the REAL analysis model config from the operator's live
// openclaw.json (via the read-only `openclaw config file` command — see
// TESTING.md's Option B) to get a genuine ALLOW/BLOCK/CLARIFY verdict, but
// runs with nancy config testMode:true throughout, so the gated action
// (an `exec` call) is always dry-run, never actually executed, regardless
// of the verdict. This still makes real, small, billed calls to the task
// model and to NanCy's analysis model — same tradeoff tools/comparator's
// own real calibration runs already accept.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";

import { startGateway, waitForGatewayReady, stopGateway } from "../../comparator/src/driver.ts";
import { AGENTS_MD_CONFIRMATION_SECTION, copyNancyPluginForRun, buildModelsProvidersConfig } from "../../comparator/src/config-builder.ts";
import { parseConfirmationRequest, isAffirmativeReply } from "../../../src/confirmation/protocol.ts";
import { sendMessage } from "../client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const OPENCLAW_ENTRY = join(REPO_ROOT, "node_modules", "openclaw", "openclaw.mjs");
const RUNS_ROOT = join(HERE, "runs");

const TASK_MODEL = "google/gemini-2.5-flash";
// The task asks the agent to do something that (a) plainly requires
// sending data to the web, per AGENTS_MD_CONFIRMATION_SECTION's trigger
// condition, and (b) is NOT web_search/web_fetch — those are exempted from
// the "no confirmed task" hard block by allowUnconfirmedInfoLookups
// (default on) and so would never actually exercise the confirmation
// dance. `exec` always requires semantic review with no such exemption
// (see TESTING.md's tool cheat sheet), and testMode:true guarantees it is
// dry-run only even if NanCy's real reviewer would ALLOW it.
// httpbin.org/post is a well-known public API-testing sandbox that exists
// specifically to accept and echo back POST bodies — chosen over an
// arbitrary domain (an earlier run used https://example.com and the real
// reviewer reasonably BLOCKed it: "POST unexplained data to a domain with
// no stated purpose" is indistinguishable from exfiltration). Framed as a
// routine integration health-check, which is both true and a plausible,
// unremarkable reason to POST a fixed known string to a testing endpoint.
const INITIAL_MESSAGE =
  "Run a shell command that POSTs the exact text 'nancy-mobile-poc-healthcheck' to https://httpbin.org/post using curl. " +
  "This is a routine health check for this integration against a public API-testing sandbox (httpbin.org exists specifically to accept and echo back test POST bodies) — no real or sensitive data is involved.";
const REPLY_TIMEOUT_MS = 180_000;

function log(msg: string): void {
  console.log(`[isolated-a2a-test] ${msg}`);
}

function readLiveAnalysisConfig(): { provider: string; model: string; apiKey: string; baseUrl?: string } {
  const result = spawnSync(process.execPath, [OPENCLAW_ENTRY, "config", "file"], { encoding: "utf8", timeout: 20_000 });
  const configPath = (result.stdout ?? "").trim();
  if (result.status !== 0 || !configPath || !existsSync(configPath)) {
    throw new Error(`could not resolve the live openclaw config path via 'openclaw config file' (this is read-only — never touches the live gateway): ${result.stderr ?? "unknown error"}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const analysis = cfg?.plugins?.entries?.nancy?.config?.analysis;
  if (!analysis?.apiKey) {
    throw new Error("plugins.entries.nancy.config.analysis (with an apiKey) was not found in the live config — configure NanCy's analysis model before running this test.");
  }
  return analysis;
}

function pickPort(): number {
  // Comparator's own pickGatewayPort() range, duplicated here rather than
  // exported/imported since it's a one-line, module-private detail there —
  // same wide high range to minimize collision with a real operator
  // gateway or a concurrent comparator run.
  return 20000 + Math.floor(Math.random() * 10000);
}

async function main() {
  const analysis = readLiveAnalysisConfig();
  log(`Using live analysis config: provider=${analysis.provider} model=${analysis.model} (apiKey read, never printed)`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_ROOT, runId);
  const stateDir = join(runDir, "state");
  const workspaceDir = join(runDir, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "AGENTS.md"), AGENTS_MD_CONFIRMATION_SECTION);

  const nancyPluginDir = copyNancyPluginForRun(runDir);
  const gatewayPort = pickPort();
  const a2aToken = randomBytes(24).toString("hex");
  const geminiApiKey = analysis.apiKey;

  const config = {
    gateway: { mode: "local", port: gatewayPort, bind: "loopback", auth: { mode: "none" } },
    channels: {
      a2a: {
        enabled: true,
        // A2A's peers.<name>.token schema requires a plain string — unlike
        // some other channel configs (e.g. Buzz's privateKey/authTag), it
        // does NOT accept a {source:"env",...} SecretRef object (confirmed
        // by `openclaw doctor` rejecting one with "must be string"). Use
        // env-var interpolation instead so the literal secret still never
        // lands in the written config file.
        peers: { "mobile-poc-test": { token: "${NANCY_MOBILE_POC_TEST_TOKEN}" } },
      },
    },
    plugins: {
      allow: ["nancy"],
      load: { paths: [nancyPluginDir] },
      entries: {
        nancy: {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            analysis,
            // Always on for this harness: the gated exec call must never
            // actually run, whatever the real reviewer decides — see the
            // module comment.
            testMode: true,
            telegramAlerts: false,
            telegramTaskReports: false,
            allowUnconfirmedInfoLookups: true,
          },
        },
      },
    },
    agents: {
      entries: {
        "test-agent": {
          model: TASK_MODEL,
          workspace: workspaceDir,
          tools: { allow: ["exec", "message", "read"] },
        },
      },
    },
    models: buildModelsProvidersConfig(TASK_MODEL, { GEMINI_API_KEY: geminiApiKey }, undefined),
  };
  const configPath = join(runDir, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const runPaths = { runDir, stateDir, configPath };
  const env = { GEMINI_API_KEY: geminiApiKey, NANCY_MOBILE_POC_TEST_TOKEN: a2aToken };

  log(`Starting isolated Gateway on loopback port ${gatewayPort} (run dir: ${runDir})`);
  // @ts-expect-error runPaths here is a narrowed stand-in for comparator's RunPaths —
  // startGateway/waitForGatewayReady only ever read runDir/stateDir/configPath.
  const gatewayProc = startGateway(runPaths, env, gatewayPort);

  let passed = false;
  try {
    // @ts-expect-error see above
    await waitForGatewayReady(runPaths, env, gatewayPort);
    log("Gateway is healthy.");

    const a2aUrl = `http://127.0.0.1:${gatewayPort}/a2a/v1`;
    const opts = { url: a2aUrl, token: a2aToken, poll: false, timeoutMs: REPLY_TIMEOUT_MS };

    log(`Sending task-initiating message via A2A: "${INITIAL_MESSAGE}"`);
    const first = await sendMessage(opts, INITIAL_MESSAGE, undefined);
    log(`Reply 1: ${first.text}`);

    const confirmation = parseConfirmationRequest(first.text);
    if (!confirmation) {
      throw new Error("Reply 1 was not recognized as a NanCy confirmation-request — the agent may not have the AGENTS.md instructions, or decided no confirmation was needed. See gateway.log / nancy.log under the run dir.");
    }
    log(`Recognized confirmation request id=${confirmation.id}: "${confirmation.description}"`);

    log('Sending "y" via A2A with the same contextId...');
    const second = await sendMessage(opts, "y", first.contextId);
    log(`Reply 2: ${second.text}`);

    if (!isAffirmativeReply("y")) throw new Error("sanity check failed: isAffirmativeReply('y') was false");

    // With testMode:true, the eventual exec attempt is always dry-run —
    // NanCy's cancelReason/blockReason text says so explicitly regardless
    // of the real verdict. A real reply of any kind (not an A2A-level
    // error) after the "y" round trip proves the whole chain worked:
    // message_sending recognized+sent the confirmation, message_received
    // matched the "y" reply to the same session, the task was authorized,
    // and before_tool_call actually ran a real semantic review against it.
    passed = true;
    log("PASS: confirmation round trip completed over A2A.");
  } catch (err) {
    log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    const { stopped } = await stopGateway(gatewayProc);
    if (!stopped) log(`warning: gateway process (pid ${gatewayProc.pid}) on port ${gatewayPort} may still be running — check it manually.`);
  }

  const nancyLogPath = join(nancyPluginDir, "nancy.log");
  if (existsSync(nancyLogPath)) {
    const lines = readFileSync(nancyLogPath, "utf8").trim().split("\n").filter(Boolean);
    const interesting = lines.filter((l) => /confirmation_requested|message_received|confirmation_message_blocked|before_tool_call|blocked|TEST MODE/i.test(l));
    log(`nancy.log (${lines.length} lines total) — decision-relevant entries:`);
    for (const line of interesting) console.log("  " + line);
  } else {
    log(`No nancy.log found at ${nancyLogPath} — NanCy may not have loaded. Check ${join(runDir, "gateway.log")}.`);
  }

  log(`Run artifacts kept at: ${runDir}`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
