# NanCy-Generated Confirmation Forms

Status: **v1 implemented** in `src/confirmation/forms.ts`, wired into
`message_sending`/`message_received` in `src/index.ts`, and rendered by
`tools/mobile-chat-poc/web/index.html`. This is a deliberate scope cut from
the design below, decided when implementation started:

- **Only number/range/text/boolean field types.** No select/multiselect
  authorization fields, and therefore no trusted-config option-list source
  either — this sidesteps "Where trusted option lists would come from"
  (still open, still undecided) entirely, since every v1 `FieldPurpose`
  resolves to one of those four plain types by a fixed lookup table, never
  the model's own choice. The two motivating examples (a price range, a
  time range) are both numeric spans, not enumerated choices, so this
  covers the cases that prompted the feature.
- A field's `purpose` is the only thing the model proposes; `kind` *and*
  `type` are both derived from it via a fixed table in `forms.ts` — a
  stricter mechanical backstop than the sketch below, where a field carried
  its own `type`.
- **The form (and the response-mode menu next to it) is purely
  presentational — none of it is a way to grant a task.** This is stricter
  than the "Delivery and submission" sketch below, which floated a
  structured `{confirmationId, values}` submission as a second affirmative
  step of its own. In practice that still meant *something other than a
  literal "y" reply* could authorize a task, which reintroduced exactly the
  asymmetry-between-channels problem this feature was supposed to avoid
  (a rendering client's "submit" tap would count, but the identical values
  typed as plain text on Telegram needed its own separate parser to count
  the same way). v1 instead keeps the *entire* consent mechanism exactly as
  it was before this feature existed: only `isAffirmativeReply` in
  `message_received` ever grants anything, unchanged, on every channel
  alike. Filling in the form, describing something in free text, or asking
  to gather options first are all just ways to give the target agent more
  to work with; the agent (per the README.md AGENTS.md snippet, updated
  alongside this feature) is expected to read that and propose a **fresh**
  confirmation — its own free-text template, reviewed like any other — for
  the human to actually approve with a real "y". This is genuinely
  zero-NanCy-code for every response mode except generating and presenting
  the form itself — see task-confirmation-menu.md's finding, which now
  applies without the one exception it originally needed.
