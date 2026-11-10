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

## Rajoitukset ja jatkokehitys

- Tesseract ei ole sarjakuvaan koulutettu. Käsin kirjoitetut kirjaimet ja kapeat fontit tunnistuvat huonosti.
- Kuplantunnistus on heuristinen (vaalea tausta + tumma teksti). Pyöreät tai kuvioidut kuplat voivat jäädä huomaamatta.
  Seuraava askel: OpenCV:n kontuurit tai pieni koulutettu malli kuplien etsintään.
- Puhekuplien järjestys on ylhäältä alas, vasemmalta oikealle (ei manga-tyylinen oikealta vasemmalle).
- Ei vielä: kuplan häntä/puhujan tunnistus, kuvan tallennus, käännös.
