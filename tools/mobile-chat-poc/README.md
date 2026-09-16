# Mobile chat POC — A2A-backed

Status: **the full confirmation dance is verified working end-to-end over a
real A2A session against a real model** — `blocked_no_confirmed_task` →
`confirmation_requested` → `"y"` → `confirmation_granted` → the next
`before_tool_call` carrying that `taskId` → a real reviewer verdict that
matches the confirmed task (`test_mode_would_allow`, dry-run only because
`testMode: true`). This is the first concrete step on
`docs/mobile-app-todo.md`'s "Yhteys nykyiseen Nancyyn" checklist — proving
that a phone can hold a plain-text chat with an OpenClaw agent behind NanCy,
with **no new NanCy code and no new OpenClaw channel plugin**. Six real,
pre-existing NanCy/tooling bugs were found and fixed along the way (see
"What broke" below) — this POC is why they were ever discovered, and the
run above only started fully succeeding once all six were in place.

## Why this exists, and why it's not a new channel plugin

The first design pass for this considered writing a real OpenClaw channel
plugin (the officially documented pattern at
`node_modules/openclaw/docs/plugins/sdk-channel-plugins.md`, using
`createChatChannelPlugin`). A real bundled-scale reference implementation
(`mir-stream/openclaw-webchannel` on GitHub) showed what that actually takes:
its inbound-turn handler alone (`packages/plugin/src/inbound.ts`) is ~1800
lines wiring `channelRuntime.inbound.run`, per-turn draft/streaming
controllers, approval-origin leases, and reasoning lanes — internal contracts
this repo has no readable source for beyond minified `.d.ts` files, and no way
to test against, since `TESTING.md`'s one rule is "never touch the live
gateway on your own initiative." Shipping unverifiable plugin code against
those contracts in a security-critical project was the wrong tradeoff for a
"simple POC, just chat."

Instead: OpenClaw already ships a bundled **A2A channel**
(`node_modules/openclaw/docs/channels/a2a.md`) — a JSON-RPC-over-HTTP
text-in/text-out channel with per-peer bearer tokens and session continuity
via `contextId`. It needs **zero new plugin code**, only config. NanCy's hooks
(`before_tool_call`, `message_sending`, `message_received`) are channel-agnostic
— they fire for A2A turns exactly like they do for Telegram, confirmed against
a real run — so the whole confirmation dance (`src/confirmation/protocol.ts`)
applies unchanged. Per `TESTING.md`: *"NanCy's confirmation matching only
keys on `sessionKey`, not channel."*

