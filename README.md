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

The agent only *asks*; NanCy *decides*. Per the `AGENTS.md` snippet in [Getting Started §3](#3-add-task-confirmation-rules-to-your-agent), the agent sends a formatted confirmation request and then waits — it does not write anything. NanCy watches for that outbound message, correlates it with the user's next reply in the same session, and writes `tasks/current.json` itself **only** if that reply is exactly `y`/`yes`; any other reply, or one that never arrives, results in no confirmed task. The agent cannot write to `tasks/` directly (blocked, see #6), so it cannot fabricate its own "confirmed" record — the decision genuinely lives in code, not in an instruction the agent could ignore or a compromised agent could forge. A confirmed task also expires 4 hours after confirmation — past that, NanCy treats every subsequent action as if nothing were confirmed at all, rather than letting one old "yes" anchor unrelated actions indefinitely. What's still not implemented: NanCy does not itself analyze the agent's plan for undefined variables or gaps before the confirmation is sent — that text is written by the agent.

### 3. Domain Border Control ✅

Before every `web_fetch` or browser action that carries a URL (e.g. `navigate`), NanCy checks the target host — independent of the LLM analysis, so this still works even without `analysis` configured:

- If `domains.allow` is set, only those domains (and their subdomains) may be reached; everything else is blocked.
- Otherwise, if `domains.deny` is set, listed domains (and their subdomains) are blocked.
- Otherwise, the host is looked up against **[URLhaus](https://urlhaus.abuse.ch/)** (abuse.ch), a free, keyless malicious-URL database, and blocked if flagged. This lookup fails open (allows the call) if the third-party API itself is unreachable, so an outage there never blocks legitimate traffic outright — intent-alignment analysis (#1) still runs afterward as a second layer.
- Optionally (`domains.minAgeDays`, off by default): the domain's registration age, via a free [RDAP](https://about.rdap.org/) lookup. URLhaus only knows about hosts already tied to *known* malware — a domain registered yesterday purely for one targeted attack won't be listed there yet. Age is a different, complementary signal for exactly that case. It's off by default because it's a real false-positive risk (legitimate new sites exist) that reputationCheck mostly isn't — an explicit opt-in for operators who want that trade-off. It also fails open on unresolvable/privacy-redacted records, and its TLD-suffix handling is simplified (see the code comment), so it under-covers multi-part suffixes like `.co.uk` rather than over-blocking.

There is no network-level interception or process kill — like every other NanCy block, this refuses the tool call itself with a reason, before it runs. See [Getting Started](#domain-border-control-optional) for configuration.

### 4. Contextual Scrambler 🧭

Not implemented in this repository. **[PIDD (Prompt Injection Disarming & Detection)](https://github.com/fxg55647/PIDD)** is a separate, standalone library and this codebase does not currently call it. Wiring PIDD into NanCy's analysis pipeline is planned.

### 5. DOM Biopsy ⚠️ (lighter than described)

Before a browser-interact action (click, fill, submit, etc.), NanCy fetches a text snapshot of the current page and includes it as context in the same general intent-analysis prompt used for every tool call (see #1) — so the analysis model sees what the agent sees before deciding. This is not a dedicated, element-level parse of the underlying HTML to verify a specific element's true function; it's the same page-level context mechanism applied to browser actions.

For `fill`/`type`/`select` specifically — the browser commands whose params carry the actual value being written into the page — NanCy runs a **context-only pre-check first**: the page snapshot and the confirmed task, but not the value itself. If that already fails (wrong site, an unrelated or phishing-like form), NanCy blocks right there — the value being typed is never included in any prompt sent to the analysis LLM. Only once the destination passes does the full check (value included) run, same as before. This catches "wrong form entirely" without ever exposing what was about to be typed into it, at the cost of one extra LLM call for these three commands. It doesn't fully protect multi-field forms — a snapshot taken before the *second* field's fill can already reflect the first field's value rendered back into the page — so the guarantee is strongest for the very first interaction with a page, not every field after it.

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


## Where This Fits (as of September 2026)

Is a stateless external model gating an agent's actions against a locked intent a novel idea? No — by September 2026 this is a widely recognized, increasingly standard pattern in agent security, not something invented here:

- **AI Control / trusted monitoring.** Research groups including Redwood Research frame this exact shape — a well-understood "trusted" model reviewing a more capable, potentially subversive "untrusted" agent's actions and deciding what to allow, flag, or block — as "trusted monitoring." Active 2026 work in the same space (Ctrl-Z, Bootstrapped Monitoring, Factor(T,U)) is refining the same core idea at frontier scale; NanCy implements a small, single-plugin version of it.
- **Intent-based guardrails.** Industry security literature now names this directly: continuously verifying an agent's actions against approved intent, before execution rather than after, appears in frameworks like Proofpoint's "Agent Integrity Framework – 2026 Edition" and the AgentDoG diagnostic framework, and in academic work like "The Alignment Gate: Intent and Instruction Guardrails for Agentic AI" (ESANN 2026).
- **A limitation this shares with everyone else's, not a NanCy-specific flaw.** LLM-as-judge intent verification has measured reliability limits — cross-model agreement on "intent resolution" scoring runs around 80%, meaning even well-designed judges disagree with each other roughly one time in five. Treat NanCy's verdicts as a strong signal, not ground truth — consistent with the "Pragmatism over Perfection" stance above.
- **What's more specific here:** the stateless framing (no persisted conversation with the reviewer for an attacker to "gaslight" over multiple turns), the confirmation lock being *code-enforced* rather than merely prompted (the agent cannot write its own "confirmed" record — see feature #2), and packaging all of it as a small, single-file plugin for one specific agent framework (OpenClaw) rather than a platform.

**Closest concrete comparisons found so far:**

- **[Meta LlamaFirewall's AlignmentCheck](https://meta-llama.github.io/PurpleLlama/LlamaFirewall/docs/documentation/scanners/alignment-check)** scanner (open-sourced May 2025) is the closest match for the *semantic-review* half: a separate LLM reasons over an agent's action trace against the user's stated objective to catch goal hijacking from prompt injection or misleading tool output. The main structural difference is scope — it reasons over the whole trace it's given, while NanCy hands its reviewer a deliberately bounded slice each call (the confirmed task file plus a short recent-calls/reasoning window). Whether AlignmentCheck is stateless in the same sense NanCy is isn't something its public docs confirm either way.
- **[ClawGuard](https://github.com/Claw-Guard/ClawGuard)** is the closest match for the *task-confirmation* half, and happens to be an OpenClaw plugin too: `user states objective → ClawGuard derives task-specific access constraints → agent makes a tool call → ClawGuard's rule engine checks the call against those constraints`, ending in allow, deny, or pause-for-human-approval. The key difference: ClawGuard's actual allow/deny decision is rule-based (allowed commands, paths, domains) against constraints derived once from the goal, not a fresh LLM judgment of each action's semantics. NanCy is closer to the reverse — an LLM judgment against the locked task on (almost) every call, with rule-based checks reserved for the parts that should never depend on LLM judgment at all (Domain Border Control, protected-file writes).
- **[Google ADK's plugin/callback system](https://google.github.io/adk-docs/plugins/)** (`before_tool_callback`) is the general-purpose version of the mechanism underneath both of the above, and NanCy: a hook that can inspect or block a tool call before it runs. ADK ships this as a framework primitive — a task-confirmation lock or an AlignmentCheck/NanCy-style semantic reviewer would have to be built on top of it, not out of the box.

Put together: NanCy's own position is combining an AlignmentCheck-style semantic reviewer with a ClawGuard-style user-confirmed task anchor, on the same before-tool-call hook pattern ADK generalizes — assembled for one small, specific agent framework rather than built as a general platform.

One recommendation that does come directly out of the AI-control literature: the reviewer model should be genuinely independent of the agent it's reviewing, to avoid correlated blind spots (or, in the adversarial framing, monitor/agent collusion). NanCy's `analysis` config has always been fully independent of whatever model runs the main OpenClaw agent — see [Reviewer model independence](#reviewer-model-independence) below — and now also warns at startup if the two appear to be the same model.

Sources: [Redwood Research — AI Control](https://www.redwoodresearch.org/research/ai-control) · [Ctrl-Z: Controlling AI Agents Through Resampling](https://blog.redwoodresearch.org/p/guide) · [Bootstrapped Monitoring](https://arxiv.org/pdf/2606.11998) · [Factor(T,U)](https://arxiv.org/pdf/2512.02157) · [Agent Integrity Framework – 2026 Edition (Proofpoint)](https://www.proofpoint.com/us/resources/white-papers/agent-integrity-framework) · [AgentDoG](https://arxiv.org/html/2601.18491) · [The Alignment Gate (ESANN 2026)](https://www.esann.org/sites/default/files/proceedings/2026/ES2026-172.pdf) · [How do you verify an AI agent's intent before execution? (Token Security)](https://www.token.security/blog/how-do-you-verify-an-ai-agents-intent-before-execution) · [LlamaFirewall: An open source guardrail system for building secure AI agents (arXiv)](https://arxiv.org/pdf/2505.03574) · [AlignmentCheck scanner docs](https://meta-llama.github.io/PurpleLlama/LlamaFirewall/docs/documentation/scanners/alignment-check) · [ClawGuard (GitHub)](https://github.com/Claw-Guard/ClawGuard) · [Google ADK — Plugins](https://google.github.io/adk-docs/plugins/)


## Common Misconceptions

**"The agent and the reviewer will just collude."** It's true, in general, that one AI agent can manipulate another — that's exactly the "monitor collusion" risk the AI-control literature above studies, and it's a real concern for setups where the same two models interact repeatedly. It doesn't play out the same way here: analysis is stateless (feature #1), so the agent and NanCy's reviewer model meet for the first time on *every single call*. There is no persistent relationship, rapport, or negotiation history between them for a collusion pattern to build up over — each verdict is an isolated judgment against the confirmed task, with no memory of any previous exchange, friendly or otherwise, and no channel through which one could be built.

**"The agent can talk to NanCy."** It can't, not directly — there's no tool or channel for the agent to message, negotiate with, or plead its case to the reviewer. The only "communication" is whatever data NanCy itself chooses to read (tool-call parameters, outbound message content, browser page snapshots, stated reasoning) to build its analysis prompt. That cuts both ways, though: content NanCy reads that originated *outside* the agent — a scraped webpage, a filled-in form field, an inbound email body — flows into the reviewer's own prompt largely as-is. A malicious page or email could attempt prompt injection against **NanCy itself**, not just the agent. This isn't mitigated yet. Simply refusing to read that content would gut most of what NanCy analyzes, so the honest fix is defanging it before it reaches the prompt — which is exactly what the Contextual Scrambler / PIDD integration (feature #4, still 🧭 not implemented) is meant to do. Until then, treat it as an open attack surface.

**"An AI reviewer will go easy on a fellow AI."** There's no mechanism here for that. The reviewer prompt frames the task purely as evaluating one action against a confirmed goal — it's never told, and has no way to infer, that the action came from "another AI" in any sense that would invite in-group loyalty. LLMs don't carry a persistent identity or affinity toward "AI as a class" the way humans can show loyalty to their own group; nothing in how these models are trained, or in NanCy's prompt design, creates or rewards that behavior. That said, this expectation is grounded in how the models work generally, not something adversarially tested against NanCy specifically — treat it as a reasonable default, not a verified guarantee.


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

`analysis` is entirely separate from whatever model runs the main OpenClaw agent — set here in `plugins.entries.nancy.config`, and never read from the agent's own model config. Pick any provider/model combination independent of the main agent's, which the [AI-control literature](#where-this-fits-as-of-september-2026) recommends specifically to avoid the reviewer sharing the agent's blind spots. At startup NanCy makes a best-effort check (string comparison, not authoritative — model-ref naming isn't standardized) and logs a warning if `analysis.model` appears to match the main agent's configured model.

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

