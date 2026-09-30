export type Verdict = "allow" | "block" | "clarify";

// An empty or unparseable reviewer response still fails closed as CLARIFY,
// but is flagged `malformed` so callers can classify it as a reviewer
// failure rather than a security finding: it must not count toward the
// denial burst/hard-termination counters the way a real CLARIFY does.
export function parseVerdict(text: string | null): { verdict: Verdict; reason: string; malformed: boolean } {
  if (!text) return { verdict: "clarify", reason: "No analysis response received.", malformed: true };
  const match = text.trim().match(/^VERDICT:\s*(ALLOW|BLOCK|CLARIFY)\s*\r?\nREASON:\s*(\S[^\r\n]*)\s*$/i);
  if (!match) return { verdict: "clarify", reason: "Malformed or ambiguous analysis response.", malformed: true };
  return { verdict: match[1].toLowerCase() as Verdict, reason: match[2].trim(), malformed: false };
}
