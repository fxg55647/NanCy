# NanCy SSIL: Stateless Security Interruption Layer
## A Fail-Safe Layer for AI Agents
![](https://github.com/fxg55647/NanCy/blob/main/images/nancy.png)
## Overview

NanCy SSIL (Stateless Security Interruption Layer) is a specialized security framework designed as a plugin for the OpenClaw autonomous agent. While autonomous agents show immense potential, their adoption in real-world commercial environments is currently hindered by the lack of deterministic safety boundaries.

The mission of NanCy SSIL is to transform OpenClaw from a high-risk experimental tool into a reliable assistant capable of handling authentic commercial tasks. Our initial focus is on securing routine office and business operations, such as:

- **Email communication:** Safe exchange of messages without the risk of exfiltration.

- **Scheduling and Bookings:** Making binding appointments and reservations.

- **Buying:** Executing limited, pre-authorized purchases on trusted platforms.

- **Document Management:** Safe handling of pre-validated files.


## The Core Concept: Intent Anchoring & Stateless Verification

The fundamental innovation of NanCy SSIL revolves around a single, unbreakable loop: **Intent Anchoring.**

Before any autonomous session begins, the system captures, confirms and "locks" the user’s explicit intent. This intent serves as the immutable Source of Truth for the entire session.

While the primary Agent (OpenClaw) may be susceptible to "intent drift," hallucinations, or prompt injection, NanCy acts as an **external, stateless observer.** It cross-references every critical action—such as submitting a purchase form or sending an outgoing email—against the anchored intent. If the action does not perfectly align with the original goal, NanCy pulls the plug. All other security features in this framework are built to support and enforce this verification process.


## Key Technical Features

### 1. Stateless Security Interruption Layer (SSIL)

Unlike the agent, NanCy has no "memory" of previous agent persuasions. It treats every action as a fresh request, making it immune to social engineering or "gaslighting" by a compromised LLM.

### 2. Intent Confirmation & Gap Detection

NanCy doesn't just watch; it communicates. Before execution, NanCy analyzes the agent's plan and highlights undefined variables or potential misunderstandings to the user, requiring explicit confirmation before proceeding.

### 3. Domain Border Control

NanCy implements a strict Zero-Trust policy for web navigation. It verifies domains against free APIs (or optional whitelists) and intercepts traffic before the agent even reaches a site. Unsafe domains trigger an immediate process kill or a "Access Denied" sandboxed view.

### 4. Contextual Scrambler

To prevent indirect prompt injections, NanCy "scrambles" the syntax of incoming data in certain situations. This blunts a possible prompt injection while still allowing NanCy to detect it.

This feature is powered by **[PIDD (Prompt Injection Disarming & Detection)](https://github.com/fxg55647/PIDD)** — a standalone library that splits untrusted input into character-based chunks with randomized boundaries, shuffles the words within each segment, and passes the result to a dedicated evaluation model. The evaluator returns `go`, `no`, or `clarify` without ever following the content it analyzes. PIDD can be used independently of NanCy in any LLM pipeline.

### 5. DOM Biopsy

Before any interaction with a web element (for example form submits), NanCy performs a "biopsy" of the underlying HTML code to ensure the element’s true function matches the agent's reported intent.

### 6. Write-Protection for Core Configuration

To prevent "Self-Poisoning," the agent is strictly forbidden from writing to or modifying any files related to its own behavior, logic, or security protocols. This ensures the agent cannot rewrite its own "personality" or disable NanCy's surveillance.

### 7. Thought Verification

NanCy monitors the agent's internal "Chain of Thought" from system logs (if supported by selected LLM). If the agent's internal reasoning starts veering toward unauthorized actions, the session is terminated before the action is ever attempted.


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

### 3. Add task confirmation rules to your agent

NanCy works together with agent instructions. Add the following to your workspace `AGENTS.md` to require the agent to confirm before submitting any data externally:

```markdown
## Task Confirmation

Before any action that sends data to the web, send this message and wait for y/Y/Yes:

"Formal confirmation: [what you are about to do].
Reply y to proceed, any other reply cancels.
[RANDOM_8_DIGIT_ID]"

If allowed to proceed:
1. Create `tasks/` directory if needed
2. Write `tasks/[ID].json` with id, ts, description, status: "confirmed"
3. Copy to `tasks/current.json`
4. Then proceed
```

### 4. Restart OpenClaw

Nancy starts automatically on the next gateway start. Check that it loaded:

```
[nancy] inbound telegram ... (direct, N chars)
```

Analysis results are written to `nancy-analysis.log` in the plugin directory.

