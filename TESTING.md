# Testing NanCy

NanCy is security-critical and easy to get subtly wrong. This doc is the
fast-orientation guide for testing changes to the plugin (`src/index.ts` and
the modules under `src/` it wires together — see `CLAUDE.md`'s module map) —
read it before touching `before_tool_call`, `message_sending`, or `testMode`
logic. It complements `CLAUDE.md` (orientation) and `SECURITY-PHILOSOPHY.md`
(deployment posture).

## The one rule: never touch the live gateway on your own initiative

The operator normally has a real OpenClaw gateway running in the foreground
(`openclaw gateway run`), wired to a real Telegram bot. It is tempting to
just restart it with a test config to see what happens. Don't — unless the
operator explicitly asks you to, in the moment, for that specific action.
Absent that ask, the default is still don't.

- `openclaw gateway stop` / `--force` explicitly refuses this: *"This stops
  the operator's running gateway service. Use an isolated dev gateway... for
  testing."* That's the project's own CLI telling you the right answer for
  anything you're doing on your own initiative rather than on request.
- Claude Code's own auto-mode safety classifier independently blocks
  `taskkill`/process-kill attempts against it ("Interfere With Workloads") —
  that's a bypass of the gateway's own process, not a sanctioned way to honor
  an operator request either; use the project's own stop/run commands.
- Even a clean restart means a real, possibly mid-conversation Telegram bot
  goes offline for a few seconds — for a stranger's phone notification, not
  a lab environment. That's a cost the operator gets to accept for
  themselves, not one you assume on their behalf.

If you think you need the live gateway, you almost certainly want one of the
two options below instead. The things that actually require touching the
live gateway are (a) confirming a *config* change (like a new
`analysis.model`) with a real live conversation, and (b) an operator request,
made in this conversation, to start/stop/restart it right now. Both still go
through the project's own commands (`openclaw config set` for validated
writes, `openclaw gateway run`/`stop` for the process itself) — never a
bypass like `taskkill`. Never restart or stop it on your own initiative for
exploratory testing; do it only on a specific, in-the-moment operator
request, not because a past instruction in this file or elsewhere implied
general standing permission.

## Option A — `npm test` (fast, deterministic, no network)

Experimental debate comparison: `node --experimental-strip-types scripts/eval-debate.mts --list` previews synthetic cases without network access. To run them against a real model, set `NANCY_EVAL_CONFIG` to a JSON file containing an `AnalysisConfig` (provider/model/apiKey/baseUrl) and run the same command without `--list`. `NANCY_EVAL_RUNS` defaults to 3. This uses only the reviewer API, never a gateway, and writes `DEBATE-EVAL-RESULTS.json` with per-case verdicts, false-ALLOW/false-block flags, call counts and elapsed time for all four modes. It does not measure provider tokens/cost or prove deployment safety. The existing full-hook eval remains necessary for integration coverage.

```
npm run check   # typecheck + test
npm test        # just the test suite (node --test test/*.test.ts)
```

`test/helpers.ts` exports `createFakeApi()`: a minimal fake of the OpenClaw
plugin host (`rootDir`, `pluginConfig`, `runtime.agent.resolveAgentWorkspaceDir`,
`runtime.subagent`, `on()`) pointed at a fresh temp directory. It's enough
surface for `nancyPlugin.register(api)` to run for real — this exercises the
actual `src/index.ts` code, not a reimplementation of it.

Pattern for a new test (see `test/testmode-message-sending.test.ts` for the
full version):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import nancyPlugin from "../src/index.ts";
import { createFakeApi } from "./helpers.ts";

