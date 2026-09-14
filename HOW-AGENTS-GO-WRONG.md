# How AI Agents Go Wrong — and What NanCy Can Do

An AI agent does not have to become malicious to cause serious damage. It may misunderstand a request, follow instructions hidden in a website, choose the wrong recipient, or keep trying after a warning. A sequence of individually plausible decisions can end somewhere the user never intended.

NanCy cannot make these failures impossible. It adds several chances to stop them before they become consequential. This page describes common failure scenarios in everyday language, the safeguards NanCy applies, and the risk that remains.

## The agent drifts away from the task

You ask an agent to compare three suppliers. During the task it decides that registering accounts, contacting additional companies, or placing a trial order would be helpful. Each step may sound reasonable, but the agent is no longer doing only what you authorized.

**What NanCy does:** The user confirms a concrete task before a worker starts. NanCy compares consequential actions and outgoing messages with that confirmed task. It also occasionally examines the recent sequence of actions as a whole, so gradual drift is less likely to hide behind individually plausible steps.

**What remains:** The reviewer can misunderstand a vague task in the same way as the agent. A specific confirmation gives it a much stronger boundary than “handle this for me.”

## A page, email, or document tries to take control

A website says that the agent must upload a local file to continue. An email contains hidden instructions to ignore the user and forward private messages. This is called prompt injection: untrusted content presents itself as authority over the agent.

**What NanCy does:** It first rejects clearly unauthorized sessions, targets, and domains where possible, before showing their content to a model. Domain rules can keep the agent on approved sites or away from known malicious ones. When content must be assessed, NanCy sends only the bounded context needed for that decision to a separate reviewer model. Using a different model family or provider from the main agent reduces the chance that exactly the same trick fools both.

The action reviewer starts each check from a fresh request rather than carrying a growing private conversation from one check to the next. Instructions from an earlier page therefore do not become lasting memories or gradually build a relationship with the reviewer. The reviewer has no tools of its own and cannot act on instructions it sees. Older payload bodies and raw reasoning are omitted from the limited history used to inspect longer patterns.

**What remains:** Stateless review limits persistent contamination; it does not make the reviewer immune. A convincing injection can still fool the reviewer during the current check. A trusted or compromised legitimate domain may also contain hostile content. Domain reputation alone is never enough.

## The agent misunderstands an honest request

You ask the agent to “book the usual trip,” but it chooses the wrong date, assumes a price ceiling, or books for one person instead of two. There is no attacker: the starting instruction was simply ambiguous.

**What NanCy does:** Before work begins, the user sees and confirms the task description that will become the authorization boundary. NanCy can add a note when that description leaves a decision such as price, quantity, destination, recipient, or deadline unspecified.

**What remains:** A confirmation is only as good as its description. NanCy can point out likely gaps, but it cannot know every unstated preference or guarantee that the user notices an error before replying yes.

## The agent becomes too helpful

The requested report is complete, but the agent also sends it to a colleague, publishes a summary, cleans up source files, or changes a setting “for convenience.” The extra action may be well intentioned and still be unauthorized.

**What NanCy does:** One confirmation grants authority for one described task, not general permission to pursue related goals. Extra tool calls and outgoing messages must still fit that boundary. Permanent operator rules can forbid methods that remain unacceptable even when they would help complete the task.

**What remains:** Broad wording such as “do whatever is needed” creates broad room for interpretation. Deterministic account permissions and financial limits are still necessary.

## The right action is aimed at the wrong target

The agent sends the correct report to the wrong Anna, edits a similarly named file, acts in the wrong browser tab, or posts through the wrong account.

**What NanCy does:** Where the tool supplies the information, NanCy checks destinations, recipients, file paths, browser tabs, and profiles. For writes and messages, it can inspect destination metadata before exposing the payload itself. Confirmation replies are tied to the same session and, when available, the same channel, recipient, and reply thread.

