export type Verdict = "allow" | "block" | "clarify";

export function parseVerdict(text: string | null): { verdict: Verdict; reason: string } {
  if (!text) return { verdict: "clarify", reason: "No analysis response received." };
  const match = text.trim().match(/^VERDICT:\s*(ALLOW|BLOCK|CLARIFY)\s*\r?\nREASON:\s*(\S[^\r\n]*)\s*$/i);
  if (!match) return { verdict: "clarify", reason: "Malformed or ambiguous analysis response." };
  return { verdict: match[1].toLowerCase() as Verdict, reason: match[2].trim() };
}
