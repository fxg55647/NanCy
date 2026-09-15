# Nancy-mobiilisovellus — suunnitelma ja TODO

Päivitetty: 15.9.2026. Tila: tuotesuunnitelma, ei kuvaus valmiista mobiilitoteutuksesta.

## Tavoite

Nancy auttaa tekemään työn loppuun sen aikana: käyttäjä antaa tehtävän, ottaa kuvat ja sanelee havainnot. Nancy kohdistaa aineiston oikeaan työhön, kysyy tarvittavat tarkennukset ja tuottaa esimerkiksi raportin tai sähköpostin liitteineen. Omat ohjeet ja työnkulut ovat käyttäjän hallittavissa.

Sovitut lähtökohdat:

- Mobiilisovellus tukee kuvia, sanelua ja tehtävien hallintaa.
- Paikallisen tekoälyn käyttö on mahdollista. Mallin suorituspaikka pitää erottaa puhelimen käyttöliittymästä.
- Nancyssa ei ole pakollista kuukausiveloitusta. Kertamaksu, lisenssi ja jakelumalli ovat vielä avoimia.
- Paikallisuus kattaa tavoitetilassa myös puheentunnistuksen, puhesynteesin, kuvien tulkinnan ja tehtävien tarkastajan. Mahdollinen pilvikäsittely valitaan erikseen.
- Laitteisto, sähkö, ylläpito ja mahdolliset ulkoiset palvelut voivat aiheuttaa kustannuksia.

## Yhteys nykyiseen Nancyyn

Nykyinen projekti on OpenClaw-agentin tehtävävaltuutusta ja toimintaa valvova Nancy SSIL -lisäosa. Mobiilisovellus tarvitsee sen ympärille käyttöliittymän ja luotetun palvelurajapinnan.

README kuvaa koodin omistaman tehtävävahvistuksen ja suojatut ohjaustiedostot. Mobiilin painikkeita, lomakkeita tai puhetta ei saa vain tulkita agentin itse tuottamaksi hyväksynnäksi. Nykyinen tarkennus- ja estokäyttäytyminen sekä vahvistuksen voimassaolo on tarkistettava toteutuksesta ennen mobiiliprotokollan suunnittelua.

- [ ] Kartoita nykyinen tehtävä-, vahvistus-, worker- ja ilmoitusrajapinta.
- [ ] Määrittele palvelurajapinta mobiilille: tehtävät, aineistot, kysymykset, hyväksynnät ja tulokset.
- [ ] Toteuta käyttäjän vastauksen vastaanotto ja valtuutuksen kirjaaminen luotetussa koodissa.
- [ ] Suunnittele ohjemuutoksille erillinen hallintareitti, joka säilyttää nykyisten suojattujen tiedostojen suojauksen.

## Ensimmäinen käyttötapaus: korjaamon työ

1. Korjaaja valitsee tai luo työn, esimerkiksi työmääräys 1234.
2. Hän ottaa kuvat ja sanelee: ”Etujarrut kuluneet. Tee asiakkaalle korjauslupapyyntö.”
3. Nancy näyttää ymmärtämänsä tehtävän ja kysyy puuttuvat tiedot.
4. Nancy muodostaa sähköpostin ja liitteet.
5. Korjaaja tarkistaa vastaanottajan, sisällön ja kuvat sekä hyväksyy lähetyksen.
6. Viesti, kuvat ja lopputulos löytyvät työn historiasta. Epäonnistunut lähetys jää näkyvästi odottamaan toimenpidettä.

Ensimmäisessä kokeilussa työ ja vastaanottaja voidaan syöttää käsin. Korjaamojärjestelmän integraatio on erillinen työ.

## P0 — ensimmäinen toimiva kokonaisuus

### Yhteys ja käyttöönotto