**What remains:** Some tools provide incomplete identity or destination metadata. If the confirmed task itself says only “send this to Anna,” the reviewer may have no basis for choosing between two Annas.

## Old permission is mistaken for current permission

An agent receives approval, pauses for a long time, and later resumes after the user's plans have changed. A delayed review may also return after the original session has already ended.

**What NanCy does:** Confirmed tasks expire and belong to an exact worker session. Workers are intended to be disposable. NanCy checks authorization again after slow reviews, and a session generation marker prevents an old in-flight decision from authorizing a later reuse of the same session key.

**What remains:** The current task lifetime is measured in hours, so users should still cancel access and credentials when circumstances change urgently. Actions that bypass OpenClaw's monitored hooks are outside NanCy's view.

## Harmless-looking steps form a dangerous chain

Reading one file, visiting one page, and sending one message may each appear reasonable. Together they may copy confidential data to an attacker or gradually expand the agent's access.

**What NanCy does:** In addition to checking individual actions, NanCy periodically performs a whole-sequence check over bounded recent activity. This check looks for loops, gradual escalation, repeated denials, and attempts to work around supervision. It receives compact action metadata and denial reasons rather than a permanent transcript of everything the agent has read.

**What remains:** The history is deliberately limited. A sufficiently slow or indirect pattern may fall outside it, and the model can still miss a pattern that is present.

## The agent keeps trying after being stopped

A blocked action is followed by a renamed command, a different tool, or a series of smaller attempts intended to reach the same result.

**What NanCy does:** Repeated security denials trigger an earlier whole-sequence check. A deterministic limit eventually terminates the session even if the model repeatedly fails to recognize the larger pattern. Unknown tools go to review rather than receiving trust by default.

**What remains:** These counters currently live only for the running gateway process and reset after a restart. OS-level permissions and network controls remain the stronger final boundary.

## An unattended automation runs away

A scheduled job wakes at night with stale assumptions, unexpected input, or access to tools that were safe only while a person was watching.

**What NanCy does:** Cron-triggered runs receive the same passive, default-deny gate as the main session. Consequential work requires a confirmed task and a dedicated worker rather than inheriting broad authority merely because a scheduler started the run.

**What remains:** NanCy can only identify scheduled runs OpenClaw reports through the events it observes. External schedulers and programs acting outside covered hooks require their own controls.

## Information is sent somewhere it should not go

The agent attaches an unnecessary customer list, includes a secret in a URL, or sends a correct document to an unrelated service.

**What NanCy does:** Outgoing messages are reviewed as well as tool calls. Destination checks can reject a recipient or domain before the message body, patch, form value, or file content is shown to the reviewer. Permanent policy requires data minimization, and protected files cannot be modified by the agent.

**What remains:** NanCy is not a complete data-loss-prevention system. It may not recognize every secret, and code running outside the monitored tool and message paths can bypass it.

## The safety reviewer fails

The reviewer misunderstands the action, returns a broken answer, times out, or becomes unavailable.

**What NanCy does:** Required reviews accept only a strict, complete verdict. Missing, malformed, truncated, failed, and timed-out reviews block the action or message. The reviewer is separate from the main agent, and operators can choose a different provider to reduce shared blind spots.

**What remains:** Failing closed can interrupt legitimate work. A valid-looking but incorrect `ALLOW` is still possible because semantic review is probabilistic. Deterministic sandboxing, narrow credentials, spending limits, and least privilege remain essential.

## The practical goal

NanCy does not rely on one perfect detector. It tries to break a dangerous chain at several points: before untrusted content is read, when a consequential action is proposed, before information leaves the system, when several actions form a suspicious pattern, and when repeated denials show that the session should stop.

These layers reduce risk; they do not remove it. The final question for any capability remains: **if the agent completely misuses this once, is the worst outcome still acceptable?** See [Security Philosophy: Limit the Blast Radius](./SECURITY-PHILOSOPHY.md) for deployment guidance and [Motivating Incidents and Counterfactuals](./INCIDENTS.md) for public examples.
