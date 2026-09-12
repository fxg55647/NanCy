# TODO

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
