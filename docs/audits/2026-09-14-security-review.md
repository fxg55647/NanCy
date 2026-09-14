# NanCy: laaja bugitarkistus 14.9.2026

Tarkastettu commit: `cfa07f015bb3f8e5455fa0af141701951f65da7a`.

Tämä raportti kuvaa commitista `cfa07f0` löydettyä tilannetta. Tarkistus löysi useita deterministisiä ohituksia: kaikki ongelmat eivät edellyttäneet, että hyökkääjä onnistuu huijaamaan arvioivaa kielimallia.

## Korjaustila 14.9.2026

Kaikki löydökset A01–A16 on korjattu nykyisessä työpuussa ja muutettu pysyviksi regressiotesteiksi tiedostoon `test/security-audit-regressions.test.ts` tai niitä lähellä olevaan olemassa olevaan testiin. Tyyppitarkistus ja **130/130 testiä** läpäisevät. A14 varmennettiin lisäksi korjauksen jälkeen asennetun OpenClawin oikealla hook-ajurilla: 16 sekuntia viivästetty BLOCK odotettiin loppuun ja viesti peruttiin noin 16,3 sekunnissa vanhan 15 sekunnin fail-open-palautuksen sijasta. Historialliset toistot ja niiden tarkemmat perustelut säilyvät alempana, jotta muutosten syy ei katoa.

Korjauksiin kuuluvat hookien kokonaisaikabudjetit ja ulkoreunan fail-closed-käsittely, vahvistusviestin tarkastus ja lähettäjä-/kanavasidonta, task-ID:n ylikirjoituksen esto, session generation -tarkistus, default-to-review selain- ja exec-polut, kanoniset polut ja domainit, välilehteen sidottu snapshot, denial-historia, tiukka verdict-parseri, providerin completion-tilan tarkistus, URLhaus Auth-Key, näkyvät Telegram-virheet sekä liian pitkän operator-policyn hylkäys.

OpenClawin koko toimituspolun fail-closed-käytös varmistettiin myös asennetun oikean hook-ajurin testillä. NanCyn viestihookin 95 sekunnin aikabudjetti on nyt OpenClawin 120 sekunnin ulkorajaa lyhyempi: 16 sekuntia viivästetty BLOCK odotettiin loppuun ja viesti peruttiin noin 16,3 sekunnissa.

## Laajuus ja menetelmä

- Luin kaikki 22 tiedostoa `src/`-hakemistossa: hookit, vahvistukset, workerit, session tila, policyt, domainit, kaikki analyysit, provider-clientin, browser-snapshotit, lokituksen ja ilmoitukset.
- Vertailin toimintaa config-skeemaan, READMEhen, arkkitehtuuridokumenttiin ja testauksen ohjeisiin.
- Tarkastin nykyisten testien kattavuutta ja molempia eval-skriptejä. Tarkistus ei ole OpenClawin kaikkien riippuvuuksien auditointi.
- Tarkistin asennetusta OpenClawista selaimen `wait`/JavaScript-polun, hookien timeoutit ja failure-policyt sekä tiedostotyökalujen parametrien validoinnin.
- Ajoin `npm run check`: tyyppitarkistus onnistui ja **113/113 testiä läpäisi**.
- Lisäsin erilliset auditointitoistot, jotka käyttävät fake-hostia, tilapäisiä hakemistoja ja mockattua HTTP:tä. Yhtään testin esimerkkikomentoa ei suoriteta shellissä eikä viestiä lähetetä oikealle vastaanottajalle.
- `scripts/audit-repro.mts`: **16 onnistunutta toistoa**, jotka kattavat 15 raportin kohtaa. A04 testataan erikseen työkaluille ja viesteille.
- `scripts/audit-host-timeout.mts`: **yksi lisätoisto** asennetun OpenClawin oikealla hook-ajurilla. A14 toistui noin 15 036 millisekunnissa, ennen Nancyn myöhempää estoa.
- URLhausin nykyinen Auth-Key-vaatimus tarkistettiin palvelun omasta dokumentaatiosta. Palveluun ei lähetetty yksityisiä URL-osoitteita eikä ladattu haittaohjelmia.

Auditointiskriptit todentavat nykyisen haavoittuvan käyttäytymisen. Niiden onnistuminen tarkoittaa **bugin toistumista**, ei turvallisuustestin läpäisyä. Korjausten jälkeen ne tulee muuttaa tavallisiksi regressiotesteiksi, jotka odottavat turvallista tulosta.

## Korjausjärjestys