- [ ] Valitse ensimmäinen alusta: Android, iOS tai molemmat.
- [ ] Valitse toteutustekniikka ja määrittele kameran, mikrofonin ja taustatoimintojen tarpeet.
- [ ] Toteuta puhelimen paritus oman Nancy-palvelimen kanssa sekä laitteen käyttöoikeuden peruminen.
- [ ] Näytä palvelimen tavoitettavuus ja tekoälyn suorituspaikka ymmärrettävästi.
- [ ] Toteuta yhteys omassa lähiverkossa; ratkaise etäkäyttö erikseen.
- [ ] Dokumentoi käyttöönotto ilman pakollista Nancy-pilvitiliä tai kuukausitilausta.

### Tehtävä ja aktiivinen työ

- [ ] Uusi tehtävä tekstillä tai sanelulla.
- [ ] Työn/kohteen luonti ja valinta: tunniste, nimi ja tarvittaessa asiakas.
- [ ] Aktiivinen työ näkyy kamera-, sanelu- ja keskustelunäkymissä.
- [ ] Työn vaihtaminen vaihtaa seuraavien havaintojen kohteen selkeästi.
- [ ] Epäselvä kohdistus kysytään käyttäjältä.
- [ ] Väärään työhön tallennetun havainnon voi siirtää jälkikäteen.
- [ ] Tehtävän tilat: luonnos, odottaa vahvistusta, käynnissä, odottaa vastausta, valmis, epäonnistunut ja peruttu.
- [ ] Käyttäjä voi keskeyttää tehtävän; jo tehdyt ulkoiset toimet jäävät historiaan.

### Kuvat ja sanelu

- [ ] Ota yksi tai useita kuvia ja tuo kuvia puhelimesta.
- [ ] Näytä liitteet ennen niiden käyttämistä raportissa tai viestissä.
- [ ] Nauhoita sanelu ja litteroi se paikallisesti suomeksi.
- [ ] Anna käyttäjän korjata litterointi ja erityisesti nimet, rekisteritunnukset, summat ja työmääräykset.
- [ ] Liitä alkuperäinen kuva, havainto ja aikaleima samaan työhön.
- [ ] Tallenna keskeneräinen aineisto laitteen paikalliseen jonoon verkkokatkon ajaksi.
- [ ] Toteuta siirron uudelleenyritys ilman kuvien tai havaintojen monistumista.
- [ ] Päätä säilytetäänkö alkuperäinen ääni ja miten käyttäjä poistaa sen.

### Tehtävän ymmärtäminen ja toimintavaltuudet

Tehtävän hyväksyntä ja kysymisen käytäntö ovat kaksi eri valintaa.

- [ ] Näytä lyhyt suunnitelma: tavoite, käytettävä aineisto ja aiotut ulkoiset toimet.
- [ ] **Mennään tällä:** hyväksyy näkyvän suunnitelman sovituilla rajoilla.
- [ ] **Tarkenna:** antaa muokata tehtävää tai pyytää Nancyltä täsmentävät kysymykset.
- [ ] **Kysele ennen rahan käyttöä:** maksu tai sitova tilaus pysähtyy hyväksyntään.
- [ ] **Kysele aina kun tarpeen:** olennainen epäselvyys pysäyttää työn tarkennukseen.
- [ ] Määrittele valintojen yhteiskäyttö. Rahankäytön hyväksyntä ei poista muun olennaisen tarkennuksen tarvetta.
- [ ] Näytä ensimmäisessä versiossa sähköpostin lähetys erillisenä hyväksyttävänä toimena.
- [ ] Sido hyväksyntä tehtävään ja tarkkaan sisältöversioon. Vastaanottajan, liitteiden tai hinnan muutos mitätöi vanhan hyväksynnän.
- [ ] Estä vanhan vastauksen, toisen tehtävän vastauksen ja toistetun verkkopyynnön käyttö uutena lupana.

### Kysymykset ja lomakkeet

- [ ] Tue yksittäistä kysymystä, valintapainikkeita ja tehtävään generoitua lyhyttä lomaketta.
- [ ] Esitäytetyt tunnetut tiedot ovat näkyvissä ja korjattavissa.
- [ ] Tue tekstiä, valintoja, numeroita ja liitepyyntöä; merkitse pakolliset tiedot.
- [ ] Muodosta lomake rajatusta, validoidusta rakenteesta, jonka sovellus renderöi.
- [ ] Näytä miksi vastausta tarvitaan ja mitä hyväksynnästä seuraa.
- [ ] Säilytä vastaamaton kysymys sovelluksen sulkemisen ja yhteyskatkon yli.

