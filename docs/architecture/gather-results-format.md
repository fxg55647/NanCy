# Reporting Gathered Options Back — the `[NANCY_RESULTS]` Convention

Status: **implemented as a documented convention only — zero NanCy code.**
This is the direct follow-on to `docs/architecture/confirmation-forms.md`'s
`offersGatherFirst` flag: once a human has asked the target agent to
"gather options first" (task-confirmation-menu.md's option 5), the agent
eventually needs to report back what it found — today that's just prose
text. This doc defines an optional convention the agent *may* use instead,
so a rendering client (`tools/mobile-chat-poc/web/index.html`) can show a
proper list/card view rather than one wall of text.

## The one thing to understand before touching this

**This is not `GeneratedForm`.** `GeneratedForm` (`src/confirmation/forms.ts`)
is NanCy's own trusted output, generated at confirmation time, because its
fields can be *authorization-bearing* (a price ceiling defines what's
authorized to spend) — that's why NanCy's own code generates and
mechanically constrains it.

The block this doc defines is different in kind: it carries **search
results about the world** (which laptops exist, what they cost) — never
anything that expands or narrows what the worker is authorized to do. It
is authored entirely by the **target agent**, at whatever point in its own
task execution it has something to report, using whatever tool results it
already gathered. NanCy's `message_sending` hook reviews the surrounding
outbound message exactly as it reviews any other outbound content — it does
not need to recognize, generate, or validate this block at all. **Do not
add NanCy-side parsing, generation, or validation for this convention** —
that would be solving a problem this design deliberately doesn't have.

## The convention

Anywhere in an ordinary outbound message, the agent may include:

```
[NANCY_RESULTS]{"items":[{...arbitrary keys...}, {...}, ...]}[/NANCY_RESULTS]
```

- `items` is a JSON array of objects. Each object's keys are **not fixed**
  — the model may improvise per call, and even per item, since nothing here
  needs to be mechanically constrained the way `GeneratedForm` fields do.
- For a nicer comparison view, common field names are suggested (not
  required): `name`, `price`, `url`, `specs`, `note`. A rendering client
  must work correctly even if none of these appear, or if they vary from
  item to item.
- The block is optional and additive — the agent's own prose report should
  still make sense without it (write the human-readable summary as usual;
  the block is extra structure alongside it, the same relationship
  `[NANCY_FORM]` has to `buildFormAndMenuNote`'s plain text).
- README.md's AGENTS.md snippet mentions this convention so the agent knows
  it exists; using it is always optional.

## Rendering (client-side only, no transport change)

`tools/mobile-chat-poc/web/index.html`:
- `extractResultsBlock(text)` — the same defensive-extraction shape as
  `extractFormBlock`: regex-match the delimiters, `JSON.parse` the inside,
  require an `items` array of objects. Any failure (block absent,
  malformed JSON, wrong shape) returns `items: null` and leaves the raw
  text to display normally — the same fail-open posture `[NANCY_FORM]`
  already established. A malformed block must never hide or break display
  of the surrounding message.
- `renderResultsView(items)` renders a small "Listana ⇄ Lomakkeena" toggle:
  - **Listana**: one line per item, its own keys/values joined as text.
  - **Lomakkeena**: one card per item, each key rendered as a generic
    label/value pair (no assumed schema, since keys aren't known ahead of
    time).
- Every item value is untrusted content — it came from pages the agent
  visited, which could include adversarial text. Render with `textContent`
  only, exactly like `[NANCY_FORM]` field labels/values already do — never
  `innerHTML`.
- Channels that don't render this (Telegram, `client.mjs`) simply show the
  raw `[NANCY_RESULTS]{...}` text, same as any unrecognized content.

## Relationship to existing work

- **`confirmation-forms.md`**'s `offersGatherFirst`/`gatherFirstDefaultCount`
  is what prompts the *narrower first confirmation* that leads to the
  agent doing this gathering in the first place — this doc only covers what
  happens once the agent has something to report back.
- **`task-confirmation-menu.md`**'s option 5 finding holds exactly as
  predicted: NanCy never becomes an active, tool-calling, or
  content-generating participant here. The target agent runs its own
  confirmed (narrower) task and reports back through its own ordinary
  outbound message; NanCy's only role is the same Intent Anchoring review
  every outbound message already gets.