P1 tarkoittaa tässä konkreettista turvallisuusrajan puutetta, joka tulisi korjata ennen kuin kyseiseen suojaan luotetaan. Se ei tarkoita, että jokainen asennus olisi hyväksikäytettävissä: esimerkiksi OpenClawin omat työkalurajoitukset, eristetyt kanavat ja tiedostojärjestelmän oikeudet voivat katkaista saman hyökkäyksen muualla.

| ID | Prioriteetti | Löydös |
|---|---|---|
| A14 | P1 | OpenClawin 15 s viestihook-timeout ohittaa Nancyn myöhemmän BLOCKin |
| A01 | P1 | Vahvistusviestin muoto antaa tarkastamattoman lähetyspoikkeuksen |
| A05 | P1 | Selaimen `act:wait` voi suorittaa JavaScriptiä ilman Nancyn tarkastusta |
| A06 | P1 | SAFE_EXEC hyväksyy muitakin ohjelmia ja muuttavia komentoja |
| A03 | P1 | Agentin valitseman tehtävä-ID:n törmäys vaihtaa workerin valtuutuksen |
| A04 | P1 | Keskeneräinen tarkastus voi sallia toiminnon session pysäytyksen jälkeen |
| A07 | P1 | Suojattujen polkujen vertailu ohitetaan kirjainkoolla tai junctionilla |
| A02 | P1, ehdollinen | Vahvistajan henkilöllisyyttä ei sidota pyyntöön |
| A09 | P1 | Selainkonteksti voidaan lukea eri välilehdeltä kuin toiminto |
| A15 | P1 | URLhaus-kutsusta puuttuu nykyisin vaadittu Auth-Key |
| A08 | P2 | Domainin loppupiste ohittaa deny-listan |
| A10 | P2 | Varhain estetyt yritykset puuttuvat käytösarvioijan aineistosta |
| A11 | P2 | Tavallinen verdict-parser hyväksyy rikkinäisen ALLOW-vastauksen |
| A16 | P2 | Providerin katkaistu vastaus voidaan hyväksyä valmiina tuomiona |
| A12 | P2 | Telegramin HTTP-virheet jäävät huomaamatta |
| A13 | P2 | Pitkän operator-policyn loppuosan rajoitukset jäävät soveltamatta |

## A14 — Isäntäohjelman timeout tekee viestitarkastuksesta fail-openin

**Paikat:** `src/index.ts` (`message_sending`-rekisteröinti), `src/analysis/debate.ts` (`timeoutMs = 60_000`), `src/constants.ts` (30 s provider-timeout). Asennettu `node_modules/openclaw/dist/hook-runner-global-BhDCl4qm.mjs`: oletustimeoutit noin rivillä 460, virhekäytös noin rivillä 501 ja globaali failure-policy noin rivillä 1391.

OpenClaw antaa `message_sending`-hookille oletuksena 15 sekuntia. NanCy ei rekisteröi pidempää timeoutia. OpenClawin globaali hook-ajuri asettaa `before_tool_call`-hookin fail-closed-tilaan, mutta ei tee samaa `message_sending`-hookille. Viestitarkastuksen aikakatkaisu johtaa siksi siihen, että ajuri palauttaa ilman `cancel: true` -tulosta.

**Toisto:** oikealle hook-ajurille rekisteröitiin NanCy fake-hostissa, `debateMode: always`. Molempien analyytikkojen HTTP-vastaus viivästettiin mockissa 16 sekuntiin. Ajuri palautti noin 15 sekunnissa `undefined`. NanCy palautti myöhemmin `cancel: true`, mutta ajurin päätös oli jo tehty. Malli ei antanut väärää ALLOW-tuomiota: se päätyi BLOCKiin liian myöhään.

Tämä koskee myös tavallista tarkastusta, jonka HTTP-timeout on 30 sekuntia. Triple-pass ja peräkkäiset preflightit kasvattavat altistavaa kokonaisviivettä. Työkalupuolella sama epäsuhta aiheuttaa ennenaikaisia virheitä/estoja; tarkistetun globaalin failure-policyn perusteella en väitä työkalujen päästävän läpi timeoutista.

**Korjaus:** määritä koko hookille yksi hallittu aikabudjetti, joka kattaa myös preflightit, snapshotin ja gap-checkin. Sen on päätyttävä turvalliseen palautusarvoon ennen isännän timeoutia. Sovita lisäksi rekisteröinnin timeout isäntään ja varmista viestihookin failure-policy. Pelkkä `reviewAction`-funktion catch ei riitä. Harkitse myös hookin ulkoreunan poikkeuskäsittelyä: lokikirjoituksen virhe ennen sisäistä try-lohkoa voi muuten päätyä samaan isännän fail-open-polkuun.

