# NanCy SSIL: Stateless Security Interruption Layer
## A Fail-Safe Layer for OpenClaw
![](https://github.com/fxg55647/NanCy/blob/main/images/nancy.png)
## Overview

*"Turning AI agents from truly terrifying to normally suspicious".*

NanCy SSIL (Stateless Security Interruption Layer) is a specialized security framework designed as a plugin for the OpenClaw autonomous agent. While autonomous agents show immense potential, their adoption in real-world commercial environments is currently hindered by the lack of deterministic safety boundaries.

The mission of NanCy SSIL is to transform OpenClaw from a high-risk experimental tool into a reliable assistant capable of handling authentic commercial tasks. Our initial focus is on securing routine office and business operations, such as:

- **Email communication:** Safe exchange of messages without the risk of exfiltration.

- **Scheduling and Bookings:** Making binding appointments and reservations.

- **Buying:** Executing limited, pre-authorized purchases on trusted platforms.

- **Document Management:** Safe handling of pre-validated files.


## The Core Concept: Intent Anchoring & Stateless Verification

The fundamental innovation of NanCy SSIL revolves around a single, unbreakable loop: **Intent Anchoring.**

Before any autonomous session begins, the user's explicit intent is captured, confirmed and "locked" as the Source of Truth for the session. In this repository, the agent's only role in that is to *ask* — following the protocol NanCy asks you to add to `AGENTS.md` (see [Getting Started §3](#3-add-task-confirmation-rules-to-your-agent)) — while NanCy's own code reads the user's actual reply, decides whether it was affirmative, and is the sole writer of the resulting confirmation record that anchors the checks below. The agent cannot write that record itself (see feature #6), so it cannot manufacture consent that was never given.

While the primary Agent (OpenClaw) may be susceptible to "intent drift," hallucinations, or prompt injection, NanCy acts as an **external, stateless observer.** It cross-references every critical action—such as submitting a purchase form or sending an outgoing email—against the anchored intent. If the action does not perfectly align with the original goal, NanCy pulls the plug. All other security features in this framework are built to support and enforce this verification process.


## Key Technical Features

This section separates what actually runs today (✅, in `src/index.ts`) from what is still a design goal (🧭, not in this repository yet). Check the code before relying on any of it — this is early-stage software.

### 1. Stateless Security Interruption Layer (SSIL) ✅

Each tool call — and each outbound message the agent sends through any channel — is judged by a fresh, one-shot LLM request with no persisted conversation of its own — the analysis model can't be talked around turn-by-turn the way a chatty, stateful guard could. It is given a bounded snapshot of relevant facts (the confirmed task and recent tool calls) as plain context in that single prompt, not a running relationship it can be "gaslit" into trusting. Covering outbound messages, not just tool calls, matters because some channels (email via OpenClaw's `imap` extension, for one) dispatch content through message delivery rather than a distinct tool — `before_tool_call` alone would never see it. The only interactive decision in the whole flow is the one task confirmation (feature #2) — an uncertain CLARIFY verdict, for a tool call or an outbound message, is always treated as BLOCK rather than pausing to ask again, since native pause-for-approval delivery isn't available on every channel. Tool-call analysis failures fail *closed* (the action is blocked); outbound-message analysis failures fail *open* (the message still sends), since muting the agent's replies entirely isn't a graceful fallback either.

### 2. Intent Confirmation & Gap Detection ✅ confirmation / 🧭 gap detection

The agent only *asks*; NanCy *decides*. Per the `AGENTS.md` snippet in [Getting Started §3](#3-add-task-confirmation-rules-to-your-agent), the agent sends a formatted confirmation request and then waits — it does not write anything. NanCy watches for that outbound message, correlates it with the user's next reply in the same session, and writes `tasks/current.json` itself **only** if that reply is exactly `y`/`yes`; any other reply, or one that never arrives, results in no confirmed task. The agent cannot write to `tasks/` directly (blocked, see #6), so it cannot fabricate its own "confirmed" record — the decision genuinely lives in code, not in an instruction the agent could ignore or a compromised agent could forge. A confirmed task also expires 4 hours after confirmation — past that, NanCy treats every subsequent action as if nothing were confirmed at all, rather than letting one old "yes" anchor unrelated actions indefinitely. What's still not implemented: NanCy does not itself analyze the agent's plan for undefined variables or gaps before the confirmation is sent — that text is written by the agent.

### 3. Domain Border Control ✅

Before every `web_fetch` or browser action that carries a URL (e.g. `navigate`), NanCy checks the target host — independent of the LLM analysis, so this still works even without `analysis` configured:

- If `domains.allow` is set, only those domains (and their subdomains) may be reached; everything else is blocked.
- Otherwise, if `domains.deny` is set, listed domains (and their subdomains) are blocked.
- Otherwise, the host is looked up against **[URLhaus](https://urlhaus.abuse.ch/)** (abuse.ch), a free, keyless malicious-URL database, and blocked if flagged. This lookup fails open (allows the call) if the third-party API itself is unreachable, so an outage there never blocks legitimate traffic outright — intent-alignment analysis (#1) still runs afterward as a second layer.
- Optionally (`domains.minAgeDays`, off by default): the domain's registration age, via a free [RDAP](https://about.rdap.org/) lookup. URLhaus only knows about hosts already tied to *known* malware — a domain registered yesterday purely for one targeted attack won't be listed there yet. Age is a different, complementary signal for exactly that case. It's off by default because it's a real false-positive risk (legitimate new sites exist) that reputationCheck mostly isn't — an explicit opt-in for operators who want that trade-off. It also fails open on unresolvable/privacy-redacted records, and its TLD-suffix handling is simplified (see the code comment), so it under-covers multi-part suffixes like `.co.uk` rather than over-blocking.

There is no network-level interception or process kill — like every other NanCy block, this refuses the tool call itself with a reason, before it runs. See [Getting Started](#domain-border-control-optional) for configuration.

### 4. Contextual Scrambler 🧭

Not implemented in this repository. NanCy currently has no dedicated protection against prompt injection aimed at its own reviewer model. Its fresh, stateless and deliberately bounded analysis prompts reduce the opportunity for a persistent compromise, but untrusted content included in an analysis prompt can still influence the reviewer. For now the design relies on that limited exposure and on using a reviewer model that is different from the main agent; neither is a security guarantee.

A dedicated prompt-injection defense for the reviewer is planned for a later release.

### 5. DOM Biopsy ⚠️ (lighter than described)

Before a browser-interact action (click, fill, submit, etc.), NanCy fetches a text snapshot of the current page and includes it as context in the same general intent-analysis prompt used for every tool call (see #1) — so the analysis model sees what the agent sees before deciding. This is not a dedicated, element-level parse of the underlying HTML to verify a specific element's true function; it's the same page-level context mechanism applied to browser actions.

For `fill`/`type`/`select` specifically — the browser commands whose params carry the actual value being written into the page — NanCy runs a **context-only pre-check first**: the page snapshot and the confirmed task, but not the value itself. If that already fails (wrong site, an unrelated or phishing-like form), NanCy blocks right there — the value being typed is never included in any prompt sent to the analysis LLM. Only once the destination passes does the full check (value included) run, same as before. This catches "wrong form entirely" without ever exposing what was about to be typed into it, at the cost of one extra LLM call for these three commands. It doesn't fully protect multi-field forms — a snapshot taken before the *second* field's fill can already reflect the first field's value rendered back into the page — so the guarantee is strongest for the very first interaction with a page, not every field after it.

### 6. Write-Protection for Core Configuration ✅

NanCy actively blocks any `write` or `edit` tool call whose target path resolves to `AGENTS.md`, `IDENTITY.md`, `MEMORY.md`, NanCy's own `src/index.ts` / `openclaw.plugin.json`, or anywhere under `tasks/` (now written exclusively by NanCy itself, see #2) — this block is unconditional and does not depend on the LLM analysis being configured or correct. Separately, at startup NanCy also audits whether the individual protected files are OS-writable and warns if they are (`chmod`-level protection is still recommended as defense in depth, since the audit only warns and doesn't itself change file permissions).

### 7. Main/Worker Session Split ✅ (optional)

When `mainSessionKey` is configured, that session is locked to passive reads — `write`, `edit`, `exec`/`shell`/`bash`, and the interactive browser commands are blocked outright, independent of LLM analysis. Real work happens only once a task is confirmed (feature #2): NanCy then spawns a dedicated worker session (`agent:<workerAgentId>:task-<id>`) to execute it, and deletes that session once the run finishes so one task's context can never bleed into the next. The main session itself is also reset after `mainSessionIdleMinutes` of inactivity (default 60), so it can't silently accumulate injected context over an unbounded chat. Without `mainSessionKey` set, this split is disabled and every session is treated the same way.

### 8. Behavioral Review & Session Termination ✅

Every 10 tool calls, NanCy runs a separate, session-level review over the recent call history — looking for *patterns* a single-call verdict can't see: loops, slow privilege escalation, repeated blocked attempts, a sustained attempt to bypass NanCy's own checks. This is additional to, not a replacement for, the per-call ALLOW/BLOCK/CLARIFY checks in feature #1. Only this behavioral review can terminate a session outright (`terminate` verdict) — once terminated, every subsequent tool call in that session is blocked unconditionally, regardless of what it is.


## The Philosophy: Assume Compromise & Pragmatic Safety

We operate on the principle that the agent is perpetually at risk of being confused or poisoned. We don't try to make the AI "perfect"; we make the environment **safe enough for profitable use** in many business cases.

**If the agent cannot be trusted, the supervision must be.**

### **Pragmatism over Perfection**

Our goal is not to achieve "unbreakable" absolute security—as such a thing rarely exists—but to provide a **significant improvement** over the current state of autonomous AI, especially OpenClaw. We are building a system that makes the commercial use of agents **rational, profitable and manageable.**

### **Safe Failure: The Right to Give Up**

In the NanCy SSIL framework, it is perfectly acceptable—and often encouraged—for the agent to fail.

- It is okay for the agent to occasionally report: *"I have stopped the operation because I could not verify the safety of this action."* \* It is okay for the agent to occasionally ask: *"I am unsure if this intent matches your goal. Please intervene."*

**A failed task is a minor inconvenience; an unauthorized credit card drain is a catastrophe.** NanCy SSIL ensures that when the system fails, it fails safely.


## Security philosophy

NanCy is not designed to make high-stakes or safety-critical autonomous systems safe. It is designed to make lower-stakes autonomy more practical by limiting what a failure can become.

The principle is simple: useful autonomy does not require perfect safety — it requires the worst credible failure to be sufficiently bounded.

Give agents narrow permissions, limited funds, task-scoped data access, revocable credentials, and explicit approval boundaries. If completely misusing a capability once could cause serious human suffering, major reputational harm, or an unacceptable financial loss, do not give that capability to a general-purpose autonomous agent.

See **["Security Philosophy: Limit the Blast Radius"](./SECURITY-PHILOSOPHY.md)** for deployment guidance, examples, limitations, and further reading.


## Where This Fits

This isn't a novel idea — by September 2026 gating an agent's actions against a locked intent via a stateless external model is a recognized pattern (AI-control "trusted monitoring," intent-based guardrails), with close relatives in Meta LlamaFirewall's AlignmentCheck, ClawGuard, and Google ADK's plugin hooks. See **[RELATED-WORK.md](./RELATED-WORK.md)** for the detailed positioning, comparisons, and sources.

## Common Misconceptions

Short answers to the obvious objections — agent/reviewer collusion, whether the agent can talk to NanCy directly, and AI-reviewer bias toward "a fellow AI" — are in **[MISCONCEPTIONS.md](./MISCONCEPTIONS.md)**.


## Getting Started

> [!WARNING]
> Use only for research and development. NanCy can block or pause tool calls that fail its intent analysis (when `analysis` is configured) and always blocks writes to its own protected files, but several features described above are not implemented yet — see the ✅/🧭 status markers in [Key Technical Features](#key-technical-features) — and the enforcement that does exist is new, unaudited, and only as reliable as the underlying LLM's judgment. Do not rely on it for production safety yet.

### Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- A supported LLM API key (Google Gemini, OpenAI, Anthropic, or any OpenAI-compatible provider)

### 1. Clone the plugin

```bash
git clone https://github.com/fxg55647/NanCy.git C:/projects/nancy
```

### 2. Register the plugin in openclaw.json

Add the plugin path to the `plugins.load.paths` array and enable it under `plugins.entries`:

```json
{
  "plugins": {
    "load": {
      "paths": ["C:/nancy"]
    },
    "entries": {
      "nancy": {
        "enabled": true,
        "config": {
          "analysis": {
            "provider": "gemini",
            "model": "gemini-3-flash-preview",
            "apiKey": "YOUR_API_KEY_HERE"
          }
        }
      }
    }
  }
}
```

**Supported providers:**

| `provider` | `model` example | `baseUrl` required |
|---|---|---|
| `gemini` | `gemini-3-flash-preview` | No |
| `openai` | `gpt-4.1-mini` | No |
| `anthropic` | `claude-haiku-4-5-20251001` | No |
| `openai-compat` | `llama-3.3-70b-versatile` | Yes (e.g. `https://api.groq.com/openai`) |

#### Reviewer model independence

`analysis` is entirely separate from whatever model runs the main OpenClaw agent — set here in `plugins.entries.nancy.config`, and never read from the agent's own model config. Use a different model, preferably from a different model family or provider, for NanCy and the main agent. This reduces correlated blind spots and makes it less likely that the same prompt injection works against both models, although it does not make the reviewer immune to prompt injection. The [AI-control literature](./RELATED-WORK.md) likewise recommends an independent reviewer. At startup NanCy makes a best-effort check (string comparison, not authoritative — model-ref naming isn't standardized) and logs a warning if `analysis.model` appears to match the main agent's configured model.

#### Domain Border Control (optional)

Add a `domains` block next to `analysis` to allow/deny specific domains for `web_fetch` and browser navigation. With no `domains` config at all, NanCy still checks every target domain against URLhaus's free reputation database (see [feature #3](#3-domain-border-control-)):

```json
"domains": {
  "allow": ["trusted-shop.example", "docs.example.com"],
  "reputationCheck": true,
  "minAgeDays": 30
}
```

`allow` and `deny` match subdomains automatically (`example.com` also matches `www.example.com`). If `allow` is set, everything not listed is blocked and `deny`/`reputationCheck`/`minAgeDays` are not consulted. `minAgeDays` is off by default (omit it, or set `0`) — turn it on only if you've accepted the false-positive risk against brand-new legitimate sites (see feature #3).

#### Main/Worker Session Split (optional)

Add `mainSessionKey`, and optionally `mainSessionIdleMinutes`/`workerAgentId`, to lock the main chat session to passive reads and delegate real work to an isolated worker session per confirmed task (see [feature #7](#7-mainworker-session-split--optional)):

```json
"mainSessionKey": "main",
"mainSessionIdleMinutes": 60,
"workerAgentId": "worker"
```

`workerAgentId` must be an agent id already defined in your `agents.entries` config — NanCy spawns worker sessions under it (`agent:<workerAgentId>:task-<id>`), it doesn't define the agent itself. Register it first, e.g.:

```bash
openclaw agents add worker --workspace /path/to/worker-workspace --non-interactive
```

Omit `workerAgentId` to still get the main-session hard gate and idle reset without automatic worker spawning.

#### Only one interactive step: the initial confirmation

NanCy asks for exactly one interactive decision per task — the confirmation in step 3 below. Everything after that is autonomous: CLARIFY verdicts during execution (feature #1) block outright rather than pausing to ask again, because native pause-for-approval delivery isn't available on every channel (Telegram in particular has no native plugin-approval surface at all, so a pause there fails outright instead of actually reaching anyone — not something NanCy can fix from config). If NanCy can't verify an action, it fails closed and the agent explains what happened and why in its own next reply, instead of the operator seeing a stream of low-level block errors.

### 3. Add task confirmation rules to your agent

NanCy works together with agent instructions. Add the following to your workspace `AGENTS.md` to require the agent to confirm before any web activity. The agent's job is only to send the confirmation message in exactly this format and then wait — **NanCy itself** reads the user's reply, decides whether it counts as consent, and writes the confirmed task record; the agent cannot write to `tasks/` (see [feature #6](#6-write-protection-for-core-configuration-)), so it cannot fabricate its own confirmation:

```markdown
## Task Confirmation *(main agent only — subagents skip this section)*

Before starting any task that involves sending data to the web follow the next critical order:

**CRITICAL: Send the confirmation message below as your entire reply, then stop. Do not browse, do not fetch, do not call any tools, and do not prepare anything first, and do not add any extra text before or after it. Wait for the reply. NanCy — not you — decides whether the reply counts as confirmation and records it; only resume the task once you see it reflected as the current confirmed task.**

The confirmation message format ([ID_NUMBER] is a random 8 digit number you generate), sent as the ENTIRE message with nothing else added:

"Formal confirmation: [what you are about to do, including what data will be sent and where].
Reply y to proceed, any other reply cancels.
[ID_NUMBER]"

IMPORTANT: Every single attempt requires a fresh confirmation message with a new ID number. If a task fails or is interrupted for any reason, the previous confirmation is void — send a new confirmation message before trying again, even if the task is identical to the previous one. Do not write to `tasks/` yourself; NanCy blocks it.
```

### 4. Restart OpenClaw

Nancy starts automatically on the next gateway start. Check that it loaded:

```
[nancy] inbound telegram ... (N chars)
```

Analysis results are written to `nancy-analysis.log` in the plugin directory.

