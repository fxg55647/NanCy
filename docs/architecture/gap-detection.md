# Gap Detection

Status: **implemented, advisory only**. This is the design record for the feature — read it before changing `src/confirmation/gap-detection.ts` or its wiring in `index.ts`'s `message_sending` handler, so later changes stay consistent with the invariants below instead of drifting from them silently.

## Why this exists

NanCy's confirmation protocol (`src/confirmation/protocol.ts`, feature #2) decided *who* confirmed a task — it verified the reply was an exact `y`/`yes` from the right session, within the TTL, to the right message. It never looked at *what* was being confirmed. A proposal like "Buy a laptop for the office and have it delivered" is a completely valid, well-formed confirmation request — non-empty, correctly templated — and would be forwarded to the human and granted exactly as written, even though it leaves out a price ceiling, a specific model, a delivery deadline, and who receives it. Whatever the worker decides on those points becomes the *de facto* task scope, without the human ever having been asked.

Gap detection closes that: before a well-formed, non-empty confirmation is sent, NanCy runs one advisory LLM check against the proposed description, looking for concrete decision points that plausibly matter for *this specific task* but were left unspecified. If it finds any, it appends a clearly separate note after the agent's own message, so the human sees them before replying `y` — not after the worker has already decided on its own.

## Non-goal: this is not a security gate

Every other LLM-backed check in this codebase (the per-call reviewer, the destination preflight, the macro-review) can block, cancel, or terminate. Gap detection cannot do any of those things. It is advisory only:

- it never blocks or delays sending the confirmation;
- it never rewrites or removes any part of the agent's own message — it only appends after it;
- any failure (missing `analysis` config, a failed LLM call, a malformed response) is treated as "no gaps found," not as a reason to hold back the confirmation; and
- a detected gap does not count toward the denial-escalation ceiling (`src/policy/denial-policy.ts`) — it isn't hostile behavior, it's the agent doing exactly what it was asked (send a confirmation), just with an under-specified proposal.

The rationale: a probabilistic check that can independently block *sending the one interactive confirmation in the whole system* would be a single point of failure for the entire task-authorization flow. If the gap-detection prompt or model has a bad day, the worst acceptable outcome is "the human doesn't get an extra hint" — never "no task can be confirmed at all."

## How it works

1. `message_sending` fires with the agent's outbound content. `parseConfirmationRequest` identifies it as a confirmation request (feature #2's existing parser) and the description passes the non-empty check.
2. If `(nancyConfig.gapDetection ?? true)` is on and `nancyConfig.analysis` is configured, `buildGapDetectionPrompt(description, policyContext)` builds a one-shot prompt (see `src/confirmation/gap-detection.ts`) asking the model to name up to 5 concrete, task-relevant decision points left unspecified — explicitly told not to invent generic boilerplate concerns irrelevant to this task, and not to flag anything already specified.
3. The model must reply with JSON only: `{"gaps": ["...", ...]}`, empty array if none. `parseGapDetectionResponse` extracts it defensively — non-JSON, the wrong shape, non-string entries, or more than 5 entries all degrade to a safe, truncated, or empty result rather than throwing.
4. If any gaps were found, `appendGapNote` appends a note **after** the agent's original content: `"\n\n🔍 NanCy note: this proposal doesn't specify — <gap1>; <gap2>. Reply y to proceed anyway, or ask for a more specific confirmation first."` The agent's own fixed-template text is never altered — `parseConfirmationRequest` already ran against the *original* content, so the id/description NanCy tracks are unaffected by whatever gets appended for display.
5. The (possibly noted) content becomes what's actually sent: `message_sending` returns `{ content: outgoingContent }` when it differs from the input, or `undefined` (send unchanged) otherwise. **The pending-confirmation record's `rawContent` is set from `outgoingContent`, not the agent's original content** — this is the one detail most likely to regress: `message_sent`/`message_received` correlate a reply against `rawContent`, so if a future change appends the note *after* recording `rawContent` from the original text, delivery-failure detection and reply-threading (see `TESTING.md`/`test/confirmation-send-failure.test.ts`) silently break for every gap-noted confirmation.
6. The confirmation still expires after the same TTL, still requires the same exact `y`/`yes`, still writes the same audit record — gap detection changes what the human *sees*, never the authorization mechanics feature #2 already had.

## Configuration

```json
"gapDetection": true
```

Default `true`. Set to `false` to disable the check entirely (no LLM call, no note, byte-identical to pre-gap-detection behavior). There is no separate rate limit or cost cap — confirmations are rare (one human-facing interaction per task), so one extra LLM call per confirmation is an acceptable, self-limiting cost; if that assumption stops holding (e.g. very high-frequency task confirmation in some deployment), revisit before assuming it's still fine.

## Known limitations

- **It's a judgment call, not a checklist.** There's no way to mechanically verify "did it catch everything relevant" — a thorough model can always find *some* additional detail on almost any real task (confirmed empirically: seen catching that "15-inch ThinkPad X1 Carbon" is internally inconsistent, since that model is normally 14-inch). `scripts/run-eval.mts`'s gap-detection section reports findings descriptively for this reason, not as a pass/fail gate — see its comments for why a naive "vague task should get more gaps than the specific one" count comparison was tried and abandoned as unreliable.
- **It only ever runs once, on the original proposal.** If the agent resends a revised confirmation (a new id, per feature #2's own rule that every attempt needs a fresh confirmation), gap detection runs fresh on that revision too — but nothing tracks whether previously-flagged gaps were actually addressed. A human has to notice that for themselves.
- **The reviewer sees only the description, not the agent's full context.** It can't know about constraints the agent is aware of but didn't write down (e.g. an existing standing budget), so it may flag something the human already considers settled elsewhere. This is intentional scope, not an oversight — teaching it to reason about implicit context would reopen exactly the kind of trust-the-agent's-framing problem Intent Anchoring exists to avoid.
- **No dedicated prompt-injection defense**, same caveat as every other reviewer prompt in this codebase (see README feature #4). The description is quoted as untrusted data in the prompt, per the project's existing pattern, but that's a mitigation, not a guarantee.

## Test coverage

- `test/gap-detection.test.ts` — pure `parseGapDetectionResponse`/`appendGapNote` unit tests (malformed JSON, wrong shape, truncation, no-gaps passthrough), and full `message_sending` integration tests: a vague description gets a note and the noted message still correlates through `message_sent`/`message_received`; a well-specified one is sent unmodified; `gapDetection: false` skips the LLM call entirely; a failed check fails open and the confirmation is still grantable.
- `test/confirmation-lifecycle.test.ts` — the "no analysis configured" fallback (gap detection has nothing to run it with, description sent as-is).
- `scripts/run-eval.mts`'s "Gap detection" section — the same vague-vs-specific comparison against the real configured model, reported descriptively (see Known limitations above).