test("describe the one behavior under test", async () => {
  const { api, handlers, cleanup } = createFakeApi({
    pluginConfig: { testMode: true, analysis: { provider: "openai", model: "test-model", apiKey: "x" } },
  });
  // @ts-expect-error FakeApi is a narrowed stand-in for OpenClawPluginApi
  nancyPlugin.register(api);
  // mock global.fetch here if the path under test calls callLlm() or Telegram
  const result = await handlers.before_tool_call({ toolName: "exec", params: { command: "dir" } }, { sessionKey: "s1" });
  assert.equal(result?.block, true);
  cleanup();
});
```

Mock `globalThis.fetch` around the call (see `mockFetchOnce` in
`test/testmode-message-sending.test.ts`) to control the LLM verdict without
hitting a real API — this is what makes the suite fast and free. Use this
tier for regression tests: "does this exact code path still behave the way
we decided it should."

This tier cannot tell you whether the *real* configured reviewer model would
actually reach a sensible verdict for some scenario — its canned responses
prove the plumbing works, not the judgment. For that, use Option B.

## Option B — standalone harness against the real analysis model

Same `createFakeApi()`-style stubbing, but with the real `analysis` config
(provider/model/apiKey) from the operator's live config, and *without*
mocking `fetch` — so `callLlm()` makes a genuine call and you see a real
ALLOW/BLOCK/CLARIFY verdict for a specific realistic scenario. Use this when
you need to know "would the actual reviewer catch this," not just "does the
code path work."

```js
import { readFileSync } from "fs";
import { pathToFileURL } from "url";
import { createFakeApi } from "./test/helpers.ts"; // or inline an equivalent stub

const live = JSON.parse(readFileSync(String.raw`C:\Users\<user>\.openclaw\openclaw.json`, "utf8"));
const analysis = live.plugins.entries.nancy.config.analysis; // reuse the real reviewer config