### Ensimmäinen valmis työnkulku ja tulos

- [ ] Toteuta **Pyydä korjauslupa** -pohja: työ, vastaanottaja, kuvat, havainto ja tarvittaessa hinta.
- [ ] Muodosta muokattava sähköpostiluonnos ja näytä kaikki liitteet.
- [ ] Toteuta yksi sähköpostiyhteys käyttäjän omalle tilille; valitse palvelu pilotin perusteella.
- [ ] Kirjaa lähetyksen kuittaus ja virhetilanne. Älä merkitse lähetetyksi pelkän agentin ilmoituksen perusteella.
- [ ] Selvitä epävarma lähetyksen tila ennen uudelleenlähetystä, jotta asiakas ei saa kaksoisviestiä.
- [ ] Näytä työn aikajanalla havainnot, kysymykset, hyväksynnät ja lopputulos.

## P1 — puheella jatkuva työ ja omat työnkulut

### Kaksisuuntainen puhe

- [ ] Nancy lukee kysymyksen ääneen ja vastaanottaa puhutun vastauksen samaan tehtävään.
- [ ] Puheella ja lomakkeella vastaaminen päivittävät samaa odottavaa päätöstä.
- [ ] Tuki komennoille ”lue ensin”, ”muuta”, ”hyväksy”, ”peru” ja ”kysy myöhemmin”.
- [ ] Epäselvä puhe, taustaääni tai toisen henkilön puhe ei tuota hyväksyntää.
- [ ] Ennen hyväksyntää luetaan päätöksen olennaiset tiedot, kuten vastaanottaja ja summa.
- [ ] Autoiluun sopiva käyttö: yksi lyhyt kysymys kerrallaan ja mahdollisuus siirtää tarkastus myöhemmäksi.
- [ ] Kuvien tai pitkän sisällön tarkastusta vaativa päätös voi odottaa pysähdystä.
- [ ] Selvitä Bluetooth-kuulokkeet, käyttö lukitulla näytöllä ja käyttöjärjestelmien taustarajoitukset.

### Työnkulkujen luonti ja ylläpito

- [ ] Valmiiden pohjien kirjasto: huoltokäynti, vikahavainto, korjauslupa ja työn valmistuminen.
- [ ] ”Muokkaa tästä oma” ja ”Luo puhumalla tai kirjoittamalla”.
- [ ] Työnkululla on nimi, tarvittavat tiedot, vaiheet, tulospohja ja ulkoiset toimet.
- [ ] Esikatselu ja kokeilu esimerkkiaineistolla ennen käyttöönottoa.
- [ ] Erota yhden työn poikkeus pysyvästä muutoksesta.
- [ ] Ohjeiden ja työnkulkujen versiohistoria, muutosvertailu ja palautus.
- [ ] Käynnissä oleva työ säilyttää käyttämänsä version; päivitys ei vaihda sitä huomaamatta.
- [ ] Omien ja yhteisten pohjien erottelu; yhteisen muutoksen hyväksyy siihen oikeutettu käyttäjä.
- [ ] Määrittele tallennusmuoto ja ohjeiden, työnkulkujen sekä pohjien tuonti ja vienti.

## P2 — laajennukset

- [ ] Korjaamo- tai asiakashallintajärjestelmän yhteys: työmääräykset ja yhteystiedot.
- [ ] Asiakkaan vastauksen liittäminen työhön ja korjausluvan tilan seuranta.
- [ ] Tiimin käyttäjät, vastuuhenkilöt ja yhteiset kohteet.
- [ ] Ajastetut tehtävät ja ilmoitukset vain merkityksellisistä muutoksista.
- [ ] PDF-raportit, lisätulospohjat ja muut palveluyhteydet.
- [ ] Puhelimessa suoritettava tekoäly ja laajempi käyttö ilman verkkoyhteyttä.
- [ ] Valinnainen pilvimalli käyttäjän omilla tunnuksilla; aineiston siirtyminen näkyy ennen käyttöönottoa.

