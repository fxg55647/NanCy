# Mobile chat POC — A2A-backed

Status: **POC scaffold, not built or run against a real Gateway yet.** This is
the first concrete step on `docs/mobile-app-todo.md`'s "Yhteys nykyiseen
Nancyyn" checklist — proving that a phone (or, for now, this terminal client
standing in for one) can hold a plain-text chat with an OpenClaw agent behind
NanCy, with **no new NanCy code and no new OpenClaw channel plugin**.

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
— they fire for A2A turns exactly like they do for Telegram — so the whole
confirmation dance (`src/confirmation/protocol.ts`) applies unchanged. Per
`TESTING.md`: *"NanCy's confirmation matching only keys on `sessionKey`, not
channel."*

This is a deliberate scope cut from the mobile plan (`docs/mobile-app-todo.md`):
**text only**, one user, one session. No images, no dictation, no forms — see
that doc's P0 list for what's still open.

## What's genuinely unverified

A2A's task model is request/response (`SendMessage` → completed task with an
`artifacts[].parts[].text` reply). NanCy's confirmation dance is: agent sends
a `"Formal confirmation: ...\nReply y to proceed..."` message and waits; the
human's `"y"` arrives as a **separate** inbound message in the same session.
Mapped onto A2A, that should become: your `SendMessage` call for the task
blocks until the agent's confirmation question comes back as the completed
task's reply text (this is the recommended default below — see "Blocking vs.
`returnImmediately`"); you then send a **second** `SendMessage` with the same
`contextId` carrying `"y"`. Whether OpenClaw's per-session turn queue actually
accepts that second call while the first task is nominally still open, and
whether NanCy's `message_received` hook sees it as arriving in the same
session, is **not yet empirically confirmed** — it needs a real run, in an
isolated test profile (see below), before trusting this for anything beyond
"can I talk to the agent at all."

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

The target agent's own `AGENTS.md` (a different file, in the OpenClaw agent's
own workspace — see `CLAUDE.md`'s note on this) must carry NanCy's confirmation
snippet from `README.md`'s "Add task confirmation rules to your agent" section,
or the agent has no reason to ever send a `"Formal confirmation: ..."` message
in the first place — same requirement the behavior-comparator's `nancy` branch
documents (`docs/architecture/behavior-comparator.md`, "The confirmation dance
depends on the target agent's own AGENTS.md").

## Testing safely — do not touch the live gateway

`TESTING.md`'s rule applies here unchanged: don't restart or reconfigure the
operator's real, Telegram-connected Gateway on your own initiative. Two
options, safest first:

1. **Spin up an isolated Gateway**, the same way `tools/comparator/src/driver.ts`
   already does for its own testing (`startGateway`/`waitForGatewayReady`/
   `stopGateway`, a throwaway `OPENCLAW_STATE_DIR`, a random loopback port,
   `auth: {mode: "none"}`). Point `client.mjs` at that instance. This never
   touches `~/.openclaw*` or any real channel credential.
2. If you specifically want to see this against the operator's real config,
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
the unverified question of whether an intermediate message during
`TASK_STATE_WORKING` is visible to a poller at all — it never needs to be,
because we only read the task once it completes with the confirmation text as
its own reply. Pass `--poll` to switch to `returnImmediately` + `GetTask`
polling instead, for exploring the other mode.

## Browser UI (`web/index.html`)

A single-file, dependency-free phone-sized chat page — the same protocol as
`client.mjs`, opened in an actual phone browser instead of a terminal. Enter
the A2A URL and token in its settings panel (persisted to `localStorage` on
that device only); it keeps the `contextId` across messages the same way
`client.mjs` does, with a "Aloita uusi keskustelu" button to drop it.

It's deliberately **not** a Claude Artifact: artifacts run behind a CSP that
blocks `fetch`/XHR to anything outside a small CDN allowlist, so a published
artifact could never actually reach a LAN OpenClaw Gateway. This is a plain
static file — serve it however's convenient (e.g. `npx serve tools/mobile-chat-poc/web`
from a machine on the same LAN as the isolated test Gateway, then open that
machine's address from the phone) or open it directly as a `file://` page.

**Unverified: CORS.** The A2A channel doc's config reference has no
origin/CORS setting, and nothing else in the OpenClaw docs confirms whether
the A2A HTTP route sends `Access-Control-Allow-Origin` for browser `fetch`
calls specifically (as opposed to server-to-server or CLI callers, which
aren't subject to CORS at all — which is why `client.mjs` working proves
nothing about whether the browser page will). If the page's requests fail
with what looks like a network error but never reaches the Gateway's own
logs, that's almost certainly this — a browser-side CORS rejection, not an
auth or routing problem. Confirm `client.mjs` works first; it isolates
"does A2A + NanCy work at all" from "does a browser get to use it directly."

## Files

- `client.mjs` — the terminal POC client: no dependencies beyond Node's
  built-in `fetch`, one file, one job (send text, print the reply, keep the
  `contextId`).
- `web/index.html` — the browser/phone equivalent of `client.mjs`. See above.
- `config-snippet.json5` — the exact `channels.a2a` block to add to a test
  profile's config.

## Next steps

- Run this against an isolated Gateway per "Testing safely" and confirm the
  `SendMessage` → confirmation-question → second `SendMessage("y")` → real
  reply round trip actually completes and NanCy's `nancy.log` shows the
  expected `confirmation_requested` / `message_received` entries.
- If the second-call-same-`contextId` pattern doesn't work as hoped, the
  fallback is `--poll` mode with the client watching `GetTask` state — record
  what's actually observed here, not assumed.
- Only after that's confirmed does it make sense to point an actual phone
  client at this instead of a terminal script — this file's job was proving
  the transport and the confirmation-flow mapping, not building the UI.
