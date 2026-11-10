# Sarjakuvalukija

Mobiiliselaimella toimiva web-sovellus: osoitat kameralla sarjakuvaruutuun, sovellus tunnistaa
tekstin, suodattaa mukaan vain puhekuplien/tekstiruutujen tekstin ja lukee sen ääneen heti kun se
on tunnistettu.

## Miten se toimii

1. **Kamera** – takakamera (`getUserMedia`), kuva otetaan ~5 kertaa sekunnissa.
2. **OCR** – [Tesseract.js](https://github.com/naptha/tesseract.js) (WebAssembly, käytetään suoraan selaimessa, kielet suomi + englanti).
3. **Kuplasuodatus** – jokaisen tunnistetun rivin ympärillä pitää olla vaalea tausta ja rivin sisällä tummaa tekstiä.
   Tämä erottaa puhekuplat ja tekstiruudut muusta kuvan tekstistä (kyltit, logot, taustan teksti).
   Lähekkäiset rivit yhdistetään yhdeksi kuplaksi, jotta monirivinen puhe luetaan kokonaisena.
4. **Vakautus** – teksti luetaan vasta kun se on näkyvissä useassa peräkkäisessä kehyksessä,
   jotta kameran tärinä ei aiheuta turhaa lukemista. Saman tekstin uudelleenluku estetään 15 s ajan.
5. **Puhe** – Web Speech API (`speechSynthesis`), kieli `fi-FI`, jos laitteella on suomenkielinen ääni.

## Käyttöönotto

Kamera vaatii **HTTPS**-yhteyden mobiilissa (localhost toimii kehityksessä). Helpoin tapa:
GitHub Pages (repon Settings → Pages → `main` / root) ja avaa sivu puhelimen selaimella.

Tiedostot:

- `index.html` – käyttöliittymä
- `app.js` – koko sovelluslogiikka
- Tesseract ladataan CDN:stä (jsDelivr, versio 5.1.1). Ensimmäisellä kerralla ladataan kielidata.

## Säätäminen

`app.js` alussa on `CONFIG`-objekti:

| Asetus | Merkitys |
|---|---|
| `bubbleBrightness` | Kuplan taustan vaaleuskynnys. Laske, jos kuplia ei tunnisteta; nosta, jos muuta tekstiä lukee mukaan |
| `inkThreshold` | Tekstin tummuuskynnys |
| `minConfidence` | OCR:n minimiluottamus. Laske, jos vaikeita fontteja jää lukematta |
| `confirmFrames` | Kuinka monta kehystä tekstin pitää näkyä ennen lukemista |
| `maxWidth` | OCR-kuvan leveys: suurempi = tarkempi mutta hitaampi |

## Asetukset sovelluksessa

- **Vain puhekuplat** (oletuksena pois): lukee vain vaalealla taustalla olevan tekstin. Kytke päälle, jos kuvassa on paljon muuta tekstiä.
- **Manga (oikealta vasemmalle)**: järjestää luettavat rivit oikealta vasemmalle. Oletuksena vasemmalta oikealle.
- **Puhenopeus**: säätää puheen nopeutta.

Tunnistus tehdään kahdessa vaiheessa: ensin etsitään tekstirivit koko kuvasta, sitten jokainen rivi luetaan uudelleen rajattuna, 3-kertaisesti suurennettuna ja binarisoituna. Tämä parantaa tunnistusta pienelle kuplatekstille.

## Rajoitukset ja jatkokehitys

- Tesseract ei ole sarjakuvaan koulutettu. Käsin kirjoitetut kirjaimet, kapeat ja koristeelliset fontit sekä epätarkka kuva tunnistuvat edelleen huonosti.
- Kuplantunnistus on heuristinen (vaalea tausta + tumma teksti). Pyöreät tai kuvioidut kuplat voivat jäädä huomaamatta, joten sitä kannattaa käyttää vain tarvittaessa.
  Seuraava askel: OpenCV:n kontuurit tai pieni koulutettu malli kuplien etsintään.
- Yhdeksi kuplaksi yhdistetään vain lähekkäiset rivit. Puhujan tai kuplan hännän tunnistusta ei ole.
- Ei vielä: kuvan tallennus, käännös.
- Kamera ei aina tue laitteistozoomia, joten zoom-toiminto on poistettu. Lähennä kuvaa fyysisesti lähemmäs sarjakuvaa.