**Hyväksymistesti:** asennetulla oikealla hook-ajurilla testataan hidas provider, hidas preflight, snapshot-timeout ja sisäinen poikkeus. Jokaisessa viesti perutaan ennen host-deadlinea; myöhäinen BLOCK ei kelpaa onnistumiseksi.

## A01 — Vahvistusmuoto on tarkastamaton lähetyskanava

**Paikat:** `src/index.ts` noin 252–329; `src/confirmation/protocol.ts`.

`Formal confirmation: ...` -muodon täsmätessä sisältö palautetaan lähetettäväksi ennen cron-eston, workerin valtuutuksen ja tavallisen viestitarkastuksen suorittamista. Kuvauksen sisältö on vapaata agentin tekstiä. Koodi ei tarkista, että vastaanottaja on tehtävän vahvistava käyttäjä. Gap detection ei ole turvallisuusesto ja sen saa pois päältä.

**Toisto:** cron-sessio lähetti vahvistusmuotoon puetun synteettisen salaisuuden ulkoiseksi nimettyyn vastaanottajaan `testMode: true` -tilassa. Hook palautti `undefined`, HTTP-kutsuja tehtiin nolla. Tässä ei väitetä oikean sähköpostin lähettämistä; todistettu asia on Nancyn toimitusestojen ohitus.

**Vaikutus:** hyökkääjän ei tarvitse saada reviewerilta ALLOW-tuomiota, jos worker voi tuottaa sopivanmuotoisen lähtevän viestin. Sama poikkeus rikkoo testimoodin väitteen siitä, että vain turvallinen kiinteä kysymys lähetetään oikeasti.

**Korjaus:** koodin omistama vahvistuslähetys luotettuun, inbound-kontekstista sidottuun käyttäjäkanavaan. Vapaata kuvausta ei pidä käsitellä vaarattomana pelkän ympäröivän templaten takia. Cron- ja worker-rajoitukset pitää ratkaista ennen poikkeusta. Tarvitaan erillinen sääntö sille, mitä dataa vahvistuskuvaus saa sisältää.

**Hyväksymistesti:** sama template väärälle vastaanottajalle, cronista ja vanhentuneesta workerista estetään ilman reviewer-kutsua; oikea käyttäjävahvistus toimii edelleen.

## A05 — Selaimen wait ei aina ole passiivinen

**Paikka:** `src/policy/tool-policy.ts`, `BROWSER_INTERACTIVE_ACT_KINDS` ja `shouldAnalyzeBrowser`.

`wait` puuttuu tarkastettavien act-kindien joukosta. Asennetun OpenClawin `pw-ai-DlOziW9s.mjs` kuitenkin välittää `wait.fn`-arvon Playwrightin `waitForFunction`-polkuun. Se on JavaScript-suoritus, jossa voi olla sivuvaikutuksia. OpenClaw estää sen, jos `browser.evaluateEnabled=false`; tämä on erillinen suoja, ei Nancyn toimiva tarkastus.

**Toisto:** `browser {action:"act", kind:"wait", fn:"() => { document.body.textContent = 'changed'; return true; }"}` sai Nancylta luvan ilman vahvistettua tehtävää ja ilman analysis-configia. Esimerkkikoodia ei ajettu selaimessa. Varsinainen hostin dispatch tarkistettiin lähdekoodista.

**Korjaus:** myös selaimen alitoiminnoissa default-to-review. Luettele vain tunnetut aidosti passiiviset muodot. Pelkän `wait`-nimen hyväksyminen ei riitä; `fn` muuttaa sen luonteen. Unknown action/kind ei saa palauttaa automaattisesti `false`.

**Hyväksymistesti:** wait+fn, tuntematon act-kind ja tuntematon päätoiminto päätyvät reviewiin tai taskittomana estoon. Pelkkä ajallinen odotus voidaan hyväksyä erikseen.

## A06 — SAFE_EXEC ei tunnista suoritettavaa komentoa riittävän tarkasti

**Paikka:** `src/policy/tool-policy.ts` noin 33–61.

Regexin `\b` ei tarkoita komennon loppua. `echo-malicious` ja `ls/custom-program` alkavat hyväksytyllä sanalla ja sanarajalla. Lisäksi `date -s ...` muuttaa järjestelmän aikaa, jos prosessin oikeudet sallivat sen, ja `mkdir` muuttaa tiedostojärjestelmää jo tavallisillakin oikeuksilla. Nämä eivät ole yleisesti read-only-komentoja.

**Toisto:** kaikki neljä luokiteltiin tarkastusta tarvitsemattomiksi: `echo-malicious`, `ls/custom-program`, `date -s 2030-01-01`, `mkdir unauthorized-dir`. Niitä ei suoritettu.

