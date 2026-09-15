# Behavior Comparator

Status: **v1, one scenario, calibration-run mode only**. This is the design record for `tools/checkpoint-recorder/`, `tools/scenario-shop/`, and `tools/comparator/` — read it before extending any of them, so later changes stay consistent with the decisions below instead of silently drifting from them. None of this is part of NanCy itself; it's a dev-only instrument that runs *alongside* NanCy (or without it) to observe the difference.

## Why this exists

NanCy's own test suite (`test/*.test.ts`, `scripts/run-eval.mts`) proves NanCy's verdict logic works, by calling `handlers.before_tool_call(...)` directly with hand-picked params. It has never proven what a *real* OpenClaw agent, running a real agentic loop against a real model, actually does differently because NanCy is or isn't in the loop — whether it asks a clarifying question it wouldn't otherwise ask, whether a vague request turns into a cheaper or more scoped purchase, or whether NanCy just adds friction with no visible effect on the outcome. The comparator runs the same ambiguous or precise shopping task twice — once with a bare OpenClaw agent, once with NanCy loaded — against a fully simulated shop (no real network, no real purchase), and reports what actually differed, per run, traceable to real events.

## Pieces

- **`tools/checkpoint-recorder/`** — a passive OpenClaw plugin (built first, independent of the comparator) that captures the full model context (`llm_input`: systemPrompt/prompt/historyMessages/tools) and every tool call's proposed params (`before_tool_call`) and, when it actually ran, its result (`after_tool_call`), correlated by `toolCallId`. It never returns a hook result, so it can never block, alter, or authorize anything.
- **`tools/scenario-shop/`** — a fully local OpenClaw plugin providing `search_products`/`buy_product` tools, backed by a per-run JSON catalog and purchase-log file. No network calls anywhere in it.
- **`tools/comparator/`** — the driver: builds an isolated OpenClaw profile per run, spawns the real `openclaw` CLI turn by turn, runs a user-simulator, and produces the report.

## Key decisions, and what grounds them

### `openclaw agent --local --session-key`, not `agent exec`

`openclaw agent exec` ("Run one isolated headless embedded agent turn") looks like the obvious fit, but it's always a fresh `randomUUID()` session in a throwaway temp state dir, deleted after the call (`node_modules/openclaw/dist/agent-exec-*.mjs`) — there is no way to continue a conversation across two `agent exec` calls. The comparator needs a real multi-turn conversation (the user-simulator answering a clarifying question, then NanCy's own confirmation dance), so it uses plain `openclaw agent --local --agent test-agent --session-key <key> --message "<text>" --json` instead, repeated with the same `--session-key`. This resolves against a real disk-backed session store (`plugin-sdk/session-store-runtime`), so two separate CLI invocations genuinely continue one conversation — the same pattern `TESTING.md`'s "Option B" already documents for driving NanCy's confirmation dance.

