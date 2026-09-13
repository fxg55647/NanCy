# Denial Escalation and Clarification Architecture

Status: **Parts A and B are implemented with runtime-scoped counters. Part C is a design proposal and is not implemented.** The current user-visible behavior remains the one described in `README.md`.

## Why this exists

NanCy currently evaluates individual consequential actions and periodically reviews a session's recent behavior. A reviewer verdict of `BLOCK` or `CLARIFY` stops that one action, while a macro-review may terminate the session. There is no deterministic upper bound on how many rejected actions a session may attempt, and a worker cannot pause mid-run to ask the operator a question and then safely resume.

The proposed change has three independent parts:

1. a deterministic ceiling for security denials — **implemented**;
2. an earlier macro-review when denials arrive in a burst — **implemented**; and
3. an optional clarification workflow for confirmed worker tasks — **design only**.

Parts 1 and 2 do not depend on clarification mode. Clarification mode must not be enabled until continuation correlation and duplicate-side-effect handling satisfy the requirements below.

## Current behavior

- Both `before_tool_call` and `message_sending` block a terminated session before further review.
- A `CLARIFY` verdict is treated as `BLOCK`; there is no mid-task dialogue with a worker.
- Periodic macro-review remains an LLM judgment, but an independent runtime counter terminates a session after the configured number of classified security denials.
- Session counters and termination flags are held in memory and cleared by `session_end` or a gateway restart.
- Confirmed workers are autonomous runs. The main chat does not have a live conversational connection to a worker while it runs.

## Safety invariants

The design must preserve these rules:

1. A stopped or clarification-suspended session cannot execute tools or send outbound messages.
2. Test-mode blocks and infrastructure failures never count as evidence of hostile worker behavior.
3. A model cannot reset a denial count, issue a clarification ticket, choose its retry depth, or claim that an unrelated task is a continuation.
4. A clarification never authorizes an action. It ends the current worker run; a revised task requires a new explicit user confirmation.
5. A continuation cannot repeat an irreversible or externally visible action that the earlier run already completed.
6. Macro-review concurrency cannot create two simultaneous reviews for one session or silently lose a required follow-up review.
7. Main-session state is never stopped because a worker session requested clarification.

## Session stop states

Security termination and clarification suspension have different meanings and must remain distinguishable even if both use the same enforcement check.

| State | Meaning | Tools | Outbound messages | Can continue |
|---|---|---:|---:|---|
| `active` | Normal session | gated normally | gated normally | yes |
| `needs_clarification` | A confirmed worker hit an eligible `CLARIFY` verdict | blocked | blocked | only as a newly confirmed worker task |
| `security_terminated` | Deterministic limit or macro-review ended the session | blocked | blocked | no; a fresh task/session is required |
| `completed` | Worker finished | authorization revoked | blocked | no |

A generic boolean such as `terminatedSessions` may remain the final enforcement mechanism, but a separate trusted reason value must drive logging, reports, cleanup, and continuation rules.

## Part A: deterministic denial ceiling

Introduce one denial recorder used by every return path that blocks a tool or cancels a message. Each call records a stable `reasonCode` and a `securitySignal` boolean. Existing decision events may remain for compatibility; the denial event supplies the normalized classification and counters.

Two counters are maintained per exact session key:

- `securityDenialsTotal`: all security denials during the defined lifetime;
- `securityDenialsBurst`: security denials since the last burst-triggered review.

When `securityDenialsTotal` reaches `limits.hardTerminateThreshold` (default `20`), trusted code marks that exact session `security_terminated`. The action that reaches the limit remains blocked. NanCy writes a `hard_terminated` event and sends one non-debounced termination alert when alerts are enabled. Later attempts from the stopped session are blocked without incrementing the counters again.

### Denial classification

The implementation must enumerate every denial path. New denial paths must choose a class explicitly rather than inheriting a default.

Count as security signals:

- semantic reviewer `BLOCK`;
- semantic reviewer `CLARIFY`, including one converted into a clarification request;
- destination or browser-context rejection;
- a protected control-plane write, except the separately classified routine `tasks/` bookkeeping mistake;
- a state-changing call from the main session or a cron-triggered run;
- a worker tool call or outbound message with no live task authorization;
- a domain-policy rejection; and
- an outbound message rejected by the cron or task-authorization gate.