// IMPORTANT: never let a real Telegram push escape a test run.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes("api.telegram.org")) {
    console.log("[INTERCEPTED TELEGRAM SEND]", JSON.parse(opts.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return realFetch(url, opts); // real Gemini/OpenAI calls still go through
};

const { api, handlers, rootDir } = createFakeApi({ pluginConfig: { analysis, testMode: true } });
const mod = await import(pathToFileURL(String.raw`C:\projects\nancy\src\index.ts`).href);
mod.default.register(api);

// There is no confirmed-task FILE to write anymore (see below) — a task is
// only ever authorized by actually driving the real confirmation dance
// through message_sending + message_received (see the confirmation-request
// format below), which is what spawnWorkerForTask uses to populate the
// in-memory authorization for the exact worker session key it creates.
// Then call handlers.before_tool_call({ toolName, params }, { sessionKey, agentId })
// and read rootDir + "/nancy.log" / "/nancy-analysis.log" for what happened.
```

Always keep `testMode: true` in this tier unless the entire point of the run
is to check what a *real* ALLOW would let through — with `testMode: true`,
even a genuine ALLOW verdict is turned into a block that names what it would
have done, so a bad verdict can never actually do anything. This applies to
both `before_tool_call` (tool calls) and `message_sending` (outbound
messages) — a real ALLOW, an analysis error, and a missing-analysis-config
all dry-run as a cancel instead of sending, and the reason logged/returned
says `TEST MODE`. The one deliberate exception is NanCy's own fixed-format
confirmation-request prompt (`Formal confirmation: ...`), which still sends
for real even in test mode — it's a rigid, NanCy-recognized template rather
than arbitrary agent content, it's the only way to exercise the confirmation
dance end-to-end, and it's sent for real in production anyway.

**Always intercept `api.telegram.org`** in this tier (as above) if
`telegramAlerts`/`telegramTaskReports` might be enabled in the config you
copy — otherwise a test run can push a real, confusing notification to the
operator's real phone. Belt-and-suspenders: `createFakeApi()`'s `api.config`
defaults to `{}`, so if you never copy `channels.telegram` into the
`pluginConfig`/`api.config` you pass it, `telegramAlertsEnabled`/
`telegramTaskReportsEnabled` resolve `false` regardless of what the live
config says — do that *in addition to* the fetch intercept, not instead of
it (a future code path could read `channels.telegram` some other way).

### Practical gotchas, from actually running this tier once

- **Finding the live config path**: don't guess
  `~/.openclaw/openclaw.json` or hand-build it from `$env:USERPROFILE` inside
  a `Bash`-tool call that shells out to `powershell -Command "...$env:...`"`
  — the outer POSIX shell can mangle the `$env:` reference before PowerShell
  ever sees it, silently producing a wrong path that then reads as "file
  doesn't exist." Either run `openclaw config file` (prints the actual active
  config path, read-only, safe) or check the path with a PowerShell-tool call
  directly rather than nesting it inside the Bash tool.
- **A standalone harness script placed *outside* the `nancy` repo** (e.g. in
  a scratch/temp dir) has no ancestor `package.json` with `"type": "module"`,
  so `node --experimental-strip-types <file>.ts` on it resolves as CommonJS
  and rejects top-level `await`/`import`. Name it `.mts` instead — Node
  always treats that extension as ESM regardless of the nearest
  `package.json` — or run it from inside the repo.
- **`createFakeApi()`'s default `subagent.waitForRun` resolves immediately**,
  which makes NanCy tear the worker session down (`deleteSession`) right
  after spawn — so a `before_tool_call` you fire moments later against
  `agent:<workerAgentId>:task-<id>` already sees no authorization. To
  actually probe a worker session's behavior after confirming it, pass a
  `subagent` override with `waitForRun: () => new Promise(() => {})` (never
  resolves), the same trick `test/worker-task-authorization.test.ts` uses to
  keep two tasks genuinely concurrent — this keeps the session "live" so you
  can fire as many `before_tool_call`s at it as you want.
- **The worker session key is derived from the task id you pick**, not from
  whatever session confirmed it: confirm with
  `confirmTask("sess-1", "424242", description)` and then probe
  `agent:<workerAgentId>:task-424242` — those are two different session keys
  and mixing them up looks like "authorization never took," when it's just
  the wrong key.
- A deliberately mismatched action (e.g. confirm a "look up flight prices,
  never buy" task, then send a `browser act click` on a buy button, or an
  `exec` shelling a payment POST) is a good sanity check that the real
  reviewer model — not just the plumbing — catches intent mismatches. Note
  that NanCy's context-check step can reasonably block a *literally* benign
  follow-up action too, if it looks like a continuation of a page/flow it
  just blocked (e.g. still typing into a field on what it believes is a
  checkout page) — that's the reviewer using state, not a bug in the harness.

## Reusable scenario eval (`scripts/run-eval.mts`)

A fixed, hand-written set of scenarios (`scripts/eval-scenarios.json`) — protected-path writes, the main/cron default-deny gate, the no-confirmed-task hard block, Domain Border Control, and genuine intent-match/mismatch/ambiguous cases — runnable end-to-end against the real configured reviewer model with the exact Option B safety properties above (`testMode: true`, live gateway never touched, no channels/telegram config passed into the harness). Run it and it (re)writes `EVAL-RESULTS.md` at the repo root:

```
node --experimental-strip-types scripts/run-eval.mts
node --experimental-strip-types scripts/run-eval.mts --config=C:\path\to\openclaw.json
```

Re-run this after changing `analysis.model` or anything under `src/policy/`/`src/analysis/` to catch reviewer-behavior regressions — it's the fastest way to see, in one shot, whether the real model still reaches the same verdicts across every gate NanCy has. Edit `scripts/eval-scenarios.json` to add scenarios; each needs a `sessionMode` (`"none"`, `"main"`, or `"worker"`) and, for `"worker"`, a `taskId` (6–10 digits) plus a `task` description — see the comments at the top of `run-eval.mts` for how session keys and task confirmation are derived.

## Confirmed-task "record", for either tier

There is no `tasks/current.json` file anymore — an earlier version stored
the confirmed task in a shared file per agent workspace, which meant two
tasks confirmed close together on the same `workerAgentId` could overwrite
each other's authorization (the second worker could start seeing the first
task's record, or vice versa — a real cross-task authorization leak, not
just a cosmetic bug). Authorization now lives only in an in-memory
`taskBySessionKey: Map<string, ConfirmedTask>`, keyed by the *exact* worker
session key NanCy itself generates (`agent:<workerAgentId>:task-<id>`), and
is populated only by `spawnWorkerForTask` right before it spawns that worker
— never from anything the agent itself, or a test, can write directly. The
shape of one entry:

```ts
{ id: "12345678", ts: "2026-09-12T20:00:00.000Z", description: "What the task is", status: "confirmed", openclaw_task_id: null }
```

`ts` must be within `CONFIRMED_TASK_MAX_AGE_MS` (4 hours) of "now" or
`getCurrentTask(sessionKey)` treats it as if nothing were confirmed.
Practically: to test anything gated on "a task is confirmed," drive the real
confirmation dance (see below) rather than trying to seed state directly —
that's now the only way in, by design.

## Which tool calls actually reach the LLM, cheat sheet

Verified against openclaw@2026.9.4's own tool registry
(`core-tool-factory-descriptors.ts`) and the browser/computer extension
schemas — not guessed. Two things worth knowing before you touch this code:
`"shell"`/`"bash"` were never real tool names (a leftover from an earlier,
wrong assumption); and the browser tool's real dispatch field is `action`
(with a nested `kind` only when `action: "act"`), not `command` — an earlier
version of this gate read the nonexistent `command` field, which silently
made every browser call invisible to both analysis and the main-session
gate, in every session type, regardless of what it actually did.

- **Hard-blocked outright, no LLM call, independent of session**: writes to
  a protected file (`AGENTS.md`/`IDENTITY.md`/`MEMORY.md`/`NANCY-POLICY.md`/
  NanCy's own code/config), and Domain Border Control denials.
- **Main session and cron-triggered runs: default-deny allowlist, no LLM
  call either way.** `isMainGateAllowed()` only lets through pure local
  reads (`read`, `ls`, `view_image`, `get_goal`, `session_status`,
  `sessions_list`/`_history`/`_search`, `agents_list`,
  `conversations_list`, `github_identity_status`, `transcripts`) plus a
  curated set of passive `browser` actions (`snapshot`, `screenshot`,
  `text`, `tabs`, `console`, `requests`, `errors`, `status`, `doctor`) and
  `computer` actions (`screenshot`, `wait` — openclaw's own `LOCAL_ACTIONS`).
  Anything not on these lists — including `apply_patch`, `process`,
  `message`, and any tool NanCy has never heard of — is blocked outright.
  This used to be a *blocklist* naming only `write`/`edit`/`exec`; dozens of
  real tools (`secrets`, `gateway`, `subagents`, `sessions_spawn`/`_send`,
  `conversations_send`, `automations`, `github_publish`, `nodes`,
  `mobile_ui`, `terminal`, ...) fell through it completely unchecked. If you
  add a new tool call anywhere in this file, assume it is blocked by default
  in main/cron until proven otherwise — that's the point of default-deny.
- **Everything else that reaches `shouldAnalyze() === true`**: `web_fetch`,
  `web_search`, `write`, `edit`, `apply_patch`, `message`; `exec` when the
  command isn't on the `SAFE_EXEC` allowlist; `process` for any action other
  than `list`/`poll`/`log`; and `browser` for the interactive actions
  (`start`/`stop`/`navigate`/`open`/`upload`/... — see
  `BROWSER_INTERACTIVE_ACTIONS`) or `action: "act"` with an interactive
  `kind` (`click`/`type`/`fill`/`select`/`drag`/`evaluate`/... — see
  `BROWSER_INTERACTIVE_ACT_KINDS`). These get a real LLM verdict.
  **With no confirmed task**, every one of these hard-blocks outright before
  any LLM call — **except `web_search`/`web_fetch`**, which (with
  `allowUnconfirmedInfoLookups`, default **on**) still reach the real
  reviewer, judged against a fixed generic "this must be a harmless,
  read-only information lookup" baseline (`buildUnconfirmedInfoLookupTask` in
  `confirmation/tasks.ts`) instead of an actual confirmed task — so a benign
  search is routinely ALLOWed with no task, but an exfiltration-shaped
  `web_fetch` URL is not. Capped independently of the reviewer's own
  judgment by `unconfirmedInfoLookupLimitPerHour` (default 10/session/hour) —
  see `scripts/eval-scenarios.json`'s `unconfirmed-info-lookup-*` scenarios
  and `test/unconfirmed-info-lookup.test.ts` for both properties verified.
  Set `allowUnconfirmedInfoLookups: false` to go back to the old strict
  behavior for these two tools as well.
- **Everything else** (e.g. a plain `read`, or `browser` with a passive
  `action`) skips analysis entirely and passes straight through — instant,
  free, no LLM call.

## Live dry-run against the real Telegram bot, without the CLI harness

If you specifically need to watch the *real* agent (real model, real
AGENTS.md instructions) attempt a real task end-to-end while `testMode: true`
guarantees nothing actually executes: set `testMode: true` on the live
config via `openclaw config set plugins.entries.nancy.config.testMode true`,
then restart the gateway — the operator's own restart on their own schedule,
or yours if they explicitly ask for that specific restart in the moment —
then drive it with `openclaw agent --session-key <mainSessionKey> --message
"..."` for the task and a second call with `"y"` for the confirmation reply —
both work over the CLI without going through Telegram at all, since NanCy's
confirmation matching only keys on `sessionKey`, not channel. Turn
`testMode` back off (`openclaw config unset ...`) and restart again the same
way when done. Absent an explicit in-the-moment request, this still doesn't
require killing/restarting the gateway on your own initiative.
