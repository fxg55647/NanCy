# Task Confirmation: a menu of response modes (design discussion)

Status: **option 3 (the form) is now implemented, presentationally** — see
[`confirmation-forms.md`](./confirmation-forms.md)'s "v1 implemented" status
line for the actual shape. The menu below is now genuinely presented to the
user (`buildFormAndMenuNote`/`buildFormDataBlock` in
`src/confirmation/forms.ts`) whenever a form is generated. This doc's key
finding held even more strongly than predicted: it turned out **all four**
of options 1, 3, 4, and 5 need zero NanCy code, including the form — a
reply that isn't a literal "y" is simply left as an ordinary denial
(`src/index.ts`'s `message_received`, completely unchanged by this
feature), which flows to the target agent as normal conversation for it to
turn into a fresh confirmation; only the AGENTS.md snippet in README.md was
extended so the agent reacts to that sensibly. (An earlier draft of the
implementation gave option 3 its own structured-submission grant path as a
second way to say "yes" — dropped before shipping, precisely because it
broke the "one rule, every channel" property the other three options keep.)
Option 2 ("always confirm when needed") remains unimplemented, per Part C of
[`denial-escalation-and-clarification.md`](./denial-escalation-and-clarification.md)
— read that doc first for the Clarify Mode design this one builds on.

## The idea

Today's confirmation protocol has exactly one interactive decision: the agent sends a `Formal confirmation: ...`, and the user replies `y` (proceed) or anything else (cancel) — see [README's Task Confirmation section](../../README.md#3-add-task-confirmation-rules-to-your-agent). This works well but is binary: either fully autonomous after one "y," or nothing happens.

The idea explored here: when the agent sends its confirmation, it could present the user with several different response modes rather than a bare y/n, letting the user choose how much oversight they want for this specific task — decided once, at the same point where the task itself is confirmed, not as a separate global setting.

## Proposed options

1. **"Go with your best judgment"** — today's default: one "y," then fully autonomous (see `SECURITY-PHILOSOPHY.md`'s "efficient delegation" principle).
2. **"Always confirm when needed"** — maps directly onto the not-yet-implemented Clarify Mode (Part C of `denial-escalation-and-clarification.md`): every eligible `CLARIFY` verdict during execution pauses and asks, instead of failing closed.
3. **A generated checklist of specific points to confirm** — gap-detection (`src/confirmation/gap-detection.ts`) already computes "this proposal doesn't specify: X, Y, Z" as an advisory note appended to the confirmation. This option turns that same list into something the user picks from item by item rather than a single take-it-or-leave-it note. **This is already a detailed, existing design**: [`confirmation-forms.md`](./confirmation-forms.md) — read that doc, not this bullet, for the real shape (the authorization/specification field-class split, trusted-config option lists, the generation flow, delivery/submission, and open questions). This menu-of-options idea is really just a different entry point into that same form: option 3 on this menu *is* "NanCy generates and sends the form" from that doc, triggered by the user's own choice rather than always happening.
4. **A free-text clarification reply** — the user just writes in prose what they want changed or specified, instead of picking a structured option.
5. **"Go gather information first"** — instead of confirming the full task now, the *first* confirmed task is deliberately narrow ("search the catalog and present a form of matching options"), and a second, separate confirmation follows once real options exist to choose from.

## The key architectural finding

Discussed directly with the user: does NanCy itself need to become an active, tool-calling agent to support option 5 (or any of these)? **No.** NanCy's whole design is "the agent only asks, NanCy decides" — a passive reviewer sitting in front of the target agent's own tool calls, never issuing any of its own. Turning it into something that spawns its own exploratory sub-tasks would be a different architecture entirely, and would remove the property that NanCy itself has no independent agentic capability to misuse.

Instead, option 5 resolves cleanly within the *existing* architecture: the agent's first confirmed task is simply scoped narrowly ("gather info, present a form") rather than broadly ("complete the whole purchase") — confirmed through the exact same y/reply mechanism NanCy already has, no new capability required. The target agent executes its own tool call (e.g. `search_products`) under that narrower authorization, same as always; NanCy reviews it exactly like any other confirmed task. A second confirmation for the actual purchase follows once concrete options exist.

This generalizes: **four of the five options (1, 3, 4, 5) need zero NanCy code changes.** They're all really just different ways the target agent's own conversational logic (its `AGENTS.md` instructions) can shape what goes into a confirmation's description text, and how many separate confirmations a task gets split into — entirely within the existing protocol. Only option 2 ("always confirm when needed") is a genuine NanCy capability gap, requiring Part C's Clarify Mode to actually be built (ticketed continuation, the completed-effects-ledger release condition, etc. — see that doc).

## Simplifying Part C's "completed side effects" concern

A related point raised while discussing Part C's completed-side-effects release condition: it doesn't need to be a complex ledger subsystem. A minimal version:

- After a consequential `after_tool_call` succeeds, append one short record (tool, key params, timestamp) to the confirmed task's own record (alongside the existing `tasks/<id>.json`).
- Feed that small list into the *same* Intent Anchoring prompt context (`src/analysis/context.ts`'s `buildAnalysisContext`) that already gets built for every review — "the following actions were already completed under this task" — letting the existing semantic reviewer catch a repeat the same way it judges everything else, no new deterministic subsystem required.
- Because the semantic reviewer is inherently probabilistic (see `SECURITY-PHILOSOPHY.md`'s "deterministic controls remain necessary"), a cheap deterministic exact-match check (same tool + same key params already recorded as succeeded) is worth adding *in front of* that LLM review specifically for irreversible actions (a purchase, a sent message) — belt-and-suspenders, not a replacement for the semantic check.

## Open questions / not decided here

- Exact UX for presenting a 5-option menu over a plain-text channel (Telegram/A2A have no native form widgets) — likely a numbered list the user replies to by number or free text.
- Whether option 3's per-item checklist needs its own reply-parsing format, or can reuse the free-text path (option 4) with the agent interpreting the reply.
- Interaction between option 5's "narrow first confirmation" and the "state the outcome, not a procedure" guidance now in README's Task Confirmation section (see `docs/architecture/behavior-comparator.md`'s "A NanCy-specific concept briefly leaked..." and "Stop writing unverifiable procedural conditions" findings, tracked in commit `8dc6903`). Option 5 is fine specifically because the split into two confirmations is an explicit user choice realized as two separate real, independently-verifiable confirmations — not one confirmation's description silently promising an unverifiable multi-step condition, which is the thing that fix was about.