Do not count as security signals:

- any `testMode` dry-run block;
- missing reviewer configuration;
- reviewer, browser-snapshot, reputation-service, or other infrastructure failure;
- an attempt from an already stopped session;
- the unconfirmed-info-lookup quota being exhausted; and
- an agent attempting routine task-file bookkeeping under `tasks/` after it has correctly emitted a confirmation request.

The last exception remains logged. If later evidence shows that task-file writes are useful attack signals, their classification can change without altering the counter mechanism.

### Counter lifetime and restart behavior

Calling a counter “lifetime” is misleading if a gateway restart clears it. The first implementation must choose and document one of these semantics:

- **runtime-scoped:** rename it accordingly and accept that restart resets it; or
- **durable:** store counters and stop reasons atomically in a NanCy-owned, write-protected state file.

The durable form is the target security behavior. It needs bounded retention, atomic replacement, schema versioning, and pruning after task expiry. Until that exists, documentation and logs must say “runtime denial count,” not imply a restart-resistant guarantee.

## Part B: denial-burst macro-review

`macroReview.blockBurstThreshold` (default `3`) requests a macro-review when the burst counter reaches the threshold. The deterministic hard ceiling is checked first and does not depend on the macro-review result.

Only one macro-review may run for a session at a time. A second request arriving during a review must set one pending-review flag. When the running review finishes, one new review uses the latest bounded history and clears that flag. This coalesces a burst without running concurrent reviewers or discarding the fact that another threshold was reached.

After a burst review is accepted for execution:

- reset the burst counter;
- reset the normal call counter; and
- draw/store the next periodic threshold using the configured fixed or random cadence.

The total denial counter is never reset by macro-review. A macro-review may still terminate sooner when it sees a clear sustained pattern.

## Part C: optional clarification mode

Clarification mode is requested as part of the task confirmation and is allowed only when both of these are true:

- `limits.clarifyMode.allowed` is enabled by the operator; and
- the user confirms a request containing `Clarify mode: on`.

Omitting the line means `off`, preserving the current protocol. `BLOCK` never becomes interactive. Only a semantic `CLARIFY` verdict for an actively authorized worker is eligible. Direct, main, cron, unconfirmed-fallback, expired, and unauthorized sessions continue to fail closed without creating a clarification ticket.

When an eligible `CLARIFY` occurs, NanCy must synchronously:

1. block the current action;
2. mark the exact task `needs_clarification`;
3. suspend the exact worker session before it can call another tool or send a message;
4. revoke its task authorization;
5. create a random, one-use NanCy-owned clarification ticket;
6. log only bounded structured context and the reviewer's reason; and
7. notify the operator through the configured out-of-band channel.

The worker is not resumed. After cleanup, any continuation runs in a new disposable worker session with a new task ID and a fresh user confirmation.

### Correlating the continuation

A map containing only “the next confirmation in the main session” is unsafe. It can attach an unrelated new task to the wrong root, cannot represent two workers awaiting clarification at once, and can be reset by expiry or overwritten by a later ticket.

NanCy therefore issues an opaque ticket ID and stores this trusted record:

```ts
{
  ticketId,
  rootTaskId,
  priorTaskId,
  depth,
  issuedAt,
  expiresAt,
  mainSessionKey,
  clarificationReason,
  completedEffects
}
```

A revised confirmation may contain an optional line:

```text
Clarification ticket: <ticketId>
```

NanCy accepts it as a continuation only when the ticket exists, is unexpired, belongs to the same main session, and has not been consumed. The user then confirms the entire revised task in the normal `y`/`yes` exchange. The ticket line is a reference, not authority: the task description and user's reply still define the new authorization.

A confirmation without a ticket is a new root task. It must not consume, inherit, or overwrite any active clarification ticket. This permits an operator to start unrelated work while another task is waiting. Multiple live tickets may coexist.

