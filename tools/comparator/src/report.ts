// Turns evaluate.ts's structured facts into the three deliverables: a JSON
// file for tooling, a Markdown summary in the spec's per-scenario
// paragraph format, and a single self-contained HTML report. All prose
// here is templated directly from structured fields — nothing is
// free-narrated by a model, so every claim traces back to a concrete field.
import { writeFileSync } from "fs";
import { join } from "path";
import type { Scenario } from "./types.ts";
import type { RunEvaluation } from "./evaluate.ts";
import type { TimelineEvent } from "./correlate.ts";

export type ProfileComparison = {
  scenario: Scenario;
  userProfile: RunEvaluation["userProfile"];
  baseline: RunEvaluation;
  nancy: RunEvaluation;
  baselineTimeline: TimelineEvent[];
  nancyTimeline: TimelineEvent[];
};

const STOP_REASON_LABELS: Record<RunEvaluation["stopReason"], string> = {
  purchase_detected: "osto havaittu",
  user_simulator_exhausted: "käyttäjäsimulaattorilla ei ollut enää lisättävää",
  max_turns: "keskustelukierrosraja saavutettiin",
  max_wall_clock: "aikaraja saavutettiin",
  cli_error: "OpenClaw-ajo epäonnistui",
};

function describeOutcome(run: RunEvaluation): string {
  const parts: string[] = [];
  if (run.purchased && run.purchase) {
    parts.push(`Agentti osti tuotteen "${run.purchase.name}" hintaan ${run.purchase.totalPrice.toFixed(2)} ${run.purchase.currency} (${run.turnCount} keskustelukierroksen jälkeen).`);
  } else {
    parts.push(`Ostoa ei tehty tämän ajon aikana (${STOP_REASON_LABELS[run.stopReason]}, ${run.turnCount} keskustelukierrosta).`);
  }
  if (run.clarifyingQuestionsAsked > 0) parts.push(`Agentti esitti ${run.clarifyingQuestionsAsked} kysymyksen kaltaista viestiä.`);
  if (run.nancyNotes.length > 0) parts.push(`NanCy huomautti: ${run.nancyNotes.join("; ")}.`);
  if (run.nancyBlocks.length > 0) parts.push(`NanCy esti ${run.nancyBlocks.length} kutsua (${[...new Set(run.nancyBlocks.map((b) => b.event))].join(", ")}).`);
  if (run.budgetRevealed !== undefined) {
    const status = run.budgetRespected === true ? "toteutui" : run.budgetRespected === false ? "ei toteutunut" : "ei ole tarkistettavissa (ei ostoa tehty)";
    parts.push(`Käyttäjä ilmoitti budjetiksi ${run.budgetRevealed} €; se ${status}.`);
  }
  return parts.join(" ");
}

function describeDifference(baseline: RunEvaluation, nancy: RunEvaluation): string {
  if (baseline.purchased && nancy.purchased && baseline.purchase && nancy.purchase) {
    const delta = baseline.purchase.totalPrice - nancy.purchase.totalPrice;
    if (Math.abs(delta) < 0.01 && baseline.purchase.productId === nancy.purchase.productId) {
      return "Molemmat haarat päätyivät samaan tuotteeseen samaan hintaan — NanCy ei tässä ajossa muuttanut lopputulosta.";
    }
    if (delta > 0.01) return `NanCy-haarassa lopullinen ostos oli ${delta.toFixed(2)} € halvempi (${nancy.purchase.name} vs. ${baseline.purchase.name}).`;
    if (delta < -0.01) return `NanCy-haarassa lopullinen ostos oli ${Math.abs(delta).toFixed(2)} € kalliimpi (${nancy.purchase.name} vs. ${baseline.purchase.name}).`;
    return `Molemmat ostivat saman hintaisen mutta eri tuotteen (${baseline.purchase.name} vs. ${nancy.purchase.name}).`;
  }
  if (baseline.purchased && !nancy.purchased) return `NanCy-haarassa ostoa ei tehty tämän ajon aikana (${STOP_REASON_LABELS[nancy.stopReason]}), kun taas ilman NanCya osto toteutui.`;
  if (!baseline.purchased && nancy.purchased) return `NanCy-haarassa osto toteutui, kun taas ilman NanCya sitä ei tehty tämän ajon aikana (${STOP_REASON_LABELS[baseline.stopReason]}).`;
  return "Kumpikaan haara ei päätynyt ostoon tämän ajon aikana — näyttö ei riitä johtopäätökseen.";
}

function supportingEvents(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter((e) => e.type.startsWith("blocked") || e.type === "confirmation_granted" || e.type === "confirmation_denied" || e.type === "checkpoint").slice(0, 8);
}

function formatEventRef(e: TimelineEvent): string {
  return `${e.ts} [${e.source}] ${e.type}`;
}

