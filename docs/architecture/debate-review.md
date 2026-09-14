# Debate-Style Triple-Pass Review

Status: **design proposal; not implemented**. This document records the idea and its open questions before any code changes are made, following the same convention as `docs/architecture/denial-escalation-and-clarification.md`. Current behavior remains the single-pass analysis described in README feature #1.

## Origin

This is not a new idea invented for NanCy — it's already implemented and running in a sibling project, `fxg55647/leima` (`neutral_witness.py`), for a different problem (evaluating whether a document supports or contradicts a factual claim). Leima's pattern:

1. **Support analyst** (`p1`, stateless): "Identify what in the document supports the claim... Do not consider contradictions or gaps."
2. **Refutation analyst** (`p2`, stateless): "Identify what in the document contradicts the claim... Do not consider supporting evidence."
3. **Judge** (`_synthesis_prompt`): receives *only the text of both analyses* (not the original document), weighs which had stronger evidence, and delivers the final verdict. Explicitly told to discount a refutation that's technically true but doesn't actually address the claim, and told a clear verdict beats a hedge.

Three passes, two of them deliberately one-sided and blind to the other's concern, one synthesis. `PASS_LABELS = ["Supporting evidence", "Contradicting evidence", "Verdict"]`.

## Why this might be worth adapting for NanCy

NanCy's current per-call analysis (`before_tool_call`'s full-analysis prompt, `message_sending`'s analysis prompt) is a single LLM call asked to weigh everything at once — the confirmed task, the standing policy, the action — and produce ALLOW/BLOCK/CLARIFY in one pass. A single pass can anchor on whichever consideration it reads or weighs first, and there's no structural pressure to seriously consider the *other* side before answering. Splitting the "does this fit" and "does this not fit" question into two independent, blind passes — each instructed to ignore the opposing concern — forces both cases to actually get made, before anything synthesizes them. This is a form of self-consistency / structured debate, a known technique for making a single model's judgment more reliable at the cost of more inference.

## Proposed design (open, not decided)

### Where it would apply

Only the per-call decision prompts that produce a final ALLOW/BLOCK/CLARIFY verdict on real content — `before_tool_call`'s full analysis and `message_sending`'s analysis. **Not** proposed for:

- **Gap detection** (`src/confirmation/gap-detection.ts`) — already advisory-only; there's no "for/against" framing that makes sense for "what's missing."
- **Destination preflight** (`metadataPreflightPrompt`) — deliberately cheap and metadata-only by design; tripling its cost defeats its purpose (avoid full review when unnecessary).
- **Browser context-only pre-check** — narrow single question ("does this page belong to the task"), not really a for/against question.
- **Macro-review** — pattern-level judgment over history, not a single action's verdict.

### The three prompts

1. **FOR pass** (stateless): given the confirmed task, standing policy, and the action, argue why it plausibly matches the task and complies with policy. Instructed not to raise objections.
2. **AGAINST pass** (stateless, independent of the FOR pass — not shown its output): argue why the action might not be authorized — task mismatch, policy violation, injection/exfiltration shape. Instructed not to concede points in the action's favor.
3. **JUDGE pass**: receives both arguments and decides ALLOW / BLOCK / CLARIFY.

### A deliberate departure from Leima's judge: give it the raw context too

Leima's judge sees *only* the two analyses, trusting its analysts completely — reasonable for document fact-checking, where the risk of a bad outcome is a wrong verdict on a claim. NanCy's stakes are different: the FOR and AGAINST passes both read the same potentially-adversarial content (a fetched page, tool output, an injected instruction). A prompt injection good enough to fool one pass could plausibly fool both consistently, and a judge that only ever sees their words would have no independent way to notice.

Proposal: the JUDGE pass should receive the policy context and confirmed task **directly**, not just secondhand through the two arguments — so it can independently flag a policy violation even if both advocates missed it. This is the opposite of Leima's design and should be treated as the default unless a reason emerges to match Leima exactly.

### CLARIFY doesn't map cleanly onto "for vs. against"

Leima's judge only ever produces a verdict on a two-sided question (supports/contradicts). NanCy's judge needs a third option — genuine ambiguity, not just "the against case was weaker." Likely resolution: instruct the judge that CLARIFY is for cases where *neither* side's argument is clearly stronger, or where the action is plausible but not clearly covered by the confirmed task — matching the existing single-pass CLARIFY criterion, just decided by the judge instead of a single undivided pass.

### Activation: always-on-when-enabled, or only as an escalation?

Two designs, both worth weighing before implementation, not yet decided:

- **A. Config flag, applies to every analyzed call when on** (e.g. `analysis.debateMode: boolean`, default `false`) — matches this project's existing pattern (`gapDetection`, `allowUnconfirmedInfoLookups`) of an opt-in whole-session behavior. Simple, predictable, but **3x the LLM calls and latency for every single analyzed tool call/message**, not just rare ones — a much bigger cost multiplier than gap-detection's "once per confirmed task."
- **B. Escalation only**: run the normal single pass first; only invoke the FOR/AGAINST/JUDGE sequence when the single pass itself returns CLARIFY (i.e., use debate mode as a structured "second opinion" for cases the model itself flagged as uncertain, rather than tripling cost on the large majority of calls that are unambiguous). This is cheaper and arguably better-targeted (debate has the most value exactly where a single pass hedges), but changes CLARIFY's current meaning ("fails closed, blocked") into "triggers one more expensive check first" — a behavior change beyond just adding an option, and worth deciding deliberately rather than as an implementation detail.

No recommendation is fixed here yet — this needs a decision before implementation, not during it.

## Open questions / risks

- **Cost and latency**: even under design B, this is a real operational cost increase for every CLARIFY case; under design A it multiplies the cost of the entire per-call review pipeline. Needs an explicit decision from whoever operates a given deployment, not a silent default change.
- **Shared blind spots**: if the FOR and AGAINST passes use the *same* model as each other (as opposed to genuinely independent models), correlated failure is still possible — both could be fooled by the same injection, or share the same training-induced bias. Using two different models/providers for FOR vs. AGAINST (mirroring the existing "reviewer should differ from the main agent" recommendation in README) is worth considering, at real added complexity (two provider configs instead of one).
- **Does it actually improve verdict quality for NanCy's specific decision (task/policy alignment), or mainly for Leima's (evidence weighing)?** Untested. Before implementing, this should be validated the same way other reviewer changes in this repo have been — via `scripts/run-eval.mts`'s verdict-variance section (same ambiguous case, run N times, single-pass vs. debate-mode) — to see whether debate mode is measurably more consistent/correct on genuinely hard cases, not just more expensive.

## If/when this gets implemented

Follow the pattern established for gap-detection and denial-escalation: a focused module (e.g. `src/analysis/debate.ts`) with pure prompt-builder/parser functions, unit tests with mocked responses for the parsing/wiring logic, and a dedicated `scripts/run-eval.mts` section comparing single-pass vs. debate-mode verdicts on the same set of genuinely ambiguous scenarios against the real configured model — not just on the easy, unambiguous ones already in `scripts/eval-scenarios.json`.