**Vaikutus:** ei-main/cron-sessiossa taskittoman session esto ohitetaan, koska `requiresSemanticReview` on false. OpenClawin exec-approvals ja käyttöjärjestelmän oikeudet voivat estää varsinaisen suorituksen muualla.

**Korjaus:** pienin turvallinen muutos on poistaa tämä shell-poikkeus. Jos se säilytetään, tarvitaan oikea shellin/platformin mukainen komennon ja argumenttien tulkinta sekä sallittujen argumenttimuotojen lista. Ohjelmanimi yksin ei riitä.

**Hyväksymistesti:** suffixit, polut, muuttavat optiot ja eri shellien muodot eivät saa päästä valtuutuksetta läpi. Testaa myös OpenClawin todellisen exec-kontekstin kanssa.

## A03 — Tehtävätunnuksen törmäys rikkoo worker-eristyksen

**Paikat:** `src/workers/worker-manager.ts` noin 49–78; `src/confirmation/tasks.ts` `grantTask`; `message_received`.

Workerin session-avain ja idempotency-avain johdetaan kokonaan agentin valitsemasta 6–10-numeroisesta ID:stä. Tunnuksen ainutkertaisuutta ei varmisteta. Kahden vahvistetun tehtävän samat ID:t luovat saman worker-avaimen, ja jälkimmäinen `grantTask` korvaa ensimmäisen tehtävän tiedot. Myös auditointitiedosto kirjoitetaan saman nimen päälle.

**Toisto:** kaksi eri chat-sessiota vahvisti saman ID:n eri kuvauksilla. Molemmat `run`-kutsut saivat saman session-avaimen. Ensimmäisen workerin avaimella tehty tarkastus näki SECOND_TASK-valtuutuksen. Riippuen hostin idempotenssista toinen run voi myös deduplikoitua; jo valtuutuksen ylikirjoitus tapahtuu ennen sitä.

**Korjaus:** luo NanCyssa sisäinen yksilöllinen grant/run-tunnus, jota agentti ei valitse. Ulkoinen kuvaustunnus voi jäädä korrelaatioksi. Älä korvaa aktiivista grantia. Cleanup saa perua vain täsmälleen sen grant-generationin, jonka kyseinen worker omistaa.

**Hyväksymistesti:** kaksi käyttäjää/sessiota, sama ulkoinen ID, eri tehtävät, rinnakkaiset runit ja eri järjestyksessä tapahtuva cleanup. Valtuutukset ja tiedostot eivät sekoitu.

## A04 — Tarkastuksen aikana muuttunutta valtuutusta ei tarkisteta lopussa

**Paikka:** `src/index.ts` hookien alkuportit ja ALLOW-palautuspolut noin 410–431 ja 836–869.

Pysäytystila katsotaan hookin alussa. Sen jälkeen odotetaan ulkoisia palveluja. Toinen rinnakkainen kutsu voi sinä aikana ylittää denial-kynnyksen tai macro-review voi pysäyttää session. Ensimmäinen kutsu palauttaa silti ALLOWin. Samalla rakenteella tehtävän vanheneminen tai korvaaminen voi tehdä aiemmin luetusta tehtävästä vanhentuneen.

**Toisto:** HTTP-arvio pysäytettiin odottamaan. Saman session suojatun tiedoston kirjoitusyritys ylitti hard-limitin 1. Lokissa näkyi `hard_terminated`. Odottavalle arviolle annettiin sitten ALLOW: sekä työkaluhook että viestihook palauttivat ilman estoa.

**Korjaus:** tarkista juuri ennen sallivaa palautusta session stop-tila ja saman valtuutuksen voimassaolo/generation. Pelkkä mikä tahansa nykyinen tehtävä ei riitä, jos arvio tehtiin toiselle tehtävälle. Tarvitaan myös yhteistyö hostin execution-boundaryn kanssa, jotta jo myönnettyjä suorituksia koskeva takuu on täsmällinen.

**Hyväksymistesti:** pysäytys, session_end, taskin expiry ja korvaava grant tapahtuvat kesken preflightin/full-reviewin/debaten. Vanha kutsu ei saa palata sallivana.

## A07 — Polkuvertailu ei vastaa tiedostojärjestelmän identiteettiä

**Paikka:** `src/policy/protected-paths.ts` noin 72–89.

`path.resolve` normalisoi syntaksin, mutta ei Windowsin kirjainkokoa eikä junction/symlink-kohdetta. Map-vertailu on kirjainkoon suhteen tarkka. Windowsissa `agents.md` ja `AGENTS.md` voivat olla sama tiedosto, mutta vain jälkimmäinen vastaa suojauslistaa. Junctionin kautta samaan workspaceen päätyvä polku jää myös tunnistamatta.