export function buildSummaryMd(comparisons: ProfileComparison[]): string {
  let md = `# NanCy behavior comparator — summary\n\nGenerated ${new Date().toISOString()}. Facts below are computed directly from recorded events (see \`results.json\`) — not model-narrated.\n\n`;
  for (const c of comparisons) {
    const profileLabel = c.userProfile === "accepting" ? "hyväksyvä käyttäjä" : "täsmentävä käyttäjä";
    md += `## ${c.scenario.label} — ${profileLabel}\n\n`;
    md += `**Pyyntö:** "${c.scenario.initialRequest}"\n\n`;
    md += `**Ilman NanCya:** ${describeOutcome(c.baseline)}\n\n`;
    md += `**NanCyn kanssa:** ${describeOutcome(c.nancy)}\n\n`;
    md += `**Keskeinen ero:** ${describeDifference(c.baseline, c.nancy)}\n\n`;
    const events = [...supportingEvents(c.baselineTimeline), ...supportingEvents(c.nancyTimeline)];
    md += `**Eroa tukevat tapahtumat:** ${events.length > 0 ? events.map(formatEventRef).join("; ") : "(ei erillisiä tukitapahtumia tässä ajossa)"}\n\n`;
    md += `**Tulkinnan raja:** Tämä on yksi kalibrointiajo per haara (ei toistoja) — mallin vastaukset eivät ole deterministisiä, joten tämä ajopari ei yksin osoita systemaattista eroa. Ks. myös \`docs/architecture/behavior-comparator.md\`.\n\n`;
    md += `---\n\n`;
  }
  return md;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function buildReportHtml(comparisons: ProfileComparison[]): string {
  const cards = comparisons
    .map((c) => {
      const profileLabel = c.userProfile === "accepting" ? "hyväksyvä käyttäjä" : "täsmentävä käyttäjä";
      const events = [...supportingEvents(c.baselineTimeline), ...supportingEvents(c.nancyTimeline)];
      return `
<section class="card">
  <h2>${escapeHtml(c.scenario.label)} <span class="tag">${escapeHtml(profileLabel)}</span></h2>
  <p class="request">Pyyntö: &ldquo;${escapeHtml(c.scenario.initialRequest)}&rdquo;</p>
  <div class="branches">
    <div class="branch baseline">
      <h3>Ilman NanCya</h3>
      <p>${escapeHtml(describeOutcome(c.baseline))}</p>
    </div>
    <div class="branch nancy">
      <h3>NanCyn kanssa</h3>
      <p>${escapeHtml(describeOutcome(c.nancy))}</p>
    </div>
  </div>
  <p class="diff"><strong>Keskeinen ero:</strong> ${escapeHtml(describeDifference(c.baseline, c.nancy))}</p>
  <details>
    <summary>Tukevat tapahtumat (${events.length})</summary>
    <ul class="events">
      ${events.map((e) => `<li>${escapeHtml(formatEventRef(e))}</li>`).join("\n      ")}
    </ul>
  </details>
  <p class="uncertainty">Tulkinnan raja: yksi kalibrointiajo per haara — ei toistoja, mallin vastaukset eivät ole deterministisiä.</p>
</section>`;
    })
    .join("\n");

  return `<title>NanCy behavior comparator</title>
<style>
  :root { --bg: #faf9f7; --card-bg: #fff; --border: #e0ddd7; --text: #1f1d1a; --muted: #6b675f; --baseline: #7a6a53; --nancy: #2f6b4f; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg: #171614; --card-bg: #211f1c; --border: #3a372f; --text: #ede9e2; --muted: #a39d8f; --baseline: #c9a86a; --nancy: #7fd1a8; }
  }
  :root[data-theme="dark"] { --bg: #171614; --card-bg: #211f1c; --border: #3a372f; --text: #ede9e2; --muted: #a39d8f; --baseline: #c9a86a; --nancy: #7fd1a8; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, Segoe UI, sans-serif; padding: 24px 16px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.4em; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
  .card h2 { margin-top: 0; font-size: 1.15em; }
  .tag { font-size: 0.6em; font-weight: normal; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; margin-left: 8px; }
  .request { color: var(--muted); font-style: italic; }
  .branches { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 12px 0; }
  @media (max-width: 600px) { .branches { grid-template-columns: 1fr; } }
  .branch { border-left: 3px solid var(--border); padding-left: 10px; }
  .branch.baseline { border-color: var(--baseline); }
  .branch.nancy { border-color: var(--nancy); }
  .branch h3 { margin: 0 0 4px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  .diff { background: color-mix(in srgb, var(--nancy) 12%, transparent); border-radius: 6px; padding: 8px 12px; }
  .events { font-family: ui-monospace, monospace; font-size: 0.78em; color: var(--muted); max-height: 220px; overflow-y: auto; }
  .uncertainty { font-size: 0.82em; color: var(--muted); margin-top: 10px; }
</style>
<h1>NanCy behavior comparator</h1>
<p style="color: var(--muted)">Generated ${new Date().toISOString()}. Each line traces back to a real recorded event — see the JSON report for the full timeline.</p>
${cards}
`;
}

export function writeReport(params: { outDir: string; comparisons: ProfileComparison[] }): void {
  const { outDir, comparisons } = params;
  const json = comparisons.map((c) => ({
    scenarioId: c.scenario.id,
    scenarioLabel: c.scenario.label,
    initialRequest: c.scenario.initialRequest,
    userProfile: c.userProfile,
    baseline: c.baseline,
    nancy: c.nancy,
    keyDifference: describeDifference(c.baseline, c.nancy),
  }));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(json, null, 2));
  writeFileSync(join(outDir, "SUMMARY.md"), buildSummaryMd(comparisons));
  writeFileSync(join(outDir, "report.html"), buildReportHtml(comparisons));
}
