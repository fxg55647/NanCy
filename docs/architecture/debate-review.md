# Debate-Style Triple-Pass Review

Status: **experimental implementation; off by default**. The historical proposal below records the rationale and alternatives. The implementation decisions in the next section supersede the open wording below. Improved real-model safety has not yet been established.

## Implemented behavior

Set `analysis.debateMode` to `off` (default), `always`, `clarify`, or `hybrid`. `src/analysis/debate.ts` wraps only full tool/message reviews; deterministic gates, metadata preflights, browser pre-checks, gap detection and macro-review retain their existing paths.

- `always`: two concurrent advocates followed by one judge.
- `clarify`: one ordinary full review; only a valid CLARIFY escalates once. BLOCK never escalates.
- `hybrid`: messages and every tool except exact `web_search`/`web_fetch` names go directly to debate. Those two use the CLARIFY route. This deliberately broad routing covers shell, generic browser and unknown tools without trusting their arguments. It does not distinguish sensitive from ordinary outgoing messages, and cannot catch confidently wrong ALLOWs on the two lookup tools.
- All passes use the same immutable prompt snapshot, including the original action and available context. The judge also receives both bounded advocate analyses as explicitly untrusted data. All passes use the configured reviewer provider/model.
- Advocates must return JSON with a nonempty `analysis` string (maximum 4,000 characters); responses over 6,000 characters are rejected. Final verdicts require the complete two-line format. Provider output caps are 300 tokens per call; at most four calls run. Input cost still depends on the existing full-review snapshot size, so this is not a total monetary budget.
- A 60-second shared full-review deadline aborts pending requests; the existing 30-second per-request timeout still applies. Preflight time is outside this deadline.
- Every enabled mode fails closed on full-review exceptions, missing/malformed outputs and timeouts, including outbound messages. Single-pass mode (`off`) retains its previous behavior. Final CLARIFY blocks. One final denial is recorded per action; review infrastructure failures are not security-denial signals.
- `debate_review` log entries report routing, attempted call count, elapsed time and failed stage. Provider usage and actual cost are not yet exposed by the shared client.

Deterministic tests cover routing, independent advocates, context delivery, escalation, malformed responses, deadline cancellation, gate precedence and outbound test-mode/failure cancellation. Real-provider comparative evaluation remains outstanding; do not infer a safety improvement from these wiring tests.

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

Proposal: the JUDGE pass should receive the mandatory baseline, operator policy, confirmed task (or the existing restricted info-lookup baseline), exact action/tool parameters or outbound message, and the same bounded page/history context used for full review **directly**, alongside both arguments. Policy and task alone are insufficient: without the action and relevant evidence, the judge cannot independently identify what the advocates missed. Build one bounded review snapshot and use it consistently across all three passes, preserving the existing content-minimization rules.

This additional context also exposes the judge to potentially injected content; it is not an injection defense by itself. Treat both advocates' outputs as untrusted analysis, never as instructions or authority. Bound their lengths and ask for evidence references and explicit missing information. Neither advocate should invent evidence just to make its assigned case; "no supported case found" must be a valid response.

### CLARIFY doesn't map cleanly onto "for vs. against"

Leima's judge only ever produces a verdict on a two-sided question (supports/contradicts). NanCy's judge needs a third option for genuine ambiguity. Proposed rule: ALLOW requires clear task authorization and compliance with both policies; a demonstrated policy violation requires BLOCK even if the FOR case is persuasive. Use CLARIFY when authorization or relevant facts remain unclear. Argument strength alone must never determine authorization. A final CLARIFY still blocks the action under the current enforcement model.

### Activation options

Three designs to compare before implementation; none is approved yet:

- **A. Applies to every full review when enabled** — simple and predictable, with three LLM calls replacing one full-review call. Existing preflights remain unchanged, so this does not triple every call in the complete pipeline. FOR and AGAINST can run concurrently, followed by JUDGE: two sequential stages, not necessarily three times the latency. Token cost depends on context and output sizes, especially the judge's additional arguments.
- **B. Escalation only**: run the normal single pass first; only invoke the FOR/AGAINST/JUDGE sequence when the single pass itself returns CLARIFY (i.e., use debate mode as a structured "second opinion" for cases the model itself flagged as uncertain, rather than tripling cost on the large majority of calls that are unambiguous). This is cheaper and arguably better-targeted (debate has the most value exactly where a single pass hedges), but changes CLARIFY's current meaning ("fails closed, blocked") into "triggers one more expensive check first" — a behavior change beyond just adding an option, and worth deciding deliberately rather than as an implementation detail.

