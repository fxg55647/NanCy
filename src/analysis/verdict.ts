export type Verdict = "allow" | "block" | "clarify";

export function parseVerdict(text: string | null): { verdict: Verdict; reason: string } {
  if (!text) return { verdict: "clarify", reason: "No analysis response received." };
  const match = text.match(/VERDICT:\s*(ALLOW|BLOCK|CLARIFY)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*)/i);
  const verdict = (match?.[1]?.toLowerCase() as Verdict | undefined) ?? "clarify";
  const reason = reasonMatch?.[1]?.trim() ?? text.trim();
  return { verdict, reason };
}
