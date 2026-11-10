(() => {
  'use strict';

  // ---- Asetukset: säädä näillä kamera-, OCR- ja kuplatunnistusta ----
  const CONFIG = {
    lang: 'fin+eng',        // OCR-kielet
    minConfidence: 40,      // OCR-luottamus 0-100, alle tämän rivi hylätään
    frameIntervalMs: 200,   // tauko kehysten välillä (OCR:n jälkeen)
    maxWidth: 1400,         // kuvan leveys OCR:lle (suurempi = parempi pienelle tekstille, hitaampi)
    confirmFrames: 2,       // montako peräkkäistä kehystä tekstin pitää näkyä ennen lukemista
    missedFrames: 4,        // montako kehystä teksti saa olla poissa ennen kuin se unohtuu
    fuzzyThreshold: 0.8,    // kuinka samankaltainen tekstin pitää olla (0-1) "samaksi"
    repeatCooldownMs: 15000,// sama teksti ei lue uudelleen tämän ajan sisällä
    bubbleBrightness: 150,  // taustan vaaleuskynnys (0-255): puhekuplat ovat vaaleita
    bubbleBrightShare: 0.35,// vähintään tämä osuus taustan pikseleistä on vaaleita
    inkThreshold: 120,      // tekstin tummuuskynnys (0-255)
  };

  const $ = id => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const rateEl = $('rate');
  const statusEl = $('status');
  const lastEl = $('last');

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let worker = null;
  let running = false;
  let busy = false;
  let timer = null;
  let ready = false;
  let tracks = [];          // näkyvissä olevat tekstit kehyksittäin
  let recentlySpoken = [];  // {norm, t} viimeksi luetut

  // ---- Apurit ----
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const setStatus = msg => { statusEl.textContent = msg; };

  // Normalisointi vertailua varten: pienet kirjaimet, vain kirjaimet ja numerot
  const normalize = s => s.toLowerCase()
    .replace(/[^a-zäöå0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Levenshtein-pohjainen samankaltaisuus 0..1
  function similarity(a, b) {
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }
  const sameText = (a, b) => similarity(a, b) >= CONFIG.fuzzyThreshold;

  // Suodatetaan roskat: riittävän luotettava ja sisältää oikeita sanoja
  const isReadable = (norm, conf) =>
    conf >= CONFIG.minConfidence && norm.replace(/ /g, '').length >= 3 && /[a-zäöå]{3}/.test(norm);

  function toGray(rgba) {
    const n = rgba.length / 4;
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
    }
    return g;
  }

  // ---- Kuplatunnistus ----
  // Rivin ympärillä pitää olla vaalea tausta ja rivin sisällä tummaa tekstiä.
  // Näin erotetaan sarjakuvan puhekuplat ja tekstiruudut kuvan muusta tekstistä
  // (esim. kyltit, tuotemerkit, taustalla oleva ympäristön teksti).
  function looksLikeBubble(gray, W, H, box) {
    const h = box.y1 - box.y0;
    const pad = Math.max(4, Math.round(h * 0.6));
    const X0 = clamp(box.x0 - pad, 0, W - 1), X1 = clamp(box.x1 + pad, 0, W - 1);
    const Y0 = clamp(box.y0 - pad, 0, H - 1), Y1 = clamp(box.y1 + pad, 0, H - 1);

    let bgSum = 0, bgCount = 0, bgBright = 0, inkDark = 0, inkCount = 0;
    for (let y = Y0; y <= Y1; y++) {
      const inTextRow = y >= box.y0 && y <= box.y1;
      for (let x = X0; x <= X1; x++) {
        const v = gray[y * W + x];
        if (inTextRow && x >= box.x0 && x <= box.x1) {
          inkCount++;
          if (v < CONFIG.inkThreshold) inkDark++;
        } else {
          bgCount++;
          bgSum += v;
          if (v > CONFIG.bubbleBrightness) bgBright++;
        }
      }
    }
    if (!bgCount || !inkCount) return false;
    const bgMean = bgSum / bgCount;
    const brightShare = bgBright / bgCount;
    const inkShare = inkDark / inkCount;
    return bgMean >= CONFIG.bubbleBrightness
        && brightShare >= CONFIG.bubbleBrightShare
        && inkShare >= 0.01 && inkShare <= 0.7;
  }

  // OCR-rivit (Tesseract 5: blocks -> paragraphs -> lines)
  function extractLines(data) {
    if (data.blocks && data.blocks.length) {
      return data.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
    }
    return data.lines || [];
  }

  const union = (a, b) => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
  });

  // Yhdistää peräkkäiset rivit yhdeksi kuplaksi (monirivinen puhe)
  function groupIntoBubbles(lines) {
    const sorted = [...lines].sort((a, b) => a.box.y0 - b.box.y0);
    const groups = [];
    for (const l of sorted) {
      const lh = l.box.y1 - l.box.y0;
      const g = groups.find(g => {
        const gap = l.box.y0 - g.box.y1;
        const overlap = Math.min(g.box.x1, l.box.x1) - Math.max(g.box.x0, l.box.x0);
        const narrower = Math.min(g.box.x1 - g.box.x0, l.box.x1 - l.box.x0);
        return gap >= -lh * 0.2 && gap < lh * 0.9 && overlap > narrower * 0.3;
      });
      if (g) {
        g.lines.push(l);
        g.box = union(g.box, l.box);
      } else {
        groups.push({ lines: [l], box: { ...l.box } });
      }
    }
    return groups.map(g => {
      const raw = g.lines.map(l => l.raw).join(' ');
      return { raw, norm: normalize(raw), box: g.box };
    });
  }

  // ---- Puhe ----
  const synth = window.speechSynthesis || null;
  let finnishVoice = null;
  function pickVoice() {
    const voices = synth ? synth.getVoices() : [];
    finnishVoice = voices.find(v => /^fi/i.test(v.lang)) || null;
  }
  if (synth) {
    pickVoice();
    synth.onvoiceschanged = pickVoice;
  }

  function speak(text) {
    if (!synth) { setStatus('Selain ei tue puhesynteesiä.'); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fi-FI';
    if (finnishVoice) u.voice = finnishVoice;
    u.rate = parseFloat(rateEl.value);
    synth.speak(u);
  }

  // Lukee tekstin vain kun se on ollut näkyvissä useassa peräkkäisessä kehyksessä
  // eikä sitä ole juuri luettu. Luku menee ylhäältä alas, vasemmalta oikealle.
  function updateSpeech(groups) {
    const used = new Set();
    const next = [];
    for (const t of tracks) {
      const idx = groups.findIndex((g, i) => !used.has(i) && sameText(g.norm, t.norm));
      if (idx >= 0) {
        used.add(idx);
        Object.assign(t, { frames: t.frames + 1, missed: 0,
                           raw: groups[idx].raw, norm: groups[idx].norm, box: groups[idx].box });
      } else {
        t.missed++;
      }
      if (t.missed < CONFIG.missedFrames) next.push(t);
    }
    groups.forEach((g, i) => {
      if (!used.has(i)) next.push({ raw: g.raw, norm: g.norm, box: g.box, frames: 1, missed: 0, spoken: false });
    });
    tracks = next;

    const now = Date.now();
    recentlySpoken = recentlySpoken.filter(r => now - r.t < CONFIG.repeatCooldownMs);

    const ready = tracks
      .filter(t => !t.spoken && t.missed === 0 && t.frames >= CONFIG.confirmFrames)
      .sort((a, b) => (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0));

    for (const t of ready) {
      t.spoken = true;
      if (recentlySpoken.some(r => sameText(r.norm, t.norm))) continue;
      recentlySpoken.push({ norm: t.norm, t: now });
      lastEl.textContent = t.raw;
      speak(t.raw);
    }
  }

  // Keltainen = luettava kupla, punainen = OCR löysi tekstiä mutta se hylättiin
  function drawOverlay(groups, rejected, W, H) {
    overlay.width = W;
    overlay.height = H;
    octx.clearRect(0, 0, W, H);
    octx.lineWidth = Math.max(2, W / 300);
    octx.strokeStyle = '#ff3b30';
    for (const b of rejected) {
      octx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
    octx.strokeStyle = '#ffcc00';
    octx.fillStyle = 'rgba(255, 204, 0, 0.15)';
    for (const g of groups) {
      const { x0, y0, x1, y1 } = g.box;
      octx.fillRect(x0, y0, x1 - x0, y1 - y0);
      octx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  // ---- Kehyksen käsittely ----
  async function processFrame() {
    if (busy || !running || !ready || video.readyState < 2) return;
    busy = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, CONFIG.maxWidth / vw);
      work.width = Math.round(vw * scale);
      work.height = Math.round(vh * scale);
      wctx.drawImage(video, 0, 0, work.width, work.height);

      const { data } = await worker.recognize(work, {}, { blocks: true });
      if (!running) return;

      const W = work.width, H = work.height;
      const gray = toGray(wctx.getImageData(0, 0, W, H).data);

      const lines = [];
      const rejected = [];
      const ocrLines = extractLines(data).filter(l => l.bbox && (l.text || '').trim());
      for (const line of ocrLines) {
        const raw = (line.text || '').replace(/\s+/g, ' ').trim();
        const norm = normalize(raw);
        if (!isReadable(norm, line.confidence) || !looksLikeBubble(gray, W, H, line.bbox)) {
          rejected.push(line.bbox);
          continue;
        }
        lines.push({ raw, norm, box: line.bbox });
      }

      const groups = groupIntoBubbles(lines);
      drawOverlay(groups, rejected, W, H);
      updateSpeech(groups);
      if (!ocrLines.length) {
        setStatus('OCR ei löytänyt tekstiä. Kuvaa lähempää tai paremmalla valolla.');
      } else {
        setStatus(`OCR-rivejä: ${ocrLines.length}, kuplia: ${groups.length} (punainen = hylätty)`);
      }
    } catch (err) {
      console.error(err);
      setStatus('Tunnistusvirhe: ' + err.message);
    } finally {
      busy = false;
    }
  }

  async function loop() {
    if (!running) return;
    await processFrame();
    if (running) timer = setTimeout(loop, CONFIG.frameIntervalMs);
  }

  // ---- Käynnistys ja pysäytys ----
  async function start() {
    startBtn.disabled = true;
    try {
      // iOS/Android vaatii puheen käynnistyksen käyttäjän napautuksesta
      if (synth) synth.speak(new SpeechSynthesisUtterance(''));

      setStatus('Käynnistetään kamera…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();

      setStatus('Ladataan tekstintunnistusta (ensimmäinen kerta voi kestää)…');
      worker = await Tesseract.createWorker(CONFIG.lang, 1, {
        logger: m => {
          if (!ready && m.status) setStatus(`${m.status} ${Math.round((m.progress || 0) * 100)} %`);
        },
      });
      ready = true;

      running = true;
      stopBtn.disabled = false;
      setStatus('Kuuntelee. Osoita kameraa sarjakuvaruutuun.');
      loop();
    } catch (err) {
      console.error(err);
      setStatus('Virhe: ' + err.message);
      await stop();
    }
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    if (worker) {
      try { await worker.terminate(); } catch (_) { /* ignoroi */ }
      worker = null;
    }
    ready = false;
    if (synth) synth.cancel();
    tracks = [];
    recentlySpoken = [];
    octx.clearRect(0, 0, overlay.width, overlay.height);
    lastEl.textContent = '';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('Pysäytetty.');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Kamera ei ole käytettävissä. Avaa sivu HTTPS-osoitteesta.');
    startBtn.disabled = true;
  }
  if (typeof Tesseract === 'undefined') {
    setStatus('Tesseract-kirjastoa ei ladattu. Tarkista internetyhteys.');
    startBtn.disabled = true;
  }
})();