This is a deliberate scope cut from the mobile plan (`docs/mobile-app-todo.md`):
**text only**, one user, one session — see that doc's P0 list for what's
still open. One exception: `web/index.html` now renders NanCy-generated
confirmation forms (see `docs/architecture/confirmation-forms.md`) — a
`[NANCY_FORM]{...}[/NANCY_FORM]` block appended to a confirmation's plain
text is parsed into up to four buttons ("Etene näillä tiedoilla" / "Selvitä
vaihtoehdot ensin" / "Tarkenna lomakkeella" / "Kuvaile tekstillä"). Only the
first sends the literal `"y"` — the rest just compose an ordinary plain-text
chat message for the target agent to read, exactly as if the human had
typed it themselves, no special marker involved; none of them are consent
on their own. `client.mjs` (the terminal client) has no renderer and just
shows the `[NANCY_FORM]` block as raw text, same as Telegram would.

## What broke, running this for real (and what it taught us)

None of this was visible from reading OpenClaw's own docs — every item here
needed a real Gateway, a real model, and (for the last two) a real phone.

1. **A CLI flag silently overrides the config file's own setting.**
   `tools/comparator/src/driver.ts`'s `startGateway()` hardcodes
   `--bind loopback` on the spawned CLI command — correct for its own use
   case (agent CLI calls only), but reusing it unmodified for a LAN-reachable
   test meant the config file's `gateway.bind: "lan"` was silently ignored:
   the process kept listening on `127.0.0.1` only, confirmed via `netstat`,
   with nothing in any log to say so. Fixed by `test/start-manual-test-gateway.mts`
   spawning its own launcher with the right flag instead of reusing
   `driver.ts`'s.
2. **A non-loopback bind refuses to start without a Gateway-level auth
   token, even though A2A never uses it.** `openclaw gateway run --bind lan
   --auth none` fails outright at startup: *"Refusing to bind gateway to lan
   without auth."* This is a blanket safeguard for the Gateway's own
   WebSocket/control-plane surface — A2A already has its own mandatory
   per-peer bearer token regardless (`a2a.md`: *"There is no unauthenticated
   mode"*) and was never relying on Gateway auth being off. The fix is a
   second, separate, never-printed Gateway token that satisfies the startup
   check; `web/index.html` and `client.mjs` never send it and don't need to
   know it exists.
3. **A2A does not send CORS headers for browser callers.** Confirmed
   two ways on a real phone: a direct address-bar GET to the Gateway's own
   `/.well-known/agent-card.json` succeeded (proving plain network/firewall
   connectivity), but `web/index.html`'s own `fetch()` to the same Gateway
   port failed with the browser's generic, undiagnostic "Failed to fetch" —
   which is indistinguishable from a connectivity failure by design (browsers
   don't expose *why* a fetch failed). `client.mjs` working proves nothing
   about the browser case: CORS is a browser-only enforcement, so a Node
   `fetch()` (in `client.mjs` or the standalone test scripts) was never
   subject to it. Fixed by making `web/index.html`'s own static server
   reverse-proxy `/a2a/v1` to the Gateway server-side (see
   `start-manual-test-gateway.mts`'s `serveWebDir`) — the browser only ever
   talks to one origin, so CORS never applies. **A real native mobile client
   (not a browser page) would not hit this at all** — CORS is a browser
   enforcement, not a wire-protocol restriction.
4. **Four real NanCy bugs, unrelated to A2A's transport plumbing, found only
   because a real model was in the loop and the round trip was actually
   pushed all the way through:**
   - `src/analysis/client.ts`'s reviewer call could exhaust its output
     budget on a "thinking" model's internal reasoning before ever producing
     a verdict (`MAX_TOKENS`).
   - `message_sending`'s design meant no outbound reply of any kind — not
     even a plain "hi" — could go out without a confirmed task
     (`allowUnconfirmedChatReplies`).
   - The confirmation-request reviewer's own verdict/reason was never logged
     anywhere retrievable, so a blocked confirmation was unrecoverable after
     the fact — fixed by logging it like every other verdict does.
   - That same reviewer was treating the `a2a` channel type itself as
     evidence the destination wasn't a real human, producing a false
     CLARIFY independent of the actual message content — fixed by telling it
     a configured, token-authenticated channel is exactly as trusted as any
     other. This one would have affected any real phone user, not just a
     synthetic test.

   All four are real behavior that would have affected the operator's live
   Telegram deployment too, not just this POC. See `CLAUDE.md`'s "Recent
   focus" and README.md feature #10 for the full detail on the first two —
   this file only covers the mobile-transport angle.
5. **A2A's `contextId` belongs on the `message` object, not top-level in
   `SendMessage`'s params.** OpenClaw's own `A2aSendMessageParamsSchema`
   silently ignores a top-level `contextId` rather than rejecting it, so
   every turn looked like it should continue the conversation but actually
   started a brand-new session every time — the human's `"y"` could never
   resolve a confirmation it was never actually a reply to. Fixed in both
   `client.mjs` and `tools/comparator/src/driver.ts`.
6. **NanCy's own plugin state was split across two separate in-process
   instances in this exact deployment shape** (no `mainSessionKey`/
   `workerAgentId` — NanCy's simplest, default documented mode): OpenClaw can
   invoke a plugin's `register(api)` more than once for the same loaded
   module, and `taskAuth`/session state/pending confirmations were all
   created fresh inside `register()`'s own body, so a task granted via
   `message_received` in one call was invisible to `before_tool_call` in
   another — confirmed directly via a per-instance id and a monotonic
   call-sequence counter, not timestamp inference. This was the last blocker:
   every other fix above was necessary but not sufficient until this one
   landed too. Fixed by keying that state at module level by `api.rootDir`
   instead of recreating it per call (see `src/index.ts`); regression-tested
   in `test/dual-registration.test.ts`.

With all six in place, a real run (`test/run-isolated-a2a-test.mts`) shows
the complete intended chain for the first time:
`blocked_no_confirmed_task` → the agent's own `"Formal confirmation: ..."` →
`confirmation_requested` → `"y"` → `confirmation_granted` → the *next*
`before_tool_call` for the same action now carries that `taskId` → a real
reviewer verdict matching the confirmed task
(`"The command directly matches the confirmed task ... does not violate any
baseline security policies."`, dry-run only because `testMode: true`). The
one thing this run doesn't cover: the agent's own follow-up narration to the
user (not the gated action itself) got CLARIFY'd as outside the task's
scope, because the test's task description authorized only the curl
command, not reporting back on it — worth keeping in mind when writing a
real task description, not a NanCy bug.

## Setup (config only — no plugin code)

Add to the target `openclaw.json` (an **isolated test profile**, not the
operator's live config — see "Testing safely" below):

```json5
// See config-snippet.json5 in this directory for the literal block.
{
  channels: {
    a2a: {
      enabled: true,
      // Plain-string field with env-var interpolation, NOT a {source:"env",...}
      // SecretRef object — A2A's peers.<name>.token schema rejects that
      // (confirmed via `openclaw doctor`), unlike some other channel configs.
      peers: {
        "mobile-poc": { token: "${NANCY_MOBILE_POC_TOKEN}" },
      },
    },
  },
}
```

Set `NANCY_MOBILE_POC_TOKEN` to a strong random value in the Gateway process's
environment. Restart the Gateway to pick up the change (see "Testing safely").
If you also want the Gateway reachable over the LAN (not just loopback), see
"What broke" items 1–2 above — `gateway.bind: "lan"` additionally needs a real
`gateway.auth` token, unrelated to A2A's own.

The target agent's own `AGENTS.md` (a different file, in the OpenClaw agent's
own workspace — see `CLAUDE.md`'s note on this) must carry NanCy's confirmation
snippet from `README.md`'s "Add task confirmation rules to your agent" section,
or the agent has no reason to ever send a `"Formal confirmation: ..."` message
in the first place — same requirement the behavior-comparator's `nancy` branch
documents (`docs/architecture/behavior-comparator.md`, "The confirmation dance
depends on the target agent's own AGENTS.md"). Confirmed working against a
real model: a blocked `exec` attempt correctly made the agent fall back to
sending the formal confirmation template next.

## Testing safely — do not touch the live gateway

`TESTING.md`'s rule applies here unchanged: don't restart or reconfigure the
operator's real, Telegram-connected Gateway on your own initiative. Two
scripts exist under `test/`, both building a fully isolated, throwaway
profile the same way `tools/comparator/src/config-builder.ts` does — never
touching `~/.openclaw*` or any real channel credential:

1. **`test/run-isolated-a2a-test.mts`** — automated, one-shot pass/fail:
   starts a loopback-only Gateway, drives the confirmation round trip via
   `client.mjs`'s own functions, prints the relevant `nancy.log` lines, and
   shuts down. Run it with
   `node --experimental-strip-types tools/mobile-chat-poc/test/run-isolated-a2a-test.mts`.
2. **`test/start-manual-test-gateway.mts`** — long-lived, LAN-bound: starts a
   Gateway reachable from a real phone on the same network, plus a static
   file server (with the CORS-avoiding same-origin `/a2a/v1` proxy from
   "What broke" item 3) for `web/index.html`, and prints the exact URL/token
   to use. `testMode: true` by default, so nothing it decides to do ever
   really executes. Stop it with Ctrl+C. Run it with
   `node --experimental-strip-types tools/mobile-chat-poc/test/start-manual-test-gateway.mts`.

If you specifically want to see this against the operator's real config,
that's an in-the-moment ask to make explicitly — same as any other live
Gateway restart.

## Try it

```bash
node tools/mobile-chat-poc/client.mjs \
  --url http://127.0.0.1:<port>/a2a/v1 \
  --token "$NANCY_MOBILE_POC_TOKEN"
```

Then type. Each line is sent as a blocking `SendMessage`; the reply prints
under `nancy>`. `Ctrl+C` exits. `--context <id>` resumes a previous
conversation's `contextId` instead of starting a new one.

### Blocking vs. `returnImmediately`

The script defaults to **blocking** `SendMessage` (no `returnImmediately`) —
each call waits (up to `replyTimeoutMs`, default 120s, max 600s per the A2A
config reference) for the agent's actual reply text, including a confirmation
question. This mirrors "send a chat message, wait for the reply" and sidesteps
the question of whether an intermediate message during `TASK_STATE_WORKING`
is visible to a poller at all — it never needs to be, because we only read
the task once it completes with the confirmation text as its own reply.
Pass `--poll` to switch to `returnImmediately` + `GetTask` polling instead,
for exploring the other mode.

## Browser UI (`web/index.html`)

A single-file, dependency-free phone-sized chat page — the same protocol as
`client.mjs`, opened in an actual phone browser instead of a terminal. Enter
the A2A URL and token in its settings panel (persisted to `localStorage` on
that device only); it keeps the `contextId` across messages the same way
`client.mjs` does, with a "Aloita uusi keskustelu" button to drop it.

It's deliberately **not** a Claude Artifact: artifacts run behind a CSP that
blocks `fetch`/XHR to anything outside a small CDN allowlist, so a published
artifact could never actually reach a LAN OpenClaw Gateway. This is a plain
static file — `start-manual-test-gateway.mts` serves it (with the same-origin
`/a2a/v1` proxy from "What broke" item 3) so a real phone can open it, or
serve it however else is convenient (e.g. `npx serve tools/mobile-chat-poc/web`)
and point the page's "A2A-osoite" setting at a same-origin proxy path, not the
Gateway's own port directly — confirmed necessary against a real phone, see
"What broke" item 3.

## Files

- `client.mjs` — the terminal POC client: no dependencies beyond Node's
  built-in `fetch`, one file, one job (send text, print the reply, keep the
  `contextId`). Exports its core functions so test scripts can reuse them
  without starting the interactive REPL.
- `web/index.html` — the browser/phone equivalent of `client.mjs`. See above.
- `config-snippet.json5` — the exact `channels.a2a` block to add to a test
  profile's config.
- `test/run-isolated-a2a-test.mts` — automated end-to-end test against a
  throwaway loopback Gateway.
- `test/start-manual-test-gateway.mts` — long-lived LAN-bound Gateway + web
  server, for testing from a real phone.

## Next steps

- Repeat the full confirmation dance from an actual phone (not just the
  automated loopback test) with all six fixes in place, using the browser UI
  and `test/start-manual-test-gateway.mts` — the mechanism is now proven
  against a real model over a real A2A session; this would confirm the same
  chain survives the LAN + same-origin-proxy path too.
- Try a task description that also authorizes reporting back to the user
  (not just the gated action itself), to see the agent's own follow-up reply
  reach the human instead of getting CLARIFY'd as out of scope.
- Only after that's confirmed does it make sense to invest in an actual
  native phone client instead of the browser page — this file's job was
  proving the transport and the confirmation-flow mapping, not building
  production UI.
