// Matches the exact confirmation-request format required in AGENTS.md §3.
export function parseConfirmationRequest(content: string): { id: string; description: string } | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const m = normalized.match(/^Formal confirmation:\s*([\s\S]*?)\s*\nReply y to proceed, any other reply cancels\.\s*\n(\d{6,10})$/);
  if (!m) return null;
  return { description: m[1].trim(), id: m[2].trim() };
}

// Per AGENTS.md §3: only an exact y/Y/Yes/yes reply counts as consent; anything else cancels.
export function isAffirmativeReply(content: string): boolean {
  return /^\s*(y|yes)\s*$/i.test(content);
}
