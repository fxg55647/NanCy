// Starts a long-lived isolated OpenClaw Gateway (A2A + NanCy, testMode:true)
// bound to the LAN — not loopback — plus a tiny static file server for
// web/index.html, so a real phone on the same network can open the page and
// chat with it. This is for interactive manual testing; for an automated
// pass/fail check see run-isolated-a2a-test.mts in this directory.
//
// Never touches the operator's live Gateway/config. Stop it with Ctrl+C
// (SIGINT) — it shuts the isolated Gateway down cleanly before exiting.
//
// SECURITY NOTE: bind is "lan", so the A2A endpoint (gated by its own
// per-peer bearer token, printed below) is reachable from anyone on the
// same network who has that token. A separate, never-printed gateway token
// satisfies OpenClaw's own "refusing to bind to lan without auth" startup
// check for its WebSocket/control-plane surface, which this script's
// clients never use. Fine for a short-lived local test on a trusted home/
// office network; do not leave this running unattended or use it on a
// shared/untrusted network.
//
// Usage:
//   node --experimental-strip-types tools/mobile-chat-poc/test/start-manual-test-gateway.mts
import { createServer, request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

import { waitForGatewayReady, stopGateway } from "../../comparator/src/driver.ts";
import { AGENTS_MD_CONFIRMATION_SECTION, copyNancyPluginForRun, buildModelsProvidersConfig } from "../../comparator/src/config-builder.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const OPENCLAW_ENTRY = join(REPO_ROOT, "node_modules", "openclaw", "openclaw.mjs");
const WEB_DIR = resolve(HERE, "..", "web");
const RUNS_ROOT = join(HERE, "runs");
const TASK_MODEL = "google/gemini-2.5-flash";

function log(msg: string): void {
  console.log(`[manual-test-gateway] ${msg}`);
}

function lanAddress(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  throw new Error("could not detect a LAN IPv4 address — check your network connection");
}

function readLiveAnalysisConfig(): { provider: string; model: string; apiKey: string; baseUrl?: string } {
  const result = spawnSync(process.execPath, [OPENCLAW_ENTRY, "config", "file"], { encoding: "utf8", timeout: 20_000 });
  const configPath = (result.stdout ?? "").trim();
  if (result.status !== 0 || !configPath || !existsSync(configPath)) {
    throw new Error(`could not resolve the live openclaw config path via 'openclaw config file': ${result.stderr ?? "unknown error"}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const analysis = cfg?.plugins?.entries?.nancy?.config?.analysis;
  if (!analysis?.apiKey) throw new Error("plugins.entries.nancy.config.analysis (with an apiKey) was not found in the live config.");
  return analysis;
}

function pickPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

// comparator's own startGateway() hardcodes `--bind loopback` on the CLI —
// correct for that harness (agent CLI calls only, never a phone on the LAN),
// but a CLI flag always wins over the config file's own gateway.bind value
// (confirmed against a real run: config said "lan", process still listened
// on 127.0.0.1 only, because startGateway's hardcoded flag silently
// overrode it). This is the same launcher with --bind lan instead, so a
// phone on the same network can actually reach the port.
//
// --auth none + --bind lan is refused outright at startup ("Refusing to
// bind gateway to lan without auth", confirmed against a real run) — a
// blanket safeguard for the Gateway's OWN WebSocket/control-plane surface,
// independent of A2A's own mandatory per-peer bearer token (see a2a.md:
// "Every JSON-RPC request requires a configured peer bearer token. There is
// no unauthenticated mode" — A2A was never actually relying on gateway auth
// being off). So a shared gateway token is still required here even though
// nothing in web/index.html or client.mjs ever sends it — only satisfies
// this startup check for the WS surface neither of them talks to.
function startGatewayLan(runPaths: { runDir: string; stateDir: string; configPath: string }, env: Record<string, string>, port: number, gatewayToken: string): ChildProcess {
  const logFd = openSync(join(runPaths.runDir, "gateway.log"), "a");
  return spawn(process.execPath, [OPENCLAW_ENTRY, "gateway", "run", "--port", String(port), "--auth", "token", "--token", gatewayToken, "--bind", "lan"], {
    env: { ...process.env, ...env, OPENCLAW_STATE_DIR: runPaths.stateDir, OPENCLAW_CONFIG_PATH: runPaths.configPath },
    stdio: ["ignore", logFd, logFd],
  });
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8" };

// Serves web/index.html AND reverse-proxies /a2a/v1 to the isolated Gateway
// on the SAME origin (this server's own host:port). Confirmed against a
// real phone: the plain page loads fine and a direct GET to the Gateway's
// own /.well-known/agent-card.json succeeds (proving plain network/firewall
// connectivity), but the page's own fetch() to the Gateway's port fails
// with the browser's generic "Failed to fetch" — the A2A route does not
// send permissive CORS headers, so any cross-origin (different-port counts)
// browser fetch is blocked client-side regardless of connectivity. Proxying
// server-side, where CORS does not apply, avoids the browser ever making a
// cross-origin request at all. Point the page's own "A2A-osoite" setting at
// THIS server's /a2a/v1, not the Gateway's port directly.
function serveWebDir(port: number, gatewayPort: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    if (req.url === "/a2a/v1" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const proxied = httpRequest(
          { host: "127.0.0.1", port: gatewayPort, path: "/a2a/v1", method: "POST", headers: { ...req.headers, host: `127.0.0.1:${gatewayPort}` } },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxied.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`Proxy error reaching the Gateway: ${String(err)}`);
        });
        proxied.end(body);
      });
      return;
    }
    const path = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
    const filePath = join(WEB_DIR, path);
    if (!filePath.startsWith(WEB_DIR) || !existsSync(filePath)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(filePath));
  });
  server.listen(port, "0.0.0.0");
  return server;
}

async function main() {
  const analysis = readLiveAnalysisConfig();
  const lanIp = lanAddress();
  log(`Using live analysis config: provider=${analysis.provider} model=${analysis.model} (apiKey read, never printed)`);

  const runId = `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = join(RUNS_ROOT, runId);
  const stateDir = join(runDir, "state");
  const workspaceDir = join(runDir, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "AGENTS.md"), AGENTS_MD_CONFIRMATION_SECTION);
  const nancyPluginDir = copyNancyPluginForRun(runDir);

  const gatewayPort = pickPort();
  const webPort = pickPort();
  const a2aToken = randomBytes(24).toString("hex");
  // Satisfies the Gateway's own "refusing to bind to lan without auth"
  // startup check (see startGatewayLan's comment) — never sent by
  // web/index.html or client.mjs, which only ever speak A2A's own bearer
  // token below.
  const gatewayToken = randomBytes(24).toString("hex");
  const geminiApiKey = analysis.apiKey;

  const config = {
    gateway: { mode: "local", port: gatewayPort, bind: "lan", auth: { mode: "token", token: "${NANCY_MANUAL_GATEWAY_TOKEN}" } },
    channels: {
      a2a: { enabled: true, peers: { "mobile-poc-manual": { token: "${NANCY_MOBILE_MANUAL_TOKEN}" } } },
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
            // Deliberately on for a first hands-on try: whatever you type
            // and whatever NanCy decides, no tool call or real send ever
            // actually happens. Turn off in the config file under
            // <runDir>/openclaw.json (then restart this script) once
            // you've seen the confirmation dance and want to see a real
            // action go through.
            testMode: true,
            telegramAlerts: false,
            telegramTaskReports: false,
            allowUnconfirmedInfoLookups: true,
          },
        },
      },
    },
    agents: {
      entries: { "test-agent": { model: TASK_MODEL, workspace: workspaceDir, tools: { allow: ["exec", "message", "read"] } } },
    },
    models: buildModelsProvidersConfig(TASK_MODEL, { GEMINI_API_KEY: geminiApiKey }, undefined),
  };
  const configPath = join(runDir, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const runPaths = { runDir, stateDir, configPath };
  const env = { GEMINI_API_KEY: geminiApiKey, NANCY_MOBILE_MANUAL_TOKEN: a2aToken, NANCY_MANUAL_GATEWAY_TOKEN: gatewayToken };

  log(`Starting isolated Gateway on ${lanIp}:${gatewayPort} (LAN-bound; run dir: ${runDir})`);
  const gatewayProc = startGatewayLan(runPaths, env, gatewayPort, gatewayToken);
  // @ts-expect-error runPaths is a narrowed stand-in for comparator's RunPaths — waitForGatewayReady only reads runDir/stateDir/configPath.
  await waitForGatewayReady(runPaths, env, gatewayPort);
  log("Gateway is healthy.");

  const webServer = serveWebDir(webPort, gatewayPort);

  console.log("");
  console.log("=================================================================");
  console.log("On your phone (same Wi-Fi network), open:");
  console.log(`  http://${lanIp}:${webPort}/`);
  console.log("");
  console.log("In the page's Asetukset panel, enter:");
  // Same origin as the page itself (this server), which proxies to the
  // Gateway server-side — NOT the Gateway's own port directly, which the
  // browser's fetch() cannot reach cross-origin (see serveWebDir's comment).
  console.log(`  A2A-osoite: http://${lanIp}:${webPort}/a2a/v1`);
  console.log(`  Bearer-token: ${a2aToken}`);
  console.log("=================================================================");
  console.log("");
  console.log("testMode is ON: nothing the agent decides to do will really execute.");
  console.log("Press Ctrl+C here to stop the gateway and web server.");
  console.log("");

  const shutdown = async () => {
    log("Shutting down...");
    webServer.close();
    const { stopped } = await stopGateway(gatewayProc);
    if (!stopped) log(`warning: gateway process (pid ${gatewayProc.pid}) may still be running — check it manually.`);
    log(`Run artifacts kept at: ${runDir}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