- **C. Risk-based hybrid (review recommendation, pending evaluation)**: route high-consequence actions directly to debate, and use single-pass review for the rest with one optional CLARIFY escalation. Candidate categories include purchases, destructive operations, permission changes, and external transmission of sensitive data. Define routing in trusted code using tool/destination metadata and operator configuration; do not let the worker label its own action low-risk. Unknown or insufficient metadata needs an explicit conservative routing rule. The exact categories and thresholds remain open and need bypass tests, including equivalent actions expressed through shell commands or generic browser tools.

B cannot catch a confidently wrong single-pass ALLOW: that result never escalates. C can cover that failure for actions routed to debate, but its routing may still miss consequential actions. All modes remain opt-in pending evaluation. Existing deterministic gates and preflight blocks retain precedence; debate cannot override them.

Under B, an escalated action costs **four calls total**: the initial review plus FOR, AGAINST, and JUDGE. With concurrent advocates, that is three sequential stages. Under C, directly routed actions use three calls and escalated actions use four. Permit at most one escalation per action, with a shared time/token budget rather than an unbounded retry loop.

### Failure behavior (proposal requiring an explicit implementation decision)

Require valid, bounded responses from both advocates and a valid final judge verdict before debate can authorize an action. An exception, timeout, empty response, or malformed result in any required pass must not become ALLOW or silently fall back to the FOR argument. Cancel remaining work when the shared deadline expires. An initial CLARIFY remains blocked if its escalation fails.

For tool calls this preserves the existing fail-closed behavior. Outbound-message analysis currently fails open on exceptions in `src/index.ts`; simply throwing from a new debate helper would therefore allow a message through. Proposed debate-mode behavior is to cancel the reviewed outbound message on any required-pass failure. This is an explicit behavior change to document and test, including its effect on ordinary replies. Whether to change single-pass message failure behavior too is outside this proposal.

Log the selected route, failed stage, final verdict, elapsed time, and usage where available. Count one final security denial per action, not one per advocate; infrastructure failures must retain their existing non-security classification. Preserve test mode's no-execution/no-send guarantees.

## Open questions / risks

- **Cost and latency**: even under design B, this is a real operational cost increase for every CLARIFY case; under design A it multiplies the cost of the entire per-call review pipeline. Needs an explicit decision from whoever operates a given deployment, not a silent default change.
- **Shared blind spots**: if the FOR and AGAINST passes use the *same* model as each other (as opposed to genuinely independent models), correlated failure is still possible — both could be fooled by the same injection, or share the same training-induced bias. Using two different models/providers for FOR vs. AGAINST (mirroring the existing "reviewer should differ from the main agent" recommendation in README) is worth considering, at real added complexity (two provider configs instead of one).
- **Does it actually improve verdict quality for NanCy's specific decision (task/policy alignment), or mainly for Leima's (evidence weighing)?** Untested. Before implementing, this should be validated the same way other reviewer changes in this repo have been — via `scripts/run-eval.mts`'s verdict-variance section (same ambiguous case, run N times, single-pass vs. debate-mode) — to see whether debate mode is measurably more consistent/correct on genuinely hard cases, not just more expensive.

## If/when this gets implemented

Before adopting a mode, compare single-pass, always-debate, and the proposed routing strategies on the same labeled scenarios. Repeated verdict agreement is only a secondary metric: a consistently wrong ALLOW is still a security failure. Measure:

- False ALLOW rates for unauthorized actions and policy violations, and false blocks on authorized actions; report sample counts and uncertainty, not just aggregate accuracy.
- Browser/email prompt injection, malicious instructions carried through an advocate's output, exfiltration to an allowed recipient, and actions that advance the task through forbidden means.
- Confidently wrong single-pass ALLOW cases as well as ambiguous cases, so CLARIFY-only escalation is evaluated against its blind spot.
- Per-action calls, token usage/cost, latency (including tail latency), and timeout/error rates, including unchanged preflights.

Use mocked integration tests for each failed or malformed pass, final CLARIFY handling, routing bypass attempts, deterministic-block precedence, and outbound cancellation on debate errors. Predefine acceptable safety/false-block and cost/latency tradeoffs before judging results. Build an isolated eval prototype first; any claimed reliability improvement remains unverified until these comparisons support it.

Follow the pattern established for gap-detection and denial-escalation: a focused module (e.g. `src/analysis/debate.ts`) with pure prompt-builder/parser functions, unit tests with mocked responses for the parsing/wiring logic, and a dedicated `scripts/run-eval.mts` section comparing single-pass vs. debate-mode verdicts on the same set of genuinely ambiguous scenarios against the real configured model — not just on the easy, unambiguous ones already in `scripts/eval-scenarios.json`.
