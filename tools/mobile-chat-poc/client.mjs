#!/usr/bin/env node
// Minimal terminal chat client for OpenClaw's bundled A2A channel — the
// mobile-app POC's transport, standing in for a real phone client. No
// dependencies beyond Node's built-in fetch/crypto/readline. See README.md
// in this directory for what this proves and what's still unverified.

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const opts = { poll: false, timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--token") opts.token = argv[++i];
    else if (arg === "--context") opts.contextId = argv[++i];
    else if (arg === "--poll") opts.poll = true;
    else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!opts.url) {
    console.error("Usage: client.mjs --url <a2a endpoint> --token <bearer token> [--context <id>] [--poll] [--timeout <ms>]");
    process.exit(1);
  }
  opts.token ??= process.env.A2A_TOKEN;
  if (!opts.token) {
    console.error("Missing --token (or set A2A_TOKEN in the environment).");
    process.exit(1);
  }
  return opts;
}

export async function callJsonRpc(url, token, method, params) {
  const body = { jsonrpc: "2.0", id: randomUUID(), method, params };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Non-JSON response (HTTP ${res.status})`);
  if (json.error) throw new Error(`A2A error ${json.error.code ?? "?"}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

export function extractTaskText(task) {
  const parts = (task?.artifacts ?? []).flatMap((a) => a.parts ?? []);
  const text = parts
    .filter((p) => typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text)
    .join("\n");
  return text || `[no reply text — task state: ${task?.status?.state ?? "unknown"}]`;
}

export async function pollUntilSettled(url, token, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const settled = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"]);
  for (;;) {
    const result = await callJsonRpc(url, token, "GetTask", { id: taskId });
    const state = result?.task?.status?.state;
    if (settled.has(state)) return result.task;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for task ${taskId} (last state: ${state})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Sends one chat turn and returns { text, contextId, taskId }.
export async function sendMessage(opts, text, contextId) {
  const params = {
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
    },
  };
  if (contextId) params.contextId = contextId;
  if (opts.poll) params.configuration = { returnImmediately: true };

  const result = await callJsonRpc(opts.url, opts.token, "SendMessage", params);
  let task = result?.task;
  if (!task) throw new Error("SendMessage response had no task");

  if (opts.poll && task.status?.state === "TASK_STATE_WORKING") {
    task = await pollUntilSettled(opts.url, opts.token, task.id, opts.timeoutMs);
  }

  return { text: extractTaskText(task), contextId: task.contextId ?? contextId, taskId: task.id };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Connected to ${opts.url}${opts.poll ? " (returnImmediately + poll mode)" : " (blocking mode)"}`);
  if (opts.contextId) console.log(`Resuming context ${opts.contextId}`);
  console.log('Type a message and press Enter. Ctrl+C to quit. Reply "y" to confirm a pending NanCy request.\n');

  let contextId = opts.contextId;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    try {
      const reply = await sendMessage(opts, text, contextId);
      contextId = reply.contextId;
      console.log(`nancy> ${reply.text}`);
      if (contextId && contextId !== opts.contextId) {
        console.log(`  (context: ${contextId})`);
      }
    } catch (err) {
      console.error(`  [error] ${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nBye.");
    process.exit(0);
  });
}

// Guarded so other scripts (e.g. tools/mobile-chat-poc/test/run-isolated-a2a-test.mts)
// can import callJsonRpc/sendMessage/extractTaskText/pollUntilSettled above
// without starting the interactive REPL as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