## Ehdotus ensimmäisen version rajaukseksi

Tämä on ehdotus, ei vielä päätetty arkkitehtuuri:

- Puhelin toimii käyttöliittymänä ja oma tietokone/palvelin suorittaa paikalliset mallit.
- Yksi käyttäjä, yksi palvelin, yksi korjaamotyönkulku ja yksi sähköpostiyhteys.
- Kuvat, suomenkielinen sanelu, tarkennuslomake ja näkyvä lähetyksen hyväksyntä.
- Yhteyskatkossa kuvat ja sanelut säilyvät jonossa. Mallityö ja lähettäminen jatkuvat yhteyden palattua.
- Kaksisuuntainen puhe seuraa ensimmäisen toimivan ketjun jälkeen. Se kuuluu tuotteen tavoitteeseen, vaikka ei ensimmäiseen väliversioon.

## Avoimet päätökset

- [ ] Android vai iOS ensin, vai yhteinen toteutus molemmille?
- [ ] Missä ensimmäisen käyttäjän Nancy-palvelin toimii ja miten puhelin yhdistetään siihen kodin/työpaikan ulkopuolelta?
- [ ] Mitkä paikalliset mallit hoitavat agentin, tarkastajan, kuvat, puheentunnistuksen ja puhesynteesin? Mitkä ovat laitevaatimukset?
- [ ] Mikä sähköpostipalvelu ja mikä oikea käyttäjä valitaan pilottiin?
- [ ] Miten sovellus hankitaan ilman kuukausimaksua ja miten päivitykset sekä ylläpito rahoitetaan?
- [ ] Kuinka kauan kuvat, äänet ja tehtävähistoria säilytetään? Miten vienti, poisto ja varmuuskopiointi toimivat?
- [ ] Mitkä hyväksynnät voi antaa äänellä ja milloin vaaditaan laitteen lukituksen avaaminen?
- [ ] Mitkä nykyisen Nancyn estot ja tarkennukset voidaan näyttää mobiilissa jatkettavana kysymyksenä?

## Hyväksymiskriteerit ja pilotin mittarit

- [ ] Käyttäjä suorittaa korjaamoketjun puhelimella: työ → kuvat ja sanelu → tarkennus → luonnos → hyväksyntä → lähetyskuittaus.
- [ ] Kuvia tai hyväksyntöjä ei siirry väärään työhön kahden samanaikaisen tehtävän testissä.
- [ ] Lähetyksen sisällön muuttaminen vaatii uuden hyväksynnän.
- [ ] Verkkokatko, sovelluksen uudelleenkäynnistys ja palvelimen häiriö eivät kadota hyväksyttyä aineistoa tai aiheuta kaksoislähetyksiä.
- [ ] Paikallisessa tilassa mallikutsut, kuvat ja ääni pysyvät määritellyssä omassa ympäristössä; tämä tarkistetaan verkkoliikenteestä.
- [ ] Mitataan sanelun korjaustarve, tehtävän valmistumisaika, kysymysten määrä ja käyttäjän tekemät korjaukset oikeissa töissä.
- [ ] Verrataan samaa työtehtävää nykyiseen käsityöhön ja käytettävissä olevaan yleisagenttiin. Määritellään tavoitetasot pilotin lähtömittauksen jälkeen.

## Seuraavat konkreettiset työt

1. Valitse pilottikäyttäjä, puhelinalusta ja oma palvelin.
2. Piirrä näkymät: työt, aktiivinen työ, kuva/sanelu, kysymys ja lähetyksen tarkistus.
3. Määrittele mobiilin ja nykyisen Nancyn tehtävä- ja hyväksyntäprotokolla.
4. Toteuta yksi toimiva ketju paikallisella tekoälyllä.
5. Testaa aidossa työtilanteessa ja lisää kaksisuuntainen puhe havaintojen perusteella.
