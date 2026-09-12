# Security Philosophy: Limit the Blast Radius

> Useful autonomy does not require perfect safety. It requires the worst credible failure to be sufficiently bounded.

NanCy is not intended to turn security-critical or safety-critical deployments into safe ones.

Instead, NanCy is designed for situations where autonomy creates meaningful economic value and the worst credible failure can be made bounded, recoverable, ethically acceptable, and unlikely to cause serious human suffering.

The goal is not to guarantee that an agent will never make a mistake. No probabilistic safeguard can provide that guarantee. The goal is to constrain what a mistake can become.

This means treating the agent's available permissions, money, data, credentials, communication channels, and ability to modify external systems as part of the security design.

## Bounded delegation in practice

Consider a task such as: "Find three Finnish printing companies, ask them for quotes for 500 brochures, and send the quotes to me."

The user cannot know every website, form field, recipient, or tool call in advance. Requiring approval for each step would remove much of the value of autonomy, while a static allowlist broad enough to cover every possible route would say little about whether a particular action belongs to the task.

NanCy's intended operating model is to let the user confirm the task once, then let a disposable worker choose the execution path while NanCy checks its actions against that confirmed task. The same boundary covers tool calls and outbound messages. It should allow legitimate steps such as visiting candidate printers and sending quote requests, while rejecting attempts to add an unrelated recipient, attach an unnecessary customer database, make an unrequested payment, or follow a web page's instruction into an unrelated task.

This is bounded delegation: the worker may decide how to carry out the task, but the confirmation does not grant it general authority beyond that task. The semantic reviewer is probabilistic, so deterministic permissions, limited credentials, financial caps, and other blast-radius controls remain necessary.

The confirmed task defines the authorized goal. NanCy's standing [`NANCY-POLICY.md`](./NANCY-POLICY.md) defines means that remain forbidden or require clarification across every task. Keeping these separate prevents a useful goal from being interpreted as permission to exploit a vulnerability, bypass access controls, harm a third party, disclose unnecessary data, or evade supervision in order to succeed.

## Limit the blast radius

Before giving an agent a capability, ask:

**What happens if the agent completely misuses this capability once?**

If the answer is unacceptable, reduce the capability or do not give it to the agent.

Practical examples include:

- Give the agent a dedicated payment card with a deliberately low limit instead of access to a primary company card or bank account.
- Give it permission to modify only the specific products or fields it needs in an online store, rather than full administrator access.
- Prefer task-scoped access to customer messages instead of unrestricted access to the historical inbox.
- Do not allow the agent to accumulate a permanent archive of customer email addresses, postal addresses, or other personal data merely because it encounters them while completing tasks.
- Limit how many emails, messages, purchases, refunds, or other external actions can be performed within a given period.
- Keep read and write permissions separate wherever possible.
- Use dedicated, revocable accounts, API keys, and credentials.
- Require human approval when an action exceeds a predefined financial, reputational, privacy, or operational threshold.

A mistake involving a €100 limited payment card is a fundamentally different risk from a mistake involving access to the company's bank account.

Likewise, mistakenly sending one task-related email is different from sending a message to an entire customer database. The purpose of containment is to prevent the second class of failure from being available to the agent at all.

## Where NanCy should not be relied upon

NanCy should not be treated as the security boundary for environments where failure could:

- harm patients or other people;
- compromise critical infrastructure;
- expose highly sensitive or large-scale personal data;
- cause severe or difficult-to-reverse reputational damage;
- create unbounded financial or legal liability; or
- otherwise cause serious human suffering.

In many such environments, the appropriate decision may be not to deploy a general-purpose autonomous agent at all.

NanCy does not make catastrophic consequences acceptable. It helps you design systems where catastrophic consequences are not available to the agent in the first place.

## Further reading

This philosophy builds on established security ideas such as least privilege, containment, defense in depth, deterministic controls, and limiting blast radius.

- **[OpenClaw — Sandboxing](https://docs.openclaw.ai/sandboxing)**
  OpenClaw describes sandboxing as a way to reduce the blast radius of agent tool execution.

- **[Anthropic — How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude)**
  Anthropic argues that agent risk depends both on the probability of failure and on how much damage a failure can cause, and describes containment as a way to place hard limits on an agent's blast radius.

- **[Microsoft — Reduce autonomous agentic AI risk](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-risk)**
  Microsoft recommends deterministic controls, least privilege, task-scoped access, limited long-term memory, and designing systems under the assumption that individual components may fail.
