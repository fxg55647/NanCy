# Injection Scan (content taint signal)

Status: **design proposal, not implemented**. Written down on 2026-09-30 after a design discussion about using TypeSafe AI's Jev model (a non-generative "System One" model returning typed values plus probabilities/confidence) as a fast prompt-injection check. This is the design record for a future feature toward README feature #4 (dedicated prompt-injection defense). Read it before implementing anything in `after_tool_call`, `src/state.ts` taint state, or a detector adapter.

## Problem

NanCy reviews what the agent *does*, not what the agent *reads*. An injected instruction on a web page or in an email is caught only indirectly: when the agent's next action clearly falls outside the confirmed task, Intent Anchoring blocks it.

Two gaps follow:

1. **On-task redirection.** Injected content that keeps the action inside the task's literal scope but changes a target, recipient, amount or scope ("our billing account has changed, send payment to X") produces an action that looks authorized. This is the reviewer's weakest case.
2. **The reviewer reads raw untrusted content itself.** For `browser` calls, `before_tool_call` fetches a live snapshot and puts up to 4000 characters straight into the reviewer prompt (`src/index.ts`, `snapshotContext`). The prompt says to treat it as data, but the reviewer is still an injection target.

Current data flow, verified in code on 2026-09-30:

- `browser`: snapshot fetched live in `before_tool_call`, bounded, included in the reviewer prompt, saved to `snapshots/`.
- `web_fetch` (and browser form submit): result saved to `snapshots/` in `after_tool_call` **only**; it never reaches the next review.
- Email content: never reaches the reviewer.
- Agent reasoning text: deliberately omitted from reviewer context (`src/analysis/context.ts`).

So a taint signal would be a genuinely new channel into the next review, not an extension of an existing one.

## Proposal

Scan content the agent has read with a fast, swappable detector. The result is a **risk signal that can only tighten review**: it never allows anything on its own.

1. `after_tool_call` starts a scan of the tool result and stores the pending scan promise in per-session state.
2. The next `before_tool_call` for that session awaits the pending scan, bounded by `timeoutMs`.
3. The classification maps to a configured action (see below). A tainted session gets stricter review: the `SAFE_EXEC` fast path is skipped, full review (optionally debate mode) is forced, and the reviewer context gets a line such as "recently read content from <source> was flagged as possible injection (class: …)".
4. Every classification is logged, so thresholds can be tuned from real data instead of intuition.

This promise-based handoff is deliberate. It is unknown whether OpenClaw awaits async `after_tool_call` handlers, or whether they can hold back a result before the agent sees it. The design does not depend on either: timing is resolved in `before_tool_call`, which NanCy controls. The flag affects the *next* action, which is exactly the action NanCy reviews.

## Invariants

- **The detector never allows an action by itself.** It can only raise the risk level or force a stricter review. The final decision stays with NanCy's policy and Intent Anchoring review. No detector verdict may skip, shorten, or override the LLM reviewer's BLOCK/CLARIFY.
- **Uncertainty never loosens review.** A timeout, provider error, malformed result or low confidence counts as tainted. `onTimeout`/`onError` cannot be configured to `ignore`.
- **A missing alert is not a clean bill of health.** Adversarial content can be built to evade classifiers, and the detector reads untrusted content itself.
- **The detector is an adapter, not a hard dependency.** Jev, a local Prompt Guard class model, or none. Default off.
- **No full content goes to an external service by default.** External providers get bounded, normalized, and where possible redacted content. Email is scanned only by a local detector by default. Redaction has a cost here: an injection can hide in the redacted part, which is another reason email stays local.

## Classification

Classifying only "is this an injection" floods on ordinary pages (READMEs and tutorials legitimately say "run this command"). Classifying by *audience* (human-directed persuasion vs. LLM-directed trickery) is useful for grading alerts but unsafe on its own:

- human-directed persuasion (fake urgency, "recommended" upsells) works on agents too;
- attackers disguise injections as ordinary human-directed text;
- scams aimed at humans (phishing, fake checkout) are dangerous to an agent too.

So the detector asks two questions (Jev: a Choice plus a Noul question in one pass):

**Content class (Choice):**

