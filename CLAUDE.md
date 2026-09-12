# NanCy SSIL — orientation for agents

Single-file OpenClaw plugin. All logic lives in `src/index.ts` (~75KB, one file — no other source files). Read `README.md` for the full feature writeup; this file is just the fast-orientation summary.

## What this is

NanCy is a security guard plugin for the **OpenClaw** autonomous agent runtime (not for Claude Code itself — this repo *builds* NanCy, it doesn't run under it). It intercepts OpenClaw's tool calls and outbound messages, runs a one-shot LLM judgment against a user-confirmed task, and blocks/allows/clarifies based on the verdict. Core idea: "the agent only asks, NanCy decides" — the agent cannot write its own confirmation, NanCy's code is the sole writer of `tasks/current.json`.

Status: early-stage, unaudited, "research and development only" per README's own warning banner. Not for production safety yet.

## Architecture (all in `src/index.ts`)

- `definePluginEntry({...})` at the bottom wires up the OpenClaw hooks (`before_tool_call`, message hooks, etc.)
- `callLlm()` — the one-shot analysis call (provider-agnostic: gemini/openai/anthropic/openai-compat)
- `checkDomainBorder()` / `checkUrlhausReputation()` / `checkDomainAgeDays()` — Domain Border Control (feature #3)
- `parseConfirmationRequest()` / `isAffirmativeReply()` — intent confirmation flow (feature #2)
- `fetchBrowserSnapshot()` — DOM Biopsy context for browser actions (feature #5)
- Protected paths are hardcoded and unconditionally blocked for `write`/`edit`: `AGENTS.md`, `IDENTITY.md`, `MEMORY.md`, `src/index.ts`, `openclaw.plugin.json`, anything under `tasks/`.
- Config schema lives in `openclaw.plugin.json` (`analysis`, `browser`, `domains`, `mainSessionKey`, `mainSessionIdleMinutes`, `workerAgentId`, `telegramAlerts`, `testMode`).

## Feature status (see README §"Key Technical Features" for full detail)

✅ implemented: SSIL one-shot analysis (#1), intent confirmation (#2, gap-detection still 🧭), Domain Border Control (#3), stated-reasoning context (#7), main/worker session split (#8, optional), behavioral review + session termination every 10 calls (#9), write-protection for core files (#6).

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
- `MISCONCEPTIONS.md` — objections/FAQ (collusion, agent talking to NanCy directly, AI-reviewer bias)
- `RELATED-WORK.md` — positioning vs. LlamaFirewall AlignmentCheck, ClawGuard, Google ADK hooks
- `TESTING.md` — how to test changes: `npm test` (mocked, fast) vs. a standalone harness against the real reviewer model (genuine verdicts, zero live-gateway risk), the confirmed-task file format, and why the live gateway must never be stopped/restarted for testing
