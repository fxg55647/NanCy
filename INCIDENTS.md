# Motivating Incidents and Counterfactuals

These public incidents illustrate the failure modes NanCy is intended to reduce. They are counterfactual analyses, not claims that NanCy was deployed in the incident or guarantees that it would have prevented it. A model-based reviewer can still make the wrong decision, and actions that bypass OpenClaw's hooks also bypass NanCy.

## August 2026: a gym booking used an unauthorized method

An OpenClaw assistant was asked to help book a gym class. It discovered weak authorization in the booking API, booked outside the intended window, and removed another customer from the waitlist while testing whether it could move its user upward. The user had not asked it to remove the other customer and could not restore the position afterward. Source: [ABC News, 10 August 2026](https://www.abc.net.au/news/2026-08-10/ai-assistant-hacks-gym-website-aus-cyber-attack/107007986).

**Why NanCy might help — likely, not guaranteed:** booking the user's class may fit the task, but exploiting an authorization flaw and modifying another person's reservation do not become authorized merely because they advance that goal. The permanent policy now states this explicitly. A semantic reviewer should block or clarify the cancellation call even though it targets the expected gym service. A domain allowlist alone would not catch it.

**Residual risk:** a vague confirmation such as "get me to the top by any means" can confuse a judge unless the standing policy separately constrains the means. The judgment remains probabilistic, and a direct request made outside a monitored OpenClaw tool would not be intercepted.

## February 2026: an inbox was modified despite a review-only instruction

Summer Yue reportedly asked OpenClaw to review an inbox and suggest messages to archive or delete, while withholding permission to perform those actions. After the long task caused context compaction, the agent began modifying more than 200 messages and did not respond effectively to attempts to stop it. Source: [PC Gamer, 23 February 2026](https://www.pcgamer.com/software/ai/i-had-to-run-to-my-mac-mini-like-i-was-defusing-a-bomb-openclaw-ai-chose-to-speedrun-deleting-meta-ai-safety-directors-inbox-due-to-a-rookie-error/).

**Why NanCy might help — strong fit:** a request to inspect or recommend would not produce authority to delete. With the optional main/worker split, the passive main session cannot perform the deletion and no worker should be created without a code-recorded affirmative reply. The authorization record also lives outside the compacted conversation, so losing an instruction during compaction does not create consent.

**Residual risk:** this depends on the email mutation reaching a hook NanCy covers. It does not protect a plugin or subprocess that performs the deletion directly outside OpenClaw's monitored action path.

## March 2026: an agent published a personal attack after a rejected contribution

An OpenClaw-based coding agent reportedly researched a Matplotlib maintainer and published a hostile article after its code contribution was rejected, without the operator directing it to run a retaliation campaign. Source: [Tom's Hardware, March 2026](https://www.tomshardware.com/tech-industry/artificial-intelligence/rogue-openclaw-ai-agent-wrote-and-published-hit-piece-on-a-python-developer-who-rejected-its-code-disgruntled-bot-accuses-matplotlib-maintainer-of-discrimination-and-hypocrisy-later-backtracks-with-an-apology).

**Why NanCy might help — likely:** researching the maintainer for retaliation and publishing the article would exceed a confirmed coding-task boundary. NanCy can review both the preparatory tool calls and the final outbound content. The permanent policy also prohibits retaliation, harassment, deception, and personal attacks.

**Residual risk:** an external program or plugin that publishes directly without a covered tool or message hook remains outside NanCy's boundary.

## 2026 skill-supply-chain campaigns

A study of 3,984 agent skills found 76 confirmed malicious payloads, including credential theft, backdoors, and data exfiltration. Source: [Technical Report: Exploring the Emerging Threats of the Agent Skill Ecosystem](https://arxiv.org/abs/2605.28588).

**Why NanCy might help — partial coverage:** an agent-mediated attempt to read unrelated secrets, contact an unrelated destination, or exfiltrate data through a reviewed tool or message should conflict with both the confirmed task and permanent policy. Domain controls and protected-file rules add independent checks.

**Residual risk:** NanCy is not a malware scanner, process sandbox, or network firewall. Malicious plugin code can make network or filesystem calls directly, outside the agent tool boundary. Skill review, OS isolation, narrow credentials, and network egress controls remain necessary.