**Toisto:** tilapäiseen workspaceen luotiin `AGENTS.md`. Sen sisältö voitiin lukea pienaakkosisella nimellä, mutta `protectedWriteTarget` palautti tälle null. Myös temp-hakemistoon luotu junction ohitti vertailun. Suojattuja tuotantotiedostoja ei kirjoitettu.

**Korjaus:** käytä hostin/filsystemin kanonista kohdeidentiteettiä. Huomioi luotavat tiedostot ratkaisemalla olemassa olevat vanhemmat, platformin case-säännöt sekä symlink-race. OS-tason kirjoitussuoja on edelleen tarpeen. Workerien pääsy muiden agenttien suojattuihin tiedostoihin on syytä kattaa samalla.

**Hyväksymistesti:** case-variantit Windowsissa, junction/symlink, suhteelliset ja absoluuttiset polut, apply_patchin derivedPaths sekä muiden agenttien suojatut kohteet.

`file_path`-parametria ei laskettu erilliseksi varmistetuksi ohitukseksi: tarkistettu nykyinen OpenClaw validoi näille työkaluille `path`-kenttää.

## A02 — Saman session toinen lähettäjä voi vahvistaa

**Paikat:** `PendingConfirmation` ja `src/index.ts` `message_received` noin 481–509.

Pending sisältää ID:n, kuvauksen, ajan ja mahdollisen viesti-ID:n, mutta ei vahvistajaa, tiliä tai kanavaa. `from` luetaan lokia varten; sitä ei verrata pyynnön vastaanottajaan. Session-avain ja ajoittain replyToId riittävät.

**Toisto:** ownerille osoitettua pyyntöä seurasi `yes` lähettäjältä other-person samassa session-avaimessa. Valtuutus syntyi ja kirjoituskutsu pääsi reviewerille. Tämä on konkreettinen ongelma, jos samaan sessioon voi kirjoittaa useampi identiteetti; eristetty yhden käyttäjän DM voi estää tilanteen jo hostissa.

**Korjaus:** sido pending luotettuun kanava-, account-, conversation- ja vahvistajaidentiteettiin. Määrittele ryhmissä, kuka saa vahvistaa. Ilman tarvittavia tietoja ei pidä väittää henkilöllisyyden olevan tarkistettu.

**Hyväksymistesti:** väärä henkilö, toinen tili/kanava ja väärä replyTo eivät myönnä eivätkä kuluta oikean käyttäjän pendingiä.

## A09 — Snapshot ei kohdistu tarkastettavan toiminnon välilehteen

**Paikat:** `src/browser/snapshot.ts` `fetchBrowserSnapshot`; `src/index.ts` noin 762–789.

Snapshot-pyyntö on aina `/snapshot?format=ai`. Funktio ei vastaanota toiminnon `targetId`, `profile`, `target` tai `node` -tietoja. OpenClawin selaintoiminto tukee kohdistusta eri välilehteen/profiiliin. Reviewer voi siten saada hyvän sivun tekstin, vaikka toiminto kohdistuu toiseen sivuun. Palautettua kohdeidentiteettiä ei myöskään verrata toiminnon identiteettiin.

**Toisto:** toiminto sisälsi `targetId: another-tab` ja `profile: another-profile`. Tallennettu snapshot-request ei sisältänyt kumpaakaan. Tämä todistaa kohdistustiedon katoamisen; todellista monivälilehtistä selainta ei käytetty.

**Korjaus:** välitä kohdistus samasta hostin auktoritatiivisesta sidonnasta kuin varsinainen toiminto. Epäonnistuva tai väärän kohteen snapshot ei saa muuttua uskottavaksi sivukontekstiksi. Arvioi myös snapshotin ja interaktion välinen sivun vaihtuminen.

**Hyväksymistesti:** kaksi välilehteä, eri profiilit, puuttuva kohde, vanhentunut kohde ja toiminnon aikana vaihtuva sivu. Väärän välilehden ALLOW ei kelpaa.

## A15 — URLhaus-integraation autentikointi on vanhentunut

**Paikka:** `src/policy/domain-policy.ts` noin 30–46; README keyless-väitteet.

