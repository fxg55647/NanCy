# TODO

## Moduloi src/index.ts

Nyt kaikki logiikka on yhdessä ~75 KB:n tiedostossa (`src/index.ts`) — ks.
CLAUDE.md. Kun tiedosto kasvaa hankalan isoksi, pilko se seuraavan
suuntaviivan mukaan (ei vielä tehty — tämä on vain muistiin kirjattu
tavoiterakenne, ei aikataulutettu):

```
src/
├── index.ts                 # pluginin rekisteröinti ja hookien kytkentä
├── config.ts                # NancyConfig ja asetusten validointi
├── analysis/
│   ├── client.ts            # Gemini/OpenAI/Anthropic-kutsut
│   ├── context.ts           # analyysikontekstin rakentaminen
│   └── verdict.ts           # ALLOW/BLOCK/CLARIFY-jäsennys
├── policy/
│   ├── tool-policy.ts       # main/cron/default-deny
│   ├── protected-paths.ts
│   └── domain-policy.ts
├── confirmation/
│   ├── protocol.ts          # vahvistusviestien käsittely
│   └── tasks.ts             # sessioon sidotut tehtävävaltuutukset
├── workers/
│   └── worker-manager.ts    # käynnistys, odotus ja cleanup
├── notifications/
│   └── telegram.ts
├── logging/
│   └── logger.ts
└── state.ts                 # sessiokohtainen tila
```

Huomioita pilkkomista varten:
- Tee vasta kun kaksi rinnakkaista muokkaustyötä samaan tiedostoon ei enää ole
  käynnissä — pilkkominen kesken toisen session muokkauksien aiheuttaisi
  ison merge-riskin.
- `test/`-hakemiston mockattu `api`-harnessi (ks. `test/helpers.ts`) pitäisi
  toimia sellaisenaan pilkkomisen jälkeenkin, koska se ajaa `register(api)`:a
  mustana laatikkona — hyvä regressiosuoja pilkkomiselle.