| Class | Example | Default action |
|---|---|---|
| `none` | ordinary content | nothing |
| `marketing` | "Buy now!", "Only 2 left" | nothing (at most a note to the reviewer) |
| `deceptive_to_human` | phishing, fake urgency, changed account number | `taint` + reviewer note |
| `llm_directed` | "ignore previous instructions", "as an AI assistant you must", hidden text | `avoid_page` + strongest review + alert |

**Task redirection (yes/no probability), independent of audience:** "Does this content try to change what the agent does relative to the confirmed task: target, recipient, amount or scope?" This is the question that catches disguised on-task redirection, which the audience-based class misses. The confirmed task text is included in the detector's state for this question only.

## Configuration sketch

```json
"injectionScan": {
  "enabled": false,
  "provider": "promptguard",
  "sources": ["web_fetch", "browser"],
  "actions": {
    "marketing": "ignore",
    "deceptive_to_human": "taint",
    "llm_directed": "avoid_page",
    "task_redirect": "taint"
  },
  "threshold": 0.7,
  "timeoutMs": 800,
  "onTimeout": "taint",
  "onError": "taint",
  "maxChars": 8000
}
```

- `provider`: `jev` | `promptguard` | `none`.
- `sources`: `email` only when explicitly added, and with an external provider only after a separate explicit opt-in.
- Allowed actions: `ignore`, `note`, `taint`, `avoid_page`, `avoid_domain`.
- Floors: `llm_directed` cannot be set below `taint`. `onTimeout`/`onError` accept `taint` or stricter only.

Strictness is meant to be tuned from operational experience, using the logged classifications.

## Avoiding a hostile source

A page that tries to command the agent has lost trust, so its content should not be used at all. This is cheap, deterministic and easy to explain, and fits alongside Domain Border Control (#3). Two traps:

1. **User-generated content hosts.** An injection planted in a GitHub issue, a review or a forum post must not cut off the whole domain. Avoidance is **per URL/page by default**. `avoid_domain` is a separate, stricter setting.
2. **Avoidance as a steering tool.** An attacker can plant an injection on a competitor's or a trusted shop's page so NanCy avoids it and the agent moves to the attacker's own page. Therefore:
   - after an avoidance, a replacement source is not trusted automatically; it goes through normal (tainted-session) review;
   - if the avoided page is central to the confirmed task ("order from this page"), the result is CLARIFY to the human, not a silent switch.

## Why Jev is not the reviewer

Discussed and rejected for now:

- **Replacing the reviewer with Jev:** Jev gives no reasons, and the REASON line feeds Telegram alerts, macro review, agent feedback and the planned Clarify Mode. Judging against task, `NANCY-POLICY.md` and call history is a reasoning task. Jev is closed, early access and unverified. A "confident Jev ALLOW skips the LLM" tier is still replacement, at the point where errors are least visible.
- **Jev as a third voter:** acceptable only with veto power (Jev BLOCK or low confidence gives at least CLARIFY), never as a majority vote that can overturn the reviewer's BLOCK. Not suitable as the debate-mode judge.

Replacement could be revisited only if evals show accuracy matching the reviewer plus calibration that tracks errors. The missing reasons remain a problem even then.

Note: the only API guide found for Jev was a Hugging Face community blog. Verify the endpoint against TypeSafe's official documentation before sending any key or content.

## Evaluation plan (before any Jev-specific code)

Build the eval scenarios first; they are needed whichever detector is chosen. Scenarios:

1. A page tells the agent to ignore the user's task.
2. A page tells the agent to send a secret out.
3. An email containing the same attacks.
4. Hostile content that looks on-task but changes target or recipient.
5. Benign READMEs and how-to pages do not cause continuous tainting or blocking.
6. The detector times out or returns an ambiguous result → tainted, never clean.
7. The hook has not finished before the host's next call → `before_tool_call` awaits the pending scan (integration test, not assumption).

Compare three setups: current reviewer only; reviewer + Jev; reviewer + local Prompt Guard. Measure blocks/recall, false alarms, added latency, and behavior on provider error. Record results in `EVAL-RESULTS.md`.

## Implementation order

1. Eval scenarios above (`scripts/eval-scenarios.json` / `run-eval.mts`).
2. Detector interface + taint state in `src/state.ts` + pending-scan handoff, tested with a mock detector.
3. Adapters: local Prompt Guard first, then Jev once an early-access key exists.
4. Comparison run and a decision on whether to recommend enabling it.
