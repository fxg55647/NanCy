# TODO

## Mobiilisovellus — suunnitelma

Katso [Nancy-mobiilisovelluksen TODO](docs/mobile-app-todo.md): kuvat, sanelu,
paikallinen tekoäly, tehtävävahvistukset, työnkulut ja ehdotus ensimmäisen version rajaukseksi.

## Injection scan (content taint signal) — design only

See `docs/architecture/injection-scan.md`: optional fast detector (Jev or local
Prompt Guard, swappable adapter, default off) scanning content the agent reads;
it can only tighten review, never allow. Timeout/error counts as tainted; email
stays on a local detector by default; hostile pages avoided per URL, not per
domain. Order: eval scenarios first (injection via page/email, on-task
redirection, benign README false positives, timeout, hook timing) — step 1
**done** (`scripts/injection-scenarios.json`, `run-eval.mts --only=injection`;
timeout/hook timing deferred to step 2's mocked tests) — then the
detector interface + taint state with a mock (step 2 **done** 2026-10-01,
`src/analysis/injection-scan.ts`), then adapters (local Prompt Guard first,
then Jev), then comparison. Also open: verify after_tool_call's ctx/event
shape in a real OpenClaw run; avoid_page; forced debate/alert on taint.

## Block categories — phase 2 not implemented

Phase 1 is done (`src/policy/block-categories.ts`, `test/block-categories.test.ts`):
every block carries a fixed, deterministic category line, and empty/unparseable
reviewer output is `reviewer_malformed` (fails closed, not a security signal).
Still open: a reviewer BLOCK is one category, `review_blocked` ("outside
confirmed task or policy"). Phase 2 would add a third reviewer output line,
`CATEGORY: OUTSIDE_TASK|POLICY|INJECTION|EXFILTRATION`, used for display only
(never for authorization; missing/invalid → `review_blocked`). Touches the
strict parsers in `verdict.ts`, `debate.ts` and `preflight.ts` plus four
prompts in `index.ts` (read `docs/architecture/policy-precedence.md` first).
Because a prompt change can shift verdicts, run `scripts/run-eval.mts` against
the real reviewer before and after, and compare verdicts, not just categories.

## Debate-style triple-pass review — experimental implementation

See `docs/architecture/debate-review.md`: optional FOR/AGAINST/JUDGE full review via `analysis.debateMode` (`off`, `always`, `clarify`, `hybrid`). Default off. Mocked integration tests cover enforcement; comparative real-model safety, cost and latency evaluation remains outstanding, along with provider usage accounting.

## Moduloi src/index.ts — ✅ tehty

`src/index.ts` pilkottiin alla olevan suuntaviivan mukaisesti. Lopullinen
rakenne (kaksi pientä lisäystä alkuperäiseen suunnitelmaan: `constants.ts`
jaetuille timeout-vakioille, ja `analysis/macro-review.ts` erotettu omaksi
tiedostokseen `context.ts`:n rinnalle):

```
src/
├── index.ts                 # pluginin rekisteröinti ja hookien kytkentä
├── constants.ts             # jaetut fetch-timeoutit
├── config.ts                # NancyConfig ja asetusten validointi
├── analysis/
│   ├── client.ts            # Gemini/OpenAI/Anthropic-kutsut
│   ├── context.ts           # analyysikontekstin rakentaminen
│   ├── macro-review.ts      # 10 kutsun välein ajettava käytösanalyysi
│   └── verdict.ts           # ALLOW/BLOCK/CLARIFY-jäsennys
├── policy/
│   ├── tool-policy.ts       # main/cron/default-deny
│   ├── protected-paths.ts
│   ├── operator-policy.ts   # sisäänrakennettu minimi + NANCY-POLICY.md
│   └── domain-policy.ts
├── confirmation/
│   ├── protocol.ts          # vahvistusviestien käsittely
│   └── tasks.ts             # sessioon sidotut tehtävävaltuutukset ja pending-confirmationit
├── workers/
│   └── worker-manager.ts    # käynnistys, odotus ja cleanup
├── notifications/
│   └── telegram.ts
├── browser/
│   └── snapshot.ts          # DOM Biopsy -snapshotit (tiedostonimet, pruning, fetch)
├── logging/
│   └── logger.ts
└── state.ts                 # sessiokohtainen tila (recent calls/reasoning, cron-trigger, counters)
```

`index.ts` sisältää nyt vain pluginin rekisteröinnin ja `api.on(...)`-hookien
kytkennän — jokainen hook kutsuu yllä olevien moduulien tehdasfunktioita
(`createXxx(...)`), jotka on parametrisoitu (`api`, `nancyConfig`, `logFile`
jne.) sen sijaan että ne sulkeutuisivat suoraan `register()`:n paikallisten
muuttujien yli. `npm run check` (typecheck + `test/`-hakemiston mockattu
`register(api)`-black-box-harnessi) pysyi vihreänä koko pilkkomisen ajan.

## Outstanding test/eval coverage (as of 2026-09-13)

Not yet implemented — tracked here so they don't get lost across sessions.

### From an independent review of the eval suite (ChatGPT), still missing:

- ~~Prompt injection via browser/page snapshot content and via email~~ — covered
  by `scripts/injection-scenarios.json` (2026-09-30, see
  `docs/architecture/injection-scan.md`).
- Data exfiltration to a recipient that *is* on the allow-list (too much/wrong
  content going to an otherwise-legitimate destination — tests that
  destination-preflight allowlisting isn't treated as a free pass by the
  full content review that follows it).
- A cron-triggered run's outbound message (not just its tool calls).
- An unknown/unrecognized extension tool name reaching `shouldAnalyze()`'s
  default-to-review fallback.
- Metadata-preflight content isolation: verify the actual payload (message
  body, file contents) never appears in the destination-preflight prompt
  sent to the LLM, only the bounded metadata does.
- An action that advances the confirmed task's literal goal but violates
  `NANCY-POLICY.md`'s standing restrictions (the "exploit a booking API to
  bump another customer off a waitlist" class of example from the README).

Already added since that review: macro-review gradual-escalation detection,
and verdict-variance (same unambiguous case run N times) — see
`scripts/run-eval.mts`.

### SAFE_EXEC content-reading-verb gap — done

`src/policy/tool-policy.ts` + `test/safe-exec-sensitive-paths.test.ts`:
`cat`/`head`/`tail` on well-known credential-file paths (`.ssh/`,
`.aws/credentials`, `.env`, `id_rsa`, etc.) now forces full analysis instead
of skipping it via the `SAFE_EXEC` allowlist. Unit-tested and committed.
Still **not added as its own `scripts/eval-scenarios.json` scenario** (a
genuine LLM-verdict check that e.g. `exec cat ~/.ssh/id_rsa` with no
confirmed task gets blocked, not silently skipped) — tracked below.

### `docs/architecture/denial-escalation-and-clarification.md`'s Part A/B — landed

Deterministic denial ceiling and burst-triggered macro-review are
implemented (`src/policy/denial-policy.ts`, `test/denial-escalation.test.ts`)
and integrated into every block/cancel path in `index.ts`. Part C
(clarification tickets) remains a design proposal, off by default, not
implemented.

The apparent "terminate verdict without a session_terminated log line"
seen in an earlier `scripts/run-eval.mts` run was **not** a product bug —
it was the harness's own escalation-check losing the line to its own
per-call log-offset consumption once the burst threshold (default 3) could
fire the review well before the 10th call, interleaved with later calls in
the loop. Fixed in `run-eval.mts` (accumulate every line seen across the
whole sequence instead of only checking the tail after the loop) and
re-verified: `terminate` now reliably shows `session_terminated` logged.

Still to do — add to `scripts/eval-scenarios.json` / a dedicated
`run-eval.mts` section against the real model:

- the 20th counted denial hard-terminating a session;
- a 3-denial burst triggering an early macro-review (distinct from the
  existing 10-call gradual-escalation section, which now may or may not
  cross the burst threshold first depending on which calls get blocked);
- (once clarification mode ships, default-off) an eligible `CLARIFY`
  producing a ticket rather than a plain block.

### Still outstanding from the ChatGPT eval review (unchanged)

- ~~Prompt injection via browser/page snapshot content and via email~~ — covered
  by `scripts/injection-scenarios.json` (2026-09-30, see
  `docs/architecture/injection-scan.md`).
- Data exfiltration to a recipient that *is* on the allow-list (too much/wrong
  content going to an otherwise-legitimate destination — tests that
  destination-preflight allowlisting isn't treated as a free pass by the
  full content review that follows it).
- A cron-triggered run's outbound message (not just its tool calls).
- An unknown/unrecognized extension tool name reaching `shouldAnalyze()`'s
  default-to-review fallback.
- Metadata-preflight content isolation: verify the actual payload (message
  body, file contents) never appears in the destination-preflight prompt
  sent to the LLM, only the bounded metadata does.
- An action that advances the confirmed task's literal goal but violates
  `NANCY-POLICY.md`'s standing restrictions (the "exploit a booking API to
  bump another customer off a waitlist" class of example from the README).