`--auth-env-only` is required to avoid a false sense of isolation: `--isolated` alone still resolves the *ambient* stored auth-profile store for credentials (verified against `agent-exec-*.mjs`'s `resolveExecBaseConfig`); only `--auth-env-only` plus explicitly-injected env vars guarantees no real stored operator credentials leak into a comparator run. `driver.ts` sets `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` directly on the spawned child's env, per run — the same mechanism `--profile <name>` uses under the hood, but fully under this harness's control (a disposable temp dir, never `~/.openclaw*`).

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

### Three-source event correlation, not recorder-only

A plugin's `before_tool_call` handler never sees another plugin's returned hook result — the recorder genuinely cannot tell, on its own, whether a proposed call was blocked by NanCy or simply never got its `after_tool_call` for some other reason (see `checkpoint-recorder`'s `outcome: "unknown"` — deliberately never guessed as "blocked"). `correlate.ts` resolves this by merging three independently-sourced timelines per run: the recorder's own captures, NanCy's own `nancy.log`/`nancy-analysis.log` (authoritative for its actual verdicts and blockReasons — searched recursively under the run directory, since this harness has not empirically confirmed exactly where OpenClaw resolves `api.rootDir` under an isolated `OPENCLAW_STATE_DIR`), and the driver's own record of every user-simulator turn. `evaluate.ts` computes every reported fact from this merged timeline plus the scenario-shop purchase-log file — never from free model narration.

### Preferences vs. authorization limits

The scenario file's `userSimulator.budgetEur` is a *hidden* fact the simulator may reveal — it is never itself scored as an authorization limit. `evaluate.ts`'s `budgetRespected` is computed only against what a run's user-simulator *actually said* in that run (`DriverTurnLog.userTurns[].revealedBudgetEur`), never against the scenario fixture directly — a hidden preference that was never voiced in a given run cannot be "violated" in that run.

## Usage

```bash
node --experimental-strip-types tools/comparator/src/run-comparison.ts \
  --scenario=tools/comparator/scenarios/laptop-vague-request.json \
  --model-config=<path to a local, gitignored JSON credentials file>
```

`model-config.json`:

```json
{
  "taskModel": "openai/gpt-4.1-mini",
  "env": { "OPENAI_API_KEY": "sk-..." },
  "analysis": { "provider": "openai", "model": "gpt-4.1-mini", "apiKey": "sk-..." }
}
```

`env` is injected verbatim into each spawned `openclaw` child process (paired with `--auth-env-only`, so no ambient stored credentials are used). `analysis` is NanCy's own reviewer-model config, used only for `nancy`-branch runs, read the same way `scripts/run-eval.mts` already reads it from a live `openclaw.json` — never copy `channels`/`telegram` config into a comparator run. **This makes real, billed model API calls** for both the task model and (nancy branch) NanCy's analysis model — bounded by the scenario file's own `limits.maxTurns`/`limits.maxWallClockMs`, not by this harness guessing a safe default.

Output lands under `--out` (default `tools/comparator/runs/run-<timestamp>/`, gitignored): `results.json` (structured facts), `SUMMARY.md` (per-scenario/profile paragraphs), `report.html` (single self-contained file, open locally).

## Known limitations

- **Not yet empirically run against a real model.** Every module here typechecks and has unit coverage for its pure logic (user-simulator decisions, config shape, event evaluation, report text), but `driver.ts`'s actual CLI-spawning path — the one part that can't be unit tested without spending real API budget — has not had a real smoke run yet. The most likely thing to need adjustment on first real run: `driver.ts`'s `extractAssistantText()`, which parses the `--json` envelope. That shape is confirmed for `agent exec` specifically (`classifyAgentExecResult` in `agent-exec-*.mjs`: `{ok, status, final, payloads: [{text,...}], ...}`); plain `agent --json` (used here, for session continuity) was not independently confirmed to share it. `extractAssistantText()` is the single place to fix if it differs.
- **Checkpoint-replay mode is not built.** Only the "OpenClaw calibration run" mode from the original spec exists — replaying a recorded checkpoint's context directly against the model (cheaper, higher-volume, but unverified against real OpenClaw behavior until calibrated) is future work.
- **One scenario.** `scenarios/laptop-vague-request.json` is the only one; the harness is built to make adding more just a matter of new scenario JSON files (see `scenario.ts`/`types.ts`), not code changes.
- **No repeated-run statistics.** Each `(scenario, branch, profile)` combination runs once. Model responses aren't deterministic, so a single run pair is a data point, not proof of a systematic difference — every generated report says this explicitly. Multi-run distributions ("7/10 runs...") are future work.
- **No model-based evaluator or self-report branch.** All facts in `results.json`/reports are computed directly from events (see `evaluate.ts`), per the original spec's requirement that measured facts and any model interpretation stay clearly separated. Nothing here asks a model to grade or explain a run.
- **The HTML report is the text-comparison core only.** No expandable parallel timeline UI yet — `report.html`'s per-scenario card includes a plain `<details>` list of supporting events, not a rendered side-by-side timeline.

## Test coverage

- `tools/checkpoint-recorder/test/recorder.test.ts` — proposed/executed/errored/unknown tool-call outcomes, `toolCallId` correlation under concurrent same-named calls, partial-run flush on `session_end`/`gateway_stop`, secret redaction.
- `tools/scenario-shop/test/scenario-shop.test.ts` — exercises the real `defineToolPlugin`/`registerTool` wiring (not a reimplementation), catalog search/filter/fallback, purchase recording and total-price calculation, rejection of an unknown product id.
- `tools/comparator/test/user-simulator.test.ts` — the confirmation-vs-deny nuance above is the one most likely to silently regress; covered directly, along with both profiles' question-answering and stop conditions.
- `tools/comparator/test/config-builder.test.ts` — baseline never loads NanCy or writes `AGENTS.md`; the nancy branch does both and disables Telegram; a nancy-branch config with no analysis model throws rather than loading NanCy unconfigured.
- `tools/comparator/test/evaluate.test.ts` — purchase/budget facts read from the purchase-log file and revealed-budget turns only, never the scenario fixture directly; NanCy blocks/notes extracted from the merged timeline.
- `tools/comparator/test/report.test.ts` — generated summary/HTML text contains the actual structured price/product facts, not placeholders, and an inconclusive run produces an explicit "not enough evidence" line rather than a fabricated claim.

`driver.ts` itself (the real `openclaw` CLI spawning) is integration-only — exercising it requires real model credentials and spends real API budget, so it is deliberately not part of the unit-test suite. See "Usage" above.
