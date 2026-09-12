# NanCy SSIL — orientation for agents

OpenClaw plugin. Logic is split across modules under `src/` (see the module map below); `src/index.ts` is now just plugin registration and `api.on(...)` hook wiring, calling into the other modules' factory functions. Read `README.md` for the full feature writeup; this file is just the fast-orientation summary.

## What this is

NanCy is a security guard plugin for the **OpenClaw** autonomous agent runtime (not for Claude Code itself — this repo *builds* NanCy, it doesn't run under it). It intercepts OpenClaw's tool calls and outbound messages, runs a one-shot LLM judgment against a user-confirmed task, and blocks/allows/clarifies based on the verdict. Core idea: "the agent only asks, NanCy decides" — the agent cannot write its own confirmation, NanCy's code is the sole writer of `tasks/current.json`.

Status: early-stage, unaudited, "research and development only" per README's own warning banner. Not for production safety yet.

## Architecture (module map — see TODO.md for the full rationale)

- `src/index.ts` — `definePluginEntry({...})`, registers all OpenClaw hooks (`before_tool_call`, message hooks, etc.), wires the factories below together with `api`/`nancyConfig`/log paths.
- `src/config.ts` — `NancyConfig`/`AnalysisConfig`/`DomainConfig` types, secret/model-ref resolution.
- `src/analysis/client.ts` — `callLlm()`, the one-shot analysis call (provider-agnostic: gemini/openai/anthropic/openai-compat).
- `src/analysis/verdict.ts` — ALLOW/BLOCK/CLARIFY parsing.
- `src/analysis/context.ts` — builds the Intent Anchoring prompt context (confirmed task, recent calls/reasoning, protected-files list).
- `src/analysis/macro-review.ts` — the every-10-calls behavioral review (feature #9).
- `src/policy/domain-policy.ts` — `checkDomainBorder()` / URLhaus reputation / RDAP domain-age — Domain Border Control (feature #3).
- `src/policy/operator-policy.ts` — built-in minimum policy plus fresh loading of the protected root `NANCY-POLICY.md` for every reviewer call.
- `src/policy/protected-paths.ts` — resolves per-agent workspace/protected paths and `protectedWriteTarget()`. Protected and unconditionally blocked for `write`/`edit`: `AGENTS.md`, `IDENTITY.md`, `MEMORY.md`, the whole `nancy/src/` directory (not just `index.ts` — NanCy's logic is split across all of it), `openclaw.plugin.json`, anything under `tasks/`.
- `src/policy/tool-policy.ts` — main/cron default-deny allowlist, browser action classification, `shouldAnalyze()`.
- `src/confirmation/protocol.ts` — `parseConfirmationRequest()` / `isAffirmativeReply()` — intent confirmation flow (feature #2).
- `src/confirmation/tasks.ts` — per-session confirmed-task authorization and pending-confirmation state.
- `src/workers/worker-manager.ts` — spawns/waits-for/cleans-up the isolated worker session per confirmed task.
- `src/notifications/telegram.ts` — Telegram alerting/status pushes, block-alert debounce.
- `src/browser/snapshot.ts` — `fetchBrowserSnapshot()` and snapshot file naming/pruning — DOM Biopsy (feature #5).
- `src/logging/logger.ts` — `logDecision()`, log rotation.
- `src/state.ts` — per-session state: recent call/reasoning ring buffers, cron-trigger correlation, call counters, termination flags.
- Config schema lives in `openclaw.plugin.json` (`analysis`, `browser`, `domains`, `mainSessionKey`, `mainSessionIdleMinutes`, `workerAgentId`, `telegramAlerts`, `testMode`).

## Feature status (see README §"Key Technical Features" for full detail)

✅ implemented: SSIL one-shot analysis (#1), intent confirmation (#2, gap-detection still 🧭), Domain Border Control (#3), main/worker session split (#7, optional), behavioral review + session termination every 10 calls (#8), permanent operator policy (#9), write-protection for core files (#6).

🧭 not implemented: Contextual Scrambler / PIDD integration (#4).

⚠️ lighter than described: DOM Biopsy (#5) — page-level snapshot only, not element-level HTML parsing.

## Recent focus (see `git log` for detail)

Work has been on the operational/runtime side: cron-triggered runs now gated like the main session, a `testMode` for dry-running full tasks with zero real side effects, and tuning Telegram alerting (which block kinds page the operator vs. just log).

## Logs & runtime artifacts (not source, don't treat as code)

- `nancy.log` — general plugin log
- `nancy-analysis.log` — LLM analysis verdicts
- `snapshots/` — browser DOM snapshots

## Docs map

- `README.md` — full feature list, config, getting-started (includes the `AGENTS.md` snippet NanCy expects the *target* OpenClaw agent to have — that's a different file in a different repo, not this one)
- `SECURITY-PHILOSOPHY.md` — "limit the blast radius" deployment guidance
- `NANCY-POLICY.md` — standing operator restrictions included in every security judgment
- `INCIDENTS.md` — sourced public incidents and scoped counterfactual analysis of where NanCy might help
- `MISCONCEPTIONS.md` — objections/FAQ (collusion, agent talking to NanCy directly, AI-reviewer bias)
- `RELATED-WORK.md` — positioning vs. LlamaFirewall AlignmentCheck, ClawGuard, Google ADK hooks
- `TESTING.md` — how to test changes: `npm test` (mocked, fast) vs. a standalone harness against the real reviewer model (genuine verdicts, zero live-gateway risk), the confirmed-task file format, and why the live gateway must never be stopped/restarted for testing