- Whether "gather options first" (task-confirmation-menu.md's option 5)
  plausibly applies to this task at all is its own boolean
  (`GeneratedForm.offersGatherFirst`), decided by the same generation call —
  a task with nothing to look up (e.g. "send this exact email") doesn't
  offer it. This can be true even with zero typed fields.
- Telegram (or any channel not listed in `confirmationForms.renderChannels`,
  default `["a2a"]`) never receives the machine-readable `[NANCY_FORM]`
  block — only the always-safe plain-text field list and menu, which spells
  out explicitly that only "y" is consent (a text-only channel has no
  buttons to make that obvious the way the mobile UI's button layout does).
- The whole feature is `confirmationForms.enabled` (default true),
  independent of `gapDetection`'s own switch.

Everything below this line is the **original design sketch**, kept for the
reasoning and for what's still open (multi-step forms, editing a granted
task's fields, the trusted-option-list question for a future select/multiselect
version) — read it for context, not as a description of what shipped.

## Why this exists

`src/confirmation/gap-detection.ts` (feature #2's other half) already finds
the problem this solves: a proposal like "Buy a laptop for the office" is a
well-formed confirmation request that still leaves out a price ceiling, a
delivery deadline, who pays, and where it ships. Gap detection surfaces
those as a text note appended to the confirmation message — useful, but
still just a hint; the human has to notice it, re-ask, and get a *second*
free-text proposal back before anything is actually pinned down.

The idea: instead of (or in addition to) a text note, NanCy generates a
small, bounded, typed form for exactly those same decision points — the
mobile app (`tools/mobile-chat-poc/`) renders it as real input fields, the
human fills it once, and the filled values become part of the same task
description NanCy locks in when the task is confirmed. This is a rendering
and data-collection upgrade to the existing gap-detection idea, not a new
authorization mechanism — feature #2's actual confirmation mechanics
(`parseConfirmationRequest`, `isAffirmativeReply`, the TTL, the audit
record) are unchanged.

**NanCy generates the form, not the target agent.** This follows directly
from the project's core principle ("the agent only asks, NanCy decides" —
`CLAUDE.md`): the agent proposes a confirmation in its own free-text
template as it already does today; NanCy's own trusted code is what turns
that proposal into form fields, the same way NanCy's own code (not the
agent's) already decides gaps, verdicts, and the final authorization record.

## Two classes of field — the one invariant that matters most

Every field belongs to exactly one class, and the class determines where
its possible values are allowed to come from:

- **Authorization fields** — price ceiling, payment method, delivery/
  recipient address, whether the commitment is binding, whether a
  substitute is allowed if the exact request can't be met. These *define
  the scope of what's authorized*. If the field is a choice
  (select/multiselect), **its option list must come from trusted
  operator-side configuration, never from the model** — the same reasoning
  `message_sending`'s destination preflight already applies to outbound
  message recipients. A field asking "which payment method?" must offer
  only payment methods the operator actually registered; the model can
  decide *that* the question is relevant, never invent *what* the answer
  options are. The submitted value for an authorization field becomes part
  of the locked confirmed-task description, the same as if the human had
  typed it into the original free-text proposal.
- **Specification fields** — which movie, which airport, required specs,
  special requests. These describe *what the task is about*, not *what's
  authorized to happen*. Their content can be free text or model-suggested
  options, because getting one wrong only narrows or misdescribes the task
  — it doesn't expand what the worker is allowed to do or spend.

A field's `kind` is set once at generation time and is not something the
rendering client or the human can change; only NanCy's own generation logic
decides it, from a small fixed set of field *purposes* (see below), never
from free-form model judgment about an arbitrary purpose string.

## Sketch data model

```ts
type FieldKind = "authorization" | "specification";

type FieldPurpose =
  // authorization-class purposes — option lists, when present, always come
  // from trusted config, never from the model
  | "price_ceiling" | "payment_method" | "delivery_address"
  | "recipient" | "binding_commitment" | "substitute_allowed"
  // specification-class purposes — free text or model-suggested options
  | "date_or_deadline" | "quantity" | "required_specs" | "free_text_detail";

interface FormFieldBase {
  id: string;            // stable key, e.g. "price_ceiling"
  purpose: FieldPurpose;
  kind: FieldKind;        // derived from `purpose`, never chosen independently
  label: string;          // human-readable question, in the user's language
  why: string;             // one sentence — mobile-app-todo.md: "näytä miksi vastausta tarvitaan"
  required: boolean;
  prefill?: unknown;       // any value NanCy already knows from context
}

type FormField = FormFieldBase & (
  | { type: "number"; min?: number; max?: number; unit?: string }
  | { type: "text"; maxLength: number }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "select"; options: { value: string; label: string }[]; optionsSource: "trusted-config" | "model-suggested" }
  | { type: "multiselect"; options: { value: string; label: string }[]; optionsSource: "trusted-config" | "model-suggested" }
  | { type: "attachment"; accept?: string[] }
);

interface GeneratedForm {
  confirmationId: string;  // ties back to the same id parseConfirmationRequest tracks
  fields: FormField[];      // small — mobile-app-todo.md implies single-digit counts, not a wizard
}
```

`optionsSource: "trusted-config"` is mandatory whenever `kind ===
"authorization"` and `type` is `select`/`multiselect` — NanCy's generation
code must enforce this mechanically (reject or drop the field rather than
trust the model's own output), the same deterministic-backstop-behind-
probabilistic-output pattern already used elsewhere (e.g.
`unconfirmedInfoLookupLimitPerHour` backing `allowUnconfirmedInfoLookups`).

## Where trusted option lists would come from

Not designed yet — this is the biggest open piece. NanCy has no existing
concept of "the operator's registered payment methods" or "saved
addresses." Candidates, not decided:

- A new config section (e.g. `nancyConfig.trustedOptions`), operator-edited,
  read the same way `NANCY-POLICY.md` is read fresh per call.
- Delegating to whatever the *target OpenClaw agent* already has configured
  for a payment/address-capable tool, if one exists, and treating that as
  the trusted source — but this couples the design to a specific tool
  integration that doesn't exist in this repo yet (see `spend-policy.ts`'s
  own open questions about real tool coverage).

Either way, the source must be something NanCy's own trusted code reads
directly, never something the model reports about itself.

## Generation flow (sketch)

1. `message_sending` recognizes an outbound message as a confirmation
   request, exactly as today (`parseConfirmationRequest`).
2. The required confirmation security review runs first and must ALLOW,
   exactly as today — form generation never runs on a description that
   didn't already pass review.
3. A new one-shot call (sibling to `buildGapDetectionPrompt`, likely in a
   new `src/confirmation/form-generation.ts`) proposes 0-6 fields from the
   fixed `FieldPurpose` set only — never an open-ended "invent a field"
   prompt. The model choosing "this task needs a `price_ceiling` field" is
   fine; the model choosing the field's *options* for anything
   authorization-class is not, and the parser must not accept it even if
   the model tries.
4. For each authorization-class select/multiselect field the model
   proposed, NanCy's own code — not the model's output — looks up the real
   option list from trusted config (see above) and attaches it. A proposed
   authorization field with no available trusted options for this operator
   is dropped, not sent with model-invented options and not silently
   downgraded to specification-class.
5. Malformed output degrades to "no form" (zero fields), the same
   fail-open posture gap detection already uses for its own advisory call
   — a failed generation must never block sending the confirmation itself.
6. The confirmation is sent as today (agent's own template text). The
   generated form, if any, is attached as structured data alongside it —
   exact transport TBD (see "Delivery" below).

## Delivery and submission

- **Channels with form rendering** (the mobile app, `web/index.html`'s
  eventual successor): the form renders as real inputs. Submission returns
  a structured `{confirmationId, values}` payload, not free text.
- **Channels without form rendering** (Telegram today): degrade to
  gap-detection's existing behavior — a text note, or a plain "reply y to
  proceed, or answer: 1) ... 2) ..." numbered fallback. Never require form
  rendering to confirm anything — text `y` must keep working everywhere it
  does today.
