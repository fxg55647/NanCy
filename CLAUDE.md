# NanCy SSIL — orientation for agents

OpenClaw plugin. Logic is split across modules under `src/` (see the module map below); `src/index.ts` is now just plugin registration and `api.on(...)` hook wiring, calling into the other modules' factory functions. Read `README.md` for the full feature writeup; this file is just the fast-orientation summary.

## What this is

NanCy is a security guard plugin for the **OpenClaw** autonomous agent runtime (not for Claude Code itself — this repo *builds* NanCy, it doesn't run under it). It intercepts OpenClaw's tool calls and outbound messages, runs a one-shot LLM judgment against a user-confirmed task, and blocks/allows/clarifies based on the verdict. Core idea: "the agent only asks, NanCy decides" — the agent cannot write its own confirmation; NanCy writes per-task audit records and grants authorization in memory to the exact worker session it creates.

Status: early-stage and "research and development only" per README's warning banner. A repository-wide security review was completed on 2026-09-14 and its reproduced findings were corrected, but this is not a production-safety guarantee.

## Architecture (module map — see TODO.md for the full rationale)

- `src/index.ts` — `definePluginEntry({...})`, registers all OpenClaw hooks (`before_tool_call`, message hooks, etc.), wires the factories below together with `api`/`nancyConfig`/log paths.
- `src/config.ts` — `NancyConfig`/`AnalysisConfig`/`DomainConfig` types, secret/model-ref resolution.
- `src/analysis/client.ts` — `callLlm()`, the one-shot analysis call (provider-agnostic: gemini/openai/anthropic/openai-compat), including provider completion-status validation and output caps.
- `src/analysis/verdict.ts` — strict two-line ALLOW/BLOCK/CLARIFY parsing.
- `src/analysis/context.ts` — builds the Intent Anchoring prompt context (confirmed task, recent calls/reasoning, protected-files list).
- `src/analysis/macro-review.ts` — the periodic behavioral review (feature #9), every 10 calls by default; cadence is configurable (`macroReview` in `openclaw.plugin.json`) as fixed or randomized (triangular distribution) via `pickNextMacroReviewInterval()`. Reviews receive bounded call metadata and recent denial reasons, and their result is discarded if the session generation changes while the review is in flight.
- `src/policy/domain-policy.ts` — `checkDomainBorder()` / authenticated URLhaus reputation / RDAP domain-age — Domain Border Control (feature #3), with canonical hostname handling and no clean cache entry for indeterminate reputation results.
- `src/policy/operator-policy.ts` — built-in minimum policy plus fresh loading of the protected root `NANCY-POLICY.md` for every reviewer call.
- `src/policy/protected-paths.ts` — resolves per-agent workspace/protected paths and `protectedWriteTarget()`, including canonical real paths and case-insensitive Windows aliases. Protected and unconditionally blocked for `write`/`edit`: `AGENTS.md`, `IDENTITY.md`, `MEMORY.md`, the whole `nancy/src/` directory (not just `index.ts` — NanCy's logic is split across all of it), `openclaw.plugin.json`, anything under `tasks/`.
- `src/policy/tool-policy.ts` — main/cron default-deny allowlist, browser action classification, and `shouldAnalyze()`. Every `exec` call is reviewed; unknown browser actions and credential-bearing reads fail into review rather than bypassing it.
- `src/policy/denial-policy.ts` — normalized denial classification, runtime-scoped total/burst counters, deterministic termination, and burst-review triggering.
- `src/confirmation/protocol.ts` — `parseConfirmationRequest()` / `isAffirmativeReply()` — intent confirmation flow (feature #2).
- `src/confirmation/gap-detection.ts` — advisory-only LLM check flagging unspecified decision points in a proposed confirmation before the human sees it (feature #2's other half). See `docs/architecture/gap-detection.md`.
- `src/confirmation/tasks.ts` — per-session confirmed-task authorization and pending-confirmation state.
- `src/workers/worker-manager.ts` — spawns/waits-for/cleans-up the isolated worker session per confirmed task.
- `src/notifications/telegram.ts` — Telegram alerting/status pushes, block-alert debounce.
- `src/browser/snapshot.ts` — `fetchBrowserSnapshot()` and snapshot file naming/pruning — DOM Biopsy (feature #5).
- `src/logging/logger.ts` — `logDecision()`, log rotation.
- `src/state.ts` — per-session state: bounded recent call/reasoning/denial ring buffers, cron-trigger correlation, call/denial counters, macro-review serialization, session-generation tokens, termination flags.
- Config schema lives in `openclaw.plugin.json` (`analysis`, `browser`, `domains`, `macroReview`, `limits`, `mainSessionKey`, `mainSessionIdleMinutes`, `workerAgentId`, `telegramAlerts`, `testMode`).

## Feature status (see README §"Key Technical Features" for full detail)

✅ implemented: SSIL one-shot analysis (#1), intent confirmation & gap detection (#2), Domain Border Control (#3), main/worker session split (#7, optional), behavioral review plus deterministic denial termination (#8), permanent operator policy (#9), write-protection for core files (#6).

🧭 not implemented: Contextual Scrambler / dedicated prompt-injection defense (#4).

⚠️ lighter than described: DOM Biopsy (#5) — page-level snapshot only, not element-level HTML parsing.

## Recent focus (see `git log` for detail)

Work has been on the operational/runtime side: cron-triggered runs are gated like the main session, `testMode` dry-runs full tasks with zero real side effects, and Telegram alerting distinguishes operator pages from logged denials. `allowUnconfirmedInfoLookups` (default on) lets `web_search`/`web_fetch` reach the real reviewer with no confirmed task, judged against a fixed generic "harmless info lookup only" baseline; a deterministic fixed one-hour per-session window (`unconfirmedInfoLookupLimitPerHour`) caps those grants. The 2026-09-14 review also made required reviews fail closed, moved every shell command into semantic review, rejected duplicate task IDs, and invalidated in-flight authorization decisions when their session ends or changes generation.

## Logs & runtime artifacts (not source, don't treat as code)

- `nancy.log` — general plugin log
- `nancy-analysis.log` — LLM analysis verdicts
- `snapshots/` — browser DOM snapshots

## Docs map

- `README.md` — full feature list, config, getting-started (includes the `AGENTS.md` snippet NanCy expects the *target* OpenClaw agent to have — that's a different file in a different repo, not this one)
- `SECURITY-PHILOSOPHY.md` — "limit the blast radius" deployment guidance
- `NANCY-POLICY.md` — standing operator restrictions included in every security judgment
- `INCIDENTS.md` — sourced public incidents and scoped counterfactual analysis of where NanCy might help
- `HOW-AGENTS-GO-WRONG.md` — plain-language failure scenarios, the NanCy layers that may reduce each risk, and residual limitations
- `MISCONCEPTIONS.md` — objections/FAQ (collusion, agent talking to NanCy directly, AI-reviewer bias)
- `RELATED-WORK.md` — positioning vs. LlamaFirewall AlignmentCheck, ClawGuard, Google ADK hooks
- `docs/architecture/denial-escalation-and-clarification.md` — implemented denial ceiling/burst-review rules plus the not-yet-implemented ticketed clarification design; includes state transitions, release conditions, and tests
- `docs/architecture/gap-detection.md` — design rationale for the advisory unspecified-decision-point check (feature #2's gap-detection half): prompt design, failure modes, config, and known limitations
- `docs/architecture/policy-precedence.md` — exactly which decision prompts explicitly name a standing-policy violation as its own BLOCK trigger (vs. relying on context alone), and which deliberately don't yet — read before editing any `Use BLOCK when...` sentence in `src/index.ts`
- `docs/architecture/debate-review.md` — experimental optional FOR/AGAINST/JUDGE full review, implemented in `src/analysis/debate.ts`; `analysis.debateMode` defaults to off. Every mode fails closed on full-review errors, including outbound messages. Comparative real-model evaluation remains outstanding.
- `docs/audits/2026-09-14-security-review.md` — repository-wide security review, reproduced findings, corrections, and verification evidence.
- `TESTING.md` — how to test changes: `npm test` (mocked, fast) vs. a standalone harness against the real reviewer model (genuine verdicts, zero live-gateway risk), the confirmed-task file format, and why the live gateway must never be stopped/restarted for testing
- `EVAL-RESULTS.md` — generated report from `scripts/run-eval.mts` (a fixed, hand-written scenario set in `scripts/eval-scenarios.json`, run against the real configured reviewer model via the Option B pattern). Regenerate with `node --experimental-strip-types scripts/run-eval.mts`; re-run whenever `analysis.model` or the policy/analysis modules change, to catch reviewer-behavior regressions.
