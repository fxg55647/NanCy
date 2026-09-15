# Behavior Comparator

Status: **v1, one scenario, calibration-run mode only, full pipeline confirmed working end to end against a real model.** This is the design record for `tools/checkpoint-recorder/`, `tools/scenario-shop/`, and `tools/comparator/` — read it before extending any of them, so later changes stay consistent with the decisions below instead of silently drifting from them. None of this is part of NanCy itself; it's a dev-only instrument that runs *alongside* NanCy (or without it) to observe the difference. A real, billed calibration run has shown the complete real chain for the first time: A2A delivery → `message_received`/`before_tool_call` → the agent's own confirmation request reaching `message_sending` → NanCy's required confirmation-review actually judging it. See "Known limitations" for exactly what that run found (including a real NanCy observability gap it surfaced) and what's still open.

## Why this exists

NanCy's own test suite (`test/*.test.ts`, `scripts/run-eval.mts`) proves NanCy's verdict logic works, by calling `handlers.before_tool_call(...)` directly with hand-picked params. It has never proven what a *real* OpenClaw agent, running a real agentic loop against a real model, actually does differently because NanCy is or isn't in the loop — whether it asks a clarifying question it wouldn't otherwise ask, whether a vague request turns into a cheaper or more scoped purchase, or whether NanCy just adds friction with no visible effect on the outcome. The comparator runs the same ambiguous or precise shopping task twice — once with a bare OpenClaw agent, once with NanCy loaded — against a fully simulated shop (no real network, no real purchase), and reports what actually differed, per run, traceable to real events.

## Pieces

- **`tools/checkpoint-recorder/`** — a passive OpenClaw plugin (built first, independent of the comparator) that captures the full model context (`llm_input`: systemPrompt/prompt/historyMessages/tools) and every tool call's proposed params (`before_tool_call`) and, when it actually ran, its result (`after_tool_call`), correlated by `toolCallId`. It never returns a hook result, so it can never block, alter, or authorize anything.
- **`tools/scenario-shop/`** — a fully local OpenClaw plugin providing `search_products`/`buy_product` tools, backed by a per-run JSON catalog and purchase-log file. No network calls anywhere in it.
- **`tools/comparator/`** — the driver: builds an isolated OpenClaw profile per run, starts a real isolated `openclaw gateway` process, drives turns against it over OpenClaw's bundled A2A channel, runs a user-simulator, and produces the report.

## Key decisions, and what grounds them

### The transport: a real isolated Gateway process driven over the A2A channel — not `agent --local`, plain `agent --json`, or `agent exec`

Three other options were tried and rejected before this, each a real, reproduced dead end, not a guess:

- **`openclaw agent exec`** ("Run one isolated headless embedded agent turn") looks like the obvious fit, but it's always a fresh `randomUUID()` session in a throwaway temp state dir, deleted after the call (`node_modules/openclaw/dist/agent-exec-*.mjs`) — there is no way to continue a conversation across two `agent exec` calls, and the comparator needs a real multi-turn conversation.
- **`openclaw agent --local --session-key <key> --message "<text>" --json`** does resume a real disk-backed session across separate CLI invocations — but run for real end to end, it bypasses OpenClaw's entire channel-delivery pipeline: a real `nancy`-branch run produced a perfectly-formatted NanCy `"Formal confirmation: ..."` / `"y"` exchange in the transcript, with **zero** entries in `nancy.log` — `message_sending` never fired. Traced to `agent-command-*.mjs`'s `prepareCurrentRunDelivery`: `if (opts.deliver !== true) return;`.
- **Plain `openclaw agent --agent test-agent --session-key <key> --message "<text>" --json` against a real, separately-started Gateway (no `--local`)** was the next hypothesis — a Gateway-routed turn's normal reply-dispatch path *should* invoke `message_sending` regardless of `--deliver`. **This turned out to be wrong too**, confirmed the same way: a real `nancy`-branch run against a live Gateway still produced the full "Formal confirmation" / "y" exchange in the transcript with zero `message_sending`/`confirmation_*` entries in `nancy.log`. A Gateway process is necessary for these hooks to exist at all, but not sufficient — `--deliver` genuinely requires a real external channel target (`"Channel is required (no configured channels detected)"`), which this harness must never touch, and without it there is still no delivery pipeline for a bare CLI call to go through.