The ticket is consumed only after a valid affirmative reply and successful durable creation of the new task record. A denied, malformed, mismatched, or failed confirmation does not silently consume it. Expired tickets are rejected and pruned.

### Retry depth

The root task begins at depth `0`. Each accepted clarification continuation increments depth. When a task already has `clarifyDepth >= maxRetryDepth`, another `CLARIFY` is handled as an ordinary fail-closed denial: no new ticket is issued and the worker is stopped. A new unrelated task may still be confirmed normally.

The agent never supplies `rootTaskId` or `clarifyDepth`; NanCy derives both from the validated ticket.

### Completed side effects

A fresh worker can otherwise repeat work completed before clarification, such as sending a message, placing an order, or creating an appointment. Clarification mode must not ship for externally visible actions until NanCy can give the continuation a trusted record of completed effects.

At minimum, every successfully completed consequential action needs a stable operation fingerprint and outcome recorded after `after_tool_call` or confirmed message delivery. A continuation receives this ledger as read-only authorization context and is told which effects must not be repeated. Where the destination supports an idempotency key, the root task ID should derive that key. If completion is uncertain, the continuation must verify state with a passive read or ask the operator rather than repeat the action.

This ledger is a release condition for general clarification mode, not an optional later improvement.

## Configuration proposal

Deterministic limits stay outside the reviewer connection settings:

```json
{
  "limits": {
    "hardTerminateThreshold": 20,
    "clarifyMode": {
      "allowed": false,
      "maxRetryDepth": 2,
      "ticketTtlMinutes": 60
    }
  },
  "macroReview": {
    "blockBurstThreshold": 3
  }
}
```

Clarification mode defaults off until its full release conditions are implemented. Numeric values must be finite positive integers in runtime normalization as well as in `openclaw.plugin.json`; callers cannot be trusted to have passed schema validation.

## Required audit events

- `denial_recorded`: reason code, security classification, total count, burst count;
- `hard_terminated`: session, triggering reason code, total count;
- `macro_review_started`, `macro_review_coalesced`, `macro_review_completed`;
- `clarification_requested`: ticket ID, root/prior task IDs, depth, bounded reason;
- `clarification_ticket_rejected`, `clarification_ticket_expired`, `clarification_ticket_consumed`;
- `task_needs_clarification`; and
- `session_blocked_after_stop`: stop kind, without increasing counters.

Raw hostile payloads must not be copied into denial events, tickets, alerts, or macro-review history. Existing bounded metadata extraction remains the source for behavioral review.

## Minimum test matrix

Part A:

- the twentieth counted denial terminates only that session;
- tool calls and outbound messages are both blocked after termination;
- `testMode`, infrastructure failures, quota exhaustion, and post-termination attempts do not increment counters;
- counters cannot cross between two simultaneous workers;
- runtime or durable restart semantics match the documented choice.

Part B:

- three counted denials request an early macro-review;
- a concurrent request is coalesced and causes exactly one later review;
- burst review resets burst/cadence counters but not the total counter;
- a reviewer that always says `ok` cannot prevent the hard ceiling.

Part C:

- clarification mode is off by default and requires explicit confirmed opt-in;
- eligible `CLARIFY` blocks the current action, suspends only its worker, revokes authorization, and prevents later tools and messages;
- `BLOCK` never creates a ticket;
- two simultaneous clarification tickets remain independent;
- an unrelated confirmation without a ticket remains a new root task;
- a wrong, expired, reused, or cross-session ticket is rejected;
- retry depth is derived only from NanCy state and capped deterministically;
- a continuation cannot repeat a recorded completed effect; and
- failure to persist a ticket/task/effect record fails closed before a worker is spawned.

## Rollout order

1. Normalize denial events and add the stop check to both outbound paths.
2. Add the deterministic runtime ceiling, tests, and accurate documentation.
3. Add macro-review serialization/coalescing and burst triggering.
4. Add durable trusted state if the limit is to survive gateway restarts.
5. Add ticketed continuation parsing and state transitions behind a default-off flag.
6. Add the completed-effects ledger and idempotency behavior.
7. Enable clarification mode only after adversarial, concurrency, restart, and duplicate-effect tests pass.
