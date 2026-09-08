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

Each tool call — and each outbound message the agent sends through any channel — is judged by a fresh, one-shot LLM request with no persisted conversation of its own — the analysis model can't be talked around turn-by-turn the way a chatty, stateful guard could. It is given a snapshot of relevant facts (the confirmed task, recent tool calls, recent stated reasoning) as plain context in that single prompt, not a running relationship it can be "gaslit" into trusting. Covering outbound messages, not just tool calls, matters because some channels (email via OpenClaw's `imap` extension, for one) dispatch content through message delivery rather than a distinct tool — `before_tool_call` alone would never see it. Outbound-message analysis has one limitation tool-call analysis doesn't: there's no "pause and ask" option for a message in flight, so an uncertain CLARIFY verdict is treated as BLOCK, and analysis failures fail *open* (the message still sends) rather than fail-safe, since muting the agent entirely isn't a graceful fallback either.

### 2. Intent Confirmation & Gap Detection ✅ confirmation / 🧭 gap detection

The agent only *asks*; NanCy *decides*. Per the `AGENTS.md` snippet in [Getting Started §3](#3-add-task-confirmation-rules-to-your-agent), the agent sends a formatted confirmation request and then waits — it does not write anything. NanCy watches for that outbound message, correlates it with the user's next reply in the same session, and writes `tasks/current.json` itself **only** if that reply is exactly `y`/`yes`; any other reply, or one that never arrives, results in no confirmed task. The agent cannot write to `tasks/` directly (blocked, see #6), so it cannot fabricate its own "confirmed" record — the decision genuinely lives in code, not in an instruction the agent could ignore or a compromised agent could forge. What's still not implemented: NanCy does not itself analyze the agent's plan for undefined variables or gaps before the confirmation is sent — that text is written by the agent.

### 3. Domain Border Control ✅

Before every `web_fetch` or browser action that carries a URL (e.g. `navigate`), NanCy checks the target host — independent of the LLM analysis, so this still works even without `analysis` configured:

- If `domains.allow` is set, only those domains (and their subdomains) may be reached; everything else is blocked.
- Otherwise, if `domains.deny` is set, listed domains (and their subdomains) are blocked.
- Otherwise, the host is looked up against **[URLhaus](https://urlhaus.abuse.ch/)** (abuse.ch), a free, keyless malicious-URL database, and blocked if flagged. This lookup fails open (allows the call) if the third-party API itself is unreachable, so an outage there never blocks legitimate traffic outright — intent-alignment analysis (#1) still runs afterward as a second layer.

There is no network-level interception or process kill — like every other NanCy block, this refuses the tool call itself with a reason, before it runs. See [Getting Started](#domain-border-control-optional) for configuration.

### 4. Contextual Scrambler 🧭

Not implemented in this repository. **[PIDD (Prompt Injection Disarming & Detection)](https://github.com/fxg55647/PIDD)** is a separate, standalone library and this codebase does not currently call it. Wiring PIDD into NanCy's analysis pipeline is planned.

### 5. DOM Biopsy ⚠️ (lighter than described)

Before a browser-interact action (click, fill, submit, etc.), NanCy fetches a text snapshot of the current page and includes it as context in the same general intent-analysis prompt used for every tool call (see #1) — so the analysis model sees what the agent sees before deciding. This is not a dedicated, element-level parse of the underlying HTML to verify a specific element's true function; it's the same page-level context mechanism applied to browser actions.

### 6. Write-Protection for Core Configuration ✅

NanCy actively blocks any `write` or `edit` tool call whose target path resolves to `AGENTS.md`, `IDENTITY.md`, `MEMORY.md`, NanCy's own `src/index.ts` / `openclaw.plugin.json`, or anywhere under `tasks/` (now written exclusively by NanCy itself, see #2) — this block is unconditional and does not depend on the LLM analysis being configured or correct. Separately, at startup NanCy also audits whether the individual protected files are OS-writable and warns if they are (`chmod`-level protection is still recommended as defense in depth, since the audit only warns and doesn't itself change file permissions).

### 7. Stated-Reasoning Context ✅

NanCy has no access to a model's hidden internal reasoning — most providers don't expose it, and NanCy makes no claim to read it. When the agent explicitly shares its reasoning in an outgoing message (prefixed with `Reasoning:`), NanCy keeps the last few such statements and feeds them as extra context into the analysis of the agent's next tool calls. If that stated reasoning points toward an unauthorized action, NanCy can block or require approval for the next tool call — it does not terminate the session outright, and it has no visibility into reasoning the agent never states out loud.


## The Philosophy: Assume Compromise & Pragmatic Safety

We operate on the principle that the agent is perpetually at risk of being confused or poisoned. We don't try to make the AI "perfect"; we make the environment **safe enough for profitable use** in many business cases.

**If the agent cannot be trusted, the supervision must be.**

### **Pragmatism over Perfection**

Our goal is not to achieve "unbreakable" absolute security—as such a thing rarely exists—but to provide a **significant improvement** over the current state of autonomous AI, especially OpenClaw. We are building a system that makes the commercial use of agents **rational, profitable and manageable.**

### **Safe Failure: The Right to Give Up**

In the NanCy SSIL framework, it is perfectly acceptable—and often encouraged—for the agent to fail.

- It is okay for the agent to occasionally report: *"I have stopped the operation because I could not verify the safety of this action."* \* It is okay for the agent to occasionally ask: *"I am unsure if this intent matches your goal. Please intervene."*

**A failed task is a minor inconvenience; an unauthorized credit card drain is a catastrophe.** NanCy SSIL ensures that when the system fails, it fails safely.


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

#### Domain Border Control (optional)

Add a `domains` block next to `analysis` to allow/deny specific domains for `web_fetch` and browser navigation. With no `domains` config at all, NanCy still checks every target domain against URLhaus's free reputation database (see [feature #3](#3-domain-border-control-)):

```json
"domains": {
  "allow": ["trusted-shop.example", "docs.example.com"],
  "reputationCheck": true
}
```

`allow` and `deny` match subdomains automatically (`example.com` also matches `www.example.com`). If `allow` is set, everything not listed is blocked and `deny`/`reputationCheck` are not consulted.

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