Nykyinen [URLhausin API-dokumentaatio](https://urlhaus-api.abuse.ch/) vaatii HTTP `Auth-Key` -otsakkeen. NanCyn kutsu ei lisää sitä eikä configissa ole sille kenttää. HTTP-virhe palauttaa nullin, minkä jälkeen domain hyväksytään tämän tarkastuksen osalta. Ohjelma ei ilmoita, että oletuksena päällä oleva mainekerros on poissa toiminnasta.

**Toisto:** mock palautti 401 ja tarkisti, ettei requestissa ollut Auth-Keytä. `checkDomainBorder` palautti nullin. En tehnyt tässä oikeaa autentikoitua API-kyselyä; vaatimus vahvistettiin yllä olevasta ensisijaisesta lähteestä.

**Korjaus:** tuettu autentikointi ja secret-resoluutio, dokumentaation päivitys ja näkyvä degraded-status. Tarkista `query_status` sallittujen tulosten mukaan: jokainen muu kuin `ok` ei tarkoita puhdasta hostia. Määrittele erikseen, mikä palveluvirhe saa fail-open-käsittelyn.

**Hyväksymistesti:** onnistunut malicious/no_results, puuttuva/väärä avain, 401/429/5xx, tuntematon query_status ja verkkovirhe. Virhettä ei välimuistiteta onnistuneena puhtaana vastauksena.

## A08 — Domainin lopussa oleva piste ohittaa deny-listan

**Paikka:** `src/policy/domain-policy.ts` `hostnameMatches`.

Pienaakkostaminen ei poista DNS-juuren loppupistettä. `blocked.example.` ei täsmää `blocked.example`-sääntöön, vaikka se voi osoittaa samaan hostiin. Toistossa tavallinen muoto estettiin ja pisteellinen hyväksyttiin, reputationCheck pois päältä. Päinvastaisessa allow-list-tilassa vastaava ero aiheuttaa turhan eston.

**Korjaus:** kanonisoi sekä URL-hostit että config-patternit samalla tavalla, mukaan lukien loppupiste ja IDN-muodot. Testaa myös alidomainit ja varmista, ettei suffix-vertailu hyväksy samankaltaisia vääriä nimiä.

## A10 — Denial-burstin reviewer ei näe sitä laukaisevia yrityksiä

**Paikat:** `src/index.ts` ennen `pushRecentCall`-kohtaa; `src/policy/denial-policy.ts`; `src/analysis/macro-review.ts`.

Suojattujen polkujen, main/cron-portin ja domain-portin estot palautuvat ennen historiakirjausta. Denial-recorder lisää laskurin ja käynnistää macro-reviewin, mutta ei lisää sille turvallista päätöstietoa. Macro-promptissa ei ole denial-laskureitakaan. Myöhemmin historioitujen kutsujen tietueista puuttuu verdict/reasonCode.

**Toisto:** kolme `AGENTS.md`-kirjoitusyritystä laukaisi macro-reviewin. Sen promptissa oli `Recent tool calls (0 entries)`.

**Korjaus:** lisää bounded päätöshistoria: työkalu, kohteen turvallinen metadata, verdict ja reasonCode myös varhaisista estoista. Älä palauta kokonaisia viesti- tai tiedostosisältöjä historiaan. Macro-reviewille mukaan laskurit ja triggerin syy.

**Hyväksymistesti:** kolmannen varhaisen eston laukaisema reviewer näkee kolme denialia. Hard ceiling toimii siitä riippumatta kuten ennenkin.

## A11 — Tavallisen verdict-parserin ALLOW on liian salliva

**Paikka:** `src/analysis/verdict.ts` noin 5–8.

Parser etsii ensimmäisen osuman mistä tahansa vastausta. `VERDICT: ALLOWANCE` tulkitaan ALLOWiksi. Myös ensin lainattu ALLOW ja sen jälkeen varsinainen BLOCK päättyy ALLOWiin. Puuttuva reason ei estä sallivaa tulosta.

**Toisto:** molemmat yllä olevat muodot hyväksyttiin. Tämä on parserin virheellinen luottamus malformed-vastaukseen, ei todiste siitä, että tietty kielimalli tuottaisi sitä normaalisti.

**Korjaus:** yksi yhteinen tiukka, koko vastauksen validoiva formaatti kaikille päätösporteille. Virheellinen tai monituomioinen vastaus ei saa sallia toimintoa. Debate-tilassa on jo tiukempi parseri, mutta preflightit ja tavallinen tila käyttävät yhä tätä funktiota.

## A16 — Katkaistu provider-vastaus hyväksytään täydellisenä

**Paikat:** `src/analysis/client.ts` provider-vastausten purku; `src/analysis/debate.ts` strictVerdict.

Client hylkää providerin completion-status-tiedot ja palauttaa pelkän tekstin. Jos token-raja katkaisee vastauksen hyväksytyn kaksirivisen alun jälkeen, edes debate-polun syntaksivalidointi ei tunnista sitä keskeneräiseksi.

**Toisto:** OpenAI-mock palautti `finish_reason: length` sekä `VERDICT: ALLOW` ja keskeneräisen perustelun `Authorized only if`. `debateMode: clarify` hyväksyi tuloksen ALLOWina ilman eskalointia.

**Korjaus:** palauta clientistä strukturoitu tulos ja varmista provider-kohtainen normaali valmistuminen. Token-rajaan katkeaminen, refusal/safety-estot ja tyhjät contentit eivät saa muuttua valmiiksi sallivaksi päätökseksi. Tämä on erityisen tärkeää 300 tokenin output-rajalla.

**Hyväksymistesti:** normaalin stopin lisäksi OpenAI length, Anthropicin max_tokens ja Geminin vastaava finishReason testataan. Katkaistu muuten validin näköinen JSON/verdict hylätään.

## A12 — Telegram-ilmoitus voi kadota huomaamatta

**Paikka:** `src/notifications/telegram.ts` noin 6–13 ja `sendAlert`.

Fetch ei heitä HTTP 400/401/429 -vastauksesta. `telegramAlert` ei tarkista `res.ok` eikä API:n `ok`-kenttää. Lisäksi parse_mode on Markdown, mutta mallin/agentin perustelut ja kuvaukset lisätään tekstiin ilman Markdown-escapingia. Toistossa mockin 400/ok:false palautui onnistuneena.

**Korjaus:** tarkista status ja API-vastaus, kirjaa toimitusvirhe ja käytä turvallista tekstimuotoa tai escapingia. Muotoiluvirheessä voidaan yrittää plain text -lähetystä. Älä tee rajatonta retryä 429-tilanteessa. Ilmoitusvirhe ei saa purkaa varsinaista estoa.

## A13 — Operator-policyn loppu katkaistaan pois

**Paikka:** `src/policy/operator-policy.ts` noin 27–34.

16 000 merkin jälkeen olevat säännöt eivät päädy reviewiin. Reviewer saa katkaisumerkinnän mutta operaattori ei saa startup/config-virhettä. Toistossa loppuun lisätty `Never send confidential invoices` puuttui kokonaan policy-kontekstista. Tämä ei poista sisäänrakennettua minimiturvaa, mutta ohittaa operaattorin oman lisärajoituksen.

**Korjaus:** hylkää liian pitkä policy näkyvästi tai validoi se tallennettaessa. Pakollisia rajoituksia ei voi korvata katkaisulla. Myös olemassa olevan mutta lukukelvottoman policy-tiedoston ja aidosti puuttuvan valinnaisen tiedoston ero on syytä tehdä näkyväksi.

## Muut tarkistuksessa havaitut rajoitukset ja jatkotestit

Näitä ei lasketa yllä oleviin erikseen toistettuihin bugeihin:

1. **Levynkäyttö kasvaa gatewayn koko ajon ajan.** Log rotation ja snapshot-pruning tapahtuvat käynnistyksessä, eivät jokaisella kirjoituksella tai ajastetusti. 20 MB / 1 000 tiedostoa eivät siis ole ajonaikaisia ylärajoja. Raakaviestit, tool-parametrit, llm_output ja snapshotit voivat myös sisältää salaisuuksia. Tarvitaan runtime-retentio, kokorajat ja selkeä pääsynhallinta.
2. **Session elinkaari ja keskeneräiset macro-reviewit.** `clearSession` poistaa in-flight-merkinnän mutta ei peruuta pyyntöä. Vanha reviewer voi myöhemmin kirjoittaa termination-tilan takaisin saman avaimen uudelle sessiolle. Tarvitaan generation-token tai cancellation ja siihen regressiotesti.
3. **Workerin odotusluupin loppuminen.** Kolmen timeoutin jälkeen worker jätetään eloon, mutta tämä watcher ei enää huomaa myöhempää valmistumista. Se on dokumentoitu valinta, mutta automaattinen cleanup/report ei ole silloin taattu. Uusi seuranta ei saa tappaa yhä ajavaa workeria.
4. **Passiiviset lukutyökalut voivat lukea arkaluonteista dataa.** `read` ohittaa reviewer-polun; shellin `cat ~/.ssh/id_rsa`-tarkistus ei sulje samaa tiedostoa `read`-työkalulta. Tämä kuuluu nykyiseen passive-read-malliin, mutta credential-polkutestin antamaa turvavaikutelmaa pitää rajata. Ulospäin lähettämisen suojat ovat tällöin erityisen tärkeitä.
5. **Domain-portti ei ole verkkopalomuuri.** Se näkee vain tarjotun URL:n. Redirectit, JS-verkkopyynnöt, clickistä seuraavat navigaatiot ja shellin verkkokutsut vaativat hostin/networkin suojat. Hostname mainepalveluun on myös ulkoinen lähetys, mahdollisesti sisäisen hostin nimellä.
6. **Tiedonhakukiintiö on kiinteä ikkuna, ei liukuva tunti.** Rajan molemmin puolin voi tehdä kaksinkertaisen määrän lyhyessä ajassa. Koodi kommentoi tämän, README käyttää rolling hour -sanamuotoa. Myös session vaihto luo uuden kiintiön. Tämä pitää dokumentoida täsmällisesti.
7. **Evalit eivät yksin todista turvallisuutta.** `run-eval.mts` kutsuu fake-hostin handlereita suoraan: juuri siksi A14 jäi piiloon. Sen classify ei tunnista kaikkia error/context-block-lokeja ja koko ajo voi silti päättyä exit 0:aan epäonnistuneilla odotuksilla. Kahdeksan tapauksen debate-eval on pieni synteettinen reviewer-testi, eikä kata hostin toimituspolkua, todellisia tokeneita/hintaa tai kaikkia reititysvirheitä.
8. **Debaten hyötyä ei mitattu tässä.** Kahden analyytikon riippumattomuus tarkoittaa erillisiä kutsuja, ei eri malliperheitä. Yhteiset virheet ja injektiot ovat edelleen mahdollisia. Oikean mallin vertailevaa evalia ei ajettu tässä auditoinnissa, eikä mock-testien määrä ole siitä korvike.

## Mikä näytti toimivan tarkistetuissa rajoissa

- Tehtävävaltuutus on muistissa session-avaimella, eikä agentin kirjoittama tasks-JSON yksin myönnä valtuutusta.
- Normaali ei-poikkeuksellinen kirjoitus suojattuun täsmäpolkuun estyy ennen LLM:ää.
- Tuntemattomat työkalunimet päätyvät yleensä reviewiin; browser-alitoiminnot ovat tästä tärkeä poikkeus.
- Main/cron-työkalujen allowlist on selkeä ja review-fallback on rajattu kahteen nimettyyn tiedonhakutyökaluun.
- Metadata-preflight ei normaalimuotoisilla parametreilla sisällä body/content/patch-kenttiä. Uudet metadata-isolation-testit läpäisivät.
- Hard denial ceiling ei tarvitse macro-reviewerin hyväksyntää. Sen ongelma on jo matkalla olevien kutsujen lopputarkastus, ei kynnyksen peruslaskenta.
- Debaten analyytikot käynnistyvät rinnakkain, tuomari saa alkuperäisen prompt-snapshotin ja molemmat analyysit, ja suoran funktion timeout/malformed-output-testit toimivat. Kokonaisjärjestelmän timeout pitää kuitenkin korjata erikseen.

## Ehdotettu korjaustyön jaksotus

1. **Sulje deterministiset ohitukset:** A14, A01, A05 ja A06. Lisää aidon host-ajurin integraatiotestit heti, jotta sisäisen funktion onnistuminen ei peitä ulkoista fail-openia.
2. **Korjaa valtuutuksen identiteetti ja elinkaari:** A03, A04 ja A02. Sisäinen yksilöllinen grant-tunnus, omistaja, voimassaolo ja generation yhdessä mallissa.
3. **Korjaa kohteiden identiteetti:** A07, A09 ja A08. Polku, välilehti ja domain eivät saa tarkoittaa tarkastuksessa eri asiaa kuin suorituksessa.
4. **Palauta ulkoisten suojakerrosten luotettava toiminta:** A15 ja A12. Virheestä näkyvä tila, ei hiljainen vaikutelma toimivasta suojasta.
5. **Tiukenna päätösten ja aineiston käsittely:** A10, A11, A16 ja A13. Yhteinen parseri, providerin valmistumistieto, bounded päätöshistoria ja policy-validointi.
6. Aja regressiotestit ja host-integraatiotestit, sitten pieni real-model smoke-eval ja lopuksi vertailueval. Raportoi väärät ALLOWit erikseen virheistä, liian tiukoista estoista ja oikeista estoista.

Alkuperäiset haavoittuvaa käyttäytymistä odottaneet reproskriptit poistettiin korjausten jälkeen. Niiden turvallista tulosta odottavat vastineet ovat tavallisessa testisarjassa. Tässä korjausvaiheessa ei käytetty oikeaa provider-mallia, selainta, gatewayta tai viestikanavaa eikä muutoksia commitoitu tai pushattu.