The actual fix: drive turns through OpenClaw's bundled **A2A channel** (JSON-RPC over HTTP, `channels.a2a` config only — zero new plugin code) instead of the `agent` CLI at all. A2A *is* a real channel, so `SendMessage`/inbound dispatch genuinely exercises message_sending/message_received — first proven end to end by `tools/mobile-chat-poc/`'s own A2A test against an isolated Gateway with NanCy loaded (a parallel effort on the mobile-app plan, see `docs/mobile-app-todo.md`), which is what this comparator's own A2A integration reuses and builds on, not a fresh guess. `driver.ts`'s `sendA2ATurn()` calls `SendMessage` with the same `contextId` across turns (A2A's session-continuation mechanism, replacing `agent --session-key`); only the Gateway process itself is spawned as a child process — every turn after that is a lightweight HTTP call, not a new `openclaw` process.

`config-builder.ts` declares the channel per run: `channels: {a2a: {enabled: true, peers: {comparator: {token: "${NANCY_COMPARATOR_A2A_TOKEN}"}}}}`. Two details that cost real debugging time, both findable only by attempting a real config: **A2A's `peers.<id>.token` schema takes a plain string with `"${ENV_VAR}"` interpolation** (validated by `openclaw doctor`), **not** the `{source:"env",...}` SecretRef object form some other channel configs accept elsewhere in OpenClaw — passing the object form fails config validation outright. The literal token value itself is generated fresh per run (`randomBytes(24).toString("hex")`) and lives only in the Gateway child process's own env, never in the config file on disk.

### A real Gateway is required, and it's a genuinely separate concern from `--deliver`

`config-builder.ts` still sets `gateway: {mode: "local", port: <random per-run port>, bind: "loopback", auth: {mode: "none"}}` — a Gateway process has to exist for A2A (or any channel) to have something to run inside. `auth.mode: "none"` is safe here: bound to loopback, on a throwaway port that only exists for this run's lifetime — the per-run A2A peer token above is the actual access boundary for the one HTTP surface this run exposes.

Credential isolation does **not** come from `--auth-env-only` — that flag exists only on `openclaw agent exec`, irrelevant now that no `agent` CLI calls happen per turn at all. Only the **Gateway process itself** needs real model credentials — `driver.ts` builds its env from `listKnownProviderAuthEnvVarNames()`/`omitEnvKeysCaseInsensitive()` (`openclaw/plugin-sdk/provider-auth` — OpenClaw's own real list of provider credential env var names, not a guessed one) applied to *this* process's own env, stripping every known provider credential var before layering the run's own explicit `env` (from `model-config.json`) on top. `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` are set on that same env, per run — the same mechanism `--profile <name>` uses under the hood, but fully under this harness's control (a disposable temp dir, never `~/.openclaw*`).

### Spawning the Gateway on Windows: `process.execPath` + `openclaw.mjs`, not the `.bin` shim

`spawn("node_modules/.bin/openclaw.cmd", [...])` fails with `EINVAL` on Windows (verified empirically — a `.cmd` shim needs `shell: true` or direct invocation of the real entry to spawn correctly). `driver.ts` instead resolves `node_modules/openclaw/openclaw.mjs` directly (the real file `package.json`'s `"bin"` field points at) and spawns it via `process.execPath` (this process's own Node binary) — works identically cross-platform, confirmed by `driver-smoke.test.ts`'s real spawn.

### A provider auth/request failure doesn't surface as an A2A task error state

Found via `driver-smoke.test.ts`'s own real run: a bad API key does **not** produce `TASK_STATE_FAILED`/`TASK_STATE_REJECTED` — OpenClaw catches the failure upstream and returns an ordinary `TASK_STATE_COMPLETED` task whose reply text is its own synthesized warning (observed verbatim: `"⚠️ google/gemini-2.5-flash request failed (authentication failed, HTTP 400). Re-authenticate the provider and try again."`). `driver.ts`'s `taskFailure()` only checks task state, so this class of failure currently reads as ordinary (if odd-looking) assistant text during a real run — `evaluate.ts`/`report.ts` have no special handling for it yet. Recognizing the `"⚠️ ... request failed"` shape too is flagged as future work directly in `taskFailure()`'s own comment.

### Plugins need `plugins.allow`, not just `plugins.load.paths`

Listing a plugin's directory under `plugins.load.paths` alone is not enough — a real run surfaced `OpenClaw can't verify where this plugin came from... Adding it to plugins.allow lets it load, but does not make it trusted` for both `scenario-shop` and `checkpoint-recorder`. `config-builder.ts` now also sets `plugins.allow` to exactly the plugin ids that run's branch loads (`scenario-shop`, `checkpoint-recorder`, and — nancy branch only — `nancy`), removing the ambiguity outright rather than relying on whatever a merely-warned, unverified load actually still does.

### A headless profile can't discover models on its own — declare them directly

`openclaw models list --refresh` against a fresh isolated profile returns an empty catalog even with a valid stored auth profile — model discovery appears to need a live gateway actively doing it, not just a bare CLI subcommand — and `openclaw agent` then fails with `"Unknown model: ..."` for literally any `google/...` model id, including ones the operator's own real, working config already uses successfully. The fix is declaring the provider and exact model definition directly under the top-level `models.providers` config (`ModelProviderConfig`/`ModelDefinitionConfig` in openclaw's schema), bypassing discovery entirely — `config-builder.ts`'s `buildModelsProvidersConfig()`, confirmed working against a real model call. Only `google` (Gemini via the AI-Studio-style API-key adapter — `api: "google-generative-ai"`, not Vertex/OAuth) is registered; adding another provider means adding and independently verifying a new `PROVIDER_REGISTRATION` entry.

### Tool-registering plugins need `contracts.tools` in their manifest

A real Gateway startup log surfaced `plugin must declare contracts.tools before registering agent tools (plugin=scenario-shop)` — `defineToolPlugin`'s registered tools are rejected under Gateway-managed loading without a matching `contracts: {tools: [...]}` array in `openclaw.plugin.json`, listing every tool name exactly. Fixed by running the project's own `openclaw plugins build --root tools/scenario-shop --entry src/index.ts`, which generates the correct manifest (and flips `activation` to the modern `{onStartup: true}` form) rather than hand-writing it — this passed silently under the old `--local` one-shot mode, which didn't enforce it, so it was invisible until a real Gateway run surfaced it.

### `llm_input`/`llm_output` need `hooks.allowConversationAccess: true`

The same real Gateway startup log also surfaced `typed hook "llm_input" blocked because non-bundled plugins must set plugins.entries.<id>.hooks.allowConversationAccess=true` for both `checkpoint-recorder` and `nancy` — a runtime privacy gate specifically on these two hooks (they carry the full raw prompt/conversation), separate from the `contracts` manifest requirement above. Without it, checkpoint-recorder's `llm_input`/`llm_output` handlers are silently skipped — which is exactly why every real run produced zero capture files despite the plugin loading successfully. `config-builder.ts` now sets `plugins.entries.checkpoint-recorder.hooks.allowConversationAccess: true` and the same for `nancy` (nancy branch only).

### A long-lived child's stdio must go to a real file, not an unconsumed pipe

`startGateway()` originally used `stdio: ["ignore", "pipe", "pipe"]` with nothing ever reading those pipes. A verbose, long-running process (the Gateway logs continuously) fills the OS pipe buffer and then blocks on its own `write()` call waiting for it to drain — which also stops it from responding to `kill()` in any reasonable time, reproduced empirically as `stopGateway()` hanging for a full test timeout. Fixed by opening a real file (`<runDir>/gateway.log`) and passing its fd as stdout/stderr instead — also useful for debugging a run that didn't behave as expected.

### Confirming a Windows child actually stopped: don't trust the `"exit"` event alone

Even after fixing the pipe issue above, `ChildProcess`'s own `"exit"` event was observed not firing in time to be awaited for this specific process tree (`node openclaw.mjs gateway run ...`) on Windows, while the underlying OS process reliably *did* terminate within a few seconds (confirmed independently via `Get-CimInstance Win32_Process`). `stopGateway()` now polls two independent signals — `proc.exitCode`/`proc.signalCode`, and (on Windows) whether the PID still appears in `tasklist /FI "PID eq <pid>" /NH` — resolving `{stopped: true}` as soon as either confirms death, with an escalation from a normal `kill()` to `kill("SIGKILL")` if it's still alive after a grace period. `run-comparison.ts`/`runComparisonRun()` log a warning (never throw) if a gateway still isn't confirmed stopped, so a stuck process is visible rather than silently leaked.

### NanCy needs a fresh per-run plugin copy, not a shared load from the repo root

OpenClaw resolves a plugin's `api.rootDir` to the plugin's own package directory. Loading NanCy straight from the repo root (as v1 first did) means `api.rootDir` is `C:\projects\nancy` for every nancy-branch run — NanCy would write `nancy.log`/`nancy-analysis.log` into the actual repo root, shared and overwritten across every run, undiscoverable by `correlate.ts` (which searches under each run's own directory), and potentially colliding with a real operator gateway using the same checkout. `config-builder.ts`'s `copyNancyPluginForRun()` instead copies NanCy's `package.json`, `openclaw.plugin.json`, and full `src/` tree into `<runDir>/nancy-plugin/` fresh on every run (never cached, so it can't go stale against real source edits) and points `plugins.load.paths` at that copy. The copy is nested inside the nancy repo itself (`tools/comparator/runs/.../nancy-plugin/`), so Node's module resolution for the copy's own imports (e.g. `arweave`) still walks up to find the real `node_modules` at the repo root.

### Price has to be in the tool call's own params, not just resolvable inside the tool

`buy_product`'s params originally carried only `productId`/`quantity` — a security reviewer sitting in front of `before_tool_call` only ever sees `params`, so it had no way to weigh price against a stated budget; the actual total existed only inside the tool's own local catalog lookup, invisible to anything inspecting the call. `buy_product` now requires `expectedTotal`/`currency` as params, validated server-side against the catalog (the order is rejected, not silently corrected, if they don't match) — this both surfaces price to anything reviewing the call and forces the model to have actually computed the real total rather than being taken on faith.

### Tool descriptions must not leak that the shop is simulated

`search_products`/`buy_product`'s model-facing descriptions read like an ordinary shop's tools, with no mention that purchases are simulated. Telling the model "this isn't real" would change exactly the behavior this harness exists to observe — a model that knows nothing is at stake may reasonably act less carefully about price or fit than it would for a real purchase. The simulation lives entirely in the implementation (local files only, no network), never in what the model is told.

### Branch order is randomized per run, not always baseline-then-nancy

`run-comparison.ts` picks `[baseline, nancy]` or `[nancy, baseline]` per `(scenario, profile)` at random, so that once this harness runs repeated trials (see "Known limitations"), ordering effects — provider warm-up, time-of-day, rate-limit backoff state carried from one run into the next — can't systematically favor one branch over the other. The report itself doesn't care which ran first, only which branch produced which facts.

### With/without NanCy must be two separate profiles, not two agents in one config

OpenClaw's plugin loading (`plugins.load.paths`/`plugins.entries`) is gateway-global; there is no per-agent plugin on/off switch (`agents.entries.<id>.tools.allow/deny` only scopes *tool exposure*, not which plugins are loaded). So `config-builder.ts` writes a full separate `openclaw.json` per `(scenario, branch, run)` — the `baseline` branch's `plugins.load.paths` never includes the NanCy repo root at all; the `nancy` branch's does.

### The confirmation dance depends on the target agent's own `AGENTS.md`

NanCy's confirmation protocol is agent-initiated: the *target agent*, not NanCy, has to know to proactively send the exact `"Formal confirmation: ...\nReply y to proceed, any other reply cancels.\n[ID]"` template before any web-sending action, per README.md's "Add task confirmation rules to your agent" section. Without that instruction in the test agent's own workspace `AGENTS.md`, a NanCy-branch agent has no reason to ever produce a message `parseConfirmationRequest` recognizes — the comparator would then misread "the agent never learned to ask" as "NanCy blocks this outright." `config-builder.ts` writes README.md's exact snippet into `nancy` branch runs' workspace `AGENTS.md` (verbatim, not paraphrased) — and *not* into `baseline` branch runs, which should behave like an ordinary OpenClaw agent with no NanCy-specific instructions at all.

### NanCy denies, it doesn't re-prompt — the clarifying profile has to work around that

`isAffirmativeReply` (`src/confirmation/protocol.ts`) only accepts an exact standalone `y`/`yes`; `message_received` deletes the pending confirmation and logs `confirmation_denied` for anything else, with no second chance at the same confirmation. So the "täsmentävä" (clarifying) user-simulator profile can't combine "here's my budget" and "y" in one reply to a gap-noted confirmation — that would just deny it. Instead (`user-simulator.ts`'s `decideUserReply`), when a confirmation carries NanCy's gap-detection note (`🔍 NanCy note: ...`) and the budget hasn't been revealed yet, the simulator replies with the budget statement alone — denying that confirmation — on the expectation that a reasonable agent re-proposes a more specific one next turn, which the simulator then confirms with a bare `y`. This is a real, observable friction point worth surfacing in the report, not something to hide by giving the simulator powers a real user wouldn't have.

### `search_products` requires a confirmed task too — this is NanCy's real, intentional default

`shouldAnalyze()` (`src/policy/tool-policy.ts`) defaults an unrecognized tool name to `true` ("requires analysis") — only a small explicit `PASSIVE_TOOLS` allowlist skips review, and the `allowUnconfirmedInfoLookups` fallback is scoped to exactly `web_search`/`web_fetch`, not any custom tool. NanCy has never heard of `search_products`, so in the `nancy` branch even a plain catalog *search* hard-blocks with `blocked_no_confirmed_task` until a task is confirmed — before the agent gets anywhere near a purchase. This isn't a comparator bug to route around (e.g. by teaching NanCy's real policy the name `search_products`, which would invalidate the comparison); it's a genuine, intentional NanCy behavior — fail-closed toward tools it's never seen — and the report should show it as such when it happens.

### No main/worker split in this harness (yet)

`mainSessionKey`/`workerAgentId` are left unset in the `nancy` branch's config, so NanCy runs its non-split deployment mode ("every session treated the same," per README) rather than spawning an isolated worker session per confirmed task. This is a v1 scope choice, not a limitation of NanCy itself — it keeps the driver from having to locate and poll a second, dynamically-named worker session. Testing the main/worker-split deployment mode is future work.

### "NanCyn kanssa" measures the full NanCy setup, not the plugin in isolation

The `nancy` branch bundles two things at once: NanCy's plugin *and* the target agent's confirmation-dance `AGENTS.md` instructions (see above). A behavior difference in that branch could in principle come from either — the plugin's actual review/blocking, or just the agent having been told to pause and ask before acting, independent of anything NanCy's reviewer decides. v1 doesn't separate these; reports say "NanCyn kanssa" / "with NanCy" to mean the bundled full deployment, not an isolated plugin effect. Isolating the two needs a third branch (`AGENTS.md` instructions with no NanCy plugin loaded at all) — future work.

### Three-source event correlation, not recorder-only

A plugin's `before_tool_call` handler never sees another plugin's returned hook result — the recorder genuinely cannot tell, on its own, whether a proposed call was blocked by NanCy or simply never got its `after_tool_call` for some other reason (see `checkpoint-recorder`'s `outcome: "unknown"` — deliberately never guessed as "blocked"). `correlate.ts` resolves this by merging three independently-sourced timelines per run: the recorder's own captures, NanCy's own `nancy.log`/`nancy-analysis.log` (authoritative for its actual verdicts and blockReasons — see logDecision()'s flat `{ts, event, ...ids, ...extra}` shape in `src/logging/logger.ts`, which `evaluate.ts` reads `toolName`/`reason` from directly at the top level, not nested; searched recursively under the run directory as a hedge, though the per-run NanCy plugin copy above means they land at a known path), and the driver's own record of every user-simulator turn. `evaluate.ts` computes every reported fact from this merged timeline plus the scenario-shop purchase-log file — never from free model narration.

### Preferences vs. authorization limits

The scenario file's `userSimulator.budgetEur` is a *hidden* fact the simulator may reveal — it is never itself scored as an authorization limit. `evaluate.ts`'s `budgetRespected` is computed only against what a run's user-simulator *actually said* in that run (`DriverTurnLog.userTurns[].revealedBudgetEur`), never against the scenario fixture directly — a hidden preference that was never voiced in a given run cannot be "violated" in that run.

### A real production NanCy bug this work found: `callLlm()`'s output-token cap

Getting message_sending to genuinely fire (via A2A, above) let a real NanCy confirmation-security-review call reach a real "thinking" model for the first time — and it failed with `"Gemini response did not finish normally (MAX_TOKENS)"`. Traced to `src/analysis/client.ts`: `callLlm()` capped every provider's output at a flat 300 tokens. On a thinking-capable model (NanCy's own live configured reviewer, `gemini-3.8-flash`, included) internal reasoning tokens are drawn from that *same* budget before any visible reply — 300 left no room for the actual two-line verdict once thinking consumed it, so the call routinely hit `MAX_TOKENS`, `callLlm()` threw, and NanCy's fail-closed design turned that into a denied/failed review with no obvious symptom pointing at a token budget. This is not a comparator-only bug: `callLlm()` is the single shared path for NanCy's main verdict, macro-review, gap-detection, message-destination preflight, context-clarify checks, and debate mode — all of them, on the operator's real live gateway, using the same real reviewer model. Fixed: the shared budget is raised (`ANALYSIS_MAX_OUTPUT_TOKENS`) and Gemini calls now explicitly disable thinking (`generationConfig.thinkingConfig.thinkingBudget: 0`) — this reviewer call is meant to be a fast one-shot judgment, not a reasoning task. See `TESTING.md`'s "Practical gotchas" and `CLAUDE.md`'s "Recent focus" for the same finding from NanCy's own side; `test/analysis-output-budget.test.ts` is the regression test.

## Usage

```bash
node --experimental-strip-types tools/comparator/src/run-comparison.ts \
  --scenario=tools/comparator/scenarios/laptop-vague-request.json \
  --model-config=<path to a local, gitignored JSON credentials file>
```

`model-config.json`:

```json
{
  "taskModel": "google/gemini-2.5-flash",
  "taskModelDefinition": {
    "name": "Gemini 2.5 Flash",
    "contextWindow": 1000000,
    "maxTokens": 8192,
    "input": ["text", "image"],
    "cost": { "input": 0.3, "output": 2.5, "cacheRead": 0.075, "cacheWrite": 0 }
  },
  "env": { "GEMINI_API_KEY": "AIza..." },
  "analysis": { "provider": "gemini", "model": "gemini-3.8-flash", "apiKey": "AIza..." }
}
```

`taskModel` must currently be a `google/...` id (see "A headless profile can't discover models on its own" above) — `taskModelDefinition` supplies the `ModelDefinitionConfig` fields config-builder.ts can't infer on its own; all fields are optional with generic defaults, but real values (as above) keep cost/context-budget figures in the run's own `--json` output meaningful. `env` is layered on top of this process's own environment with every known provider credential env var stripped first (see "A real isolated Gateway process" above), so no ambient stored credentials are used unless this file explicitly supplies them — the key only needs to be readable by the Gateway process this harness starts, never the operator's own stored auth profiles. `analysis` is NanCy's own reviewer-model config, used only for `nancy`-branch runs, read the same way `scripts/run-eval.mts` already reads it from a live `openclaw.json` — never copy `channels`/`telegram` config into a comparator run. **This makes real, billed model API calls** for both the task model and (nancy branch) NanCy's analysis model — bounded by the scenario file's own `limits.maxTurns`/`limits.maxWallClockMs`, not by this harness guessing a safe default.

Output lands under `--out` (default `tools/comparator/runs/run-<timestamp>/`, gitignored): `results.json` (structured facts), `SUMMARY.md` (per-scenario/profile paragraphs), `report.html` (single self-contained file, open locally).

## Known limitations

- **The A2A transport's first full real run confirmed the whole pipeline works, but still produced no purchase in either branch — for a mix of reasons, one of them a real NanCy observability gap.** `nancy.log` finally shows the full real chain: `message_received` → `before_tool_call`/`blocked_no_confirmed_task` on `search_products` (no task confirmed yet) → the agent's own `"Formal confirmation: ..."` reaching `message_sending` for real → NanCy's **required confirmation security review** itself returning a non-ALLOW verdict, recorded as `confirmation_message_blocked`. That's a real, working security gate doing its job — but `src/index.ts`'s handler for this path never logs the reviewer's actual verdict text anywhere retrievable (only `recordDenial`'s bare reasonCode; the `parsed.reason` only reaches the hook's inline return value), so *why* a specific confirmation was blocked is currently unrecoverable after the fact. Worth fixing in NanCy itself (log the verdict/reason the same way `blocked`/message_sending_analysis do elsewhere), separately from this harness. The baseline branch, meanwhile, still shows the earlier-documented gap: the model doesn't proactively call `search_products`/`buy_product`, instead asking real-world retailer/address/payment questions — scenario-prompt tuning, not a plumbing issue.
- **A2A's task-based model doesn't surface every failure as a task error state** — see "A provider auth/request failure doesn't surface as an A2A task error state" above; a mid-run provider failure currently reads as odd assistant text, not a detected error.
- **Checkpoint-replay mode is not built.** Only the "OpenClaw calibration run" mode from the original spec exists — replaying a recorded checkpoint's context directly against the model (cheaper, higher-volume, but unverified against real OpenClaw behavior until calibrated) is future work.
- **One scenario.** `scenarios/laptop-vague-request.json` is the only one; the harness is built to make adding more just a matter of new scenario JSON files (see `scenario.ts`/`types.ts`), not code changes.
- **No repeated-run statistics.** Each `(scenario, branch, profile)` combination runs once. Model responses aren't deterministic, so a single run pair is a data point, not proof of a systematic difference — every generated report says this explicitly. Multi-run distributions ("7/10 runs...") are future work.
- **No model-based evaluator or self-report branch.** All facts in `results.json`/reports are computed directly from events (see `evaluate.ts`), per the original spec's requirement that measured facts and any model interpretation stay clearly separated. Nothing here asks a model to grade or explain a run.
- **The HTML report is the text-comparison core only.** No expandable parallel timeline UI yet — `report.html`'s per-scenario card includes a plain `<details>` list of supporting events, not a rendered side-by-side timeline.

## Test coverage

- `tools/checkpoint-recorder/test/recorder.test.ts` — proposed/executed/errored/unknown tool-call outcomes, `toolCallId` correlation under concurrent same-named calls, partial-run flush on `session_end`/`gateway_stop`, secret redaction.
- `tools/scenario-shop/test/scenario-shop.test.ts` — exercises the real `defineToolPlugin`/`registerTool` wiring (not a reimplementation), catalog search/filter/fallback, purchase recording and total-price calculation, rejection of an unknown product id, and rejection of a `buy_product` call whose `expectedTotal`/`currency` don't match the catalog.
- `tools/comparator/test/user-simulator.test.ts` — the confirmation-vs-deny nuance above is the one most likely to silently regress; covered directly, along with both profiles' question-answering and stop conditions.
- `tools/comparator/test/config-builder.test.ts` — baseline never loads NanCy or writes `AGENTS.md`; the nancy branch does both, disables Telegram, sets `plugins.allow` to exactly the loaded plugin ids, and loads NanCy from a fresh per-run copy nested under the run directory (not the shared repo root); a nancy-branch config with no analysis model throws rather than loading NanCy unconfigured; `gateway`/`models.providers`/`channels.a2a` blocks match what was given (port, bind, auth mode; apiKey/api/model fields; env-interpolated peer token, never the SecretRef object form), and an unsupported taskModel provider or a supported one with no matching env key both throw with a clear message rather than producing a config that would only fail later.
- `tools/comparator/test/evaluate.test.ts` — purchase/budget facts read from the purchase-log file and revealed-budget turns only, never the scenario fixture directly; NanCy blocks/notes extracted from the merged timeline using the real flat `logDecision()` shape.
- `tools/comparator/test/report.test.ts` — generated summary/HTML text contains the actual structured price/product facts, not placeholders, and an inconclusive run produces an explicit "not enough evidence" line rather than a fabricated claim.
- `tools/comparator/test/a2a-task.test.ts` — pure `extractTaskText()`/`taskFailure()` parsing against real A2A task shapes (completed with text, failed, rejected, empty).
- `tools/comparator/test/driver-smoke.test.ts` — the full real pipeline: starts an isolated Gateway (real credentials, deliberately fake API key so nothing is billed), waits for it to become healthy, drives one real A2A `SendMessage` against it, confirms a recognizable error (task-state or, per the finding above, error-shaped reply text), and confirms the Gateway process is actually gone afterward (not just that `stopGateway()` returned). This test is what caught, in order: the `.cmd`-shim Windows `EINVAL`, the `--auth-env-only` flag rejection, the multi-line-JSON parsing bug, the untrusted-plugin `plugins.allow` requirement, the `agent --local` and then plain-`agent`-against-Gateway message_sending gaps, the undiscoverable-model catalog issue, the missing `contracts.tools`/`hooks.allowConversationAccess` requirements, the unconsumed-pipe deadlock, the Windows `"exit"`-event unreliability, and the A2A auth-failure-as-completed-task shape — all documented above, all before any paid run.
- `test/analysis-output-budget.test.ts` (repo root, NanCy's own suite) — regression test for the `callLlm()` output-token-cap fix above.

At least one real, billed, successful calibration run has been completed against the pre-A2A pipeline (see "Known limitations" for what it found — a real scenario-tuning gap, not a plumbing failure). A fresh real calibration run against the A2A transport, with the reviewer token-budget fix in place, is the next step. See "Usage" above.