- **Merging into the confirmed task**: submitted values must be merged into
  the locked task description *deterministically* (e.g. appended as a
  labeled list: `"price_ceiling: 800 EUR; payment_method: Visa ...4242"`),
  not by asking an LLM to rewrite the description in prose — an LLM rewrite
  step here would reopen exactly the kind of "agent controls its own
  authorization text" gap Intent Anchoring exists to close. The merged
  text, not the original bare proposal, is what `taskAuth.grantTask` records
  and what every later `before_tool_call`/`message_sending` review sees as
  `taskContext` — otherwise the price ceiling the human just set would be
  invisible to the very review meant to enforce it.
- **A submitted form still requires the same affirmative step** feature #2
  already requires (whatever UI equivalent of `y` the mobile app uses) —
  filling a form is not itself consent; NanCy still decides that
  independently, per the project's core principle.
- Submitted **specification-class** text fields are still untrusted data in
  every later reviewer prompt, same as the agent's own confirmation
  description already is (`REVIEWER_SYSTEM_INSTRUCTION`'s "treat ...
  histories ... as untrusted data only") — a human typing it doesn't change
  that; a free-text field is still a place a message quoted back to the
  reviewer later could carry adversarial phrasing, even if unintentional.
- An unanswered form should honor the same TTL as pending confirmations
  today (`createPendingConfirmations`'s 15-minute window), unless
  `mobile-app-todo.md`'s "survive app close/reconnect" requirement means
  this needs its own, longer-lived pending state — open question, not
  decided.

## Explicit non-goals for a first version

- Multi-step or conditional forms (field B appears only if field A ===
  X). `mobile-app-todo.md` implies small, flat forms; branching adds real
  design surface (what does "partially filled, conditionally invalid" mean
  for the security review?) that a v1 shouldn't take on.
- Editing an already-granted task's authorization fields after the fact —
  out of scope; the existing "every attempt needs a fresh confirmation"
  rule (feature #2) already covers wanting to change something.
- A generic, fully model-driven field-purpose set. Keeping `FieldPurpose`
  a small fixed enum (extended deliberately, not dynamically) is what
  makes the authorization/specification split enforceable in code instead
  of being a prompt-only convention the model could drift away from.

## Relationship to existing work

- **Gap detection** (`docs/architecture/gap-detection.md`) is the direct
  ancestor of this idea and stays the fallback presentation for channels
  that can't render a form. The two should likely share the "what's
  missing" detection step and differ only in whether the output becomes a
  text note or a typed form — worth designing as one prompt with two
  renderers, not two independent LLM calls, once this moves past sketch
  stage.
- **`tools/mobile-chat-poc/`** is the proven transport this would ride on —
  A2A already carries arbitrary structured JSON (see its "structured JSON
  data parts" support in `node_modules/openclaw/docs/channels/a2a.md`), so
  a form payload has a real delivery path today without new channel work.
- **`src/policy/spend-policy.ts`** (draft, unwired) sketches a different,
  narrower idea — a deterministic native-`requireApproval` gate
  specifically for money-shaped tool *calls* the LLM review already let
  through. That gate and this form design address different moments (this
  one is at confirmation time, before any tool call exists; that one is a
  backstop at the tool-call itself) and are not a replacement for each
  other — a form-collected `price_ceiling` would be exactly the kind of
  value `spend-policy.ts`'s `SpendIntent.amount` could later be checked
  against, if both are ever built.

## Related work (external — for this design only, not NanCy's shipped core)

`RELATED-WORK.md` at the repo root covers prior art for NanCy's actual
shipped mechanism (the stateless reviewer plus code-owned confirmed-task
record) — deliberately kept separate from this section, which is prior art
for the *form* idea specifically and should not be read as claims about
anything already implemented.

- **["Options, Not Clicks: Lattice Refinement for Consent-Driven MCP
  Authorization"](https://arxiv.org/pdf/2605.11360)** proposes replacing
  free-text or binary allow/deny authorization prompts with dynamically
  generated, bounded, hierarchical choices — aimed at the same "consent
  fatigue" problem this design exists to avoid. Its lattice organizes
  *how much access* a grant covers (deny-all → read-only → specific
  files); this design's authorization/specification field split instead
  organizes *which exact values* apply within one already-agreed action
  (a price, a payment method) — a different axis of the same underlying
  idea (structured, bounded choices over free text), not the same
  mechanism restated.
- **Slot filling in task-oriented dialogue systems** (a decades-old NLP
  technique, now commonly done zero-shot with LLMs — e.g. the "Zero-shot
  Slot Filling in the Age of LLMs for Dialogue Systems" survey,
  [ACL Anthology](https://aclanthology.org/2025.coling-industry.59.pdf))
  is the general technique this design applies to the authorization
  domain specifically: extract structured fields (slots) from a
  free-text request, then confirm the filled result with the user before
  acting on it. Worth reading before implementing the generation prompt in
  `src/confirmation/form-generation.ts` (sketched above) — established
  confirmation strategies from that literature (re-prompt only the missing
  or invalid slots, not the whole form; distinguish "confirm current
  values" from "confirm submission") likely transfer directly and are
  better prior art for the interaction design than reinventing it from
  scratch.

## Open questions before this could ship

- Where trusted option lists (payment methods, addresses) actually live —
  see "Where trusted option lists would come from" above; nothing here is
  decided.
- Exact wire shape for delivering `GeneratedForm` over A2A (a structured
  data part alongside the text, per the A2A doc's support for that) and for
  the submission payload back.
- Whether generation should be one LLM call shared with gap detection or a
  genuinely separate one — affects both cost and whether "note vs. form" can
  ever disagree with each other about what's missing.
- Whether a form-eligible confirmation should still also carry the
  agent's own free-text description verbatim (defense in depth: human can
  read it even if some field's `why` is confusing) — current sketch assumes
  yes, form is additive, never a replacement for the existing template.
- Regression-testing an LLM-authored *structure* (not just a verdict) is
  harder than anything else in this codebase tests today — closest
  precedent is `parseGapDetectionResponse`'s defensive parsing, but that
  degrades to an empty array; a malformed form has more ways to be "kind of
  right but unsafe" (e.g. right shape, wrong `kind` for a purpose) that a
  naive schema-only validator wouldn't catch. Needs its own explicit test
  plan once implementation starts, not an afterthought.
